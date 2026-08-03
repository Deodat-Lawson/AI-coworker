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
  type TranscriptEntry,
  type UserStatus,
  type Visibility,
  type WorkspacePrefs,
  defaultChannelPrefs,
  defaultWorkspacePrefs,
  emptyStatus,
  id,
  slugify,
} from '@ai-coworker/shared';

interface DbShape {
  version: number;
  projects: Project[];
  artifacts: Artifact[];
  tasks: Task[];
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
  /** Unsent text, keyed `workspaceId:channelId` (or `:threadRootId`). */
  drafts: Record<string, string>;
  /** Where to reopen: the last workspace, and the last channel inside each. */
  lastWorkspace: string;
  lastChannel: Record<string, string>;
  /** Custom status, mirrored to every relay on connect. */
  status: UserStatus;
  presence: Presence;
}

function emptyClientState(): ClientState {
  return {
    version: 1,
    relays: [],
    prefs: {},
    drafts: {},
    lastWorkspace: '',
    lastChannel: {},
    status: emptyStatus(),
    presence: 'active',
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

function serializeNote(note: Note): string {
  const fm = [
    '---',
    `id: ${note.id}`,
    `title: ${escapeScalar(note.title)}`,
    `kind: ${note.kind}`,
    `visibility: ${note.visibility}`,
    note.projectId ? `projectId: ${note.projectId}` : null,
    `tags: ${note.tags.join(', ')}`,
    `createdAt: ${note.createdAt}`,
    `updatedAt: ${note.updatedAt}`,
    '---',
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
  return `${fm}${note.body.trimEnd()}\n`;
}

function escapeScalar(value: string): string {
  // Keep it on one line; the parser splits on the first colon only.
  return value.replace(/\r?\n/g, ' ').trim();
}

function parseNote(raw: string, fallbackId: string): Note | null {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!match) return null;
  const body = raw.slice(match[0].length);
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const now = Date.now();
  return {
    id: fields.id || fallbackId,
    title: fields.title || 'Untitled',
    kind: (fields.kind as Note['kind']) || 'update',
    visibility: (fields.visibility as Visibility) || 'team',
    projectId: fields.projectId || undefined,
    tags: fields.tags ? fields.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    createdAt: Number(fields.createdAt) || now,
    updatedAt: Number(fields.updatedAt) || now,
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
    db.calendar ??= [];
    db.feedback ??= [];

    const ws = new KnowledgeBase(root, profile, db);
    const client = await readJson<ClientState>(path.join(root, 'client.json'), emptyClientState());
    ws.clientState = { ...emptyClientState(), ...client };
    ws.clientState.prefs ??= {};
    ws.clientState.drafts ??= {};
    ws.clientState.lastChannel ??= {};
    ws.clientState.relays ??= [];
    await ws.loadNotes();
    await ws.loadMeetings();
    if (seedProfile && !(await exists(profileFile))) await ws.saveProfile();
    return ws;
  }

  private async loadNotes(): Promise<void> {
    const dir = path.join(this.root, 'notes');
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    for (const file of entries) {
      if (!file.endsWith('.md')) continue;
      const raw = await fs.readFile(path.join(dir, file), 'utf8');
      const note = parseNote(raw, id('note'));
      if (!note) continue;
      this.notesMap.set(note.id, note);
      this.noteFiles.set(note.id, file);
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
    if (file) await fs.rm(path.join(this.root, 'notes', file), { force: true });
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

  async upsertTask(input: Partial<Task> & { title: string }): Promise<Task> {
    const now = Date.now();
    const existing = input.id ? this.db.tasks.find((t) => t.id === input.id) : undefined;
    if (existing) {
      Object.assign(existing, input, { updatedAt: now });
      await this.saveDb();
      this.emit('change', 'tasks');
      return existing;
    }
    const task: Task = {
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
      createdAt: now,
      updatedAt: now,
    };
    this.db.tasks.push(task);
    await this.saveDb();
    this.emit('change', 'tasks');
    return task;
  }

  async deleteTask(taskId: string): Promise<void> {
    this.db.tasks = this.db.tasks.filter((t) => t.id !== taskId);
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
      const desired = `${slugify(note.title)}-${note.id.slice(-6)}.md`;
      const previous = this.noteFiles.get(note.id);
      if (previous && previous !== desired) {
        await fs.rm(path.join(this.root, 'notes', previous), { force: true });
      }
      this.noteFiles.set(note.id, desired);
      await fs.writeFile(path.join(this.root, 'notes', desired), serializeNote(note), 'utf8');
    });
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
