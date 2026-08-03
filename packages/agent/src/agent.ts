import { EventEmitter } from 'node:events';

import {
  type AgentAddress,
  type ArtifactRef,
  type Commitment,
  type Feedback,
  type Meeting,
  type MeetingOutcome,
  type MeetingPhase,
  type Note,
  type ProposedTask,
  type PublicProfile,
  type ServerMessage,
  type Task,
  type TimeSlot,
  type TranscriptEntry,
  DAY,
  HOUR,
  MINUTE,
  formatTime,
  freeSlots,
  id,
  truncate,
} from '@ai-coworker/shared';

import {
  type ChatMessage,
  type ChatOutput,
  type KnowledgeDigest,
  type LLMProvider,
  type ToolSpec,
  createProvider,
  describeGeminiError,
} from './llm/index.js';
import { RelayClient, type ConnectionState } from './relay-client.js';
import { Workspace } from './store.js';

export interface PersonalAgentOptions {
  workspace: Workspace;
  relayUrl: string;
  provider?: LLMProvider;
  /** Emitted alongside the provider so the UI can explain why it is offline. */
  providerReason?: string;
  autoConnect?: boolean;
}

export interface LiveMeetingState {
  meeting: Meeting;
  phase: MeetingPhase;
  transcript: TranscriptEntry[];
  present: AgentAddress[];
  /** Whose turn it is right now, if the relay has told us. */
  speaking?: AgentAddress;
  thinking: boolean;
}

export interface AgentActivity {
  id: string;
  ts: number;
  kind: 'info' | 'meeting' | 'task' | 'error';
  text: string;
}

/**
 * The personal AI. It owns one person's knowledge base, speaks for them in
 * agent-to-agent meetings, and reports back afterwards.
 */
export class PersonalAgent extends EventEmitter {
  readonly workspace: Workspace;
  readonly relay: RelayClient;
  provider: LLMProvider;
  providerReason: string;

  private directoryMap = new Map<AgentAddress, PublicProfile>();
  private live = new Map<string, LiveMeetingState>();
  private pendingAssignments = new Map<string, ProposedTask[]>();
  private commitmentsByMeeting = new Map<string, Commitment[]>();
  private chatHistory: ChatMessage[] = [];
  private activityLog: AgentActivity[] = [];
  /** Set while this agent holds the floor, so waits can be reported to the room. */
  private activeTurn: { meetingId: string } | null = null;

  constructor(options: PersonalAgentOptions) {
    super();
    this.workspace = options.workspace;
    const chosen = options.provider
      ? { provider: options.provider, reason: options.providerReason ?? 'provider supplied' }
      : createProvider();
    this.provider = chosen.provider;
    this.providerReason = chosen.reason;
    // A rate-limit wait should look like waiting, not like the agent hanging —
    // both to its own human and to the room that is holding a turn open for it.
    this.provider.onRateLimit = (waitMs) => {
      const seconds = Math.ceil(waitMs / 1000);
      this.activity('info', `Model rate limit reached — waiting ${seconds}s before continuing.`);
      if (this.activeTurn) {
        this.relay.send({
          type: 'room.working',
          meetingId: this.activeTurn.meetingId,
          note: `waiting ${seconds}s on a model rate limit`,
        });
      }
    };

    this.relay = new RelayClient({
      url: options.relayUrl,
      profile: () => this.workspace.publicProfile(true),
    });
    this.relay.on('message', (msg: ServerMessage) => {
      void this.handleServerMessage(msg).catch((err) => {
        this.activity('error', `Protocol error: ${(err as Error).message}`);
      });
    });
    this.relay.on('state', (state: ConnectionState, error: string | null) => {
      this.emit('connection', state, error);
      if (state === 'online') this.activity('info', 'Connected to the network.');
    });
    this.workspace.on('change', (section: string) => this.emit('workspace', section));

    if (options.autoConnect !== false) this.relay.connect();
  }

  // --- state accessors -----------------------------------------------------

  get directory(): PublicProfile[] {
    return [...this.directoryMap.values()].filter((p) => p.address !== this.workspace.address);
  }

  get connectionState(): ConnectionState {
    return this.relay.state;
  }

  get liveMeetings(): LiveMeetingState[] {
    return [...this.live.values()];
  }

  liveMeeting(meetingId: string): LiveMeetingState | undefined {
    return this.live.get(meetingId);
  }

  get activities(): AgentActivity[] {
    return [...this.activityLog].reverse();
  }

  get chatLog(): ChatMessage[] {
    return [...this.chatHistory];
  }

  private activity(kind: AgentActivity['kind'], text: string): void {
    const entry: AgentActivity = { id: id('act'), ts: Date.now(), kind, text };
    this.activityLog.push(entry);
    if (this.activityLog.length > 200) this.activityLog.shift();
    this.emit('activity', entry);
  }

  // --- knowledge ------------------------------------------------------------

  /**
   * Build the view of the knowledge base an agent will reason over.
   * `audience: 'self'` includes private material; anything else does not.
   */
  digest(audience: 'self' | 'meeting' = 'self', limits = { notes: 12, artifacts: 12, tasks: 15 }): KnowledgeDigest {
    const visible = <T extends { visibility: string }>(items: T[]) =>
      audience === 'self' ? items : items.filter((i) => i.visibility !== 'private');

    return {
      projects: visible(this.workspace.projects).filter((p) => p.status !== 'shipped' || audience === 'self'),
      notes: visible(this.workspace.notes).slice(0, limits.notes),
      artifacts: visible(this.workspace.artifacts).slice(0, limits.artifacts),
      tasks: this.workspace.tasks
        .filter((t) => t.assignee === this.workspace.address && t.status !== 'done' && t.status !== 'dropped')
        .slice(0, limits.tasks),
      feedbackLines: this.workspace.feedback
        .slice(0, 5)
        .map((f) => `${f.from}: ${truncate(f.text, 200)}`),
    };
  }

  private artifactRefs(ids: string[]): ArtifactRef[] {
    const refs: ArtifactRef[] = [];
    for (const artifactId of ids) {
      const a = this.workspace.artifacts.find((x) => x.id === artifactId);
      // Grounding: an agent can only show artifacts that actually exist and are
      // not marked private. A hallucinated id simply produces nothing.
      if (!a || a.visibility === 'private') continue;
      refs.push({
        artifactId: a.id,
        kind: a.kind,
        title: a.title,
        url: a.url,
        summary: a.summary,
        stats: a.stats,
      });
    }
    return refs;
  }

  // --- server message handling ---------------------------------------------

  private async handleServerMessage(msg: ServerMessage): Promise<void> {
    switch (msg.type) {
      case 'hello.ok':
        break;

      case 'directory.update': {
        this.directoryMap = new Map(msg.agents.map((a) => [a.address, a]));
        this.emit('directory', this.directory);
        break;
      }

      case 'meeting.availability.request': {
        // "asap" overrides working-hours preferences: if someone needs their
        // agent now, offering nothing because it is 8pm is the wrong answer.
        const slots = this.availabilityFor(
          msg.request.earliest,
          msg.request.latest,
          msg.request.durationMins,
          { ignoreWorkingHours: msg.request.urgency === 'asap' },
        );
        this.relay.send({
          type: 'meeting.availability.reply',
          reply: {
            negotiationId: msg.request.negotiationId,
            from: this.workspace.address,
            slots,
            declined: slots.length === 0,
            declineReason: slots.length === 0 ? 'No free slot in the requested window.' : undefined,
          },
        });
        this.activity(
          'meeting',
          `${msg.request.organizer} asked for time: offered ${slots.length} slot(s) for "${msg.request.title}".`,
        );
        break;
      }

      case 'meeting.scheduled': {
        await this.workspace.saveMeeting(msg.meeting);
        await this.workspace.addCalendarBlock({
          id: `cal_${msg.meeting.id}`,
          title: msg.meeting.title,
          start: msg.meeting.start,
          end: msg.meeting.end,
          kind: 'meeting',
          meetingId: msg.meeting.id,
        });
        this.activity(
          'meeting',
          `Scheduled "${msg.meeting.title}" for ${formatTime(msg.meeting.start, this.workspace.profile.timezone)}.`,
        );
        this.emit('meeting.scheduled', msg.meeting);
        break;
      }

      case 'meeting.failed': {
        this.activity('error', `Could not schedule a meeting: ${msg.reason}`);
        this.emit('meeting.failed', msg);
        break;
      }

      case 'meeting.cancelled': {
        await this.workspace.setMeetingStatus(msg.meetingId, 'cancelled');
        await this.workspace.removeCalendarBlockForMeeting(msg.meetingId);
        this.activity('meeting', `Meeting cancelled by ${msg.by}: ${msg.reason}`);
        break;
      }

      case 'meeting.starting': {
        await this.workspace.saveMeeting({ ...msg.meeting, status: 'live' });
        this.live.set(msg.meeting.id, {
          meeting: msg.meeting,
          phase: 'opening',
          transcript: [],
          present: [],
          thinking: false,
        });
        this.relay.send({ type: 'meeting.join', meetingId: msg.meeting.id });
        this.activity('meeting', `"${msg.meeting.title}" is starting — joining on your behalf.`);
        this.emit('meeting.live', this.live.get(msg.meeting.id));
        break;
      }

      case 'room.state': {
        const state = this.live.get(msg.meetingId);
        if (state) {
          state.phase = msg.phase;
          state.present = msg.present;
          state.transcript = msg.transcript;
          this.emit('meeting.update', state);
        }
        break;
      }

      case 'room.phase': {
        const state = this.live.get(msg.meetingId);
        if (state) {
          state.phase = msg.phase;
          this.emit('meeting.update', state);
        }
        break;
      }

      case 'room.event': {
        const state = this.live.get(msg.meetingId);
        if (state) {
          state.transcript.push(msg.entry);
          if (msg.entry.kind === 'assignment' && msg.entry.task) {
            const list = this.pendingAssignments.get(msg.meetingId) ?? [];
            list.push(msg.entry.task);
            this.pendingAssignments.set(msg.meetingId, list);
          }
          if (msg.entry.kind === 'commitment' && msg.entry.commitment) {
            const list = this.commitmentsByMeeting.get(msg.meetingId) ?? [];
            list.push(msg.entry.commitment);
            this.commitmentsByMeeting.set(msg.meetingId, list);
          }
          this.emit('meeting.update', state);
        }
        break;
      }

      case 'room.turn': {
        const state = this.live.get(msg.meetingId);
        if (state) {
          state.speaking = msg.speaker;
          this.emit('meeting.update', state);
        }
        if (msg.speaker === this.workspace.address) await this.takeTurn(msg);
        break;
      }

      case 'meeting.ended': {
        await this.finishMeeting(msg);
        break;
      }

      case 'error': {
        this.activity('error', `${msg.code}: ${msg.message}`);
        break;
      }

      case 'pong':
        break;
    }
  }

  // --- scheduling -----------------------------------------------------------

  availabilityFor(
    earliest: number,
    latest: number,
    durationMins: number,
    options: { ignoreWorkingHours?: boolean } = {},
  ): TimeSlot[] {
    const allHours = { days: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 24 * 60 };
    return freeSlots({
      windowStart: earliest,
      windowEnd: latest,
      durationMins,
      workingHours: options.ignoreWorkingHours ? allHours : this.workspace.profile.workingHours,
      busy: this.workspace.calendar,
      granularityMins: 30,
      // "asap" windows are short, so a fine-grained lattice matters more there.
      maxSlots: 60,
    });
  }

  requestMeeting(input: {
    participants: AgentAddress[];
    title: string;
    purpose: string;
    kind?: Meeting['kind'];
    durationMins?: number;
    agenda?: string[];
    urgency?: 'whenever' | 'this_week' | 'asap';
    chair?: AgentAddress;
    earliest?: number;
    latest?: number;
    note?: string;
  }): { ok: boolean; error?: string } {
    if (this.relay.state !== 'online') {
      return { ok: false, error: 'Not connected to the relay.' };
    }
    const participants = [...new Set([this.workspace.address, ...input.participants])];
    if (participants.length < 2) return { ok: false, error: 'A meeting needs at least one other person.' };

    const urgency = input.urgency ?? 'this_week';
    const now = Date.now();
    const earliest = input.earliest ?? now + (urgency === 'asap' ? 2 * MINUTE : HOUR);
    const latest = input.latest ?? now + (urgency === 'asap' ? DAY : 7 * DAY);

    // Default chair: the most senior participant present (a manager if there is
    // one), otherwise the organizer.
    const chair =
      input.chair ??
      participants.find((p) => this.directoryMap.get(p)?.role === 'manager') ??
      (this.workspace.profile.role === 'manager' ? this.workspace.address : participants[0]!);

    this.relay.send({
      type: 'meeting.request',
      request: {
        participants,
        chair,
        title: input.title,
        purpose: input.purpose,
        kind: input.kind ?? 'sync',
        agenda: (input.agenda ?? []).map((title) => ({ id: id('ag'), title })),
        durationMins: input.durationMins ?? 30,
        earliest,
        latest,
        urgency,
        note: input.note,
      },
    });
    this.activity('meeting', `Asked the network for time: "${input.title}".`);
    return { ok: true };
  }

  cancelMeeting(meetingId: string, reason: string): void {
    this.relay.send({ type: 'meeting.cancel', meetingId, reason });
  }

  startMeetingNow(meetingId: string): void {
    this.relay.send({ type: 'meeting.start_now', meetingId });
    this.activity('meeting', 'Asked the relay to run a scheduled meeting immediately.');
  }

  // --- taking a turn in a meeting -------------------------------------------

  private async takeTurn(turn: Extract<ServerMessage, { type: 'room.turn' }>): Promise<void> {
    const state = this.live.get(turn.meetingId);
    if (!state) {
      this.relay.send({ type: 'room.yield', meetingId: turn.meetingId });
      return;
    }
    state.thinking = true;
    this.emit('meeting.update', state);

    // Tell the room we are working. Composing a turn can take a while — a slow
    // model, or waiting out an API rate limit — and without this the moderator
    // cannot tell that apart from a crashed agent.
    const heartbeat = setInterval(() => {
      this.relay.send({ type: 'room.working', meetingId: turn.meetingId });
    }, Math.max(10_000, Math.floor(turn.timeLimitMs / 3)));
    this.activeTurn = { meetingId: turn.meetingId };

    const participants: PublicProfile[] = [
      this.workspace.publicProfile(true),
      ...state.meeting.participants
        .filter((p) => p !== this.workspace.address)
        .map(
          (p) =>
            this.directoryMap.get(p) ?? {
              address: p,
              displayName: p.split('@')[0]!,
              title: '',
              role: 'ic' as const,
              team: '',
              timezone: 'UTC',
              bio: '',
              focusAreas: [],
              online: true,
              lastSeen: Date.now(),
            },
        ),
    ];

    try {
      const output = await this.provider.meetingTurn({
        self: this.workspace.profile,
        meeting: state.meeting,
        phase: turn.phase,
        turnKind: turn.turnKind,
        instruction: turn.instruction,
        transcript: state.transcript,
        digest: this.digest('meeting'),
        participants,
        question: turn.question,
        pendingTasks: turn.pendingTasks?.map((t) => ({
          id: t.id,
          title: t.title,
          detail: t.detail,
          acceptanceCriteria: t.acceptanceCriteria,
          dueDate: t.dueDate,
          priority: t.priority,
        })),
        now: Date.now(),
      });

      const refs = this.artifactRefs(output.showArtifactIds);

      // Order matters: what the agent says, then what it shows, then what it decides.
      if (turn.turnKind === 'answer') {
        this.relay.send({
          type: 'room.answer',
          meetingId: turn.meetingId,
          to: turn.question?.from ?? state.meeting.chair,
          text: output.speech || 'No answer available.',
          refs,
        });
      } else if (output.speech) {
        this.relay.send({
          type: 'room.say',
          meetingId: turn.meetingId,
          text: output.speech,
          refs: refs.length ? refs : undefined,
        });
      } else if (refs.length) {
        this.relay.send({
          type: 'room.demo',
          meetingId: turn.meetingId,
          text: 'Showing the current state of the work.',
          refs,
        });
      }

      if (turn.turnKind === 'ask' && output.question.to && output.question.text) {
        const target = state.meeting.participants.find((p) => p === output.question.to);
        if (target && target !== this.workspace.address) {
          this.relay.send({
            type: 'room.ask',
            meetingId: turn.meetingId,
            to: target,
            question: output.question.text,
          });
        }
      }

      if (turn.turnKind === 'decide') {
        for (const decision of output.decisions) {
          this.relay.send({ type: 'room.decision', meetingId: turn.meetingId, text: decision });
        }
        for (const a of output.assignments) {
          if (!state.meeting.participants.includes(a.assignee)) continue;
          const task: ProposedTask = {
            id: id('task'),
            title: a.title,
            detail: a.detail,
            assignee: a.assignee,
            priority: a.priority,
            dueDate: Date.now() + Math.max(1, a.dueInDays) * DAY,
            acceptanceCriteria: a.acceptanceCriteria,
            projectId: this.workspace.findProject(a.projectHint)?.id,
          };
          this.relay.send({ type: 'room.assign', meetingId: turn.meetingId, task });
        }
      }

      if (turn.turnKind === 'commit') {
        const valid = new Set((turn.pendingTasks ?? []).map((t) => t.id));
        for (const c of output.commitments) {
          if (!valid.has(c.taskId)) continue;
          this.relay.send({
            type: 'room.commit',
            meetingId: turn.meetingId,
            commitment: {
              taskId: c.taskId,
              accepted: c.accepted,
              note: c.note,
              proposedDueDate:
                c.proposedDueInDays > 0 ? Date.now() + c.proposedDueInDays * DAY : undefined,
            },
          });
        }
      }

      if (turn.turnKind === 'wrap' && output.minutes.summary) {
        this.relay.send({
          type: 'room.minutes',
          meetingId: turn.meetingId,
          minutes: {
            summary: output.minutes.summary,
            decisions: output.minutes.decisions,
            risks: output.minutes.risks,
            followUps: output.minutes.followUps,
          },
        });
      }

      for (const q of output.openQuestionsForHuman) {
        this.activity('info', `Needs your input: ${q}`);
      }
    } catch (err) {
      const reason = describeGeminiError(err);
      this.activity('error', `Turn failed (${turn.turnKind}): ${(err as Error).message}`);
      // Say something short and honest in the room rather than pasting an API
      // error into the transcript everyone else has to read.
      this.relay.send({
        type: 'room.say',
        meetingId: turn.meetingId,
        text: `I have to pass this turn — ${reason}.`,
      });
    } finally {
      clearInterval(heartbeat);
      this.activeTurn = null;
      state.thinking = false;
      this.emit('meeting.update', state);
      this.relay.send({ type: 'room.yield', meetingId: turn.meetingId });
    }
  }

  // --- after the meeting ----------------------------------------------------

  private async finishMeeting(msg: Extract<ServerMessage, { type: 'meeting.ended' }>): Promise<void> {
    const me = this.workspace.address;
    await this.workspace.saveMeeting({ ...msg.meeting, status: 'completed' });
    await this.workspace.saveMeetingTranscript(msg.meetingId, msg.transcript, msg.minutes);

    const commitments = new Map(msg.commitments.map((c) => [c.taskId, c]));
    const mine = msg.assignments.filter((a) => a.assignee === me);

    const createdTasks: Task[] = [];
    for (const proposed of mine) {
      const commitment = commitments.get(proposed.id);
      const task = await this.workspace.upsertTask({
        id: proposed.id,
        title: proposed.title,
        detail: proposed.detail,
        assignee: me,
        assignedBy: msg.meeting.chair,
        projectId: proposed.projectId,
        status: 'todo',
        priority: proposed.priority,
        dueDate: commitment?.proposedDueDate ?? proposed.dueDate,
        acceptanceCriteria: proposed.acceptanceCriteria,
        sourceMeetingId: msg.meetingId,
        negotiationNote:
          commitment && !commitment.accepted ? `Your agent pushed back: ${commitment.note}` : undefined,
      });
      createdTasks.push(task);
    }

    // Feedback aimed at me: anything the chair said in the decisions phase, plus
    // anything explicitly addressed to my address.
    const feedbackEntries = msg.transcript.filter(
      (e) =>
        (e.to === me && (e.kind === 'utterance' || e.kind === 'answer')) ||
        (e.phase === 'decisions' && e.kind === 'utterance' && e.speaker === msg.meeting.chair && e.speaker !== me),
    );
    const feedback: Feedback[] = [];
    for (const entry of feedbackEntries) {
      feedback.push(
        await this.workspace.addFeedback({
          from: entry.speaker,
          text: entry.text,
          sentiment: 'neutral',
          meetingId: msg.meetingId,
        }),
      );
    }

    let outcome: MeetingOutcome;
    try {
      const brief = await this.provider.postMeeting({
        self: this.workspace.profile,
        meeting: msg.meeting,
        transcript: msg.transcript,
        digest: this.digest('self'),
        assignedToMe: mine.map((t) => ({ title: t.title, detail: t.detail })),
        now: Date.now(),
      });

      for (const note of brief.notesToSave) {
        await this.workspace.upsertNote({
          title: note.title,
          body: note.body,
          kind: note.kind,
          visibility: 'team',
          projectId: this.workspace.findProject(note.projectHint)?.id,
          tags: ['meeting', msg.meeting.kind],
        });
      }

      outcome = {
        meetingId: msg.meetingId,
        generatedFor: me,
        headline: brief.headline,
        summary: brief.summary,
        myTasks: createdTasks,
        feedbackReceived: feedback,
        decisions: brief.decisions,
        myCommitments: brief.myCommitments,
        openQuestionsForHuman: brief.openQuestionsForHuman,
        createdAt: Date.now(),
      };
    } catch (err) {
      this.activity('error', `Briefing generation failed: ${(err as Error).message}`);
      outcome = {
        meetingId: msg.meetingId,
        generatedFor: me,
        headline: `${msg.meeting.title} ended`,
        summary: msg.minutes?.summary ?? 'The meeting ended; the transcript is available.',
        myTasks: createdTasks,
        feedbackReceived: feedback,
        decisions: msg.transcript.filter((e) => e.kind === 'decision').map((e) => e.text),
        myCommitments: [],
        openQuestionsForHuman: [],
        createdAt: Date.now(),
      };
    }

    await this.workspace.saveMeetingOutcome(msg.meetingId, outcome);
    await this.workspace.removeCalendarBlockForMeeting(msg.meetingId);
    this.live.delete(msg.meetingId);
    this.pendingAssignments.delete(msg.meetingId);
    this.commitmentsByMeeting.delete(msg.meetingId);

    this.activity(
      'meeting',
      `"${msg.meeting.title}" finished. ${outcome.headline}${
        createdTasks.length ? ` (${createdTasks.length} new task(s))` : ''
      }`,
    );
    this.emit('meeting.ended', outcome);
  }

  // --- chat with your own agent --------------------------------------------

  async chat(message: string): Promise<ChatOutput> {
    const output = await this.provider.chat(
      {
        self: this.workspace.profile,
        message,
        history: this.chatHistory.slice(-12),
        digest: this.digest('self'),
        directory: this.directory,
        upcoming: this.workspace.upcomingMeetings().map((m) => ({
          title: m.meeting.title,
          start: m.meeting.start,
          participants: m.meeting.participants.filter((p) => p !== this.workspace.address),
        })),
        now: Date.now(),
      },
      this.toolSpecs(),
      (name, input) => this.runTool(name, input),
    );
    this.chatHistory.push({ role: 'user', content: message });
    this.chatHistory.push({ role: 'assistant', content: output.reply });
    if (this.chatHistory.length > 40) this.chatHistory = this.chatHistory.slice(-40);
    this.emit('chat', output);
    return output;
  }

  clearChat(): void {
    this.chatHistory = [];
  }

  // --- tools ----------------------------------------------------------------

  private toolSpecs(): ToolSpec[] {
    const str = (description: string) => ({ type: 'string', description });
    return [
      {
        name: 'list_projects',
        description: "List your human's projects with status and summary.",
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'create_project',
        description: 'Create or update a project in the knowledge base.',
        input_schema: {
          type: 'object',
          properties: {
            name: str('Project name'),
            summary: str('One or two sentences on what it is and where it stands'),
            status: { type: 'string', enum: ['planning', 'active', 'blocked', 'shipped', 'paused'] },
            visibility: { type: 'string', enum: ['public', 'team', 'private'] },
          },
          required: ['name'],
        },
      },
      {
        name: 'search_knowledge',
        description: 'Keyword search across projects, notes, artifacts and tasks.',
        input_schema: {
          type: 'object',
          properties: { query: str('What to look for') },
          required: ['query'],
        },
      },
      {
        name: 'create_note',
        description:
          'Record a note (an "NB file") about the work: an update, a decision, a blocker, an idea.',
        input_schema: {
          type: 'object',
          properties: {
            title: str('Short title'),
            body: str('Markdown body'),
            kind: { type: 'string', enum: ['update', 'decision', 'idea', 'blocker', 'meeting', 'reference'] },
            visibility: {
              type: 'string',
              enum: ['public', 'team', 'private'],
              description: 'private notes are never shared in meetings',
            },
            project: str('Project name this belongs to, if any'),
          },
          required: ['title', 'body'],
        },
      },
      {
        name: 'add_artifact',
        description:
          'Record something concrete your agent can show in a meeting: a PR, CL, demo, doc, design, or metric.',
        input_schema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['pr', 'cl', 'demo', 'doc', 'metric', 'design', 'incident'] },
            title: str('Title'),
            url: str('Link, if there is one'),
            summary: str('What it is and why it matters'),
            status: { type: 'string', enum: ['draft', 'in_review', 'merged', 'shipped', 'abandoned'] },
            project: str('Project name this belongs to, if any'),
            visibility: { type: 'string', enum: ['public', 'team', 'private'] },
          },
          required: ['kind', 'title', 'summary'],
        },
      },
      {
        name: 'list_tasks',
        description: 'List tasks assigned to your human.',
        input_schema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done', 'dropped', 'open'] },
          },
          required: [],
        },
      },
      {
        name: 'create_task',
        description: 'Add a task for your human.',
        input_schema: {
          type: 'object',
          properties: {
            title: str('What needs doing'),
            detail: str('Any detail'),
            due_in_days: { type: 'integer', description: 'Days from now; 0 for no due date' },
            priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
          },
          required: ['title'],
        },
      },
      {
        name: 'update_task',
        description: 'Change the status of a task. Match it by title text or id.',
        input_schema: {
          type: 'object',
          properties: {
            task: str('Task id or part of its title'),
            status: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done', 'dropped'] },
            note: str('Optional note about the change'),
          },
          required: ['task', 'status'],
        },
      },
      {
        name: 'list_directory',
        description: 'List the other people (and their agents) reachable on the network.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'request_meeting',
        description:
          'Ask the network to find a time and book a meeting. The other agents answer from their own calendars.',
        input_schema: {
          type: 'object',
          properties: {
            participants: {
              type: 'array',
              items: { type: 'string' },
              description: 'Names or addresses of the other attendees',
            },
            title: str('Meeting title'),
            purpose: str('What the meeting is for — this drives what the agents discuss'),
            kind: { type: 'string', enum: ['standup', 'one_on_one', 'review', 'planning', 'sync'] },
            duration_mins: { type: 'integer' },
            urgency: { type: 'string', enum: ['whenever', 'this_week', 'asap'] },
            agenda: { type: 'array', items: { type: 'string' } },
            chair: str('Who runs it; defaults to the manager in the room'),
          },
          required: ['participants', 'purpose'],
        },
      },
      {
        name: 'list_meetings',
        description: 'List upcoming and recent meetings.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'get_meeting_briefing',
        description: 'Read back the briefing your agent wrote after a meeting.',
        input_schema: {
          type: 'object',
          properties: { meeting: str('Meeting id or part of its title') },
          required: ['meeting'],
        },
      },
      {
        name: 'block_time',
        description: 'Block time on your human\'s calendar so other agents will not book over it.',
        input_schema: {
          type: 'object',
          properties: {
            title: str('What the block is for'),
            day_offset: { type: 'integer', description: '0 = today, 1 = tomorrow' },
            start_hour: { type: 'integer', description: 'Local hour, 0-23' },
            duration_mins: { type: 'integer' },
          },
          required: ['title', 'day_offset', 'start_hour', 'duration_mins'],
        },
      },
      {
        name: 'set_working_hours',
        description: 'Set the hours during which meetings may be booked.',
        input_schema: {
          type: 'object',
          properties: {
            start_hour: { type: 'integer' },
            end_hour: { type: 'integer' },
            days: { type: 'array', items: { type: 'integer' }, description: '0=Sun .. 6=Sat' },
          },
          required: ['start_hour', 'end_hour'],
        },
      },
      {
        name: 'brief_me',
        description: 'Summarize what is on your human\'s plate right now.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
    ];
  }

  private resolveAddress(needle: string): AgentAddress | undefined {
    const lower = needle.toLowerCase().trim();
    if (!lower) return undefined;
    const candidates = this.directory;
    return (
      candidates.find((d) => d.address.toLowerCase() === lower)?.address ??
      candidates.find((d) => d.displayName.toLowerCase() === lower)?.address ??
      candidates.find((d) => d.displayName.toLowerCase().split(' ')[0] === lower)?.address ??
      candidates.find((d) => d.displayName.toLowerCase().includes(lower))?.address ??
      candidates.find((d) => lower.includes(d.displayName.toLowerCase().split(' ')[0]!))?.address
    );
  }

  async runTool(name: string, input: Record<string, unknown>): Promise<string> {
    const s = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '');
    const n = (key: string, fallback = 0): number =>
      typeof input[key] === 'number' ? (input[key] as number) : fallback;

    switch (name) {
      case 'list_projects': {
        const projects = this.workspace.projects;
        if (!projects.length) return 'No projects recorded yet.';
        return projects
          .map((p) => `- ${p.name} [${p.status}, ${p.visibility}]: ${p.summary || '(no summary)'}`)
          .join('\n');
      }

      case 'create_project': {
        const existing = this.workspace.findProject(s('name'));
        const project = await this.workspace.upsertProject({
          id: existing?.id,
          name: s('name'),
          summary: s('summary') || existing?.summary || '',
          status: (s('status') as never) || existing?.status || 'active',
          visibility: (s('visibility') as never) || existing?.visibility || 'team',
        });
        return `${existing ? 'Updated' : 'Created'} project "${project.name}" (${project.status}).`;
      }

      case 'search_knowledge': {
        const query = s('query').toLowerCase();
        const terms = query.split(/\s+/).filter((t) => t.length > 2);
        const match = (text: string) => terms.some((t) => text.toLowerCase().includes(t));
        const hits: string[] = [];
        for (const p of this.workspace.projects) {
          if (match(`${p.name} ${p.summary}`)) hits.push(`[project] ${p.name}: ${truncate(p.summary, 160)}`);
        }
        for (const nt of this.workspace.notes) {
          if (match(`${nt.title} ${nt.body}`)) hits.push(`[note/${nt.kind}] ${nt.title}: ${truncate(nt.body, 200)}`);
        }
        for (const a of this.workspace.artifacts) {
          if (match(`${a.title} ${a.summary}`))
            hits.push(`[${a.kind}] ${a.title} (${a.status}): ${truncate(a.summary, 160)}${a.url ? ` ${a.url}` : ''}`);
        }
        for (const t of this.workspace.tasks) {
          if (match(`${t.title} ${t.detail}`)) hits.push(`[task/${t.status}] ${t.title}`);
        }
        return hits.length ? hits.slice(0, 15).join('\n') : `Nothing in the knowledge base matches "${s('query')}".`;
      }

      case 'create_note': {
        const note = await this.workspace.upsertNote({
          title: s('title'),
          body: s('body'),
          kind: (s('kind') as Note['kind']) || 'update',
          visibility: (s('visibility') as never) || 'team',
          projectId: this.workspace.findProject(s('project'))?.id,
        });
        return `Saved note "${note.title}" (${note.kind}, ${note.visibility}).`;
      }

      case 'add_artifact': {
        const artifact = await this.workspace.upsertArtifact({
          kind: (s('kind') as never) || 'pr',
          title: s('title'),
          url: s('url') || undefined,
          summary: s('summary'),
          status: (s('status') as never) || 'in_review',
          visibility: (s('visibility') as never) || 'team',
          projectId: this.workspace.findProject(s('project'))?.id,
        });
        return `Recorded ${artifact.kind} "${artifact.title}" (${artifact.status}). Your agent can now show this in meetings.`;
      }

      case 'list_tasks': {
        const filter = s('status');
        let tasks = this.workspace.tasks.filter((t) => t.assignee === this.workspace.address);
        if (filter && filter !== 'open') tasks = tasks.filter((t) => t.status === filter);
        else if (filter === 'open') tasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'dropped');
        if (!tasks.length) return 'No tasks match.';
        return tasks
          .map(
            (t) =>
              `- [${t.status}] ${t.title}${t.dueDate ? ` (due ${formatTime(t.dueDate, this.workspace.profile.timezone)})` : ''}` +
              `${t.assignedBy !== this.workspace.address ? ` — from ${t.assignedBy}` : ''}` +
              `${t.negotiationNote ? `\n    ${t.negotiationNote}` : ''}`,
          )
          .join('\n');
      }

      case 'create_task': {
        const days = n('due_in_days', 0);
        const task = await this.workspace.upsertTask({
          title: s('title'),
          detail: s('detail'),
          priority: (s('priority') as never) || 'normal',
          dueDate: days > 0 ? Date.now() + days * DAY : undefined,
        });
        return `Added task "${task.title}".`;
      }

      case 'update_task': {
        const needle = s('task').toLowerCase();
        const task =
          this.workspace.tasks.find((t) => t.id === s('task')) ??
          this.workspace.tasks.find((t) => t.title.toLowerCase().includes(needle));
        if (!task) return `No task matches "${s('task')}".`;
        await this.workspace.upsertTask({
          id: task.id,
          title: task.title,
          status: (s('status') as never) || task.status,
          detail: s('note') ? `${task.detail}\n\n${s('note')}`.trim() : task.detail,
        });
        return `"${task.title}" is now ${s('status')}.`;
      }

      case 'list_directory': {
        const people = this.directory;
        if (!people.length) return 'Nobody else is on the network right now.';
        return people
          .map(
            (p) =>
              `- ${p.displayName} <${p.address}> — ${p.title || p.role}${p.team ? `, ${p.team}` : ''}` +
              `${p.focusAreas.length ? ` (focus: ${p.focusAreas.join(', ')})` : ''} ${p.online ? '[online]' : '[offline]'}`,
          )
          .join('\n');
      }

      case 'request_meeting': {
        const raw = Array.isArray(input.participants) ? (input.participants as unknown[]) : [];
        const resolved: AgentAddress[] = [];
        const unresolved: string[] = [];
        for (const entry of raw) {
          if (typeof entry !== 'string') continue;
          const address = this.resolveAddress(entry);
          if (address) resolved.push(address);
          else unresolved.push(entry);
        }
        if (!resolved.length) {
          return `Could not resolve ${unresolved.join(', ') || 'anyone'} on the network. Available: ${
            this.directory.map((d) => d.displayName).join(', ') || 'nobody'
          }.`;
        }
        const agenda = Array.isArray(input.agenda)
          ? (input.agenda as unknown[]).filter((a): a is string => typeof a === 'string')
          : [];
        const result = this.requestMeeting({
          participants: resolved,
          title: s('title') || `Sync: ${truncate(s('purpose'), 50)}`,
          purpose: s('purpose'),
          kind: (s('kind') as never) || 'sync',
          durationMins: n('duration_mins', 30),
          urgency: (s('urgency') as never) || 'this_week',
          agenda,
          chair: s('chair') ? this.resolveAddress(s('chair')) : undefined,
        });
        if (!result.ok) return `Could not request the meeting: ${result.error}`;
        const names = resolved.map((a) => this.directoryMap.get(a)?.displayName ?? a);
        return `Asked ${names.join(' and ')}'s agent(s) for time. I'll book the first slot everyone is free.${
          unresolved.length ? ` (Could not resolve: ${unresolved.join(', ')}.)` : ''
        }`;
      }

      case 'list_meetings': {
        const upcoming = this.workspace.upcomingMeetings();
        const past = this.workspace.meetings.filter((m) => m.meeting.status === 'completed').slice(0, 5);
        const lines: string[] = [];
        if (upcoming.length) {
          lines.push('Upcoming:');
          for (const m of upcoming) {
            lines.push(
              `- "${m.meeting.title}" ${formatTime(m.meeting.start, this.workspace.profile.timezone)} with ${m.meeting.participants
                .filter((p) => p !== this.workspace.address)
                .join(', ')}`,
            );
          }
        }
        if (past.length) {
          lines.push('Recent:');
          for (const m of past) {
            lines.push(`- "${m.meeting.title}" — ${m.outcome?.headline ?? 'completed'}`);
          }
        }
        return lines.join('\n') || 'No meetings scheduled.';
      }

      case 'get_meeting_briefing': {
        const needle = s('meeting').toLowerCase();
        const record =
          this.workspace.meeting(s('meeting')) ??
          this.workspace.meetings.find((m) => m.meeting.title.toLowerCase().includes(needle));
        if (!record) return `No meeting matches "${s('meeting')}".`;
        if (!record.outcome) return `"${record.meeting.title}" has no briefing yet (status: ${record.meeting.status}).`;
        const o = record.outcome;
        return [
          o.headline,
          '',
          o.summary,
          o.decisions.length ? `\nDecisions:\n${o.decisions.map((d) => `- ${d}`).join('\n')}` : '',
          o.myTasks.length ? `\nYour new tasks:\n${o.myTasks.map((t) => `- ${t.title}`).join('\n')}` : '',
          o.openQuestionsForHuman.length
            ? `\nNeeds you:\n${o.openQuestionsForHuman.map((q) => `- ${q}`).join('\n')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n');
      }

      case 'block_time': {
        const day = new Date();
        day.setDate(day.getDate() + n('day_offset', 0));
        day.setHours(n('start_hour', 9), 0, 0, 0);
        const start = day.getTime();
        const end = start + Math.max(15, n('duration_mins', 60)) * MINUTE;
        await this.workspace.addCalendarBlock({ title: s('title'), start, end, kind: 'focus' });
        return `Blocked ${formatTime(start, this.workspace.profile.timezone)} – ${formatTime(
          end,
          this.workspace.profile.timezone,
        )} for "${s('title')}". Other agents will schedule around it.`;
      }

      case 'set_working_hours': {
        const days = Array.isArray(input.days)
          ? (input.days as unknown[]).filter((d): d is number => typeof d === 'number')
          : this.workspace.profile.workingHours.days;
        await this.workspace.updateProfile({
          workingHours: {
            days,
            startMinute: n('start_hour', 9) * 60,
            endMinute: n('end_hour', 18) * 60,
          },
        });
        return `Working hours set to ${n('start_hour', 9)}:00–${n('end_hour', 18)}:00.`;
      }

      case 'brief_me': {
        const tasks = this.workspace.tasks.filter(
          (t) => t.assignee === this.workspace.address && t.status !== 'done' && t.status !== 'dropped',
        );
        const upcoming = this.workspace.upcomingMeetings();
        const recent = this.workspace.meetings.filter((m) => m.outcome).slice(0, 3);
        const lines = [
          `${tasks.length} open task(s), ${upcoming.length} upcoming meeting(s).`,
          tasks.length ? `\nOpen work:\n${tasks.slice(0, 8).map((t) => `- [${t.status}] ${t.title}`).join('\n')}` : '',
          upcoming.length
            ? `\nComing up:\n${upcoming
                .map(
                  (m) =>
                    `- "${m.meeting.title}" ${formatTime(m.meeting.start, this.workspace.profile.timezone)}`,
                )
                .join('\n')}`
            : '',
          recent.length
            ? `\nRecent meeting outcomes:\n${recent.map((m) => `- ${m.outcome!.headline}`).join('\n')}`
            : '',
        ];
        return lines.filter(Boolean).join('\n');
      }

      default:
        return `Unknown tool: ${name}`;
    }
  }

  async shutdown(): Promise<void> {
    this.relay.close();
    await this.workspace.flush();
  }
}
