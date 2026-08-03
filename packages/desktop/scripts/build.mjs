import { build } from 'esbuild';

/**
 * Bundle the Electron main and preload entry points.
 *
 * Workspace packages are bundled in rather than resolved at runtime so a
 * packaged app does not need a node_modules tree beside it.
 */
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  // `electron` is provided by the runtime; the two below are optional native
  // accelerators for `ws` that are fine to omit.
  external: ['electron', 'bufferutil', 'utf-8-validate'],
};

await build({
  ...shared,
  entryPoints: ['electron/main.ts'],
  outfile: 'dist/main/main.cjs',
});

await build({
  ...shared,
  entryPoints: ['electron/preload.ts'],
  outfile: 'dist/main/preload.cjs',
});
