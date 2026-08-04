/**
 * Running a workspace: roles, permissions, deactivation, guests, join requests
 * and the audit trail.
 *
 * Everything here is checked through the relay rather than by calling the hub
 * directly, because the point of these rules is that they hold against a client
 * that has decided not to co-operate. Half of them are written from the
 * attacker's side: an admin reaching for an owner, a guest reaching for a
 * channel, a deactivated account reaching for anything at all.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import fs from 'node:fs/promises';

import { cleanup, makeTempDir, startAgent, startRelay, until } from './helpers.mjs';

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
const settle = (ms = 220) => new Promise((resolve) => setTimeout(resolve, ms));
const channelNamed = (agent, name) =>
  home(agent) ? [...home(agent).channels.values()].find((c) => c.name === name) : undefined;
const memberOf = (agent, address) => home(agent)?.members.get(address);

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

test('the first person holds the workspace and cannot be demoted out of it', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah']);
  const [dana, sarah] = agents;
  await until(() => memberOf(dana.agent, sarah.knowledge.address), 'dana sees sarah');
  const workspaceId = home(dana.agent).workspace.id;

  assert.equal(home(dana.agent).workspace.primaryOwner, dana.knowledge.address);
  assert.equal(memberOf(dana.agent, dana.knowledge.address).primaryOwner, true);
  assert.equal(memberOf(dana.agent, sarah.knowledge.address).primaryOwner, false);

  // Even another owner cannot take the seat by demoting its holder.
  dana.agent.setMemberRole(workspaceId, sarah.knowledge.address, 'owner');
  await until(() => home(sarah.agent).me.role === 'owner', 'sarah is an owner');
  sarah.agent.setMemberRole(workspaceId, dana.knowledge.address, 'member');
  await settle();
  assert.equal(home(dana.agent).me.role, 'owner', 'the primary owner survived the attempt');
  assert.equal(home(dana.agent).workspace.primaryOwner, dana.knowledge.address);

  // Nor by removing them.
  sarah.agent.removeMember(workspaceId, dana.knowledge.address);
  await settle();
  assert.ok(memberOf(sarah.agent, dana.knowledge.address), 'still a member');
});

test('ownership can be handed over, and then it really has moved', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah']);
  const [dana, sarah] = agents;
  await until(() => home(sarah.agent), 'sarah snapshot');
  const workspaceId = home(dana.agent).workspace.id;

  // Not by anybody else, however senior.
  dana.agent.setMemberRole(workspaceId, sarah.knowledge.address, 'owner');
  await until(() => home(sarah.agent).me.role === 'owner', 'promotion');
  sarah.agent.transferOwnership(workspaceId, sarah.knowledge.address);
  await settle();
  assert.equal(home(dana.agent).workspace.primaryOwner, dana.knowledge.address);

  dana.agent.transferOwnership(workspaceId, sarah.knowledge.address);
  await until(
    () => home(sarah.agent).workspace.primaryOwner === sarah.knowledge.address,
    'ownership moved',
  );

  // The outgoing holder stays an owner rather than being pushed out of the room.
  assert.equal(home(dana.agent).me.role, 'owner');
  // And the new holder now has the protection the old one had.
  dana.agent.setMemberRole(workspaceId, sarah.knowledge.address, 'member');
  await settle();
  assert.equal(home(sarah.agent).me.role, 'owner');
});

// ---------------------------------------------------------------------------
// Deactivation
// ---------------------------------------------------------------------------

test('deactivating somebody stops them without erasing what they said', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah']);
  const [dana, sarah] = agents;
  await until(() => channelNamed(sarah.agent, 'general'), 'sarah sees #general');
  const workspaceId = home(dana.agent).workspace.id;
  const general = channelNamed(dana.agent, 'general');

  sarah.agent.sendMessage({ workspaceId, channelId: general.id, text: 'Here before I was switched off.' });
  await until(
    () => dana.agent.workspaces.messages(workspaceId, general.id).some((m) => m.text.startsWith('Here before')),
    'her message landed',
  );

  dana.agent.setMemberActive(workspaceId, sarah.knowledge.address, false);
  await until(() => memberOf(dana.agent, sarah.knowledge.address)?.deactivated, 'deactivated');

  const row = memberOf(dana.agent, sarah.knowledge.address);
  assert.equal(row.deactivatedBy, dana.knowledge.address);
  assert.ok(row.deactivatedAt > 0);
  assert.equal(row.agentOnline, false, 'a deactivated account never reads as online');

  // Her history is untouched.
  assert.ok(
    dana.agent.workspaces.messages(workspaceId, general.id).some((m) => m.text.startsWith('Here before')),
    'the message survived',
  );

  // And she can no longer say anything.
  sarah.agent.sendMessage({ workspaceId, channelId: general.id, text: 'Still here?' });
  await settle(300);
  assert.ok(
    !dana.agent.workspaces.messages(workspaceId, general.id).some((m) => m.text === 'Still here?'),
    'a deactivated account cannot post',
  );

  // Reactivating gives her the workspace back.
  dana.agent.setMemberActive(workspaceId, sarah.knowledge.address, true);
  await until(() => !memberOf(dana.agent, sarah.knowledge.address).deactivated, 'reactivated');
  await until(() => home(sarah.agent), 'her snapshot came back');
  sarah.agent.sendMessage({ workspaceId, channelId: general.id, text: 'Back.' });
  await until(
    () => dana.agent.workspaces.messages(workspaceId, general.id).some((m) => m.text === 'Back.'),
    'she can post again',
  );
});

test('a deactivated account cannot be mentioned', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah']);
  const [dana, sarah] = agents;
  await until(() => channelNamed(sarah.agent, 'general'), 'sarah sees #general');
  const workspaceId = home(dana.agent).workspace.id;
  const general = channelNamed(dana.agent, 'general');
  const handle = sarah.knowledge.address.split('@')[0];

  dana.agent.sendMessage({ workspaceId, channelId: general.id, text: `@${handle} can you look?` });
  const before = await until(
    () => dana.agent.workspaces.messages(workspaceId, general.id).find((m) => m.text.includes('can you look')),
    'mention resolved',
  );
  assert.deepEqual(before.mentions, [sarah.knowledge.address]);

  dana.agent.setMemberActive(workspaceId, sarah.knowledge.address, false);
  await until(() => memberOf(dana.agent, sarah.knowledge.address)?.deactivated, 'deactivated');

  dana.agent.sendMessage({ workspaceId, channelId: general.id, text: `@${handle} still there?` });
  const after = await until(
    () => dana.agent.workspaces.messages(workspaceId, general.id).find((m) => m.text.includes('still there')),
    'second message',
  );
  assert.deepEqual(after.mentions, [], 'work should stop being routed to somebody switched off');
});

test('you cannot deactivate yourself, or anybody above you', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah', 'marcus']);
  const [dana, sarah, marcus] = agents;
  await until(() => home(marcus.agent), 'marcus snapshot');
  const workspaceId = home(dana.agent).workspace.id;

  dana.agent.setMemberRole(workspaceId, sarah.knowledge.address, 'admin');
  await until(() => home(sarah.agent).me.role === 'admin', 'sarah is an admin');

  sarah.agent.setMemberActive(workspaceId, sarah.knowledge.address, false);
  await settle();
  assert.equal(memberOf(dana.agent, sarah.knowledge.address).deactivated, false);

  sarah.agent.setMemberActive(workspaceId, dana.knowledge.address, false);
  await settle();
  assert.equal(memberOf(dana.agent, dana.knowledge.address).deactivated, false, 'an admin cannot reach the owner');

  // Downwards is fine.
  sarah.agent.setMemberActive(workspaceId, marcus.knowledge.address, false);
  await until(() => memberOf(dana.agent, marcus.knowledge.address)?.deactivated, 'marcus switched off');
});

// ---------------------------------------------------------------------------
// Bulk actions
// ---------------------------------------------------------------------------

test('a bulk role change applies to everybody or to nobody', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah', 'marcus']);
  const [dana, sarah, marcus] = agents;
  await until(() => home(marcus.agent), 'marcus snapshot');
  const workspaceId = home(dana.agent).workspace.id;

  dana.agent.setMemberRole(workspaceId, [sarah.knowledge.address, marcus.knowledge.address], 'guest');
  await until(
    () =>
      memberOf(dana.agent, sarah.knowledge.address).role === 'guest' &&
      memberOf(dana.agent, marcus.knowledge.address).role === 'guest',
    'both became guests',
  );

  // One bad name in the batch refuses the whole thing rather than half-applying.
  dana.agent.setMemberRole(
    workspaceId,
    [sarah.knowledge.address, 'nobody@nowhere', marcus.knowledge.address],
    'member',
  );
  await settle(300);
  assert.equal(memberOf(dana.agent, sarah.knowledge.address).role, 'guest');
  assert.equal(memberOf(dana.agent, marcus.knowledge.address).role, 'guest');
});

// ---------------------------------------------------------------------------
// Guests
// ---------------------------------------------------------------------------

test('a single-channel guest sees that channel and nothing else', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah']);
  const [dana, sarah] = agents;
  await until(() => channelNamed(sarah.agent, 'random'), 'sarah sees #random');
  const workspaceId = home(dana.agent).workspace.id;
  const random = channelNamed(dana.agent, 'random');
  const general = channelNamed(dana.agent, 'general');

  dana.agent.setMemberRole(workspaceId, sarah.knowledge.address, 'guest', [random.id]);
  await until(
    () => home(sarah.agent) && !channelNamed(sarah.agent, 'general'),
    '#general disappeared for the guest',
  );
  assert.ok(channelNamed(sarah.agent, 'random'), 'the channel she was let into is still there');

  // Traffic in the channel she cannot see must not reach her either.
  dana.agent.sendMessage({ workspaceId, channelId: general.id, text: 'Internal only.' });
  await settle(300);
  assert.equal(
    sarah.agent.workspaces.messages(workspaceId, general.id).length,
    0,
    'a confined guest is not sent messages from channels they cannot open',
  );

  // She can still work in the one she was invited to.
  sarah.agent.sendMessage({ workspaceId, channelId: random.id, text: 'Hello from the contractor.' });
  await until(
    () => dana.agent.workspaces.messages(workspaceId, random.id).some((m) => m.text.includes('contractor')),
    'the guest can post where she belongs',
  );
});

test('promoting a guest back to member restores the workspace', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah']);
  const [dana, sarah] = agents;
  await until(() => channelNamed(sarah.agent, 'random'), 'sarah snapshot');
  const workspaceId = home(dana.agent).workspace.id;
  const random = channelNamed(dana.agent, 'random');

  dana.agent.setMemberRole(workspaceId, sarah.knowledge.address, 'guest', [random.id]);
  await until(() => !channelNamed(sarah.agent, 'general'), 'confined');

  dana.agent.setMemberRole(workspaceId, sarah.knowledge.address, 'member');
  await until(() => channelNamed(sarah.agent, 'general'), '#general came back');
  assert.deepEqual(memberOf(dana.agent, sarah.knowledge.address).guestChannels, []);
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

test('permissions decide who can create channels, and are enforced on the relay', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah']);
  const [dana, sarah] = agents;
  await until(() => home(sarah.agent), 'sarah snapshot');
  const workspaceId = home(dana.agent).workspace.id;

  // Out of the box a member can make a channel.
  sarah.agent.createChannel(workspaceId, { name: 'design-review' });
  await until(() => channelNamed(sarah.agent, 'design-review'), 'member created a channel');

  dana.agent.setWorkspacePermissions(workspaceId, { create_public_channel: 'admin' });
  await until(
    () => home(sarah.agent).workspace.permissions.create_public_channel === 'admin',
    'permission propagated',
  );

  sarah.agent.createChannel(workspaceId, { name: 'second-attempt' });
  await settle(300);
  assert.equal(channelNamed(sarah.agent, 'second-attempt'), undefined, 'the relay refused');

  // The admin who set the rule is still above it.
  dana.agent.createChannel(workspaceId, { name: 'second-attempt' });
  await until(() => channelNamed(dana.agent, 'second-attempt'), 'the admin still can');
});

test('a permission floor cannot be lowered past what is safe', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah']);
  const [dana, sarah] = agents;
  await until(() => home(sarah.agent), 'sarah snapshot');
  const workspaceId = home(dana.agent).workspace.id;

  dana.agent.setWorkspacePermissions(workspaceId, {
    manage_members: 'guest',
    manage_workspace: 'member',
    invite: 'guest',
  });
  await settle(300);

  const permissions = home(dana.agent).workspace.permissions;
  assert.equal(permissions.manage_members, 'admin', 'managing people stays an admin job');
  assert.equal(permissions.manage_workspace, 'admin');
  assert.equal(permissions.invite, 'member', 'inviting cannot be handed to guests');

  // And the clamp is real, not cosmetic: a member still cannot remove anybody.
  sarah.agent.removeMember(workspaceId, dana.knowledge.address);
  await settle();
  assert.ok(memberOf(sarah.agent, dana.knowledge.address));
});

test('the default channel can be restricted to announcements', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah']);
  const [dana, sarah] = agents;
  await until(() => channelNamed(sarah.agent, 'general'), 'sarah sees #general');
  const workspaceId = home(dana.agent).workspace.id;
  const general = channelNamed(dana.agent, 'general');

  dana.agent.setWorkspacePermissions(workspaceId, { post_in_default_channel: 'admin' });
  await until(
    () => home(sarah.agent).workspace.permissions.post_in_default_channel === 'admin',
    'permission propagated',
  );

  sarah.agent.sendMessage({ workspaceId, channelId: general.id, text: 'Anybody want lunch?' });
  await settle(300);
  assert.ok(
    !dana.agent.workspaces.messages(workspaceId, general.id).some((m) => m.text.includes('lunch')),
    'a member cannot post in a restricted default channel',
  );

  dana.agent.sendMessage({ workspaceId, channelId: general.id, text: 'All-hands on Thursday.' });
  await until(
    () => sarah.agent.workspaces.messages(workspaceId, general.id).some((m) => m.text.includes('All-hands')),
    'the admin still can',
  );
});

// ---------------------------------------------------------------------------
// Join requests
// ---------------------------------------------------------------------------

test('somebody can ask to join a private workspace, and an admin decides', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah']);
  const [dana, sarah] = agents;
  await until(() => home(sarah.agent), 'sarah snapshot');

  // A second, invitation-only workspace that Sarah is not in.
  dana.agent.createWorkspace({ name: 'Ledger', discoverable: false });
  const ledger = await until(
    () => dana.agent.workspaces.all.find((w) => w.workspace.name === 'Ledger'),
    'ledger created',
  );

  // She cannot simply walk in.
  sarah.agent.joinWorkspace({ slug: ledger.workspace.slug });
  await settle(300);
  assert.equal(sarah.agent.workspaces.all.some((w) => w.workspace.name === 'Ledger'), false);

  sarah.agent.requestToJoin(ledger.workspace.slug, 'I am on the billing project.');
  const pending = await until(
    () => dana.agent.workspaces.get(ledger.workspace.id)?.joinRequests.find((r) => r.state === 'pending'),
    'dana sees the request',
  );
  assert.equal(pending.address, sarah.knowledge.address);
  assert.match(pending.message, /billing project/);

  dana.agent.reviewJoinRequest(ledger.workspace.id, pending.id, true);
  await until(
    () => sarah.agent.workspaces.all.some((w) => w.workspace.name === 'Ledger'),
    'she was let in',
  );
  assert.equal(
    dana.agent.workspaces.get(ledger.workspace.id).joinRequests[0].state,
    'approved',
  );
});

test('a denied request leaves the person exactly where they were', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah']);
  const [dana, sarah] = agents;
  await until(() => home(sarah.agent), 'sarah snapshot');

  dana.agent.createWorkspace({ name: 'Board', discoverable: false });
  const board = await until(
    () => dana.agent.workspaces.all.find((w) => w.workspace.name === 'Board'),
    'board created',
  );

  const decided = new Promise((resolve) =>
    sarah.agent.workspaces.once('join.decided', (name, approved) => resolve({ name, approved })),
  );
  sarah.agent.requestToJoin(board.workspace.slug, 'Curious.');
  const pending = await until(
    () => dana.agent.workspaces.get(board.workspace.id)?.joinRequests[0],
    'request arrived',
  );

  dana.agent.reviewJoinRequest(board.workspace.id, pending.id, false);
  const outcome = await decided;
  assert.equal(outcome.approved, false);
  assert.equal(outcome.name, 'Board');
  assert.equal(sarah.agent.workspaces.all.some((w) => w.workspace.name === 'Board'), false);

  // The same request cannot be answered twice.
  dana.agent.reviewJoinRequest(board.workspace.id, pending.id, true);
  await settle(300);
  assert.equal(sarah.agent.workspaces.all.some((w) => w.workspace.name === 'Board'), false);
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

test('administrative acts are written down, and only admins can read them', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah']);
  const [dana, sarah] = agents;
  await until(() => home(sarah.agent), 'sarah snapshot');
  const workspaceId = home(dana.agent).workspace.id;

  dana.agent.setMemberRole(workspaceId, sarah.knowledge.address, 'admin');
  await until(() => home(sarah.agent).me.role === 'admin', 'promoted');
  dana.agent.updateWorkspace(workspaceId, { name: 'Northwind' });
  await until(() => home(sarah.agent).workspace.name === 'Northwind', 'renamed');

  dana.agent.listAudit(workspaceId);
  const entries = await until(
    () => {
      const log = home(dana.agent).audit;
      return log.length ? log : null;
    },
    'the audit log came back',
  );

  const actions = entries.map((e) => e.action);
  assert.ok(actions.includes('role_changed'), 'a role change is recorded');
  assert.ok(actions.includes('workspace_updated'), 'a rename is recorded');
  const roleChange = entries.find((e) => e.action === 'role_changed');
  assert.equal(roleChange.actor, dana.knowledge.address);
  assert.equal(roleChange.target, sarah.knowledge.address);
  assert.match(roleChange.detail, /member → admin/);

  // Demote her and the log stops being readable.
  dana.agent.setMemberRole(workspaceId, sarah.knowledge.address, 'member');
  await until(() => home(sarah.agent).me.role === 'member', 'demoted');
  const seen = home(sarah.agent).audit.length;
  sarah.agent.listAudit(workspaceId);
  await settle(300);
  assert.equal(home(sarah.agent).audit.length, seen, 'a plain member learns nothing new');
});

// ---------------------------------------------------------------------------
// Admin editing somebody else
// ---------------------------------------------------------------------------

test('an admin can correct somebody else’s workspace profile, a member cannot', async (t) => {
  const { agents } = await scene(t, ['dana', 'sarah']);
  const [dana, sarah] = agents;
  await until(() => home(sarah.agent), 'sarah snapshot');
  const workspaceId = home(dana.agent).workspace.id;

  dana.agent.setWorkspaceProfile(workspaceId, {
    address: sarah.knowledge.address,
    title: 'Staff Engineer',
  });
  await until(
    () => memberOf(sarah.agent, sarah.knowledge.address)?.title === 'Staff Engineer',
    'the admin edit landed',
  );

  sarah.agent.setWorkspaceProfile(workspaceId, {
    address: dana.knowledge.address,
    title: 'Intern',
  });
  await settle(300);
  assert.notEqual(memberOf(dana.agent, dana.knowledge.address).title, 'Intern');

  // Your own is always yours to set.
  sarah.agent.setWorkspaceProfile(workspaceId, { displayName: 'Sarah C.' });
  await until(
    () => memberOf(dana.agent, sarah.knowledge.address)?.displayName === 'Sarah C.',
    'she can rename herself',
  );
});

// ---------------------------------------------------------------------------
// Default channels
// ---------------------------------------------------------------------------

test('new people land in the channels an admin chose', async (t) => {
  const { relay, agents } = await scene(t, ['dana']);
  const [dana] = agents;
  await until(() => channelNamed(dana.agent, 'general'), 'dana snapshot');
  const workspaceId = home(dana.agent).workspace.id;

  dana.agent.createChannel(workspaceId, { name: 'announcements' });
  await until(() => channelNamed(dana.agent, 'announcements'), 'channel created');
  dana.agent.updateWorkspace(workspaceId, { defaultChannels: ['announcements'] });
  await until(
    () => home(dana.agent).workspace.defaultChannels.includes('announcements'),
    'defaults set',
  );
  // #general is load-bearing, so it is added back whatever the admin typed.
  assert.ok(home(dana.agent).workspace.defaultChannels.includes('general'));

  const sarah = await startAgent('sarah', relay.url);
  t.after(async () => {
    await sarah.agent.shutdown();
    await cleanup([sarah.dir]);
  });

  const landed = await until(() => channelNamed(sarah.agent, 'announcements'), 'she landed in it');
  assert.ok(landed.members.includes(sarah.knowledge.address));
});

// ---------------------------------------------------------------------------
// Upgrading a relay
// ---------------------------------------------------------------------------

test('a workspace written by an older relay comes back with its rules intact', async (t) => {
  const { WorkspaceHub } = await import('../packages/server/dist/index.js');
  const dir = await makeTempDir('ai-coworker-migrate-');
  t.after(() => cleanup([dir]));
  const statePath = `${dir}/.relay-workspaces.json`;

  // Exactly what version 2 wrote: an `invitePolicy` flag, no permission table,
  // no primary owner, no email domains.
  const legacy = {
    version: 2,
    defaultWorkspaceId: 'ws_old',
    workspaces: [
      {
        workspace: {
          id: 'ws_old',
          slug: 'northwind',
          name: 'Northwind',
          description: '',
          icon: '🛰️',
          color: '#6ea8fe',
          createdBy: 'dana@northwind',
          createdAt: 1,
          updatedAt: 1,
          invitePolicy: 'admins',
          discoverable: true,
          defaultChannels: ['general'],
        },
        members: [
          { address: 'sarah@northwind', role: 'member', joinedAt: 30, deactivated: false },
          { address: 'dana@northwind', role: 'owner', joinedAt: 10, deactivated: false },
          { address: 'marcus@northwind', role: 'owner', joinedAt: 20, deactivated: false },
        ],
        invites: [],
        channels: [
          {
            channel: {
              id: 'ch_general',
              workspaceId: 'ws_old',
              kind: 'public',
              name: 'general',
              topic: '',
              purpose: '',
              createdBy: 'dana@northwind',
              createdAt: 1,
              updatedAt: 1,
              archived: false,
              members: ['dana@northwind', 'sarah@northwind', 'marcus@northwind'],
              isDefault: true,
              lastMessageAt: 0,
              messageCount: 0,
              pinned: [],
            },
            messages: [],
            reads: {},
          },
        ],
      },
    ],
    identities: [],
  };
  await fs.writeFile(statePath, JSON.stringify(legacy), 'utf8');

  const hub = new WorkspaceHub({ statePath });
  const snapshot = hub.snapshot('dana@northwind', 'ws_old');
  const w = snapshot.workspace;

  // The old single flag becomes the corresponding permission, rather than
  // silently reverting the workspace to "anybody can invite".
  assert.equal(w.permissions.invite, 'admin', 'admins-only invites survived the upgrade');
  assert.equal(w.permissions.manage_members, 'admin');
  assert.equal(w.invitePolicy, undefined, 'the superseded field is gone');

  // The earliest owner takes the seat — almost always the person who made it.
  assert.equal(w.primaryOwner, 'dana@northwind');
  assert.deepEqual(w.emailDomains, []);
  assert.equal(w.acceptsJoinRequests, true);
  assert.equal(w.domainJoin, 'open');

  // And nothing was lost on the way.
  assert.equal(snapshot.members.length, 3);
  assert.equal(hub.channelsOf('ws_old').length, 1);
  hub.shutdown();
});
