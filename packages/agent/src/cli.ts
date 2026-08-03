#!/usr/bin/env node
/**
 * Headless agent runner.
 *
 * The desktop app is the product, but a personal agent is just a process with a
 * knowledge base and a socket — so it also runs from a terminal. This is what
 * the five-person demo drives.
 */

import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

import { formatTime } from '@ai-coworker/shared';

import { PersonalAgent } from './agent.js';
import { loadEnvFromAncestors } from './env.js';
import { createProvider } from './llm/index.js';

// Pick up GEMINI_API_KEY from a .env beside the repo before anything reads it.
loadEnvFromAncestors();
import { PERSONAS, findPersona, seedWorkspace } from './seed.js';
import { Workspace } from './store.js';

interface Args {
  command: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

function str(flags: Args['flags'], key: string, fallback = ''): string {
  const v = flags[key];
  return typeof v === 'string' ? v : fallback;
}

function defaultDir(persona: string): string {
  return path.join(os.homedir(), '.ai-coworker', persona || 'default');
}

async function openWorkspace(flags: Args['flags']): Promise<Workspace> {
  const personaKey = str(flags, 'persona');
  const dir = str(flags, 'dir') || defaultDir(personaKey);
  const ws = await Workspace.open(dir);
  if (personaKey) {
    const persona = findPersona(personaKey);
    if (!persona) throw new Error(`Unknown persona "${personaKey}". Known: ${PERSONAS.map((p) => p.key).join(', ')}`);
    if (!ws.profile.address) await seedWorkspace(ws, persona);
  }
  if (!ws.profile.address) {
    throw new Error('This workspace has no profile. Pass --persona to seed one, or use the desktop app.');
  }
  return ws;
}

/** `--request "with=sarah,marcus;purpose=Weekly sync;title=Weekly;kind=standup;duration=30"` */
function parseRequest(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of spec.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

async function cmdRun(flags: Args['flags']): Promise<void> {
  const ws = await openWorkspace(flags);
  const relayUrl = str(flags, 'relay', process.env.AI_COWORKER_RELAY || 'ws://localhost:8787');
  const { provider, reason } = createProvider();
  const agent = new PersonalAgent({ workspace: ws, relayUrl, provider, providerReason: reason });

  const tag = ws.profile.displayName || ws.profile.address;
  const log = (msg: string) => console.log(`[${tag}] ${msg}`);
  log(`brain: ${provider.name} (${reason})`);
  log(`workspace: ${ws.root}`);

  agent.on('connection', (state: string, error: string | null) => {
    log(`relay ${state}${error ? `: ${error}` : ''}`);
  });
  agent.on('activity', (a: { kind: string; text: string }) => log(`${a.kind}: ${a.text}`));

  // `meeting.update` also fires for phase and turn changes, so print each
  // transcript entry once rather than re-printing the tail.
  const printed = new Set<string>();
  agent.on('meeting.update', (state: { transcript: { id: string; speaker: string; kind: string; text: string }[] }) => {
    for (const entry of state.transcript) {
      if (printed.has(entry.id)) continue;
      printed.add(entry.id);
      if (entry.speaker === 'moderator') continue;
      log(`  ${entry.speaker} (${entry.kind}): ${entry.text.slice(0, 160)}`);
    }
  });

  let exiting = false;
  const finish = async (code = 0) => {
    if (exiting) return;
    exiting = true;
    await agent.shutdown();
    process.exit(code);
  };

  agent.on('meeting.ended', async (outcome: { headline: string; summary: string }) => {
    log(`BRIEFING: ${outcome.headline}`);
    log(`  ${outcome.summary}`);
    if (flags['exit-after-meeting']) {
      await ws.flush();
      setTimeout(() => void finish(0), 1500);
    }
  });

  const requestSpec = str(flags, 'request');
  if (requestSpec) {
    const spec = parseRequest(requestSpec);
    const waitForDirectory = () =>
      new Promise<void>((resolve) => {
        const wanted = (spec.with ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const check = () => {
          const known = agent.directory.map((d) => d.address);
          const resolvedAll = wanted.every((w) =>
            known.some((k) => k.startsWith(`${w}@`) || k === w) ||
            agent.directory.some((d) => d.displayName.toLowerCase().includes(w.toLowerCase())),
          );
          if (resolvedAll && agent.connectionState === 'online') {
            agent.off('directory', check);
            resolve();
          }
        };
        agent.on('directory', check);
        setTimeout(() => {
          agent.off('directory', check);
          resolve();
        }, 15_000);
        check();
      });

    await waitForDirectory();

    const participants = (spec.with ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((needle) => {
        const hit = agent.directory.find(
          (d) =>
            d.address === needle ||
            d.address.startsWith(`${needle}@`) ||
            d.displayName.toLowerCase().includes(needle.toLowerCase()),
        );
        return hit?.address ?? needle;
      });

    const result = agent.requestMeeting({
      participants,
      title: spec.title || 'Team sync',
      purpose: spec.purpose || 'Progress update and next steps.',
      kind: (spec.kind as never) || 'standup',
      durationMins: spec.duration ? Number(spec.duration) : 30,
      urgency: (spec.urgency as never) || 'asap',
      agenda: spec.agenda ? spec.agenda.split('|') : [],
    });
    log(result.ok ? 'meeting requested' : `meeting request failed: ${result.error}`);

    if (flags['start-now']) {
      agent.on('meeting.scheduled', (meeting: { id: string; title: string; start: number }) => {
        log(`booked "${meeting.title}" for ${formatTime(meeting.start, ws.profile.timezone)} — starting it now`);
        setTimeout(() => agent.startMeetingNow(meeting.id), 600);
      });
    }
  }

  process.on('SIGINT', () => void finish(0));
  process.on('SIGTERM', () => void finish(0));

  const timeoutSecs = Number(str(flags, 'timeout', '0'));
  if (timeoutSecs > 0) {
    setTimeout(() => {
      log('timeout reached, shutting down');
      void finish(0);
    }, timeoutSecs * 1000).unref?.();
  }
}

async function cmdChat(flags: Args['flags']): Promise<void> {
  const ws = await openWorkspace(flags);
  const relayUrl = str(flags, 'relay', process.env.AI_COWORKER_RELAY || 'ws://localhost:8787');
  const agent = new PersonalAgent({ workspace: ws, relayUrl });
  const message = str(flags, 'message');
  if (!message) throw new Error('Pass --message "..."');

  // Give the directory a moment to arrive so "book with Sarah" can resolve.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const output = await agent.chat(message);
  for (const action of output.actions) console.log(`  · ${action.tool}: ${action.result.split('\n')[0]}`);
  console.log(output.reply);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await agent.shutdown();
  process.exit(0);
}

async function cmdSeed(flags: Args['flags']): Promise<void> {
  const personaKey = str(flags, 'persona');
  const persona = findPersona(personaKey);
  if (!persona) throw new Error(`Unknown persona "${personaKey}". Known: ${PERSONAS.map((p) => p.key).join(', ')}`);
  const dir = str(flags, 'dir') || defaultDir(persona.key);
  const ws = await Workspace.open(dir);
  await seedWorkspace(ws, persona);
  await ws.flush();
  console.log(`Seeded ${persona.profile.displayName} at ${dir}`);
}

function usage(): void {
  console.log(`ai-coworker-agent — run a personal AI agent headlessly

  run    --dir <path> [--persona <key>] [--relay ws://host:port]
         [--request "with=sarah,marcus;purpose=...;title=...;kind=standup;duration=30"]
         [--start-now] [--exit-after-meeting] [--timeout <secs>]

  chat   --dir <path> [--persona <key>] --message "book a sync with Sarah"

  seed   --persona <key> [--dir <path>]

Personas: ${PERSONAS.map((p) => `${p.key} (${p.profile.displayName})`).join(', ')}
`);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'run':
      await cmdRun(flags);
      break;
    case 'chat':
      await cmdChat(flags);
      break;
    case 'seed':
      await cmdSeed(flags);
      break;
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
});
