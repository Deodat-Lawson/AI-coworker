/**
 * The agent-to-agent (A2A) wire protocol.
 *
 * Personal agents run on each person's machine. The relay does three things and
 * deliberately no more: it keeps a directory, it negotiates meeting times, and
 * it moderates meeting rooms (whose turn it is). All *intelligence* stays in
 * the personal agents — the relay never reads a knowledge base and never
 * summarizes anything.
 */

import type {
  AgendaItem,
  AgentAddress,
  ArtifactRef,
  AvailabilityReply,
  Commitment,
  Meeting,
  MeetingKind,
  MeetingPhase,
  MeetingRequest,
  Minutes,
  ProposedTask,
  PublicProfile,
  TimeSlot,
  TranscriptEntry,
} from './domain.js';

export const PROTOCOL_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export interface HelloMessage {
  type: 'hello';
  protocolVersion: string;
  profile: PublicProfile;
  /** Capabilities let agents evolve independently. */
  capabilities: string[];
}

export interface DirectoryListMessage {
  type: 'directory.list';
}

export interface MeetingRequestMessage {
  type: 'meeting.request';
  request: Omit<MeetingRequest, 'negotiationId' | 'organizer'>;
}

export interface AvailabilityReplyMessage {
  type: 'meeting.availability.reply';
  reply: AvailabilityReply;
}

export interface MeetingCancelMessage {
  type: 'meeting.cancel';
  meetingId: string;
  reason: string;
}

export interface MeetingJoinMessage {
  type: 'meeting.join';
  meetingId: string;
}

/** Ask the relay to start a scheduled meeting immediately (demo / "run it now"). */
export interface MeetingStartNowMessage {
  type: 'meeting.start_now';
  meetingId: string;
}

export interface RoomSayMessage {
  type: 'room.say';
  meetingId: string;
  text: string;
  refs?: ArtifactRef[];
}

export interface RoomAskMessage {
  type: 'room.ask';
  meetingId: string;
  to: AgentAddress;
  question: string;
}

export interface RoomAnswerMessage {
  type: 'room.answer';
  meetingId: string;
  to: AgentAddress;
  text: string;
  refs?: ArtifactRef[];
}

export interface RoomDemoMessage {
  type: 'room.demo';
  meetingId: string;
  text: string;
  refs: ArtifactRef[];
}

export interface RoomAssignMessage {
  type: 'room.assign';
  meetingId: string;
  task: ProposedTask;
}

export interface RoomCommitMessage {
  type: 'room.commit';
  meetingId: string;
  commitment: Commitment;
}

export interface RoomDecisionMessage {
  type: 'room.decision';
  meetingId: string;
  text: string;
}

export interface RoomMinutesMessage {
  type: 'room.minutes';
  meetingId: string;
  minutes: Minutes;
}

/** "I'm done with my turn." The relay then advances the room. */
export interface RoomYieldMessage {
  type: 'room.yield';
  meetingId: string;
}

/**
 * "Still working on my turn — don't move on yet."
 *
 * Composing a turn can legitimately take a while: a slow model, or an agent
 * waiting out an API rate limit. Without this the room cannot tell that apart
 * from a crashed agent, and has to choose between dropping good turns and
 * stalling on dead ones.
 */
export interface RoomWorkingMessage {
  type: 'room.working';
  meetingId: string;
  /** Optional human-readable reason, surfaced to spectators. */
  note?: string;
}

export interface PingMessage {
  type: 'ping';
}

export type ClientMessage =
  | HelloMessage
  | DirectoryListMessage
  | MeetingRequestMessage
  | AvailabilityReplyMessage
  | MeetingCancelMessage
  | MeetingJoinMessage
  | MeetingStartNowMessage
  | RoomSayMessage
  | RoomAskMessage
  | RoomAnswerMessage
  | RoomDemoMessage
  | RoomAssignMessage
  | RoomCommitMessage
  | RoomDecisionMessage
  | RoomMinutesMessage
  | RoomYieldMessage
  | RoomWorkingMessage
  | PingMessage;

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export interface HelloOkMessage {
  type: 'hello.ok';
  you: PublicProfile;
  serverTime: number;
  protocolVersion: string;
}

export interface DirectoryUpdateMessage {
  type: 'directory.update';
  agents: PublicProfile[];
}

/** Relay asks an agent when its human is free. The agent answers from its own calendar. */
export interface AvailabilityRequestMessage {
  type: 'meeting.availability.request';
  request: MeetingRequest;
}

export interface MeetingScheduledMessage {
  type: 'meeting.scheduled';
  meeting: Meeting;
}

export interface MeetingFailedMessage {
  type: 'meeting.failed';
  negotiationId: string;
  reason: string;
  /** Slots that were offered, so an agent can explain the conflict to its human. */
  offered: Record<AgentAddress, TimeSlot[]>;
}

export interface MeetingCancelledMessage {
  type: 'meeting.cancelled';
  meetingId: string;
  by: AgentAddress;
  reason: string;
}

export interface MeetingStartingMessage {
  type: 'meeting.starting';
  meeting: Meeting;
  joinDeadline: number;
}

export interface RoomStateMessage {
  type: 'room.state';
  meetingId: string;
  phase: MeetingPhase;
  present: AgentAddress[];
  transcript: TranscriptEntry[];
}

export type TurnKind =
  | 'open'
  | 'update'
  | 'ask'
  | 'answer'
  | 'decide'
  | 'commit'
  | 'wrap';

/** The relay grants exactly one agent the floor at a time. */
export interface RoomTurnMessage {
  type: 'room.turn';
  meetingId: string;
  speaker: AgentAddress;
  phase: MeetingPhase;
  turnKind: TurnKind;
  /** Human-readable instruction for what this turn is for. */
  instruction: string;
  timeLimitMs: number;
  /** For `answer` turns: the question being answered. */
  question?: { from: AgentAddress; text: string };
  /** For `commit` turns: the tasks this agent is being asked to accept. */
  pendingTasks?: ProposedTask[];
}

/** Broadcast of anything said in the room. */
export interface RoomEventMessage {
  type: 'room.event';
  meetingId: string;
  entry: TranscriptEntry;
}

export interface RoomPhaseMessage {
  type: 'room.phase';
  meetingId: string;
  phase: MeetingPhase;
}

export interface MeetingEndedMessage {
  type: 'meeting.ended';
  meetingId: string;
  meeting: Meeting;
  transcript: TranscriptEntry[];
  minutes?: Minutes;
  assignments: ProposedTask[];
  commitments: Commitment[];
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export interface PongMessage {
  type: 'pong';
  serverTime: number;
}

export type ServerMessage =
  | HelloOkMessage
  | DirectoryUpdateMessage
  | AvailabilityRequestMessage
  | MeetingScheduledMessage
  | MeetingFailedMessage
  | MeetingCancelledMessage
  | MeetingStartingMessage
  | RoomStateMessage
  | RoomTurnMessage
  | RoomEventMessage
  | RoomPhaseMessage
  | MeetingEndedMessage
  | ErrorMessage
  | PongMessage;

// ---------------------------------------------------------------------------
// Validation helpers (hand-rolled: no runtime dependency)
// ---------------------------------------------------------------------------

const CLIENT_TYPES = new Set<ClientMessage['type']>([
  'hello',
  'directory.list',
  'meeting.request',
  'meeting.availability.reply',
  'meeting.cancel',
  'meeting.join',
  'meeting.start_now',
  'room.say',
  'room.ask',
  'room.answer',
  'room.demo',
  'room.assign',
  'room.commit',
  'room.decision',
  'room.minutes',
  'room.yield',
  'room.working',
  'ping',
]);

const SERVER_TYPES = new Set<ServerMessage['type']>([
  'hello.ok',
  'directory.update',
  'meeting.availability.request',
  'meeting.scheduled',
  'meeting.failed',
  'meeting.cancelled',
  'meeting.starting',
  'room.state',
  'room.turn',
  'room.event',
  'room.phase',
  'meeting.ended',
  'error',
  'pong',
]);

export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string' || !CLIENT_TYPES.has(type as ClientMessage['type'])) return null;
  return value as ClientMessage;
}

export function parseServerMessage(raw: string): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string' || !SERVER_TYPES.has(type as ServerMessage['type'])) return null;
  return value as ServerMessage;
}

export type { AgendaItem, MeetingKind };
