import { useEffect, useRef, type MouseEvent } from 'react';

import {
  dueLabel,
  dueState,
  priorityNumber,
  taskProgress,
  type Task,
  type TaskList,
} from '@ai-coworker/shared';

import { DatePicker, ListDot } from './pickers.js';

export interface RowState {
  /** The keyboard cursor is on this row. */
  cursor: boolean;
  /** The detail panel is showing this task. */
  open: boolean;
  /** Part of a multi-selection. */
  checked: boolean;
  /** Ticked, and playing the little animation before it leaves. */
  completing: boolean;
  /** The date picker is open on this row. */
  scheduling: boolean;
  /** A drag is hovering, and would drop above or below this row. */
  dropping?: 'above' | 'below';
}

export interface RowHandlers {
  onComplete: (task: Task, done: boolean) => void;
  onOpen: (task: Task) => void;
  onCheck: (task: Task, event: MouseEvent) => void;
  /** Open the date picker on the row, without opening the whole task. */
  onSchedule: (task: Task | null) => void;
  onPickDate: (task: Task, due: number | undefined, hasTime: boolean) => void;
  onDragStart: (task: Task) => void;
  onDragOver: (task: Task, below: boolean) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}

/**
 * One line of the list.
 *
 * The circle is the only thing that finishes a task, and it is deliberately the
 * biggest target on the row. Everything else — the date, the list, the labels —
 * is metadata that gets out of the way until you hover.
 */
export default function TaskRow({
  task,
  lists,
  now,
  state,
  handlers,
  showList = true,
}: {
  task: Task;
  lists: TaskList[];
  now: number;
  state: RowState;
  handlers: RowHandlers;
  /** Off inside a list, where naming the list on every row is just noise. */
  showList?: boolean;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const list = lists.find((l) => l.id === task.listId);

  /**
   * Bring the row to the top of the scroller when its date picker opens.
   *
   * The list is a scroll box, so it clips: a picker that opened upward from a
   * row near the top would have its head cut off, and one that opened downward
   * from the last row would need scrolling to reach. Putting the row at the top
   * first means there is always room below it.
   */
  useEffect(() => {
    if (!state.scheduling) return;
    const id = requestAnimationFrame(() =>
      anchor.current?.closest('.task-row')?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
    );
    return () => cancelAnimationFrame(id);
  }, [state.scheduling]);
  const done = task.status === 'done' || task.status === 'dropped';
  // Mid-animation the circle already shows where it is going, so the tick lands
  // under the cursor rather than a beat later when the store catches up.
  const ticked = state.completing ? !done : done;
  const priority = priorityNumber(task.priority);
  const progress = taskProgress(task);
  const due = dueState(task, now);

  const classes = [
    'task-row',
    state.cursor ? 'cursor' : '',
    state.open ? 'open' : '',
    state.checked ? 'checked' : '',
    state.completing ? 'completing' : '',
    done ? 'done' : '',
    state.dropping ? `drop-${state.dropping}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const activate = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      event.preventDefault();
      handlers.onCheck(task, event);
      return;
    }
    handlers.onOpen(task);
  };

  return (
    <div
      className={classes}
      data-task-id={task.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        // Firefox and Chromium both refuse to start a drag with no payload.
        e.dataTransfer.setData('text/plain', task.id);
        handlers.onDragStart(task);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        const box = e.currentTarget.getBoundingClientRect();
        handlers.onDragOver(task, e.clientY > box.top + box.height / 2);
      }}
      onDrop={(e) => {
        e.preventDefault();
        handlers.onDrop();
      }}
      onDragEnd={handlers.onDragEnd}
    >
      <span className="task-grip" aria-hidden="true">
        ⠿
      </span>

      <button
        className={`task-check p${priority} ${ticked ? 'ticked' : ''}`}
        aria-label={ticked ? `Reopen ${task.title}` : `Complete ${task.title}`}
        aria-pressed={ticked}
        title={task.recurrence ? 'Ticking this moves it to its next date' : undefined}
        onClick={(e) => {
          e.stopPropagation();
          handlers.onComplete(task, !done);
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.5 8.5l3 3 6-7" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <div className="task-body" onClick={activate}>
        <div className="task-title-line">
          <span className="task-title">{task.title}</span>
          {task.recurrence ? (
            <span className="task-repeat" title="Repeats">
              ↻
            </span>
          ) : null}
          {task.status === 'blocked' ? <span className="tag bad small">blocked</span> : null}
          {task.status === 'in_progress' ? <span className="tag warn small">doing</span> : null}
        </div>

        {task.detail ? <div className="task-note">{task.detail}</div> : null}

        <div className="task-meta">
          {/* Rescheduling is the commonest thing anybody does to a task, so it
              is one click on the row rather than a trip through the panel. */}
          <span className="task-due-anchor" ref={anchor}>
            {task.dueDate !== undefined ? (
              <button
                className={`task-due ${due}`}
                title="Reschedule"
                onClick={(e) => {
                  e.stopPropagation();
                  handlers.onSchedule(state.scheduling ? null : task);
                }}
              >
                {due === 'overdue' ? '⚠ ' : ''}
                {dueLabel(task.dueDate, task.dueHasTime, now)}
              </button>
            ) : (
              <button
                className="task-due none"
                title="Schedule"
                aria-label={`Schedule ${task.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handlers.onSchedule(state.scheduling ? null : task);
                }}
              >
                ▤
              </button>
            )}
            {state.scheduling ? (
              <DatePicker
                value={task.dueDate}
                hasTime={task.dueHasTime}
                now={now}
                onClose={() => handlers.onSchedule(null)}
                onPick={(dueDate, hasTime) => handlers.onPickDate(task, dueDate, hasTime)}
              />
            ) : null}
          </span>
          {progress.total > 0 ? (
            <span className="task-progress">
              ✓ {progress.done}/{progress.total}
            </span>
          ) : null}
          {task.labels.map((label) => (
            <span className="task-label" key={label}>
              @{label}
            </span>
          ))}
          {task.sourceMeetingId ? <span className="task-origin">from a meeting</span> : null}
          {task.source?.kind === 'message' ? <span className="task-origin">from a message</span> : null}
          {showList && list ? (
            <span className="task-list">
              <ListDot color={list.color} emoji={list.emoji} />
              {list.name}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
