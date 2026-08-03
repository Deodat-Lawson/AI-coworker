/**
 * The connector registry.
 *
 * Detection is deliberately cheap — it stats a few well-known paths and never
 * opens a transcript — because it runs every time the app wants to tell the
 * human "here is what is on this machine that you have not connected yet".
 */

import type { DetectedSource } from '@ai-coworker/shared';

import { claudeCodeConnector } from './claude-code.js';
import { codexConnector } from './codex.js';
import { folderConnector, inspectFolder } from './folder.js';
import { hermesConnector } from './hermes.js';
import { openclawConnector } from './openclaw.js';
import { type Connector, type ConnectorContext, connectorContext } from './types.js';

export const CONNECTORS: Connector[] = [
  claudeCodeConnector,
  codexConnector,
  openclawConnector,
  hermesConnector,
  folderConnector,
];

export function connectorFor(kind: string): Connector | undefined {
  return CONNECTORS.find((c) => c.kind === kind);
}

/**
 * Everything on this machine that holds memory. One broken connector must not
 * hide the others, so failures are swallowed per connector.
 */
export async function detectSources(ctx: Partial<ConnectorContext> = {}): Promise<DetectedSource[]> {
  const context = connectorContext(ctx);
  const found: DetectedSource[] = [];
  for (const connector of CONNECTORS) {
    try {
      found.push(...(await connector.detect(context)));
    } catch {
      // Detection is a convenience; a tool we cannot see is simply not offered.
    }
  }
  return found.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
}

export { claudeCodeConnector, codexConnector, folderConnector, hermesConnector, openclawConnector, inspectFolder };
export { connectorContext, DEFAULT_LIMITS } from './types.js';
export type { Connector, ConnectorContext, ConnectorLimits, ReadOptions } from './types.js';
