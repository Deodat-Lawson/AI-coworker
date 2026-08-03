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
  chooseWorkspaceDir: () => ipcRenderer.invoke('workspace:choose'),
  openWorkspaceDir: () => ipcRenderer.invoke('workspace:open'),
  onState: (handler: (state: AppState) => void) => {
    const listener = (_event: unknown, state: AppState) => handler(state);
    ipcRenderer.on('state', listener);
    return () => ipcRenderer.removeListener('state', listener);
  },
};

contextBridge.exposeInMainWorld('api', api);
