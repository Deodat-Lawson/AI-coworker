import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideAccess,
  decideAccessForRoom,
  defaultPolicy,
  deriveRelation,
  formatSelector,
  maskNumbers,
  parseSelector,
  projectForAudience,
} from '../packages/shared/dist/index.js';

const ceo = {
  address: 'dana@northwind',
  team: 'leadership',
  manager: 'chair@northwind',
  reports: ['sarah@northwind', 'marcus@northwind'],
};

const engineer = { address: 'sarah@northwind', team: 'platform', role: 'ic' };
const board = { address: 'chair@northwind', team: 'board', role: 'manager' };
const outsider = { address: 'rival@othercorp', team: 'growth', role: 'manager' };

function financePolicy(overrides = {}) {
  return {
    ...defaultPolicy('confidential'),
    topics: ['finance'],
    gist: 'Q3 revenue figures',
    ...overrides,
  };
}

test('relationships are read from the two profiles, in the right direction', () => {
  assert.equal(deriveRelation(ceo, { address: 'dana@northwind' }), 'self');
  assert.equal(deriveRelation(ceo, engineer), 'report', 'someone listed in reports reports to me');
  assert.equal(deriveRelation(ceo, board), 'manager', 'my manager asking is a different case');
  assert.equal(deriveRelation(ceo, outsider), 'external', 'a different domain is outside the company');
  assert.equal(
    deriveRelation({ ...ceo, team: 'platform' }, engineer),
    'report',
    'being on the same team does not stop them reporting to me',
  );
  assert.equal(
    deriveRelation({ address: 'tom@northwind', team: 'platform', reports: [] }, engineer),
    'teammate',
  );
});

test("an engineer asking the CEO for revenue is told it exists, not what it is", () => {
  const policy = financePolicy();

  const toEngineer = decideAccess(policy, { owner: ceo, requester: engineer });
  assert.equal(toEngineer.level, 'gist', 'confidential finance does not flow down the org chart');
  assert.match(toEngineer.reason, /finance/);

  const projection = projectForAudience(
    { title: 'Q3 revenue landed at $4.1M', body: 'ARR is $4,100,000 as of September 30.', policy },
    toEngineer,
  );
  assert.equal(projection.level, 'gist');
  assert.equal(projection.body, undefined, 'the body never leaves at gist level');
  assert.ok(!JSON.stringify(projection).includes('4.1M'), 'no figure survives into the projection');
  assert.ok(!JSON.stringify(projection).includes('4,100,000'));

  // The same memory going *up* is fine: the board already has the numbers.
  assert.equal(decideAccess(policy, { owner: ceo, requester: board }).level, 'full');
  // And nothing crosses the company boundary.
  assert.equal(decideAccess(policy, { owner: ceo, requester: outsider }).level, 'none');
  // The owner always sees their own knowledge base.
  assert.equal(decideAccess(policy, { owner: ceo, requester: { address: ceo.address } }).level, 'full');
});

test('an explicit grant beats the default, and a deny beats everything', () => {
  const granted = financePolicy({ allow: [{ kind: 'address', value: 'sarah@northwind' }], pinned: true });
  assert.equal(decideAccess(granted, { owner: ceo, requester: engineer }).level, 'full');
  assert.match(decideAccess(granted, { owner: ceo, requester: engineer }).reason, /cleared/);

  // Another engineer on the same footing is unaffected by Sarah's grant.
  assert.equal(
    decideAccess(granted, { owner: ceo, requester: { address: 'marcus@northwind', role: 'ic' } }).level,
    'gist',
  );

  const denied = {
    ...defaultPolicy('public'),
    allow: [{ kind: 'anyone' }],
    deny: [{ kind: 'address', value: 'sarah@northwind' }],
  };
  const decision = decideAccess(denied, { owner: ceo, requester: engineer });
  assert.equal(decision.level, 'none', 'a deny outranks even allow-anyone');
  assert.match(decision.reason, /explicitly/);
});

test('secret is self-only and restricted only reaches a manager as a gist', () => {
  const secret = defaultPolicy('secret');
  for (const requester of [engineer, board, outsider]) {
    assert.equal(decideAccess(secret, { owner: ceo, requester }).level, 'none');
  }

  const restricted = defaultPolicy('restricted');
  assert.equal(decideAccess(restricted, { owner: ceo, requester: board }).level, 'gist');
  assert.equal(decideAccess(restricted, { owner: ceo, requester: engineer }).level, 'none');
});

test('a room gets the strictest answer of everyone in it', () => {
  const policy = financePolicy();
  // Alone with the board member, the figures are shareable.
  assert.equal(decideAccessForRoom(policy, ceo, [board]).level, 'full');
  // Put an engineer in the same room and the whole room drops to a gist,
  // because anything said is heard by everyone present.
  assert.equal(decideAccessForRoom(policy, ceo, [board, engineer]).level, 'gist');
  // Add an outsider and it cannot be raised at all.
  assert.equal(decideAccessForRoom(policy, ceo, [board, engineer, outsider]).level, 'none');
  // An empty room is the agent talking to itself.
  assert.equal(decideAccessForRoom(policy, ceo, []).level, 'full');
});

test('internal material reaches colleagues but stops at the company boundary', () => {
  const internal = defaultPolicy('internal');
  assert.equal(decideAccess(internal, { owner: ceo, requester: engineer }).level, 'full');
  assert.equal(decideAccess(internal, { owner: ceo, requester: outsider }).level, 'none');
  assert.equal(decideAccess(defaultPolicy('public'), { owner: ceo, requester: outsider }).level, 'full');
});

test('audiences round-trip through their written form', () => {
  const cases = ['anyone', 'org', 'self', 'manager', 'reports', 'team:platform', 'role:ic', 'address:dana@northwind'];
  for (const text of cases) {
    assert.equal(formatSelector(parseSelector(text)), text, text);
  }
  assert.deepEqual(parseSelector('dana@northwind'), { kind: 'address', value: 'dana@northwind' });
  assert.equal(parseSelector('nonsense'), null);
  assert.equal(parseSelector(''), null);
});

test('figures are masked out of anything the agent may still say', () => {
  assert.equal(maskNumbers('ARR crossed $4.1M in June'), 'ARR crossed [amount] in June');
  assert.equal(maskNumbers('churn is 12%'), 'churn is [percent]');
  assert.equal(maskNumbers('reach me on 16679103023'), 'reach me on [number]');
  // A year is not a secret, and masking it makes gists unreadable.
  assert.equal(maskNumbers('setup notes from 2026'), 'setup notes from 2026');
});
