/**
 * Accounts and registration.
 *
 * The flow is Slack's, so the tests are written as the journey somebody
 * actually takes — email, code, name, workspace, invite a colleague — plus the
 * things that must not work: guessing a code, reusing one, claiming somebody
 * else's address on the socket, or reading a mailbox you do not own.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import {
  Accounts,
  AuthHttp,
  LogMailer,
  Relay,
  addressForEmail,
  isCorporateDomain,
  nameFromEmail,
  passwordProblem,
  hashPassword,
  verifyPassword,
} from '../packages/server/dist/index.js';
import { cleanup, makeTempDir, startAgent, until } from './helpers.mjs';

/** A relay with accounts turned on, and an HTTP client for its auth endpoints. */
async function scene(t, { auth = 'optional' } = {}) {
  const mailer = new LogMailer();
  const accounts = new Accounts({ mailer, relayName: 'Testworks', codeTtlMs: 60_000 });
  const relay = new Relay({
    auth,
    accounts,
    negotiationTimeoutMs: 3000,
    joinTimeoutMs: 1500,
    log: () => {},
  });
  const authHttp = new AuthHttp({ accounts, hub: relay.hub, relayName: 'Testworks' });

  const server = http.createServer((req, res) => {
    void authHttp.handle(req, res).then((handled) => {
      if (handled) return;
      res.writeHead(404).end();
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => relay.handleConnection(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const base = `http://127.0.0.1:${port}`;
  const call = async (path, body, token) => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  t.after(async () => {
    relay.shutdown();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  });

  return { relay, accounts, mailer, call, wsUrl: `ws://127.0.0.1:${port}` };
}

/** Pull the six digits out of whatever the mailer was handed. */
function codeFrom(mailer, email) {
  const mail = mailer.lastFor(email);
  assert.ok(mail, `no mail was sent to ${email}`);
  const match = /\b(\d{6})\b/.exec(mail.subject + mail.text);
  assert.ok(match, `no code in the mail to ${email}`);
  return match[1];
}

/** Email, code, name — the three steps every account starts with. */
async function register(scene, email, displayName, password) {
  await scene.call('/auth/start', { email });
  const verified = await scene.call('/auth/verify', {
    email,
    code: codeFrom(scene.mailer, email),
  });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  const token = verified.body.token;
  await scene.call('/auth/profile', { displayName, password }, token);
  return { token, account: verified.body.account, verified: verified.body };
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test('the whole sign-up, from an email address to a workspace with a colleague in it', async (t) => {
  const s = await scene(t);

  // 1 — an email, and a code that actually goes somewhere.
  const start = await s.call('/auth/start', { email: 'Ada@Northwind.io' });
  assert.equal(start.status, 200);
  assert.equal(start.body.sent, true);
  const mail = s.mailer.lastFor('ada@northwind.io');
  assert.ok(mail, 'a code was sent');
  assert.match(mail.subject, /Testworks/);

  // 2 — the code.
  const code = codeFrom(s.mailer, 'ada@northwind.io');
  const verified = await s.call('/auth/verify', { email: 'ada@northwind.io', code });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.created, true);
  assert.equal(verified.body.needsProfile, true);
  assert.ok(verified.body.token);
  // The address is derived rather than claimed, and it is recognisably hers.
  assert.equal(verified.body.account.address, 'ada@northwind');
  const token = verified.body.token;

  // 3 — her name, and a password so next time is one step.
  const profile = await s.call(
    '/auth/profile',
    { displayName: 'Ada Lovelace', password: 'difference-engine-1' },
    token,
  );
  assert.equal(profile.status, 200);
  assert.equal(profile.body.account.displayName, 'Ada Lovelace');
  assert.equal(profile.body.account.hasPassword, true);

  // 4 and 5 — the workspace, and the project that becomes its first channel.
  const created = await s.call(
    '/auth/workspace',
    { name: 'Northwind', project: 'Auth Migration' },
    token,
  );
  assert.equal(created.status, 200);
  assert.equal(created.body.workspace.name, 'Northwind');
  assert.equal(created.body.createdChannel, 'auth-migration');
  const workspaceId = created.body.workspace.id;
  const channels = s.relay.hub.channelsOf(workspaceId).map((c) => c.name);
  assert.ok(channels.includes('general'), '#general is always there');
  assert.ok(channels.includes('auth-migration'), 'the project became a channel');

  // 6 — the rest of the team.
  const invited = await s.call(
    '/auth/invite',
    { workspaceId, emails: ['sarah@northwind.io', 'not-an-email'] },
    token,
  );
  assert.equal(invited.status, 200);
  assert.equal(invited.body.invited.length, 1, 'the malformed address was dropped, not fatal');
  assert.equal(invited.body.invited[0].email, 'sarah@northwind.io');
  const invitation = s.mailer.lastFor('sarah@northwind.io');
  assert.ok(invitation, 'the invitation was emailed');
  assert.match(invitation.text, /Ada Lovelace/);
  assert.match(invitation.text, /Northwind/);

  // And Sarah's own sign-up finds the workspace waiting for her.
  const sarah = await register(s, 'sarah@northwind.io', 'Sarah Chen');
  const offered = sarah.verified.workspaces.find((w) => w.id === workspaceId);
  assert.ok(offered, 'her email domain matched the workspace Ada claimed');
  assert.equal(offered.joined, false);
  assert.equal(sarah.verified.invitations.length, 1, 'and her invitation is waiting');

  const joined = await s.call('/auth/join', { workspaceId }, sarah.token);
  assert.equal(joined.status, 200);
  const members = s.relay.hub.publicView(workspaceId).memberCount;
  assert.equal(members, 2, 'both of them are in it');
});

test('signing in again takes one step with a password, and still works without one', async (t) => {
  const s = await scene(t);
  await register(s, 'ada@northwind.io', 'Ada Lovelace', 'difference-engine-1');

  const login = await s.call('/auth/login', {
    email: 'ada@northwind.io',
    password: 'difference-engine-1',
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.account.displayName, 'Ada Lovelace');

  const wrong = await s.call('/auth/login', { email: 'ada@northwind.io', password: 'nope' });
  assert.equal(wrong.status, 401);

  // Somebody who never set one signs in with a fresh code, which is no worse.
  await register(s, 'grace@northwind.io', 'Grace Hopper');
  const again = await s.call('/auth/start', { email: 'grace@northwind.io' });
  assert.equal(again.status, 200);
  const second = await s.call('/auth/verify', {
    email: 'grace@northwind.io',
    code: codeFrom(s.mailer, 'grace@northwind.io'),
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.created, false, 'the same account, not a second one');
});

// ---------------------------------------------------------------------------
// The things that must not work
// ---------------------------------------------------------------------------

test('a code cannot be guessed, reused, or used after it expires', async (t) => {
  const s = await scene(t);
  await s.call('/auth/start', { email: 'ada@northwind.io' });
  const code = codeFrom(s.mailer, 'ada@northwind.io');

  // Wrong guesses are refused, counted, and say how many are left.
  for (let i = 0; i < 4; i++) {
    const wrong = await s.call('/auth/verify', { email: 'ada@northwind.io', code: '000000' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.code, 'bad_code');
    assert.match(wrong.body.error, /attempt\(s\) left/);
  }
  // The fifth exhausts them and burns the code, even though it was right all along.
  const fifth = await s.call('/auth/verify', { email: 'ada@northwind.io', code: '000000' });
  assert.equal(fifth.status, 429);
  const afterBurn = await s.call('/auth/verify', { email: 'ada@northwind.io', code });
  assert.equal(afterBurn.status, 400);
  assert.equal(afterBurn.body.code, 'no_code');

  // A code is single-use.
  await s.call('/auth/start', { email: 'ada@northwind.io' });
  const fresh = codeFrom(s.mailer, 'ada@northwind.io');
  assert.equal((await s.call('/auth/verify', { email: 'ada@northwind.io', code: fresh })).status, 200);
  const replay = await s.call('/auth/verify', { email: 'ada@northwind.io', code: fresh });
  assert.equal(replay.status, 400);
});

test('codes expire', async (t) => {
  const mailer = new LogMailer();
  const accounts = new Accounts({ mailer, codeTtlMs: 1 });
  await accounts.startEmail('ada@northwind.io');
  const code = codeFrom(mailer, 'ada@northwind.io');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.throws(
    () => accounts.verifyEmail('ada@northwind.io', code),
    (err) => err.code === 'code_expired',
  );
});

test('asking for codes over and over is rate limited', async (t) => {
  const s = await scene(t);
  for (let i = 0; i < 5; i++) {
    assert.equal((await s.call('/auth/start', { email: 'ada@northwind.io' })).status, 200);
  }
  const sixth = await s.call('/auth/start', { email: 'ada@northwind.io' });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.code, 'too_many_codes');

  // The limit is per address, not global — one noisy signup must not lock out
  // everybody else on the relay.
  assert.equal((await s.call('/auth/start', { email: 'grace@northwind.io' })).status, 200);
});

test('the endpoints do not say whether an email is registered', async (t) => {
  const s = await scene(t);
  await register(s, 'ada@northwind.io', 'Ada Lovelace', 'difference-engine-1');

  const known = await s.call('/auth/start', { email: 'ada@northwind.io' });
  const unknown = await s.call('/auth/start', { email: 'nobody@northwind.io' });
  assert.deepEqual(
    Object.keys(known.body).sort(),
    Object.keys(unknown.body).sort(),
    'the two answers must be indistinguishable',
  );
  assert.equal(known.body.sent, unknown.body.sent);

  // The same goes for a failed password: no account and a wrong password are
  // the same refusal.
  const noAccount = await s.call('/auth/login', { email: 'nobody@northwind.io', password: 'x' });
  const badPassword = await s.call('/auth/login', { email: 'ada@northwind.io', password: 'x' });
  assert.equal(noAccount.status, badPassword.status);
  assert.equal(noAccount.body.error, badPassword.body.error);
});

test('a weak password is refused, and a good one is stored as a hash', async () => {
  assert.ok(passwordProblem('short1'));
  assert.ok(passwordProblem('alllettersnodigits'));
  assert.equal(passwordProblem('difference-engine-1'), null);

  const stored = hashPassword('difference-engine-1');
  assert.ok(!stored.includes('difference-engine-1'), 'never stored in the clear');
  assert.match(stored, /^scrypt\$/);
  assert.equal(verifyPassword('difference-engine-1', stored), true);
  assert.equal(verifyPassword('difference-engine-2', stored), false);
  // Two hashes of the same password differ: the salt is doing its job.
  assert.notEqual(stored, hashPassword('difference-engine-1'));
});

test('an endpoint that needs a session refuses without one', async (t) => {
  const s = await scene(t);
  for (const [path, body] of [
    ['/auth/profile', { displayName: 'Nobody' }],
    ['/auth/workspace', { name: 'Somewhere' }],
    ['/auth/join', { workspaceId: 'ws_nothing' }],
    ['/auth/invite', { workspaceId: 'ws_nothing', emails: ['a@b.com'] }],
  ]) {
    const anonymous = await s.call(path, body);
    assert.equal(anonymous.status, 401, `${path} should need a session`);
    const forged = await s.call(path, body, 'not-a-real-token');
    assert.equal(forged.status, 401, `${path} should reject a forged token`);
  }
});

// ---------------------------------------------------------------------------
// Email domains
// ---------------------------------------------------------------------------

test('a workspace is only offered to colleagues, never to every gmail address', async (t) => {
  const s = await scene(t);
  const ada = await register(s, 'ada@northwind.io', 'Ada Lovelace');
  await s.call('/auth/workspace', { name: 'Northwind' }, ada.token);

  const outsider = await register(s, 'someone@gmail.com', 'Someone');
  assert.equal(
    outsider.verified.workspaces.some((w) => w.name === 'Northwind'),
    false,
    'a free mailbox is not an organisation',
  );

  const colleague = await register(s, 'grace@northwind.io', 'Grace Hopper');
  assert.ok(
    colleague.verified.workspaces.some((w) => w.name === 'Northwind'),
    'a colleague at the same domain is offered it',
  );
});

test('a workspace made from a free mailbox claims nothing', async (t) => {
  const s = await scene(t);
  const first = await register(s, 'someone@gmail.com', 'Someone');
  await s.call('/auth/workspace', { name: 'Side Project' }, first.token);

  const second = await register(s, 'another@gmail.com', 'Another');
  assert.equal(
    second.verified.workspaces.some((w) => w.name === 'Side Project'),
    false,
    'sharing gmail.com does not make two strangers colleagues',
  );
});

test('domain classification and address derivation', () => {
  assert.equal(isCorporateDomain('northwind.io'), true);
  assert.equal(isCorporateDomain('gmail.com'), false);
  assert.equal(isCorporateDomain('outlook.com'), false);

  const taken = new Set(['ada@northwind']);
  assert.equal(addressForEmail('ada@northwind.io', (a) => taken.has(a)), 'ada2@northwind');
  assert.equal(addressForEmail('sarah.chen@northwind.io', () => false), 'sarahchen@northwind');
  // A plus-address is the same mailbox, so it must not become a second handle.
  assert.equal(addressForEmail('ada+work@northwind.io', () => false), 'ada@northwind');

  assert.equal(nameFromEmail('sarah.chen@northwind.io'), 'Sarah Chen');
  assert.equal(nameFromEmail('ada@northwind.io'), 'Ada');
});

// ---------------------------------------------------------------------------
// The socket
// ---------------------------------------------------------------------------

test('a session decides who the socket is, and an address cannot be borrowed', async (t) => {
  const s = await scene(t);
  const ada = await register(s, 'ada@northwind.io', 'Ada Lovelace');
  const dirs = [];
  t.after(() => cleanup(dirs));

  // Nobody may connect as an address that belongs to an account without holding
  // that account's session. This is the hole the README used to warn about.
  const dir = await makeTempDir('ai-coworker-imposter-');
  dirs.push(dir);
  const { KnowledgeBase, PersonalAgent, MockProvider } = await import(
    '../packages/agent/dist/index.js'
  );
  const kb = await KnowledgeBase.open(dir);
  await kb.updateProfile({ address: ada.account.address, displayName: 'Definitely Ada' });
  const imposter = new PersonalAgent({
    knowledge: kb,
    relayUrl: s.wsUrl,
    provider: new MockProvider(),
  });
  t.after(() => imposter.shutdown());

  let refusal = null;
  imposter.on('connection', (state, error) => {
    if (state === 'error' || error) refusal = error;
  });
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(
    s.relay.hub.workspaceIdsFor(ada.account.address).length,
    0,
    'the imposter never got into a workspace',
  );

  // With the session, the same address connects and works.
  await kb.saveSession(s.wsUrl, {
    token: ada.token,
    email: 'ada@northwind.io',
    accountId: ada.account.id,
    address: ada.account.address,
    displayName: 'Ada Lovelace',
    savedAt: Date.now(),
  });
  imposter.relay.close();
  imposter.relay.connect();
  await until(
    () => imposter.workspaces.all.length > 0,
    'the real Ada connected and landed in a workspace',
  );
});

test('a relay set to require accounts turns away anybody without one', async (t) => {
  const s = await scene(t, { auth: 'required' });
  const dirs = [];
  t.after(() => cleanup(dirs));

  const dir = await makeTempDir('ai-coworker-anon-');
  dirs.push(dir);
  const { KnowledgeBase, PersonalAgent, MockProvider } = await import(
    '../packages/agent/dist/index.js'
  );
  const kb = await KnowledgeBase.open(dir);
  await kb.updateProfile({ address: 'stranger@nowhere', displayName: 'Stranger' });
  const stranger = new PersonalAgent({
    knowledge: kb,
    relayUrl: s.wsUrl,
    provider: new MockProvider(),
  });
  t.after(() => stranger.shutdown());

  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(stranger.workspaces.all.length, 0, 'no account, no workspace');
  assert.equal(s.relay.onlineCount, 0, 'and no connection');
});

test('an expired or unknown session token is refused rather than ignored', async (t) => {
  const s = await scene(t);
  const dirs = [];
  t.after(() => cleanup(dirs));

  const dir = await makeTempDir('ai-coworker-stale-');
  dirs.push(dir);
  const { KnowledgeBase, PersonalAgent, MockProvider } = await import(
    '../packages/agent/dist/index.js'
  );
  const kb = await KnowledgeBase.open(dir);
  await kb.updateProfile({ address: 'stale@nowhere', displayName: 'Stale' });
  await kb.saveSession(s.wsUrl, {
    token: 'a-token-that-was-never-issued',
    email: 'stale@nowhere.com',
    accountId: 'acc_nothing',
    address: 'stale@nowhere',
    displayName: 'Stale',
    savedAt: Date.now(),
  });
  const agent = new PersonalAgent({
    knowledge: kb,
    relayUrl: s.wsUrl,
    provider: new MockProvider(),
  });
  t.after(() => agent.shutdown());

  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(
    agent.workspaces.all.length,
    0,
    'presenting a bad token is worse than presenting none',
  );
});

// ---------------------------------------------------------------------------
// Everything still works without accounts
// ---------------------------------------------------------------------------

test('a relay with no account store behaves exactly as it always did', async (t) => {
  const { startRelay } = await import('./helpers.mjs');
  const relay = await startRelay();
  const dirs = [];
  t.after(async () => {
    await relay.stop();
    await cleanup(dirs);
  });

  const dana = await startAgent('dana', relay.url);
  dirs.push(dana.dir);
  await until(() => dana.agent.workspaces.all.length > 0, 'dana landed in the home workspace');
  assert.equal(dana.agent.workspaces.all[0].me.role, 'owner');
  await dana.agent.shutdown();
});

// ---------------------------------------------------------------------------
// Surviving a restart
// ---------------------------------------------------------------------------

test('accounts and sessions survive the relay being restarted', async (t) => {
  const dir = await makeTempDir('ai-coworker-accounts-');
  t.after(() => cleanup([dir]));
  const statePath = `${dir}/.relay-accounts.json`;

  const mailer = new LogMailer();
  const first = new Accounts({ statePath, mailer });
  await first.startEmail('ada@northwind.io');
  const { account, session } = first.verifyEmail(
    'ada@northwind.io',
    codeFrom(mailer, 'ada@northwind.io'),
  );
  first.completeProfile(session.token, {
    displayName: 'Ada Lovelace',
    password: 'difference-engine-1',
  });
  first.shutdown();

  // Nothing readable should be sitting in that file.
  const onDisk = await readFile(statePath, 'utf8');
  assert.ok(!onDisk.includes('difference-engine-1'), 'the password is not on disk in the clear');

  const second = new Accounts({ statePath, mailer: new LogMailer() });
  t.after(() => second.shutdown());
  assert.equal(second.size, 1);

  // Restarting the relay must not sign everybody out.
  const resumed = second.resolve(session.token);
  assert.ok(resumed, 'the session still resolves');
  assert.equal(resumed.address, account.address);
  assert.equal(resumed.displayName, 'Ada Lovelace');
  // And the password still checks out against the rehydrated hash.
  assert.doesNotThrow(() => second.login('ada@northwind.io', 'difference-engine-1'));
});

test('signing out invalidates the token everywhere', async (t) => {
  const s = await scene(t);
  const ada = await register(s, 'ada@northwind.io', 'Ada Lovelace');
  assert.equal((await s.call('/auth/session', {}, ada.token)).status, 200);
  assert.equal((await s.call('/auth/logout', {}, ada.token)).status, 200);
  assert.equal(
    (await s.call('/auth/session', {}, ada.token)).status,
    401,
    'the token is dead as soon as it is handed back',
  );
});
