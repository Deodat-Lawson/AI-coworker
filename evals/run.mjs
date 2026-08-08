#!/usr/bin/env node
/**
 * The agent-communication eval.
 *
 * Runs real meetings between real agents on a real relay, with the real brain —
 * a mock provider would only be testing our own fixtures — then hands each
 * transcript to an independent judge along with the answer key, and reports
 * whether these agents are fit to put in front of someone who will act on what
 * they say.
 *
 *   npm run eval                      every scenario
 *   npm run eval -- --scenario dependency-chain
 *   npm run eval -- --save baseline   write the report to evals/reports/
 *
 * Exit code is 0 only if every hardline criterion passed in every scenario and
 * the quality bar was met. That makes it usable as a gate, not just a report.
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { WebSocketServer } from 'ws';

import {
  KnowledgeBase,
  PersonalAgent,
  createProvider,
  findPersona,
  loadEnvFromAncestors,
  resolveApiKey,
  seedKnowledgeBase,
} from '../packages/agent/dist/index.js';
import { Relay } from '../packages/server/dist/index.js';

import { BAR, HARDLINE, QUALITY } from './criteria.mjs';
import { judge } from './judge.mjs';
import { SCENARIOS, scenarioByKey } from './scenarios.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
loadEnvFromAncestors(root);

const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const only = flagValue('scenario');
const saveAs = flagValue('save');
const judgeModel = process.env.EVAL_JUDGE_MODEL ?? 'gemini-flash-latest';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function startRelay() {
  const relay = new Relay({
    negotiationTimeoutMs: 8000,
    // Real model calls are slow, and a turn timing out mid-thought would show
    // up as an agent that ignored a question — a bug in the eval, not the agent.
    turnTimeoutMs: 90_000,
    joinTimeoutMs: 8000,
    log: () => {},
  });
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => relay.handleConnection(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    relay,
    url: `ws://127.0.0.1:${server.address().port}`,
    async stop() {
      relay.shutdown();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function startAgent(personaKey, url, apiKey) {
  const persona = findPersona(personaKey);
  if (!persona) throw new Error(`no persona "${personaKey}"`);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `stead-eval-${personaKey}-`));
  const knowledge = await KnowledgeBase.open(dir);
  await seedKnowledgeBase(knowledge, persona);
  const { provider, reason } = createProvider({ apiKey });
  const agent = new PersonalAgent({ knowledge, relayUrl: url, provider, providerReason: reason });
  await once(agent, 'connection', (state) => state === 'online');
  return { agent, knowledge, dir, persona, provider };
}

function once(emitter, event, predicate = () => true, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeoutMs);
    function handler(...a) {
      if (!predicate(...a)) return;
      clearTimeout(timer);
      emitter.off(event, handler);
      resolve(a[0]);
    }
    emitter.on(event, handler);
  });
}

/**
 * The answer key. Everything the agent legitimately knows, plus what it must
 * not say — which is the half that makes the hardline criteria checkable.
 */
function groundTruthFor({ knowledge }) {
  const profile = knowledge.profile;
  const visible = (items) => items.filter((i) => i.visibility !== 'private');
  const priv = (items) => items.filter((i) => i.visibility === 'private');

  return {
    displayName: profile.displayName,
    role: `${profile.title || profile.role}${profile.team ? `, ${profile.team}` : ''}`,
    sections: {
      Projects: knowledge.projects.map((p) => `${p.name} — ${p.summary ?? ''} [${p.status}]`),
      Artifacts: visible(knowledge.artifacts).map(
        (a) =>
          `${a.kind.toUpperCase()} "${a.title}" — status=${a.status}` +
          `${a.url ? ` url=${a.url}` : ''}${a.summary ? ` — ${a.summary}` : ''}` +
          `${Object.keys(a.stats ?? {}).length ? ` stats=${JSON.stringify(a.stats)}` : ''}`,
      ),
      Notes: visible(knowledge.notes).map((n) => `[${n.kind}] ${n.title} — ${n.body}`),
      Tasks: knowledge.tasks.map((t) => `${t.title} [${t.status}]`),
    },
    private: [
      ...priv(knowledge.notes).map((n) => `[${n.kind}] ${n.title} — ${n.body}`),
      ...priv(knowledge.artifacts).map((a) => `${a.kind} "${a.title}" — ${a.summary}`),
    ],
  };
}

// ---------------------------------------------------------------------------
// One scenario
// ---------------------------------------------------------------------------

async function runScenario(scenario, apiKey) {
  const relay = await startRelay();
  const started = [];
  try {
    for (const key of scenario.people) {
      started.push(await startAgent(key, relay.url, apiKey));
      // Registration is chatty; let the directory settle before the next joins.
      await sleep(300);
    }

    const byKey = Object.fromEntries(started.map((a) => [a.persona.key, a]));
    const chair = byKey[scenario.chair];
    if (!chair) throw new Error(`chair "${scenario.chair}" is not in this scenario`);
    const others = started.filter((a) => a !== chair).map((a) => a.knowledge.profile.address);

    // Everyone has to see everyone before a meeting can be booked.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (started.every((a) => a.agent.directory.length >= started.length)) break;
      await sleep(300);
    }

    const scheduled = once(chair.agent, 'meeting.scheduled');
    chair.agent.requestMeeting({
      participants: others,
      title: scenario.request.title,
      purpose: scenario.request.purpose,
      kind: scenario.request.kind,
      durationMins: scenario.request.durationMins,
      urgency: 'asap',
      agenda: scenario.request.agenda,
    });
    const meeting = await scheduled;

    const ended = Promise.all(
      started.map((a) => once(a.agent, 'meeting.ended', () => true, 600_000)),
    );
    chair.agent.startMeetingNow(meeting.id);
    const [outcome] = await ended;

    const record = chair.knowledge.meeting(meeting.id);
    const transcript = (record?.transcript ?? outcome?.transcript ?? []).map((t) => ({
      speaker: t.speaker,
      kind: t.kind,
      text: t.text,
    }));

    const groundTruth = Object.fromEntries(
      started.map((a) => [a.knowledge.profile.address, groundTruthFor(a)]),
    );

    return { transcript, groundTruth, meeting };
  } finally {
    for (const a of started) await a.agent.shutdown().catch(() => {});
    await relay.stop().catch(() => {});
    for (const a of started) await fs.rm(a.dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const RED = (s) => `[31m${s}[0m`;
const GREEN = (s) => `[32m${s}[0m`;
const DIM = (s) => `[2m${s}[0m`;
const BOLD = (s) => `[1m${s}[0m`;

function report(name, verdict) {
  console.log(`\n${BOLD(name)}`);
  for (const criterion of HARDLINE) {
    const result = verdict.hardline.find((h) => h.id === criterion.id);
    const passed = result?.passed ?? false;
    console.log(`  ${passed ? GREEN('PASS') : RED('FAIL')}  ${criterion.title}`);
    if (!passed) {
      for (const e of result?.evidence ?? []) {
        console.log(RED(`        ${e.speaker}: "${truncate(e.quote, 100)}"`));
        console.log(DIM(`        → ${e.why}`));
      }
    }
  }
  const scores = verdict.quality ?? [];
  const line = QUALITY.map((q) => {
    const s = scores.find((x) => x.id === q.id)?.score ?? 0;
    return `${q.id} ${s}/5`;
  }).join('  ');
  console.log(DIM(`  ${line}`));
  return scores;
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ---------------------------------------------------------------------------

async function main() {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(
      'These evals need a real model: the offline brain would only be testing our own fixtures.\n' +
        'Set GEMINI_API_KEY in your environment or in .env at the repo root.',
    );
    process.exit(2);
  }

  const chosen = only ? [scenarioByKey(only)].filter(Boolean) : SCENARIOS;
  if (!chosen.length) {
    console.error(`No scenario named "${only}". Known: ${SCENARIOS.map((s) => s.key).join(', ')}`);
    process.exit(2);
  }

  console.log(BOLD(`\nAgent communication eval — ${chosen.length} scenario(s), judge ${judgeModel}\n`));

  const results = [];
  for (const scenario of chosen) {
    process.stdout.write(DIM(`  running "${scenario.name}"… `));
    let run;
    try {
      run = await runScenario(scenario, apiKey);
    } catch (err) {
      console.log(RED(`failed to run: ${err.message}`));
      results.push({ scenario, error: err.message });
      continue;
    }
    console.log(DIM(`${run.transcript.length} turns, judging…`));

    let verdict;
    try {
      verdict = await judge({
        transcript: run.transcript,
        groundTruth: run.groundTruth,
        scenario,
        apiKey,
        model: judgeModel,
      });
    } catch (err) {
      console.log(RED(`  judge failed: ${err.message}`));
      results.push({ scenario, error: `judge: ${err.message}` });
      continue;
    }

    const scores = report(scenario.name, verdict);
    results.push({ scenario, verdict, transcript: run.transcript, scores });
  }

  // --- the bar -------------------------------------------------------------

  const usable = results.filter((r) => r.verdict);
  const hardFailures = usable.flatMap((r) =>
    (r.verdict.hardline ?? [])
      .filter((h) => !h.passed)
      .map((h) => ({ scenario: r.scenario.name, id: h.id, evidence: h.evidence })),
  );
  const allScores = usable.flatMap((r) => (r.scores ?? []).map((s) => s.score));
  const mean = allScores.length ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0;
  const floor = allScores.length ? Math.min(...allScores) : 0;
  const judgeConfident = usable.length > 0 && usable.every((r) => r.verdict.confident);

  console.log(`\n${BOLD('Summary')}`);
  console.log(`  scenarios run     ${usable.length}/${chosen.length}`);
  console.log(`  hardline failures ${hardFailures.length ? RED(String(hardFailures.length)) : GREEN('0')}`);
  console.log(`  quality mean      ${mean.toFixed(2)} (bar ${BAR.qualityMean})`);
  console.log(`  quality floor     ${floor} (bar ${BAR.qualityFloor})`);
  console.log(`  judge confident   ${judgeConfident ? GREEN('yes') : RED('no')}`);

  const improvements = usable.flatMap((r) => r.verdict.improvements ?? []);
  if (improvements.length) {
    console.log(`\n${BOLD('What the judge says to change')}`);
    for (const i of improvements.slice(0, 8)) {
      console.log(`  • ${i.problem}`);
      console.log(DIM(`    → ${i.change}`));
    }
  }

  for (const r of usable) {
    if (r.verdict.verdict) console.log(DIM(`\n  ${r.scenario.name}: ${r.verdict.verdict}`));
  }

  if (saveAs) {
    const dir = path.join(here, 'reports');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${saveAs}.json`);
    await fs.writeFile(file, JSON.stringify({ results: usable, mean, floor, hardFailures }, null, 2));
    console.log(DIM(`\n  saved ${path.relative(root, file)}`));
  }

  const passed =
    usable.length === chosen.length &&
    hardFailures.length === 0 &&
    mean >= BAR.qualityMean &&
    floor >= BAR.qualityFloor &&
    judgeConfident;

  console.log(passed ? GREEN('\n  PASS — the judge would ship these agents.\n') : RED('\n  FAIL — not shippable yet.\n'));
  process.exit(passed ? 0 : 1);
}

await main();
