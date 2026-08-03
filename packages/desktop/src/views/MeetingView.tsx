import { useEffect, useRef } from 'react';

import type { TranscriptEntry } from '@ai-coworker/shared';

import { api, type AppState } from '../lib/api.js';
import { dateTimeOf, nameOf, relative, timeOf } from '../lib/format.js';

interface Props {
  state: AppState;
  openMeetingId: string | null;
  onOpenMeeting: (id: string) => void;
}

export default function MeetingView({ state, openMeetingId, onOpenMeeting }: Props) {
  const meetings = [...state.meetings].sort((a, b) => b.meeting.start - a.meeting.start);
  // Default to the most recent meeting when nothing has been picked yet, and
  // resolve both the live room and the record from that same selection.
  const selected = openMeetingId ?? meetings[0]?.meeting.id ?? null;
  const live = state.live.find((l) => l.meeting.id === selected);
  const record = meetings.find((m) => m.meeting.id === selected);

  if (!meetings.length && !state.live.length) {
    return (
      <>
        <h1>Meetings</h1>
        <p className="subtitle">Nothing here yet.</p>
        <div className="empty">
          Go to People and ask your agent to book a meeting. The two agents will negotiate a time,
          meet without you, and each write their own human a briefing.
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Meetings</h1>
      <p className="subtitle">Everything your agent has attended or is about to attend.</p>

      <div className="tabs" style={{ flexWrap: 'wrap' }}>
        {meetings.map((m) => {
          const isLive = state.live.some((l) => l.meeting.id === m.meeting.id);
          return (
            <button
              key={m.meeting.id}
              className={`tab ${selected === m.meeting.id ? 'active' : ''}`}
              onClick={() => onOpenMeeting(m.meeting.id)}
            >
              {m.meeting.title}
              {isLive ? <span className="tag good" style={{ marginLeft: 6 }}>live</span> : null}
            </button>
          );
        })}
      </div>

      {live ? (
        <LiveRoom state={state} live={live} />
      ) : record ? (
        <PastMeeting state={state} record={record} />
      ) : null}
    </>
  );
}

function LiveRoom({ state, live }: { state: AppState; live: AppState['live'][number] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [live.transcript.length]);

  return (
    <>
      <div className="banner">
        <div>
          <div className="card-title">{live.meeting.title}</div>
          <div className="card-sub">
            {live.meeting.purpose}
          </div>
          <div className="card-meta" style={{ marginTop: 6 }}>
            Phase: <strong>{live.phase}</strong>
            {live.speaking ? ` · ${nameOf(live.speaking, state.directory)} has the floor` : ''}
            {live.thinking ? ' · your agent is composing a turn' : ''}
          </div>
        </div>
        <div>
          {live.present.map((p) => (
            <span className="tag" key={p}>
              {nameOf(p, state.directory)}
            </span>
          ))}
        </div>
      </div>

      <Transcript entries={live.transcript} state={state} />
      <div ref={endRef} />
    </>
  );
}

function PastMeeting({ state, record }: { state: AppState; record: AppState['meetings'][number] }) {
  const me = state.profile!.address;
  const { meeting, outcome, minutes, transcript } = record;
  const scheduled = meeting.status === 'scheduled';
  // A meeting run early ("run it now") kept its booked slot, so trust the
  // transcript for when it actually happened.
  const happenedAt = transcript[0]?.ts ?? meeting.start;

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">{meeting.title}</div>
            <div className="card-sub">{meeting.purpose}</div>
            <div className="card-sub">
              {meeting.participants
                .map((p) => (p === me ? 'you' : nameOf(p, state.directory)))
                .join(', ')}{' '}
              · {meeting.chair === me ? 'you chair' : `${nameOf(meeting.chair, state.directory)} chairs`}
            </div>
          </div>
          <div className="card-meta">
            {dateTimeOf(scheduled ? meeting.start : happenedAt)}
            <div>{relative(scheduled ? meeting.start : happenedAt)}</div>
            <span className={`tag ${meeting.status === 'completed' ? 'good' : scheduled ? 'accent' : 'bad'}`}>
              {meeting.status}
            </span>
          </div>
        </div>
        {scheduled ? (
          <div style={{ marginTop: 10 }}>
            <button onClick={() => void api.startMeetingNow(meeting.id)}>Run it now</button>{' '}
            <button className="danger" onClick={() => void api.cancelMeeting(meeting.id, 'Cancelled by the organizer.')}>
              Cancel
            </button>
          </div>
        ) : null}
      </div>

      {outcome ? (
        <>
          <h2>Your briefing</h2>
          <div className="card">
            <div className="card-title">{outcome.headline}</div>
                  <p style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{outcome.summary}</p>

            {outcome.myTasks.length ? (
              <>
                <div className="card-meta" style={{ marginTop: 14, marginBottom: 4 }}>WHAT YOU PICKED UP</div>
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
                      <div className="card-sub" style={{ color: 'var(--warn)' }}>{t.negotiationNote}</div>
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
                <div className="card-meta" style={{ marginTop: 14, marginBottom: 4 }}>WHAT YOUR AGENT COMMITTED YOU TO</div>
                <ul className="checklist">
                  {outcome.myCommitments.map((c, i) => (
                    <li key={i}>· {c}</li>
                  ))}
                </ul>
              </>
            ) : null}

            {outcome.openQuestionsForHuman.length ? (
              <>
                <div className="card-meta" style={{ marginTop: 14, marginBottom: 4, color: 'var(--warn)' }}>
                  NEEDS YOU
                </div>
                <ul className="checklist">
                  {outcome.openQuestionsForHuman.map((q, i) => (
                    <li key={i} style={{ color: 'var(--warn)' }}>· {q}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        </>
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

      {transcript.length ? (
        <>
          <h2>Full transcript</h2>
          <p className="subtitle">
            What the agents actually said to each other. You do not need to read this — that is the
            point — but it is here.
          </p>
          <Transcript entries={transcript} state={state} highlight={me} />
        </>
      ) : null}
    </>
  );
}

function Transcript({
  entries,
  state,
  highlight,
}: {
  entries: TranscriptEntry[];
  state: AppState;
  highlight?: string;
}) {
  return (
    <div className="transcript">
      {entries.map((entry) => {
        if (entry.kind === 'moderator') {
          return (
            <div className="turn moderator" key={entry.id}>
              <div className="turn-body">{entry.text}</div>
            </div>
          );
        }
        const isMe = entry.speaker === highlight;
        return (
          <div className={`turn ${entry.kind}`} key={entry.id}>
            <div className="turn-who">
              <span style={isMe ? { color: 'var(--accent)', fontWeight: 600 } : undefined}>
                {nameOf(entry.speaker, state.directory)}
                {isMe ? ' (you)' : ''}
              </span>
              <span className="kind">
                {entry.kind}
                {entry.to ? ` → ${nameOf(entry.to, state.directory).split(' ')[0]}` : ''}
              </span>
              <span className="kind">{timeOf(entry.ts)}</span>
            </div>
            <div className="turn-body">
              <div style={{ whiteSpace: 'pre-wrap' }}>{entry.text}</div>
              {entry.task ? (
                <ul className="checklist">
                  {entry.task.acceptanceCriteria.map((c, i) => (
                    <li key={i}>· {c}</li>
                  ))}
                </ul>
              ) : null}
              {entry.refs?.map((ref) => (
                <span className="artifact-chip" key={ref.artifactId} title={ref.summary}>
                  <span className="k">{ref.kind}</span>
                  {ref.url ? (
                    <a href={ref.url} target="_blank" rel="noreferrer">
                      {ref.title}
                    </a>
                  ) : (
                    <span>{ref.title}</span>
                  )}
                  {ref.stats && Object.keys(ref.stats).length ? (
                    <span style={{ color: 'var(--text-faint)' }}>
                      {Object.entries(ref.stats)
                        .slice(0, 3)
                        .map(([k, v]) => `${k} ${v}`)
                        .join(' · ')}
                    </span>
                  ) : null}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
