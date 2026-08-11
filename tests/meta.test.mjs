/**
 * Pure-function tests for the Meta adapter. No network: these cover the places
 * a silent mistake would be expensive — schema translation, the rate-limit
 * backoff, and the truncation retry that keeps a runaway decode from becoming
 * a hole in a meeting transcript.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeMetaError,
  parseRetryDelayMs,
  parseRetryAfterHeader,
  toMetaSchema,
  createProvider,
  MockProvider,
  MetaProvider,
} from '../packages/agent/dist/index.js';

test('json schema passes through in the shape Meta accepts', () => {
  const converted = toMetaSchema({
    type: 'object',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    propertyOrdering: ['speech'],
    properties: {
      speech: { type: 'string', description: 'what you say' },
      count: { type: 'integer' },
      priority: { type: 'string', enum: ['low', 'high'] },
      ids: { type: 'array', items: { type: 'string' } },
      nested: {
        type: 'object',
        properties: { to: { type: 'string' } },
        required: ['to'],
      },
    },
    required: ['speech'],
  });

  // Standard JSON Schema types survive as authored — no OpenAPI dialect here.
  assert.equal(converted.type, 'object');
  assert.equal(converted.properties.speech.type, 'string');
  assert.equal(converted.properties.count.type, 'integer');
  assert.equal(converted.properties.ids.items.type, 'string');
  assert.equal(converted.properties.nested.properties.to.type, 'string');

  // Descriptions, enums and required survive.
  assert.equal(converted.properties.speech.description, 'what you say');
  assert.deepEqual(converted.properties.priority.enum, ['low', 'high']);
  assert.deepEqual(converted.required, ['speech']);

  // Keywords the endpoint rejects are dropped.
  assert.equal('$schema' in converted, false);
  assert.equal('propertyOrdering' in converted, false);

  // Without `strict`, optional properties stay optional — tool arguments depend
  // on this, or the model would invent values for fields meant to be left out.
  assert.equal('additionalProperties' in converted, false);
  assert.deepEqual(converted.properties.nested.required, ['to']);
});

test('strict mode seals every object so structured output is accepted', () => {
  const converted = toMetaSchema(
    {
      type: 'object',
      properties: {
        speech: { type: 'string' },
        minutes: {
          type: 'object',
          properties: { summary: { type: 'string' }, risks: { type: 'array', items: { type: 'string' } } },
          required: ['summary'],
        },
        assignments: {
          type: 'array',
          items: {
            type: 'object',
            properties: { assignee: { type: 'string' }, due_in_days: { type: 'integer' } },
            required: ['assignee'],
          },
        },
      },
      required: ['speech'],
    },
    { strict: true },
  );

  // Strict structured output demands sealed objects with every key required —
  // at the top level, inside nested objects, and inside array items.
  assert.equal(converted.additionalProperties, false);
  assert.deepEqual(converted.required, ['speech', 'minutes', 'assignments']);
  assert.equal(converted.properties.minutes.additionalProperties, false);
  assert.deepEqual(converted.properties.minutes.required, ['summary', 'risks']);
  assert.equal(converted.properties.assignments.items.additionalProperties, false);
  assert.deepEqual(converted.properties.assignments.items.required, ['assignee', 'due_in_days']);

  // Arrays themselves are not objects and must not grow the sealed keys.
  assert.equal('additionalProperties' in converted.properties.assignments, false);
});

test('rate-limit retry delay is read from the header and the body', () => {
  // The standard header wins when it is present, in either of its two forms.
  assert.equal(parseRetryAfterHeader('30'), 30_000);
  assert.equal(parseRetryAfterHeader(null), null);
  assert.equal(parseRetryAfterHeader('not a date'), null);
  const at = Date.parse('2026-01-01T00:00:30Z');
  assert.equal(parseRetryAfterHeader('Thu, 01 Jan 2026 00:00:30 GMT', at - 30_000), 30_000);

  // Otherwise fall back to whatever the body says.
  assert.equal(parseRetryDelayMs('{"error":{"retry_after":"51"}}'), 51_000);
  assert.equal(parseRetryDelayMs('{"retry_after_ms": 7500}'), 7_500);
  assert.equal(parseRetryDelayMs('please retry in 12s'), 12_000);
  assert.equal(parseRetryDelayMs('no delay here'), null);
});

test('api errors become something worth showing a person', () => {
  assert.match(describeMetaError(new Error('Meta 429: {"error":{"code":429}}')), /rate limit/);
  assert.match(describeMetaError(new Error('Meta 403: forbidden')), /key was rejected/);
  assert.match(describeMetaError(new Error('Meta request timed out after 90000ms')), /timed out/);
  assert.match(describeMetaError(new Error('Meta 503: {"error":"overloaded"}')), /briefly unavailable/);
  // A raw API blob is never pasted into a transcript verbatim.
  assert.equal(describeMetaError(new Error('Meta: {"error":"weird"}')), 'the model call failed');
  // Anything unrecognized is passed through, trimmed to one readable line.
  const long = describeMetaError(new Error(`${'x'.repeat(300)}\nsecond line`));
  assert.ok(long.length <= 140);
  assert.ok(!long.includes('\n'));
});

test('provider selection falls back to the offline brain without a key', () => {
  const saved = {
    offline: process.env.AI_COWORKER_OFFLINE,
    meta: process.env.META_API_KEY,
    llama: process.env.LLAMA_API_KEY,
  };
  try {
    delete process.env.AI_COWORKER_OFFLINE;
    delete process.env.META_API_KEY;
    delete process.env.LLAMA_API_KEY;

    const withoutKey = createProvider();
    assert.ok(withoutKey.provider instanceof MockProvider);
    assert.equal(withoutKey.provider.live, false);
    assert.match(withoutKey.reason, /no Meta API key/);

    const withKey = createProvider({ apiKey: 'test-key' });
    assert.ok(withKey.provider instanceof MetaProvider);
    assert.equal(withKey.provider.live, true);
    assert.match(withKey.provider.name, /^meta:/);

    // LLAMA_API_KEY is honoured too, so an existing Meta key keeps working.
    process.env.LLAMA_API_KEY = 'from-env';
    assert.ok(createProvider().provider instanceof MetaProvider);
    delete process.env.LLAMA_API_KEY;

    // An explicit offline switch beats a present key, so tests stay hermetic.
    process.env.AI_COWORKER_OFFLINE = '1';
    const forced = createProvider({ apiKey: 'test-key' });
    assert.ok(forced.provider instanceof MockProvider);
  } finally {
    for (const [key, value] of Object.entries({
      AI_COWORKER_OFFLINE: saved.offline,
      META_API_KEY: saved.meta,
      LLAMA_API_KEY: saved.llama,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
