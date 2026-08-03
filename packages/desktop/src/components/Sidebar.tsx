import type { AppState } from '../lib/api.js';
import { initials } from '../lib/format.js';

export type ViewKey = 'today' | 'meetings' | 'knowledge' | 'sources' | 'people' | 'agent' | 'settings';

interface Props {
  state: AppState;
  view: ViewKey;
  onView: (view: ViewKey) => void;
}

/**
 * The Stead mark: a ring broken by a gap, with a bead standing in the gap — the
 * meeting, your absence, and the agent holding your place.
 *
 * Geometry is generated; it matches brand/mark.svg. Retune it in
 * scripts/build-icons.mjs and rebuild rather than editing these numbers.
 */
function Mark() {
  return (
    <svg className="mark" viewBox="-34.43 -34.43 68.86 68.86" aria-hidden="true">
      <path
        d="M 21.76 -7.7 A 24.5 24.5 0 1 0 21.76 7.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="8.4"
        strokeLinecap="round"
      />
      <circle cx="23" cy="0" r="7.2" fill="var(--accent)" />
    </svg>
  );
}

export default function Sidebar({ state, view, onView }: Props) {
  const openTasks = state.tasks.filter(
    (t) => t.assignee === state.profile?.address && t.status !== 'done' && t.status !== 'dropped',
  ).length;
  const upcoming = state.meetings.filter(
    (m) => m.meeting.status === 'scheduled' && m.meeting.end > Date.now(),
  ).length;
  const live = state.live.length;

  const items: { key: ViewKey; label: string; count?: number; accent?: boolean }[] = [
    { key: 'today', label: 'Today' },
    { key: 'meetings', label: 'Meetings', count: live || upcoming, accent: live > 0 },
    { key: 'knowledge', label: 'Knowledge' },
    { key: 'sources', label: 'Sources' },
    { key: 'people', label: 'People', count: state.directory.length },
    { key: 'agent', label: 'Your agent' },
    { key: 'settings', label: 'Settings' },
  ];

  const { connection } = state;
  const statusLabel =
    connection.state === 'online'
      ? `Connected · ${state.directory.length + 1} online`
      : connection.state === 'connecting'
        ? 'Connecting…'
        : connection.state === 'error'
          ? 'Connection failed'
          : 'Offline';

  return (
    <aside className="sidebar">
      <div className="brand">
        <Mark />
        <span>Stead</span>
      </div>
      <div className="me">
        <div className="avatar">{initials(state.profile?.displayName ?? '?')}</div>
        <div className="me-text">
          <div className="me-name">{state.profile?.displayName}</div>
          <div className="me-addr">{state.profile?.address}</div>
        </div>
      </div>

      {items.map((item) => (
        <button
          key={item.key}
          className={`nav-item ${view === item.key ? 'active' : ''}`}
          onClick={() => onView(item.key)}
        >
          <span>{item.label}</span>
          {item.count ? (
            <span className="nav-count" style={item.accent ? { color: 'var(--good)' } : undefined}>
              {item.accent ? 'live' : item.count}
            </span>
          ) : null}
          {item.key === 'today' && openTasks ? <span className="nav-count">{openTasks}</span> : null}
        </button>
      ))}

      <div className="sidebar-foot">
        <div className="status">
          <span className={`dot ${connection.state}`} />
          <span>{statusLabel}</span>
        </div>
        <div className="status" title={connection.providerReason}>
          <span className={`dot ${connection.providerLive ? 'online' : ''}`} />
          <span>{connection.providerLive ? 'Gemini' : 'Offline brain'}</span>
        </div>
      </div>
    </aside>
  );
}
