import { useMemo, useState } from 'react';

import {
  LIST_COLORS,
  TASK_PRIORITIES,
  addDays,
  addMonths,
  atTime,
  describeRecurrence,
  dueLabel,
  isSameDay,
  priorityNumber,
  startOfDay,
  timeLabel,
  type Recurrence,
  type RecurrenceUnit,
  type TaskList,
  type TaskPriority,
} from '@ai-coworker/shared';

import { Modal, Popover } from '../components/ui.js';

/** The coloured bead that stands for a list, everywhere a list is named. */
export function ListDot({ color, emoji }: { color?: string; emoji?: string }) {
  if (emoji) return <span className="list-emoji">{emoji}</span>;
  return <span className={`list-dot ${color ?? 'blue'}`} />;
}

const WEEK_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

/** Monday-first, because a to-do list is mostly a working week. */
function weekIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

/**
 * The date picker.
 *
 * Two halves, because scheduling splits into two habits: the four dates people
 * actually pick ninety per cent of the time, and a calendar for the tenth.
 */
export function DatePicker({
  value,
  hasTime,
  onPick,
  onClose,
  align = 'left',
  now = Date.now(),
}: {
  value?: number;
  hasTime?: boolean;
  onPick: (due: number | undefined, hasTime: boolean) => void;
  onClose: () => void;
  align?: 'left' | 'right';
  now?: number;
}) {
  const [month, setMonth] = useState(() => startOfDay(value ?? now));
  const [time, setTime] = useState(() =>
    value !== undefined && hasTime
      ? `${String(new Date(value).getHours()).padStart(2, '0')}:${String(
          new Date(value).getMinutes(),
        ).padStart(2, '0')}`
      : '',
  );

  const today = startOfDay(now);
  // The coming Saturday — "this weekend" on a Sunday means next Saturday, not
  // yesterday.
  const saturday = addDays(today, ((6 - new Date(today).getDay() + 7) % 7) || 7);
  const nextMonday = addDays(today, ((1 - new Date(today).getDay() + 7) % 7) || 7);

  const commit = (day: number | undefined) => {
    if (day === undefined) {
      onPick(undefined, false);
      onClose();
      return;
    }
    if (time) {
      const [h, m] = time.split(':').map(Number);
      onPick(atTime(day, h ?? 9, m ?? 0), true);
    } else {
      onPick(startOfDay(day), false);
    }
    onClose();
  };

  const grid = useMemo(() => {
    const first = new Date(month);
    first.setDate(1);
    const start = addDays(first.getTime(), -weekIndex(first));
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [month]);

  const quick: { label: string; hint: string; day: number }[] = [
    { label: 'Today', hint: new Date(today).toLocaleDateString([], { weekday: 'short' }), day: today },
    {
      label: 'Tomorrow',
      hint: new Date(addDays(today, 1)).toLocaleDateString([], { weekday: 'short' }),
      day: addDays(today, 1),
    },
    {
      label: 'This weekend',
      hint: new Date(saturday).toLocaleDateString([], { weekday: 'short', day: 'numeric' }),
      day: saturday,
    },
    {
      label: 'Next week',
      hint: new Date(nextMonday).toLocaleDateString([], { weekday: 'short', day: 'numeric' }),
      day: nextMonday,
    },
  ];

  return (
    <Popover onClose={onClose} align={align}>
      <div className="date-picker">
        <div className="date-quick">
          {quick.map((option) => (
            <button key={option.label} className="date-quick-row" onClick={() => commit(option.day)}>
              <span>{option.label}</span>
              <span className="date-quick-hint">{option.hint}</span>
            </button>
          ))}
        </div>

        <div className="date-cal">
          <div className="date-cal-head">
            <button className="ghost" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month">
              ‹
            </button>
            <span>{new Date(month).toLocaleDateString([], { month: 'long', year: 'numeric' })}</span>
            <button className="ghost" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month">
              ›
            </button>
          </div>
          <div className="date-grid">
            {WEEK_LABELS.map((label) => (
              <div className="date-grid-label" key={label}>
                {label}
              </div>
            ))}
            {grid.map((day) => {
              const date = new Date(day);
              const outside = date.getMonth() !== new Date(month).getMonth();
              const chosen = value !== undefined && isSameDay(day, value);
              return (
                <button
                  key={day}
                  className={`date-cell ${outside ? 'outside' : ''} ${chosen ? 'chosen' : ''} ${
                    isSameDay(day, now) ? 'is-today' : ''
                  }`}
                  onClick={() => commit(day)}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
        </div>

        <div className="date-time">
          <label htmlFor="due-time">Time</label>
          <input
            id="due-time"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              commit(value ?? today);
            }}
          />
          {time ? (
            <button className="ghost" onClick={() => setTime('')}>
              Clear
            </button>
          ) : null}
        </div>

        <div className="date-foot">
          <button className="ghost" onClick={() => commit(undefined)} disabled={value === undefined}>
            No date
          </button>
          <button className="primary" onClick={() => commit(value ?? today)}>
            {value === undefined && !time ? 'Set today' : 'Save'}
          </button>
        </div>
      </div>
    </Popover>
  );
}

export function PriorityMenu({
  value,
  onPick,
  onClose,
  align = 'left',
}: {
  value: TaskPriority;
  onPick: (priority: TaskPriority) => void;
  onClose: () => void;
  align?: 'left' | 'right';
}) {
  return (
    <Popover onClose={onClose} align={align}>
      <div className="menu">
        {TASK_PRIORITIES.map((priority) => (
          <button
            key={priority}
            className="menu-item"
            onClick={() => {
              onPick(priority);
              onClose();
            }}
          >
            <span className="menu-lead">
              <span className={`flag p${priorityNumber(priority)}`}>⚑</span>
              Priority {priorityNumber(priority)}
            </span>
            {value === priority ? <span className="menu-hint">✓</span> : null}
          </button>
        ))}
      </div>
    </Popover>
  );
}

export function ListMenu({
  lists,
  value,
  onPick,
  onClose,
  onCreate,
  align = 'left',
}: {
  lists: TaskList[];
  value?: string;
  onPick: (listId: string | undefined) => void;
  onClose: () => void;
  onCreate?: (name: string) => void;
  align?: 'left' | 'right';
}) {
  const [query, setQuery] = useState('');
  const matches = lists.filter((l) => l.name.toLowerCase().includes(query.trim().toLowerCase()));
  const exact = lists.some((l) => l.name.toLowerCase() === query.trim().toLowerCase());

  return (
    <Popover onClose={onClose} align={align}>
      <div className="menu">
        <input
          className="menu-search"
          autoFocus
          placeholder="Move to…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const first = matches[0];
            if (first) {
              onPick(first.id);
              onClose();
            } else if (query.trim() && onCreate) {
              onCreate(query.trim());
              onClose();
            }
          }}
        />
        <div className="menu-scroll">
          <button
            className="menu-item"
            onClick={() => {
              onPick(undefined);
              onClose();
            }}
          >
            <span className="menu-lead">
              <span className="list-dot inbox" />
              Inbox
            </span>
            {!value ? <span className="menu-hint">✓</span> : null}
          </button>
          {matches.map((list) => (
            <button
              key={list.id}
              className="menu-item"
              onClick={() => {
                onPick(list.id);
                onClose();
              }}
            >
              <span className="menu-lead">
                <ListDot color={list.color} emoji={list.emoji} />
                {list.name}
              </span>
              {value === list.id ? <span className="menu-hint">✓</span> : null}
            </button>
          ))}
          {query.trim() && !exact && onCreate ? (
            <button
              className="menu-item"
              onClick={() => {
                onCreate(query.trim());
                onClose();
              }}
            >
              <span className="menu-lead">＋ Create “{query.trim()}”</span>
            </button>
          ) : null}
        </div>
      </div>
    </Popover>
  );
}

export function LabelMenu({
  labels,
  value,
  onToggle,
  onClose,
  align = 'left',
}: {
  labels: string[];
  value: string[];
  onToggle: (label: string) => void;
  onClose: () => void;
  align?: 'left' | 'right';
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const known = [...new Set([...value, ...labels])];
  const matches = known.filter((label) => label.toLowerCase().includes(needle));
  const exact = known.some((label) => label.toLowerCase() === needle);

  return (
    <Popover onClose={onClose} align={align}>
      <div className="menu">
        <input
          className="menu-search"
          autoFocus
          placeholder="Label…"
          value={query}
          onChange={(e) => setQuery(e.target.value.replace(/[\s,]+/g, '-'))}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const target = exact ? known.find((l) => l.toLowerCase() === needle) : needle ? query.trim() : matches[0];
            if (target) onToggle(target);
            setQuery('');
          }}
        />
        <div className="menu-scroll">
          {matches.map((label) => (
            <button key={label} className="menu-item" onClick={() => onToggle(label)}>
              <span className="menu-lead">@{label}</span>
              {value.includes(label) ? <span className="menu-hint">✓</span> : null}
            </button>
          ))}
          {needle && !exact ? (
            <button className="menu-item" onClick={() => onToggle(query.trim())}>
              <span className="menu-lead">＋ New label “{query.trim()}”</span>
            </button>
          ) : null}
          {!matches.length && !needle ? <div className="menu-empty">No labels yet.</div> : null}
        </div>
      </div>
    </Popover>
  );
}

const UNITS: { unit: RecurrenceUnit; label: string }[] = [
  { unit: 'day', label: 'days' },
  { unit: 'week', label: 'weeks' },
  { unit: 'month', label: 'months' },
  { unit: 'year', label: 'years' },
];

export function RepeatMenu({
  value,
  dueDate,
  onPick,
  onClose,
  align = 'left',
}: {
  value?: Recurrence;
  dueDate?: number;
  onPick: (recurrence: Recurrence | undefined) => void;
  onClose: () => void;
  align?: 'left' | 'right';
}) {
  const [custom, setCustom] = useState(false);
  const [every, setEvery] = useState(value?.every ?? 2);
  const [unit, setUnit] = useState<RecurrenceUnit>(value?.unit ?? 'week');
  const [fromCompletion, setFromCompletion] = useState(value?.from === 'completion');

  const anchor = dueDate ?? Date.now();
  const weekday = new Date(anchor).getDay();
  const presets: Recurrence[] = [
    { unit: 'day', every: 1, from: 'schedule' },
    { unit: 'week', every: 1, weekdays: [1, 2, 3, 4, 5], from: 'schedule' },
    { unit: 'week', every: 1, weekdays: [weekday], from: 'schedule' },
    { unit: 'month', every: 1, from: 'schedule' },
    { unit: 'year', every: 1, from: 'schedule' },
  ];

  const same = (a: Recurrence, b?: Recurrence) =>
    Boolean(
      b &&
        a.unit === b.unit &&
        a.every === b.every &&
        a.from === b.from &&
        (a.weekdays ?? []).join(',') === (b.weekdays ?? []).join(','),
    );

  return (
    <Popover onClose={onClose} align={align}>
      <div className="menu">
        {custom ? (
          <div className="repeat-custom">
            <div className="repeat-row">
              <span>Every</span>
              <input
                type="number"
                min={1}
                max={365}
                value={every}
                onChange={(e) => setEvery(Math.max(1, Number(e.target.value) || 1))}
              />
              <select value={unit} onChange={(e) => setUnit(e.target.value as RecurrenceUnit)}>
                {UNITS.map((option) => (
                  <option key={option.unit} value={option.unit}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <label className="repeat-check">
              <input
                type="checkbox"
                checked={fromCompletion}
                onChange={(e) => setFromCompletion(e.target.checked)}
              />
              Count from when I finish it
            </label>
            <p className="hint">
              Off, it keeps its rhythm — rent is due on the 1st however late you paid the last one.
            </p>
            <div className="repeat-foot">
              <button className="ghost" onClick={() => setCustom(false)}>
                Back
              </button>
              <button
                className="primary"
                onClick={() => {
                  onPick({ unit, every, from: fromCompletion ? 'completion' : 'schedule' });
                  onClose();
                }}
              >
                Repeat
              </button>
            </div>
          </div>
        ) : (
          <>
            <button
              className="menu-item"
              onClick={() => {
                onPick(undefined);
                onClose();
              }}
            >
              <span className="menu-lead">Never</span>
              {!value ? <span className="menu-hint">✓</span> : null}
            </button>
            {presets.map((preset) => (
              <button
                key={describeRecurrence(preset)}
                className="menu-item"
                onClick={() => {
                  onPick(preset);
                  onClose();
                }}
              >
                <span className="menu-lead">{describeRecurrence(preset)}</span>
                {same(preset, value) ? <span className="menu-hint">✓</span> : null}
              </button>
            ))}
            <div className="menu-sep" />
            <button className="menu-item" onClick={() => setCustom(true)}>
              <span className="menu-lead">Custom…</span>
            </button>
          </>
        )}
      </div>
    </Popover>
  );
}

/** Name, emoji and colour for a list — the same form for making and editing. */
export function ListForm({
  list,
  onSave,
  onClose,
  onDelete,
}: {
  list?: TaskList;
  onSave: (input: { name: string; emoji: string; color: string }) => void;
  onClose: () => void;
  onDelete?: (deleteTasks: boolean) => void;
}) {
  const [name, setName] = useState(list?.name ?? '');
  const [emoji, setEmoji] = useState(list?.emoji ?? '');
  const [color, setColor] = useState(list?.color ?? 'blue');
  const [confirming, setConfirming] = useState(false);

  const save = () => {
    if (!name.trim()) return;
    onSave({ name: name.trim(), emoji: emoji.trim(), color });
    onClose();
  };

  return (
    // A modal rather than a popover: the rail is a scroll box, and a popover
    // hanging off a row near its bottom gets its Create button clipped away.
    <Modal title={list ? 'Edit list' : 'New list'} onClose={onClose}>
      <div className="list-form">
        <div className="list-form-row">
          <input
            className="list-emoji-input"
            value={emoji}
            maxLength={2}
            placeholder="🙂"
            aria-label="List emoji"
            onChange={(e) => setEmoji(e.target.value)}
          />
          <input
            autoFocus
            value={name}
            placeholder="List name"
            aria-label="List name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                save();
              }
            }}
          />
        </div>
        <div className="swatches">
          {LIST_COLORS.map((option) => (
            <button
              key={option}
              className={`swatch ${option} ${color === option ? 'chosen' : ''}`}
              title={option}
              aria-label={option}
              onClick={() => setColor(option)}
            />
          ))}
        </div>
        <div className="list-form-foot">
          {onDelete && list ? (
            confirming ? (
              <span className="list-form-confirm">
                <button className="danger" onClick={() => onDelete(false)}>
                  Keep tasks
                </button>
                <button className="danger" onClick={() => onDelete(true)}>
                  Delete tasks
                </button>
              </span>
            ) : (
              <button className="danger" onClick={() => setConfirming(true)}>
                Delete
              </button>
            )
          ) : (
            <span />
          )}
          <button className="primary" onClick={save} disabled={!name.trim()}>
            {list ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The one-line summary a scheduling chip shows. */
export function scheduleText(dueDate: number | undefined, hasTime: boolean, now = Date.now()): string {
  if (dueDate === undefined) return 'Schedule';
  return dueLabel(dueDate, hasTime, now);
}

export { timeLabel };
