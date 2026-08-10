/**
 * The UI suite runner.
 *
 * Builds the desktop app, seeds a throwaway vault, launches a real Electron
 * window, and evaluates `probe.js` inside it. The probe acts on the interface
 * and reads files back through the app's own IPC, so a pass means the bytes on
 * disk are right.
 *
 *   npm run test:ui                 run everything
 *   npm run test:ui -- --keep       leave the temporary vault behind for inspection
 *   npm run test:ui -- --only task  run only the tests whose names contain "task"
 *
 * Not part of `npm test`: it needs a display, and CI for this repo has none.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const desktopDir = path.join(repoRoot, 'packages/desktop');
const keep = process.argv.includes('--keep');
const only = process.argv[process.argv.indexOf('--only') + 1];
const filter = process.argv.includes('--only') && only && !only.startsWith('--') ? only : '';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`)),
    );
  });
}

async function seedVault(root) {
  const notes = path.join(root, 'notes');
  await fs.mkdir(path.join(notes, '.obsidian'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'profile.json'),
    JSON.stringify(
      {
        address: 'probe@local',
        displayName: 'Probe',
        title: '',
        role: 'ic',
        team: '',
        timezone: 'UTC',
        bio: '',
        focusAreas: [],
        reports: [],
        workingHours: { days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1080 },
        agentInstructions: '',
      },
      null,
      2,
    ),
    'utf8',
  );
  await fs.writeFile(
    path.join(notes, '.obsidian', 'app.json'),
    JSON.stringify(
      {
        theme: 'dark',
        defaultViewMode: 'live',
        dailyNoteFolder: 'Daily',
        templateFolder: 'Templates',
        confirmDelete: false,
        alwaysUpdateLinks: true,
      },
      null,
      2,
    ),
    'utf8',
  );
  await fs.writeFile(path.join(notes, 'Welcome.md'), '# Welcome\n\nA starting note.\n', 'utf8');
}

/**
 * A relay for the app to actually connect to.
 *
 * Without one the window opens on "no workspace yet", and everything that is
 * only reachable once you are in a workspace — the member table, permissions,
 * invitations — cannot be driven at all.
 *
 * Its state files go in their own directory, deliberately not inside the vault:
 * the app watches the vault recursively, and a relay rewriting JSON in there
 * every few hundred milliseconds turns every editor test into a race.
 */
async function startRelay(root) {
  const port = 8900 + Math.floor(Math.random() * 400);
  const dir = `${root}-relay`;
  await fs.mkdir(dir, { recursive: true });
  const child = spawn(process.execPath, [path.join(repoRoot, 'packages/server/dist/main.js')], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AI_COWORKER_PORT: String(port),
      AI_COWORKER_RELAY_NAME: 'Probe relay',
      AI_COWORKER_WORKSPACE: 'Probe',
    },
  });
  const url = `ws://127.0.0.1:${port}`;

  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('the relay did not start')), 15_000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening on')) {
        clearTimeout(deadline);
        resolve();
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`the relay exited ${code}`)));
  });
  return { url, stop: () => child.kill() };
}

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-coworker-ui-'));
const resultFile = path.join(workspace, 'probe-result.json');
let relay = null;

try {
  console.log('building the desktop app…');
  await run('npm', ['run', 'build', '--workspace', '@ai-coworker/desktop'], {
    cwd: repoRoot,
    stdio: 'ignore',
  });

  await seedVault(workspace);
  console.log(`vault: ${workspace}`);
  relay = await startRelay(workspace);
  console.log(`relay: ${relay.url}`);
  console.log('launching the app…\n');

  // The probe is handed to the renderer as a file, so a filter rides in as a
  // line stitched on the front rather than as a second channel into the window.
  const probeSource = await fs.readFile(path.join(here, 'probe.js'), 'utf8');
  const probeFile = path.join(workspace, 'probe.js');
  await fs.writeFile(probeFile, `window.__probeOnly = ${JSON.stringify(filter)};\n${probeSource}`, 'utf8');
  if (filter) console.log(`only: tests matching "${filter}"\n`);

  const electron = (await import(path.join(repoRoot, 'node_modules/electron/index.js'))).default;
  // Give the run its own userData. `AI_COWORKER_WORKSPACE` moves the knowledge
  // base but not the app's settings, so without this the suite writes its own
  // config over the config of the app you actually use and leaves it there —
  // and inherits whatever relay that config already pointed at, which is how a
  // "fresh" window ends up in somebody else's workspace.
  //
  // Beside the vault rather than inside it: the app watches the vault
  // recursively, and Electron writes to userData constantly.
  const userData = `${workspace}-userdata`;
  await fs.mkdir(userData, { recursive: true });
  await run(electron, ['.', `--user-data-dir=${userData}`], {
    cwd: desktopDir,
    env: {
      ...process.env,
      AI_COWORKER_WORKSPACE: workspace,
      AI_COWORKER_RELAY: relay.url,
      AI_COWORKER_PROBE: probeFile,
      AI_COWORKER_PROBE_OUT: resultFile,
      AI_COWORKER_CAPTURE_DELAY: '2600',
      AI_COWORKER_PROBE_TIMEOUT: process.env.AI_COWORKER_PROBE_TIMEOUT ?? '300000',
    },
  });

  const payload = JSON.parse(await fs.readFile(resultFile, 'utf8'));
  if (payload.fatal) {
    console.error('\nthe probe itself failed:\n');
    console.error(payload.fatal);
    process.exitCode = 1;
  }

  for (const result of payload.results ?? []) {
    const mark = result.ok ? '  ok  ' : ' FAIL ';
    console.log(`${mark} ${result.name}${result.ok ? '' : ''}`);
    if (!result.ok) console.log(`        ${result.error}`);
  }
  for (const line of payload.logs ?? []) console.log(`  note  ${line}`);

  const summary = payload.summary ?? {
    total: (payload.results ?? []).length,
    passed: (payload.results ?? []).filter((r) => r.ok).length,
    failed: (payload.results ?? []).filter((r) => !r.ok).length,
  };
  console.log(`\n${summary.passed}/${summary.total} passed, ${summary.failed} failed`);
  if (summary.failed > 0 || summary.total === 0) process.exitCode = 1;
} finally {
  relay?.stop();
  // The relay flushes its state on the way down, so removing its directory
  // immediately races that last write.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const sweep = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
  if (!keep) {
    for (const extra of [`${workspace}-relay`, `${workspace}-userdata`]) {
      await fs.rm(extra, sweep);
    }
  }
  if (keep) console.log(`\nvault kept at ${workspace}`);
  else await fs.rm(workspace, sweep);
}
