import { contextBridge, ipcRenderer } from 'electron';

import type { AppState, DesktopApi, VaultState } from './ipc.js';
import { MEMORY_CHANNELS, type MemoryApi, type MemoryState } from './memory-ipc.js';

/**
 * The only surface the renderer gets. No node, no filesystem, no sockets —
 * every capability is an explicit, named channel.
 */
const api: DesktopApi = {
  getState: () => ipcRenderer.invoke('state:get'),
  setup: (input) => ipcRenderer.invoke('setup', input),
  chat: (message) => ipcRenderer.invoke('chat', message),
  clearChat: () => ipcRenderer.invoke('chat:clear'),
  requestMeeting: (input) => ipcRenderer.invoke('meeting:request', input),
  startMeetingNow: (meetingId) => ipcRenderer.invoke('meeting:startNow', meetingId),
  cancelMeeting: (meetingId, reason) => ipcRenderer.invoke('meeting:cancel', meetingId, reason),
  saveProfile: (patch) => ipcRenderer.invoke('profile:save', patch),
  saveProject: (input) => ipcRenderer.invoke('project:save', input),
  deleteProject: (id) => ipcRenderer.invoke('project:delete', id),
  saveNote: (input) => ipcRenderer.invoke('note:save', input),
  deleteNote: (id) => ipcRenderer.invoke('note:delete', id),
  saveArtifact: (input) => ipcRenderer.invoke('artifact:save', input),
  deleteArtifact: (id) => ipcRenderer.invoke('artifact:delete', id),
  saveTask: (input) => ipcRenderer.invoke('task:save', input),
  deleteTask: (id) => ipcRenderer.invoke('task:delete', id),
  addCalendarBlock: (input) => ipcRenderer.invoke('calendar:add', input),
  removeCalendarBlock: (id) => ipcRenderer.invoke('calendar:remove', id),
  setRelayUrl: (url) => ipcRenderer.invoke('relay:set', url),
  reconnect: () => ipcRenderer.invoke('relay:reconnect'),
  setBrain: (input) => ipcRenderer.invoke('brain:set', input),
  setAppearance: (appearance) => ipcRenderer.invoke('appearance:set', appearance),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  chooseKnowledgeDir: () => ipcRenderer.invoke('knowledge:chooseDir'),
  openKnowledgeDir: () => ipcRenderer.invoke('knowledge:openDir'),

  authConfig: (relayUrl) => ipcRenderer.invoke('auth:config', relayUrl),
  authStart: (input) => ipcRenderer.invoke('auth:start', input),
  authVerify: (input) => ipcRenderer.invoke('auth:verify', input),
  authLogin: (input) => ipcRenderer.invoke('auth:login', input),
  authProfile: (patch) => ipcRenderer.invoke('auth:profile', patch),
  authCreateWorkspace: (input) => ipcRenderer.invoke('auth:createWorkspace', input),
  authJoin: (input) => ipcRenderer.invoke('auth:join', input),
  authInvite: (input) => ipcRenderer.invoke('auth:invite', input),
  authFinish: (input) => ipcRenderer.invoke('auth:finish', input),
  authSignOut: () => ipcRenderer.invoke('auth:signOut'),

  openChannel: (workspaceId, channelId) => ipcRenderer.invoke('ws:openChannel', workspaceId, channelId),
  openThread: (workspaceId, channelId, rootId) =>
    ipcRenderer.invoke('ws:openThread', workspaceId, channelId, rootId),
  loadOlder: () => ipcRenderer.invoke('ws:loadOlder'),
  sendMessage: (input) => ipcRenderer.invoke('ws:send', input),
  editMessage: (workspaceId, messageId, text) => ipcRenderer.invoke('ws:edit', workspaceId, messageId, text),
  deleteMessage: (workspaceId, messageId) => ipcRenderer.invoke('ws:delete', workspaceId, messageId),
  react: (workspaceId, messageId, emoji, on) => ipcRenderer.invoke('ws:react', workspaceId, messageId, emoji, on),
  pinMessage: (workspaceId, messageId, pinned) => ipcRenderer.invoke('ws:pin', workspaceId, messageId, pinned),
  typing: (workspaceId, channelId) => ipcRenderer.invoke('ws:typing', workspaceId, channelId),
  markRead: (workspaceId, channelId) => ipcRenderer.invoke('ws:markRead', workspaceId, channelId),

  createWorkspace: (input) => ipcRenderer.invoke('ws:create', input),
  joinWorkspace: (input) => ipcRenderer.invoke('ws:join', input),
  leaveWorkspace: (workspaceId) => ipcRenderer.invoke('ws:leave', workspaceId),
  updateWorkspace: (workspaceId, patch) => ipcRenderer.invoke('ws:update', workspaceId, patch),
  deleteWorkspace: (workspaceId) => ipcRenderer.invoke('ws:deleteWorkspace', workspaceId),
  discoverWorkspaces: () => ipcRenderer.invoke('ws:discover'),
  setWorkspacePermissions: (workspaceId, patch) =>
    ipcRenderer.invoke('ws:permissions', workspaceId, patch),
  setMemberRole: (workspaceId, addresses, role, guestChannels) =>
    ipcRenderer.invoke('ws:setRole', workspaceId, addresses, role, guestChannels),
  removeMember: (workspaceId, addresses) => ipcRenderer.invoke('ws:removeMember', workspaceId, addresses),
  setMemberActive: (workspaceId, addresses, active) =>
    ipcRenderer.invoke('ws:setActive', workspaceId, addresses, active),
  transferOwnership: (workspaceId, address) =>
    ipcRenderer.invoke('ws:transferOwnership', workspaceId, address),
  setWorkspaceProfile: (workspaceId, patch) => ipcRenderer.invoke('ws:profile', workspaceId, patch),
  requestToJoin: (slug, message, relayUrl) =>
    ipcRenderer.invoke('ws:requestJoin', slug, message, relayUrl),
  reviewJoinRequest: (workspaceId, requestId, approve, role) =>
    ipcRenderer.invoke('ws:reviewJoin', workspaceId, requestId, approve, role),
  listJoinRequests: (workspaceId) => ipcRenderer.invoke('ws:joinRequests', workspaceId),
  listAudit: (workspaceId, limit) => ipcRenderer.invoke('ws:audit', workspaceId, limit),
  createInvite: (workspaceId, input) => ipcRenderer.invoke('ws:createInvite', workspaceId, input),
  revokeInvite: (workspaceId, code) => ipcRenderer.invoke('ws:revokeInvite', workspaceId, code),

  createChannel: (workspaceId, input) => ipcRenderer.invoke('ch:create', workspaceId, input),
  updateChannel: (workspaceId, channelId, patch) => ipcRenderer.invoke('ch:update', workspaceId, channelId, patch),
  archiveChannel: (workspaceId, channelId, archived) =>
    ipcRenderer.invoke('ch:archive', workspaceId, channelId, archived),
  joinChannel: (workspaceId, channelId) => ipcRenderer.invoke('ch:join', workspaceId, channelId),
  leaveChannel: (workspaceId, channelId) => ipcRenderer.invoke('ch:leave', workspaceId, channelId),
  addToChannel: (workspaceId, channelId, addresses) =>
    ipcRenderer.invoke('ch:add', workspaceId, channelId, addresses),
  removeFromChannel: (workspaceId, channelId, address) =>
    ipcRenderer.invoke('ch:remove', workspaceId, channelId, address),
  openDirectMessage: (workspaceId, addresses) => ipcRenderer.invoke('ch:dm', workspaceId, addresses),

  saveWorkspaceAgent: (workspaceId, patch) => ipcRenderer.invoke('agent:save', workspaceId, patch),
  grantAgentFolder: (workspaceId) => ipcRenderer.invoke('agent:grantFolder', workspaceId),
  revokeAgentFolder: (workspaceId, folder) => ipcRenderer.invoke('agent:revokeFolder', workspaceId, folder),
  agentIsolation: () => ipcRenderer.invoke('agent:isolation'),

  setChannelPrefs: (workspaceId, channelId, patch) =>
    ipcRenderer.invoke('prefs:channel', workspaceId, channelId, patch),
  setWorkspacePrefs: (workspaceId, patch) => ipcRenderer.invoke('prefs:workspace', workspaceId, patch),
  setStatus: (status, presence) => ipcRenderer.invoke('presence:set', status, presence),
  search: (workspaceId, query) => ipcRenderer.invoke('ws:search', workspaceId, query),
  clearSearch: () => ipcRenderer.invoke('ws:clearSearch'),
  addRelay: (url) => ipcRenderer.invoke('relay:add', url),
  removeRelay: (url) => ipcRenderer.invoke('relay:remove', url),
  saveDraft: (key, text) => ipcRenderer.invoke('draft:save', key, text),
  getDrafts: () => ipcRenderer.invoke('draft:all'),

  onState: (handler: (state: AppState) => void) => {
    const listener = (_event: unknown, state: AppState) => handler(state);
    ipcRenderer.on('state', listener);
    return () => ipcRenderer.removeListener('state', listener);
  },
  onOpenChannel: (handler) => {
    const listener = (_event: unknown, target: { workspaceId: string; channelId: string }) =>
      handler(target);
    ipcRenderer.on('open-channel', listener);
    return () => ipcRenderer.removeListener('open-channel', listener);
  },

  vaultState: () => ipcRenderer.invoke('vault:state'),
  vaultRead: (path) => ipcRenderer.invoke('vault:read', path),
  vaultWrite: (path, content) => ipcRenderer.invoke('vault:write', path, content),
  vaultCreate: (path, content) => ipcRenderer.invoke('vault:create', path, content),
  vaultCreateFolder: (path) => ipcRenderer.invoke('vault:createFolder', path),
  vaultRename: (from, to) => ipcRenderer.invoke('vault:rename', from, to),
  vaultDelete: (path) => ipcRenderer.invoke('vault:delete', path),
  vaultSearch: (query, options) => ipcRenderer.invoke('vault:search', query, options),
  vaultSaveSettings: (patch) => ipcRenderer.invoke('vault:settings', patch),
  vaultSaveBookmarks: (items) => ipcRenderer.invoke('vault:bookmarks', items),
  vaultDailyNote: () => ipcRenderer.invoke('vault:daily'),
  vaultMentions: (path) => ipcRenderer.invoke('vault:mentions', path),
  vaultTemplate: (templatePath, title) => ipcRenderer.invoke('vault:template', templatePath, title),
  vaultSaveAttachment: (name, dataBase64) => ipcRenderer.invoke('vault:attachment', name, dataBase64),
  vaultReveal: (path) => ipcRenderer.invoke('vault:reveal', path),
  vaultOpenExternal: (url) => ipcRenderer.invoke('vault:openExternal', url),
  vaultExport: (path, format, html) => ipcRenderer.invoke('vault:export', path, format, html),
  onVaultChange: (handler: (state: VaultState) => void) => {
    const listener = (_event: unknown, state: VaultState) => handler(state);
    ipcRenderer.on('vault:changed', listener);
    return () => ipcRenderer.removeListener('vault:changed', listener);
  },
};

/** Connectors and sharing policy. Separate surface, separate channels. */
const memory: MemoryApi = {
  getMemoryState: () => ipcRenderer.invoke(MEMORY_CHANNELS.state),
  syncMemory: (options) => ipcRenderer.invoke(MEMORY_CHANNELS.sync, options),
  setSourceEnabled: (sourceId, enabled) => ipcRenderer.invoke(MEMORY_CHANNELS.setEnabled, sourceId, enabled),
  connectSource: (sourceId) => ipcRenderer.invoke(MEMORY_CHANNELS.connect, sourceId),
  connectFolder: () => ipcRenderer.invoke(MEMORY_CHANNELS.connectFolder),
  disconnectSource: (sourceId, purge) => ipcRenderer.invoke(MEMORY_CHANNELS.disconnect, sourceId, purge),
  setSensitivity: (recordId, sensitivity) => ipcRenderer.invoke(MEMORY_CHANNELS.sensitivity, recordId, sensitivity),
  grant: (recordId, selector) => ipcRenderer.invoke(MEMORY_CHANNELS.grant, recordId, selector),
  revoke: (recordId, selector) => ipcRenderer.invoke(MEMORY_CHANNELS.revoke, recordId, selector),
  forget: (recordId) => ipcRenderer.invoke(MEMORY_CHANNELS.forget, recordId),
  previewAudience: (address) => ipcRenderer.invoke(MEMORY_CHANNELS.preview, address),
  onMemoryState: (handler: (state: MemoryState) => void) => {
    const listener = (_event: unknown, state: MemoryState) => handler(state);
    ipcRenderer.on(MEMORY_CHANNELS.push, listener);
    return () => ipcRenderer.removeListener(MEMORY_CHANNELS.push, listener);
  },
};

contextBridge.exposeInMainWorld('api', api);
contextBridge.exposeInMainWorld('memory', memory);
