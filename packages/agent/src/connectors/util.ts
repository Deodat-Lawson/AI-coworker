/**
 * Shared plumbing for connectors: reading files that may not exist, splitting
 * markdown the way each tool happens to write it, and turning a blob of text
 * into a title.
 *
 * Every helper here fails soft. A connector is pointed at someone else's
 * private directory that it does not own and cannot fix; a malformed file is a
 * skipped memory, never a failed sync.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Read the first `maxBytes` of a file.
 *
 * Transcripts run to tens of megabytes and everything a connector wants out of
 * one — the working directory, the opening request — is written in the first
 * few turns. Slurping the whole file to find it would make a sync cost more
 * memory than the index it produces.
 */
export async function readHead(file: string, maxBytes: number): Promise<string | null> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function statSafe(target: string): Promise<{ mtimeMs: number; birthtimeMs: number; isDir: boolean; size: number } | null> {
  try {
    const st = await fs.stat(target);
    return { mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs || st.mtimeMs, isDir: st.isDirectory(), size: st.size };
  } catch {
    return null;
  }
}

export async function exists(target: string): Promise<boolean> {
  return (await statSafe(target)) !== null;
}

export async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

export async function listFiles(dir: string, ext?: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await listDir(dir)) {
    if (name.startsWith('.')) continue;
    if (ext && !name.endsWith(ext)) continue;
    const full = path.join(dir, name);
    const st = await statSafe(full);
    if (st && !st.isDir) out.push(full);
  }
  return out.sort();
}

export async function listSubdirs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await listDir(dir)) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const st = await statSafe(full);
    if (st?.isDir) out.push(full);
  }
  return out.sort();
}

/** Walk a directory tree, breadth-first, stopping at `maxDepth`. */
export async function walkFiles(
  dir: string,
  options: { maxDepth?: number; ext?: string; limit?: number } = {},
): Promise<string[]> {
  const { maxDepth = 4, ext, limit = 5000 } = options;
  const out: string[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir, depth: 0 }];
  while (queue.length && out.length < limit) {
    const next = queue.shift()!;
    for (const name of await listDir(next.dir)) {
      if (name.startsWith('.')) continue;
      const full = path.join(next.dir, name);
      const st = await statSafe(full);
      if (!st) continue;
      if (st.isDir) {
        if (next.depth < maxDepth) queue.push({ dir: full, depth: next.depth + 1 });
      } else if (!ext || name.endsWith(ext)) {
        out.push(full);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

export function hashContent(...parts: string[]): string {
  const h = createHash('sha256');
  for (const part of parts) h.update(part.trim().replace(/\s+/g, ' ').toLowerCase());
  return h.digest('hex').slice(0, 32);
}

// --- markdown ---------------------------------------------------------------

export interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

/**
 * Same shape the app's own notes use: `---` fenced key/value pairs. Nested YAML
 * (Claude Code writes a `metadata:` block) is flattened onto the leaf key,
 * which is all any connector needs.
 */
export function parseFrontmatter(raw: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { fields: {}, body: raw };
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key || !value) continue;
    fields[key] = value;
  }
  return { fields, body: raw.slice(match[0].length) };
}

export interface MarkdownSection {
  heading: string;
  /** Heading path, e.g. ["Memory", "System Setup"]. */
  trail: string[];
  body: string;
}

/**
 * Split on ATX headings, keeping the heading trail so a section can be named
 * "Key Context › System Setup" rather than just "System Setup".
 */
export function splitSections(markdown: string, minLevel = 2): MarkdownSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: MarkdownSection[] = [];
  const trail: string[] = [];
  let current: MarkdownSection | null = null;

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      trail.length = Math.max(0, level - 1);
      trail[level - 1] = text;
      if (level >= minLevel) {
        current = { heading: text, trail: trail.filter(Boolean).slice(), body: '' };
        sections.push(current);
      } else {
        // A top-level title introduces the document rather than a section.
        current = null;
      }
      continue;
    }
    if (current) current.body += `${line}\n`;
  }

  return sections.filter((s) => s.body.trim().length > 0);
}

/** Strip markdown decoration so a heading or bullet can become a title. */
export function plainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<\/?[a-z][a-z0-9_-]*\s*\/?>/gi, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>]+/g, '')
    .replace(/^\s*[-+*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First meaningful sentence of a blob, capped — used when nothing named it. */
export function titleFrom(text: string, max = 88): string {
  const flat = plainText(text);
  if (!flat) return 'Untitled memory';
  const stop = /[.!?](\s|$)/.exec(flat.slice(0, max * 2));
  const candidate = stop ? flat.slice(0, stop.index + 1) : flat;
  const trimmed = candidate.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

/**
 * Whether a file is worth importing at all. Agent tools ship template files
 * that are nothing but instructional HTML comments (Hermes' SOUL.md is one);
 * importing those would fill the index with the tool's own boilerplate.
 */
export function meaningful(text: string, minChars = 24): boolean {
  const stripped = text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^---[\s\S]*?---/m, ' ')
    .trim();
  return plainText(stripped).length >= minChars;
}

export function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').trim();
}

/**
 * Remove the machine-generated preamble agent CLIs staple onto the first user
 * message (plugin catalogues, environment dumps, injected instructions) so what
 * is left is the sentence the human actually typed.
 */
export function stripInjectedBlocks(text: string): string {
  let out = text;
  const wrappers = [
    'recommended_plugins',
    'environment_context',
    'user_instructions',
    'system-reminder',
    'ide_context',
    'plugins',
    'available_skills',
    'command-name',
    'command-message',
    'command-args',
    'local-command-stdout',
    'local-command-caveat',
  ];
  for (const tag of wrappers) {
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'gi'), ' ');
  }
  // Tools invent their own wrappers (`<codex_delegation>`, `<task-context>`).
  // Any paired tag whose name carries an underscore or dash is machinery, not
  // prose — no one types `<source_thread_id>` into a prompt on purpose.
  out = out.replace(/<([a-z][a-z0-9]*[_-][a-z0-9_-]*)>[\s\S]*?<\/\1>/gi, ' ');
  // Unclosed wrappers happen when a preamble was truncated on write.
  out = out.replace(/<[a-z_-]+>\s*$/i, ' ');
  // Bracketed status markers the CLI writes into the user turn — an interrupt
  // is not something the human said, and it makes a terrible memory title.
  out = out.replace(/^\s*\[(request interrupted|resumed|continued)[^\]]*\]\s*/gi, ' ');
  out = out.trim();
  // Whatever survived has to contain actual words.
  return /[a-z]{3}/i.test(out) ? out : '';
}

/**
 * What a past coding session is worth remembering: where it happened and what
 * was asked for, quoted rather than paraphrased. Two connectors produce this,
 * and they should read identically in the index.
 */
export function sessionBody(input: { cwd?: string; branch?: string; opening?: string }): string {
  const where = input.cwd
    ? `Worked in ${input.cwd}${input.branch ? ` on branch ${input.branch}` : ''}.`
    : null;
  const asked = input.opening
    ? `Opening request, as typed:\n\n> ${input.opening.replace(/\n/g, '\n> ')}`
    : null;
  return [where, asked].filter(Boolean).join('\n\n');
}

export function truncateBody(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/** `/Users/me/Work/api-server` → `api-server`. */
export function basenameOf(p: string): string {
  return path.basename(p.replace(/[\\/]+$/, '')) || p;
}
