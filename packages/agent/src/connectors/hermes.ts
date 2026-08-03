/**
 * Hermes.
 *
 *   ~/.hermes/memories/MEMORY.md   facts, one per `§`-delimited chunk
 *   ~/.hermes/memories/USER.md     who the human is, same format
 *   ~/.hermes/SOUL.md              persona, usually still the shipped template
 *
 * Hermes writes append-only chunks separated by a lone `§`, each carrying its
 * own breadcrumb: `Memory - Key Context > System Setup (2026-03-27): the fact`.
 * That breadcrumb is the natural title, and each chunk is genuinely a separate
 * fact — Hermes' memory file mixes "the deployment is local" with details of
 * the human's phone, and those two cannot share one sharing policy.
 */

import path from 'node:path';

import type { DetectedSource, MemoryKind, RawMemory } from '@ai-coworker/shared';

import { type Connector, type ConnectorContext, type ReadOptions, memory } from './types.js';
import {
  exists,
  meaningful,
  plainText,
  readTextIfExists,
  statSafe,
  stripComments,
  titleFrom,
  truncateBody,
} from './util.js';

const CHUNK_SEPARATOR = /^\s*§\s*$/m;

function hermesHome(ctx: ConnectorContext): string {
  return ctx.env.HERMES_HOME || path.join(ctx.home, '.hermes');
}

interface Chunk {
  title: string;
  body: string;
  trail: string[];
}

/**
 * `Memory - Key Context & Setup > System Setup (2026-03-27): **Local**: text`
 * becomes trail ["Key Context & Setup", "System Setup"] with the text as body.
 * Anything that does not match that shape keeps its whole text and gets a title
 * derived from its first sentence.
 */
function parseChunk(raw: string): Chunk | null {
  const text = raw.trim();
  if (!text) return null;

  const breadcrumb = /^([^:\n]{0,120}?)\s*:\s*([\s\S]+)$/.exec(text);
  if (breadcrumb && breadcrumb[1]!.includes('>')) {
    const trail = breadcrumb[1]!
      .split('>')
      .map((part) => part.replace(/^Memory\s*-\s*/i, '').trim())
      .filter(Boolean);
    const body = breadcrumb[2]!.trim();
    return { title: trail.join(' › ') || titleFrom(body), body, trail };
  }

  // `**Name:** Timothy` — the label is the title, the value is the fact.
  const labelled = /^\*\*([^*]{1,60})\*\*\s*:?\s*([\s\S]+)$/.exec(text);
  if (labelled) {
    return { title: plainText(labelled[1]!), body: labelled[2]!.trim(), trail: [plainText(labelled[1]!)] };
  }

  return { title: titleFrom(text), body: text, trail: [] };
}

function splitChunks(raw: string): Chunk[] {
  return raw
    .split(CHUNK_SEPARATOR)
    .map((part) => parseChunk(part))
    .filter((c): c is Chunk => c !== null && c.body.length > 0);
}

const FILES: { file: string; kind: MemoryKind; label: string; chunked: boolean }[] = [
  { file: 'memories/MEMORY.md', kind: 'fact', label: 'Memory', chunked: true },
  { file: 'memories/USER.md', kind: 'identity', label: 'About my human', chunked: true },
  { file: 'SOUL.md', kind: 'identity', label: 'Agent persona', chunked: false },
];

export const hermesConnector: Connector = {
  kind: 'hermes',
  label: 'Hermes',
  description: 'Memory and user files from ~/.hermes',

  async detect(ctx) {
    const home = hermesHome(ctx);
    if (!(await exists(home))) return [];

    let itemsSeen = 0;
    let lastModified = 0;
    const present: string[] = [];
    for (const entry of FILES) {
      const st = await statSafe(path.join(home, entry.file));
      if (!st) continue;
      present.push(path.basename(entry.file));
      lastModified = Math.max(lastModified, st.mtimeMs);
      itemsSeen += 1;
    }
    if (present.length === 0) return [];

    const source: DetectedSource = {
      id: 'hermes:memories',
      kind: 'hermes',
      label: 'Hermes — memory',
      root: home,
      scope: 'global',
      detail: present.join(', '),
      itemsSeen,
      lastModified: lastModified || undefined,
    };
    return [source];
  },

  async read(source, ctx, options) {
    const out: RawMemory[] = [];

    for (const entry of FILES) {
      const file = path.join(source.root, entry.file);
      const st = await statSafe(file);
      if (!st || (options.since && st.mtimeMs <= options.since)) continue;
      const raw = stripComments((await readTextIfExists(file)) ?? '');
      if (!meaningful(raw)) continue;

      if (!entry.chunked) {
        out.push(
          memory({
            sourceId: source.id,
            externalId: file,
            title: entry.label,
            body: truncateBody(raw, options.limits.maxBodyChars),
            kind: entry.kind,
            tool: 'hermes',
            tags: ['hermes'],
            createdAt: st.birthtimeMs,
            updatedAt: st.mtimeMs,
            path: file,
          }),
        );
        continue;
      }

      for (const [index, chunk] of splitChunks(raw).entries()) {
        if (out.length >= options.limits.maxRecordsPerSource) break;
        // Judge the pair, not the value: "**Name:** Riley" is five characters
        // of body and one of the most useful things in the file.
        if (!meaningful(`${chunk.title} ${chunk.body}`, 10)) continue;
        out.push(
          memory({
            sourceId: source.id,
            // Position is part of the identity: two chunks can carry the same
            // breadcrumb on different days, and neither should overwrite the
            // other on a re-sync.
            externalId: `${file}#${index}:${chunk.trail.join('/') || titleFrom(chunk.body, 40)}`,
            title: chunk.title,
            body: truncateBody(chunk.body, options.limits.maxBodyChars),
            kind: entry.kind,
            tool: 'hermes',
            tags: ['hermes', ...chunk.trail.slice(0, 2).map((t) => t.toLowerCase())],
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
