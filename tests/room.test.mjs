/**
 * Moderator behaviour under stress: slow agents, absent agents, and agents that
 * try to speak out of turn. The room is the one piece both people depend on, so
 * it has to degrade predictably.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { MeetingRoom } from '../packages/server/dist/index.js';

function makeMeeting(overrides = {}) {
  const now = Date.now();
  return {
    id: 'mtg_test',
    title: 'Test sync',
    purpose: 'Testing',
    kind: 'sync',
    agenda: [],
    chair: 'chair@t',
    participants: ['chair@t', 'ic@t'],
    organizer: 'chair@t',
    start: now,
    end: now + 1800_000,
    status: 'scheduled',
    createdAt: now,
    ...overrides,
  };
}

/** Build a room plus a recorder of everything it sent to each agent. */
function makeRoom(options = {}) {
  const sent = [];
  const room = new MeetingRoom({
    meeting: makeMeeting(options.meeting),
    send: (to, message) => sent.push({ to, message }),
    onEnded: () => {},
    turnTimeoutMs: options.turnTimeoutMs ?? 150,
    maxTurnMs: options.maxTurnMs ?? 600,
    joinTimeoutMs: options.joinTimeoutMs ?? 20,
    ...options.roomOptions,
  });
  const turnsFor = (address) =>
    sent.filter((s) => s.to === address && s.message.type === 'room.turn' && s.message.speaker === address);
  return { room, sent, turnsFor };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a slow agent keeps its turn while it reports progress', async () => {
  const { room, turnsFor, sent } = makeRoom({ turnTimeoutMs: 120, maxTurnMs: 10_000 });
  room.open();
  room.join('chair@t');
  room.join('ic@t');
  await sleep(30);

  assert.equal(turnsFor('chair@t').length, 1, 'the chair opens the meeting');

  // Heartbeat past several timeout windows without yielding.
  for (let i = 0; i < 4; i++) {
    await sleep(70);
    room.heartbeat('chair@t');
  }
  await sleep(40);

  const timedOut = sent.some(
    (s) => s.message.type === 'room.event' && /timed out/.test(s.message.entry?.text ?? ''),
  );
  assert.equal(timedOut, false, 'a heartbeating agent must not lose its turn');
  assert.equal(room.phase, 'opening', 'the room is still waiting on the chair');

  // Once it yields, the room advances normally.
  room.say('chair@t', 'Here is why we are meeting.');
  room.yieldTurn('chair@t');
  await sleep(30);
  assert.equal(room.phase, 'updates');
});

test('a heartbeat cannot hold the floor forever', async () => {
  const { room, sent } = makeRoom({ turnTimeoutMs: 100, maxTurnMs: 250 });
  room.open();
  room.join('chair@t');
  room.join('ic@t');
  await sleep(30);

  // Keep claiming progress well past the hard ceiling.
  for (let i = 0; i < 8; i++) {
    await sleep(60);
    room.heartbeat('chair@t');
  }

  const movedOn = sent.some(
    (s) => s.message.type === 'room.event' && /held the floor too long/.test(s.message.entry?.text ?? ''),
  );
  assert.equal(movedOn, true, 'the room reclaims the floor past maxTurnMs');
});

test('an agent cannot speak out of turn', async () => {
  const { room, sent } = makeRoom();
  room.open();
  room.join('chair@t');
  room.join('ic@t');
  await sleep(30);

  // The chair holds the floor during `opening`; the IC must not be able to
  // inject content, assign work, or record minutes.
  room.say('ic@t', 'butting in');
  room.assign('ic@t', {
    id: 'task_x',
    title: 'work for the chair',
    detail: '',
    assignee: 'chair@t',
    priority: 'normal',
    acceptanceCriteria: [],
  });
  room.recordMinutes('ic@t', { summary: 'my minutes', decisions: [], risks: [], followUps: [] });

  const utterances = sent.filter(
    (s) => s.message.type === 'room.event' && s.message.entry?.speaker === 'ic@t',
  );
  assert.equal(utterances.length, 0, 'nothing from the agent without the floor reaches the room');
  assert.equal(room.collectedAssignments.length, 0);
  assert.equal(room.collectedMinutes, undefined);
});

test('only the chair may assign, and only to people in the room', async () => {
  const { room } = makeRoom({ turnTimeoutMs: 5_000 });
  room.open();
  room.join('chair@t');
  room.join('ic@t');
  await sleep(30);

  // Drive to the decisions phase.
  room.yieldTurn('chair@t'); // opening
  await sleep(20);
  room.yieldTurn('ic@t'); // updates
  await sleep(20);
  room.yieldTurn('chair@t'); // qa: chair passes
  await sleep(20);
  room.yieldTurn('ic@t'); // qa: ic passes
  await sleep(20);
  assert.equal(room.phase, 'decisions');

  room.assign('chair@t', {
    id: 'task_ok',
    title: 'real work',
    detail: '',
    assignee: 'ic@t',
    priority: 'normal',
    acceptanceCriteria: ['done when merged'],
  });
  room.assign('chair@t', {
    id: 'task_outsider',
    title: 'work for a stranger',
    detail: '',
    assignee: 'nobody@elsewhere',
    priority: 'normal',
    acceptanceCriteria: [],
  });

  const assigned = room.collectedAssignments;
  assert.equal(assigned.length, 1, 'an assignment to a non-participant is dropped');
  assert.equal(assigned[0].assignee, 'ic@t');
});

test('the room starts without an agent that never joins', async () => {
  const { room, turnsFor } = makeRoom({ joinTimeoutMs: 40, turnTimeoutMs: 5_000 });
  room.open();
  room.join('chair@t'); // ic@t never joins
  await sleep(120);

  assert.equal(turnsFor('chair@t').length >= 1, true, 'the meeting still runs');
  assert.equal(turnsFor('ic@t').length, 0, 'the absent agent is never given the floor');
});
