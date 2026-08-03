/**
 * OpenClaw.
 *
 *   ~/.openclaw/workspace/MEMORY.md     long-lived context, in ## sections
 *   ~/.openclaw/workspace/USER.md       who the human is
 *   ~/.openclaw/workspace/IDENTITY.md   who the agent is
 *   ~/.openclaw/workspace/AGENTS.md     how it is meant to behave
 *   ~/.openclaw/workspace/memory/*.md   a file per day, bullets of what happened
 *
 * MEMORY.md is split per `##` heading rather than imported whole: those
 * sections are independent facts written at different times, and they need
 * separate sharing policies — "system setup" is harmless, and the paragraph
 * below it about someone's phone is not.
 *
 * BOOTSTRAP.md, HEARTBEAT.md and TOOLS.md are deliberately skipped. They are
 * the tool explaining itself to itself, not anything the human told it.
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
  readTextIfExists,
  splitSections,
  statSafe,
  stripComments,
  titleFrom,
  truncateBody,
} from './util.js';

/** file → what it is. Anything not named here is left alone. */
const NAMED_FILES: { file: string; kind: MemoryKind; title: string }[] = [
  { file: 'MEMORY.md', kind: 'fact', title: 'Memory' },
  { file: 'USER.md', kind: 'identity', title: 'About my human' },
  { file: 'IDENTITY.md', kind: 'identity', title: 'About this agent' },
  { file: 'AGENTS.md', kind: 'instruction', title: 'How this agent is meant to behave' },
  { file: 'SOUL.md', kind: 'identity', title: 'Agent persona' },
];

function openclawHome(ctx: ConnectorContext): string {
  return ctx.env.OPENCLAW_HOME || path.join(ctx.home, '.openclaw');
}

async function workspaceRoots(root: string): Promise<string[]> {
  const roots: string[] = [];
  if (await exists(path.join(root, 'workspace'))) roots.push(path.join(root, 'workspace'));
  // Multi-agent installs keep a workspace per agent.
  for (const agentDir of await listSubdirs(path.join(root, 'agents'))) {
    const nested = path.join(agentDir, 'workspace');
    if (await exists(nested)) roots.push(nested);
  }
  return roots;
}

export const openclawConnector: Connector = {
  kind: 'openclaw',
  label: 'OpenClaw',
  description: 'Workspace memory, identity and daily notes from ~/.openclaw',

  async detect(ctx) {
    const home = openclawHome(ctx);
    const sources: DetectedSource[] = [];

    for (const workspace of await workspaceRoots(home)) {
      const daily = await listFiles(path.join(workspace, 'memory'), '.md');
      const named: string[] = [];
      let lastModified = 0;
      for (const entry of NAMED_FILES) {
        const st = await statSafe(path.join(workspace, entry.file));
        if (!st) continue;
        named.push(entry.file);
        lastModified = Math.max(lastModified, st.mtimeMs);
      }
      for (const file of daily) {
        const st = await statSafe(file);
        if (st) lastModified = Math.max(lastModified, st.mtimeMs);
      }
      if (named.length === 0 && daily.length === 0) continue;

      const agentName =
        basenameOf(path.dirname(workspace)) === 'agents' || basenameOf(path.dirname(workspace)) === '.openclaw'
          ? 'main'
          : basenameOf(path.dirname(workspace));
      sources.push({
        id: `openclaw:workspace:${agentName}`,
        kind: 'openclaw',
        label: agentName === 'main' ? 'OpenClaw — workspace' : `OpenClaw — ${agentName}`,
        root: workspace,
        scope: 'global',
        detail: [named.join(', '), daily.length ? `${daily.length} daily notes` : null]
          .filter(Boolean)
          .join(' · '),
        itemsSeen: named.length + daily.length,
        lastModified: lastModified || undefined,
      });
    }

    return sources;
  },

  async read(source, ctx, options) {
    const out: RawMemory[] = [];

    for (const entry of NAMED_FILES) {
      const file = path.join(source.root, entry.file);
      const st = await statSafe(file);
      if (!st || (options.since && st.mtimeMs <= options.since)) continue;
      const raw = stripComments((await readTextIfExists(file)) ?? '');
      if (!meaningful(raw)) continue;

      const sections = splitSections(raw);
      if (entry.file === 'MEMORY.md' && sections.length > 0) {
        for (const section of sections) {
          if (!meaningful(section.body)) continue;
          out.push(
            memory({
              sourceId: source.id,
              externalId: `${file}#${section.trail.join('/')}`,
              title: section.trail.join(' › ') || section.heading,
              body: truncateBody(section.body, options.limits.maxBodyChars),
              kind: 'fact',
              tool: 'openclaw',
              tags: ['openclaw', 'memory'],
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
          tool: 'openclaw',
          tags: ['openclaw', entry.file.replace(/\.md$/i, '').toLowerCase()],
          createdAt: st.birthtimeMs,
          updatedAt: st.mtimeMs,
          path: file,
        }),
      );
    }

    // Daily notes, newest first so a cap keeps the recent ones.
    const daily = (await listFiles(path.join(source.root, 'memory'), '.md')).reverse();
    for (const file of daily) {
      if (out.length >= options.limits.maxRecordsPerSource) break;
      const st = await statSafe(file);
      if (!st || (options.since && st.mtimeMs <= options.since)) continue;
      const raw = stripComments((await readTextIfExists(file)) ?? '');
      if (!meaningful(raw)) continue;
      const day = basenameOf(file).replace(/\.md$/i, '');
      out.push(
        memory({
          sourceId: source.id,
          externalId: file,
          title: `What happened on ${day}`,
          body: truncateBody(raw, options.limits.maxBodyChars),
          kind: 'session',
          tool: 'openclaw',
          tags: ['openclaw', 'daily', day],
          createdAt: Date.parse(day) || st.birthtimeMs,
          updatedAt: st.mtimeMs,
          path: file,
        }),
      );
    }

    return out.slice(0, options.limits.maxRecordsPerSource);
  },
};

/** Exported for the generic folder connector, which handles the same shapes. */
export { NAMED_FILES as OPENCLAW_NAMED_FILES, titleFrom };
