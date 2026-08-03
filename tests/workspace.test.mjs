import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanup, startAgent, startRelay, until } from './helpers.mjs';

/** Boot a relay and N seeded agents on it, cleaning up after the test. */
async function scene(t, personas) {
  const relay = await startRelay();
  const agents = [];
  for (const key of personas) agents.push(await startAgent(key, relay.url));
  t.after(async () => {
    for (const a of agents) await a.agent.shutdown();
    await relay.stop();
    await cleanup(agents.map((a) => a.dir));
  });
  return { relay, agents };
}

const home = (agent) => agent.workspaces.all[0];
const channelNamed = (agent, name) =>
  home(agent)
    ? [...home(agent).channels.values()].find((c) => c.name === name)
    : undefined;

test('everyone who connects lands in a shared home workspace', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah']);
  const [dana, sarah] = agents;

  await until(() => home(dana.agent) && home(sarah.agent), 'both snapshots');

  assert.equal(home(dana.agent).workspace.id, home(sarah.agent).workspace.id);
  assert.ok(channelNamed(dana.agent, 'general'), '#general exists');
  assert.ok(channelNamed(dana.agent, 'random'), '#random exists');

  // The first person on a fresh relay owns it; the second is an ordinary member.
  assert.equal(home(dana.agent).me.role, 'owner');
  assert.equal(home(sarah.agent).me.role, 'member');

  await until(() => home(dana.agent).members.size === 2, 'both members visible');
  assert.ok(home(dana.agent).members.get(sarah.knowledge.address));
});

test('a message posted in a channel reaches everyone in it', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah']);
  const [dana, sarah] = agents;
  await until(() => channelNamed(sarah.agent, 'general'), 'sarah sees #general');

  const workspaceId = home(dana.agent).workspace.id;
  const general = channelNamed(dana.agent, 'general');
  dana.agent.sendMessage({ workspaceId, channelId: general.id, text: 'Morning all — standup at 10.' });

  const seen = await until(
    () =>
      sarah.agent.workspaces
        .messages(workspaceId, general.id)
        .find((m) => m.text.startsWith('Morning all')),
    'sarah receives the message',
  );
  assert.equal(seen.author, dana.knowledge.address);

  // Unread for the reader, not for the author.
  await until(() => sarah.agent.workspaces.read(workspaceId, general.id)?.unread === 1, 'unread');
  assert.equal(dana.agent.workspaces.read(workspaceId, general.id)?.unread ?? 0, 0);

  sarah.agent.markRead(workspaceId, general.id);
  await until(() => sarah.agent.workspaces.read(workspaceId, general.id)?.unread === 0, 'read');
});

test('a mention counts as a mention, plain traffic does not', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah']);
  const [dana, sarah] = agents;
  await until(() => channelNamed(sarah.agent, 'general'), 'sarah sees #general');

  const workspaceId = home(dana.agent).workspace.id;
  const general = channelNamed(dana.agent, 'general');
  const notified = new Promise((resolve) => sarah.agent.once('notification', resolve));

  dana.agent.sendMessage({ workspaceId, channelId: general.id, text: 'unrelated chatter' });
  dana.agent.sendMessage({ workspaceId, channelId: general.id, text: '@sarah can you take the SSO edge case?' });

  const read = await until(
    () => {
      const r = sarah.agent.workspaces.read(workspaceId, general.id);
      return r && r.unread === 2 ? r : null;
    },
    'both messages',
  );
  assert.equal(read.mentions, 1, 'only the message naming her counts');

  const notification = await notified;
  assert.equal(notification.workspaceId, workspaceId);
  assert.match(notification.body, /chatter|SSO/);
});

test('private channels are invisible until you are added', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah']);
  const [dana, sarah] = agents;
  await until(() => home(sarah.agent), 'sarah snapshot');

  const workspaceId = home(dana.agent).workspace.id;
  dana.agent.createChannel(workspaceId, { name: 'comp-planning', kind: 'private', topic: 'Not for everyone' });

  const secret = await until(() => channelNamed(dana.agent, 'comp-planning'), 'channel created');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(channelNamed(sarah.agent, 'comp-planning'), undefined, 'sarah cannot see it');

  dana.agent.sendMessage({ workspaceId, channelId: secret.id, text: 'bands are locked' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(sarah.agent.workspaces.messages(workspaceId, secret.id).length, 0);

  dana.agent.addToChannel(workspaceId, secret.id, [sarah.knowledge.address]);
  await until(() => channelNamed(sarah.agent, 'comp-planning'), 'sarah is added');
  await until(
    () => sarah.agent.workspaces.messages(workspaceId, secret.id).some((m) => m.text === 'bands are locked'),
    'history arrives with the invitation',
  );
});

test('a second workspace keeps its own people and channels', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah', 'tom']);
  const [dana, sarah, tom] = agents;
  await until(() => home(dana.agent) && home(sarah.agent) && home(tom.agent), 'snapshots');

  dana.agent.createWorkspace({ name: 'Design Partners', channels: ['launch'] });
  const created = await until(
    () => dana.agent.workspaces.all.find((s) => s.workspace.name === 'Design Partners'),
    'workspace created',
  );

  // Nobody else is in it yet.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(sarah.agent.workspaces.all.length, 1);
  assert.equal(created.members.size, 1);

  const invite = await new Promise((resolve) => {
    dana.agent.workspaces.once('invite', resolve);
    dana.agent.createInvite(created.workspace.id, { invitedAddress: sarah.knowledge.address });
  });

  // The invitation names Sarah, so Tom cannot spend it.
  tom.agent.joinWorkspace({ code: invite.code });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(tom.agent.workspaces.all.length, 1, 'tom stays out');

  sarah.agent.joinWorkspace({ code: invite.code });
  const sarahSide = await until(
    () => sarah.agent.workspaces.all.find((s) => s.workspace.name === 'Design Partners'),
    'sarah joins',
  );

  assert.ok([...sarahSide.channels.values()].some((c) => c.name === 'launch'));
  assert.equal(sarahSide.me.role, 'member');

  // Traffic in one workspace never shows up in the other.
  const launch = [...sarahSide.channels.values()].find((c) => c.name === 'launch');
  sarah.agent.joinChannel(sarahSide.workspace.id, launch.id);
  await until(() => channelNamed(sarah.agent, 'general'), 'home still there');
  sarah.agent.sendMessage({ workspaceId: sarahSide.workspace.id, channelId: launch.id, text: 'partner deck is ready' });

  await until(
    () => dana.agent.workspaces.messages(created.workspace.id, launch.id).some((m) => m.text.includes('partner deck')),
    'dana sees it in the new workspace',
  );
  const homeGeneral = channelNamed(tom.agent, 'general');
  assert.ok(
    !tom.agent.workspaces.messages(home(tom.agent).workspace.id, homeGeneral.id).some((m) => m.text.includes('partner deck')),
    'the home workspace never saw it',
  );
});

test('threads, reactions, edits and deletes behave', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah']);
  const [dana, sarah] = agents;
  await until(() => channelNamed(sarah.agent, 'general'), 'sarah sees #general');

  const workspaceId = home(dana.agent).workspace.id;
  const general = channelNamed(dana.agent, 'general');

  dana.agent.sendMessage({ workspaceId, channelId: general.id, text: 'Ship the migration Thursday?' });
  const root = await until(
    () => sarah.agent.workspaces.messages(workspaceId, general.id).find((m) => m.text.startsWith('Ship the')),
    'root message',
  );

  sarah.agent.sendMessage({ workspaceId, channelId: general.id, text: 'Friday is safer.', threadRootId: root.id });
  await until(() => dana.agent.workspaces.thread(workspaceId, root.id).length === 1, 'reply lands in the thread');

  // A thread reply stays out of the channel timeline.
  const timeline = dana.agent.workspaces.messages(workspaceId, general.id);
  assert.ok(!timeline.some((m) => m.text === 'Friday is safer.'));
  await until(
    () => dana.agent.workspaces.messages(workspaceId, general.id).find((m) => m.id === root.id)?.replyCount === 1,
    'reply count on the root',
  );

  sarah.agent.reactToMessage(workspaceId, root.id, '👍', true);
  await until(
    () =>
      dana.agent.workspaces
        .messages(workspaceId, general.id)
        .find((m) => m.id === root.id)
        ?.reactions.some((r) => r.emoji === '👍' && r.by.includes(sarah.knowledge.address)),
    'reaction',
  );

  dana.agent.editMessage(workspaceId, root.id, 'Ship the migration Friday?');
  await until(
    () => sarah.agent.workspaces.messages(workspaceId, general.id).find((m) => m.id === root.id)?.editedAt,
    'edit',
  );

  // Only the author may edit.
  sarah.agent.editMessage(workspaceId, root.id, 'hacked');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.match(
    dana.agent.workspaces.messages(workspaceId, general.id).find((m) => m.id === root.id).text,
    /Friday/,
  );

  dana.agent.deleteMessage(workspaceId, root.id);
  await until(
    () => sarah.agent.workspaces.messages(workspaceId, general.id).find((m) => m.id === root.id)?.deletedAt,
    'delete',
  );
});

test('a direct message is private to the two people in it', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah', 'tom']);
  const [dana, sarah, tom] = agents;
  await until(() => home(dana.agent).members.size === 3, 'everyone present');

  const workspaceId = home(dana.agent).workspace.id;
  dana.agent.openDirectMessage(workspaceId, [sarah.knowledge.address]);

  const dm = await until(
    () => [...home(dana.agent).channels.values()].find((c) => c.kind === 'dm'),
    'dm opens',
  );
  await until(() => [...home(sarah.agent).channels.values()].find((c) => c.id === dm.id), 'sarah sees it');

  dana.agent.sendMessage({ workspaceId, channelId: dm.id, text: 'quiet word about headcount' });
  await until(
    () => sarah.agent.workspaces.messages(workspaceId, dm.id).some((m) => m.text.includes('headcount')),
    'sarah receives it',
  );

  assert.equal(
    [...home(tom.agent).channels.values()].find((c) => c.id === dm.id),
    undefined,
    'tom never learns the conversation exists',
  );
  // Both ends compute the same channel id, so nobody ends up with two threads.
  sarah.agent.openDirectMessage(workspaceId, [dana.knowledge.address]);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal([...home(sarah.agent).channels.values()].filter((c) => c.kind === 'dm').length, 1);
});

test('search finds what was said, scoped to the workspace', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah']);
  const [dana, sarah] = agents;
  await until(() => channelNamed(sarah.agent, 'general'), 'sarah sees #general');

  const workspaceId = home(dana.agent).workspace.id;
  const general = channelNamed(dana.agent, 'general');
  dana.agent.sendMessage({ workspaceId, channelId: general.id, text: 'the auth migration lands Thursday' });
  dana.agent.sendMessage({ workspaceId, channelId: general.id, text: 'lunch is at noon' });
  await until(
    () => sarah.agent.workspaces.messages(workspaceId, general.id).some((m) => m.text.includes('lunch')),
    'messages arrive',
  );

  const results = await new Promise((resolve) => {
    sarah.agent.workspaces.once('search', resolve);
    sarah.agent.searchMessages(workspaceId, 'auth migration');
  });
  assert.equal(results.hits.length, 1);
  assert.match(results.hits[0].message.text, /auth migration/);
});

test('roles gate the destructive things', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah']);
  const [dana, sarah] = agents;
  await until(() => home(sarah.agent), 'sarah snapshot');
  const workspaceId = home(dana.agent).workspace.id;

  // An ordinary member cannot rename the workspace.
  sarah.agent.updateWorkspace(workspaceId, { name: 'Sarah Co' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.notEqual(home(dana.agent).workspace.name, 'Sarah Co');

  // The owner can, and everybody sees it.
  dana.agent.updateWorkspace(workspaceId, { name: 'Northwind' });
  await until(() => home(sarah.agent).workspace.name === 'Northwind', 'rename propagates');

  // Promotion is an owner's call, and then the new admin can rename too.
  dana.agent.setMemberRole(workspaceId, sarah.knowledge.address, 'admin');
  await until(() => home(sarah.agent).me.role === 'admin', 'promotion');
  sarah.agent.updateWorkspace(workspaceId, { description: 'Platform team' });
  await until(() => home(dana.agent).workspace.description === 'Platform team', 'admin can edit');

  // #general is load-bearing: it cannot be left or archived.
  const general = channelNamed(sarah.agent, 'general');
  sarah.agent.leaveChannel(workspaceId, general.id);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(channelNamed(sarah.agent, 'general').members.includes(sarah.knowledge.address));
});

test('your own agent can work the workspace on your behalf', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah']);
  const [dana, sarah] = agents;
  await until(() => channelNamed(sarah.agent, 'general'), 'sarah sees #general');

  const workspaceId = home(dana.agent).workspace.id;
  const general = channelNamed(dana.agent, 'general');

  // Listing.
  const list = await dana.agent.runTool('list_workspaces', {});
  assert.match(list, /member\(s\)/);
  assert.match(list, /you are owner/);

  const channels = await dana.agent.runTool('list_channels', {});
  assert.match(channels, /#general/);

  // Posting by name, the way somebody would ask for it.
  const posted = await dana.agent.runTool('send_message', {
    channel: 'general',
    text: 'Posting this through my agent.',
  });
  assert.match(posted, /Posted to #general/);
  const landed = await until(
    () =>
      sarah.agent.workspaces
        .messages(workspaceId, general.id)
        .find((m) => m.text.includes('through my agent')),
    'message lands',
  );
  assert.equal(landed.viaAgent, true, 'the room can tell an agent said it');

  // Reading catches the reader up as a side effect.
  const read = await sarah.agent.runTool('read_channel', { channel: 'general' });
  assert.match(read, /Posting this through my agent/);
  await until(() => sarah.agent.workspaces.read(workspaceId, general.id)?.unread === 0, 'marked read');

  // Searching round-trips to the relay inside one tool call.
  const found = await sarah.agent.runTool('search_messages', { query: 'through my agent' });
  assert.match(found, /Posting this through my agent/);

  // Catch-up reports what is waiting, per workspace.
  dana.agent.sendMessage({ workspaceId, channelId: general.id, text: 'and one more thing' });
  await until(() => sarah.agent.workspaces.read(workspaceId, general.id)?.unread === 1, 'unread again');
  const summary = await sarah.agent.runTool('catch_me_up', {});
  assert.match(summary, /#general: 1 unread/);

  // Creating a channel, and inviting somebody.
  await dana.agent.runTool('create_channel', { name: 'from-the-agent', topic: 'made by tool' });
  await until(() => channelNamed(dana.agent, 'from-the-agent'), 'channel created');

  const invite = await dana.agent.runTool('invite_to_workspace', { address: 'tom@northwind' });
  assert.match(invite, /Invitation to/);
  assert.match(invite, /for tom@northwind/);

  // A name nobody has is refused with the options, not silently dropped.
  const missing = await dana.agent.runTool('send_message', { channel: 'nowhere', text: 'hi' });
  assert.match(missing, /No channel or person called "nowhere"/);
});
