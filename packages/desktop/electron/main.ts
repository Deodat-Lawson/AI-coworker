/**
 * Electron main process.
 *
 * The personal agent runs *here*, in the desktop process, next to the knowledge
 * base on the user's disk. The renderer is a view: it never touches the store,
 * the network, or the model directly.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  MemoryIndex,
  PersonalAgent,
  KnowledgeBase,
  Vault,
  PERSONAS,
  createProvider,
  emptyProfile,
  findPersona,
  loadEnvFromAncestors,
  resolveApiKey,
  seedKnowledgeBase,
} from '@ai-coworker/agent';
import type {
  AgentNotification,
  Bookmark,
  WorkspaceState,
} from '@ai-coworker/agent';
import type {
  ChannelPrefs,
  Message,
  Presence,
  Profile,
  UserStatus,
  VaultSearchHit,
  VaultSettings,
  Workspace,
  WorkspacePrefs,
  WorkspaceRole,
} from '@ai-coworker/shared';
import { emptyStatus, isDirect } from '@ai-coworker/shared';
import {
  BrowserWindow,
  Notification,
  app,
  dialog,
  ipcMain,
  net,
  protocol,
  shell,
} from 'electron';

import type {
  ActivityItem,
  AppState,
  ChannelView,
  ChatEntry,
  DiscoverableWorkspaceView,
  IpcResult,
  MeetingRequestInput,
  SendMessageInput,
  SetupInput,
  ThreadView,
  VaultSearchOptions,
  VaultState,
  WorkspaceView,
} from './ipc.js';
import { MEMORY_CHANNELS, buildMemoryState, registerMemoryIpc } from './memory-ipc.js';

const DEFAULT_RELAY = process.env.AI_COWORKER_RELAY || 'ws://localhost:8787';

interface Config {
  knowledgeDir?: string;
  relayUrl?: string;
  /** Set from Settings. Falls back to GEMINI_API_KEY in the environment or a .env file. */
  geminiApiKey?: string;
  geminiModel?: string;
}

let mainWindow: BrowserWindow | null = null;
let knowledge: KnowledgeBase | null = null;
let vault: Vault | null = null;
let agent: PersonalAgent | null = null;
/** Memory imported from this person's other agents, beside the knowledge base. */
let memoryIndex: MemoryIndex | null = null;
let config: Config = {};
let chatEntries: ChatEntry[] = [];
let pushTimer: NodeJS.Timeout | null = null;
let vaultPushTimer: NodeJS.Timeout | null = null;
let devHooksRan = false;

/**
 * Send to the renderer, if there is still a renderer to send to. These fire
 * from timers, so an unguarded send during teardown or a reload surfaces as an
 * uncaught exception in the main process.
 */
function sendToRenderer(channel: string, payload: unknown): void {
  const contents = mainWindow?.webContents;
  if (!contents || contents.isDestroyed()) return;
  try {
    contents.send(channel, payload);
  } catch {
    // The frame went away between the check and the send; nothing to do.
  }
}

/**
 * What the person is looking at. The renderer owns navigation, but the main
 * process needs to know so it can ship exactly one channel's messages across
 * the wire instead of every message in every workspace.
 */
let view = { workspaceId: '', channelId: '', threadRootId: '', unreadFrom: 0 };

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

async function loadConfig(): Promise<Config> {
  try {
    const raw = JSON.parse(await fs.readFile(configPath(), 'utf8')) as Config & {
      workspaceDir?: string;
    };
    // `workspaceDir` was this key's name before "workspace" came to mean a
    // Slack-style shared space. Keep reading it so existing installs still
    // find the knowledge base they already have on disk.
    if (!raw.knowledgeDir && raw.workspaceDir) raw.knowledgeDir = raw.workspaceDir;
    delete raw.workspaceDir;
    return raw;
  } catch {
    return {};
  }
}

async function saveConfig(): Promise<void> {
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(config, null, 2), 'utf8');
}

function defaultKnowledgeDir(): string {
  // Folder name kept from an earlier release so upgrades keep their data.
  return path.join(app.getPath('userData'), 'workspace');
}

// --- workspace views ---------------------------------------------------------

/**
 * Turn the agent's live workspace replica into plain objects the renderer can
 * hold. Maps and Sets do not survive structured cloning intact enough to be
 * pleasant on the other side, and the sidebar wants everything pre-computed.
 */
function buildWorkspaceViews(a: PersonalAgent, kb: KnowledgeBase): WorkspaceView[] {
  return a.workspaces.all.map((state) => {
    const totals = a.workspaces.totals(state.workspace.id);
    const channels: ChannelView[] = [...state.channels.values()].map((channel) => {
      const typing = a.workspaces
        .typing(state.workspace.id, channel.id)
        .filter((address) => address !== state.me.address)
        .map((address) => state.members.get(address)?.displayName ?? address.split('@')[0]!);
      const other =
        channel.kind === 'dm' ? channel.members.find((m) => m !== state.me.address) : undefined;
      return {
        channel,
        label: a.workspaces.label(state.workspace.id, channel.id),
        read:
          a.workspaces.read(state.workspace.id, channel.id) ??
          { channelId: channel.id, lastReadTs: 0, unread: 0, mentions: 0 },
        preview: a.workspaces.preview(state.workspace.id, channel.id),
        typing,
        prefs: kb.channelPrefs(state.workspace.id, channel.id),
        joined: channel.members.includes(state.me.address),
        presence: other ? state.members.get(other)?.presence : undefined,
      };
    });

    return {
      workspace: state.workspace,
      relayUrl: state.relayUrl,
      connection: a.network.client(state.relayUrl)?.state ?? 'offline',
      me: state.me,
      members: [...state.members.values()],
      channels,
      unread: totals.unread,
      mentions: totals.mentions,
      invites: state.invites,
      prefs: kb.prefs(state.workspace.id),
    };
  });
}

/**
 * Mentions, thread replies and reactions aimed at this person, newest first.
 * Built from the messages already cached rather than a separate feed, so it
 * costs nothing to keep current.
 */
function buildActivity(a: PersonalAgent): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const state of a.workspaces.all) {
    const me = state.me.address;
    const consider = (message: Message) => {
      if (message.deletedAt || message.kind !== 'user') return;
      const base = {
        workspaceId: state.workspace.id,
        workspaceName: state.workspace.name,
        channelId: message.channelId,
        channelLabel: a.workspaces.label(state.workspace.id, message.channelId),
        message,
      };
      if (message.author !== me && (message.mentions.includes(me) || message.broadcast)) {
        items.push({ ...base, kind: 'mention', ts: message.ts });
      }
      if (message.author === me) {
        for (const reaction of message.reactions) {
          for (const by of reaction.by) {
            if (by === me) continue;
            items.push({
              ...base,
              kind: 'reaction',
              emoji: reaction.emoji,
              by: state.members.get(by)?.displayName ?? by,
              ts: message.ts,
            });
          }
        }
      }
    };
    for (const list of state.messages.values()) for (const m of list) consider(m);
    for (const replies of state.threads.values()) for (const m of replies) consider(m);
  }
  return items.sort((x, y) => y.ts - x.ts).slice(0, 100);
}

function buildThread(a: PersonalAgent): ThreadView | null {
  if (!view.threadRootId || !view.workspaceId) return null;
  const state = a.workspaces.get(view.workspaceId);
  if (!state) return null;
  const root =
    a.workspaces.messages(view.workspaceId, view.channelId).find((m) => m.id === view.threadRootId) ??
    a.workspaces.thread(view.workspaceId, view.threadRootId).find((m) => m.id === view.threadRootId);
  if (!root) return null;
  return {
    workspaceId: view.workspaceId,
    channelId: root.channelId,
    root,
    replies: a.workspaces.thread(view.workspaceId, view.threadRootId),
  };
}

function buildDiscoverable(a: PersonalAgent): DiscoverableWorkspaceView[] {
  // The book keeps one list per relay round-trip; tag each with where it lives
  // so "join" knows which socket to ask.
  const primary = a.network.urls[0] ?? '';
  return a.workspaces.discoverable.map((w) => ({ ...w, relayUrl: primary }));
}

/** Keep the open channel valid as workspaces come and go. */
function reconcileView(a: PersonalAgent, kb: KnowledgeBase): void {
  const states = a.workspaces.all;
  if (!states.length) {
    view = { workspaceId: '', channelId: '', threadRootId: '', unreadFrom: 0 };
    return;
  }
  let state = states.find((s) => s.workspace.id === view.workspaceId);
  if (!state) {
    const remembered = states.find((s) => s.workspace.id === kb.client.lastWorkspace);
    state = remembered ?? states[0]!;
    view = { workspaceId: state.workspace.id, channelId: '', threadRootId: '', unreadFrom: 0 };
  }
  if (!view.channelId || !state.channels.has(view.channelId)) {
    const remembered = kb.client.lastChannel[state.workspace.id];
    const candidates = [...state.channels.values()].filter(
      (c) => !c.archived && c.members.includes(state!.me.address),
    );
    const next =
      candidates.find((c) => c.id === remembered) ??
      candidates.find((c) => c.isDefault) ??
      candidates[0];
    view.channelId = next?.id ?? '';
    view.threadRootId = '';
    view.unreadFrom = next ? (a.workspaces.read(state.workspace.id, next.id)?.lastReadTs ?? 0) : 0;
  }
}

/**
 * Development affordances, all off in a packaged build:
 *
 *   AI_COWORKER_WORKSPACE       run against a specific knowledge base
 *   AI_COWORKER_PROBE           path to a JS file to evaluate in the renderer
 *   AI_COWORKER_PROBE_OUT       where to write what the probe returns, as JSON
 *   AI_COWORKER_CAPTURE         write a PNG of the window
 *   AI_COWORKER_CAPTURE_SCRIPT  renderer JS to run before the capture
 *   AI_COWORKER_CAPTURE_DELAY   milliseconds to wait first (default 2500)
 *
 * The probe is how the UI suite drives a real window: it runs against the same
 * preload API the app uses, so it can act on the interface and then read the
 * files back to see what actually landed on disk.
 */
function devOption(name: string): string | undefined {
  return app.isPackaged ? undefined : process.env[name];
}

async function runDevHooks(window: BrowserWindow): Promise<void> {
  if (devHooksRan) return;
  devHooksRan = true;
  const delay = Number(devOption('AI_COWORKER_CAPTURE_DELAY') ?? 2500);
  await new Promise((resolve) => setTimeout(resolve, delay));

  const probeFile = devOption('AI_COWORKER_PROBE');
  const probeOut = devOption('AI_COWORKER_PROBE_OUT');
  if (probeFile) {
    let payload: unknown;
    try {
      const source = await fs.readFile(probeFile, 'utf8');
      payload = await window.webContents.executeJavaScript(source, true);
    } catch (err) {
      payload = { fatal: (err as Error).stack ?? (err as Error).message };
    }
    if (probeOut) {
      await fs.mkdir(path.dirname(probeOut), { recursive: true });
      await fs.writeFile(probeOut, JSON.stringify(payload, null, 2), 'utf8');
    } else {
      console.log(JSON.stringify(payload, null, 2));
    }
  }

  const script = devOption('AI_COWORKER_CAPTURE_SCRIPT');
  if (script) {
    try {
      await window.webContents.executeJavaScript(script, true);
      await new Promise((resolve) => setTimeout(resolve, 900));
    } catch (err) {
      console.error('capture script failed:', err);
    }
  }

  const target = devOption('AI_COWORKER_CAPTURE');
  if (target) {
    const image = await window.webContents.capturePage();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, image.toPNG());
    console.log(`captured ${target}`);
  }
  app.exit(0);
}

// --- state ------------------------------------------------------------------

function buildState(): AppState {
  const relayUrl = config.relayUrl ?? DEFAULT_RELAY;
  const personas = PERSONAS.map((p) => ({
    key: p.key,
    displayName: p.profile.displayName,
    title: p.profile.title,
    role: p.profile.role,
  }));

  if (!knowledge || !agent || !knowledge.profile.address) {
    return {
      ready: false,
      knowledgeDir: knowledge?.root ?? null,
      profile: null,
      connection: {
        state: 'offline',
        error: null,
        relayUrl,
        providerName: 'not started',
        providerLive: false,
        providerReason: '',
        hasApiKey: Boolean(resolveApiKey(config.geminiApiKey)),
        apiKeySource: config.geminiApiKey ? 'settings' : resolveApiKey() ? 'environment' : 'none',
        model: config.geminiModel ?? process.env.GEMINI_MODEL ?? 'gemini-flash-latest',
      },
      directory: [],
      projects: [],
      notes: [],
      artifacts: [],
      tasks: [],
      calendar: [],
      feedback: [],
      meetings: [],
      live: [],
      activities: [],
      chat: [],
      personas,
      workspaces: [],
      activeWorkspaceId: '',
      activeChannelId: '',
      unreadFrom: 0,
      messages: [],
      historyComplete: true,
      thread: null,
      activity: [],
      search: null,
      discoverable: [],
      relays: [relayUrl],
      status: emptyStatus(),
      presence: 'offline',
    };
  }

  reconcileView(agent, knowledge);
  const workspaces = buildWorkspaceViews(agent, knowledge);
  const activeState = agent.workspaces.get(view.workspaceId);

  return {
    ready: true,
    knowledgeDir: knowledge.root,
    profile: knowledge.profile,
    connection: {
      state: agent.connectionState,
      error: agent.relay.lastError,
      relayUrl: agent.relay.url,
      providerName: agent.provider.name,
      providerLive: agent.provider.live,
      providerReason: agent.providerReason,
      // Never send the key itself to the renderer — only whether one is set and
      // where it came from.
      hasApiKey: Boolean(resolveApiKey(config.geminiApiKey)),
      apiKeySource: config.geminiApiKey ? 'settings' : resolveApiKey() ? 'environment' : 'none',
      model: config.geminiModel ?? process.env.GEMINI_MODEL ?? 'gemini-flash-latest',
    },
    directory: agent.directory,
    projects: knowledge.projects,
    notes: knowledge.notes,
    artifacts: knowledge.artifacts,
    tasks: knowledge.tasks,
    calendar: knowledge.calendar,
    feedback: knowledge.feedback,
    meetings: knowledge.meetings,
    live: agent.liveMeetings.map((m) => ({
      meeting: m.meeting,
      phase: m.phase,
      transcript: m.transcript,
      present: m.present,
      speaking: m.speaking,
      thinking: m.thinking,
    })),
    activities: agent.activities,
    chat: chatEntries,
    personas,
    workspaces,
    activeWorkspaceId: view.workspaceId,
    activeChannelId: view.channelId,
    unreadFrom: view.unreadFrom,
    messages: view.channelId ? agent.workspaces.messages(view.workspaceId, view.channelId) : [],
    historyComplete: activeState ? activeState.complete.has(view.channelId) : true,
    thread: buildThread(agent),
    activity: buildActivity(agent),
    search: agent.workspaces.searchResults,
    discoverable: buildDiscoverable(agent),
    relays: agent.network.urls,
    status: knowledge.client.status,
    presence: knowledge.client.presence,
  };
}

/** Coalesce bursts of change events into one render. */
function pushState(): void {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    sendToRenderer('state', buildState());
    updateBadge();
  }, 40);
}

// --- notifications -----------------------------------------------------------

/**
 * Raise a desktop notification, unless the person is already looking at the
 * conversation it came from. Clicking it jumps straight there.
 */
function notify(notification: AgentNotification): void {
  const focused = mainWindow?.isFocused() ?? false;
  const looking =
    focused &&
    view.workspaceId === notification.workspaceId &&
    view.channelId === notification.channelId;
  if (looking) return;
  if (!Notification.isSupported()) return;

  const toast = new Notification({
    title: notification.title,
    body: notification.body,
    silent: !notification.mention,
  });
  toast.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
    mainWindow?.webContents.send('open-channel', {
      workspaceId: notification.workspaceId,
      channelId: notification.channelId,
    });
  });
  toast.show();
  updateBadge();
}

/** The dock/taskbar badge counts mentions, the way every chat app does. */
function updateBadge(): void {
  if (!agent) return;
  let mentions = 0;
  for (const id of agent.workspaces.ids) mentions += agent.workspaces.totals(id).mentions;
  if (process.platform === 'darwin') app.dock?.setBadge(mentions ? String(mentions) : '');
  else app.setBadgeCount?.(mentions);
}

// --- vault --------------------------------------------------------------------

function buildVaultState(): VaultState {
  const v = requireVault();
  return { ...v.snapshot(), settings: v.settings, bookmarks: v.bookmarks };
}

function pushVaultState(): void {
  if (vaultPushTimer || !vault) return;
  vaultPushTimer = setTimeout(() => {
    vaultPushTimer = null;
    if (!vault) return;
    sendToRenderer('vault:changed', buildVaultState());
  }, 60);
}

// --- imported memory ---------------------------------------------------------

/** Imported memory rides its own channel: it changes on syncs, not on turns. */
function pushMemoryState(): void {
  void buildMemoryState(memoryDeps)
    .then((state) => sendToRenderer(MEMORY_CHANNELS.push, state))
    .catch(() => {});
}

const memoryDeps = {
  getIndex: () => memoryIndex,
  getOwner: () => knowledge?.profile ?? null,
  lookup: (address: string) => {
    const profile = agent?.directory.find(
      (p) => p.address.toLowerCase() === address.toLowerCase().trim(),
    );
    return profile
      ? { address: profile.address, role: profile.role, team: profile.team, manager: profile.manager }
      : null;
  },
  push: (state: Awaited<ReturnType<typeof buildMemoryState>>) => {
    sendToRenderer(MEMORY_CHANNELS.push, state);
  },
};

// --- agent lifecycle ---------------------------------------------------------

async function startAgent(dir: string): Promise<void> {
  await stopAgent();
  knowledge = await KnowledgeBase.open(dir);

  // The vault is the same `notes/` folder the agent reads. Editing a note here
  // and having the agent quote it in a meeting are the same act.
  vault = await Vault.open(knowledge.vaultDir);
  vault.watch();
  vault.on('change', () => {
    // Keep the agent's view of its own notes in step with the files.
    void knowledge?.reloadNotes().then(() => pushState());
    pushVaultState();
  });

  memoryIndex = await MemoryIndex.open(dir);
  memoryIndex.on('change', () => pushMemoryState());

  if (!knowledge.profile.address) {
    // Nothing to run yet — the renderer will show onboarding.
    pushState();
    return;
  }
  const { provider, reason } = createProvider({
    apiKey: config.geminiApiKey,
    model: config.geminiModel,
  });
  agent = new PersonalAgent({
    knowledge,
    relayUrl: config.relayUrl ?? DEFAULT_RELAY,
    provider,
    providerReason: reason,
    memory: memoryIndex,
  });

  for (const event of [
    'connection',
    'directory',
    'knowledge',
    'workspaces',
    'activity',
    'meeting.scheduled',
    'meeting.failed',
    'meeting.live',
    'meeting.update',
    'meeting.ended',
  ]) {
    agent.on(event, () => pushState());
  }
  agent.on('notification', (notification: AgentNotification) => notify(notification));

  // Typing indicators expire on a timer rather than an event, so nudge the
  // renderer while somebody is mid-sentence.
  agent.workspaces.on('change', () => pushState());
  pushState();
}

async function stopAgent(): Promise<void> {
  if (agent) {
    await agent.shutdown();
    agent = null;
  }
  vault?.close();
  vault = null;
  if (memoryIndex) {
    await memoryIndex.flush();
    memoryIndex.removeAllListeners();
    memoryIndex = null;
  }
  knowledge = null;
}

// --- ipc ---------------------------------------------------------------------

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}
function fail(error: string): IpcResult<never> {
  return { ok: false, error };
}

function requireAgent(): PersonalAgent {
  if (!agent) throw new Error('The agent is not running yet. Finish setup first.');
  return agent;
}
function requireKnowledge(): KnowledgeBase {
  if (!knowledge) throw new Error("No knowledge base is open.");
  return knowledge;
}
function requireVault(): Vault {
  if (!vault) throw new Error('No vault is open.');
  return vault;
}

/** Wrap a handler so a thrown error becomes a typed failure the UI can show. */
function handle<Args extends unknown[], T>(
  channel: string,
  fn: (...args: Args) => Promise<T> | T,
): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      const value = await fn(...(args as Args));
      pushState();
      return ok(value);
    } catch (err) {
      return fail((err as Error).message);
    }
  });
}

function registerIpc(): void {
  ipcMain.handle('state:get', () => buildState());
  registerMemoryIpc(memoryDeps);

  handle<[SetupInput], void>('setup', async (input) => {
    const dir = input.knowledgeDir || defaultKnowledgeDir();
    config.knowledgeDir = dir;
    if (input.relayUrl) config.relayUrl = input.relayUrl;
    await saveConfig();

    const ws = await KnowledgeBase.open(dir);
    if (input.mode === 'persona') {
      const persona = findPersona(input.personaKey ?? '');
      if (!persona) throw new Error(`Unknown persona: ${input.personaKey}`);
      await seedKnowledgeBase(ws, persona);
    } else {
      const handle = (input.handle || input.displayName || 'me')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
        .slice(0, 24);
      const domain = (input.domain || 'local').toLowerCase().replace(/[^a-z0-9.-]+/g, '');
      if (!handle) throw new Error('Pick a handle for your agent address.');
      const profile: Profile = {
        ...emptyProfile(`${handle}@${domain}`, input.displayName || handle),
        title: input.title ?? '',
        role: input.role ?? 'ic',
        team: input.team ?? '',
        bio: input.bio ?? '',
        focusAreas: input.focusAreas ?? [],
      };
      await ws.updateProfile(profile);
    }
    await ws.flush();
    await startAgent(dir);
  });

  handle<[string], { reply: string; actions: { tool: string; result: string }[] }>(
    'chat',
    async (message) => {
      const a = requireAgent();
      chatEntries.push({ role: 'user', content: message });
      pushState();
      const output = await a.chat(message);
      const actions = output.actions.map((x) => ({ tool: x.tool, result: x.result }));
      chatEntries.push({ role: 'assistant', content: output.reply, actions });
      if (chatEntries.length > 120) chatEntries = chatEntries.slice(-120);
      return { reply: output.reply, actions };
    },
  );

  handle<[], void>('chat:clear', () => {
    chatEntries = [];
    agent?.clearChat();
  });

  handle<[MeetingRequestInput], void>('meeting:request', (input) => {
    const result = requireAgent().requestMeeting({
      participants: input.participants,
      title: input.title,
      purpose: input.purpose,
      kind: input.kind,
      durationMins: input.durationMins,
      urgency: input.urgency,
      agenda: input.agenda,
      chair: input.chair,
    });
    if (!result.ok) throw new Error(result.error ?? 'Could not request the meeting.');
  });

  handle<[string], void>('meeting:startNow', (meetingId) => {
    requireAgent().startMeetingNow(meetingId);
  });

  handle<[string, string], void>('meeting:cancel', (meetingId, reason) => {
    requireAgent().cancelMeeting(meetingId, reason);
  });

  handle<[Partial<Profile>], void>('profile:save', async (patch) => {
    await requireKnowledge().updateProfile(patch);
  });

  handle<[Parameters<KnowledgeBase['upsertProject']>[0]], void>('project:save', async (input) => {
    await requireKnowledge().upsertProject(input);
  });
  handle<[string], void>('project:delete', async (id) => {
    await requireKnowledge().deleteProject(id);
  });

  handle<[Parameters<KnowledgeBase['upsertNote']>[0]], void>('note:save', async (input) => {
    await requireKnowledge().upsertNote(input);
  });
  handle<[string], void>('note:delete', async (id) => {
    await requireKnowledge().deleteNote(id);
  });

  handle<[Parameters<KnowledgeBase['upsertArtifact']>[0]], void>('artifact:save', async (input) => {
    await requireKnowledge().upsertArtifact(input);
  });
  handle<[string], void>('artifact:delete', async (id) => {
    await requireKnowledge().deleteArtifact(id);
  });

  handle<[Parameters<KnowledgeBase['upsertTask']>[0]], void>('task:save', async (input) => {
    await requireKnowledge().upsertTask(input);
  });
  handle<[string], void>('task:delete', async (id) => {
    await requireKnowledge().deleteTask(id);
  });

  handle<[{ title: string; start: number; end: number; kind?: string }], void>(
    'calendar:add',
    async (input) => {
      await requireKnowledge().addCalendarBlock({
        title: input.title,
        start: input.start,
        end: input.end,
        kind: (input.kind as never) ?? 'busy',
      });
    },
  );
  handle<[string], void>('calendar:remove', async (id) => {
    await requireKnowledge().removeCalendarBlock(id);
  });

  handle<[string], void>('relay:set', async (url) => {
    config.relayUrl = url;
    await saveConfig();
    if (agent) {
      agent.relay.close();
      agent.relay.setUrl(url);
      agent.relay.connect();
    }
  });

  handle<[], void>('relay:reconnect', () => {
    if (!agent) return;
    agent.relay.close();
    agent.relay.connect();
  });

  // Changing the key swaps the brain without losing the knowledge base or the socket.
  handle<[{ apiKey?: string; model?: string }], void>('brain:set', async (input) => {
    config.geminiApiKey = input.apiKey?.trim() || undefined;
    config.geminiModel = input.model?.trim() || undefined;
    await saveConfig();
    if (!agent) return;
    const { provider, reason } = createProvider({
      apiKey: config.geminiApiKey,
      model: config.geminiModel,
    });
    agent.provider = provider;
    agent.providerReason = reason;
  });

  handle<[], string | null>("knowledge:chooseDir", async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose where your knowledge base lives',
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle<[], void>("knowledge:openDir", async () => {
    const kb = requireKnowledge();
    await shell.openPath(kb.root);
  });

  // --- workspaces -------------------------------------------------------------

  handle<[string, string], void>('ws:openChannel', (workspaceId, channelId) => {
    const a = requireAgent();
    // Capture where the reader left off *before* marking the channel read, so
    // the "new messages" line lands above what they have not seen.
    const before = a.workspaces.read(workspaceId, channelId)?.lastReadTs ?? 0;
    view = { workspaceId, channelId, threadRootId: '', unreadFrom: before };
    a.focusWorkspace(workspaceId, channelId);
    // Opening a channel is what "read" means; also top up history if we only
    // hold the tail the snapshot shipped.
    a.markRead(workspaceId, channelId);
    const state = a.workspaces.get(workspaceId);
    if (state && !state.messages.has(channelId)) a.fetchHistory(workspaceId, channelId);
  });

  handle<[string, string, string | null], void>('ws:openThread', (workspaceId, channelId, rootId) => {
    const a = requireAgent();
    view = { ...view, workspaceId, channelId, threadRootId: rootId ?? '' };
    if (rootId) a.fetchThread(workspaceId, rootId);
  });

  handle<[], void>('ws:loadOlder', () => {
    const a = requireAgent();
    if (!view.channelId) return;
    const oldest = a.workspaces.messages(view.workspaceId, view.channelId)[0];
    a.fetchHistory(view.workspaceId, view.channelId, oldest?.ts);
  });

  handle<[SendMessageInput], void>('ws:send', (input) => {
    const a = requireAgent();
    const ok = a.sendMessage(input);
    if (!ok) throw new Error('Not connected to that workspace — your message was not sent.');
    requireKnowledge().setDraft(draftKey(input.workspaceId, input.channelId, input.threadRootId), '');
  });

  handle<[string, string, string], void>('ws:edit', (workspaceId, messageId, text) => {
    requireAgent().editMessage(workspaceId, messageId, text);
  });
  handle<[string, string], void>('ws:delete', (workspaceId, messageId) => {
    requireAgent().deleteMessage(workspaceId, messageId);
  });
  handle<[string, string, string, boolean], void>('ws:react', (workspaceId, messageId, emoji, on) => {
    requireAgent().reactToMessage(workspaceId, messageId, emoji, on);
  });
  handle<[string, string, boolean], void>('ws:pin', (workspaceId, messageId, pinned) => {
    requireAgent().pinMessage(workspaceId, messageId, pinned);
  });
  handle<[string, string], void>('ws:typing', (workspaceId, channelId) => {
    requireAgent().sendTyping(workspaceId, channelId);
  });
  handle<[string, string], void>('ws:markRead', (workspaceId, channelId) => {
    requireAgent().markRead(workspaceId, channelId);
  });

  handle<[Parameters<PersonalAgent['createWorkspace']>[0]], void>('ws:create', (input) => {
    if (!requireAgent().createWorkspace(input)) throw new Error('Not connected to a relay.');
  });
  handle<[{ code?: string; slug?: string; relayUrl?: string }], void>('ws:join', (input) => {
    if (!requireAgent().joinWorkspace(input)) throw new Error('Not connected to a relay.');
  });
  handle<[string], void>('ws:leave', (workspaceId) => {
    requireAgent().leaveWorkspace(workspaceId);
  });
  handle<[string, Partial<Workspace>], void>('ws:update', (workspaceId, patch) => {
    requireAgent().updateWorkspace(workspaceId, patch);
  });
  handle<[string], void>('ws:deleteWorkspace', (workspaceId) => {
    requireAgent().deleteWorkspace(workspaceId);
  });
  handle<[], void>('ws:discover', () => {
    requireAgent().discoverWorkspaces();
  });
  handle<[string, string, WorkspaceRole], void>('ws:setRole', (workspaceId, address, role) => {
    requireAgent().setMemberRole(workspaceId, address, role);
  });
  handle<[string, string], void>('ws:removeMember', (workspaceId, address) => {
    requireAgent().removeMember(workspaceId, address);
  });
  handle<[string, { displayName?: string; title?: string }], void>('ws:profile', (workspaceId, patch) => {
    requireAgent().setWorkspaceProfile(workspaceId, patch);
  });
  handle<[string, { invitedAddress?: string; expiresInHours?: number; maxUses?: number } | undefined], void>(
    'ws:createInvite',
    (workspaceId, input) => {
      requireAgent().createInvite(workspaceId, input ?? {});
    },
  );
  handle<[string, string], void>('ws:revokeInvite', (workspaceId, code) => {
    requireAgent().revokeInvite(workspaceId, code);
  });

  handle<[string, Parameters<PersonalAgent['createChannel']>[1]], void>('ch:create', (workspaceId, input) => {
    requireAgent().createChannel(workspaceId, input);
  });
  handle<[string, string, { name?: string; topic?: string; purpose?: string }], void>(
    'ch:update',
    (workspaceId, channelId, patch) => {
      requireAgent().updateChannel(workspaceId, channelId, patch);
    },
  );
  handle<[string, string, boolean], void>('ch:archive', (workspaceId, channelId, archived) => {
    requireAgent().archiveChannel(workspaceId, channelId, archived);
  });
  handle<[string, string], void>('ch:join', (workspaceId, channelId) => {
    requireAgent().joinChannel(workspaceId, channelId);
  });
  handle<[string, string], void>('ch:leave', (workspaceId, channelId) => {
    requireAgent().leaveChannel(workspaceId, channelId);
  });
  handle<[string, string, string[]], void>('ch:add', (workspaceId, channelId, addresses) => {
    requireAgent().addToChannel(workspaceId, channelId, addresses);
  });
  handle<[string, string, string], void>('ch:remove', (workspaceId, channelId, address) => {
    requireAgent().removeFromChannel(workspaceId, channelId, address);
  });
  handle<[string, string[]], void>('ch:dm', (workspaceId, addresses) => {
    requireAgent().openDirectMessage(workspaceId, addresses);
  });

  handle<[string, string, Partial<ChannelPrefs>], void>('prefs:channel', async (workspaceId, channelId, patch) => {
    await requireKnowledge().saveChannelPrefs(workspaceId, channelId, patch);
  });
  handle<[string, Partial<WorkspacePrefs>], void>('prefs:workspace', async (workspaceId, patch) => {
    await requireKnowledge().saveWorkspacePrefs(workspaceId, patch);
  });
  handle<[UserStatus, Presence | undefined], void>('presence:set', async (status, presence) => {
    await requireAgent().setStatus(status, presence);
  });

  handle<[string, string], void>('ws:search', (workspaceId, query) => {
    requireAgent().searchMessages(workspaceId, query);
  });
  handle<[], void>('ws:clearSearch', () => {
    // The book keeps the last result set; an empty one resets the panel.
    requireAgent().workspaces.apply(
      {
        type: 'search.results',
        results: { workspaceId: view.workspaceId, query: '', hits: [], truncated: false },
      },
      '',
    );
  });

  handle<[string], void>('relay:add', (url) => {
    requireAgent().addRelay(url);
  });
  handle<[string], void>('relay:remove', (url) => {
    requireAgent().removeRelay(url);
  });

  handle<[string, string], void>('draft:save', (key, text) => {
    requireKnowledge().setDraft(key, text);
  });
  handle<[], Record<string, string>>('draft:all', () => ({ ...requireKnowledge().client.drafts }));

  registerVaultIpc();
}

/** Drafts are keyed by where they were typed, threads included. */
function draftKey(workspaceId: string, channelId: string, threadRootId?: string): string {
  return `${workspaceId}:${channelId}${threadRootId ? `:${threadRootId}` : ''}`;
}

// --- vault ipc ----------------------------------------------------------------

function registerVaultIpc(): void {
  handle<[], VaultState>('vault:state', () => buildVaultState());

  handle<[string], string>('vault:read', (file) => requireVault().read(file));

  handle<[string, string], void>('vault:write', async (file, content) => {
    await requireVault().write(file, content);
  });

  handle<[string, string | undefined], string>('vault:create', (file, content) =>
    requireVault().create(file, content ?? ''),
  );

  handle<[string], string>('vault:createFolder', (folder) => requireVault().createFolder(folder));

  handle<[string, string], { path: string; updated: string[] }>('vault:rename', (from, to) =>
    requireVault().rename(from, to),
  );

  handle<[string], void>('vault:delete', async (file) => {
    await requireVault().delete(file);
  });

  handle<[string, VaultSearchOptions | undefined], VaultSearchHit[]>('vault:search', (query, options) =>
    requireVault().search(query, options ?? {}),
  );

  handle<[Partial<VaultSettings>], VaultSettings>('vault:settings', async (patch) => {
    const next = await requireVault().updateSettings(patch);
    pushVaultState();
    return next;
  });

  handle<[Bookmark[]], void>('vault:bookmarks', async (items) => {
    await requireVault().setBookmarks(items);
    pushVaultState();
  });

  handle<[], string>('vault:daily', () => requireVault().dailyNote());

  handle<[string], { from: string; line: number; context: string }[]>('vault:mentions', (file) =>
    requireVault().unlinkedMentions(file),
  );

  handle<[string, string], string>('vault:template', (templatePath, title) =>
    requireVault().renderTemplate(templatePath, title),
  );

  handle<[string, string], string>('vault:attachment', async (name, dataBase64) => {
    const v = requireVault();
    const folder = v.settings.attachmentFolder || '';
    const target = v.uniquePath(folder ? `${folder}/${name}` : name);
    await v.writeBinary(target, Buffer.from(dataBase64, 'base64'));
    return target;
  });

  handle<[string], void>('vault:reveal', async (file) => {
    shell.showItemInFolder(requireVault().abs(file));
  });

  handle<[string], void>('vault:openExternal', async (url) => {
    if (!/^(https?|mailto):/i.test(url)) throw new Error(`Refusing to open ${url}`);
    await shell.openExternal(url);
  });

  handle<[string, 'pdf' | 'html' | 'md', string | undefined], string | null>(
    'vault:export',
    async (file, format, html) => exportNote(file, format, html),
  );
}

/**
 * Export a note. PDF goes through a hidden window so the printed page matches
 * what the reading view shows, styles and all.
 */
async function exportNote(
  file: string,
  format: 'pdf' | 'html' | 'md',
  html: string | undefined,
): Promise<string | null> {
  const v = requireVault();
  const name = file.split('/').pop()?.replace(/\.md$/, '') ?? 'note';
  const result = await dialog.showSaveDialog({
    title: `Export ${name}`,
    defaultPath: path.join(app.getPath('documents'), `${name}.${format}`),
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  });
  if (result.canceled || !result.filePath) return null;

  if (format === 'md') {
    await fs.writeFile(result.filePath, await v.read(file), 'utf8');
    return result.filePath;
  }

  const document = `<!doctype html><html><head><meta charset="utf-8" /><title>${name}</title>
<style>${EXPORT_CSS}</style></head><body><article class="markdown-body">${html ?? ''}</article></body></html>`;

  if (format === 'html') {
    await fs.writeFile(result.filePath, document, 'utf8');
    return result.filePath;
  }

  const printer = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  try {
    await printer.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`);
    const pdf = await printer.webContents.printToPDF({
      printBackground: true,
      margins: { marginType: 'custom', top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
    });
    await fs.writeFile(result.filePath, pdf);
  } finally {
    printer.destroy();
  }
  return result.filePath;
}

const EXPORT_CSS = `
body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; line-height: 1.65; }
.markdown-body { max-width: 46em; margin: 0 auto; padding: 2em; }
h1,h2,h3,h4 { line-height: 1.25; margin: 1.4em 0 .5em; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
pre { background: #f5f5f7; padding: .9em 1em; border-radius: 8px; overflow-x: auto; }
code { background: #f0f0f3; padding: .12em .35em; border-radius: 4px; }
pre code { background: none; padding: 0; }
blockquote { margin: 1em 0; padding: .2em 1em; border-left: 3px solid #d0d0d8; color: #444; }
table { border-collapse: collapse; margin: 1em 0; }
th, td { border: 1px solid #ddd; padding: .4em .7em; text-align: left; }
img { max-width: 100%; }
.md-callout { border: 1px solid #e0e0e6; border-left: 4px solid #6ea8fe; border-radius: 8px; padding: .7em 1em; margin: 1em 0; }
.md-callout-title { font-weight: 600; margin-bottom: .3em; }
.md-tag { color: #4a7fd6; }
.md-link { color: #2f6fd0; text-decoration: none; }
a { color: #2f6fd0; }
.md-copy, .md-code-lang { display: none; }
.md-embed { border-left: 2px solid #ddd; padding-left: 1em; }
`;

// --- window ------------------------------------------------------------------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    title: 'Stead',
    // Packaged builds get their icon from electron-builder; this is what makes
    // the window and taskbar look right when running from source on
    // Linux/Windows, where Electron would otherwise show its own icon.
    ...(process.platform === 'darwin'
      ? {}
      : { icon: path.join(__dirname, '../../build/icon.png') }),
    backgroundColor: '#0f1115',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Surface renderer errors in the terminal during development.
  if (devUrl || !app.isPackaged) {
    mainWindow.webContents.on('console-message', (_event, level, message, line, source) => {
      if (level >= 2) console.error(`[renderer] ${message} (${source}:${line})`);
    });
  }

  if (devOption('AI_COWORKER_CAPTURE') || devOption('AI_COWORKER_PROBE')) {
    mainWindow.webContents.once('did-finish-load', () => {
      void runDevHooks(mainWindow!);
    });
  }

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`renderer gone: ${details.reason} (exit ${details.exitCode})`);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Attachments are served over their own scheme rather than file://, so a note
// can show an image without the renderer being handed filesystem access.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'vault',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
]);

function registerVaultProtocol(): void {
  protocol.handle('vault', async (request) => {
    if (!vault) return new Response('No vault', { status: 404 });
    try {
      const url = new URL(request.url);
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const absolute = vault.abs(relative);
      return await net.fetch(pathToFileURL(absolute).toString());
    } catch (err) {
      return new Response((err as Error).message, { status: 404 });
    }
  });
}

app.whenReady().then(async () => {
  registerVaultProtocol();
  // A .env beside the app (dev) or in the user's home is a convenient way to
  // provide the key without pasting it into the UI.
  loadEnvFromAncestors(app.getAppPath());
  loadEnvFromAncestors(app.getPath('home'), 0);
  config = await loadConfig();
  const forced = devOption('AI_COWORKER_WORKSPACE');
  if (forced) config.workspaceDir = forced;
  registerIpc();
  createWindow();
  if (config.knowledgeDir) {
    try {
      await startAgent(config.knowledgeDir);
    } catch (err) {
      console.error('Failed to start agent:', err);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void stopAgent();
});
