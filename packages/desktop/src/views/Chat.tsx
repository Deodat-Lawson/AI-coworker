import { useEffect, useMemo, useState } from 'react';

import { isDirect } from '@ai-coworker/shared';

import Composer from '../components/Composer.js';
import MessageList, { type MessageListActions } from '../components/MessageList.js';
import type { MentionContext } from '../components/RichText.js';
import RichText from '../components/RichText.js';
import { Avatar } from '../components/ui.js';
import { api, unwrap, type AppState, type WorkspaceView } from '../lib/api.js';
import { plural, timeOf } from '../lib/format.js';

interface Props {
  state: AppState;
  workspace: WorkspaceView;
  onOpenChannel: (channelId: string) => void;
  onOpenMember: (address: string) => void;
  onChannelDetails: () => void;
  onBookMeeting: () => void;
}

/** The channel view: header, messages, composer, and the thread panel beside it. */
export default function Chat({
  state,
  workspace,
  onOpenChannel,
  onOpenMember,
  onChannelDetails,
  onBookMeeting,
}: Props) {
  const view = workspace.channels.find((c) => c.channel.id === state.activeChannelId);
  const [error, setError] = useState<string | null>(null);
  const [showPinned, setShowPinned] = useState(false);

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
  };

  const pinned = state.messages.filter((m) => channel.pinned.includes(m.id));
  // Browsing a public channel you have not joined: read freely, but say so
  // rather than pretending you are part of it.
  const previewing = !view.joined && !isDirect(channel) && !channel.archived;
  const others = channel.members.filter((a) => a !== workspace.me.address);

  return (
    <div className={`chat ${state.thread ? 'with-thread' : ''}`}>
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
            {isDirect(channel) || channel.archived ? null : (
              <button className="ghost" onClick={onBookMeeting} title="Have your agents meet about this">
                ◷ Meet
              </button>
            )}
          </div>
        </header>

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

      {state.thread ? (
        <ThreadPanel state={state} workspace={workspace} ctx={ctx} actions={actions} onError={setError} />
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
  onError,
}: {
  state: AppState;
  workspace: WorkspaceView;
  ctx: MentionContext;
  actions: MessageListActions;
  onError: (message: string) => void;
}) {
  const thread = state.thread!;
  const [alsoSend, setAlsoSend] = useState(false);
  const channel = workspace.channels.find((c) => c.channel.id === thread.channelId);
  const label = channel ? (isDirect(channel.channel) ? channel.label : `#${channel.channel.name}`) : '';

  return (
    <aside className="thread-panel">
      <header className="chat-head">
        <div className="chat-title">
          Thread
          <span className="chat-topic">{label}</span>
        </div>
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
      />

      <div className="chat-foot">
        <Composer
          placeholder="Reply…"
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
