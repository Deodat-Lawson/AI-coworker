import type { AppState, DesktopApi, IpcResult } from '../../electron/ipc.js';

declare global {
  interface Window {
    api: DesktopApi;
  }
}

export const api = window.api;

export type { AppState };

/** Unwrap an IPC result, throwing the error message so callers can surface it. */
export async function unwrap<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

export const emptyState: AppState = {
  ready: false,
  workspaceDir: null,
  profile: null,
  connection: {
    state: 'offline',
    error: null,
    relayUrl: '',
    providerName: '',
    providerLive: false,
    providerReason: '',
    hasApiKey: false,
    apiKeySource: 'none',
    model: '',
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
  personas: [],
};
