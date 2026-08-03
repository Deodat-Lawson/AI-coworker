/**
 * Any other agent's folder.
 *
 * Every tool in this space converges on the same handful of filenames —
 * MEMORY.md, AGENTS.md, CLAUDE.md, USER.md, and a `memory/` directory of
 * markdown. So the escape hatch for the fifth tool, or next year's, is to point
 * this connector at its directory instead of writing a new one.
 *
 * Sources come from `AI_COWORKER_MEMORY_DIRS` (path-separated) or from a human
 * adding a directory in the app.
 */

import path from 'node:path';

import type { DetectedSource, MemoryKind, RawMemory } from '@ai-coworker/shared';

import { type Connector, type ConnectorContext, type ReadOptions, memory } from './types.js';
import {
  basenameOf,
  exists,
  listFiles,
  meaningful,
  parseFrontmatter,
  readTextIfExists,
  splitSections,
  statSafe,
  stripComments,
  titleFrom,
  truncateBody,
} from './util.js';

const KNOWN_FILES: { file: string; kind: MemoryKind; title: string; sectioned: boolean }[] = [
  { file: 'MEMORY.md', kind: 'fact', title: 'Memory', sectioned: true },
  { file: 'USER.md', kind: 'identity', title: 'About my human', sectioned: false },
  { file: 'IDENTITY.md', kind: 'identity', title: 'About this agent', sectioned: false },
  { file: 'AGENTS.md', kind: 'instruction', title: 'How this agent is meant to behave', sectioned: false },
  { file: 'CLAUDE.md', kind: 'instruction', title: 'Standing instructions', sectioned: false },
];

const MEMORY_DIRS = ['memory', 'memories'];

export function folderSourceId(root: string): string {
  return `folder:${path.resolve(root)}`;
}

/** Describe a directory as a source, whether or not it turns out to hold anything. */
export async function inspectFolder(root: string): Promise<DetectedSource | null> {
  const resolved = path.resolve(root);
  if (!(await exists(resolved))) return null;

  const found: string[] = [];
  let itemsSeen = 0;
  let lastModified = 0;
  for (const entry of KNOWN_FILES) {
    const st = await statSafe(path.join(resolved, entry.file));
    if (!st) continue;
    found.push(entry.file);
    itemsSeen += 1;
    lastModified = Math.max(lastModified, st.mtimeMs);
  }
  for (const dir of MEMORY_DIRS) {
    const files = await listFiles(path.join(resolved, dir), '.md');
    if (files.length === 0) continue;
    found.push(`${dir}/ (${files.length})`);
    itemsSeen += files.length;
    for (const file of files) {
      const st = await statSafe(file);
      if (st) lastModified = Math.max(lastModified, st.mtimeMs);
    }
  }
  if (found.length === 0) return null;

  return {
    id: folderSourceId(resolved),
    kind: 'folder',
    label: `Folder — ${basenameOf(resolved)}`,
    root: resolved,
    scope: 'global',
    detail: found.join(', '),
    itemsSeen,
    lastModified: lastModified || undefined,
  };
}

export const folderConnector: Connector = {
  kind: 'folder',
  label: 'Folder',
  description: 'Any directory holding MEMORY.md, AGENTS.md, or a memory/ folder',

  async detect(ctx) {
    const configured = (ctx.env.AI_COWORKER_MEMORY_DIRS ?? '')
      .split(path.delimiter)
      .map((p) => p.trim())
      .filter(Boolean);
    const out: DetectedSource[] = [];
    for (const dir of configured) {
      const source = await inspectFolder(dir);
      if (source) out.push(source);
    }
    return out;
  },

  async read(source, ctx, options) {
    const out: RawMemory[] = [];

    for (const entry of KNOWN_FILES) {
      const file = path.join(source.root, entry.file);
      const st = await statSafe(file);
      if (!st || (options.since && st.mtimeMs <= options.since)) continue;
      const raw = stripComments((await readTextIfExists(file)) ?? '');
      if (!meaningful(raw)) continue;

      const sections = entry.sectioned ? splitSections(raw) : [];
      if (sections.length > 0) {
        for (const section of sections) {
          if (!meaningful(section.body)) continue;
          out.push(
            memory({
              sourceId: source.id,
              externalId: `${file}#${section.trail.join('/')}`,
              title: section.trail.join(' › ') || section.heading,
              body: truncateBody(section.body, options.limits.maxBodyChars),
              kind: entry.kind,
              tool: 'folder',
              tags: ['folder', basenameOf(source.root)],
              createdAt: st.birthtimeMs,
              updatedAt: st.mtimeMs,
              path: file,
            }),
          );
        }
        continue;
      }

      out.push(
        memory({
          sourceId: source.id,
          externalId: file,
          title: entry.title,
          body: truncateBody(raw, options.limits.maxBodyChars),
          kind: entry.kind,
          tool: 'folder',
          tags: ['folder', basenameOf(source.root)],
          createdAt: st.birthtimeMs,
          updatedAt: st.mtimeMs,
          path: file,
        }),
      );
    }

    for (const dir of MEMORY_DIRS) {
      for (const file of (await listFiles(path.join(source.root, dir), '.md')).reverse()) {
        if (out.length >= options.limits.maxRecordsPerSource) break;
        if (path.basename(file).toUpperCase() === 'MEMORY.MD') continue;
        const st = await statSafe(file);
        if (!st || (options.since && st.mtimeMs <= options.since)) continue;
        const raw = (await readTextIfExists(file)) ?? '';
        const { fields, body } = parseFrontmatter(raw);
        if (!meaningful(body)) continue;
        out.push(
          memory({
            sourceId: source.id,
            externalId: file,
            title: fields.name || fields.title || titleFrom(body),
            body: truncateBody(body, options.limits.maxBodyChars),
            kind: 'fact',
            tool: 'folder',
            tags: ['folder', basenameOf(source.root)],
            createdAt: st.birthtimeMs,
            updatedAt: st.mtimeMs,
            path: file,
          }),
        );
      }
    }

    return out.slice(0, options.limits.maxRecordsPerSource);
  },
};
