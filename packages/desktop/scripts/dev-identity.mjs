/**
 * Makes a run from source introduce itself as Stead on macOS.
 *
 * `app.setName()` covers most of what the app says about itself, but the Dock
 * and the window server read the name and the icon off the *bundle*, before any
 * of our JavaScript runs. A packaged build has our bundle and electron-builder
 * fills it in. In development we are borrowing the one that ships inside
 * `node_modules/electron`, which is called Electron.app and says so — under the
 * Dock icon, in the app switcher, in Force Quit.
 *
 * So this rebrands that bundle in place: it becomes Stead.app, with our icon,
 * and `path.txt` — the file the `electron` package reads to find its binary —
 * is repointed at it. Everything that launches Electron by importing the
 * package (the dev loop, `npm start`, the UI suite) follows automatically.
 *
 * Renaming the bundle directory and the executable is what actually moves the
 * Dock label; setting CFBundleName alone is not enough, because the Dock keeps
 * naming a running app after the binary it launched.
 *
 * The bundle identifier is left as Electron's on purpose. It is the key
 * LaunchServices files an app under, and pointing it at ours would put this
 * bundle and an installed Stead.app in the same slot, where the winner is
 * whichever macOS registered last.
 *
 * Patching node_modules is not free — a reinstall undoes it — so this runs on
 * every dev launch and is a no-op once it has taken. Nothing in a packaged
 * build depends on it.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');

/**
 * Not plain "Stead". This bundle sits in node_modules, and Spotlight, Launchpad
 * and the app switcher index it like any other app — so naming it exactly what
 * the installed app is called produces two identical "Stead" entries and no way
 * to tell which one you are about to launch. The suffix keeps the Dock honest
 * during development without competing with the real thing.
 */
const APP_NAME = 'Stead (dev)';
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

const exists = (target) =>
  fs
    .access(target)
    .then(() => true)
    .catch(() => false);

/** Read one Info.plist key, or undefined if the bundle does not carry it. */
async function readKey(plist, key) {
  try {
    const { stdout } = await run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function writeKey(plist, key, value) {
  const had = (await readKey(plist, key)) !== undefined;
  await run('/usr/libexec/PlistBuddy', [
    '-c',
    had ? `Set :${key} ${value}` : `Add :${key} string ${value}`,
    plist,
  ]);
}

async function sameFile(a, b) {
  try {
    const [x, y] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
    return x.equals(y);
  } catch {
    return false;
  }
}

/** Where the `electron` package keeps its bundle, and which one it points at. */
function locate() {
  const require = createRequire(import.meta.url);
  const pkgDir = path.dirname(require.resolve('electron/package.json'));
  return {
    distDir: path.join(pkgDir, 'dist'),
    pathFile: path.join(pkgDir, 'path.txt'),
  };
}

/**
 * Rename Electron.app to `${APP_NAME}.app`, executable included, and repoint
 * path.txt. A leftover bundle *of the current name* is discarded rather than
 * merged: it is derived from the one npm just installed, never a source of
 * truth.
 *
 * A bundle left under a previous APP_NAME is not cleaned up — this only ever
 * looks for Electron.app — so changing APP_NAME strands the old one in
 * node_modules, where Spotlight goes on indexing it. `npm install electron`
 * fixes that by restoring Electron.app for the next run to rename.
 */
async function renameBundle(distDir, pathFile) {
  const from = path.join(distDir, 'Electron.app');
  const to = path.join(distDir, `${APP_NAME}.app`);
  const relative = `${APP_NAME}.app/Contents/MacOS/${APP_NAME}`;

  if (await exists(from)) {
    await fs.rm(to, { recursive: true, force: true });
    await fs.rename(from, to);
    const binary = path.join(to, 'Contents', 'MacOS', APP_NAME);
    if (!(await exists(binary))) {
      await fs.rename(path.join(to, 'Contents', 'MacOS', 'Electron'), binary);
    }
  }
  if (!(await exists(to))) return null;

  const current = await fs.readFile(pathFile, 'utf8').catch(() => '');
  if (current.trim() !== relative) await fs.writeFile(pathFile, relative, 'utf8');
  return to;
}

/**
 * Ad-hoc re-sign the bundle we just edited. `--deep` is the wrong tool for
 * shipping software, but this bundle never ships: it is the development
 * Electron, re-signed in place so its own signature matches its own contents.
 * A failure here is not fatal — say so and carry on, because an unsigned dev
 * bundle still launches; it just does it on macOS's terms.
 */
async function resign(bundle) {
  try {
    await run('codesign', ['--force', '--deep', '--sign', '-', bundle]);
    await run('codesign', ['--verify', bundle]);
  } catch (err) {
    console.warn(`dev identity: could not re-sign the bundle — ${err.message.split('\n')[0]}`);
  }
}

/**
 * @returns whether anything changed
 */
export async function brandDevElectron() {
  if (process.platform !== 'darwin') return false;

  let distDir;
  let pathFile;
  try {
    ({ distDir, pathFile } = locate());
  } catch {
    return false; // No electron installed; the caller will fail more usefully.
  }

  const before = await fs.readFile(pathFile, 'utf8').catch(() => '');
  const bundle = await renameBundle(distDir, pathFile);
  if (!bundle) return false;
  const renamed = before.trim() !== `${APP_NAME}.app/Contents/MacOS/${APP_NAME}`;

  const plist = path.join(bundle, 'Contents', 'Info.plist');
  const iconName = (await readKey(plist, 'CFBundleIconFile')) ?? 'electron.icns';
  const iconTarget = path.join(bundle, 'Contents', 'Resources', iconName);
  const iconSource = path.join(desktopRoot, 'build', 'icon.icns');
  const haveIcon = await exists(iconSource);

  const keys = { CFBundleName: APP_NAME, CFBundleDisplayName: APP_NAME, CFBundleExecutable: APP_NAME };
  const stale = [];
  for (const [key, value] of Object.entries(keys)) {
    if ((await readKey(plist, key)) !== value) stale.push([key, value]);
  }
  const iconStale = haveIcon && !(await sameFile(iconSource, iconTarget));
  if (!renamed && !stale.length && !iconStale) return false;

  for (const [key, value] of stale) await writeKey(plist, key, value);
  if (iconStale) await fs.copyFile(iconSource, iconTarget);
  if (!haveIcon) console.warn('dev identity: build/icon.icns is missing — run `npm run icons`');

  // Renaming the bundle and rewriting Info.plist breaks the seal the signature
  // covers — `codesign -v` then reports resources it can no longer find, and a
  // bundle in that state is at the OS's mercy about what it is still allowed to
  // do. Re-sign ad-hoc so what we hand to macOS is at least internally
  // consistent. Helpers first: the outer signature covers them, so signing the
  // app before its frameworks would seal a stale digest.
  await resign(bundle);

  // The Dock and the app switcher read names and icons through LaunchServices,
  // which caches per bundle. Re-stamp and re-register so the next launch sees
  // what we just wrote rather than what it saw last time.
  const now = new Date();
  await fs.utimes(bundle, now, now).catch(() => {});
  await run(LSREGISTER, ['-f', bundle]).catch(() => {});

  console.log(`dev identity: development builds now run as ${APP_NAME}`);
  return true;
}

// Runnable on its own for a one-off fix-up: `node scripts/dev-identity.mjs`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await brandDevElectron();
}
