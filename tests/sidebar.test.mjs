/**
 * The sidebar somebody arranged.
 *
 * The layout is stored as a diff from the default, so the interesting failures
 * are all about *what happens to a channel nobody mentioned*: one created after
 * the layout was written, one that was starred since, one whose section was
 * deleted. Every test here checks the same invariant from a different angle —
 * every channel is drawn exactly once, and nothing a person arranged is undone
 * behind their back.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultSections,
  moveSection,
  naturalSection,
  newSection,
  normalizeSections,
  placeChannel,
  removeSection,
  resolveSections,
  unfileChannel,
  updateSection,
} from '../packages/shared/dist/index.js';

function channel(id, overrides = {}) {
  return {
    id,
    kind: 'public',
    starred: false,
    isMeeting: false,
    archived: false,
    lastMessageAt: 0,
    name: id,
    ...overrides,
  };
}

/** Every channel that ended up drawn, in order, flattened across sections. */
function drawn(sections) {
  return sections.flatMap((s) => s.channels);
}

test('with no stored layout, channels land in the group they belong to', () => {
  const channels = [
    channel('general'),
    channel('secret', { kind: 'private' }),
    channel('dana', { kind: 'dm' }),
    channel('standup', { isMeeting: true }),
    channel('launch', { starred: true }),
  ];
  const sections = resolveSections(undefined, channels);
  const find = (builtin) => sections.find((s) => s.builtin === builtin);

  assert.deepEqual(find('channels').channels.sort(), ['general', 'secret']);
  assert.deepEqual(find('dms').channels, ['dana']);
  assert.deepEqual(find('meetings').channels, ['standup']);
  assert.deepEqual(find('starred').channels, ['launch']);
});

test('a meeting is a meeting even when it is starred', () => {
  assert.equal(naturalSection(channel('x', { isMeeting: true, starred: true })), 'meetings');
  assert.equal(naturalSection(channel('x', { starred: true })), 'starred');
  assert.equal(naturalSection(channel('x', { kind: 'group_dm' })), 'dms');
});

test('every channel is drawn exactly once', () => {
  const channels = ['a', 'b', 'c', 'd'].map((id) => channel(id));
  const stored = [
    { ...newSection({ name: 'Mine', id: 'mine' }), channels: ['a', 'b'] },
    // 'b' listed twice across two sections is a layout that got out of step;
    // it must resolve to one row, not two.
    { ...newSection({ name: 'Also', id: 'also' }), channels: ['b', 'c'] },
  ];
  const list = drawn(resolveSections(stored, channels));

  assert.deepEqual([...list].sort(), ['a', 'b', 'c', 'd']);
  assert.equal(new Set(list).size, list.length, 'no channel appears twice');
});

test('a channel filed by hand stays where it was put, even after it is starred', () => {
  const stored = [{ ...newSection({ name: 'Launch', id: 'launch' }), channels: ['design'] }];
  const sections = resolveSections(stored, [channel('design', { starred: true }), channel('general')]);

  assert.deepEqual(sections.find((s) => s.id === 'launch').channels, ['design']);
  assert.equal(
    sections.find((s) => s.builtin === 'starred'),
    undefined,
    'an empty built-in group is not drawn at all',
  );
});

test('an empty section somebody made is kept — it is a place they are about to fill', () => {
  const stored = [newSection({ name: 'Clients', id: 'clients' })];
  const sections = resolveSections(stored, [channel('general')]);
  assert.ok(sections.find((s) => s.id === 'clients'), 'the named empty section survives');
});

test('a channel that has gone away is dropped from the layout it was in', () => {
  const stored = [{ ...newSection({ name: 'Mine', id: 'mine' }), channels: ['gone', 'here'] }];
  const sections = resolveSections(stored, [channel('here')]);
  assert.deepEqual(sections.find((s) => s.id === 'mine').channels, ['here']);
});

test('a channel created after the layout was written still appears', () => {
  const stored = [{ ...newSection({ name: 'Mine', id: 'mine' }), channels: ['old'] }];
  const sections = resolveSections(stored, [channel('old'), channel('brand-new')]);
  assert.ok(drawn(sections).includes('brand-new'));
});

test('deleting the group a channel belongs to brings the group back rather than losing it', () => {
  // A stored layout that has no `dms` group at all, with a DM to place.
  const stored = [{ ...newSection({ name: 'Only', id: 'only' }), channels: [] }].concat(
    defaultSections().filter((s) => s.builtin !== 'dms'),
  );
  const sections = resolveSections(stored, [channel('dana', { kind: 'dm' })]);
  assert.ok(drawn(sections).includes('dana'), 'the DM is still reachable');
});

test('moving a channel takes it out of wherever it was', () => {
  const sections = [
    { ...newSection({ name: 'A', id: 'a' }), channels: ['x', 'y'] },
    { ...newSection({ name: 'B', id: 'b' }), channels: [] },
  ];
  const moved = placeChannel(sections, 'x', 'b');
  assert.deepEqual(moved.find((s) => s.id === 'a').channels, ['y']);
  assert.deepEqual(moved.find((s) => s.id === 'b').channels, ['x']);
});

test('a channel can be dropped at a position, not just appended', () => {
  const sections = [{ ...newSection({ name: 'A', id: 'a' }), channels: ['x', 'y', 'z'] }];
  assert.deepEqual(placeChannel(sections, 'z', 'a', 0)[0].channels, ['z', 'x', 'y']);
  assert.deepEqual(placeChannel(sections, 'x', 'a', 99)[0].channels, ['y', 'z', 'x']);
});

test('unfiling a channel sends it back to its natural group', () => {
  const stored = [{ ...newSection({ name: 'Mine', id: 'mine' }), channels: ['dana'] }];
  const after = unfileChannel(stored, 'dana');
  const sections = resolveSections(after, [channel('dana', { kind: 'dm' })]);
  assert.deepEqual(sections.find((s) => s.builtin === 'dms').channels, ['dana']);
});

test('sections can be reordered, and a built-in one cannot be deleted', () => {
  const sections = normalizeSections([
    newSection({ name: 'Mine', id: 'mine' }),
    ...defaultSections(),
  ]);
  const moved = moveSection(sections, 'mine', 2);
  assert.equal(moved[2].id, 'mine');

  const afterDelete = removeSection(moved, 'builtin:channels');
  assert.ok(
    afterDelete.some((s) => s.builtin === 'channels'),
    'the standard groups are not deletable',
  );
  assert.ok(!removeSection(moved, 'mine').some((s) => s.id === 'mine'));
});

test('renaming is bounded, and an empty name is refused', () => {
  const sections = [newSection({ name: 'Mine', id: 'mine' })];
  assert.equal(updateSection(sections, 'mine', { name: '' })[0].name, 'Mine');
  assert.equal(updateSection(sections, 'mine', { name: 'x'.repeat(80) })[0].name.length, 40);
});

test('a layout written before a group existed still shows that group', () => {
  const stored = [{ ...newSection({ name: 'Mine', id: 'mine' }), channels: [] }];
  const normalized = normalizeSections(stored);
  for (const builtin of ['starred', 'channels', 'meetings', 'dms']) {
    assert.ok(normalized.some((s) => s.builtin === builtin), `${builtin} was restored`);
  }
});

test('built-in groups sort themselves; DMs by recency, channels by name', () => {
  const sections = resolveSections(undefined, [
    channel('zebra'),
    channel('apple'),
    channel('old-dm', { kind: 'dm', lastMessageAt: 10 }),
    channel('new-dm', { kind: 'dm', lastMessageAt: 99 }),
  ]);
  assert.deepEqual(sections.find((s) => s.builtin === 'channels').channels, ['apple', 'zebra']);
  assert.deepEqual(sections.find((s) => s.builtin === 'dms').channels, ['new-dm', 'old-dm']);
});
