/**
 * Settings, and the line down the middle of them.
 *
 * Two things were getting called "settings" and behaving differently. One is
 * the installation: the relay it talks to, the model behind every agent, the
 * folder on disk, how the window looks. There is exactly one of those per copy
 * of the app, and changing it changes everything at once. The other is *an
 * agent* — how this person's agent introduces itself, when it is willing to
 * meet, what it has been told to do on their behalf. That travels with the
 * person, and two people on one relay disagree about it constantly.
 *
 * Keeping both in one bag meant every screen had to remember which kind it was
 * touching, and the answer lived only in the name of the IPC channel. So they
 * are two types now, stored apart and written apart: `GlobalSettings` in the
 * app's own config, `AgentSettings` in the knowledge base beside the notes.
 *
 * Workspace preferences are a third thing again — per workspace, per person,
 * and already modelled by `WorkspacePrefs`. They are not settings in this
 * sense: they belong to a membership rather than to the app or the agent.
 */

import type { WorkingHours } from './domain.js';
import type { Appearance } from './theme.js';

/** Which brain the agents use. The key itself never leaves the main process. */
export interface BrainSettings {
  /** The model id, e.g. `gemini-flash-latest`. Empty means "whatever ships". */
  model: string;
  /**
   * Whether a key is configured, and where it came from. The renderer is told
   * that a key exists so it can stop asking; it is never told what the key is.
   */
  hasApiKey: boolean;
  apiKeySource: 'settings' | 'environment' | 'none';
}

/**
 * One per installation. Everything here is true regardless of who is signed in
 * or which workspace is open.
 */
export interface GlobalSettings {
  appearance: Appearance;
  /** The relay this copy of the app connects to first. */
  relayUrl: string;
  /** Every relay it knows about, the primary one included. */
  relays: string[];
  /** Where the knowledge base lives on this disk. */
  knowledgeDir: string | null;
  brain: BrainSettings;
}

/**
 * One per agent — this person's. Stored in their knowledge base, not in the
 * app's config, because it belongs to them rather than to the machine.
 */
export interface AgentSettings {
  displayName: string;
  title: string;
  team: string;
  timezone: string;
  bio: string;
  focusAreas: string[];
  /** Standing instructions the agent follows when it acts on their behalf. */
  instructions: string;
  /** When this person's agent is willing to put a meeting on the calendar. */
  workingHours: WorkingHours;
}

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  appearance: 'system',
  relayUrl: '',
  relays: [],
  knowledgeDir: null,
  brain: { model: '', hasApiKey: false, apiKeySource: 'none' },
};

/**
 * A patch a caller is allowed to send. `brain.hasApiKey` and `apiKeySource` are
 * derived — the main process works them out from the key it holds — so they are
 * not settable, and the key is write-only from the renderer's side.
 */
export interface GlobalSettingsPatch {
  appearance?: Appearance;
  relayUrl?: string;
  knowledgeDir?: string;
  brain?: {
    model?: string;
    /** Write-only. Empty string clears the stored key. */
    apiKey?: string;
  };
}

/** Everything a person may change about their own agent. */
export type AgentSettingsPatch = Partial<AgentSettings>;
