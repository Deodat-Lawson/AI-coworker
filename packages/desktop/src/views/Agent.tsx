import { useEffect, useRef, useState } from 'react';

import { api, type AppState } from '../lib/api.js';
import { dateTimeOf, nameOf, relative, timeOf } from '../lib/format.js';

interface Props {
  state: AppState;
  /** Jump to a meeting: its channel, with the briefing open beside it. */
  onOpenMeeting: (meetingId: string) => void;
}

const SUGGESTIONS = [
  'Book a 30 minute sync with Dana about the auth migration',
  'What am I on the hook for right now?',
  'Note: SSO refresh is blocked on a decision from mobile',
  'Block 2 hours tomorrow morning for focus time',
  'What happened in my last meeting?',
];

/**
 * Your own agent, laid out like every other conversation in the app: you talk
 * to it on the left, and what it is currently holding for you — meetings it has
 * booked, work it accepted on your behalf, questions it could not answer
 * without you — sits beside it.
 */
export default function Agent({ state, onOpenMeeting }: Props) {
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
    <div className="chat with-thread">
      <div className="chat-main">
        <header className="chat-head">
          <div className="chat-title">
            <span className="chat-glyph">◆</span>
            Your agent
          </div>
          <div className="chat-head-meta">
            <span className={`tag ${state.connection.providerLive ? 'good' : 'warn'}`}>
              {state.connection.providerName}
            </span>
            <span className="chat-topic">
              {state.connection.state === 'online'
                ? 'on the network — other agents can reach it'
                : 'offline — it cannot be reached for meetings'}
            </span>
          </div>
        </header>

        <div className="messages">
          <div className="msg-spacer" />
          {state.chat.length === 0 ? (
            <div className="chat-intro">
              <h2>Tell it what you're working on</h2>
              <p className="subtitle">
                It keeps your knowledge base current, books meetings with other people's agents, and
                attends them for you.
                {!state.connection.providerLive ? (
                  <>
                    {' '}
                    <span style={{ color: 'var(--warn)' }}>
                      Running the offline brain ({state.connection.providerReason}) — it only
                      understands simple phrasings.
                    </span>
                  </>
                ) : null}
              </p>
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button className="suggestion" key={s} onClick={() => void send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
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

        <div className="chat-foot">
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
            <button
              className="primary"
              style={{ flex: '0 0 auto' }}
              disabled={busy || !draft.trim()}
              onClick={() => void send(draft)}
            >
              Send
            </button>
            {state.chat.length ? (
              <button style={{ flex: '0 0 auto' }} onClick={() => void api.clearChat()}>
                Clear
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <AgentLedger state={state} onOpenMeeting={onOpenMeeting} />
    </div>
  );
}

/** Everything your agent is holding on your behalf, in one column. */
function AgentLedger({ state, onOpenMeeting }: Props) {
  const me = state.profile!.address;
  const openTasks = state.tasks
    .filter((t) => t.assignee === me && t.status !== 'done' && t.status !== 'dropped')
    .sort((a, b) => (a.dueDate ?? Infinity) - (b.dueDate ?? Infinity));
  const upcoming = state.meetings
    .filter((m) => m.meeting.status === 'scheduled' && m.meeting.end > Date.now())
    .sort((a, b) => a.meeting.start - b.meeting.start);
  const briefings = state.meetings.filter((m) => m.outcome).slice(0, 4);
  const needsYou = briefings.flatMap((m) =>
    (m.outcome?.openQuestionsForHuman ?? []).map((q) => ({ meeting: m.meeting, question: q })),
  );

  return (
    <aside className="thread-panel">
      <header className="chat-head">
        <div className="chat-title">What it's holding</div>
      </header>

      <div className="panel scroll">
        {state.connection.state === 'error' ? (
          <div className="banner bad">
            <div>
              <div className="card-title">Can't reach the relay</div>
              <div className="card-sub">{state.connection.error ?? state.connection.relayUrl}</div>
            </div>
            <button onClick={() => void api.reconnect()}>Retry</button>
          </div>
        ) : null}

        {state.live.map((room) => (
          <div className="banner" key={room.meeting.id}>
            <div>
              <div className="card-title">
                {room.meeting.title} is happening now
                {room.thinking ? <span className="thinking-dots" /> : null}
              </div>
              <div className="card-sub">
                {room.phase} · {room.transcript.filter((t) => t.speaker !== 'moderator').length} turns
                {room.speaking ? ` · ${nameOf(room.speaking, state.directory)} has the floor` : ''}
              </div>
            </div>
            <button className="primary" onClick={() => onOpenMeeting(room.meeting.id)}>
              Watch
            </button>
          </div>
        ))}

        {needsYou.length ? (
          <div className="banner warn">
            <div>
              <div className="card-title">
                Your agent needs you on {needsYou.length} thing{needsYou.length === 1 ? '' : 's'}
              </div>
              <div className="card-sub">{needsYou[0]!.question}</div>
            </div>
            <button onClick={() => onOpenMeeting(needsYou[0]!.meeting.id)}>Review</button>
          </div>
        ) : null}

        <h2>Coming up</h2>
        {upcoming.length === 0 ? (
          <div className="empty">
            Nothing scheduled. Ask for a meeting, or press <strong>Meet</strong> in any channel — the
            agents in it will negotiate a time between them.
          </div>
        ) : (
          upcoming.map(({ meeting }) => (
            <div className="card clickable" key={meeting.id} onClick={() => onOpenMeeting(meeting.id)}>
              <div className="card-title">{meeting.title}</div>
              <div className="card-sub">
                with{' '}
                {meeting.participants
                  .filter((p) => p !== me)
                  .map((p) => nameOf(p, state.directory))
                  .join(', ')}
              </div>
              <div className="card-meta" style={{ marginTop: 6 }}>
                {dateTimeOf(meeting.start)} · {relative(meeting.start)}
              </div>
              <div style={{ marginTop: 8 }}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void api.startMeetingNow(meeting.id);
                  }}
                >
                  Run it now
                </button>{' '}
                <button
                  className="danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    void api.cancelMeeting(meeting.id, 'Cancelled from the desktop app.');
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ))
        )}

        <h2>Your work</h2>
        {openTasks.length === 0 ? (
          <div className="empty">No open tasks.</div>
        ) : (
          openTasks.slice(0, 10).map((task) => (
            <div className="card" key={task.id}>
              <div className="card-title">{task.title}</div>
              <div className="card-sub">
                {task.assignedBy !== me
                  ? `Assigned by ${nameOf(task.assignedBy, state.directory)}`
                  : 'Self-assigned'}
                {task.sourceMeetingId ? ' in a meeting your agent attended' : ''}
              </div>
              {task.negotiationNote ? (
                <div className="card-sub" style={{ color: 'var(--warn)' }}>{task.negotiationNote}</div>
              ) : null}
              {task.acceptanceCriteria.length ? (
                <ul className="checklist">
                  {task.acceptanceCriteria.map((c, i) => (
                    <li key={i}>· {c}</li>
                  ))}
                </ul>
              ) : null}
              <div className="card-meta" style={{ marginTop: 6 }}>
                <span
                  className={`tag ${task.status === 'blocked' ? 'bad' : task.status === 'in_progress' ? 'warn' : ''}`}
                >
                  {task.status.replace('_', ' ')}
                </span>
                {task.dueDate ? ` · ${relative(task.dueDate)}` : ''}
              </div>
              <div style={{ marginTop: 8 }}>
                {(['in_progress', 'blocked', 'done'] as const)
                  .filter((s) => s !== task.status)
                  .map((s) => (
                    <button
                      key={s}
                      className="ghost"
                      onClick={() => void api.saveTask({ id: task.id, title: task.title, status: s })}
                    >
                      mark {s.replace('_', ' ')}
                    </button>
                  ))}
              </div>
            </div>
          ))
        )}

        <h2>Latest briefings</h2>
        {briefings.length === 0 ? (
          <div className="empty">
            After a meeting, your agent writes you a briefing — you never read a transcript unless you
            want to.
          </div>
        ) : (
          briefings.map((m) => (
            <div className="card clickable" key={m.meeting.id} onClick={() => onOpenMeeting(m.meeting.id)}>
              <div className="card-title">{m.outcome!.headline}</div>
              <div className="card-sub">{m.outcome!.summary.slice(0, 180)}</div>
              <div className="card-meta" style={{ marginTop: 8 }}>
                {m.meeting.title} · {relative(m.meeting.start)}
              </div>
            </div>
          ))
        )}

        <h2>Agent activity</h2>
        {state.activities.length === 0 ? (
          <div className="empty">Nothing yet.</div>
        ) : (
          <div className="card">
            {state.activities.slice(0, 12).map((a) => (
              <div className="activity-line" key={a.id}>
                <span className="activity-time">{timeOf(a.ts)}</span>
                <span className={`activity-text ${a.kind === 'error' ? 'error' : ''}`}>{a.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
