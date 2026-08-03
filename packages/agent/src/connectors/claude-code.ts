/**
 * Claude Code.
 *
 *   ~/.claude/projects/<slug>/memory/*.md   per-project memories, frontmattered
 *   ~/.claude/projects/<slug>/memory/MEMORY.md  an index of the above
 *   ~/.claude/projects/<slug>/*.jsonl       session transcripts
 *   ~/.claude/CLAUDE.md                     standing instructions, all projects
 *   <project>/CLAUDE.md                     standing instructions, one project
 *
 * The memory files are the prize: they are already distilled, already typed
 * (`user` / `feedback` / `project` / `reference`), and already written to be
 * re-read later. MEMORY.md is skipped on purpose — it is a table of contents
 * for files we are importing individually, so ingesting it would duplicate
 * every memory in summary form.
 *
 * The project slug is the working directory with separators flattened, which
 * cannot be reversed unambiguously ("-" is legal in a folder name). So the real
 * path is read out of a session transcript instead, and the slug is only a
 * fallback label.
 */

import path from 'node:path';

import type { DetectedSource, MemoryKind, RawMemory } from '@ai-coworker/shared';

import { type Connector, type ConnectorContext, type ReadOptions, memory } from './types.js';
import {
  basenameOf,
  exists,
  listFiles,
  listSubdirs,
  meaningful,
  parseFrontmatter,
  readHead,
  readTextIfExists,
  sessionBody,
  statSafe,
  stripInjectedBlocks,
  titleFrom,
  truncateBody,
} from './util.js';

const KIND_BY_TYPE: Record<string, MemoryKind> = {
  user: 'identity',
  feedback: 'preference',
  project: 'project',
  reference: 'reference',
};

function claudeHome(ctx: ConnectorContext): string {
  return ctx.env.CLAUDE_CONFIG_DIR || path.join(ctx.home, '.claude');
}

/** Recover the real working directory a project slug stands for. */
async function projectCwd(projectDir: string): Promise<string | undefined> {
  for (const file of (await listFiles(projectDir, '.jsonl')).slice(0, 3)) {
    const raw = await readHead(file, HEAD_BYTES);
    if (!raw) continue;
    for (const line of raw.split('\n', 80)) {
      if (!line.includes('"cwd"')) continue;
      try {
        const parsed = JSON.parse(line) as { cwd?: unknown };
        if (typeof parsed.cwd === 'string' && parsed.cwd) return parsed.cwd;
      } catch {
        // A half-written last line is normal for a live session.
      }
    }
  }
  return unslugOnDisk(basenameOf(projectDir));
}

/**
 * Last resort when a project has memories but no transcript to read the path
 * out of. The slug is the path with every separator *and* every existing dash
 * flattened to "-", so `-Users-aurea-Pensieve-new-frontend` is genuinely
 * ambiguous. Walk it greedily against the filesystem — longest directory that
 * actually exists wins — and give up rather than guess if nothing matches.
 */
async function unslugOnDisk(slug: string): Promise<string | undefined> {
  const parts = slug.replace(/^-+/, '').split('-').filter(Boolean);
  let current: string = path.sep;
  let index = 0;
  while (index < parts.length) {
    let matched = false;
    for (let take = parts.length - index; take >= 1; take--) {
      const candidate = path.join(current, parts.slice(index, index + take).join('-'));
      if (await exists(candidate)) {
        current = candidate;
        index += take;
        matched = true;
        break;
      }
    }
    if (!matched) return undefined;
  }
  return current;
}

interface SessionFacts {
  cwd?: string;
  branch?: string;
  startedAt?: number;
  opening?: string;
}

/**
 * The stated facts of a Claude Code transcript: where it ran and the first
 * thing the human actually typed. Slash commands, pasted caveats and injected
 * reminders are not that, so they are stripped and the scan moves on.
 */
async function sessionFacts(file: string): Promise<SessionFacts> {
  const raw = await readHead(file, TRANSCRIPT_SCAN_BYTES);
  if (!raw) return {};
  const facts: SessionFacts = {};

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof entry.cwd === 'string' && !facts.cwd) facts.cwd = entry.cwd;
    if (typeof entry.gitBranch === 'string' && entry.gitBranch && !facts.branch) facts.branch = entry.gitBranch;
    if (typeof entry.timestamp === 'string' && !facts.startedAt) facts.startedAt = Date.parse(entry.timestamp) || undefined;

    if (facts.opening || entry.type !== 'user' || entry.isMeta || entry.isSidechain) continue;
    const message = (entry.message ?? {}) as { content?: unknown };
    const text = Array.isArray(message.content)
      ? message.content
          .map((part) => (typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
          .join('\n')
      : typeof message.content === 'string'
        ? message.content
        : '';
    const cleaned = stripInjectedBlocks(text);
    if (cleaned.length >= 12) facts.opening = cleaned;
  }

  return facts;
}

/** `<uuid>.jsonl` → `<uuid>`. */
function sessionIdOf(file: string): string {
  return basenameOf(file).replace(/\.jsonl$/i, '');
}

/** Newest sessions first, so a per-project cap keeps what is current. */
const MAX_SESSIONS_PER_PROJECT = 25;
/** Enough of a transcript head to carry the metadata and the opening request. */
const TRANSCRIPT_SCAN_BYTES = 256_000;
const HEAD_BYTES = 64_000;

export const claudeCodeConnector: Connector = {
  kind: 'claude-code',
  label: 'Claude Code',
  description: 'Per-project memory files and standing instructions from ~/.claude',

  async detect(ctx) {
    const root = claudeHome(ctx);
    const sources: DetectedSource[] = [];

    const globalInstructions = path.join(root, 'CLAUDE.md');
    const globalStat = await statSafe(globalInstructions);
    if (globalStat) {
      sources.push({
        id: 'claude-code:global',
        kind: 'claude-code',
        label: 'Claude Code — standing instructions',
        root,
        scope: 'global',
        detail: 'CLAUDE.md that applies to every project',
        itemsSeen: 1,
        lastModified: globalStat.mtimeMs,
      });
    }

    for (const projectDir of await listSubdirs(path.join(root, 'projects'))) {
      const memoryDir = path.join(projectDir, 'memory');
      const memoryFiles = (await listFiles(memoryDir, '.md')).filter(
        (f) => path.basename(f).toUpperCase() !== 'MEMORY.MD',
      );
      const transcripts = await listFiles(projectDir, '.jsonl');
      const cwd = await projectCwd(projectDir);
      const projectInstructions = cwd ? path.join(cwd, 'CLAUDE.md') : null;
      const hasInstructions = projectInstructions ? await exists(projectInstructions) : false;
      if (memoryFiles.length === 0 && !hasInstructions && transcripts.length === 0) continue;

      let lastModified = 0;
      for (const file of [...memoryFiles, ...transcripts]) {
        const st = await statSafe(file);
        if (st) lastModified = Math.max(lastModified, st.mtimeMs);
      }

      const name = cwd ? basenameOf(cwd) : basenameOf(projectDir).replace(/^-+/, '').replace(/-/g, ' ');
      sources.push({
        id: `claude-code:project:${basenameOf(projectDir)}`,
        kind: 'claude-code',
        label: `Claude Code — ${name}`,
        root: projectDir,
        scope: 'project',
        project: name,
        detail: [
          memoryFiles.length ? `${memoryFiles.length} memory file${memoryFiles.length === 1 ? '' : 's'}` : null,
          hasInstructions ? 'CLAUDE.md' : null,
          transcripts.length ? `${transcripts.length} session${transcripts.length === 1 ? '' : 's'}` : null,
          cwd ?? null,
        ]
          .filter(Boolean)
          .join(' · '),
        itemsSeen: memoryFiles.length + (hasInstructions ? 1 : 0) + transcripts.length,
        lastModified: lastModified || undefined,
      });
    }

    return sources;
  },

  async read(source, ctx, options) {
    return source.scope === 'global'
      ? readGlobal(source, ctx, options)
      : readProject(source, ctx, options);
  },
};

async function readGlobal(
  source: DetectedSource,
  ctx: ConnectorContext,
  options: ReadOptions,
): Promise<RawMemory[]> {
  const file = path.join(source.root, 'CLAUDE.md');
  const st = await statSafe(file);
  if (!st || (options.since && st.mtimeMs <= options.since)) return [];
  const raw = await readTextIfExists(file);
  if (!raw || !meaningful(raw)) return [];
  return [
    memory({
      sourceId: source.id,
      externalId: file,
      title: 'Standing instructions for every Claude Code session',
      body: truncateBody(raw, options.limits.maxBodyChars),
      kind: 'instruction',
      tool: 'claude-code',
      tags: ['claude-code', 'instructions'],
      createdAt: st.birthtimeMs,
      updatedAt: st.mtimeMs,
      path: file,
    }),
  ];
}

async function readProject(
  source: DetectedSource,
  ctx: ConnectorContext,
  options: ReadOptions,
): Promise<RawMemory[]> {
  const out: RawMemory[] = [];
  const memoryDir = path.join(source.root, 'memory');

  for (const file of await listFiles(memoryDir, '.md')) {
    if (path.basename(file).toUpperCase() === 'MEMORY.MD') continue;
    if (out.length >= options.limits.maxRecordsPerSource) break;
    const st = await statSafe(file);
    if (!st) continue;
    if (options.since && st.mtimeMs <= options.since) continue;
    const raw = await readTextIfExists(file);
    if (!raw) continue;

    const { fields, body } = parseFrontmatter(raw);
    if (!meaningful(body)) continue;
    const declaredType = (fields.type ?? '').toLowerCase();
    out.push(
      memory({
        sourceId: source.id,
        externalId: file,
        title: fields.name || fields.description || titleFrom(body),
        body: truncateBody(
          fields.description && !body.includes(fields.description)
            ? `${fields.description}\n\n${body}`
            : body,
          options.limits.maxBodyChars,
        ),
        kind: KIND_BY_TYPE[declaredType] ?? 'fact',
        tool: 'claude-code',
        tags: ['claude-code', declaredType, source.project ?? ''].filter(Boolean),
        createdAt: st.birthtimeMs,
        updatedAt: st.mtimeMs,
        path: file,
        project: source.project,
        session: fields.originSessionId,
      }),
    );
  }

  // What past sessions in this project were about. Not summaries — the
  // directory they ran in and the request the human opened with, quoted.
  const transcripts: { file: string; mtime: number }[] = [];
  for (const file of await listFiles(source.root, '.jsonl')) {
    const st = await statSafe(file);
    if (!st) continue;
    if (options.since && st.mtimeMs <= options.since) continue;
    transcripts.push({ file, mtime: st.mtimeMs });
  }
  transcripts.sort((a, b) => b.mtime - a.mtime);

  for (const { file, mtime } of transcripts.slice(0, MAX_SESSIONS_PER_PROJECT)) {
    if (out.length >= options.limits.maxRecordsPerSource) break;
    const facts = await sessionFacts(file);
    if (!facts.opening) continue;
    const opening = truncateBody(facts.opening, Math.min(1200, options.limits.maxBodyChars));
    out.push(
      memory({
        sourceId: source.id,
        externalId: `claude-session:${sessionIdOf(file)}`,
        title: titleFrom(opening),
        body: sessionBody({ cwd: facts.cwd, branch: facts.branch, opening }),
        kind: 'session',
        tool: 'claude-code',
        tags: ['claude-code', 'session', source.project ?? ''].filter(Boolean),
        createdAt: facts.startedAt ?? mtime,
        updatedAt: mtime,
        path: file,
        project: source.project,
        session: sessionIdOf(file),
      }),
    );
  }

  // The project's own CLAUDE.md is instruction rather than memory, but it is
  // the single best statement of how this person wants that project handled.
  const cwd = await projectCwd(source.root);
  if (cwd) {
    const file = path.join(cwd, 'CLAUDE.md');
    const st = await statSafe(file);
    if (st && !(options.since && st.mtimeMs <= options.since)) {
      const raw = await readTextIfExists(file);
      if (raw && meaningful(raw)) {
        out.push(
          memory({
            sourceId: source.id,
            externalId: file,
            title: `How ${source.project ?? basenameOf(cwd)} is meant to be worked on`,
            body: truncateBody(raw, options.limits.maxBodyChars),
            kind: 'instruction',
            tool: 'claude-code',
            tags: ['claude-code', 'instructions', source.project ?? ''].filter(Boolean),
            createdAt: st.birthtimeMs,
            updatedAt: st.mtimeMs,
            path: file,
            project: source.project,
          }),
        );
      }
    }
  }

  return out;
}
