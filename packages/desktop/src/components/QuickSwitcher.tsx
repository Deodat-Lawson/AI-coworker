import { useEffect, useMemo, useState } from 'react';

import { isDirect } from '@ai-coworker/shared';

import type { AppState } from '../lib/api.js';
import { Avatar } from './ui.js';

interface Target {
  key: string;
  kind: 'channel' | 'dm' | 'person' | 'workspace';
  workspaceId: string;
  workspaceName: string;
  channelId?: string;
  address?: string;
  label: string;
  hint: string;
  unread: number;
}

/**
 * ⌘K. Everything reachable, in one list, ranked so the thing you meant is
 * first: exact prefix matches, then unread, then recency of the last message.
 */
export default function QuickSwitcher({
  state,
  onClose,
  onOpenChannel,
  onSwitchWorkspace,
  onMessagePerson,
}: {
  state: AppState;
  onClose: () => void;
  onOpenChannel: (workspaceId: string, channelId: string) => void;
  onSwitchWorkspace: (workspaceId: string) => void;
  onMessagePerson: (workspaceId: string, address: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);

  const targets = useMemo<Target[]>(() => {
    const out: Target[] = [];
    for (const workspace of state.workspaces) {
      out.push({
        key: `w:${workspace.workspace.id}`,
        kind: 'workspace',
        workspaceId: workspace.workspace.id,
        workspaceName: workspace.workspace.name,
        label: workspace.workspace.name,
        hint: 'workspace',
        unread: workspace.unread,
      });
      for (const view of workspace.channels) {
        if (view.channel.archived) continue;
        out.push({
          key: `c:${view.channel.id}`,
          kind: isDirect(view.channel) ? 'dm' : 'channel',
          workspaceId: workspace.workspace.id,
          workspaceName: workspace.workspace.name,
          channelId: view.channel.id,
          label: isDirect(view.channel) ? view.label : `#${view.channel.name}`,
          hint: workspace.workspace.name,
          unread: view.read.unread,
        });
      }
      for (const member of workspace.members) {
        if (member.address === workspace.me.address) continue;
        out.push({
          key: `p:${workspace.workspace.id}:${member.address}`,
          kind: 'person',
          workspaceId: workspace.workspace.id,
          workspaceName: workspace.workspace.name,
          address: member.address,
          label: member.displayName,
          hint: `${member.title || 'message'} · ${workspace.workspace.name}`,
          unread: 0,
        });
      }
    }
    return out;
  }, [state.workspaces]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase().replace(/^[#@]/, '');
    const wantChannel = query.startsWith('#');
    const wantPerson = query.startsWith('@');
    const scored = targets
      .filter((t) => {
        if (wantChannel && t.kind !== 'channel') return false;
        if (wantPerson && t.kind !== 'person' && t.kind !== 'dm') return false;
        return !needle || t.label.toLowerCase().includes(needle);
      })
      .map((t) => {
        const label = t.label.toLowerCase().replace(/^#/, '');
        let score = 0;
        if (needle && label.startsWith(needle)) score += 20;
        if (needle && label === needle) score += 30;
        if (t.unread) score += 8;
        if (t.workspaceId === state.activeWorkspaceId) score += 4;
        if (t.kind === 'channel') score += 3;
        if (t.kind === 'dm') score += 2;
        return { t, score };
      })
      .sort((a, b) => b.score - a.score || a.t.label.localeCompare(b.t.label));
    return scored.slice(0, 12).map((s) => s.t);
  }, [targets, query, state.activeWorkspaceId]);

  useEffect(() => setIndex(0), [query]);

  const choose = (target: Target | undefined) => {
    if (!target) return;
    if (target.kind === 'workspace') onSwitchWorkspace(target.workspaceId);
    else if (target.kind === 'person' && target.address) onMessagePerson(target.workspaceId, target.address);
    else if (target.channelId) onOpenChannel(target.workspaceId, target.channelId);
    onClose();
  };

  return (
    <div className="scrim top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="switcher">
        <input
          autoFocus
          value={query}
          placeholder="Jump to a channel, person or workspace…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, results.length - 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              choose(results[index]);
            }
          }}
        />
        <div className="switcher-list">
          {results.map((target, i) => (
            <button
              key={target.key}
              className={`switcher-row ${i === index ? 'active' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(target)}
            >
              <span className="switcher-icon">
                {target.kind === 'workspace' ? (
                  state.workspaces.find((w) => w.workspace.id === target.workspaceId)?.workspace.icon
                ) : target.kind === 'channel' ? (
                  '#'
                ) : target.address ? (
                  <Avatar name={target.label} address={target.address} size={18} square />
                ) : (
                  '✉'
                )}
              </span>
              <span className="switcher-label">{target.label}</span>
              <span className="switcher-hint">{target.hint}</span>
              {target.unread ? <span className="side-badge">{target.unread}</span> : null}
            </button>
          ))}
          {results.length === 0 ? <div className="hint switcher-empty">Nothing matches.</div> : null}
        </div>
        <div className="switcher-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>↵</kbd> to open
          </span>
          <span>
            <kbd>#</kbd> channels · <kbd>@</kbd> people
          </span>
        </div>
      </div>
    </div>
  );
}
