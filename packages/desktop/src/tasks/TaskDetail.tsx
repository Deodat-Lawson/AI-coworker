import { useEffect, useRef, useState } from 'react';

import {
  addDays,
  atTime,
  describeRecurrence,
  dueLabel,
  makeSubtask,
  priorityLabel,
  priorityNumber,
  startOfDay,
  statusLabel,
  timeLabel,
  WORKING_STATUSES,
  type Subtask,
  type Task,
  type TaskList,
  type TaskStatus,
} from '@ai-coworker/shared';

import { dateTimeOf, nameOf } from '../lib/format.js';
import { ConfirmButton, Popover } from '../components/ui.js';
import { DatePicker, LabelMenu, ListDot, ListMenu, PriorityMenu, RepeatMenu } from './pickers.js';

type Menu = 'none' | 'due' | 'priority' | 'list' | 'labels' | 'repeat' | 'remind' | 'status';

/**
 * Everything about one task, beside the list rather than on top of it — you
 * should be able to see where a task sits while you edit it.
 *
 * Text is held locally and written on blur; everything else writes the moment
 * you pick it, because a date picker has no "done" and waiting for one is how
 * changes get lost.
 */
export default function TaskDetail({
  task,
  lists,
  labels,
  directory,
  now,
  onPatch,
  onComplete,
  onDelete,
  onClose,
  onOpenSource,
}: {
  task: Task;
  lists: TaskList[];
  labels: string[];
  directory: { address: string; displayName: string }[];
  now: number;
  onPatch: (patch: Partial<Task>) => void;
  /**
   * Separate from `onPatch` on purpose: ticking a task off is not the same act
   * as setting its status, because a repeating task moves on instead of
   * finishing — and it has to do that from here as well as from the list.
   */
  onComplete: (done: boolean) => void;
  onDelete: () => void;
  onClose: () => void;
  onOpenSource: (task: Task) => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [detail, setDetail] = useState(task.detail);
  const [menu, setMenu] = useState<Menu>('none');
  const [newSubtask, setNewSubtask] = useState('');
  const titleRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Keep the boxes in step with the store without fighting the typist. A
   * different task replaces everything; the *same* task changing underneath —
   * the agent renaming it, a meeting adding to it — is adopted only where the
   * field has not been touched since it last matched.
   */
  const source = useRef({ id: task.id, title: task.title, detail: task.detail });
  useEffect(() => {
    const previous = source.current;
    source.current = { id: task.id, title: task.title, detail: task.detail };
    if (previous.id !== task.id) {
      setTitle(task.title);
      setDetail(task.detail);
      setMenu('none');
      setNewSubtask('');
      return;
    }
    if (previous.title !== task.title) {
      setTitle((current) => (current === previous.title ? task.title : current));
    }
    if (previous.detail !== task.detail) {
      setDetail((current) => (current === previous.detail ? task.detail : current));
    }
  }, [task.id, task.title, task.detail]);

  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);

  const list = lists.find((l) => l.id === task.listId);
  const done = task.status === 'done' || task.status === 'dropped';

  const commitTitle = () => {
    const next = title.trim();
    if (!next || next === task.title) {
      if (!next) setTitle(task.title);
      return;
    }
    onPatch({ title: next });
  };

  const commitDetail = () => {
    if (detail === task.detail) return;
    onPatch({ detail });
  };

  const setSubtasks = (next: Task['subtasks']) => onPatch({ subtasks: next });

  const addSubtask = () => {
    const text = newSubtask.trim();
    if (!text) return;
    setSubtasks([...task.subtasks, makeSubtask(text)]);
    setNewSubtask('');
  };

  const remindOptions: { label: string; at: number | undefined }[] = task.dueDate
    ? [
        { label: 'At the time it is due', at: task.dueDate },
        { label: '10 minutes before', at: task.dueDate - 10 * 60_000 },
        { label: '1 hour before', at: task.dueDate - 60 * 60_000 },
        { label: 'The day before, at 9am', at: atTime(addDays(task.dueDate, -1), 9) },
        { label: 'No reminder', at: undefined },
      ]
    : [
        { label: 'In an hour', at: now + 60 * 60_000 },
        { label: 'This evening, at 6pm', at: atTime(now, 18) },
        { label: 'Tomorrow, at 9am', at: atTime(addDays(now, 1), 9) },
        { label: 'No reminder', at: undefined },
      ];

  return (
    <aside className="task-detail">
      <header className="task-detail-head">
        <button
          className={`task-check p${priorityNumber(task.priority)} ${done ? 'ticked' : ''}`}
          aria-label={done ? 'Reopen this task' : 'Complete this task'}
          title={task.recurrence && !done ? 'Ticking this moves it to its next date' : undefined}
          onClick={() => onComplete(!done)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.5 8.5l3 3 6-7" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span className="task-detail-status">{statusLabel(task.status)}</span>
        <button className="ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      <div className="task-detail-body">
        <textarea
          ref={titleRef}
          className="task-detail-title"
          value={title}
          rows={1}
          aria-label="Task title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitTitle();
              (e.target as HTMLTextAreaElement).blur();
            }
            if (e.key === 'Escape') setTitle(task.title);
          }}
        />

        <textarea
          className="task-detail-note"
          value={detail}
          placeholder="Notes"
          aria-label="Notes"
          onChange={(e) => setDetail(e.target.value)}
          onBlur={commitDetail}
        />

        <div className="task-props">
          <div className="task-prop">
            <span className="task-prop-label">Due</span>
            <button className={`prop-button ${task.dueDate ? 'set' : ''}`} onClick={() => setMenu('due')}>
              {task.dueDate ? dueLabel(task.dueDate, task.dueHasTime, now) : 'No date'}
            </button>
            {menu === 'due' ? (
              <DatePicker
                value={task.dueDate}
                hasTime={task.dueHasTime}
                now={now}
                align="right"
                onClose={() => setMenu('none')}
                onPick={(due, hasTime) => onPatch({ dueDate: due, dueHasTime: hasTime })}
              />
            ) : null}
          </div>

          <div className="task-prop">
            <span className="task-prop-label">Priority</span>
            <button className="prop-button set" onClick={() => setMenu('priority')}>
              <span className={`flag p${priorityNumber(task.priority)}`}>⚑</span>
              {priorityLabel(task.priority)}
            </button>
            {menu === 'priority' ? (
              <PriorityMenu
                value={task.priority}
                align="right"
                onClose={() => setMenu('none')}
                onPick={(priority) => onPatch({ priority })}
              />
            ) : null}
          </div>

          <div className="task-prop">
            <span className="task-prop-label">List</span>
            <button className={`prop-button ${list ? 'set' : ''}`} onClick={() => setMenu('list')}>
              <ListDot color={list?.color} emoji={list?.emoji} />
              {list?.name ?? 'Inbox'}
            </button>
            {menu === 'list' ? (
              <ListMenu
                lists={lists}
                value={task.listId}
                align="right"
                onClose={() => setMenu('none')}
                onPick={(listId) => onPatch({ listId, sectionId: undefined })}
              />
            ) : null}
          </div>

          <div className="task-prop">
            <span className="task-prop-label">Labels</span>
            <button className={`prop-button ${task.labels.length ? 'set' : ''}`} onClick={() => setMenu('labels')}>
              {task.labels.length ? task.labels.map((l) => `@${l}`).join(' ') : 'None'}
            </button>
            {menu === 'labels' ? (
              <LabelMenu
                labels={labels}
                value={task.labels}
                align="right"
                onClose={() => setMenu('none')}
                onToggle={(label) =>
                  onPatch({
                    labels: task.labels.includes(label)
                      ? task.labels.filter((l) => l !== label)
                      : [...task.labels, label],
                  })
                }
              />
            ) : null}
          </div>

          <div className="task-prop">
            <span className="task-prop-label">Repeat</span>
            <button className={`prop-button ${task.recurrence ? 'set' : ''}`} onClick={() => setMenu('repeat')}>
              {task.recurrence ? describeRecurrence(task.recurrence) : 'Never'}
            </button>
            {menu === 'repeat' ? (
              <RepeatMenu
                value={task.recurrence}
                dueDate={task.dueDate}
                align="right"
                onClose={() => setMenu('none')}
                onPick={(recurrence) =>
                  onPatch({
                    recurrence,
                    // A repeat has to have somewhere to start counting from.
                    dueDate: recurrence && !task.dueDate ? startOfDay(now) : task.dueDate,
                  })
                }
              />
            ) : null}
          </div>

          <div className="task-prop">
            <span className="task-prop-label">Remind me</span>
            <button className={`prop-button ${task.remindAt ? 'set' : ''}`} onClick={() => setMenu('remind')}>
              {task.remindAt ? `${dueLabel(task.remindAt, true, now)}` : 'No reminder'}
            </button>
            {menu === 'remind' ? (
              <Popover align="right" onClose={() => setMenu('none')}>
                <div className="menu">
                  {remindOptions.map((option) => (
                    <button
                      key={option.label}
                      className="menu-item"
                      onClick={() => {
                        onPatch({ remindAt: option.at });
                        setMenu('none');
                      }}
                    >
                      <span className="menu-lead">{option.label}</span>
                      {option.at !== undefined ? (
                        <span className="menu-hint">{timeLabel(option.at)}</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </Popover>
            ) : null}
          </div>

          <div className="task-prop">
            <span className="task-prop-label">Status</span>
            <div className="status-row">
              {WORKING_STATUSES.map((status: TaskStatus) => (
                <button
                  key={status}
                  className={`status-pill ${task.status === status ? 'on' : ''}`}
                  onClick={() => onPatch({ status })}
                >
                  {statusLabel(status)}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="task-section">
          <div className="task-section-head">
            <h3>Checklist</h3>
            {task.subtasks.length ? (
              <span className="task-section-count">
                {task.subtasks.filter((s) => s.done).length}/{task.subtasks.length}
              </span>
            ) : null}
          </div>
          {task.subtasks.map((sub, index) => (
            <SubtaskRow
              key={sub.id}
              subtask={sub}
              index={index}
              onToggle={() =>
                setSubtasks(task.subtasks.map((s) => (s.id === sub.id ? { ...s, done: !s.done } : s)))
              }
              onRename={(title) =>
                setSubtasks(task.subtasks.map((s) => (s.id === sub.id ? { ...s, title } : s)))
              }
              onRemove={() => setSubtasks(task.subtasks.filter((s) => s.id !== sub.id))}
            />
          ))}
          <div className="subtask add">
            <span className="subtask-plus">＋</span>
            <input
              value={newSubtask}
              placeholder="Add a step"
              aria-label="Add a checklist item"
              onChange={(e) => setNewSubtask(e.target.value)}
              onBlur={addSubtask}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addSubtask();
                }
              }}
            />
          </div>
        </div>

        {task.acceptanceCriteria.length ? (
          <div className="task-section">
            <div className="task-section-head">
              <h3>Agreed in the meeting</h3>
            </div>
            <ul className="criteria">
              {task.acceptanceCriteria.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {task.negotiationNote ? <div className="banner warn task-negotiation">{task.negotiationNote}</div> : null}

        {task.sourceMeetingId || task.source ? (
          <div className="task-section">
            <div className="task-section-head">
              <h3>Where this came from</h3>
            </div>
            <button className="task-origin-card" onClick={() => onOpenSource(task)}>
              <div className="card-title">
                {task.sourceMeetingId
                  ? 'An agent meeting'
                  : task.source?.kind === 'message'
                    ? 'A message in your workspace'
                    : 'Your agent'}
              </div>
              {task.source?.excerpt ? <div className="card-sub">“{task.source.excerpt}”</div> : null}
              {task.assignedBy && task.assignedBy !== task.assignee ? (
                <div className="card-meta">Assigned by {nameOf(task.assignedBy, directory)}</div>
              ) : null}
            </button>
          </div>
        ) : null}

        <div className="task-detail-foot">
          <div className="task-stamps">
            <div>Added {dateTimeOf(task.createdAt)}</div>
            {task.completedAt ? <div>Completed {dateTimeOf(task.completedAt)}</div> : null}
          </div>
          <ConfirmButton label="Delete" confirmLabel="Really delete" onConfirm={onDelete} />
        </div>
      </div>
    </aside>
  );
}

/**
 * One checklist line.
 *
 * The text is held here and written on blur, not on every keystroke. Bound
 * straight to the store it would write `db.json` per character and, because the
 * value comes back asynchronously, put the caret back at the end of the line
 * every time you edited the middle of one.
 */
function SubtaskRow({
  subtask,
  index,
  onToggle,
  onRename,
  onRemove,
}: {
  subtask: Subtask;
  index: number;
  onToggle: () => void;
  onRename: (title: string) => void;
  onRemove: () => void;
}) {
  const [title, setTitle] = useState(subtask.title);
  const known = useRef(subtask.title);

  useEffect(() => {
    if (known.current === subtask.title) return;
    known.current = subtask.title;
    setTitle((current) => (current === known.current ? current : subtask.title));
  }, [subtask.title]);

  const commit = () => {
    const next = title.trim();
    if (next === subtask.title) return;
    if (!next) {
      onRemove();
      return;
    }
    known.current = next;
    onRename(next);
  };

  return (
    <div className="subtask">
      <button
        className={`subtask-check ${subtask.done ? 'ticked' : ''}`}
        aria-label={subtask.done ? `Uncheck ${subtask.title}` : `Check ${subtask.title}`}
        onClick={onToggle}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.5 8.5l3 3 6-7" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <input
        className={`subtask-title ${subtask.done ? 'done' : ''}`}
        value={title}
        aria-label={`Checklist item ${index + 1}`}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') setTitle(subtask.title);
          if (e.key === 'Backspace' && !title) {
            e.preventDefault();
            onRemove();
          }
        }}
      />
      <button className="ghost subtask-remove" aria-label={`Remove ${subtask.title}`} onClick={onRemove}>
        ✕
      </button>
    </div>
  );
}
