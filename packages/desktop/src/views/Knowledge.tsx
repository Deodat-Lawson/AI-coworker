import { useMemo, useState } from 'react';

import type { Artifact, Project, Task } from '@ai-coworker/shared';

import { Icon } from '../components/icons.js';
import { api, unwrap, type AppState } from '../lib/api.js';
import ObsidianView, { type ExtraView } from '../vault/ObsidianView.js';
import { UiProvider } from '../vault/ui.js';
import Sources from './Sources.js';

interface Props {
  state: AppState;
  /**
   * Go to the to-do list, which is a section of its own. The graph draws tasks
   * beside the notes and the projects they belong to, so clicking one has to
   * land somewhere — and the somewhere is the real list, not a second copy of
   * it in here.
   */
  onOpenTasks?: () => void;
}

/**
 * Knowledge is the vault: a folder of markdown notes with links, tags, a graph
 * and a canvas over it. Projects, artifacts and tasks are structured records the
 * agent needs alongside the prose, and open as their own workspace views.
 *
 * Sources belongs here too. What the agent has read is part of what it knows —
 * the connectors that bring memory in from the other agents on this machine,
 * and the sharing rules that decide who ever hears it — so it lives beside the
 * notes rather than off in a tab of its own.
 *
 * Tasks are not one of these panes. They are their own section of the app now,
 * with a real to-do list in it, and a second poorer list in here would be the
 * confusion this view is meant to remove rather than a convenience. The graph
 * still draws them — a task is worth seeing next to the project it belongs to —
 * and clicking one goes to that list.
 *
 * Each pane carries its own one-line definition, and the ribbon shows it on
 * hover. "Project" and "artifact" mean something specific here and something
 * vaguer everywhere else, so the view says which before it shows a record.
 */
export default function Knowledge({ state, onOpenTasks }: Props) {
  const extras = useMemo<ExtraView[]>(
    () => [
      {
        id: 'projects',
        label: 'Projects',
        hint: 'The folders your notes and artifacts belong to',
        icon: <Icon name="folder" />,
        render: () => <ProjectsView state={state} />,
      },
      {
        id: 'artifacts',
        label: 'Artifacts',
        hint: 'Work your agent can show, not just describe',
        icon: <Icon name="box" />,
        render: () => <ArtifactsView state={state} />,
      },
      {
        id: 'sources',
        label: 'Sources',
        hint: 'Where knowledge comes in from, and who gets to hear it',
        icon: <Icon name="plug" />,
        render: () => <Sources state={state} />,
      },
    ],
    [state],
  );

  // The graph draws these beside the notes, which is the one place the two
  // halves of Knowledge are visible as one thing.
  const records = useMemo(
    () => ({
      projects: state.projects,
      artifacts: state.artifacts,
      tasks: state.tasks,
      notes: state.notes,
    }),
    [state.artifacts, state.notes, state.projects, state.tasks],
  );

  return (
    <UiProvider>
      <ObsidianView extraViews={extras} records={records} onOpenTaskList={onOpenTasks} />
    </UiProvider>
  );
}

// ---------------------------------------------------------------------------
// The frame every record view sits in
// ---------------------------------------------------------------------------

type Runner = (work: Promise<unknown>) => Promise<void>;

function useRunner(): [Runner, string | null] {
  const [error, setError] = useState<string | null>(null);
  const run: Runner = async (work) => {
    try {
      await work;
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return [run, error];
}

/**
 * The header every record view opens with: what the word means, then how many
 * there are, then where they live on disk.
 *
 * The definition used to be printed twice — once as a subtitle and again in the
 * toolbar underneath it — which is its own kind of unhelpful: repeating a
 * sentence is what a page does when nobody decided where the sentence belonged.
 */
function RecordHeader({
  icon,
  title,
  definition,
  count,
  countNoun,
  dir,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  definition: string;
  count: number;
  countNoun: string;
  dir: string | null;
  action?: { label: string; onClick(): void };
}) {
  return (
    <header className="rec-head">
      <div className="rec-head-main">
        <span className="rec-head-icon">{icon}</span>
        <div className="rec-head-text">
          <h1>{title}</h1>
          <p className="rec-definition">{definition}</p>
        </div>
        {action ? (
          <button className="primary rec-head-action" onClick={action.onClick}>
            <Icon name="plus" size={15} />
            {action.label}
          </button>
        ) : null}
      </div>
      <div className="rec-head-meta">
        <span>
          {count} {count === 1 ? countNoun : `${countNoun}s`}
        </span>
        {dir ? (
          <button className="rec-dir" onClick={() => void api.openKnowledgeDir()} title={dir}>
            <Icon name="folder-open" size={14} />
            <span className="rec-dir-path">{shortenPath(dir)}</span>
          </button>
        ) : null}
      </div>
    </header>
  );
}

/** The last two segments are the part a person recognises; the rest is noise. */
function shortenPath(dir: string): string {
  const parts = dir.split('/').filter(Boolean);
  return parts.length <= 2 ? dir : `…/${parts.slice(-2).join('/')}`;
}

function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: { label: string; onClick(): void };
}) {
  return (
    <div className="rec-empty">
      <span className="rec-empty-icon">{icon}</span>
      <div className="rec-empty-title">{title}</div>
      <p className="rec-empty-body">{body}</p>
      {action ? (
        <button className="primary" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

/** A status word, coloured by what it means rather than by where it sits. */
function StatusPill({ value, tone }: { value: string; tone: 'good' | 'bad' | 'warn' | 'plain' }) {
  return <span className={`rec-pill is-${tone}`}>{value.replace(/_/g, ' ')}</span>;
}

const PROJECT_TONE: Record<Project['status'], 'good' | 'bad' | 'warn' | 'plain'> = {
  planning: 'plain',
  active: 'warn',
  blocked: 'bad',
  shipped: 'good',
  paused: 'plain',
};

const ARTIFACT_TONE: Record<Artifact['status'], 'good' | 'bad' | 'warn' | 'plain'> = {
  draft: 'plain',
  in_review: 'warn',
  merged: 'good',
  shipped: 'good',
  abandoned: 'bad',
};

/** What each kind of artifact is, in the words somebody would use out loud. */
const ARTIFACT_KINDS: Record<Artifact['kind'], { short: string; long: string }> = {
  pr: { short: 'PR', long: 'pull request' },
  cl: { short: 'CL', long: 'changelist' },
  demo: { short: 'Demo', long: 'a recording or a live walkthrough' },
  doc: { short: 'Doc', long: 'a written document' },
  metric: { short: 'Metric', long: 'a number that moved' },
  design: { short: 'Design', long: 'a mock or a prototype' },
  incident: { short: 'Incident', long: 'something that broke' },
};

/** Only ever shown against something private, so the wording can be blunt. */
function VisibilityNote({ visibility }: { visibility: Project['visibility'] }) {
  if (visibility === 'private') {
    return (
      <span className="rec-visibility is-private" title="Never leaves this machine">
        private
      </span>
    );
  }
  if (visibility === 'public') {
    return (
      <span className="rec-visibility" title="Shown on your directory profile">
        public
      </span>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

function ProjectsView({ state }: { state: AppState }) {
  const [run, error] = useRunner();
  const [editing, setEditing] = useState<Partial<Project> | null>(null);

  const blank = () => setEditing({ name: '', summary: '', status: 'active', visibility: 'team' });

  return (
    <div className="rec">
      <RecordHeader
        icon={<Icon name="folder" size={20} />}
        title="Projects"
        definition="A project is the home a note, an artifact or a task belongs to. Give a piece of work one, and your agent can answer questions about it as a whole instead of a file at a time."
        count={state.projects.length}
        countNoun="project"
        dir={state.knowledgeDir}
        // While the list is empty the empty state is already asking; two buttons
        // saying the same thing on one screen is one too many.
        action={state.projects.length ? { label: 'New project', onClick: blank } : undefined}
      />

      {error ? <div className="error-text">{error}</div> : null}

      {editing ? (
        <form
          className="rec-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!editing.name?.trim()) return;
            await run(unwrap(api.saveProject({ ...editing, name: editing.name.trim() })));
            setEditing(null);
          }}
        >
          <div className="field">
            <label>Name</label>
            <input
              autoFocus
              value={editing.name ?? ''}
              placeholder="Auth migration"
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </div>
          <div className="field">
            <label>What it is, and where it stands</label>
            <textarea
              value={editing.summary ?? ''}
              placeholder="Move every service off the legacy session store before the audit."
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
                {(['planning', 'active', 'blocked', 'shipped', 'paused'] as const).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Who can hear about it</label>
              <select
                value={editing.visibility ?? 'team'}
                onChange={(e) =>
                  setEditing({ ...editing, visibility: e.target.value as Project['visibility'] })
                }
              >
                <option value="team">Team — your agent may raise it in meetings</option>
                <option value="public">Public — listed on your directory profile</option>
                <option value="private">Private — never leaves this machine</option>
              </select>
            </div>
          </div>
          <div className="rec-form-actions">
            <button className="primary" type="submit" disabled={!editing.name?.trim()}>
              {editing.id ? 'Save changes' : 'Create project'}
            </button>
            <button type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {state.projects.length === 0 && !editing ? (
        <EmptyState
          icon={<Icon name="folder" size={26} />}
          title="No projects yet"
          body="Name the thing you are working on. Notes, artifacts and tasks can then point at it, and the graph starts to have a shape."
          action={{ label: 'New project', onClick: blank }}
        />
      ) : (
        <div className="rec-list">
          {state.projects.map((project) => {
            const artifacts = state.artifacts.filter((a) => a.projectId === project.id).length;
            const tasks = state.tasks.filter((t) => t.projectId === project.id);
            const open = tasks.filter((t) => t.status !== 'done').length;
            return (
              <article className="rec-card" key={project.id}>
                <div className="rec-card-head">
                  <h2>{project.name}</h2>
                  <StatusPill value={project.status} tone={PROJECT_TONE[project.status]} />
                  <VisibilityNote visibility={project.visibility} />
                  <span className="rec-card-actions">
                    <button className="ghost" onClick={() => setEditing(project)}>
                      Edit
                    </button>
                    <button
                      className="ghost is-danger"
                      title="Delete this project"
                      onClick={() => void run(unwrap(api.deleteProject(project.id)))}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </span>
                </div>
                {project.summary ? <p className="rec-card-body">{project.summary}</p> : null}
                <div className="rec-card-foot">
                  <span>
                    {artifacts} {artifacts === 1 ? 'artifact' : 'artifacts'}
                  </span>
                  <span>
                    {open} of {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'} open
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

function ArtifactsView({ state }: { state: AppState }) {
  const [run, error] = useRunner();
  const [editing, setEditing] = useState<Partial<Artifact> | null>(null);

  const blank = () =>
    setEditing({ title: '', summary: '', kind: 'pr', status: 'in_review', visibility: 'team' });

  return (
    <div className="rec">
      <RecordHeader
        icon={<Icon name="box" size={20} />}
        title="Artifacts"
        definition="An artifact is a piece of work your agent can put in front of someone — a pull request, a demo, a document, a number. It is the difference between saying the migration is going well and showing the diff that says so."
        count={state.artifacts.length}
        countNoun="artifact"
        dir={state.knowledgeDir}
        action={state.artifacts.length ? { label: 'New artifact', onClick: blank } : undefined}
      />

      {error ? <div className="error-text">{error}</div> : null}

      {editing ? (
        <form
          className="rec-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!editing.title?.trim()) return;
            await run(unwrap(api.saveArtifact({ ...editing, title: editing.title.trim() })));
            setEditing(null);
          }}
        >
          <div className="field">
            <label>Title</label>
            <input
              autoFocus
              value={editing.title ?? ''}
              placeholder="Dual-read behind a flag"
              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
            />
          </div>
          <div className="row">
            <div className="field">
              <label>Kind</label>
              <select
                value={editing.kind ?? 'pr'}
                onChange={(e) => setEditing({ ...editing, kind: e.target.value as Artifact['kind'] })}
              >
                {(Object.keys(ARTIFACT_KINDS) as Artifact['kind'][]).map((k) => (
                  <option key={k} value={k}>
                    {ARTIFACT_KINDS[k].short} — {ARTIFACT_KINDS[k].long}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Status</label>
              <select
                value={editing.status ?? 'in_review'}
                onChange={(e) =>
                  setEditing({ ...editing, status: e.target.value as Artifact['status'] })
                }
              >
                {(['draft', 'in_review', 'merged', 'shipped', 'abandoned'] as const).map((s) => (
                  <option key={s} value={s}>
                    {s.replace('_', ' ')}
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
                <option value="">No project</option>
                {state.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
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
            <label>What it is, and why it matters</label>
            <textarea
              value={editing.summary ?? ''}
              placeholder="Reads from both stores so the cutover is reversible."
              onChange={(e) => setEditing({ ...editing, summary: e.target.value })}
            />
          </div>
          <div className="rec-form-actions">
            <button className="primary" type="submit" disabled={!editing.title?.trim()}>
              {editing.id ? 'Save changes' : 'Add artifact'}
            </button>
            <button type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {state.artifacts.length === 0 && !editing ? (
        <EmptyState
          icon={<Icon name="box" size={26} />}
          title="Nothing to show yet"
          body="Add a pull request, a demo or a metric. This is what your agent reaches for when another agent asks what actually shipped."
          action={{ label: 'New artifact', onClick: blank }}
        />
      ) : (
        <div className="rec-list">
          {state.artifacts.map((artifact) => {
            const kind = ARTIFACT_KINDS[artifact.kind];
            const project = state.projects.find((p) => p.id === artifact.projectId);
            const stats = Object.entries(artifact.stats ?? {});
            return (
              <article className="rec-card" key={artifact.id}>
                <div className="rec-card-head">
                  <span className={`rec-kind is-${artifact.kind}`} title={kind.long}>
                    {kind.short}
                  </span>
                  <h2>{artifact.title}</h2>
                  <StatusPill value={artifact.status} tone={ARTIFACT_TONE[artifact.status]} />
                  <VisibilityNote visibility={artifact.visibility} />
                  <span className="rec-card-actions">
                    <button className="ghost" onClick={() => setEditing(artifact)}>
                      Edit
                    </button>
                    <button
                      className="ghost is-danger"
                      title="Delete this artifact"
                      onClick={() => void run(unwrap(api.deleteArtifact(artifact.id)))}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </span>
                </div>
                {artifact.summary ? <p className="rec-card-body">{artifact.summary}</p> : null}
                <div className="rec-card-foot">
                  {project ? <span className="rec-chip">{project.name}</span> : null}
                  {stats.map(([key, value]) => (
                    <span className="rec-chip" key={key}>
                      {key} {String(value)}
                    </span>
                  ))}
                  {artifact.url ? (
                    <a className="rec-link" href={artifact.url} target="_blank" rel="noreferrer">
                      <Icon name="external" size={13} />
                      {hostOf(artifact.url)}
                    </a>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A link is more useful as its host than as 90 characters of path. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}
