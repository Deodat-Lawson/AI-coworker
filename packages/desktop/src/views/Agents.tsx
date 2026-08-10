import { useState } from 'react';

import type { AppState } from '../lib/api.js';
import { Icon } from '../components/icons.js';
import { Avatar } from '../components/ui.js';

interface Props {
  state: AppState;
  /** Open the conversation with this person — the room their agent meets yours in. */
  onOpenConversation: (address: string) => void;
  onOpenProfile: (address: string) => void;
  onInvite: () => void;
}

/**
 * Every agent in this workspace.
 *
 * There is nothing to book from here. To have two agents meet you open the
 * conversation they share and press Meet — because that conversation is the
 * room, and the meeting belongs in it with everything else you have said to
 * each other.
 */
export default function Agents({ state, onOpenConversation, onOpenProfile, onInvite }: Props) {
  const workspace = state.workspaces.find((w) => w.workspace.id === state.activeWorkspaceId);
  const [query, setQuery] = useState('');

  const needle = query.trim().toLowerCase();
  const people = (workspace?.members ?? [])
    .filter((m) => m.address !== workspace?.me.address && !m.deactivated)
    .filter(
      (m) =>
        !needle ||
        m.displayName.toLowerCase().includes(needle) ||
        m.address.toLowerCase().includes(needle) ||
        m.title.toLowerCase().includes(needle) ||
        m.focusAreas.some((f) => f.toLowerCase().includes(needle)),
    )
    .sort((a, b) => Number(b.agentOnline) - Number(a.agentOnline) || a.displayName.localeCompare(b.displayName));

  return (
    <>
      <h1>People</h1>
      <p className="subtitle">
        Everyone in <strong>{workspace?.workspace.name ?? 'this workspace'}</strong>, and whether
        their agent is reachable. You talk to your agent; your agent talks to theirs.
      </p>

      <div className="row" style={{ marginBottom: 12 }}>
        <input
          placeholder="Search by name, title or what they own"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button style={{ flex: '0 0 auto' }} onClick={onInvite}>
          <Icon name="plus" size={14} /> Invite someone
        </button>
      </div>

      {people.length === 0 ? (
        <div className="empty">
          {needle
            ? 'Nobody here matches that.'
            : 'Nobody else is in this workspace yet. Invite somebody — or run another persona on this machine with npm run agent -- run --persona sarah.'}
        </div>
      ) : (
        people.map((person) => (
          <div className="card" key={person.address}>
            <div className="card-head">
              <div style={{ display: 'flex', gap: 10 }}>
                <Avatar
                  name={person.displayName}
                  address={person.address}
                  size={38}
                  presence={person.presence}
                  image={person.avatar}
                />
                <div>
                  <button className="card-title link" onClick={() => onOpenProfile(person.address)}>
                    {person.displayName}
                  </button>
                  <div className="card-sub">{person.title}</div>
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
              </div>
              <div className="card-meta">
                <span className={`tag ${person.agentOnline ? 'good' : ''}`}>
                  {person.agentOnline ? 'agent online' : 'agent offline'}
                </span>
                <div style={{ fontFamily: 'var(--mono)', marginTop: 6 }}>{person.address}</div>
                <div style={{ marginTop: 6 }}>{person.timezone}</div>
              </div>
            </div>
            <div style={{ marginTop: 10 }}>
              <button className="primary" onClick={() => onOpenConversation(person.address)}>
                <Icon name="envelope" size={14} /> Open the conversation
              </button>
              <span className="hint" style={{ marginLeft: 10 }}>
                Press <strong>Meet</strong> in there to have your agents sit down together.
              </span>
            </div>
          </div>
        ))
      )}
    </>
  );
}
