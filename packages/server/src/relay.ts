/**
 * The relay: workspaces, scheduling, and meeting rooms.
 *
 * What it deliberately does not do: read anyone's knowledge base, summarize
 * anything, or generate a single word of meeting content. Those all belong to
 * the personal agents. The relay is closer to a switchboard plus a shared
 * message board than to a chatbot.
 *
 * Workspace state lives in {@link WorkspaceHub}; this file is the transport and
 * the meeting scheduler that sits beside it.
 */

import { EventEmitter } from 'node:events';

import {
  type AgentAddress,
  type ClientMessage,
  type Meeting,
  type MeetingRequest,
  type PublicProfile,
  type ServerMessage,
  type TimeSlot,
  MINUTE,
  formatTime,
  id,
  intersectSlots,
  parseClientMessage,
  PROTOCOL_VERSION,
} from '@ai-coworker/shared';
import type { WebSocket } from 'ws';

import { HubError, WorkspaceHub, type HubOptions } from './hub.js';
import { MeetingRoom } from './room.js';

interface Connection {
  socket: WebSocket;
  profile: PublicProfile;
  connectedAt: number;
}

interface Negotiation {
  request: MeetingRequest;
  replies: Map<AgentAddress, TimeSlot[]>;
  declined: Map<AgentAddress, string>;
  timer: NodeJS.Timeout;
}

interface ScheduledMeeting {
  meeting: Meeting;
  timer: NodeJS.Timeout | null;
  room: MeetingRoom | null;
}

export interface RelayOptions {
  /** How long to wait for every agent to answer an availability request. */
  negotiationTimeoutMs?: number;
  turnTimeoutMs?: number;
  joinTimeoutMs?: number;
  log?: (message: string) => void;
  /** Called whenever a meeting completes, for optional persistence. */
  onMeetingEnded?: (room: MeetingRoom) => void;
  /** Workspace storage and naming. */
  hub?: HubOptions;
  /**
   * How hard the relay leans on accounts:
   *
   *   off       accounts are not consulted at all
   *   optional  a token is honoured when presented, and an address that belongs
   *             to an account can only be used with one (the default)
   *   required  no token, no connection
   */
  auth?: 'off' | 'optional' | 'required';
  accounts?: AccountLookup;
}

/** The slice of the account store the transport needs. Keeps the two apart. */
export interface AccountLookup {
  resolve(token: string | undefined): { address: AgentAddress; displayName: string } | undefined;
  forAddress(address: AgentAddress): { address: AgentAddress } | undefined;
}

export class Relay extends EventEmitter {
  private connections = new Map<AgentAddress, Connection>();
  private negotiations = new Map<string, Negotiation>();
  private meetings = new Map<string, ScheduledMeeting>();
  private options: Required<Omit<RelayOptions, 'onMeetingEnded' | 'hub' | 'accounts'>> &
    Pick<RelayOptions, 'onMeetingEnded' | 'accounts'>;
  readonly hub: WorkspaceHub;

  constructor(options: RelayOptions = {}) {
    super();
    this.options = {
      negotiationTimeoutMs: options.negotiationTimeoutMs ?? 10_000,
      // Generous by default: an agent may be waiting out a model rate limit,
      // which is normal on a free API tier and should not drop its turn.
      turnTimeoutMs:
        options.turnTimeoutMs ?? Number(process.env.AI_COWORKER_TURN_TIMEOUT_MS ?? 240_000),
      joinTimeoutMs: options.joinTimeoutMs ?? 15_000,
      log: options.log ?? (() => {}),
      auth: options.auth ?? 'optional',
      accounts: options.accounts,
      onMeetingEnded: options.onMeetingEnded,
    };
    this.hub = new WorkspaceHub({ log: this.options.log, ...options.hub });
    this.hub.onDeliver((to, message) => this.send(to, message));
  }

  get onlineCount(): number {
    return this.connections.size;
  }

  get directory(): PublicProfile[] {
    return [...this.connections.values()].map((c) => c.profile);
  }

  get scheduledMeetings(): Meeting[] {
    return [...this.meetings.values()].map((m) => m.meeting);
  }

  // --- connection lifecycle -------------------------------------------------

  handleConnection(socket: WebSocket): void {
    let address: AgentAddress | null = null;

    socket.on('message', (data) => {
      const message = parseClientMessage(data.toString());
      if (!message) {
        this.sendSocket(socket, { type: 'error', code: 'bad_message', message: 'Unparseable message.' });
        return;
      }

      if (message.type === 'hello') {
        address = this.handleHello(socket, message.profile, message.sessionToken);
        return;
      }

      if (!address) {
        this.sendSocket(socket, { type: 'error', code: 'no_hello', message: 'Send hello first.' });
        return;
      }
      try {
        this.handleMessage(address, message);
      } catch (err) {
        // A HubError is a refusal the user should read ("that channel is
        // archived"); anything else is a bug and gets logged as one.
        const hubError = err instanceof HubError;
        if (!hubError) {
          this.options.log(`error handling ${message.type} from ${address}: ${(err as Error).message}`);
        }
        this.sendSocket(socket, {
          type: 'error',
          code: hubError ? (err as HubError).code : 'handler_error',
          message: (err as Error).message,
          context: message.type,
        });
      }
    });

    socket.on('close', () => {
      if (!address) return;
      // Only drop the directory entry if this socket is still the live one for
      // the address (a reconnect may already have replaced it).
      if (this.connections.get(address)?.socket === socket) {
        this.connections.delete(address);
        this.options.log(`${address} disconnected (${this.connections.size} online)`);
        for (const entry of this.meetings.values()) entry.room?.leave(address);
        this.hub.disconnect(address);
        this.broadcastDirectory();
        this.emit('directory', this.directory);
      }
    });

    socket.on('error', () => {
      /* 'close' handles cleanup */
    });
  }

  private handleHello(
    socket: WebSocket,
    profile: PublicProfile,
    sessionToken?: string,
  ): AgentAddress | null {
    if (!profile?.address || typeof profile.address !== 'string') {
      this.sendSocket(socket, { type: 'error', code: 'bad_profile', message: 'Profile needs an address.' });
      return null;
    }

    // The address on the wire is only worth what backs it. A token proves the
    // person behind it verified an email, and the address it grants is the one
    // they get — not the one they typed. Without a token the relay falls back to
    // taking the claim at face value, which is the historical behaviour and is
    // only defensible on a network where everybody is already trusted; a relay
    // started with `auth: 'required'` refuses instead.
    const account = this.options.accounts?.resolve(sessionToken);
    if (sessionToken && !account) {
      this.sendSocket(socket, {
        type: 'error',
        code: 'bad_session',
        message: 'That session has expired. Sign in again.',
      });
      socket.close();
      return null;
    }
    if (!account && this.options.auth === 'required') {
      this.sendSocket(socket, {
        type: 'error',
        code: 'auth_required',
        message: 'This relay requires an account. Sign in to continue.',
      });
      socket.close();
      return null;
    }
    if (account && account.address !== profile.address) {
      this.options.log(
        `refusing ${profile.address} from the session for ${account.address}`,
      );
      this.sendSocket(socket, {
        type: 'error',
        code: 'address_mismatch',
        message: `That session belongs to ${account.address}.`,
      });
      socket.close();
      return null;
    }
    // Nobody may present an address that belongs to somebody else's account.
    if (!account && this.options.accounts?.forAddress(profile.address)) {
      this.sendSocket(socket, {
        type: 'error',
        code: 'auth_required',
        message: 'That address belongs to an account. Sign in to use it.',
      });
      socket.close();
      return null;
    }

    const address = profile.address;
    const previous = this.connections.get(address);
    if (previous && previous.socket !== socket) previous.socket.close();

    this.connections.set(address, {
      socket,
      profile: { ...profile, online: true, lastSeen: Date.now() },
      connectedAt: Date.now(),
    });
    this.options.log(`${address} connected (${this.connections.size} online)`);

    this.sendSocket(socket, {
      type: 'hello.ok',
      you: this.connections.get(address)!.profile,
      serverTime: Date.now(),
      protocolVersion: PROTOCOL_VERSION,
      relayName: this.hub.relayName,
    });

    // Everything this person belongs to, in full, before anything else arrives —
    // the client can then draw its whole shell from one round trip.
    for (const workspaceId of this.hub.connect(this.connections.get(address)!.profile)) {
      this.hub.sendSnapshot(address, workspaceId);
    }

    this.broadcastDirectory();
    this.emit('directory', this.directory);

    // Re-announce meetings this agent is party to, so a client that restarted
    // does not lose a booking that is still on the relay's books.
    for (const entry of this.meetings.values()) {
      if (entry.meeting.participants.includes(address)) {
        this.sendSocket(socket, { type: 'meeting.scheduled', meeting: entry.meeting });
      }
    }
    return address;
  }

  private handleMessage(address: AgentAddress, message: ClientMessage): void {
    switch (message.type) {
      case 'ping':
        this.send(address, { type: 'pong', serverTime: Date.now() });
        break;

      case 'directory.list':
        this.send(address, { type: 'directory.update', agents: this.directory });
        break;

      // --- workspaces -------------------------------------------------------

      case 'workspace.list':
        for (const workspaceId of this.hub.workspaceIdsFor(address)) {
          this.hub.sendSnapshot(address, workspaceId);
        }
        break;

      case 'workspace.discover':
        this.send(address, this.hub.discoverable(address));
        break;

      case 'workspace.create': {
        const workspaceId = this.hub.createWorkspace(address, message);
        this.hub.sendSnapshot(address, workspaceId);
        break;
      }

      case 'workspace.join': {
        const workspaceId = this.hub.joinWorkspace(address, message);
        this.hub.sendSnapshot(address, workspaceId);
        break;
      }

      case 'workspace.leave':
        this.hub.leaveWorkspace(address, message.workspaceId);
        break;

      case 'workspace.update':
        this.hub.updateWorkspace(address, message.workspaceId, message.patch);
        break;

      case 'workspace.permissions':
        this.hub.setPermissions(address, message.workspaceId, message.patch);
        break;

      case 'workspace.delete':
        this.hub.deleteWorkspace(address, message.workspaceId);
        break;

      case 'workspace.set_role':
        this.hub.setRole(address, message.workspaceId, message, message.role, message.guestChannels);
        break;

      case 'workspace.remove_member':
        this.hub.removeMember(address, message.workspaceId, message);
        break;

      case 'workspace.set_active':
        this.hub.setActive(address, message.workspaceId, message, message.active);
        break;

      case 'workspace.transfer_ownership':
        this.hub.transferOwnership(address, message.workspaceId, message.address);
        break;

      case 'workspace.profile':
        this.hub.setWorkspaceProfile(address, message.workspaceId, {
          address: message.address,
          displayName: message.displayName,
          title: message.title,
        });
        break;

      case 'workspace.request_join':
        this.hub.requestJoin(address, message.slug, message.message);
        break;

      case 'workspace.review_join':
        this.hub.reviewJoin(
          address,
          message.workspaceId,
          message.requestId,
          message.approve,
          message.role,
        );
        break;

      case 'workspace.join_requests':
        this.send(address, this.hub.listJoinRequests(address, message.workspaceId));
        break;

      case 'workspace.audit':
        this.send(address, this.hub.auditLog(address, message.workspaceId, message.limit));
        break;

      // --- invitations ------------------------------------------------------

      case 'invite.create':
        this.hub.createInvite(address, message.workspaceId, message);
        break;

      case 'invite.revoke':
        this.hub.revokeInvite(address, message.workspaceId, message.code);
        break;

      case 'invite.list':
        this.send(address, this.hub.listInvites(address, message.workspaceId));
        break;

      // --- channels ---------------------------------------------------------

      case 'channel.create':
        this.hub.createChannel(address, message.workspaceId, message);
        break;

      case 'channel.update':
        this.hub.updateChannel(address, message.workspaceId, message.channelId, message.patch);
        break;

      case 'channel.archive':
        this.hub.archiveChannel(address, message.workspaceId, message.channelId, message.archived);
        break;

      case 'channel.join':
        this.hub.joinChannel(address, message.workspaceId, message.channelId);
        break;

      case 'channel.leave':
        this.hub.leaveChannel(address, message.workspaceId, message.channelId);
        break;

      case 'channel.invite':
        this.hub.inviteToChannel(address, message.workspaceId, message.channelId, message.addresses);
        break;

      case 'channel.kick':
        this.hub.kickFromChannel(address, message.workspaceId, message.channelId, message.address);
        break;

      case 'channel.list':
        for (const update of this.hub.listChannels(address, message.workspaceId)) {
          this.send(address, update);
        }
        break;

      case 'dm.open':
        this.hub.openDm(address, message.workspaceId, message.addresses);
        break;

      // --- messages ---------------------------------------------------------

      case 'message.send':
        this.hub.postMessage(address, message);
        break;

      case 'message.edit':
        this.hub.editMessage(address, message.workspaceId, message.messageId, message.text);
        break;

      case 'message.delete':
        this.hub.deleteMessage(address, message.workspaceId, message.messageId);
        break;

      case 'message.react':
        this.hub.react(address, message.workspaceId, message.messageId, message.emoji, message.on);
        break;

      case 'message.pin':
        this.hub.pin(address, message.workspaceId, message.messageId, message.pinned);
        break;

      case 'history.fetch':
        this.send(
          address,
          this.hub.history(address, message.workspaceId, message.channelId, message.before, message.limit),
        );
        break;

      case 'thread.fetch':
        this.send(address, this.hub.thread(address, message.workspaceId, message.rootId));
        break;

      case 'typing':
        this.hub.typing(address, message.workspaceId, message.channelId);
        break;

      case 'read.set':
        this.hub.markRead(address, message.workspaceId, message.channelId, message.ts);
        break;

      case 'presence.set':
        this.hub.setPresence(address, message.presence, message.status);
        break;

      case 'search':
        this.send(
          address,
          this.hub.search(address, message.workspaceId, message.query, {
            limit: message.limit,
            channelId: message.channelId,
            from: message.from,
          }),
        );
        break;

      case 'meeting.request':
        this.startNegotiation(address, message.request);
        break;

      case 'meeting.availability.reply':
        this.collectAvailability(address, message.reply);
        break;

      case 'meeting.cancel': {
        const entry = this.meetings.get(message.meetingId);
        if (!entry || !entry.meeting.participants.includes(address)) return;
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.room) {
          entry.room.cancel(address, message.reason);
        } else {
          for (const p of entry.meeting.participants) {
            this.send(p, {
              type: 'meeting.cancelled',
              meetingId: entry.meeting.id,
              by: address,
              reason: message.reason,
            });
          }
          this.meetings.delete(message.meetingId);
        }
        break;
      }

      case 'meeting.join': {
        const entry = this.meetings.get(message.meetingId);
        entry?.room?.join(address);
        break;
      }

      case 'meeting.start_now': {
        const entry = this.meetings.get(message.meetingId);
        if (!entry || !entry.meeting.participants.includes(address)) return;
        if (entry.room) return;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        this.openRoom(entry);
        break;
      }

      case 'room.say':
        this.room(message.meetingId)?.say(address, message.text, message.refs);
        break;
      case 'room.demo':
        this.room(message.meetingId)?.demo(address, message.text, message.refs);
        break;
      case 'room.ask':
        this.room(message.meetingId)?.ask(address, message.to, message.question);
        break;
      case 'room.answer':
        this.room(message.meetingId)?.answer(address, message.to, message.text, message.refs);
        break;
      case 'room.assign':
        this.room(message.meetingId)?.assign(address, message.task);
        break;
      case 'room.commit':
        this.room(message.meetingId)?.commit(address, message.commitment);
        break;
      case 'room.decision':
        this.room(message.meetingId)?.decision(address, message.text);
        break;
      case 'room.minutes':
        this.room(message.meetingId)?.recordMinutes(address, message.minutes);
        break;
      case 'room.yield':
        this.room(message.meetingId)?.yieldTurn(address);
        break;
      case 'room.working':
        this.room(message.meetingId)?.heartbeat(address, message.note);
        break;

      case 'hello':
        break;
    }
  }

  private room(meetingId: string): MeetingRoom | null {
    return this.meetings.get(meetingId)?.room ?? null;
  }

  // --- scheduling -----------------------------------------------------------

  private startNegotiation(organizer: AgentAddress, input: Omit<MeetingRequest, 'negotiationId' | 'organizer'>): void {
    const participants = [...new Set([organizer, ...input.participants])];
    const negotiationId = id('neg');
    const workspaceId = this.hub.resolveMeetingWorkspace(organizer, input.workspaceId);

    // A meeting happens inside one workspace: you cannot pull somebody into a
    // room they have no membership in.
    const outsiders = this.hub.sharesWorkspace(workspaceId, participants);
    if (outsiders.length) {
      this.send(organizer, {
        type: 'meeting.failed',
        negotiationId,
        reason: `Not in ${this.hub.workspaceName(workspaceId)}: ${outsiders.join(', ')}. Invite them to the workspace first.`,
        offered: {},
      });
      return;
    }

    const offline = participants.filter((p) => !this.connections.has(p));
    if (offline.length) {
      this.send(organizer, {
        type: 'meeting.failed',
        negotiationId,
        reason: `Not reachable: ${offline.join(', ')}. Their agent needs to be online to negotiate a time.`,
        offered: {},
      });
      return;
    }

    const request: MeetingRequest = { ...input, workspaceId, participants, negotiationId, organizer };
    const negotiation: Negotiation = {
      request,
      replies: new Map(),
      declined: new Map(),
      timer: setTimeout(() => this.resolveNegotiation(negotiationId), this.options.negotiationTimeoutMs),
    };
    this.negotiations.set(negotiationId, negotiation);

    this.options.log(
      `negotiating "${request.title}" for ${participants.join(', ')} (${request.durationMins}m)`,
    );
    for (const participant of participants) {
      this.send(participant, { type: 'meeting.availability.request', request });
    }
  }

  private collectAvailability(
    address: AgentAddress,
    reply: { negotiationId: string; slots: TimeSlot[]; declined?: boolean; declineReason?: string },
  ): void {
    const negotiation = this.negotiations.get(reply.negotiationId);
    if (!negotiation) return;
    if (!negotiation.request.participants.includes(address)) return;

    if (reply.declined || reply.slots.length === 0) {
      negotiation.declined.set(address, reply.declineReason ?? 'No availability offered.');
      negotiation.replies.set(address, []);
    } else {
      negotiation.replies.set(address, reply.slots);
    }

    if (negotiation.replies.size === negotiation.request.participants.length) {
      clearTimeout(negotiation.timer);
      this.resolveNegotiation(reply.negotiationId);
    }
  }

  private resolveNegotiation(negotiationId: string): void {
    const negotiation = this.negotiations.get(negotiationId);
    if (!negotiation) return;
    this.negotiations.delete(negotiationId);
    clearTimeout(negotiation.timer);

    const { request } = negotiation;
    const missing = request.participants.filter((p) => !negotiation.replies.has(p));
    const offered: Record<AgentAddress, TimeSlot[]> = {};
    for (const [address, slots] of negotiation.replies) offered[address] = slots.slice(0, 10);

    if (missing.length) {
      this.send(request.organizer, {
        type: 'meeting.failed',
        negotiationId,
        reason: `No answer from ${missing.join(', ')} in time.`,
        offered,
      });
      return;
    }
    if (negotiation.declined.size) {
      const detail = [...negotiation.declined.entries()].map(([a, r]) => `${a}: ${r}`).join('; ');
      this.send(request.organizer, {
        type: 'meeting.failed',
        negotiationId,
        reason: `No shared availability. ${detail}`,
        offered,
      });
      return;
    }

    const common = intersectSlots([...negotiation.replies.values()]);
    if (!common.length) {
      this.send(request.organizer, {
        type: 'meeting.failed',
        negotiationId,
        reason:
          'Everyone answered, but there is no slot all of them are free for in that window. Try a wider window or a shorter meeting.',
        offered,
      });
      return;
    }

    const slot = common[0]!;
    const meeting: Meeting = {
      id: id('mtg'),
      workspaceId: request.workspaceId ?? this.hub.resolveMeetingWorkspace(request.organizer),
      channelId: request.channelId,
      title: request.title,
      purpose: request.purpose,
      kind: request.kind,
      agenda: request.agenda,
      chair: request.participants.includes(request.chair) ? request.chair : request.organizer,
      participants: request.participants,
      organizer: request.organizer,
      start: slot.start,
      end: slot.end,
      status: 'scheduled',
      createdAt: Date.now(),
    };

    const entry: ScheduledMeeting = { meeting, timer: null, room: null };
    this.meetings.set(meeting.id, entry);

    const delay = Math.max(0, meeting.start - Date.now());
    entry.timer = setTimeout(() => this.openRoom(entry), delay);

    this.options.log(
      `booked "${meeting.title}" ${formatTime(meeting.start)} for ${meeting.participants.join(', ')}`,
    );
    for (const participant of meeting.participants) {
      this.send(participant, { type: 'meeting.scheduled', meeting });
    }
    this.announceMeeting(meeting, 'meeting_scheduled', `booked *${meeting.title}* for ${formatTime(meeting.start)}`);
    this.emit('meeting.scheduled', meeting);
  }

  /** Meetings are workspace events, so they show up in the channel too. */
  private announceMeeting(
    meeting: Meeting,
    event: 'meeting_scheduled' | 'meeting_started' | 'meeting_ended',
    text: string,
  ): void {
    this.hub.postMeetingEvent(
      meeting.workspaceId,
      meeting.channelId,
      meeting.organizer,
      event,
      text,
      meeting.id,
    );
  }

  // --- rooms ----------------------------------------------------------------

  private openRoom(entry: ScheduledMeeting): void {
    if (entry.room) return;
    entry.meeting.status = 'live';
    const room = new MeetingRoom({
      meeting: entry.meeting,
      send: (to, message) => this.send(to, message),
      turnTimeoutMs: this.options.turnTimeoutMs,
      joinTimeoutMs: this.options.joinTimeoutMs,
      log: this.options.log,
      onEnded: (finished) => {
        entry.meeting.status = finished.phase === 'closed' ? 'completed' : 'cancelled';
        this.meetings.delete(entry.meeting.id);
        this.announceMeeting(
          entry.meeting,
          'meeting_ended',
          finished.phase === 'closed'
            ? `*${entry.meeting.title}* finished — ${finished.transcript.length} turns on the record.`
            : `*${entry.meeting.title}* ended early.`,
        );
        this.options.onMeetingEnded?.(finished);
        this.emit('meeting.ended', finished);
      },
    });
    entry.room = room;
    this.options.log(`opening room for "${entry.meeting.title}"`);
    this.announceMeeting(entry.meeting, 'meeting_started', `*${entry.meeting.title}* is under way.`);
    this.emit('meeting.live', entry.meeting);
    room.open();
  }

  /** Re-arm timers for meetings restored from disk. */
  restoreMeeting(meeting: Meeting): void {
    if (this.meetings.has(meeting.id)) return;
    if (meeting.status !== 'scheduled') return;
    if (meeting.end < Date.now() - 30 * MINUTE) return;
    const entry: ScheduledMeeting = { meeting, timer: null, room: null };
    this.meetings.set(meeting.id, entry);
    entry.timer = setTimeout(() => this.openRoom(entry), Math.max(0, meeting.start - Date.now()));
  }

  // --- transport ------------------------------------------------------------

  private send(address: AgentAddress, message: ServerMessage): void {
    const connection = this.connections.get(address);
    if (!connection) return;
    this.sendSocket(connection.socket, message);
  }

  private sendSocket(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  private broadcastDirectory(): void {
    const agents = this.directory;
    for (const address of this.connections.keys()) {
      this.send(address, { type: 'directory.update', agents });
    }
  }

  shutdown(): void {
    for (const negotiation of this.negotiations.values()) clearTimeout(negotiation.timer);
    for (const entry of this.meetings.values()) if (entry.timer) clearTimeout(entry.timer);
    for (const connection of this.connections.values()) connection.socket.close();
    this.negotiations.clear();
    this.meetings.clear();
    this.connections.clear();
    this.hub.shutdown();
  }
}
