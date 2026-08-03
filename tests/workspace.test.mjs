import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { Workspace, findPersona, seedWorkspace } from '../packages/agent/dist/index.js';
import { freeSlots, intersectSlots, withinWorkingHours, DAY, HOUR, MINUTE } from '../packages/shared/dist/index.js';

import { cleanup, makeTempDir } from './helpers.mjs';

test('two workspaces never share state', async (t) => {
  const dirA = await makeTempDir();
  const dirB = await makeTempDir();
  t.after(() => cleanup([dirA, dirB]));

  const a = await Workspace.open(dirA);
  const b = await Workspace.open(dirB);
  await seedWorkspace(a, findPersona('sarah'));
  await seedWorkspace(b, findPersona('tom'));

  // Regression: a shallow-copied empty db once made every fresh workspace share
  // the same arrays, merging separate people's knowledge bases.
  assert.notEqual(a.profile.address, b.profile.address);
  assert.ok(a.projects.every((p) => !b.projects.some((q) => q.id === p.id)));
  assert.ok(a.artifacts.every((x) => !b.artifacts.some((y) => y.id === x.id)));
  assert.ok(a.tasks.every((x) => !b.tasks.some((y) => y.id === x.id)));
  assert.ok(a.projects.some((p) => p.name === 'Auth Migration'));
  assert.ok(b.projects.some((p) => p.name === 'Mobile Client 4.2'));
  assert.ok(!b.projects.some((p) => p.name === 'Auth Migration'));
});

test('a workspace round-trips through disk', async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanup([dir]));

  const first = await Workspace.open(dir);
  await seedWorkspace(first, findPersona('priya'));
  const note = await first.upsertNote({
    title: 'Private thinking',
    body: 'Not for the meeting.\n\nSecond paragraph with **markdown**.',
    kind: 'idea',
    visibility: 'private',
  });
  await first.flush();

  const second = await Workspace.open(dir);
  assert.equal(second.profile.displayName, 'Priya Nair');
  assert.equal(second.projects.length, first.projects.length);
  assert.equal(second.artifacts.length, first.artifacts.length);

  const reloaded = second.notes.find((n) => n.id === note.id);
  assert.ok(reloaded, 'notes survive a reload');
  assert.equal(reloaded.visibility, 'private');
  assert.equal(reloaded.kind, 'idea');
  assert.match(reloaded.body, /Second paragraph with \*\*markdown\*\*/);

  // Notes are real markdown files, editable outside the app.
  const files = await fs.readdir(path.join(dir, 'notes'));
  assert.ok(files.some((f) => f.endsWith('.md')), 'notes are stored as markdown');
  const raw = await fs.readFile(path.join(dir, 'notes', files.find((f) => f.includes('private-thinking'))), 'utf8');
  assert.match(raw, /^---\n/, 'notes carry frontmatter');
});

test('private material never reaches a meeting digest', async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanup([dir]));
  const ws = await Workspace.open(dir);
  await seedWorkspace(ws, findPersona('dana'));

  const { PersonalAgent, MockProvider } = await import('../packages/agent/dist/index.js');
  const agent = new PersonalAgent({
    workspace: ws,
    relayUrl: 'ws://127.0.0.1:1',
    provider: new MockProvider(),
    autoConnect: false,
  });

  // Dana's headcount note is private; it must be visible to her own agent but
  // never included in what her agent reasons over in front of other people.
  const selfNotes = agent.digest('self').notes.map((n) => n.title);
  const meetingNotes = agent.digest('meeting').notes.map((n) => n.title);
  assert.ok(selfNotes.includes('Headcount will not arrive this quarter'));
  assert.ok(!meetingNotes.includes('Headcount will not arrive this quarter'));

  await agent.shutdown();
});

test('availability lands on a shared lattice and respects working hours', () => {
  // A Monday at 00:00 local.
  const monday = new Date();
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
  monday.setHours(0, 0, 0, 0);
  const windowStart = monday.getTime();

  const workingHours = { days: [1, 2, 3, 4, 5], startMinute: 9 * 60, endMinute: 17 * 60 };
  const slots = freeSlots({
    windowStart,
    windowEnd: windowStart + DAY,
    durationMins: 30,
    workingHours,
    busy: [],
    now: windowStart,
  });

  assert.ok(slots.length > 0);
  for (const slot of slots) {
    assert.ok(withinWorkingHours(slot, workingHours), 'every slot is inside working hours');
    assert.equal(slot.end - slot.start, 30 * MINUTE);
  }

  // Two people with different busy calendars still produce intersectable slots.
  const busyMorning = [{ id: 'x', title: 'busy', start: windowStart + 9 * HOUR, end: windowStart + 12 * HOUR, kind: 'busy' }];
  const other = freeSlots({
    windowStart,
    windowEnd: windowStart + DAY,
    durationMins: 30,
    workingHours,
    busy: busyMorning,
    now: windowStart,
  });
  const common = intersectSlots([slots, other]);
  assert.ok(common.length > 0, 'the two calendars intersect somewhere');
  for (const slot of common) {
    assert.ok(slot.start >= windowStart + 12 * HOUR, 'the intersection avoids the busy block');
  }

  // No common slot when one person is booked solid.
  const solid = freeSlots({
    windowStart,
    windowEnd: windowStart + DAY,
    durationMins: 30,
    workingHours,
    busy: [{ id: 'y', title: 'all day', start: windowStart, end: windowStart + DAY, kind: 'busy' }],
    now: windowStart,
  });
  assert.equal(intersectSlots([slots, solid]).length, 0);
});
