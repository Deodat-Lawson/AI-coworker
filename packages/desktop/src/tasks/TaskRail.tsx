import { useState } from 'react';

import {
  SMART_VIEWS,
  scopeKey,
  type TaskCounts,
  type TaskList,
  type TaskScope,
} from '@ai-coworker/shared';

import { ListDot, ListForm } from './pickers.js';

/**
 * The places a task can be, down the left.
 *
 * Smart views first because they are where the day starts, then the lists a
 * person made, then the labels they have actually used. Counts are open tasks
 * only — a badge that includes finished work is a badge nobody reads twice.
 */
export default function TaskRail({
  lists,
  labels,
  counts,
  scope,
  onScope,
  onSaveList,
  onDeleteList,
  onDropOnList,
  dragging,
}: {
  lists: TaskList[];
  labels: string[];
  counts: TaskCounts;
  scope: TaskScope;
  onScope: (scope: TaskScope) => void;
  onSaveList: (input: { id?: string; name: string; emoji: string; color: string }) => void;
  onDeleteList: (listId: string, deleteTasks: boolean) => void;
  onDropOnList: (listId: string | undefined) => void;
  /** True while a task is being dragged, so the lists can offer themselves. */
  dragging: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [over, setOver] = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState(true);

  const current = scopeKey(scope);

  const dropProps = (listId: string | undefined) =>
    dragging
      ? {
          onDragOver: (e: React.DragEvent) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setOver(listId ?? 'inbox');
          },
          onDragLeave: () => setOver((o) => (o === (listId ?? 'inbox') ? null : o)),
          onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            setOver(null);
            onDropOnList(listId);
          },
        }
      : {};

  const countFor = (view: string): number => {
    if (view === 'inbox') return counts.inbox;
    if (view === 'today') return counts.today;
    if (view === 'upcoming') return counts.upcoming;
    if (view === 'all') return counts.all;
    return 0;
  };

  return (
    <nav className="todo-rail">
      <div className="todo-rail-group">
        {SMART_VIEWS.map((entry) => {
          const key = `smart:${entry.view}`;
          const count = countFor(entry.view);
          const isInbox = entry.view === 'inbox';
          return (
            <button
              key={entry.view}
              className={`todo-rail-row ${current === key ? 'active' : ''} ${
                over === 'inbox' && isInbox ? 'dropping' : ''
              }`}
              title={entry.hint}
              onClick={() => onScope({ kind: 'smart', view: entry.view })}
              {...(isInbox ? dropProps(undefined) : {})}
            >
              <span className={`todo-rail-icon ${entry.view}`}>{entry.icon}</span>
              <span className="todo-rail-label">{entry.label}</span>
              {entry.view === 'today' && counts.overdue > 0 ? (
                <span className="todo-rail-count late" title={`${counts.overdue} overdue`}>
                  {count}
                </span>
              ) : count > 0 ? (
                <span className="todo-rail-count">{count}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="todo-rail-group">
        <div className="todo-rail-head">
          <span>Lists</span>
          <button
            className="todo-rail-add"
            aria-label="New list"
            title="New list"
            onClick={() => setCreating(true)}
          >
            ＋
          </button>
          {creating ? (
            <ListForm
              onClose={() => setCreating(false)}
              onSave={(input) => onSaveList(input)}
            />
          ) : null}
        </div>

        {lists.map((list) => {
          const key = `list:${list.id}`;
          const count = counts.byList[list.id] ?? 0;
          return (
            <div className="todo-rail-row-wrap" key={list.id}>
              <button
                className={`todo-rail-row ${current === key ? 'active' : ''} ${
                  over === list.id ? 'dropping' : ''
                }`}
                onClick={() => onScope({ kind: 'list', listId: list.id })}
                onDoubleClick={() => setEditing(list.id)}
                {...dropProps(list.id)}
              >
                <span className="todo-rail-icon">
                  <ListDot color={list.color} emoji={list.emoji} />
                </span>
                <span className="todo-rail-label">{list.name}</span>
                {count > 0 ? <span className="todo-rail-count">{count}</span> : null}
              </button>
              <button
                className="todo-rail-more"
                aria-label={`Edit ${list.name}`}
                onClick={() => setEditing(list.id)}
              >
                ⋯
              </button>
              {editing === list.id ? (
                <ListForm
                  list={list}
                  onClose={() => setEditing(null)}
                  onSave={(input) => onSaveList({ id: list.id, ...input })}
                  onDelete={(deleteTasks) => {
                    onDeleteList(list.id, deleteTasks);
                    setEditing(null);
                  }}
                />
              ) : null}
            </div>
          );
        })}

        {!lists.length ? (
          <button className="todo-rail-row muted" onClick={() => setCreating(true)}>
            <span className="todo-rail-icon">＋</span>
            <span className="todo-rail-label">Add a list</span>
          </button>
        ) : null}
      </div>

      {labels.length ? (
        <div className="todo-rail-group">
          <button className="todo-rail-head as-button" onClick={() => setShowLabels((v) => !v)}>
            <span className={`chevron ${showLabels ? '' : 'closed'}`}>▾</span>
            <span>Labels</span>
          </button>
          {showLabels
            ? labels.map((label) => {
                const key = `label:${label}`;
                return (
                  <button
                    key={label}
                    className={`todo-rail-row ${current === key ? 'active' : ''}`}
                    onClick={() => onScope({ kind: 'label', label })}
                  >
                    <span className="todo-rail-icon at">@</span>
                    <span className="todo-rail-label">{label}</span>
                    <span className="todo-rail-count">{counts.byLabel[label] ?? 0}</span>
                  </button>
                );
              })
            : null}
        </div>
      ) : null}
    </nav>
  );
}
