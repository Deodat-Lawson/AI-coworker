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

import {
  SENSITIVITY_ORDER,
  decideAccess,
  formatSelector,
  formatTime,
  truncate,
} from '@ai-coworker/shared';

import { PersonalAgent } from './agent.js';
import { detectSources, inspectFolder } from './connectors/index.js';
import { loadEnvFromAncestors } from './env.js';
import { createProvider } from './llm/index.js';
import { MemoryIndex, syncMemory } from './memory/index.js';

// Pick up GEMINI_API_KEY from a .env beside the repo before anything reads it.
loadEnvFromAncestors();
import { PERSONAS, findPersona, seedWorkspace } from './seed.js';
import { Workspace } from './store.js';

interface Args {
  command: string;
  /** Positional tokens after the command, e.g. `memory sync` → ["sync"]. */
  rest: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...tail] = argv;
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const token = tail[i]!;
    if (!token.startsWith('--')) {
      rest.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = tail[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { command, rest, flags };
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

// --- memory ------------------------------------------------------------------

/**
 * The pipeline from a terminal. Everything the desktop app does with imported
 * memory is available here, because a headless agent on a server has the same
 * three questions: what is on this machine, what did I take from it, and who am
 * I allowed to tell.
 */
async function cmdMemory(args: Args): Promise<void> {
  const sub = args.rest[0] ?? 'status';
  const dir = str(args.flags, 'dir') || defaultDir(str(args.flags, 'persona'));
  const ws = await Workspace.open(dir);
  const index = await MemoryIndex.open(dir);
  // Access decisions need someone to be relative to; an un-onboarded workspace
  // still has an owner, it just has no name yet.
  const owner = ws.profile.address
    ? ws.profile
    : { ...ws.profile, address: 'me@local', reports: [] as string[] };

  switch (sub) {
    case 'sources': {
      const detected = await detectSources();
      const connected = new Map(index.sources.map((s) => [s.id, s]));
      console.log(`Detected ${detected.length} source(s) on this machine:\n`);
      for (const source of detected) {
        const state = connected.get(source.id);
        const status = !state
          ? 'not connected'
          : !state.enabled
            ? 'disabled'
            : state.lastSyncAt
              ? `synced ${formatTime(state.lastSyncAt, ws.profile.timezone)}`
              : 'connected, never synced';
        console.log(`  ${source.id}\n    ${source.label} — ${source.detail}\n    ${status}`);
      }
      const missing = index.sources.filter((s) => !detected.some((d) => d.id === s.id));
      if (missing.length) {
        console.log('\nConnected but not found right now:');
        for (const state of missing) console.log(`  ${state.id} (${state.root})`);
      }
      break;
    }

    case 'connect': {
      const folder = str(args.flags, 'folder') || args.rest[1];
      if (!folder) throw new Error('Pass --folder <path> to connect a directory of memories.');
      const source = await inspectFolder(folder);
      if (!source) throw new Error(`No MEMORY.md, AGENTS.md or memory/ directory under ${folder}`);
      await index.connectSource(source, true);
      await index.flush();
      console.log(`Connected ${source.label} (${source.detail}). Run "memory sync" to import it.`);
      break;
    }

    case 'disconnect': {
      const sourceId = str(args.flags, 'source') || args.rest[1] || '';
      if (!sourceId) throw new Error('Pass --source <id>. See "memory sources".');
      const purge = Boolean(args.flags.purge);
      const removed = await index.removeSource(sourceId, { purge });
      await index.flush();
      console.log(purge ? `Disconnected ${sourceId} and forgot ${removed} memories.` : `Disconnected ${sourceId}.`);
      break;
    }

    case 'sync': {
      const report = await syncMemory(index, {
        full: Boolean(args.flags.full),
        only: str(args.flags, 'source') ? [str(args.flags, 'source')] : undefined,
        autoConnect: args.flags['no-connect'] ? false : true,
        onProgress: (message) => console.log(`  ${message}`),
      });
      const t = report.totals;
      console.log(
        `\n${t.added} new, ${t.updated} updated, ${t.unchanged} unchanged, ${t.duplicates} duplicate, ` +
          `${t.rejected} skipped, ${t.quarantined} quarantined in ${t.durationMs}ms`,
      );
      if (t.errors.length) console.log(`problems:\n${t.errors.map((e) => `  - ${e}`).join('\n')}`);
      if (report.discovered.length) {
        console.log(`\nFound but not connected:\n${report.discovered.map((d) => `  - ${d.id}`).join('\n')}`);
      }
      break;
    }

    case 'list': {
      const audience = str(args.flags, 'as');
      const hits = index.query({
        owner,
        requester: audience ? { address: audience, role: str(args.flags, 'role') as never, team: str(args.flags, 'team') } : undefined,
        text: str(args.flags, 'query') || args.rest.slice(1).join(' '),
        limit: Number(str(args.flags, 'limit', '20')) || 20,
      });
      if (!hits.length) {
        console.log(audience ? `Nothing I would share with ${audience}.` : 'Nothing matches.');
        break;
      }
      for (const hit of hits) {
        const tag = hit.shared.level === 'full' ? '   ' : ' ✋';
        console.log(`${tag} ${hit.record.id}  [${hit.record.policy.sensitivity}] ${hit.record.title}`);
        console.log(`      ${hit.record.sourceLabel} · ${hit.record.policy.topics.join(', ')}`);
        if (hit.shared.level !== 'full') console.log(`      withheld: ${hit.decision.reason}`);
      }
      break;
    }

    case 'show': {
      const recordId = str(args.flags, 'id') || args.rest[1] || '';
      const record = index.record(recordId);
      if (!record) throw new Error(`No memory with id ${recordId}`);
      console.log(`${record.title}\n`);
      console.log(`  id          ${record.id}`);
      console.log(`  from        ${record.sourceLabel} (${record.origin.path ?? record.externalId})`);
      console.log(`  sensitivity ${record.policy.sensitivity}${record.policy.pinned ? ' (set by you)' : ' (auto)'}`);
      console.log(`  topics      ${record.policy.topics.join(', ')}`);
      console.log(`  why         ${record.policy.rationale}`);
      if (record.policy.allow.length) console.log(`  allow       ${record.policy.allow.map(formatSelector).join(', ')}`);
      if (record.policy.deny.length) console.log(`  deny        ${record.policy.deny.map(formatSelector).join(', ')}`);
      console.log(`  status      ${record.status}\n`);
      console.log(record.body);
      break;
    }

    case 'policy': {
      const recordId = str(args.flags, 'id') || args.rest[1] || '';
      if (!index.record(recordId)) throw new Error(`No memory with id ${recordId}`);
      const sensitivity = str(args.flags, 'sensitivity');
      if (sensitivity) {
        if (!SENSITIVITY_ORDER.includes(sensitivity as never)) {
          throw new Error(`Sensitivity must be one of: ${SENSITIVITY_ORDER.join(', ')}`);
        }
        await index.setPolicy(recordId, { sensitivity: sensitivity as never });
      }
      for (const selector of str(args.flags, 'allow').split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!(await index.grant(recordId, selector))) throw new Error(`Could not parse audience "${selector}"`);
      }
      for (const selector of str(args.flags, 'deny').split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!(await index.revoke(recordId, selector))) throw new Error(`Could not parse audience "${selector}"`);
      }
      await index.flush();
      const updated = index.record(recordId)!;
      console.log(
        `${updated.title}\n  sensitivity ${updated.policy.sensitivity}\n` +
          `  allow       ${updated.policy.allow.map(formatSelector).join(', ') || '(default)'}\n` +
          `  deny        ${updated.policy.deny.map(formatSelector).join(', ') || '(none)'}`,
      );
      break;
    }

    case 'forget': {
      const recordId = str(args.flags, 'id') || args.rest[1] || '';
      const record = index.record(recordId);
      if (!record) throw new Error(`No memory with id ${recordId}`);
      await index.forget(recordId);
      await index.flush();
      console.log(`Forgot "${record.title}".`);
      break;
    }

    case 'ask': {
      // "If Dana asked me this, what would I say?" — the whole permission model
      // in one command.
      const audience = str(args.flags, 'as');
      if (!audience) throw new Error('Pass --as <agent address> to test what you would share.');
      const question = str(args.flags, 'query') || args.rest.slice(1).join(' ');
      const requester = {
        address: audience,
        role: (str(args.flags, 'role') || undefined) as never,
        team: str(args.flags, 'team') || undefined,
      };
      const hits = index.query({ owner, requester, text: question, limit: 10 });
      console.log(`If ${audience} asked "${question}":\n`);
      if (!hits.length) {
        console.log('  I would say I have nothing on that for them.');
        break;
      }
      for (const hit of hits) {
        if (hit.shared.level === 'full') {
          console.log(`  SHARE   ${hit.record.title}\n          ${truncate(hit.shared.body ?? '', 200)}`);
        } else {
          console.log(`  WITHOLD ${hit.shared.gist}\n          ${hit.decision.reason}`);
        }
      }
      const blocked = index.records.filter((r) => {
        if (r.status !== 'active') return false;
        const decision = decideAccess(r.policy, { owner, requester });
        return decision.level === 'none';
      });
      console.log(`\n  ${blocked.length} memories would not be mentioned at all.`);
      break;
    }

    case 'status':
    default: {
      const coverage = index.coverage(await detectSources());
      console.log(`${coverage.active} memories (${coverage.quarantined} quarantined) in ${dir}/memory\n`);
      for (const row of coverage.byKind) {
        console.log(
          `  ${row.kind.padEnd(12)} ${String(row.memories).padStart(4)} memories  ${row.sources} source(s)  ` +
            (row.lastSyncAt ? formatTime(row.lastSyncAt, ws.profile.timezone) : 'never synced'),
        );
      }
      if (coverage.bySensitivity.length) {
        console.log(`\n  ${coverage.bySensitivity.map((s) => `${s.count} ${s.level}`).join(', ')}`);
      }
      if (coverage.unconnected.length) {
        console.log('\n  Not connected yet:');
        for (const source of coverage.unconnected) console.log(`    - ${source.label} (${source.detail})`);
      }
      if (coverage.staleSources.length) {
        console.log('\n  Stale:');
        for (const source of coverage.staleSources) console.log(`    - ${source.label}`);
      }
      if (coverage.failing.length) {
        console.log('\n  Could not be read:');
        for (const source of coverage.failing) console.log(`    - ${source.label}: ${source.errors.join('; ')}`);
      }
      break;
    }
  }

  await index.flush();
}

function usage(): void {
  console.log(`ai-coworker-agent — run a personal AI agent headlessly

  run    --dir <path> [--persona <key>] [--relay ws://host:port]
         [--request "with=sarah,marcus;purpose=...;title=...;kind=standup;duration=30"]
         [--start-now] [--exit-after-meeting] [--timeout <secs>]

  chat   --dir <path> [--persona <key>] --message "book a sync with Sarah"

  seed   --persona <key> [--dir <path>]

  memory <subcommand> [--dir <path>] [--persona <key>]
         status                      what is connected, what is not, how fresh
         sources                     every memory store found on this machine
         sync [--full] [--source id] import what changed (connects new sources)
         connect --folder <path>     add any directory of memory files
         disconnect --source <id> [--purge]
         list [--query text] [--as <address>] [--limit n]
         show --id <memory id>
         policy --id <id> [--sensitivity public|internal|confidential|restricted|secret]
                          [--allow team:platform,dana@acme] [--deny role:ic]
         ask --as <address> --query "what about revenue"
         forget --id <memory id>

Personas: ${PERSONAS.map((p) => `${p.key} (${p.profile.displayName})`).join(', ')}
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case 'run':
      await cmdRun(args.flags);
      break;
    case 'chat':
      await cmdChat(args.flags);
      break;
    case 'seed':
      await cmdSeed(args.flags);
      break;
    case 'memory':
      await cmdMemory(args);
      break;
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
});
