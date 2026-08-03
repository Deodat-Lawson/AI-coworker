import { formatTime, truncate } from '@ai-coworker/shared';

import type { KnowledgeDigest, MeetingTurnInput, PostMeetingInput } from './types.js';

/**
 * Prompt construction is shared by every live provider. It is kept in one place
 * because the *grounding rules* — never invent an artifact, never accept work
 * you have no evidence for — are the product, not an implementation detail.
 */

export function renderDigest(digest: KnowledgeDigest, opts: { includeIds?: boolean } = {}): string {
  const { includeIds = true } = opts;
  const lines: string[] = [];

  if (digest.projects.length) {
    lines.push('## Projects');
    for (const p of digest.projects) {
      lines.push(
        `- ${p.name} [${p.status}]${includeIds ? ` (id: ${p.id})` : ''}: ${truncate(p.summary, 240)}`,
      );
    }
  }

  if (digest.artifacts.length) {
    lines.push('', '## Artifacts I can show (these are real; nothing else is)');
    for (const a of digest.artifacts) {
      const stats = Object.entries(a.stats)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      lines.push(
        `- [${a.kind}] ${a.title} — ${a.status}${includeIds ? ` (id: ${a.id})` : ''}` +
          `${a.url ? ` <${a.url}>` : ''}${stats ? ` {${stats}}` : ''}\n    ${truncate(a.summary, 220)}`,
      );
    }
  }

  if (digest.notes.length) {
    lines.push('', '## Recent notes');
    for (const n of digest.notes) {
      lines.push(`- (${n.kind}) ${n.title}\n    ${truncate(n.body.replace(/\s+/g, ' '), 320)}`);
    }
  }

  if (digest.tasks.length) {
    lines.push('', '## My open tasks');
    for (const t of digest.tasks) {
      const due = t.dueDate ? `, due ${formatTime(t.dueDate)}` : '';
      lines.push(`- [${t.status}] ${t.title} (from ${t.assignedBy}${due})`);
    }
  }

  if (digest.feedbackLines.length) {
    lines.push('', '## Feedback I have received recently');
    for (const f of digest.feedbackLines) lines.push(`- ${f}`);
  }

  return lines.join('\n') || '(the knowledge base is empty)';
}

export function renderTranscript(input: MeetingTurnInput | PostMeetingInput): string {
  if (input.transcript.length === 0) return '(nothing said yet)';
  return input.transcript
    .map((e) => {
      const who = e.speaker === 'moderator' ? 'MODERATOR' : e.speaker;
      const target = e.to ? ` -> ${e.to}` : '';
      const refs = e.refs?.length
        ? `\n    [showed: ${e.refs.map((r) => `${r.kind} "${r.title}"${r.url ? ` ${r.url}` : ''}`).join('; ')}]`
        : '';
      return `${who}${target} (${e.kind}): ${e.text}${refs}`;
    })
    .join('\n');
}

const GROUNDING_RULES = `
Grounding rules — these are absolute:
- You may only claim work exists if it appears in the knowledge base above. Never invent a PR, a number, a ship date, or a decision.
- To show something concrete, put its artifact id in show_artifact_ids. Only ids listed above are valid.
- If you are asked something the knowledge base does not answer, say plainly that you do not have it and add the question to open_questions_for_human. Do not guess on your human's behalf.
- Never accept a commitment your human has no capacity or information for. Pushing back with a reason is better than a false yes.
- Speak in first person as the person you represent, but do not pretend to be human. You are their agent and the other attendees are agents too.
- Be brief and concrete. Two to five sentences per turn. No filler, no pleasantries, no restating the agenda.`.trim();

export function meetingSystemPrompt(input: MeetingTurnInput): string {
  const { self, meeting, participants } = input;
  const roster = participants
    .map(
      (p) =>
        `- ${p.address} — ${p.displayName}, ${p.title || p.role}${p.team ? `, ${p.team}` : ''}` +
        `${p.focusAreas.length ? ` (focus: ${p.focusAreas.join(', ')})` : ''}` +
        `${p.address === meeting.chair ? ' [CHAIR]' : ''}`,
    )
    .join('\n');

  const agenda = meeting.agenda.length
    ? meeting.agenda.map((a, i) => `${i + 1}. ${a.title}${a.owner ? ` (owner: ${a.owner})` : ''}${a.notes ? ` — ${a.notes}` : ''}`).join('\n')
    : '(no formal agenda)';

  return `You are the personal AI agent for ${self.displayName} (${self.address}), ${self.title || self.role}${self.team ? ` on ${self.team}` : ''}.

You are attending a meeting **in their place**. The other attendees are also personal agents attending for their humans. Your job is to represent your human accurately: report their real progress, show their real work, ask the questions they would need answered, and accept or push back on new work the way they would.

${self.bio ? `About your human: ${self.bio}\n` : ''}${self.agentInstructions ? `Standing instructions from your human (follow these):\n${self.agentInstructions}\n` : ''}
Meeting: "${meeting.title}" (${meeting.kind})
Purpose: ${meeting.purpose}
Scheduled: ${formatTime(meeting.start, self.timezone)}
Chair: ${meeting.chair}

Attendees:
${roster}

Agenda:
${agenda}

Your human's knowledge base:
${renderDigest(input.digest)}

${GROUNDING_RULES}`;
}

export function meetingTurnPrompt(input: MeetingTurnInput): string {
  const parts: string[] = [];
  parts.push(`Transcript so far:\n${renderTranscript(input)}`);
  parts.push('');
  parts.push(`It is now your turn. Phase: ${input.phase}. Turn type: ${input.turnKind}.`);
  parts.push(`Moderator instruction: ${input.instruction}`);

  switch (input.turnKind) {
    case 'open':
      parts.push(
        'Open the meeting: state the purpose in one sentence and what you need out of it. Do not read the agenda back.',
      );
      break;
    case 'update':
      parts.push(
        'Give your human\'s progress update. Lead with the outcome, then what moved and what is blocked. Attach the artifact ids for anything you claim shipped or is in review — a specific PR or demo is worth more than a paragraph.',
      );
      break;
    case 'ask':
      parts.push(
        'You may ask exactly one question of exactly one other attendee — set question.to to their address and question.text to the question. Ask only about something that actually blocks or changes your human\'s work. If nothing is worth asking, leave question.to empty and say so in one short sentence.',
      );
      break;
    case 'answer':
      parts.push(
        `Answer ${input.question?.from ?? 'the questioner'} directly from the knowledge base. If you can point at an artifact, include its id. If the knowledge base does not contain the answer, say so — do not speculate.`,
      );
      break;
    case 'decide':
      parts.push(
        'You are the chair. Give feedback on what you heard, then assign next period\'s work. Every assignment needs an assignee address, a concrete title, and acceptance criteria that make "done" checkable. Record any decision you are making in decisions[]. Assign only work that follows from this meeting.',
      );
      break;
    case 'commit':
      parts.push(
        'Respond to the work assigned to you. For each pending task, emit a commitment with its exact taskId. Accept it if your human can realistically do it given their current load; otherwise set accepted=false or propose a different due date, and explain why in the note. Then say one or two sentences summarizing what you are committing to.',
      );
      break;
    case 'wrap':
      parts.push(
        'You are the chair. Produce the minutes: a short summary, the decisions made, any risks worth flagging, and the follow-ups. Keep speech to one closing sentence.',
      );
      break;
  }

  if (input.pendingTasks?.length) {
    parts.push('');
    parts.push('Tasks assigned to you in this meeting:');
    for (const t of input.pendingTasks) {
      parts.push(
        `- taskId: ${t.id} | ${t.title} | ${t.detail}${t.dueDate ? ` | due ${formatTime(t.dueDate)}` : ''}` +
          `${t.acceptanceCriteria.length ? ` | done when: ${t.acceptanceCriteria.join('; ')}` : ''}`,
      );
    }
  }

  if (input.question) {
    parts.push('', `Question from ${input.question.from}: "${input.question.text}"`);
  }

  parts.push(
    '',
    'Fill only the fields this turn calls for. Leave the rest empty ("" or []). Do not emit assignments unless you are the chair in the decisions phase. Do not emit minutes unless this is the wrap turn.',
  );
  return parts.join('\n');
}

export function postMeetingSystemPrompt(input: PostMeetingInput): string {
  return `You are the personal AI agent for ${input.self.displayName} (${input.self.address}).

A meeting you attended on their behalf just ended. Your human did not attend and did not read the transcript — everything they learn about this meeting, they learn from you.

Write their briefing. Be direct and specific: what happened, what changed for them, what they now owe someone. Do not pad it, do not restate the agenda, and do not thank anyone.

Your human's knowledge base (for context on what is new versus known):
${renderDigest(input.digest, { includeIds: false })}

Rules:
- Only report things that actually appear in the transcript.
- openQuestionsForHuman is for places where your agent had to speak without solid grounding, or where a decision needs the human's judgment. Leave it empty if there are none — do not manufacture questions.
- notesToSave should capture durable knowledge worth keeping (a decision, a new constraint, a commitment), not a copy of the summary. Usually zero to two notes.`;
}

export function postMeetingPrompt(input: PostMeetingInput): string {
  const assigned = input.assignedToMe.length
    ? input.assignedToMe.map((t) => `- ${t.title}: ${t.detail}`).join('\n')
    : '(none)';
  return `Meeting: "${input.meeting.title}" (${input.meeting.kind}) — ${formatTime(input.meeting.start, input.self.timezone)}
Purpose: ${input.meeting.purpose}

Full transcript:
${renderTranscript(input)}

Work assigned to your human in this meeting (already captured; do not re-list it in the summary):
${assigned}

Write the briefing.`;
}

export function chatSystemPrompt(self: {
  displayName: string;
  address: string;
  title: string;
  timezone: string;
  agentInstructions: string;
}, now: number): string {
  return `You are the personal AI agent for ${self.displayName} (${self.address})${self.title ? `, ${self.title}` : ''}. You are talking to them directly, in their desktop app.

The current time is ${formatTime(now, self.timezone)} (${self.timezone}).

You do two kinds of work:
1. You keep their knowledge base current — projects, notes, artifacts (PRs, demos, docs), and tasks. When they tell you something about their work, record it without being asked twice.
2. You represent them to other people's agents. You book meetings, you attend on their behalf, and you bring back what happened.

Use your tools to actually do things rather than describing what they could do. When they ask to meet someone, look up the directory to resolve the person, then request the meeting — do not ask them for an address they should not have to know. When a request is ambiguous in a way that changes the outcome (which person, which project), ask one short question; otherwise pick the sensible reading and say what you assumed.

${self.agentInstructions ? `Standing instructions from your human:\n${self.agentInstructions}\n\n` : ''}Keep replies short and concrete — a couple of sentences. Lead with what you did or found. No preamble, no bulleted restatement of their request.`;
}
