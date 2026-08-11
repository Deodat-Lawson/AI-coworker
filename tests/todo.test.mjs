/**
 * The to-do list's reasoning, checked without a screen.
 *
 * Almost everything that can be wrong about a to-do list is wrong about dates:
 * a repeat that lands in the past, "next Friday" meaning this one, a task that
 * is overdue by a minute but still filed under tomorrow. All of that is pure
 * arithmetic, so all of it is tested here rather than by clicking.
 *
 * Times are built with the local-time `Date` constructor on purpose — the app
 * shows a person their own Tuesday, and a test that pinned everything to UTC
 * would pass in London and fail in Auckland.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addDays,
  addMonths,
  allLabels,
  completeRecurring,
  countTasks,
  dayDiff,
  dayProgress,
  describeRecurrence,
  dueLabel,
  dueState,
  groupBySection,
  groupTasks,
  isOverdue,
  nextOccurrence,
  normalizeTask,
  parseQuickAdd,
  priorityFromNumber,
  priorityNumber,
  reorderTasks,
  scopeKey,
  sortTasks,
  startOfDay,
  taskMatches,
  tasksInScope,
  upcomingDays,
} from '../packages/shared/dist/index.js';

/** A Tuesday, mid-morning, so "tomorrow" and "next Friday" have real answers. */
const NOW = new Date(2026, 2, 10, 9, 30, 0).getTime();

function task(overrides = {}) {
  return normalizeTask({
    id: overrides.id ?? `t-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Something',
    detail: '',
    assignee: 'me@here',
    assignedBy: 'me@here',
    status: 'todo',
    priority: 'normal',
    acceptanceCriteria: [],
    labels: [],
    subtasks: [],
    order: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------

describe('quick add', () => {
  const parse = (text) => parseQuickAdd(text, { now: NOW });

  it('keeps a plain line as the title', () => {
    const result = parse('Buy milk');
    assert.equal(result.title, 'Buy milk');
    assert.equal(result.dueDate, undefined);
    assert.equal(result.priority, undefined);
    assert.deepEqual(result.labels, []);
  });

  it('lifts a day out of the title', () => {
    const result = parse('Call the dentist tomorrow');
    assert.equal(result.title, 'Call the dentist');
    assert.equal(startOfDay(result.dueDate), startOfDay(addDays(NOW, 1)));
    assert.equal(result.dueHasTime, false);
  });

  it('reads a day and a time together', () => {
    const result = parse('Pay rent tomorrow at 9am');
    assert.equal(result.title, 'Pay rent');
    assert.equal(result.dueHasTime, true);
    const due = new Date(result.dueDate);
    assert.equal(due.getHours(), 9);
    assert.equal(due.getMinutes(), 0);
    assert.equal(dayDiff(NOW, result.dueDate), 1);
  });

  it('reads a bare time as the next time it comes round', () => {
    // 7am has already gone by at half past nine, so it means tomorrow morning.
    const morning = parse('Stretch at 7am');
    assert.equal(dayDiff(NOW, morning.dueDate), 1);
    assert.equal(new Date(morning.dueDate).getHours(), 7);

    const evening = parse('Stretch at 7pm');
    assert.equal(dayDiff(NOW, evening.dueDate), 0);
    assert.equal(new Date(evening.dueDate).getHours(), 19);
  });

  it('understands the shapes a clock comes in', () => {
    for (const [text, hours, minutes] of [
      ['Ship it at 17:00', 17, 0],
      ['Ship it 5:30pm', 17, 30],
      ['Ship it at noon', 12, 0],
      ['Ship it at midnight', 0, 0],
      ['Ship it 11am', 11, 0],
    ]) {
      const result = parse(text);
      assert.equal(result.title, 'Ship it', text);
      assert.equal(new Date(result.dueDate).getHours(), hours, text);
      assert.equal(new Date(result.dueDate).getMinutes(), minutes, text);
    }
  });

  it('reads priorities in both spellings', () => {
    assert.equal(parse('Fix the build p1').priority, 'urgent');
    assert.equal(parse('Fix the build p2').priority, 'high');
    assert.equal(parse('Fix the build p3').priority, 'normal');
    assert.equal(parse('Fix the build p4').priority, 'low');
    assert.equal(parse('Fix the build !!1').priority, 'urgent');
    assert.equal(parse('Fix the build p1').title, 'Fix the build');
  });

  it('does not mistake a word for a priority', () => {
    const result = parse('Order p1000 connectors');
    assert.equal(result.priority, undefined);
    assert.equal(result.title, 'Order p1000 connectors');
  });

  it('pulls out a list and any number of labels', () => {
    const result = parse('Book flights #Travel @admin @money');
    assert.equal(result.title, 'Book flights');
    assert.equal(result.listName, 'Travel');
    assert.deepEqual(result.labels, ['admin', 'money']);
  });

  it('takes a multi-word list name in quotes or brackets', () => {
    assert.equal(parse('Draft the memo #"Q3 planning"').listName, 'Q3 planning');
    assert.equal(parse('Draft the memo #[Q3 planning]').listName, 'Q3 planning');
    assert.equal(parse('Draft the memo #[Q3 planning]').title, 'Draft the memo');
  });

  it('does not read a date out of a list name', () => {
    const result = parse('Prep #friday-standup');
    assert.equal(result.listName, 'friday-standup');
    assert.equal(result.dueDate, undefined);
    assert.equal(result.title, 'Prep');
  });

  it('reads every kind of repeat', () => {
    const daily = parse('Water the plants every day');
    assert.deepEqual(
      { unit: daily.recurrence.unit, every: daily.recurrence.every },
      { unit: 'day', every: 1 },
    );
    assert.equal(daily.title, 'Water the plants');

    assert.equal(parse('Standup every weekday').recurrence.weekdays.length, 5);
    assert.deepEqual(parse('Gym every monday and thursday').recurrence.weekdays, [1, 4]);
    assert.equal(parse('Payroll every other week').recurrence.every, 2);
    assert.equal(parse('Review every 3 months').recurrence.unit, 'month');
    assert.equal(parse('Review every 3 months').recurrence.every, 3);
    assert.equal(parse('Backup weekly').recurrence.unit, 'week');
    assert.equal(parse('Taxes annually').recurrence.unit, 'year');
  });

  it('counts a bang-repeat from when you actually do it', () => {
    assert.equal(parse('Change the filter every! 3 months').recurrence.from, 'completion');
    assert.equal(parse('Change the filter every 3 months').recurrence.from, 'schedule');
  });

  it('reads a repeating weekday as a rhythm, and starts it on that weekday', () => {
    const result = parse('Standup every monday');
    assert.equal(result.recurrence.unit, 'week');
    assert.deepEqual(result.recurrence.weekdays, [1]);
    assert.equal(result.title, 'Standup');
    // It needs a first date, and the only sensible one is the next Monday —
    // starting "every monday" on a Tuesday would put it a day out for ever.
    assert.equal(dayDiff(NOW, result.dueDate), 6, 'Tuesday to the coming Monday');
    assert.equal(new Date(result.dueDate).getDay(), 1);
  });

  it('reads a fortnightly weekday', () => {
    const result = parse('Gym every other tuesday');
    assert.equal(result.title, 'Gym');
    assert.equal(result.recurrence.every, 2);
    assert.deepEqual(result.recurrence.weekdays, [2]);
    assert.equal(parse('Payroll every 2 mondays').recurrence.every, 2);
  });

  it('leaves an address alone', () => {
    // The `@` in an email is not a label, and the `#` in "C#" is not a list.
    for (const text of ['Email me@example.com about the demo', 'Reply to sam@stead.app']) {
      const result = parse(text);
      assert.equal(result.title, text, text);
      assert.deepEqual(result.labels, [], text);
    }
    assert.equal(parse('Learn C#basics').listName, undefined);
    assert.equal(parse('Learn C#basics').title, 'Learn C#basics');
  });

  it('does not turn ordinary words into dates', () => {
    // "Call Tom" is a task about a person, and "I sat on it" is not a Saturday.
    for (const text of ['Call Tom', 'Ask Tod about it', 'The sun room needs paint', 'I sat on the report']) {
      const result = parse(text);
      assert.equal(result.dueDate, undefined, text);
      assert.equal(result.title, text, text);
    }
    // After "next", "this" or "every" the ambiguity is gone.
    assert.ok(parse('Mow the lawn this sunday').dueDate);
    assert.ok(parse('Brunch every saturday').recurrence);
  });

  it('reads "day after tomorrow" as itself, not as tomorrow', () => {
    const result = parse('Ship it day after tomorrow');
    assert.equal(result.title, 'Ship it');
    assert.equal(dayDiff(NOW, result.dueDate), 2);
  });

  it('refuses a date that does not exist rather than rolling it over', () => {
    const result = parse('Do it 2026-13-45');
    assert.equal(result.dueDate, undefined);
    assert.equal(result.title, 'Do it 2026-13-45');
  });

  it('never produces an unusable date from an absurd span', () => {
    for (const text of ['in 99999999 years', 'wait in 9999 years']) {
      const result = parse(text);
      assert.ok(
        result.dueDate === undefined || Number.isFinite(result.dueDate),
        `${text} produced ${result.dueDate}`,
      );
    }
  });

  it('separates "this" from "next" weekday', () => {
    const thisFriday = parse('Report this friday');
    const nextFriday = parse('Report next friday');
    assert.equal(dayDiff(NOW, thisFriday.dueDate), 3, 'Tuesday to Friday');
    assert.equal(dayDiff(NOW, nextFriday.dueDate), 10, 'the Friday after');
  });

  it('reads a bare weekday as the next one, today included', () => {
    assert.equal(dayDiff(NOW, parse('Gym tuesday').dueDate), 0, 'today is Tuesday');
    assert.equal(dayDiff(NOW, parse('Gym wednesday').dueDate), 1);
    assert.equal(dayDiff(NOW, parse('Gym monday').dueDate), 6);
  });

  it('reads relative spans', () => {
    assert.equal(dayDiff(NOW, parse('Follow up in 3 days').dueDate), 3);
    assert.equal(dayDiff(NOW, parse('Follow up in 2 weeks').dueDate), 14);
    assert.equal(dayDiff(NOW, parse('Follow up in a month').dueDate), 31);
    const soon = parse('Check the oven in 2 hours');
    assert.equal(soon.dueHasTime, true);
    assert.equal(new Date(soon.dueDate).getHours(), 11);
  });

  it('reads written and numeric dates', () => {
    for (const text of ['Renew the domain jan 5', 'Renew the domain 5 january', 'Renew the domain january 5th']) {
      const result = parse(text);
      assert.equal(result.title, 'Renew the domain', text);
      const due = new Date(result.dueDate);
      assert.equal(due.getMonth(), 0, text);
      assert.equal(due.getDate(), 5, text);
      // January is behind us in March, so it means next January.
      assert.equal(due.getFullYear(), 2027, text);
    }
    const iso = parse('Renew the domain 2026-12-01');
    assert.equal(new Date(iso.dueDate).getMonth(), 11);
    assert.equal(new Date(iso.dueDate).getDate(), 1);
  });

  it('takes everything at once and leaves a clean title', () => {
    const result = parse('Pay rent every month on the 1st at 9am p1 #Home @money');
    assert.equal(result.priority, 'urgent');
    assert.equal(result.listName, 'Home');
    assert.deepEqual(result.labels, ['money']);
    assert.equal(result.recurrence.unit, 'month');
    assert.equal(new Date(result.dueDate).getHours(), 9);
    assert.equal(result.title, 'Pay rent on the 1st');
  });

  it('reports what it understood, so the input can show it', () => {
    const result = parse('Ship the release tomorrow at 5pm p1 #Launch');
    const kinds = result.chips.map((c) => c.kind);
    assert.deepEqual([...kinds].sort(), ['date', 'list', 'priority', 'time']);
    for (const chip of result.chips) {
      assert.ok(chip.end > chip.start, 'a chip covers real text');
      assert.ok(chip.text.length > 0);
    }
  });

  it('leaves nonsense alone rather than guessing', () => {
    const result = parse('Read chapter 3 of 4');
    assert.equal(result.title, 'Read chapter 3 of 4');
    assert.equal(result.dueDate, undefined);
  });

  it('never throws, whatever it is handed', () => {
    for (const text of ['', '   ', '#', '@', 'p', 'every', 'at', 'in 999999999 years', '@@@ ###']) {
      assert.doesNotThrow(() => parse(text), text);
    }
  });
});

// ---------------------------------------------------------------------------

describe('due dates', () => {
  it('names the state of a date', () => {
    assert.equal(dueState(task({ dueDate: addDays(NOW, -1) }), NOW), 'overdue');
    assert.equal(dueState(task({ dueDate: NOW }), NOW), 'today');
    assert.equal(dueState(task({ dueDate: addDays(NOW, 1) }), NOW), 'tomorrow');
    assert.equal(dueState(task({ dueDate: addDays(NOW, 4) }), NOW), 'soon');
    assert.equal(dueState(task({ dueDate: addDays(NOW, 30) }), NOW), 'later');
    assert.equal(dueState(task({}), NOW), 'none');
  });

  it('treats a time that has gone by today as late', () => {
    const earlier = task({ dueDate: NOW - 3_600_000, dueHasTime: true });
    assert.equal(dueState(earlier, NOW), 'overdue');
    // The same task without a time is due some time today, so it is not late.
    const allDay = task({ dueDate: NOW - 3_600_000, dueHasTime: false });
    assert.equal(dueState(allDay, NOW), 'today');
  });

  it('does not call a finished task overdue', () => {
    const done = task({ dueDate: addDays(NOW, -3), status: 'done', completedAt: NOW });
    assert.equal(isOverdue(done, NOW), false);
  });

  it('labels a date the shortest way that is still clear', () => {
    assert.equal(dueLabel(NOW, false, NOW), 'Today');
    assert.equal(dueLabel(addDays(NOW, 1), false, NOW), 'Tomorrow');
    assert.equal(dueLabel(addDays(NOW, -1), false, NOW), 'Yesterday');
    assert.equal(dueLabel(addDays(NOW, 3), false, NOW), 'Friday');
    assert.match(dueLabel(addDays(NOW, 40), false, NOW), /Apr/);
    assert.match(dueLabel(NOW, true, NOW), /Today \d/);
  });

  it('adds months without falling out of the month', () => {
    const jan31 = new Date(2026, 0, 31).getTime();
    assert.equal(new Date(addMonths(jan31, 1)).getMonth(), 1, 'February');
    assert.equal(new Date(addMonths(jan31, 1)).getDate(), 28);
    // And it does not then stay on the 28th for good.
    assert.equal(new Date(addMonths(jan31, 2)).getDate(), 31, 'March');
  });
});

// ---------------------------------------------------------------------------

describe('repeating tasks', () => {
  it('moves to the next date instead of finishing', () => {
    const t = task({
      dueDate: startOfDay(NOW),
      recurrence: { unit: 'day', every: 1, from: 'schedule' },
    });
    const patch = completeRecurring(t, NOW);
    assert.equal(patch.status, 'todo', 'it stays open');
    assert.equal(dayDiff(NOW, patch.dueDate), 1);
    assert.equal(patch.recurrence.completions, 1);
  });

  it('skips past a backlog rather than landing in the past', () => {
    const t = task({
      dueDate: addDays(NOW, -10),
      recurrence: { unit: 'day', every: 1, from: 'schedule' },
    });
    const patch = completeRecurring(t, NOW);
    assert.ok(patch.dueDate > NOW, 'the next date is ahead of now');
    assert.equal(dayDiff(NOW, patch.dueDate), 1);
  });

  it('counts from completion when told to', () => {
    const t = task({
      dueDate: addDays(NOW, -10),
      recurrence: { unit: 'day', every: 3, from: 'completion' },
    });
    const patch = completeRecurring(t, NOW);
    assert.equal(dayDiff(NOW, patch.dueDate), 3, 'three days from today, not from the old date');
  });

  it('keeps the time of day when counting from completion', () => {
    const nineAm = new Date(2026, 2, 1, 9, 0).getTime();
    const t = task({
      dueDate: nineAm,
      dueHasTime: true,
      recurrence: { unit: 'day', every: 3, from: 'completion' },
    });
    const patch = completeRecurring(t, NOW);
    assert.equal(new Date(patch.dueDate).getHours(), 9);
  });

  it('walks named weekdays in order', () => {
    const rec = { unit: 'week', every: 1, weekdays: [1, 4], from: 'schedule' };
    const tuesday = startOfDay(NOW);
    const thursday = nextOccurrence(rec, tuesday, tuesday);
    assert.equal(new Date(thursday).getDay(), 4);
    const monday = nextOccurrence(rec, thursday, thursday);
    assert.equal(new Date(monday).getDay(), 1);
  });

  it('stops when the series runs out', () => {
    const bounded = task({
      dueDate: startOfDay(NOW),
      recurrence: { unit: 'day', every: 1, from: 'schedule', count: 2, completions: 1 },
    });
    assert.equal(completeRecurring(bounded, NOW), null, 'the last one really is the last');

    const expired = task({
      dueDate: startOfDay(NOW),
      recurrence: { unit: 'week', every: 1, from: 'schedule', until: addDays(NOW, 3) },
    });
    assert.equal(completeRecurring(expired, NOW), null);
  });

  it('resets the checklist for the next round', () => {
    const t = task({
      dueDate: startOfDay(NOW),
      recurrence: { unit: 'week', every: 1, from: 'schedule' },
      subtasks: [
        { id: 's1', title: 'One', done: true },
        { id: 's2', title: 'Two', done: true },
      ],
    });
    const patch = completeRecurring(t, NOW);
    assert.deepEqual(patch.subtasks.map((s) => s.done), [false, false]);
  });

  it('carries the reminder along with the date', () => {
    const due = new Date(2026, 2, 12, 17, 0).getTime();
    const t = task({
      dueDate: due,
      dueHasTime: true,
      remindAt: due - 3_600_000,
      recurrence: { unit: 'week', every: 1, from: 'schedule' },
    });
    const patch = completeRecurring(t, NOW);
    assert.equal(patch.dueDate - patch.remindAt, 3_600_000, 'still an hour before');
  });

  it('keeps a monthly repeat pinned to the day it was set on', () => {
    // The 31st is the 28th in February and the 31st again in March. Letting the
    // clamp become the new anchor walks a bill up the calendar for ever.
    let current = task({
      dueDate: new Date(2026, 0, 31).getTime(),
      recurrence: { unit: 'month', every: 1, from: 'schedule' },
    });
    const days = [];
    for (let i = 0; i < 5; i += 1) {
      const patch = completeRecurring(current, current.dueDate);
      current = { ...current, ...patch };
      days.push(new Date(current.dueDate).getDate());
    }
    assert.deepEqual(days, [28, 31, 30, 31, 30], 'Feb, Mar, Apr, May, Jun');
  });

  it('skips a week for a fortnightly weekday', () => {
    const tuesday = new Date(2026, 7, 11).getTime();
    const current = task({
      dueDate: tuesday,
      recurrence: { unit: 'week', every: 2, weekdays: [2], from: 'schedule' },
    });
    const patch = completeRecurring(current, tuesday);
    assert.equal(dayDiff(tuesday, patch.dueDate), 14);
    assert.equal(new Date(patch.dueDate).getDay(), 2);
  });

  it('says what it does in words', () => {
    assert.equal(describeRecurrence({ unit: 'day', every: 1, from: 'schedule' }), 'Every day');
    assert.equal(describeRecurrence({ unit: 'week', every: 2, from: 'schedule' }), 'Every 2 weeks');
    assert.equal(
      describeRecurrence({ unit: 'week', every: 1, weekdays: [1, 2, 3, 4, 5], from: 'schedule' }),
      'Every weekday',
    );
    assert.equal(
      describeRecurrence({ unit: 'week', every: 1, weekdays: [1, 4], from: 'schedule' }),
      'Every Monday, Thursday',
    );
  });
});

// ---------------------------------------------------------------------------

describe('views', () => {
  const tasks = [
    task({ id: 'inbox-1', title: 'Unfiled' }),
    task({ id: 'late', title: 'Late', dueDate: addDays(NOW, -2), listId: 'work' }),
    task({ id: 'today', title: 'Today', dueDate: NOW, listId: 'work' }),
    task({ id: 'soon', title: 'Soon', dueDate: addDays(NOW, 2), listId: 'home', labels: ['errand'] }),
    task({ id: 'done', title: 'Finished', status: 'done', completedAt: NOW, listId: 'work' }),
  ];

  it('puts unfiled work in the inbox and nothing else', () => {
    const inbox = tasksInScope(tasks, { kind: 'smart', view: 'inbox' }, NOW);
    assert.deepEqual(inbox.map((t) => t.id), ['inbox-1']);
  });

  it('shows today what is due today and what is late', () => {
    const today = tasksInScope(tasks, { kind: 'smart', view: 'today' }, NOW);
    assert.deepEqual(today.map((t) => t.id).sort(), ['late', 'today']);
  });

  it('keeps today out of upcoming', () => {
    const upcoming = tasksInScope(tasks, { kind: 'smart', view: 'upcoming' }, NOW);
    assert.deepEqual(upcoming.map((t) => t.id), ['soon']);
  });

  it('separates open from completed', () => {
    assert.equal(tasksInScope(tasks, { kind: 'smart', view: 'all' }, NOW).length, 4);
    assert.deepEqual(
      tasksInScope(tasks, { kind: 'smart', view: 'completed' }, NOW).map((t) => t.id),
      ['done'],
    );
  });

  it('scopes to a list without dragging its finished work back in', () => {
    const work = tasksInScope(tasks, { kind: 'list', listId: 'work' }, NOW);
    assert.deepEqual(work.map((t) => t.id).sort(), ['late', 'today']);
  });

  it('scopes to a label', () => {
    assert.deepEqual(
      tasksInScope(tasks, { kind: 'label', label: 'errand' }, NOW).map((t) => t.id),
      ['soon'],
    );
  });

  it('gives each scope a stable key', () => {
    assert.equal(scopeKey({ kind: 'smart', view: 'today' }), 'smart:today');
    assert.equal(scopeKey({ kind: 'list', listId: 'work' }), 'list:work');
    assert.equal(scopeKey({ kind: 'label', label: 'errand' }), 'label:errand');
  });

  it('counts everything the sidebar shows in one pass', () => {
    const counts = countTasks(tasks, NOW);
    assert.equal(counts.inbox, 1);
    assert.equal(counts.today, 2);
    assert.equal(counts.overdue, 1);
    assert.equal(counts.upcoming, 1);
    assert.equal(counts.all, 4);
    assert.equal(counts.completed, 1);
    assert.equal(counts.byList.work, 2);
    assert.equal(counts.byLabel.errand, 1);
  });

  it('measures the day as done over due', () => {
    const progress = dayProgress(tasks, NOW);
    assert.equal(progress.done, 1);
    assert.equal(progress.total, 3, 'one finished today plus two still due');
  });

  it('lists the labels in use, busiest first', () => {
    const many = [
      task({ labels: ['home'] }),
      task({ labels: ['home', 'errand'] }),
      task({ labels: ['errand'] }),
      task({ labels: ['zzz'] }),
      task({ labels: ['ignored'], status: 'done' }),
    ];
    assert.deepEqual(allLabels(many), ['errand', 'home', 'zzz']);
  });

  it('lays the days ahead out one at a time, gaps included', () => {
    const days = upcomingDays(tasks, { now: NOW, days: 5 });
    assert.equal(days.length, 5);
    assert.equal(days[1].tasks.length, 1, 'the task two days out');
    assert.equal(days[0].tasks.length, 0, 'tomorrow is empty and still shown');
    assert.match(days[0].title, /Tomorrow/);
  });
});

// ---------------------------------------------------------------------------

describe('order', () => {
  it('sorts undated work after dated work rather than before it', () => {
    const list = [
      task({ id: 'none', order: 0 }),
      task({ id: 'later', dueDate: addDays(NOW, 5), order: 1 }),
      task({ id: 'sooner', dueDate: addDays(NOW, 1), order: 2 }),
    ];
    assert.deepEqual(
      sortTasks(list, 'due').map((t) => t.id),
      ['sooner', 'later', 'none'],
    );
  });

  it('sorts by priority, then by date', () => {
    const list = [
      task({ id: 'normal-soon', priority: 'normal', dueDate: NOW }),
      task({ id: 'urgent-late', priority: 'urgent', dueDate: addDays(NOW, 9) }),
      task({ id: 'urgent-soon', priority: 'urgent', dueDate: NOW }),
    ];
    assert.deepEqual(
      sortTasks(list, 'priority').map((t) => t.id),
      ['urgent-soon', 'urgent-late', 'normal-soon'],
    );
  });

  it('keeps manual order stable', () => {
    const list = [task({ id: 'c', order: 300 }), task({ id: 'a', order: 100 }), task({ id: 'b', order: 200 })];
    assert.deepEqual(sortTasks(list, 'manual').map((t) => t.id), ['a', 'b', 'c']);
  });

  it('renumbers only what a drag actually moved', () => {
    const list = [task({ id: 'a', order: 1000 }), task({ id: 'b', order: 2000 }), task({ id: 'c', order: 3000 })];
    const moves = reorderTasks(list, 'c', 0);
    const byId = Object.fromEntries(moves.map((m) => [m.id, m.order]));
    assert.equal(byId.c, 1000);
    assert.equal(byId.a, 2000);
    assert.equal(byId.b, 3000);
    // Dropping something back where it started is not a change.
    assert.deepEqual(reorderTasks(list, 'a', 0), []);
  });

  it('redeals the positions a group already holds, disturbing nothing else', () => {
    // `order` is one number across the whole knowledge base, so a view is a
    // filtered slice of it. Renumbering the slice from scratch would shove it
    // past everything not on screen; reusing its own slots cannot.
    const shown = [task({ id: 'a', order: 4000 }), task({ id: 'b', order: 9000 })];
    const moves = reorderTasks(shown, 'b', 0);
    assert.deepEqual(
      moves.slice().sort((x, y) => x.id.localeCompare(y.id)),
      [
        { id: 'a', order: 9000 },
        { id: 'b', order: 4000 },
      ],
      'they swap slots rather than both landing near zero',
    );
  });

  it('lands a task dragged in from another group where it was dropped', () => {
    const group = [task({ id: 'a', order: 1000 }), task({ id: 'b', order: 2000 })];
    const incoming = task({ id: 'c', order: 77 });
    const rows = [...group, incoming];
    const moves = reorderTasks(rows, 'c', 1);

    // What matters is the sequence the person sees afterwards, not the numbers.
    const applied = rows.map((t) => ({
      id: t.id,
      order: moves.find((m) => m.id === t.id)?.order ?? t.order,
    }));
    applied.sort((x, y) => x.order - y.order);
    assert.deepEqual(applied.map((t) => t.id), ['a', 'c', 'b']);
  });

  it('never invents a position when the group has none spare', () => {
    // Two rows, three tasks after a cross-group drop: the slots have to grow.
    const rows = [task({ id: 'a', order: 1000 }), task({ id: 'b', order: 2000 }), task({ id: 'c', order: 2000 })];
    const moves = reorderTasks(rows, 'c', 2);
    const orders = rows.map((t) => moves.find((m) => m.id === t.id)?.order ?? t.order);
    assert.equal(new Set(orders).size, 3, 'every task ends on a position of its own');
  });

  it('ignores a drag of something that is not there', () => {
    assert.deepEqual(reorderTasks([task({ id: 'a' })], 'ghost', 0), []);
  });
});

// ---------------------------------------------------------------------------

describe('grouping', () => {
  const lists = [
    { id: 'work', name: 'Work', emoji: '', color: 'blue', order: 1, archived: false, createdAt: 0, updatedAt: 0 },
    { id: 'home', name: 'Home', emoji: '', color: 'green', order: 2, archived: false, createdAt: 0, updatedAt: 0 },
  ];

  it('groups by due bucket, dropping the empty buckets', () => {
    const groups = groupTasks(
      [task({ dueDate: addDays(NOW, -1) }), task({ dueDate: NOW }), task({})],
      'due',
      { now: NOW },
    );
    assert.deepEqual(groups.map((g) => g.title), ['Overdue', 'Today', 'No date']);
  });

  it('groups by list with the inbox first', () => {
    const groups = groupTasks(
      [task({ listId: 'home' }), task({}), task({ listId: 'work' })],
      'list',
      { lists, now: NOW },
    );
    assert.deepEqual(groups.map((g) => g.title), ['Inbox', 'Work', 'Home']);
  });

  it('groups by label and keeps the unlabelled', () => {
    const groups = groupTasks([task({ labels: ['a'] }), task({})], 'label', { now: NOW });
    assert.deepEqual(groups.map((g) => g.title), ['@a', 'No label']);
  });

  it('shows an empty section so there is somewhere to drop', () => {
    const sections = [
      { id: 's1', listId: 'work', name: 'Doing', order: 1 },
      { id: 's2', listId: 'work', name: 'Later', order: 2 },
    ];
    const groups = groupBySection([task({ sectionId: 's1' })], sections);
    assert.deepEqual(groups.map((g) => g.title), ['Doing', 'Later']);
    assert.equal(groups[1].tasks.length, 0);
  });

  it('does not lose a task whose section was deleted', () => {
    const groups = groupBySection([task({ id: 'orphan', sectionId: 'gone' })], [
      { id: 's1', listId: 'work', name: 'Doing', order: 1 },
    ]);
    assert.equal(groups[0].key, 'loose');
    assert.deepEqual(groups[0].tasks.map((t) => t.id), ['orphan']);
  });
});

// ---------------------------------------------------------------------------

describe('searching and backfilling', () => {
  it('matches every word, anywhere on the task', () => {
    const t = task({ title: 'Review the auth migration', labels: ['deep-work'], detail: 'ask Dana' });
    assert.equal(taskMatches(t, 'auth review'), true);
    assert.equal(taskMatches(t, 'dana'), true);
    assert.equal(taskMatches(t, 'deep-work'), true);
    assert.equal(taskMatches(t, 'auth billing'), false);
    assert.equal(taskMatches(t, '   '), true, 'an empty search matches everything');
  });

  it('searches the list name too', () => {
    const lists = [
      { id: 'work', name: 'Work', emoji: '', color: 'blue', order: 1, archived: false, createdAt: 0, updatedAt: 0 },
    ];
    assert.equal(taskMatches(task({ listId: 'work' }), 'work', lists), true);
  });

  it('fills in fields a task written before the list existed has never had', () => {
    const old = normalizeTask({
      id: 'old',
      title: 'From a meeting',
      detail: '',
      assignee: 'me@here',
      assignedBy: 'chair@here',
      status: 'done',
      priority: 'normal',
      createdAt: 1,
      updatedAt: 5000,
    }, 7);
    assert.deepEqual(old.labels, []);
    assert.deepEqual(old.subtasks, []);
    assert.deepEqual(old.acceptanceCriteria, []);
    assert.equal(old.order, 7, 'it keeps its place in the file rather than piling onto zero');
    assert.equal(old.completedAt, 5000, 'a task finished long ago still reaches the logbook');
  });

  it('does not stamp a completion on something still open', () => {
    assert.equal(normalizeTask(task({ status: 'todo' })).completedAt, undefined);
  });

  it('numbers priorities the way people say them', () => {
    assert.equal(priorityNumber('urgent'), 1);
    assert.equal(priorityNumber('low'), 4);
    assert.equal(priorityFromNumber(1), 'urgent');
    assert.equal(priorityFromNumber(9), 'low', 'out of range clamps rather than throwing');
  });
});
