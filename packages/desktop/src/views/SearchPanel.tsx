import { useEffect, useState } from 'react';

import RichText from '../components/RichText.js';
import { Avatar } from '../components/ui.js';
import { api, type AppState, type WorkspaceView } from '../lib/api.js';
import { dateTimeOf, plural } from '../lib/format.js';

/**
 * Search across a workspace. Results come from the relay because it holds the
 * full history; the app only caches what has been read.
 */
export default function SearchPanel({
  state,
  workspace,
  onClose,
  onOpenChannel,
}: {
  state: AppState;
  workspace: WorkspaceView;
  onClose: () => void;
  onOpenChannel: (channelId: string) => void;
}) {
  const [query, setQuery] = useState(state.search?.query ?? '');

  // Debounced: one request per pause in typing, not one per keystroke.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const id = setTimeout(() => void api.search(workspace.workspace.id, trimmed), 220);
    return () => clearTimeout(id);
  }, [query, workspace.workspace.id]);

  const results = state.search && state.search.query ? state.search : null;

  return (
    <div className="panel search-panel">
      <div className="search-bar">
        <input
          autoFocus
          value={query}
          placeholder={`Search ${workspace.workspace.name}`}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
        />
        <button className="ghost" onClick={onClose}>
          Close
        </button>
      </div>

      {!query.trim() ? (
        <div className="empty">
          Search everything said in {workspace.workspace.name} — channels you are in, and your direct
          messages.
        </div>
      ) : !results ? (
        <div className="hint">Searching…</div>
      ) : results.hits.length === 0 ? (
        <div className="empty">Nothing matches “{results.query}”.</div>
      ) : (
        <>
          <p className="subtitle">
            {plural(results.hits.length, 'result')}
            {results.truncated ? ' (showing the best matches)' : ''}
          </p>
          {results.hits.map((hit) => {
            const author = workspace.members.find((m) => m.address === hit.message.author);
            const isRoom = hit.channelKind === 'public' || hit.channelKind === 'private';
            return (
              <button
                className="activity-card"
                key={hit.message.id}
                onClick={() => onOpenChannel(hit.message.channelId)}
              >
                <Avatar
                  name={author?.displayName ?? hit.message.author}
                  address={hit.message.author}
                  size={32}
                />
                <div className="activity-body">
                  <div className="activity-head">
                    <span className="activity-kind">{author?.displayName ?? hit.message.author}</span>
                    <span className="activity-where">
                      {isRoom ? `#${hit.channelName}` : hit.channelName}
                    </span>
                    <span className="activity-when">{dateTimeOf(hit.message.ts)}</span>
                  </div>
                  <RichText
                    text={hit.message.text}
                    ctx={{ members: workspace.members, me: workspace.me.address }}
                  />
                </div>
              </button>
            );
          })}
        </>
      )}
    </div>
  );
}
