import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  AudiencePreview,
  MemoryApi,
  MemoryState,
  MemoryView,
  SourceView,
} from '../../electron/memory-ipc.js';
import { agentMayUseSource, SOURCE_KIND_TOOLS } from '@ai-coworker/shared';

import { api, type AppState } from '../lib/api.js';
import { relative } from '../lib/format.js';

declare global {
  interface Window {
    memory: MemoryApi;
  }
}

const SENSITIVITIES = ['public', 'internal', 'confidential', 'restricted', 'secret'] as const;

/** Plain language beats a five-point scale nobody has seen before. */
const SENSITIVITY_HELP: Record<string, string> = {
  public: 'Anyone, inside the company or outside it.',
  internal: 'Anyone at the company. Not outsiders.',
  confidential: 'Your manager in full; everyone else is told it exists.',
  restricted: 'You. Your manager is told it exists.',
  secret: 'You alone. It never leaves this machine.',
};

const EMPTY: MemoryState = {
  ready: false,
  sources: [],
  available: [],
  memories: [],
  coverage: null,
  syncing: false,
};

export default function Sources({ state }: { state: AppState }) {
  const [memory, setMemory] = useState<MemoryState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState<string>('');
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<AudiencePreview | null>(null);

  useEffect(() => {
    void window.memory.getMemoryState().then(setMemory);
    return window.memory.onMemoryState(setMemory);
  }, []);

  const run = useCallback(async (work: () => Promise<{ ok: boolean; error?: string } | void>, ok?: string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await work();
      if (result && 'ok' in result && !result.ok) setError(result.error ?? 'That did not work.');
      else if (ok) setNote(ok);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setMemory(await window.memory.getMemoryState());
    }
  }, []);

  const memories = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return memory.memories.filter((m) => {
      if (sourceFilter && m.sourceId !== sourceFilter) return false;
      if (!needle) return true;
      return (
        m.title.toLowerCase().includes(needle) ||
        m.preview.toLowerCase().includes(needle) ||
        m.topics.join(' ').includes(needle)
      );
    });
  }, [memory.memories, filter, sourceFilter]);

  const open = selected ? memory.memories.find((m) => m.id === selected) ?? null : null;

  return (
    <div>
      <div className="card-head">
        <div>
          <h1>Imported memory</h1>
          <div className="subtitle">
            What your other tools already know on this machine — and, per source, which of your
            workspace agents may recall it. Importing puts it here; it hands it to nobody.
          </div>
        </div>
        <div className="row">
          <button className="tab" disabled={busy} onClick={() => void run(() => window.memory.connectFolder(), 'Folder connected.')}>
            Add a folder
          </button>
          <button
            className="tab active"
            disabled={busy || memory.syncing}
            onClick={() =>
              void run(async () => {
                const result = await window.memory.syncMemory();
                if (result.ok) {
                  setNote(
                    `${result.value.added} new, ${result.value.updated} updated` +
                      (result.value.errors.length ? ` · ${result.value.errors.length} problem(s)` : ''),
                  );
                }
                return result;
              })
            }
          >
            {memory.syncing ? 'Importing…' : 'Import now'}
          </button>
        </div>
      </div>

      {error ? <div className="banner error-text">{error}</div> : null}
      {note ? <div className="banner">{note}</div> : null}

      {memory.coverage ? (
        <div className="card">
          <div className="card-title">
            {memory.coverage.active} memories
            {memory.coverage.quarantined ? ` · ${memory.coverage.quarantined} quarantined` : ''}
          </div>
          <div className="card-sub">
            {memory.coverage.bySensitivity.map((row) => `${row.count} ${row.level}`).join(' · ') ||
              'Nothing imported yet.'}
          </div>
          {memory.coverage.failing.length ? (
            <div className="hint error-text">
              Could not read: {memory.coverage.failing.map((f) => `${f.label} (${f.errors.join('; ')})`).join(', ')}
            </div>
          ) : null}
        </div>
      ) : null}

      <h2>Connected</h2>
      {memory.sources.length === 0 ? (
        <div className="empty">Nothing connected yet. Import to pull in what is already on this machine.</div>
      ) : (
        memory.sources.map((source) => (
          <SourceRow
            key={source.id}
            source={source}
            busy={busy}
            grants={state.workspaces.map((w) => ({
              id: w.workspace.id,
              name: w.workspace.name,
              agentName: w.agent.name,
              granted: agentMayUseSource(w.agent, source.id, source.kind),
            }))}
            onGrant={(workspaceId, on) => {
              const view = state.workspaces.find((w) => w.workspace.id === workspaceId);
              if (!view) return;
              const sources = on
                ? [...new Set([...view.agent.access.sources, source.id])]
                : view.agent.access.sources.filter((s) => s !== source.id);
              const tools: Record<string, boolean> = { memory_recall: sources.length > 0 };
              const kindTool = SOURCE_KIND_TOOLS[source.kind];
              if (kindTool && on) tools[kindTool] = true;
              void run(() =>
                api.saveWorkspaceAgent(workspaceId, {
                  access: { sources, sourceMode: sources.length ? 'selected' : 'none', tools },
                }),
              );
            }}
            onToggle={(enabled) =>
              void run(() => window.memory.setSourceEnabled(source.id, enabled))
            }
            onSync={() => void run(() => window.memory.syncMemory({ sourceId: source.id, full: true }))}
            onDisconnect={(purge) => void run(() => window.memory.disconnectSource(source.id, purge))}
            onFilter={() => setSourceFilter(sourceFilter === source.id ? '' : source.id)}
            filtered={sourceFilter === source.id}
          />
        ))
      )}

      {memory.available.length > 0 ? (
        <>
          <h2>Found on this machine, not connected</h2>
          {memory.available.map((source) => (
            <div className="card" key={source.id}>
              <div className="card-head">
                <div>
                  <div className="card-title">{source.label}</div>
                  <div className="card-sub">{source.detail}</div>
                </div>
                <button className="tab" disabled={busy} onClick={() => void run(() => window.memory.connectSource(source.id))}>
                  Connect
                </button>
              </div>
            </div>
          ))}
        </>
      ) : null}

      <h2>What your agent knows</h2>
      <div className="row">
        <input
          className="field"
          placeholder="Filter memories…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        {sourceFilter ? (
          <button className="tab active" onClick={() => setSourceFilter('')}>
            Clear source filter
          </button>
        ) : null}
      </div>

      {memories.length === 0 ? (
        <div className="empty">Nothing matches.</div>
      ) : (
        memories.slice(0, 200).map((item) => (
          <MemoryRow
            key={item.id}
            memory={item}
            expanded={selected === item.id}
            busy={busy}
            onOpen={() => setSelected(selected === item.id ? null : item.id)}
            onSensitivity={(value) => void run(() => window.memory.setSensitivity(item.id, value))}
            onGrant={(selector) => void run(() => window.memory.grant(item.id, selector), `Shared with ${selector}.`)}
            onRevoke={(selector) => void run(() => window.memory.revoke(item.id, selector), `Blocked for ${selector}.`)}
            onForget={() => void run(() => window.memory.forget(item.id), 'Forgotten.')}
          />
        ))
      )}

      <h2>What would you tell them?</h2>
      <div className="card">
        <div className="card-sub">
          Pick someone your agent can reach and see exactly what it would share, acknowledge, or keep back.
        </div>
        <div className="row">
          {state.directory.map((person) => (
            <button
              key={person.address}
              className="tab"
              disabled={busy}
              onClick={() =>
                void window.memory.previewAudience(person.address).then((result) => {
                  if (result.ok) setPreview(result.value);
                  else setError(result.error);
                })
              }
            >
              {person.displayName}
            </button>
          ))}
          {state.directory.length === 0 ? <span className="hint">Nobody else is online yet.</span> : null}
        </div>
        {preview ? (
          <div className="checklist">
            <div className="card-title">{preview.audience}</div>
            <div className="card-sub">
              {preview.shared.length} shared in full · {preview.acknowledged.length} acknowledged only ·{' '}
              {preview.withheldCount} never mentioned
            </div>
            {preview.acknowledged.slice(0, 8).map((row) => (
              <div className="hint" key={row.id}>
                ✋ {row.gist || row.title} — {row.reason}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** One workspace's answer to "may your agent here use this source?". */
interface Grant {
  id: string;
  name: string;
  agentName: string;
  granted: boolean;
}

function SourceRow({
  source,
  busy,
  filtered,
  grants,
  onGrant,
  onToggle,
  onSync,
  onDisconnect,
  onFilter,
}: {
  source: SourceView;
  busy: boolean;
  filtered: boolean;
  grants: Grant[];
  onGrant: (workspaceId: string, on: boolean) => void;
  onToggle: (enabled: boolean) => void;
  onSync: () => void;
  onDisconnect: (purge: boolean) => void;
  onFilter: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">{source.label}</div>
          <div className="card-sub">
            {source.memories} memories · {source.lastSyncAt ? `imported ${relative(source.lastSyncAt)}` : 'never imported'}
            {source.lastResult?.errors.length ? ` · ${source.lastResult.errors.join('; ')}` : ''}
          </div>
          <div className="hint">{source.root}</div>
        </div>
        <div className="row">
          <button className={`tab ${filtered ? 'active' : ''}`} onClick={onFilter}>
            {filtered ? 'Showing' : 'Show'}
          </button>
          <button className="tab" disabled={busy} onClick={() => onToggle(!source.enabled)}>
            {source.enabled ? 'Pause' : 'Resume'}
          </button>
          <button className="tab" disabled={busy} onClick={onSync}>
            Re-read
          </button>
          {confirming ? (
            <>
              <button className="tab" disabled={busy} onClick={() => onDisconnect(false)}>
                Keep memories
              </button>
              <button className="tab" disabled={busy} onClick={() => onDisconnect(true)}>
                Delete them
              </button>
              <button className="tab" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button className="tab" onClick={() => setConfirming(true)}>
              Disconnect
            </button>
          )}
        </div>
      </div>

      {/* Importing a source puts it on this machine. It does not hand it to any
          agent: each workspace's agent is granted separately, and this row is
          where you can see all of those answers at once. */}
      {grants.length ? (
        <div className="grant-strip">
          <span className="grant-strip-label">Agents allowed to recall this</span>
          {grants.map((grant) => (
            <button
              key={grant.id}
              className={`tab ${grant.granted ? 'active' : ''}`}
              disabled={busy}
              title={`${grant.agentName} in ${grant.name}`}
              onClick={() => onGrant(grant.id, !grant.granted)}
            >
              {grant.granted ? '✓ ' : ''}
              {grant.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MemoryRow({
  memory,
  expanded,
  busy,
  onOpen,
  onSensitivity,
  onGrant,
  onRevoke,
  onForget,
}: {
  memory: MemoryView;
  expanded: boolean;
  busy: boolean;
  onOpen: () => void;
  onSensitivity: (value: (typeof SENSITIVITIES)[number]) => void;
  onGrant: (selector: string) => void;
  onRevoke: (selector: string) => void;
  onForget: () => void;
}) {
  const [audience, setAudience] = useState('');

  return (
    <div className="card">
      <div className="card-head" onClick={onOpen} style={{ cursor: 'pointer' }}>
        <div>
          <div className="card-title">
            {memory.status === 'quarantined' ? '🔒 ' : ''}
            {memory.title}
          </div>
          <div className="card-sub">{memory.preview}</div>
          <div className="card-meta">
            <span className="tag">{memory.sensitivity}</span>
            {memory.topics.map((topic) => (
              <span className="tag" key={topic}>
                {topic}
              </span>
            ))}
            <span className="tag">{memory.sourceLabel}</span>
            {memory.pinned ? <span className="tag">set by you</span> : null}
          </div>
        </div>
      </div>

      {expanded ? (
        <div className="checklist">
          {memory.status === 'quarantined' ? (
            <div className="banner error-text">
              This looks like a credential. It is kept here for you to see and is never recalled or shared.
            </div>
          ) : null}
          <div className="hint">{memory.rationale}</div>
          <div className="hint">{memory.originPath ?? memory.sourceLabel}</div>

          <div className="row">
            {SENSITIVITIES.map((level) => (
              <button
                key={level}
                className={`tab ${memory.sensitivity === level ? 'active' : ''}`}
                disabled={busy}
                title={SENSITIVITY_HELP[level]}
                onClick={() => onSensitivity(level)}
              >
                {level}
              </button>
            ))}
          </div>
          <div className="hint">{SENSITIVITY_HELP[memory.sensitivity]}</div>

          {memory.allow.length ? <div className="hint">Always share with: {memory.allow.join(', ')}</div> : null}
          {memory.deny.length ? <div className="hint">Never share with: {memory.deny.join(', ')}</div> : null}

          <div className="row">
            <input
              className="field"
              placeholder="someone@company, team:platform, role:ic, org, anyone"
              value={audience}
              onChange={(event) => setAudience(event.target.value)}
            />
            <button className="tab" disabled={busy || !audience.trim()} onClick={() => onGrant(audience.trim())}>
              Always share
            </button>
            <button className="tab" disabled={busy || !audience.trim()} onClick={() => onRevoke(audience.trim())}>
              Never share
            </button>
          </div>

          <pre className="tool-trace">{memory.body}</pre>
          <button className="tab" disabled={busy} onClick={onForget}>
            Forget this
          </button>
        </div>
      ) : null}
    </div>
  );
}
