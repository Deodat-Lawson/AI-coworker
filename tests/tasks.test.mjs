/**
 * The to-do list where it is actually kept: on disk, in the knowledge base.
 *
 * `todo.test.mjs` proves the arithmetic. This proves the store — that ticking
 * something off writes what it should, that deleting a list cannot take work
 * with it by accident, and that a knowledge base written before any of this
 * existed still opens.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { KnowledgeBase } from '../packages/agent/dist/index.js';
import { DAY, makeSubtask } from '../packages/shared/dist/index.js';

import { cleanup, makeTempDir } from './helpers.mjs';

async function open(dir) {
  const kb = await KnowledgeBase.open(dir);
  await kb.updateProfile({ address: 'me@here', displayName: 'Me' });
  return kb;
}

test('a task carries everything the to-do list needs, and survives a reload', async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanup([dir]));

  const first = await open(dir);
  const list = await first.upsertTaskList({ name: 'Home', emoji: '🏠', color: 'green' });
  const task = await first.upsertTask({
    title: 'Pay rent',
    listId: list.id,
    labels: ['money'],
    priority: 'urgent',
    dueDate: Date.now() + DAY,
    dueHasTime: true,
    subtasks: [makeSubtask('Check the amount')],
    recurrence: { unit: 'month', every: 1, from: 'schedule' },
  });
  await first.flush();

  const second = await KnowledgeBase.open(dir);
  const reloaded = second.tasks.find((x) => x.id === task.id);
  assert.ok(reloaded, 'the task survived');
  assert.equal(reloaded.listId, list.id);
  assert.deepEqual(reloaded.labels, ['money']);
  assert.equal(reloaded.priority, 'urgent');
  assert.equal(reloaded.dueHasTime, true);
  assert.equal(reloaded.subtasks.length, 1);
  assert.equal(reloaded.recurrence.unit, 'month');
  assert.equal(second.taskLists[0].emoji, '🏠');
  assert.equal(second.taskLists[0].color, 'green');
});

test('completing writes a timestamp, and reopening takes it away', async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanup([dir]));

  const kb = await open(dir);
  const task = await kb.upsertTask({ title: 'Something' });
  assert.equal(task.completedAt, undefined);

  const done = await kb.completeTask(task.id, true);
  assert.equal(done.status, 'done');
  assert.ok(done.completedAt > 0, 'a finished task records when');

  const reopened = await kb.completeTask(task.id, false);
  assert.equal(reopened.status, 'todo');
  assert.equal(reopened.completedAt, undefined, 'reopening clears the completion');
});

test('the status and the completion stamp cannot drift apart', async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanup([dir]));

  const kb = await open(dir);
  const task = await kb.upsertTask({ title: 'Via the detail panel' });

  // The panel sets a status rather than calling complete; the stamp still has
  // to follow, or the logbook shows a task with no date on it.
  const done = await kb.upsertTask({ id: task.id, title: task.title, status: 'done' });
  assert.ok(done.completedAt > 0);

  const back = await kb.upsertTask({ id: task.id, title: task.title, status: 'in_progress' });
  assert.equal(back.completedAt, undefined);
});

test('a repeating task moves on instead of finishing', async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanup([dir]));

  const kb = await open(dir);
  const due = Date.now();
  const task = await kb.upsertTask({
    title: 'Water the plants',
    dueDate: due,
    recurrence: { unit: 'day', every: 2, from: 'schedule' },
  });

  const after = await kb.completeTask(task.id, true);
  assert.equal(after.status, 'todo', 'it stays open');
  assert.ok(after.dueDate > due, 'it moved forward');
  assert.equal(after.recurrence.completions, 1, 'and counted the round');
  assert.equal(after.completedAt, undefined);
});

test('the last occurrence of a bounded repeat really does finish', async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanup([dir]));

  const kb = await open(dir);
  const task = await kb.upsertTask({
    title: 'Take the course',
    dueDate: Date.now(),
    recurrence: { unit: 'week', every: 1, from: 'schedule', count: 2, completions: 1 },
  });

  const after = await kb.completeTask(task.id, true);
  assert.equal(after.status, 'done', 'the series ran out, so this one is done');
  assert.ok(after.completedAt > 0);
});

test('deleting a list never takes work with it unless asked', async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanup([dir]));

  const kb = await open(dir);
  const list = await kb.upsertTaskList({ name: 'Errands' });
  const section = await kb.upsertTaskSection({ listId: list.id, name: 'In town' });
  const kept = await kb.upsertTask({ title: 'Post the parcel', listId: list.id, sectionId: section.id });

  await kb.deleteTaskList(list.id);
  const survivor = kb.tasks.find((x) => x.id === kept.id);
  assert.ok(survivor, 'the task outlived its list');
  assert.equal(survivor.listId, undefined, 'and fell back to the Inbox');
  assert.equal(survivor.sectionId, undefined, 'with no dangling section');
  assert.equal(kb.taskSections.length, 0, 'the list took its sections with it');

  // And when it is asked, it obeys.
  const doomedList = await kb.upsertTaskList({ name: 'Scratch' });
  const doomedTask = await kb.upsertTask({ title: 'Throwaway', listId: doomedList.id });
  await kb.deleteTaskList(doomedList.id, { deleteTasks: true });
  assert.equal(kb.tasks.some((x) => x.id === doomedTask.id), false);
});

test('removing a section keeps its tasks in the list', async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanup([dir]));

  const kb = await open(dir);
  const list = await kb.upsertTaskList({ name: 'Work' });
  const section = await kb.upsertTaskSection({ listId: list.id, name: 'Today' });
  const task = await kb.upsertTask({ title: 'Review the PR', listId: list.id, sectionId: section.id });

  await kb.deleteTaskSection(section.id);
  const after = kb.tasks.find((x) => x.id === task.id);
  assert.equal(after.listId, list.id, 'it stayed in the list');
  assert.equal(after.sectionId, undefined, 'it just lost its heading');
});

test('new work goes to the top of its own list, not the top of everything', async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanup([dir]));

  const kb = await open(dir);
  const list = await kb.upsertTaskList({ name: 'Home' });
  const inboxFirst = await kb.upsertTask({ title: 'Inbox one' });
  const inboxSecond = await kb.upsertTask({ title: 'Inbox two' });
  const homeFirst = await kb.upsertTask({ title: 'Home one', listId: list.id });

  assert.ok(inboxSecond.order < inboxFirst.order, 'the newest inbox task sorts first');
  // The home list starts fresh rather than inheriting the inbox's positions.
  assert.notEqual(homeFirst.order, inboxSecond.order - 1000);
});

test('a drag writes the positions it implies', async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanup([dir]));

  const kb = await open(dir);
  const a = await kb.upsertTask({ title: 'A' });
  const b = await kb.upsertTask({ title: 'B' });

  await kb.reorderTasks([
    { id: a.id, order: 1000 },
    { id: b.id, order: 2000 },
  ]);
  const ordered = kb.tasks.slice().sort((x, y) => x.order - y.order).map((x) => x.title);
  assert.deepEqual(ordered, ['A', 'B']);
});

test('one patch reaches every task a multi-selection holds', async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanup([dir]));

  const kb = await open(dir);
  const first = await kb.upsertTask({ title: 'One' });
  const second = await kb.upsertTask({ title: 'Two' });
  const untouched = await kb.upsertTask({ title: 'Three' });

  const due = Date.now() + DAY;
  await kb.updateTasks([first.id, second.id], { dueDate: due, priority: 'high' });

  assert.equal(kb.tasks.find((x) => x.id === first.id).priority, 'high');
  assert.equal(kb.tasks.find((x) => x.id === second.id).dueDate, due);
  assert.equal(kb.tasks.find((x) => x.id === untouched.id).priority, 'normal');
});

test('putting a deleted task back restores it rather than making a new one', async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanup([dir]));

  const kb = await open(dir);
  const list = await kb.upsertTaskList({ name: 'Home' });
  const original = await kb.upsertTask({
    title: 'Cancel the gym',
    listId: list.id,
    labels: ['money'],
    priority: 'high',
    order: 4000,
  });
  await kb.deleteTask(original.id);
  assert.equal(kb.tasks.length, 0);

  // Undo re-saves the snapshot the view was holding, whole.
  const restored = await kb.upsertTask({ ...original });
  assert.equal(restored.id, original.id, 'the same task, not a copy');
  assert.equal(restored.createdAt, original.createdAt, 'it keeps its age');
  assert.equal(restored.order, original.order, 'and its place in the list');
  assert.equal(restored.listId, list.id);
  assert.deepEqual(restored.labels, ['money']);
  assert.equal(restored.priority, 'high');
});

test('undo can take back something that was added, not just something removed', async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanup([dir]));

  const kb = await open(dir);
  const before = await kb.upsertTask({ title: 'Undated and unfiled' });
  const snapshot = { ...before };

  const list = await kb.upsertTaskList({ name: 'Work' });
  await kb.updateTasks([before.id], {
    dueDate: Date.now() + DAY,
    dueHasTime: true,
    listId: list.id,
    labels: ['added'],
  });

  // A patch can only ever set. Undo has to be able to unset.
  await kb.restoreTasks([snapshot]);
  const after = kb.tasks.find((x) => x.id === before.id);
  assert.equal(after.dueDate, undefined, 'the date it never had is gone again');
  assert.equal(after.listId, undefined, 'and so is the filing');
  assert.deepEqual(after.labels, []);
});

test('undoing a deleted list brings the list back, not just its tasks', async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanup([dir]));

  const kb = await open(dir);
  const list = await kb.upsertTaskList({ name: 'Errands', emoji: '🛒' });
  const task = await kb.upsertTask({ title: 'Buy stamps', listId: list.id });
  const snapshot = { list: { ...list }, task: { ...task } };

  await kb.deleteTaskList(list.id, { deleteTasks: true });
  assert.equal(kb.tasks.length, 0);
  assert.equal(kb.taskLists.length, 0);

  await kb.restoreTaskLists([snapshot.list]);
  await kb.restoreTasks([snapshot.task]);
  assert.equal(kb.taskLists[0].name, 'Errands');
  assert.equal(kb.taskLists[0].emoji, '🛒');
  assert.equal(kb.tasks[0].listId, list.id, 'the task points at a list that exists again');
});

test('finishing a repeating task moves it on however it was finished', async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanup([dir]));

  const kb = await open(dir);
  const due = Date.now();
  const recurrence = { unit: 'day', every: 1, from: 'schedule' };

  // Through the status field — a pill in the panel, or the agent's update_task.
  const viaStatus = await kb.upsertTask({ title: 'Via status', dueDate: due, recurrence });
  const afterStatus = await kb.upsertTask({ id: viaStatus.id, title: viaStatus.title, status: 'done' });
  assert.equal(afterStatus.status, 'todo', 'it did not finish');
  assert.ok(afterStatus.dueDate > due);

  // And through a bulk patch.
  const viaBulk = await kb.upsertTask({ title: 'Via bulk', dueDate: due, recurrence });
  await kb.updateTasks([viaBulk.id], { status: 'done' });
  const afterBulk = kb.tasks.find((x) => x.id === viaBulk.id);
  assert.equal(afterBulk.status, 'todo');
  assert.ok(afterBulk.dueDate > due);
});

test('a reminder already raised stays raised across a restart', async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanup([dir]));

  const first = await open(dir);
  assert.equal(first.wasReminded('task_1:1234'), false);
  await first.markReminded(['task_1:1234']);
  assert.equal(first.wasReminded('task_1:1234'), true);
  await first.flush();

  const second = await KnowledgeBase.open(dir);
  assert.equal(second.wasReminded('task_1:1234'), true, 'a notification you have seen does not come back');
  assert.equal(second.wasReminded('task_1:9999'), false, 'but a rescheduled one does');
});

test('a knowledge base written before the to-do list existed still opens', async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanup([dir]));

  // Exactly the shape the old store wrote: no lists, no sections, and tasks
  // with none of the fields every screen now reads.
  await fs.mkdir(path.join(dir, 'notes'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'db.json'),
    JSON.stringify({
      version: 1,
      projects: [],
      artifacts: [],
      calendar: [],
      feedback: [],
      tasks: [
        {
          id: 'task_old',
          title: 'From a meeting last month',
          detail: '',
          assignee: 'me@here',
          assignedBy: 'chair@here',
          status: 'todo',
          priority: 'normal',
          acceptanceCriteria: ['Ship it'],
          sourceMeetingId: 'meet_1',
          createdAt: 1,
          updatedAt: 2,
        },
        {
          id: 'task_done',
          title: 'Finished before the logbook existed',
          detail: '',
          assignee: 'me@here',
          assignedBy: 'me@here',
          status: 'done',
          priority: 'normal',
          acceptanceCriteria: [],
          createdAt: 1,
          updatedAt: 5000,
        },
      ],
    }),
    'utf8',
  );

  const kb = await KnowledgeBase.open(dir);
  const old = kb.tasks.find((x) => x.id === 'task_old');
  assert.deepEqual(old.labels, [], 'labels were backfilled');
  assert.deepEqual(old.subtasks, [], 'so was the checklist');
  assert.ok(Number.isFinite(old.order), 'and a position');
  assert.deepEqual(old.acceptanceCriteria, ['Ship it'], 'what the meeting agreed is untouched');

  const done = kb.tasks.find((x) => x.id === 'task_done');
  assert.equal(done.completedAt, 5000, 'an old completion reaches the logbook');

  assert.deepEqual(kb.taskLists, []);
  assert.deepEqual(kb.taskSections, []);

  // And the backfill is written back rather than recomputed forever.
  await kb.upsertTask({ id: 'task_old', title: 'From a meeting last month', priority: 'high' });
  await kb.flush();
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'db.json'), 'utf8'));
  assert.ok(Array.isArray(raw.tasks[0].labels), 'the file now carries the new shape');
  assert.ok(Array.isArray(raw.lists), 'and the collections it was missing');
});
