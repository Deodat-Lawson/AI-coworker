/**
 * Codex.
 *
 *   ~/.codex/AGENTS.md            standing instructions
 *   ~/.codex/memories/*.md        distilled memories, when the feature is on
 *   ~/.codex/memories_*.sqlite    the same, once they move into the database
 *   ~/.codex/session_index.jsonl  thread id → the name Codex gave the thread
 *   ~/.codex/sessions/**.jsonl    one rollout per thread
 *
 * Rollouts are transcripts, and a transcript is not a memory. What is imported
 * from one is only what the tool already stated about itself: which directory
 * the work happened in, what the thread was called, and the first thing the
 * human actually typed — verbatim, with the machine preamble stripped. No
 * summarizing, so nothing can be invented here.
 *
 * The sqlite path degrades on purpose. `node:sqlite` is a recent addition; when
 * it is missing the run records "could not read" against that source rather
 * than failing, which is exactly the kind of gap the coverage report exists to
 * show.
 */

import path from 'node:path';

import type { DetectedSource, RawMemory } from '@ai-coworker/shared';

import { type Connector, type ConnectorContext, type ReadOptions, memory } from './types.js';
import {
  basenameOf,
  listFiles,
  meaningful,
  readHead,
  readTextIfExists,
  sessionBody,
  statSafe,
  stripInjectedBlocks,
  titleFrom,
  truncateBody,
  walkFiles,
} from './util.js';

/** Enough of a rollout to carry its metadata and opening request. */
const TRANSCRIPT_SCAN_BYTES = 256_000;

function codexHome(ctx: ConnectorContext): string {
  return ctx.env.CODEX_HOME || path.join(ctx.home, '.codex');
}

interface ThreadName {
  id: string;
  name: string;
  updatedAt: number;
}

async function threadNames(root: string): Promise<Map<string, ThreadName>> {
  const out = new Map<string, ThreadName>();
  const raw = await readTextIfExists(path.join(root, 'session_index.jsonl'));
  if (!raw) return out;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { id?: string; thread_name?: string; updated_at?: string };
      if (!parsed.id || !parsed.thread_name) continue;
      out.set(parsed.id, {
        id: parsed.id,
        name: parsed.thread_name,
        updatedAt: parsed.updated_at ? Date.parse(parsed.updated_at) || 0 : 0,
      });
    } catch {
      // Index lines are appended live; a torn last line is expected.
    }
  }
  return out;
}

/** Session id is the tail of `rollout-<iso>-<uuid>.jsonl`. */
function sessionIdFromFile(file: string): string {
  const match = /rollout-[\dT-]+-([0-9a-f-]{36})\.jsonl$/i.exec(basenameOf(file));
  return match?.[1] ?? basenameOf(file).replace(/\.jsonl$/, '');
}

interface RolloutFacts {
  cwd?: string;
  startedAt?: number;
  firstUserMessage?: string;
}

/**
 * Pull the few stated facts out of a rollout without reading all of it — these
 * files run to megabytes and only the head carries the metadata.
 */
async function rolloutFacts(file: string): Promise<RolloutFacts> {
  const raw = await readHead(file, TRANSCRIPT_SCAN_BYTES);
  if (!raw) return {};
  const facts: RolloutFacts = {};

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (parsed.type === 'session_meta') {
      const payload = (parsed.payload ?? {}) as { cwd?: string; timestamp?: string };
      if (typeof payload.cwd === 'string') facts.cwd = payload.cwd;
      if (payload.timestamp) facts.startedAt = Date.parse(payload.timestamp) || undefined;
    }

    if (!facts.firstUserMessage && parsed.type === 'response_item') {
      const payload = (parsed.payload ?? {}) as {
        type?: string;
        role?: string;
        content?: { type?: string; text?: string }[];
      };
      if (payload.type === 'message' && payload.role === 'user') {
        const text = (payload.content ?? [])
          .map((part) => (typeof part?.text === 'string' ? part.text : ''))
          .join('\n');
        const cleaned = stripInjectedBlocks(text);
        if (cleaned.length >= 12) facts.firstUserMessage = cleaned;
      }
    }

    if (facts.cwd && facts.firstUserMessage) break;
  }

  return facts;
}

export const codexConnector: Connector = {
  kind: 'codex',
  label: 'Codex',
  description: 'Instructions, distilled memories, and thread subjects from ~/.codex',

  async detect(ctx) {
    const root = codexHome(ctx);
    const sources: DetectedSource[] = [];

    const instructionFiles = [path.join(root, 'AGENTS.md'), path.join(root, 'memories')];
    const memoryFiles = await listFiles(path.join(root, 'memories'), '.md');
    const agentsStat = await statSafe(instructionFiles[0]!);
    const dbFiles = (await listFiles(root)).filter((f) => /memories.*\.sqlite$/.test(f));

    if (agentsStat || memoryFiles.length > 0 || dbFiles.length > 0) {
      sources.push({
        id: 'codex:global',
        kind: 'codex',
        label: 'Codex — instructions and memories',
        root,
        scope: 'global',
        detail: [
          agentsStat ? 'AGENTS.md' : null,
          memoryFiles.length ? `${memoryFiles.length} memory files` : null,
          dbFiles.length ? basenameOf(dbFiles[0]!) : null,
        ]
          .filter(Boolean)
          .join(', '),
        itemsSeen: memoryFiles.length + (agentsStat ? 1 : 0),
        lastModified: agentsStat?.mtimeMs,
      });
    }

    const sessionDir = path.join(root, 'sessions');
    const rollouts = await walkFiles(sessionDir, { maxDepth: 5, ext: '.jsonl', limit: 4000 });
    if (rollouts.length > 0) {
      const newest = await statSafe(rollouts[rollouts.length - 1]!);
      sources.push({
        id: 'codex:sessions',
        kind: 'codex',
        label: 'Codex — what past threads were about',
        root: sessionDir,
        scope: 'global',
        detail: `${rollouts.length} thread${rollouts.length === 1 ? '' : 's'} on disk`,
        itemsSeen: rollouts.length,
        lastModified: newest?.mtimeMs,
      });
    }

    return sources;
  },

  async read(source, ctx, options) {
    return source.id === 'codex:sessions'
      ? readSessions(source, ctx, options)
      : readGlobal(source, ctx, options);
  },
};

async function readGlobal(
  source: DetectedSource,
  ctx: ConnectorContext,
  options: ReadOptions,
): Promise<RawMemory[]> {
  const out: RawMemory[] = [];

  const agents = path.join(source.root, 'AGENTS.md');
  const agentsStat = await statSafe(agents);
  if (agentsStat && !(options.since && agentsStat.mtimeMs <= options.since)) {
    const raw = await readTextIfExists(agents);
    if (raw && meaningful(raw)) {
      out.push(
        memory({
          sourceId: source.id,
          externalId: agents,
          title: 'Standing instructions for every Codex thread',
          body: truncateBody(raw, options.limits.maxBodyChars),
          kind: 'instruction',
          tool: 'codex',
          tags: ['codex', 'instructions'],
          createdAt: agentsStat.birthtimeMs,
          updatedAt: agentsStat.mtimeMs,
          path: agents,
        }),
      );
    }
  }

  for (const file of await listFiles(path.join(source.root, 'memories'), '.md')) {
    const st = await statSafe(file);
    if (!st || (options.since && st.mtimeMs <= options.since)) continue;
    const raw = await readTextIfExists(file);
    if (!raw || !meaningful(raw)) continue;
    out.push(
      memory({
        sourceId: source.id,
        externalId: file,
        title: titleFrom(raw),
        body: truncateBody(raw, options.limits.maxBodyChars),
        kind: 'fact',
        tool: 'codex',
        tags: ['codex'],
        createdAt: st.birthtimeMs,
        updatedAt: st.mtimeMs,
        path: file,
      }),
    );
  }

  try {
    out.push(...(await readMemoryDatabases(source, options)));
  } catch (err) {
    // A database we cannot open must not cost us the files we could read.
    options.onWarning?.((err as Error).message);
  }
  return out.slice(0, options.limits.maxRecordsPerSource);
}

/**
 * Codex's own distilled memories, once they live in sqlite. Best effort: no
 * dependency is added for this, and a Node without `node:sqlite` simply
 * contributes nothing.
 */
async function readMemoryDatabases(source: DetectedSource, options: ReadOptions): Promise<RawMemory[]> {
  const dbFiles = (await listFiles(source.root)).filter((f) => /memories.*\.sqlite$/.test(f));
  if (dbFiles.length === 0) return [];

  let DatabaseSync: (new (file: string, opts?: unknown) => {
    prepare(sql: string): { all(...params: unknown[]): unknown[] };
    close(): void;
  }) | null = null;
  try {
    ({ DatabaseSync } = (await import('node:sqlite')) as never);
  } catch {
    throw new Error('codex memory database found but this Node build has no node:sqlite — skipped');
  }
  if (!DatabaseSync) return [];

  const out: RawMemory[] = [];
  for (const file of dbFiles) {
    let db: { prepare(sql: string): { all(...p: unknown[]): unknown[] }; close(): void } | null = null;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const rows = db
        .prepare(
          'SELECT thread_id, raw_memory, rollout_summary, rollout_slug, source_updated_at FROM stage1_outputs ORDER BY source_updated_at DESC LIMIT ?',
        )
        .all(options.limits.maxRecordsPerSource) as {
        thread_id?: string;
        raw_memory?: string;
        rollout_summary?: string;
        rollout_slug?: string;
        source_updated_at?: number;
      }[];

      for (const row of rows) {
        const body = (row.raw_memory ?? '').trim();
        if (!meaningful(body)) continue;
        const updatedAt = Number(row.source_updated_at) || Date.now();
        if (options.since && updatedAt <= options.since) continue;
        out.push(
          memory({
            sourceId: source.id,
            externalId: `${file}#${row.thread_id ?? ''}`,
            title: row.rollout_summary?.trim() || row.rollout_slug?.trim() || titleFrom(body),
            body: truncateBody(body, options.limits.maxBodyChars),
            kind: 'fact',
            tool: 'codex',
            tags: ['codex', 'distilled'],
            createdAt: updatedAt,
            updatedAt,
            path: file,
            session: row.thread_id,
          }),
        );
      }
    } catch (err) {
      throw new Error(`could not read ${basenameOf(file)}: ${(err as Error).message}`);
    } finally {
      try {
        db?.close();
      } catch {
        /* closing a read-only handle can only fail if it was never opened */
      }
    }
  }
  return out;
}

async function readSessions(
  source: DetectedSource,
  ctx: ConnectorContext,
  options: ReadOptions,
): Promise<RawMemory[]> {
  const names = await threadNames(path.dirname(source.root));
  const files = await walkFiles(source.root, { maxDepth: 5, ext: '.jsonl', limit: 4000 });

  // Newest first: a cap should keep what is current, not what is oldest.
  const dated: { file: string; mtime: number }[] = [];
  for (const file of files) {
    const st = await statSafe(file);
    if (!st) continue;
    if (options.since && st.mtimeMs <= options.since) continue;
    dated.push({ file, mtime: st.mtimeMs });
  }
  dated.sort((a, b) => b.mtime - a.mtime);

  const out: RawMemory[] = [];
  for (const { file, mtime } of dated.slice(0, options.limits.maxRecordsPerSource)) {
    const sessionId = sessionIdFromFile(file);
    const named = names.get(sessionId);
    const facts = await rolloutFacts(file);
    if (!facts.firstUserMessage && !named) continue;

    const project = facts.cwd ? basenameOf(facts.cwd) : undefined;
    const opening = facts.firstUserMessage
      ? truncateBody(facts.firstUserMessage, Math.min(1200, options.limits.maxBodyChars))
      : '';
    const body = sessionBody({ cwd: facts.cwd, opening });
    if (!body) continue;

    out.push(
      memory({
        sourceId: source.id,
        externalId: `codex-session:${sessionId}`,
        title: named?.name?.trim() || titleFrom(opening) || `Codex thread in ${project ?? 'an unknown folder'}`,
        body,
        kind: 'session',
        tool: 'codex',
        tags: ['codex', 'session', project ?? ''].filter(Boolean),
        createdAt: facts.startedAt ?? mtime,
        updatedAt: named?.updatedAt || mtime,
        path: file,
        project,
        session: sessionId,
      }),
    );
  }

  return out;
}
