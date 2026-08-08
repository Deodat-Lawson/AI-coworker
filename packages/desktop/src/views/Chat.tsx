import { useEffect, useMemo, useState } from 'react';

import { isDirect } from '@ai-coworker/shared';

import Composer from '../components/Composer.js';
import MessageList, { type MeetingLens, type MessageListActions } from '../components/MessageList.js';
import type { MentionContext } from '../components/RichText.js';
import RichText from '../components/RichText.js';
import StartMeetingDialog from '../components/StartMeetingDialog.js';
import { Avatar } from '../components/ui.js';
import { api, unwrap, type AppState, type WorkspaceView } from '../lib/api.js';
import { nameOf, plural, timeOf } from '../lib/format.js';
import MeetingPanel from './MeetingPanel.js';

interface Props {
  state: AppState;
  workspace: WorkspaceView;
  onOpenChannel: (channelId: string) => void;
  onOpenMember: (address: string) => void;
  onChannelDetails: () => void;
  /** The meeting whose briefing is open beside the channel, if any. */
  openMeetingId: string | null;
  onOpenMeeting: (meetingId: string | null) => void;
}

/**
 * The channel view: header, messages, composer, and — beside them — either the
 * thread panel or a meeting's briefing.
 *
 * A meeting is not somewhere else in this app. It is a thread in a channel: one
 * row in the timeline, the agents' turns inside it, and the briefing your own
 * agent wrote for you in the panel next to it.
 */
export default function Chat({
  state,
  workspace,
  onOpenChannel,
  onOpenMember,
  onChannelDetails,
  openMeetingId,
  onOpenMeeting,
}: Props) {
  const view = workspace.channels.find((c) => c.channel.id === state.activeChannelId);
  const [error, setError] = useState<string | null>(null);
  const [showPinned, setShowPinned] = useState(false);
  const [booking, setBooking] = useState(false);

  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(id);
  }, [error]);

  const ctx = useMemo<MentionContext>(
    () => ({
      members: workspace.members,
      me: workspace.me.address,
      channels: workspace.channels.map((c) => ({ id: c.channel.id, name: c.channel.name })),
      onOpenChannel,
      onOpenMember,
    }),
    [workspace.members, workspace.channels, workspace.me.address, onOpenChannel, onOpenMember],
  );

  // What the app knows about every meeting it can see, so a meeting row in the
  // timeline can say whether it is live, booked, or already briefed.
  const meetingLenses = useMemo(() => {
    const map = new Map<string, MeetingLens>();
    for (const record of state.meetings) {
      map.set(record.meeting.id, {
        live: false,
        scheduled: record.meeting.status === 'scheduled',
        turns: record.transcript.filter((t) => t.kind !== 'moderator').length,
        participants: record.meeting.participants,
        hasBriefing: Boolean(record.outcome),
      });
    }
    for (const room of state.live) {
      map.set(room.meeting.id, {
        live: true,
        scheduled: false,
        turns: room.transcript.filter((t) => t.kind !== 'moderator').length,
        participants: room.meeting.participants,
        hasBriefing: false,
      });
    }
    return map;
  }, [state.meetings, state.live]);

  if (!view) {
    return (
      <div className="chat">
        <div className="chat-empty">
          <h2>Nothing open</h2>
          <p className="subtitle">Pick a channel on the left, or start a conversation.</p>
        </div>
      </div>
    );
  }

  const channel = view.channel;
  const guard = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /**
   * Open the room for a meeting — which is to say, go to its channel. The
   * meeting is a channel, so watching it is just reading one, full width, with
   * no second way to render a conversation.
   */
  const openRoom = (meetingId: string) => {
    const room = workspace.channels.find((c) => c.channel.meetingId === meetingId);
    if (room) {
      onOpenMeeting(null);
      onOpenChannel(room.channel.id);
      return;
    }
    // Older meetings ran before rooms were channels, or this one never got a
    // room of its own. The briefing still has everything your agent kept.
    onOpenMeeting(meetingId);
  };

  const actions: MessageListActions = {
    onReact: (messageId, emoji, on) =>
      void guard(() => unwrap(api.react(workspace.workspace.id, messageId, emoji, on))),
    onOpenThread: (rootId) =>
      void guard(() => unwrap(api.openThread(workspace.workspace.id, channel.id, rootId))),
    onEdit: (messageId, text) =>
      void guard(() => unwrap(api.editMessage(workspace.workspace.id, messageId, text))),
    onDelete: (messageId) => void guard(() => unwrap(api.deleteMessage(workspace.workspace.id, messageId))),
    onPin: (messageId, pinned) =>
      void guard(() => unwrap(api.pinMessage(workspace.workspace.id, messageId, pinned))),
    onOpenChannel,
    onOpenMember,
    onLoadOlder: () => void api.loadOlder(),
    onOpenMeeting,
  };

  // Rooms running in this channel right now. The banner is how you find out a
  // meeting started without your agent having to interrupt you — so it shows
  // both in the meeting's own channel and in the one it was booked from, which
  // is where the people who care are actually sitting.
  const liveHere = state.live.filter(
    (room) =>
      room.meeting.channelId === channel.id || room.meeting.originChannelId === channel.id,
  );
  const pinned = state.messages.filter((m) => channel.pinned.includes(m.id));
  // Browsing a public channel you have not joined: read freely, but say so
  // rather than pretending you are part of it.
  const previewing = !view.joined && !isDirect(channel) && !channel.archived;
  const others = channel.members.filter((a) => a !== workspace.me.address);

  const sidePanel = openMeetingId ? 'meeting' : state.thread ? 'thread' : null;

  return (
    <div className={`chat ${sidePanel ? 'with-thread' : ''}`}>
      <div className="chat-main">
        <header className="chat-head">
          <button className="chat-title" onClick={onChannelDetails}>
            {isDirect(channel) ? (
              <>
                {channel.kind === 'dm' && others[0] ? (
                  <Avatar
                    name={view.label}
                    address={others[0]}
                    size={22}
                    presence={view.presence}
                    square
                  />
                ) : (
                  <span className="chat-glyph">👥</span>
                )}
                {view.label}
              </>
            ) : (
              <>
                <span className="chat-glyph">{channel.kind === 'private' ? '🔒' : '#'}</span>
                {channel.name}
              </>
            )}
            {channel.archived ? <span className="tag small">archived</span> : null}
          </button>

          <div className="chat-head-meta">
            {channel.topic ? <span className="chat-topic">{channel.topic}</span> : null}
            {pinned.length ? (
              <button className="ghost" onClick={() => setShowPinned((v) => !v)}>
                📌 {pinned.length}
              </button>
            ) : null}
            <button className="ghost members-chip" onClick={onChannelDetails} title="Members">
              <span className="face-stack">
                {channel.members.slice(0, 3).map((address) => {
                  const member = workspace.members.find((m) => m.address === address);
                  return (
                    <Avatar
                      key={address}
                      name={member?.displayName ?? address}
                      address={address}
                      size={20}
                      square
                    />
                  );
                })}
              </span>
              {channel.members.length}
            </button>
            {channel.archived || !view.joined ? null : (
              <button
                className="ghost"
                onClick={() => setBooking(true)}
                title="Have the agents in this channel meet, here"
              >
                ◷ Meet
              </button>
            )}
          </div>
        </header>

        {liveHere.map((room) => (
          <div className="live-bar" key={room.meeting.id}>
            <span className="side-badge live">live</span>
            <span className="live-title">{room.meeting.title}</span>
            <span className="live-sub">
              {room.phase}
              {room.speaking ? ` · ${nameOf(room.speaking, state.directory)} has the floor` : ''}
              {room.thinking ? ' · your agent is composing a turn' : ''}
            </span>
            <button className="ghost" onClick={() => onOpenMeeting(room.meeting.id)}>
              Briefing
            </button>
            {room.meeting.channelId === channel.id ? null : (
              <button className="primary" onClick={() => openRoom(room.meeting.id)}>
                Watch the room
              </button>
            )}
          </div>
        ))}

        {showPinned && pinned.length ? (
          <div className="pinned-bar">
            {pinned.map((message) => (
              <div className="pinned-item" key={message.id}>
                <span className="pinned-author">
                  {workspace.members.find((m) => m.address === message.author)?.displayName ?? message.author}
                </span>
                <RichText text={message.text} ctx={ctx} />
                <span className="pinned-time">{timeOf(message.ts)}</span>
              </div>
            ))}
          </div>
        ) : null}

        <MessageList
          key={channel.id}
          messages={state.messages}
          members={workspace.members}
          me={workspace.me.address}
          ctx={ctx}
          actions={actions}
          lastReadTs={state.unreadFrom}
          historyComplete={state.historyComplete}
          meetings={meetingLenses}
          emptyState={<ChannelIntro view={view} workspace={workspace} />}
        />

        <div className="chat-foot">
          {view.typing.length ? (
            <div className="typing">
              <span className="thinking-dots" />
              {view.typing.length === 1
                ? `${view.typing[0]} is typing`
                : view.typing.length === 2
                  ? `${view.typing.join(' and ')} are typing`
                  : 'Several people are typing'}
            </div>
          ) : null}
          {error ? <div className="error-text">{error}</div> : null}
          {previewing ? (
            <div className="preview-bar">
              <div>
                <div className="preview-title">You are previewing #{channel.name}</div>
                <div className="preview-sub">
                  Join to post here and get notified about it.
                </div>
              </div>
              <button
                className="primary"
                onClick={() =>
                  void guard(() => unwrap(api.joinChannel(workspace.workspace.id, channel.id)))
                }
              >
                Join channel
              </button>
            </div>
          ) : (
          <Composer
            placeholder={
              channel.archived
                ? 'This channel is archived.'
                : isDirect(channel)
                  ? `Message ${view.label}`
                  : `Message #${channel.name}`
            }
            members={workspace.members}
            channels={workspace.channels.map((c) => c.channel)}
            me={workspace.me.address}
            draftKey={`${workspace.workspace.id}:${channel.id}`}
            disabled={channel.archived ? 'This channel is archived — reopen it to post.' : undefined}
            onTyping={() => void api.typing(workspace.workspace.id, channel.id)}
            onSend={(text) =>
              void guard(() =>
                unwrap(api.sendMessage({ workspaceId: workspace.workspace.id, channelId: channel.id, text })),
              )
            }
          />
          )}
        </div>
      </div>

      {sidePanel === 'meeting' && openMeetingId ? (
        <MeetingPanel
          state={state}
          meetingId={openMeetingId}
          onClose={() => onOpenMeeting(null)}
          onWatch={() => openRoom(openMeetingId)}
        />
      ) : sidePanel === 'thread' ? (
        <ThreadPanel
          state={state}
          workspace={workspace}
          ctx={ctx}
          actions={actions}
          meetings={meetingLenses}
          onError={setError}
        />
      ) : null}

      {booking ? (
        <StartMeetingDialog workspace={workspace} view={view} onClose={() => setBooking(false)} />
      ) : null}
    </div>
  );
}

function ChannelIntro({ view, workspace }: { view: WorkspaceView['channels'][number]; workspace: WorkspaceView }) {
  const channel = view.channel;
  if (isDirect(channel)) {
    return (
      <div className="chat-intro">
        <h2>{view.label}</h2>
        <p className="subtitle">
          This is the very beginning of your direct message history. Whatever is said here stays between
          the {plural(channel.members.length, 'person', 'people')} in it.
        </p>
      </div>
    );
  }
  return (
    <div className="chat-intro">
      <h2>
        {channel.kind === 'private' ? '🔒' : '#'}
        {channel.name}
      </h2>
      <p className="subtitle">
        {channel.purpose ||
          channel.topic ||
          `This is the start of #${channel.name} in ${workspace.workspace.name}.`}
      </p>
    </div>
  );
}

function ThreadPanel({
  state,
  workspace,
  ctx,
  actions,
  meetings,
  onError,
}: {
  state: AppState;
  workspace: WorkspaceView;
  ctx: MentionContext;
  actions: MessageListActions;
  meetings: Map<string, MeetingLens>;
  onError: (message: string) => void;
}) {
  const thread = state.thread!;
  const [alsoSend, setAlsoSend] = useState(false);
  const channel = workspace.channels.find((c) => c.channel.id === thread.channelId);
  const label = channel ? (isDirect(channel.channel) ? channel.label : `#${channel.channel.name}`) : '';
  // A meeting's thread is the meeting room. Say so, rather than calling the
  // room "Thread".
  const room = thread.root.meetingId ? meetings.get(thread.root.meetingId) : undefined;
  const meetingId = thread.root.meetingId;

  return (
    <aside className="thread-panel">
      <header className="chat-head">
        <div className="chat-title">
          {meetingId ? 'The room' : 'Thread'}
          {room?.live ? <span className="side-badge live">live</span> : null}
          <span className="chat-topic">{label}</span>
        </div>
        {meetingId ? (
          <button className="ghost" onClick={() => actions.onOpenMeeting?.(meetingId)}>
            {room?.hasBriefing ? 'Your briefing' : 'Details'}
          </button>
        ) : null}
        <button
          className="ghost"
          onClick={() => void api.openThread(workspace.workspace.id, thread.channelId, null)}
          aria-label="Close thread"
        >
          ✕
        </button>
      </header>

      <MessageList
        key={thread.root.id}
        messages={[thread.root, ...thread.replies]}
        members={workspace.members}
        me={workspace.me.address}
        ctx={ctx}
        actions={actions}
        lastReadTs={Number.MAX_SAFE_INTEGER}
        historyComplete
        inThread
        meetings={meetings}
      />

      <div className="chat-foot">
        <Composer
          placeholder={meetingId ? 'Say something about this meeting…' : 'Reply…'}
          members={workspace.members}
          channels={workspace.channels.map((c) => c.channel)}
          me={workspace.me.address}
          draftKey={`${workspace.workspace.id}:${thread.channelId}:${thread.root.id}`}
          onTyping={() => void api.typing(workspace.workspace.id, thread.channelId)}
          extra={
            <label className="check small">
              <input type="checkbox" checked={alsoSend} onChange={(e) => setAlsoSend(e.target.checked)} />
              Also send to {label}
            </label>
          }
          onSend={async (text) => {
            try {
              await unwrap(
                api.sendMessage({
                  workspaceId: workspace.workspace.id,
                  channelId: thread.channelId,
                  text,
                  threadRootId: thread.root.id,
                  alsoSendToChannel: alsoSend,
                }),
              );
            } catch (err) {
              onError((err as Error).message);
            }
          }}
        />
      </div>
    </aside>
  );
}
