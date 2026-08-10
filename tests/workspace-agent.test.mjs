/**
 * One agent per workspace, and the gates that make that true.
 *
 * The promise the product makes is not "each workspace has its own agent name".
 * It is that the agent in one workspace cannot reach what the agent in another
 * was granted. These tests are written against that sentence: every one of them
 * asks whether something leaks across the workspace line.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_TOOLS,
  agentMay,
  agentMayReadPath,
  agentMayUseSource,
  agentMayUseSourceKind,
  agentMaySeeSensitivity,
  agentSourceScope,
  applyAgentPatch,
  defaultWorkspaceAgent,
  describeAgentReach,
  liveTools,
  normalizeWorkspaceAgent,
  overlappingReach,
} from '../packages/shared/dist/index.js';

function grant(agent, patch) {
  return applyAgentPatch(agent, patch);
}

test('a fresh workspace agent reaches nothing on the machine', () => {
  const agent = defaultWorkspaceAgent('ws_acme');

  assert.equal(agent.access.sourceMode, 'none');
  assert.deepEqual(agent.access.sources, []);
  assert.deepEqual(agent.access.folders, []);
  assert.equal(agentMay(agent, 'memory_recall'), false);
  assert.equal(agentMay(agent, 'computer_folders'), false);
  assert.equal(agentMay(agent, 'computer_claude_code'), false);
  assert.deepEqual(
    agentSourceScope(agent),
    [],
    'an empty scope is a hard stop, not "unfiltered"',
  );
});

test('the everyday workspace capabilities are on, the machine ones are not', () => {
  const agent = defaultWorkspaceAgent('ws_acme');
  assert.equal(agentMay(agent, 'messages'), true);
  assert.equal(agentMay(agent, 'meetings'), true);
  assert.equal(agentMay(agent, 'knowledge_read'), true);
  assert.equal(agentMay(agent, 'knowledge_write'), false, 'writing is opt-in');
});

test('every tool offered on the screen is one the runtime actually gates', () => {
  // The catalogue is allowed to describe reach that does not exist yet, but the
  // screen must never offer it — a switch that does nothing is worse than none.
  for (const tool of liveTools()) {
    assert.equal(tool.implemented, true, `${tool.key} is offered but not implemented`);
  }
  const unimplemented = AGENT_TOOLS.filter((t) => !t.implemented);
  for (const tool of unimplemented) {
    const agent = grant(defaultWorkspaceAgent('ws'), { access: { tools: { [tool.key]: true } } });
    assert.equal(
      agentMay(agent, tool.key),
      false,
      `${tool.key} is not implemented, so switching it on must still deny`,
    );
  }
});

test('watching only holds off everything that puts something into the world', () => {
  const agent = grant(defaultWorkspaceAgent('ws_acme'), {
    autonomy: 'observer',
    access: { tools: { knowledge_write: true, tasks: true, meetings: true } },
  });

  assert.equal(agentMay(agent, 'knowledge_write'), false);
  assert.equal(agentMay(agent, 'tasks'), false);
  assert.equal(agentMay(agent, 'meetings'), false);
  assert.equal(agentMay(agent, 'messages'), true, 'reading is still allowed');
  assert.equal(agentMay(agent, 'knowledge_read'), true);
});

test('a source granted to one workspace is not reachable from another', () => {
  const acme = grant(defaultWorkspaceAgent('ws_acme'), {
    access: { tools: { memory_recall: true }, sourceMode: 'selected', sources: ['claude-code:global'] },
  });
  const home = defaultWorkspaceAgent('ws_home');

  assert.equal(agentMayUseSource(acme, 'claude-code:global'), true);
  assert.equal(agentMayUseSource(home, 'claude-code:global'), false);
  assert.deepEqual(overlappingReach(acme, home), [], 'nothing is shared between them');
});

test('"everything imported" means every source, and says so', () => {
  const wide = grant(defaultWorkspaceAgent('ws'), {
    access: { tools: { memory_recall: true }, sourceMode: 'all' },
  });
  assert.equal(agentSourceScope(wide), null, 'null is the only "no filter" answer');
  assert.equal(agentMayUseSource(wide, 'anything-at-all'), true);
});

test('switching recall off closes the gate however the sources are set', () => {
  const agent = grant(defaultWorkspaceAgent('ws'), {
    access: { sourceMode: 'all', sources: ['a', 'b'], tools: { memory_recall: false } },
  });
  assert.deepEqual(agentSourceScope(agent), []);
  assert.equal(agentMayUseSource(agent, 'a'), false);
});

test('switching a tool off covers every source of that kind, granted or not', () => {
  const agent = grant(defaultWorkspaceAgent('ws'), {
    access: {
      tools: { memory_recall: true, computer_claude_code: true, computer_codex: false },
      sourceMode: 'selected',
      sources: ['claude-code:global', 'codex:global', 'hermes:global'],
    },
  });

  assert.equal(agentMayUseSource(agent, 'claude-code:global', 'claude-code'), true);
  assert.equal(
    agentMayUseSource(agent, 'codex:global', 'codex'),
    false,
    'the grant survives, but the tool is switched off — the stricter answer wins',
  );
  assert.equal(
    agentMayUseSource(agent, 'hermes:global', 'hermes'),
    true,
    'a kind with no master switch is governed by the grant alone',
  );
});

test('a kind switch cannot let anything through when recall itself is off', () => {
  const agent = grant(defaultWorkspaceAgent('ws'), {
    access: {
      tools: { memory_recall: false, computer_claude_code: true },
      sourceMode: 'all',
    },
  });
  assert.equal(agentMayUseSourceKind(agent, 'claude-code'), false);
  assert.equal(agentMayUseSource(agent, 'anything', 'claude-code'), false);
});

test('"everything imported" still respects the per-tool switches', () => {
  const agent = grant(defaultWorkspaceAgent('ws'), {
    access: { tools: { memory_recall: true, computer_codex: false }, sourceMode: 'all' },
  });
  assert.equal(agentMayUseSource(agent, 'codex:global', 'codex'), false);
  assert.equal(agentMayUseSource(agent, 'hermes:global', 'hermes'), true);
});

test('the ceiling keeps sensitive material out of the workspace entirely', () => {
  const agent = grant(defaultWorkspaceAgent('ws'), { access: { ceiling: 'internal' } });
  assert.equal(agentMaySeeSensitivity(agent, 'public'), true);
  assert.equal(agentMaySeeSensitivity(agent, 'internal'), true);
  assert.equal(agentMaySeeSensitivity(agent, 'confidential'), false);
  assert.equal(agentMaySeeSensitivity(agent, 'secret'), false);

  const trusted = grant(agent, { access: { ceiling: 'confidential' } });
  assert.equal(agentMaySeeSensitivity(trusted, 'confidential'), true);
  assert.equal(agentMaySeeSensitivity(trusted, 'restricted'), false);
});

test('a folder grant does not spill into the folder next door', () => {
  const agent = grant(defaultWorkspaceAgent('ws'), {
    access: { tools: { computer_folders: true }, folders: ['/work/acme'] },
  });

  assert.equal(agentMayReadPath(agent, '/work/acme'), true);
  assert.equal(agentMayReadPath(agent, '/work/acme/src/index.ts'), true);
  assert.equal(
    agentMayReadPath(agent, '/work/acme-secrets/keys.txt'),
    false,
    'prefix matching must stop at a path separator',
  );
  assert.equal(agentMayReadPath(agent, '/work'), false, 'a parent is not granted by a child');
});

test('a folder listed but with the capability off is not readable', () => {
  const agent = grant(defaultWorkspaceAgent('ws'), {
    access: { tools: { computer_folders: false }, folders: ['/work/acme'] },
  });
  assert.equal(agentMayReadPath(agent, '/work/acme/file.md'), false);
});

test('the reach sentence is true, and says nothing when there is nothing', () => {
  const bare = grant(defaultWorkspaceAgent('ws'), { access: { tools: { knowledge_read: false } } });
  assert.match(describeAgentReach(bare), /nothing/i);

  const wide = grant(defaultWorkspaceAgent('ws'), {
    access: {
      tools: { memory_recall: true, computer_folders: true },
      sourceMode: 'selected',
      sources: ['a', 'b'],
      folders: ['/work/acme'],
    },
  });
  const sentence = describeAgentReach(wide);
  assert.match(sentence, /2 imported sources/);
  assert.match(sentence, /1 folder/);
  assert.match(sentence, /internal/, 'the ceiling is part of the reach, not a footnote');
});

test('overlap between two agents is reported, because that is the thing worth seeing', () => {
  const a = grant(defaultWorkspaceAgent('ws_a'), {
    access: {
      tools: { memory_recall: true, computer_folders: true },
      sourceMode: 'selected',
      sources: ['codex:global', 'folder:notes'],
      folders: ['/work/shared'],
    },
  });
  const b = grant(defaultWorkspaceAgent('ws_b'), {
    access: {
      tools: { memory_recall: true, computer_folders: true },
      sourceMode: 'selected',
      sources: ['codex:global'],
      folders: ['/work/shared', '/work/only-b'],
    },
  });

  assert.deepEqual(overlappingReach(a, b).sort(), ['/work/shared', 'codex:global']);
});

test('a stored agent from an older version comes back whole', () => {
  const restored = normalizeWorkspaceAgent('ws', {
    name: 'Ada',
    access: { sources: ['x', 'x'], tools: { memory_recall: true } },
  });

  assert.equal(restored.name, 'Ada');
  assert.equal(restored.workspaceId, 'ws');
  assert.deepEqual(restored.access.sources, ['x'], 'duplicates are collapsed');
  assert.equal(restored.access.ceiling, 'internal', 'missing fields fall back to the default');
  assert.equal(restored.access.tools.messages, true, 'tools it never heard of get their default');
  assert.equal(restored.access.tools.memory_recall, true, 'what it did set survives');
});

test('patching an agent never widens something the patch did not mention', () => {
  const before = grant(defaultWorkspaceAgent('ws'), {
    access: { tools: { memory_recall: true }, sourceMode: 'selected', sources: ['a'] },
  });
  const after = applyAgentPatch(before, { name: 'Renamed' });

  assert.equal(after.name, 'Renamed');
  assert.deepEqual(after.access.sources, ['a']);
  assert.equal(after.access.sourceMode, 'selected');
  assert.ok(after.updatedAt >= before.updatedAt);
});

test('an empty name is refused rather than stored', () => {
  const agent = defaultWorkspaceAgent('ws', { name: 'Ada' });
  assert.equal(applyAgentPatch(agent, { name: '   ' }).name, 'Ada');
});
