/**
 * Workspaces: the shared places people (and their agents) talk in.
 *
 * A person's *knowledge base* is private and lives on their own machine. A
 * *workspace* is the opposite: a named, shared space hosted by a relay, with a
 * membership list, channels, and a message history everyone in it can read.
 * Somebody can belong to several — work, a client, an open-source project —
 * and switch between them without the two ever seeing each other's traffic.
 *
 * The relay owns workspace state because it is the only party all members can
 * reach. It still never reads a knowledge base: messages are what people (and
 * their agents) chose to say out loud.
 */

import type { AgentAddress, ArtifactRef } from './domain.js';

export type WorkspaceId = string;
export type ChannelId = string;
export type MessageId = string;

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'guest';

/** Higher outranks lower. Used for every permission check. */
export const ROLE_RANK: Record<WorkspaceRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
  guest: 0,
};

export function atLeast(role: WorkspaceRole | undefined, floor: WorkspaceRole): boolean {
  return role !== undefined && ROLE_RANK[role] >= ROLE_RANK[floor];
}

/** Who is allowed to invite new people. */
export type InvitePolicy = 'anyone' | 'admins';

export interface Workspace {
  id: WorkspaceId;
  /** Unique per relay; what people type to find the workspace. */
  slug: string;
  name: string;
  description: string;
  /** A single emoji, drawn on the workspace rail. */
  icon: string;
  /** Accent colour for the rail tile and headers. */
  color: string;
  createdBy: AgentAddress;
  createdAt: number;
  updatedAt: number;
  invitePolicy: InvitePolicy;
  /** Listed to everyone on the relay, and joinable without an invitation. */
  discoverable: boolean;
  /** Channels every new member is dropped into, by name. */
  defaultChannels: string[];
}

export const WORKSPACE_COLORS = [
  '#6ea8fe',
  '#a78bfa',
  '#f472b6',
  '#fb923c',
  '#4ade80',
  '#22d3ee',
  '#facc15',
  '#f87171',
] as const;

export const WORKSPACE_ICONS = [
  '🛰️', '🧭', '🪐', '⚡', '🌱', '🔭', '🧪', '🎛️', '📡', '🏗️', '🧩', '🌊',
] as const;

// ---------------------------------------------------------------------------
// Members and presence
// ---------------------------------------------------------------------------

export type Presence = 'active' | 'away' | 'dnd' | 'offline';

export interface UserStatus {
  /** A single emoji, or '' for none. */
  emoji: string;
  text: string;
  /** Epoch ms; 0 means it never expires. */
  expiresAt: number;
}

export function emptyStatus(): UserStatus {
  return { emoji: '', text: '', expiresAt: 0 };
}

export function statusIsLive(status: UserStatus | undefined, now = Date.now()): boolean {
  if (!status) return false;
  if (!status.emoji && !status.text) return false;
  return status.expiresAt === 0 || status.expiresAt > now;
}

/**
 * A person as seen *inside one workspace*. Display name and title can be
 * overridden per workspace — the same human is "Sarah Chen, Staff Engineer" at
 * work and "sarah" in a side project.
 */
export interface WorkspaceMember {
  workspaceId: WorkspaceId;
  address: AgentAddress;
  displayName: string;
  title: string;
  bio: string;
  timezone: string;
  focusAreas: string[];
  role: WorkspaceRole;
  joinedAt: number;
  /** Kept in the list but greyed out and unmentionable. */
  deactivated: boolean;
  presence: Presence;
  status: UserStatus;
  lastSeen: number;
  /** True while the person's own agent is connected on their behalf. */
  agentOnline: boolean;
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export type ChannelKind = 'public' | 'private' | 'dm' | 'group_dm';

export interface Channel {
  id: ChannelId;
  workspaceId: WorkspaceId;
  kind: ChannelKind;
  /** Lower-kebab for public/private channels; empty for DMs. */
  name: string;
  topic: string;
  purpose: string;
  createdBy: AgentAddress;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  /**
   * Everyone who has joined. For public channels this is the joined set (the
   * channel is still readable by any member who browses it); for private
   * channels and DMs it is also the access list.
   */
  members: AgentAddress[];
  /** #general: cannot be left, archived, or renamed. */
  isDefault: boolean;
  lastMessageAt: number;
  messageCount: number;
  pinned: MessageId[];
}

export function isDirect(channel: Pick<Channel, 'kind'>): boolean {
  return channel.kind === 'dm' || channel.kind === 'group_dm';
}

/** A stable id both ends of a DM compute independently. */
export function dmKey(workspaceId: WorkspaceId, addresses: AgentAddress[]): string {
  const unique = [...new Set(addresses)].sort();
  return `dm:${workspaceId}:${unique.join(',')}`;
}

const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;

export function normalizeChannelName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[._-]+/, '')
    .slice(0, 80);
}

export function validateChannelName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = normalizeChannelName(raw);
  if (!name) return { ok: false, error: 'Channel names need at least one letter or number.' };
  if (!CHANNEL_NAME_RE.test(name)) return { ok: false, error: 'Use lowercase letters, numbers, hyphens and underscores.' };
  return { ok: true, name };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type MessageKind = 'user' | 'system' | 'meeting';

export interface Reaction {
  /** The rendered emoji, e.g. "👍". */
  emoji: string;
  by: AgentAddress[];
}

/** What a system message is announcing, so clients can phrase it themselves. */
export type SystemEvent =
  | 'channel_created'
  | 'member_joined'
  | 'member_left'
  | 'member_added'
  | 'member_removed'
  | 'topic_changed'
  | 'purpose_changed'
  | 'channel_renamed'
  | 'channel_archived'
  | 'channel_unarchived'
  | 'meeting_scheduled'
  | 'meeting_started'
  | 'meeting_ended';

export interface Message {
  id: MessageId;
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  author: AgentAddress;
  text: string;
  ts: number;
  editedAt?: number;
  /** Soft delete: the row stays so threads and reply counts hold their shape. */
  deletedAt?: number;
  kind: MessageKind;
  /** Set on replies. Points at the root message of the thread. */
  threadRootId?: MessageId;
  /** Maintained on thread roots only. */
  replyCount: number;
  replyUsers: AgentAddress[];
  lastReplyAt?: number;
  /** A thread reply the author also broadcast to the channel. */
  alsoSentToChannel?: boolean;
  reactions: Reaction[];
  /** Resolved at send time so notification routing never re-parses text. */
  mentions: AgentAddress[];
  /** @channel / @here / @everyone. */
  broadcast?: 'channel' | 'here' | 'everyone';
  /** Artifacts the author chose to show — the same refs meetings use. */
  refs?: ArtifactRef[];
  systemEvent?: SystemEvent;
  /** Payload for a system message, e.g. the new topic or the added member. */
  systemDetail?: string;
  meetingId?: string;
  /** True when the person's agent posted this rather than the person typing it. */
  viaAgent?: boolean;
  pinnedBy?: AgentAddress;
  pinnedAt?: number;
}

/**
 * How many messages a workspace snapshot carries per channel. A shorter list
 * than this means the client already holds the whole channel.
 */
export const SNAPSHOT_PAGE = 50;

export interface MessagePage {
  channelId: ChannelId;
  messages: Message[];
  /** False when older messages exist before `messages[0]`. */
  reachedStart: boolean;
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

export interface Invite {
  code: string;
  workspaceId: WorkspaceId;
  workspaceName: string;
  createdBy: AgentAddress;
  createdAt: number;
  /** 0 = never expires. */
  expiresAt: number;
  /** 0 = unlimited. */
  maxUses: number;
  uses: number;
  /** When set, only this address may redeem it. */
  invitedAddress?: AgentAddress;
  role: WorkspaceRole;
  revoked: boolean;
  /** Channels the joiner is added to on top of the workspace defaults. */
  channels: ChannelId[];
}

export function inviteIsUsable(invite: Invite, by: AgentAddress, now = Date.now()): string | null {
  if (invite.revoked) return 'That invitation was revoked.';
  if (invite.expiresAt && invite.expiresAt < now) return 'That invitation has expired.';
  if (invite.maxUses && invite.uses >= invite.maxUses) return 'That invitation has already been used.';
  if (invite.invitedAddress && invite.invitedAddress !== by) {
    return `That invitation was issued to ${invite.invitedAddress}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Read state, preferences
// ---------------------------------------------------------------------------

export type NotifyLevel = 'all' | 'mentions' | 'nothing';

export interface ChannelReadState {
  channelId: ChannelId;
  /** Everything at or before this timestamp has been seen. */
  lastReadTs: number;
  unread: number;
  mentions: number;
  /** Timestamp of the first unread message, for the "new messages" divider. */
  firstUnreadTs?: number;
}

export interface ChannelPrefs {
  channelId: ChannelId;
  notify: NotifyLevel;
  muted: boolean;
  starred: boolean;
}

export interface WorkspacePrefs {
  workspaceId: WorkspaceId;
  notify: NotifyLevel;
  /** Epoch ms until which notifications are suppressed; 0 = not snoozed. */
  dndUntil: number;
  channels: Record<ChannelId, ChannelPrefs>;
  /** Sidebar sections the user collapsed. */
  collapsed: string[];
}

export function defaultChannelPrefs(channelId: ChannelId): ChannelPrefs {
  return { channelId, notify: 'all', muted: false, starred: false };
}

export function defaultWorkspacePrefs(workspaceId: WorkspaceId): WorkspacePrefs {
  return { workspaceId, notify: 'all', dndUntil: 0, channels: {}, collapsed: [] };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchHit {
  message: Message;
  channelName: string;
  channelKind: ChannelKind;
  /** Higher is better. */
  score: number;
}

export interface SearchResults {
  workspaceId: WorkspaceId;
  query: string;
  hits: SearchHit[];
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Client-side view models
// ---------------------------------------------------------------------------

/** What the workspace rail needs to draw one tile. */
export interface WorkspaceSummary {
  workspace: Workspace;
  relayUrl: string;
  myRole: WorkspaceRole;
  connection: 'offline' | 'connecting' | 'online' | 'error';
  memberCount: number;
  unread: number;
  mentions: number;
}

export interface TypingSignal {
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  address: AgentAddress;
  ts: number;
}
