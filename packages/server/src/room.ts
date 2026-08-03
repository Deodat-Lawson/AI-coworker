/**
 * The meeting room moderator.
 *
 * This is deliberately a dumb state machine. It decides *who speaks next* and
 * nothing else — it never reads a knowledge base, never summarizes, and never
 * writes a word of the transcript's content. All of that belongs to the
 * personal agents, because that is what keeps the intelligence on the
 * participants' own machines.
 *
 * The phase structure mirrors what an actual working meeting does:
 *
 *   opening      chair states what the meeting is for
 *   updates      each attendee reports, and can show real artifacts
 *   qa           attendees interrogate each other; an answer turn is granted
 *                immediately so questions get answered in context, not by email
 *   decisions    the chair gives feedback and assigns next period's work
 *   commitments  each assignee accepts or pushes back, out loud, with a reason
 *   wrap         the chair records minutes
 */

import {
  type AgentAddress,
  type Commitment,
  type Meeting,
  type MeetingPhase,
  type Minutes,
  type ProposedTask,
  type ServerMessage,
  type TranscriptEntry,
  type TurnKind,
  id,
} from '@ai-coworker/shared';

export interface RoomTurn {
  speaker: AgentAddress;
  kind: TurnKind;
  instruction: string;
  question?: { from: AgentAddress; text: string };
  pendingTasks?: ProposedTask[];
}

export interface RoomOptions {
  meeting: Meeting;
  send: (to: AgentAddress, message: ServerMessage) => void;
  onEnded: (room: MeetingRoom) => void;
  /** How long an agent gets to produce a turn before the room moves on. */
  turnTimeoutMs?: number;
  /** Ceiling on a single turn even if the agent keeps reporting progress. */
  maxTurnMs?: number;
  /** How long to wait for agents to join before starting without them. */
  joinTimeoutMs?: number;
  log?: (message: string) => void;
}

const PHASE_LABEL: Record<MeetingPhase, string> = {
  opening: 'Opening',
  updates: 'Progress updates',
  qa: 'Questions',
  decisions: 'Feedback and assignments',
  commitments: 'Commitments',
  wrap: 'Wrap-up',
  closed: 'Closed',
};

export class MeetingRoom {
  readonly meeting: Meeting;
  readonly transcript: TranscriptEntry[] = [];
  phase: MeetingPhase = 'opening';
  present = new Set<AgentAddress>();
  ended = false;

  private send: RoomOptions['send'];
  private onEnded: RoomOptions['onEnded'];
  private turnTimeoutMs: number;
  private joinTimeoutMs: number;
  private log: (message: string) => void;

  private queue: RoomTurn[] = [];
  private current: RoomTurn | null = null;
  private turnTimer: NodeJS.Timeout | null = null;
  private turnStartedAt = 0;
  /** Hard ceiling on one turn, however many heartbeats arrive. */
  private maxTurnMs: number;
  private joinTimer: NodeJS.Timeout | null = null;
  private started = false;
  private askedBy = new Set<AgentAddress>();

  private assignments: ProposedTask[] = [];
  private commitments: Commitment[] = [];
  private minutes: Minutes | undefined;

  constructor(options: RoomOptions) {
    this.meeting = options.meeting;
    this.send = options.send;
    this.onEnded = options.onEnded;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 90_000;
    this.maxTurnMs = options.maxTurnMs ?? Math.max(this.turnTimeoutMs * 4, 600_000);
    this.joinTimeoutMs = options.joinTimeoutMs ?? 20_000;
    this.log = options.log ?? (() => {});
  }

  get id(): string {
    return this.meeting.id;
  }

  get collectedAssignments(): ProposedTask[] {
    return [...this.assignments];
  }

  get collectedCommitments(): Commitment[] {
    return [...this.commitments];
  }

  get collectedMinutes(): Minutes | undefined {
    return this.minutes;
  }

  /** Called once the meeting's start time arrives. Agents are invited to join. */
  open(): void {
    for (const participant of this.meeting.participants) {
      this.send(participant, {
        type: 'meeting.starting',
        meeting: this.meeting,
        joinDeadline: Date.now() + this.joinTimeoutMs,
      });
    }
    this.joinTimer = setTimeout(() => this.begin(), this.joinTimeoutMs);
  }

  join(address: AgentAddress): void {
    if (!this.meeting.participants.includes(address)) return;
    this.present.add(address);
    this.send(address, {
      type: 'room.state',
      meetingId: this.id,
      phase: this.phase,
      present: [...this.present],
      transcript: this.transcript,
    });
    this.broadcast({
      type: 'room.state',
      meetingId: this.id,
      phase: this.phase,
      present: [...this.present],
      transcript: this.transcript,
    });
    // Start as soon as everyone is here rather than burning the whole join window.
    if (!this.started && this.present.size === this.meeting.participants.length) {
      this.begin();
    }
  }

  leave(address: AgentAddress): void {
    this.present.delete(address);
    if (this.ended) return;
    if (this.present.size === 0) {
      this.moderatorSays('Everyone dropped. Ending the meeting.');
      this.end();
      return;
    }
    // If the absent agent held the floor, do not let the room stall on it.
    if (this.current?.speaker === address) {
      this.moderatorSays(`${address} dropped mid-turn.`);
      this.completeTurn();
    }
  }

  private begin(): void {
    if (this.started || this.ended) return;
    this.started = true;
    if (this.joinTimer) {
      clearTimeout(this.joinTimer);
      this.joinTimer = null;
    }

    const absent = this.meeting.participants.filter((p) => !this.present.has(p));
    if (this.present.size === 0) {
      this.moderatorSays('No agents joined. Cancelling.');
      this.end();
      return;
    }
    if (absent.length) {
      this.moderatorSays(`Starting without ${absent.join(', ')} — their agent did not join.`);
    }

    this.setPhase('opening');
    const chair = this.chairOrFallback();
    this.enqueue({
      speaker: chair,
      kind: 'open',
      instruction: 'Open the meeting: say what it is for and what you need out of it.',
    });
    this.pump();
  }

  private chairOrFallback(): AgentAddress {
    if (this.present.has(this.meeting.chair)) return this.meeting.chair;
    // The chair's agent is not here; the room still needs someone to run it.
    return [...this.present][0]!;
  }

  // --- turn plumbing -------------------------------------------------------

  private enqueue(turn: RoomTurn): void {
    this.queue.push(turn);
  }

  private enqueueNext(turn: RoomTurn): void {
    this.queue.unshift(turn);
  }

  private pump(): void {
    if (this.ended) return;
    if (this.current) return;

    // Skip turns for agents that are not in the room.
    while (this.queue.length && !this.present.has(this.queue[0]!.speaker)) {
      const skipped = this.queue.shift()!;
      this.moderatorSays(`Skipping ${skipped.speaker} — not present.`);
    }

    const next = this.queue.shift();
    if (!next) {
      this.advancePhase();
      return;
    }

    this.current = next;
    this.send(next.speaker, {
      type: 'room.turn',
      meetingId: this.id,
      speaker: next.speaker,
      phase: this.phase,
      turnKind: next.kind,
      instruction: next.instruction,
      timeLimitMs: this.turnTimeoutMs,
      question: next.question,
      pendingTasks: next.pendingTasks,
    });
    // Everyone else sees whose turn it is, so a spectating UI can follow along.
    for (const participant of this.present) {
      if (participant === next.speaker) continue;
      this.send(participant, {
        type: 'room.turn',
        meetingId: this.id,
        speaker: next.speaker,
        phase: this.phase,
        turnKind: next.kind,
        instruction: next.instruction,
        timeLimitMs: this.turnTimeoutMs,
      });
    }

    this.turnStartedAt = Date.now();
    this.armTurnTimer();
  }

  private armTurnTimer(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = setTimeout(() => {
      const speaker = this.current?.speaker;
      this.moderatorSays(`${speaker ?? 'speaker'} timed out. Moving on.`);
      this.completeTurn();
    }, this.turnTimeoutMs);
  }

  /**
   * An agent reporting that it is still composing. Extends its turn, but only
   * up to `maxTurnMs` — a heartbeat loop must not be able to hold the floor
   * forever.
   */
  heartbeat(address: AgentAddress, note?: string): void {
    if (!this.current || this.current.speaker !== address) return;
    if (Date.now() - this.turnStartedAt >= this.maxTurnMs) {
      this.moderatorSays(`${address} has held the floor too long. Moving on.`);
      this.completeTurn();
      return;
    }
    if (note) this.moderatorSays(`${address}: ${note}`);
    this.armTurnTimer();
  }

  /** An agent said it is finished, or its time ran out. */
  yieldTurn(address: AgentAddress): void {
    if (!this.current || this.current.speaker !== address) return;
    this.completeTurn();
  }

  private completeTurn(): void {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    this.current = null;
    // Defer so a burst of room.* messages from the same agent settles first.
    setImmediate(() => this.pump());
  }

  private advancePhase(): void {
    switch (this.phase) {
      case 'opening': {
        this.setPhase('updates');
        const chair = this.chairOrFallback();
        for (const participant of this.meeting.participants) {
          if (participant === chair) continue;
          this.enqueue({
            speaker: participant,
            kind: 'update',
            instruction:
              'Give your progress update. Show real artifacts — a PR, a demo, a metric — rather than describing them.',
          });
        }
        // A chair who is also doing the work still owes the room an update.
        if (this.meeting.participants.length === 1 || this.meeting.kind === 'standup') {
          this.enqueue({
            speaker: chair,
            kind: 'update',
            instruction: 'Give your own update.',
          });
        }
        this.pump();
        break;
      }

      case 'updates': {
        this.setPhase('qa');
        for (const participant of this.meeting.participants) {
          this.enqueue({
            speaker: participant,
            kind: 'ask',
            instruction:
              'Ask one question of one other attendee — something that actually blocks or changes your work. Pass if there is nothing.',
          });
        }
        this.pump();
        break;
      }

      case 'qa': {
        this.setPhase('decisions');
        this.enqueue({
          speaker: this.chairOrFallback(),
          kind: 'decide',
          instruction:
            'Give feedback on what you heard and assign next period\'s work, with acceptance criteria for each item.',
        });
        this.pump();
        break;
      }

      case 'decisions': {
        this.setPhase('commitments');
        const byAssignee = new Map<AgentAddress, ProposedTask[]>();
        for (const task of this.assignments) {
          const list = byAssignee.get(task.assignee) ?? [];
          list.push(task);
          byAssignee.set(task.assignee, list);
        }
        for (const participant of this.meeting.participants) {
          const tasks = byAssignee.get(participant);
          if (!tasks?.length) continue;
          this.enqueue({
            speaker: participant,
            kind: 'commit',
            instruction:
              'Accept or push back on the work assigned to you. Say which, and why, out loud.',
            pendingTasks: tasks,
          });
        }
        this.pump();
        break;
      }

      case 'commitments': {
        this.setPhase('wrap');
        this.enqueue({
          speaker: this.chairOrFallback(),
          kind: 'wrap',
          instruction: 'Record the minutes: summary, decisions, risks, follow-ups.',
        });
        this.pump();
        break;
      }

      case 'wrap':
        this.end();
        break;

      case 'closed':
        break;
    }
  }

  private setPhase(phase: MeetingPhase): void {
    this.phase = phase;
    this.broadcast({ type: 'room.phase', meetingId: this.id, phase });
    this.moderatorSays(`— ${PHASE_LABEL[phase]} —`);
  }

  // --- content from agents --------------------------------------------------

  private record(entry: Omit<TranscriptEntry, 'id' | 'ts' | 'phase'>): TranscriptEntry {
    const full: TranscriptEntry = { id: id('tr'), ts: Date.now(), phase: this.phase, ...entry };
    this.transcript.push(full);
    this.broadcast({ type: 'room.event', meetingId: this.id, entry: full });
    return full;
  }

  private moderatorSays(text: string): void {
    this.record({ kind: 'moderator', speaker: 'moderator', text });
  }

  /** Guard: only the agent currently holding the floor may put content in the room. */
  private holdsFloor(address: AgentAddress): boolean {
    return this.current?.speaker === address;
  }

  say(address: AgentAddress, text: string, refs?: TranscriptEntry['refs']): void {
    if (!this.holdsFloor(address)) return;
    this.record({
      kind: refs?.length && !text ? 'demo' : 'utterance',
      speaker: address,
      text,
      refs,
    });
  }

  demo(address: AgentAddress, text: string, refs: NonNullable<TranscriptEntry['refs']>): void {
    if (!this.holdsFloor(address)) return;
    this.record({ kind: 'demo', speaker: address, text, refs });
  }

  ask(address: AgentAddress, to: AgentAddress, question: string): void {
    if (!this.holdsFloor(address)) return;
    if (!this.meeting.participants.includes(to) || to === address) return;
    // One question each keeps the room bounded; the rest is the chair's job.
    if (this.askedBy.has(address)) return;
    this.askedBy.add(address);
    this.record({ kind: 'question', speaker: address, to, text: question });

    if (this.present.has(to)) {
      // Answer immediately, in context. This is the thing email cannot do.
      this.enqueueNext({
        speaker: to,
        kind: 'answer',
        instruction: `Answer ${address} directly, from your knowledge base.`,
        question: { from: address, text: question },
      });
    } else {
      this.moderatorSays(`${to} is not present to answer.`);
    }
  }

  answer(address: AgentAddress, to: AgentAddress, text: string, refs?: TranscriptEntry['refs']): void {
    if (!this.holdsFloor(address)) return;
    this.record({ kind: 'answer', speaker: address, to, text, refs });
  }

  assign(address: AgentAddress, task: ProposedTask): void {
    if (!this.holdsFloor(address)) return;
    // Only the chair assigns work, and only to someone in the room.
    if (address !== this.chairOrFallback()) return;
    if (!this.meeting.participants.includes(task.assignee)) return;
    this.assignments.push(task);
    this.record({
      kind: 'assignment',
      speaker: address,
      to: task.assignee,
      text: task.title,
      task,
    });
  }

  commit(address: AgentAddress, commitment: Commitment): void {
    if (!this.holdsFloor(address)) return;
    const task = this.assignments.find((t) => t.id === commitment.taskId);
    if (!task || task.assignee !== address) return;
    this.commitments.push(commitment);
    this.record({
      kind: 'commitment',
      speaker: address,
      to: this.meeting.chair,
      text: commitment.accepted
        ? `Accepted: ${task.title}${commitment.note ? ` — ${commitment.note}` : ''}`
        : `Pushed back on: ${task.title} — ${commitment.note}`,
      commitment,
    });
  }

  decision(address: AgentAddress, text: string): void {
    if (!this.holdsFloor(address)) return;
    this.record({ kind: 'decision', speaker: address, text });
  }

  recordMinutes(address: AgentAddress, minutes: Minutes): void {
    if (!this.holdsFloor(address)) return;
    this.minutes = minutes;
    this.record({ kind: 'minutes', speaker: address, text: minutes.summary });
  }

  // --- lifecycle ------------------------------------------------------------

  private broadcast(message: ServerMessage): void {
    for (const participant of this.present) this.send(participant, message);
  }

  cancel(by: AgentAddress, reason: string): void {
    if (this.ended) return;
    this.moderatorSays(`Meeting cancelled by ${by}: ${reason}`);
    this.broadcast({ type: 'meeting.cancelled', meetingId: this.id, by, reason });
    this.teardown();
    this.ended = true;
    this.onEnded(this);
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.phase = 'closed';
    this.teardown();
    this.log(`meeting ${this.id} ended: ${this.transcript.length} entries, ${this.assignments.length} assignments`);
    this.broadcast({
      type: 'meeting.ended',
      meetingId: this.id,
      meeting: { ...this.meeting, status: 'completed' },
      transcript: this.transcript,
      minutes: this.minutes,
      assignments: this.assignments,
      commitments: this.commitments,
    });
    this.onEnded(this);
  }

  private teardown(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    if (this.joinTimer) clearTimeout(this.joinTimer);
    this.turnTimer = null;
    this.joinTimer = null;
    this.current = null;
    this.queue = [];
  }
}
