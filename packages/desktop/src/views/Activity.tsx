import { useMemo, useState } from 'react';

import RichText from '../components/RichText.js';
import { Avatar } from '../components/ui.js';
import { api, unwrap, type AppState, type WorkspaceView } from '../lib/api.js';
import { dateTimeOf, plural } from '../lib/format.js';

interface Props {
  state: AppState;
  workspace: WorkspaceView | undefined;
  mode: 'activity' | 'threads';
  onOpenChannel: (workspaceId: string, channelId: string) => void;
  onOpenThread: (workspaceId: string, channelId: string, rootId: string) => void;
}

/**
 * Two views over the same cache: everything aimed at you (Activity), and every
 * conversation you are part of (Threads). Both work across workspaces, because
 * "did anybody need me?" is not a per-workspace question.
 */
export default function Activity({ state, workspace, mode, onOpenChannel, onOpenThread }: Props) {
  const [filter, setFilter] = useState<'all' | 'mentions' | 'reactions'>('all');

  const items = useMemo(() => {
    if (mode === 'threads') return [];
    return state.activity.filter((item) => {
      if (filter === 'mentions') return item.kind === 'mention';
      if (filter === 'reactions') return item.kind === 'reaction';
      return true;
    });
  }, [state.activity, filter, mode]);

  const threads = useMemo(() => {
    if (mode !== 'threads') return [];
    // Threads are derived from the activity feed: anything you were mentioned in
    // or reacted to that lives in a thread, plus roots that have replies.
    const seen = new Map<
      string,
      {
        workspaceId: string;
        workspaceName: string;
        channelId: string;
        channelLabel: string;
        root: string;
        ts: number;
        count: number;
      }
    >();
    for (const item of state.activity) {
      const rootId = item.message.threadRootId ?? item.message.id;
      if (!item.message.threadRootId && item.message.replyCount === 0) continue;
      const existing = seen.get(rootId);
      if (existing) {
        existing.ts = Math.max(existing.ts, item.ts);
        existing.count++;
      } else {
        seen.set(rootId, {
          workspaceId: item.workspaceId,
          workspaceName: item.workspaceName,
          channelId: item.channelId,
          channelLabel: item.channelLabel,
          root: rootId,
          ts: item.ts,
          count: 1,
        });
      }
    }
    return [...seen.values()].sort((a, b) => b.ts - a.ts);
  }, [state.activity, mode]);

  const ctx = {
    members: workspace?.members ?? [],
    me: workspace?.me.address,
  };

  if (mode === 'threads') {
    return (
      <div className="panel">
        <h1>Threads</h1>
        <p className="subtitle">Conversations you have been part of, newest first.</p>
        {threads.length === 0 ? (
          <div className="empty">No threads yet. Reply to a message to start one.</div>
        ) : (
          threads.map((thread) => (
            <button
              className="card clickable full"
              key={thread.root}
              onClick={() => {
                void api.openChannel(thread.workspaceId, thread.channelId);
                onOpenThread(thread.workspaceId, thread.channelId, thread.root);
              }}
            >
              <div className="card-head">
                <div>
                  <div className="card-title">{thread.channelLabel}</div>
                  <div className="card-sub">{thread.workspaceName}</div>
                </div>
                <div className="card-meta">
                  {plural(thread.count, 'update')}
                  <div>{dateTimeOf(thread.ts)}</div>
                </div>
              </div>
            </button>
          ))
        )}
      </div>
    );
  }

  return (
    <div className="panel">
      <h1>Activity</h1>
      <p className="subtitle">Mentions and reactions across every workspace you are in.</p>
      <div className="tabs">
        {(['all', 'mentions', 'reactions'] as const).map((option) => (
          <button
            key={option}
            className={`tab ${filter === option ? 'active' : ''}`}
            onClick={() => setFilter(option)}
          >
            {option[0]!.toUpperCase() + option.slice(1)}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <div className="empty">Nothing yet. When somebody says your name it lands here.</div>
      ) : (
        items.map((item, i) => {
          const author =
            state.workspaces
              .find((w) => w.workspace.id === item.workspaceId)
              ?.members.find((m) => m.address === item.message.author) ?? null;
          return (
            <button
              className="activity-card"
              key={`${item.message.id}:${item.kind}:${i}`}
              onClick={async () => {
                await unwrap(api.openChannel(item.workspaceId, item.channelId));
                onOpenChannel(item.workspaceId, item.channelId);
              }}
            >
              <Avatar
                name={author?.displayName ?? item.message.author}
                address={item.message.author}
                size={32}
              />
              <div className="activity-body">
                <div className="activity-head">
                  <span className="activity-kind">
                    {item.kind === 'reaction' ? `${item.by} reacted ${item.emoji}` : 'Mentioned you'}
                  </span>
                  <span className="activity-where">
                    {item.channelLabel} · {item.workspaceName}
                  </span>
                  <span className="activity-when">{dateTimeOf(item.ts)}</span>
                </div>
                <RichText text={item.message.text} ctx={ctx} />
              </div>
            </button>
          );
        })
      )}
    </div>
  );
}
