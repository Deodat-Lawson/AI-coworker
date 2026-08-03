import { useEffect, useMemo, useRef, useState } from 'react';

import { handleFor, searchEmoji } from '@ai-coworker/shared';
import type { Channel, WorkspaceMember } from '@ai-coworker/shared';

import { api } from '../lib/api.js';
import { Avatar, EmojiPicker } from './ui.js';

interface Props {
  placeholder: string;
  members: WorkspaceMember[];
  channels: Channel[];
  me: string;
  /** Where the draft is stored, so switching channels never loses a sentence. */
  draftKey: string;
  disabled?: string;
  onSend: (text: string) => void;
  onTyping: () => void;
  /** Rendered on the right of the toolbar (e.g. "also send to channel"). */
  extra?: React.ReactNode;
}

type Suggestion =
  | { kind: 'member'; member: WorkspaceMember }
  | { kind: 'channel'; channel: Channel }
  | { kind: 'emoji'; code: string; char: string }
  | { kind: 'broadcast'; word: string; description: string };

const BROADCASTS: Suggestion[] = [
  { kind: 'broadcast', word: 'channel', description: 'Notify everyone in this channel' },
  { kind: 'broadcast', word: 'here', description: 'Notify everyone who is around' },
];

export default function Composer({
  placeholder,
  members,
  channels,
  me,
  draftKey,
  disabled,
  onSend,
  onTyping,
  extra,
}: Props) {
  const [text, setText] = useState('');
  const [picker, setPicker] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);
  const loadedFor = useRef('');

  // Restore whatever was half-written here last time.
  useEffect(() => {
    let live = true;
    loadedFor.current = draftKey;
    void api.getDrafts().then((result) => {
      if (!live || loadedFor.current !== draftKey) return;
      setText(result.ok ? (result.value[draftKey] ?? '') : '');
    });
    return () => {
      live = false;
    };
  }, [draftKey]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(320, el.scrollHeight)}px`;
  }, [text]);

  const token = useMemo(() => activeToken(text, area.current?.selectionStart ?? text.length), [text]);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!token) return [];
    const needle = token.word.toLowerCase();
    if (token.trigger === '@') {
      const people = members
        .filter((m) => m.address !== me && !m.deactivated)
        .filter(
          (m) =>
            !needle ||
            m.displayName.toLowerCase().includes(needle) ||
            handleFor(m.address).toLowerCase().startsWith(needle),
        )
        .slice(0, 6)
        .map((member): Suggestion => ({ kind: 'member', member }));
      const broadcasts = BROADCASTS.filter(
        (b) => b.kind === 'broadcast' && (!needle || b.word.startsWith(needle)),
      );
      return [...people, ...broadcasts].slice(0, 8);
    }
    if (token.trigger === '#') {
      return channels
        .filter((c) => c.kind === 'public' || c.kind === 'private')
        .filter((c) => !c.archived && (!needle || c.name.includes(needle)))
        .slice(0, 8)
        .map((channel): Suggestion => ({ kind: 'channel', channel }));
    }
    if (token.trigger === ':' && token.word.length >= 2) {
      return searchEmoji(token.word, 8).map((hit): Suggestion => ({ kind: 'emoji', ...hit }));
    }
    return [];
  }, [token, members, channels, me]);

  useEffect(() => setHighlight(0), [suggestions.length, token?.trigger, token?.word]);

  const update = (next: string) => {
    setText(next);
    void api.saveDraft(draftKey, next);
    const now = Date.now();
    // One typing ping every couple of seconds is plenty for the other end.
    if (next && now - lastTyping.current > 2000) {
      lastTyping.current = now;
      onTyping();
    }
  };

  const accept = (suggestion: Suggestion) => {
    if (!token) return;
    const replacement =
      suggestion.kind === 'member'
        ? `@${handleFor(suggestion.member.address)} `
        : suggestion.kind === 'channel'
          ? `#${suggestion.channel.name} `
          : suggestion.kind === 'emoji'
            ? `${suggestion.char} `
            : `@${suggestion.word} `;
    const next = text.slice(0, token.start) + replacement + text.slice(token.end);
    update(next);
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      const caret = token.start + replacement.length;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const send = () => {
    const value = text.trim();
    if (!value || disabled) return;
    onSend(value);
    setText('');
    void api.saveDraft(draftKey, '');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => (h + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        accept(suggestions[highlight]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // Dropping the trigger character closes the menu without losing text.
        update(`${text.slice(0, token!.start)}${text.slice(token!.start + 1)}`);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      send();
    }
  };

  const wrap = (before: string, after = before) => {
    const el = area.current;
    if (!el) return;
    const { selectionStart: from, selectionEnd: to } = el;
    const selected = text.slice(from, to) || 'text';
    const next = `${text.slice(0, from)}${before}${selected}${after}${text.slice(to)}`;
    update(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(from + before.length, from + before.length + selected.length);
    });
  };

  if (disabled) {
    return <div className="composer-disabled">{disabled}</div>;
  }

  return (
    <div className="composer-shell">
      {suggestions.length ? (
        <div className="autocomplete">
          {suggestions.map((suggestion, i) => (
            <button
              key={keyOf(suggestion)}
              className={`ac-row ${i === highlight ? 'active' : ''}`}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(suggestion);
              }}
            >
              {suggestion.kind === 'member' ? (
                <>
                  <Avatar
                    name={suggestion.member.displayName}
                    address={suggestion.member.address}
                    size={20}
                    square
                  />
                  <span className="ac-name">{suggestion.member.displayName}</span>
                  <span className="ac-hint">@{handleFor(suggestion.member.address)}</span>
                </>
              ) : suggestion.kind === 'channel' ? (
                <>
                  <span className="ac-icon">{suggestion.channel.kind === 'private' ? '🔒' : '#'}</span>
                  <span className="ac-name">{suggestion.channel.name}</span>
                  <span className="ac-hint">{suggestion.channel.topic}</span>
                </>
              ) : suggestion.kind === 'emoji' ? (
                <>
                  <span className="ac-icon">{suggestion.char}</span>
                  <span className="ac-name">:{suggestion.code}:</span>
                </>
              ) : (
                <>
                  <span className="ac-icon">@</span>
                  <span className="ac-name">@{suggestion.word}</span>
                  <span className="ac-hint">{suggestion.description}</span>
                </>
              )}
            </button>
          ))}
        </div>
      ) : null}

      <div className="composer-box">
        <textarea
          ref={area}
          value={text}
          placeholder={placeholder}
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
        />
        <div className="composer-bar">
          <div className="composer-tools">
            <button className="tool" title="Bold (⌘B)" onClick={() => wrap('**')}>
              <b>B</b>
            </button>
            <button className="tool" title="Italic (⌘I)" onClick={() => wrap('_')}>
              <i>I</i>
            </button>
            <button className="tool" title="Strikethrough" onClick={() => wrap('~~')}>
              <s>S</s>
            </button>
            <button className="tool" title="Code" onClick={() => wrap('`')}>
              {'</>'}
            </button>
            <button className="tool" title="Code block" onClick={() => wrap('```\n', '\n```')}>
              ▤
            </button>
            <button className="tool" title="Quote" onClick={() => update(`${text}${text ? '\n' : ''}> `)}>
              ❝
            </button>
            <span className="tool-sep" />
            <button className="tool" title="Emoji" onClick={() => setPicker(true)}>
              ☺
            </button>
            <button
              className="tool"
              title="Mention someone"
              onClick={() => {
                update(`${text}@`);
                area.current?.focus();
              }}
            >
              @
            </button>
            {picker ? (
              <EmojiPicker
                onClose={() => setPicker(false)}
                onPick={(emoji) => {
                  update(text + emoji);
                  setPicker(false);
                  area.current?.focus();
                }}
              />
            ) : null}
          </div>
          <div className="composer-right">
            {extra}
            <span className="composer-hint">Enter to send · Shift+Enter for a new line</span>
            <button className="primary" disabled={!text.trim()} onClick={send}>
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function keyOf(suggestion: Suggestion): string {
  switch (suggestion.kind) {
    case 'member':
      return `m:${suggestion.member.address}`;
    case 'channel':
      return `c:${suggestion.channel.id}`;
    case 'emoji':
      return `e:${suggestion.code}`;
    default:
      return `b:${suggestion.word}`;
  }
}

/**
 * The `@`, `#` or `:` token the caret is sitting in, if any. Triggers only fire
 * at a word boundary, so an email address never opens the mention menu.
 */
function activeToken(
  text: string,
  caret: number,
): { trigger: '@' | '#' | ':'; word: string; start: number; end: number } | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)([@#:])([\w.+-]*)$/.exec(before);
  if (!match) return null;
  const trigger = match[2] as '@' | '#' | ':';
  const word = match[3] ?? '';
  const start = before.length - word.length - 1;
  return { trigger, word, start, end: caret };
}
