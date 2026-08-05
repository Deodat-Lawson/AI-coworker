/**
 * The contract between the Electron main process (which owns the agent) and the
 * renderer (which only draws). Kept in one file so both sides stay in step.
 */

import type {
  Appearance,
  Artifact,
  AuditEntry,
  CalendarBlock,
  Channel,
  ChannelPrefs,
  ChannelReadState,
  Feedback,
  GlobalSettings,
  GlobalSettingsPatch,
  Invite,
  JoinRequest,
  Meeting,
  MeetingPhase,
  MeetingRecord,
  Message,
  Note,
  Presence,
  Profile,
  Project,
  PublicProfile,
  SearchResults,
  Task,
  TranscriptEntry,
  UserStatus,
  VaultSearchHit,
  VaultSettings,
  VaultSnapshot,
  Workspace,
  WorkspaceMember,
  WorkspacePermissions,
  WorkspacePrefs,
  WorkspaceRole,
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

// --- workspaces --------------------------------------------------------------

/** One row in the channel sidebar, with everything needed to draw it. */
export interface ChannelView {
  channel: Channel;
  /** "#general", or the people in a direct message. */
  label: string;
  read: ChannelReadState;
  /** Last thing said, for DM rows and search results. */
  preview: string;
  /** Display names of people currently typing. */
  typing: string[];
  prefs: ChannelPrefs;
  joined: boolean;
  /** Presence of the other person, for one-to-one DMs. */
  presence?: Presence;
}

export interface WorkspaceView {
  workspace: Workspace;
  relayUrl: string;
  connection: 'offline' | 'connecting' | 'online' | 'error';
  me: WorkspaceMember;
  members: WorkspaceMember[];
  channels: ChannelView[];
  unread: number;
  mentions: number;
  invites: Invite[];
  /** Populated only for admins; the relay refuses to send these to anybody else. */
  joinRequests: JoinRequest[];
  audit: AuditEntry[];
  prefs: WorkspacePrefs;
}

/** A mention or reaction worth showing in the Activity view. */
export interface ActivityItem {
  kind: 'mention' | 'reaction' | 'thread_reply';
  workspaceId: string;
  workspaceName: string;
  channelId: string;
  channelLabel: string;
  message: Message;
  /** For reactions: who reacted, and with what. */
  emoji?: string;
  by?: string;
  ts: number;
}

export interface ThreadView {
  workspaceId: string;
  channelId: string;
  root: Message;
  replies: Message[];
}

export interface DiscoverableWorkspaceView {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  memberCount: number;
  joined: boolean;
  relayUrl: string;
}

export interface AppState {
  /** False until a profile exists — the renderer shows onboarding. */
  ready: boolean;
  knowledgeDir: string | null;
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

  // --- workspaces ---
  workspaces: WorkspaceView[];
  activeWorkspaceId: string;
  activeChannelId: string;
  /**
   * Where the reader had got to when they opened the channel, captured before
   * it was marked read — this is what the "new messages" divider hangs on.
   */
  unreadFrom: number;
  /** The open channel's timeline. Other channels stay in the main process. */
  messages: Message[];
  /** False while older messages remain on the relay. */
  historyComplete: boolean;
  thread: ThreadView | null;
  /** Mentions and reactions across every workspace, newest first. */
  activity: ActivityItem[];
  search: SearchResults | null;
  discoverable: DiscoverableWorkspaceView[];
  relays: string[];
  status: UserStatus;
  presence: Presence;
  /** The theme the person chose: dark, light, or follow the machine. */
  appearance: Appearance;
  /** The account this app is signed in as, if the relay has accounts. */
  account: { email: string; displayName: string; address: string } | null;
}

// --- signing up and in -------------------------------------------------------

export interface AuthAccountView {
  id: string;
  email: string;
  displayName: string;
  address: string;
  hasPassword: boolean;
  createdAt: number;
}

/** A workspace this verified email is already welcome in. */
export interface WelcomeWorkspaceView {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  memberCount: number;
  joined: boolean;
  /** `request` means an admin has to say yes first. */
  how: 'open' | 'request';
}

export interface PendingInvitationView {
  code: string;
  workspaceId: string;
  workspaceName: string;
  role: string;
  invitedBy: string;
  expiresAt: number;
}

/** What both the code path and the password path hand back. */
export interface AuthResult {
  account: AuthAccountView;
  /** True when the account did not exist until this moment. */
  created: boolean;
  /** True when they have not named themselves or set a password yet. */
  needsProfile: boolean;
  workspaces: WelcomeWorkspaceView[];
  invitations: PendingInvitationView[];
  relayUrl: string;
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
  knowledgeDir?: string;
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
  workspaceId?: string;
  channelId?: string;
}

export interface SendMessageInput {
  workspaceId: string;
  channelId: string;
  text: string;
  threadRootId?: string;
  alsoSendToChannel?: boolean;
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
  setAppearance(appearance: Appearance): Promise<IpcResult>;

  /**
   * The installation's settings, whole. The single-purpose setters above are
   * still here because most screens change exactly one thing, but this is the
   * surface that says what "global" means — everything not tied to an agent or
   * a workspace.
   */
  getSettings(): Promise<IpcResult<GlobalSettings>>;
  updateSettings(patch: GlobalSettingsPatch): Promise<IpcResult<GlobalSettings>>;
  chooseKnowledgeDir(): Promise<IpcResult<string | null>>;
  openKnowledgeDir(): Promise<IpcResult>;

  // --- signing up and in ---
  authConfig(
    relayUrl?: string,
  ): Promise<IpcResult<{ relayName: string; accounts: number; codesInResponse: boolean }>>;
  authStart(input: {
    email: string;
    relayUrl?: string;
  }): Promise<IpcResult<{ email: string; expiresAt: number; devCode?: string }>>;
  authVerify(input: { email: string; code: string; relayUrl?: string }): Promise<IpcResult<AuthResult>>;
  authLogin(input: { email: string; password: string; relayUrl?: string }): Promise<IpcResult<AuthResult>>;
  authProfile(patch: { displayName?: string; password?: string }): Promise<IpcResult<AuthAccountView>>;
  authCreateWorkspace(input: {
    name: string;
    project?: string;
    description?: string;
    discoverable?: boolean;
  }): Promise<IpcResult<{ workspaceId: string; name: string; createdChannel: string }>>;
  authJoin(input: {
    workspaceId?: string;
    code?: string;
    message?: string;
  }): Promise<IpcResult<{ workspaceId: string; requested: boolean }>>;
  authInvite(input: {
    workspaceId: string;
    emails: string[];
  }): Promise<
    IpcResult<{ invited: { email: string; code: string }[]; failed: { email: string; error: string }[] }>
  >;
  /** Create the local knowledge base for the signed-in account and start the agent. */
  authFinish(input: {
    knowledgeDir?: string;
    title?: string;
    team?: string;
    focusAreas?: string[];
  }): Promise<IpcResult>;
  authSignOut(): Promise<IpcResult>;

  // --- workspaces ---
  openChannel(workspaceId: string, channelId: string): Promise<IpcResult>;
  openThread(workspaceId: string, channelId: string, rootId: string | null): Promise<IpcResult>;
  loadOlder(): Promise<IpcResult>;
  sendMessage(input: SendMessageInput): Promise<IpcResult>;
  editMessage(workspaceId: string, messageId: string, text: string): Promise<IpcResult>;
  deleteMessage(workspaceId: string, messageId: string): Promise<IpcResult>;
  react(workspaceId: string, messageId: string, emoji: string, on: boolean): Promise<IpcResult>;
  pinMessage(workspaceId: string, messageId: string, pinned: boolean): Promise<IpcResult>;
  typing(workspaceId: string, channelId: string): Promise<IpcResult>;
  markRead(workspaceId: string, channelId: string): Promise<IpcResult>;

  createWorkspace(input: {
    name: string;
    description?: string;
    icon?: string;
    color?: string;
    discoverable?: boolean;
    channels?: string[];
    relayUrl?: string;
  }): Promise<IpcResult>;
  joinWorkspace(input: { code?: string; slug?: string; relayUrl?: string }): Promise<IpcResult>;
  leaveWorkspace(workspaceId: string): Promise<IpcResult>;
  updateWorkspace(workspaceId: string, patch: Partial<Workspace>): Promise<IpcResult>;
  deleteWorkspace(workspaceId: string): Promise<IpcResult>;
  discoverWorkspaces(): Promise<IpcResult>;
  setWorkspacePermissions(workspaceId: string, patch: Partial<WorkspacePermissions>): Promise<IpcResult>;
  setMemberRole(
    workspaceId: string,
    addresses: string | string[],
    role: WorkspaceRole,
    guestChannels?: string[],
  ): Promise<IpcResult>;
  removeMember(workspaceId: string, addresses: string | string[]): Promise<IpcResult>;
  setMemberActive(workspaceId: string, addresses: string | string[], active: boolean): Promise<IpcResult>;
  transferOwnership(workspaceId: string, address: string): Promise<IpcResult>;
  setWorkspaceProfile(
    workspaceId: string,
    patch: { address?: string; displayName?: string; title?: string },
  ): Promise<IpcResult>;
  requestToJoin(slug: string, message?: string, relayUrl?: string): Promise<IpcResult>;
  reviewJoinRequest(
    workspaceId: string,
    requestId: string,
    approve: boolean,
    role?: WorkspaceRole,
  ): Promise<IpcResult>;
  listJoinRequests(workspaceId: string): Promise<IpcResult>;
  listAudit(workspaceId: string, limit?: number): Promise<IpcResult>;
  createInvite(
    workspaceId: string,
    input?: {
      invitedAddress?: string;
      role?: WorkspaceRole;
      expiresInHours?: number;
      maxUses?: number;
      channels?: string[];
    },
  ): Promise<IpcResult>;
  revokeInvite(workspaceId: string, code: string): Promise<IpcResult>;

  createChannel(
    workspaceId: string,
    input: { name: string; kind?: 'public' | 'private'; topic?: string; purpose?: string; members?: string[] },
  ): Promise<IpcResult>;
  updateChannel(
    workspaceId: string,
    channelId: string,
    patch: { name?: string; topic?: string; purpose?: string },
  ): Promise<IpcResult>;
  archiveChannel(workspaceId: string, channelId: string, archived: boolean): Promise<IpcResult>;
  joinChannel(workspaceId: string, channelId: string): Promise<IpcResult>;
  leaveChannel(workspaceId: string, channelId: string): Promise<IpcResult>;
  addToChannel(workspaceId: string, channelId: string, addresses: string[]): Promise<IpcResult>;
  removeFromChannel(workspaceId: string, channelId: string, address: string): Promise<IpcResult>;
  openDirectMessage(workspaceId: string, addresses: string[]): Promise<IpcResult>;

  setChannelPrefs(workspaceId: string, channelId: string, patch: Partial<ChannelPrefs>): Promise<IpcResult>;
  setWorkspacePrefs(workspaceId: string, patch: Partial<WorkspacePrefs>): Promise<IpcResult>;
  setStatus(status: UserStatus, presence?: Presence): Promise<IpcResult>;
  search(workspaceId: string, query: string): Promise<IpcResult>;
  clearSearch(): Promise<IpcResult>;
  addRelay(url: string): Promise<IpcResult>;
  removeRelay(url: string): Promise<IpcResult>;
  saveDraft(key: string, text: string): Promise<IpcResult>;
  getDrafts(): Promise<IpcResult<Record<string, string>>>;

  onState(handler: (state: AppState) => void): () => void;
  /** Fired when a notification is clicked, so the app can jump to the message. */
  onOpenChannel(handler: (target: { workspaceId: string; channelId: string }) => void): () => void;

  // --- vault -----------------------------------------------------------------
  vaultState(): Promise<IpcResult<VaultState>>;
  vaultRead(path: string): Promise<IpcResult<string>>;
  vaultWrite(path: string, content: string): Promise<IpcResult>;
  vaultCreate(path: string, content?: string): Promise<IpcResult<string>>;
  vaultCreateFolder(path: string): Promise<IpcResult<string>>;
  vaultRename(from: string, to: string): Promise<IpcResult<{ path: string; updated: string[] }>>;
  vaultDelete(path: string): Promise<IpcResult>;
  vaultSearch(query: string, options?: VaultSearchOptions): Promise<IpcResult<VaultSearchHit[]>>;
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
