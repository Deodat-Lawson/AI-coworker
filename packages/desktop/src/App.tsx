import { useCallback, useEffect, useState } from 'react';

import Onboarding from './components/Onboarding.js';
import Sidebar, { type ViewKey } from './components/Sidebar.js';
import { api, emptyState, type AppState } from './lib/api.js';
import AgentChat from './views/AgentChat.js';
import Knowledge from './views/Knowledge.js';
import MeetingView from './views/MeetingView.js';
import People from './views/People.js';
import Settings from './views/Settings.js';
import Today from './views/Today.js';

export default function App() {
  const [state, setState] = useState<AppState>(emptyState);
  const [view, setView] = useState<ViewKey>('today');
  const [openMeetingId, setOpenMeetingId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    void api.getState().then((initial) => {
      if (!active) return;
      setState(initial);
      setLoaded(true);
    });
    const off = api.onState((next) => setState(next));
    return () => {
      active = false;
      off();
    };
  }, []);

  // A meeting that goes live is the one thing that should pull focus.
  const liveId = state.live[0]?.meeting.id ?? null;
  useEffect(() => {
    if (liveId) {
      setOpenMeetingId(liveId);
      setView('meetings');
    }
  }, [liveId]);

  const openMeeting = useCallback((meetingId: string) => {
    setOpenMeetingId(meetingId);
    setView('meetings');
  }, []);

  if (!loaded) {
    return <div className="onboarding"><div className="subtitle">Starting your agent…</div></div>;
  }

  if (!state.ready) {
    return <Onboarding state={state} />;
  }

  return (
    <div className="app">
      <Sidebar state={state} view={view} onView={setView} />
      <main className="main">
        <div className="main-inner">
          {view === 'today' && <Today state={state} onOpenMeeting={openMeeting} onView={setView} />}
          {view === 'meetings' && (
            <MeetingView
              state={state}
              openMeetingId={openMeetingId}
              onOpenMeeting={setOpenMeetingId}
            />
          )}
          {view === 'knowledge' && <Knowledge state={state} />}
          {view === 'people' && <People state={state} />}
          {view === 'agent' && <AgentChat state={state} />}
          {view === 'settings' && <Settings state={state} />}
        </div>
      </main>
    </div>
  );
}
