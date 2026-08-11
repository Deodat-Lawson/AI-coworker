/**
 * The to-do list's brain.
 *
 * Everything here is pure: dates in, dates out. The store persists tasks, the
 * renderer draws them, and both of them ask this module what a task *means* —
 * whether it is overdue, where it belongs, what "every other tuesday at 3"
 * parses to. Keeping it in one place is what lets the agent and the interface
 * agree: typing "pay rent on the 1st p1" into the quick-add and asking your
 * agent to "add pay rent on the 1st, p1" produce the same task.
 */

import type {
  Recurrence,
  RecurrenceUnit,
  Subtask,
  Task,
  TaskList,
  TaskPriority,
  TaskSection,
  TaskStatus,
} from './domain.js';
import { id } from './util.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Most urgent first, which is also the order they are offered in menus. */
export const TASK_PRIORITIES: TaskPriority[] = ['urgent', 'high', 'normal', 'low'];

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/** P1 … P4, the way every to-do app numbers them. */
export function priorityNumber(priority: TaskPriority): 1 | 2 | 3 | 4 {
  return (PRIORITY_ORDER[priority] + 1) as 1 | 2 | 3 | 4;
}

export function priorityFromNumber(value: number): TaskPriority {
  return TASK_PRIORITIES[Math.min(3, Math.max(0, Math.round(value) - 1))]!;
}

export function priorityRank(priority: TaskPriority): number {
  return PRIORITY_ORDER[priority] ?? 2;
}

export function priorityLabel(priority: TaskPriority): string {
  return `Priority ${priorityNumber(priority)}`;
}

/**
 * List colours are names, not hexes: the stylesheet owns the actual hue so a
 * list looks right in both themes without anybody storing a colour twice.
 */
export const LIST_COLORS = [
  'blue',
  'teal',
  'green',
  'amber',
  'orange',
  'red',
  'pink',
  'purple',
  'slate',
] as const;

export type ListColor = (typeof LIST_COLORS)[number];

export function normalizeListColor(value: string | undefined): ListColor {
  return (LIST_COLORS as readonly string[]).includes(value ?? '')
    ? (value as ListColor)
    : 'blue';
}

/** The Inbox is not a list you can rename or delete, so it has no record. */
export const INBOX_ID = '';

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function endOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export function addDays(ts: number, days: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/**
 * Add months, keeping the day of the month where the target has one. The 31st
 * plus a month is the 30th, not the 1st of the month after — a bill due on the
 * 31st should not wander into the next month twice a year.
 */
export function addMonths(ts: number, months: number): number {
  const d = new Date(ts);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d.getTime();
}

export function isSameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
  );
}

/** Whole days from `a`'s day to `b`'s day. Negative when `b` is earlier. */
export function dayDiff(a: number, b: number): number {
  return Math.round((startOfDay(b) - startOfDay(a)) / 86_400_000);
}

/** Combine a day with a time of day, both taken from local time. */
export function atTime(day: number, hours: number, minutes = 0): number {
  const d = new Date(day);
  d.setHours(hours, minutes, 0, 0);
  return d.getTime();
}

// ---------------------------------------------------------------------------
// What a task is
// ---------------------------------------------------------------------------

export function isCompleted(task: Task): boolean {
  return task.status === 'done' || task.status === 'dropped';
}

export function isOpen(task: Task): boolean {
  return !isCompleted(task);
}

export type DueState = 'none' | 'overdue' | 'today' | 'tomorrow' | 'soon' | 'later';

export function dueState(task: Task, now = Date.now()): DueState {
  if (!task.dueDate) return 'none';
  const days = dayDiff(now, task.dueDate);
  if (days < 0) return 'overdue';
  // A time that has already gone by today is late, even though the day has not.
  if (days === 0) return task.dueHasTime && task.dueDate < now ? 'overdue' : 'today';
  if (days === 1) return 'tomorrow';
  return days <= 7 ? 'soon' : 'later';
}

export function isOverdue(task: Task, now = Date.now()): boolean {
  return isOpen(task) && dueState(task, now) === 'overdue';
}

/** Everything that should be in front of you today: due today, or already late. */
export function isDueToday(task: Task, now = Date.now()): boolean {
  if (!task.dueDate) return false;
  return dayDiff(now, task.dueDate) <= 0;
}

export function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * "Today", "Tomorrow", "Fri", "12 Mar" — the shortest thing that is still
 * unambiguous, with the time appended only when the task actually has one.
 */
export function dueLabel(dueDate: number, hasTime = false, now = Date.now()): string {
  const days = dayDiff(now, dueDate);
  let day: string;
  if (days === 0) day = 'Today';
  else if (days === 1) day = 'Tomorrow';
  else if (days === -1) day = 'Yesterday';
  else if (days > 1 && days < 7) day = new Date(dueDate).toLocaleDateString([], { weekday: 'long' });
  else if (days < -1 && days > -7)
    day = `Last ${new Date(dueDate).toLocaleDateString([], { weekday: 'long' })}`;
  else {
    const sameYear = new Date(dueDate).getFullYear() === new Date(now).getFullYear();
    day = new Date(dueDate).toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      year: sameYear ? undefined : 'numeric',
    });
  }
  return hasTime ? `${day} ${timeLabel(dueDate)}` : day;
}

/** A day heading: "Today · Monday 12 May". */
export function dayHeading(ts: number, now = Date.now()): string {
  const days = dayDiff(now, ts);
  const full = new Date(ts).toLocaleDateString([], {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
  if (days === 0) return `Today · ${full}`;
  if (days === 1) return `Tomorrow · ${full}`;
  return full;
}

export function taskProgress(task: Task): { done: number; total: number } {
  return {
    done: task.subtasks.filter((s) => s.done).length,
    total: task.subtasks.length,
  };
}

/**
 * Fill in fields added after a knowledge base was first written. Tasks predate
 * the to-do list — the ones a meeting created a month ago have no labels, no
 * checklist and no position, and they have to sort somewhere sensible rather
 * than all landing on zero.
 */
export function normalizeTask(task: Task, index = 0): Task {
  const labels = Array.isArray(task.labels) ? task.labels.filter(Boolean) : [];
  const subtasks = Array.isArray(task.subtasks)
    ? task.subtasks.filter((s): s is Subtask => Boolean(s && typeof s.title === 'string'))
    : [];
  const completed = task.status === 'done' || task.status === 'dropped';
  return {
    ...task,
    labels,
    subtasks,
    acceptanceCriteria: Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [],
    order: Number.isFinite(task.order) ? task.order : index,
    // A task finished before the list existed still belongs in the logbook, so
    // fall back to when it was last touched.
    completedAt: completed ? (task.completedAt ?? task.updatedAt) : undefined,
  };
}

export function makeSubtask(title: string, done = false): Subtask {
  return { id: id('sub'), title, done };
}

// ---------------------------------------------------------------------------
// Where a task shows up
// ---------------------------------------------------------------------------

export type SmartView = 'inbox' | 'today' | 'upcoming' | 'all' | 'completed';

export const SMART_VIEWS: { view: SmartView; label: string; icon: string; hint: string }[] = [
  { view: 'inbox', label: 'Inbox', icon: '❑', hint: 'Anything you have not filed yet' },
  { view: 'today', label: 'Today', icon: '★', hint: 'Due today, and anything late' },
  { view: 'upcoming', label: 'Upcoming', icon: '▤', hint: 'The days ahead' },
  { view: 'all', label: 'All tasks', icon: '≡', hint: 'Everything still open' },
  { view: 'completed', label: 'Completed', icon: '✓', hint: 'What you have finished' },
];

export type TaskScope =
  | { kind: 'smart'; view: SmartView }
  | { kind: 'list'; listId: string }
  | { kind: 'label'; label: string };

export function scopeKey(scope: TaskScope): string {
  if (scope.kind === 'smart') return `smart:${scope.view}`;
  if (scope.kind === 'list') return `list:${scope.listId}`;
  return `label:${scope.label}`;
}

/** The tasks a scope holds, before searching, filtering or sorting. */
export function tasksInScope(tasks: Task[], scope: TaskScope, now = Date.now()): Task[] {
  if (scope.kind === 'list') {
    return tasks.filter((t) => isOpen(t) && (t.listId ?? '') === scope.listId);
  }
  if (scope.kind === 'label') {
    return tasks.filter((t) => isOpen(t) && t.labels.includes(scope.label));
  }
  switch (scope.view) {
    case 'inbox':
      return tasks.filter((t) => isOpen(t) && !t.listId);
    case 'today':
      return tasks.filter((t) => isOpen(t) && isDueToday(t, now));
    case 'upcoming':
      return tasks.filter((t) => isOpen(t) && t.dueDate !== undefined && dayDiff(now, t.dueDate) > 0);
    case 'all':
      return tasks.filter(isOpen);
    case 'completed':
      return tasks.filter(isCompleted);
    default:
      return tasks.filter(isOpen);
  }
}

/** Search across the parts of a task a person would expect to search. */
export function taskMatches(task: Task, query: string, lists: TaskList[] = []): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const listName = lists.find((l) => l.id === task.listId)?.name ?? '';
  const haystack = [
    task.title,
    task.detail,
    listName,
    ...task.labels,
    ...task.subtasks.map((s) => s.title),
    ...task.acceptanceCriteria,
  ]
    .join(' ')
    .toLowerCase();
  // Every word has to appear somewhere, so "auth review" finds a task called
  // "review the auth migration" without matching everything containing "the".
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

export type TaskSort = 'manual' | 'due' | 'priority' | 'created' | 'alphabetical';

export const TASK_SORTS: { sort: TaskSort; label: string }[] = [
  { sort: 'manual', label: 'My order' },
  { sort: 'due', label: 'Due date' },
  { sort: 'priority', label: 'Priority' },
  { sort: 'created', label: 'Date added' },
  { sort: 'alphabetical', label: 'Alphabetical' },
];

const NO_DUE = Number.POSITIVE_INFINITY;

export function sortTasks(tasks: Task[], sort: TaskSort): Task[] {
  const out = [...tasks];
  switch (sort) {
    case 'due':
      // Undated work is not late, so it sits after everything with a date
      // rather than pretending to be due at the epoch.
      out.sort(
        (a, b) =>
          (a.dueDate ?? NO_DUE) - (b.dueDate ?? NO_DUE) ||
          priorityRank(a.priority) - priorityRank(b.priority) ||
          a.order - b.order,
      );
      break;
    case 'priority':
      out.sort(
        (a, b) =>
          priorityRank(a.priority) - priorityRank(b.priority) ||
          (a.dueDate ?? NO_DUE) - (b.dueDate ?? NO_DUE) ||
          a.order - b.order,
      );
      break;
    case 'created':
      out.sort((a, b) => b.createdAt - a.createdAt);
      break;
    case 'alphabetical':
      out.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case 'manual':
    default:
      out.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
      break;
  }
  return out;
}

/** The logbook reads newest-first, whatever the sort says. */
export function sortCompleted(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt));
}

/**
 * Where a new task goes: the top of its group, so what you just typed is where
 * you are looking. Positions are spaced so a drag between two neighbours has
 * somewhere to land without renumbering the world.
 */
export const ORDER_STEP = 1000;

export function orderForTop(items: { order: number }[]): number {
  if (!items.length) return ORDER_STEP;
  return Math.min(...items.map((t) => t.order)) - ORDER_STEP;
}

export function orderForBottom(items: { order: number }[]): number {
  if (!items.length) return ORDER_STEP;
  return Math.max(...items.map((t) => t.order)) + ORDER_STEP;
}

/**
 * The order values a drag implies: `moved` lands at `toIndex` of `ordered`.
 * Returns only the tasks whose position actually changed.
 *
 * The group is renumbered by *redealing its own position values* rather than by
 * counting from zero. `order` is one number across the whole knowledge base, so
 * a view is always a filtered slice of it — renumbering a slice 1, 2, 3 would
 * shuffle it past everything that was not on screen. Reusing the slots the
 * group already occupies leaves every task outside it exactly where it was.
 */
export function reorderTasks(
  ordered: Task[],
  movedId: string,
  toIndex: number,
): { id: string; order: number }[] {
  const from = ordered.findIndex((t) => t.id === movedId);
  if (from < 0) return [];
  const next = [...ordered];
  const [moved] = next.splice(from, 1);
  if (!moved) return [];
  next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, moved);

  // Strictly increasing, so two tasks cannot end up on one position and have
  // their order decided by a tiebreak nobody can see.
  const slots: number[] = [];
  for (const value of ordered.map((t) => t.order).sort((a, b) => a - b)) {
    const previous = slots[slots.length - 1];
    slots.push(previous !== undefined && value <= previous ? previous + ORDER_STEP : value);
  }
  // A task dragged in from another group needs one slot more than the group had.
  while (slots.length < next.length) {
    slots.push((slots[slots.length - 1] ?? 0) + ORDER_STEP);
  }

  return next
    .map((task, index) => ({ id: task.id, order: slots[index]! }))
    .filter((entry, index) => next[index]!.order !== entry.order);
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export type TaskGroupBy = 'none' | 'due' | 'priority' | 'list' | 'label' | 'day';

export const TASK_GROUPINGS: { group: TaskGroupBy; label: string }[] = [
  { group: 'none', label: 'Nothing' },
  { group: 'due', label: 'Due date' },
  { group: 'priority', label: 'Priority' },
  { group: 'list', label: 'List' },
  { group: 'label', label: 'Label' },
];

export interface TaskGroup {
  key: string;
  title: string;
  /** Set when the group is a section of a list, so it can be renamed. */
  sectionId?: string;
  /** Set on day groups, so "Today" can be dropped onto. */
  day?: number;
  tasks: Task[];
}

const DUE_BUCKETS: { key: DueState; title: string }[] = [
  { key: 'overdue', title: 'Overdue' },
  { key: 'today', title: 'Today' },
  { key: 'tomorrow', title: 'Tomorrow' },
  { key: 'soon', title: 'This week' },
  { key: 'later', title: 'Later' },
  { key: 'none', title: 'No date' },
];

export function groupTasks(
  tasks: Task[],
  groupBy: TaskGroupBy,
  context: { lists?: TaskList[]; sections?: TaskSection[]; now?: number } = {},
): TaskGroup[] {
  const now = context.now ?? Date.now();
  const lists = context.lists ?? [];

  if (groupBy === 'none') return [{ key: 'all', title: '', tasks }];

  if (groupBy === 'day') {
    const byDay = new Map<number, Task[]>();
    for (const task of tasks) {
      const day = startOfDay(task.dueDate ?? now);
      byDay.set(day, [...(byDay.get(day) ?? []), task]);
    }
    return [...byDay.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([day, group]) => ({
        key: `day:${day}`,
        title: dayHeading(day, now),
        day,
        tasks: group,
      }));
  }

  if (groupBy === 'due') {
    return DUE_BUCKETS.map((bucket) => ({
      key: bucket.key,
      title: bucket.title,
      // Today and Tomorrow name one day each, so they can be dropped onto.
      // "This week" and "Later" name a range, and there is no honest answer to
      // what dropping onto a range should mean.
      day:
        bucket.key === 'today'
          ? startOfDay(now)
          : bucket.key === 'tomorrow'
            ? startOfDay(addDays(now, 1))
            : undefined,
      tasks: tasks.filter((t) => dueState(t, now) === bucket.key),
    })).filter((group) => group.tasks.length > 0);
  }

  if (groupBy === 'priority') {
    return TASK_PRIORITIES.map((priority) => ({
      key: priority,
      title: priorityLabel(priority),
      tasks: tasks.filter((t) => t.priority === priority),
    })).filter((group) => group.tasks.length > 0);
  }

  if (groupBy === 'list') {
    const groups: TaskGroup[] = [
      { key: 'inbox', title: 'Inbox', tasks: tasks.filter((t) => !t.listId) },
      ...[...lists]
        .sort((a, b) => a.order - b.order)
        .map((list) => ({
          key: list.id,
          title: list.name,
          tasks: tasks.filter((t) => t.listId === list.id),
        })),
    ];
    return groups.filter((group) => group.tasks.length > 0);
  }

  // By label, with the unlabelled gathered at the end rather than dropped.
  const labels = [...new Set(tasks.flatMap((t) => t.labels))].sort((a, b) => a.localeCompare(b));
  const groups = labels.map((label) => ({
    key: `label:${label}`,
    title: `@${label}`,
    tasks: tasks.filter((t) => t.labels.includes(label)),
  }));
  const unlabelled = tasks.filter((t) => t.labels.length === 0);
  if (unlabelled.length) groups.push({ key: 'label:', title: 'No label', tasks: unlabelled });
  return groups.filter((group) => group.tasks.length > 0);
}

/**
 * A list, cut into its sections. Tasks with no section come first, unheaded.
 *
 * Empty sections are kept — an empty section is not clutter, it is the thing
 * you drag the first task into. The unheaded group is dropped when it is empty
 * and there are sections, so a fully filed list does not open with a blank gap.
 */
export function groupBySection(tasks: Task[], sections: TaskSection[]): TaskGroup[] {
  const ordered = [...sections].sort((a, b) => a.order - b.order);
  const known = new Set(ordered.map((s) => s.id));
  // A task whose section was deleted underneath it still has to be reachable.
  const loose = tasks.filter((t) => !t.sectionId || !known.has(t.sectionId));
  const groups: TaskGroup[] = [];
  if (loose.length > 0 || ordered.length === 0) {
    groups.push({ key: 'loose', title: '', tasks: loose });
  }
  for (const section of ordered) {
    groups.push({
      key: section.id,
      title: section.name,
      sectionId: section.id,
      tasks: tasks.filter((t) => t.sectionId === section.id),
    });
  }
  return groups;
}

/** Days for the Upcoming view: every day in the window, empty ones included. */
export function upcomingDays(
  tasks: Task[],
  options: { now?: number; days?: number } = {},
): TaskGroup[] {
  const now = options.now ?? Date.now();
  const span = options.days ?? 14;
  const out: TaskGroup[] = [];
  for (let i = 1; i <= span; i += 1) {
    const day = startOfDay(addDays(now, i));
    out.push({
      key: `day:${day}`,
      title: dayHeading(day, now),
      day,
      tasks: tasks.filter((t) => t.dueDate !== undefined && isSameDay(t.dueDate, day)),
    });
  }
  const beyond = tasks.filter((t) => t.dueDate !== undefined && dayDiff(now, t.dueDate) > span);
  if (beyond.length) out.push({ key: 'later', title: 'Later', tasks: beyond });
  return out;
}

// ---------------------------------------------------------------------------
// Repeating
// ---------------------------------------------------------------------------

export function describeRecurrence(rec: Recurrence): string {
  const suffix = rec.from === 'completion' ? ' after completing' : '';
  if (rec.unit === 'week' && rec.weekdays?.length) {
    const names = rec.weekdays
      .slice()
      .sort((a, b) => a - b)
      .map((d) => WEEKDAY_NAMES[d] ?? '');
    if (
      rec.every === 1 &&
      rec.weekdays.length === 5 &&
      [1, 2, 3, 4, 5].every((d) => rec.weekdays!.includes(d))
    ) {
      return 'Every weekday';
    }
    if (rec.every === 2) return `Every other ${names.join(', ')}`;
    if (rec.every > 2) return `Every ${rec.every} weeks on ${names.join(', ')}`;
    return `Every ${names.join(', ')}`;
  }
  const unit = rec.every === 1 ? rec.unit : `${rec.every} ${rec.unit}s`;
  return `Every ${unit}${suffix}`;
}

/**
 * The next date a repeating task falls due.
 *
 * `reference` is what the next occurrence is measured from — the old due date
 * for a task that keeps its rhythm, the moment you ticked it off for one that
 * counts from completion. The result is always strictly later than `after`, so
 * ticking off a task that is three weeks overdue moves it to the next date in
 * the future rather than to one still in the past.
 */
export function nextOccurrence(
  rec: Recurrence,
  reference: number,
  after: number = reference,
): number | null {
  if ((rec.count ?? 0) > 0 && (rec.completions ?? 0) + 1 >= (rec.count ?? 0)) return null;

  const every = Math.max(1, Math.round(rec.every || 1));
  let next = reference;

  // Generous, because the loop also has to walk a long-abandoned daily task
  // back up to the present: 2000 days is five years, 2000 months is a lifetime.
  for (let guard = 0; guard < 2000; guard += 1) {
    if (rec.unit === 'week' && rec.weekdays?.length) {
      const days = [...new Set(rec.weekdays)].sort((a, b) => a - b);
      // Walk forward a day at a time to the next named weekday. Cheap, and it
      // gets "every Monday and Thursday" right without any modular arithmetic.
      let candidate = addDays(next, 1);
      for (let step = 0; step < 7 && !days.includes(new Date(candidate).getDay()); step += 1) {
        candidate = addDays(candidate, 1);
      }
      // "Every other Tuesday" is the next Tuesday, then a week skipped.
      next = every > 1 ? addDays(candidate, (every - 1) * 7) : candidate;
    } else if (rec.unit === 'day') {
      next = addDays(next, every);
    } else if (rec.unit === 'week') {
      next = addDays(next, every * 7);
    } else if (rec.unit === 'month') {
      next = pinToAnchor(addMonths(next, every), rec.anchorDay);
    } else {
      next = pinToAnchor(addMonths(next, every * 12), rec.anchorDay);
    }
    if (next > after) break;
  }

  if (rec.until && next > rec.until) return null;
  return next;
}

/**
 * Put a date back on the day of the month a repeat is anchored to, as far as
 * the month allows. The 31st in February is the 28th; the 31st in March is the
 * 31st again.
 */
function pinToAnchor(ts: number, anchorDay?: number): number {
  if (!anchorDay) return ts;
  const d = new Date(ts);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(anchorDay, lastDay));
  return d.getTime();
}

/**
 * What ticking off a repeating task does: it does not finish, it moves. Returns
 * the patch to apply, or null when the series has run out and it really is done.
 */
export function completeRecurring(
  task: Task,
  completedAt = Date.now(),
): Partial<Task> | null {
  const raw = task.recurrence;
  if (!raw) return null;

  // Remember the day of the month the series is really pinned to the first time
  // it moves, before any clamp can turn a 31st into a 28th for good.
  const rec: Recurrence =
    (raw.unit === 'month' || raw.unit === 'year') && raw.anchorDay === undefined && task.dueDate
      ? { ...raw, anchorDay: new Date(task.dueDate).getDate() }
      : raw;

  const base = rec.from === 'completion' ? completedAt : (task.dueDate ?? completedAt);
  // A task that repeats from completion keeps its time of day: "every 3 days at
  // 9am" should not drift to whenever you happened to tick it.
  const reference =
    rec.from === 'completion' && task.dueDate && task.dueHasTime
      ? atTime(base, new Date(task.dueDate).getHours(), new Date(task.dueDate).getMinutes())
      : base;

  const next = nextOccurrence(rec, reference, completedAt);
  if (next === null) return null;

  return {
    dueDate: next,
    status: 'todo',
    completedAt: undefined,
    // The reminder travels with the date, keeping its offset from the due time.
    remindAt:
      task.remindAt && task.dueDate ? next - (task.dueDate - task.remindAt) : task.remindAt,
    recurrence: { ...rec, completions: (rec.completions ?? 0) + 1 },
    subtasks: task.subtasks.map((s) => ({ ...s, done: false })),
  };
}

// ---------------------------------------------------------------------------
// Quick add
// ---------------------------------------------------------------------------

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  weds: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const MONTHS: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

const WEEKDAY_WORDS = Object.keys(WEEKDAYS).join('|');

/**
 * The weekday words safe to read on their own.
 *
 * "sat", "sun" and "wed" are ordinary English — "I sat on it", "in the sun",
 * "wed the couple" — and a to-do list that turns *Call about the sun room* into
 * a task due Sunday is worse than one that understands less. After "next",
 * "this" or "every" the ambiguity is gone, so those rules keep the full set.
 */
const BARE_WEEKDAYS = Object.fromEntries(
  Object.entries(WEEKDAYS).filter(([word]) => !['sat', 'sun', 'wed', 'weds'].includes(word)),
);
const BARE_WEEKDAY_WORDS = Object.keys(BARE_WEEKDAYS).join('|');

const MONTH_WORDS = Object.keys(MONTHS).join('|');

export type QuickAddChipKind = 'date' | 'time' | 'priority' | 'list' | 'label' | 'repeat';

export interface QuickAddChip {
  kind: QuickAddChipKind;
  /** What to show on the chip — "Tomorrow 5:00 PM", "P1", "#Home". */
  text: string;
  start: number;
  end: number;
}

export interface QuickAddResult {
  title: string;
  dueDate?: number;
  dueHasTime?: boolean;
  priority?: TaskPriority;
  labels: string[];
  /** The name typed after `#`; the caller resolves it to a list, or makes one. */
  listName?: string;
  recurrence?: Recurrence;
  chips: QuickAddChip[];
}

interface Span {
  start: number;
  end: number;
}

/**
 * Read a line of natural-ish language into a task.
 *
 *   "Pay rent tomorrow at 9am p1 #Home @money every month"
 *
 * Anything understood is lifted out of the title, so what is left is the thing
 * you actually have to do. Nothing here throws: an unparseable date is simply
 * part of the title, which is the only behaviour that stays out of the way when
 * somebody is typing fast.
 */
export function parseQuickAdd(
  text: string,
  options: { now?: number } = {},
): QuickAddResult {
  const now = options.now ?? Date.now();
  const chips: QuickAddChip[] = [];
  const taken: Span[] = [];

  const free = (start: number, end: number): boolean =>
    !taken.some((span) => start < span.end && span.start < end);

  const claim = (kind: QuickAddChipKind, match: RegExpExecArray, label: string): void => {
    const start = match.index;
    const end = start + match[0].length;
    taken.push({ start, end });
    chips.push({ kind, text: label, start, end });
  };

  /** First match of `re` that has not already been claimed by an earlier rule. */
  const find = (re: RegExp): RegExpExecArray | null => {
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let match = rx.exec(text);
    while (match) {
      if (free(match.index, match.index + match[0].length)) return match;
      match = rx.exec(text);
    }
    return null;
  };

  const result: QuickAddResult = { title: '', labels: [], chips };

  /**
   * Claim a match that had to include the whitespace in front of it to prove it
   * was a whole token, without eating that whitespace.
   */
  const claimAfterSpace = (kind: QuickAddChipKind, match: RegExpExecArray, label: string): void => {
    const offset = /^\s/.test(match[0]) ? 1 : 0;
    const start = match.index + offset;
    const end = match.index + match[0].length;
    taken.push({ start, end });
    chips.push({ kind, text: label, start, end });
  };

  // --- lists and labels ----------------------------------------------------
  // First, because `#` and `@` are unambiguous and can contain words that later
  // rules would otherwise read as dates ("#friday-standup").
  //
  // Both anchor to the start of a word. Without that, the `@` in an email
  // address is a label and `me@example.com` becomes "me.com" — which is the
  // kind of quiet mangling that makes people stop trusting a parser.

  const listMatch = find(/(?:^|\s)#(?:"([^"]+)"|\[([^\]]+)\]|([\w][\w-]*))/i);
  if (listMatch) {
    const name = (listMatch[1] ?? listMatch[2] ?? listMatch[3] ?? '').trim();
    if (name) {
      result.listName = name;
      claimAfterSpace('list', listMatch, `#${name}`);
    }
  }

  const labelRx = /(?:^|\s)@(?:"([^"]+)"|\[([^\]]+)\]|([\w][\w-]*))/gi;
  for (let match = labelRx.exec(text); match; match = labelRx.exec(text)) {
    if (!free(match.index, match.index + match[0].length)) continue;
    const name = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!name) continue;
    result.labels.push(name);
    claimAfterSpace('label', match, `@${name}`);
    // The match consumed the space that separates it from the next token, so a
    // run like "@a @b" would skip every other one without rewinding.
    labelRx.lastIndex -= 1;
  }

  // --- priority ------------------------------------------------------------

  const priorityMatch = find(/(?:^|\s)(?:p([1-4])|!!([1-4]))(?=\s|$)/i);
  if (priorityMatch) {
    const digit = Number(priorityMatch[1] ?? priorityMatch[2]);
    result.priority = priorityFromNumber(digit);
    claimAfterSpace('priority', priorityMatch, `P${digit}`);
  }

  // --- repeats -------------------------------------------------------------
  // Before dates, so "every monday" is a rhythm rather than next Monday.

  const recurrence = parseRecurrence(text, find, claim);
  if (recurrence) result.recurrence = recurrence.rec;

  // --- the day -------------------------------------------------------------

  const day = parseDay(text, now, find, claim);

  // --- the time ------------------------------------------------------------

  const time = parseTimeOfDay(text, find, claim);

  let due = day?.ts;
  let hasTime = day?.hasTime ?? false;

  if (time) {
    // A time with no day means the next time it comes round: "at 7am" typed in
    // the afternoon is tomorrow morning, not this morning.
    const base = due ?? now;
    let stamped = atTime(base, time.hours, time.minutes);
    if (due === undefined && stamped <= now) stamped = addDays(stamped, 1);
    due = stamped;
    hasTime = true;
  }

  // A repeat with no date needs somewhere to start counting from. "Standup
  // every monday" starts on the next Monday, not on whatever day you typed it.
  if (due === undefined && result.recurrence) {
    const days = result.recurrence.weekdays;
    due = days?.length
      ? Math.min(...days.map((weekday) => nextWeekday(now, weekday, true)))
      : startOfDay(now);
  }

  if (due !== undefined) {
    result.dueDate = due;
    result.dueHasTime = hasTime;
  }

  // --- what is left is the title ------------------------------------------

  result.title = strip(text, taken);
  chips.sort((a, b) => a.start - b.start);
  return result;
}

function strip(text: string, spans: Span[]): string {
  if (!spans.length) return text.trim();
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const span of ordered) {
    if (span.start > cursor) out += text.slice(cursor, span.start);
    cursor = Math.max(cursor, span.end);
  }
  out += text.slice(cursor);
  return out
    .replace(/\s+/g, ' ')
    // Dangling prepositions left behind by lifting a date out of the middle.
    .replace(/\s+(on|at|by|due|due on|due by)\s*$/i, '')
    .replace(/^(on|at|by|due)\s+/i, '')
    .trim();
}

type Finder = (re: RegExp) => RegExpExecArray | null;
type Claimer = (kind: QuickAddChipKind, match: RegExpExecArray, label: string) => void;

function parseRecurrence(
  _text: string,
  find: Finder,
  claim: Claimer,
): { rec: Recurrence } | null {
  // "every!" is Todoist's way of saying "count from when I actually do it".
  // The optional quantifier is what makes "every other tuesday" a fortnightly
  // rhythm rather than a one-off date next Tuesday.
  const listed = find(
    new RegExp(
      `\\bevery(!?)\\s+(other\\s+|\\d+(?:st|nd|rd|th)?\\s+)?((?:${WEEKDAY_WORDS})(?:s\\b)?(?:\\s*(?:,|and|&)\\s*(?:${WEEKDAY_WORDS})(?:s\\b)?)*)\\b`,
      'i',
    ),
  );
  if (listed) {
    const days = (listed[3] ?? '')
      .split(/\s*(?:,|and|&)\s*/i)
      .map((word) => WEEKDAYS[word.trim().toLowerCase().replace(/s$/, '')])
      .filter((d): d is number => d !== undefined);
    if (days.length) {
      const quantity = (listed[2] ?? '').trim().toLowerCase();
      const rec: Recurrence = {
        unit: 'week',
        every: quantity === 'other' ? 2 : Number(quantity.replace(/\D/g, '')) || 1,
        weekdays: [...new Set(days)],
        from: listed[1] ? 'completion' : 'schedule',
      };
      claim('repeat', listed, describeRecurrence(rec));
      return { rec };
    }
  }

  const weekdays = find(/\bevery(!?)\s+weekdays?\b/i);
  if (weekdays) {
    const rec: Recurrence = {
      unit: 'week',
      every: 1,
      weekdays: [1, 2, 3, 4, 5],
      from: weekdays[1] ? 'completion' : 'schedule',
    };
    claim('repeat', weekdays, describeRecurrence(rec));
    return { rec };
  }

  const counted = find(/\bevery(!?)\s+(other\s+|\d+\s+)?(day|week|month|year)s?\b/i);
  if (counted) {
    const quantity = (counted[2] ?? '').trim().toLowerCase();
    const rec: Recurrence = {
      unit: counted[3]!.toLowerCase() as RecurrenceUnit,
      every: quantity === 'other' ? 2 : Number(quantity) || 1,
      from: counted[1] ? 'completion' : 'schedule',
    };
    claim('repeat', counted, describeRecurrence(rec));
    return { rec };
  }

  const named = find(/\b(daily|weekly|biweekly|fortnightly|monthly|quarterly|yearly|annually)\b/i);
  if (named) {
    const word = named[1]!.toLowerCase();
    const table: Record<string, Recurrence> = {
      daily: { unit: 'day', every: 1, from: 'schedule' },
      weekly: { unit: 'week', every: 1, from: 'schedule' },
      biweekly: { unit: 'week', every: 2, from: 'schedule' },
      fortnightly: { unit: 'week', every: 2, from: 'schedule' },
      monthly: { unit: 'month', every: 1, from: 'schedule' },
      quarterly: { unit: 'month', every: 3, from: 'schedule' },
      yearly: { unit: 'year', every: 1, from: 'schedule' },
      annually: { unit: 'year', every: 1, from: 'schedule' },
    };
    const rec = table[word]!;
    claim('repeat', named, describeRecurrence(rec));
    return { rec };
  }

  return null;
}

/** The next date on or after today that falls on `weekday`. */
function nextWeekday(now: number, weekday: number, includeToday: boolean): number {
  const today = startOfDay(now);
  const current = new Date(today).getDay();
  let delta = (weekday - current + 7) % 7;
  if (delta === 0 && !includeToday) delta = 7;
  return addDays(today, delta);
}

function parseDay(
  text: string,
  now: number,
  find: Finder,
  claim: Claimer,
): { ts: number; hasTime: boolean } | null {
  const today = startOfDay(now);

  const tonight = find(/\btonight\b/i);
  if (tonight) {
    claim('date', tonight, 'Tonight');
    return { ts: atTime(today, 20), hasTime: true };
  }

  // Before the bare "tomorrow" rule, which would otherwise claim the word out
  // of the middle of this phrase and leave "day after" in the title.
  const dayAfter = find(/\bday after tomorrow\b/i);
  if (dayAfter) {
    claim('date', dayAfter, 'In 2 days');
    return { ts: addDays(today, 2), hasTime: false };
  }

  // Deliberately no "tom" or "tod": "Call Tom" is a task, not a date.
  const plain = find(/\b(today|tomorrow|tmrw|tmr)\b/i);
  if (plain) {
    const isToday = plain[1]!.toLowerCase() === 'today';
    claim('date', plain, isToday ? 'Today' : 'Tomorrow');
    return { ts: isToday ? today : addDays(today, 1), hasTime: false };
  }

  const iso = find(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const [year, month, dayOfMonth] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    const date = new Date(year, month - 1, dayOfMonth);
    // `2026-13-45` is not a date, and rolling it silently into 2027 is worse
    // than leaving it in the title where the person can see it.
    if (date.getMonth() === month - 1 && date.getDate() === dayOfMonth) {
      claim('date', iso, dueLabel(date.getTime(), false, now));
      return { ts: date.getTime(), hasTime: false };
    }
  }

  // Day/month, the way most of the world writes it outside the US. Ambiguous by
  // nature, so this reads the *first* number as the month only when the second
  // could not be one.
  const slashed = find(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slashed) {
    const a = Number(slashed[1]);
    const b = Number(slashed[2]);
    const year = slashed[3]
      ? Number(slashed[3]) < 100
        ? 2000 + Number(slashed[3])
        : Number(slashed[3])
      : new Date(now).getFullYear();
    const [month, day] = a > 12 ? [b, a] : [a, b];
    const date = new Date(year, month - 1, day);
    if (date.getMonth() === month - 1 && date.getDate() === day) {
      const ts = slashed[3] ? date.getTime() : rollForward(date.getTime(), now);
      claim('date', slashed, dueLabel(ts, false, now));
      return { ts, hasTime: false };
    }
  }

  const monthFirst = find(new RegExp(`\\b(${MONTH_WORDS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'));
  if (monthFirst) {
    const ts = fromMonthDay(MONTHS[monthFirst[1]!.toLowerCase()]!, Number(monthFirst[2]), now);
    if (ts !== null) {
      claim('date', monthFirst, dueLabel(ts, false, now));
      return { ts, hasTime: false };
    }
  }

  const dayFirst = find(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_WORDS})\\b`, 'i'));
  if (dayFirst) {
    const ts = fromMonthDay(MONTHS[dayFirst[2]!.toLowerCase()]!, Number(dayFirst[1]), now);
    if (ts !== null) {
      claim('date', dayFirst, dueLabel(ts, false, now));
      return { ts, hasTime: false };
    }
  }

  // Bounded at four digits: "in 99999999 years" is not a date anybody means,
  // and left unbounded it overflows into a NaN that reaches the store.
  const relativeIn = find(/\bin\s+(a|an|\d{1,4})\s+(day|week|month|year|hour|minute|min)s?\b/i);
  if (relativeIn) {
    const raw = relativeIn[1]!.toLowerCase();
    const count = raw === 'a' || raw === 'an' ? 1 : Number(raw);
    const unit = relativeIn[2]!.toLowerCase();
    let ts: number;
    let hasTime = false;
    if (unit === 'hour') {
      ts = now + count * 3_600_000;
      hasTime = true;
    } else if (unit === 'minute' || unit === 'min') {
      ts = now + count * 60_000;
      hasTime = true;
    } else if (unit === 'day') ts = addDays(today, count);
    else if (unit === 'week') ts = addDays(today, count * 7);
    else if (unit === 'month') ts = addMonths(today, count);
    else ts = addMonths(today, count * 12);
    if (!Number.isFinite(ts)) return null;
    claim('date', relativeIn, hasTime ? dueLabel(ts, true, now) : dueLabel(ts, false, now));
    return { ts, hasTime };
  }

  const nextUnit = find(/\bnext\s+(week|month|year)\b/i);
  if (nextUnit) {
    const unit = nextUnit[1]!.toLowerCase();
    const ts =
      unit === 'week' ? addDays(today, 7) : unit === 'month' ? addMonths(today, 1) : addMonths(today, 12);
    claim('date', nextUnit, dueLabel(ts, false, now));
    return { ts, hasTime: false };
  }

  const qualified = find(new RegExp(`\\b(next|this|coming)\\s+(${WEEKDAY_WORDS})\\b`, 'i'));
  if (qualified) {
    const weekday = WEEKDAYS[qualified[2]!.toLowerCase()]!;
    // "next Friday" means the one in the week after this one; "this Friday" is
    // the one coming up.
    const base = nextWeekday(now, weekday, false);
    const ts = qualified[1]!.toLowerCase() === 'next' ? addDays(base, 7) : base;
    claim('date', qualified, dueLabel(ts, false, now));
    return { ts, hasTime: false };
  }

  const bare = find(new RegExp(`\\b(${BARE_WEEKDAY_WORDS})\\b`, 'i'));
  if (bare) {
    const ts = nextWeekday(now, BARE_WEEKDAYS[bare[1]!.toLowerCase()]!, true);
    claim('date', bare, dueLabel(ts, false, now));
    return { ts, hasTime: false };
  }

  const endOf = find(/\bend of (?:the\s+)?(week|month)\b/i);
  if (endOf) {
    const ts =
      endOf[1]!.toLowerCase() === 'week'
        ? nextWeekday(now, 5, true)
        : startOfDay(new Date(new Date(now).getFullYear(), new Date(now).getMonth() + 1, 0).getTime());
    claim('date', endOf, dueLabel(ts, false, now));
    return { ts, hasTime: false };
  }

  return null;
}

/** A month and day with no year: this year if it is still ahead, else next. */
function fromMonthDay(month: number, day: number, now: number): number | null {
  if (day < 1 || day > 31) return null;
  const year = new Date(now).getFullYear();
  const date = new Date(year, month, day);
  if (date.getMonth() !== month || date.getDate() !== day) return null;
  return rollForward(date.getTime(), now);
}

/** Push a bare date into the future — "5 Jan" typed in March means next year. */
function rollForward(ts: number, now: number): number {
  if (ts >= startOfDay(now)) return ts;
  const d = new Date(ts);
  d.setFullYear(d.getFullYear() + 1);
  return d.getTime();
}

function parseTimeOfDay(
  _text: string,
  find: Finder,
  claim: Claimer,
): { hours: number; minutes: number } | null {
  const named = find(/\b(noon|midday|midnight)\b/i);
  if (named) {
    const word = named[1]!.toLowerCase();
    const hours = word === 'midnight' ? 0 : 12;
    claim('time', named, word === 'midnight' ? 'Midnight' : 'Noon');
    return { hours, minutes: 0 };
  }

  // "at 5", "at 5:30pm", "@ 17:00" — the "at" makes a bare number safe to read
  // as a time, which it is not on its own.
  const explicit = find(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (explicit) {
    const time = toTime(Number(explicit[1]), explicit[2] ? Number(explicit[2]) : 0, explicit[3]);
    if (time) {
      claim('time', explicit, formatParsedTime(time));
      return time;
    }
  }

  const meridiem = find(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (meridiem) {
    const time = toTime(Number(meridiem[1]), meridiem[2] ? Number(meridiem[2]) : 0, meridiem[3]);
    if (time) {
      claim('time', meridiem, formatParsedTime(time));
      return time;
    }
  }

  const clock = find(/\b(\d{1,2}):(\d{2})\b/);
  if (clock) {
    const time = toTime(Number(clock[1]), Number(clock[2]));
    if (time) {
      claim('time', clock, formatParsedTime(time));
      return time;
    }
  }

  const partOfDay = find(/\b(morning|afternoon|evening)\b/i);
  if (partOfDay) {
    const word = partOfDay[1]!.toLowerCase();
    const hours = word === 'morning' ? 9 : word === 'afternoon' ? 14 : 18;
    claim('time', partOfDay, word[0]!.toUpperCase() + word.slice(1));
    return { hours, minutes: 0 };
  }

  return null;
}

function toTime(
  rawHours: number,
  minutes: number,
  meridiem?: string,
): { hours: number; minutes: number } | null {
  if (minutes > 59) return null;
  let hours = rawHours;
  const suffix = meridiem?.toLowerCase();
  if (suffix === 'pm' && hours < 12) hours += 12;
  else if (suffix === 'am' && hours === 12) hours = 0;
  if (hours > 23) return null;
  return { hours, minutes };
}

function formatParsedTime({ hours, minutes }: { hours: number; minutes: number }): string {
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  return timeLabel(d.getTime());
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

export interface TaskCounts {
  inbox: number;
  today: number;
  overdue: number;
  upcoming: number;
  all: number;
  completed: number;
  /** Keyed by list id. */
  byList: Record<string, number>;
  byLabel: Record<string, number>;
}

/** Every badge the sidebar draws, in one pass over the tasks. */
export function countTasks(tasks: Task[], now = Date.now()): TaskCounts {
  const counts: TaskCounts = {
    inbox: 0,
    today: 0,
    overdue: 0,
    upcoming: 0,
    all: 0,
    completed: 0,
    byList: {},
    byLabel: {},
  };
  for (const task of tasks) {
    if (isCompleted(task)) {
      counts.completed += 1;
      continue;
    }
    counts.all += 1;
    if (!task.listId) counts.inbox += 1;
    else counts.byList[task.listId] = (counts.byList[task.listId] ?? 0) + 1;
    for (const label of task.labels) counts.byLabel[label] = (counts.byLabel[label] ?? 0) + 1;
    if (task.dueDate !== undefined) {
      const days = dayDiff(now, task.dueDate);
      if (days <= 0) counts.today += 1;
      else counts.upcoming += 1;
      if (dueState(task, now) === 'overdue') counts.overdue += 1;
    }
  }
  return counts;
}

/** "3 of 8" for the day's progress ring. */
export function dayProgress(tasks: Task[], now = Date.now()): { done: number; total: number } {
  const done = tasks.filter(
    (t) => t.status === 'done' && t.completedAt !== undefined && isSameDay(t.completedAt, now),
  ).length;
  const open = tasks.filter((t) => isOpen(t) && isDueToday(t, now)).length;
  return { done, total: done + open };
}

/** The labels in use, most-used first, for the sidebar and the label picker. */
export function allLabels(tasks: Task[]): string[] {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (!isOpen(task)) continue;
    for (const label of task.labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label]) => label);
}

/** Statuses a person can set by hand; `done` is the checkbox's job. */
export const WORKING_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'blocked'];

export function statusLabel(status: TaskStatus): string {
  switch (status) {
    case 'in_progress':
      return 'In progress';
    case 'blocked':
      return 'Blocked';
    case 'done':
      return 'Done';
    case 'dropped':
      return 'Dropped';
    default:
      return 'To do';
  }
}
