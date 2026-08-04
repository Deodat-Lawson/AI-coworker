/**
 * Every relay this person's agent is connected to.
 *
 * One workspace lives on one relay, but a person can belong to workspaces on
 * several — a work relay and a side-project relay are simply two sockets. The
 * network keeps one {@link RelayClient} per URL and hands the source client to
 * every message listener, so the agent always knows which relay to answer.
 */

import { EventEmitter } from 'node:events';

import type { ClientMessage, PublicProfile, ServerMessage } from '@ai-coworker/shared';

import { RelayClient, type ConnectionState } from './relay-client.js';

export interface RelayNetworkOptions {
  /** The session to present on a given relay, if this person has signed in. */
  sessionToken?: (relayUrl: string) => string | undefined;
  profile: () => PublicProfile;
  autoConnect?: boolean;
}

export class RelayNetwork extends EventEmitter {
  private clients = new Map<string, RelayClient>();
  private order: string[] = [];
  private options: RelayNetworkOptions;

  constructor(options: RelayNetworkOptions) {
    super();
    this.options = options;
  }

  get urls(): string[] {
    return [...this.order];
  }

  /** The first relay added: where meetings and the directory come from. */
  get primary(): RelayClient {
    const url = this.order[0];
    if (!url) throw new Error('No relay configured.');
    return this.clients.get(url)!;
  }

  get clientList(): RelayClient[] {
    return this.order.map((url) => this.clients.get(url)!);
  }

  client(url: string): RelayClient | undefined {
    return this.clients.get(url);
  }

  has(url: string): boolean {
    return this.clients.has(url);
  }

  add(url: string): RelayClient {
    const existing = this.clients.get(url);
    if (existing) return existing;

    const client = new RelayClient({
      url,
      profile: this.options.profile,
      sessionToken: () => this.options.sessionToken?.(url),
    });
    this.clients.set(url, client);
    this.order.push(url);

    client.on('message', (message: ServerMessage) => this.emit('message', message, client));
    client.on('state', (state: ConnectionState, error: string | null) =>
      this.emit('state', state, error, client),
    );
    if (this.options.autoConnect !== false) client.connect();
    this.emit('relays', this.urls);
    return client;
  }

  remove(url: string): void {
    const client = this.clients.get(url);
    if (!client) return;
    client.removeAllListeners();
    client.close();
    this.clients.delete(url);
    this.order = this.order.filter((u) => u !== url);
    this.emit('relays', this.urls);
  }

  /** Point the primary relay at a new address, keeping any others in place. */
  replacePrimary(url: string): RelayClient {
    const current = this.order[0];
    if (current === url) return this.primary;
    if (current) this.remove(current);
    const client = this.add(url);
    this.order = [url, ...this.order.filter((u) => u !== url)];
    return client;
  }

  send(url: string, message: ClientMessage): boolean {
    return this.clients.get(url)?.send(message) ?? false;
  }

  connect(): void {
    for (const client of this.clients.values()) client.connect();
  }

  close(): void {
    for (const client of this.clients.values()) client.close();
  }

  /** Worst-case view across relays, for a single status line. */
  get state(): ConnectionState {
    const states = this.clientList.map((c) => c.state);
    if (!states.length) return 'offline';
    if (states.includes('online')) return 'online';
    if (states.includes('connecting')) return 'connecting';
    if (states.includes('error')) return 'error';
    return 'offline';
  }
}
