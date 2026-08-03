import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  MemoryIndex,
  Workspace,
  classifyMemory,
  detectSources,
  inspectFolder,
  syncMemory,
} from '../packages/agent/dist/index.js';

import { cleanup, makeTempDir } from './helpers.mjs';

/**
 * A miniature version of a real machine: one directory per agent tool, each
 * laid out the way that tool actually lays itself out on disk.
 */
async function buildFakeMachine() {
  const home = await makeTempDir('ai-coworker-home-');
  const write = async (relative, contents) => {
    const file = path.join(home, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents, 'utf8');
    return file;
  };

  // --- Claude Code ---------------------------------------------------------
  const project = path.join(home, 'work', 'api-server');
  await fs.mkdir(project, { recursive: true });
  await write('work/api-server/CLAUDE.md', '# api-server\n\nRun the tests with `npm test` before pushing.\n');
  await write(
    '.claude/projects/-home-work-api-server/session-a.jsonl',
    [
      JSON.stringify({ type: 'summary', sessionId: 'session-a' }),
      JSON.stringify({
        type: 'user',
        cwd: project,
        gitBranch: 'main',
        timestamp: '2026-01-04T10:00:00.000Z',
        message: { role: 'user', content: 'Split the billing service out of the monolith.' },
      }),
    ].join('\n'),
  );
  await write(
    '.claude/projects/-home-work-api-server/memory/feedback_stack.md',
    [
      '---',
      'name: User pivots stack mid-build',
      'description: Confirm the framework before scaffolding.',
      'type: feedback',
      '---',
      '',
      'They reversed the framework choice twice after work had started.',
      '',
      '**Why:** they only commit once they see it taking shape.',
    ].join('\n'),
  );
  await write(
    '.claude/projects/-home-work-api-server/memory/MEMORY.md',
    '- [User pivots stack mid-build](feedback_stack.md) — confirm before scaffolding.\n',
  );
  await write('.claude/CLAUDE.md', 'Always ask before force-pushing to a shared branch.\n');

  // --- Codex ---------------------------------------------------------------
  await write('.codex/AGENTS.md', 'Prefer small commits. Never rewrite published history.\n');
  // The same sentence Hermes has, written down by a second tool.
  await write('.codex/memories/setup.md', 'The agent runs locally on this machine.\n');
  await write(
    '.codex/session_index.jsonl',
    `${JSON.stringify({
      id: '019f545d-edb2-7e42-a434-969e205476c5',
      thread_name: 'Q3 revenue model',
      updated_at: '2026-01-05T12:00:00.000Z',
    })}\n`,
  );
  await write(
    '.codex/sessions/2026/01/05/rollout-2026-01-05T12-00-00-019f545d-edb2-7e42-a434-969e205476c5.jsonl',
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { session_id: '019f545d-edb2-7e42-a434-969e205476c5', cwd: '/home/work/finance', timestamp: '2026-01-05T12:00:00.000Z' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '<recommended_plugins>\n- Airtable\n</recommended_plugins>' },
            { type: 'input_text', text: 'Work out what our revenue and runway look like if we hire two more engineers.' },
          ],
        },
      }),
    ].join('\n'),
  );

  // --- OpenClaw ------------------------------------------------------------
  await write(
    '.openclaw/workspace/MEMORY.md',
    [
      '# Memory',
      '',
      '## System Setup',
      '- The agent runs locally on this machine.',
      '- All messaging goes through the agent.',
      '',
      '## Compensation review',
      '- Salary bands for the platform team are being revised this quarter.',
    ].join('\n'),
  );
  await write('.openclaw/workspace/USER.md', '**Name:** Riley\n**Timezone:** Eastern Time\n');
  await write(
    '.openclaw/workspace/memory/2026-01-06.md',
    '- Reminder: meeting with the Google team on Friday at 9:30am.\n- Bring the agenda and the open questions.\n',
  );
  // Boilerplate the tool ships with itself; nothing here was said by a human.
  await write('.openclaw/workspace/BOOTSTRAP.md', '<!-- edit this file to configure the agent -->\n');

  // --- Hermes --------------------------------------------------------------
  await write(
    '.hermes/memories/MEMORY.md',
    [
      'Memory - Key Context > System Setup (2026-01-02): The agent is deployed locally on this machine',
      '§',
      'Memory - Key Context > Access: The AWS deploy key is AKIAIOSFODNN7EXAMPLE and should be rotated',
      '§',
      'The agent runs locally on this machine.',
    ].join('\n'),
  );
  await write('.hermes/memories/USER.md', '**Name:** Riley\n§\nContext: prefers direct answers over hedging\n');
  await write('.hermes/SOUL.md', '<!--\nEdit this file to customize the personality.\n-->\n');

  return { home, project };
}

const fixtureContext = (home) => ({ home, env: {}, limits: { maxRecordsPerSource: 100, maxBodyChars: 2000 } });

test('every agent tool on the machine is found where it actually lives', async (t) => {
  const { home } = await buildFakeMachine();
  t.after(() => cleanup([home]));

  const sources = await detectSources(fixtureContext(home));
  const kinds = new Set(sources.map((s) => s.kind));
  assert.deepEqual([...kinds].sort(), ['claude-code', 'codex', 'hermes', 'openclaw']);

  // Claude Code is per project, and the project's real path is recovered from a
  // transcript rather than guessed back out of the flattened directory name.
  const project = sources.find((s) => s.scope === 'project');
  assert.ok(project, 'the project source is detected');
  assert.match(project.detail, /api-server/);
  assert.ok(sources.some((s) => s.id === 'codex:sessions'));
  assert.ok(sources.some((s) => s.id === 'hermes:memories'));
});

test('a sync imports every tool, and says what it did', async (t) => {
  const { home } = await buildFakeMachine();
  const workspace = await makeTempDir('ai-coworker-ws-');
  t.after(() => cleanup([home, workspace]));

  const index = await MemoryIndex.open(workspace);
  const report = await syncMemory(index, { context: fixtureContext(home) });

  assert.equal(report.totals.errors.length, 0, JSON.stringify(report.totals.errors));
  assert.ok(report.totals.added >= 10, `expected a real import, got ${report.totals.added}`);
  assert.equal(report.discovered.length, 0, 'everything detected was connected');

  const titles = index.records.map((r) => r.title);
  assert.ok(titles.includes('User pivots stack mid-build'), 'Claude Code memory files keep their names');
  assert.ok(titles.includes('Q3 revenue model'), "Codex threads keep the name Codex gave them");
  assert.ok(titles.some((t) => t.includes('System Setup')), 'OpenClaw sections become separate memories');
  assert.ok(titles.some((t) => t.startsWith('Name')), 'Hermes user facts are split on their separator');

  // Index files, tool boilerplate and template files are not memories.
  assert.ok(!titles.some((t) => t.includes('table of contents')));
  assert.ok(!index.records.some((r) => r.body.includes('edit this file to configure')));
  assert.ok(!index.records.some((r) => r.title === 'Agent persona'), 'an untouched persona template is skipped');

  // Provenance survives: every memory can be traced back to a file.
  for (const record of index.records) {
    assert.ok(record.sourceId, 'each memory knows its source');
    assert.ok(record.origin.path || record.origin.session, `${record.title} has no provenance`);
  }

  // The machine preamble is stripped, so what is stored is what the human typed.
  const thread = index.records.find((r) => r.title === 'Q3 revenue model');
  assert.match(thread.body, /hire two more engineers/);
  assert.ok(!thread.body.includes('recommended_plugins'));
  assert.ok(!thread.body.includes('Airtable'));
});

test('sensitive material is classified on the way in, credentials are quarantined', async (t) => {
  const { home } = await buildFakeMachine();
  const workspace = await makeTempDir('ai-coworker-ws-');
  t.after(() => cleanup([home, workspace]));

  const index = await MemoryIndex.open(workspace);
  await syncMemory(index, { context: fixtureContext(home) });

  const revenue = index.records.find((r) => r.title === 'Q3 revenue model');
  assert.equal(revenue.policy.sensitivity, 'confidential');
  assert.ok(revenue.policy.topics.includes('finance'), revenue.policy.topics.join(','));
  assert.ok(revenue.policy.gist, 'a withheld memory still has something safe to say');

  const salaries = index.records.find((r) => r.title.includes('Compensation review'));
  assert.equal(salaries.policy.sensitivity, 'confidential');
  assert.ok(salaries.policy.topics.includes('people'));

  const identity = index.records.find((r) => r.title.startsWith('Name'));
  assert.equal(identity.policy.sensitivity, 'restricted', 'facts about the human are theirs to release');

  const key = index.records.find((r) => r.body.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(key, 'the memory is kept — deleting someone\'s file behind their back is worse');
  assert.equal(key.status, 'quarantined');
  assert.equal(key.policy.sensitivity, 'secret');

  const owner = { address: 'riley@northwind', team: 'platform', reports: [] };
  const recalled = index.query({ owner, text: 'AWS deploy key', limit: 10 });
  assert.ok(
    !recalled.some((hit) => hit.record.id === key.id),
    'a quarantined memory is never recallable, not even by its owner',
  );
  assert.ok(!JSON.stringify(recalled).includes('AKIAIOSFODNN7EXAMPLE'), 'the key itself never comes back');
});

test('a second sync reads what changed and nothing else', async (t) => {
  const { home } = await buildFakeMachine();
  const workspace = await makeTempDir('ai-coworker-ws-');
  t.after(() => cleanup([home, workspace]));

  const index = await MemoryIndex.open(workspace);
  const first = await syncMemory(index, { context: fixtureContext(home) });
  const countAfterFirst = index.records.length;

  const second = await syncMemory(index, { context: fixtureContext(home) });
  assert.equal(second.totals.added, 0, 'nothing is imported twice');
  assert.equal(second.totals.updated, 0);
  assert.equal(index.records.length, countAfterFirst, 'the index does not grow on a no-op sync');

  // Edit a memory file the way a person would, and push its timestamp forward.
  const memoryFile = path.join(home, '.claude/projects/-home-work-api-server/memory/feedback_stack.md');
  const edited = (await fs.readFile(memoryFile, 'utf8')).replace('twice', 'three times');
  await fs.writeFile(memoryFile, edited, 'utf8');
  const future = new Date(Date.now() + 60_000);
  await fs.utimes(memoryFile, future, future);

  const third = await syncMemory(index, { context: fixtureContext(home) });
  assert.equal(third.totals.added, 0, 'an edit updates the memory, it does not make a second one');
  assert.equal(third.totals.updated, 1);
  assert.equal(index.records.length, countAfterFirst);
  const updated = index.records.find((r) => r.title === 'User pivots stack mid-build');
  assert.match(updated.body, /three times/);

  // A full re-read still converges on the same set.
  const fourth = await syncMemory(index, { context: fixtureContext(home), full: true });
  assert.equal(fourth.totals.added, 0);
  assert.equal(index.records.length, countAfterFirst);
});

test('the same fact arriving from two tools is recorded once, with both sightings', async (t) => {
  const { home } = await buildFakeMachine();
  const workspace = await makeTempDir('ai-coworker-ws-');
  t.after(() => cleanup([home, workspace]));

  const index = await MemoryIndex.open(workspace);
  const report = await syncMemory(index, { context: fixtureContext(home) });

  // "The agent runs locally on this machine." is written in both the OpenClaw
  // workspace and the Hermes memory file.
  assert.ok(report.totals.duplicates >= 1, 'the repeat is recognised');
  const matches = index.records.filter((r) => r.body.trim() === 'The agent runs locally on this machine.');
  assert.equal(matches.length, 1, 'one fact, one memory');
  assert.ok(matches[0].alsoSeenIn.length >= 1, 'the second sighting is recorded against it');
});

test('a human decision about sharing survives every later sync', async (t) => {
  const { home } = await buildFakeMachine();
  const workspace = await makeTempDir('ai-coworker-ws-');
  t.after(() => cleanup([home, workspace]));

  const index = await MemoryIndex.open(workspace);
  await syncMemory(index, { context: fixtureContext(home) });

  const revenue = index.records.find((r) => r.title === 'Q3 revenue model');
  await index.grant(revenue.id, 'team:platform');
  await index.setPolicy(revenue.id, { sensitivity: 'restricted' });
  await index.flush();

  await syncMemory(index, { context: fixtureContext(home), full: true });
  const after = index.record(revenue.id);
  assert.equal(after.policy.sensitivity, 'restricted', 'the classifier does not overrule a person');
  assert.ok(after.policy.pinned);
  assert.equal(after.policy.allow.length, 1);

  // And it survives a restart, because it is written into the file.
  await index.flush();
  const reopened = await MemoryIndex.open(workspace);
  const reloaded = reopened.record(revenue.id);
  assert.equal(reloaded.policy.sensitivity, 'restricted');
  assert.deepEqual(reloaded.policy.allow, [{ kind: 'team', value: 'platform' }]);
  assert.equal(reloaded.policy.pinned, true);
});

test('recall answers differently depending on who is asking', async (t) => {
  const { home } = await buildFakeMachine();
  const workspace = await makeTempDir('ai-coworker-ws-');
  t.after(() => cleanup([home, workspace]));

  const index = await MemoryIndex.open(workspace);
  await syncMemory(index, { context: fixtureContext(home) });

  const owner = { address: 'riley@northwind', team: 'leadership', reports: ['sam@northwind'] };

  const mine = index.query({ owner, text: 'revenue runway', limit: 5 });
  assert.ok(mine.length > 0);
  assert.equal(mine[0].shared.level, 'full', 'my own agent reads my own memory in full');

  const toReport = index.query({
    owner,
    requester: { address: 'sam@northwind', role: 'ic', team: 'platform' },
    text: 'revenue runway',
    limit: 5,
  });
  assert.ok(toReport.length > 0, 'the subject is still acknowledged');
  assert.ok(
    toReport.every((hit) => hit.shared.level === 'gist'),
    'but an engineer gets the subject, not the numbers',
  );
  assert.ok(toReport.every((hit) => hit.shared.body === undefined));

  const toOutsider = index.query({
    owner,
    requester: { address: 'someone@elsewhere' },
    text: 'revenue runway',
    limit: 5,
  });
  assert.equal(toOutsider.length, 0, 'nothing internal crosses the company boundary');
});

test('the index knows what it has not got', async (t) => {
  const { home } = await buildFakeMachine();
  const workspace = await makeTempDir('ai-coworker-ws-');
  t.after(() => cleanup([home, workspace]));

  const index = await MemoryIndex.open(workspace);
  const detected = await detectSources(fixtureContext(home));

  const before = index.coverage(detected);
  assert.equal(before.totalMemories, 0);
  assert.equal(before.unconnected.length, detected.length, 'everything found is reported as not yet connected');

  await syncMemory(index, { context: fixtureContext(home) });
  const after = index.coverage(await detectSources(fixtureContext(home)));
  assert.equal(after.unconnected.length, 0);
  assert.ok(after.active > 0);
  assert.equal(after.staleSources.length, 0, 'a source synced just now is not stale');
  assert.ok(after.byKind.length >= 4);
  assert.ok(after.bySensitivity.some((row) => row.level === 'confidential'));
});

test('disconnecting a tool can take its memories with it', async (t) => {
  const { home } = await buildFakeMachine();
  const workspace = await makeTempDir('ai-coworker-ws-');
  t.after(() => cleanup([home, workspace]));

  const index = await MemoryIndex.open(workspace);
  await syncMemory(index, { context: fixtureContext(home) });

  const hermesCount = index.recordsFrom('hermes:memories').length;
  assert.ok(hermesCount > 0);

  const removed = await index.removeSource('hermes:memories', { purge: true });
  await index.flush();
  assert.equal(removed, hermesCount);
  assert.equal(index.recordsFrom('hermes:memories').length, 0);
  assert.equal(index.source('hermes:memories'), undefined);

  const files = await fs.readdir(path.join(workspace, 'memory', 'records'));
  assert.ok(!files.some((f) => f.startsWith('hermes-')), 'the files are gone from disk too');
});

test('any other agent\'s folder can be connected by hand', async (t) => {
  const home = await makeTempDir('ai-coworker-other-');
  const workspace = await makeTempDir('ai-coworker-ws-');
  t.after(() => cleanup([home, workspace]));

  await fs.writeFile(
    path.join(home, 'MEMORY.md'),
    '# Notes\n\n## Deployment\n- The staging cluster is rebuilt every Monday.\n',
    'utf8',
  );

  const source = await inspectFolder(home);
  assert.ok(source, 'a directory with a MEMORY.md is a valid source');
  assert.equal(source.kind, 'folder');

  const index = await MemoryIndex.open(workspace);
  await index.connectSource(source, true);
  const report = await syncMemory(index, { context: { home: workspace, env: {} }, only: [source.id] });

  assert.equal(report.totals.added, 1);
  assert.match(index.records[0].title, /Deployment/);
});

test('memories are markdown a person can read and edit', async (t) => {
  const { home } = await buildFakeMachine();
  const workspace = await makeTempDir('ai-coworker-ws-');
  t.after(() => cleanup([home, workspace]));

  const index = await MemoryIndex.open(workspace);
  await syncMemory(index, { context: fixtureContext(home) });
  await index.flush();

  const dir = path.join(workspace, 'memory', 'records');
  const files = await fs.readdir(dir);
  assert.ok(files.length > 0);
  const raw = await fs.readFile(path.join(dir, files[0]), 'utf8');
  assert.match(raw, /^---\n/);
  assert.match(raw, /sensitivity: /);
  assert.match(raw, /source: /);

  const sources = JSON.parse(await fs.readFile(path.join(workspace, 'memory', 'sources.json'), 'utf8'));
  assert.ok(sources.sources.length >= 4);
  assert.ok(sources.sources.every((s) => typeof s.watermark === 'number'));
});

test('the classifier is a pure function of the text', () => {
  const finance = classifyMemory({
    title: 'Runway update',
    body: 'We have 14 months of runway at the current burn rate.',
    tags: [],
    kind: 'fact',
    sourceKind: 'folder',
  });
  assert.equal(finance.policy.sensitivity, 'confidential');
  assert.deepEqual(finance.policy.topics.slice(0, 1), ['finance']);

  const marked = classifyMemory({
    title: 'Reorg thinking',
    body: 'Do not share: I am considering moving the platform team under infra.',
    tags: [],
    kind: 'fact',
    sourceKind: 'folder',
  });
  assert.equal(marked.policy.sensitivity, 'restricted');
  assert.match(marked.policy.rationale, /do not share/i);

  const ordinary = classifyMemory({
    title: 'Test command',
    body: 'Run the test suite with npm test before pushing a branch.',
    tags: [],
    kind: 'instruction',
    sourceKind: 'claude-code',
  });
  assert.equal(ordinary.policy.sensitivity, 'internal');
  assert.equal(ordinary.quarantine, false);
});

test('talking about tokens is engineering; a token that moved is not', () => {
  // Locking down every memory that says "token" would hide most of what an
  // engineer's agent knows about their own work.
  const work = classifyMemory({
    title: 'Auth migration',
    body: 'The refresh-token rollout is behind because of the session store.',
    tags: [],
    kind: 'fact',
    sourceKind: 'codex',
  });
  assert.equal(work.policy.sensitivity, 'internal');
  assert.ok(work.policy.topics.includes('security'), 'it is still recognised as touching security');

  const incident = classifyMemory({
    title: 'Auth incident',
    body: 'A refresh token was hard-coded in the deploy script and has leaked.',
    tags: [],
    kind: 'fact',
    sourceKind: 'codex',
  });
  assert.equal(incident.policy.sensitivity, 'confidential');
  assert.match(incident.policy.rationale, /exposed/);

  const actualKey = classifyMemory({
    title: 'Deploy notes',
    body: 'export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345',
    tags: [],
    kind: 'reference',
    sourceKind: 'folder',
  });
  assert.equal(actualKey.quarantine, true);
  assert.equal(actualKey.policy.sensitivity, 'secret');
  assert.deepEqual(actualKey.policy.deny, [{ kind: 'anyone' }]);
});
