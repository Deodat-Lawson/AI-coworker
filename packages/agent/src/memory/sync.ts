/**
 * The pipeline: find the tools, read what changed, classify it, write it down.
 *
 * Everything here is incremental and restartable. A source keeps a watermark —
 * the newest modification time it has already ingested — so the second run of
 * the day reads a handful of files instead of ninety-nine transcripts. A source
 * that throws records the error against itself and the run continues; one
 * broken tool must never cost the human the other three.
 *
 * Nothing is uploaded. Every path in this file reads from the local disk and
 * writes to the local workspace.
 */

import {
  type ConnectorContext,
  type ConnectorLimits,
  connectorContext,
  connectorFor,
  detectSources,
} from '../connectors/index.js';
import {
  type DetectedSource,
  type SourceState,
  type SourceSyncResult,
  type SyncReport,
  emptySyncResult,
} from '@ai-coworker/shared';

import type { MemoryIndex } from './store.js';

export interface SyncOptions {
  /** Overrides for where connectors look. Tests point this at a fixture tree. */
  context?: Partial<ConnectorContext>;
  limits?: Partial<ConnectorLimits>;
  /** Restrict the run to these source ids. */
  only?: string[];
  /**
   * Connect anything newly detected. On by default: the product promise is
   * that nobody has to upload anything, and a source found but left
   * unconnected is a memory the agent silently does not have.
   */
  autoConnect?: boolean;
  /** Ignore watermarks and re-read everything. */
  full?: boolean;
  onProgress?: (message: string) => void;
}

export async function syncMemory(index: MemoryIndex, options: SyncOptions = {}): Promise<SyncReport> {
  const startedAt = Date.now();
  const context = connectorContext({ ...options.context, limits: { ...options.context?.limits, ...options.limits } as ConnectorLimits });
  const progress = options.onProgress ?? (() => {});

  const detected = await detectSources(context);
  const detectedById = new Map(detected.map((d) => [d.id, d]));

  if (options.autoConnect !== false) {
    for (const source of detected) {
      if (index.source(source.id)) continue;
      if (options.only && !options.only.includes(source.id)) continue;
      await index.connectSource(source, true);
      progress(`connected ${source.label}`);
    }
  }

  const bySource: SyncReport['bySource'] = [];
  const totals = emptySyncResult();

  for (const state of index.sources) {
    if (options.only && !options.only.includes(state.id)) continue;
    if (!state.enabled) continue;

    const source = detectedById.get(state.id) ?? sourceFromState(state);
    const result = await syncOne(index, state, source, context, options);
    bySource.push({ source: index.source(state.id) ?? state, result });

    totals.added += result.added;
    totals.updated += result.updated;
    totals.unchanged += result.unchanged;
    totals.duplicates += result.duplicates;
    totals.quarantined += result.quarantined;
    totals.rejected += result.rejected;
    totals.errors.push(...result.errors);
    progress(
      `${state.label}: +${result.added} new, ${result.updated} updated, ${result.unchanged} unchanged` +
        (result.errors.length ? ` (${result.errors.length} problem${result.errors.length === 1 ? '' : 's'})` : ''),
    );
  }

  await index.flush();
  const finishedAt = Date.now();
  totals.durationMs = finishedAt - startedAt;

  return {
    startedAt,
    finishedAt,
    bySource,
    discovered: detected.filter((d) => !index.source(d.id)),
    totals,
  };
}

async function syncOne(
  index: MemoryIndex,
  state: SourceState,
  source: DetectedSource,
  context: ConnectorContext,
  options: SyncOptions,
): Promise<SourceSyncResult> {
  const result = emptySyncResult();
  const started = Date.now();
  const connector = connectorFor(state.kind);
  if (!connector) {
    result.errors.push(`no connector for ${state.kind}`);
    result.durationMs = Date.now() - started;
    await index.recordSyncResult(state.id, { lastSyncAt: Date.now(), lastResult: result });
    return result;
  }

  let watermark = options.full ? 0 : state.watermark;

  try {
    const raws = await connector.read(source, context, {
      since: watermark || undefined,
      limits: context.limits,
      onWarning: (message) => result.errors.push(message),
    });

    for (const raw of raws) {
      const outcome = await index.ingest(raw, state.kind, state.label);
      switch (outcome.change) {
        case 'added':
          result.added += 1;
          break;
        case 'updated':
          result.updated += 1;
          break;
        case 'unchanged':
          result.unchanged += 1;
          break;
        case 'duplicate':
          result.duplicates += 1;
          break;
        case 'rejected':
          result.rejected += 1;
          break;
      }
      if (outcome.record?.status === 'quarantined') result.quarantined += 1;
      watermark = Math.max(watermark, raw.updatedAt);
    }

    // Detection already stat'd every candidate file, so its newest timestamp is
    // a safe floor: without it a source whose memories carry timestamps older
    // than their files would be re-read in full on every single sync.
    watermark = Math.max(watermark, source.lastModified ?? 0);
  } catch (err) {
    result.errors.push((err as Error).message);
  }

  result.durationMs = Date.now() - started;
  await index.recordSyncResult(state.id, {
    lastSyncAt: Date.now(),
    watermark,
    lastResult: result,
    label: source.label,
    root: source.root,
  });
  return result;
}

/** A connected source whose tool has since disappeared from the machine. */
function sourceFromState(state: SourceState): DetectedSource {
  return {
    id: state.id,
    kind: state.kind,
    label: state.label,
    root: state.root,
    scope: state.scope,
    project: state.project,
    detail: 'not detected on this machine right now',
  };
}
