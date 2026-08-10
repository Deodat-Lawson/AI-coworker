import { useCallback, useMemo, useState } from 'react';

import {
  type SidebarChannel,
  type SidebarSection,
  isDirect,
  moveSection,
  newSection,
  normalizeSections,
  placeChannel,
  removeSection,
  resolveSections,
  statusIsLive,
  unfileChannel,
  updateSection,
} from '@ai-coworker/shared';

import { api, type AppState, type ChannelView, type WorkspaceView } from '../lib/api.js';
import { Icon, channelIcon, type IconName } from './icons.js';
import { Avatar, ContextMenu, MenuLabel, MenuRow, MenuSeparator, Popover } from './ui.js';

/**
 * The places you can be in this app. There are only six, and four of them are
 * conversations — that is the whole point. Meetings are not on this list
 * because a meeting is not a place: it happens in a channel, in a thread.
 */
export type Section =
  | 'chat'
  | 'activity'
  | 'threads'
  | 'agent'
  | 'agents'
  | 'knowledge'
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
  onChannelDetails: (channelId: string) => void;
}

/** What the pointer is currently dragging, and what it is hovering over. */
interface DragState {
  channelId: string;
  overSection: string | null;
  overIndex: number | null;
}

/**
 * The channel list — everything a person reaches for a hundred times a day.
 *
 * The order is the one Slack taught everyone to expect: workspace name, your
 * own status, the jump/activity strip, then the channels. What is new is that
 * *the person arranges it*: sections they name, channels they drag, an order
 * they chose. That layout is stored as a diff from the default (see
 * `resolveSections` in shared/sidebar.ts), so nothing is lost when a channel is
 * created tomorrow and nobody has filed it yet.
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
  onChannelDetails,
}: Props) {
  const [menu, setMenu] = useState<
    | { kind: 'channel'; channelId: string; x: number; y: number }
    | { kind: 'section'; sectionId: string; x: number; y: number }
    | null
  >(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const workspaceId = workspace?.workspace.id ?? '';
  const stored = workspace?.prefs.sections;
  const density = workspace?.prefs.density ?? 'comfortable';
  const unreadOnly = workspace?.prefs.unreadOnly ?? false;

  /** Persisting a layout is always "take the stored diff and change one bit". */
  const saveSections = useCallback(
    (next: SidebarSection[]) => {
      if (!workspaceId) return;
      void api.setWorkspacePrefs(workspaceId, { sections: next });
    },
    [workspaceId],
  );

  const rows = useMemo(() => {
    const map = new Map<string, ChannelView>();
    for (const view of workspace?.channels ?? []) map.set(view.channel.id, view);
    return map;
  }, [workspace?.channels]);

  /**
   * Two shapes of the same thing, and the difference matters.
   *
   * `layout` is what is *stored*: the diff from the default. Every edit is made
   * against this. `sections` is what is *drawn*: the diff resolved against
   * today's channels. Editing the resolved list instead would write every
   * channel's current position back as an explicit choice — so the first time
   * anybody collapsed a group, their whole sidebar would freeze and starring a
   * channel would stop moving it.
   */
  const layout = useMemo(() => normalizeSections(stored), [stored]);

  const sections = useMemo(() => {
    const visible = (workspace?.channels ?? []).filter(
      (c) => c.joined && (!c.channel.archived || Boolean(c.channel.meetingId)),
    );
    const sidebarChannels: SidebarChannel[] = visible.map((c) => ({
      id: c.channel.id,
      kind: c.channel.kind,
      starred: c.prefs.starred,
      isMeeting: Boolean(c.channel.meetingId),
      archived: c.channel.archived,
      lastMessageAt: c.channel.lastMessageAt || c.channel.createdAt,
      name: isDirect(c.channel) ? c.label : c.channel.name,
    }));
    return resolveSections(stored, sidebarChannels);
  }, [workspace?.channels, stored]);

  if (!workspace) {
    return (
      <aside className="sidebar">
        <div className="ws-head">
          <div className="ws-name">No workspace</div>
        </div>
        <div className="sidebar-empty">Join or create a workspace to start talking to people.</div>
      </aside>
    );
  }

  const mentions = state.activity.filter((a) => a.kind === 'mention').length;
  const threadCount = new Set(
    state.activity.filter((a) => a.kind === 'thread_reply').map((a) => a.message.threadRootId),
  ).size;
  const liveChannels = new Set(
    state.live.map((room) => room.meeting.channelId).filter((id): id is string => Boolean(id)),
  );

  const closeMenu = () => setMenu(null);

  const onDrop = (sectionId: string, index: number) => {
    if (!drag) return;
    saveSections(placeChannel(layout, drag.channelId, sectionId, index));
    setDrag(null);
  };

  const menuChannel = menu?.kind === 'channel' ? rows.get(menu.channelId) : undefined;
  const menuSection = menu?.kind === 'section' ? sections.find((s) => s.id === menu.sectionId) : undefined;

  return (
    <aside className={`sidebar density-${density}`}>
      <button className="ws-head" onClick={onWorkspaceMenu} title="Workspace menu">
        <div className="ws-name">
          <WorkspaceGlyph workspace={workspace} />
          <span className="ws-name-text">{workspace.workspace.name}</span>
          <Icon name="chevron-down" size={14} className="ws-caret" />
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
          image={workspace.me.avatar}
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
        <SideItem label="Search" icon="search" onClick={onSearch} hint="⌘F" />
        <SideItem
          label="Activity"
          icon="activity"
          active={section === 'activity'}
          count={mentions}
          onClick={() => onSection('activity')}
        />
        <SideItem
          label="Threads"
          icon="threads"
          active={section === 'threads'}
          count={threadCount}
          onClick={() => onSection('threads')}
        />
        <SideItem
          label={workspace.agent.name}
          icon="agent"
          active={section === 'agent'}
          onClick={() => onSection('agent')}
          accent={state.live.length > 0 ? 'live' : undefined}
        />
      </div>

      <div className="side-scroll" onDragEnd={() => setDrag(null)}>
        {sections.map((group) => (
          <SectionGroup
            key={group.id}
            group={group}
            rows={rows}
            state={state}
            section={section}
            liveChannels={liveChannels}
            unreadOnly={unreadOnly}
            drag={drag}
            renaming={renaming === group.id}
            onRenamed={(name) => {
              setRenaming(null);
              if (name) saveSections(updateSection(layout, group.id, { name }));
            }}
            onToggle={() => saveSections(updateSection(layout, group.id, { collapsed: !group.collapsed }))}
            onOpenChannel={onOpenChannel}
            onChannelMenu={(channelId, x, y) => setMenu({ kind: 'channel', channelId, x, y })}
            onSectionMenu={(x, y) => setMenu({ kind: 'section', sectionId: group.id, x, y })}
            onDragChannel={(channelId) => setDrag({ channelId, overSection: null, overIndex: null })}
            onDragOver={(overIndex) =>
              setDrag((prev) => (prev ? { ...prev, overSection: group.id, overIndex } : prev))
            }
            onDrop={(index) => onDrop(group.id, index)}
            onAdd={
              group.builtin === 'dms'
                ? onNewDm
                : group.builtin === 'channels'
                  ? onBrowseChannels
                  : undefined
            }
          />
        ))}

        <button className="side-row muted new-section" onClick={() => {
          const created = newSection({ name: 'New section' });
          saveSections([...layout, created]);
          setRenaming(created.id);
        }}>
          <Icon name="plus" size={15} className="side-icon" />
          <span className="side-label">New section</span>
        </button>
      </div>

      <div className="side-foot">
        <SideItem
          label="People"
          icon="people"
          active={section === 'agents'}
          onClick={() => onSection('agents')}
        />
        <SideItem
          label="Knowledge"
          icon="knowledge"
          active={section === 'knowledge'}
          onClick={() => onSection('knowledge')}
        />
        <SideItem
          label="Settings"
          icon="settings"
          active={section === 'settings'}
          onClick={() => onSection('settings')}
          hint="⌘,"
        />
      </div>

      {menu && menuChannel ? (
        <ContextMenu x={menu.x} y={menu.y} onClose={closeMenu}>
          <ChannelMenu
            view={menuChannel}
            workspaceId={workspaceId}
            sections={sections}
            onClose={closeMenu}
            onDetails={() => onChannelDetails(menuChannel.channel.id)}
            onMove={(sectionId) => saveSections(placeChannel(layout, menuChannel.channel.id, sectionId))}
            onUnfile={() => saveSections(unfileChannel(layout, menuChannel.channel.id))}
          />
        </ContextMenu>
      ) : null}

      {menu && menuSection ? (
        <ContextMenu x={menu.x} y={menu.y} onClose={closeMenu}>
          <MenuLabel>{menuSection.name}</MenuLabel>
          <MenuRow
            icon="edit"
            label="Rename section"
            onClick={() => {
              setRenaming(menuSection.id);
              closeMenu();
            }}
          />
          <MenuRow
            icon={menuSection.collapsed ? 'chevron-down' : 'chevron-right'}
            label={menuSection.collapsed ? 'Expand' : 'Collapse'}
            onClick={() => {
              saveSections(updateSection(layout, menuSection.id, { collapsed: !menuSection.collapsed }));
              closeMenu();
            }}
          />
          <MenuRow
            icon="bell-off"
            label="Show only unread"
            checked={menuSection.unreadOnly}
            onClick={() => {
              saveSections(updateSection(layout, menuSection.id, { unreadOnly: !menuSection.unreadOnly }));
              closeMenu();
            }}
          />
          <MenuSeparator />
          <MenuRow
            icon="chevron-up"
            label="Move up"
            onClick={() => {
              const at = layout.findIndex((s) => s.id === menuSection.id);
              saveSections(moveSection(layout, menuSection.id, Math.max(0, at - 1)));
              closeMenu();
            }}
          />
          <MenuRow
            icon="chevron-down"
            label="Move down"
            onClick={() => {
              const at = layout.findIndex((s) => s.id === menuSection.id);
              saveSections(moveSection(layout, menuSection.id, at + 1));
              closeMenu();
            }}
          />
          {!menuSection.builtin ? (
            <>
              <MenuSeparator />
              <MenuRow
                icon="trash"
                label="Delete section"
                danger
                onClick={() => {
                  saveSections(removeSection(layout, menuSection.id));
                  closeMenu();
                }}
              />
            </>
          ) : null}
        </ContextMenu>
      ) : null}
    </aside>
  );
}

/** The workspace's uploaded icon, its emoji, or its initial — in that order. */
function WorkspaceGlyph({ workspace }: { workspace: WorkspaceView }) {
  const w = workspace.workspace;
  if (w.iconImage) return <img className="ws-glyph-img" src={w.iconImage} alt="" />;
  return <span className="ws-glyph">{w.icon || w.name.slice(0, 1).toUpperCase()}</span>;
}

// ---------------------------------------------------------------------------
// One section
// ---------------------------------------------------------------------------

function SectionGroup({
  group,
  rows,
  state,
  section,
  liveChannels,
  unreadOnly,
  drag,
  renaming,
  onRenamed,
  onToggle,
  onOpenChannel,
  onChannelMenu,
  onSectionMenu,
  onDragChannel,
  onDragOver,
  onDrop,
  onAdd,
}: {
  group: SidebarSection;
  rows: Map<string, ChannelView>;
  state: AppState;
  section: Section;
  liveChannels: Set<string>;
  unreadOnly: boolean;
  drag: DragState | null;
  renaming: boolean;
  onRenamed: (name: string | null) => void;
  onToggle: () => void;
  onOpenChannel: (channelId: string) => void;
  onChannelMenu: (channelId: string, x: number, y: number) => void;
  onSectionMenu: (x: number, y: number) => void;
  onDragChannel: (channelId: string) => void;
  onDragOver: (index: number) => void;
  onDrop: (index: number) => void;
  onAdd?: () => void;
}) {
  const [draftName, setDraftName] = useState(group.name);

  const hideRead = unreadOnly || group.unreadOnly;
  const visible = group.channels
    .map((id) => rows.get(id))
    .filter((view): view is ChannelView => Boolean(view))
    .filter((view) => {
      if (!hideRead) return true;
      // The channel you are reading never vanishes out from under you.
      if (view.channel.id === state.activeChannelId) return true;
      return view.read.unread > 0;
    });

  // A dragged channel needs somewhere to land even when the group it is over is
  // empty or entirely read, so a group being dragged over always draws.
  const isDropTarget = drag?.overSection === group.id;
  if (!visible.length && !isDropTarget && group.builtin) return null;

  return (
    <div
      className={`side-group ${isDropTarget ? 'drop-target' : ''}`}
      onDragOver={(e) => {
        if (!drag) return;
        e.preventDefault();
        onDragOver(visible.length);
      }}
      onDrop={(e) => {
        if (!drag) return;
        e.preventDefault();
        onDrop(drag.overIndex ?? visible.length);
      }}
    >
      <div className="side-group-head" onContextMenu={(e) => {
        e.preventDefault();
        onSectionMenu(e.clientX, e.clientY);
      }}>
        {renaming ? (
          <input
            className="side-rename"
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={() => onRenamed(draftName.trim() || null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRenamed(draftName.trim() || null);
              if (e.key === 'Escape') onRenamed(null);
            }}
          />
        ) : (
          <button className="side-group-title" onClick={onToggle}>
            <Icon
              name={group.collapsed ? 'chevron-right' : 'chevron-down'}
              size={13}
              className="chevron"
            />
            <span className="side-group-emoji">{group.emoji}</span>
            {group.name}
            {group.collapsed && visible.length ? (
              <span className="side-group-count">{visible.length}</span>
            ) : null}
          </button>
        )}
        <div className="side-group-actions">
          {onAdd ? (
            <button className="side-group-action" title="Add" onClick={onAdd}>
              <Icon name="plus" size={14} />
            </button>
          ) : null}
          <button
            className="side-group-action"
            title="Section options"
            onClick={(e) => onSectionMenu(e.clientX, e.clientY)}
          >
            <Icon name="more" size={14} />
          </button>
        </div>
      </div>

      {group.collapsed
        ? null
        : visible.map((view, i) => (
            <ChannelRow
              key={view.channel.id}
              view={view}
              active={section === 'chat' && view.channel.id === state.activeChannelId}
              live={liveChannels.has(view.channel.id)}
              done={view.channel.archived}
              dragging={drag?.channelId === view.channel.id}
              dropBefore={isDropTarget && drag?.overIndex === i}
              onClick={() => onOpenChannel(view.channel.id)}
              onMenu={(x, y) => onChannelMenu(view.channel.id, x, y)}
              onDragStart={() => onDragChannel(view.channel.id)}
              onDragOver={() => onDragOver(i)}
            />
          ))}

      {!group.collapsed && !visible.length ? (
        <div className="side-empty">
          {group.builtin ? 'Nothing here yet.' : 'Drag channels in here.'}
        </div>
      ) : null}
    </div>
  );
}

function SideItem({
  label,
  icon,
  active,
  count,
  hint,
  accent,
  onClick,
}: {
  label: string;
  icon: IconName;
  active?: boolean;
  count?: number;
  hint?: string;
  accent?: string;
  onClick: () => void;
}) {
  return (
    <button className={`side-row ${active ? 'active' : ''}`} onClick={onClick}>
      <Icon name={icon} size={17} className="side-icon" />
      <span className="side-label">{label}</span>
      {accent ? <span className="side-badge live">{accent}</span> : null}
      {count && !accent ? <span className="side-badge">{count > 99 ? '99+' : count}</span> : null}
      {hint && !count && !accent ? <span className="side-hint">{hint}</span> : null}
    </button>
  );
}

function ChannelRow({
  view,
  active,
  live,
  done,
  dragging,
  dropBefore,
  onClick,
  onMenu,
  onDragStart,
  onDragOver,
}: {
  view: ChannelView;
  active: boolean;
  /** A meeting is running in this channel right now. */
  live?: boolean;
  /** A meeting that has finished: still readable, no longer happening. */
  done?: boolean;
  dragging?: boolean;
  dropBefore?: boolean;
  onClick: () => void;
  onMenu: (x: number, y: number) => void;
  onDragStart: () => void;
  onDragOver: () => void;
}) {
  const dm = isDirect(view.channel);
  const unread = view.read.unread > 0 && !active;
  const muted = view.prefs.muted;

  return (
    <button
      className={[
        'side-row',
        active ? 'active' : '',
        unread && !muted ? 'unread' : '',
        muted || done ? 'muted' : '',
        dragging ? 'dragging' : '',
        dropBefore ? 'drop-before' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', view.channel.id);
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver();
      }}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      title={
        live
          ? 'A meeting is happening in here'
          : done
            ? 'This meeting has finished'
            : view.channel.topic || view.label
      }
    >
      {dm ? (
        <span className="side-icon">
          <span className={`presence-dot ${view.presence ?? 'offline'}`} />
        </span>
      ) : (
        <Icon
          name={channelIcon(view.channel.kind, Boolean(view.channel.meetingId))}
          size={16}
          className="side-icon"
        />
      )}
      <span className="side-label">{dm ? view.label : view.channel.name}</span>
      {view.prefs.starred ? <Icon name="star-filled" size={11} className="side-star" /> : null}
      {live ? (
        <span className="side-badge live">live</span>
      ) : done ? (
        <Icon name="check" size={13} className="side-done" />
      ) : view.read.mentions > 0 ? (
        <span className="side-badge mention">
          {view.read.mentions > 99 ? '99+' : view.read.mentions}
        </span>
      ) : unread && muted ? (
        <span className="side-badge">{view.read.unread}</span>
      ) : null}
    </button>
  );
}

/** Right-clicking a channel: everything you can do to it, without leaving it. */
function ChannelMenu({
  view,
  workspaceId,
  sections,
  onClose,
  onDetails,
  onMove,
  onUnfile,
}: {
  view: ChannelView;
  workspaceId: string;
  sections: SidebarSection[];
  onClose: () => void;
  onDetails: () => void;
  onMove: (sectionId: string) => void;
  onUnfile: () => void;
}) {
  const [moving, setMoving] = useState(false);
  const id = view.channel.id;
  const act = (work: () => void) => {
    work();
    onClose();
  };

  if (moving) {
    return (
      <>
        <MenuLabel>Move to section</MenuLabel>
        {sections.map((s) => (
          <MenuRow key={s.id} label={`${s.emoji}  ${s.name}`} onClick={() => act(() => onMove(s.id))} />
        ))}
        <MenuSeparator />
        <MenuRow icon="refresh" label="Let it sort itself" onClick={() => act(onUnfile)} />
      </>
    );
  }

  return (
    <>
      <MenuLabel>{isDirect(view.channel) ? view.label : `#${view.channel.name}`}</MenuLabel>
      <MenuRow
        icon="check"
        label="Mark as read"
        onClick={() => act(() => void api.markRead(workspaceId, id))}
      />
      <MenuRow
        icon={view.prefs.starred ? 'star-filled' : 'star'}
        label={view.prefs.starred ? 'Remove star' : 'Star channel'}
        onClick={() => act(() => void api.setChannelPrefs(workspaceId, id, { starred: !view.prefs.starred }))}
      />
      <MenuRow
        icon={view.prefs.muted ? 'bell' : 'bell-off'}
        label={view.prefs.muted ? 'Unmute' : 'Mute channel'}
        onClick={() => act(() => void api.setChannelPrefs(workspaceId, id, { muted: !view.prefs.muted }))}
      />
      <MenuSeparator />
      <MenuRow icon="grip" label="Move to section…" onClick={() => setMoving(true)} />
      <MenuRow icon="info" label="Open channel details" onClick={() => act(onDetails)} />
      {!view.channel.isDefault ? (
        <>
          <MenuSeparator />
          <MenuRow
            icon="close"
            label={isDirect(view.channel) ? 'Close conversation' : 'Leave channel'}
            danger
            onClick={() => act(() => void api.leaveChannel(workspaceId, id))}
          />
        </>
      ) : null}
    </>
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
  onAgent,
  onLeave,
  onAddWorkspace,
}: {
  workspace: WorkspaceView;
  onClose: () => void;
  onInvite: () => void;
  onSettings: () => void;
  onMembers: () => void;
  onProfile: () => void;
  onAgent: () => void;
  onLeave: () => void;
  onAddWorkspace: () => void;
}) {
  const item = (icon: IconName, label: string, action: () => void, danger?: boolean) => (
    <MenuRow
      icon={icon}
      label={label}
      danger={danger}
      onClick={() => {
        action();
        onClose();
      }}
    />
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
        {item('agent', `${workspace.agent.name} — access`, onAgent)}
        <MenuSeparator />
        {item('people', 'Invite people', onInvite)}
        {item('shield', 'Manage members', onMembers)}
        {item('edit', 'Edit your profile here', onProfile)}
        <MenuSeparator />
        {item('settings', 'Workspace settings', onSettings)}
        {item('plus', 'Add another workspace', onAddWorkspace)}
        <MenuSeparator />
        {item('close', `Leave ${workspace.workspace.name}`, onLeave, true)}
      </div>
    </Popover>
  );
}
