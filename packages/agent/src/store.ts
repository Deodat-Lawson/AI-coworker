/**
 * The local knowledge base.
 *
 * Everything a person's agent knows lives in one directory:
 *
 *   <root>/profile.json     – who I am, my working hours, my standing instructions
 *   <root>/db.json          – projects, artifacts, tasks, calendar, feedback
 *   <root>/notes/*.md       – the "NB files": markdown notes with YAML-ish frontmatter
 *   <root>/meetings/*.json  – transcripts and per-person outcomes
 *   <root>/client.json      – which relays to dial, unsent drafts, per-channel
 *                             notification choices; nothing anyone else can see
 *
 * Notes are real markdown on disk on purpose: a person should be able to open
 * their knowledge base in any editor and have it still make sense.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  type AgentAddress,
  type Artifact,
  type CalendarBlock,
  type Feedback,
  type Meeting,
  type MeetingOutcome,
  type MeetingRecord,
  type Minutes,
  type Note,
  type Profile,
  type Project,
  type PublicProfile,
  type Presence,
  type Task,
  type TaskList,
  type TaskSection,
  type TranscriptEntry,
  type UserStatus,
  type Visibility,
  type WorkspaceAgent,
  type WorkspaceAgentPatch,
  type WorkspacePrefs,
  type FrontmatterValue,
  applyAgentPatch,
  completeRecurring,
  defaultChannelPrefs,
  normalizeWorkspaceAgent,
  defaultWorkspacePrefs,
  emptyStatus,
  hashUnit,
  id,
  isMarkdown,
  normalizeListColor,
  normalizeTask,
  orderForBottom,
  orderForTop,
  parseNoteMeta,
  slugify,
  splitFrontmatter,
  stringifyYaml,
} from '@ai-coworker/shared';

interface DbShape {
  version: number;
  projects: Project[];
  artifacts: Artifact[];
  tasks: Task[];
  /** The to-do list's lists. Tasks with no list are in the Inbox. */
  lists: TaskList[];
  sections: TaskSection[];
  calendar: CalendarBlock[];
  feedback: Feedback[];
}

/**
 * Must be a factory, not a shared constant: a spread of a constant would give
 * every fresh knowledge base the *same* array instances, and separate people's
 * knowledge bases would silently merge.
 */
function emptyDb(): DbShape {
  return {
    version: 1,
    projects: [],
    artifacts: [],
    tasks: [],
    lists: [],
    sections: [],
    calendar: [],
    feedback: [],
  };
}

export interface KnowledgeBaseEvents {
  change: [section: string];
}

/**
 * Everything about *how this person uses* their workspaces, as opposed to what
 * is in them. It never leaves the machine: the relay has no idea which channel
 * you muted or what you half-typed and did not send.
 */
export interface ClientState {
  version: number;
  /** Relays to dial on start-up, in order. The first is the primary. */
  relays: string[];
  /** Per-workspace notification and sidebar choices. */
  prefs: Record<string, WorkspacePrefs>;
  /**
   * The agent that represents this person in each workspace, keyed by
   * workspace id — including what it is allowed to reach on this machine.
   *
   * It lives here, beside the drafts and the muted channels, because it is the
   * same kind of thing: yours, local, and none of the relay's business. A
   * workspace never learns what its agent was granted; it only ever sees what
   * the agent chose to say.
   */
  agents: Record<string, WorkspaceAgent>;
  /** Unsent text, keyed `workspaceId:channelId` (or `:threadRootId`). */
  drafts: Record<string, string>;
  /** Where to reopen: the last workspace, and the last channel inside each. */
  lastWorkspace: string;
  lastChannel: Record<string, string>;
  /** Custom status, mirrored to every relay on connect. */
  status: UserStatus;
  presence: Presence;
  /**
   * The session this person holds on each relay, keyed by relay url. Kept
   * beside the knowledge base rather than in a browser store because the agent
   * runs headless too, and it has to be able to dial in without a window open.
   */
  sessions: Record<string, RelaySession>;
  /**
   * Reminders already raised, keyed by task and moment. Persisted because a
   * notification you have seen must not come back every time the app restarts.
   */
  reminded: Record<string, number>;
}

export interface RelaySession {
  token: string;
  email: string;
  accountId: string;
  address: string;
  displayName: string;
  savedAt: number;
}

function emptyClientState(): ClientState {
  return {
    version: 1,
    relays: [],
    prefs: {},
    agents: {},
    drafts: {},
    lastWorkspace: '',
    lastChannel: {},
    status: emptyStatus(),
    presence: 'active',
    sessions: {},
    reminded: {},
  };
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

// --- Minimal frontmatter handling (no YAML dependency) ---------------------

/** Frontmatter keys this store owns; everything else on a note is the user's. */
const OWNED_KEYS = ['id', 'title', 'kind', 'visibility', 'projectId', 'tags', 'createdAt', 'updatedAt'];

function serializeNote(note: Note, extra: Record<string, FrontmatterValue> = {}): string {
  const fm: Record<string, FrontmatterValue> = {
    id: note.id,
    title: note.title.replace(/\r?\n/g, ' ').trim(),
    kind: note.kind,
    visibility: note.visibility,
    ...(note.projectId ? { projectId: note.projectId } : {}),
    tags: note.tags,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    // Properties the user added by hand survive a write from the agent.
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => !OWNED_KEYS.includes(k))),
  };
  return `---\n${stringifyYaml(fm)}\n---\n\n${note.body.trimEnd()}\n`;
}

/**
 * Read a note from a vault file.
 *
 * A file written by this app carries `id`, `kind` and timestamps. A file
 * written by hand — or by any other editor pointed at the same folder — carries
 * none of that, and must still load: the title comes from the first heading or
 * the filename, and the id is derived from the path so it stays stable across
 * reloads.
 */
function parseNote(raw: string, relPath: string, stat: { mtime: number; ctime: number }): Note {
  const { frontmatter, lines } = splitFrontmatter(raw);
  const body = lines ? raw.split('\n').slice(lines).join('\n').replace(/^\n/, '') : raw;
  const meta = parseNoteMeta(relPath, raw, stat);
  const str = (key: string): string | undefined => {
    const value = frontmatter[key];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
  };
  const num = (key: string): number | undefined => {
    const value = Number(str(key));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  return {
    id: str('id') || `note-${hashUnit(relPath).toString(36).slice(2, 10)}${relPath.length}`,
    path: relPath,
    title: meta.title,
    kind: (str('kind') as Note['kind']) || 'reference',
    visibility: (str('visibility') as Visibility) || 'team',
    projectId: str('projectId') || undefined,
    tags: meta.tags,
    createdAt: num('createdAt') ?? stat.ctime,
    updatedAt: num('updatedAt') ?? stat.mtime,
    body,
  };
}

export const DEFAULT_WORKING_HOURS = {
  days: [1, 2, 3, 4, 5],
  startMinute: 9 * 60,
  endMinute: 18 * 60,
};

export function emptyProfile(address: AgentAddress, displayName: string): Profile {
  return {
    address,
    displayName,
    title: '',
    role: 'ic',
    team: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    bio: '',
    focusAreas: [],
    reports: [],
    workingHours: { ...DEFAULT_WORKING_HOURS },
    agentInstructions: '',
  };
}

export class KnowledgeBase extends EventEmitter {
  readonly root: string;
  private profileData: Profile;
  private db: DbShape;
  private notesMap = new Map<string, Note>();
  private meetingsMap = new Map<string, MeetingRecord>();
  private noteFiles = new Map<string, string>();
  /** Frontmatter the user wrote that this store does not own, kept for round trips. */
  private noteExtras = new Map<string, Record<string, FrontmatterValue>>();
  private writeQueue: Promise<void> = Promise.resolve();
  private clientState: ClientState = emptyClientState();

  private constructor(root: string, profile: Profile, db: DbShape) {
    super();
    this.root = root;
    this.profileData = profile;
    this.db = db;
  }

  static async open(root: string, seedProfile?: Profile): Promise<KnowledgeBase> {
    await fs.mkdir(path.join(root, 'notes'), { recursive: true });
    await fs.mkdir(path.join(root, 'meetings'), { recursive: true });

    const profileFile = path.join(root, 'profile.json');
    const fallback = seedProfile ?? emptyProfile('', '');
    const profile = await readJson<Profile>(profileFile, fallback);
    // Backfill fields added after a knowledge base was first created.
    profile.workingHours ??= { ...DEFAULT_WORKING_HOURS };
    profile.focusAreas ??= [];
    profile.reports ??= [];
    profile.agentInstructions ??= '';

    const db = await readJson<DbShape>(path.join(root, 'db.json'), emptyDb());
    // Backfill collections added after a knowledge base was first written.
    db.version ??= 1;
    db.projects ??= [];
    db.artifacts ??= [];
    db.tasks ??= [];
    db.lists ??= [];
    db.sections ??= [];
    db.calendar ??= [];
    db.feedback ??= [];
    // Tasks predate the to-do list: the ones a meeting created before it existed
    // carry no labels, no checklist and no position, and every screen from here
    // down assumes they do.
    db.tasks = db.tasks.map((task, index) => normalizeTask(task, index * 1000));

    const ws = new KnowledgeBase(root, profile, db);
    const client = await readJson<ClientState>(path.join(root, 'client.json'), emptyClientState());
    ws.clientState = { ...emptyClientState(), ...client };
    ws.clientState.prefs ??= {};
    ws.clientState.drafts ??= {};
    ws.clientState.lastChannel ??= {};
    ws.clientState.relays ??= [];
    ws.clientState.reminded ??= {};
    await ws.loadNotes();
    await ws.loadMeetings();
    if (seedProfile && !(await exists(profileFile))) await ws.saveProfile();
    return ws;
  }

  /** The vault root. Notes live here, in any arrangement of folders. */
  get vaultDir(): string {
    return path.join(this.root, 'notes');
  }

  /** Re-read every note from disk. Called after the vault is edited directly. */
  async reloadNotes(): Promise<void> {
    this.notesMap.clear();
    this.noteFiles.clear();
    this.noteExtras.clear();
    await this.loadNotes();
    this.emit('change', 'notes');
  }

  private async loadNotes(rel = ''): Promise<void> {
    const dir = path.join(this.vaultDir, rel);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await this.loadNotes(relPath);
        continue;
      }
      if (!isMarkdown(relPath)) continue;
      const abs = path.join(this.vaultDir, relPath);
      const raw = await fs.readFile(abs, 'utf8').catch(() => null);
      if (raw === null) continue;
      const stat = await fs.stat(abs).catch(() => null);
      const note = parseNote(raw, relPath, {
        mtime: stat?.mtimeMs ?? Date.now(),
        ctime: stat?.birthtimeMs || stat?.ctimeMs || Date.now(),
      });
      this.notesMap.set(note.id, note);
      this.noteFiles.set(note.id, relPath);
      this.noteExtras.set(note.id, splitFrontmatter(raw).frontmatter);
    }
  }

  private async loadMeetings(): Promise<void> {
    const dir = path.join(this.root, 'meetings');
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      const record = await readJson<MeetingRecord | null>(path.join(dir, file), null);
      if (record?.meeting?.id) this.meetingsMap.set(record.meeting.id, record);
    }
  }

  // --- accessors -----------------------------------------------------------

  get profile(): Profile {
    return this.profileData;
  }

  get address(): AgentAddress {
    return this.profileData.address;
  }

  publicProfile(online = true): PublicProfile {
    const p = this.profileData;
    return {
      address: p.address,
      displayName: p.displayName,
      title: p.title,
      role: p.role,
      team: p.team,
      timezone: p.timezone,
      bio: p.bio,
      focusAreas: p.focusAreas,
      manager: p.manager,
      online,
      lastSeen: Date.now(),
    };
  }

  get projects(): Project[] {
    return [...this.db.projects];
  }

  get notes(): Note[] {
    return [...this.notesMap.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get artifacts(): Artifact[] {
    return [...this.db.artifacts].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get tasks(): Task[] {
    return [...this.db.tasks].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get taskLists(): TaskList[] {
    return [...this.db.lists].sort((a, b) => a.order - b.order);
  }

  get taskSections(): TaskSection[] {
    return [...this.db.sections].sort((a, b) => a.order - b.order);
  }

  task(taskId: string): Task | undefined {
    return this.db.tasks.find((t) => t.id === taskId);
  }

  /** Resolve a list by id, then by exact name, then by a loose one. */
  findTaskList(needle: string): TaskList | undefined {
    if (!needle) return undefined;
    const lower = needle.toLowerCase().trim();
    return (
      this.db.lists.find((l) => l.id === needle) ??
      this.db.lists.find((l) => l.name.toLowerCase() === lower) ??
      this.db.lists.find((l) => l.name.toLowerCase().includes(lower))
    );
  }

  get calendar(): CalendarBlock[] {
    return [...this.db.calendar].sort((a, b) => a.start - b.start);
  }

  get feedback(): Feedback[] {
    return [...this.db.feedback].sort((a, b) => b.createdAt - a.createdAt);
  }

  get meetings(): MeetingRecord[] {
    return [...this.meetingsMap.values()].sort((a, b) => b.meeting.start - a.meeting.start);
  }

  meeting(meetingId: string): MeetingRecord | undefined {
    return this.meetingsMap.get(meetingId);
  }

  project(projectId: string): Project | undefined {
    return this.db.projects.find((p) => p.id === projectId);
  }

  /** Resolve a project by id, exact name, or fuzzy name. */
  findProject(needle: string): Project | undefined {
    if (!needle) return undefined;
    const lower = needle.toLowerCase().trim();
    return (
      this.db.projects.find((p) => p.id === needle) ??
      this.db.projects.find((p) => p.name.toLowerCase() === lower) ??
      this.db.projects.find((p) => p.name.toLowerCase().includes(lower)) ??
      this.db.projects.find((p) => lower.includes(p.name.toLowerCase()))
    );
  }

  // --- mutations -----------------------------------------------------------

  async updateProfile(patch: Partial<Profile>): Promise<Profile> {
    this.profileData = { ...this.profileData, ...patch };
    await this.saveProfile();
    this.emit('change', 'profile');
    return this.profileData;
  }

  async upsertProject(input: Partial<Project> & { name: string }): Promise<Project> {
    const now = Date.now();
    const existing = input.id ? this.db.projects.find((p) => p.id === input.id) : undefined;
    if (existing) {
      Object.assign(existing, input, { updatedAt: now });
      await this.saveDb();
      this.emit('change', 'projects');
      return existing;
    }
    const project: Project = {
      id: input.id ?? id('proj'),
      name: input.name,
      summary: input.summary ?? '',
      status: input.status ?? 'active',
      visibility: input.visibility ?? 'team',
      tags: input.tags ?? [],
      repo: input.repo,
      stakeholders: input.stakeholders ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.db.projects.push(project);
    await this.saveDb();
    this.emit('change', 'projects');
    return project;
  }

  async deleteProject(projectId: string): Promise<void> {
    this.db.projects = this.db.projects.filter((p) => p.id !== projectId);
    await this.saveDb();
    this.emit('change', 'projects');
  }

  async upsertNote(input: Partial<Note> & { title: string; body: string }): Promise<Note> {
    const now = Date.now();
    const existing = input.id ? this.notesMap.get(input.id) : undefined;
    const note: Note = existing
      ? { ...existing, ...input, updatedAt: now }
      : {
          id: input.id ?? id('note'),
          title: input.title,
          body: input.body,
          kind: input.kind ?? 'update',
          tags: input.tags ?? [],
          visibility: input.visibility ?? 'team',
          projectId: input.projectId,
          createdAt: now,
          updatedAt: now,
        };
    this.notesMap.set(note.id, note);
    await this.saveNote(note);
    this.emit('change', 'notes');
    return note;
  }

  async deleteNote(noteId: string): Promise<void> {
    const file = this.noteFiles.get(noteId);
    this.notesMap.delete(noteId);
    this.noteFiles.delete(noteId);
    this.noteExtras.delete(noteId);
    if (file) await fs.rm(path.join(this.vaultDir, file), { force: true });
    this.emit('change', 'notes');
  }

  async upsertArtifact(input: Partial<Artifact> & { title: string }): Promise<Artifact> {
    const now = Date.now();
    const existing = input.id ? this.db.artifacts.find((a) => a.id === input.id) : undefined;
    if (existing) {
      Object.assign(existing, input, { updatedAt: now });
      await this.saveDb();
      this.emit('change', 'artifacts');
      return existing;
    }
    const artifact: Artifact = {
      id: input.id ?? id('art'),
      projectId: input.projectId,
      kind: input.kind ?? 'pr',
      title: input.title,
      url: input.url,
      summary: input.summary ?? '',
      status: input.status ?? 'in_review',
      visibility: input.visibility ?? 'team',
      stats: input.stats ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.db.artifacts.push(artifact);
    await this.saveDb();
    this.emit('change', 'artifacts');
    return artifact;
  }

  async deleteArtifact(artifactId: string): Promise<void> {
    this.db.artifacts = this.db.artifacts.filter((a) => a.id !== artifactId);
    await this.saveDb();
    this.emit('change', 'artifacts');
  }

  /**
   * Create or change a task.
   *
   * `title` is required so a caller cannot accidentally create an untitled task,
   * but a patch to an existing one leaves everything it does not mention alone.
   * Finishing and reopening are handled here rather than by every caller, so
   * `completedAt` cannot drift out of step with `status`.
   */
  async upsertTask(input: Partial<Task> & { title: string }): Promise<Task> {
    const now = Date.now();
    const existing = input.id ? this.db.tasks.find((t) => t.id === input.id) : undefined;
    if (existing) {
      const wasCompleted = existing.status === 'done' || existing.status === 'dropped';
      Object.assign(existing, input, { updatedAt: now });
      const isCompleted = existing.status === 'done' || existing.status === 'dropped';
      if (isCompleted && !wasCompleted) existing.completedAt = input.completedAt ?? now;
      if (!isCompleted) existing.completedAt = undefined;
      // Finishing a repeating task is never really finishing it, whichever
      // route got here — a status pill, the agent, or a restored snapshot.
      if (existing.status === 'done' && !wasCompleted) this.advanceIfRepeating(existing, now);
      await this.saveDb();
      this.emit('change', 'tasks');
      return existing;
    }
    const completed = input.status === 'done' || input.status === 'dropped';
    const task: Task = normalizeTask({
      id: input.id ?? id('task'),
      title: input.title,
      detail: input.detail ?? '',
      assignee: input.assignee ?? this.address,
      assignedBy: input.assignedBy ?? this.address,
      projectId: input.projectId,
      status: input.status ?? 'todo',
      priority: input.priority ?? 'normal',
      dueDate: input.dueDate,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      sourceMeetingId: input.sourceMeetingId,
      negotiationNote: input.negotiationNote,
      listId: input.listId,
      sectionId: input.sectionId,
      labels: input.labels ?? [],
      dueHasTime: input.dueHasTime,
      remindAt: input.remindAt,
      recurrence: input.recurrence,
      subtasks: input.subtasks ?? [],
      // New work goes to the top of its list, where you are already looking.
      order: input.order ?? orderForTop(this.db.tasks.filter((t) => (t.listId ?? '') === (input.listId ?? ''))),
      completedAt: completed ? (input.completedAt ?? now) : undefined,
      source: input.source,
      // Honoured rather than stamped, so undoing a delete puts the task back as
      // it was rather than as a task created just now.
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    });
    this.db.tasks.push(task);
    await this.saveDb();
    this.emit('change', 'tasks');
    return task;
  }

  /**
   * Tick a task off, or put it back.
   *
   * A repeating task does not finish when you tick it — it moves to its next
   * date and stays open. That rule lives here so it holds however the task was
   * completed: the checkbox, a keystroke, or the agent being asked to.
   */
  /**
   * Move a repeating task to its next date in place. Returns true when it moved,
   * false when it has no repeat or the series has run out and it really is done.
   */
  private advanceIfRepeating(task: Task, now: number): boolean {
    if (!task.recurrence) return false;
    const patch = completeRecurring(task, now);
    if (!patch) return false;
    Object.assign(task, patch, { updatedAt: now });
    return true;
  }

  async completeTask(taskId: string, done = true): Promise<Task | undefined> {
    const task = this.db.tasks.find((t) => t.id === taskId);
    if (!task) return undefined;
    const now = Date.now();

    if (done && this.advanceIfRepeating(task, now)) {
      await this.saveDb();
      this.emit('change', 'tasks');
      return task;
    }

    task.status = done ? 'done' : 'todo';
    task.completedAt = done ? now : undefined;
    task.updatedAt = now;
    await this.saveDb();
    this.emit('change', 'tasks');
    return task;
  }

  /** Apply one patch to several tasks — what multi-select acts through. */
  async updateTasks(taskIds: string[], patch: Partial<Task>): Promise<Task[]> {
    const now = Date.now();
    const touched: Task[] = [];
    for (const taskId of taskIds) {
      const task = this.db.tasks.find((t) => t.id === taskId);
      if (!task) continue;
      const wasCompleted = task.status === 'done' || task.status === 'dropped';
      Object.assign(task, patch, { updatedAt: now });
      const isCompleted = task.status === 'done' || task.status === 'dropped';
      if (isCompleted && !wasCompleted) task.completedAt = now;
      if (!isCompleted) task.completedAt = undefined;
      if (task.status === 'done' && !wasCompleted) this.advanceIfRepeating(task, now);
      touched.push(task);
    }
    if (!touched.length) return [];
    await this.saveDb();
    this.emit('change', 'tasks');
    return touched;
  }

  /** Write the positions a drag produced. */
  async reorderTasks(positions: { id: string; order: number }[]): Promise<void> {
    if (!positions.length) return;
    const now = Date.now();
    for (const { id: taskId, order } of positions) {
      const task = this.db.tasks.find((t) => t.id === taskId);
      if (!task) continue;
      task.order = order;
      task.updatedAt = now;
    }
    await this.saveDb();
    this.emit('change', 'tasks');
  }

  /**
   * Put snapshots back exactly as they were, field for field.
   *
   * Deliberately a replacement rather than a patch: undo has to be able to
   * *unset* something — a date you added, a list you filed it under — and a
   * patch can only ever set. Anything the snapshot does not carry, the restored
   * task does not have either.
   */
  async restoreTasks(snapshots: Task[]): Promise<Task[]> {
    if (!snapshots.length) return [];
    const now = Date.now();
    const restored = snapshots.map((snapshot) => normalizeTask({ ...snapshot, updatedAt: now }));
    for (const task of restored) {
      const index = this.db.tasks.findIndex((t) => t.id === task.id);
      if (index >= 0) this.db.tasks[index] = task;
      else this.db.tasks.push(task);
    }
    await this.saveDb();
    this.emit('change', 'tasks');
    return restored;
  }

  /** The same, for lists — so undoing a deleted list brings the list back too. */
  async restoreTaskLists(snapshots: TaskList[]): Promise<void> {
    if (!snapshots.length) return;
    for (const list of snapshots) {
      const index = this.db.lists.findIndex((l) => l.id === list.id);
      if (index >= 0) this.db.lists[index] = { ...list };
      else this.db.lists.push({ ...list });
    }
    await this.saveDb();
    this.emit('change', 'tasks');
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.deleteTasks([taskId]);
  }

  async deleteTasks(taskIds: string[]): Promise<void> {
    const doomed = new Set(taskIds);
    const before = this.db.tasks.length;
    this.db.tasks = this.db.tasks.filter((t) => !doomed.has(t.id));
    if (this.db.tasks.length === before) return;
    await this.saveDb();
    this.emit('change', 'tasks');
  }

  // --- the to-do list's lists ----------------------------------------------

  async upsertTaskList(input: Partial<TaskList> & { name: string }): Promise<TaskList> {
    const now = Date.now();
    const existing = input.id ? this.db.lists.find((l) => l.id === input.id) : undefined;
    if (existing) {
      Object.assign(existing, input, {
        color: normalizeListColor(input.color ?? existing.color),
        updatedAt: now,
      });
      await this.saveDb();
      this.emit('change', 'tasks');
      return existing;
    }
    const list: TaskList = {
      id: input.id ?? id('list'),
      name: input.name,
      emoji: input.emoji ?? '',
      color: normalizeListColor(input.color),
      order: input.order ?? orderForBottom(this.db.lists),
      archived: input.archived ?? false,
      createdAt: now,
      updatedAt: now,
    };
    this.db.lists.push(list);
    await this.saveDb();
    this.emit('change', 'tasks');
    return list;
  }

  /**
   * Delete a list. Its tasks go back to the Inbox unless the caller says to take
   * them with it — losing work because a folder was tidied away is the one thing
   * a to-do list must never do.
   */
  async deleteTaskList(listId: string, options: { deleteTasks?: boolean } = {}): Promise<void> {
    this.db.lists = this.db.lists.filter((l) => l.id !== listId);
    this.db.sections = this.db.sections.filter((s) => s.listId !== listId);
    if (options.deleteTasks) {
      this.db.tasks = this.db.tasks.filter((t) => t.listId !== listId);
    } else {
      for (const task of this.db.tasks) {
        if (task.listId !== listId) continue;
        task.listId = undefined;
        task.sectionId = undefined;
        task.updatedAt = Date.now();
      }
    }
    await this.saveDb();
    this.emit('change', 'tasks');
  }

  async reorderTaskLists(orderedIds: string[]): Promise<void> {
    orderedIds.forEach((listId, index) => {
      const list = this.db.lists.find((l) => l.id === listId);
      if (list) list.order = (index + 1) * 1000;
    });
    await this.saveDb();
    this.emit('change', 'tasks');
  }

  async upsertTaskSection(
    input: Partial<TaskSection> & { listId: string; name: string },
  ): Promise<TaskSection> {
    const existing = input.id ? this.db.sections.find((s) => s.id === input.id) : undefined;
    if (existing) {
      Object.assign(existing, input);
      await this.saveDb();
      this.emit('change', 'tasks');
      return existing;
    }
    const siblings = this.db.sections.filter((s) => s.listId === input.listId);
    const section: TaskSection = {
      id: input.id ?? id('sect'),
      listId: input.listId,
      name: input.name,
      order: input.order ?? (siblings.length + 1) * 1000,
      collapsed: input.collapsed,
    };
    this.db.sections.push(section);
    await this.saveDb();
    this.emit('change', 'tasks');
    return section;
  }

  /** Removing a heading keeps its tasks, unfiled at the top of the list. */
  async deleteTaskSection(sectionId: string): Promise<void> {
    this.db.sections = this.db.sections.filter((s) => s.id !== sectionId);
    for (const task of this.db.tasks) {
      if (task.sectionId !== sectionId) continue;
      task.sectionId = undefined;
      task.updatedAt = Date.now();
    }
    await this.saveDb();
    this.emit('change', 'tasks');
  }

  async addCalendarBlock(input: Partial<CalendarBlock> & { title: string; start: number; end: number }): Promise<CalendarBlock> {
    const block: CalendarBlock = {
      id: input.id ?? id('cal'),
      title: input.title,
      start: input.start,
      end: input.end,
      kind: input.kind ?? 'busy',
      meetingId: input.meetingId,
    };
    const existingIdx = this.db.calendar.findIndex((b) => b.id === block.id);
    if (existingIdx >= 0) this.db.calendar[existingIdx] = block;
    else this.db.calendar.push(block);
    await this.saveDb();
    this.emit('change', 'calendar');
    return block;
  }

  async removeCalendarBlock(blockId: string): Promise<void> {
    this.db.calendar = this.db.calendar.filter((b) => b.id !== blockId);
    await this.saveDb();
    this.emit('change', 'calendar');
  }

  async removeCalendarBlockForMeeting(meetingId: string): Promise<void> {
    this.db.calendar = this.db.calendar.filter((b) => b.meetingId !== meetingId);
    await this.saveDb();
    this.emit('change', 'calendar');
  }

  async addFeedback(input: Omit<Feedback, 'id' | 'createdAt'> & { id?: string }): Promise<Feedback> {
    const fb: Feedback = { ...input, id: input.id ?? id('fb'), createdAt: Date.now() };
    this.db.feedback.push(fb);
    await this.saveDb();
    this.emit('change', 'feedback');
    return fb;
  }

  // --- meetings ------------------------------------------------------------

  async saveMeeting(meeting: Meeting): Promise<MeetingRecord> {
    const existing = this.meetingsMap.get(meeting.id);
    const record: MeetingRecord = existing
      ? { ...existing, meeting }
      : { meeting, transcript: [] };
    this.meetingsMap.set(meeting.id, record);
    await this.writeMeeting(record);
    this.emit('change', 'meetings');
    return record;
  }

  async saveMeetingTranscript(
    meetingId: string,
    transcript: TranscriptEntry[],
    minutes?: Minutes,
  ): Promise<void> {
    const record = this.meetingsMap.get(meetingId);
    if (!record) return;
    record.transcript = transcript;
    if (minutes) record.minutes = minutes;
    await this.writeMeeting(record);
    this.emit('change', 'meetings');
  }

  async saveMeetingOutcome(meetingId: string, outcome: MeetingOutcome): Promise<void> {
    const record = this.meetingsMap.get(meetingId);
    if (!record) return;
    record.outcome = outcome;
    await this.writeMeeting(record);
    this.emit('change', 'meetings');
  }

  async setMeetingStatus(meetingId: string, status: Meeting['status']): Promise<void> {
    const record = this.meetingsMap.get(meetingId);
    if (!record) return;
    record.meeting.status = status;
    await this.writeMeeting(record);
    this.emit('change', 'meetings');
  }

  upcomingMeetings(now = Date.now()): MeetingRecord[] {
    return this.meetings
      .filter((m) => m.meeting.end >= now && (m.meeting.status === 'scheduled' || m.meeting.status === 'live'))
      .sort((a, b) => a.meeting.start - b.meeting.start);
  }

  // --- client state --------------------------------------------------------

  get client(): ClientState {
    return this.clientState;
  }

  get relays(): string[] {
    return [...this.clientState.relays];
  }

  async setRelays(urls: string[]): Promise<void> {
    this.clientState.relays = [...new Set(urls.filter(Boolean))];
    await this.saveClient();
    this.emit('change', 'client');
  }

  /** Has this exact reminder already been raised, in this run or an earlier one? */
  wasReminded(key: string): boolean {
    return this.clientState.reminded[key] !== undefined;
  }

  /** Record reminders as raised, pruning ones too old to still matter. */
  async markReminded(keys: string[]): Promise<void> {
    if (!keys.length) return;
    const now = Date.now();
    for (const key of keys) this.clientState.reminded[key] = now;
    const cutoff = now - 30 * 24 * 60 * 60_000;
    for (const [key, at] of Object.entries(this.clientState.reminded)) {
      if (at < cutoff) delete this.clientState.reminded[key];
    }
    await this.saveClient();
  }

  /** The session held on one relay, if the person has signed in to it. */
  session(relayUrl: string): RelaySession | undefined {
    return this.clientState.sessions?.[relayUrl];
  }

  async saveSession(relayUrl: string, session: RelaySession): Promise<void> {
    this.clientState.sessions ??= {};
    this.clientState.sessions[relayUrl] = session;
    await this.saveClient();
    this.emit('change', 'client');
  }

  async clearSession(relayUrl: string): Promise<void> {
    if (!this.clientState.sessions?.[relayUrl]) return;
    delete this.clientState.sessions[relayUrl];
    await this.saveClient();
    this.emit('change', 'client');
  }

  prefs(workspaceId: string): WorkspacePrefs {
    const existing = this.clientState.prefs[workspaceId];
    if (existing) {
      existing.channels ??= {};
      existing.collapsed ??= [];
      return existing;
    }
    const fresh = defaultWorkspacePrefs(workspaceId);
    this.clientState.prefs[workspaceId] = fresh;
    return fresh;
  }

  /**
   * The agent that represents this person in one workspace.
   *
   * Created on first read, which is deliberate: the moment you are in a
   * workspace you have an agent there, and it starts gated shut rather than
   * inheriting whatever the agent next door was trusted with.
   */
  workspaceAgent(workspaceId: string, seed?: { name?: string; emoji?: string; accent?: string }): WorkspaceAgent {
    this.clientState.agents ??= {};
    const stored = this.clientState.agents[workspaceId];
    // The seed only ever names a *new* agent: once one exists, what it is
    // called is the person's answer, not the workspace's.
    const agent = normalizeWorkspaceAgent(workspaceId, stored ?? seed);
    this.clientState.agents[workspaceId] = agent;
    // A newly created agent is written straight away rather than waiting for
    // somebody to change something. Otherwise it exists only in memory, and a
    // restart would introduce "your new agent" all over again — and, worse,
    // would forget that its grants were deliberately empty rather than unset.
    if (!stored) void this.saveClient();
    return agent;
  }

  /** Every workspace agent this person has, for the isolation overview. */
  get workspaceAgents(): WorkspaceAgent[] {
    this.clientState.agents ??= {};
    return Object.values(this.clientState.agents);
  }

  async saveWorkspaceAgent(workspaceId: string, patch: WorkspaceAgentPatch): Promise<WorkspaceAgent> {
    const next = applyAgentPatch(this.workspaceAgent(workspaceId), patch);
    this.clientState.agents[workspaceId] = next;
    await this.saveClient();
    this.emit('change', 'agents');
    return next;
  }

  /** Leaving a workspace takes its agent — and its grants — with it. */
  async forgetWorkspaceAgent(workspaceId: string): Promise<void> {
    if (!this.clientState.agents?.[workspaceId]) return;
    delete this.clientState.agents[workspaceId];
    await this.saveClient();
    this.emit('change', 'agents');
  }

  channelPrefs(workspaceId: string, channelId: string) {
    const workspace = this.prefs(workspaceId);
    workspace.channels[channelId] ??= defaultChannelPrefs(channelId);
    return workspace.channels[channelId]!;
  }

  async saveWorkspacePrefs(workspaceId: string, patch: Partial<WorkspacePrefs>): Promise<void> {
    const prefs = this.prefs(workspaceId);
    Object.assign(prefs, patch);
    await this.saveClient();
    this.emit('change', 'client');
  }

  async saveChannelPrefs(
    workspaceId: string,
    channelId: string,
    patch: Partial<{ notify: WorkspacePrefs['notify']; muted: boolean; starred: boolean }>,
  ): Promise<void> {
    Object.assign(this.channelPrefs(workspaceId, channelId), patch);
    await this.saveClient();
    this.emit('change', 'client');
  }

  draft(key: string): string {
    return this.clientState.drafts[key] ?? '';
  }

  /** Drafts change on every keystroke, so this is deliberately fire-and-forget. */
  setDraft(key: string, text: string): void {
    if (text) this.clientState.drafts[key] = text;
    else delete this.clientState.drafts[key];
    void this.saveClient();
  }

  async rememberPlace(workspaceId: string, channelId?: string): Promise<void> {
    this.clientState.lastWorkspace = workspaceId;
    if (channelId) this.clientState.lastChannel[workspaceId] = channelId;
    await this.saveClient();
  }

  async setStatus(status: UserStatus, presence?: Presence): Promise<void> {
    this.clientState.status = status;
    if (presence) this.clientState.presence = presence;
    await this.saveClient();
    this.emit('change', 'client');
  }

  // --- persistence ---------------------------------------------------------

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.writeQueue = this.writeQueue.then(work, work);
    return this.writeQueue;
  }

  private saveProfile(): Promise<void> {
    return this.enqueue(() => writeJsonAtomic(path.join(this.root, 'profile.json'), this.profileData));
  }

  private saveDb(): Promise<void> {
    return this.enqueue(() => writeJsonAtomic(path.join(this.root, 'db.json'), this.db));
  }

  private saveClient(): Promise<void> {
    return this.enqueue(() => writeJsonAtomic(path.join(this.root, 'client.json'), this.clientState));
  }

  private saveNote(note: Note): Promise<void> {
    return this.enqueue(async () => {
      const previous = this.noteFiles.get(note.id);
      // A note that already has a home keeps it — the vault owns file layout,
      // and renaming behind the user's back would break their links.
      const desired = note.path ?? previous ?? this.freeNotePath(`${slugify(note.title)}.md`);
      this.noteFiles.set(note.id, desired);
      note.path = desired;
      const abs = path.join(this.vaultDir, desired);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, serializeNote(note, this.noteExtras.get(note.id) ?? {}), 'utf8');
    });
  }

  /** First unused file name for a new note. */
  private freeNotePath(name: string): string {
    const taken = new Set(this.noteFiles.values());
    if (!taken.has(name)) return name;
    const stem = name.replace(/\.md$/, '');
    for (let i = 1; i < 500; i += 1) {
      const candidate = `${stem} ${i}.md`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${stem}-${id('n').slice(-6)}.md`;
  }

  private writeMeeting(record: MeetingRecord): Promise<void> {
    return this.enqueue(() =>
      writeJsonAtomic(path.join(this.root, 'meetings', `${record.meeting.id}.json`), record),
    );
  }

  /** Wait for all pending disk writes. Used by tests and on shutdown. */
  flush(): Promise<void> {
    return this.writeQueue;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
