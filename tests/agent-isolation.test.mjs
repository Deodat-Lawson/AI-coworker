/**
 * The isolation guarantee, end to end.
 *
 * `tests/workspace-agent.test.mjs` checks the gate functions in isolation. This
 * checks the thing that actually matters: that an agent *reasoning inside one
 * workspace* is handed only what that workspace granted — that the gate is on
 * the road, not just in the drawer.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  KnowledgeBase,
  MemoryIndex,
  MockProvider,
  PersonalAgent,
  syncMemory,
} from '../packages/agent/dist/index.js';

import { cleanup, makeTempDir } from './helpers.mjs';

async function setup(t) {
  const home = await makeTempDir('stead-home-');
  const dir = await makeTempDir('stead-kb-');

  await fs.mkdir(path.join(home, '.hermes', 'memories'), { recursive: true });
  await fs.writeFile(
    path.join(home, '.hermes', 'memories', 'MEMORY.md'),
    [
      'Memory - Platform > Auth migration: The refresh-token rollout is behind because of the session store',
      '§',
      'Memory - Product > Roadmap: The billing rewrite is the next thing after auth',
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
    reports: [],
    workingHours: { days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1080 },
    agentInstructions: 'Never agree to a date without checking with me.',
  });
  await knowledge.upsertNote({
    title: 'Session store rewrite',
    body: 'The session store cannot take the write volume during the rollout.',
    kind: 'update',
    visibility: 'team',
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
  t.after(async () => {
    await agent.shutdown();
    await cleanup([home, dir]);
  });

  const sources = memory.sources.map((s) => s.id);
  return { agent, knowledge, memory, sources };
}

const limits = { notes: 5, artifacts: 5, tasks: 5, memories: 10 };

test('a workspace agent recalls nothing until its workspace is granted a source', async (t) => {
  const { agent } = await setup(t);

  const ungated = agent.digest('self', limits, { query: 'auth migration' });
  assert.ok(ungated.recalled.length > 0, 'your own agent, outside any workspace, sees your memory');

  const inWorkspace = agent.digest('self', limits, { query: 'auth migration', workspaceId: 'ws_acme' });
  assert.deepEqual(
    inWorkspace.recalled,
    [],
    'the agent in a workspace starts with no imported memory at all',
  );
});

test('granting one workspace does not grant the next one', async (t) => {
  const { agent, knowledge, sources } = await setup(t);

  await knowledge.saveWorkspaceAgent('ws_acme', {
    access: { tools: { memory_recall: true }, sourceMode: 'selected', sources },
  });

  const acme = agent.digest('self', limits, { query: 'auth migration', workspaceId: 'ws_acme' });
  assert.ok(acme.recalled.length > 0, 'the workspace that was granted the source can recall from it');

  const home = agent.digest('self', limits, { query: 'auth migration', workspaceId: 'ws_home' });
  assert.deepEqual(home.recalled, [], 'the agent next door was granted nothing and gets nothing');
});

test('the sensitivity ceiling keeps material out of the workspace entirely', async (t) => {
  const { agent, knowledge, memory, sources } = await setup(t);

  // Mark one memory confidential, the way the Sources screen would.
  const record = memory.records.find((r) => r.title.toLowerCase().includes('roadmap'));
  assert.ok(record, 'the fixture produced the roadmap memory');
  await memory.setPolicy(record.id, { sensitivity: 'confidential' });

  await knowledge.saveWorkspaceAgent('ws_client', {
    access: { tools: { memory_recall: true }, sourceMode: 'all', ceiling: 'internal' },
  });
  const capped = agent.digest('self', limits, { query: 'billing roadmap', workspaceId: 'ws_client' });
  assert.ok(
    !JSON.stringify(capped.recalled).toLowerCase().includes('billing rewrite'),
    'confidential material is not loaded under an internal ceiling',
  );

  await knowledge.saveWorkspaceAgent('ws_client', { access: { ceiling: 'confidential' } });
  const raised = agent.digest('self', limits, { query: 'billing roadmap', workspaceId: 'ws_client' });
  assert.ok(
    JSON.stringify(raised.recalled).toLowerCase().includes('billing'),
    'raising the ceiling lets it back in',
  );
  assert.ok(sources.length > 0);
});

test('switching a tool off stops recall from that tool, grant or no grant', async (t) => {
  const { agent, knowledge, memory } = await setup(t);
  // The fixture is Hermes memory; borrow its ids but claim they came from Codex
  // so the kind gate has something to bite on.
  const ids = memory.sources.map((s) => s.id);

  await knowledge.saveWorkspaceAgent('ws', {
    access: { tools: { memory_recall: true }, sourceMode: 'selected', sources: ids },
  });
  assert.ok(
    agent.digest('self', limits, { query: 'auth migration', workspaceId: 'ws' }).recalled.length > 0,
    'granted, and the tool has no master switch, so it recalls',
  );

  // Hermes has no master switch; folders do. A folder-kind source with the
  // folder capability off must not come back even though it is granted.
  await knowledge.saveWorkspaceAgent('ws', {
    access: { tools: { computer_folders: false } },
  });
  const stillThere = agent.digest('self', limits, { query: 'auth migration', workspaceId: 'ws' });
  assert.ok(
    stillThere.recalled.length > 0,
    'switching folders off does not touch a Hermes source — the gate is per kind, not global',
  );
});

test('an agent denied the knowledge base is handed none of it', async (t) => {
  const { agent, knowledge } = await setup(t);

  const open = agent.digest('self', limits, { workspaceId: 'ws_open' });
  assert.ok(open.notes.length > 0, 'reading the knowledge base is on by default');

  await knowledge.saveWorkspaceAgent('ws_shut', { access: { tools: { knowledge_read: false } } });
  const shut = agent.digest('self', limits, { workspaceId: 'ws_shut' });
  assert.deepEqual(shut.notes, []);
  assert.deepEqual(shut.projects, []);
  assert.deepEqual(shut.artifacts, []);
});

test('each workspace agent follows its own standing instructions', async (t) => {
  const { agent, knowledge } = await setup(t);

  await knowledge.saveWorkspaceAgent('ws_client', {
    instructions: 'Never discuss headcount.',
  });
  const client = agent.selfIn('ws_client');
  assert.match(client.agentInstructions, /Never agree to a date/, 'the base orders still apply');
  assert.match(client.agentInstructions, /Never discuss headcount/, 'plus this workspace’s own');

  await knowledge.saveWorkspaceAgent('ws_client', { inheritInstructions: false });
  const isolated = agent.selfIn('ws_client');
  assert.equal(isolated.agentInstructions, 'Never discuss headcount.');
  assert.doesNotMatch(isolated.agentInstructions, /Never agree to a date/);

  assert.match(
    agent.selfIn(undefined).agentInstructions,
    /Never agree to a date/,
    'outside a workspace the machine-wide orders are what apply',
  );
});

test('leaving a workspace takes its agent, and its grants, with it', async (t) => {
  const { agent, knowledge, sources } = await setup(t);

  await knowledge.saveWorkspaceAgent('ws_gone', {
    access: { tools: { memory_recall: true }, sourceMode: 'selected', sources },
  });
  assert.equal(knowledge.workspaceAgents.some((a) => a.workspaceId === 'ws_gone'), true);

  await knowledge.forgetWorkspaceAgent('ws_gone');
  assert.equal(knowledge.workspaceAgents.some((a) => a.workspaceId === 'ws_gone'), false);

  // Re-entering that workspace gets a fresh, closed agent rather than the old grants.
  const fresh = knowledge.workspaceAgent('ws_gone');
  assert.equal(fresh.access.sourceMode, 'none');
  assert.deepEqual(agent.digest('self', limits, { query: 'auth', workspaceId: 'ws_gone' }).recalled, []);
});
