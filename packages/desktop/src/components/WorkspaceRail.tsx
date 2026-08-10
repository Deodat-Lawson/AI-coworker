import type { WorkspaceView } from '../../electron/ipc.js';
import { initials } from '../lib/format.js';

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

interface Props {
  workspaces: WorkspaceView[];
  activeId: string;
  onSwitch: (workspaceId: string) => void;
  onAdd: () => void;
}

/**
 * The far-left rail. One tile per workspace, in the order they were joined, so
 * ⌘1–⌘9 always mean the same thing. Unread shows as a dot; mentions as a count,
 * because "somebody said your name" deserves a number and general chatter does
 * not.
 */
export default function WorkspaceRail({ workspaces, activeId, onSwitch, onAdd }: Props) {
  if (workspaces.length === 0) {
    return (
      <nav className="rail">
        <button className="rail-add" onClick={onAdd} title="Add a workspace">
          +
        </button>
        <div className="rail-brand" title="Stead">
          <Mark />
        </div>
      </nav>
    );
  }

  return (
    <nav className="rail">
      {workspaces.map((view, index) => {
        const active = view.workspace.id === activeId;
        const shortcut = index < 9 ? `⌘${index + 1}` : '';
        return (
          <button
            key={view.workspace.id}
            className={`rail-tile ${active ? 'active' : ''}`}
            onClick={() => onSwitch(view.workspace.id)}
            title={`${view.workspace.name}${shortcut ? ` · ${shortcut}` : ''}`}
            aria-current={active}
          >
            <span className="rail-icon" style={{ borderColor: active ? view.workspace.color : undefined }}>
              {view.workspace.iconImage ? (
                <img className="rail-img" src={view.workspace.iconImage} alt="" />
              ) : (
                view.workspace.icon || initials(view.workspace.name)
              )}
            </span>
            {/* The agent that represents you here, drawn on its workspace. Two
                tiles side by side is the clearest statement the app can make
                that these are two different agents. */}
            <span
              className="rail-agent"
              style={{ background: view.agent.accent }}
              title={`${view.agent.name} · ${view.agent.autonomy === 'observer' ? 'watching only' : view.agent.autonomy === 'ask' ? 'asks first' : 'acts for you'}`}
            >
              {view.agent.emoji}
            </span>
            {view.mentions > 0 ? (
              <span className="rail-badge">{view.mentions > 99 ? '99+' : view.mentions}</span>
            ) : view.unread > 0 ? (
              <span className="rail-dot" />
            ) : null}
            {view.connection !== 'online' ? <span className="rail-offline" title="Reconnecting" /> : null}
          </button>
        );
      })}
      <button className="rail-add" onClick={onAdd} title="Add a workspace">
        +
      </button>
      <div className="rail-brand" title="Stead">
        <Mark />
      </div>
    </nav>
  );
}
