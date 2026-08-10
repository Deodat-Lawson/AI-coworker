import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';

import { dueLabel, parseQuickAdd, type QuickAddResult, type TaskList } from '@ai-coworker/shared';

import { ListDot } from './pickers.js';

export interface QuickAddHandle {
  focus(): void;
}

export interface QuickAddDraft extends QuickAddResult {
  raw: string;
}

/**
 * The add box.
 *
 * One line, and it understands what you type into it: "Pay rent tomorrow at 9am
 * p1 #Home @money" comes out as a task due at nine tomorrow, urgent, filed under
 * Home, labelled money — with only "Pay rent" left as the title. What it
 * understood is shown as chips underneath rather than guessed at silently, so a
 * date it read wrongly is visible before you press Enter.
 */
const QuickAdd = forwardRef<QuickAddHandle, {
  lists: TaskList[];
  labels: string[];
  /** The list a new task lands in when the text does not name one. */
  defaultListName?: string;
  /** The date a new task takes when the text does not name one. */
  defaultDue?: number;
  onAdd: (draft: QuickAddDraft) => void;
  placeholder?: string;
  autoFocus?: boolean;
  onDismiss?: () => void;
}>(function QuickAdd(
  { lists, labels, defaultListName, defaultDue, onAdd, placeholder, autoFocus, onDismiss },
  ref,
) {
  const [text, setText] = useState('');
  const [suggestAt, setSuggestAt] = useState<number | null>(null);
  const [highlight, setHighlight] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  const parsed = useMemo(() => parseQuickAdd(text), [text]);

  // The token being typed right now, when it is a `#list` or an `@label`.
  const trigger = useMemo(() => {
    const upto = text.slice(0, suggestAt ?? text.length);
    const match = /(^|\s)([#@])([\w-]*)$/.exec(upto);
    if (!match) return null;
    return {
      kind: match[2] as '#' | '@',
      query: match[3] ?? '',
      start: match.index + match[1]!.length,
    };
  }, [text, suggestAt]);

  const options = useMemo(() => {
    if (!trigger) return [];
    const needle = trigger.query.toLowerCase();
    const pool = trigger.kind === '#' ? lists.map((l) => l.name) : labels;
    const hits = pool.filter((name) => name.toLowerCase().includes(needle)).slice(0, 6);
    // Offer to make the thing you are typing, the way every tagger does.
    if (trigger.query && !pool.some((name) => name.toLowerCase() === needle)) hits.push(trigger.query);
    return hits;
  }, [trigger, lists, labels]);

  useEffect(() => setHighlight(0), [trigger?.query, trigger?.kind]);

  const applySuggestion = (name: string) => {
    if (!trigger) return;
    const quoted = /\s/.test(name) ? `"${name}"` : name;
    const next = `${text.slice(0, trigger.start)}${trigger.kind}${quoted} ${text.slice(
      suggestAt ?? text.length,
    )}`;
    setText(next);
    setSuggestAt(null);
    requestAnimationFrame(() => {
      const caret = trigger.start + trigger.kind.length + quoted.length + 1;
      input.current?.setSelectionRange(caret, caret);
      input.current?.focus();
    });
  };

  const submit = () => {
    if (!parsed.title.trim() && !text.trim()) return;
    onAdd({ ...parsed, raw: text, title: parsed.title.trim() || text.trim() });
    setText('');
    setSuggestAt(null);
    input.current?.focus();
  };

  const listChip = parsed.listName ?? defaultListName;
  const chips = parsed.chips.filter((chip) => chip.kind !== 'list');
  // Once what you have typed *is* the only option, the popup has nothing left
  // to offer and would only steal the Enter that meant "add this".
  const showing =
    Boolean(trigger && options.length) &&
    !(options.length === 1 && options[0]!.toLowerCase() === trigger!.query.toLowerCase());

  return (
    <div className="quick-add">
      <div className="quick-add-field">
        <span className="quick-add-plus" aria-hidden="true">
          ＋
        </span>
        <input
          ref={input}
          value={text}
          placeholder={placeholder ?? 'Add a task — try “report friday 4pm p2 #Work”'}
          aria-label="Add a task"
          onChange={(e) => {
            setText(e.target.value);
            setSuggestAt(e.target.selectionStart);
          }}
          onSelect={(e) => setSuggestAt((e.target as HTMLInputElement).selectionStart)}
          onKeyDown={(e) => {
            if (showing && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              setHighlight((h) => (h + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
              return;
            }
            if (showing && (e.key === 'Tab' || e.key === 'Enter')) {
              e.preventDefault();
              applySuggestion(options[highlight] ?? options[0]!);
              return;
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              if (text) setText('');
              else onDismiss?.();
            }
          }}
        />
        <button className="primary quick-add-go" onClick={submit} disabled={!text.trim()}>
          Add
        </button>
      </div>

      {showing ? (
        <div className="quick-add-suggest">
          {options.map((name, index) => {
            const list = lists.find((l) => l.name === name);
            const isNew = !(trigger!.kind === '#' ? lists.some((l) => l.name === name) : labels.includes(name));
            return (
              <button
                key={name}
                className={`quick-add-option ${index === highlight ? 'on' : ''}`}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applySuggestion(name);
                }}
              >
                {trigger!.kind === '#' ? (
                  <ListDot color={list?.color} emoji={list?.emoji} />
                ) : (
                  <span className="quick-add-at">@</span>
                )}
                {name}
                {isNew ? <span className="quick-add-new">new</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {text.trim() ? (
        <div className="quick-add-chips">
          {listChip ? (
            <span className="chip list">
              <ListDot
                color={lists.find((l) => l.name === listChip)?.color}
                emoji={lists.find((l) => l.name === listChip)?.emoji}
              />
              {listChip}
            </span>
          ) : (
            <span className="chip muted">Inbox</span>
          )}
          {chips.map((chip) => (
            <span className={`chip ${chip.kind}`} key={`${chip.kind}-${chip.start}`}>
              {chip.text}
            </span>
          ))}
          {!parsed.dueDate && defaultDue !== undefined ? (
            <span className="chip muted">{dueLabel(defaultDue, false)}</span>
          ) : null}
          <span className="quick-add-hint">Enter to add</span>
        </div>
      ) : null}
    </div>
  );
});

export default QuickAdd;
