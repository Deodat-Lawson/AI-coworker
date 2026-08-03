/**
 * The contract between the Electron main process (which owns the agent) and the
 * renderer (which only draws). Kept in one file so both sides stay in step.
 */

import type {
  Artifact,
  CalendarBlock,
  Feedback,
  MeetingRecord,
  Note,
  Profile,
  Project,
  PublicProfile,
  SearchHit,
  Task,
  TranscriptEntry,
  MeetingPhase,
  Meeting,
  VaultSettings,
  VaultSnapshot,
} from '@ai-coworker/shared';

/** Mirrors the vault's bookmark record; declared here to keep the renderer node-free. */
export interface VaultBookmark {
  type: 'file' | 'folder' | 'search' | 'graph' | 'heading' | 'block';
  path?: string;
  subpath?: string;
  query?: string;
  title?: string;
  ctime: number;
}

export interface VaultState extends VaultSnapshot {
  settings: VaultSettings;
  bookmarks: VaultBookmark[];
}

export interface VaultSearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  limit?: number;
  folder?: string;
}

/** Mirrors the agent's activity entry; declared here so the renderer needs no node deps. */
export interface AgentActivity {
  id: string;
  ts: number;
  kind: 'info' | 'meeting' | 'task' | 'error';
  text: string;
}

export interface LiveMeetingView {
  meeting: Meeting;
  phase: MeetingPhase;
  transcript: TranscriptEntry[];
  present: string[];
  speaking?: string;
  thinking: boolean;
}

export interface ConnectionView {
  state: 'offline' | 'connecting' | 'online' | 'error';
  error: string | null;
  relayUrl: string;
  providerName: string;
  providerLive: boolean;
  providerReason: string;
  /** The key itself never crosses the IPC boundary — only whether one exists. */
  hasApiKey: boolean;
  apiKeySource: 'settings' | 'environment' | 'none';
  model: string;
}

export interface ChatEntry {
  role: 'user' | 'assistant';
  content: string;
  actions?: { tool: string; result: string }[];
}

export interface AppState {
  /** False until a profile exists — the renderer shows onboarding. */
  ready: boolean;
  workspaceDir: string | null;
  profile: Profile | null;
  connection: ConnectionView;
  directory: PublicProfile[];
  projects: Project[];
  notes: Note[];
  artifacts: Artifact[];
  tasks: Task[];
  calendar: CalendarBlock[];
  feedback: Feedback[];
  meetings: MeetingRecord[];
  live: LiveMeetingView[];
  activities: AgentActivity[];
  chat: ChatEntry[];
  personas: { key: string; displayName: string; title: string; role: string }[];
}

export interface SetupInput {
  mode: 'persona' | 'custom';
  personaKey?: string;
  displayName?: string;
  handle?: string;
  domain?: string;
  title?: string;
  role?: 'manager' | 'ic';
  team?: string;
  bio?: string;
  focusAreas?: string[];
  workspaceDir?: string;
  relayUrl?: string;
}

export interface MeetingRequestInput {
  participants: string[];
  title: string;
  purpose: string;
  kind?: 'standup' | 'one_on_one' | 'review' | 'planning' | 'sync';
  durationMins?: number;
  urgency?: 'whenever' | 'this_week' | 'asap';
  agenda?: string[];
  chair?: string;
}

export type IpcResult<T = void> = { ok: true; value: T } | { ok: false; error: string };

export interface DesktopApi {
  getState(): Promise<AppState>;
  setup(input: SetupInput): Promise<IpcResult>;
  chat(message: string): Promise<IpcResult<{ reply: string; actions: { tool: string; result: string }[] }>>;
  clearChat(): Promise<IpcResult>;
  requestMeeting(input: MeetingRequestInput): Promise<IpcResult>;
  startMeetingNow(meetingId: string): Promise<IpcResult>;
  cancelMeeting(meetingId: string, reason: string): Promise<IpcResult>;
  saveProfile(patch: Partial<Profile>): Promise<IpcResult>;
  saveProject(input: Partial<Project> & { name: string }): Promise<IpcResult>;
  deleteProject(id: string): Promise<IpcResult>;
  saveNote(input: Partial<Note> & { title: string; body: string }): Promise<IpcResult>;
  deleteNote(id: string): Promise<IpcResult>;
  saveArtifact(input: Partial<Artifact> & { title: string }): Promise<IpcResult>;
  deleteArtifact(id: string): Promise<IpcResult>;
  saveTask(input: Partial<Task> & { title: string }): Promise<IpcResult>;
  deleteTask(id: string): Promise<IpcResult>;
  addCalendarBlock(input: { title: string; start: number; end: number; kind?: string }): Promise<IpcResult>;
  removeCalendarBlock(id: string): Promise<IpcResult>;
  setRelayUrl(url: string): Promise<IpcResult>;
  reconnect(): Promise<IpcResult>;
  setBrain(input: { apiKey?: string; model?: string }): Promise<IpcResult>;
  chooseWorkspaceDir(): Promise<IpcResult<string | null>>;
  openWorkspaceDir(): Promise<IpcResult>;
  onState(handler: (state: AppState) => void): () => void;

  // --- vault -----------------------------------------------------------------
  vaultState(): Promise<IpcResult<VaultState>>;
  vaultRead(path: string): Promise<IpcResult<string>>;
  vaultWrite(path: string, content: string): Promise<IpcResult>;
  vaultCreate(path: string, content?: string): Promise<IpcResult<string>>;
  vaultCreateFolder(path: string): Promise<IpcResult<string>>;
  vaultRename(from: string, to: string): Promise<IpcResult<{ path: string; updated: string[] }>>;
  vaultDelete(path: string): Promise<IpcResult>;
  vaultSearch(query: string, options?: VaultSearchOptions): Promise<IpcResult<SearchHit[]>>;
  vaultSaveSettings(patch: Partial<VaultSettings>): Promise<IpcResult<VaultSettings>>;
  vaultSaveBookmarks(items: VaultBookmark[]): Promise<IpcResult>;
  vaultDailyNote(): Promise<IpcResult<string>>;
  /** Notes that name this one in prose without linking to it. */
  vaultMentions(path: string): Promise<IpcResult<{ from: string; line: number; context: string }[]>>;
  vaultTemplate(templatePath: string, title: string): Promise<IpcResult<string>>;
  /** Store a pasted or dropped file in the attachment folder; returns its path. */
  vaultSaveAttachment(name: string, dataBase64: string): Promise<IpcResult<string>>;
  vaultReveal(path: string): Promise<IpcResult>;
  vaultOpenExternal(url: string): Promise<IpcResult>;
  /** Export a note; returns the file written, or null if the user cancelled. */
  vaultExport(path: string, format: 'pdf' | 'html' | 'md', html?: string): Promise<IpcResult<string | null>>;
  onVaultChange(handler: (state: VaultState) => void): () => void;
}
