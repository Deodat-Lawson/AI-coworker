/**
 * The modal list behind the quick switcher, the command palette and the tag
 * jumper: type, fuzzy-match, arrow, enter.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { fuzzyMatch } from '@ai-coworker/shared';

export interface SuggestItem {
  id: string;
  label: string;
  detail?: string;
  aside?: string;
  /** Extra text that should match but is not displayed. */
  haystack?: string;
  group?: string;
  run(): void;
}

interface Props {
  placeholder: string;
  items: SuggestItem[];
  emptyText?: string;
  /** Shown when the query matches nothing; lets the switcher create a note. */
  fallback?(query: string): SuggestItem | null;
  onClose(): void;
}

export default function Suggester({ placeholder, items, emptyText, fallback, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return items.slice(0, 60);
    const scored = items
      .map((item) => {
        const primary = fuzzyMatch(trimmed, item.label);
        const secondary = primary
          ? null
          : fuzzyMatch(trimmed, `${item.label} ${item.detail ?? ''} ${item.haystack ?? ''}`);
        const match = primary ?? secondary;
        if (!match) return null;
        return { item, score: match.score + (primary ? 25 : 0), positions: primary?.positions ?? [] };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 60);
    const results = scored.map((entry) => ({ ...entry.item, positions: entry.positions }));
    const extra = fallback?.(trimmed);
    return extra ? [...results, extra] : results;
  }, [fallback, items, query]);

  useEffect(() => setIndex(0), [query]);

  useEffect(() => {
    const active = listRef.current?.querySelector('.is-active');
    active?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const choose = (item: SuggestItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  const groups: { group: string | undefined; items: SuggestItem[] }[] = [];
  for (const item of filtered) {
    const last = groups[groups.length - 1];
    if (last && last.group === item.group) last.items.push(item);
    else groups.push({ group: item.group, items: [item] });
  }
  let flatIndex = -1;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-suggest" onMouseDown={(event) => event.stopPropagation()}>
        <input
          autoFocus
          className="suggest-input"
          placeholder={placeholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setIndex((i) => Math.min(filtered.length - 1, i + 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              choose(filtered[index]);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <div className="suggest-list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="empty">{emptyText ?? 'No matches.'}</div>
          ) : (
            groups.map((group, groupIndex) => (
              <div key={`${group.group ?? ''}:${groupIndex}`}>
                {group.group ? <div className="suggest-group">{group.group}</div> : null}
                {group.items.map((item) => {
                  flatIndex += 1;
                  const current = flatIndex;
                  return (
                    <button
                      key={item.id}
                      className={`suggest-item${current === index ? ' is-active' : ''}`}
                      onMouseEnter={() => setIndex(current)}
                      onClick={() => choose(item)}
                      type="button"
                    >
                      <span className="suggest-label">{item.label}</span>
                      {item.detail ? <span className="suggest-detail">{item.detail}</span> : null}
                      {item.aside ? <span className="suggest-aside">{item.aside}</span> : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
