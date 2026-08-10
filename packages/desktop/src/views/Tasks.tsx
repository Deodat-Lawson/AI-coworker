import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  TASK_GROUPINGS,
  TASK_SORTS,
  addDays,
  allLabels,
  atTime,
  countTasks,
  dayProgress,
  groupBySection,
  groupTasks,
  isCompleted,
  isSameDay,
  priorityFromNumber,
  reorderTasks as reorderWithin,
  sortCompleted,
  sortTasks,
  startOfDay,
  taskMatches,
  tasksInScope,
  upcomingDays,
  type Task,
  type TaskGroup,
  type TaskGroupBy,
  type TaskList,
  type TaskScope,
  type TaskSort,
} from '@ai-coworker/shared';

import { Popover } from '../components/ui.js';
import { api, unwrap, type AppState } from '../lib/api.js';
import QuickAdd, { type QuickAddDraft, type QuickAddHandle } from '../tasks/QuickAdd.js';
import TaskDetail from '../tasks/TaskDetail.js';
import TaskRail from '../tasks/TaskRail.js';
import TaskRow from '../tasks/TaskRow.js';
import { DatePicker, ListMenu, PriorityMenu } from '../tasks/pickers.js';

/** `auto` lets each view group itself the way that view wants to be read. */
type Grouping = 'auto' | TaskGroupBy;

interface ViewPrefs {
  scope: TaskScope;
  sort: TaskSort;
  grouping: Grouping;
  showCompleted: boolean;
}

const PREFS_KEY = 'stead.todo.prefs';

const DEFAULT_PREFS: ViewPrefs = {
  scope: { kind: 'smart', view: 'today' },
  sort: 'manual',
  grouping: 'auto',
  showCompleted: false,
};

function loadPrefs(): ViewPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<ViewPrefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** How long the tick stays visible before the row leaves. */
const TICK_MS = 240;

/** How long an undone thing stays undoable. */
const UNDO_MS = 8000;

interface UndoEntry {
  label: string;
  /** The tasks exactly as they were. Putting them back is a replacement. */
  tasks: Task[];
  /** Lists that went with them, so undoing a deleted list brings it back. */
  lists?: TaskList[];
  /** True when the tasks were deleted, so undo has to recreate them. */
  deleted: boolean;
}

interface Props {
  state: AppState;
  /** Set when a reminder notification was clicked. */
  openTaskId: string | null;
  onTaskOpened: () => void;
  onOpenMeeting: (meetingId: string) => void;
  onOpenChannel: (workspaceId: string, channelId: string) => void;
}

/**
 * The to-do list.
 *
 * A list of things to do is the oldest interface there is, and every good one
 * has the same three parts: somewhere to put a thought without thinking about
 * where it goes, a view that shows only today, and a way to change your mind
 * that does not punish you. Everything else here is in service of those.
 */
export default function Tasks({
  state,
  openTaskId,
  onTaskOpened,
  onOpenMeeting,
  onOpenChannel,
}: Props) {
  const [prefs, setPrefs] = useState<ViewPrefs>(loadPrefs);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [completing, setCompleting] = useState<Record<string, boolean>>({});
  const [undo, setUndo] = useState<UndoEntry | null>(null);
  const [menu, setMenu] = useState<'none' | 'sort' | 'bulk-date' | 'bulk-priority' | 'bulk-list'>('none');
  const [schedulingId, setSchedulingId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<Task | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; below: boolean } | null>(null);
  const [addTarget, setAddTarget] = useState<{ sectionId?: string; day?: number } | null>(null);
  const [addingSection, setAddingSection] = useState(false);
  const [sectionName, setSectionName] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const quickAdd = useRef<QuickAddHandle>(null);
  /** Tasks whose tick is in flight, so a second click cannot double-advance one. */
  const pending = useRef<Set<string>>(new Set());
  const scroller = useRef<HTMLDivElement>(null);

  const { scope, sort, grouping, showCompleted } = prefs;
  const patchPrefs = useCallback((patch: Partial<ViewPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        // A locked-down store is not a reason to stop working.
      }
      return next;
    });
  }, []);

  // "Overdue" is a fact about the clock, not about the data, so the view has to
  // notice the clock moving even when nothing has changed.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [undo]);

  const tasks = state.tasks;
  const lists = state.taskLists;
  const sections = state.taskSections;
  const labels = useMemo(() => allLabels(tasks), [tasks]);
  const counts = useMemo(() => countTasks(tasks, now), [tasks, now]);
  const progress = useMemo(() => dayProgress(tasks, now), [tasks, now]);

  // A scope whose list was deleted has to land somewhere real.
  useEffect(() => {
    if (scope.kind !== 'list') return;
    if (lists.some((l) => l.id === scope.listId)) return;
    patchPrefs({ scope: { kind: 'smart', view: 'today' } });
  }, [scope, lists, patchPrefs]);

  // --- what is on screen -----------------------------------------------------

  const visible = useMemo(() => {
    let pool = tasksInScope(tasks, scope, now);
    if (showCompleted && !(scope.kind === 'smart' && scope.view === 'completed')) {
      pool = [...pool, ...completedFor(tasks, scope, now)];
    }
    if (query.trim()) pool = pool.filter((task) => taskMatches(task, query, lists));
    return pool;
  }, [tasks, scope, now, showCompleted, query, lists]);

  const inList = scope.kind === 'list';
  const isCompletedView = scope.kind === 'smart' && scope.view === 'completed';

  const groups = useMemo<TaskGroup[]>(() => {
    const raw = rawGroups();
    return raw.map((group) => ({
      ...group,
      tasks: isCompletedView ? sortCompleted(group.tasks) : sortTasks(group.tasks, sort),
    }));

    function rawGroups(): TaskGroup[] {
      if (grouping !== 'auto') return groupTasks(visible, grouping, { lists, now });
      if (query.trim()) return [{ key: 'results', title: '', tasks: visible }];
      if (scope.kind === 'list') {
        return groupBySection(
          visible,
          sections.filter((s) => s.listId === scope.listId),
        );
      }
      if (scope.kind === 'smart' && scope.view === 'upcoming') {
        return upcomingDays(visible, { now, days: 14 });
      }
      if (scope.kind === 'smart' && scope.view === 'today') {
        return groupTasks(visible, 'due', { lists, now });
      }
      return [{ key: 'all', title: '', tasks: visible }];
    }
  }, [visible, grouping, scope, sections, lists, sort, now, query, isCompletedView]);

  /** Every visible row, in the order the eye reads them — what arrows walk. */
  const flat = useMemo(() => groups.flatMap((group) => group.tasks), [groups]);

  const selected = useMemo(
    () => tasks.find((t) => t.id === selectedId) ?? null,
    [tasks, selectedId],
  );

  const checkedTasks = useMemo(
    () => tasks.filter((t) => checked.includes(t.id)),
    [tasks, checked],
  );

  /**
   * Keep the cursor where the eye is. When the row under it leaves — ticked
   * off, deleted, filtered out — the cursor takes the row that slid into its
   * place, rather than being thrown back to the top of the list.
   */
  const lastFlat = useRef<string[]>([]);
  useEffect(() => {
    const ids = flat.map((t) => t.id);
    const previous = lastFlat.current;
    lastFlat.current = ids;
    if (cursorId && ids.includes(cursorId)) return;
    const wasAt = cursorId ? previous.indexOf(cursorId) : -1;
    const next = wasAt >= 0 ? ids[Math.min(wasAt, ids.length - 1)] : ids[0];
    setCursorId(next ?? null);
  }, [flat, cursorId]);

  // A reminder that was clicked opens its task, wherever it happens to live.
  useEffect(() => {
    if (!openTaskId) return;
    const task = tasks.find((t) => t.id === openTaskId);
    onTaskOpened();
    if (!task) return;
    if (!tasksInScope(tasks, scope, now).some((t) => t.id === task.id)) {
      patchPrefs({ scope: { kind: 'smart', view: 'all' } });
    }
    setSelectedId(task.id);
    setCursorId(task.id);
  }, [openTaskId, tasks, scope, now, onTaskOpened, patchPrefs]);

  // --- acting ----------------------------------------------------------------

  const remember = useCallback(
    (label: string, snapshot: Task[], options: { deleted?: boolean; lists?: TaskList[] } = {}) => {
      if (!snapshot.length && !options.lists?.length) return;
      setUndo({
        label,
        tasks: snapshot.map((t) => ({ ...t })),
        lists: options.lists?.map((l) => ({ ...l })),
        deleted: options.deleted ?? false,
      });
    },
    [],
  );

  const patchTasks = useCallback(
    (targets: Task[], patch: Partial<Task>, label = 'Task updated') => {
      if (!targets.length) return;
      remember(label, targets);
      void api.updateTasks(
        targets.map((t) => t.id),
        patch,
      );
    },
    [remember],
  );

  const removeTasks = useCallback(
    (targets: Task[]) => {
      if (!targets.length) return;
      remember(targets.length === 1 ? 'Task deleted' : `${targets.length} tasks deleted`, targets, {
        deleted: true,
      });
      const doomed = new Set(targets.map((t) => t.id));
      setChecked((current) => current.filter((id) => !doomed.has(id)));
      if (selectedId && doomed.has(selectedId)) setSelectedId(null);
      void api.deleteTasks([...doomed]);
    },
    [remember, selectedId],
  );

  /**
   * Move several tasks to a day, each keeping the time it was due at — a
   * standup that was due at 9:30 yesterday is due at 9:30 today, not at
   * midnight.
   */
  const rescheduleAll = useCallback(
    (targets: Task[], day: number) => {
      if (!targets.length) return;
      remember(`${targets.length} task${targets.length === 1 ? '' : 's'} moved`, targets);
      for (const task of targets) {
        void api.updateTasks([task.id], {
          dueDate: keepTime(day, task),
          dueHasTime: task.dueHasTime,
        });
      }
    },
    [remember],
  );

  /**
   * Tick tasks off (or put them back) as one act, so undo takes back the whole
   * act rather than the last task in it.
   */
  const completeMany = useCallback(
    (targets: Task[], done: boolean) => {
      const fresh = targets.filter((task) => !pending.current.has(task.id));
      if (!fresh.length) return;
      remember(
        fresh.length === 1
          ? done
            ? 'Task completed'
            : 'Task reopened'
          : `${fresh.length} tasks ${done ? 'completed' : 'reopened'}`,
        fresh,
      );

      if (!done) {
        for (const task of fresh) void api.completeTask(task.id, false);
        return;
      }

      // Let the tick land before the row leaves; a task that vanishes under the
      // cursor reads as a mis-click even when it was not. The pending set is
      // what stops a double click advancing a repeating task twice.
      for (const task of fresh) pending.current.add(task.id);
      setCompleting((current) => {
        const next = { ...current };
        for (const task of fresh) next[task.id] = true;
        return next;
      });
      window.setTimeout(() => {
        for (const task of fresh) {
          void api.completeTask(task.id, true).finally(() => {
            pending.current.delete(task.id);
            setCompleting((current) => {
              const next = { ...current };
              delete next[task.id];
              return next;
            });
          });
        }
      }, TICK_MS);
    },
    [remember],
  );

  const toggleComplete = useCallback(
    (task: Task, done: boolean) => completeMany([task], done),
    [completeMany],
  );

  const runUndo = useCallback(() => {
    if (!undo) return;
    // A replacement, not a patch: undo has to be able to take a date back off a
    // task, and a list has to exist again before its tasks point at it.
    void (async () => {
      if (undo.lists?.length) await api.restoreTaskLists(undo.lists);
      if (undo.tasks.length) await api.restoreTasks(undo.tasks);
    })();
    if (undo.deleted) setSelectedId(undo.tasks[0]?.id ?? null);
    setUndo(null);
  }, [undo]);

  const addTask = useCallback(
    async (draft: QuickAddDraft) => {
      let listId = scope.kind === 'list' ? scope.listId : undefined;
      if (draft.listName) {
        const wanted = draft.listName.toLowerCase();
        const match =
          lists.find((l) => l.name.toLowerCase() === wanted) ??
          lists.find((l) => l.name.toLowerCase().includes(wanted));
        if (match) {
          listId = match.id;
        } else {
          // Typing `#Errands` when there is no Errands list means you want one.
          const created = await unwrap(api.saveTaskList({ name: draft.listName })).catch(() => null);
          listId = created?.id;
        }
      }

      const scopeLabels = scope.kind === 'label' ? [scope.label] : [];
      const defaultDue = defaultDueFor(scope, addTarget, now);

      await api.saveTask({
        title: draft.title,
        listId,
        sectionId: addTarget?.sectionId,
        labels: [...new Set([...scopeLabels, ...draft.labels])],
        priority: draft.priority ?? 'normal',
        dueDate: draft.dueDate ?? defaultDue,
        dueHasTime: draft.dueDate ? (draft.dueHasTime ?? false) : false,
        recurrence: draft.recurrence,
      });
    },
    [scope, lists, addTarget, now],
  );

  const saveList = useCallback(
    (input: { id?: string; name: string; emoji: string; color: string }) => {
      void api.saveTaskList(input);
    },
    [],
  );

  const deleteList = useCallback(
    (listId: string, deleteTasks: boolean) => {
      const list = lists.find((l) => l.id === listId);
      // Whether or not the tasks went with it, the list itself has to come back
      // — otherwise undo restores work into a list that no longer exists.
      remember(
        deleteTasks ? 'List and its tasks deleted' : 'List deleted',
        tasks.filter((t) => t.listId === listId),
        { deleted: deleteTasks, lists: list ? [list] : [] },
      );
      void api.deleteTaskList(listId, deleteTasks);
      patchPrefs({ scope: { kind: 'smart', view: 'today' } });
    },
    [remember, tasks, lists, patchPrefs],
  );

  // --- dragging --------------------------------------------------------------

  const endDrag = useCallback(() => {
    setDragging(null);
    setDropTarget(null);
  }, []);

  const dropOnList = useCallback(
    (listId: string | undefined) => {
      if (!dragging) return;
      const moving = checked.includes(dragging.id) ? checkedTasks : [dragging];
      patchTasks(moving, { listId, sectionId: undefined }, 'Moved');
      endDrag();
    },
    [dragging, checked, checkedTasks, patchTasks, endDrag],
  );

  const dropOnDay = useCallback(
    (day: number) => {
      if (!dragging) return;
      const moving = checked.includes(dragging.id) ? checkedTasks : [dragging];
      patchTasks(moving, { dueDate: keepTime(day, dragging), dueHasTime: dragging.dueHasTime }, 'Rescheduled');
      endDrag();
    },
    [dragging, checked, checkedTasks, patchTasks, endDrag],
  );

  const dropOnRow = useCallback(() => {
    const moved = dragging;
    const target = dropTarget;
    endDrag();
    if (!moved || !target || moved.id === target.id) return;

    const group = groups.find((g) => g.tasks.some((t) => t.id === target.id));
    if (!group) return;

    // Landing in a different group means taking on what that group stands for
    // before worrying about where in it the row sits. A drag that started on a
    // selected row carries the whole selection with it.
    const carried = checked.includes(moved.id) ? checkedTasks : [moved];
    const patch: Partial<Task> = {};
    if (group.day !== undefined && !isSameDay(group.day, moved.dueDate ?? -1)) {
      patch.dueDate = keepTime(group.day, moved);
      patch.dueHasTime = moved.dueHasTime;
    }
    if (inList && group.sectionId !== moved.sectionId) patch.sectionId = group.sectionId;
    if (Object.keys(patch).length) {
      if (carried.length > 1 && patch.dueDate !== undefined) {
        rescheduleAll(carried, patch.dueDate);
      } else {
        patchTasks(carried, patch, 'Moved');
      }
    }

    if (sort !== 'manual') return; // Any other sort would undo the drag anyway.

    const base = group.tasks.some((t) => t.id === moved.id) ? group.tasks : [...group.tasks, moved];
    const without = base.filter((t) => t.id !== moved.id);
    const anchor = without.findIndex((t) => t.id === target.id);
    if (anchor < 0) return;
    const positions = reorderWithin(base, moved.id, anchor + (target.below ? 1 : 0));
    if (positions.length) void api.reorderTasks(positions);
  }, [dragging, dropTarget, groups, inList, sort, checked, checkedTasks, patchTasks, rescheduleAll, endDrag]);

  // --- keyboard --------------------------------------------------------------

  const cursorTask = useMemo(() => flat.find((t) => t.id === cursorId) ?? null, [flat, cursorId]);

  /** What a keystroke acts on: the whole selection, or the row under the cursor. */
  const acting = useMemo(
    () => (checkedTasks.length ? checkedTasks : cursorTask ? [cursorTask] : []),
    [checkedTasks, cursorTask],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          // A `<select>` has its own typeahead; letters belong to it.
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      const mod = e.metaKey || e.ctrlKey;

      // A dialog over the view owns the keyboard — the shortcuts list is not a
      // place where `x` should be selecting rows behind it.
      if (document.querySelector('.scrim')) return;

      // A popover handles its own Escape. Without this, one press closes the
      // date picker *and* the panel behind it, which reads as a double-undo.
      if (e.key === 'Escape' && document.querySelector('.popover')) return;

      // Inside a text box ⌘Z belongs to the text box. Undoing a deletion is
      // never what somebody means while they are mid-sentence.
      if (typing) {
        if (e.key === 'Escape') (target as HTMLElement).blur();
        return;
      }

      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        if (!undo) return;
        e.preventDefault();
        runUndo();
        return;
      }

      if (mod || e.altKey) return;

      const step = (delta: number) => {
        if (!flat.length) return;
        const index = flat.findIndex((t) => t.id === cursorId);
        const next = flat[Math.max(0, Math.min(flat.length - 1, (index < 0 ? 0 : index) + delta))];
        if (!next) return;
        setCursorId(next.id);
        if (selectedId) setSelectedId(next.id);
        document
          .querySelector(`[data-task-id="${next.id}"]`)
          ?.scrollIntoView({ block: 'nearest' });
      };

      switch (e.key) {
        case 'ArrowDown':
        case 'j':
          e.preventDefault();
          step(1);
          return;
        case 'ArrowUp':
        case 'k':
          e.preventDefault();
          step(-1);
          return;
        case 'Enter':
          if (!cursorTask) return;
          e.preventDefault();
          setSelectedId(cursorTask.id);
          return;
        case 'Escape':
          e.preventDefault();
          if (checked.length) setChecked([]);
          else if (selectedId) setSelectedId(null);
          return;
        case 'a':
        case 'n':
          e.preventDefault();
          setAddTarget(null);
          quickAdd.current?.focus();
          return;
        case '/':
          e.preventDefault();
          document.getElementById('todo-search')?.focus();
          return;
        case 'x':
          if (!cursorTask) return;
          e.preventDefault();
          toggleChecked(cursorTask.id, false, false);
          return;
        case 'c': {
          if (!acting.length) return;
          e.preventDefault();
          // One act, so one undo: reopen the finished ones, finish the rest.
          const open = acting.filter((task) => !isCompleted(task));
          completeMany(open.length ? open : acting, open.length > 0);
          setChecked([]);
          return;
        }
        case 'Backspace':
        case 'Delete':
          if (!acting.length) return;
          e.preventDefault();
          removeTasks(acting);
          return;
        case 't':
          if (!acting.length) return;
          e.preventDefault();
          patchTasks(acting, { dueDate: startOfDay(now), dueHasTime: false }, 'Rescheduled');
          return;
        case 'm':
          if (!acting.length) return;
          e.preventDefault();
          patchTasks(acting, { dueDate: startOfDay(addDays(now, 1)), dueHasTime: false }, 'Rescheduled');
          return;
        case 'w':
          if (!acting.length) return;
          e.preventDefault();
          patchTasks(acting, { dueDate: startOfDay(addDays(now, 7)), dueHasTime: false }, 'Rescheduled');
          return;
        case 'r':
          if (!acting.length) return;
          e.preventDefault();
          patchTasks(acting, { dueDate: undefined, dueHasTime: false }, 'Date removed');
          return;
        case '1':
        case '2':
        case '3':
        case '4':
          if (!acting.length) return;
          e.preventDefault();
          patchTasks(acting, { priority: priorityFromNumber(Number(e.key)) }, 'Priority set');
          return;
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat, cursorId, cursorTask, acting, checked, selectedId, undo, now, completeMany]);

  const toggleChecked = (taskId: string, range: boolean, additive: boolean) => {
    setChecked((current) => {
      if (range && current.length) {
        const anchor = flat.findIndex((t) => t.id === current[current.length - 1]);
        const here = flat.findIndex((t) => t.id === taskId);
        if (anchor >= 0 && here >= 0) {
          const [from, to] = anchor < here ? [anchor, here] : [here, anchor];
          const span = flat.slice(from, to + 1).map((t) => t.id);
          return [...new Set([...current, ...span])];
        }
      }
      if (current.includes(taskId)) return current.filter((id) => id !== taskId);
      return additive || current.length ? [...current, taskId] : [taskId];
    });
    setCursorId(taskId);
  };

  // --- chrome ----------------------------------------------------------------

  const list = scope.kind === 'list' ? lists.find((l) => l.id === scope.listId) : undefined;
  const heading =
    scope.kind === 'list'
      ? (list?.name ?? 'List')
      : scope.kind === 'label'
        ? `@${scope.label}`
        : (SMART_VIEW_TITLES[scope.view] ?? 'Tasks');

  const subtitle = describeScope(scope, visible.length, counts.overdue, now);

  return (
    <div className="todo">
      <TaskRail
        lists={lists}
        labels={labels}
        counts={counts}
        scope={scope}
        onScope={(next) => {
          patchPrefs({ scope: next });
          setChecked([]);
          setAddTarget(null);
          setQuery('');
          scroller.current?.scrollTo({ top: 0 });
        }}
        onSaveList={saveList}
        onDeleteList={deleteList}
        onDropOnList={dropOnList}
        dragging={Boolean(dragging)}
      />

      <div className="todo-main">
        <header className="todo-head">
          <div className="todo-head-main">
            <h1>
              {list?.emoji ? <span className="todo-head-emoji">{list.emoji}</span> : null}
              {heading}
            </h1>
            <div className="todo-sub">{subtitle}</div>
          </div>

          <div className="todo-head-actions">
            <input
              id="todo-search"
              className="todo-search"
              placeholder="Filter…"
              value={query}
              aria-label="Filter tasks"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setQuery('');
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
            <div className="todo-menu-anchor">
              <button
                className="ghost"
                title="Sort and group"
                aria-label="Sort and group"
                onClick={() => setMenu(menu === 'sort' ? 'none' : 'sort')}
              >
                ⇅
              </button>
              {menu === 'sort' ? (
                <Popover align="right" onClose={() => setMenu('none')}>
                  <div className="menu">
                    <div className="menu-label">Sort by</div>
                    {TASK_SORTS.map((option) => (
                      <button
                        key={option.sort}
                        className="menu-item"
                        onClick={() => patchPrefs({ sort: option.sort })}
                      >
                        <span className="menu-lead">{option.label}</span>
                        {sort === option.sort ? <span className="menu-hint">✓</span> : null}
                      </button>
                    ))}
                    <div className="menu-sep" />
                    <div className="menu-label">Group by</div>
                    <button className="menu-item" onClick={() => patchPrefs({ grouping: 'auto' })}>
                      <span className="menu-lead">However this view reads best</span>
                      {grouping === 'auto' ? <span className="menu-hint">✓</span> : null}
                    </button>
                    {TASK_GROUPINGS.map((option) => (
                      <button
                        key={option.group}
                        className="menu-item"
                        onClick={() => patchPrefs({ grouping: option.group })}
                      >
                        <span className="menu-lead">{option.label}</span>
                        {grouping === option.group ? <span className="menu-hint">✓</span> : null}
                      </button>
                    ))}
                    {!isCompletedView ? (
                      <>
                        <div className="menu-sep" />
                        <button
                          className="menu-item"
                          onClick={() => patchPrefs({ showCompleted: !showCompleted })}
                        >
                          <span className="menu-lead">Show completed</span>
                          {showCompleted ? <span className="menu-hint">✓</span> : null}
                        </button>
                      </>
                    ) : null}
                  </div>
                </Popover>
              ) : null}
            </div>
          </div>
        </header>

        {scope.kind === 'smart' && scope.view === 'today' && progress.total > 0 ? (
          <div className="todo-progress" title={`${progress.done} of ${progress.total} done today`}>
            <div
              className="todo-progress-bar"
              style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
            />
          </div>
        ) : null}

        {!isCompletedView ? (
          <QuickAdd
            ref={quickAdd}
            lists={lists}
            labels={labels}
            defaultListName={list?.name}
            defaultDue={defaultDueFor(scope, addTarget, now)}
            placeholder={
              addTarget?.sectionId
                ? `Add to ${sections.find((s) => s.id === addTarget.sectionId)?.name ?? 'section'}…`
                : undefined
            }
            onAdd={(draft) => void addTask(draft)}
            onDismiss={() => setAddTarget(null)}
          />
        ) : null}

        <div className="todo-scroll" ref={scroller}>
          {flat.length === 0 ? (
            <EmptyState scope={scope} query={query} onAdd={() => quickAdd.current?.focus()} />
          ) : (
            groups.map((group) => (
              <section className="todo-group" key={group.key}>
                {group.title ? (
                  <div
                    className={`todo-group-head ${group.day !== undefined ? 'droppable' : ''}`}
                    onDragOver={
                      group.day !== undefined
                        ? (e) => {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                          }
                        : undefined
                    }
                    onDrop={
                      group.day !== undefined
                        ? (e) => {
                            e.preventDefault();
                            dropOnDay(group.day!);
                          }
                        : undefined
                    }
                  >
                    <h2>{group.title}</h2>
                    <span className="todo-group-count">{group.tasks.length}</span>
                    {/* A backlog you have to reschedule one at a time is a
                        backlog you stop looking at. */}
                    {group.key === 'overdue' && group.tasks.length > 0 ? (
                      <button
                        className="todo-group-action"
                        onClick={() => rescheduleAll(group.tasks, startOfDay(now))}
                      >
                        Move to today
                      </button>
                    ) : null}
                    {group.sectionId || group.day !== undefined ? (
                      <button
                        className="todo-group-add"
                        title="Add a task here"
                        aria-label={`Add a task to ${group.title}`}
                        onClick={() => {
                          setAddTarget({ sectionId: group.sectionId, day: group.day });
                          quickAdd.current?.focus();
                        }}
                      >
                        ＋
                      </button>
                    ) : null}
                    {group.sectionId ? (
                      <button
                        className="todo-group-remove"
                        title="Remove this section (its tasks stay)"
                        aria-label={`Remove the section ${group.title}`}
                        onClick={() => void api.deleteTaskSection(group.sectionId!)}
                      >
                        ✕
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {group.tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    lists={lists}
                    now={now}
                    showList={!inList}
                    state={{
                      cursor: cursorId === task.id,
                      open: selectedId === task.id,
                      checked: checked.includes(task.id),
                      completing: Boolean(completing[task.id]),
                      scheduling: schedulingId === task.id,
                      dropping:
                        dropTarget?.id === task.id && dragging && dragging.id !== task.id
                          ? dropTarget.below
                            ? 'below'
                            : 'above'
                          : undefined,
                    }}
                    handlers={{
                      onComplete: toggleComplete,
                      onOpen: (t) => {
                        setSelectedId(t.id);
                        setCursorId(t.id);
                      },
                      onCheck: (t, event) => toggleChecked(t.id, event.shiftKey, event.metaKey || event.ctrlKey),
                      onSchedule: (t) => setSchedulingId(t?.id ?? null),
                      onPickDate: (t, dueDate, dueHasTime) => {
                        patchTasks([t], { dueDate, dueHasTime }, 'Rescheduled');
                        setSchedulingId(null);
                      },
                      onDragStart: setDragging,
                      onDragOver: (t, below) => setDropTarget({ id: t.id, below }),
                      onDrop: dropOnRow,
                      onDragEnd: endDrag,
                    }}
                  />
                ))}

                {group.tasks.length === 0 && group.day === undefined ? (
                  <div className="todo-group-empty">Nothing here yet.</div>
                ) : null}
              </section>
            ))
          )}

          {inList ? (
            <div className="todo-section-add">
              {addingSection ? (
                <input
                  autoFocus
                  value={sectionName}
                  placeholder="Section name"
                  aria-label="Section name"
                  onChange={(e) => setSectionName(e.target.value)}
                  onBlur={() => {
                    setAddingSection(false);
                    setSectionName('');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && sectionName.trim()) {
                      e.preventDefault();
                      void api.saveTaskSection({ listId: scope.listId, name: sectionName.trim() });
                      setSectionName('');
                      setAddingSection(false);
                    }
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      setAddingSection(false);
                      setSectionName('');
                    }
                  }}
                />
              ) : (
                <button className="ghost" onClick={() => setAddingSection(true)}>
                  ＋ Add a section
                </button>
              )}
            </div>
          ) : null}
        </div>

        {checked.length ? (
          <div className="todo-bulk">
            <span className="todo-bulk-count">
              {checked.length} selected
            </span>
            <div className="todo-menu-anchor">
              <button onClick={() => setMenu(menu === 'bulk-date' ? 'none' : 'bulk-date')}>Schedule</button>
              {menu === 'bulk-date' ? (
                <DatePicker
                  now={now}
                  onClose={() => setMenu('none')}
                  onPick={(due, hasTime) => {
                    patchTasks(checkedTasks, { dueDate: due, dueHasTime: hasTime }, 'Rescheduled');
                    setChecked([]);
                  }}
                />
              ) : null}
            </div>
            <div className="todo-menu-anchor">
              <button onClick={() => setMenu(menu === 'bulk-priority' ? 'none' : 'bulk-priority')}>
                Priority
              </button>
              {menu === 'bulk-priority' ? (
                <PriorityMenu
                  value={checkedTasks[0]?.priority ?? 'normal'}
                  onClose={() => setMenu('none')}
                  onPick={(priority) => {
                    patchTasks(checkedTasks, { priority }, 'Priority set');
                    setChecked([]);
                  }}
                />
              ) : null}
            </div>
            <div className="todo-menu-anchor">
              <button onClick={() => setMenu(menu === 'bulk-list' ? 'none' : 'bulk-list')}>Move</button>
              {menu === 'bulk-list' ? (
                <ListMenu
                  lists={lists}
                  onClose={() => setMenu('none')}
                  onPick={(listId) => {
                    patchTasks(checkedTasks, { listId, sectionId: undefined }, 'Moved');
                    setChecked([]);
                  }}
                  onCreate={(name) => {
                    void unwrap(api.saveTaskList({ name })).then((created) => {
                      patchTasks(checkedTasks, { listId: created.id, sectionId: undefined }, 'Moved');
                      setChecked([]);
                    });
                  }}
                />
              ) : null}
            </div>
            <button
              onClick={() => {
                const open = checkedTasks.filter((task) => !isCompleted(task));
                completeMany(open.length ? open : checkedTasks, open.length > 0);
                setChecked([]);
              }}
            >
              Complete
            </button>
            <button className="danger" onClick={() => removeTasks(checkedTasks)}>
              Delete
            </button>
            <button className="ghost" onClick={() => setChecked([])}>
              Clear
            </button>
          </div>
        ) : null}

        {undo ? (
          <div className="todo-undo" role="status">
            <span>{undo.label}</span>
            <button onClick={runUndo}>
              Undo <kbd>⌘Z</kbd>
            </button>
          </div>
        ) : null}
      </div>

      {selected ? (
        <TaskDetail
          task={selected}
          lists={lists}
          labels={labels}
          directory={state.directory}
          now={now}
          onClose={() => setSelectedId(null)}
          onPatch={(patch) => patchTasks([selected], patch)}
          onComplete={(done) => toggleComplete(selected, done)}
          onDelete={() => removeTasks([selected])}
          onOpenSource={(task) => {
            if (task.sourceMeetingId) {
              onOpenMeeting(task.sourceMeetingId);
              return;
            }
            if (task.source?.workspaceId && task.source.channelId) {
              onOpenChannel(task.source.workspaceId, task.source.channelId);
            }
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

const SMART_VIEW_TITLES: Record<string, string> = {
  inbox: 'Inbox',
  today: 'Today',
  upcoming: 'Upcoming',
  all: 'All tasks',
  completed: 'Completed',
};

/** Finished tasks that belong to a scope, for the "show completed" toggle. */
function completedFor(tasks: Task[], scope: TaskScope, now: number): Task[] {
  const done = tasks.filter(isCompleted);
  if (scope.kind === 'list') return done.filter((t) => (t.listId ?? '') === scope.listId);
  if (scope.kind === 'label') return done.filter((t) => t.labels.includes(scope.label));
  switch (scope.view) {
    case 'inbox':
      return done.filter((t) => !t.listId);
    case 'today':
      return done.filter((t) => t.completedAt !== undefined && isSameDay(t.completedAt, now));
    case 'all':
      return done;
    default:
      return [];
  }
}

/** The date a task typed into this view should get without being told one. */
function defaultDueFor(
  scope: TaskScope,
  addTarget: { day?: number } | null,
  now: number,
): number | undefined {
  if (addTarget?.day !== undefined) return addTarget.day;
  if (scope.kind !== 'smart') return undefined;
  if (scope.view === 'today') return startOfDay(now);
  if (scope.view === 'upcoming') return startOfDay(addDays(now, 1));
  return undefined;
}

/** Move a task to another day without losing the time it was due at. */
function keepTime(day: number, task: Task): number {
  if (!task.dueHasTime || task.dueDate === undefined) return startOfDay(day);
  const old = new Date(task.dueDate);
  return atTime(day, old.getHours(), old.getMinutes());
}

function describeScope(scope: TaskScope, count: number, overdue: number, now: number): string {
  const things = `${count} task${count === 1 ? '' : 's'}`;
  if (scope.kind === 'label') return things;
  if (scope.kind === 'list') return things;
  switch (scope.view) {
    case 'today': {
      // Short forms: with the detail panel open this line has to survive a
      // narrow column without being cut off mid-word.
      const day = new Date(now).toLocaleDateString([], {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      return overdue > 0 ? `${things} · ${overdue} overdue · ${day}` : `${things} · ${day}`;
    }
    case 'inbox':
      return count ? `${things} to file` : 'Nothing waiting';
    case 'upcoming':
      return `${things} ahead`;
    case 'completed':
      return `${things} finished`;
    default:
      return things;
  }
}

function EmptyState({
  scope,
  query,
  onAdd,
}: {
  scope: TaskScope;
  query: string;
  onAdd: () => void;
}) {
  if (query.trim()) {
    return (
      <div className="todo-empty">
        <div className="todo-empty-mark">⌕</div>
        <p>Nothing matches “{query.trim()}”.</p>
      </div>
    );
  }

  const copy =
    scope.kind === 'list'
      ? { mark: '❑', line: 'This list is empty.', hint: 'Add the first thing that belongs in it.' }
      : scope.kind === 'label'
        ? { mark: '@', line: 'Nothing carries this label right now.', hint: '' }
        : scope.view === 'today'
          ? { mark: '✓', line: 'Nothing due today.', hint: 'Enjoy it, or pull something forward from Upcoming.' }
          : scope.view === 'inbox'
            ? { mark: '❑', line: 'Your inbox is clear.', hint: 'Anything you add without a list lands here.' }
            : scope.view === 'upcoming'
              ? { mark: '▤', line: 'Nothing scheduled ahead.', hint: '' }
              : scope.view === 'completed'
                ? { mark: '✓', line: 'Nothing finished yet.', hint: 'Tick something off and it will keep a record here.' }
                : { mark: '≡', line: 'No open tasks.', hint: 'Add one and it shows up here.' };

  return (
    <div className="todo-empty">
      <div className="todo-empty-mark">{copy.mark}</div>
      <p>{copy.line}</p>
      {copy.hint ? <p className="todo-empty-hint">{copy.hint}</p> : null}
      {scope.kind !== 'label' && !(scope.kind === 'smart' && scope.view === 'completed') ? (
        <button onClick={onAdd}>Add a task</button>
      ) : null}
    </div>
  );
}
