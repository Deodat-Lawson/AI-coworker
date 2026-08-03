/**
 * Electron main process.
 *
 * The personal agent runs *here*, in the desktop process, next to the knowledge
 * base on the user's disk. The renderer is a view: it never touches the store,
 * the network, or the model directly.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  PersonalAgent,
  Workspace,
  PERSONAS,
  createProvider,
  emptyProfile,
  findPersona,
  loadEnvFromAncestors,
  resolveApiKey,
  seedWorkspace,
} from '@ai-coworker/agent';
import type { Profile } from '@ai-coworker/shared';
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';

import type {
  AppState,
  ChatEntry,
  IpcResult,
  MeetingRequestInput,
  SetupInput,
} from './ipc.js';

const DEFAULT_RELAY = process.env.AI_COWORKER_RELAY || 'ws://localhost:8787';

interface Config {
  workspaceDir?: string;
  relayUrl?: string;
  /** Set from Settings. Falls back to GEMINI_API_KEY in the environment or a .env file. */
  geminiApiKey?: string;
  geminiModel?: string;
}

let mainWindow: BrowserWindow | null = null;
let workspace: Workspace | null = null;
let agent: PersonalAgent | null = null;
let config: Config = {};
let chatEntries: ChatEntry[] = [];
let pushTimer: NodeJS.Timeout | null = null;

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

async function loadConfig(): Promise<Config> {
  try {
    return JSON.parse(await fs.readFile(configPath(), 'utf8')) as Config;
  } catch {
    return {};
  }
}

async function saveConfig(): Promise<void> {
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(config, null, 2), 'utf8');
}

function defaultWorkspaceDir(): string {
  return path.join(app.getPath('userData'), 'workspace');
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

  if (!workspace || !agent || !workspace.profile.address) {
    return {
      ready: false,
      workspaceDir: workspace?.root ?? null,
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
    };
  }

  return {
    ready: true,
    workspaceDir: workspace.root,
    profile: workspace.profile,
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
    projects: workspace.projects,
    notes: workspace.notes,
    artifacts: workspace.artifacts,
    tasks: workspace.tasks,
    calendar: workspace.calendar,
    feedback: workspace.feedback,
    meetings: workspace.meetings,
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
  };
}

/** Coalesce bursts of change events into one render. */
function pushState(): void {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    mainWindow?.webContents.send('state', buildState());
  }, 40);
}

// --- agent lifecycle ---------------------------------------------------------

async function startAgent(dir: string): Promise<void> {
  await stopAgent();
  workspace = await Workspace.open(dir);
  if (!workspace.profile.address) {
    // Nothing to run yet — the renderer will show onboarding.
    pushState();
    return;
  }
  const { provider, reason } = createProvider({
    apiKey: config.geminiApiKey,
    model: config.geminiModel,
  });
  agent = new PersonalAgent({
    workspace,
    relayUrl: config.relayUrl ?? DEFAULT_RELAY,
    provider,
    providerReason: reason,
  });

  for (const event of [
    'connection',
    'directory',
    'workspace',
    'activity',
    'meeting.scheduled',
    'meeting.failed',
    'meeting.live',
    'meeting.update',
    'meeting.ended',
  ]) {
    agent.on(event, () => pushState());
  }
  pushState();
}

async function stopAgent(): Promise<void> {
  if (agent) {
    await agent.shutdown();
    agent = null;
  }
  workspace = null;
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
function requireWorkspace(): Workspace {
  if (!workspace) throw new Error('No workspace is open.');
  return workspace;
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

  handle<[SetupInput], void>('setup', async (input) => {
    const dir = input.workspaceDir || defaultWorkspaceDir();
    config.workspaceDir = dir;
    if (input.relayUrl) config.relayUrl = input.relayUrl;
    await saveConfig();

    const ws = await Workspace.open(dir);
    if (input.mode === 'persona') {
      const persona = findPersona(input.personaKey ?? '');
      if (!persona) throw new Error(`Unknown persona: ${input.personaKey}`);
      await seedWorkspace(ws, persona);
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
    await requireWorkspace().updateProfile(patch);
  });

  handle<[Parameters<Workspace['upsertProject']>[0]], void>('project:save', async (input) => {
    await requireWorkspace().upsertProject(input);
  });
  handle<[string], void>('project:delete', async (id) => {
    await requireWorkspace().deleteProject(id);
  });

  handle<[Parameters<Workspace['upsertNote']>[0]], void>('note:save', async (input) => {
    await requireWorkspace().upsertNote(input);
  });
  handle<[string], void>('note:delete', async (id) => {
    await requireWorkspace().deleteNote(id);
  });

  handle<[Parameters<Workspace['upsertArtifact']>[0]], void>('artifact:save', async (input) => {
    await requireWorkspace().upsertArtifact(input);
  });
  handle<[string], void>('artifact:delete', async (id) => {
    await requireWorkspace().deleteArtifact(id);
  });

  handle<[Parameters<Workspace['upsertTask']>[0]], void>('task:save', async (input) => {
    await requireWorkspace().upsertTask(input);
  });
  handle<[string], void>('task:delete', async (id) => {
    await requireWorkspace().deleteTask(id);
  });

  handle<[{ title: string; start: number; end: number; kind?: string }], void>(
    'calendar:add',
    async (input) => {
      await requireWorkspace().addCalendarBlock({
        title: input.title,
        start: input.start,
        end: input.end,
        kind: (input.kind as never) ?? 'busy',
      });
    },
  );
  handle<[string], void>('calendar:remove', async (id) => {
    await requireWorkspace().removeCalendarBlock(id);
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

  // Changing the key swaps the brain without losing the workspace or the socket.
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

  handle<[], string | null>('workspace:choose', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose where your knowledge base lives',
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle<[], void>('workspace:open', async () => {
    const ws = requireWorkspace();
    await shell.openPath(ws.root);
  });
}

// --- window ------------------------------------------------------------------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    title: 'AI Coworker',
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // A .env beside the app (dev) or in the user's home is a convenient way to
  // provide the key without pasting it into the UI.
  loadEnvFromAncestors(app.getAppPath());
  loadEnvFromAncestors(app.getPath('home'), 0);
  config = await loadConfig();
  registerIpc();
  createWindow();
  if (config.workspaceDir) {
    try {
      await startAgent(config.workspaceDir);
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
