/**
 * The relay: directory, scheduling, and meeting rooms.
 *
 * What it deliberately does not do: read anyone's knowledge base, summarize
 * anything, or generate a single word of meeting content. Those all belong to
 * the personal agents. The relay is closer to a switchboard plus a meeting-room
 * booking system than to a chatbot.
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
} from '@ai-coworker/shared';
import type { WebSocket } from 'ws';

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
}

export class Relay extends EventEmitter {
  private connections = new Map<AgentAddress, Connection>();
  private negotiations = new Map<string, Negotiation>();
  private meetings = new Map<string, ScheduledMeeting>();
  private options: Required<Omit<RelayOptions, 'onMeetingEnded'>> & Pick<RelayOptions, 'onMeetingEnded'>;

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
      onMeetingEnded: options.onMeetingEnded,
    };
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
        address = this.handleHello(socket, message.profile);
        return;
      }

      if (!address) {
        this.sendSocket(socket, { type: 'error', code: 'no_hello', message: 'Send hello first.' });
        return;
      }
      try {
        this.handleMessage(address, message);
      } catch (err) {
        this.options.log(`error handling ${message.type} from ${address}: ${(err as Error).message}`);
        this.sendSocket(socket, {
          type: 'error',
          code: 'handler_error',
          message: (err as Error).message,
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
        this.broadcastDirectory();
        this.emit('directory', this.directory);
      }
    });

    socket.on('error', () => {
      /* 'close' handles cleanup */
    });
  }

  private handleHello(socket: WebSocket, profile: PublicProfile): AgentAddress | null {
    if (!profile?.address || typeof profile.address !== 'string') {
      this.sendSocket(socket, { type: 'error', code: 'bad_profile', message: 'Profile needs an address.' });
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
      protocolVersion: '1.0.0',
    });
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
    const offline = participants.filter((p) => !this.connections.has(p));
    const negotiationId = id('neg');

    if (offline.length) {
      this.send(organizer, {
        type: 'meeting.failed',
        negotiationId,
        reason: `Not reachable: ${offline.join(', ')}. Their agent needs to be online to negotiate a time.`,
        offered: {},
      });
      return;
    }

    const request: MeetingRequest = { ...input, participants, negotiationId, organizer };
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
    this.emit('meeting.scheduled', meeting);
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
        this.options.onMeetingEnded?.(finished);
        this.emit('meeting.ended', finished);
      },
    });
    entry.room = room;
    this.options.log(`opening room for "${entry.meeting.title}"`);
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
  }
}
