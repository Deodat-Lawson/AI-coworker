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

import { Relay } from './relay.js';

const PORT = Number(process.env.PORT ?? process.env.AI_COWORKER_PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const STATE_FILE = process.env.AI_COWORKER_RELAY_STATE ?? path.join(process.cwd(), '.relay-state.json');
const WORKSPACE_FILE =
  process.env.AI_COWORKER_WORKSPACE_STATE ?? path.join(process.cwd(), '.relay-workspaces.json');

function log(message: string): void {
  console.log(`[relay ${new Date().toISOString()}] ${message}`);
}

const relay = new Relay({
  log,
  hub: {
    statePath: WORKSPACE_FILE,
    relayName: process.env.AI_COWORKER_RELAY_NAME ?? 'Stead',
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

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const body = JSON.stringify(
      {
        ok: true,
        service: 'ai-coworker-relay',
        online: relay.onlineCount,
        workspaces: relay.hub.size,
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
  restoreSchedule();
});

function shutdown(): void {
  log('shutting down');
  relay.shutdown();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
