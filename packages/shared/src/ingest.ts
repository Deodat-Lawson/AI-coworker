/**
 * Memory that came from somewhere else.
 *
 * A person on this machine already has agents with memories: Claude Code keeps
 * per-project memory files, Codex keeps threads and distilled memories, an
 * OpenClaw workspace keeps MEMORY.md and daily notes, Hermes keeps a memory and
 * a user file. None of that should have to be re-typed into this app.
 *
 * These are the shapes the ingestion pipeline normalizes everything into. The
 * connectors know about the tools; nothing downstream does.
 */

import type { AudiencePolicy } from './access.js';

export type MemorySourceKind = 'claude-code' | 'codex' | 'openclaw' | 'hermes' | 'folder';

export const MEMORY_SOURCE_KINDS: readonly MemorySourceKind[] = [
  'claude-code',
  'codex',
  'openclaw',
  'hermes',
  'folder',
] as const;

/**
 * What kind of thing the memory is. Deliberately about *shape*, not subject:
 * the subject is the policy's job.
 */
export type MemoryKind =
  | 'fact'
  | 'preference'
  | 'instruction'
  | 'project'
  | 'session'
  | 'identity'
  | 'reference';

/** A place on this machine that holds memories, as found by a connector. */
export interface DetectedSource {
  /** Stable across runs: `<kind>:<scope>[:<slug>]`. */
  id: string;
  kind: MemorySourceKind;
  label: string;
  /** Directory (or file) the connector will read. */
  root: string;
  scope: 'global' | 'project';
  /** Human name of the project this source belongs to, when it has one. */
  project?: string;
  /** One line for the UI: "4 memory files, last touched Tuesday". */
  detail: string;
  /** Rough count found during detection, before anything is read. */
  itemsSeen?: number;
  lastModified?: number;
}

/** One memory as a connector produces it, before classification. */
export interface RawMemory {
  sourceId: string;
  /**
   * Stable identity *within* the source — usually file path plus heading. Re-
   * running a sync updates the same record instead of creating a second one.
   */
  externalId: string;
  title: string;
  body: string;
  kind: MemoryKind;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  origin: MemoryOrigin;
}

export interface MemoryOrigin {
  /** The tool it came from, for provenance in the UI. */
  tool: MemorySourceKind;
  path?: string;
  project?: string;
  session?: string;
}

export type MemoryStatus = 'active' | 'quarantined' | 'archived';

/** A memory after it has been classified and written to the index. */
export interface MemoryRecord {
  id: string;
  sourceId: string;
  sourceKind: MemorySourceKind;
  sourceLabel: string;
  externalId: string;
  title: string;
  body: string;
  kind: MemoryKind;
  tags: string[];
  policy: AudiencePolicy;
  /**
   * `quarantined` means the pipeline found something that looks like a
   * credential. It stays on disk for the human to see and is never recallable.
   */
  status: MemoryStatus;
  /** Content hash — how re-syncs tell "unchanged" from "edited". */
  hash: string;
  origin: MemoryOrigin;
  /** Other sources that produced the identical text. */
  alsoSeenIn: string[];
  createdAt: number;
  updatedAt: number;
  importedAt: number;
  lastSeenAt: number;
}

/** Per-source state the index keeps so a re-sync only reads what changed. */
export interface SourceState {
  id: string;
  kind: MemorySourceKind;
  label: string;
  root: string;
  scope: 'global' | 'project';
  project?: string;
  enabled: boolean;
  addedAt: number;
  lastSyncAt?: number;
  /** Highest `updatedAt` ingested so far. */
  watermark: number;
  lastResult?: SourceSyncResult;
}

export interface SourceSyncResult {
  added: number;
  updated: number;
  unchanged: number;
  /** Skipped as an exact duplicate of a memory from another source. */
  duplicates: number;
  quarantined: number;
  /** Read but rejected — empty, too short, a template with nothing in it. */
  rejected: number;
  errors: string[];
  durationMs: number;
}

export function emptySyncResult(): SourceSyncResult {
  return {
    added: 0,
    updated: 0,
    unchanged: 0,
    duplicates: 0,
    quarantined: 0,
    rejected: 0,
    errors: [],
    durationMs: 0,
  };
}

export interface SyncReport {
  startedAt: number;
  finishedAt: number;
  /** Per source that actually ran. */
  bySource: { source: SourceState; result: SourceSyncResult }[];
  /** Found on disk but not connected yet — the "I could know more" list. */
  discovered: DetectedSource[];
  totals: SourceSyncResult;
}

/**
 * What the agent knows and, just as importantly, what it does not: which tools
 * are connected, how stale each one is, and what was found but never imported.
 */
export interface CoverageReport {
  totalMemories: number;
  active: number;
  quarantined: number;
  byKind: { kind: MemorySourceKind; sources: number; memories: number; lastSyncAt?: number }[];
  bySensitivity: { level: string; count: number }[];
  /** Connected, enabled, but never synced or stale beyond the threshold. */
  staleSources: { id: string; label: string; lastSyncAt?: number }[];
  /** Detected on the machine and not connected. */
  unconnected: DetectedSource[];
  /** Sources that errored on the last run. */
  failing: { id: string; label: string; errors: string[] }[];
}
