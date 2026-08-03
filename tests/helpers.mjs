import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { WebSocketServer } from 'ws';

import { PersonalAgent, KnowledgeBase, MockProvider, findPersona, seedKnowledgeBase } from '../packages/agent/dist/index.js';
import { Relay } from '../packages/server/dist/index.js';

/** Start an in-process relay on an ephemeral port. */
export async function startRelay(options = {}) {
  const relay = new Relay({
    negotiationTimeoutMs: 3000,
    turnTimeoutMs: 8000,
    joinTimeoutMs: 1500,
    log: options.verbose ? (m) => console.log(`  [relay] ${m}`) : () => {},
    ...options,
  });
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => relay.handleConnection(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    relay,
    url: `ws://127.0.0.1:${port}`,
    async stop() {
      relay.shutdown();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function makeTempDir(prefix = 'ai-coworker-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Boot a seeded persona agent connected to `url`. */
export async function startAgent(personaKey, url, root) {
  const persona = findPersona(personaKey);
  if (!persona) throw new Error(`no persona ${personaKey}`);
  const dir = root ?? (await makeTempDir(`ai-coworker-${personaKey}-`));
  const knowledge = await KnowledgeBase.open(dir);
  await seedKnowledgeBase(knowledge, persona);
  const agent = new PersonalAgent({
    knowledge,
    relayUrl: url,
    provider: new MockProvider(),
    providerReason: 'test',
  });
  await once(agent, 'connection', (state) => state === 'online');
  return { agent, knowledge, dir, persona };
}

/** Wait for an event, optionally filtered by a predicate on the first argument. */
export function once(emitter, event, predicate = () => true, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeoutMs);
    function handler(...args) {
      if (!predicate(...args)) return;
      clearTimeout(timer);
      emitter.off(event, handler);
      resolve(args[0]);
    }
    emitter.on(event, handler);
  });
}

/** Wait until a predicate holds, polling. Cheaper to read than nested `once`s. */
export async function until(predicate, message = 'condition', timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Wait until every agent sees every other agent in the directory. */
export async function waitForDirectory(agents, expectedCount, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (agents.every((a) => a.directory.length >= expectedCount - 1)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('directory did not converge');
}

export async function cleanup(dirs) {
  // Agents flush to disk asynchronously; retry so a late write does not fail the run.
  await Promise.all(
    dirs.map((d) => fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
}
