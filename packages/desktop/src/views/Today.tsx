import type { Section } from '../components/ChannelSidebar.js';
import { api, type AppState } from '../lib/api.js';
import { dateTimeOf, nameOf, relative, timeOf } from '../lib/format.js';

interface Props {
  state: AppState;
  onOpenMeeting: (meetingId: string) => void;
  onView: (view: Section) => void;
}

export default function Today({ state, onOpenMeeting, onView }: Props) {
  const me = state.profile!.address;
  const openTasks = state.tasks
    .filter((t) => t.assignee === me && t.status !== 'done' && t.status !== 'dropped')
    .sort((a, b) => (a.dueDate ?? Infinity) - (b.dueDate ?? Infinity));

  const upcoming = state.meetings
    .filter((m) => m.meeting.status === 'scheduled' && m.meeting.end > Date.now())
    .sort((a, b) => a.meeting.start - b.meeting.start);

  const briefings = state.meetings.filter((m) => m.outcome).slice(0, 4);
  const needsYou = briefings.flatMap((m) =>
    (m.outcome?.openQuestionsForHuman ?? []).map((q) => ({ meeting: m.meeting.title, question: q })),
  );

  return (
    <>
      <h1>Today</h1>
      <p className="subtitle">
        {state.connection.state === 'online'
          ? 'Your agent is on the network and will attend on your behalf.'
          : 'Your agent is offline — it cannot be reached for meetings right now.'}
      </p>

      {state.live.map((live) => (
        <div className="banner" key={live.meeting.id}>
          <div>
            <div className="card-title">
              {live.meeting.title} is happening now
              {live.thinking ? <span className="thinking-dots" /> : null}
            </div>
            <div className="card-sub">
              {live.phase} · {live.transcript.filter((t) => t.speaker !== 'moderator').length} turns
              {live.speaking ? ` · ${nameOf(live.speaking, state.directory)} has the floor` : ''}
            </div>
          </div>
          <button className="primary" onClick={() => onOpenMeeting(live.meeting.id)}>
            Watch
          </button>
        </div>
      ))}

      {state.connection.state === 'error' ? (
        <div className="banner bad">
          <div>
            <div className="card-title">Can't reach the relay</div>
            <div className="card-sub">{state.connection.error ?? state.connection.relayUrl}</div>
          </div>
          <button onClick={() => void api.reconnect()}>Retry</button>
        </div>
      ) : null}

      {needsYou.length ? (
        <div className="banner warn">
          <div>
            <div className="card-title">Your agent needs you on {needsYou.length} thing(s)</div>
            <div className="card-sub">{needsYou[0].question}</div>
          </div>
          <button onClick={() => onView('meetings')}>Review</button>
        </div>
      ) : null}

      <div className="split">
        <div>
          <h2>Coming up</h2>
          {upcoming.length === 0 ? (
            <div className="empty">
              Nothing scheduled. Ask your agent to book something — it will negotiate the time with
              the other person's agent.
            </div>
          ) : (
            upcoming.map(({ meeting }) => (
              <div className="card clickable" key={meeting.id} onClick={() => onOpenMeeting(meeting.id)}>
                <div className="card-head">
                  <div>
                    <div className="card-title">{meeting.title}</div>
                    <div className="card-sub">
                      with{' '}
                      {meeting.participants
                        .filter((p) => p !== me)
                        .map((p) => nameOf(p, state.directory))
                        .join(', ')}
                      {meeting.chair !== me ? ` · chaired by ${nameOf(meeting.chair, state.directory)}` : ' · you chair'}
                    </div>
                  </div>
                  <div className="card-meta">
                    {dateTimeOf(meeting.start)}
                    <div>{relative(meeting.start)}</div>
                  </div>
                </div>
                <div style={{ marginTop: 10 }}>
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
                <div className="card-head">
                  <div>
                    <div className="card-title">{task.title}</div>
                    <div className="card-sub">
                      {task.assignedBy !== me ? `Assigned by ${nameOf(task.assignedBy, state.directory)}` : 'Self-assigned'}
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
                  </div>
                  <div className="card-meta">
                    <span className={`tag ${task.status === 'blocked' ? 'bad' : task.status === 'in_progress' ? 'warn' : ''}`}>
                      {task.status.replace('_', ' ')}
                    </span>
                    {task.dueDate ? <div style={{ marginTop: 6 }}>{relative(task.dueDate)}</div> : null}
                  </div>
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
        </div>

        <div>
          <h2>Latest briefings</h2>
          {briefings.length === 0 ? (
            <div className="empty">
              After a meeting, your agent writes you a briefing here — you never read a transcript
              unless you want to.
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
      </div>
    </>
  );
}
