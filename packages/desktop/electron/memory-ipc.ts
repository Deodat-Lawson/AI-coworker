/**
 * The imported-memory surface, kept in its own file.
 *
 * Everything here is about *where memory comes from* and *who may hear it* —
 * the connectors, the sync, and the sharing policy. It registers its own IPC
 * channels and defines its own renderer contract so it stays independent of the
 * knowledge-base API in `ipc.ts`.
 */

import { MemoryIndex, detectSources, inspectFolder, syncMemory } from '@ai-coworker/agent';
import type {
  AudienceSelector,
  CoverageReport,
  DetectedSource,
  MemoryTopic,
  Profile,
  Sensitivity,
  SourceState,
} from '@ai-coworker/shared';
import { formatSelector } from '@ai-coworker/shared';
import { dialog, ipcMain } from 'electron';

export type MemoryIpcResult<T = void> = { ok: true; value: T } | { ok: false; error: string };

/** A connected source plus what the last run did with it. */
export interface SourceView {
  id: string;
  kind: string;
  label: string;
  root: string;
  project?: string;
  enabled: boolean;
  lastSyncAt?: number;
  memories: number;
  lastResult?: { added: number; updated: number; unchanged: number; errors: string[] };
}

/** A memory, trimmed for a list. The full body comes with `body`. */
export interface MemoryView {
  id: string;
  title: string;
  preview: string;
  body: string;
  kind: string;
  status: string;
  sourceId: string;
  sourceLabel: string;
  sourceKind: string;
  originPath?: string;
  project?: string;
  sensitivity: Sensitivity;
  topics: MemoryTopic[];
  allow: string[];
  deny: string[];
  pinned: boolean;
  rationale: string;
  gist?: string;
  updatedAt: number;
  importedAt: number;
}

export interface MemoryState {
  /** False when no workspace is open yet. */
  ready: boolean;
  sources: SourceView[];
  /** Found on this machine and not connected. */
  available: DetectedSource[];
  memories: MemoryView[];
  coverage: CoverageReport | null;
  syncing: boolean;
}

/** What one named person would actually get, memory by memory. */
export interface AudiencePreview {
  audience: string;
  shared: { id: string; title: string }[];
  acknowledged: { id: string; title: string; gist: string; reason: string }[];
  withheldCount: number;
}

export interface MemoryApi {
  getMemoryState(): Promise<MemoryState>;
  syncMemory(options?: { full?: boolean; sourceId?: string }): Promise<MemoryIpcResult<{ added: number; updated: number; errors: string[] }>>;
  setSourceEnabled(sourceId: string, enabled: boolean): Promise<MemoryIpcResult>;
  connectSource(sourceId: string): Promise<MemoryIpcResult>;
  connectFolder(): Promise<MemoryIpcResult<string | null>>;
  disconnectSource(sourceId: string, purge: boolean): Promise<MemoryIpcResult>;
  setSensitivity(recordId: string, sensitivity: Sensitivity): Promise<MemoryIpcResult>;
  grant(recordId: string, selector: string): Promise<MemoryIpcResult>;
  revoke(recordId: string, selector: string): Promise<MemoryIpcResult>;
  forget(recordId: string): Promise<MemoryIpcResult>;
  previewAudience(address: string): Promise<MemoryIpcResult<AudiencePreview>>;
  onMemoryState(handler: (state: MemoryState) => void): () => void;
}

export const MEMORY_CHANNELS = {
  state: 'memory:state',
  push: 'memory:push',
  sync: 'memory:sync',
  setEnabled: 'memory:setEnabled',
  connect: 'memory:connect',
  connectFolder: 'memory:connectFolder',
  disconnect: 'memory:disconnect',
  sensitivity: 'memory:sensitivity',
  grant: 'memory:grant',
  revoke: 'memory:revoke',
  forget: 'memory:forget',
  preview: 'memory:preview',
} as const;

interface Deps {
  getIndex: () => MemoryIndex | null;
  getOwner: () => Profile | null;
  /** Look up someone in the network directory, to judge policy against them. */
  lookup: (address: string) => { address: string; role?: 'manager' | 'ic'; team?: string; manager?: string } | null;
  push: (state: MemoryState) => void;
}

let syncing = false;

export function registerMemoryIpc(deps: Deps): void {
  const requireIndex = (): MemoryIndex => {
    const index = deps.getIndex();
    if (!index) throw new Error('No workspace is open yet.');
    return index;
  };

  const handle = <Args extends unknown[], T>(
    channel: string,
    fn: (...args: Args) => Promise<T> | T,
  ): void => {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      try {
        const value = await fn(...(args as Args));
        deps.push(await buildMemoryState(deps));
        return { ok: true, value } as MemoryIpcResult<T>;
      } catch (err) {
        return { ok: false, error: (err as Error).message } as MemoryIpcResult<T>;
      }
    });
  };

  ipcMain.handle(MEMORY_CHANNELS.state, () => buildMemoryState(deps));

  handle<[{ full?: boolean; sourceId?: string } | undefined], { added: number; updated: number; errors: string[] }>(
    MEMORY_CHANNELS.sync,
    async (options) => {
      const index = requireIndex();
      if (syncing) throw new Error('A sync is already running.');
      syncing = true;
      // Tell the UI immediately: a first sync walks every transcript on the
      // machine and the button must not look dead while it does.
      deps.push(await buildMemoryState(deps));
      try {
        const report = await syncMemory(index, {
          full: options?.full,
          only: options?.sourceId ? [options.sourceId] : undefined,
        });
        return {
          added: report.totals.added,
          updated: report.totals.updated,
          errors: report.totals.errors,
        };
      } finally {
        syncing = false;
      }
    },
  );

  handle<[string, boolean], void>(MEMORY_CHANNELS.setEnabled, async (sourceId, enabled) => {
    await requireIndex().setSourceEnabled(sourceId, enabled);
  });

  handle<[string], void>(MEMORY_CHANNELS.connect, async (sourceId) => {
    const index = requireIndex();
    const source = (await detectSources()).find((s) => s.id === sourceId);
    if (!source) throw new Error('That source is no longer on this machine.');
    await index.connectSource(source, true);
  });

  handle<[], string | null>(MEMORY_CHANNELS.connectFolder, async () => {
    const index = requireIndex();
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Choose a folder holding another agent\'s memory',
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const source = await inspectFolder(result.filePaths[0]);
    if (!source) throw new Error('No MEMORY.md, AGENTS.md or memory/ folder in there.');
    await index.connectSource(source, true);
    return source.label;
  });

  handle<[string, boolean], void>(MEMORY_CHANNELS.disconnect, async (sourceId, purge) => {
    await requireIndex().removeSource(sourceId, { purge });
  });

  handle<[string, Sensitivity], void>(MEMORY_CHANNELS.sensitivity, async (recordId, sensitivity) => {
    await requireIndex().setPolicy(recordId, { sensitivity });
  });

  handle<[string, string], void>(MEMORY_CHANNELS.grant, async (recordId, selector) => {
    if (!(await requireIndex().grant(recordId, selector))) {
      throw new Error(`I do not understand the audience "${selector}".`);
    }
  });

  handle<[string, string], void>(MEMORY_CHANNELS.revoke, async (recordId, selector) => {
    if (!(await requireIndex().revoke(recordId, selector))) {
      throw new Error(`I do not understand the audience "${selector}".`);
    }
  });

  handle<[string], void>(MEMORY_CHANNELS.forget, async (recordId) => {
    await requireIndex().forget(recordId);
  });

  handle<[string], AudiencePreview>(MEMORY_CHANNELS.preview, (address) => {
    const index = requireIndex();
    const owner = deps.getOwner();
    if (!owner) throw new Error('No profile yet.');
    const requester = deps.lookup(address) ?? { address };

    const hits = index.query({ owner, requester, limit: 500 });
    const shared = hits
      .filter((hit) => hit.shared.level === 'full')
      .map((hit) => ({ id: hit.record.id, title: hit.record.title }));
    const acknowledged = hits
      .filter((hit) => hit.shared.level === 'gist')
      .map((hit) => ({
        id: hit.record.id,
        title: hit.record.title,
        gist: hit.shared.gist ?? '',
        reason: hit.decision.reason,
      }));
    const active = index.records.filter((r) => r.status === 'active').length;
    return {
      audience: requester.address,
      shared,
      acknowledged,
      withheldCount: Math.max(0, active - shared.length - acknowledged.length),
    };
  });
}

export async function buildMemoryState(deps: Deps): Promise<MemoryState> {
  const index = deps.getIndex();
  if (!index) {
    return { ready: false, sources: [], available: [], memories: [], coverage: null, syncing };
  }

  const detected = await detectSources().catch(() => [] as DetectedSource[]);
  const connected = new Set(index.sources.map((s) => s.id));

  return {
    ready: true,
    syncing,
    sources: index.sources.map((state) => toSourceView(state, index.recordsFrom(state.id).length)),
    available: detected.filter((source) => !connected.has(source.id)),
    memories: index.records.map(toMemoryView),
    coverage: index.coverage(detected),
  };
}

function toSourceView(state: SourceState, memories: number): SourceView {
  return {
    id: state.id,
    kind: state.kind,
    label: state.label,
    root: state.root,
    project: state.project,
    enabled: state.enabled,
    lastSyncAt: state.lastSyncAt,
    memories,
    lastResult: state.lastResult
      ? {
          added: state.lastResult.added,
          updated: state.lastResult.updated,
          unchanged: state.lastResult.unchanged,
          errors: state.lastResult.errors,
        }
      : undefined,
  };
}

function toMemoryView(record: import('@ai-coworker/shared').MemoryRecord): MemoryView {
  return {
    id: record.id,
    title: record.title,
    preview: record.body.replace(/\s+/g, ' ').slice(0, 240),
    body: record.body,
    kind: record.kind,
    status: record.status,
    sourceId: record.sourceId,
    sourceLabel: record.sourceLabel,
    sourceKind: record.sourceKind,
    originPath: record.origin.path,
    project: record.origin.project,
    sensitivity: record.policy.sensitivity,
    topics: record.policy.topics,
    allow: record.policy.allow.map((s: AudienceSelector) => formatSelector(s)),
    deny: record.policy.deny.map((s: AudienceSelector) => formatSelector(s)),
    pinned: record.policy.pinned,
    rationale: record.policy.rationale,
    gist: record.policy.gist,
    updatedAt: record.updatedAt,
    importedAt: record.importedAt,
  };
}
