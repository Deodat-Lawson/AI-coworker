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
  Vault,
  Workspace,
  PERSONAS,
  createProvider,
  emptyProfile,
  findPersona,
  loadEnvFromAncestors,
  resolveApiKey,
  seedWorkspace,
} from '@ai-coworker/agent';
import type { Bookmark } from '@ai-coworker/agent';
import type { Profile, SearchHit, VaultSettings } from '@ai-coworker/shared';
import { BrowserWindow, app, dialog, ipcMain, net, protocol, shell } from 'electron';

import type {
  AppState,
  ChatEntry,
  IpcResult,
  MeetingRequestInput,
  SetupInput,
  VaultSearchOptions,
  VaultState,
} from './ipc.js';
import { MEMORY_CHANNELS, buildMemoryState, registerMemoryIpc } from './memory-ipc.js';

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
    sendToRenderer('state', buildState());
  }, 40);
}

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

/** Imported memory rides its own channel: it changes on syncs, not on turns. */
function pushMemoryState(): void {
  void buildMemoryState(memoryDeps)
    .then((state) => sendToRenderer(MEMORY_CHANNELS.push, state))
    .catch(() => {});
}

const memoryDeps = {
  getIndex: () => memoryIndex,
  getOwner: () => workspace?.profile ?? null,
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
  workspace = await Workspace.open(dir);

  // The vault is the same `notes/` folder the agent reads. Editing a note here
  // and having the agent quote it in a meeting are the same act.
  vault = await Vault.open(workspace.vaultDir);
  vault.watch();
  vault.on('change', () => {
    // Keep the agent's view of its own notes in step with the files.
    void workspace?.reloadNotes().then(() => pushState());
    pushVaultState();
  });

  memoryIndex = await MemoryIndex.open(dir);
  memoryIndex.on('change', () => pushMemoryState());

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
    memory: memoryIndex,
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
  vault?.close();
  vault = null;
  if (memoryIndex) {
    await memoryIndex.flush();
    memoryIndex.removeAllListeners();
    memoryIndex = null;
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

  registerVaultIpc();
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

  handle<[string, VaultSearchOptions | undefined], SearchHit[]>('vault:search', (query, options) =>
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
