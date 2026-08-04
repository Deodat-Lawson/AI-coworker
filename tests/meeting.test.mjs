/**
 * The load-bearing test: three agents negotiate a time, hold a full meeting
 * without their humans, and each writes its own briefing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanup, once, startAgent, startRelay, until, waitForDirectory } from './helpers.mjs';

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
      a.knowledge.calendar.some((b) => b.meetingId === meeting.id),
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
  const record = dana.knowledge.meeting(meeting.id);
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
    const task = target.knowledge.tasks.find((tk) => tk.id === assignment.task.id);
    assert.ok(task, `${target.persona.key} should have the assigned task saved locally`);
    assert.equal(task.sourceMeetingId, meeting.id);
    assert.equal(task.assignedBy, meeting.chair);
  }

  // The slot is released once the meeting is over.
  for (const a of all) {
    assert.ok(
      !a.knowledge.calendar.some((b) => b.meetingId === meeting.id),
      'the calendar hold should be released after the meeting',
    );
    assert.equal(a.knowledge.meeting(meeting.id).meeting.status, 'completed');
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

  const transcript = dana.knowledge.meeting(meeting.id).transcript;
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

test('a meeting is a thread in the channel it belongs to', async (t) => {
  const relay = await startRelay();
  const dana = await startAgent('dana', relay.url);
  const sarah = await startAgent('sarah', relay.url);
  const all = [dana, sarah];

  t.after(async () => {
    for (const a of all) await a.agent.shutdown();
    await relay.stop();
    await cleanup(all.map((a) => a.dir));
  });

  await waitForDirectory(all.map((a) => a.agent), 2);
  await until(() => dana.agent.workspaces.all[0] && sarah.agent.workspaces.all[0], 'snapshots');

  const workspace = dana.agent.workspaces.all[0];
  const general = [...workspace.channels.values()].find((c) => c.isDefault);
  assert.ok(general, 'the home workspace should have a default channel');

  const scheduled = once(dana.agent, 'meeting.scheduled');
  dana.agent.requestMeeting({
    participants: [sarah.persona.profile.address],
    title: 'Refresh tokens',
    purpose: 'Settle the refresh-token question.',
    urgency: 'asap',
    durationMins: 30,
    workspaceId: workspace.workspace.id,
    channelId: general.id,
  });
  const meeting = await scheduled;

  // A meeting booked from a channel belongs to that channel — there is no
  // separate place for it to happen.
  assert.equal(meeting.channelId, general.id);

  // Booking it put exactly one row in the channel, and that row is the meeting.
  const timeline = () => dana.agent.workspaces.messages(workspace.workspace.id, general.id);
  await until(() => timeline().some((m) => m.meetingId === meeting.id), 'the booking lands in the channel');
  const roots = timeline().filter((m) => m.meetingId === meeting.id && !m.threadRootId);
  assert.equal(roots.length, 1, 'a meeting is one row in the channel, not several');
  const root = roots[0];
  assert.equal(root.kind, 'meeting');
  assert.equal(root.systemEvent, 'meeting_scheduled');

  const ended = Promise.all(all.map((a) => once(a.agent, 'meeting.ended', () => true, 60_000)));
  dana.agent.startMeetingNow(meeting.id);
  await ended;

  // Every turn the agents took is a reply under that row, on both machines.
  for (const who of all) {
    const state = who.agent.workspaces.all[0];
    await until(
      () => (who.agent.workspaces.thread(state.workspace.id, root.id) ?? []).length > 8,
      `${who.persona.key} sees the room as a thread`,
    );
    const replies = who.agent.workspaces.thread(state.workspace.id, root.id);
    for (const reply of replies) {
      assert.equal(reply.kind, 'meeting');
      assert.equal(reply.meetingId, meeting.id);
      assert.equal(reply.threadRootId, root.id);
    }
    assert.ok(
      replies.some((r) => r.systemDetail === 'assignment'),
      'the assignments should be in the channel too',
    );
    assert.ok(
      replies.some((r) => r.systemEvent === 'meeting_ended'),
      'the meeting should close out in its own thread',
    );

    // The turns are replies, so a long meeting never reads as a hundred unread
    // things: the channel timeline still holds one row for it.
    const shown = who.agent.workspaces.messages(state.workspace.id, general.id);
    assert.equal(
      shown.filter((m) => m.meetingId === meeting.id).length,
      1,
      'the timeline keeps one row per meeting',
    );

    // The row has to advertise the room, which means its reply count has to
    // reach the client — the "Open the room" affordance hangs off it.
    const mine = shown.find((m) => m.id === root.id);
    assert.ok(
      mine.replyCount >= replies.length,
      `the meeting row should count its turns, saw ${mine.replyCount} for ${replies.length} replies`,
    );

    // And a meeting must never light up the unread badge turn by turn.
    const read = who.agent.workspaces.read(state.workspace.id, general.id);
    assert.ok(read.unread <= 1, `a meeting should not read as ${read.unread} unread things`);
  }
});

test('a meeting booked with no channel lands in the conversation those people share', async (t) => {
  const relay = await startRelay();
  const dana = await startAgent('dana', relay.url);
  const sarah = await startAgent('sarah', relay.url);
  const all = [dana, sarah];

  t.after(async () => {
    for (const a of all) await a.agent.shutdown();
    await relay.stop();
    await cleanup(all.map((a) => a.dir));
  });

  await waitForDirectory(all.map((a) => a.agent), 2);
  await until(() => dana.agent.workspaces.all[0] && sarah.agent.workspaces.all[0], 'snapshots');
  const workspace = dana.agent.workspaces.all[0];

  const scheduled = once(dana.agent, 'meeting.scheduled');
  dana.agent.requestMeeting({
    participants: [sarah.persona.profile.address],
    title: 'Quick one',
    purpose: 'Sanity-check the rollout order.',
    urgency: 'asap',
    durationMins: 15,
  });
  const meeting = await scheduled;

  // Nobody said where, so it goes where these two already talk to each other
  // rather than into a room invented for the occasion.
  assert.ok(meeting.channelId, 'a meeting always belongs to a channel');
  await until(
    () => dana.agent.workspaces.channel(workspace.workspace.id, meeting.channelId),
    'the conversation to arrive',
  );
  const channel = dana.agent.workspaces.channel(workspace.workspace.id, meeting.channelId);
  assert.equal(channel.kind, 'dm', 'two people share a direct conversation, so that is the room');
  assert.deepEqual(
    [...channel.members].sort(),
    [dana.persona.profile.address, sarah.persona.profile.address].sort(),
  );

  await until(
    () =>
      dana.agent.workspaces
        .messages(workspace.workspace.id, meeting.channelId)
        .some((m) => m.meetingId === meeting.id),
    'the booking to show up in that conversation',
  );
});
