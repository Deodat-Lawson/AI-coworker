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

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * The things a workspace can be configured to restrict.
 *
 * Each one is stored as the *lowest role that may do it*, which is how it reads
 * on the settings screen ("who can create private channels: admins") and how it
 * is checked at the door (`atLeast(myRole, floor)`). Roles are already ordered,
 * so one comparison answers every question.
 */
export type Capability =
  | 'invite'
  | 'create_public_channel'
  | 'create_private_channel'
  | 'archive_channel'
  | 'rename_channel'
  | 'manage_members'
  | 'manage_workspace'
  | 'post_in_default_channel'
  | 'delete_any_message'
  | 'manage_invites';

export type WorkspacePermissions = Record<Capability, WorkspaceRole>;

export const CAPABILITIES: readonly Capability[] = [
  'invite',
  'create_public_channel',
  'create_private_channel',
  'archive_channel',
  'rename_channel',
  'manage_members',
  'manage_workspace',
  'post_in_default_channel',
  'delete_any_message',
  'manage_invites',
] as const;

/** What each control says on the settings screen. */
export const CAPABILITY_LABELS: Record<Capability, string> = {
  invite: 'Invite new people',
  create_public_channel: 'Create public channels',
  create_private_channel: 'Create private channels',
  archive_channel: 'Archive channels',
  rename_channel: 'Rename channels and set topics',
  manage_members: 'Change roles, deactivate and remove people',
  manage_workspace: 'Rename the workspace and change its settings',
  post_in_default_channel: 'Post in the default channel',
  delete_any_message: "Delete anybody's message",
  manage_invites: "Revoke other people's invitations",
};

/**
 * Some things cannot be handed to everyone however the settings are edited —
 * a workspace where any guest could remove the owner is not a configuration,
 * it is a bug. The floor is enforced on the relay, not just greyed out.
 */
export const CAPABILITY_FLOORS: Partial<Record<Capability, WorkspaceRole>> = {
  manage_members: 'admin',
  manage_workspace: 'admin',
  delete_any_message: 'admin',
  create_public_channel: 'member',
  create_private_channel: 'member',
  invite: 'member',
};

export function defaultPermissions(): WorkspacePermissions {
  return {
    invite: 'member',
    create_public_channel: 'member',
    create_private_channel: 'member',
    archive_channel: 'admin',
    rename_channel: 'member',
    manage_members: 'admin',
    manage_workspace: 'admin',
    post_in_default_channel: 'guest',
    delete_any_message: 'admin',
    manage_invites: 'admin',
  };
}

/** Clamp a requested floor to the hard minimum for that capability. */
export function clampCapability(capability: Capability, role: WorkspaceRole): WorkspaceRole {
  const floor = CAPABILITY_FLOORS[capability];
  if (!floor) return role;
  return ROLE_RANK[role] >= ROLE_RANK[floor] ? role : floor;
}

export function can(
  role: WorkspaceRole | undefined,
  capability: Capability,
  permissions: WorkspacePermissions | undefined,
): boolean {
  const table = permissions ?? defaultPermissions();
  return atLeast(role, clampCapability(capability, table[capability]));
}

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
  /**
   * Exactly one person holds this. They cannot be demoted, deactivated or
   * removed by anybody — including another owner — and the only way out is to
   * hand it to somebody else. It is what stops a workspace from being taken
   * from the person whose workspace it is.
   */
  primaryOwner: AgentAddress;
  permissions: WorkspacePermissions;
  /** Listed to everyone on the relay, and joinable without an invitation. */
  discoverable: boolean;
  /**
   * Somebody who finds the workspace but has no invitation can ask to join
   * rather than being told no. Admins see the queue.
   */
  acceptsJoinRequests: boolean;
  /**
   * Email domains this workspace belongs to. Anybody who verifies an address at
   * one of them is offered the workspace during sign-up, which is how a new
   * colleague finds the team without anybody having to send them a code.
   * Only ever set to domains somebody has actually proved they can read mail at.
   */
  emailDomains: string[];
  /** What a verified colleague from a claimed domain gets when they walk in. */
  domainJoin: 'open' | 'request' | 'off';
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
  /** Who switched them off, and when — an admin list is useless without it. */
  deactivatedAt?: number;
  deactivatedBy?: AgentAddress;
  /**
   * A guest confined to these channels and no others, the way Slack's
   * single-channel guests work. Empty on anybody who is not a guest, and on a
   * guest who was given the run of the workspace.
   */
  guestChannels: ChannelId[];
  /** True for the one person who cannot be demoted or removed. */
  primaryOwner: boolean;
  /** Who let them in: the inviter's address, or empty if they found their own way. */
  invitedBy?: AgentAddress;
  presence: Presence;
  status: UserStatus;
  lastSeen: number;
  /** True while the person's own agent is connected on their behalf. */
  agentOnline: boolean;
}

/** A guest is confined when they were given an explicit list of channels. */
export function isConfinedGuest(member: Pick<WorkspaceMember, 'role' | 'guestChannels'>): boolean {
  return member.role === 'guest' && member.guestChannels.length > 0;
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
  /**
   * Set when this channel is a meeting. The agents talk here and nowhere else,
   * and it is archived once they are done — so the sidebar can keep meetings
   * apart from the channels people chose to have.
   */
  meetingId?: string;
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
  /**
   * Who it was emailed to. The account that verifies this address is the one
   * allowed to redeem it, which is what makes "invite your team by email" a
   * real invitation rather than a code anybody who sees it can use.
   */
  invitedEmail?: string;
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
// Join requests
// ---------------------------------------------------------------------------

export type JoinRequestState = 'pending' | 'approved' | 'denied';

/**
 * Somebody asking to be let in. The alternative is that a workspace which is
 * not discoverable can only be joined by somebody who already knows an admin,
 * which is how teams end up passing invite codes around in public channels.
 */
export interface JoinRequest {
  id: string;
  workspaceId: WorkspaceId;
  address: AgentAddress;
  displayName: string;
  /** What they typed to say who they are. */
  message: string;
  createdAt: number;
  state: JoinRequestState;
  decidedBy?: AgentAddress;
  decidedAt?: number;
  /** Set when approved: the role they were let in as. */
  role?: WorkspaceRole;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export type AuditAction =
  | 'workspace_created'
  | 'workspace_updated'
  | 'permissions_changed'
  | 'member_joined'
  | 'member_invited'
  | 'member_removed'
  | 'member_left'
  | 'member_deactivated'
  | 'member_reactivated'
  | 'role_changed'
  | 'ownership_transferred'
  | 'guest_channels_changed'
  | 'invite_created'
  | 'invite_revoked'
  | 'join_requested'
  | 'join_approved'
  | 'join_denied'
  | 'channel_created'
  | 'channel_archived'
  | 'channel_unarchived'
  | 'profile_changed_by_admin';

/**
 * One administrative act. Held on the relay because the relay is the only party
 * that sees all of them, and read only by admins.
 */
export interface AuditEntry {
  id: string;
  workspaceId: WorkspaceId;
  at: number;
  actor: AgentAddress;
  action: AuditAction;
  /** Who or what it was done to. */
  target?: string;
  /** Human-readable specifics: "member → admin", "#billing". */
  detail?: string;
}

/** How much history one workspace keeps. Old entries fall off the end. */
export const AUDIT_LIMIT = 500;

export const AUDIT_LABELS: Record<AuditAction, string> = {
  workspace_created: 'created the workspace',
  workspace_updated: 'changed workspace settings',
  permissions_changed: 'changed permissions',
  member_joined: 'joined',
  member_invited: 'invited',
  member_removed: 'removed',
  member_left: 'left',
  member_deactivated: 'deactivated',
  member_reactivated: 'reactivated',
  role_changed: 'changed the role of',
  ownership_transferred: 'transferred ownership to',
  guest_channels_changed: 'changed guest access for',
  invite_created: 'created an invitation',
  invite_revoked: 'revoked an invitation',
  join_requested: 'asked to join',
  join_approved: 'approved the request from',
  join_denied: 'denied the request from',
  channel_created: 'created',
  channel_archived: 'archived',
  channel_unarchived: 'unarchived',
  profile_changed_by_admin: 'edited the profile of',
};

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
