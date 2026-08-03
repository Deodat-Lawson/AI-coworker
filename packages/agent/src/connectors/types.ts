/**
 * The connector contract.
 *
 * A connector knows one tool's layout on disk and nothing else. It answers two
 * questions — "is this tool on this machine, and where does it keep memory?"
 * and "give me everything you have, or everything since a timestamp" — and the
 * pipeline does the rest.
 */

import os from 'node:os';

import type { DetectedSource, MemorySourceKind, RawMemory } from '@ai-coworker/shared';

export interface ConnectorLimits {
  /** Ceiling per source per run, so one noisy tool cannot flood the index. */
  maxRecordsPerSource: number;
  /** Memories are recall material, not archives; long files get cut. */
  maxBodyChars: number;
}

export const DEFAULT_LIMITS: ConnectorLimits = {
  maxRecordsPerSource: 400,
  maxBodyChars: 4000,
};

export interface ConnectorContext {
  /** Overridable so tests can point a whole run at a fixture tree. */
  home: string;
  env: NodeJS.ProcessEnv;
  now: number;
  limits: ConnectorLimits;
}

export function connectorContext(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    home: overrides.home ?? os.homedir(),
    env: overrides.env ?? process.env,
    now: overrides.now ?? Date.now(),
    limits: { ...DEFAULT_LIMITS, ...(overrides.limits ?? {}) },
  };
}

export interface ReadOptions {
  /** Only return memories touched after this timestamp. */
  since?: number;
  limits: ConnectorLimits;
  /**
   * Report something that could not be read without losing what could. A
   * connector that reaches four files and fails on one should surface the
   * failure and still return the other three.
   */
  onWarning?: (message: string) => void;
}

export interface Connector {
  kind: MemorySourceKind;
  label: string;
  /** One line for the UI explaining what this connector reaches. */
  description: string;
  detect(ctx: ConnectorContext): Promise<DetectedSource[]>;
  read(source: DetectedSource, ctx: ConnectorContext, options: ReadOptions): Promise<RawMemory[]>;
}

/** Build a RawMemory with the boring fields filled in. */
export function memory(input: {
  sourceId: string;
  externalId: string;
  title: string;
  body: string;
  kind: RawMemory['kind'];
  tool: MemorySourceKind;
  tags?: string[];
  createdAt?: number;
  updatedAt?: number;
  path?: string;
  project?: string;
  session?: string;
}): RawMemory {
  // Whole milliseconds: `birthtimeMs` is fractional on macOS and a fractional
  // timestamp in frontmatter is noise a human has to read past.
  const ts = Math.round(input.updatedAt ?? input.createdAt ?? Date.now());
  return {
    sourceId: input.sourceId,
    externalId: input.externalId,
    title: input.title,
    body: input.body,
    kind: input.kind,
    tags: (input.tags ?? []).filter(Boolean),
    createdAt: Math.round(input.createdAt ?? ts),
    updatedAt: ts,
    origin: {
      tool: input.tool,
      path: input.path,
      project: input.project,
      session: input.session,
    },
  };
}
