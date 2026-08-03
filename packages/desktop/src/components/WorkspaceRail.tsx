import type { WorkspaceView } from '../../electron/ipc.js';
import { initials } from '../lib/format.js';

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
              {view.workspace.icon || initials(view.workspace.name)}
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
    </nav>
  );
}
