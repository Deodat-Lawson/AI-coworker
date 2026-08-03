import { useState } from 'react';

import { api, unwrap, type AppState } from '../lib/api.js';
import { dateTimeOf } from '../lib/format.js';

interface Props {
  state: AppState;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function Settings({ state }: Props) {
  const profile = state.profile!;
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [title, setTitle] = useState(profile.title);
  const [team, setTeam] = useState(profile.team);
  const [bio, setBio] = useState(profile.bio);
  const [focus, setFocus] = useState(profile.focusAreas.join(', '));
  const [instructions, setInstructions] = useState(profile.agentInstructions);
  const [startHour, setStartHour] = useState(Math.floor(profile.workingHours.startMinute / 60));
  const [endHour, setEndHour] = useState(Math.floor(profile.workingHours.endMinute / 60));
  const [days, setDays] = useState<number[]>(profile.workingHours.days);
  const [relayUrl, setRelayUrl] = useState(state.connection.relayUrl);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(state.connection.model);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function saveProfile() {
    setError(null);
    try {
      await unwrap(
        api.saveProfile({
          displayName,
          title,
          team,
          bio,
          focusAreas: focus.split(',').map((f) => f.trim()).filter(Boolean),
          agentInstructions: instructions,
          workingHours: { days, startMinute: startHour * 60, endMinute: endHour * 60 },
        }),
      );
      setStatus('Saved.');
      setTimeout(() => setStatus(null), 2000);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <h1>Settings</h1>

      <h2>How your agent represents you</h2>
      <div className="card">
        <div className="row">
          <div className="field">
            <label>Name</label>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="field">
            <label>Agent address</label>
            <input readOnly value={profile.address} />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label>Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label>Team</label>
            <input value={team} onChange={(e) => setTeam(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label>Bio — how other agents understand your role</label>
          <textarea value={bio} onChange={(e) => setBio(e.target.value)} />
        </div>
        <div className="field">
          <label>Focus areas (comma separated) — other agents use this to route questions to you</label>
          <input value={focus} onChange={(e) => setFocus(e.target.value)} />
        </div>
        <div className="field">
          <label>Standing instructions to your agent</label>
          <textarea
            style={{ minHeight: 110 }}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Never commit me to more than two new items in a meeting. Push back on anything that adds scope before launch."
          />
          <p className="hint">
            Your agent follows these in every meeting. This is where you protect your own time.
          </p>
        </div>
        <button className="primary" onClick={saveProfile}>
          Save
        </button>
        {status ? <span style={{ marginLeft: 10, color: 'var(--good)' }}>{status}</span> : null}
        {error ? <div className="error-text">{error}</div> : null}
      </div>

      <h2>When you can be booked</h2>
      <div className="card">
        <p className="card-sub" style={{ marginTop: 0 }}>
          Other agents can only schedule you inside these hours. Urgent requests are the exception.
        </p>
        <div className="row">
          <div className="field">
            <label>From</label>
            <select value={startHour} onChange={(e) => setStartHour(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {h}:00
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Until</label>
            <select value={endHour} onChange={(e) => setEndHour(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {h}:00
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label>Days</label>
          <div>
            {DAY_LABELS.map((label, index) => (
              <button
                key={label}
                className={days.includes(index) ? 'primary' : ''}
                style={{ marginRight: 6 }}
                onClick={() =>
                  setDays((prev) =>
                    prev.includes(index) ? prev.filter((d) => d !== index) : [...prev, index].sort(),
                  )
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <button className="primary" onClick={saveProfile}>
          Save hours
        </button>
      </div>

      <h2>Calendar holds</h2>
      <div className="card">
        {state.calendar.length === 0 ? (
          <p className="card-sub" style={{ margin: 0 }}>
            Nothing held. Ask your agent to block focus time and other agents will schedule around it.
          </p>
        ) : (
          state.calendar.map((block) => (
            <div className="activity-line" key={block.id}>
              <span className="activity-time">{block.kind}</span>
              <span className="activity-text">
                {block.title} — {dateTimeOf(block.start)}
              </span>
              {!block.meetingId ? (
                <button className="ghost" onClick={() => void api.removeCalendarBlock(block.id)}>
                  remove
                </button>
              ) : null}
            </div>
          ))
        )}
      </div>

      <h2>Network</h2>
      <div className="card">
        <div className="field">
          <label>Relay address</label>
          <div className="row">
            <input value={relayUrl} onChange={(e) => setRelayUrl(e.target.value)} />
            <button style={{ flex: '0 0 auto' }} onClick={() => void api.setRelayUrl(relayUrl.trim())}>
              Connect
            </button>
          </div>
        </div>
        <p className="hint">
          Status: <strong>{state.connection.state}</strong>
          {state.connection.error ? ` — ${state.connection.error}` : ''}
        </p>
        <button onClick={() => void api.reconnect()}>Reconnect</button>
      </div>

      <h2>Brain</h2>
      <div className="card">
        <p style={{ marginTop: 0 }}>
          <span className={`tag ${state.connection.providerLive ? 'good' : 'warn'}`}>
            {state.connection.providerName}
          </span>{' '}
          {state.connection.providerReason}
          {state.connection.apiKeySource === 'environment' ? ' (key from your environment)' : ''}
        </p>
        <div className="field">
          <label>Gemini API key</label>
          <div className="row">
            <input
              type="password"
              value={apiKey}
              placeholder={
                state.connection.hasApiKey ? '•••••••• (a key is already set)' : 'Paste your Gemini API key'
              }
              onChange={(e) => setApiKey(e.target.value)}
            />
            <button
              style={{ flex: '0 0 auto' }}
              onClick={async () => {
                try {
                  await unwrap(api.setBrain({ apiKey: apiKey.trim(), model: model.trim() }));
                  setApiKey('');
                  setStatus('Brain updated.');
                  setTimeout(() => setStatus(null), 2000);
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              Save key
            </button>
            {state.connection.apiKeySource === 'settings' ? (
              <button
                style={{ flex: '0 0 auto' }}
                onClick={() => void api.setBrain({ apiKey: '', model: model.trim() })}
              >
                Clear
              </button>
            ) : null}
          </div>
          <p className="hint">
            Stored locally in this app's config. It never leaves your machine except in requests to
            Google. You can also set <code>GEMINI_API_KEY</code> in your environment or a{' '}
            <code>.env</code> file next to the app.
          </p>
        </div>
        <div className="field">
          <label>Model</label>
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gemini-flash-latest" />
        </div>
        {!state.connection.providerLive ? (
          <p className="hint">
            Everything works without a key, but the offline brain only handles simple phrasings and
            writes much blunter meeting turns.
          </p>
        ) : null}
      </div>

      <h2>Knowledge base</h2>
      <div className="card">
        <p className="card-sub" style={{ marginTop: 0 }}>
          <code>{state.knowledgeDir}</code>
        </p>
        <p className="hint">
          Notes are markdown files; projects, artifacts and tasks are one JSON file. Nothing is sent
          anywhere except what your agent chooses to say in a meeting.
        </p>
        <button onClick={() => void api.openKnowledgeDir()}>Open folder</button>
      </div>
    </>
  );
}
