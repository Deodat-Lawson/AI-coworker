import { useEffect, useRef, useState } from 'react';

import { api, type AppState } from '../lib/api.js';

interface Props {
  state: AppState;
}

const SUGGESTIONS = [
  'Book a 30 minute sync with Dana about the auth migration',
  'What am I on the hook for right now?',
  'Note: SSO refresh is blocked on a decision from mobile',
  'Block 2 hours tomorrow morning for focus time',
  'What happened in my last meeting?',
];

export default function AgentChat({ state }: Props) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.chat.length, busy]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setDraft('');
    setBusy(true);
    setError(null);
    const result = await api.chat(message);
    if (!result.ok) setError(result.error);
    setBusy(false);
  }

  return (
    <div className="chat-shell">
      <div>
        <h1>Your agent</h1>
        <p className="subtitle">
          Tell it what you're working on and who you need to talk to. It keeps your knowledge base
          current and books meetings with other people's agents.
          {!state.connection.providerLive ? (
            <>
              {' '}
              <span style={{ color: 'var(--warn)' }}>
                Running the offline brain ({state.connection.providerReason}) — it only understands
                simple phrasings.
              </span>
            </>
          ) : null}
        </p>
      </div>

      <div className="chat-log">
        {state.chat.length === 0 ? (
          <>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button className="suggestion" key={s} onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
            <div className="empty">Say anything. Your agent acts rather than describing what it could do.</div>
          </>
        ) : null}

        {state.chat.map((entry, i) => (
          <div key={i} style={{ display: 'contents' }}>
            {entry.actions?.length ? (
              <div className="tool-trace">
                {entry.actions.map((a, j) => (
                  <div key={j}>
                    → {a.tool}: {a.result.split('\n')[0].slice(0, 120)}
                  </div>
                ))}
              </div>
            ) : null}
            <div className={`bubble ${entry.role}`}>{entry.content}</div>
          </div>
        ))}

        {busy ? <div className="bubble assistant thinking-dots" /> : null}
        {error ? <div className="error-text">{error}</div> : null}
        <div ref={endRef} />
      </div>

      <div className="composer">
        <textarea
          value={draft}
          placeholder="Ask your agent to do something…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
        />
        <button className="primary" style={{ flex: '0 0 auto' }} disabled={busy || !draft.trim()} onClick={() => void send(draft)}>
          Send
        </button>
        {state.chat.length ? (
          <button style={{ flex: '0 0 auto' }} onClick={() => void api.clearChat()}>
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}
