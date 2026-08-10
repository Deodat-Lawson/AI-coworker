/**
 * Uploaded workspace icons, and the wall the relay puts in front of them.
 *
 * An icon lives inside the workspace record, which is replicated to every
 * member on every reconnect. That makes the size limit a real defence rather
 * than a nicety, and it makes the relay — not the app that happened to send it
 * — the place the limit has to hold.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ICON_MAX_BYTES, validateIconImage } from '../packages/shared/dist/index.js';

import { cleanup, startAgent, startRelay, until } from './helpers.mjs';

/** A data URI of roughly `bytes` decoded length. */
function fakeIcon(bytes, mime = 'image/png') {
  const payload = 'A'.repeat(Math.ceil((bytes * 4) / 3));
  return `data:${mime};base64,${payload}`;
}

async function scene(t) {
  const relay = await startRelay();
  const dana = await startAgent('dana', relay.url);
  t.after(async () => {
    await dana.agent.shutdown();
    await relay.stop();
    await cleanup([dana.dir]);
  });
  return dana;
}

test('the validator accepts what the app produces and refuses what it cannot', () => {
  assert.deepEqual(validateIconImage(''), { ok: true }, 'no icon is fine');
  assert.equal(validateIconImage(fakeIcon(4_000)).ok, true);
  assert.equal(validateIconImage(fakeIcon(4_000, 'image/webp')).ok, true);

  assert.equal(validateIconImage('https://example.com/logo.png').ok, false, 'a URL is not an icon');
  assert.equal(validateIconImage('data:text/html;base64,PHNjcmlwdD4=').ok, false, 'not an image type');
  assert.equal(
    validateIconImage(fakeIcon(ICON_MAX_BYTES + 5_000)).ok,
    false,
    'over the ceiling is refused',
  );
});

test('an uploaded icon reaches every member of the workspace', async (t) => {
  const dana = await scene(t);
  await until(() => dana.agent.workspaces.all[0], 'a snapshot');

  const icon = fakeIcon(2_000);
  dana.agent.createWorkspace({ name: 'Marked', iconImage: icon });
  const created = await until(
    () => dana.agent.workspaces.all.find((s) => s.workspace.name === 'Marked'),
    'workspace created',
  );
  assert.equal(created.workspace.iconImage, icon, 'the image rode along with the record');

  // And it can be cleared again, falling back to the emoji.
  dana.agent.updateWorkspace(created.workspace.id, { iconImage: '' });
  await until(
    () => !dana.agent.workspaces.get(created.workspace.id).workspace.iconImage,
    'the icon was cleared',
  );
  assert.ok(
    dana.agent.workspaces.get(created.workspace.id).workspace.icon,
    'the emoji is still there to fall back to',
  );
});

test('a member picture is per workspace, and bounded the same way', async (t) => {
  const dana = await scene(t);
  const state = await until(() => dana.agent.workspaces.all[0], 'a snapshot');
  const id = state.workspace.id;

  const picture = fakeIcon(3_000, 'image/webp');
  dana.agent.setWorkspaceProfile(id, { avatar: picture });
  await until(() => dana.agent.workspaces.get(id).me.avatar === picture, 'the picture arrives');

  // A second workspace is a separate membership, so it starts without one.
  dana.agent.createWorkspace({ name: 'Side Project' });
  const other = await until(
    () => dana.agent.workspaces.all.find((s) => s.workspace.name === 'Side Project'),
    'second workspace',
  );
  assert.equal(other.me.avatar, undefined, 'the picture did not follow you across');

  // Oversized is refused, and the one already set survives the attempt.
  dana.agent.setWorkspaceProfile(id, { avatar: fakeIcon(ICON_MAX_BYTES * 2) });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(dana.agent.workspaces.get(id).me.avatar, picture);

  // And it can be taken off again.
  dana.agent.setWorkspaceProfile(id, { avatar: '' });
  await until(() => !dana.agent.workspaces.get(id).me.avatar, 'the picture was removed');
});

test('the relay refuses an oversized icon rather than replicating it', async (t) => {
  const dana = await scene(t);
  const state = await until(() => dana.agent.workspaces.all[0], 'a snapshot');
  const before = state.workspace.iconImage;

  dana.agent.updateWorkspace(state.workspace.id, { iconImage: fakeIcon(ICON_MAX_BYTES * 2) });
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal(
    dana.agent.workspaces.get(state.workspace.id).workspace.iconImage,
    before,
    'the workspace kept the icon it had',
  );
});
