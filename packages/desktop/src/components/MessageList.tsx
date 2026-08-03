import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { ArtifactRef, Message, WorkspaceMember } from '@ai-coworker/shared';

import { dayLabel, plural, sameDay, timeOf } from '../lib/format.js';
import RichText, { type MentionContext } from './RichText.js';
import { Avatar, EmojiPicker, Popover, QuickReactions } from './ui.js';

/** Consecutive messages from one person inside this window share a header. */
const GROUP_WINDOW = 5 * 60_000;

export interface MessageListActions {
  onReact: (messageId: string, emoji: string, on: boolean) => void;
  onOpenThread: (rootId: string) => void;
  onEdit: (messageId: string, text: string) => void;
  onDelete: (messageId: string) => void;
  onPin: (messageId: string, pinned: boolean) => void;
  onOpenChannel?: (channelId: string) => void;
  onOpenMember?: (address: string) => void;
  onLoadOlder?: () => void;
}

interface Props {
  messages: Message[];
  members: WorkspaceMember[];
  me: string;
  ctx: MentionContext;
  actions: MessageListActions;
  /** Everything at or before this timestamp was already read. */
  lastReadTs: number;
  historyComplete: boolean;
  /** Replies live in the thread panel, which renders without the thread affordance. */
  inThread?: boolean;
  emptyState?: React.ReactNode;
}

export default function MessageList({
  messages,
  members,
  me,
  ctx,
  actions,
  lastReadTs,
  historyComplete,
  inThread,
  emptyState,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);

  // The unread divider is decided once per channel visit, so it does not leap
  // down the screen while you are reading.
  const [dividerTs] = useState(() => lastReadTs);
  const firstUnread = messages.find(
    (m) => m.ts > dividerTs && m.author !== me && m.kind === 'user' && !m.deletedAt,
  );

  const lastId = messages[messages.length - 1]?.id;
  useLayoutEffect(() => {
    if (!pinnedToBottom) return;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId, pinnedToBottom, messages.length]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinnedToBottom(distance < 80);
    if (el.scrollTop < 60 && !historyComplete) actions.onLoadOlder?.();
  };

  if (!messages.length) {
    return <div className="messages empty-scroll">{emptyState}</div>;
  }

  const rows: React.ReactNode[] = [];
  let previous: Message | undefined;

  for (const message of messages) {
    if (!previous || !sameDay(previous.ts, message.ts)) {
      rows.push(
        <div className="day-divider" key={`day-${message.id}`}>
          <span>{dayLabel(message.ts)}</span>
        </div>,
      );
      previous = undefined;
    }
    if (firstUnread && message.id === firstUnread.id) {
      rows.push(
        <div className="new-divider" key={`new-${message.id}`}>
          <span>New</span>
        </div>,
      );
      previous = undefined;
    }

    const grouped =
      previous !== undefined &&
      previous.author === message.author &&
      previous.kind === 'user' &&
      message.kind === 'user' &&
      message.ts - previous.ts < GROUP_WINDOW;

    rows.push(
      <MessageRow
        key={message.id}
        message={message}
        author={members.find((m) => m.address === message.author)}
        me={me}
        grouped={grouped}
        ctx={ctx}
        actions={actions}
        editing={editing === message.id}
        onEditing={(on) => setEditing(on ? message.id : null)}
        inThread={inThread}
        members={members}
      />,
    );
    previous = message;
  }

  return (
    <div className="messages" ref={scroller} onScroll={onScroll}>
      {historyComplete ? (
        <div className="history-start">This is the very beginning.</div>
      ) : (
        <button className="history-more" onClick={() => actions.onLoadOlder?.()}>
          Load earlier messages
        </button>
      )}
      <div className="msg-spacer" />
      {rows}
      {!pinnedToBottom ? (
        <button
          className="jump-latest"
          onClick={() => {
            const el = scroller.current;
            if (el) el.scrollTop = el.scrollHeight;
            setPinnedToBottom(true);
          }}
        >
          Jump to latest ↓
        </button>
      ) : null}
    </div>
  );
}

function MessageRow({
  message,
  author,
  members,
  me,
  grouped,
  ctx,
  actions,
  editing,
  onEditing,
  inThread,
}: {
  message: Message;
  author?: WorkspaceMember;
  members: WorkspaceMember[];
  me: string;
  grouped: boolean;
  ctx: MentionContext;
  actions: MessageListActions;
  editing: boolean;
  onEditing: (on: boolean) => void;
  inThread?: boolean;
}) {
  const [picker, setPicker] = useState(false);
  const [menu, setMenu] = useState(false);
  const [draft, setDraft] = useState(message.text);

  useEffect(() => setDraft(message.text), [message.text, editing]);

  const name = author?.displayName ?? message.author.split('@')[0]!;

  if (message.kind === 'system' || message.kind === 'meeting') {
    return (
      <div className={`msg system ${message.kind}`}>
        <span className="system-dot">{message.kind === 'meeting' ? '◷' : '·'}</span>
        <span className="system-text">
          {message.kind === 'meeting' ? (
            <RichText text={message.text} ctx={ctx} />
          ) : (
            systemPhrase(message, name, members)
          )}
        </span>
        <span className="msg-time">{timeOf(message.ts)}</span>
      </div>
    );
  }

  if (message.deletedAt) {
    return (
      <div className={`msg ${grouped ? 'grouped' : ''} deleted`}>
        <div className="msg-gutter">{grouped ? null : <Avatar name={name} address={message.author} size={36} />}</div>
        <div className="msg-body">
          {grouped ? null : (
            <div className="msg-head">
              <span className="msg-author">{name}</span>
              <span className="msg-time">{timeOf(message.ts)}</span>
            </div>
          )}
          <div className="msg-deleted">This message was deleted.</div>
        </div>
      </div>
    );
  }

  const mentionsMe = message.mentions.includes(me) || Boolean(message.broadcast);
  const mine = message.author === me;

  return (
    <div className={`msg ${grouped ? 'grouped' : ''} ${mentionsMe ? 'mentions-me' : ''}`}>
      <div className="msg-gutter">
        {grouped ? (
          <span className="msg-hover-time">{timeOf(message.ts)}</span>
        ) : (
          <Avatar name={name} address={message.author} size={36} presence={author?.presence} />
        )}
      </div>
      <div className="msg-body">
        {grouped ? null : (
          <div className="msg-head">
            <button className="msg-author" onClick={() => actions.onOpenMember?.(message.author)}>
              {name}
            </button>
            {author?.title ? <span className="msg-title">{author.title}</span> : null}
            {message.viaAgent ? <span className="tag accent small">agent</span> : null}
            <span className="msg-time">{timeOf(message.ts)}</span>
          </div>
        )}

        {editing ? (
          <div className="msg-edit">
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') onEditing(false);
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  actions.onEdit(message.id, draft);
                  onEditing(false);
                }
              }}
            />
            <div className="msg-edit-actions">
              <button className="ghost" onClick={() => onEditing(false)}>
                Cancel
              </button>
              <button
                className="primary"
                onClick={() => {
                  actions.onEdit(message.id, draft);
                  onEditing(false);
                }}
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <>
            <RichText text={message.text} ctx={ctx} />
            {message.editedAt ? <span className="msg-edited">(edited)</span> : null}
            {message.refs?.length ? <ArtifactChips refs={message.refs} /> : null}
          </>
        )}

        {message.reactions.length > 0 ? (
          <div className="reactions">
            {message.reactions.map((reaction) => {
              const on = reaction.by.includes(me);
              const who = reaction.by
                .map((a) => members.find((m) => m.address === a)?.displayName ?? a)
                .join(', ');
              return (
                <button
                  key={reaction.emoji}
                  className={`reaction ${on ? 'on' : ''}`}
                  title={`${who} reacted with ${reaction.emoji}`}
                  onClick={() => actions.onReact(message.id, reaction.emoji, !on)}
                >
                  <span>{reaction.emoji}</span>
                  <span className="reaction-count">{reaction.by.length}</span>
                </button>
              );
            })}
            <button className="reaction add" title="Add a reaction" onClick={() => setPicker(true)}>
              ＋
            </button>
            {picker ? (
              <EmojiPicker
                onClose={() => setPicker(false)}
                onPick={(emoji) => {
                  actions.onReact(message.id, emoji, true);
                  setPicker(false);
                }}
              />
            ) : null}
          </div>
        ) : null}

        {!inThread && message.replyCount > 0 ? (
          <button className="thread-link" onClick={() => actions.onOpenThread(message.id)}>
            <span className="thread-faces">
              {message.replyUsers.slice(0, 3).map((address) => {
                const who = members.find((m) => m.address === address);
                return (
                  <Avatar
                    key={address}
                    name={who?.displayName ?? address}
                    address={address}
                    size={18}
                    square
                  />
                );
              })}
            </span>
            {plural(message.replyCount, 'reply', 'replies')}
            {message.lastReplyAt ? (
              <span className="thread-when">Last reply {timeOf(message.lastReplyAt)}</span>
            ) : null}
          </button>
        ) : null}
      </div>

      {editing ? null : (
        <div className="hover-toolbar">
          <QuickReactions onPick={(emoji) => actions.onReact(message.id, emoji, true)} />
          <button className="hover-action" title="Add a reaction" onClick={() => setPicker(true)}>
            ☺
          </button>
          {inThread ? null : (
            <button
              className="hover-action"
              title="Reply in thread"
              onClick={() => actions.onOpenThread(message.id)}
            >
              ⤷
            </button>
          )}
          <button className="hover-action" title="More" onClick={() => setMenu(true)}>
            ⋯
          </button>
          {menu ? (
            <Popover onClose={() => setMenu(false)} align="right">
              <div className="menu">
                <button
                  className="menu-item"
                  onClick={() => {
                    actions.onPin(message.id, !message.pinnedAt);
                    setMenu(false);
                  }}
                >
                  {message.pinnedAt ? 'Unpin from channel' : 'Pin to channel'}
                </button>
                <button
                  className="menu-item"
                  onClick={() => {
                    void navigator.clipboard?.writeText(message.text);
                    setMenu(false);
                  }}
                >
                  Copy text
                </button>
                {mine ? (
                  <>
                    <div className="menu-sep" />
                    <button
                      className="menu-item"
                      onClick={() => {
                        onEditing(true);
                        setMenu(false);
                      }}
                    >
                      Edit message
                    </button>
                    <button
                      className="menu-item danger"
                      onClick={() => {
                        actions.onDelete(message.id);
                        setMenu(false);
                      }}
                    >
                      Delete message
                    </button>
                  </>
                ) : null}
              </div>
            </Popover>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ArtifactChips({ refs }: { refs: ArtifactRef[] }) {
  return (
    <div className="msg-refs">
      {refs.map((ref) => (
        <span className="artifact-chip" key={ref.artifactId}>
          <span className="k">{ref.kind}</span>
          {ref.url ? (
            <a href={ref.url} target="_blank" rel="noreferrer noopener">
              {ref.title}
            </a>
          ) : (
            <span>{ref.title}</span>
          )}
        </span>
      ))}
    </div>
  );
}

/** Phrase a system event the way a person would say it. */
function systemPhrase(message: Message, name: string, members: WorkspaceMember[]): string {
  const who = (address: string) =>
    members.find((m) => m.address === address)?.displayName ?? address.split('@')[0]!;
  const detail = message.systemDetail ?? '';
  switch (message.systemEvent) {
    case 'channel_created':
      return `${name} created #${detail}`;
    case 'member_joined':
      return `${name} joined`;
    case 'member_left':
      return `${name} left`;
    case 'member_added':
      return `${name} added ${who(detail)}`;
    case 'member_removed':
      return `${name} removed ${who(detail)}`;
    case 'topic_changed':
      return detail ? `${name} set the topic: ${detail}` : `${name} cleared the topic`;
    case 'purpose_changed':
      return detail ? `${name} set the purpose: ${detail}` : `${name} cleared the purpose`;
    case 'channel_renamed':
      return `${name} renamed the channel: ${detail}`;
    case 'channel_archived':
      return `${name} archived this channel`;
    case 'channel_unarchived':
      return `${name} reopened this channel`;
    default:
      return `${name} ${message.systemEvent?.replace(/_/g, ' ') ?? 'did something'}`;
  }
}
