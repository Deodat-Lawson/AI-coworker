/**
 * The client-side picture of every workspace this person belongs to.
 *
 * The relay is the source of truth; this is the local replica the desktop app
 * draws from. It applies server frames, keeps messages ordered and de-duplicated,
 * and answers the questions a sidebar asks — what is unread, who is typing, what
 * is this DM called.
 */

import { EventEmitter } from 'node:events';

import {
  type AgentAddress,
  type AuditEntry,
  type Channel,
  type ChannelId,
  type ChannelReadState,
  type Invite,
  type JoinRequest,
  type Message,
  type MessageId,
  type SearchResults,
  type ServerMessage,
  type Workspace,
  type WorkspaceId,
  type WorkspaceMember,
  isDirect,
  messagePreview,
  SNAPSHOT_PAGE,
} from '@ai-coworker/shared';

/** How long a typing signal stays warm before it fades. */
const TYPING_TTL = 5_000;

export interface DiscoverableWorkspace {
  id: WorkspaceId;
  slug: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  memberCount: number;
  joined: boolean;
}

export interface WorkspaceState {
  relayUrl: string;
  workspace: Workspace;
  me: WorkspaceMember;
  members: Map<AgentAddress, WorkspaceMember>;
  channels: Map<ChannelId, Channel>;
  /** Channel timeline, oldest first. */
  messages: Map<ChannelId, Message[]>;
  /** Thread replies keyed by root message id, oldest first. */
  threads: Map<MessageId, Message[]>;
  reads: Map<ChannelId, ChannelReadState>;
  /** Channels whose full history we already hold. */
  complete: Set<ChannelId>;
  typing: Map<ChannelId, Map<AgentAddress, number>>;
  invites: Invite[];
  /** Only ever populated for admins; the relay refuses to send it to anybody else. */
  joinRequests: JoinRequest[];
  audit: AuditEntry[];
}

export class WorkspaceBook extends EventEmitter {
  private states = new Map<WorkspaceId, WorkspaceState>();
  private discovered: DiscoverableWorkspace[] = [];
  private lastSearch: SearchResults | null = null;

  get all(): WorkspaceState[] {
    return [...this.states.values()].sort(
      (a, b) => a.workspace.createdAt - b.workspace.createdAt,
    );
  }

  get ids(): WorkspaceId[] {
    return this.all.map((s) => s.workspace.id);
  }

  get discoverable(): DiscoverableWorkspace[] {
    return this.discovered;
  }

  get searchResults(): SearchResults | null {
    return this.lastSearch;
  }

  get(workspaceId: WorkspaceId): WorkspaceState | undefined {
    return this.states.get(workspaceId);
  }

  relayFor(workspaceId: WorkspaceId): string | undefined {
    return this.states.get(workspaceId)?.relayUrl;
  }

  /** Drop everything a relay told us — used when a connection is removed. */
  forgetRelay(relayUrl: string): void {
    for (const [id, state] of this.states) {
      if (state.relayUrl === relayUrl) this.states.delete(id);
    }
    this.emit('change');
  }

  // -------------------------------------------------------------------------
  // Applying server frames
  // -------------------------------------------------------------------------

  /** Returns true when the frame belonged to the workspace layer. */
  apply(message: ServerMessage, relayUrl: string): boolean {
    switch (message.type) {
      case 'workspace.snapshot': {
        const previous = this.states.get(message.workspace.id);
        const state: WorkspaceState = {
          relayUrl,
          workspace: message.workspace,
          me: message.me,
          members: new Map(message.members.map((m) => [m.address, m])),
          channels: new Map(message.channels.map((c) => [c.id, c])),
          messages: previous?.messages ?? new Map(),
          threads: previous?.threads ?? new Map(),
          reads: new Map(message.readStates.map((r) => [r.channelId, r])),
          complete: previous?.complete ?? new Set(),
          typing: previous?.typing ?? new Map(),
          invites: previous?.invites ?? [],
          joinRequests: previous?.joinRequests ?? [],
          audit: previous?.audit ?? [],
        };
        for (const [channelId, messages] of Object.entries(message.recent)) {
          state.messages.set(channelId, [...messages]);
          // A short page means the snapshot carried the whole channel, so the
          // reader is never offered a pointless "load earlier messages".
          if (messages.length < SNAPSHOT_PAGE) state.complete.add(channelId);
          else state.complete.delete(channelId);
        }

        // A snapshot is the whole truth about what this person can see, so
        // anything it leaves out has been taken away — a channel archived out
        // from under them, or access narrowed to a guest's single room. Carrying
        // the old messages forward would leave that history readable locally
        // long after the relay stopped serving it.
        for (const channelId of [...state.messages.keys()]) {
          if (state.channels.has(channelId)) continue;
          state.messages.delete(channelId);
          state.reads.delete(channelId);
          state.complete.delete(channelId);
          state.typing.delete(channelId);
        }
        // Threads are keyed by root id, so they are pruned by the channel their
        // replies belong to rather than by whether the root is still on the
        // visible page — an open thread can easily be older than that.
        for (const [rootId, replies] of state.threads) {
          const channelId = replies[0]?.channelId;
          if (channelId && !state.channels.has(channelId)) state.threads.delete(rootId);
        }

        this.states.set(message.workspace.id, state);
        this.emit('change');
        this.emit('workspace.snapshot', state);
        return true;
      }

      case 'workspace.updated': {
        const state = this.states.get(message.workspace.id);
        if (state) {
          state.workspace = message.workspace;
          this.emit('change');
        }
        return true;
      }

      case 'workspace.removed': {
        const state = this.states.get(message.workspaceId);
        this.states.delete(message.workspaceId);
        if (state) this.emit('workspace.removed', state.workspace, message.reason);
        this.emit('change');
        return true;
      }

      case 'workspace.discover.result':
        this.discovered = message.workspaces;
        this.emit('change');
        return true;

      case 'workspace.member': {
        const state = this.states.get(message.workspaceId);
        if (state) {
          state.members.set(message.member.address, message.member);
          if (message.member.address === state.me.address) state.me = message.member;
          this.emit('change');
        }
        return true;
      }

      case 'workspace.member_removed': {
        const state = this.states.get(message.workspaceId);
        if (state) {
          state.members.delete(message.address);
          this.emit('change');
        }
        return true;
      }

      case 'channel.upserted': {
        const state = this.states.get(message.workspaceId);
        if (state) {
          state.channels.set(message.channel.id, message.channel);
          this.emit('change');
        }
        return true;
      }

      case 'channel.removed': {
        const state = this.states.get(message.workspaceId);
        if (state) {
          state.channels.delete(message.channelId);
          state.messages.delete(message.channelId);
          this.emit('change');
        }
        return true;
      }

      case 'message.new': {
        const state = this.states.get(message.workspaceId);
        if (!state) return true;
        this.insert(state, message.message);
        if (message.read) state.reads.set(message.read.channelId, message.read);
        // Somebody who posts has stopped typing.
        state.typing.get(message.message.channelId)?.delete(message.message.author);
        this.emit('change');
        this.emit('message', message.message, state);
        return true;
      }

      case 'message.updated': {
        const state = this.states.get(message.workspaceId);
        if (!state) return true;
        this.replace(state, message.message);
        this.emit('change');
        return true;
      }

      case 'history.page': {
        const state = this.states.get(message.workspaceId);
        if (!state) return true;
        if (message.threadRootId) {
          const [root, ...replies] = message.messages;
          if (root) this.replace(state, root);
          state.threads.set(message.threadRootId, replies);
        } else {
          const merged = mergeById(state.messages.get(message.channelId) ?? [], message.messages);
          state.messages.set(message.channelId, merged);
          if (message.reachedStart) state.complete.add(message.channelId);
        }
        this.emit('change');
        return true;
      }

      case 'typing.update': {
        const state = this.states.get(message.workspaceId);
        if (!state) return true;
        const forChannel = state.typing.get(message.channelId) ?? new Map();
        forChannel.set(message.address, Date.now());
        state.typing.set(message.channelId, forChannel);
        this.emit('change');
        return true;
      }

      case 'read.updated': {
        const state = this.states.get(message.workspaceId);
        if (state) {
          state.reads.set(message.read.channelId, message.read);
          this.emit('change');
        }
        return true;
      }

      case 'invite.created': {
        const state = this.states.get(message.workspaceId);
        if (state) {
          state.invites = [message.invite, ...state.invites.filter((i) => i.code !== message.invite.code)];
          this.emit('change');
        }
        this.emit('invite', message.invite);
        return true;
      }

      case 'invite.list.result': {
        const state = this.states.get(message.workspaceId);
        if (state) {
          state.invites = message.invites;
          this.emit('change');
        }
        return true;
      }

      case 'workspace.join_requests.result': {
        const state = this.states.get(message.workspaceId);
        if (state) {
          state.joinRequests = message.requests;
          this.emit('change');
        }
        return true;
      }

      case 'workspace.join_requested': {
        const state = this.states.get(message.workspaceId);
        if (state) {
          state.joinRequests = [
            message.request,
            ...state.joinRequests.filter((r) => r.id !== message.request.id),
          ];
          this.emit('change');
        }
        this.emit('join.requested', message.request);
        return true;
      }

      case 'workspace.join_decided':
        // The snapshot follows on approval; this is what lets an app say "they
        // said no" instead of leaving somebody watching an empty rail.
        this.emit('join.decided', message.workspaceName, message.approved);
        return true;

      case 'workspace.audit.result': {
        const state = this.states.get(message.workspaceId);
        if (state) {
          state.audit = message.entries;
          this.emit('change');
        }
        return true;
      }

      case 'search.results':
        this.lastSearch = message.results;
        this.emit('change');
        this.emit('search', message.results);
        return true;

      default:
        return false;
    }
  }

  private insert(state: WorkspaceState, message: Message): void {
    if (message.threadRootId && !message.alsoSentToChannel) {
      const replies = state.threads.get(message.threadRootId) ?? [];
      state.threads.set(message.threadRootId, mergeById(replies, [message]));
      const root = this.findMessage(state, message.threadRootId);
      if (root) {
        root.replyCount = Math.max(root.replyCount, (state.threads.get(message.threadRootId) ?? []).length);
        root.lastReplyAt = message.ts;
        if (!root.replyUsers.includes(message.author)) root.replyUsers.push(message.author);
      }
      return;
    }
    if (message.threadRootId) {
      const replies = state.threads.get(message.threadRootId) ?? [];
      state.threads.set(message.threadRootId, mergeById(replies, [message]));
    }
    const list = state.messages.get(message.channelId) ?? [];
    state.messages.set(message.channelId, mergeById(list, [message]));
  }

  private replace(state: WorkspaceState, message: Message): void {
    const list = state.messages.get(message.channelId);
    if (list) {
      const idx = list.findIndex((m) => m.id === message.id);
      if (idx >= 0) list[idx] = message;
    }
    for (const [rootId, replies] of state.threads) {
      const idx = replies.findIndex((m) => m.id === message.id);
      if (idx >= 0) replies[idx] = message;
      if (rootId === message.id) {
        // Root updates (reply counts, reactions) are worth keeping in sync too.
        state.threads.set(rootId, replies);
      }
    }
  }

  private findMessage(state: WorkspaceState, messageId: MessageId): Message | undefined {
    for (const list of state.messages.values()) {
      const hit = list.find((m) => m.id === messageId);
      if (hit) return hit;
    }
    for (const replies of state.threads.values()) {
      const hit = replies.find((m) => m.id === messageId);
      if (hit) return hit;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  channels(workspaceId: WorkspaceId): Channel[] {
    return [...(this.states.get(workspaceId)?.channels.values() ?? [])];
  }

  channel(workspaceId: WorkspaceId, channelId: ChannelId): Channel | undefined {
    return this.states.get(workspaceId)?.channels.get(channelId);
  }

  messages(workspaceId: WorkspaceId, channelId: ChannelId): Message[] {
    return this.states.get(workspaceId)?.messages.get(channelId) ?? [];
  }

  thread(workspaceId: WorkspaceId, rootId: MessageId): Message[] {
    return this.states.get(workspaceId)?.threads.get(rootId) ?? [];
  }

  members(workspaceId: WorkspaceId): WorkspaceMember[] {
    return [...(this.states.get(workspaceId)?.members.values() ?? [])];
  }

  member(workspaceId: WorkspaceId, address: AgentAddress): WorkspaceMember | undefined {
    return this.states.get(workspaceId)?.members.get(address);
  }

  read(workspaceId: WorkspaceId, channelId: ChannelId): ChannelReadState | undefined {
    return this.states.get(workspaceId)?.reads.get(channelId);
  }

  typing(workspaceId: WorkspaceId, channelId: ChannelId): AgentAddress[] {
    const map = this.states.get(workspaceId)?.typing.get(channelId);
    if (!map) return [];
    const cutoff = Date.now() - TYPING_TTL;
    const live: AgentAddress[] = [];
    for (const [address, ts] of map) {
      if (ts >= cutoff) live.push(address);
      else map.delete(address);
    }
    return live;
  }

  /** Unread and mention totals for one workspace, for the rail badge. */
  totals(workspaceId: WorkspaceId): { unread: number; mentions: number } {
    const state = this.states.get(workspaceId);
    if (!state) return { unread: 0, mentions: 0 };
    let unread = 0;
    let mentions = 0;
    for (const read of state.reads.values()) {
      const channel = state.channels.get(read.channelId);
      if (!channel || channel.archived) continue;
      if (!channel.members.includes(state.me.address)) continue;
      unread += read.unread;
      mentions += read.mentions;
    }
    return { unread, mentions };
  }

  /** What to call a channel in a list: "#general" or the people in a DM. */
  label(workspaceId: WorkspaceId, channelId: ChannelId): string {
    const state = this.states.get(workspaceId);
    const channel = state?.channels.get(channelId);
    if (!state || !channel) return 'channel';
    if (!isDirect(channel)) return `#${channel.name}`;
    const others = channel.members.filter((a) => a !== state.me.address);
    if (!others.length) return `${state.me.displayName} (you)`;
    return others.map((a) => state.members.get(a)?.displayName ?? a.split('@')[0]!).join(', ');
  }

  /** One line describing the newest thing said, for a channel list preview. */
  preview(workspaceId: WorkspaceId, channelId: ChannelId): string {
    const list = this.messages(workspaceId, channelId);
    for (let i = list.length - 1; i >= 0; i--) {
      const message = list[i]!;
      if (message.deletedAt || message.kind === 'system') continue;
      const who = this.member(workspaceId, message.author)?.displayName.split(' ')[0] ?? message.author;
      return `${who}: ${messagePreview(message.text, 60)}`;
    }
    return '';
  }
}

/** Merge two message lists by id, keeping them sorted oldest-first. */
function mergeById(current: Message[], incoming: Message[]): Message[] {
  if (!incoming.length) return current;
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
}
