/**
 * Pure-function tests for the Gemini adapter. No network: these cover the two
 * places a silent mistake would be expensive — schema translation and the
 * rate-limit backoff that free-tier keys depend on.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeGeminiError,
  parseRetryDelayMs,
  toGeminiSchema,
  createProvider,
  MockProvider,
  GeminiProvider,
} from '../packages/agent/dist/index.js';

test('json schema translates to the shape Gemini accepts', () => {
  const converted = toGeminiSchema({
    type: 'object',
    additionalProperties: false,
    properties: {
      speech: { type: 'string', description: 'what you say' },
      count: { type: 'integer' },
      ratio: { type: 'number' },
      accepted: { type: 'boolean' },
      priority: { type: 'string', enum: ['low', 'high'] },
      ids: { type: 'array', items: { type: 'string' } },
      nested: {
        type: 'object',
        additionalProperties: false,
        properties: { to: { type: 'string' } },
        required: ['to'],
      },
    },
    required: ['speech'],
  });

  // Types become the OpenAPI uppercase names.
  assert.equal(converted.type, 'OBJECT');
  assert.equal(converted.properties.speech.type, 'STRING');
  assert.equal(converted.properties.count.type, 'INTEGER');
  assert.equal(converted.properties.ratio.type, 'NUMBER');
  assert.equal(converted.properties.accepted.type, 'BOOLEAN');
  assert.equal(converted.properties.ids.type, 'ARRAY');
  assert.equal(converted.properties.ids.items.type, 'STRING');
  assert.equal(converted.properties.nested.type, 'OBJECT');
  assert.equal(converted.properties.nested.properties.to.type, 'STRING');

  // Descriptions, enums and required survive; additionalProperties is dropped
  // because Gemini rejects it outright.
  assert.equal(converted.properties.speech.description, 'what you say');
  assert.deepEqual(converted.properties.priority.enum, ['low', 'high']);
  assert.deepEqual(converted.required, ['speech']);
  assert.equal('additionalProperties' in converted, false);
  assert.equal('additionalProperties' in converted.properties.nested, false);

  // Property ordering is emitted so field order is stable.
  assert.deepEqual(converted.propertyOrdering, [
    'speech',
    'count',
    'ratio',
    'accepted',
    'priority',
    'ids',
    'nested',
  ]);
});

test('rate-limit retry delay is read from the error body', () => {
  const body = JSON.stringify({
    error: {
      code: 429,
      message: 'You exceeded your current quota',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure' },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '51s' },
      ],
    },
  });
  assert.equal(parseRetryDelayMs(body), 51_000);
  assert.equal(parseRetryDelayMs('{"retryDelay": "7.5s"}'), 7_500);
  assert.equal(parseRetryDelayMs('no delay here'), null);
});

test('api errors become something worth showing a person', () => {
  assert.match(describeGeminiError(new Error('Gemini 429: {"error":{"code":429}}')), /rate limit/);
  assert.match(describeGeminiError(new Error('Gemini 403: forbidden')), /key was rejected/);
  assert.match(describeGeminiError(new Error('Gemini request timed out after 90000ms')), /timed out/);
  // Anything unrecognized is passed through, trimmed to one readable line.
  const long = describeGeminiError(new Error(`${'x'.repeat(300)}\nsecond line`));
  assert.ok(long.length <= 140);
  assert.ok(!long.includes('\n'));
});

test('provider selection falls back to the offline brain without a key', () => {
  const saved = {
    offline: process.env.AI_COWORKER_OFFLINE,
    gemini: process.env.GEMINI_API_KEY,
    google: process.env.GOOGLE_API_KEY,
    genai: process.env.GOOGLE_GENAI_API_KEY,
  };
  try {
    delete process.env.AI_COWORKER_OFFLINE;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_GENAI_API_KEY;

    const withoutKey = createProvider();
    assert.ok(withoutKey.provider instanceof MockProvider);
    assert.equal(withoutKey.provider.live, false);
    assert.match(withoutKey.reason, /no Gemini API key/);

    const withKey = createProvider({ apiKey: 'test-key' });
    assert.ok(withKey.provider instanceof GeminiProvider);
    assert.equal(withKey.provider.live, true);

    // An explicit offline switch beats a present key, so tests stay hermetic.
    process.env.AI_COWORKER_OFFLINE = '1';
    const forced = createProvider({ apiKey: 'test-key' });
    assert.ok(forced.provider instanceof MockProvider);
  } finally {
    for (const [key, value] of Object.entries({
      AI_COWORKER_OFFLINE: saved.offline,
      GEMINI_API_KEY: saved.gemini,
      GOOGLE_API_KEY: saved.google,
      GOOGLE_GENAI_API_KEY: saved.genai,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
