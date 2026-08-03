import { contextBridge, ipcRenderer } from 'electron';

import type { AppState, DesktopApi } from './ipc.js';

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
  chooseKnowledgeDir: () => ipcRenderer.invoke('knowledge:chooseDir'),
  openKnowledgeDir: () => ipcRenderer.invoke('knowledge:openDir'),

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
  setMemberRole: (workspaceId, address, role) => ipcRenderer.invoke('ws:setRole', workspaceId, address, role),
  removeMember: (workspaceId, address) => ipcRenderer.invoke('ws:removeMember', workspaceId, address),
  setWorkspaceProfile: (workspaceId, patch) => ipcRenderer.invoke('ws:profile', workspaceId, patch),
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
};

contextBridge.exposeInMainWorld('api', api);
