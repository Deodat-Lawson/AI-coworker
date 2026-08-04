#!/usr/bin/env node
/**
 * Relay process. One of these runs for a team; every desktop app connects to it.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

import { type Meeting, formatTime } from '@ai-coworker/shared';
import { WebSocketServer } from 'ws';

import { Accounts, LogMailer } from './accounts.js';
import { AuthHttp } from './auth-http.js';
import { Relay } from './relay.js';

const PORT = Number(process.env.PORT ?? process.env.AI_COWORKER_PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const STATE_FILE = process.env.AI_COWORKER_RELAY_STATE ?? path.join(process.cwd(), '.relay-state.json');
const WORKSPACE_FILE =
  process.env.AI_COWORKER_WORKSPACE_STATE ?? path.join(process.cwd(), '.relay-workspaces.json');
const ACCOUNT_FILE =
  process.env.AI_COWORKER_ACCOUNT_STATE ?? path.join(process.cwd(), '.relay-accounts.json');
/**
 * Off by default so a relay you start for a demo still works with no ceremony.
 * Set AI_COWORKER_REQUIRE_AUTH=1 and nothing connects without a verified
 * account — which is what you want for anything that is not your own laptop.
 */
const AUTH_MODE = process.env.AI_COWORKER_REQUIRE_AUTH ? 'required' : 'optional';

function log(message: string): void {
  console.log(`[relay ${new Date().toISOString()}] ${message}`);
}

const relayName = process.env.AI_COWORKER_RELAY_NAME ?? 'Stead';

const accounts = new Accounts({
  statePath: ACCOUNT_FILE,
  relayName,
  log,
  mailer: new LogMailer(log),
});

const relay = new Relay({
  log,
  auth: AUTH_MODE,
  accounts,
  hub: {
    statePath: WORKSPACE_FILE,
    relayName,
    defaultWorkspaceName: process.env.AI_COWORKER_WORKSPACE ?? 'Home',
  },
});

/**
 * Booked meetings survive a relay restart. Only the schedule is persisted —
 * transcripts and outcomes belong to the participants, not to the relay.
 */
function saveSchedule(): void {
  try {
    const meetings = relay.scheduledMeetings.filter((m) => m.status === 'scheduled');
    fs.writeFileSync(STATE_FILE, JSON.stringify({ meetings }, null, 2), 'utf8');
  } catch (err) {
    log(`could not persist schedule: ${(err as Error).message}`);
  }
}

function restoreSchedule(): void {
  let raw: string;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8');
  } catch {
    return; // no prior state
  }
  try {
    const { meetings } = JSON.parse(raw) as { meetings?: Meeting[] };
    let restored = 0;
    for (const meeting of meetings ?? []) {
      relay.restoreMeeting(meeting);
      restored++;
    }
    if (restored) log(`restored ${restored} scheduled meeting(s) from ${STATE_FILE}`);
  } catch (err) {
    log(`ignoring unreadable relay state: ${(err as Error).message}`);
  }
}

relay.on('meeting.scheduled', saveSchedule);
relay.on('meeting.ended', saveSchedule);

const auth = new AuthHttp({ accounts, hub: relay.hub, relayName, log });

const server = http.createServer((req, res) => {
  // Sign-up and sign-in come before anything else: they are the only endpoints
  // somebody can reach before they have an identity.
  if ((req.url ?? '').startsWith('/auth/')) {
    void auth.handle(req, res);
    return;
  }
  if (req.url === '/health' || req.url === '/') {
    const body = JSON.stringify(
      {
        ok: true,
        service: 'ai-coworker-relay',
        online: relay.onlineCount,
        workspaces: relay.hub.size,
        accounts: accounts.size,
        auth: AUTH_MODE,
        home: relay.hub.homeWorkspaceId,
        agents: relay.directory.map((a) => ({
          address: a.address,
          name: a.displayName,
          title: a.title,
          role: a.role,
        })),
        meetings: relay.scheduledMeetings.map((m) => ({
          id: m.id,
          title: m.title,
          start: formatTime(m.start),
          participants: m.participants,
          status: m.status,
        })),
      },
      null,
      2,
    );
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

const wss = new WebSocketServer({ server });
wss.on('connection', (socket) => relay.handleConnection(socket));

relay.on('meeting.live', (meeting: { title: string }) => log(`live: "${meeting.title}"`));

server.listen(PORT, HOST, () => {
  log(`listening on ws://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  log(`health: http://localhost:${PORT}/health`);
  log(`sign-in: http://localhost:${PORT}/auth/config (accounts ${AUTH_MODE})`);
  restoreSchedule();
});

function shutdown(): void {
  log('shutting down');
  accounts.shutdown();
  relay.shutdown();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
