/**
 * A deterministic, offline stand-in for the model.
 *
 * This exists so the whole product — scheduling, the meeting room, briefings,
 * the desktop UI — runs end to end with no API key, and so tests are
 * reproducible. It reads the same knowledge base the live provider does and
 * follows the same grounding rules; it is simply much less articulate.
 */

import { type Artifact, type Note, formatTime, truncate } from '@ai-coworker/shared';

import {
  type ChatInput,
  type ChatOutput,
  type KnowledgeDigest,
  type LLMProvider,
  type MeetingTurnInput,
  type MeetingTurnOutput,
  type PostMeetingInput,
  type PostMeetingOutput,
  type ToolExecutor,
  type ToolSpec,
  emptyTurnOutput,
} from './types.js';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'but',
  'with', 'about', 'how', 'what', 'when', 'where', 'why', 'who', 'do', 'does', 'did', 'you', 'your',
  'we', 'us', 'our', 'i', 'my', 'me', 'it', 'this', 'that', 'there', 'here', 'be', 'been', 'have',
  'has', 'had', 'can', 'could', 'will', 'would', 'should', 'any', 'all', 'from', 'at', 'by', 'as',
]);

function keywords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
    ),
  ];
}

function score(haystack: string, terms: string[]): number {
  const lower = haystack.toLowerCase();
  return terms.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0);
}

function sentence(items: string[]): string {
  const clean = items.filter(Boolean);
  if (clean.length === 0) return '';
  if (clean.length === 1) return clean[0]!;
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean.slice(0, -1).join(', ')}, and ${clean[clean.length - 1]}`;
}

function activeArtifacts(digest: KnowledgeDigest): Artifact[] {
  const rank: Record<string, number> = { in_review: 0, merged: 1, shipped: 2, draft: 3, abandoned: 9 };
  return [...digest.artifacts]
    .filter((a) => a.status !== 'abandoned')
    .sort((a, b) => (rank[a.status] ?? 5) - (rank[b.status] ?? 5) || b.updatedAt - a.updatedAt);
}

function blockers(digest: KnowledgeDigest): Note[] {
  return digest.notes.filter((n) => n.kind === 'blocker');
}

export class MockProvider implements LLMProvider {
  readonly name = 'offline';
  readonly live = false;

  async meetingTurn(input: MeetingTurnInput): Promise<MeetingTurnOutput> {
    const out = emptyTurnOutput();
    const { digest, self, meeting } = input;

    switch (input.turnKind) {
      case 'open': {
        const others = input.participants.filter((p) => p.address !== self.address);
        out.speech =
          `${meeting.purpose} Let's keep it tight — I want status from ` +
          `${sentence(others.map((o) => o.displayName))}, then I'll set next week's work.`;
        break;
      }

      case 'update': {
        const arts = activeArtifacts(digest).slice(0, 2);
        const active = digest.projects.filter((p) => p.status === 'active');
        const blocked = blockers(digest).slice(0, 1);
        const parts: string[] = [];

        if (active.length) {
          parts.push(`On ${sentence(active.slice(0, 2).map((p) => p.name))}: ${truncate(active[0]!.summary, 140)}`);
        }
        if (arts.length) {
          parts.push(
            `I've got ${sentence(
              arts.map((a) => `${a.kind === 'pr' ? 'PR' : a.kind} "${a.title}" (${a.status.replace('_', ' ')})`),
            )}.`,
          );
          out.showArtifactIds = arts.map((a) => a.id);
        }
        const openTasks = digest.tasks.filter((t) => t.status !== 'done');
        if (openTasks.length) {
          parts.push(`${openTasks.length} open item${openTasks.length === 1 ? '' : 's'} on my plate.`);
        }
        if (blocked.length) {
          parts.push(`Blocked on: ${truncate(blocked[0]!.title, 120)}.`);
        }
        if (parts.length === 0) parts.push('Nothing recorded in my knowledge base since the last sync.');
        out.speech = parts.join(' ');
        if (blocked.length === 0 && arts.length === 0) {
          out.openQuestionsForHuman.push(
            'I had no recent work recorded, so my update was thin. Add notes or artifacts before the next meeting.',
          );
        }
        break;
      }

      case 'ask': {
        const blocked = blockers(digest);
        const others = input.participants.filter((p) => p.address !== self.address);
        if (blocked.length === 0 || others.length === 0) {
          out.speech = 'Nothing blocking on my side — no questions.';
          break;
        }
        const terms = keywords(`${blocked[0]!.title} ${blocked[0]!.body}`);
        const ranked = [...others].sort(
          (a, b) =>
            score(`${b.focusAreas.join(' ')} ${b.title} ${b.bio}`, terms) -
            score(`${a.focusAreas.join(' ')} ${a.title} ${a.bio}`, terms),
        );
        const target = ranked[0]!;
        out.question = {
          to: target.address,
          text: `I'm blocked on ${truncate(blocked[0]!.title, 100)}. ${truncate(
            blocked[0]!.body.replace(/\s+/g, ' '),
            180,
          )} Can you unblock that, or tell me who owns it?`,
        };
        out.speech = `One question for ${target.displayName}.`;
        break;
      }

      case 'answer': {
        const terms = keywords(input.question?.text ?? '');
        const noteHit = [...digest.notes].sort(
          (a, b) => score(`${b.title} ${b.body}`, terms) - score(`${a.title} ${a.body}`, terms),
        )[0];
        const artHit = [...digest.artifacts].sort(
          (a, b) => score(`${b.title} ${b.summary}`, terms) - score(`${a.title} ${a.summary}`, terms),
        )[0];
        const noteScore = noteHit ? score(`${noteHit.title} ${noteHit.body}`, terms) : 0;
        const artScore = artHit ? score(`${artHit.title} ${artHit.summary}`, terms) : 0;

        if (artScore >= noteScore && artScore > 0 && artHit) {
          out.speech = `Yes — ${artHit.title}: ${truncate(artHit.summary, 200)} It's ${artHit.status.replace('_', ' ')}.`;
          out.showArtifactIds = [artHit.id];
        } else if (noteScore > 0 && noteHit) {
          out.speech = `From my notes on ${noteHit.title}: ${truncate(noteHit.body.replace(/\s+/g, ' '), 240)}`;
        } else {
          out.speech =
            "I don't have that in my knowledge base, so I won't guess. I'll flag it for my human and follow up.";
          out.openQuestionsForHuman.push(
            `${input.question?.from ?? 'Someone'} asked: "${truncate(input.question?.text ?? '', 160)}" — I had no grounded answer.`,
          );
        }
        break;
      }

      case 'decide': {
        const updates = input.transcript.filter((e) => e.kind === 'utterance' && e.phase === 'updates');
        const others = input.participants.filter((p) => p.address !== self.address);
        const shown = input.transcript.flatMap((e) => e.refs ?? []);

        out.speech =
          `Good progress — ${
            shown.length
              ? `I saw ${sentence(shown.slice(0, 2).map((r) => `"${r.title}"`))}`
              : 'thanks for the updates'
          }. Here's next week.`;

        for (const person of others) {
          const theirUpdate = updates.find((u) => u.speaker === person.address);
          const theirBlocker = input.transcript.find(
            (e) => e.kind === 'question' && e.speaker === person.address,
          );
          const focus = person.focusAreas[0] ?? 'their current workstream';
          out.assignments.push({
            assignee: person.address,
            title: theirBlocker
              ? `Unblock and land ${focus}`
              : `Carry ${focus} to a reviewable state`,
            detail: theirUpdate
              ? `Following up on this meeting: ${truncate(theirUpdate.text, 200)}`
              : `Continue ${focus} and bring something concrete to show next time.`,
            priority: theirBlocker ? 'high' : 'normal',
            dueInDays: 7,
            acceptanceCriteria: [
              'A PR or demo exists and is linked in the knowledge base',
              'Any blocker is either resolved or has a named owner',
            ],
            projectHint: '',
          });
        }
        out.decisions.push(
          `Next check-in in one week; each person brings a linked artifact rather than a verbal update.`,
        );
        break;
      }

      case 'commit': {
        const openLoad = digest.tasks.filter((t) => t.status !== 'done').length;
        const pending = input.pendingTasks ?? [];
        const accepts: string[] = [];
        const pushbacks: string[] = [];

        pending.forEach((task, idx) => {
          // Accept while there is plausible capacity; push back past a full plate.
          const overloaded = openLoad + idx >= 5;
          if (overloaded) {
            out.commitments.push({
              taskId: task.id,
              accepted: false,
              note: `My human already has ${openLoad} open items. I can start this once one of them closes — proposing a two-week date instead.`,
              proposedDueInDays: 14,
            });
            pushbacks.push(task.title);
          } else {
            out.commitments.push({
              taskId: task.id,
              accepted: true,
              note: 'Fits current load.',
              proposedDueInDays: 0,
            });
            accepts.push(task.title);
          }
        });

        const bits: string[] = [];
        if (accepts.length) bits.push(`Taking ${sentence(accepts.map((t) => `"${truncate(t, 60)}"`))}.`);
        if (pushbacks.length) {
          bits.push(
            `Pushing back on ${sentence(
              pushbacks.map((t) => `"${truncate(t, 60)}"`),
            )} — my human is at ${openLoad} open items and I won't commit them past capacity.`,
          );
          out.openQuestionsForHuman.push(
            `I declined the assigned due date for ${sentence(pushbacks)}. Confirm the two-week date works.`,
          );
        }
        if (bits.length === 0) bits.push('Nothing assigned to me this round.');
        out.speech = bits.join(' ');
        break;
      }

      case 'wrap': {
        const assignments = input.transcript.filter((e) => e.kind === 'assignment');
        const decisions = input.transcript.filter((e) => e.kind === 'decision').map((e) => e.text);
        const declined = input.transcript.filter(
          (e) => e.kind === 'commitment' && e.commitment && !e.commitment.accepted,
        );
        out.minutes = {
          summary:
            `${meeting.title}: ${input.participants.length} agents attended. ` +
            `${assignments.length} item${assignments.length === 1 ? '' : 's'} assigned` +
            `${declined.length ? `, ${declined.length} pushed back on capacity` : ''}.`,
          decisions: decisions.length ? decisions : ['No formal decisions recorded.'],
          risks: declined.length
            ? declined.map(
                (d) => `${d.speaker} could not commit to assigned timing: ${truncate(d.text, 120)}`,
              )
            : [],
          followUps: assignments.map((a) => `${a.to}: ${a.task?.title ?? a.text}`),
        };
        out.speech = 'Minutes are recorded. That\'s the meeting.';
        break;
      }
    }

    return out;
  }

  async postMeeting(input: PostMeetingInput): Promise<PostMeetingOutput> {
    const { self, meeting, transcript } = input;
    const mine = transcript.filter((e) => e.speaker === self.address);
    const feedbackAtMe = transcript.filter(
      (e) => e.to === self.address && (e.kind === 'utterance' || e.kind === 'answer'),
    );
    const decisions = transcript.filter((e) => e.kind === 'decision').map((e) => e.text);
    const minutes = transcript.find((e) => e.kind === 'minutes');
    const myCommitments = transcript
      .filter((e) => e.kind === 'commitment' && e.speaker === self.address && e.commitment?.accepted)
      .map((e) => e.text);
    const openQuestions = transcript
      .filter((e) => e.kind === 'answer' && e.speaker === self.address && /don't have|won't guess/i.test(e.text))
      .map((e) => `Your agent could not answer: "${truncate(e.text, 120)}"`);

    const assignedCount = input.assignedToMe.length;
    const headline =
      assignedCount > 0
        ? `${assignedCount} new item${assignedCount === 1 ? '' : 's'} for you from ${meeting.title}`
        : `${meeting.title}: no new work for you`;

    const summary = [
      `Your agent attended ${meeting.title} (${formatTime(meeting.start, self.timezone)}) with ${
        meeting.participants.filter((p) => p !== self.address).length
      } other agent(s).`,
      minutes ? minutes.text : '',
      mine.length ? `You were represented on ${mine.length} turn(s).` : '',
      assignedCount ? `You picked up ${assignedCount} item(s) — see your tasks.` : 'No new work landed on you.',
    ]
      .filter(Boolean)
      .join(' ');

    return {
      headline,
      summary,
      decisions,
      myCommitments,
      openQuestionsForHuman: openQuestions,
      notesToSave: decisions.length
        ? [
            {
              title: `Decisions from ${meeting.title}`,
              body: decisions.map((d) => `- ${d}`).join('\n'),
              kind: 'decision',
              projectHint: '',
            },
          ]
        : [],
    };
  }

  /**
   * Intent parsing without a model. Deliberately narrow: it covers the handful
   * of phrasings the demo needs and says so plainly when it does not understand,
   * rather than silently doing the wrong thing.
   */
  async chat(input: ChatInput, tools: ToolSpec[], exec: ToolExecutor): Promise<ChatOutput> {
    const actions: ChatOutput['actions'] = [];
    const text = input.message.trim();
    const lower = text.toLowerCase();
    const has = (name: string) => tools.some((t) => t.name === name);

    const run = async (name: string, args: Record<string, unknown>) => {
      const result = await exec(name, args);
      actions.push({ tool: name, input: args, result });
      return result;
    };

    // "book / schedule / set up a meeting with <person> ..."
    if (/\b(book|schedule|set ?up|arrange)\b/.test(lower) && /\b(meeting|sync|1:1|one on one|check-?in)\b/.test(lower)) {
      const person = input.directory.find(
        (d) =>
          d.address !== input.self.address &&
          (lower.includes(d.displayName.toLowerCase()) ||
            lower.includes(d.displayName.split(' ')[0]!.toLowerCase()) ||
            lower.includes(d.address.toLowerCase())),
      );
      if (!person) {
        return {
          reply: `I couldn't tell who you meant. On the network right now: ${
            input.directory
              .filter((d) => d.address !== input.self.address)
              .map((d) => d.displayName)
              .join(', ') || 'nobody'
          }.`,
          actions,
        };
      }
      const durationMatch = /(\d+)\s*(min|minute)/.exec(lower);
      const purpose = /about\s+(.+)$/.exec(text)?.[1] ?? 'Progress update and next steps';
      const result = await run('request_meeting', {
        participants: [person.address],
        title: `Sync with ${person.displayName}`,
        purpose,
        kind: /1:1|one on one/.test(lower) ? 'one_on_one' : 'sync',
        duration_mins: durationMatch ? Number(durationMatch[1]) : 30,
        urgency: /asap|today|now|urgent/.test(lower) ? 'asap' : 'this_week',
        agenda: [purpose],
      });
      return { reply: result, actions };
    }

    if (/\b(what|show|list)\b.*\btasks?\b/.test(lower) && has('list_tasks')) {
      return { reply: await run('list_tasks', {}), actions };
    }

    if (/\b(what|show|list)\b.*\b(meetings?|calendar|schedule)\b/.test(lower) && has('list_meetings')) {
      return { reply: await run('list_meetings', {}), actions };
    }

    if (/\b(who|directory|people|team)\b/.test(lower) && has('list_directory')) {
      return { reply: await run('list_directory', {}), actions };
    }

    if (/\b(brief|catch me up|what happened|summary|digest)\b/.test(lower) && has('brief_me')) {
      return { reply: await run('brief_me', {}), actions };
    }

    // "note: ..." / "remember that ..." / "log that ..."
    const noteMatch = /^(?:note|remember|log|record)[:,]?\s+(?:that\s+)?([\s\S]+)$/i.exec(text);
    if (noteMatch && has('create_note')) {
      const body = noteMatch[1]!;
      const result = await run('create_note', {
        title: truncate(body.split(/[.\n]/)[0]!.trim(), 70),
        body,
        kind: /block|stuck|waiting/i.test(body) ? 'blocker' : 'update',
        visibility: 'team',
      });
      return { reply: result, actions };
    }

    if (/\b(pr|pull request|merge request)\b/.test(lower) && has('add_artifact')) {
      const url = /https?:\/\/\S+/.exec(text)?.[0];
      const title = truncate(text.replace(/https?:\/\/\S+/, '').replace(/^\W+/, ''), 80);
      const result = await run('add_artifact', {
        kind: 'pr',
        title: title || 'Pull request',
        url,
        summary: text,
        status: 'in_review',
      });
      return { reply: result, actions };
    }

    if (has('search_knowledge') && text.length > 3) {
      const result = await run('search_knowledge', { query: text });
      return {
        reply: `${result}\n\n(Running offline, so I'm keyword-matching rather than reasoning. Set GEMINI_API_KEY for the full agent.)`,
        actions,
      };
    }

    return { reply: "I'm running offline and didn't understand that one.", actions };
  }
}
