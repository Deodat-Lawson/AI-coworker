/**
 * One agent per workspace.
 *
 * A person has one knowledge base and one machine, but they do not have one
 * agent: the agent that sits in a client's workspace and the one that sits in
 * their employer's are different agents with different names, different
 * standing orders, and — this is the part that matters — different reach into
 * the machine they both run on.
 *
 * That is what this file models. A `WorkspaceAgent` is the single agent that
 * represents you inside exactly one workspace. It is created the moment you
 * join, it is stored on your own machine (never on the relay), and it starts
 * with **nothing**: no imported memory, no folders, no coding tool. Everything
 * it can reach, somebody granted it deliberately, for that workspace alone.
 *
 * The alternative — one agent with the run of the machine, joining every
 * workspace — is the thing that cannot be made safe after the fact. A grant
 * that is workspace-shaped can be reasoned about ("what can the Acme agent
 * see?"); an agent that is merely *asked* to be careful cannot.
 */

import type { Sensitivity } from './access.js';
import { sensitivityRank } from './access.js';
import type { WorkspaceId } from './workspace.js';

// ---------------------------------------------------------------------------
// What an agent may do
// ---------------------------------------------------------------------------

/**
 * How much rope the agent has in this workspace.
 *
 * `observer` is a real setting, not a placeholder: an agent that reads a
 * workspace and briefs you, and never opens its mouth in it, is what most
 * people want in the workspace they were added to last week.
 */
export type AgentAutonomy = 'observer' | 'ask' | 'act';

export const AGENT_AUTONOMIES: readonly AgentAutonomy[] = ['observer', 'ask', 'act'] as const;

export const AUTONOMY_LABELS: Record<AgentAutonomy, string> = {
  observer: 'Watch only',
  ask: 'Ask me first',
  act: 'Act on my behalf',
};

export const AUTONOMY_BLURBS: Record<AgentAutonomy, string> = {
  observer: 'Reads this workspace and briefs you. Never posts, never accepts work.',
  ask: 'Drafts replies, proposes meetings and work — you approve each one before it lands.',
  act: 'Speaks for you: attends meetings, answers questions, accepts work within your instructions.',
};

/**
 * A thing the agent can reach. Each key is one switch on the access screen and
 * one gate in the runtime — if it is not in this list, the agent cannot do it,
 * and if it is off, the runtime refuses before the model is ever asked.
 */
export type AgentToolKey =
  | 'knowledge_read'
  | 'knowledge_write'
  | 'memory_recall'
  | 'meetings'
  | 'messages'
  | 'calendar'
  | 'tasks'
  | 'computer_folders'
  | 'computer_claude_code'
  | 'computer_codex';

/**
 * What each switch means, in the words the screen uses.
 *
 * `risk` orders the list and colours it: a person scanning this screen should
 * be able to see the dangerous half without reading it. `implemented` is the
 * honest bit — a switch is only listed when the runtime actually honours it,
 * so this screen never promises reach the agent does not have.
 */
export interface AgentToolSpec {
  key: AgentToolKey;
  label: string;
  blurb: string;
  /** Which half of the screen it belongs to. */
  group: 'workspace' | 'knowledge' | 'computer';
  risk: 'low' | 'medium' | 'high';
  /** False while the runtime does not honour the switch; such tools are hidden. */
  implemented: boolean;
  /** Default for a freshly created workspace agent. */
  onByDefault: boolean;
}

/**
 * The catalogue. Order is the order the screen draws.
 *
 * Everything here is `implemented: true` — the runtime gates on each of these
 * keys today. When a new reach is added, its entry lands here switched off by
 * default and is only marked implemented once the gate exists, because a switch
 * that does nothing is worse than no switch at all.
 */
export const AGENT_TOOLS: readonly AgentToolSpec[] = [
  {
    key: 'messages',
    label: 'Read this workspace',
    blurb: 'Channels you are in, so it knows what is going on before it says anything.',
    group: 'workspace',
    risk: 'low',
    implemented: true,
    onByDefault: true,
  },
  {
    key: 'meetings',
    label: 'Meet other agents',
    blurb: 'Negotiate times and attend meetings here on your behalf.',
    group: 'workspace',
    risk: 'medium',
    implemented: true,
    onByDefault: true,
  },
  {
    key: 'calendar',
    label: 'Hold time in your calendar',
    blurb: 'Book and block time inside your working hours. Never outside them.',
    group: 'workspace',
    risk: 'medium',
    implemented: true,
    onByDefault: true,
  },
  {
    key: 'tasks',
    label: 'Accept work for you',
    blurb: 'Take on tasks assigned in this workspace, within your standing instructions.',
    group: 'workspace',
    risk: 'medium',
    implemented: true,
    onByDefault: true,
  },
  {
    key: 'knowledge_read',
    label: 'Read your knowledge base',
    blurb: 'Your notes, projects and artifacts — subject to the sensitivity ceiling below.',
    group: 'knowledge',
    risk: 'medium',
    implemented: true,
    onByDefault: true,
  },
  {
    key: 'knowledge_write',
    label: 'Write to your knowledge base',
    blurb: 'File notes and update projects from what happens in this workspace.',
    group: 'knowledge',
    risk: 'medium',
    implemented: true,
    onByDefault: false,
  },
  {
    key: 'memory_recall',
    label: 'Recall imported memory',
    blurb: 'What your other tools already knew, from the sources you grant below.',
    group: 'knowledge',
    risk: 'high',
    implemented: true,
    onByDefault: false,
  },
  {
    key: 'computer_folders',
    label: 'Read granted folders',
    blurb: 'Only the folders listed here. Nothing else on this machine is reachable.',
    group: 'computer',
    risk: 'high',
    implemented: true,
    onByDefault: false,
  },
  {
    key: 'computer_claude_code',
    label: 'Claude Code memory',
    blurb: "Project memory and session notes kept by Claude Code on this machine.",
    group: 'computer',
    risk: 'high',
    implemented: true,
    onByDefault: false,
  },
  {
    key: 'computer_codex',
    label: 'Codex memory',
    blurb: 'Threads and distilled memories kept by Codex on this machine.',
    group: 'computer',
    risk: 'high',
    implemented: true,
    onByDefault: false,
  },
] as const;

export const AGENT_TOOL_KEYS: readonly AgentToolKey[] = AGENT_TOOLS.map((t) => t.key);

/** Only these are ever drawn: a switch the runtime ignores must not be offered. */
export function liveTools(): AgentToolSpec[] {
  return AGENT_TOOLS.filter((tool) => tool.implemented);
}

export function toolSpec(key: AgentToolKey): AgentToolSpec | undefined {
  return AGENT_TOOLS.find((tool) => tool.key === key);
}

export const AGENT_TOOL_GROUPS: { key: AgentToolSpec['group']; label: string; blurb: string }[] = [
  {
    key: 'workspace',
    label: 'In this workspace',
    blurb: 'What it may do in the rooms you share with other people.',
  },
  {
    key: 'knowledge',
    label: 'Your own knowledge',
    blurb: 'What of yours it may draw on when it speaks here.',
  },
  {
    key: 'computer',
    label: 'This computer',
    blurb:
      'Every agent runs on your machine. Each one reaches only what its own workspace was granted — nothing here is shared with the agent in another workspace.',
  },
];

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------

/** Where imported memory comes from, for this workspace's agent only. */
export type SourceMode = 'none' | 'selected' | 'all';

export interface WorkspaceAgentAccess {
  tools: Partial<Record<AgentToolKey, boolean>>;
  /**
   * `none` is the default and it is not a formality — a brand new workspace
   * agent recalls nothing that came from another tool until somebody says so.
   */
  sourceMode: SourceMode;
  /** Source ids granted when `sourceMode` is `selected`. */
  sources: string[];
  /**
   * Nothing above this level is loaded in this workspace at all — not shared,
   * not summarized, not used to reason. `secret` never leaves the machine
   * regardless, so the useful range is public…restricted.
   */
  ceiling: Sensitivity;
  /** Absolute paths this agent may read. Empty means it reads no folders. */
  folders: string[];
}

/**
 * The one agent that represents you in one workspace.
 *
 * Identity (`name`, `emoji`, `accent`) is per workspace on purpose: the point
 * of the whole model is that "Ada, at Acme" and "your agent, at home" are
 * visibly not the same actor, so nobody has to remember which one they are
 * talking to.
 */
export interface WorkspaceAgent {
  workspaceId: WorkspaceId;
  name: string;
  /** A single emoji drawn on its avatar. */
  emoji: string;
  accent: string;
  /** Standing instructions that apply here and nowhere else. */
  instructions: string;
  /** Whether your machine-wide instructions apply in this workspace too. */
  inheritInstructions: boolean;
  autonomy: AgentAutonomy;
  access: WorkspaceAgentAccess;
  /**
   * False until the person has actually been shown this agent. Joining a
   * workspace creates an agent whether or not anybody looks at it, and an agent
   * nobody has met is the one case where the app should interrupt: it is the
   * only moment when "this is a *different* agent" is cheap to explain.
   */
  introduced: boolean;
  createdAt: number;
  updatedAt: number;
}

export const AGENT_EMOJI = [
  '◆', '🤖', '🦉', '🐙', '🦊', '🐝', '🛰️', '🧭', '🔭', '⚙️', '🧠', '✳️',
] as const;

export function defaultAgentAccess(): WorkspaceAgentAccess {
  const tools: Partial<Record<AgentToolKey, boolean>> = {};
  for (const tool of AGENT_TOOLS) tools[tool.key] = tool.onByDefault;
  return { tools, sourceMode: 'none', sources: [], ceiling: 'internal', folders: [] };
}

export function defaultWorkspaceAgent(
  workspaceId: WorkspaceId,
  input: { name?: string; emoji?: string; accent?: string; now?: number } = {},
): WorkspaceAgent {
  const now = input.now ?? Date.now();
  return {
    workspaceId,
    name: input.name?.trim() || 'Your agent',
    emoji: input.emoji || '◆',
    accent: input.accent || '#6ea8fe',
    instructions: '',
    inheritInstructions: true,
    autonomy: 'ask',
    access: defaultAgentAccess(),
    introduced: false,
    createdAt: now,
    updatedAt: now,
  };
}

/** Fill in anything a stored agent predates, without touching what it set. */
export function normalizeWorkspaceAgent(
  workspaceId: WorkspaceId,
  stored: Partial<WorkspaceAgent> | undefined,
  now = Date.now(),
): WorkspaceAgent {
  const base = defaultWorkspaceAgent(workspaceId, { now });
  if (!stored) return base;
  const access = stored.access ?? base.access;
  return {
    ...base,
    ...stored,
    workspaceId,
    access: {
      tools: { ...base.access.tools, ...(access.tools ?? {}) },
      sourceMode: access.sourceMode ?? base.access.sourceMode,
      sources: [...new Set(access.sources ?? [])],
      ceiling: access.ceiling ?? base.access.ceiling,
      folders: [...new Set(access.folders ?? [])],
    },
  };
}

/** A patch a screen is allowed to send. Timestamps and identity are ours. */
export interface WorkspaceAgentPatch {
  name?: string;
  emoji?: string;
  accent?: string;
  instructions?: string;
  inheritInstructions?: boolean;
  autonomy?: AgentAutonomy;
  access?: Partial<WorkspaceAgentAccess>;
  introduced?: boolean;
}

export function applyAgentPatch(
  agent: WorkspaceAgent,
  patch: WorkspaceAgentPatch,
  now = Date.now(),
): WorkspaceAgent {
  const next: WorkspaceAgent = {
    ...agent,
    ...patch,
    access: { ...agent.access },
    updatedAt: now,
  };
  if (patch.access) {
    next.access = {
      ...agent.access,
      ...patch.access,
      tools: { ...agent.access.tools, ...(patch.access.tools ?? {}) },
      sources: patch.access.sources ? [...new Set(patch.access.sources)] : agent.access.sources,
      folders: patch.access.folders ? [...new Set(patch.access.folders)] : agent.access.folders,
    };
  }
  next.name = next.name.trim() || agent.name;
  return next;
}

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

/**
 * Is this switch on for this agent?
 *
 * Unknown keys and unimplemented tools are `false`. A caller that asks about
 * reach nobody has built gets "no", which is the only safe direction for a
 * default to fall in.
 */
export function agentMay(agent: WorkspaceAgent | undefined, tool: AgentToolKey): boolean {
  if (!agent) return false;
  const spec = toolSpec(tool);
  if (!spec || !spec.implemented) return false;
  if (agent.autonomy === 'observer' && WRITES.has(tool)) return false;
  return agent.access.tools[tool] === true;
}

/** Tools that put something into the world rather than reading from it. */
const WRITES = new Set<AgentToolKey>(['knowledge_write', 'tasks', 'meetings']);

/**
 * Which imported sources this workspace's agent may recall from.
 *
 * `null` means "every connected source" and is only ever returned for an
 * explicit `all`. An empty array means none, and callers must treat it as a
 * hard stop rather than as "unset" — that distinction is the whole gate.
 */
export function agentSourceScope(agent: WorkspaceAgent | undefined): string[] | null {
  if (!agent || !agentMay(agent, 'memory_recall')) return [];
  if (agent.access.sourceMode === 'all') return null;
  if (agent.access.sourceMode === 'none') return [];
  return [...agent.access.sources];
}

/**
 * Which tool switch governs a whole class of source.
 *
 * A person who switches "Claude Code memory" off is not asking for their grants
 * to be edited — they are saying *that tool's memory is not to be used here*.
 * So the kind is checked as well as the individual grant, and the stricter of
 * the two wins. Kinds not listed here are governed by the recall switch and the
 * source list alone.
 */
export const SOURCE_KIND_TOOLS: Record<string, AgentToolKey> = {
  'claude-code': 'computer_claude_code',
  codex: 'computer_codex',
  folder: 'computer_folders',
};

export function agentMayUseSourceKind(agent: WorkspaceAgent | undefined, kind: string): boolean {
  if (!agent) return false;
  if (!agentMay(agent, 'memory_recall')) return false;
  const tool = SOURCE_KIND_TOOLS[kind];
  return tool ? agentMay(agent, tool) : true;
}

export function agentMayUseSource(
  agent: WorkspaceAgent | undefined,
  sourceId: string,
  kind?: string,
): boolean {
  if (kind !== undefined && !agentMayUseSourceKind(agent, kind)) return false;
  const scope = agentSourceScope(agent);
  if (scope === null) return true;
  return scope.includes(sourceId);
}

/** Nothing above the workspace's ceiling is loaded in that workspace. */
export function agentMaySeeSensitivity(
  agent: WorkspaceAgent | undefined,
  level: Sensitivity,
): boolean {
  if (!agent) return false;
  return sensitivityRank(level) <= sensitivityRank(agent.access.ceiling);
}

/**
 * Is this path inside a folder this agent was granted?
 *
 * Prefix matching with a separator guard, so `/work/acme-secrets` does not fall
 * inside a grant for `/work/acme`. Paths are compared as given; the caller
 * resolves them first.
 */
export function agentMayReadPath(agent: WorkspaceAgent | undefined, absolutePath: string): boolean {
  if (!agentMay(agent, 'computer_folders')) return false;
  const target = trimTrailingSlash(absolutePath);
  return (agent?.access.folders ?? []).some((folder) => {
    const root = trimTrailingSlash(folder);
    if (!root) return false;
    return target === root || target.startsWith(`${root}/`);
  });
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * The line the access screen puts under the agent's name, and the line a
 * refusal quotes back. One sentence, no jargon, true by construction.
 */
export function describeAgentReach(agent: WorkspaceAgent): string {
  const parts: string[] = [];
  const scope = agentSourceScope(agent);
  if (scope === null) parts.push('every imported source');
  else if (scope.length) parts.push(`${scope.length} imported source${scope.length === 1 ? '' : 's'}`);
  if (agentMay(agent, 'knowledge_read')) parts.push(`your knowledge base up to ${agent.access.ceiling}`);
  const folders = agentMay(agent, 'computer_folders') ? agent.access.folders.length : 0;
  if (folders) parts.push(`${folders} folder${folders === 1 ? '' : 's'} on this machine`);
  if (!parts.length) return 'Reaches nothing on this machine yet.';
  return `Reaches ${joinList(parts)}.`;
}

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Two agents in two workspaces must never share reach they were not both
 * granted. This answers "what would leak if these were the same agent?", which
 * is what the settings screen shows when somebody asks why isolation matters.
 */
export function overlappingReach(a: WorkspaceAgent, b: WorkspaceAgent): string[] {
  const aScope = agentSourceScope(a);
  const bScope = agentSourceScope(b);
  if (aScope === null && bScope === null) return ['every imported source'];
  const aSet = new Set(aScope ?? []);
  const shared = (bScope ?? []).filter((id) => aSet.has(id));
  const folders = a.access.folders.filter((f) => b.access.folders.includes(f));
  return [...shared, ...folders];
}
