import { useState } from 'react';

import { api, unwrap, type AppState } from '../lib/api.js';

interface Props {
  state: AppState;
}

export default function People({ state }: Props) {
  // Meetings happen inside a workspace, so the people you can book with are its
  // members — not everybody who happens to be connected to the relay.
  const workspace = state.workspaces.find((w) => w.workspace.id === state.activeWorkspaceId);
  const people = (workspace?.members ?? [])
    .filter((m) => m.address !== workspace?.me.address)
    .map((m) => ({
      address: m.address,
      displayName: m.displayName,
      title: m.title,
      team: '',
      role: 'ic' as const,
      bio: m.bio,
      focusAreas: m.focusAreas,
      timezone: m.timezone,
      online: m.agentOnline,
    }));

  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [kind, setKind] = useState<'standup' | 'one_on_one' | 'review' | 'planning' | 'sync'>('sync');
  const [duration, setDuration] = useState(30);
  const [urgency, setUrgency] = useState<'whenever' | 'this_week' | 'asap'>('this_week');
  const [agenda, setAgenda] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const toggle = (address: string) =>
    setSelected((prev) => (prev.includes(address) ? prev.filter((a) => a !== address) : [...prev, address]));

  async function book() {
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      await unwrap(
        api.requestMeeting({
          participants: selected,
          title: title.trim() || `Sync with ${selected.length} teammate(s)`,
          purpose: purpose.trim(),
          kind,
          durationMins: duration,
          urgency,
          workspaceId: workspace?.workspace.id,
          agenda: agenda
            .split('\n')
            .map((a) => a.trim())
            .filter(Boolean),
        }),
      );
      setSent(
        'Your agent asked theirs for time. The moment they agree on a slot it will appear under Meetings.',
      );
      setSelected([]);
      setPurpose('');
      setAgenda('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>People</h1>
      <p className="subtitle">
        Everyone in <strong>{workspace?.workspace.name ?? 'this workspace'}</strong>. You talk to your
        agent; your agent talks to theirs.
      </p>

      {people.length === 0 ? (
        <div className="empty">
          Nobody else is in this workspace yet. Invite somebody from the workspace menu — or run
          another persona on this machine with <code>npm run agent -- run --persona sarah</code>.
        </div>
      ) : (
        people.map((person) => (
          <div
            className={`card clickable ${selected.includes(person.address) ? '' : ''}`}
            key={person.address}
            onClick={() => toggle(person.address)}
            style={
              selected.includes(person.address)
                ? { borderColor: 'var(--accent)', background: 'rgba(110,168,254,0.07)' }
                : undefined
            }
          >
            <div className="card-head">
              <div>
                <div className="card-title">
                  {person.displayName}

                </div>
                <div className="card-sub">
                  {person.title}
                  {person.team ? ` · ${person.team}` : ''}
                </div>
                {person.bio ? <div className="card-sub">{person.bio}</div> : null}
                {person.focusAreas.length ? (
                  <div style={{ marginTop: 6 }}>
                    {person.focusAreas.map((f) => (
                      <span className="tag" key={f}>
                        {f}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="card-meta">
                <span className={`dot ${person.online ? 'online' : ''}`} style={{ display: 'inline-block' }} />{' '}
                {person.online ? 'online' : 'offline'}
                <div style={{ fontFamily: 'var(--mono)', marginTop: 6 }}>{person.address}</div>
                <div style={{ marginTop: 6 }}>{person.timezone}</div>
              </div>
            </div>
          </div>
        ))
      )}

      {selected.length > 0 ? (
        <>
          <h2>Book a meeting</h2>
          <div className="card">
            <p className="card-sub" style={{ marginTop: 0 }}>
              Your agent will ask{' '}
              {selected
                .map((a) => people.find((d) => d.address === a)?.displayName ?? a)
                .join(' and ')}
              's agent for a time that works for everyone, then attend for you.
            </p>
            <div className="field">
              <label>Title</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Weekly platform sync" />
            </div>
            <div className="field">
              <label>Purpose — this is what the agents will actually discuss</label>
              <textarea
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="Get status on the auth migration and decide whether the billing launch date moves."
              />
            </div>
            <div className="field">
              <label>Agenda (one per line, optional)</label>
              <textarea value={agenda} onChange={(e) => setAgenda(e.target.value)} />
            </div>
            <div className="row">
              <div className="field">
                <label>Kind</label>
                <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                  <option value="sync">sync</option>
                  <option value="standup">standup</option>
                  <option value="one_on_one">1:1</option>
                  <option value="review">review</option>
                  <option value="planning">planning</option>
                </select>
              </div>
              <div className="field">
                <label>Duration</label>
                <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                  {[15, 30, 45, 60].map((d) => (
                    <option key={d} value={d}>
                      {d} min
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>When</label>
                <select value={urgency} onChange={(e) => setUrgency(e.target.value as typeof urgency)}>
                  <option value="asap">as soon as possible</option>
                  <option value="this_week">this week</option>
                  <option value="whenever">whenever there's room</option>
                </select>
              </div>
            </div>
            <button className="primary" disabled={busy || !purpose.trim()} onClick={book}>
              {busy ? 'Asking…' : 'Ask their agent for a time'}
            </button>
            {error ? <div className="error-text">{error}</div> : null}
            {sent ? <p className="hint" style={{ color: 'var(--good)' }}>{sent}</p> : null}
          </div>
        </>
      ) : (
        <p className="hint">Select one or more people to book a meeting.</p>
      )}
    </>
  );
}
