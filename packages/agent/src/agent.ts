import { EventEmitter } from 'node:events';

import {
  type AgentAddress,
  type ArtifactRef,
  type ChannelId,
  type ClientMessage,
  type Commitment,
  type Feedback,
  type Invite,
  type Meeting,
  type MeetingOutcome,
  type MeetingPhase,
  type Message,
  type MessageId,
  type Note,
  type Presence,
  type ProposedTask,
  type PublicProfile,
  type SearchResults,
  type ServerMessage,
  type Task,
  type TimeSlot,
  type TranscriptEntry,
  type UserStatus,
  type Workspace,
  type WorkspaceId,
  type WorkspaceRole,
  DAY,
  HOUR,
  MINUTE,
  formatTime,
  freeSlots,
  handleFor,
  id,
  isDirect,
  messagePreview,
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
import type { RelayClient, ConnectionState } from './relay-client.js';
import { RelayNetwork } from './relay-network.js';
import { KnowledgeBase } from './store.js';
import { WorkspaceBook, type WorkspaceState } from './workspaces.js';

export interface PersonalAgentOptions {
  knowledge: KnowledgeBase;
  relayUrl: string;
  provider?: LLMProvider;
  /** Emitted alongside the provider so the UI can explain why it is offline. */
  providerReason?: string;
  autoConnect?: boolean;
}

/** Something worth interrupting the person for. */
export interface AgentNotification {
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  channelLabel: string;
  author: string;
  title: string;
  body: string;
  /** True when the person was named directly rather than in passing. */
  mention: boolean;
  messageId: MessageId;
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
  readonly knowledge: KnowledgeBase;
  readonly network: RelayNetwork;
  readonly workspaces = new WorkspaceBook();
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
  /** Which relay a live meeting arrived on, so room traffic goes back the same way. */
  private meetingRelay = new Map<string, RelayClient>();
  /** The workspace the UI currently has open, so tools default sensibly. */
  private focusedWorkspace = '';

  constructor(options: PersonalAgentOptions) {
    super();
    this.knowledge = options.knowledge;
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
        this.roomSend(this.activeTurn.meetingId, {
          type: 'room.working',
          meetingId: this.activeTurn.meetingId,
          note: `waiting ${seconds}s on a model rate limit`,
        });
      }
    };

    this.network = new RelayNetwork({
      profile: () => this.knowledge.publicProfile(true),
      autoConnect: options.autoConnect,
    });
    this.network.on('message', (msg: ServerMessage, client: RelayClient) => {
      void this.handleServerMessage(msg, client).catch((err) => {
        this.activity('error', `Protocol error: ${(err as Error).message}`);
      });
    });
    this.network.on('state', (state: ConnectionState, error: string | null, client: RelayClient) => {
      this.emit('connection', state, error, client.url);
      if (state === 'online') {
        this.activity('info', `Connected to ${client.url}.`);
        // Re-assert a custom status the person set while offline.
        const { status, presence } = this.knowledge.client;
        client.send({ type: 'presence.set', presence, status });
      }
      if (state === 'offline' || state === 'error') this.workspaces.forgetRelay(client.url);
    });

    this.workspaces.on('change', () => this.emit('workspaces'));
    this.workspaces.on('message', (message: Message, state: WorkspaceState) =>
      this.onIncomingMessage(message, state),
    );
    this.workspaces.on('workspace.removed', (workspace: { name: string }, reason: string) => {
      this.activity('info', `${workspace.name}: ${reason}`);
    });

    this.knowledge.on('change', (section: string) => this.emit('knowledge', section));

    // The configured relay is the primary; anything the person joined earlier
    // on another relay comes back with it.
    const saved = this.knowledge.relays.filter((url) => url !== options.relayUrl);
    this.network.add(options.relayUrl);
    for (const url of saved) this.network.add(url);
    void this.knowledge.setRelays([options.relayUrl, ...saved]);
  }

  /** The primary relay: where meetings and the directory come from. */
  get relay(): RelayClient {
    return this.network.primary;
  }

  // --- state accessors -----------------------------------------------------

  get directory(): PublicProfile[] {
    return [...this.directoryMap.values()].filter((p) => p.address !== this.knowledge.address);
  }

  get connectionState(): ConnectionState {
    return this.network.state;
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
      projects: visible(this.knowledge.projects).filter((p) => p.status !== 'shipped' || audience === 'self'),
      notes: visible(this.knowledge.notes).slice(0, limits.notes),
      artifacts: visible(this.knowledge.artifacts).slice(0, limits.artifacts),
      tasks: this.knowledge.tasks
        .filter((t) => t.assignee === this.knowledge.address && t.status !== 'done' && t.status !== 'dropped')
        .slice(0, limits.tasks),
      feedbackLines: this.knowledge.feedback
        .slice(0, 5)
        .map((f) => `${f.from}: ${truncate(f.text, 200)}`),
    };
  }

  private artifactRefs(ids: string[]): ArtifactRef[] {
    const refs: ArtifactRef[] = [];
    for (const artifactId of ids) {
      const a = this.knowledge.artifacts.find((x) => x.id === artifactId);
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

  private async handleServerMessage(msg: ServerMessage, client: RelayClient): Promise<void> {
    // Everything workspace-shaped is replicated by the book, which knows how to
    // merge history and recompute unread counts.
    if (this.workspaces.apply(msg, client.url)) {
      if (msg.type === 'workspace.snapshot' && !this.focusedWorkspace) {
        this.focusedWorkspace = this.knowledge.client.lastWorkspace || msg.workspace.id;
      }
      return;
    }

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
        client.send({
          type: 'meeting.availability.reply',
          reply: {
            negotiationId: msg.request.negotiationId,
            from: this.knowledge.address,
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
        this.meetingRelay.set(msg.meeting.id, client);
        await this.knowledge.saveMeeting(msg.meeting);
        await this.knowledge.addCalendarBlock({
          id: `cal_${msg.meeting.id}`,
          title: msg.meeting.title,
          start: msg.meeting.start,
          end: msg.meeting.end,
          kind: 'meeting',
          meetingId: msg.meeting.id,
        });
        this.activity(
          'meeting',
          `Scheduled "${msg.meeting.title}" for ${formatTime(msg.meeting.start, this.knowledge.profile.timezone)}.`,
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
        await this.knowledge.setMeetingStatus(msg.meetingId, 'cancelled');
        await this.knowledge.removeCalendarBlockForMeeting(msg.meetingId);
        this.activity('meeting', `Meeting cancelled by ${msg.by}: ${msg.reason}`);
        break;
      }

      case 'meeting.starting': {
        await this.knowledge.saveMeeting({ ...msg.meeting, status: 'live' });
        this.live.set(msg.meeting.id, {
          meeting: msg.meeting,
          phase: 'opening',
          transcript: [],
          present: [],
          thinking: false,
        });
        this.meetingRelay.set(msg.meeting.id, client);
        client.send({ type: 'meeting.join', meetingId: msg.meeting.id });
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
        if (msg.speaker === this.knowledge.address) await this.takeTurn(msg);
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
      workingHours: options.ignoreWorkingHours ? allHours : this.knowledge.profile.workingHours,
      busy: this.knowledge.calendar,
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
    workspaceId?: WorkspaceId;
    channelId?: ChannelId;
  }): { ok: boolean; error?: string } {
    const workspaceId = input.workspaceId ?? this.focusedWorkspaceId;
    const client = this.clientFor(workspaceId);
    if (!client || client.state !== 'online') {
      return { ok: false, error: 'Not connected to the relay.' };
    }
    const participants = [...new Set([this.knowledge.address, ...input.participants])];
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
      (this.knowledge.profile.role === 'manager' ? this.knowledge.address : participants[0]!);

    client.send({
      type: 'meeting.request',
      request: {
        workspaceId,
        channelId: input.channelId,
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
    this.roomSend(meetingId, { type: 'meeting.cancel', meetingId, reason });
  }

  startMeetingNow(meetingId: string): void {
    this.roomSend(meetingId, { type: 'meeting.start_now', meetingId });
    this.activity('meeting', 'Asked the relay to run a scheduled meeting immediately.');
  }

  /**
   * Send into a meeting on whichever relay is hosting it. Meetings booked
   * before this process started fall back to the primary relay.
   */
  private roomSend(meetingId: string, message: ClientMessage): boolean {
    const client = this.meetingRelay.get(meetingId) ?? this.network.primary;
    return client.send(message);
  }

  // --- taking a turn in a meeting -------------------------------------------

  private async takeTurn(turn: Extract<ServerMessage, { type: 'room.turn' }>): Promise<void> {
    const state = this.live.get(turn.meetingId);
    if (!state) {
      this.roomSend(turn.meetingId, { type: 'room.yield', meetingId: turn.meetingId });
      return;
    }
    state.thinking = true;
    this.emit('meeting.update', state);

    // Tell the room we are working. Composing a turn can take a while — a slow
    // model, or waiting out an API rate limit — and without this the moderator
    // cannot tell that apart from a crashed agent.
    const heartbeat = setInterval(() => {
      this.roomSend(turn.meetingId, { type: 'room.working', meetingId: turn.meetingId });
    }, Math.max(10_000, Math.floor(turn.timeLimitMs / 3)));
    this.activeTurn = { meetingId: turn.meetingId };

    const participants: PublicProfile[] = [
      this.knowledge.publicProfile(true),
      ...state.meeting.participants
        .filter((p) => p !== this.knowledge.address)
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
        self: this.knowledge.profile,
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
        this.roomSend(turn.meetingId, {
          type: 'room.answer',
          meetingId: turn.meetingId,
          to: turn.question?.from ?? state.meeting.chair,
          text: output.speech || 'No answer available.',
          refs,
        });
      } else if (output.speech) {
        this.roomSend(turn.meetingId, {
          type: 'room.say',
          meetingId: turn.meetingId,
          text: output.speech,
          refs: refs.length ? refs : undefined,
        });
      } else if (refs.length) {
        this.roomSend(turn.meetingId, {
          type: 'room.demo',
          meetingId: turn.meetingId,
          text: 'Showing the current state of the work.',
          refs,
        });
      }

      if (turn.turnKind === 'ask' && output.question.to && output.question.text) {
        const target = state.meeting.participants.find((p) => p === output.question.to);
        if (target && target !== this.knowledge.address) {
          this.roomSend(turn.meetingId, {
            type: 'room.ask',
            meetingId: turn.meetingId,
            to: target,
            question: output.question.text,
          });
        }
      }

      if (turn.turnKind === 'decide') {
        for (const decision of output.decisions) {
          this.roomSend(turn.meetingId, { type: 'room.decision', meetingId: turn.meetingId, text: decision });
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
            projectId: this.knowledge.findProject(a.projectHint)?.id,
          };
          this.roomSend(turn.meetingId, { type: 'room.assign', meetingId: turn.meetingId, task });
        }
      }

      if (turn.turnKind === 'commit') {
        const valid = new Set((turn.pendingTasks ?? []).map((t) => t.id));
        for (const c of output.commitments) {
          if (!valid.has(c.taskId)) continue;
          this.roomSend(turn.meetingId, {
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
        this.roomSend(turn.meetingId, {
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
      this.roomSend(turn.meetingId, {
        type: 'room.say',
        meetingId: turn.meetingId,
        text: `I have to pass this turn — ${reason}.`,
      });
    } finally {
      clearInterval(heartbeat);
      this.activeTurn = null;
      state.thinking = false;
      this.emit('meeting.update', state);
      this.roomSend(turn.meetingId, { type: 'room.yield', meetingId: turn.meetingId });
    }
  }

  // --- after the meeting ----------------------------------------------------

  private async finishMeeting(msg: Extract<ServerMessage, { type: 'meeting.ended' }>): Promise<void> {
    const me = this.knowledge.address;
    await this.knowledge.saveMeeting({ ...msg.meeting, status: 'completed' });
    await this.knowledge.saveMeetingTranscript(msg.meetingId, msg.transcript, msg.minutes);

    const commitments = new Map(msg.commitments.map((c) => [c.taskId, c]));
    const mine = msg.assignments.filter((a) => a.assignee === me);

    const createdTasks: Task[] = [];
    for (const proposed of mine) {
      const commitment = commitments.get(proposed.id);
      const task = await this.knowledge.upsertTask({
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
        await this.knowledge.addFeedback({
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
        self: this.knowledge.profile,
        meeting: msg.meeting,
        transcript: msg.transcript,
        digest: this.digest('self'),
        assignedToMe: mine.map((t) => ({ title: t.title, detail: t.detail })),
        now: Date.now(),
      });

      for (const note of brief.notesToSave) {
        await this.knowledge.upsertNote({
          title: note.title,
          body: note.body,
          kind: note.kind,
          visibility: 'team',
          projectId: this.knowledge.findProject(note.projectHint)?.id,
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

    await this.knowledge.saveMeetingOutcome(msg.meetingId, outcome);
    await this.knowledge.removeCalendarBlockForMeeting(msg.meetingId);
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

  // --- workspaces -----------------------------------------------------------

  /** The workspace the person is looking at, or the first one they belong to. */
  get focusedWorkspaceId(): WorkspaceId {
    if (this.focusedWorkspace && this.workspaces.get(this.focusedWorkspace)) return this.focusedWorkspace;
    return this.workspaces.ids[0] ?? '';
  }

  focusWorkspace(workspaceId: WorkspaceId, channelId?: ChannelId): void {
    if (!this.workspaces.get(workspaceId)) return;
    this.focusedWorkspace = workspaceId;
    void this.knowledge.rememberPlace(workspaceId, channelId);
    this.emit('workspaces');
  }

  private clientFor(workspaceId: WorkspaceId): RelayClient | undefined {
    const url = this.workspaces.relayFor(workspaceId);
    if (!url) return this.network.urls.length ? this.network.primary : undefined;
    return this.network.client(url);
  }

  /** Send one frame to the relay that owns a workspace. */
  private toWorkspace(workspaceId: WorkspaceId, message: ClientMessage): boolean {
    const client = this.clientFor(workspaceId);
    if (!client) return false;
    return client.send(message);
  }

  addRelay(url: string): void {
    const trimmed = url.trim();
    if (!trimmed || this.network.has(trimmed)) return;
    this.network.add(trimmed);
    void this.knowledge.setRelays([...this.network.urls]);
    this.activity('info', `Connecting to ${trimmed}.`);
  }

  removeRelay(url: string): void {
    if (this.network.urls.length <= 1) return;
    this.network.remove(url);
    this.workspaces.forgetRelay(url);
    void this.knowledge.setRelays([...this.network.urls]);
  }

  createWorkspace(input: {
    name: string;
    description?: string;
    icon?: string;
    color?: string;
    discoverable?: boolean;
    channels?: string[];
    relayUrl?: string;
  }): boolean {
    const client = input.relayUrl ? this.network.client(input.relayUrl) : this.network.primary;
    if (!client) return false;
    return client.send({ type: 'workspace.create', ...input });
  }

  joinWorkspace(input: { code?: string; slug?: string; relayUrl?: string }): boolean {
    // An invitation code is only valid on the relay that issued it, so when the
    // person pastes one we offer it to every relay we are connected to.
    if (input.relayUrl) {
      return this.network.send(input.relayUrl, {
        type: 'workspace.join',
        code: input.code,
        slug: input.slug,
      });
    }
    let sent = false;
    for (const client of this.network.clientList) {
      sent = client.send({ type: 'workspace.join', code: input.code, slug: input.slug }) || sent;
    }
    return sent;
  }

  leaveWorkspace(workspaceId: WorkspaceId): boolean {
    return this.toWorkspace(workspaceId, { type: 'workspace.leave', workspaceId });
  }

  updateWorkspace(
    workspaceId: WorkspaceId,
    patch: Partial<Pick<Workspace, 'name' | 'description' | 'icon' | 'color' | 'invitePolicy' | 'discoverable'>>,
  ): boolean {
    return this.toWorkspace(workspaceId, { type: 'workspace.update', workspaceId, patch });
  }

  deleteWorkspace(workspaceId: WorkspaceId): boolean {
    return this.toWorkspace(workspaceId, { type: 'workspace.delete', workspaceId });
  }

  discoverWorkspaces(): void {
    for (const client of this.network.clientList) client.send({ type: 'workspace.discover' });
  }

  setMemberRole(workspaceId: WorkspaceId, address: AgentAddress, role: WorkspaceRole): boolean {
    return this.toWorkspace(workspaceId, { type: 'workspace.set_role', workspaceId, address, role });
  }

  removeMember(workspaceId: WorkspaceId, address: AgentAddress): boolean {
    return this.toWorkspace(workspaceId, { type: 'workspace.remove_member', workspaceId, address });
  }

  setWorkspaceProfile(workspaceId: WorkspaceId, patch: { displayName?: string; title?: string }): boolean {
    return this.toWorkspace(workspaceId, { type: 'workspace.profile', workspaceId, ...patch });
  }

  createInvite(
    workspaceId: WorkspaceId,
    input: {
      invitedAddress?: AgentAddress;
      role?: WorkspaceRole;
      expiresInHours?: number;
      maxUses?: number;
      channels?: ChannelId[];
    } = {},
  ): boolean {
    return this.toWorkspace(workspaceId, { type: 'invite.create', workspaceId, ...input });
  }

  revokeInvite(workspaceId: WorkspaceId, code: string): boolean {
    return this.toWorkspace(workspaceId, { type: 'invite.revoke', workspaceId, code });
  }

  listInvites(workspaceId: WorkspaceId): boolean {
    return this.toWorkspace(workspaceId, { type: 'invite.list', workspaceId });
  }

  // --- channels -------------------------------------------------------------

  createChannel(
    workspaceId: WorkspaceId,
    input: { name: string; kind?: 'public' | 'private'; topic?: string; purpose?: string; members?: AgentAddress[] },
  ): boolean {
    return this.toWorkspace(workspaceId, { type: 'channel.create', workspaceId, ...input });
  }

  updateChannel(
    workspaceId: WorkspaceId,
    channelId: ChannelId,
    patch: { name?: string; topic?: string; purpose?: string },
  ): boolean {
    return this.toWorkspace(workspaceId, { type: 'channel.update', workspaceId, channelId, patch });
  }

  archiveChannel(workspaceId: WorkspaceId, channelId: ChannelId, archived: boolean): boolean {
    return this.toWorkspace(workspaceId, { type: 'channel.archive', workspaceId, channelId, archived });
  }

  joinChannel(workspaceId: WorkspaceId, channelId: ChannelId): boolean {
    return this.toWorkspace(workspaceId, { type: 'channel.join', workspaceId, channelId });
  }

  leaveChannel(workspaceId: WorkspaceId, channelId: ChannelId): boolean {
    return this.toWorkspace(workspaceId, { type: 'channel.leave', workspaceId, channelId });
  }

  addToChannel(workspaceId: WorkspaceId, channelId: ChannelId, addresses: AgentAddress[]): boolean {
    return this.toWorkspace(workspaceId, { type: 'channel.invite', workspaceId, channelId, addresses });
  }

  removeFromChannel(workspaceId: WorkspaceId, channelId: ChannelId, address: AgentAddress): boolean {
    return this.toWorkspace(workspaceId, { type: 'channel.kick', workspaceId, channelId, address });
  }

  openDirectMessage(workspaceId: WorkspaceId, addresses: AgentAddress[]): boolean {
    return this.toWorkspace(workspaceId, { type: 'dm.open', workspaceId, addresses });
  }

  // --- messages -------------------------------------------------------------

  sendMessage(input: {
    workspaceId: WorkspaceId;
    channelId: ChannelId;
    text: string;
    threadRootId?: MessageId;
    alsoSendToChannel?: boolean;
    refs?: ArtifactRef[];
    clientId?: string;
    viaAgent?: boolean;
  }): boolean {
    return this.toWorkspace(input.workspaceId, { type: 'message.send', ...input });
  }

  editMessage(workspaceId: WorkspaceId, messageId: MessageId, text: string): boolean {
    return this.toWorkspace(workspaceId, { type: 'message.edit', workspaceId, messageId, text });
  }

  deleteMessage(workspaceId: WorkspaceId, messageId: MessageId): boolean {
    return this.toWorkspace(workspaceId, { type: 'message.delete', workspaceId, messageId });
  }

  reactToMessage(workspaceId: WorkspaceId, messageId: MessageId, emoji: string, on: boolean): boolean {
    return this.toWorkspace(workspaceId, { type: 'message.react', workspaceId, messageId, emoji, on });
  }

  pinMessage(workspaceId: WorkspaceId, messageId: MessageId, pinned: boolean): boolean {
    return this.toWorkspace(workspaceId, { type: 'message.pin', workspaceId, messageId, pinned });
  }

  fetchHistory(workspaceId: WorkspaceId, channelId: ChannelId, before?: number): boolean {
    return this.toWorkspace(workspaceId, { type: 'history.fetch', workspaceId, channelId, before });
  }

  fetchThread(workspaceId: WorkspaceId, rootId: MessageId): boolean {
    return this.toWorkspace(workspaceId, { type: 'thread.fetch', workspaceId, rootId });
  }

  sendTyping(workspaceId: WorkspaceId, channelId: ChannelId): boolean {
    return this.toWorkspace(workspaceId, { type: 'typing', workspaceId, channelId });
  }

  markRead(workspaceId: WorkspaceId, channelId: ChannelId, ts = Date.now()): boolean {
    return this.toWorkspace(workspaceId, { type: 'read.set', workspaceId, channelId, ts });
  }

  searchMessages(
    workspaceId: WorkspaceId,
    query: string,
    options: { channelId?: ChannelId; from?: AgentAddress; limit?: number } = {},
  ): boolean {
    return this.toWorkspace(workspaceId, { type: 'search', workspaceId, query, ...options });
  }

  async setStatus(status: UserStatus, presence?: Presence): Promise<void> {
    await this.knowledge.setStatus(status, presence);
    for (const client of this.network.clientList) {
      client.send({ type: 'presence.set', presence, status });
    }
  }

  // --- notifications --------------------------------------------------------

  /**
   * Decide whether a message deserves the person's attention, honouring the
   * mute and do-not-disturb choices they made locally. The relay is never told
   * any of this — what you silence is nobody else's business.
   */
  private onIncomingMessage(message: Message, state: WorkspaceState): void {
    if (message.author === state.me.address) return;
    if (message.kind === 'system') return;
    if (message.deletedAt) return;

    const channel = state.channels.get(message.channelId);
    if (!channel) return;

    const workspacePrefs = this.knowledge.prefs(state.workspace.id);
    const channelPrefs = this.knowledge.channelPrefs(state.workspace.id, message.channelId);
    const mention = message.mentions.includes(state.me.address) || Boolean(message.broadcast);
    const direct = isDirect(channel);

    if (workspacePrefs.dndUntil > Date.now()) return;
    if (channelPrefs.muted && !mention) return;

    const level = channelPrefs.notify === 'all' ? workspacePrefs.notify : channelPrefs.notify;
    if (level === 'nothing') return;
    if (level === 'mentions' && !mention && !direct) return;
    if (!mention && !direct && level !== 'all') return;

    const author = state.members.get(message.author)?.displayName ?? message.author;
    const label = this.workspaces.label(state.workspace.id, message.channelId);
    const notification: AgentNotification = {
      workspaceId: state.workspace.id,
      channelId: message.channelId,
      channelLabel: label,
      author,
      title: direct ? `${author} · ${state.workspace.name}` : `${label} · ${state.workspace.name}`,
      body: `${direct ? '' : `${author}: `}${messagePreview(message.text, 140)}`,
      mention,
      messageId: message.id,
    };
    this.emit('notification', notification);
    if (mention) {
      this.activity('info', `${author} mentioned you in ${label} (${state.workspace.name}).`);
    }
  }

  // --- chat with your own agent --------------------------------------------

  async chat(message: string): Promise<ChatOutput> {
    const output = await this.provider.chat(
      {
        self: this.knowledge.profile,
        message,
        history: this.chatHistory.slice(-12),
        digest: this.digest('self'),
        directory: this.directory,
        upcoming: this.knowledge.upcomingMeetings().map((m) => ({
          title: m.meeting.title,
          start: m.meeting.start,
          participants: m.meeting.participants.filter((p) => p !== this.knowledge.address),
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
      {
        name: 'list_workspaces',
        description:
          'List the workspaces your human belongs to, with unread counts. A workspace is a separate place with its own people and channels.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'list_channels',
        description: 'List the channels and direct messages in a workspace.',
        input_schema: {
          type: 'object',
          properties: {
            workspace: str('Workspace name; defaults to the one currently open'),
            all: { type: 'boolean', description: 'Include channels your human has not joined' },
          },
          required: [],
        },
      },
      {
        name: 'read_channel',
        description: 'Read the recent messages in a channel or direct message.',
        input_schema: {
          type: 'object',
          properties: {
            channel: str('Channel name (with or without #) or a person\'s name for a DM'),
            workspace: str('Workspace name; defaults to the one currently open'),
            limit: { type: 'integer', description: 'How many messages back to read (default 25)' },
          },
          required: ['channel'],
        },
      },
      {
        name: 'send_message',
        description:
          'Post a message to a channel or send a direct message, as your human. Use @name to mention somebody and #channel to link one.',
        input_schema: {
          type: 'object',
          properties: {
            channel: str('Channel name, or a person\'s name to send a direct message'),
            text: str('What to say. Supports *bold*, `code`, links, and :emoji:'),
            workspace: str('Workspace name; defaults to the one currently open'),
          },
          required: ['channel', 'text'],
        },
      },
      {
        name: 'create_channel',
        description: 'Create a channel in a workspace.',
        input_schema: {
          type: 'object',
          properties: {
            name: str('Channel name, lowercase with hyphens'),
            topic: str('What the channel is for'),
            private: { type: 'boolean', description: 'Invite-only' },
            workspace: str('Workspace name; defaults to the one currently open'),
          },
          required: ['name'],
        },
      },
      {
        name: 'search_messages',
        description: 'Search what has been said in a workspace.',
        input_schema: {
          type: 'object',
          properties: {
            query: str('What to look for'),
            workspace: str('Workspace name; defaults to the one currently open'),
          },
          required: ['query'],
        },
      },
      {
        name: 'invite_to_workspace',
        description: 'Create an invitation link somebody can use to join a workspace.',
        input_schema: {
          type: 'object',
          properties: {
            workspace: str('Workspace name; defaults to the one currently open'),
            address: str('Restrict the invitation to one agent address, e.g. sarah@northwind'),
          },
          required: [],
        },
      },
      {
        name: 'catch_me_up',
        description:
          'Summarize what your human missed: unread channels, direct messages and mentions across every workspace.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
    ];
  }

  // --- resolving names the way a person says them ---------------------------

  private resolveWorkspace(needle: string): WorkspaceState | undefined {
    const states = this.workspaces.all;
    if (!needle) return this.workspaces.get(this.focusedWorkspaceId) ?? states[0];
    const lower = needle.toLowerCase().trim();
    return (
      states.find((s) => s.workspace.id === needle) ??
      states.find((s) => s.workspace.slug === lower) ??
      states.find((s) => s.workspace.name.toLowerCase() === lower) ??
      states.find((s) => s.workspace.name.toLowerCase().includes(lower))
    );
  }

  /**
   * Find the channel somebody means. "#eng", "eng" and "Sarah" should all land
   * somewhere sensible — the last one by opening a DM rather than failing.
   */
  private resolveChannel(
    state: WorkspaceState,
    needle: string,
  ): { channelId: ChannelId; label: string } | { error: string } {
    const lower = needle.toLowerCase().trim().replace(/^#/, '');
    const channels = [...state.channels.values()].filter((c) => !c.archived);

    const byName =
      channels.find((c) => c.name === lower) ??
      channels.find((c) => c.name.replace(/-/g, ' ') === lower) ??
      channels.find((c) => c.name.startsWith(lower)) ??
      channels.find((c) => c.name.includes(lower));
    if (byName) return { channelId: byName.id, label: `#${byName.name}` };

    const member = [...state.members.values()].find(
      (m) =>
        m.address !== state.me.address &&
        (m.address.toLowerCase() === lower ||
          handleFor(m.address).toLowerCase() === lower ||
          m.displayName.toLowerCase() === lower ||
          m.displayName.toLowerCase().split(' ')[0] === lower ||
          m.displayName.toLowerCase().includes(lower)),
    );
    if (member) {
      const dm = [...state.channels.values()].find(
        (c) =>
          c.kind === 'dm' &&
          c.members.length === 2 &&
          c.members.includes(member.address) &&
          c.members.includes(state.me.address),
      );
      if (dm) return { channelId: dm.id, label: member.displayName };
      // No conversation yet: ask the relay to open one and tell the caller to
      // try again once it lands, rather than silently dropping the message.
      this.openDirectMessage(state.workspace.id, [member.address]);
      return {
        error: `Opening a direct message with ${member.displayName} — ask me again in a moment.`,
      };
    }

    return {
      error: `No channel or person called "${needle}" in ${state.workspace.name}. Channels: ${
        channels
          .filter((c) => c.kind !== 'dm' && c.kind !== 'group_dm')
          .map((c) => `#${c.name}`)
          .join(', ') || 'none'
      }.`,
    };
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
        const projects = this.knowledge.projects;
        if (!projects.length) return 'No projects recorded yet.';
        return projects
          .map((p) => `- ${p.name} [${p.status}, ${p.visibility}]: ${p.summary || '(no summary)'}`)
          .join('\n');
      }

      case 'create_project': {
        const existing = this.knowledge.findProject(s('name'));
        const project = await this.knowledge.upsertProject({
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
        for (const p of this.knowledge.projects) {
          if (match(`${p.name} ${p.summary}`)) hits.push(`[project] ${p.name}: ${truncate(p.summary, 160)}`);
        }
        for (const nt of this.knowledge.notes) {
          if (match(`${nt.title} ${nt.body}`)) hits.push(`[note/${nt.kind}] ${nt.title}: ${truncate(nt.body, 200)}`);
        }
        for (const a of this.knowledge.artifacts) {
          if (match(`${a.title} ${a.summary}`))
            hits.push(`[${a.kind}] ${a.title} (${a.status}): ${truncate(a.summary, 160)}${a.url ? ` ${a.url}` : ''}`);
        }
        for (const t of this.knowledge.tasks) {
          if (match(`${t.title} ${t.detail}`)) hits.push(`[task/${t.status}] ${t.title}`);
        }
        return hits.length ? hits.slice(0, 15).join('\n') : `Nothing in the knowledge base matches "${s('query')}".`;
      }

      case 'create_note': {
        const note = await this.knowledge.upsertNote({
          title: s('title'),
          body: s('body'),
          kind: (s('kind') as Note['kind']) || 'update',
          visibility: (s('visibility') as never) || 'team',
          projectId: this.knowledge.findProject(s('project'))?.id,
        });
        return `Saved note "${note.title}" (${note.kind}, ${note.visibility}).`;
      }

      case 'add_artifact': {
        const artifact = await this.knowledge.upsertArtifact({
          kind: (s('kind') as never) || 'pr',
          title: s('title'),
          url: s('url') || undefined,
          summary: s('summary'),
          status: (s('status') as never) || 'in_review',
          visibility: (s('visibility') as never) || 'team',
          projectId: this.knowledge.findProject(s('project'))?.id,
        });
        return `Recorded ${artifact.kind} "${artifact.title}" (${artifact.status}). Your agent can now show this in meetings.`;
      }

      case 'list_tasks': {
        const filter = s('status');
        let tasks = this.knowledge.tasks.filter((t) => t.assignee === this.knowledge.address);
        if (filter && filter !== 'open') tasks = tasks.filter((t) => t.status === filter);
        else if (filter === 'open') tasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'dropped');
        if (!tasks.length) return 'No tasks match.';
        return tasks
          .map(
            (t) =>
              `- [${t.status}] ${t.title}${t.dueDate ? ` (due ${formatTime(t.dueDate, this.knowledge.profile.timezone)})` : ''}` +
              `${t.assignedBy !== this.knowledge.address ? ` — from ${t.assignedBy}` : ''}` +
              `${t.negotiationNote ? `\n    ${t.negotiationNote}` : ''}`,
          )
          .join('\n');
      }

      case 'create_task': {
        const days = n('due_in_days', 0);
        const task = await this.knowledge.upsertTask({
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
          this.knowledge.tasks.find((t) => t.id === s('task')) ??
          this.knowledge.tasks.find((t) => t.title.toLowerCase().includes(needle));
        if (!task) return `No task matches "${s('task')}".`;
        await this.knowledge.upsertTask({
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
        const upcoming = this.knowledge.upcomingMeetings();
        const past = this.knowledge.meetings.filter((m) => m.meeting.status === 'completed').slice(0, 5);
        const lines: string[] = [];
        if (upcoming.length) {
          lines.push('Upcoming:');
          for (const m of upcoming) {
            lines.push(
              `- "${m.meeting.title}" ${formatTime(m.meeting.start, this.knowledge.profile.timezone)} with ${m.meeting.participants
                .filter((p) => p !== this.knowledge.address)
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
          this.knowledge.meeting(s('meeting')) ??
          this.knowledge.meetings.find((m) => m.meeting.title.toLowerCase().includes(needle));
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
        await this.knowledge.addCalendarBlock({ title: s('title'), start, end, kind: 'focus' });
        return `Blocked ${formatTime(start, this.knowledge.profile.timezone)} – ${formatTime(
          end,
          this.knowledge.profile.timezone,
        )} for "${s('title')}". Other agents will schedule around it.`;
      }

      case 'set_working_hours': {
        const days = Array.isArray(input.days)
          ? (input.days as unknown[]).filter((d): d is number => typeof d === 'number')
          : this.knowledge.profile.workingHours.days;
        await this.knowledge.updateProfile({
          workingHours: {
            days,
            startMinute: n('start_hour', 9) * 60,
            endMinute: n('end_hour', 18) * 60,
          },
        });
        return `Working hours set to ${n('start_hour', 9)}:00–${n('end_hour', 18)}:00.`;
      }

      case 'brief_me': {
        const tasks = this.knowledge.tasks.filter(
          (t) => t.assignee === this.knowledge.address && t.status !== 'done' && t.status !== 'dropped',
        );
        const upcoming = this.knowledge.upcomingMeetings();
        const recent = this.knowledge.meetings.filter((m) => m.outcome).slice(0, 3);
        const lines = [
          `${tasks.length} open task(s), ${upcoming.length} upcoming meeting(s).`,
          tasks.length ? `\nOpen work:\n${tasks.slice(0, 8).map((t) => `- [${t.status}] ${t.title}`).join('\n')}` : '',
          upcoming.length
            ? `\nComing up:\n${upcoming
                .map(
                  (m) =>
                    `- "${m.meeting.title}" ${formatTime(m.meeting.start, this.knowledge.profile.timezone)}`,
                )
                .join('\n')}`
            : '',
          recent.length
            ? `\nRecent meeting outcomes:\n${recent.map((m) => `- ${m.outcome!.headline}`).join('\n')}`
            : '',
        ];
        return lines.filter(Boolean).join('\n');
      }

      // --- workspaces -------------------------------------------------------

      case 'list_workspaces': {
        const states = this.workspaces.all;
        if (!states.length) return 'Not in any workspace yet.';
        const focused = this.focusedWorkspaceId;
        return states
          .map((state) => {
            const { unread, mentions } = this.workspaces.totals(state.workspace.id);
            const badge = mentions ? ` — ${mentions} mention(s)` : unread ? ` — ${unread} unread` : '';
            return (
              `- ${state.workspace.icon} ${state.workspace.name}${state.workspace.id === focused ? ' (open)' : ''}` +
              ` · ${state.members.size} member(s) · you are ${state.me.role}${badge}`
            );
          })
          .join('\n');
      }

      case 'list_channels': {
        const state = this.resolveWorkspace(s('workspace'));
        if (!state) return 'Not in any workspace yet.';
        const showAll = input.all === true;
        const channels = [...state.channels.values()]
          .filter((c) => !c.archived)
          .filter((c) => showAll || c.members.includes(state.me.address));
        const rooms = channels.filter((c) => c.kind === 'public' || c.kind === 'private');
        const dms = channels.filter((c) => isDirect(c));
        const lines = [`${state.workspace.name}:`];
        for (const channel of rooms.sort((a, b) => a.name.localeCompare(b.name))) {
          const read = state.reads.get(channel.id);
          lines.push(
            `- #${channel.name}${channel.kind === 'private' ? ' (private)' : ''}` +
              `${channel.members.includes(state.me.address) ? '' : ' [not joined]'}` +
              `${read?.unread ? ` — ${read.unread} unread` : ''}` +
              `${channel.topic ? `: ${truncate(channel.topic, 70)}` : ''}`,
          );
        }
        for (const channel of dms) {
          const read = state.reads.get(channel.id);
          lines.push(
            `- DM with ${this.workspaces.label(state.workspace.id, channel.id)}` +
              `${read?.unread ? ` — ${read.unread} unread` : ''}`,
          );
        }
        return lines.length > 1 ? lines.join('\n') : `No channels in ${state.workspace.name} yet.`;
      }

      case 'read_channel': {
        const state = this.resolveWorkspace(s('workspace'));
        if (!state) return 'Not in any workspace yet.';
        const target = this.resolveChannel(state, s('channel'));
        if ('error' in target) return target.error;
        const limit = Math.max(1, Math.min(100, n('limit', 25)));
        const messages = this.workspaces
          .messages(state.workspace.id, target.channelId)
          .filter((m) => !m.deletedAt)
          .slice(-limit);
        if (!messages.length) return `Nothing has been said in ${target.label} yet.`;
        // Reading is reading: catch the person's unread badge up too.
        this.markRead(state.workspace.id, target.channelId);
        return [
          `${target.label} (${state.workspace.name}), last ${messages.length} message(s):`,
          ...messages.map((m) => {
            const who = state.members.get(m.author)?.displayName ?? m.author;
            const when = formatTime(m.ts, this.knowledge.profile.timezone);
            if (m.kind !== 'user') return `  · ${when} — ${m.systemEvent?.replace(/_/g, ' ')} (${who})`;
            const thread = m.replyCount ? ` [${m.replyCount} repl${m.replyCount === 1 ? 'y' : 'ies'}]` : '';
            return `  ${who} (${when})${thread}: ${m.text}`;
          }),
        ].join('\n');
      }

      case 'send_message': {
        const state = this.resolveWorkspace(s('workspace'));
        if (!state) return 'Not in any workspace yet.';
        const target = this.resolveChannel(state, s('channel'));
        if ('error' in target) return target.error;
        const text = s('text').trim();
        if (!text) return 'Nothing to send.';
        const ok = this.sendMessage({
          workspaceId: state.workspace.id,
          channelId: target.channelId,
          text,
          viaAgent: true,
        });
        if (!ok) return 'Not connected to that workspace right now — the message was not sent.';
        this.activity('info', `Posted to ${target.label} in ${state.workspace.name}.`);
        return `Posted to ${target.label} in ${state.workspace.name}: "${truncate(text, 80)}"`;
      }

      case 'create_channel': {
        const state = this.resolveWorkspace(s('workspace'));
        if (!state) return 'Not in any workspace yet.';
        const ok = this.createChannel(state.workspace.id, {
          name: s('name'),
          topic: s('topic'),
          kind: input.private === true ? 'private' : 'public',
        });
        if (!ok) return 'Not connected to that workspace right now.';
        return `Creating #${s('name')} in ${state.workspace.name}.`;
      }

      case 'search_messages': {
        const state = this.resolveWorkspace(s('workspace'));
        if (!state) return 'Not in any workspace yet.';
        const query = s('query');
        // Search round-trips to the relay, so wait briefly for the answer
        // rather than telling the model "ask again later".
        const results = await this.awaitSearch(state.workspace.id, query);
        if (!results) return 'The search did not come back in time.';
        if (!results.hits.length) return `Nothing in ${state.workspace.name} matches "${query}".`;
        return results.hits
          .slice(0, 12)
          .map((hit) => {
            const who = state.members.get(hit.message.author)?.displayName ?? hit.message.author;
            const where = hit.channelKind === 'public' || hit.channelKind === 'private' ? `#${hit.channelName}` : hit.channelName;
            return `- ${where} · ${who} (${formatTime(hit.message.ts, this.knowledge.profile.timezone)}): ${truncate(hit.message.text, 160)}`;
          })
          .join('\n');
      }

      case 'invite_to_workspace': {
        const state = this.resolveWorkspace(s('workspace'));
        if (!state) return 'Not in any workspace yet.';
        const address = s('address') || undefined;
        const invite = await this.awaitInvite(state.workspace.id, address);
        if (!invite) return 'Could not create an invitation right now.';
        return (
          `Invitation to ${state.workspace.name}: code \`${invite.code}\`` +
          `${address ? ` for ${address}` : ''}. They join with it from the workspace switcher.`
        );
      }

      case 'catch_me_up': {
        const lines: string[] = [];
        for (const state of this.workspaces.all) {
          const rows: string[] = [];
          for (const channel of state.channels.values()) {
            if (channel.archived) continue;
            if (!channel.members.includes(state.me.address)) continue;
            const read = state.reads.get(channel.id);
            if (!read?.unread) continue;
            const label = this.workspaces.label(state.workspace.id, channel.id);
            const preview = this.workspaces.preview(state.workspace.id, channel.id);
            rows.push(
              `  - ${label}: ${read.unread} unread${read.mentions ? `, ${read.mentions} for you` : ''}` +
                `${preview ? `\n      ${preview}` : ''}`,
            );
          }
          if (rows.length) lines.push(`${state.workspace.icon} ${state.workspace.name}`, ...rows);
        }
        return lines.length ? lines.join('\n') : 'Nothing unread anywhere.';
      }

      default:
        return `Unknown tool: ${name}`;
    }
  }

  /** Wait for one round trip of a relay reply, so a tool can answer in one go. */
  private awaitOnce<T>(
    event: string,
    matches: (value: T) => boolean,
    trigger: () => boolean,
    timeoutMs = 4000,
  ): Promise<T | null> {
    if (!trigger()) return Promise.resolve(null);
    return new Promise((resolve) => {
      const done = (value: T | null) => {
        clearTimeout(timer);
        this.workspaces.off(event, listener);
        resolve(value);
      };
      const listener = (value: T) => {
        if (matches(value)) done(value);
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      timer.unref?.();
      this.workspaces.on(event, listener);
    });
  }

  private awaitSearch(workspaceId: WorkspaceId, query: string) {
    return this.awaitOnce<SearchResults>(
      'search',
      (results) => results.workspaceId === workspaceId && results.query === query,
      () => this.searchMessages(workspaceId, query),
    );
  }

  private awaitInvite(workspaceId: WorkspaceId, invitedAddress?: AgentAddress) {
    return this.awaitOnce<Invite>(
      'invite',
      (invite) => invite.workspaceId === workspaceId,
      () => this.createInvite(workspaceId, { invitedAddress }),
    );
  }

  async shutdown(): Promise<void> {
    this.network.close();
    await this.knowledge.flush();
  }
}
