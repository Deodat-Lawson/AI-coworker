import { useMemo, useState } from 'react';

import type { Artifact, Project, Task } from '@ai-coworker/shared';

import { api, unwrap, type AppState } from '../lib/api.js';
import { relative } from '../lib/format.js';
import ObsidianView, { type ExtraView } from '../vault/ObsidianView.js';
import { UiProvider } from '../vault/ui.js';

interface Props {
  state: AppState;
}

/**
 * Knowledge is the vault: a folder of markdown notes with links, tags, a graph
 * and a canvas over it. Projects, artifacts and tasks are structured records the
 * agent needs alongside the prose, and open as their own workspace views.
 */
export default function Knowledge({ state }: Props) {
  const extras = useMemo<ExtraView[]>(
    () => [
      { id: 'projects', label: 'Projects', icon: '▣', render: () => <StructuredView state={state} kind="projects" /> },
      { id: 'artifacts', label: 'Artifacts', icon: '◈', render: () => <StructuredView state={state} kind="artifacts" /> },
      { id: 'tasks', label: 'Tasks', icon: '☑', render: () => <StructuredView state={state} kind="tasks" /> },
    ],
    [state],
  );

  return (
    <UiProvider>
      <ObsidianView extraViews={extras} />
    </UiProvider>
  );
}

function StructuredView({
  state,
  kind,
}: {
  state: AppState;
  kind: 'projects' | 'artifacts' | 'tasks';
}) {
  const [error, setError] = useState<string | null>(null);
  const run = async (work: Promise<unknown>) => {
    try {
      await work;
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="structured">
      <h1>{kind[0]!.toUpperCase() + kind.slice(1)}</h1>
      <p className="subtitle">
        {kind === 'projects'
          ? 'Projects give every note and artifact a home.'
          : kind === 'artifacts'
            ? 'What your agent can show in a meeting instead of describing.'
            : 'Work you owe someone, including anything assigned in a meeting.'}
      </p>
      {state.workspaceDir ? (
        <p className="hint">
          Stored at <code>{state.workspaceDir}</code>{' '}
          <button className="ghost" onClick={() => void api.openWorkspaceDir()}>
            open folder
          </button>
        </p>
      ) : null}
      {error ? <div className="error-text">{error}</div> : null}
      {kind === 'projects' ? <Projects state={state} run={run} /> : null}
      {kind === 'artifacts' ? <Artifacts state={state} run={run} /> : null}
      {kind === 'tasks' ? <Tasks state={state} run={run} /> : null}
    </div>
  );
}

type Runner = (work: Promise<unknown>) => Promise<void>;

function Projects({ state, run }: { state: AppState; run: Runner }) {
  const [editing, setEditing] = useState<Partial<Project> | null>(null);

  return (
    <>
      <div className="toolbar">
        <span className="card-meta">Projects give every note and artifact a home.</span>
        <button onClick={() => setEditing({ name: '', summary: '', status: 'active', visibility: 'team' })}>
          New project
        </button>
      </div>

      {editing ? (
        <div className="card">
          <div className="field">
            <label>Name</label>
            <input value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </div>
          <div className="field">
            <label>Summary — what it is and where it stands</label>
            <textarea
              value={editing.summary ?? ''}
              onChange={(e) => setEditing({ ...editing, summary: e.target.value })}
            />
          </div>
          <div className="row">
            <div className="field">
              <label>Status</label>
              <select
                value={editing.status ?? 'active'}
                onChange={(e) => setEditing({ ...editing, status: e.target.value as Project['status'] })}
              >
                {['planning', 'active', 'blocked', 'shipped', 'paused'].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Visibility</label>
              <select
                value={editing.visibility ?? 'team'}
                onChange={(e) => setEditing({ ...editing, visibility: e.target.value as Project['visibility'] })}
              >
                <option value="team">team — shared in meetings</option>
                <option value="public">public — in your directory profile</option>
                <option value="private">private — never leaves this machine</option>
              </select>
            </div>
          </div>
          <button
            className="primary"
            disabled={!editing.name?.trim()}
            onClick={async () => {
              await run(unwrap(api.saveProject({ ...editing, name: editing.name!.trim() })));
              setEditing(null);
            }}
          >
            Save
          </button>{' '}
          <button onClick={() => setEditing(null)}>Cancel</button>
        </div>
      ) : null}

      {state.projects.length === 0 && !editing ? (
        <div className="empty">No projects yet.</div>
      ) : (
        state.projects.map((p) => (
          <div className="card" key={p.id}>
            <div className="card-head">
              <div>
                <div className="card-title">{p.name}</div>
                <div className="card-sub">{p.summary}</div>
              </div>
              <div className="card-meta">
                <span className={`tag ${p.status === 'blocked' ? 'bad' : p.status === 'shipped' ? 'good' : ''}`}>
                  {p.status}
                </span>
                {p.visibility === 'private' ? <span className="tag warn">private</span> : null}
              </div>
            </div>
            <div style={{ marginTop: 8 }}>
              <button className="ghost" onClick={() => setEditing(p)}>
                edit
              </button>
              <button className="danger" onClick={() => void run(unwrap(api.deleteProject(p.id)))}>
                delete
              </button>
            </div>
          </div>
        ))
      )}
    </>
  );
}

function Artifacts({ state, run }: { state: AppState; run: Runner }) {
  const [editing, setEditing] = useState<Partial<Artifact> | null>(null);

  return (
    <>
      <div className="toolbar">
        <span className="card-meta">
          Artifacts are what your agent can <em>show</em> in a meeting instead of describing.
        </span>
        <button
          onClick={() => setEditing({ title: '', summary: '', kind: 'pr', status: 'in_review', visibility: 'team' })}
        >
          New artifact
        </button>
      </div>

      {editing ? (
        <div className="card">
          <div className="row">
            <div className="field">
              <label>Kind</label>
              <select
                value={editing.kind ?? 'pr'}
                onChange={(e) => setEditing({ ...editing, kind: e.target.value as Artifact['kind'] })}
              >
                {['pr', 'cl', 'demo', 'doc', 'metric', 'design', 'incident'].map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Status</label>
              <select
                value={editing.status ?? 'in_review'}
                onChange={(e) => setEditing({ ...editing, status: e.target.value as Artifact['status'] })}
              >
                {['draft', 'in_review', 'merged', 'shipped', 'abandoned'].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Project</label>
              <select
                value={editing.projectId ?? ''}
                onChange={(e) => setEditing({ ...editing, projectId: e.target.value || undefined })}
              >
                <option value="">— none —</option>
                {state.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label>Title</label>
            <input value={editing.title ?? ''} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
          </div>
          <div className="field">
            <label>Link</label>
            <input
              value={editing.url ?? ''}
              placeholder="https://github.com/org/repo/pull/123"
              onChange={(e) => setEditing({ ...editing, url: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Summary — what it is and why it matters</label>
            <textarea
              value={editing.summary ?? ''}
              onChange={(e) => setEditing({ ...editing, summary: e.target.value })}
            />
          </div>
          <button
            className="primary"
            disabled={!editing.title?.trim()}
            onClick={async () => {
              await run(unwrap(api.saveArtifact({ ...editing, title: editing.title!.trim() })));
              setEditing(null);
            }}
          >
            Save
          </button>{' '}
          <button onClick={() => setEditing(null)}>Cancel</button>
        </div>
      ) : null}

      {state.artifacts.length === 0 && !editing ? (
        <div className="empty">
          Nothing to show yet. Add a PR or a demo — this is what makes an agent meeting concrete.
        </div>
      ) : (
        state.artifacts.map((a) => (
          <div className="card" key={a.id}>
            <div className="card-head">
              <div>
                <div className="card-title">
                  <span className="tag accent">{a.kind}</span> {a.title}
                </div>
                <div className="card-sub">{a.summary}</div>
                {a.url ? (
                  <div className="card-sub">
                    <a href={a.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                      {a.url}
                    </a>
                  </div>
                ) : null}
                {Object.keys(a.stats).length ? (
                  <div className="card-meta" style={{ marginTop: 6 }}>
                    {Object.entries(a.stats)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(' · ')}
                  </div>
                ) : null}
              </div>
              <div className="card-meta">
                <span className={`tag ${a.status === 'merged' || a.status === 'shipped' ? 'good' : ''}`}>
                  {a.status.replace('_', ' ')}
                </span>
                {a.visibility === 'private' ? <span className="tag warn">private</span> : null}
              </div>
            </div>
            <div style={{ marginTop: 8 }}>
              <button className="ghost" onClick={() => setEditing(a)}>
                edit
              </button>
              <button className="danger" onClick={() => void run(unwrap(api.deleteArtifact(a.id)))}>
                delete
              </button>
            </div>
          </div>
        ))
      )}
    </>
  );
}

function Tasks({ state, run }: { state: AppState; run: Runner }) {
  const [title, setTitle] = useState('');

  return (
    <>
      <div className="toolbar">
        <span className="card-meta">Work you owe someone, including anything assigned in a meeting.</span>
      </div>
      <div className="card">
        <div className="row">
          <input
            placeholder="Add a task…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && title.trim()) {
                await run(unwrap(api.saveTask({ title: title.trim() })));
                setTitle('');
              }
            }}
          />
          <button
            style={{ flex: '0 0 auto' }}
            disabled={!title.trim()}
            onClick={async () => {
              await run(unwrap(api.saveTask({ title: title.trim() })));
              setTitle('');
            }}
          >
            Add
          </button>
        </div>
      </div>

      {state.tasks.length === 0 ? (
        <div className="empty">No tasks.</div>
      ) : (
        state.tasks.map((t: Task) => (
          <div className="card" key={t.id}>
            <div className="card-head">
              <div>
                <div className="card-title">{t.title}</div>
                {t.detail ? <div className="card-sub">{t.detail}</div> : null}
                {t.acceptanceCriteria.length ? (
                  <ul className="checklist">
                    {t.acceptanceCriteria.map((c, i) => (
                      <li key={i}>· {c}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <div className="card-meta">
                <span className={`tag ${t.status === 'blocked' ? 'bad' : t.status === 'done' ? 'good' : ''}`}>
                  {t.status.replace('_', ' ')}
                </span>
                {t.dueDate ? <div style={{ marginTop: 6 }}>{relative(t.dueDate)}</div> : null}
              </div>
            </div>
            <div style={{ marginTop: 8 }}>
              {(['todo', 'in_progress', 'blocked', 'done'] as const)
                .filter((s) => s !== t.status)
                .map((s) => (
                  <button
                    key={s}
                    className="ghost"
                    onClick={() => void run(unwrap(api.saveTask({ id: t.id, title: t.title, status: s })))}
                  >
                    {s.replace('_', ' ')}
                  </button>
                ))}
              <button className="danger" onClick={() => void run(unwrap(api.deleteTask(t.id)))}>
                delete
              </button>
            </div>
          </div>
        ))
      )}
    </>
  );
}
