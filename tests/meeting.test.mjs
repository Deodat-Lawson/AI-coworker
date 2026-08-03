/**
 * The load-bearing test: three agents negotiate a time, hold a full meeting
 * without their humans, and each writes its own briefing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanup, once, startAgent, startRelay, waitForDirectory } from './helpers.mjs';

test('three agents schedule and run a meeting end to end', async (t) => {
  const relay = await startRelay();
  const dana = await startAgent('dana', relay.url);
  const sarah = await startAgent('sarah', relay.url);
  const tom = await startAgent('tom', relay.url);
  const all = [dana, sarah, tom];

  t.after(async () => {
    for (const a of all) await a.agent.shutdown();
    await relay.stop();
    await cleanup(all.map((a) => a.dir));
  });

  await waitForDirectory(all.map((a) => a.agent), 3);

  // --- scheduling ---------------------------------------------------------
  const scheduled = Promise.all(all.map((a) => once(a.agent, 'meeting.scheduled')));
  const requested = dana.agent.requestMeeting({
    participants: [sarah.persona.profile.address, tom.persona.profile.address],
    title: 'Auth + mobile sync',
    purpose: 'Decide the refresh-token question and unblock the mobile release.',
    kind: 'standup',
    durationMins: 30,
    urgency: 'asap',
    agenda: ['Auth migration status', 'Mobile 4.2 blocker'],
  });
  assert.equal(requested.ok, true, requested.error);

  const meetings = await scheduled;
  const meeting = meetings[0];
  assert.equal(meeting.participants.length, 3);
  assert.equal(meeting.chair, dana.persona.profile.address, 'the manager should chair by default');
  assert.ok(meeting.start >= Date.now() - 60_000, 'meeting should be booked in the near future');

  // Every agent independently blocked the slot on its own calendar.
  for (const a of all) {
    assert.ok(
      a.workspace.calendar.some((b) => b.meetingId === meeting.id),
      `${a.persona.key} should hold the slot on their calendar`,
    );
  }

  // --- the meeting itself --------------------------------------------------
  const ended = Promise.all(all.map((a) => once(a.agent, 'meeting.ended', () => true, 60_000)));
  dana.agent.startMeetingNow(meeting.id);
  const outcomes = await ended;

  // Each agent produced its own briefing, for its own human.
  for (const [i, outcome] of outcomes.entries()) {
    assert.equal(outcome.meetingId, meeting.id);
    assert.equal(outcome.generatedFor, all[i].persona.profile.address);
    assert.ok(outcome.headline.length > 0, 'briefing needs a headline');
    assert.ok(outcome.summary.length > 0, 'briefing needs a summary');
  }

  // --- the transcript ------------------------------------------------------
  const record = dana.workspace.meeting(meeting.id);
  assert.ok(record, 'the meeting should be saved locally');
  const transcript = record.transcript;
  assert.ok(transcript.length > 8, `transcript should be substantive, got ${transcript.length}`);

  const phases = new Set(transcript.map((e) => e.phase));
  for (const phase of ['opening', 'updates', 'qa', 'decisions', 'wrap']) {
    assert.ok(phases.has(phase), `meeting should have reached the ${phase} phase`);
  }

  // Every non-moderator line came from a participant.
  for (const entry of transcript) {
    if (entry.speaker === 'moderator') continue;
    assert.ok(
      meeting.participants.includes(entry.speaker),
      `unexpected speaker ${entry.speaker}`,
    );
  }

  // The ICs gave updates and showed real artifacts rather than describing them.
  const updates = transcript.filter((e) => e.phase === 'updates' && e.kind === 'utterance');
  assert.ok(updates.length >= 2, 'both ICs should have given an update');
  const shown = transcript.flatMap((e) => e.refs ?? []);
  assert.ok(shown.length > 0, 'at least one real artifact should have been shown');
  for (const ref of shown) {
    assert.ok(ref.artifactId && ref.title, 'artifact refs must be grounded');
  }

  // The chair assigned work and the assignees answered out loud.
  const assignments = transcript.filter((e) => e.kind === 'assignment');
  assert.ok(assignments.length > 0, 'the chair should have assigned work');
  for (const a of assignments) {
    assert.equal(a.speaker, meeting.chair, 'only the chair assigns');
    assert.ok(meeting.participants.includes(a.task.assignee));
    assert.ok(a.task.acceptanceCriteria.length > 0, 'assignments need acceptance criteria');
  }
  const commitments = transcript.filter((e) => e.kind === 'commitment');
  assert.ok(commitments.length > 0, 'assignees should respond to assigned work');

  // Minutes were produced by the chair's agent, not the relay.
  const minutes = transcript.find((e) => e.kind === 'minutes');
  assert.ok(minutes, 'the chair should have recorded minutes');
  assert.equal(minutes.speaker, meeting.chair);

  // --- what the humans get ------------------------------------------------
  for (const assignment of assignments) {
    const target = all.find((a) => a.persona.profile.address === assignment.task.assignee);
    const task = target.workspace.tasks.find((tk) => tk.id === assignment.task.id);
    assert.ok(task, `${target.persona.key} should have the assigned task saved locally`);
    assert.equal(task.sourceMeetingId, meeting.id);
    assert.equal(task.assignedBy, meeting.chair);
  }

  // The slot is released once the meeting is over.
  for (const a of all) {
    assert.ok(
      !a.workspace.calendar.some((b) => b.meetingId === meeting.id),
      'the calendar hold should be released after the meeting',
    );
    assert.equal(a.workspace.meeting(meeting.id).meeting.status, 'completed');
  }
});

test('a question in the room is answered in the room', async (t) => {
  const relay = await startRelay();
  const dana = await startAgent('dana', relay.url);
  const sarah = await startAgent('sarah', relay.url);
  const tom = await startAgent('tom', relay.url);
  const all = [dana, sarah, tom];

  t.after(async () => {
    for (const a of all) await a.agent.shutdown();
    await relay.stop();
    await cleanup(all.map((a) => a.dir));
  });

  await waitForDirectory(all.map((a) => a.agent), 3);
  const scheduled = once(dana.agent, 'meeting.scheduled');
  dana.agent.requestMeeting({
    participants: [sarah.persona.profile.address, tom.persona.profile.address],
    title: 'Blocker clearing',
    purpose: 'Clear cross-team blockers.',
    urgency: 'asap',
    durationMins: 30,
  });
  const meeting = await scheduled;

  // Wait for every agent to finish writing, not just the organizer's.
  const ended = Promise.all(all.map((a) => once(a.agent, 'meeting.ended', () => true, 60_000)));
  dana.agent.startMeetingNow(meeting.id);
  await ended;

  const transcript = dana.workspace.meeting(meeting.id).transcript;
  const questions = transcript.filter((e) => e.kind === 'question');
  assert.ok(questions.length > 0, 'agents should interrogate each other');

  for (const question of questions) {
    const answer = transcript.find(
      (e) => e.kind === 'answer' && e.speaker === question.to && e.to === question.speaker,
    );
    assert.ok(answer, `${question.to} should have answered ${question.speaker} in the room`);
    // The answer must come after the question — this is a live exchange, not a mailbox.
    assert.ok(answer.ts >= question.ts);
  }
});
