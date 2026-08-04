import { EventEmitter } from 'node:events';

import {
  type ClientMessage,
  type PublicProfile,
  type ServerMessage,
  CLIENT_CAPABILITIES,
  PROTOCOL_VERSION,
  parseServerMessage,
} from '@ai-coworker/shared';
import WebSocket from 'ws';

export type ConnectionState = 'offline' | 'connecting' | 'online' | 'error';

export interface RelayClientOptions {
  url: string;
  profile: () => PublicProfile;
  /**
   * The session this agent connects as, when the relay has accounts. Read
   * afresh on every connect so signing in or out takes effect on reconnect
   * rather than needing the process restarted.
   */
  sessionToken?: () => string | undefined;
  /** Exponential backoff ceiling. */
  maxBackoffMs?: number;
  autoReconnect?: boolean;
}

/**
 * Thin, reconnecting WebSocket transport to the relay. It owns connection
 * lifecycle only — every protocol decision lives in PersonalAgent.
 */
export class RelayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private options: RelayClientOptions;
  private backoff = 500;
  private stopped = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  state: ConnectionState = 'offline';
  lastError: string | null = null;

  constructor(options: RelayClientOptions) {
    super();
    this.options = { maxBackoffMs: 15_000, autoReconnect: true, ...options };
  }

  get url(): string {
    return this.options.url;
  }

  setUrl(url: string): void {
    this.options.url = url;
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  private setState(state: ConnectionState, error?: string): void {
    this.state = state;
    this.lastError = error ?? (state === 'error' ? this.lastError : null);
    this.emit('state', state, this.lastError);
  }

  private open(): void {
    if (this.ws) return;
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.options.url);
    } catch (err) {
      this.setState('error', (err as Error).message);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.backoff = 500;
      this.send({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        profile: this.options.profile(),
        capabilities: CLIENT_CAPABILITIES,
        sessionToken: this.options.sessionToken?.(),
      });
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 20_000);
    });

    ws.on('message', (data) => {
      const message = parseServerMessage(data.toString());
      if (!message) return;
      if (message.type === 'hello.ok') this.setState('online');
      this.emit('message', message);
    });

    ws.on('close', () => {
      this.cleanup();
      if (this.state !== 'error') this.setState('offline');
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.setState('error', (err as Error).message);
      // 'close' follows and drives the reconnect.
    });
  }

  private cleanup(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.options.autoReconnect) return;
    if (this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.options.maxBackoffMs!);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
    // Do not keep a CLI process alive purely to retry a dead relay.
    this.reconnectTimer.unref?.();
  }

  send(message: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.cleanup();
    ws?.close();
    this.setState('offline');
  }
}

export type { ServerMessage };
