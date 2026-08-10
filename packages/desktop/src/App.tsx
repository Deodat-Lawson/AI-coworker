import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { isDirect, nextAppearance } from '@ai-coworker/shared';

import ChannelSidebar, { WorkspaceMenu, type Section } from './components/ChannelSidebar.js';
import Onboarding from './components/Onboarding.js';
import SignUp from './components/SignUp.js';
import QuickSwitcher from './components/QuickSwitcher.js';
import WorkspaceRail from './components/WorkspaceRail.js';
import {
  AddWorkspaceDialog,
  ChannelBrowser,
  ChannelDetailsDialog,
  CreateChannelDialog,
  NewDirectMessageDialog,
  ProfileCard,
  ShortcutsDialog,
  StatusDialog,
} from './components/dialogs.js';
import { api, emptyState, type AppState } from './lib/api.js';
import { watchAppearance } from './lib/theme.js';
import Activity from './views/Activity.js';
import Agent from './views/Agent.js';
import Agents from './views/Agents.js';
import Chat from './views/Chat.js';
import Knowledge from './views/Knowledge.js';
import SearchPanel from './views/SearchPanel.js';
import Settings, { type SettingsPane } from './views/Settings.js';
import Tasks from './views/Tasks.js';

type Dialog =
  | { kind: 'none' }
  | { kind: 'add-workspace' }
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
  const [settingsPane, setSettingsPane] = useState<SettingsPane>('account');
  const [loaded, setLoaded] = useState(false);
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' });
  const [switcher, setSwitcher] = useState(false);
  const [wsMenu, setWsMenu] = useState(false);
  const [searching, setSearching] = useState(false);
  const [demoSetup, setDemoSetup] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

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
    // A task reminder that gets clicked should land on the task, not just on
    // the app.
    const offTask = api.onOpenTask(({ taskId }) => {
      setOpenTaskId(taskId);
      setSection('tasks');
      setSearching(false);
    });
    return () => {
      active = false;
      offState();
      offOpen();
      offTask();
    };
  }, []);

  // The theme follows the chosen appearance, and keeps following the machine
  // for as long as the choice is "system" — not just at startup.
  useEffect(() => watchAppearance(state.appearance), [state.appearance]);

  const workspace = useMemo(
    () => state.workspaces.find((w) => w.workspace.id === state.activeWorkspaceId),
    [state.workspaces, state.activeWorkspaceId],
  );

  const openChannel = useCallback(
    (workspaceId: string, channelId: string) => {
      void api.openChannel(workspaceId, channelId);
      setSection('chat');
      setSearching(false);
      // A briefing belongs to the channel its meeting happened in; walking away
      // from that channel should not leave it hanging beside a different one.
      setOpenMeetingId(null);
    },
    [],
  );

  /**
   * Go to a meeting. A meeting is not a place of its own — it is a channel — so
   * this opens that channel and puts the briefing beside it.
   */
  const openMeeting = useCallback(
    (meetingId: string | null) => {
      setOpenMeetingId(meetingId);
      if (!meetingId) return;
      const meeting =
        state.live.find((l) => l.meeting.id === meetingId)?.meeting ??
        state.meetings.find((m) => m.meeting.id === meetingId)?.meeting;
      if (!meeting) return;
      setSearching(false);
      setSection('chat');
      if (meeting.channelId && meeting.channelId !== state.activeChannelId) {
        void api.openChannel(meeting.workspaceId, meeting.channelId);
      }
    },
    [state.live, state.meetings, state.activeChannelId],
  );

  /**
   * Going somewhere closes the search. Search is a view over one workspace, not
   * a place you stay: leaving it for Activity and finding it still on top reads
   * as the click having done nothing.
   */
  const goToSection = useCallback((next: Section) => {
    setSection(next);
    setSearching(false);
  }, []);

  /** Every route into settings lands in the same place, on the right pane. */
  const openSettings = useCallback((pane: SettingsPane) => {
    setSettingsPane(pane);
    setSection('settings');
    setSearching(false);
  }, []);

  // A meeting that goes live is the one thing that should pull focus: it opens
  // the channel it is happening in.
  const liveId = state.live[0]?.meeting.id ?? null;
  useEffect(() => {
    if (liveId) openMeeting(liveId);
    // Deliberately keyed on the meeting alone — re-running as the transcript
    // grows would drag the reader back every time an agent speaks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveId]);

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
      setOpenMeetingId(null);
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

      // Not `⌘⇧K` — that is the to-do list, and without the guard the switcher
      // swallows it.
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSwitcher(true);
        return;
      }
      // The vault owns ⌘F while you are in it — that is its find-and-replace
      // bar, and swapping the whole editor out for workspace search mid-edit
      // is never what you meant.
      if (mod && e.key.toLowerCase() === 'f' && section !== 'knowledge') {
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
        goToSection('activity');
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        goToSection('threads');
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        goToSection('agent');
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        goToSection('tasks');
        return;
      }
      // ⌘⇧L cycles dark → light → match system. Stamping it here as well as in
      // the effect keeps the flip instant rather than waiting for the round trip
      // through the main process that persists it.
      if (mod && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        const next = nextAppearance(state.appearance);
        watchAppearance(next);
        void api.setAppearance(next);
        return;
      }
      // The vault owns ⌘, while you are in it — that is its own preferences.
      if (mod && e.key === ',' && section !== 'knowledge') {
        e.preventDefault();
        goToSection('settings');
        return;
      }
      // ⌘N is "new note" inside the vault, the way it is in Obsidian.
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'n' && section !== 'knowledge') {
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
  }, [
    state.workspaces,
    state.activeChannelId,
    state.appearance,
    workspace,
    switchWorkspace,
    openChannel,
    goToSection,
    section,
  ]);

  if (!loaded) {
    return (
      <div className="onboarding">
        <div className="subtitle">Starting your agent…</div>
      </div>
    );
  }

  if (!state.ready) {
    // Signing in is the front door; the demo personas are behind it, because a
    // persona is a thing you reach for deliberately rather than the first choice
    // somebody new is asked to make.
    return demoSetup ? (
      <Onboarding state={state} onBack={() => setDemoSetup(false)} />
    ) : (
      <SignUp state={state} onUseDemoPersona={() => setDemoSetup(true)} />
    );
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
          onSection={goToSection}
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
              onInvite={() => openSettings('members')}
              onMembers={() => openSettings('members')}
              onProfile={() => openSettings('account')}
              onSettings={() => openSettings('workspace')}
              onLeave={() => void api.leaveWorkspace(workspace.workspace.id)}
              onAddWorkspace={() => setDialog({ kind: 'add-workspace' })}
            />
          </div>
        ) : null}
      </div>

      <main
        className={
          section === 'knowledge' || section === 'settings' || section === 'tasks'
            ? 'main is-full'
            : 'main'
        }
      >
        {searching && workspace ? (
          <SearchPanel
            state={state}
            workspace={workspace}
            onClose={() => setSearching(false)}
            onOpenChannel={(channelId) => openChannel(workspace.workspace.id, channelId)}
          />
        ) : section === 'knowledge' ? (
          // The vault runs its own layout edge to edge; everything else sits in
          // the standard padded column.
          <Knowledge state={state} />
        ) : section === 'tasks' ? (
          // The to-do list belongs to you rather than to a workspace, so it does
          // not wait for one.
          <Tasks
            state={state}
            openTaskId={openTaskId}
            onTaskOpened={() => setOpenTaskId(null)}
            onOpenMeeting={openMeeting}
            onOpenChannel={openChannel}
          />
        ) : section === 'chat' && workspace ? (
          <Chat
            state={state}
            workspace={workspace}
            onOpenChannel={(channelId) => openChannel(workspace.workspace.id, channelId)}
            onOpenMember={(address) => setDialog({ kind: 'profile', address })}
            onChannelDetails={() => setDialog({ kind: 'channel-details', channelId: state.activeChannelId })}
            openMeetingId={openMeetingId}
            onOpenMeeting={openMeeting}
          />
        ) : section === 'agent' ? (
          <Agent state={state} onOpenMeeting={openMeeting} onOpenTasks={() => goToSection('tasks')} />
        ) : section === 'settings' ? (
          <Settings
            state={state}
            workspace={workspace}
            pane={settingsPane}
            onPane={setSettingsPane}
            onOpenChannel={(channelId) =>
              workspace && openChannel(workspace.workspace.id, channelId)
            }
            onMessage={(address) => {
              if (!workspace) return;
              setPendingDm(address);
              void messagePerson(workspace.workspace.id, address);
            }}
            onOpenKnowledge={() => goToSection('knowledge')}
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
            {section === 'agents' && (
              <Agents
                state={state}
                onOpenConversation={(address) => {
                  if (!workspace) return;
                  setPendingDm(address);
                  void messagePerson(workspace.workspace.id, address);
                }}
                onOpenProfile={(address) => setDialog({ kind: 'profile', address })}
                onInvite={() => openSettings('members')}
              />
            )}
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
