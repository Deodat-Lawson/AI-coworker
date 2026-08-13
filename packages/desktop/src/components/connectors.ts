/**
 * What each connector is, in the words somebody would recognise it by.
 *
 * This lives on its own because two screens need the same answer and used to
 * disagree: the access list described each tool properly, while the import list
 * showed a bare label and one line of detail — so the screen whose whole job is
 * "decide what to bring in" was the one that never said what any of it was.
 */

import type { AgentToolKey } from '@ai-coworker/shared';

import type { IconName } from './icons.js';

export interface ConnectorMeta {
  label: string;
  icon: IconName;
  /** What this tool is, for somebody who has not opened it in a month. */
  blurb: string;
  /** Where the connector looks, so an empty result is explainable. */
  where?: string;
  /** The tool gate that must be on for a granted source of this kind to work. */
  tool?: AgentToolKey;
}

export const CONNECTOR_META: Record<string, ConnectorMeta> = {
  'claude-code': {
    label: 'Claude Code',
    icon: 'terminal',
    blurb: 'Project memory and session notes from Claude Code on this machine.',
    where: '~/.claude',
    tool: 'computer_claude_code',
  },
  codex: {
    label: 'Codex',
    icon: 'code',
    blurb: 'Threads and distilled memories kept by Codex.',
    where: '~/.codex',
    tool: 'computer_codex',
  },
  openclaw: {
    label: 'OpenClaw',
    icon: 'plug',
    blurb: 'MEMORY.md and daily notes from an OpenClaw workspace.',
    where: '~/.openclaw',
  },
  hermes: {
    label: 'Hermes',
    icon: 'brain',
    blurb: 'The memory and user files Hermes keeps.',
    where: '~/.hermes',
  },
  folder: {
    label: 'Folder',
    icon: 'folder',
    blurb: 'Any folder holding memory files you point at.',
  },
};

export function connectorMeta(kind: string): ConnectorMeta {
  return CONNECTOR_META[kind] ?? { label: kind, icon: 'database' as IconName, blurb: '' };
}

/** The order the tools are presented in, so the list does not reshuffle. */
export const CONNECTOR_ORDER = ['claude-code', 'codex', 'openclaw', 'hermes', 'folder'];

export function connectorRank(kind: string): number {
  const at = CONNECTOR_ORDER.indexOf(kind);
  return at === -1 ? CONNECTOR_ORDER.length : at;
}
