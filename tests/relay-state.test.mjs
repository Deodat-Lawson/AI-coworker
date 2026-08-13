/**
 * A relay nobody has used yet must still remember its own default workspace.
 * Before this, `ensureDefaultWorkspace` created it in memory and left the file
 * unwritten until some later mutation happened to call save() — so a fresh
 * relay minted a new workspace id on every restart.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { WorkspaceHub } from '../packages/server/dist/hub.js';

test('a default workspace survives a restart with nothing else happening', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stead-hub-'));
  const statePath = path.join(dir, 'nested', 'relay-workspaces.json');

  try {
    const first = new WorkspaceHub({ statePath, defaultWorkspaceName: 'Home' });
    const original = first.homeWorkspaceId;
    assert.ok(original, 'a default workspace is created');
    first.flush();

    assert.ok(fs.existsSync(statePath), 'the state file is written without any mutation');

    // A second hub over the same file is what a restart looks like.
    const second = new WorkspaceHub({ statePath, defaultWorkspaceName: 'Home' });
    assert.equal(second.homeWorkspaceId, original, 'the id is the same one, not a new one');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
