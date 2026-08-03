/**
 * The workspace hub.
 *
 * A relay hosts any number of workspaces. Each one has its own membership,
 * channels and message history, and the two never leak into each other: a
 * person in two workspaces on the same relay sees two separate places.
 *
 * This file is the whole model — every permission check, every unread count,
 * every side effect of "somebody said something". It is transport-agnostic on
 * purpose: it takes a `deliver` callback and never touches a socket, which is
 * what makes it straightforward to test.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  type AgentAddress,
  type Channel,
  type ChannelId,
  type ChannelReadState,
  type Invite,
  type Message,
  type MessageId,
  type Presence,
  type PublicProfile,
  type SearchHit,
  type ServerMessage,
  type SystemEvent,
  type UserStatus,
  type Workspace,
  type WorkspaceId,
  type WorkspaceMember,
  type WorkspaceRole,
  atLeast,
  dmKey,
  emptyStatus,
  id,
  inviteIsUsable,
  resolveMentions,
  slugify,
  SNAPSHOT_PAGE,
  validateChannelName,
  WORKSPACE_COLORS,
  WORKSPACE_ICONS,
} from '@ai-coworker/shared';

/** A refusal the relay turns into a typed `error` frame for the caller. */
export class HubError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HubError';
  }
}

interface MemberRecord {
  address: AgentAddress;
  role: WorkspaceRole;
  joinedAt: number;
  deactivated: boolean;
  /** Per-workspace overrides; absent means "use the person's own profile". */
  displayName?: string;
  title?: string;
}

interface ChannelRecord {
  channel: Channel;
  messages: Message[];
  /** address -> lastReadTs */
  reads: Record<AgentAddress, number>;
}

interface WorkspaceRecord {
  workspace: Workspace;
  members: Map<AgentAddress, MemberRecord>;
  channels: Map<ChannelId, ChannelRecord>;
  invites: Map<string, Invite>;
}

interface Identity {
  profile: PublicProfile;
  presence: Presence;
  status: UserStatus;
  lastSeen: number;
  online: boolean;
}

export interface HubOptions {
  /** Where to persist. Omit for an in-memory hub (tests). */
  statePath?: string;
  relayName?: string;
  /** Name of the workspace every newcomer lands in. */
  defaultWorkspaceName?: string;
  /** Per-channel retention. Older messages fall off the end. */
  maxMessagesPerChannel?: number;
  log?: (message: string) => void;
}

const SNAPSHOT_MESSAGES = SNAPSHOT_PAGE;
const HISTORY_PAGE = 50;

export class WorkspaceHub {
  private workspaces = new Map<WorkspaceId, WorkspaceRecord>();
  private identities = new Map<AgentAddress, Identity>();
  private options: Required<Omit<HubOptions, 'statePath'>> & { statePath?: string };
  private saveTimer: NodeJS.Timeout | null = null;
  private deliver: (to: AgentAddress, message: ServerMessage) => void = () => {};

  constructor(options: HubOptions = {}) {
    this.options = {
      statePath: options.statePath,
      relayName: options.relayName ?? 'AI Coworker relay',
      defaultWorkspaceName: options.defaultWorkspaceName ?? 'Home',
      maxMessagesPerChannel: options.maxMessagesPerChannel ?? 5000,
      log: options.log ?? (() => {}),
    };
    this.restore();
    this.ensureDefaultWorkspace();
  }

  /** Wire the hub to a transport. Called once by the relay. */
  onDeliver(fn: (to: AgentAddress, message: ServerMessage) => void): void {
    this.deliver = fn;
  }

  get relayName(): string {
    return this.options.relayName;
  }

  // -------------------------------------------------------------------------
  // Identity and presence
  // -------------------------------------------------------------------------

  /**
   * Record who just connected. Everyone lands in the default workspace so a
   * fresh relay is usable without an invitation dance.
   */
  connect(profile: PublicProfile): WorkspaceId[] {
    const existing = this.identities.get(profile.address);
    this.identities.set(profile.address, {
      profile,
      presence: existing?.presence === 'dnd' ? 'dnd' : 'active',
      status: existing?.status ?? emptyStatus(),
      lastSeen: Date.now(),
      online: true,
    });

    const mine = this.workspaceIdsFor(profile.address);
    if (!mine.length) {
      const fallback = this.defaultWorkspace();
      this.addMember(fallback, profile.address, fallback.members.size === 0 ? 'owner' : 'member');
      mine.push(fallback.workspace.id);
    }
    this.announcePresence(profile.address);
    this.save();
    return mine;
  }

  disconnect(address: AgentAddress): void {
    const identity = this.identities.get(address);
    if (!identity) return;
    identity.online = false;
    identity.presence = 'offline';
    identity.lastSeen = Date.now();
    this.announcePresence(address);
  }

  setPresence(address: AgentAddress, presence?: Presence, status?: UserStatus): void {
    const identity = this.identities.get(address);
    if (!identity) return;
    if (presence) identity.presence = presence;
    if (status) identity.status = status;
    identity.lastSeen = Date.now();
    this.announcePresence(address);
    this.save();
  }

  private announcePresence(address: AgentAddress): void {
    for (const workspaceId of this.workspaceIdsFor(address)) {
      const record = this.workspaces.get(workspaceId)!;
      const member = this.memberView(record, address);
      if (!member) continue;
      this.broadcast(record, { type: 'workspace.member', workspaceId, member });
    }
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  workspaceIdsFor(address: AgentAddress): WorkspaceId[] {
    const out: WorkspaceId[] = [];
    for (const record of this.workspaces.values()) {
      if (record.members.has(address)) out.push(record.workspace.id);
    }
    return out;
  }

  private require(workspaceId: WorkspaceId): WorkspaceRecord {
    const record = this.workspaces.get(workspaceId);
    if (!record) throw new HubError('no_workspace', 'That workspace does not exist on this relay.');
    return record;
  }

  private requireMembership(workspaceId: WorkspaceId, address: AgentAddress): WorkspaceRecord {
    const record = this.require(workspaceId);
    if (!record.members.has(address)) {
      throw new HubError('not_a_member', `You are not a member of ${record.workspace.name}.`);
    }
    return record;
  }

  private roleOf(record: WorkspaceRecord, address: AgentAddress): WorkspaceRole | undefined {
    return record.members.get(address)?.role;
  }

  private requireRole(record: WorkspaceRecord, address: AgentAddress, floor: WorkspaceRole): void {
    if (!atLeast(this.roleOf(record, address), floor)) {
      throw new HubError('forbidden', `That needs ${floor} permissions in ${record.workspace.name}.`);
    }
  }

  private requireChannel(record: WorkspaceRecord, channelId: ChannelId): ChannelRecord {
    const channel = record.channels.get(channelId);
    if (!channel) throw new HubError('no_channel', 'That channel does not exist.');
    return channel;
  }

  /** Public channels are visible to the whole workspace; the rest are by membership. */
  private canSee(entry: ChannelRecord, address: AgentAddress): boolean {
    if (entry.channel.kind === 'public') return true;
    return entry.channel.members.includes(address);
  }

  private requireVisible(
    record: WorkspaceRecord,
    channelId: ChannelId,
    address: AgentAddress,
  ): ChannelRecord {
    const entry = this.requireChannel(record, channelId);
    if (!this.canSee(entry, address)) throw new HubError('forbidden', 'You do not have access to that channel.');
    return entry;
  }

  private isDefaultWorkspace(record: WorkspaceRecord): boolean {
    return this.defaultWorkspaceId === record.workspace.id;
  }

  private defaultWorkspaceId: WorkspaceId = '';

  private defaultWorkspace(): WorkspaceRecord {
    return this.require(this.defaultWorkspaceId);
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  private memberView(record: WorkspaceRecord, address: AgentAddress): WorkspaceMember | null {
    const entry = record.members.get(address);
    if (!entry) return null;
    const identity = this.identities.get(address);
    const profile = identity?.profile;
    return {
      workspaceId: record.workspace.id,
      address,
      displayName: entry.displayName ?? profile?.displayName ?? address.split('@')[0]!,
      title: entry.title ?? profile?.title ?? '',
      bio: profile?.bio ?? '',
      timezone: profile?.timezone ?? 'UTC',
      focusAreas: profile?.focusAreas ?? [],
      role: entry.role,
      joinedAt: entry.joinedAt,
      deactivated: entry.deactivated,
      presence: entry.deactivated ? 'offline' : (identity?.presence ?? 'offline'),
      status: identity?.status ?? emptyStatus(),
      lastSeen: identity?.lastSeen ?? entry.joinedAt,
      agentOnline: Boolean(identity?.online) && !entry.deactivated,
    };
  }

  private membersView(record: WorkspaceRecord): WorkspaceMember[] {
    const out: WorkspaceMember[] = [];
    for (const address of record.members.keys()) {
      const view = this.memberView(record, address);
      if (view) out.push(view);
    }
    return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /** Messages that belong on the channel timeline (thread replies stay in threads). */
  private timeline(entry: ChannelRecord): Message[] {
    return entry.messages.filter((m) => !m.threadRootId || m.alsoSentToChannel);
  }

  readState(entry: ChannelRecord, address: AgentAddress): ChannelReadState {
    const lastReadTs = entry.reads[address] ?? 0;
    let unread = 0;
    let mentions = 0;
    let firstUnreadTs: number | undefined;
    for (const message of entry.messages) {
      if (message.ts <= lastReadTs) continue;
      if (message.author === address) continue;
      if (message.deletedAt) continue;
      // "Sarah joined the channel" is worth showing in the timeline but is not
      // worth a badge — a red dot should always mean somebody said something.
      if (message.kind === 'system') continue;
      const onTimeline = !message.threadRootId || message.alsoSentToChannel;
      const mentionsMe = message.mentions.includes(address) || Boolean(message.broadcast);
      if (onTimeline) {
        unread++;
        firstUnreadTs ??= message.ts;
      }
      if (mentionsMe) mentions++;
    }
    // Every message in a DM is addressed to you, so the badge should say so.
    if ((entry.channel.kind === 'dm' || entry.channel.kind === 'group_dm') && unread > 0) {
      mentions = Math.max(mentions, unread);
    }
    return { channelId: entry.channel.id, lastReadTs, unread, mentions, firstUnreadTs };
  }

  snapshot(address: AgentAddress, workspaceId: WorkspaceId): ServerMessage {
    const record = this.requireMembership(workspaceId, address);
    const me = this.memberView(record, address)!;
    const channels: Channel[] = [];
    const readStates: ChannelReadState[] = [];
    const recent: Record<ChannelId, Message[]> = {};

    for (const entry of record.channels.values()) {
      if (!this.canSee(entry, address)) continue;
      channels.push(entry.channel);
      readStates.push(this.readState(entry, address));
      if (entry.channel.members.includes(address)) {
        recent[entry.channel.id] = this.timeline(entry).slice(-SNAPSHOT_MESSAGES);
      }
    }

    return {
      type: 'workspace.snapshot',
      workspace: record.workspace,
      me,
      members: this.membersView(record),
      channels: channels.sort((a, b) => a.name.localeCompare(b.name)),
      readStates,
      recent,
    };
  }

  sendSnapshot(address: AgentAddress, workspaceId: WorkspaceId): void {
    this.deliver(address, this.snapshot(address, workspaceId));
  }

  discoverable(address: AgentAddress): ServerMessage {
    const workspaces = [...this.workspaces.values()]
      .filter((r) => r.workspace.discoverable || r.members.has(address))
      .map((r) => ({
        id: r.workspace.id,
        slug: r.workspace.slug,
        name: r.workspace.name,
        description: r.workspace.description,
        icon: r.workspace.icon,
        color: r.workspace.color,
        memberCount: r.members.size,
        joined: r.members.has(address),
      }))
      .sort((a, b) => b.memberCount - a.memberCount);
    return { type: 'workspace.discover.result', workspaces };
  }

  // -------------------------------------------------------------------------
  // Broadcast
  // -------------------------------------------------------------------------

  private broadcast(
    record: WorkspaceRecord,
    message: ServerMessage,
    to?: AgentAddress[],
  ): void {
    const targets = to ?? [...record.members.keys()];
    for (const address of targets) this.deliver(address, message);
  }

  /** Everyone who should be told about traffic in this channel. */
  private audience(record: WorkspaceRecord, entry: ChannelRecord): AgentAddress[] {
    if (entry.channel.kind === 'public') return [...record.members.keys()];
    return entry.channel.members.filter((a) => record.members.has(a));
  }

  // -------------------------------------------------------------------------
  // Workspace lifecycle
  // -------------------------------------------------------------------------

  private ensureDefaultWorkspace(): void {
    if (this.defaultWorkspaceId && this.workspaces.has(this.defaultWorkspaceId)) return;
    const existing = [...this.workspaces.values()].sort(
      (a, b) => a.workspace.createdAt - b.workspace.createdAt,
    )[0];
    if (existing) {
      this.defaultWorkspaceId = existing.workspace.id;
      return;
    }
    const record = this.newWorkspace({
      name: this.options.defaultWorkspaceName,
      slug: slugify(this.options.defaultWorkspaceName),
      createdBy: 'relay',
      description: 'Everyone on this relay.',
      discoverable: true,
      channels: ['general', 'random'],
    });
    this.defaultWorkspaceId = record.workspace.id;
    this.options.log(`created default workspace "${record.workspace.name}"`);
  }

  private newWorkspace(input: {
    name: string;
    slug: string;
    createdBy: AgentAddress;
    description?: string;
    icon?: string;
    color?: string;
    discoverable?: boolean;
    channels?: string[];
  }): WorkspaceRecord {
    const now = Date.now();
    const seed = input.slug.length + input.name.length;
    const workspace: Workspace = {
      id: id('ws'),
      slug: this.uniqueSlug(input.slug),
      name: input.name,
      description: input.description ?? '',
      icon: input.icon || WORKSPACE_ICONS[seed % WORKSPACE_ICONS.length]!,
      color: input.color || WORKSPACE_COLORS[seed % WORKSPACE_COLORS.length]!,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      invitePolicy: 'anyone',
      discoverable: input.discoverable ?? true,
      // Everything created with the workspace is a default: a new member should
      // land somewhere with people in it, not in an empty #general.
      defaultChannels: [],
    };
    const record: WorkspaceRecord = {
      workspace,
      members: new Map(),
      channels: new Map(),
      invites: new Map(),
    };
    this.workspaces.set(workspace.id, record);

    const names = ['general', ...(input.channels ?? [])].filter(
      (n, i, all) => all.indexOf(n) === i,
    );
    for (const name of names) {
      this.createChannelRecord(record, {
        name,
        kind: 'public',
        createdBy: input.createdBy,
        isDefault: name === 'general',
        topic: name === 'general' ? 'Everything that matters to everyone.' : '',
      });
    }
    workspace.defaultChannels = names;
    return record;
  }

  private uniqueSlug(base: string): string {
    const clean = slugify(base) || 'workspace';
    if (![...this.workspaces.values()].some((r) => r.workspace.slug === clean)) return clean;
    for (let n = 2; n < 500; n++) {
      const candidate = `${clean}-${n}`;
      if (![...this.workspaces.values()].some((r) => r.workspace.slug === candidate)) return candidate;
    }
    return `${clean}-${id('x').slice(-4)}`;
  }

  createWorkspace(
    actor: AgentAddress,
    input: {
      name: string;
      slug?: string;
      description?: string;
      icon?: string;
      color?: string;
      discoverable?: boolean;
      channels?: string[];
    },
  ): WorkspaceId {
    const name = input.name.trim().slice(0, 60);
    if (name.length < 2) throw new HubError('bad_name', 'Give the workspace a name.');
    const extra = (input.channels ?? [])
      .map((c) => validateChannelName(c))
      .filter((r): r is { ok: true; name: string } => r.ok)
      .map((r) => r.name);

    const record = this.newWorkspace({
      name,
      slug: input.slug?.trim() || name,
      createdBy: actor,
      description: input.description?.trim().slice(0, 280),
      icon: input.icon,
      color: input.color,
      discoverable: input.discoverable,
      channels: extra,
    });
    this.addMember(record, actor, 'owner');
    this.options.log(`${actor} created workspace "${record.workspace.name}"`);
    this.save();
    return record.workspace.id;
  }

  updateWorkspace(actor: AgentAddress, workspaceId: WorkspaceId, patch: Partial<Workspace>): void {
    const record = this.requireMembership(workspaceId, actor);
    this.requireRole(record, actor, 'admin');
    const w = record.workspace;
    if (typeof patch.name === 'string' && patch.name.trim()) w.name = patch.name.trim().slice(0, 60);
    if (typeof patch.description === 'string') w.description = patch.description.slice(0, 280);
    if (typeof patch.icon === 'string' && patch.icon) w.icon = [...patch.icon][0] ?? w.icon;
    if (typeof patch.color === 'string' && /^#[0-9a-f]{6}$/i.test(patch.color)) w.color = patch.color;
    if (patch.invitePolicy === 'anyone' || patch.invitePolicy === 'admins') w.invitePolicy = patch.invitePolicy;
    if (typeof patch.discoverable === 'boolean') w.discoverable = patch.discoverable;
    w.updatedAt = Date.now();
    this.broadcast(record, { type: 'workspace.updated', workspace: w });
    this.save();
  }

  deleteWorkspace(actor: AgentAddress, workspaceId: WorkspaceId): void {
    const record = this.requireMembership(workspaceId, actor);
    this.requireRole(record, actor, 'owner');
    if (this.isDefaultWorkspace(record)) {
      throw new HubError('forbidden', 'The relay\'s home workspace cannot be deleted.');
    }
    const members = [...record.members.keys()];
    this.workspaces.delete(workspaceId);
    for (const address of members) {
      this.deliver(address, {
        type: 'workspace.removed',
        workspaceId,
        reason: `${record.workspace.name} was deleted by its owner.`,
      });
    }
    this.save();
  }

  private addMember(
    record: WorkspaceRecord,
    address: AgentAddress,
    role: WorkspaceRole,
    channels: ChannelId[] = [],
  ): void {
    if (record.members.has(address)) return;
    record.members.set(address, { address, role, joinedAt: Date.now(), deactivated: false });

    // Drop them into the default channels, plus anything the invite named.
    const wanted = new Set(channels);
    for (const entry of record.channels.values()) {
      if (entry.channel.kind === 'public' && entry.channel.isDefault) wanted.add(entry.channel.id);
      if (record.workspace.defaultChannels.includes(entry.channel.name)) wanted.add(entry.channel.id);
    }
    for (const channelId of wanted) {
      const entry = record.channels.get(channelId);
      if (!entry || entry.channel.archived) continue;
      if (!entry.channel.members.includes(address)) entry.channel.members.push(address);
    }

    const member = this.memberView(record, address)!;
    this.broadcast(record, { type: 'workspace.member', workspaceId: record.workspace.id, member });
    for (const channelId of wanted) {
      const entry = record.channels.get(channelId);
      if (entry) {
        this.broadcast(record, {
          type: 'channel.upserted',
          workspaceId: record.workspace.id,
          channel: entry.channel,
        });
      }
    }
    const general = [...record.channels.values()].find((c) => c.channel.isDefault);
    if (general) {
      this.postSystem(record, general, address, 'member_joined', '');
    }
  }

  joinWorkspace(actor: AgentAddress, input: { code?: string; slug?: string }): WorkspaceId {
    if (input.code) {
      const code = input.code.trim();
      for (const record of this.workspaces.values()) {
        const invite = record.invites.get(code);
        if (!invite) continue;
        const problem = inviteIsUsable(invite, actor);
        if (problem) throw new HubError('bad_invite', problem);
        if (record.members.has(actor)) return record.workspace.id;
        invite.uses++;
        this.addMember(record, actor, invite.role, invite.channels);
        this.options.log(`${actor} joined "${record.workspace.name}" by invitation`);
        this.save();
        return record.workspace.id;
      }
      throw new HubError('bad_invite', 'That invitation code is not valid on this relay.');
    }

    const slug = (input.slug ?? '').trim().toLowerCase().replace(/^#/, '');
    const record = [...this.workspaces.values()].find(
      (r) => r.workspace.slug === slug || r.workspace.id === slug,
    );
    if (!record) throw new HubError('no_workspace', `No workspace called "${slug}" on this relay.`);
    if (record.members.has(actor)) return record.workspace.id;
    if (!record.workspace.discoverable) {
      throw new HubError('forbidden', `${record.workspace.name} is invitation-only.`);
    }
    this.addMember(record, actor, 'member');
    this.options.log(`${actor} joined "${record.workspace.name}"`);
    this.save();
    return record.workspace.id;
  }

  leaveWorkspace(actor: AgentAddress, workspaceId: WorkspaceId): void {
    const record = this.requireMembership(workspaceId, actor);
    if (this.roleOf(record, actor) === 'owner') {
      const others = [...record.members.values()].filter((m) => m.address !== actor && !m.deactivated);
      if (others.length) {
        throw new HubError(
          'owner_must_transfer',
          'Make somebody else an owner before you leave, or delete the workspace.',
        );
      }
    }
    this.removeMemberInternal(record, actor, `You left ${record.workspace.name}.`);
    this.save();
  }

  removeMember(actor: AgentAddress, workspaceId: WorkspaceId, address: AgentAddress): void {
    const record = this.requireMembership(workspaceId, actor);
    this.requireRole(record, actor, 'admin');
    if (address === actor) throw new HubError('bad_request', 'Use "leave workspace" to remove yourself.');
    const target = record.members.get(address);
    if (!target) throw new HubError('not_a_member', 'They are not in this workspace.');
    if (atLeast(target.role, 'owner')) throw new HubError('forbidden', 'An owner cannot be removed.');
    this.removeMemberInternal(record, address, `You were removed from ${record.workspace.name}.`);
    this.save();
  }

  private removeMemberInternal(record: WorkspaceRecord, address: AgentAddress, reason: string): void {
    record.members.delete(address);
    for (const entry of record.channels.values()) {
      const idx = entry.channel.members.indexOf(address);
      if (idx >= 0) entry.channel.members.splice(idx, 1);
    }
    this.deliver(address, { type: 'workspace.removed', workspaceId: record.workspace.id, reason });
    this.broadcast(record, {
      type: 'workspace.member_removed',
      workspaceId: record.workspace.id,
      address,
    });
    const general = [...record.channels.values()].find((c) => c.channel.isDefault);
    if (general) this.postSystem(record, general, address, 'member_left', '');
  }

  setRole(actor: AgentAddress, workspaceId: WorkspaceId, address: AgentAddress, role: WorkspaceRole): void {
    const record = this.requireMembership(workspaceId, actor);
    this.requireRole(record, actor, 'admin');
    const target = record.members.get(address);
    if (!target) throw new HubError('not_a_member', 'They are not in this workspace.');

    const actorRole = this.roleOf(record, actor)!;
    if (role === 'owner' && actorRole !== 'owner') {
      throw new HubError('forbidden', 'Only an owner can hand over ownership.');
    }
    if (target.role === 'owner' && actorRole !== 'owner') {
      throw new HubError('forbidden', 'Only an owner can change another owner.');
    }
    if (target.role === 'owner' && address !== actor) {
      // Demoting the last owner would strand the workspace.
      const owners = [...record.members.values()].filter((m) => m.role === 'owner');
      if (owners.length <= 1 && role !== 'owner') {
        throw new HubError('forbidden', 'A workspace always needs at least one owner.');
      }
    }
    target.role = role;
    const member = this.memberView(record, address)!;
    this.broadcast(record, { type: 'workspace.member', workspaceId, member });
    this.save();
  }

  setWorkspaceProfile(
    actor: AgentAddress,
    workspaceId: WorkspaceId,
    patch: { displayName?: string; title?: string },
  ): void {
    const record = this.requireMembership(workspaceId, actor);
    const entry = record.members.get(actor)!;
    if (patch.displayName !== undefined) {
      const trimmed = patch.displayName.trim().slice(0, 60);
      entry.displayName = trimmed || undefined;
    }
    if (patch.title !== undefined) {
      const trimmed = patch.title.trim().slice(0, 80);
      entry.title = trimmed || undefined;
    }
    const member = this.memberView(record, actor)!;
    this.broadcast(record, { type: 'workspace.member', workspaceId, member });
    this.save();
  }

  // -------------------------------------------------------------------------
  // Invitations
  // -------------------------------------------------------------------------

  createInvite(
    actor: AgentAddress,
    workspaceId: WorkspaceId,
    input: {
      invitedAddress?: AgentAddress;
      role?: WorkspaceRole;
      expiresInHours?: number;
      maxUses?: number;
      channels?: ChannelId[];
    },
  ): Invite {
    const record = this.requireMembership(workspaceId, actor);
    if (record.workspace.invitePolicy === 'admins') this.requireRole(record, actor, 'admin');
    const role: WorkspaceRole = input.role === 'guest' || input.role === 'admin' ? input.role : 'member';
    if (role === 'admin') this.requireRole(record, actor, 'admin');

    const hours = input.expiresInHours ?? 24 * 7;
    const invite: Invite = {
      code: inviteCode(),
      workspaceId,
      workspaceName: record.workspace.name,
      createdBy: actor,
      createdAt: Date.now(),
      expiresAt: hours > 0 ? Date.now() + hours * 3_600_000 : 0,
      maxUses: Math.max(0, input.maxUses ?? 0),
      uses: 0,
      invitedAddress: input.invitedAddress,
      role,
      revoked: false,
      channels: (input.channels ?? []).filter((c) => record.channels.has(c)),
    };
    record.invites.set(invite.code, invite);
    this.deliver(actor, { type: 'invite.created', workspaceId, invite });

    // A targeted invitation is worth telling the recipient about directly.
    if (invite.invitedAddress && this.identities.get(invite.invitedAddress)?.online) {
      this.deliver(invite.invitedAddress, { type: 'invite.created', workspaceId, invite });
    }
    this.save();
    return invite;
  }

  revokeInvite(actor: AgentAddress, workspaceId: WorkspaceId, code: string): void {
    const record = this.requireMembership(workspaceId, actor);
    const invite = record.invites.get(code);
    if (!invite) throw new HubError('no_invite', 'That invitation no longer exists.');
    if (invite.createdBy !== actor) this.requireRole(record, actor, 'admin');
    invite.revoked = true;
    this.deliver(actor, { type: 'invite.list.result', workspaceId, invites: this.invitesFor(record, actor) });
    this.save();
  }

  listInvites(actor: AgentAddress, workspaceId: WorkspaceId): ServerMessage {
    const record = this.requireMembership(workspaceId, actor);
    return { type: 'invite.list.result', workspaceId, invites: this.invitesFor(record, actor) };
  }

  private invitesFor(record: WorkspaceRecord, actor: AgentAddress): Invite[] {
    const isAdmin = atLeast(this.roleOf(record, actor), 'admin');
    return [...record.invites.values()]
      .filter((i) => !i.revoked && (isAdmin || i.createdBy === actor))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  // -------------------------------------------------------------------------
  // Channels
  // -------------------------------------------------------------------------

  private createChannelRecord(
    record: WorkspaceRecord,
    input: {
      name: string;
      kind: Channel['kind'];
      createdBy: AgentAddress;
      topic?: string;
      purpose?: string;
      members?: AgentAddress[];
      isDefault?: boolean;
      id?: ChannelId;
    },
  ): ChannelRecord {
    const now = Date.now();
    const channel: Channel = {
      id: input.id ?? id('ch'),
      workspaceId: record.workspace.id,
      kind: input.kind,
      name: input.name,
      topic: input.topic ?? '',
      purpose: input.purpose ?? '',
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      archived: false,
      members: [...new Set(input.members ?? [])],
      isDefault: input.isDefault ?? false,
      lastMessageAt: 0,
      messageCount: 0,
      pinned: [],
    };
    const entry: ChannelRecord = { channel, messages: [], reads: {} };
    record.channels.set(channel.id, entry);
    return entry;
  }

  createChannel(
    actor: AgentAddress,
    workspaceId: WorkspaceId,
    input: { name: string; kind?: 'public' | 'private'; topic?: string; purpose?: string; members?: AgentAddress[] },
  ): ChannelId {
    const record = this.requireMembership(workspaceId, actor);
    if (this.roleOf(record, actor) === 'guest') {
      throw new HubError('forbidden', 'Guests cannot create channels.');
    }
    const validated = validateChannelName(input.name);
    if (!validated.ok) throw new HubError('bad_name', validated.error);
    const name = validated.name;
    const clash = [...record.channels.values()].find(
      (c) => c.channel.name === name && c.channel.kind !== 'dm' && c.channel.kind !== 'group_dm',
    );
    if (clash) throw new HubError('name_taken', `#${name} already exists in this workspace.`);

    const members = [actor, ...(input.members ?? []).filter((a) => record.members.has(a))];
    const entry = this.createChannelRecord(record, {
      name,
      kind: input.kind === 'private' ? 'private' : 'public',
      createdBy: actor,
      topic: input.topic?.slice(0, 250),
      purpose: input.purpose?.slice(0, 250),
      members,
    });
    this.broadcast(
      record,
      { type: 'channel.upserted', workspaceId, channel: entry.channel },
      this.audience(record, entry),
    );
    this.postSystem(record, entry, actor, 'channel_created', name);
    this.save();
    return entry.channel.id;
  }

  updateChannel(
    actor: AgentAddress,
    workspaceId: WorkspaceId,
    channelId: ChannelId,
    patch: { name?: string; topic?: string; purpose?: string },
  ): void {
    const record = this.requireMembership(workspaceId, actor);
    const entry = this.requireVisible(record, channelId, actor);
    if (entry.channel.kind === 'dm' || entry.channel.kind === 'group_dm') {
      throw new HubError('forbidden', 'Direct messages have no topic or name.');
    }
    if (!entry.channel.members.includes(actor)) {
      this.requireRole(record, actor, 'admin');
    }

    if (patch.name !== undefined) {
      if (entry.channel.isDefault) throw new HubError('forbidden', '#general cannot be renamed.');
      const validated = validateChannelName(patch.name);
      if (!validated.ok) throw new HubError('bad_name', validated.error);
      const clash = [...record.channels.values()].find(
        (c) => c.channel.name === validated.name && c.channel.id !== channelId,
      );
      if (clash) throw new HubError('name_taken', `#${validated.name} already exists.`);
      const before = entry.channel.name;
      entry.channel.name = validated.name;
      this.postSystem(record, entry, actor, 'channel_renamed', `${before} → ${validated.name}`);
    }
    if (patch.topic !== undefined) {
      entry.channel.topic = patch.topic.slice(0, 250);
      this.postSystem(record, entry, actor, 'topic_changed', entry.channel.topic);
    }
    if (patch.purpose !== undefined) {
      entry.channel.purpose = patch.purpose.slice(0, 250);
      this.postSystem(record, entry, actor, 'purpose_changed', entry.channel.purpose);
    }
    entry.channel.updatedAt = Date.now();
    this.broadcast(
      record,
      { type: 'channel.upserted', workspaceId, channel: entry.channel },
      this.audience(record, entry),
    );
    this.save();
  }

  archiveChannel(actor: AgentAddress, workspaceId: WorkspaceId, channelId: ChannelId, archived: boolean): void {
    const record = this.requireMembership(workspaceId, actor);
    const entry = this.requireVisible(record, channelId, actor);
    if (entry.channel.isDefault) throw new HubError('forbidden', '#general cannot be archived.');
    if (entry.channel.kind === 'dm' || entry.channel.kind === 'group_dm') {
      throw new HubError('forbidden', 'Direct messages cannot be archived.');
    }
    if (entry.channel.createdBy !== actor) this.requireRole(record, actor, 'admin');
    entry.channel.archived = archived;
    entry.channel.updatedAt = Date.now();
    this.postSystem(record, entry, actor, archived ? 'channel_archived' : 'channel_unarchived', '');
    this.broadcast(
      record,
      { type: 'channel.upserted', workspaceId, channel: entry.channel },
      this.audience(record, entry),
    );
    this.save();
  }

  joinChannel(actor: AgentAddress, workspaceId: WorkspaceId, channelId: ChannelId): void {
    const record = this.requireMembership(workspaceId, actor);
    const entry = this.requireChannel(record, channelId);
    if (entry.channel.kind !== 'public') {
      throw new HubError('forbidden', 'That channel is private — somebody in it has to add you.');
    }
    if (entry.channel.archived) throw new HubError('archived', 'That channel is archived.');
    if (entry.channel.members.includes(actor)) {
      this.sendChannel(record, entry, actor);
      return;
    }
    entry.channel.members.push(actor);
    this.postSystem(record, entry, actor, 'member_joined', '');
    this.broadcast(record, { type: 'channel.upserted', workspaceId, channel: entry.channel });
    this.sendChannelHistory(actor, record, entry);
    this.save();
  }

  leaveChannel(actor: AgentAddress, workspaceId: WorkspaceId, channelId: ChannelId): void {
    const record = this.requireMembership(workspaceId, actor);
    const entry = this.requireChannel(record, channelId);
    if (entry.channel.isDefault) throw new HubError('forbidden', 'You cannot leave #general.');
    if (entry.channel.kind === 'dm' || entry.channel.kind === 'group_dm') {
      throw new HubError('forbidden', 'Close the conversation instead of leaving it.');
    }
    const idx = entry.channel.members.indexOf(actor);
    if (idx === -1) return;
    entry.channel.members.splice(idx, 1);
    this.postSystem(record, entry, actor, 'member_left', '');
    const audience = new Set([...this.audience(record, entry), actor]);
    this.broadcast(record, { type: 'channel.upserted', workspaceId, channel: entry.channel }, [...audience]);
    this.save();
  }

  inviteToChannel(
    actor: AgentAddress,
    workspaceId: WorkspaceId,
    channelId: ChannelId,
    addresses: AgentAddress[],
  ): void {
    const record = this.requireMembership(workspaceId, actor);
    const entry = this.requireVisible(record, channelId, actor);
    if (entry.channel.kind === 'dm') throw new HubError('forbidden', 'Start a group message instead.');
    if (!entry.channel.members.includes(actor)) {
      throw new HubError('forbidden', 'Join the channel before adding people to it.');
    }
    const added: AgentAddress[] = [];
    for (const address of addresses) {
      if (!record.members.has(address)) continue;
      if (entry.channel.members.includes(address)) continue;
      entry.channel.members.push(address);
      added.push(address);
    }
    if (!added.length) return;
    for (const address of added) {
      this.postSystem(record, entry, actor, 'member_added', address);
    }
    this.broadcast(
      record,
      { type: 'channel.upserted', workspaceId, channel: entry.channel },
      this.audience(record, entry),
    );
    for (const address of added) this.sendChannelHistory(address, record, entry);
    this.save();
  }

  kickFromChannel(
    actor: AgentAddress,
    workspaceId: WorkspaceId,
    channelId: ChannelId,
    address: AgentAddress,
  ): void {
    const record = this.requireMembership(workspaceId, actor);
    const entry = this.requireVisible(record, channelId, actor);
    if (entry.channel.isDefault) throw new HubError('forbidden', 'Nobody can be removed from #general.');
    if (entry.channel.createdBy !== actor) this.requireRole(record, actor, 'admin');
    const idx = entry.channel.members.indexOf(address);
    if (idx === -1) return;
    entry.channel.members.splice(idx, 1);
    this.postSystem(record, entry, actor, 'member_removed', address);
    const audience = new Set([...this.audience(record, entry), address]);
    this.broadcast(record, { type: 'channel.upserted', workspaceId, channel: entry.channel }, [...audience]);
    this.save();
  }

  listChannels(actor: AgentAddress, workspaceId: WorkspaceId): ServerMessage[] {
    const record = this.requireMembership(workspaceId, actor);
    const out: ServerMessage[] = [];
    for (const entry of record.channels.values()) {
      if (!this.canSee(entry, actor)) continue;
      out.push({ type: 'channel.upserted', workspaceId, channel: entry.channel });
    }
    return out;
  }

  private sendChannel(record: WorkspaceRecord, entry: ChannelRecord, to: AgentAddress): void {
    this.deliver(to, {
      type: 'channel.upserted',
      workspaceId: record.workspace.id,
      channel: entry.channel,
    });
  }

  private sendChannelHistory(to: AgentAddress, record: WorkspaceRecord, entry: ChannelRecord): void {
    this.sendChannel(record, entry, to);
    const messages = this.timeline(entry).slice(-SNAPSHOT_MESSAGES);
    this.deliver(to, {
      type: 'history.page',
      workspaceId: record.workspace.id,
      channelId: entry.channel.id,
      messages,
      reachedStart: messages.length === this.timeline(entry).length,
    });
    this.deliver(to, {
      type: 'read.updated',
      workspaceId: record.workspace.id,
      read: this.readState(entry, to),
    });
  }

  /** Open (or reuse) a direct conversation. Both ends land on the same channel. */
  openDm(actor: AgentAddress, workspaceId: WorkspaceId, addresses: AgentAddress[]): ChannelId {
    const record = this.requireMembership(workspaceId, actor);
    const others = [...new Set(addresses)].filter((a) => a !== actor && record.members.has(a));
    if (!others.length) throw new HubError('bad_request', 'Pick somebody in this workspace to message.');
    const participants = [actor, ...others].sort();
    if (participants.length > 9) throw new HubError('bad_request', 'A group message tops out at 9 people.');

    const key = dmKey(workspaceId, participants);
    const existing = [...record.channels.values()].find((c) => c.channel.id === key);
    if (existing) {
      for (const address of participants) this.sendChannelHistory(address, record, existing);
      return existing.channel.id;
    }

    const entry = this.createChannelRecord(record, {
      id: key,
      name: '',
      kind: participants.length > 2 ? 'group_dm' : 'dm',
      createdBy: actor,
      members: participants,
    });
    for (const address of participants) this.sendChannelHistory(address, record, entry);
    this.save();
    return entry.channel.id;
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  postMessage(
    actor: AgentAddress,
    input: {
      workspaceId: WorkspaceId;
      channelId: ChannelId;
      text: string;
      threadRootId?: MessageId;
      alsoSendToChannel?: boolean;
      refs?: Message['refs'];
      clientId?: string;
      viaAgent?: boolean;
    },
  ): Message {
    const record = this.requireMembership(input.workspaceId, actor);
    const entry = this.requireVisible(record, input.channelId, actor);
    if (entry.channel.archived) throw new HubError('archived', 'That channel is archived.');

    const text = input.text.slice(0, 12_000);
    if (!text.trim() && !(input.refs ?? []).length) {
      throw new HubError('empty', 'Nothing to send.');
    }
    // Posting in a public channel you are only browsing joins you to it, the
    // way walking up to a conversation and speaking does.
    if (entry.channel.kind === 'public' && !entry.channel.members.includes(actor)) {
      entry.channel.members.push(actor);
      this.broadcast(record, {
        type: 'channel.upserted',
        workspaceId: record.workspace.id,
        channel: entry.channel,
      });
    }

    let root: Message | undefined;
    if (input.threadRootId) {
      root = entry.messages.find((m) => m.id === input.threadRootId);
      if (!root) throw new HubError('no_message', 'That thread no longer exists.');
      if (root.threadRootId) root = entry.messages.find((m) => m.id === root!.threadRootId) ?? root;
    }

    const members = this.membersView(record);
    const resolved = resolveMentions(text, members);
    const now = Date.now();
    const message: Message = {
      id: id('msg'),
      workspaceId: record.workspace.id,
      channelId: entry.channel.id,
      author: actor,
      text,
      ts: now,
      kind: 'user',
      threadRootId: root?.id,
      replyCount: 0,
      replyUsers: [],
      reactions: [],
      mentions: resolved.mentions.filter((a) => a !== actor),
      broadcast: resolved.broadcast,
      refs: input.refs?.length ? input.refs : undefined,
      alsoSentToChannel: root ? Boolean(input.alsoSendToChannel) : undefined,
      viaAgent: input.viaAgent || undefined,
    };
    this.append(entry, message);

    if (root) {
      root.replyCount++;
      root.lastReplyAt = now;
      if (!root.replyUsers.includes(actor)) root.replyUsers.push(actor);
      this.broadcast(
        record,
        { type: 'message.updated', workspaceId: record.workspace.id, message: root },
        this.audience(record, entry),
      );
    }

    this.fanOut(record, entry, message);
    this.save();
    return message;
  }

  private append(entry: ChannelRecord, message: Message): void {
    entry.messages.push(message);
    entry.channel.messageCount++;
    entry.channel.lastMessageAt = message.ts;
    const cap = this.options.maxMessagesPerChannel;
    if (entry.messages.length > cap) entry.messages.splice(0, entry.messages.length - cap);
  }

  /** Deliver a new message and everyone's freshly-computed read state. */
  private fanOut(record: WorkspaceRecord, entry: ChannelRecord, message: Message, clientId?: string): void {
    for (const address of this.audience(record, entry)) {
      this.deliver(address, {
        type: 'message.new',
        workspaceId: record.workspace.id,
        message,
        clientId: address === message.author ? clientId : undefined,
        read: this.readState(entry, address),
      });
    }
  }

  private postSystem(
    record: WorkspaceRecord,
    entry: ChannelRecord,
    actor: AgentAddress,
    event: SystemEvent,
    detail: string,
  ): void {
    const message: Message = {
      id: id('msg'),
      workspaceId: record.workspace.id,
      channelId: entry.channel.id,
      author: actor,
      text: '',
      ts: Date.now(),
      kind: 'system',
      systemEvent: event,
      systemDetail: detail,
      replyCount: 0,
      replyUsers: [],
      reactions: [],
      mentions: [],
    };
    this.append(entry, message);
    this.fanOut(record, entry, message);
  }

  /** A meeting milestone, written into the channel it belongs to. */
  postMeetingEvent(
    workspaceId: WorkspaceId,
    channelId: ChannelId | undefined,
    actor: AgentAddress,
    event: Extract<SystemEvent, 'meeting_scheduled' | 'meeting_started' | 'meeting_ended'>,
    text: string,
    meetingId: string,
  ): void {
    const record = this.workspaces.get(workspaceId);
    if (!record) return;
    const entry =
      (channelId ? record.channels.get(channelId) : undefined) ??
      [...record.channels.values()].find((c) => c.channel.isDefault);
    if (!entry) return;
    const message: Message = {
      id: id('msg'),
      workspaceId,
      channelId: entry.channel.id,
      author: actor,
      text,
      ts: Date.now(),
      kind: 'meeting',
      systemEvent: event,
      meetingId,
      replyCount: 0,
      replyUsers: [],
      reactions: [],
      mentions: [],
    };
    this.append(entry, message);
    this.fanOut(record, entry, message);
    this.save();
  }

  editMessage(actor: AgentAddress, workspaceId: WorkspaceId, messageId: MessageId, text: string): void {
    const { record, entry, message } = this.locateMessage(workspaceId, messageId, actor);
    if (message.author !== actor) throw new HubError('forbidden', 'You can only edit your own messages.');
    if (message.kind !== 'user') throw new HubError('forbidden', 'That message cannot be edited.');
    if (message.deletedAt) throw new HubError('gone', 'That message was deleted.');
    message.text = text.slice(0, 12_000);
    message.editedAt = Date.now();
    const resolved = resolveMentions(message.text, this.membersView(record));
    message.mentions = resolved.mentions.filter((a) => a !== actor);
    message.broadcast = resolved.broadcast;
    this.broadcast(record, { type: 'message.updated', workspaceId, message }, this.audience(record, entry));
    this.save();
  }

  deleteMessage(actor: AgentAddress, workspaceId: WorkspaceId, messageId: MessageId): void {
    const { record, entry, message } = this.locateMessage(workspaceId, messageId, actor);
    if (message.author !== actor) this.requireRole(record, actor, 'admin');
    message.deletedAt = Date.now();
    message.text = '';
    message.refs = undefined;
    message.mentions = [];
    message.broadcast = undefined;
    const pinIdx = entry.channel.pinned.indexOf(messageId);
    if (pinIdx >= 0) {
      entry.channel.pinned.splice(pinIdx, 1);
      this.broadcast(record, { type: 'channel.upserted', workspaceId, channel: entry.channel });
    }
    this.broadcast(record, { type: 'message.updated', workspaceId, message }, this.audience(record, entry));
    this.save();
  }

  react(
    actor: AgentAddress,
    workspaceId: WorkspaceId,
    messageId: MessageId,
    emoji: string,
    on: boolean,
  ): void {
    const { record, entry, message } = this.locateMessage(workspaceId, messageId, actor);
    if (message.deletedAt) return;
    const char = [...emoji.trim()].slice(0, 4).join('');
    if (!char) throw new HubError('bad_request', 'That is not an emoji.');

    let reaction = message.reactions.find((r) => r.emoji === char);
    if (on) {
      if (!reaction) {
        reaction = { emoji: char, by: [] };
        message.reactions.push(reaction);
      }
      if (!reaction.by.includes(actor)) reaction.by.push(actor);
    } else if (reaction) {
      reaction.by = reaction.by.filter((a) => a !== actor);
      if (!reaction.by.length) message.reactions = message.reactions.filter((r) => r.emoji !== char);
    }
    this.broadcast(record, { type: 'message.updated', workspaceId, message }, this.audience(record, entry));
    this.save();
  }

  pin(actor: AgentAddress, workspaceId: WorkspaceId, messageId: MessageId, pinned: boolean): void {
    const { record, entry, message } = this.locateMessage(workspaceId, messageId, actor);
    if (message.deletedAt) return;
    const idx = entry.channel.pinned.indexOf(messageId);
    if (pinned && idx === -1) {
      entry.channel.pinned.push(messageId);
      message.pinnedBy = actor;
      message.pinnedAt = Date.now();
    } else if (!pinned && idx >= 0) {
      entry.channel.pinned.splice(idx, 1);
      message.pinnedBy = undefined;
      message.pinnedAt = undefined;
    } else {
      return;
    }
    const audience = this.audience(record, entry);
    this.broadcast(record, { type: 'message.updated', workspaceId, message }, audience);
    this.broadcast(record, { type: 'channel.upserted', workspaceId, channel: entry.channel }, audience);
    this.save();
  }

  private locateMessage(
    workspaceId: WorkspaceId,
    messageId: MessageId,
    actor: AgentAddress,
  ): { record: WorkspaceRecord; entry: ChannelRecord; message: Message } {
    const record = this.requireMembership(workspaceId, actor);
    for (const entry of record.channels.values()) {
      const message = entry.messages.find((m) => m.id === messageId);
      if (!message) continue;
      if (!this.canSee(entry, actor)) throw new HubError('forbidden', 'You do not have access to that channel.');
      return { record, entry, message };
    }
    throw new HubError('no_message', 'That message no longer exists.');
  }

  history(
    actor: AgentAddress,
    workspaceId: WorkspaceId,
    channelId: ChannelId,
    before?: number,
    limit = HISTORY_PAGE,
  ): ServerMessage {
    const record = this.requireMembership(workspaceId, actor);
    const entry = this.requireVisible(record, channelId, actor);
    const all = this.timeline(entry);
    const cutoff = before ?? Number.POSITIVE_INFINITY;
    const older = all.filter((m) => m.ts < cutoff);
    const page = older.slice(-Math.max(1, Math.min(200, limit)));
    return {
      type: 'history.page',
      workspaceId,
      channelId,
      messages: page,
      reachedStart: page.length === older.length,
    };
  }

  thread(actor: AgentAddress, workspaceId: WorkspaceId, rootId: MessageId): ServerMessage {
    const { entry, message } = this.locateMessage(workspaceId, rootId, actor);
    const replies = entry.messages.filter((m) => m.threadRootId === message.id);
    return {
      type: 'history.page',
      workspaceId,
      channelId: entry.channel.id,
      messages: [message, ...replies],
      reachedStart: true,
      threadRootId: message.id,
    };
  }

  markRead(actor: AgentAddress, workspaceId: WorkspaceId, channelId: ChannelId, ts: number): void {
    const record = this.requireMembership(workspaceId, actor);
    const entry = this.requireVisible(record, channelId, actor);
    const previous = entry.reads[actor] ?? 0;
    entry.reads[actor] = Math.max(previous, Math.min(ts, Date.now()));
    this.deliver(actor, { type: 'read.updated', workspaceId, read: this.readState(entry, actor) });
    this.save();
  }

  typing(actor: AgentAddress, workspaceId: WorkspaceId, channelId: ChannelId): void {
    const record = this.requireMembership(workspaceId, actor);
    const entry = this.requireVisible(record, channelId, actor);
    for (const address of this.audience(record, entry)) {
      if (address === actor) continue;
      this.deliver(address, { type: 'typing.update', workspaceId, channelId, address: actor });
    }
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  search(
    actor: AgentAddress,
    workspaceId: WorkspaceId,
    query: string,
    options: { limit?: number; channelId?: ChannelId; from?: AgentAddress } = {},
  ): ServerMessage {
    const record = this.requireMembership(workspaceId, actor);
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
    const limit = Math.max(1, Math.min(100, options.limit ?? 40));
    const hits: SearchHit[] = [];

    if (terms.length) {
      for (const entry of record.channels.values()) {
        if (!this.canSee(entry, actor)) continue;
        if (options.channelId && entry.channel.id !== options.channelId) continue;
        for (const message of entry.messages) {
          if (message.deletedAt || message.kind !== 'user') continue;
          if (options.from && message.author !== options.from) continue;
          const haystack = message.text.toLowerCase();
          let score = 0;
          for (const term of terms) {
            if (!haystack.includes(term)) {
              score = 0;
              break;
            }
            score += term.length;
            // An exact word match beats an incidental substring.
            if (new RegExp(`\\b${escapeRegExp(term)}\\b`).test(haystack)) score += 3;
          }
          if (!score) continue;
          // Recent messages win ties.
          score += Math.max(0, 5 - (Date.now() - message.ts) / 86_400_000);
          hits.push({
            message,
            channelName: entry.channel.name || this.dmLabel(record, entry, actor),
            channelKind: entry.channel.kind,
            score,
          });
        }
      }
    }

    hits.sort((a, b) => b.score - a.score || b.message.ts - a.message.ts);
    return {
      type: 'search.results',
      results: {
        workspaceId,
        query,
        hits: hits.slice(0, limit),
        truncated: hits.length > limit,
      },
    };
  }

  private dmLabel(record: WorkspaceRecord, entry: ChannelRecord, viewer: AgentAddress): string {
    const others = entry.channel.members.filter((a) => a !== viewer);
    return others.map((a) => this.memberView(record, a)?.displayName ?? a).join(', ');
  }

  // -------------------------------------------------------------------------
  // Meeting support
  // -------------------------------------------------------------------------

  /** The workspace a meeting request belongs to, and whether everyone is in it. */
  resolveMeetingWorkspace(organizer: AgentAddress, requested?: WorkspaceId): WorkspaceId {
    if (requested && this.workspaces.get(requested)?.members.has(organizer)) return requested;
    const mine = this.workspaceIdsFor(organizer);
    return mine[0] ?? this.defaultWorkspaceId;
  }

  sharesWorkspace(workspaceId: WorkspaceId, addresses: AgentAddress[]): AgentAddress[] {
    const record = this.workspaces.get(workspaceId);
    if (!record) return addresses;
    return addresses.filter((a) => !record.members.has(a));
  }

  workspaceName(workspaceId: WorkspaceId): string {
    return this.workspaces.get(workspaceId)?.workspace.name ?? 'this workspace';
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private save(): void {
    if (!this.options.statePath) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 400);
    this.saveTimer.unref?.();
  }

  /** Write state to disk now. Called on shutdown and by tests. */
  flush(): void {
    const file = this.options.statePath;
    if (!file) return;
    try {
      const payload = {
        version: 2,
        defaultWorkspaceId: this.defaultWorkspaceId,
        workspaces: [...this.workspaces.values()].map((r) => ({
          workspace: r.workspace,
          members: [...r.members.values()],
          invites: [...r.invites.values()],
          channels: [...r.channels.values()].map((c) => ({
            channel: c.channel,
            messages: c.messages,
            reads: c.reads,
          })),
        })),
        identities: [...this.identities.entries()].map(([address, i]) => ({
          address,
          profile: i.profile,
          status: i.status,
          lastSeen: i.lastSeen,
        })),
      };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      this.options.log(`could not persist workspaces: ${(err as Error).message}`);
    }
  }

  private restore(): void {
    const file = this.options.statePath;
    if (!file) return;
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    try {
      const data = JSON.parse(raw) as {
        defaultWorkspaceId?: string;
        workspaces?: {
          workspace: Workspace;
          members: MemberRecord[];
          invites: Invite[];
          channels: { channel: Channel; messages: Message[]; reads: Record<string, number> }[];
        }[];
        identities?: { address: string; profile: PublicProfile; status?: UserStatus; lastSeen?: number }[];
      };
      for (const entry of data.workspaces ?? []) {
        const record: WorkspaceRecord = {
          workspace: { ...entry.workspace, discoverable: entry.workspace.discoverable ?? true },
          members: new Map(entry.members.map((m) => [m.address, m])),
          channels: new Map(
            entry.channels.map((c) => [
              c.channel.id,
              { channel: c.channel, messages: c.messages ?? [], reads: c.reads ?? {} },
            ]),
          ),
          invites: new Map((entry.invites ?? []).map((i) => [i.code, i])),
        };
        this.workspaces.set(record.workspace.id, record);
      }
      for (const entry of data.identities ?? []) {
        this.identities.set(entry.address, {
          profile: entry.profile,
          presence: 'offline',
          status: entry.status ?? emptyStatus(),
          lastSeen: entry.lastSeen ?? 0,
          online: false,
        });
      }
      if (data.defaultWorkspaceId && this.workspaces.has(data.defaultWorkspaceId)) {
        this.defaultWorkspaceId = data.defaultWorkspaceId;
      }
      const count = this.workspaces.size;
      if (count) this.options.log(`restored ${count} workspace(s) from ${file}`);
    } catch (err) {
      this.options.log(`ignoring unreadable workspace state: ${(err as Error).message}`);
    }
  }

  /** Test seam: how many workspaces this hub holds. */
  get size(): number {
    return this.workspaces.size;
  }

  /** Test seam: read a workspace's channel list without going through the wire. */
  channelsOf(workspaceId: WorkspaceId): Channel[] {
    return [...(this.workspaces.get(workspaceId)?.channels.values() ?? [])].map((c) => c.channel);
  }

  /** Test seam: read a channel's messages. */
  messagesOf(workspaceId: WorkspaceId, channelId: ChannelId): Message[] {
    return [...(this.workspaces.get(workspaceId)?.channels.get(channelId)?.messages ?? [])];
  }

  /** Test seam: the id newcomers land in. */
  get homeWorkspaceId(): WorkspaceId {
    return this.defaultWorkspaceId;
  }

  shutdown(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.flush();
  }
}

function inviteCode(): string {
  // Readable enough to say out loud; long enough not to guess.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 9) out += '-';
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

