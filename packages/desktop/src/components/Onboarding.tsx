import { useState } from 'react';

import { api, unwrap, type AppState } from '../lib/api.js';

interface Props {
  state: AppState;
}

export default function Onboarding({ state }: Props) {
  const [mode, setMode] = useState<'persona' | 'custom'>('persona');
  const [personaKey, setPersonaKey] = useState(state.personas[0]?.key ?? '');
  const [displayName, setDisplayName] = useState('');
  const [handle, setHandle] = useState('');
  const [domain, setDomain] = useState('local');
  const [title, setTitle] = useState('');
  const [team, setTeam] = useState('');
  const [role, setRole] = useState<'manager' | 'ic'>('ic');
  const [focus, setFocus] = useState('');
  const [relayUrl, setRelayUrl] = useState(state.connection.relayUrl || 'ws://localhost:8787');
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function chooseDir() {
    try {
      const dir = await unwrap(api.chooseWorkspaceDir());
      if (dir) setWorkspaceDir(dir);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.setup({
          mode,
          personaKey: mode === 'persona' ? personaKey : undefined,
          displayName: displayName.trim(),
          handle: handle.trim() || displayName.trim().split(/\s+/)[0],
          domain: domain.trim(),
          title: title.trim(),
          team: team.trim(),
          role,
          focusAreas: focus
            .split(',')
            .map((f) => f.trim())
            .filter(Boolean),
          workspaceDir: workspaceDir ?? undefined,
          relayUrl: relayUrl.trim(),
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    mode === 'persona' ? Boolean(personaKey) : displayName.trim().length > 1 && domain.trim().length > 0;

  return (
    <div className="onboarding">
      <div className="onboarding-inner">
        <h1>Set up your agent</h1>
        <p className="subtitle">
          Your agent runs on this machine, next to a knowledge base only you can see. It meets other
          people's agents on your behalf and reports back.
        </p>

        <div className="tabs">
          <button className={`tab ${mode === 'persona' ? 'active' : ''}`} onClick={() => setMode('persona')}>
            Use a demo persona
          </button>
          <button className={`tab ${mode === 'custom' ? 'active' : ''}`} onClick={() => setMode('custom')}>
            Set up as yourself
          </button>
        </div>

        {mode === 'persona' ? (
          <>
            <p className="subtitle">
              Each persona comes with a real knowledge base — projects, notes, PRs, blockers — so a
              meeting has something to actually be about. Run one per machine.
            </p>
            <div className="persona-grid">
              {state.personas.map((p) => (
                <button
                  key={p.key}
                  className={`persona ${personaKey === p.key ? 'selected' : ''}`}
                  onClick={() => setPersonaKey(p.key)}
                >
                  <div className="persona-name">{p.displayName}</div>
                  <div className="persona-title">{p.title}</div>
                  {p.role === 'manager' ? <span className="tag accent">chairs meetings</span> : null}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="row">
              <div className="field">
                <label>Your name</label>
                <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Ada Lovelace" />
              </div>
              <div className="field">
                <label>Role</label>
                <select value={role} onChange={(e) => setRole(e.target.value as 'manager' | 'ic')}>
                  <option value="ic">Individual contributor</option>
                  <option value="manager">Manager (chairs meetings)</option>
                </select>
              </div>
            </div>
            <div className="row">
              <div className="field">
                <label>Agent handle</label>
                <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="ada" />
              </div>
              <div className="field">
                <label>Network</label>
                <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="northwind" />
              </div>
            </div>
            <p className="hint">
              Your agent's address will be{' '}
              <code>
                {(handle || displayName.split(/\s+/)[0] || 'you').toLowerCase().replace(/[^a-z0-9]/g, '')}@
                {domain || 'local'}
              </code>
              . Other people's agents use it to reach yours.
            </p>
            <div className="row">
              <div className="field">
                <label>Title</label>
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Backend Engineer" />
              </div>
              <div className="field">
                <label>Team</label>
                <input value={team} onChange={(e) => setTeam(e.target.value)} placeholder="Platform" />
              </div>
            </div>
            <div className="field">
              <label>What you work on (comma separated)</label>
              <input value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="auth, sessions, API" />
              <p className="hint">Other agents use this to decide who to ask what.</p>
            </div>
          </>
        )}

        <h2>Network</h2>
        <div className="field">
          <label>Relay address</label>
          <input value={relayUrl} onChange={(e) => setRelayUrl(e.target.value)} />
          <p className="hint">
            One relay runs per team. It routes agents and moderates meetings — it never sees your
            knowledge base. Start one with <code>npm run server</code>.
          </p>
        </div>

        <div className="field">
          <label>Knowledge base location</label>
          <div className="row">
            <input readOnly value={workspaceDir ?? 'Default app folder'} />
            <button style={{ flex: '0 0 auto' }} onClick={chooseDir}>
              Choose folder…
            </button>
          </div>
          <p className="hint">Notes are stored as plain markdown files you can open in any editor.</p>
        </div>

        <button className="primary" disabled={!canSubmit || busy} onClick={submit} style={{ marginTop: 8 }}>
          {busy ? 'Setting up…' : 'Start my agent'}
        </button>
        {error ? <div className="error-text">{error}</div> : null}
      </div>
    </div>
  );
}
