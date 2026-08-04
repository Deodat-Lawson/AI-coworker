import { api, type AppState } from '../lib/api.js';
import { dateTimeOf, nameOf, relative } from '../lib/format.js';

interface Props {
  state: AppState;
  meetingId: string;
  onClose: () => void;
  /** Open the room — which is this meeting's thread in the channel. */
  onWatch?: () => void;
}

/**
 * What your agent made of a meeting.
 *
 * The meeting itself is not here: it happened in the channel, and its turns are
 * the thread beside this panel. This is the asymmetric half — the briefing
 * written for you and nobody else, plus the controls for a meeting that has not
 * run yet.
 */
export default function MeetingPanel({ state, meetingId, onClose, onWatch }: Props) {
  const me = state.profile!.address;
  const live = state.live.find((l) => l.meeting.id === meetingId);
  const record = state.meetings.find((m) => m.meeting.id === meetingId);
  const meeting = live?.meeting ?? record?.meeting;

  if (!meeting) {
    return (
      <aside className="thread-panel">
        <header className="chat-head">
          <div className="chat-title">Meeting</div>
          <button className="ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="panel scroll">
          <div className="empty">
            That meeting is not on this machine. Your agent keeps its own record of the meetings it
            attended.
          </div>
        </div>
      </aside>
    );
  }

  const scheduled = meeting.status === 'scheduled';
  const happenedAt = record?.transcript[0]?.ts ?? meeting.start;
  const outcome = record?.outcome;
  const minutes = record?.minutes;

  return (
    <aside className="thread-panel">
      <header className="chat-head">
        <div className="chat-title">
          {meeting.title}
          {live ? <span className="side-badge live">live</span> : null}
        </div>
        <button className="ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      <div className="panel scroll">
        <div className="card">
          <div className="card-sub">{meeting.purpose}</div>
          <div className="card-sub" style={{ marginTop: 6 }}>
            {meeting.participants.map((p) => (p === me ? 'you' : nameOf(p, state.directory))).join(', ')}{' '}
            · {meeting.chair === me ? 'you chair' : `${nameOf(meeting.chair, state.directory)} chairs`}
          </div>
          <div className="card-meta" style={{ marginTop: 6 }}>
            {dateTimeOf(scheduled ? meeting.start : happenedAt)} ·{' '}
            {relative(scheduled ? meeting.start : happenedAt)}
            <span
              className={`tag ${meeting.status === 'completed' ? 'good' : scheduled ? 'accent' : 'bad'}`}
              style={{ marginLeft: 6 }}
            >
              {meeting.status}
            </span>
          </div>

          {live ? (
            <div className="card-meta" style={{ marginTop: 10 }}>
              Phase: <strong>{live.phase}</strong>
              {live.speaking ? ` · ${nameOf(live.speaking, state.directory)} has the floor` : ''}
              {live.thinking ? ' · your agent is composing a turn' : ''}
            </div>
          ) : null}

          <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {onWatch ? (
              <button onClick={onWatch}>{live ? 'Watch the room' : 'Open the room'}</button>
            ) : null}
            {scheduled ? (
              <>
                <button onClick={() => void api.startMeetingNow(meeting.id)}>Run it now</button>
                <button
                  className="danger"
                  onClick={() => void api.cancelMeeting(meeting.id, 'Cancelled by the organizer.')}
                >
                  Cancel
                </button>
              </>
            ) : null}
          </div>
        </div>

        {meeting.agenda.length ? (
          <>
            <h2>Agenda</h2>
            <div className="card">
              <ul className="checklist">
                {meeting.agenda.map((item) => (
                  <li key={item.id}>· {item.title}</li>
                ))}
              </ul>
            </div>
          </>
        ) : null}

        {outcome ? (
          <>
            <h2>Your briefing</h2>
            <div className="card">
              <div className="card-title">{outcome.headline}</div>
              <p style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{outcome.summary}</p>

              {outcome.myTasks.length ? (
                <>
                  <div className="card-meta" style={{ marginTop: 14, marginBottom: 4 }}>
                    WHAT YOU PICKED UP
                  </div>
                  {outcome.myTasks.map((t) => (
                    <div key={t.id} style={{ marginBottom: 8 }}>
                      <strong>{t.title}</strong>
                      <div className="card-sub">{t.detail}</div>
                      {t.acceptanceCriteria.length ? (
                        <ul className="checklist">
                          {t.acceptanceCriteria.map((c, i) => (
                            <li key={i}>· {c}</li>
                          ))}
                        </ul>
                      ) : null}
                      {t.negotiationNote ? (
                        <div className="card-sub" style={{ color: 'var(--warn)' }}>
                          {t.negotiationNote}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </>
              ) : null}

              {outcome.decisions.length ? (
                <>
                  <div className="card-meta" style={{ marginTop: 14, marginBottom: 4 }}>DECISIONS</div>
                  <ul className="checklist">
                    {outcome.decisions.map((d, i) => (
                      <li key={i}>· {d}</li>
                    ))}
                  </ul>
                </>
              ) : null}

              {outcome.myCommitments.length ? (
                <>
                  <div className="card-meta" style={{ marginTop: 14, marginBottom: 4 }}>
                    WHAT YOUR AGENT COMMITTED YOU TO
                  </div>
                  <ul className="checklist">
                    {outcome.myCommitments.map((c, i) => (
                      <li key={i}>· {c}</li>
                    ))}
                  </ul>
                </>
              ) : null}

              {outcome.openQuestionsForHuman.length ? (
                <>
                  <div
                    className="card-meta"
                    style={{ marginTop: 14, marginBottom: 4, color: 'var(--warn)' }}
                  >
                    NEEDS YOU
                  </div>
                  <ul className="checklist">
                    {outcome.openQuestionsForHuman.map((q, i) => (
                      <li key={i} style={{ color: 'var(--warn)' }}>
                        · {q}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          </>
        ) : live ? (
          <div className="empty">
            Your briefing is written when the meeting ends. Until then, the room is the thread beside
            this.
          </div>
        ) : null}

        {minutes ? (
          <>
            <h2>Minutes</h2>
            <div className="card">
              <p style={{ marginTop: 0 }}>{minutes.summary}</p>
              {minutes.risks.length ? (
                <>
                  <div className="card-meta">RISKS</div>
                  <ul className="checklist">
                    {minutes.risks.map((r, i) => (
                      <li key={i}>· {r}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              {minutes.followUps.length ? (
                <>
                  <div className="card-meta" style={{ marginTop: 10 }}>FOLLOW-UPS</div>
                  <ul className="checklist">
                    {minutes.followUps.map((f, i) => (
                      <li key={i}>· {f}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </aside>
  );
}
