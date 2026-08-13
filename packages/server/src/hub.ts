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
  type AuditAction,
  type AuditEntry,
  type Capability,
  type Channel,
  type ChannelId,
  type ChannelReadState,
  type Invite,
  type JoinRequest,
  type Message,
  type MessageId,
  type Presence,
  type PublicProfile,
  type SearchHit,
  type ServerMessage,
  type SystemEvent,
  type TranscriptEntry,
  type UserStatus,
  type Workspace,
  type WorkspaceId,
  type WorkspaceMember,
  type WorkspacePermissions,
  type WorkspaceRole,
  AUDIT_LIMIT,
  atLeast,
  can,
  clampCapability,
  defaultPermissions,
  dmKey,
  emptyStatus,
  id,
  inviteIsUsable,
  resolveMentions,
  slugify,
  SNAPSHOT_PAGE,
  validateChannelName,
  validateIconImage,
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
  deactivatedAt?: number;
  deactivatedBy?: AgentAddress;
  /** A guest confined to these channels; empty means the whole workspace. */
  guestChannels?: ChannelId[];
  invitedBy?: AgentAddress;
  /** Per-workspace overrides; absent means "use the person's own profile". */
  displayName?: string;
  title?: string;
  /** An uploaded square image, as a data URI; absent means "draw initials". */
  avatar?: string;
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
  joinRequests: Map<string, JoinRequest>;
  /** Newest last, capped at AUDIT_LIMIT. */
  audit: AuditEntry[];
}

interface Identity {
  profile: PublicProfile;
  /** Set once an account has been verified for this address. */
  email?: string;
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
      relayName: options.relayName ?? 'Stead relay',
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
    // Somebody whose only membership was switched off must not be silently
    // readmitted to the home workspace on their next connection.
    const deactivatedSomewhere = [...this.workspaces.values()].some(
      (r) => r.members.get(profile.address)?.deactivated,
    );
    if (!mine.length && !deactivatedSomewhere) {
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

  /**
   * The workspaces this person can actually open. A deactivated membership is
   * still a membership — the row stays in everybody else's member list — but it
   * is not a place they can go.
   */
  workspaceIdsFor(address: AgentAddress): WorkspaceId[] {
    const out: WorkspaceId[] = [];
    for (const record of this.workspaces.values()) {
      const member = record.members.get(address);
      if (member && !member.deactivated) out.push(record.workspace.id);
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

  /**
   * Check a configured capability rather than a fixed role. Everything an
   * administrator can loosen or tighten goes through here, so the settings
   * screen and the door agree by construction.
   */
  private requireCapability(
    record: WorkspaceRecord,
    address: AgentAddress,
    capability: Capability,
  ): void {
    if (can(this.roleOf(record, address), capability, record.workspace.permissions)) return;
    const floor = clampCapability(capability, record.workspace.permissions[capability]);
    throw new HubError(
      'forbidden',
      `In ${record.workspace.name} that is limited to ${floor === 'member' ? 'members' : `${floor}s`} and above.`,
    );
  }

  /** A deactivated account can be seen but can do nothing. */
  private requireActive(record: WorkspaceRecord, address: AgentAddress): void {
    if (record.members.get(address)?.deactivated) {
      throw new HubError(
        'deactivated',
        `Your account in ${record.workspace.name} has been deactivated. An admin can switch it back on.`,
      );
    }
  }

  private isPrimaryOwner(record: WorkspaceRecord, address: AgentAddress): boolean {
    return record.workspace.primaryOwner === address;
  }

  /**
   * Whether `actor` may act on `target`. Nobody outranks the primary owner, and
   * an admin cannot reach an owner — otherwise the first thing a compromised
   * admin account does is remove everybody above it.
   */
  private requireOutranks(record: WorkspaceRecord, actor: AgentAddress, target: AgentAddress): void {
    if (this.isPrimaryOwner(record, target)) {
      throw new HubError('forbidden', 'The primary owner can only be changed by handing the workspace over.');
    }
    const actorRole = this.roleOf(record, actor);
    const targetRole = this.roleOf(record, target);
    if (!targetRole) throw new HubError('not_a_member', 'They are not in this workspace.');
    if (actorRole === 'owner') return;
    if (atLeast(targetRole, 'owner')) {
      throw new HubError('forbidden', 'Only an owner can act on another owner.');
    }
  }

  /** Resolve the one-or-many spelling both bulk operations accept. */
  private targets(input: { address?: AgentAddress; addresses?: AgentAddress[] }): AgentAddress[] {
    const all = [...(input.addresses ?? []), ...(input.address ? [input.address] : [])];
    const unique = [...new Set(all.filter(Boolean))];
    if (!unique.length) throw new HubError('bad_request', 'Name at least one person.');
    return unique;
  }

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  private audit(
    record: WorkspaceRecord,
    actor: AgentAddress,
    action: AuditAction,
    target?: string,
    detail?: string,
  ): void {
    record.audit.push({
      id: id('aud'),
      workspaceId: record.workspace.id,
      at: Date.now(),
      actor,
      action,
      target,
      detail,
    });
    if (record.audit.length > AUDIT_LIMIT) {
      record.audit.splice(0, record.audit.length - AUDIT_LIMIT);
    }
  }

  auditLog(actor: AgentAddress, workspaceId: WorkspaceId, limit = 200): ServerMessage {
    const record = this.requireMembership(workspaceId, actor);
    this.requireRole(record, actor, 'admin');
    const entries = record.audit.slice(-Math.max(1, Math.min(limit, AUDIT_LIMIT))).reverse();
    return { type: 'workspace.audit.result', workspaceId, entries };
  }

  private requireChannel(record: WorkspaceRecord, channelId: ChannelId): ChannelRecord {
    const channel = record.channels.get(channelId);
    if (!channel) throw new HubError('no_channel', 'That channel does not exist.');
    return channel;
  }

  /**
   * Public channels are visible to the whole workspace; the rest are by
   * membership. A confined guest is the exception in both directions: they see
   * the channels they were let into and nothing else, not even a public one.
   */
  private canSee(record: WorkspaceRecord, entry: ChannelRecord, address: AgentAddress): boolean {
    const confined = this.confinedTo(record, address);
    if (confined) {
      return confined.includes(entry.channel.id) || entry.channel.members.includes(address);
    }
    if (entry.channel.kind === 'public') return true;
    return entry.channel.members.includes(address);
  }

  /** The channel list a guest is pinned to, or null if they are not pinned. */
  private confinedTo(record: WorkspaceRecord, address: AgentAddress): ChannelId[] | null {
    const member = record.members.get(address);
    if (!member || member.role !== 'guest') return null;
    const channels = member.guestChannels ?? [];
    return channels.length ? channels : null;
  }

  private requireVisible(
    record: WorkspaceRecord,
    channelId: ChannelId,
    address: AgentAddress,
  ): ChannelRecord {
    const entry = this.requireChannel(record, channelId);
    if (!this.canSee(record, entry, address)) throw new HubError('forbidden', 'You do not have access to that channel.');
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
      avatar: entry.avatar,
      title: entry.title ?? profile?.title ?? '',
      bio: profile?.bio ?? '',
      timezone: profile?.timezone ?? 'UTC',
      focusAreas: profile?.focusAreas ?? [],
      role: entry.role,
      joinedAt: entry.joinedAt,
      deactivated: entry.deactivated,
      deactivatedAt: entry.deactivatedAt,
      deactivatedBy: entry.deactivatedBy,
      guestChannels: entry.role === 'guest' ? [...(entry.guestChannels ?? [])] : [],
      primaryOwner: record.workspace.primaryOwner === address,
      invitedBy: entry.invitedBy,
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
      if (!this.canSee(record, entry, address)) continue;
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
    const eligible =
      entry.channel.kind === 'public'
        ? [...record.members.keys()]
        : entry.channel.members.filter((a) => record.members.has(a));
    // A confined guest must not be told about a public channel they cannot see,
    // and a deactivated account should stop receiving traffic entirely.
    return eligible.filter((address) => {
      if (record.members.get(address)?.deactivated) return false;
      return this.canSee(record, entry, address);
    });
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
    // Write it out now rather than waiting for the first mutation. Until
    // somebody joins or posts, nothing else calls save(), so a relay nobody has
    // used yet reinvents this workspace — with a new id — on every restart, and
    // anything that remembered the old id is pointing at a workspace that no
    // longer exists.
    this.save();
  }

  private newWorkspace(input: {
    name: string;
    slug: string;
    createdBy: AgentAddress;
    description?: string;
    icon?: string;
    iconImage?: string;
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
      iconImage: input.iconImage,
      color: input.color || WORKSPACE_COLORS[seed % WORKSPACE_COLORS.length]!,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      // Whoever asked for the workspace holds it until they hand it on. The
      // relay's own home workspace has no person behind it, so its first member
      // takes the seat on the way in.
      primaryOwner: input.createdBy === 'relay' ? '' : input.createdBy,
      permissions: defaultPermissions(),
      discoverable: input.discoverable ?? true,
      acceptsJoinRequests: true,
      emailDomains: [],
      domainJoin: 'open',
      // Everything created with the workspace is a default: a new member should
      // land somewhere with people in it, not in an empty #general.
      defaultChannels: [],
    };
    const record: WorkspaceRecord = {
      workspace,
      members: new Map(),
      channels: new Map(),
      invites: new Map(),
      joinRequests: new Map(),
      audit: [],
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
      iconImage?: string;
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

    if (input.iconImage) {
      const check = validateIconImage(input.iconImage);
      if (!check.ok) throw new HubError('bad_icon', check.error);
    }

    const record = this.newWorkspace({
      name,
      slug: input.slug?.trim() || name,
      createdBy: actor,
      description: input.description?.trim().slice(0, 280),
      icon: input.icon,
      iconImage: input.iconImage || undefined,
      color: input.color,
      discoverable: input.discoverable,
      channels: extra,
    });
    this.addMember(record, actor, 'owner');
    this.audit(record, actor, 'workspace_created', record.workspace.name);
    this.options.log(`${actor} created workspace "${record.workspace.name}"`);
    this.save();
    return record.workspace.id;
  }

  updateWorkspace(actor: AgentAddress, workspaceId: WorkspaceId, patch: Partial<Workspace>): void {
    const record = this.requireMembership(workspaceId, actor);
    this.requireActive(record, actor);
    this.requireCapability(record, actor, 'manage_workspace');
    const w = record.workspace;
    const changed: string[] = [];
    if (typeof patch.name === 'string' && patch.name.trim() && patch.name.trim() !== w.name) {
      w.name = patch.name.trim().slice(0, 60);
      changed.push('name');
    }
    if (typeof patch.slug === 'string' && patch.slug.trim()) {
      const wanted = slugify(patch.slug);
      if (wanted && wanted !== w.slug) {
        const taken = [...this.workspaces.values()].some(
          (r) => r !== record && r.workspace.slug === wanted,
        );
        if (taken) throw new HubError('slug_taken', `Another workspace already uses "${wanted}".`);
        w.slug = wanted;
        changed.push('address');
      }
    }
    if (typeof patch.description === 'string') w.description = patch.description.slice(0, 280);
    if (typeof patch.icon === 'string' && patch.icon) w.icon = [...patch.icon][0] ?? w.icon;
    if (typeof patch.iconImage === 'string') {
      // An empty string clears the upload and falls back to the emoji. Anything
      // else is checked here rather than trusted: this record is replicated to
      // every member, so an unbounded image is everybody's bandwidth bill.
      const check = validateIconImage(patch.iconImage);
      if (!check.ok) throw new HubError('bad_icon', check.error);
      w.iconImage = patch.iconImage || undefined;
      changed.push(patch.iconImage ? 'icon image' : 'icon image removed');
    }
    if (typeof patch.color === 'string' && /^#[0-9a-f]{6}$/i.test(patch.color)) w.color = patch.color;
    if (typeof patch.discoverable === 'boolean' && patch.discoverable !== w.discoverable) {
      w.discoverable = patch.discoverable;
      changed.push(patch.discoverable ? 'discoverable' : 'invitation-only');
    }
    if (typeof patch.acceptsJoinRequests === 'boolean') {
      w.acceptsJoinRequests = patch.acceptsJoinRequests;
    }
    if (patch.domainJoin === 'open' || patch.domainJoin === 'request' || patch.domainJoin === 'off') {
      w.domainJoin = patch.domainJoin;
      changed.push(`domain joining ${patch.domainJoin}`);
    }
    if (Array.isArray(patch.emailDomains)) {
      // A domain can only be claimed by somebody who has proved they read mail
      // at it. Anything else in the list is dropped rather than refused, so an
      // admin editing the other fields is not blocked by a stale entry.
      const actorEmail = (this.identities.get(actor)?.email ?? '').toLowerCase();
      const kept: string[] = [];
      for (const raw of patch.emailDomains) {
        const domain = String(raw).trim().toLowerCase();
        if (!domain || domain.includes('@')) continue;
        // Already claimed stays claimed; only additions need proof.
        if (w.emailDomains.includes(domain) || actorEmail.endsWith(`@${domain}`)) {
          if (!kept.includes(domain)) kept.push(domain);
        }
      }
      if (kept.join(',') !== w.emailDomains.join(',')) {
        w.emailDomains = kept;
        changed.push(`email domains (${kept.length})`);
      }
    }
    if (Array.isArray(patch.defaultChannels)) {
      // Only names that exist, so a new member is never promised a channel the
      // workspace does not have.
      const known = new Set(
        [...record.channels.values()]
          .filter((c) => c.channel.kind === 'public' && !c.channel.archived)
          .map((c) => c.channel.name),
      );
      const names = [...new Set(patch.defaultChannels.filter((n) => known.has(n)))];
      const general = [...record.channels.values()].find((c) => c.channel.isDefault);
      if (general && !names.includes(general.channel.name)) names.unshift(general.channel.name);
      w.defaultChannels = names;
      changed.push('default channels');
    }
    w.updatedAt = Date.now();
    this.audit(record, actor, 'workspace_updated', w.name, changed.join(', ') || undefined);
    this.broadcast(record, { type: 'workspace.updated', workspace: w });
    this.save();
  }

  /**
   * Retune who can do what. Each floor is clamped on the way in, so a hostile
   * or simply confused client cannot hand `manage_members` to guests.
   */
  setPermissions(
    actor: AgentAddress,
    workspaceId: WorkspaceId,
    patch: Partial<WorkspacePermissions>,
  ): void {
    const record = this.requireMembership(workspaceId, actor);
    this.requireActive(record, actor);
    this.requireRole(record, actor, 'admin');
    const permissions = record.workspace.permissions;
    const changed: string[] = [];
    for (const [key, value] of Object.entries(patch) as [Capability, WorkspaceRole][]) {
      if (!(key in permissions)) continue;
      if (!['owner', 'admin', 'member', 'guest'].includes(value)) continue;
      const next = clampCapability(key, value);
      if (permissions[key] === next) continue;
      permissions[key] = next;
      changed.push(`${key}=${next}`);
    }
    if (!changed.length) return;
    record.workspace.updatedAt = Date.now();
    this.audit(record, actor, 'permissions_changed', record.workspace.name, changed.join(', '));
    this.broadcast(record, { type: 'workspace.updated', workspace: record.workspace });
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
    invitedBy?: AgentAddress,
  ): void {
    if (record.members.has(address)) return;
    record.members.set(address, {
      address,
      role,
      joinedAt: Date.now(),
      deactivated: false,
      // A guest let in through a specific channel stays in that channel. Any
      // other role gets the usual defaults.
      guestChannels: role === 'guest' ? [...channels] : undefined,
      invitedBy,
    });
    // The home workspace has no creator to be its primary owner; the first
    // person through the door takes the seat.
    if (!record.workspace.primaryOwner && role === 'owner') {
      record.workspace.primaryOwner = address;
    }

    // Drop them into the default channels, plus anything the invite named. A
    // confined guest is the exception: they get exactly what they were given.
    const wanted = new Set(channels);
    if (role !== 'guest' || channels.length === 0) {
      for (const entry of record.channels.values()) {
        if (entry.channel.kind === 'public' && entry.channel.isDefault) wanted.add(entry.channel.id);
        if (record.workspace.defaultChannels.includes(entry.channel.name)) wanted.add(entry.channel.id);
      }
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
    // A confined guest is not announced to the whole workspace; they were let
    // into one room, not into the company.
    const general = [...record.channels.values()].find((c) => c.channel.isDefault);
    if (general && !this.confinedTo(record, address)) {
      this.postSystem(record, general, address, 'member_joined', '');
    }
    this.audit(record, invitedBy ?? address, 'member_joined', address, role);
  }

  joinWorkspace(actor: AgentAddress, input: { code?: string; slug?: string }): WorkspaceId {
    if (input.code) {
      const code = input.code.trim();
      for (const record of this.workspaces.values()) {
        const invite = record.invites.get(code);
        if (!invite) continue;
        const problem = inviteIsUsable(invite, actor);
        if (problem) throw new HubError('bad_invite', problem);
        if (record.members.has(actor)) {
          this.requireActive(record, actor);
          return record.workspace.id;
        }
        invite.uses++;
        this.addMember(record, actor, invite.role, invite.channels, invite.createdBy);
        this.options.log(`${actor} joined "${record.workspace.name}" by invitation`);
        this.save();
        return record.workspace.id;
      }
      throw new HubError('bad_invite', 'That invitation code is not valid on this relay.');
    }

    const record = this.bySlug(input.slug ?? '');
    if (record.members.has(actor)) {
      this.requireActive(record, actor);
      return record.workspace.id;
    }
    if (!record.workspace.discoverable) {
      throw new HubError(
        'forbidden',
        record.workspace.acceptsJoinRequests
          ? `${record.workspace.name} is invitation-only. You can ask an admin to let you in.`
          : `${record.workspace.name} is invitation-only.`,
      );
    }
    this.addMember(record, actor, 'member');
    this.options.log(`${actor} joined "${record.workspace.name}"`);
    this.save();
    return record.workspace.id;
  }

  // -------------------------------------------------------------------------
  // Accounts and email domains
  // -------------------------------------------------------------------------

  /**
   * Told by the auth layer that this address belongs to a verified person,
   * before any socket has opened as them. It seeds the identity so a workspace
   * created during sign-up already has a name against it, and so the relay can
   * later check that whoever connects as this address really is them.
   */
  registerAccount(address: AgentAddress, displayName: string, email: string): void {
    const existing = this.identities.get(address);
    this.identities.set(address, {
      profile: existing?.profile ?? {
        address,
        displayName,
        title: '',
        role: 'ic',
        team: '',
        timezone: 'UTC',
        bio: '',
        focusAreas: [],
        online: false,
        lastSeen: Date.now(),
      },
      presence: existing?.presence ?? 'offline',
      status: existing?.status ?? emptyStatus(),
      lastSeen: existing?.lastSeen ?? Date.now(),
      online: existing?.online ?? false,
      email,
    });
    if (existing?.profile && !existing.profile.displayName) {
      existing.profile.displayName = displayName;
    }
    this.save();
  }

  /**
   * Claim an email domain for a workspace. Only somebody who has proved they
   * read mail at that domain can — otherwise claiming `@bigco.com` would be a
   * way to intercept a whole company's sign-ups.
   */
  claimEmailDomain(actor: AgentAddress, workspaceId: WorkspaceId, domain: string): void {
    const record = this.requireMembership(workspaceId, actor);
    this.requireCapability(record, actor, 'manage_workspace');
    const clean = domain.trim().toLowerCase();
    if (!clean || clean.includes('@')) throw new HubError('bad_domain', 'That is not a domain.');
    const actorEmail = this.identities.get(actor)?.email ?? '';
    if (!actorEmail.toLowerCase().endsWith(`@${clean}`)) {
      throw new HubError(
        'forbidden',
        `Only somebody with an @${clean} address can claim it for a workspace.`,
      );
    }
    if (!record.workspace.emailDomains.includes(clean)) {
      record.workspace.emailDomains.push(clean);
      record.workspace.updatedAt = Date.now();
      this.audit(record, actor, 'workspace_updated', record.workspace.name, `claimed @${clean}`);
      this.broadcast(record, { type: 'workspace.updated', workspace: record.workspace });
      this.save();
    }
  }

  releaseEmailDomain(actor: AgentAddress, workspaceId: WorkspaceId, domain: string): void {
    const record = this.requireMembership(workspaceId, actor);
    this.requireCapability(record, actor, 'manage_workspace');
    const clean = domain.trim().toLowerCase();
    const idx = record.workspace.emailDomains.indexOf(clean);
    if (idx < 0) return;
    record.workspace.emailDomains.splice(idx, 1);
    record.workspace.updatedAt = Date.now();
    this.audit(record, actor, 'workspace_updated', record.workspace.name, `released @${clean}`);
    this.broadcast(record, { type: 'workspace.updated', workspace: record.workspace });
    this.save();
  }

  /**
   * What sign-up shows after the code is typed: the workspaces this person is
   * already welcome in, either because they are in them or because their email
   * domain is. This is the step that turns "here is an empty app" into "your
   * team is already here".
   */
  workspacesForEmail(
    address: AgentAddress,
    domain: string,
  ): {
    id: WorkspaceId;
    slug: string;
    name: string;
    description: string;
    icon: string;
    color: string;
    memberCount: number;
    joined: boolean;
    how: 'open' | 'request';
  }[] {
    const clean = domain.trim().toLowerCase();
    const out = [];
    for (const record of this.workspaces.values()) {
      const member = record.members.get(address);
      const joined = Boolean(member && !member.deactivated);
      const claimed = clean && record.workspace.emailDomains.includes(clean);
      const domainOpen = claimed && record.workspace.domainJoin !== 'off';
      if (!joined && !domainOpen && !record.workspace.discoverable) continue;
      out.push({
        id: record.workspace.id,
        slug: record.workspace.slug,
        name: record.workspace.name,
        description: record.workspace.description,
        icon: record.workspace.icon,
        color: record.workspace.color,
        memberCount: [...record.members.values()].filter((m) => !m.deactivated).length,
        joined,
        how: (domainOpen && record.workspace.domainJoin === 'request'
          ? 'request'
          : 'open') as 'open' | 'request',
      });
    }
    // Where your colleagues already are comes before anything merely public.
    return out.sort(
      (a, b) => Number(b.joined) - Number(a.joined) || b.memberCount - a.memberCount,
    );
  }

  /** Walk in on the strength of a verified email domain. */
  joinByDomain(actor: AgentAddress, workspaceId: WorkspaceId, domain: string): WorkspaceId {
    const record = this.require(workspaceId);
    const clean = domain.trim().toLowerCase();
    const existing = record.members.get(actor);
    if (existing) {
      if (existing.deactivated) {
        throw new HubError('deactivated', 'That account has been deactivated in this workspace.');
      }
      return workspaceId;
    }
    const claimed = clean && record.workspace.emailDomains.includes(clean);
    if (!claimed || record.workspace.domainJoin !== 'open') {
      if (!record.workspace.discoverable) {
        throw new HubError('forbidden', `${record.workspace.name} is invitation-only.`);
      }
    }
    this.addMember(record, actor, 'member');
    this.options.log(`${actor} joined "${record.workspace.name}" by email domain`);
    this.save();
    return workspaceId;
  }

  /** Invitations addressed to one email, across every workspace on the relay. */
  invitationsForEmail(email: string): Invite[] {
    const key = email.trim().toLowerCase();
    const now = Date.now();
    const out: Invite[] = [];
    for (const record of this.workspaces.values()) {
      for (const invite of record.invites.values()) {
        if (invite.invitedEmail?.toLowerCase() !== key) continue;
        if (invite.revoked) continue;
        if (invite.expiresAt && invite.expiresAt < now) continue;
        if (invite.maxUses && invite.uses >= invite.maxUses) continue;
        out.push(invite);
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** The safe-to-show summary of one workspace, for the sign-up screens. */
  publicView(workspaceId: WorkspaceId): {
    id: WorkspaceId;
    slug: string;
    name: string;
    icon: string;
    color: string;
    memberCount: number;
  } {
    const record = this.require(workspaceId);
    return {
      id: record.workspace.id,
      slug: record.workspace.slug,
      name: record.workspace.name,
      icon: record.workspace.icon,
      color: record.workspace.color,
      memberCount: record.members.size,
    };
  }

  private bySlug(raw: string): WorkspaceRecord {
    const slug = raw.trim().toLowerCase().replace(/^#/, '');
    const record = [...this.workspaces.values()].find(
      (r) => r.workspace.slug === slug || r.workspace.id === slug,
    );
    if (!record) throw new HubError('no_workspace', `No workspace called "${slug}" on this relay.`);
    return record;
  }

  // -------------------------------------------------------------------------
  // Join requests
  // -------------------------------------------------------------------------

  /**
   * Ask to be let into a workspace you cannot join on your own. The alternative
   * is an invite code passed around out of band, which is how they end up
   * pasted into channels that outlive the person who needed them.
   */
  requestJoin(actor: AgentAddress, slug: string, message = ''): WorkspaceId {
    const record = this.bySlug(slug);
    if (record.members.has(actor)) {
      throw new HubError('already_member', `You are already in ${record.workspace.name}.`);
    }
    if (!record.workspace.acceptsJoinRequests) {
      throw new HubError('forbidden', `${record.workspace.name} is not taking requests.`);
    }
    const existing = [...record.joinRequests.values()].find(
      (r) => r.address === actor && r.state === 'pending',
    );
    if (existing) return record.workspace.id;

    const request: JoinRequest = {
      id: id('req'),
      workspaceId: record.workspace.id,
      address: actor,
      displayName: this.identities.get(actor)?.profile.displayName ?? actor.split('@')[0]!,
      message: message.trim().slice(0, 280),
      createdAt: Date.now(),
      state: 'pending',
    };
    record.joinRequests.set(request.id, request);
    this.audit(record, actor, 'join_requested', actor, request.message || undefined);
    for (const [address, member] of record.members) {
      if (!atLeast(member.role, 'admin') || member.deactivated) continue;
      this.deliver(address, {
        type: 'workspace.join_requested',
        workspaceId: record.workspace.id,
        request,
      });
    }
    this.save();
    return record.workspace.id;
  }

  reviewJoin(
    actor: AgentAddress,
    workspaceId: WorkspaceId,
    requestId: string,
    approve: boolean,
    role: WorkspaceRole = 'member',
  ): void {
    const record = this.requireMembership(workspaceId, actor);
    this.requireActive(record, actor);
    this.requireCapability(record, actor, 'manage_members');
    const request = record.joinRequests.get(requestId);
    if (!request) throw new HubError('no_request', 'That request no longer exists.');
    if (request.state !== 'pending') {
      throw new HubError('already_decided', 'Somebody has already answered that one.');
    }
    if (role === 'owner') this.requireRole(record, actor, 'owner');

    request.state = approve ? 'approved' : 'denied';
    request.decidedBy = actor;
    request.decidedAt = Date.now();
    if (approve) {
      request.role = role;
      this.addMember(record, request.address, role, [], actor);
    }
    this.audit(record, actor, approve ? 'join_approved' : 'join_denied', request.address);
    this.deliver(request.address, {
      type: 'workspace.join_decided',
      workspaceId,
      workspaceName: record.workspace.name,
      approved: approve,
    });
    if (approve) this.sendSnapshot(request.address, workspaceId);
    this.broadcastJoinRequests(record);
    this.save();
  }

  listJoinRequests(actor: AgentAddress, workspaceId: WorkspaceId): ServerMessage {
    const record = this.requireMembership(workspaceId, actor);
    this.requireCapability(record, actor, 'manage_members');
    return {
      type: 'workspace.join_requests.result',
      workspaceId,
      requests: [...record.joinRequests.values()].sort((a, b) => b.createdAt - a.createdAt),
    };
  }

  private broadcastJoinRequests(record: WorkspaceRecord): void {
    const requests = [...record.joinRequests.values()].sort((a, b) => b.createdAt - a.createdAt);
    for (const [address, member] of record.members) {
      if (!atLeast(member.role, 'admin') || member.deactivated) continue;
      this.deliver(address, {
        type: 'workspace.join_requests.result',
        workspaceId: record.workspace.id,
        requests,
      });
    }
  }

  leaveWorkspace(actor: AgentAddress, workspaceId: WorkspaceId): void {
    const record = this.requireMembership(workspaceId, actor);
    if (this.isPrimaryOwner(record, actor)) {
      const others = [...record.members.values()].filter((m) => m.address !== actor && !m.deactivated);
      if (others.length) {
        throw new HubError(
          'owner_must_transfer',
          'Hand the workspace to somebody else before you leave, or delete it.',
        );
      }
    }
    this.audit(record, actor, 'member_left', actor);
    this.removeMemberInternal(record, actor, `You left ${record.workspace.name}.`);
    this.save();
  }

  removeMember(
    actor: AgentAddress,
    workspaceId: WorkspaceId,
    input: { address?: AgentAddress; addresses?: AgentAddress[] },
  ): void {
    const record = this.requireMembership(workspaceId, actor);
    this.requireActive(record, actor);
    this.requireCapability(record, actor, 'manage_members');
    const addresses = this.targets(input);
    // Check the whole batch before applying any of it: a bulk action that
    // half-succeeds is worse than one that refuses.
    for (const address of addresses) {
      if (address === actor) {
        throw new HubError('bad_request', 'Use "leave workspace" to remove yourself.');
      }
      this.requireOutranks(record, actor, address);
    }
    for (const address of addresses) {
      this.audit(record, actor, 'member_removed', address);
      this.removeMemberInternal(record, address, `You were removed from ${record.workspace.name}.`);
    }
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

  /**
   * Deactivation, not deletion. Slack's default for somebody who leaves the
   * company: the account stops working, everything they wrote stays where it
   * is, and the decision is reversible if they come back.
   */
  setActive(
    actor: AgentAddress,
    workspaceId: WorkspaceId,
    input: { address?: AgentAddress; addresses?: AgentAddress[] },
    active: boolean,
  ): void {
    const record = this.requireMembership(workspaceId, actor);
    this.requireActive(record, actor);
    this.requireCapability(record, actor, 'manage_members');
    const addresses = this.targets(input);
    for (const address of addresses) {
      if (address === actor) {
        throw new HubError('bad_request', 'You cannot deactivate your own account.');
      }
      this.requireOutranks(record, actor, address);
    }
    for (const address of addresses) {
      const target = record.members.get(address)!;
      if (target.deactivated === !active) continue;
      target.deactivated = !active;
      target.deactivatedAt = active ? undefined : Date.now();
      target.deactivatedBy = active ? undefined : actor;
      this.audit(record, actor, active ? 'member_reactivated' : 'member_deactivated', address);
      this.broadcast(record, {
        type: 'workspace.member',
        workspaceId,
        member: this.memberView(record, address)!,
      });
      if (!active) {
        // Tell their client to close the workspace; the row stays for everybody
        // else, greyed out.
        this.deliver(address, {
          type: 'workspace.removed',
          workspaceId,
          reason: `Your account in ${record.workspace.name} was deactivated.`,
        });
      } else {
        this.sendSnapshot(address, workspaceId);
      }
    }
    this.save();
  }

  setRole(
    actor: AgentAddress,
    workspaceId: WorkspaceId,
    input: { address?: AgentAddress; addresses?: AgentAddress[] },
    role: WorkspaceRole,
    guestChannels?: ChannelId[],
  ): void {
    const record = this.requireMembership(workspaceId, actor);
    this.requireActive(record, actor);
    this.requireCapability(record, actor, 'manage_members');
    const addresses = this.targets(input);
    const actorRole = this.roleOf(record, actor)!;

    for (const address of addresses) {
      const target = record.members.get(address);
      if (!target) throw new HubError('not_a_member', `${address} is not in this workspace.`);
      if (role === 'owner' && actorRole !== 'owner') {
        throw new HubError('forbidden', 'Only an owner can make somebody else an owner.');
      }
      // Stepping down from your own owner seat is allowed; reaching across at
      // somebody else's is not.
      if (address !== actor) this.requireOutranks(record, actor, address);
      if (this.isPrimaryOwner(record, address) && role !== 'owner') {
        throw new HubError(
          'forbidden',
          'The primary owner keeps the workspace until they hand it to somebody else.',
        );
      }
      if (target.role === 'owner' && role !== 'owner') {
        const owners = [...record.members.values()].filter((m) => m.role === 'owner' && !m.deactivated);
        if (owners.length <= 1) {
          throw new HubError('forbidden', 'A workspace always needs at least one owner.');
        }
      }
    }

    const scoped = (guestChannels ?? []).filter((c) => record.channels.has(c));
    for (const address of addresses) {
      const target = record.members.get(address)!;
      const before = target.role;
      target.role = role;
      target.guestChannels = role === 'guest' ? scoped : undefined;

      // A guest being confined loses everything outside their list; a guest
      // being promoted keeps what they had and gains the defaults.
      if (role === 'guest' && scoped.length) {
        for (const entry of record.channels.values()) {
          const idx = entry.channel.members.indexOf(address);
          if (scoped.includes(entry.channel.id)) {
            if (idx < 0) entry.channel.members.push(address);
          } else if (idx >= 0) {
            entry.channel.members.splice(idx, 1);
          }
        }
        this.audit(record, actor, 'guest_channels_changed', address, `${scoped.length} channel(s)`);
      }

      if (before !== role) this.audit(record, actor, 'role_changed', address, `${before} → ${role}`);
      this.broadcast(record, {
        type: 'workspace.member',
        workspaceId,
        member: this.memberView(record, address)!,
      });
    }
    // Channel membership moved under their feet, so their picture of the
    // workspace has to be redrawn from scratch.
    for (const address of addresses) {
      if (record.members.get(address)?.deactivated) continue;
      this.sendSnapshot(address, workspaceId);
    }
    this.save();
  }

  /**
   * Hand the workspace over. Only the person holding it can, and the seat is
   * never empty for an instant: the new owner is set before the old one drops
   * to a plain owner.
   */
  transferOwnership(actor: AgentAddress, workspaceId: WorkspaceId, address: AgentAddress): void {
    const record = this.requireMembership(workspaceId, actor);
    this.requireActive(record, actor);
    if (!this.isPrimaryOwner(record, actor)) {
      throw new HubError('forbidden', 'Only the primary owner can hand the workspace over.');
    }
    if (address === actor) throw new HubError('bad_request', 'You already hold this workspace.');
    const target = record.members.get(address);
    if (!target) throw new HubError('not_a_member', 'They are not in this workspace.');
    if (target.deactivated) {
      throw new HubError('bad_request', 'Reactivate their account before handing it over.');
    }

    record.workspace.primaryOwner = address;
    record.workspace.updatedAt = Date.now();
    target.role = 'owner';
    // The outgoing owner stays an owner rather than being demoted out of the
    // room they built.
    record.members.get(actor)!.role = 'owner';

    this.audit(record, actor, 'ownership_transferred', address);
    this.broadcast(record, { type: 'workspace.updated', workspace: record.workspace });
    for (const who of [actor, address]) {
      this.broadcast(record, {
        type: 'workspace.member',
        workspaceId,
        member: this.memberView(record, who)!,
      });
    }
    this.save();
  }

  setWorkspaceProfile(
    actor: AgentAddress,
    workspaceId: WorkspaceId,
    patch: { address?: AgentAddress; displayName?: string; title?: string; avatar?: string },
  ): void {
    const record = this.requireMembership(workspaceId, actor);
    this.requireActive(record, actor);
    const subject = patch.address ?? actor;
    if (subject !== actor) {
      this.requireCapability(record, actor, 'manage_members');
      this.requireOutranks(record, actor, subject);
    }
    const entry = record.members.get(subject);
    if (!entry) throw new HubError('not_a_member', 'They are not in this workspace.');
    if (patch.displayName !== undefined) {
      const trimmed = patch.displayName.trim().slice(0, 60);
      entry.displayName = trimmed || undefined;
    }
    if (patch.title !== undefined) {
      const trimmed = patch.title.trim().slice(0, 80);
      entry.title = trimmed || undefined;
    }
    if (patch.avatar !== undefined) {
      // Checked here, not trusted from the app: a member record is replicated
      // to everybody in the workspace, so an unbounded image is a bill charged
      // to every one of them.
      const check = validateIconImage(patch.avatar);
      if (!check.ok) throw new HubError('bad_avatar', check.error);
      entry.avatar = patch.avatar || undefined;
    }
    if (subject !== actor) this.audit(record, actor, 'profile_changed_by_admin', subject);
    const member = this.memberView(record, subject)!;
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
      invitedEmail?: string;
      role?: WorkspaceRole;
      expiresInHours?: number;
      maxUses?: number;
      channels?: ChannelId[];
    },
  ): Invite {
    const record = this.requireMembership(workspaceId, actor);
    this.requireActive(record, actor);
    this.requireCapability(record, actor, 'invite');
    const role: WorkspaceRole = input.role === 'guest' || input.role === 'admin' ? input.role : 'member';
    // You can never invite somebody in above yourself.
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
      invitedEmail: input.invitedEmail?.trim().toLowerCase(),
      role,
      revoked: false,
      channels: (input.channels ?? []).filter((c) => record.channels.has(c)),
    };
    record.invites.set(invite.code, invite);
    this.audit(
      record,
      actor,
      'invite_created',
      invite.invitedAddress ?? 'anyone with the code',
      role,
    );
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
    if (invite.createdBy !== actor) this.requireCapability(record, actor, 'manage_invites');
    invite.revoked = true;
    this.audit(record, actor, 'invite_revoked', invite.invitedAddress ?? invite.code);
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
      meetingId?: string;
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
      meetingId: input.meetingId,
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
    this.requireActive(record, actor);
    this.requireCapability(
      record,
      actor,
      input.kind === 'private' ? 'create_private_channel' : 'create_public_channel',
    );
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
    this.audit(record, actor, 'channel_created', `#${name}`, input.kind === 'private' ? 'private' : 'public');
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
    this.requireActive(record, actor);
    this.requireCapability(record, actor, 'rename_channel');
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
    this.requireActive(record, actor);
    if (entry.channel.createdBy !== actor) this.requireCapability(record, actor, 'archive_channel');
    entry.channel.archived = archived;
    this.audit(record, actor, archived ? 'channel_archived' : 'channel_unarchived', `#${entry.channel.name}`);
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
      if (!this.canSee(record, entry, actor)) continue;
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
    this.requireActive(record, actor);
    const entry = this.requireVisible(record, input.channelId, actor);
    if (entry.channel.archived) throw new HubError('archived', 'That channel is archived.');
    // Slack's "restrict #general" setting: the one channel everybody is in is
    // also the one an announcement should not be lost in.
    if (entry.channel.isDefault) {
      this.requireCapability(record, actor, 'post_in_default_channel');
    }

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

    // A deactivated account cannot be mentioned: the point of switching
    // somebody off is that work stops being routed to them.
    const members = this.membersView(record).filter((m) => !m.deactivated);
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

  /**
   * A meeting milestone, written into the channel it belongs to.
   *
   * Pass `threadRootId` to hang the milestone under the meeting's own message
   * instead of adding another row to the channel — that is what keeps a whole
   * meeting to a single line in the timeline.
   *
   * Returns the message so the caller can use it as that thread root.
   */
  postMeetingEvent(
    workspaceId: WorkspaceId,
    channelId: ChannelId | undefined,
    actor: AgentAddress,
    event: Extract<SystemEvent, 'meeting_scheduled' | 'meeting_started' | 'meeting_ended'>,
    text: string,
    meetingId: string,
    threadRootId?: MessageId,
  ): Message | null {
    const record = this.workspaces.get(workspaceId);
    if (!record) return null;
    const entry =
      (channelId ? record.channels.get(channelId) : undefined) ??
      [...record.channels.values()].find((c) => c.channel.isDefault);
    if (!entry) return null;
    const root = threadRootId ? entry.messages.find((m) => m.id === threadRootId) : undefined;
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
      threadRootId: root?.id,
      replyCount: 0,
      replyUsers: [],
      reactions: [],
      mentions: [],
    };
    this.append(entry, message);
    if (root) this.countReply(record, entry, root, message);
    this.fanOut(record, entry, message);
    this.save();
    return message;
  }

  /**
   * One turn of an agent meeting, written into the meeting's channel as an
   * ordinary message.
   *
   * A meeting *is* a channel, so a turn is just something said in it — no
   * thread, no room, no second way to render a conversation. Pass `rootId` to
   * hang turns under a message instead; that is how a meeting reports into a
   * channel it does not own, where thirty turns should not read as thirty
   * things to catch up on.
   */
  postMeetingTurn(
    workspaceId: WorkspaceId,
    channelId: ChannelId,
    rootId: MessageId | undefined,
    meetingId: string,
    turn: TranscriptEntry,
  ): void {
    const record = this.workspaces.get(workspaceId);
    const entry = record?.channels.get(channelId);
    if (!record || !entry) return;
    const root = rootId ? entry.messages.find((m) => m.id === rootId) : undefined;
    if (rootId && !root) return;

    const message: Message = {
      id: id('msg'),
      workspaceId,
      channelId: entry.channel.id,
      author: turn.speaker,
      text: turn.text,
      ts: turn.ts,
      kind: 'meeting',
      meetingId,
      threadRootId: root?.id,
      // The turn's own kind — question, assignment, commitment — so a reader
      // can see the shape of the meeting without reading every word of it.
      systemDetail: turn.kind,
      replyCount: 0,
      replyUsers: [],
      reactions: [],
      mentions: [],
      refs: turn.refs?.length ? turn.refs : undefined,
      viaAgent: turn.speaker === 'moderator' ? undefined : true,
    };
    this.append(entry, message);
    if (root) this.countReply(record, entry, root, message);
    this.fanOut(record, entry, message);
    this.save();
  }

  /** Keep a thread root's reply counters honest, and tell the room about it. */
  private countReply(
    record: WorkspaceRecord,
    entry: ChannelRecord,
    root: Message,
    reply: Message,
  ): void {
    root.replyCount++;
    root.lastReplyAt = reply.ts;
    if (!root.replyUsers.includes(reply.author)) root.replyUsers.push(reply.author);
    this.broadcast(
      record,
      { type: 'message.updated', workspaceId: record.workspace.id, message: root },
      this.audience(record, entry),
    );
  }

  editMessage(actor: AgentAddress, workspaceId: WorkspaceId, messageId: MessageId, text: string): void {
    const { record, entry, message } = this.locateMessage(workspaceId, messageId, actor);
    this.requireActive(record, actor);
    if (message.author !== actor) throw new HubError('forbidden', 'You can only edit your own messages.');
    if (message.kind !== 'user') throw new HubError('forbidden', 'That message cannot be edited.');
    if (message.deletedAt) throw new HubError('gone', 'That message was deleted.');
    message.text = text.slice(0, 12_000);
    message.editedAt = Date.now();
    const resolved = resolveMentions(
      message.text,
      this.membersView(record).filter((m) => !m.deactivated),
    );
    message.mentions = resolved.mentions.filter((a) => a !== actor);
    message.broadcast = resolved.broadcast;
    this.broadcast(record, { type: 'message.updated', workspaceId, message }, this.audience(record, entry));
    this.save();
  }

  deleteMessage(actor: AgentAddress, workspaceId: WorkspaceId, messageId: MessageId): void {
    const { record, entry, message } = this.locateMessage(workspaceId, messageId, actor);
    if (message.author !== actor) this.requireCapability(record, actor, 'delete_any_message');
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
      if (!this.canSee(record, entry, actor)) throw new HubError('forbidden', 'You do not have access to that channel.');
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
        if (!this.canSee(record, entry, actor)) continue;
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

  /**
   * The channel a meeting happens in.
   *
   * There is no such thing as a meeting room that is not a channel. A meeting
   * booked from a channel runs in that channel; one booked from the agent
   * directory runs in the direct conversation its people already share, so the
   * booking, the meeting itself and everything said about it afterwards all sit
   * in one place. The workspace's default channel is the last resort.
   */
  meetingChannel(
    workspaceId: WorkspaceId,
    organizer: AgentAddress,
    participants: AgentAddress[],
    requested?: ChannelId,
  ): ChannelId | undefined {
    const record = this.workspaces.get(workspaceId);
    if (!record) return undefined;

    if (requested) {
      const entry = record.channels.get(requested);
      if (entry && !entry.channel.archived && this.canSee(record, entry, organizer)) {
        return entry.channel.id;
      }
    }

    const others = participants.filter((a) => a !== organizer && record.members.has(a));
    if (others.length) {
      try {
        return this.openDm(organizer, workspaceId, others);
      } catch {
        // Too many people for a group message, or somebody left mid-negotiation.
        // Fall through rather than losing the meeting.
      }
    }

    return [...record.channels.values()].find((c) => c.channel.isDefault && !c.channel.archived)
      ?.channel.id;
  }

  /**
   * Make the channel a meeting happens in.
   *
   * A meeting is a room, and a room here is a channel — so it gets a real one,
   * named after itself, holding its participants and nothing else. Its turns
   * are ordinary messages in it, which is the whole point: reading a meeting is
   * reading a channel, with no second way to render a conversation.
   *
   * Privacy is inherited rather than chosen. A meeting booked out of a private
   * channel or a DM must not become a public record of what was said there, so
   * the room is private unless the place it came from was public.
   */
  openMeetingChannel(
    workspaceId: WorkspaceId,
    meeting: { id: string; title: string; purpose: string; organizer: AgentAddress; participants: AgentAddress[] },
    originChannelId?: ChannelId,
  ): ChannelId | undefined {
    const record = this.workspaces.get(workspaceId);
    if (!record) return undefined;

    const origin = originChannelId ? record.channels.get(originChannelId) : undefined;
    const kind: Channel['kind'] = origin && origin.channel.kind !== 'public' ? 'private' : 'public';

    // A title is free text and a channel name is not, so fall back rather than
    // refusing to open the room over a name.
    const validated = validateChannelName(meeting.title);
    const base = validated.ok ? validated.name : 'meeting';
    const taken = (name: string) =>
      [...record.channels.values()].some(
        (c) => c.channel.name === name && c.channel.kind !== 'dm' && c.channel.kind !== 'group_dm',
      );
    let name = base;
    for (let n = 2; taken(name); n += 1) name = `${base}-${n}`;

    const members = [
      meeting.organizer,
      ...meeting.participants.filter((a) => record.members.has(a)),
    ];
    const entry = this.createChannelRecord(record, {
      name,
      kind,
      createdBy: meeting.organizer,
      topic: meeting.purpose.slice(0, 250),
      purpose: `Agent meeting: ${meeting.title}`.slice(0, 250),
      members,
      meetingId: meeting.id,
    });
    this.broadcast(
      record,
      { type: 'channel.upserted', workspaceId, channel: entry.channel },
      this.audience(record, entry),
    );
    this.save();
    return entry.channel.id;
  }

  /**
   * Close the room. The channel stays readable — the meeting is its history —
   * but it stops competing for attention in the sidebar.
   */
  archiveMeetingChannel(workspaceId: WorkspaceId, channelId: ChannelId): void {
    const record = this.workspaces.get(workspaceId);
    const entry = record?.channels.get(channelId);
    if (!record || !entry || !entry.channel.meetingId) return;
    entry.channel.archived = true;
    entry.channel.updatedAt = Date.now();
    this.broadcast(
      record,
      { type: 'channel.upserted', workspaceId, channel: entry.channel },
      this.audience(record, entry),
    );
    this.save();
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
        version: 3,
        defaultWorkspaceId: this.defaultWorkspaceId,
        workspaces: [...this.workspaces.values()].map((r) => ({
          workspace: r.workspace,
          members: [...r.members.values()],
          invites: [...r.invites.values()],
          joinRequests: [...r.joinRequests.values()],
          audit: r.audit,
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
          email: i.email,
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

  /**
   * Bring a workspace written by an older relay up to the current shape.
   *
   * The two things that must be invented rather than defaulted are the
   * permission table (derived from the old single `invitePolicy` flag, so a
   * workspace that was admins-only stays admins-only) and the primary owner
   * (the earliest owner, who is almost always the person who created it).
   */
  private migrateWorkspace(
    stored: Workspace & { invitePolicy?: 'anyone' | 'admins' },
    members: MemberRecord[],
  ): Workspace {
    const permissions = { ...defaultPermissions(), ...(stored.permissions ?? {}) };
    if (!stored.permissions && stored.invitePolicy === 'admins') permissions.invite = 'admin';
    for (const capability of Object.keys(permissions) as Capability[]) {
      permissions[capability] = clampCapability(capability, permissions[capability]);
    }

    let primaryOwner = stored.primaryOwner ?? '';
    if (!primaryOwner || !members.some((m) => m.address === primaryOwner)) {
      const owners = members.filter((m) => m.role === 'owner').sort((a, b) => a.joinedAt - b.joinedAt);
      primaryOwner = owners[0]?.address ?? stored.createdBy ?? '';
      if (primaryOwner && !members.some((m) => m.address === primaryOwner)) primaryOwner = '';
    }

    const migrated: Workspace = {
      ...stored,
      discoverable: stored.discoverable ?? true,
      acceptsJoinRequests: stored.acceptsJoinRequests ?? true,
      emailDomains: stored.emailDomains ?? [],
      domainJoin: stored.domainJoin ?? 'open',
      defaultChannels: stored.defaultChannels ?? [],
      permissions,
      primaryOwner,
    };
    delete (migrated as { invitePolicy?: unknown }).invitePolicy;
    return migrated;
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
          workspace: Workspace & { invitePolicy?: 'anyone' | 'admins' };
          members: MemberRecord[];
          invites: Invite[];
          joinRequests?: JoinRequest[];
          audit?: AuditEntry[];
          channels: { channel: Channel; messages: Message[]; reads: Record<string, number> }[];
        }[];
        identities?: {
          address: string;
          profile: PublicProfile;
          status?: UserStatus;
          lastSeen?: number;
          email?: string;
        }[];
      };
      for (const entry of data.workspaces ?? []) {
        const record: WorkspaceRecord = {
          workspace: this.migrateWorkspace(entry.workspace, entry.members),
          members: new Map(entry.members.map((m) => [m.address, m])),
          channels: new Map(
            entry.channels.map((c) => [
              c.channel.id,
              { channel: c.channel, messages: c.messages ?? [], reads: c.reads ?? {} },
            ]),
          ),
          invites: new Map((entry.invites ?? []).map((i) => [i.code, i])),
          joinRequests: new Map((entry.joinRequests ?? []).map((r) => [r.id, r])),
          audit: entry.audit ?? [],
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
          email: entry.email,
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

