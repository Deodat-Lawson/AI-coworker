/**
 * Pure-function tests for the ACS mailer. No network: these cover the two
 * things that are easy to get wrong and impossible to debug from the 401 the
 * service answers with — the connection-string split and the signature.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import {
  AcsMailer,
  acsMailerFromEnv,
  parseAcsConnectionString,
  signAcsRequest,
} from '../packages/server/dist/mailer-acs.js';

const KEY = Buffer.from('a-test-key-that-is-not-secret').toString('base64');

test('connection string splits on the first = only', () => {
  // The access key is base64 and routinely ends in padding, so a naive split
  // on '=' loses it.
  const parsed = parseAcsConnectionString(
    `endpoint=https://stead.communication.azure.com/;accesskey=${KEY}`,
  );
  assert.equal(parsed.endpoint, 'https://stead.communication.azure.com');
  assert.equal(parsed.accessKey, KEY);
});

test('connection string is case-insensitive on keys and tolerates order', () => {
  const parsed = parseAcsConnectionString(`AccessKey=${KEY};EndPoint=https://x.communication.azure.com`);
  assert.equal(parsed.accessKey, KEY);
  assert.equal(parsed.endpoint, 'https://x.communication.azure.com');
});

test('an incomplete connection string is refused, not half-used', () => {
  assert.throws(() => parseAcsConnectionString('endpoint=https://x.communication.azure.com'), /accesskey/);
  assert.throws(() => parseAcsConnectionString('nonsense'), /endpoint/);
});

test('the signature matches a hand-computed HMAC over the documented string', () => {
  const url = new URL('https://stead.communication.azure.com/emails:send?api-version=2023-03-31');
  const body = JSON.stringify({ hello: 'world' });
  const date = 'Mon, 11 Aug 2026 02:00:00 GMT';

  const { authorization, contentHash } = signAcsRequest({
    method: 'POST',
    url,
    body,
    accessKey: KEY,
    date,
  });

  const expectedHash = crypto.createHash('sha256').update(body, 'utf8').digest('base64');
  assert.equal(contentHash, expectedHash);

  // Recomputed here the long way round, so a reordering of the signed headers
  // or a dropped query string fails loudly rather than at the service.
  const stringToSign = [
    'POST',
    '/emails:send?api-version=2023-03-31',
    `${date};stead.communication.azure.com;${expectedHash}`,
  ].join('\n');
  const expected = crypto
    .createHmac('sha256', Buffer.from(KEY, 'base64'))
    .update(stringToSign, 'utf8')
    .digest('base64');

  assert.equal(
    authorization,
    `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${expected}`,
  );
});

test('the query string is signed — dropping it changes the signature', () => {
  const body = '{}';
  const date = 'Mon, 11 Aug 2026 02:00:00 GMT';
  const withQuery = signAcsRequest({
    method: 'POST',
    url: new URL('https://x.communication.azure.com/emails:send?api-version=2023-03-31'),
    body,
    accessKey: KEY,
    date,
  });
  const withoutQuery = signAcsRequest({
    method: 'POST',
    url: new URL('https://x.communication.azure.com/emails:send'),
    body,
    accessKey: KEY,
    date,
  });
  assert.notEqual(withQuery.authorization, withoutQuery.authorization);
});

test('a mailer without a sender address is refused at construction', () => {
  assert.throws(
    () =>
      new AcsMailer({
        connectionString: `endpoint=https://x.communication.azure.com;accesskey=${KEY}`,
        senderAddress: '',
      }),
    /sender address/,
  );
});

test('env builds a mailer only when both halves are present', () => {
  const saved = {
    connection: process.env.ACS_CONNECTION_STRING,
    sender: process.env.ACS_SENDER_ADDRESS,
  };
  try {
    delete process.env.ACS_CONNECTION_STRING;
    delete process.env.ACS_SENDER_ADDRESS;
    assert.equal(acsMailerFromEnv(), undefined, 'nothing configured');

    process.env.ACS_CONNECTION_STRING = `endpoint=https://x.communication.azure.com;accesskey=${KEY}`;
    assert.equal(acsMailerFromEnv(), undefined, 'a connection string alone is not enough');

    process.env.ACS_SENDER_ADDRESS = 'DoNotReply@example.azurecomm.net';
    assert.ok(acsMailerFromEnv() instanceof AcsMailer, 'both halves present');
  } finally {
    for (const [key, value] of [
      ['ACS_CONNECTION_STRING', saved.connection],
      ['ACS_SENDER_ADDRESS', saved.sender],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('nothing about the message reaches the log', async () => {
  // The subject is `<code> is your <relay> code`. A log line quoting it puts
  // every confirmation code in the platform's log store.
  const lines = [];
  const mailer = new AcsMailer({
    connectionString: `endpoint=https://x.communication.azure.com;accesskey=${KEY}`,
    senderAddress: 'DoNotReply@example.azurecomm.net',
    log: (m) => lines.push(m),
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 202 });
  try {
    await mailer.send({
      to: 'someone@example.com',
      subject: '424242 is your Stead code',
      text: 'Your confirmation code is 424242.',
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  const joined = lines.join('\n');
  assert.ok(lines.length > 0, 'it should still say something happened');
  assert.doesNotMatch(joined, /424242/, 'the code must not be logged');
  assert.doesNotMatch(joined, /someone@example\.com/, 'the address must not be logged');
});
