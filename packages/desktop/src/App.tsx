import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { isDirect } from '@ai-coworker/shared';

import ChannelSidebar, { WorkspaceMenu, type Section } from './components/ChannelSidebar.js';
import Onboarding from './components/Onboarding.js';
import QuickSwitcher from './components/QuickSwitcher.js';
import WorkspaceRail from './components/WorkspaceRail.js';
import {
  AddWorkspaceDialog,
  ChannelBrowser,
  ChannelDetailsDialog,
  CreateChannelDialog,
  InviteDialog,
  MembersDialog,
  NewDirectMessageDialog,
  ProfileCard,
  ShortcutsDialog,
  StatusDialog,
  WorkspaceProfileDialog,
  WorkspaceSettingsDialog,
} from './components/dialogs.js';
import { api, emptyState, type AppState } from './lib/api.js';
import Activity from './views/Activity.js';
import AgentChat from './views/AgentChat.js';
import Chat from './views/Chat.js';
import Knowledge from './views/Knowledge.js';
import MeetingView from './views/MeetingView.js';
import People from './views/People.js';
import SearchPanel from './views/SearchPanel.js';
import Settings from './views/Settings.js';
import Sources from './views/Sources.js';
import Today from './views/Today.js';

type Dialog =
  | { kind: 'none' }
  | { kind: 'add-workspace' }
  | { kind: 'workspace-settings' }
  | { kind: 'invite' }
  | { kind: 'members' }
  | { kind: 'workspace-profile' }
  | { kind: 'create-channel' }
  | { kind: 'browse-channels' }
  | { kind: 'channel-details'; channelId: string }
  | { kind: 'new-dm' }
  | { kind: 'status' }
  | { kind: 'shortcuts' }
  | { kind: 'profile'; address: string };

export default function App() {
  const [state, setState] = useState<AppState>(emptyState);
  const [section, setSection] = useState<Section>('chat');
  const [openMeetingId, setOpenMeetingId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' });
  const [switcher, setSwitcher] = useState(false);
  const [wsMenu, setWsMenu] = useState(false);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let active = true;
    void api.getState().then((initial) => {
      if (!active) return;
      setState(initial);
      setLoaded(true);
    });
    const offState = api.onState((next) => setState(next));
    const offOpen = api.onOpenChannel(({ workspaceId, channelId }) => {
      void api.openChannel(workspaceId, channelId);
      setSection('chat');
      setSearching(false);
    });
    return () => {
      active = false;
      offState();
      offOpen();
    };
  }, []);

  const workspace = useMemo(
    () => state.workspaces.find((w) => w.workspace.id === state.activeWorkspaceId),
    [state.workspaces, state.activeWorkspaceId],
  );

  // A meeting that goes live is the one thing that should pull focus.
  const liveId = state.live[0]?.meeting.id ?? null;
  useEffect(() => {
    if (liveId) {
      setOpenMeetingId(liveId);
      setSection('meetings');
    }
  }, [liveId]);

  const openChannel = useCallback(
    (workspaceId: string, channelId: string) => {
      void api.openChannel(workspaceId, channelId);
      setSection('chat');
      setSearching(false);
    },
    [],
  );

  const switchWorkspace = useCallback(
    (workspaceId: string) => {
      const target = state.workspaces.find((w) => w.workspace.id === workspaceId);
      if (!target) return;
      const first =
        target.channels.find((c) => c.joined && c.channel.isDefault) ??
        target.channels.find((c) => c.joined && !c.channel.archived);
      void api.openChannel(workspaceId, first?.channel.id ?? '');
      setSection('chat');
      setSearching(false);
    },
    [state.workspaces],
  );

  const messagePerson = useCallback(
    async (workspaceId: string, address: string) => {
      const target = state.workspaces.find((w) => w.workspace.id === workspaceId);
      const existing = target?.channels.find(
        (c) =>
          c.channel.kind === 'dm' &&
          c.channel.members.length === 2 &&
          c.channel.members.includes(address),
      );
      if (existing) {
        openChannel(workspaceId, existing.channel.id);
        return;
      }
      await api.openDirectMessage(workspaceId, [address]);
      setSection('chat');
    },
    [state.workspaces, openChannel],
  );

  // Creating or joining a workspace should land you in it, the way Slack does.
  // The new one arrives over the socket, so watch for an id we have not seen.
  const knownWorkspaces = useRef<string[] | null>(null);
  useEffect(() => {
    const ids = state.workspaces.map((w) => w.workspace.id);
    const previous = knownWorkspaces.current;
    knownWorkspaces.current = ids;
    if (!previous) return;
    const fresh = ids.find((id) => !previous.includes(id));
    if (fresh) switchWorkspace(fresh);
  }, [state.workspaces, switchWorkspace]);

  // A newly opened DM arrives asynchronously; jump to it once it lands.
  const [pendingDm, setPendingDm] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingDm || !workspace) return;
    const dm = workspace.channels.find(
      (c) => c.channel.kind === 'dm' && c.channel.members.includes(pendingDm),
    );
    if (dm) {
      setPendingDm(null);
      openChannel(workspace.workspace.id, dm.channel.id);
    }
  }, [pendingDm, workspace, openChannel]);

  // --- keyboard --------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const typing =
        e.target instanceof HTMLElement &&
        (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');

      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSwitcher(true);
        return;
      }
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearching(true);
        return;
      }
      if (mod && e.key === '/') {
        e.preventDefault();
        setDialog({ kind: 'shortcuts' });
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSection('activity');
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        setSection('threads');
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setDialog({ kind: 'new-dm' });
        return;
      }
      if (mod && e.key >= '1' && e.key <= '9') {
        const index = Number(e.key) - 1;
        const target = state.workspaces[index];
        if (target) {
          e.preventDefault();
          switchWorkspace(target.workspace.id);
        }
        return;
      }
      // ⌥⇧↑ / ⌥⇧↓ walk the unread channels, the way Slack does.
      if (e.altKey && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const unread = (workspace?.channels ?? []).filter((c) => c.joined && c.read.unread > 0);
        if (!unread.length) return;
        const current = unread.findIndex((c) => c.channel.id === state.activeChannelId);
        const next =
          e.key === 'ArrowDown'
            ? unread[(current + 1) % unread.length]
            : unread[(current - 1 + unread.length) % unread.length];
        if (next && workspace) openChannel(workspace.workspace.id, next.channel.id);
        return;
      }
      if (e.key === 'Escape' && !typing && workspace && state.activeChannelId) {
        void api.markRead(workspace.workspace.id, state.activeChannelId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.workspaces, state.activeChannelId, workspace, switchWorkspace, openChannel]);

  if (!loaded) {
    return (
      <div className="onboarding">
        <div className="subtitle">Starting your agent…</div>
      </div>
    );
  }

  if (!state.ready) {
    return <Onboarding state={state} />;
  }

  const closeDialog = () => setDialog({ kind: 'none' });

  return (
    <div className="app">
      <WorkspaceRail
        workspaces={state.workspaces}
        activeId={state.activeWorkspaceId}
        onSwitch={switchWorkspace}
        onAdd={() => setDialog({ kind: 'add-workspace' })}
      />

      <div className="sidebar-column">
        <ChannelSidebar
          state={state}
          workspace={workspace}
          section={section}
          onSection={setSection}
          onOpenChannel={(channelId) => workspace && openChannel(workspace.workspace.id, channelId)}
          onBrowseChannels={() => setDialog({ kind: 'browse-channels' })}
          onCreateChannel={() => setDialog({ kind: 'create-channel' })}
          onNewDm={() => setDialog({ kind: 'new-dm' })}
          onWorkspaceMenu={() => setWsMenu(true)}
          onStatus={() => setDialog({ kind: 'status' })}
          onSearch={() => setSearching(true)}
        />
        {wsMenu && workspace ? (
          <div className="ws-menu-anchor">
            <WorkspaceMenu
              workspace={workspace}
              onClose={() => setWsMenu(false)}
              onInvite={() => setDialog({ kind: 'invite' })}
              onMembers={() => setDialog({ kind: 'members' })}
              onProfile={() => setDialog({ kind: 'workspace-profile' })}
              onSettings={() => setDialog({ kind: 'workspace-settings' })}
              onLeave={() => void api.leaveWorkspace(workspace.workspace.id)}
              onAddWorkspace={() => setDialog({ kind: 'add-workspace' })}
            />
          </div>
        ) : null}
      </div>

      <main className="main">
        {searching && workspace ? (
          <SearchPanel
            state={state}
            workspace={workspace}
            onClose={() => setSearching(false)}
            onOpenChannel={(channelId) => openChannel(workspace.workspace.id, channelId)}
          />
        ) : section === 'chat' && workspace ? (
          <Chat
            state={state}
            workspace={workspace}
            onOpenChannel={(channelId) => openChannel(workspace.workspace.id, channelId)}
            onOpenMember={(address) => setDialog({ kind: 'profile', address })}
            onChannelDetails={() => setDialog({ kind: 'channel-details', channelId: state.activeChannelId })}
            onBookMeeting={() => setSection('people')}
          />
        ) : section === 'chat' ? (
          <div className="panel">
            <h1>No workspace yet</h1>
            <p className="subtitle">
              Create one, or join an existing one, and this is where the conversation happens.
            </p>
            <button className="primary" onClick={() => setDialog({ kind: 'add-workspace' })}>
              Add a workspace
            </button>
          </div>
        ) : section === 'activity' || section === 'threads' ? (
          <Activity
            state={state}
            workspace={workspace}
            mode={section}
            onOpenChannel={(workspaceId, channelId) => openChannel(workspaceId, channelId)}
            onOpenThread={(workspaceId, channelId, rootId) => {
              void api.openThread(workspaceId, channelId, rootId);
              setSection('chat');
            }}
          />
        ) : (
          <div className="panel scroll">
            {section === 'today' && (
              <Today
                state={state}
                onOpenMeeting={(id) => {
                  setOpenMeetingId(id);
                  setSection('meetings');
                }}
                onView={(key) => setSection(key as Section)}
              />
            )}
            {section === 'meetings' && (
              <MeetingView state={state} openMeetingId={openMeetingId} onOpenMeeting={setOpenMeetingId} />
            )}
            {section === 'knowledge' && <Knowledge state={state} />}
            {section === 'sources' && <Sources state={state} />}
            {section === 'people' && <People state={state} />}
            {section === 'agent' && <AgentChat state={state} />}
            {section === 'settings' && <Settings state={state} />}
          </div>
        )}
      </main>

      {switcher ? (
        <QuickSwitcher
          state={state}
          onClose={() => setSwitcher(false)}
          onOpenChannel={openChannel}
          onSwitchWorkspace={switchWorkspace}
          onMessagePerson={(workspaceId, address) => {
            setPendingDm(address);
            void messagePerson(workspaceId, address);
          }}
        />
      ) : null}

      {dialog.kind === 'add-workspace' ? (
        <AddWorkspaceDialog state={state} onClose={closeDialog} />
      ) : null}
      {dialog.kind === 'status' ? <StatusDialog state={state} onClose={closeDialog} /> : null}
      {dialog.kind === 'shortcuts' ? <ShortcutsDialog onClose={closeDialog} /> : null}
      {workspace && dialog.kind === 'workspace-settings' ? (
        <WorkspaceSettingsDialog workspace={workspace} onClose={closeDialog} />
      ) : null}
      {workspace && dialog.kind === 'invite' ? (
        <InviteDialog workspace={workspace} onClose={closeDialog} />
      ) : null}
      {workspace && dialog.kind === 'members' ? (
        <MembersDialog
          workspace={workspace}
          onClose={closeDialog}
          onMessage={(address) => {
            setPendingDm(address);
            void messagePerson(workspace.workspace.id, address);
          }}
        />
      ) : null}
      {workspace && dialog.kind === 'workspace-profile' ? (
        <WorkspaceProfileDialog workspace={workspace} onClose={closeDialog} />
      ) : null}
      {workspace && dialog.kind === 'create-channel' ? (
        <CreateChannelDialog
          workspace={workspace}
          onClose={closeDialog}
          onCreated={(name) => {
            // The channel arrives over the socket; open it the moment it does.
            const poll = setInterval(() => {
              const created = workspace.channels.find((c) => c.channel.name === name);
              if (created) {
                clearInterval(poll);
                openChannel(workspace.workspace.id, created.channel.id);
              }
            }, 120);
            setTimeout(() => clearInterval(poll), 4000);
          }}
        />
      ) : null}
      {workspace && dialog.kind === 'browse-channels' ? (
        <ChannelBrowser
          workspace={workspace}
          onClose={closeDialog}
          onOpen={(channelId) => openChannel(workspace.workspace.id, channelId)}
          onCreate={() => setDialog({ kind: 'create-channel' })}
        />
      ) : null}
      {workspace && dialog.kind === 'channel-details' && dialog.channelId ? (
        <ChannelDetailsDialog
          workspace={workspace}
          channelId={dialog.channelId}
          onClose={closeDialog}
          onLeft={() => {
            const next = workspace.channels.find(
              (c) => c.joined && c.channel.id !== dialog.channelId && !isDirect(c.channel),
            );
            if (next) openChannel(workspace.workspace.id, next.channel.id);
          }}
        />
      ) : null}
      {workspace && dialog.kind === 'new-dm' ? (
        <NewDirectMessageDialog workspace={workspace} onClose={closeDialog} />
      ) : null}
      {workspace && dialog.kind === 'profile' ? (
        <ProfileCard
          workspace={workspace}
          address={dialog.address}
          onClose={closeDialog}
          onMessage={(address) => {
            setPendingDm(address);
            void messagePerson(workspace.workspace.id, address);
          }}
        />
      ) : null}
    </div>
  );
}
