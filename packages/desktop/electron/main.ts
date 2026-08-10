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
  RelaySession,
  WorkspaceState,
} from '@ai-coworker/agent';
import type {
  BrainSettings,
  ChannelPrefs,
  GlobalSettings,
  GlobalSettingsPatch,
  Message,
  Presence,
  Profile,
  UserStatus,
  VaultSearchHit,
  VaultSettings,
  Workspace,
  WorkspaceAgent,
  WorkspaceAgentPatch,
  WorkspacePermissions,
  WorkspacePrefs,
  WorkspaceRole,
} from '@ai-coworker/shared';
import type { Appearance } from '@ai-coworker/shared';
import {
  AGENT_TOOL_KEYS,
  THEME_BACKGROUNDS,
  agentMay,
  agentSourceScope,
  describeAgentReach,
  emptyStatus,
  isDirect,
  normalizeAppearance,
  overlappingReach,
  resolveTheme,
} from '@ai-coworker/shared';
import {
  BrowserWindow,
  Menu,
  Notification,
  app,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  shell,
} from 'electron';

import type {
  ActivityItem,
  AgentIsolationRow,
  AgentIsolationView,
  AppState,
  ChannelView,
  ChatEntry,
  DiscoverableWorkspaceView,
  IpcResult,
  MeetingRequestInput,
  SendMessageInput,
  AuthResult,
  SetupInput,
  ThreadView,
  VaultSearchOptions,
  VaultState,
  WorkspaceView,
} from './ipc.js';
import { relayAuth, type AuthAccount, type PendingInvitation, type WelcomeWorkspace } from './auth-client.js';
import { MEMORY_CHANNELS, buildMemoryState, registerMemoryIpc } from './memory-ipc.js';

const DEFAULT_RELAY = process.env.AI_COWORKER_RELAY || 'ws://localhost:8787';

// --- identity ----------------------------------------------------------------
// Kept in step with electron-builder's `productName` and `appId` in package.json.

const APP_NAME = 'Stead';
const APP_ID = 'app.stead.desktop';

/**
 * The app answers to its own name whether it was launched from a bundle or from
 * source. A packaged build inherits the name from electron-builder, but
 * `npm run desktop` runs inside Electron's own bundle, which otherwise calls
 * itself Electron in the menu bar, in notifications, and on disk.
 *
 * This runs at import time, before anything reads it: `app.getPath('userData')`
 * is derived from the name, so setting it late would strand a run's config in a
 * different directory than the one the rest of the app uses.
 */
app.setName(APP_NAME);
// Windows groups taskbar buttons and attributes notifications by this id.
app.setAppUserModelId(APP_ID);

/** The generated icon, as shipped in the desktop package's build resources. */
function brandIconPath(ext: 'png' | 'icns'): string {
  return path.join(__dirname, `../../build/icon.${ext}`);
}

/**
 * Dress the dock/taskbar for a run from source. Packaged builds carry the icon
 * in the bundle; unpackaged ones are wearing Electron's, so replace it.
 */
function applyDockIcon(): void {
  if (app.isPackaged || process.platform !== 'darwin') return;
  const icon = nativeImage.createFromPath(brandIconPath('png'));
  if (!icon.isEmpty()) app.dock?.setIcon(icon);
}

/**
 * The macOS application menu. Electron's default is fine in shape, but its
 * first submenu — About, Hide, Quit — is built from the *bundle's* name, so
 * from source it reads "About Electron". Building it here takes the name from
 * `app.name` instead. Elsewhere the default menu already says the right thing.
 */
function applyMenu(): void {
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about', label: `About ${app.name}` },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide', label: `Hide ${app.name}` },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit', label: `Quit ${app.name}` },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

interface Config {
  knowledgeDir?: string;
  relayUrl?: string;
  /** Set from Settings. Falls back to GEMINI_API_KEY in the environment or a .env file. */
  geminiApiKey?: string;
  geminiModel?: string;
  /** dark | light | system. Lives here so the window can be painted before the renderer loads. */
  appearance?: Appearance;
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

/**
 * Push the chosen appearance out to everything the renderer cannot reach: the
 * window's own background (what shows during a resize or before the first
 * paint) and Electron's native chrome — menus, the traffic-light strip on the
 * hidden-inset titlebar, and any native dialog we open.
 */
function applyAppearance(): void {
  const appearance = normalizeAppearance(config.appearance);
  nativeTheme.themeSource = appearance;
  const theme = resolveTheme(appearance, nativeTheme.shouldUseDarkColors);
  mainWindow?.setBackgroundColor(THEME_BACKGROUNDS[theme]);
}

function defaultKnowledgeDir(): string {
  // Folder name kept from an earlier release so upgrades keep their data.
  return path.join(app.getPath('userData'), 'workspace');
}

/**
 * Where the key came from, which is a different question from what it is. The
 * renderer needs to know whether to keep asking; it never needs the key.
 */
function brainSettings(): BrainSettings {
  return {
    model: config.geminiModel ?? '',
    hasApiKey: Boolean(resolveApiKey(config.geminiApiKey)),
    apiKeySource: config.geminiApiKey ? 'settings' : resolveApiKey() ? 'environment' : 'none',
  };
}

/** The installation's settings, assembled from the config on disk. */
function buildGlobalSettings(): GlobalSettings {
  return {
    appearance: normalizeAppearance(config.appearance),
    relayUrl: config.relayUrl ?? DEFAULT_RELAY,
    relays: agent?.network.urls ?? [config.relayUrl ?? DEFAULT_RELAY],
    knowledgeDir: config.knowledgeDir ?? null,
    brain: brainSettings(),
  };
}

/**
 * Apply a change to the installation's settings. Every route that changes a
 * global setting comes through here — the unified `settings:update` and the
 * single-purpose handlers alike — so there is one implementation of what each
 * setting *does*, and the narrow handlers are only doors onto it.
 */
async function applySettingsPatch(patch: GlobalSettingsPatch): Promise<GlobalSettings> {
  if (patch.appearance !== undefined) {
    config.appearance = normalizeAppearance(patch.appearance);
    applyAppearance();
  }
  if (patch.knowledgeDir !== undefined) config.knowledgeDir = patch.knowledgeDir;
  if (patch.brain) {
    // An empty string is "forget the key I gave you", which is different from
    // not mentioning the key at all.
    if (patch.brain.apiKey !== undefined) {
      config.geminiApiKey = patch.brain.apiKey.trim() || undefined;
    }
    if (patch.brain.model !== undefined) config.geminiModel = patch.brain.model.trim() || undefined;
    applyBrain();
  }
  if (patch.relayUrl !== undefined && patch.relayUrl !== config.relayUrl) {
    config.relayUrl = patch.relayUrl;
    if (agent) {
      agent.relay.close();
      agent.relay.setUrl(patch.relayUrl);
      agent.relay.connect();
    }
  }
  await saveConfig();
  pushState();
  return buildGlobalSettings();
}

/** Swap the brain in place, without losing the knowledge base or the socket. */
function applyBrain(): void {
  if (!agent) return;
  const { provider, reason } = createProvider({
    apiKey: config.geminiApiKey,
    model: config.geminiModel,
  });
  agent.provider = provider;
  agent.providerReason = reason;
}

// --- sign-in state -----------------------------------------------------------

/**
 * The session held between verifying an email and having a knowledge base to
 * store it in. Sign-up is several screens long and the account exists from the
 * first one, so this is where the token waits — it moves onto disk the moment
 * there is a knowledge base to put it beside.
 */
let pendingSession: RelaySession | null = null;

async function rememberSession(
  relayUrl: string,
  token: string,
  account: AuthAccount,
): Promise<void> {
  pendingSession = {
    token,
    email: account.email,
    accountId: account.id,
    address: account.address,
    displayName: account.displayName,
    savedAt: Date.now(),
  };
  // Once a knowledge base exists the session belongs on disk beside it, so a
  // restart does not ask for the mailbox again.
  if (knowledge) {
    await knowledge.saveSession(relayUrl, pendingSession);
    pushState();
  }
}

/** Who the app is signed in as, for the Settings screen. */
function signedInAccount(): { email: string; displayName: string; address: string } | null {
  const url = (config.relayUrl || DEFAULT_RELAY).trim();
  const session = knowledge?.session(url) ?? pendingSession;
  if (!session) return null;
  return { email: session.email, displayName: session.displayName, address: session.address };
}

function requireSession(): { url: string; token: string } {
  const url = (config.relayUrl || DEFAULT_RELAY).trim();
  const token = pendingSession?.token ?? knowledge?.session(url)?.token;
  if (!token) throw new Error('Sign in first.');
  return { url, token };
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
      joinRequests: state.joinRequests,
      audit: state.audit,
      prefs: kb.prefs(state.workspace.id),
      // Every workspace has exactly one agent, created the moment you are in
      // the workspace and gated shut until you say otherwise.
      agent: kb.workspaceAgent(state.workspace.id, {
        name: `${kb.profile.displayName.split(' ')[0] ?? 'Your'}'s agent`,
        accent: state.workspace.color,
      }),
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
      // A probe that never settles must not take the run with it: the whole
      // point of the harness is to produce a report. On the deadline we read
      // back what the probe published as it went, including which test it was
      // in the middle of, which is the one piece of information a hang needs.
      const limit = Number(devOption('AI_COWORKER_PROBE_TIMEOUT') ?? 480_000);
      payload = await Promise.race([
        window.webContents.executeJavaScript(source, true),
        new Promise((resolve) =>
          setTimeout(() => {
            void window.webContents
              .executeJavaScript('window.__probe && JSON.parse(JSON.stringify(window.__probe))')
              .then((partial: { results?: unknown[]; logs?: string[]; running?: string }) =>
                resolve({
                  ...partial,
                  fatal: `the probe stalled after ${Math.round(limit / 1000)}s${
                    partial?.running ? ` in "${partial.running}"` : ''
                  }`,
                }),
              )
              .catch(() => resolve({ fatal: 'the probe stalled and could not be read back' }));
          }, limit),
        ),
      ]);
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
      appearance: normalizeAppearance(config.appearance),
      account: signedInAccount(),
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
    appearance: normalizeAppearance(config.appearance),
    account: signedInAccount(),
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

  // --- signing up and in ----------------------------------------------------
  //
  // The sequence is the relay's; this side keeps the pieces that have to live
  // on the machine — the session token beside the knowledge base, and the
  // profile the agent runs as, taken from the account rather than typed.

  /** The relay being signed in to: whatever was last set, or the default. */
  const relayFor = (override?: string) => (override || config.relayUrl || DEFAULT_RELAY).trim();

  handle<[string | undefined], { relayName: string; accounts: number; codesInResponse: boolean }>(
    'auth:config',
    (relayUrl) => relayAuth.config(relayFor(relayUrl)),
  );

  handle<[{ email: string; relayUrl?: string }], { email: string; expiresAt: number; devCode?: string }>(
    'auth:start',
    async (input) => {
      const url = relayFor(input.relayUrl);
      // Remember the relay as soon as it answers, so the rest of the flow and
      // the eventual connection all point at the same place.
      if (config.relayUrl !== url) {
        config.relayUrl = url;
        await saveConfig();
      }
      return relayAuth.start(url, input.email);
    },
  );

  handle<[{ email: string; code: string; relayUrl?: string }], AuthResult>(
    'auth:verify',
    async (input) => {
      const url = relayFor(input.relayUrl);
      const result = await relayAuth.verify(url, input.email, input.code);
      await rememberSession(url, result.token, result.account);
      return {
        account: result.account,
        created: result.created,
        needsProfile: result.needsProfile,
        workspaces: result.workspaces,
        invitations: result.invitations,
        relayUrl: url,
      };
    },
  );

  handle<[{ email: string; password: string; relayUrl?: string }], AuthResult>(
    'auth:login',
    async (input) => {
      const url = relayFor(input.relayUrl);
      const result = await relayAuth.login(url, input.email, input.password);
      await rememberSession(url, result.token, result.account);
      return {
        account: result.account,
        created: false,
        needsProfile: false,
        workspaces: result.workspaces,
        invitations: result.invitations,
        relayUrl: url,
      };
    },
  );

  handle<[{ displayName?: string; password?: string }], AuthAccount>('auth:profile', async (patch) => {
    const { url, token } = requireSession();
    const { account } = await relayAuth.profile(url, token, patch);
    await rememberSession(url, token, account);
    return account;
  });

  handle<
    [{ name: string; project?: string; description?: string; discoverable?: boolean }],
    { workspaceId: string; name: string; createdChannel: string }
  >('auth:createWorkspace', async (input) => {
    const { url, token } = requireSession();
    const result = await relayAuth.createWorkspace(url, token, input);
    return {
      workspaceId: result.workspace.id,
      name: result.workspace.name,
      createdChannel: result.createdChannel,
    };
  });

  handle<[{ workspaceId?: string; code?: string; message?: string }], { workspaceId: string; requested: boolean }>(
    'auth:join',
    async (input) => {
      const { url, token } = requireSession();
      const result = await relayAuth.join(url, token, input);
      return { workspaceId: result.workspace.id, requested: Boolean(result.requested) };
    },
  );

  handle<
    [{ workspaceId: string; emails: string[] }],
    { invited: { email: string; code: string }[]; failed: { email: string; error: string }[] }
  >('auth:invite', async (input) => {
    const { url, token } = requireSession();
    return relayAuth.invite(url, token, input.workspaceId, input.emails);
  });

  /**
   * The last step: make the knowledge base this account's, and start the agent
   * against it. Everything before this was on the relay; this is where the
   * person gets a machine of their own.
   */
  handle<[{ knowledgeDir?: string; title?: string; team?: string; focusAreas?: string[] }], void>(
    'auth:finish',
    async (input) => {
      const url = relayFor();
      const session = pendingSession;
      if (!session) throw new Error('Sign in first.');

      const dir = input.knowledgeDir || config.knowledgeDir || defaultKnowledgeDir();
      config.knowledgeDir = dir;
      config.relayUrl = url;
      await saveConfig();

      const kb = await KnowledgeBase.open(dir);
      await kb.updateProfile({
        ...emptyProfile(session.address, session.displayName),
        title: input.title ?? '',
        team: input.team ?? '',
        focusAreas: input.focusAreas ?? [],
      });
      await kb.saveSession(url, { ...session, savedAt: Date.now() });
      await kb.setRelays([url]);
      await kb.flush();
      await startAgent(dir);
    },
  );

  handle<[], void>('auth:signOut', async () => {
    const url = relayFor();
    const token = knowledge?.session(url)?.token ?? pendingSession?.token;
    pendingSession = null;
    if (token) {
      // Best effort: the local session is gone either way, and a relay that is
      // down must not be able to trap somebody in a signed-in state.
      try {
        await relayAuth.logout(url, token);
      } catch {
        /* the token expires on its own */
      }
    }
    await knowledge?.clearSession(url);
    pushState();
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

  // --- settings ---------------------------------------------------------------
  // One way in and one way out for everything that belongs to the installation
  // rather than to an agent. The single-purpose handlers below still exist —
  // plenty of screens want to set exactly one thing — but they all land here.

  handle<[], GlobalSettings>('settings:get', () => buildGlobalSettings());

  handle<[GlobalSettingsPatch], GlobalSettings>('settings:update', (patch) =>
    applySettingsPatch(patch),
  );

  handle<[string], void>('relay:set', async (url) => {
    await applySettingsPatch({ relayUrl: url });
  });

  handle<[], void>('relay:reconnect', () => {
    if (!agent) return;
    agent.relay.close();
    agent.relay.connect();
  });

  handle<[Appearance], void>('appearance:set', async (appearance) => {
    await applySettingsPatch({ appearance });
  });

  // Changing the key swaps the brain without losing the knowledge base or the socket.
  handle<[{ apiKey?: string; model?: string }], void>('brain:set', async (input) => {
    await applySettingsPatch({ brain: { apiKey: input.apiKey, model: input.model } });
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
  handle<[string, Partial<WorkspacePermissions>], void>('ws:permissions', (workspaceId, patch) => {
    requireAgent().setWorkspacePermissions(workspaceId, patch);
  });
  handle<[string, string | string[], WorkspaceRole, string[] | undefined], void>(
    'ws:setRole',
    (workspaceId, addresses, role, guestChannels) => {
      requireAgent().setMemberRole(workspaceId, addresses, role, guestChannels);
    },
  );
  handle<[string, string | string[]], void>('ws:removeMember', (workspaceId, addresses) => {
    requireAgent().removeMember(workspaceId, addresses);
  });
  handle<[string, string | string[], boolean], void>(
    'ws:setActive',
    (workspaceId, addresses, active) => {
      requireAgent().setMemberActive(workspaceId, addresses, active);
    },
  );
  handle<[string, string], void>('ws:transferOwnership', (workspaceId, address) => {
    requireAgent().transferOwnership(workspaceId, address);
  });
  handle<[string, { address?: string; displayName?: string; title?: string; avatar?: string }], void>(
    'ws:profile',
    (workspaceId, patch) => {
      requireAgent().setWorkspaceProfile(workspaceId, patch);
    },
  );
  handle<[string, string | undefined, string | undefined], void>(
    'ws:requestJoin',
    async (slug, message, relayUrl) => {
      // Asking to join a workspace on a relay we are not on yet means dialling
      // it first, exactly as joining by code does.
      if (relayUrl) await requireAgent().network.add(relayUrl);
      if (!requireAgent().requestToJoin(slug, message)) throw new Error('Not connected to a relay.');
    },
  );
  handle<[string, string, boolean, WorkspaceRole | undefined], void>(
    'ws:reviewJoin',
    (workspaceId, requestId, approve, role) => {
      requireAgent().reviewJoinRequest(workspaceId, requestId, approve, role);
    },
  );
  handle<[string], void>('ws:joinRequests', (workspaceId) => {
    requireAgent().listJoinRequests(workspaceId);
  });
  handle<[string, number | undefined], void>('ws:audit', (workspaceId, limit) => {
    requireAgent().listAudit(workspaceId, limit);
  });
  handle<
    [
      string,
      {
        invitedAddress?: string;
        role?: WorkspaceRole;
        expiresInHours?: number;
        maxUses?: number;
        channels?: string[];
      } | undefined,
    ],
    void
  >(
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

  // --- the agent in one workspace -------------------------------------------

  handle<[string, WorkspaceAgentPatch], WorkspaceAgent>('agent:save', async (workspaceId, patch) => {
    return requireKnowledge().saveWorkspaceAgent(workspaceId, patch);
  });

  handle<[string], string | null>('agent:grantFolder', async (workspaceId) => {
    const kb = requireKnowledge();
    const picked = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Choose a folder this workspace’s agent may read',
      buttonLabel: 'Grant',
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    const folder = picked.filePaths[0];
    const agent = kb.workspaceAgent(workspaceId);
    // Granting a folder switches the capability on: a path in a list the
    // runtime is not consulting would be a lie told by a settings screen.
    await kb.saveWorkspaceAgent(workspaceId, {
      access: {
        folders: [...agent.access.folders, folder],
        tools: { ...agent.access.tools, computer_folders: true },
      },
    });
    return folder;
  });

  handle<[string, string], WorkspaceAgent>('agent:revokeFolder', async (workspaceId, folder) => {
    const kb = requireKnowledge();
    const agent = kb.workspaceAgent(workspaceId);
    return kb.saveWorkspaceAgent(workspaceId, {
      access: { folders: agent.access.folders.filter((f) => f !== folder) },
    });
  });

  handle<[], AgentIsolationView>('agent:isolation', () => {
    const kb = requireKnowledge();
    const a = agent;
    const names = new Map(
      (a?.workspaces.all ?? []).map((s) => [s.workspace.id, s.workspace.name] as const),
    );
    const agents = kb.workspaceAgents.filter((entry) => names.has(entry.workspaceId));
    const rows: AgentIsolationRow[] = agents.map((entry) => {
      const scope = agentSourceScope(entry);
      return {
        workspaceId: entry.workspaceId,
        workspaceName: names.get(entry.workspaceId) ?? entry.workspaceId,
        agentName: entry.name,
        emoji: entry.emoji,
        accent: entry.accent,
        autonomy: entry.autonomy,
        reach: describeAgentReach(entry),
        sourceCount: scope === null ? 'all' : scope.length,
        folders: entry.access.folders,
        ceiling: entry.access.ceiling,
        tools: AGENT_TOOL_KEYS.filter((key) => agentMay(entry, key)),
      };
    });

    const shared: AgentIsolationView['shared'] = [];
    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const overlap = overlappingReach(agents[i]!, agents[j]!);
        if (overlap.length) {
          shared.push({
            a: names.get(agents[i]!.workspaceId) ?? agents[i]!.workspaceId,
            b: names.get(agents[j]!.workspaceId) ?? agents[j]!.workspaceId,
            overlap,
          });
        }
      }
    }
    return { rows, shared };
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
    ...(process.platform === 'darwin' ? {} : { icon: brandIconPath('png') }),
    backgroundColor:
      THEME_BACKGROUNDS[
        resolveTheme(normalizeAppearance(config.appearance), nativeTheme.shouldUseDarkColors)
      ],
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
  applyDockIcon();
  applyMenu();
  app.setAboutPanelOptions({
    applicationName: app.name,
    applicationVersion: app.getVersion(),
    iconPath: brandIconPath('png'),
  });
  registerVaultProtocol();
  // A .env beside the app (dev) or in the user's home is a convenient way to
  // provide the key without pasting it into the UI.
  loadEnvFromAncestors(app.getAppPath());
  loadEnvFromAncestors(app.getPath('home'), 0);
  config = await loadConfig();
  const forced = devOption('AI_COWORKER_WORKSPACE');
  if (forced) config.knowledgeDir = forced;
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
