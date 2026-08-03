/**
 * The agent-to-agent (A2A) wire protocol.
 *
 * Personal agents run on each person's machine. The relay does a small, fixed
 * set of things and deliberately no more: it keeps workspaces (membership,
 * channels, message history), it negotiates meeting times, and it moderates
 * meeting rooms (whose turn it is). All *intelligence* stays in the personal
 * agents — the relay never reads a knowledge base and never summarizes anything.
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
import type {
  Channel,
  ChannelId,
  ChannelKind,
  ChannelReadState,
  Invite,
  Message,
  MessageId,
  Presence,
  SearchResults,
  UserStatus,
  Workspace,
  WorkspaceId,
  WorkspaceMember,
  WorkspaceRole,
} from './workspace.js';

export const PROTOCOL_VERSION = '2.0.0';

/** Capabilities an agent announces at hello, so the two sides can evolve apart. */
export const CLIENT_CAPABILITIES = [
  'meetings.v1',
  'scheduling.v1',
  'artifacts.v1',
  'workspaces.v1',
  'messaging.v1',
];

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export interface HelloMessage {
  type: 'hello';
  protocolVersion: string;
  profile: PublicProfile;
  capabilities: string[];
}

export interface DirectoryListMessage {
  type: 'directory.list';
}

// --- workspaces ------------------------------------------------------------

export interface WorkspaceListMessage {
  type: 'workspace.list';
}

/** Workspaces on this relay that accept new members without an invitation. */
export interface WorkspaceDiscoverMessage {
  type: 'workspace.discover';
}

export interface WorkspaceCreateMessage {
  type: 'workspace.create';
  name: string;
  slug?: string;
  description?: string;
  icon?: string;
  color?: string;
  discoverable?: boolean;
  /** Extra channels to create alongside #general. */
  channels?: string[];
}

export interface WorkspaceJoinMessage {
  type: 'workspace.join';
  /** Either an invitation code or the slug of a discoverable workspace. */
  code?: string;
  slug?: string;
}

export interface WorkspaceLeaveMessage {
  type: 'workspace.leave';
  workspaceId: WorkspaceId;
}

export interface WorkspaceUpdateMessage {
  type: 'workspace.update';
  workspaceId: WorkspaceId;
  patch: Partial<Pick<Workspace, 'name' | 'description' | 'icon' | 'color' | 'invitePolicy' | 'discoverable'>>;
}

export interface WorkspaceDeleteMessage {
  type: 'workspace.delete';
  workspaceId: WorkspaceId;
}

export interface WorkspaceSetRoleMessage {
  type: 'workspace.set_role';
  workspaceId: WorkspaceId;
  address: AgentAddress;
  role: WorkspaceRole;
}

export interface WorkspaceRemoveMemberMessage {
  type: 'workspace.remove_member';
  workspaceId: WorkspaceId;
  address: AgentAddress;
}

/** Per-workspace identity: the same person can present differently in each. */
export interface WorkspaceProfileMessage {
  type: 'workspace.profile';
  workspaceId: WorkspaceId;
  displayName?: string;
  title?: string;
}

// --- invitations -----------------------------------------------------------

export interface InviteCreateMessage {
  type: 'invite.create';
  workspaceId: WorkspaceId;
  /** Restrict the invitation to one agent address. */
  invitedAddress?: AgentAddress;
  role?: WorkspaceRole;
  expiresInHours?: number;
  maxUses?: number;
  channels?: ChannelId[];
}

export interface InviteRevokeMessage {
  type: 'invite.revoke';
  workspaceId: WorkspaceId;
  code: string;
}

export interface InviteListMessage {
  type: 'invite.list';
  workspaceId: WorkspaceId;
}

// --- channels --------------------------------------------------------------

export interface ChannelCreateMessage {
  type: 'channel.create';
  workspaceId: WorkspaceId;
  name: string;
  kind?: Extract<ChannelKind, 'public' | 'private'>;
  topic?: string;
  purpose?: string;
  members?: AgentAddress[];
}

export interface ChannelUpdateMessage {
  type: 'channel.update';
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  patch: { name?: string; topic?: string; purpose?: string };
}

export interface ChannelArchiveMessage {
  type: 'channel.archive';
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  archived: boolean;
}

export interface ChannelJoinMessage {
  type: 'channel.join';
  workspaceId: WorkspaceId;
  channelId: ChannelId;
}

export interface ChannelLeaveMessage {
  type: 'channel.leave';
  workspaceId: WorkspaceId;
  channelId: ChannelId;
}

export interface ChannelInviteMessage {
  type: 'channel.invite';
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  addresses: AgentAddress[];
}

export interface ChannelKickMessage {
  type: 'channel.kick';
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  address: AgentAddress;
}

/** Every channel the caller is allowed to see, joined or not. */
export interface ChannelListMessage {
  type: 'channel.list';
  workspaceId: WorkspaceId;
}

export interface DmOpenMessage {
  type: 'dm.open';
  workspaceId: WorkspaceId;
  addresses: AgentAddress[];
}

// --- messages --------------------------------------------------------------

export interface MessageSendMessage {
  type: 'message.send';
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  text: string;
  /** Reply inside a thread rooted at this message. */
  threadRootId?: MessageId;
  /** Thread reply that should also appear in the channel. */
  alsoSendToChannel?: boolean;
  refs?: ArtifactRef[];
  /** Echoed back on `message.new` so an optimistic bubble can be reconciled. */
  clientId?: string;
  /** True when the person's agent is posting rather than the person. */
  viaAgent?: boolean;
}

export interface MessageEditMessage {
  type: 'message.edit';
  workspaceId: WorkspaceId;
  messageId: MessageId;
  text: string;
}

export interface MessageDeleteMessage {
  type: 'message.delete';
  workspaceId: WorkspaceId;
  messageId: MessageId;
}

export interface MessageReactMessage {
  type: 'message.react';
  workspaceId: WorkspaceId;
  messageId: MessageId;
  emoji: string;
  /** false removes the reaction. */
  on: boolean;
}

export interface MessagePinMessage {
  type: 'message.pin';
  workspaceId: WorkspaceId;
  messageId: MessageId;
  pinned: boolean;
}

export interface HistoryFetchMessage {
  type: 'history.fetch';
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  /** Fetch messages strictly older than this timestamp. */
  before?: number;
  limit?: number;
}

export interface ThreadFetchMessage {
  type: 'thread.fetch';
  workspaceId: WorkspaceId;
  rootId: MessageId;
}

export interface TypingMessage {
  type: 'typing';
  workspaceId: WorkspaceId;
  channelId: ChannelId;
}

export interface ReadSetMessage {
  type: 'read.set';
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  /** Everything at or before this timestamp is read. */
  ts: number;
}

export interface PresenceSetMessage {
  type: 'presence.set';
  presence?: Presence;
  status?: UserStatus;
}

export interface SearchMessage {
  type: 'search';
  workspaceId: WorkspaceId;
  query: string;
  limit?: number;
  /** Restrict to one channel. */
  channelId?: ChannelId;
  /** Restrict to one author. */
  from?: AgentAddress;
}

// --- meetings --------------------------------------------------------------

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
  | WorkspaceListMessage
  | WorkspaceDiscoverMessage
  | WorkspaceCreateMessage
  | WorkspaceJoinMessage
  | WorkspaceLeaveMessage
  | WorkspaceUpdateMessage
  | WorkspaceDeleteMessage
  | WorkspaceSetRoleMessage
  | WorkspaceRemoveMemberMessage
  | WorkspaceProfileMessage
  | InviteCreateMessage
  | InviteRevokeMessage
  | InviteListMessage
  | ChannelCreateMessage
  | ChannelUpdateMessage
  | ChannelArchiveMessage
  | ChannelJoinMessage
  | ChannelLeaveMessage
  | ChannelInviteMessage
  | ChannelKickMessage
  | ChannelListMessage
  | DmOpenMessage
  | MessageSendMessage
  | MessageEditMessage
  | MessageDeleteMessage
  | MessageReactMessage
  | MessagePinMessage
  | HistoryFetchMessage
  | ThreadFetchMessage
  | TypingMessage
  | ReadSetMessage
  | PresenceSetMessage
  | SearchMessage
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
  /** Name of the relay, shown while switching workspaces. */
  relayName: string;
}

export interface DirectoryUpdateMessage {
  type: 'directory.update';
  agents: PublicProfile[];
}

/**
 * Everything the client needs to render one workspace: who is in it, what
 * channels exist, and where the reader left off. Sent on connect and on join.
 */
export interface WorkspaceSnapshotMessage {
  type: 'workspace.snapshot';
  workspace: Workspace;
  me: WorkspaceMember;
  members: WorkspaceMember[];
  channels: Channel[];
  readStates: ChannelReadState[];
  /** Most recent messages per joined channel, so the app opens with content. */
  recent: Record<ChannelId, Message[]>;
}

export interface WorkspaceUpdatedMessage {
  type: 'workspace.updated';
  workspace: Workspace;
}

export interface WorkspaceRemovedMessage {
  type: 'workspace.removed';
  workspaceId: WorkspaceId;
  reason: string;
}

export interface WorkspaceDiscoverResultMessage {
  type: 'workspace.discover.result';
  workspaces: {
    id: WorkspaceId;
    slug: string;
    name: string;
    description: string;
    icon: string;
    color: string;
    memberCount: number;
    joined: boolean;
  }[];
}

export interface WorkspaceMemberMessage {
  type: 'workspace.member';
  workspaceId: WorkspaceId;
  member: WorkspaceMember;
}

export interface WorkspaceMemberRemovedMessage {
  type: 'workspace.member_removed';
  workspaceId: WorkspaceId;
  address: AgentAddress;
}

export interface ChannelUpsertedMessage {
  type: 'channel.upserted';
  workspaceId: WorkspaceId;
  channel: Channel;
}

export interface ChannelRemovedMessage {
  type: 'channel.removed';
  workspaceId: WorkspaceId;
  channelId: ChannelId;
}

export interface MessageNewMessage {
  type: 'message.new';
  workspaceId: WorkspaceId;
  message: Message;
  /** Echo of the sender's optimistic id. */
  clientId?: string;
  /** Read state for the recipient after this message landed. */
  read?: ChannelReadState;
}

export interface MessageUpdatedMessage {
  type: 'message.updated';
  workspaceId: WorkspaceId;
  message: Message;
}

export interface HistoryPageMessage {
  type: 'history.page';
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  messages: Message[];
  reachedStart: boolean;
  /** Set when this page answers a `thread.fetch`. */
  threadRootId?: MessageId;
}

export interface TypingUpdateMessage {
  type: 'typing.update';
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  address: AgentAddress;
}

export interface ReadUpdatedMessage {
  type: 'read.updated';
  workspaceId: WorkspaceId;
  read: ChannelReadState;
}

export interface InviteCreatedMessage {
  type: 'invite.created';
  workspaceId: WorkspaceId;
  invite: Invite;
}

export interface InviteListResultMessage {
  type: 'invite.list.result';
  workspaceId: WorkspaceId;
  invites: Invite[];
}

export interface SearchResultsMessage {
  type: 'search.results';
  results: SearchResults;
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
  /** The client message type that caused it, when the relay can tell. */
  context?: string;
}

export interface PongMessage {
  type: 'pong';
  serverTime: number;
}

export type ServerMessage =
  | HelloOkMessage
  | DirectoryUpdateMessage
  | WorkspaceSnapshotMessage
  | WorkspaceUpdatedMessage
  | WorkspaceRemovedMessage
  | WorkspaceDiscoverResultMessage
  | WorkspaceMemberMessage
  | WorkspaceMemberRemovedMessage
  | ChannelUpsertedMessage
  | ChannelRemovedMessage
  | MessageNewMessage
  | MessageUpdatedMessage
  | HistoryPageMessage
  | TypingUpdateMessage
  | ReadUpdatedMessage
  | InviteCreatedMessage
  | InviteListResultMessage
  | SearchResultsMessage
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
  'workspace.list',
  'workspace.discover',
  'workspace.create',
  'workspace.join',
  'workspace.leave',
  'workspace.update',
  'workspace.delete',
  'workspace.set_role',
  'workspace.remove_member',
  'workspace.profile',
  'invite.create',
  'invite.revoke',
  'invite.list',
  'channel.create',
  'channel.update',
  'channel.archive',
  'channel.join',
  'channel.leave',
  'channel.invite',
  'channel.kick',
  'channel.list',
  'dm.open',
  'message.send',
  'message.edit',
  'message.delete',
  'message.react',
  'message.pin',
  'history.fetch',
  'thread.fetch',
  'typing',
  'read.set',
  'presence.set',
  'search',
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
  'workspace.snapshot',
  'workspace.updated',
  'workspace.removed',
  'workspace.discover.result',
  'workspace.member',
  'workspace.member_removed',
  'channel.upserted',
  'channel.removed',
  'message.new',
  'message.updated',
  'history.page',
  'typing.update',
  'read.updated',
  'invite.created',
  'invite.list.result',
  'search.results',
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
