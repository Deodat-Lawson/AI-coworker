#!/usr/bin/env node
/**
 * The five-person demo.
 *
 * Starts a relay and five independent agent processes — one per person, each
 * with its own knowledge base on disk — then has the manager's agent book a
 * meeting and run it. Nobody's human attends.
 *
 *   node scripts/demo.mjs             # everyone, full meeting
 *   node scripts/demo.mjs --keep      # leave it running afterwards
 *   node scripts/demo.mjs --people dana,sarah,tom
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'demo-data');
const PORT = Number(process.env.PORT ?? 8799);
const RELAY = `ws://127.0.0.1:${PORT}`;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const people = value('people', 'dana,sarah,marcus,priya,tom').split(',').map((p) => p.trim());
const chair = people[0];
const others = people.slice(1);
const keep = flag('keep');
const fresh = !flag('reuse');

const children = [];
const COLORS = ['\x1b[36m', '\x1b[32m', '\x1b[35m', '\x1b[33m', '\x1b[34m', '\x1b[31m'];
const RESET = '\x1b[0m';

function run(label, command, argv, env = {}, colorIndex = 0) {
  const color = COLORS[colorIndex % COLORS.length];
  const child = spawn(command, argv, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pipe = (stream, isError) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        process.stdout.write(`${color}${label.padEnd(8)}${RESET} ${isError ? '\x1b[31m' : ''}${line}${RESET}\n`);
      }
    });
  };
  pipe(child.stdout, false);
  pipe(child.stderr, true);
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 400);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForRelay(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('relay did not start');
}

async function onlineCount() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    const body = await res.json();
    return body.online ?? 0;
  } catch {
    return 0;
  }
}

console.log(`\n  Stead — ${people.length}-person demo`);
console.log(`  ${people.join(', ')} · chair: ${chair}`);
console.log(`  relay ${RELAY} · data ${path.relative(root, dataDir)}`);
console.log('  everyone lands in the "Northwind" workspace; open the desktop app on the same');
console.log(`  relay to watch the channels fill up\n`);

if (fresh) await fs.rm(dataDir, { recursive: true, force: true });
await fs.mkdir(dataDir, { recursive: true });

run(
  'relay',
  process.execPath,
  ['packages/server/dist/main.js'],
  {
    PORT: String(PORT),
    AI_COWORKER_WORKSPACE: 'Northwind',
    // Keep the demo's workspace state beside its knowledge bases, so
    // `--reuse` picks up where the last run left off and a fresh run starts
    // from nothing.
    AI_COWORKER_WORKSPACE_STATE: path.join(dataDir, 'relay-workspaces.json'),
    AI_COWORKER_RELAY_STATE: path.join(dataDir, 'relay-schedule.json'),
  },
  0,
);
await waitForRelay();

// Each person is a separate OS process with its own knowledge base directory —
// the same shape as five people on five machines.
people.forEach((person, index) => {
  const isChair = person === chair;
  const argv = [
    'packages/agent/dist/cli.js',
    'run',
    '--persona',
    person,
    '--dir',
    path.join(dataDir, person),
    '--relay',
    RELAY,
  ];
  if (isChair) {
    argv.push(
      '--request',
      [
        `with=${others.join(',')}`,
        'title=Weekly platform sync',
        'purpose=Status on the auth migration and the billing launch, then next week\'s work.',
        'kind=standup',
        'duration=30',
        'urgency=asap',
        'agenda=Auth migration|Billing dashboard|On-call load',
      ].join(';'),
      '--start-now',
    );
    if (!keep) argv.push('--exit-after-meeting');
  }
  run(person, process.execPath, argv, {}, index + 1);
});

// Give every agent time to register before the chair asks for a slot.
const deadline = Date.now() + 20_000;
while ((await onlineCount()) < people.length && Date.now() < deadline) await sleep(300);
console.log(`\n  ${await onlineCount()}/${people.length} agents online — booking the meeting\n`);

/** Read every briefing a person's agent has written to disk. */
async function briefingsFor(person) {
  const dir = path.join(dataDir, person, 'meetings');
  const files = await fs.readdir(dir).catch(() => []);
  const out = [];
  for (const file of files) {
    try {
      const record = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
      if (record.outcome) out.push(record.outcome);
    } catch {
      /* mid-write; try again on the next poll */
    }
  }
  return out;
}

if (!keep) {
  const chairChild = children[1];
  chairChild.on('close', async () => {
    // Every agent writes its own briefing, and one may still be waiting out a
    // model rate limit — poll rather than guessing with a fixed sleep.
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const counts = await Promise.all(people.map((p) => briefingsFor(p).then((b) => b.length)));
      if (counts.every((c) => c > 0)) break;
      await sleep(1000);
    }

    console.log('\n  Meeting finished. Briefings and tasks are in demo-data/<person>/.\n');
    for (const person of people) {
      const outcomes = await briefingsFor(person);
      if (!outcomes.length) {
        console.log(`  ${person}: (no briefing written — the agent may still be rate limited)`);
        continue;
      }
      for (const outcome of outcomes) {
        console.log(`  ${person}: ${outcome.headline}`);
        for (const task of outcome.myTasks) console.log(`      → ${task.title}`);
        for (const question of outcome.openQuestionsForHuman) console.log(`      ? ${question}`);
      }
    }
    console.log('');
    shutdown(0);
  });
} else {
  console.log('  Running with --keep. Ctrl-C to stop.\n');
}
