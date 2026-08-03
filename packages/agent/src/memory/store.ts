/**
 * The imported-memory index.
 *
 * This deliberately sits *beside* the knowledge base rather than inside it.
 * `notes/` is what a person wrote for themselves; `memory/` is what their other
 * agents already knew and this one borrowed. Keeping them apart means an import
 * can never quietly rewrite something the human authored, a source can be
 * disconnected and its memories dropped in one move, and provenance survives:
 * every record still knows which tool, which file, and which session it came
 * from.
 *
 *   <workspace>/memory/sources.json   what is connected and how fresh it is
 *   <workspace>/memory/records/*.md   one memory per file, policy in frontmatter
 *
 * Markdown on disk for the same reason the notes are: a person should be able
 * to open the folder and see exactly what their agent absorbed, and what it is
 * allowed to say about it.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  type AudiencePolicy,
  type AudienceSelector,
  type CoverageReport,
  type DetectedSource,
  type MemoryKind,
  type MemoryRecord,
  type MemorySourceKind,
  type MemoryStatus,
  type MemoryTopic,
  type Profile,
  type RequesterContext,
  type Sensitivity,
  type SourceState,
  type AccessDecision,
  type SharedProjection,
  SENSITIVITY_ORDER,
  decideAccess,
  decideAccessForRoom,
  defaultPolicy,
  formatSelector,
  id,
  parseSelector,
  projectForAudience,
  slugify,
} from '@ai-coworker/shared';

import { hashContent, parseFrontmatter } from '../connectors/util.js';
import { classifyMemory, mergePolicy } from './classify.js';

export type IngestChange = 'added' | 'updated' | 'unchanged' | 'duplicate' | 'rejected';

export interface IngestResult {
  change: IngestChange;
  record?: MemoryRecord;
  reason?: string;
}

export interface RecallHit {
  record: MemoryRecord;
  decision: AccessDecision;
  shared: SharedProjection;
  score: number;
}

export interface QueryOptions {
  /** Whose knowledge base this is. Required to work out relationships. */
  owner: Pick<Profile, 'address' | 'team' | 'manager' | 'reports'>;
  /** Who is asking. Omit for the owner's own eyes. */
  requester?: RequesterContext;
  /** Everyone who would hear the answer. Beats `requester` when both are set. */
  room?: RequesterContext[];
  text?: string;
  topics?: MemoryTopic[];
  sources?: string[];
  limit?: number;
  /** Include memories the agent may only acknowledge, not quote. Default true. */
  includeGists?: boolean;
}

interface SourcesFile {
  version: number;
  sources: SourceState[];
}

const RECORDS_DIR = 'records';

export class MemoryIndex extends EventEmitter {
  readonly root: string;
  private recordsById = new Map<string, MemoryRecord>();
  private fileById = new Map<string, string>();
  /** `<sourceId>::<externalId>` → record id. Identity across re-syncs. */
  private byExternal = new Map<string, string>();
  /** content hash → record id. Cross-source duplicate detection. */
  private byHash = new Map<string, string>();
  private sourceStates = new Map<string, SourceState>();
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(root: string) {
    super();
    this.root = root;
  }

  /** `root` is the workspace directory; the index lives in `memory/` under it. */
  static async open(workspaceRoot: string): Promise<MemoryIndex> {
    const root = path.join(workspaceRoot, 'memory');
    await fs.mkdir(path.join(root, RECORDS_DIR), { recursive: true });
    const index = new MemoryIndex(root);
    await index.load();
    return index;
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(path.join(this.root, 'sources.json'), 'utf8');
      const parsed = JSON.parse(raw) as SourcesFile;
      for (const state of parsed.sources ?? []) this.sourceStates.set(state.id, state);
    } catch {
      // A fresh workspace has no sources file; that is not an error.
    }

    const dir = path.join(this.root, RECORDS_DIR);
    for (const file of await fs.readdir(dir).catch(() => [] as string[])) {
      if (!file.endsWith('.md')) continue;
      const raw = await fs.readFile(path.join(dir, file), 'utf8').catch(() => null);
      if (raw === null) continue;
      const record = deserialize(raw);
      if (!record) continue;
      this.register(record, file);
    }
  }

  private register(record: MemoryRecord, file: string): void {
    this.recordsById.set(record.id, record);
    this.fileById.set(record.id, file);
    this.byExternal.set(externalKey(record.sourceId, record.externalId), record.id);
    this.byHash.set(record.hash, record.id);
  }

  // --- accessors -----------------------------------------------------------

  get records(): MemoryRecord[] {
    return [...this.recordsById.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get sources(): SourceState[] {
    return [...this.sourceStates.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  record(recordId: string): MemoryRecord | undefined {
    return this.recordsById.get(recordId);
  }

  source(sourceId: string): SourceState | undefined {
    return this.sourceStates.get(sourceId);
  }

  recordsFrom(sourceId: string): MemoryRecord[] {
    return this.records.filter((r) => r.sourceId === sourceId);
  }

  // --- sources -------------------------------------------------------------

  async connectSource(detected: DetectedSource, enabled = true): Promise<SourceState> {
    const existing = this.sourceStates.get(detected.id);
    const state: SourceState = existing
      ? { ...existing, label: detected.label, root: detected.root, enabled }
      : {
          id: detected.id,
          kind: detected.kind,
          label: detected.label,
          root: detected.root,
          scope: detected.scope,
          project: detected.project,
          enabled,
          addedAt: Date.now(),
          watermark: 0,
        };
    this.sourceStates.set(state.id, state);
    await this.saveSources();
    this.emit('change', 'sources');
    return state;
  }

  async setSourceEnabled(sourceId: string, enabled: boolean): Promise<void> {
    const state = this.sourceStates.get(sourceId);
    if (!state) return;
    state.enabled = enabled;
    await this.saveSources();
    this.emit('change', 'sources');
  }

  /**
   * Disconnect a tool. `purge` deletes what came from it, which is the only
   * honest way to answer "make it forget my Hermes history".
   */
  async removeSource(sourceId: string, options: { purge?: boolean } = {}): Promise<number> {
    let removed = 0;
    if (options.purge) {
      for (const record of this.recordsFrom(sourceId)) {
        await this.forget(record.id);
        removed += 1;
      }
    }
    this.sourceStates.delete(sourceId);
    await this.saveSources();
    this.emit('change', 'sources');
    return removed;
  }

  async recordSyncResult(sourceId: string, patch: Partial<SourceState>): Promise<void> {
    const state = this.sourceStates.get(sourceId);
    if (!state) return;
    Object.assign(state, patch);
    await this.saveSources();
    this.emit('change', 'sources');
  }

  // --- ingestion -----------------------------------------------------------

  /**
   * Fold one raw memory into the index.
   *
   * Identity is (source, externalId), so a re-sync of an edited file updates
   * the record it produced last time instead of stacking a second copy. An
   * identical body from a *different* tool is recorded as a second sighting —
   * the same fact reaching us twice is not two facts.
   */
  async ingest(
    raw: {
      sourceId: string;
      externalId: string;
      title: string;
      body: string;
      kind: MemoryKind;
      tags: string[];
      createdAt: number;
      updatedAt: number;
      origin: MemoryRecord['origin'];
    },
    sourceKind: MemorySourceKind,
    sourceLabel: string,
  ): Promise<IngestResult> {
    const body = raw.body.trim();
    const title = raw.title.trim() || 'Untitled memory';
    // Title and body together: "Name / Riley" is a short but real memory, while
    // anything under ten characters in total is a stray line, not a fact.
    if (!body || `${title} ${body}`.length < 10) {
      return { change: 'rejected', reason: 'too short to be worth remembering' };
    }

    const hash = hashContent(title, body);
    const key = externalKey(raw.sourceId, raw.externalId);
    const existingId = this.byExternal.get(key);
    const now = Date.now();

    const classification = classifyMemory({
      title,
      body,
      tags: raw.tags,
      kind: raw.kind,
      sourceKind,
      origin: raw.origin,
    });

    if (existingId) {
      const existing = this.recordsById.get(existingId)!;
      existing.lastSeenAt = now;
      if (existing.hash === hash) {
        await this.write(existing);
        return { change: 'unchanged', record: existing };
      }
      this.byHash.delete(existing.hash);
      existing.title = title;
      existing.body = body;
      existing.tags = raw.tags;
      existing.kind = raw.kind;
      existing.hash = hash;
      existing.updatedAt = raw.updatedAt;
      existing.origin = raw.origin;
      existing.sourceLabel = sourceLabel;
      existing.status = classification.quarantine ? 'quarantined' : existing.status === 'archived' ? 'archived' : 'active';
      existing.policy = mergePolicy(existing.policy, classification.policy);
      this.byHash.set(hash, existing.id);
      await this.write(existing);
      this.emit('change', 'records');
      return { change: 'updated', record: existing };
    }

    const duplicateId = this.byHash.get(hash);
    if (duplicateId) {
      const original = this.recordsById.get(duplicateId)!;
      if (!original.alsoSeenIn.includes(raw.sourceId) && original.sourceId !== raw.sourceId) {
        original.alsoSeenIn.push(raw.sourceId);
        original.lastSeenAt = now;
        await this.write(original);
        this.emit('change', 'records');
      }
      return { change: 'duplicate', record: original, reason: `already imported from ${original.sourceLabel}` };
    }

    const record: MemoryRecord = {
      id: id('mem'),
      sourceId: raw.sourceId,
      sourceKind,
      sourceLabel,
      externalId: raw.externalId,
      title,
      body,
      kind: raw.kind,
      tags: raw.tags,
      policy: classification.policy,
      status: classification.quarantine ? 'quarantined' : 'active',
      hash,
      origin: raw.origin,
      alsoSeenIn: [],
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      importedAt: now,
      lastSeenAt: now,
    };
    this.register(record, fileNameFor(record));
    await this.write(record);
    this.emit('change', 'records');
    return { change: 'added', record };
  }

  // --- permissions ---------------------------------------------------------

  /** A human edit. Pins the policy so no later sync re-decides it. */
  async setPolicy(recordId: string, patch: Partial<AudiencePolicy>): Promise<MemoryRecord | undefined> {
    const record = this.recordsById.get(recordId);
    if (!record) return undefined;
    record.policy = { ...record.policy, ...patch, pinned: true };
    await this.write(record);
    this.emit('change', 'records');
    return record;
  }

  async grant(recordId: string, selector: AudienceSelector | string): Promise<MemoryRecord | undefined> {
    const parsed = typeof selector === 'string' ? parseSelector(selector) : selector;
    if (!parsed) return undefined;
    const record = this.recordsById.get(recordId);
    if (!record) return undefined;
    const key = formatSelector(parsed);
    record.policy = {
      ...record.policy,
      allow: [...record.policy.allow.filter((s) => formatSelector(s) !== key), parsed],
      deny: record.policy.deny.filter((s) => formatSelector(s) !== key),
      pinned: true,
    };
    await this.write(record);
    this.emit('change', 'records');
    return record;
  }

  async revoke(recordId: string, selector: AudienceSelector | string): Promise<MemoryRecord | undefined> {
    const parsed = typeof selector === 'string' ? parseSelector(selector) : selector;
    if (!parsed) return undefined;
    const record = this.recordsById.get(recordId);
    if (!record) return undefined;
    const key = formatSelector(parsed);
    record.policy = {
      ...record.policy,
      allow: record.policy.allow.filter((s) => formatSelector(s) !== key),
      deny: [...record.policy.deny.filter((s) => formatSelector(s) !== key), parsed],
      pinned: true,
    };
    await this.write(record);
    this.emit('change', 'records');
    return record;
  }

  async setStatus(recordId: string, status: MemoryStatus): Promise<void> {
    const record = this.recordsById.get(recordId);
    if (!record) return;
    record.status = status;
    await this.write(record);
    this.emit('change', 'records');
  }

  async forget(recordId: string): Promise<boolean> {
    const record = this.recordsById.get(recordId);
    if (!record) return false;
    const file = this.fileById.get(recordId);
    this.recordsById.delete(recordId);
    this.fileById.delete(recordId);
    this.byExternal.delete(externalKey(record.sourceId, record.externalId));
    if (this.byHash.get(record.hash) === recordId) this.byHash.delete(record.hash);
    if (file) {
      await this.enqueue(() => fs.rm(path.join(this.root, RECORDS_DIR, file), { force: true }));
    }
    this.emit('change', 'records');
    return true;
  }

  // --- recall --------------------------------------------------------------

  /**
   * Everything the agent may use for this audience, best match first.
   *
   * The access decision happens *here*, not at the call site, so there is one
   * place where a memory can turn into words — and a caller that forgets to
   * pass a requester gets the owner's own view, never someone else's.
   */
  query(options: QueryOptions): RecallHit[] {
    const { owner, limit = 8, includeGists = true } = options;
    const terms = tokenize(options.text ?? '');
    const hits: RecallHit[] = [];

    for (const record of this.recordsById.values()) {
      if (record.status !== 'active') continue;
      if (options.sources && !options.sources.includes(record.sourceId)) continue;
      if (options.topics && !record.policy.topics.some((t) => options.topics!.includes(t))) continue;

      const decision = options.room
        ? decideAccessForRoom(record.policy, owner, options.room)
        : options.requester
          ? decideAccess(record.policy, { owner, requester: options.requester })
          : selfDecision();
      if (decision.level === 'none') continue;
      if (decision.level === 'gist' && !includeGists) continue;

      const shared = projectForAudience(record, decision);
      if (!shared) continue;

      const score = scoreRecord(record, terms);
      if (terms.length > 0 && score <= 0) continue;
      hits.push({ record, decision, shared, score });
    }

    hits.sort((a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt);
    return hits.slice(0, limit);
  }

  /**
   * What this agent knows, and what it does not. The second half is the part
   * that matters: a source detected but never connected, or connected and never
   * synced, is a gap the human can see rather than a silent hole in an answer.
   */
  coverage(detected: DetectedSource[] = [], staleAfterMs = 7 * 24 * 60 * 60 * 1000): CoverageReport {
    const records = this.records;
    const byKind = new Map<MemorySourceKind, { sources: Set<string>; memories: number; lastSyncAt?: number }>();
    for (const state of this.sourceStates.values()) {
      const entry = byKind.get(state.kind) ?? { sources: new Set<string>(), memories: 0 };
      entry.sources.add(state.id);
      entry.lastSyncAt = Math.max(entry.lastSyncAt ?? 0, state.lastSyncAt ?? 0) || undefined;
      byKind.set(state.kind, entry);
    }
    for (const record of records) {
      const entry = byKind.get(record.sourceKind) ?? { sources: new Set<string>(), memories: 0 };
      entry.memories += 1;
      byKind.set(record.sourceKind, entry);
    }

    const counts = new Map<Sensitivity, number>();
    for (const record of records) {
      if (record.status !== 'active') continue;
      counts.set(record.policy.sensitivity, (counts.get(record.policy.sensitivity) ?? 0) + 1);
    }

    const now = Date.now();
    const connectedIds = new Set(this.sourceStates.keys());

    return {
      totalMemories: records.length,
      active: records.filter((r) => r.status === 'active').length,
      quarantined: records.filter((r) => r.status === 'quarantined').length,
      byKind: [...byKind.entries()].map(([kind, entry]) => ({
        kind,
        sources: entry.sources.size,
        memories: entry.memories,
        lastSyncAt: entry.lastSyncAt,
      })),
      bySensitivity: SENSITIVITY_ORDER.map((level) => ({ level, count: counts.get(level) ?? 0 })).filter(
        (row) => row.count > 0,
      ),
      staleSources: this.sources
        .filter((s) => s.enabled && (!s.lastSyncAt || now - s.lastSyncAt > staleAfterMs))
        .map((s) => ({ id: s.id, label: s.label, lastSyncAt: s.lastSyncAt })),
      unconnected: detected.filter((d) => !connectedIds.has(d.id)),
      failing: this.sources
        .filter((s) => (s.lastResult?.errors.length ?? 0) > 0)
        .map((s) => ({ id: s.id, label: s.label, errors: s.lastResult!.errors })),
    };
  }

  // --- persistence ---------------------------------------------------------

  private enqueue(work: () => Promise<unknown>): Promise<void> {
    const run = async () => {
      await work();
    };
    this.writeQueue = this.writeQueue.then(run, run);
    return this.writeQueue;
  }

  private saveSources(): Promise<void> {
    return this.enqueue(async () => {
      const payload: SourcesFile = { version: 1, sources: this.sources };
      const file = path.join(this.root, 'sources.json');
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await fs.rename(tmp, file);
    });
  }

  private write(record: MemoryRecord): Promise<void> {
    return this.enqueue(async () => {
      const desired = fileNameFor(record);
      const previous = this.fileById.get(record.id);
      // The filename is derived from the title, so an edited memory is renamed
      // rather than left under a name that no longer describes it.
      if (previous && previous !== desired) {
        await fs.rm(path.join(this.root, RECORDS_DIR, previous), { force: true });
      }
      this.fileById.set(record.id, desired);
      await fs.writeFile(path.join(this.root, RECORDS_DIR, desired), serialize(record), 'utf8');
    });
  }

  flush(): Promise<void> {
    return this.writeQueue;
  }
}

function selfDecision(): AccessDecision {
  return { level: 'full', allowed: true, reason: 'This is my own knowledge base.', rule: 'self', relation: 'self' };
}

function externalKey(sourceId: string, externalId: string): string {
  return `${sourceId}::${externalId}`;
}

function fileNameFor(record: MemoryRecord): string {
  return `${record.sourceKind}-${slugify(record.title)}-${record.id.slice(-6)}.md`;
}

// --- scoring ----------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'were', 'be',
  'what', 'when', 'who', 'how', 'do', 'does', 'did', 'my', 'our', 'we', 'i', 'you', 'it', 'that',
  'this', 'about', 'with', 'from', 'me', 'tell', 'know', 'any',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Title and tag matches count for more than body matches, and a memory nobody
 * has touched in a year loses to one from last week. Deliberately simple: this
 * picks candidates for a prompt, it is not a search engine.
 */
function scoreRecord(record: MemoryRecord, terms: string[]): number {
  if (terms.length === 0) return 1;
  const title = record.title.toLowerCase();
  const body = record.body.toLowerCase();
  const tags = record.tags.join(' ').toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 3;
    if (tags.includes(term)) score += 2;
    if (body.includes(term)) score += 1;
  }
  if (score === 0) return 0;

  const ageDays = Math.max(0, (Date.now() - record.updatedAt) / 86_400_000);
  return score + Math.max(0, 2 - ageDays / 60);
}

// --- serialization ----------------------------------------------------------

function serialize(record: MemoryRecord): string {
  const p = record.policy;
  const lines = [
    '---',
    `id: ${record.id}`,
    `title: ${oneLine(record.title)}`,
    `kind: ${record.kind}`,
    `status: ${record.status}`,
    `source: ${record.sourceId}`,
    `sourceKind: ${record.sourceKind}`,
    `sourceLabel: ${oneLine(record.sourceLabel)}`,
    `externalId: ${oneLine(record.externalId)}`,
    `sensitivity: ${p.sensitivity}`,
    `topics: ${p.topics.join(', ')}`,
    `allow: ${p.allow.map(formatSelector).join(', ')}`,
    `deny: ${p.deny.map(formatSelector).join(', ')}`,
    `pinned: ${p.pinned}`,
    `rationale: ${oneLine(p.rationale)}`,
    p.gist ? `gist: ${oneLine(p.gist)}` : null,
    `tags: ${record.tags.join(', ')}`,
    record.origin.path ? `originPath: ${oneLine(record.origin.path)}` : null,
    record.origin.project ? `originProject: ${oneLine(record.origin.project)}` : null,
    record.origin.session ? `originSession: ${oneLine(record.origin.session)}` : null,
    record.alsoSeenIn.length ? `alsoSeenIn: ${record.alsoSeenIn.join(', ')}` : null,
    `hash: ${record.hash}`,
    `createdAt: ${record.createdAt}`,
    `updatedAt: ${record.updatedAt}`,
    `importedAt: ${record.importedAt}`,
    `lastSeenAt: ${record.lastSeenAt}`,
    '---',
    '',
  ].filter((line) => line !== null);
  return `${lines.join('\n')}${record.body.trimEnd()}\n`;
}

function deserialize(raw: string): MemoryRecord | null {
  const { fields, body } = parseFrontmatter(raw);
  if (!fields.id || !fields.source) return null;
  const now = Date.now();

  const policy: AudiencePolicy = {
    ...defaultPolicy((fields.sensitivity as Sensitivity) || 'internal'),
    topics: splitList(fields.topics) as MemoryTopic[],
    allow: splitList(fields.allow).map(parseSelector).filter(Boolean) as AudienceSelector[],
    deny: splitList(fields.deny).map(parseSelector).filter(Boolean) as AudienceSelector[],
    pinned: fields.pinned === 'true',
    rationale: fields.rationale ?? '',
    gist: fields.gist,
  };
  if (policy.topics.length === 0) policy.topics = ['general'];

  return {
    id: fields.id,
    sourceId: fields.source,
    sourceKind: (fields.sourceKind as MemorySourceKind) || 'folder',
    sourceLabel: fields.sourceLabel ?? fields.source,
    externalId: fields.externalId ?? fields.id,
    title: fields.title ?? 'Untitled memory',
    body: body.trim(),
    kind: (fields.kind as MemoryKind) || 'fact',
    tags: splitList(fields.tags),
    policy,
    status: (fields.status as MemoryStatus) || 'active',
    hash: fields.hash ?? hashContent(fields.title ?? '', body),
    origin: {
      tool: (fields.sourceKind as MemorySourceKind) || 'folder',
      path: fields.originPath,
      project: fields.originProject,
      session: fields.originSession,
    },
    alsoSeenIn: splitList(fields.alsoSeenIn),
    createdAt: Number(fields.createdAt) || now,
    updatedAt: Number(fields.updatedAt) || now,
    importedAt: Number(fields.importedAt) || now,
    lastSeenAt: Number(fields.lastSeenAt) || now,
  };
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function oneLine(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}
