import { useState } from 'react';

import { isDirect, statusIsLive } from '@ai-coworker/shared';

import type { AppState, ChannelView, WorkspaceView } from '../lib/api.js';
import { Avatar, Popover } from './ui.js';

export type Section =
  | 'chat'
  | 'activity'
  | 'threads'
  | 'today'
  | 'meetings'
  | 'knowledge'
  | 'sources'
  | 'people'
  | 'agent'
  | 'settings';

interface Props {
  state: AppState;
  workspace: WorkspaceView | undefined;
  section: Section;
  onSection: (section: Section) => void;
  onOpenChannel: (channelId: string) => void;
  onBrowseChannels: () => void;
  onCreateChannel: () => void;
  onNewDm: () => void;
  onWorkspaceMenu: () => void;
  onStatus: () => void;
  onSearch: () => void;
}

/**
 * The channel list. Everything a person reaches for a hundred times a day, in
 * the order Slack taught everyone to expect: workspace name, jump/search,
 * activity, then channels and direct messages.
 */
export default function ChannelSidebar({
  state,
  workspace,
  section,
  onSection,
  onOpenChannel,
  onBrowseChannels,
  onCreateChannel,
  onNewDm,
  onWorkspaceMenu,
  onStatus,
  onSearch,
}: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  if (!workspace) {
    return (
      <aside className="sidebar">
        <div className="ws-head">
          <div className="ws-name">No workspace</div>
        </div>
        <div className="sidebar-empty">
          Join or create a workspace to start talking to people.
        </div>
      </aside>
    );
  }

  const live = workspace.channels.filter((c) => !c.channel.archived);
  const joined = live.filter((c) => c.joined);
  const starred = joined.filter((c) => c.prefs.starred);
  const rooms = joined.filter((c) => !c.prefs.starred && !isDirect(c.channel));
  const dms = joined.filter((c) => !c.prefs.starred && isDirect(c.channel));
  const mentions = state.activity.filter((a) => a.kind === 'mention').length;
  const threadCount = new Set(
    state.activity.filter((a) => a.kind === 'thread_reply').map((a) => a.message.threadRootId),
  ).size;

  return (
    <aside className="sidebar">
      <button className="ws-head" onClick={onWorkspaceMenu} title="Workspace menu">
        <div className="ws-name">
          {workspace.workspace.name}
          <span className="ws-caret">▾</span>
        </div>
        <div className="ws-sub">
          <span className={`dot ${workspace.connection}`} />
          {workspace.connection === 'online'
            ? `${workspace.members.filter((m) => m.agentOnline).length} of ${workspace.members.length} online`
            : workspace.connection === 'connecting'
              ? 'Connecting…'
              : 'Offline'}
        </div>
      </button>

      <button className="you" onClick={onStatus} title="Set a status">
        <Avatar
          name={workspace.me.displayName}
          address={workspace.me.address}
          size={26}
          presence={state.presence}
        />
        <span className="you-text">
          {statusIsLive(state.status) ? (
            <>
              <span className="you-emoji">{state.status.emoji}</span>
              {state.status.text || 'Status set'}
            </>
          ) : (
            'What are you up to?'
          )}
        </span>
      </button>

      <div className="side-group">
        <SideItem
          label="Search"
          icon="⌕"
          onClick={onSearch}
          hint="⌘F"
        />
        <SideItem
          label="Activity"
          icon="✳"
          active={section === 'activity'}
          count={mentions}
          onClick={() => onSection('activity')}
        />
        <SideItem
          label="Threads"
          icon="❑"
          active={section === 'threads'}
          count={threadCount}
          onClick={() => onSection('threads')}
        />
      </div>

      <div className="side-scroll">
        {starred.length > 0 ? (
          <Group
            title="Starred"
            collapsed={collapsed.starred}
            onToggle={() => toggle('starred')}
          >
            {starred.map((c) => (
              <ChannelRow
                key={c.channel.id}
                view={c}
                active={section === 'chat' && c.channel.id === state.activeChannelId}
                onClick={() => onOpenChannel(c.channel.id)}
              />
            ))}
          </Group>
        ) : null}

        <Group
          title="Channels"
          collapsed={collapsed.channels}
          onToggle={() => toggle('channels')}
          action={{ label: 'Browse or create a channel', onClick: onBrowseChannels }}
        >
          {rooms.map((c) => (
            <ChannelRow
              key={c.channel.id}
              view={c}
              active={section === 'chat' && c.channel.id === state.activeChannelId}
              onClick={() => onOpenChannel(c.channel.id)}
            />
          ))}
          <button className="side-row muted" onClick={onCreateChannel}>
            <span className="side-icon">+</span>
            <span className="side-label">Add channel</span>
          </button>
        </Group>

        <Group
          title="Direct messages"
          collapsed={collapsed.dms}
          onToggle={() => toggle('dms')}
          action={{ label: 'New message', onClick: onNewDm }}
        >
          {dms.map((c) => (
            <ChannelRow
              key={c.channel.id}
              view={c}
              active={section === 'chat' && c.channel.id === state.activeChannelId}
              onClick={() => onOpenChannel(c.channel.id)}
              dm
            />
          ))}
          {dms.length === 0 ? (
            <button className="side-row muted" onClick={onNewDm}>
              <span className="side-icon">+</span>
              <span className="side-label">Message someone</span>
            </button>
          ) : null}
        </Group>

        <Group title="Your agent" collapsed={collapsed.apps} onToggle={() => toggle('apps')}>
          <AppRow label="Today" active={section === 'today'} onClick={() => onSection('today')} />
          <AppRow
            label="Meetings"
            active={section === 'meetings'}
            onClick={() => onSection('meetings')}
            accent={state.live.length > 0 ? 'live' : undefined}
          />
          <AppRow label="Knowledge" active={section === 'knowledge'} onClick={() => onSection('knowledge')} />
          <AppRow label="Sources" active={section === 'sources'} onClick={() => onSection('sources')} />
          <AppRow label="People" active={section === 'people'} onClick={() => onSection('people')} />
          <AppRow label="Ask your agent" active={section === 'agent'} onClick={() => onSection('agent')} />
          <AppRow label="Settings" active={section === 'settings'} onClick={() => onSection('settings')} />
        </Group>
      </div>
    </aside>
  );
}

function Group({
  title,
  collapsed,
  onToggle,
  action,
  children,
}: {
  title: string;
  collapsed?: boolean;
  onToggle: () => void;
  action?: { label: string; onClick: () => void };
  children: React.ReactNode;
}) {
  return (
    <div className="side-group">
      <div className="side-group-head">
        <button className="side-group-title" onClick={onToggle}>
          <span className={`chevron ${collapsed ? 'closed' : ''}`}>▾</span>
          {title}
        </button>
        {action ? (
          <button className="side-group-action" title={action.label} onClick={action.onClick}>
            +
          </button>
        ) : null}
      </div>
      {collapsed ? null : children}
    </div>
  );
}

function SideItem({
  label,
  icon,
  active,
  count,
  hint,
  onClick,
}: {
  label: string;
  icon: string;
  active?: boolean;
  count?: number;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button className={`side-row ${active ? 'active' : ''}`} onClick={onClick}>
      <span className="side-icon">{icon}</span>
      <span className="side-label">{label}</span>
      {count ? <span className="side-badge">{count > 99 ? '99+' : count}</span> : null}
      {hint && !count ? <span className="side-hint">{hint}</span> : null}
    </button>
  );
}

function AppRow({
  label,
  active,
  accent,
  onClick,
}: {
  label: string;
  active?: boolean;
  accent?: string;
  onClick: () => void;
}) {
  return (
    <button className={`side-row ${active ? 'active' : ''}`} onClick={onClick}>
      <span className="side-icon dim">◆</span>
      <span className="side-label">{label}</span>
      {accent ? <span className="side-badge live">{accent}</span> : null}
    </button>
  );
}

function ChannelRow({
  view,
  active,
  dm,
  onClick,
}: {
  view: ChannelView;
  active: boolean;
  dm?: boolean;
  onClick: () => void;
}) {
  const unread = view.read.unread > 0 && !active;
  const muted = view.prefs.muted;
  return (
    <button
      className={`side-row ${active ? 'active' : ''} ${unread && !muted ? 'unread' : ''} ${muted ? 'muted' : ''}`}
      onClick={onClick}
      title={view.channel.topic || view.label}
    >
      <span className="side-icon">
        {dm ? (
          <span className={`presence-dot ${view.presence ?? 'offline'}`} />
        ) : view.channel.kind === 'private' ? (
          '🔒'
        ) : (
          '#'
        )}
      </span>
      <span className="side-label">{dm ? view.label : view.channel.name}</span>
      {view.read.mentions > 0 ? (
        <span className="side-badge mention">{view.read.mentions > 99 ? '99+' : view.read.mentions}</span>
      ) : unread && muted ? (
        <span className="side-badge">{view.read.unread}</span>
      ) : null}
    </button>
  );
}

/** The menu that drops out of the workspace name. */
export function WorkspaceMenu({
  workspace,
  onClose,
  onInvite,
  onSettings,
  onMembers,
  onProfile,
  onLeave,
  onAddWorkspace,
}: {
  workspace: WorkspaceView;
  onClose: () => void;
  onInvite: () => void;
  onSettings: () => void;
  onMembers: () => void;
  onProfile: () => void;
  onLeave: () => void;
  onAddWorkspace: () => void;
}) {
  const item = (label: string, action: () => void, hint?: string) => (
    <button
      className="menu-item"
      onClick={() => {
        action();
        onClose();
      }}
    >
      {label}
      {hint ? <span className="menu-hint">{hint}</span> : null}
    </button>
  );

  return (
    <Popover onClose={onClose}>
      <div className="menu">
        <div className="menu-head">
          <div className="menu-title">{workspace.workspace.name}</div>
          <div className="menu-sub">
            {workspace.members.length} member{workspace.members.length === 1 ? '' : 's'} ·{' '}
            {workspace.workspace.slug} · you are {workspace.me.role}
          </div>
        </div>
        {item('Invite people', onInvite)}
        {item('Manage members', onMembers)}
        {item('Edit your profile here', onProfile)}
        <div className="menu-sep" />
        {item('Workspace settings', onSettings)}
        {item('Add another workspace', onAddWorkspace)}
        <div className="menu-sep" />
        {item(`Leave ${workspace.workspace.name}`, onLeave)}
      </div>
    </Popover>
  );
}
