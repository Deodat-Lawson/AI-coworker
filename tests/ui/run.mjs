/**
 * The UI suite runner.
 *
 * Builds the desktop app, seeds a throwaway vault, launches a real Electron
 * window, and evaluates `probe.js` inside it. The probe acts on the interface
 * and reads files back through the app's own IPC, so a pass means the bytes on
 * disk are right.
 *
 *   npm run test:ui            run everything
 *   npm run test:ui -- --keep  leave the temporary vault behind for inspection
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

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-coworker-ui-'));
const resultFile = path.join(workspace, 'probe-result.json');

try {
  console.log('building the desktop app…');
  await run('npm', ['run', 'build', '--workspace', '@ai-coworker/desktop'], {
    cwd: repoRoot,
    stdio: 'ignore',
  });

  await seedVault(workspace);
  console.log(`vault: ${workspace}`);
  console.log('launching the app…\n');

  const electron = (await import(path.join(repoRoot, 'node_modules/electron/index.js'))).default;
  await run(electron, ['.'], {
    cwd: desktopDir,
    env: {
      ...process.env,
      AI_COWORKER_WORKSPACE: workspace,
      AI_COWORKER_RELAY: 'ws://127.0.0.1:1',
      AI_COWORKER_PROBE: path.join(here, 'probe.js'),
      AI_COWORKER_PROBE_OUT: resultFile,
      AI_COWORKER_CAPTURE_DELAY: '2600',
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
  if (keep) console.log(`\nvault kept at ${workspace}`);
  else await fs.rm(workspace, { recursive: true, force: true });
}
