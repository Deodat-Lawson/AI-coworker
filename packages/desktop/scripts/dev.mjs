import { spawn } from 'node:child_process';
import process from 'node:process';

import { build } from 'esbuild';
import { createServer } from 'vite';

import { brandDevElectron } from './dev-identity.mjs';

/** Dev loop: vite for the renderer, esbuild --watch for main/preload. */
const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = server.resolvedUrls?.local?.[0];
if (!url) throw new Error('vite did not report a dev url');
server.printUrls();

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external: ['electron', 'bufferutil', 'utf-8-validate'],
};

const mainCtx = await build({ ...shared, entryPoints: ['electron/main.ts'], outfile: 'dist/main/main.cjs' });
await build({ ...shared, entryPoints: ['electron/preload.ts'], outfile: 'dist/main/preload.cjs' });
void mainCtx;

// The bundle we borrow from node_modules calls itself Electron in the Dock and
// the menu bar. Rebrand it *before* asking the package where its binary lives —
// the rebrand moves it.
await brandDevElectron();
const electronBin = (await import('electron')).default;
const child = spawn(electronBin, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});

child.on('close', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});

process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
