import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  KnowledgeBase,
  MemoryIndex,
  MockProvider,
  PersonalAgent,
  renderDigest,
  syncMemory,
} from '../packages/agent/dist/index.js';

import { cleanup, makeTempDir } from './helpers.mjs';

/**
 * A manager with one report, a finance memory, and an ordinary one. This is the
 * shape of the problem: the same agent, the same knowledge base, two very
 * different answers depending on who is in the room.
 */
async function setup(t) {
  const home = await makeTempDir('ai-coworker-home-');
  const dir = await makeTempDir('ai-coworker-ws-');

  await fs.mkdir(path.join(home, '.hermes', 'memories'), { recursive: true });
  await fs.writeFile(
    path.join(home, '.hermes', 'memories', 'MEMORY.md'),
    [
      'Memory - Company > Finance: Revenue for the quarter came in at 4.1M against a 3.6M plan',
      '§',
      'Memory - Platform > Auth migration: The refresh-token rollout is behind because of the session store',
    ].join('\n'),
    'utf8',
  );

  const knowledge = await KnowledgeBase.open(dir);
  await knowledge.updateProfile({
    address: 'dana@northwind',
    displayName: 'Dana Okoye',
    title: 'Engineering Manager',
    role: 'manager',
    team: 'leadership',
    timezone: 'UTC',
    bio: '',
    focusAreas: [],
    reports: ['sarah@northwind'],
    workingHours: { days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1080 },
    agentInstructions: '',
  });

  const memory = await MemoryIndex.open(dir);
  await syncMemory(memory, { context: { home, env: {} } });

  const agent = new PersonalAgent({
    knowledge,
    relayUrl: 'ws://127.0.0.1:1',
    provider: new MockProvider(),
    autoConnect: false,
    memory,
  });
  // Shut the agent down *before* the directory goes away. The agent writes
  // client.json in the background, and removing the folder out from under an
  // in-flight atomic rename surfaces as an unhandled rejection attributed to
  // whichever test happens to be running — which is why this used to fail in a
  // different place every time.
  t.after(async () => {
    await agent.shutdown();
    await cleanup([home, dir]);
  });

  return { agent, memory, knowledge };
}

const sarah = {
  address: 'sarah@northwind',
  displayName: 'Sarah Chen',
  title: 'Engineer',
  role: 'ic',
  team: 'platform',
  timezone: 'UTC',
  bio: '',
  focusAreas: [],
  online: true,
  lastSeen: 0,
};

test('imported memory reaches the agent, and the room decides how much of it', async (t) => {
  const { agent } = await setup(t);

  const mine = agent.digest('self', { notes: 5, artifacts: 5, tasks: 5, memories: 10 }, { query: 'revenue' });
  const revenue = mine.recalled.find((m) => m.title.toLowerCase().includes('finance'));
  assert.ok(revenue, 'my own agent can see my own imported memory');
  assert.equal(revenue.level, 'full');
  assert.match(revenue.body, /4\.1M/);

  // The same question in front of an engineer who reports to me.
  const inRoom = agent.digest(
    'meeting',
    { notes: 5, artifacts: 5, tasks: 5, memories: 10 },
    // What a real meeting turn passes: the title, the purpose and the last few
    // things said, which is why both subjects are in scope here.
    { room: [sarah], query: 'revenue for the quarter and the auth migration rollout' },
  );
  const withheld = inRoom.recalled.find((m) => m.title.toLowerCase().includes('finance'));
  assert.ok(withheld, 'the subject is still surfaced — the agent should not pretend ignorance');
  assert.equal(withheld.level, 'gist');
  assert.equal(withheld.body, undefined);
  assert.ok(!JSON.stringify(inRoom.recalled).includes('4.1M'), 'the figure does not reach the model at all');

  // Engineering context is ordinary internal material and flows normally.
  const auth = inRoom.recalled.find((m) => m.title.toLowerCase().includes('auth'));
  assert.ok(auth, 'the room still gets the work context');
  assert.equal(auth.level, 'full');
});

test('a meeting digest with no room named falls closed, not open', async (t) => {
  const { agent } = await setup(t);

  // A caller that forgets to say who is present must not be read as "nobody is
  // present, share everything".
  const blind = agent.digest('meeting', { notes: 5, artifacts: 5, tasks: 5, memories: 10 }, { query: 'revenue auth' });
  assert.ok(
    blind.recalled.every((m) => m.level !== 'full'),
    'nothing is quoted to an audience the agent cannot identify',
  );
  assert.ok(!JSON.stringify(blind.recalled).includes('4.1M'));
});

test('the prompt tells the model it may acknowledge but not disclose', async (t) => {
  const { agent } = await setup(t);

  const digest = agent.digest(
    'meeting',
    { notes: 5, artifacts: 5, tasks: 5, memories: 10 },
    { room: [sarah], query: 'revenue' },
  );
  const rendered = renderDigest(digest);

  assert.match(rendered, /WITHHELD/);
  assert.match(rendered, /Do not state its contents/);
  assert.ok(!rendered.includes('4.1M'), 'the number is nowhere in the prompt');
  assert.ok(!rendered.includes('3.6M'));
});

test('the agent can be asked, in chat, what it would say to someone', async (t) => {
  const { agent } = await setup(t);

  const asMe = await agent.runTool('recall_memory', { query: 'revenue quarter' });
  assert.match(asMe, /4\.1M/, 'my own agent tells me my own numbers');

  const asSarah = await agent.runTool('recall_memory', { query: 'revenue quarter', audience: 'sarah@northwind' });
  assert.match(asSarah, /WITHHELD/);
  assert.ok(!asSarah.includes('4.1M'));

  const status = await agent.runTool('memory_sources', {});
  assert.match(status, /hermes/);
});

test('an agent with no imported memory behaves exactly as before', async (t) => {
  const dir = await makeTempDir('ai-coworker-ws-');
  const knowledge = await KnowledgeBase.open(dir);
  await knowledge.updateProfile({ address: 'solo@northwind', displayName: 'Solo', reports: [] });
  const agent = new PersonalAgent({
    knowledge,
    relayUrl: 'ws://127.0.0.1:1',
    provider: new MockProvider(),
    autoConnect: false,
  });
  t.after(async () => {
    await agent.shutdown();
    await cleanup([dir]);
  });

  assert.deepEqual(agent.digest('self').recalled, []);
  assert.deepEqual(agent.recall({ text: 'anything' }), []);
  assert.match(await agent.runTool('recall_memory', { query: 'anything' }), /No other agents are connected/);
});
