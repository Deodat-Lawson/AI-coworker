import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal `.env` loader (no dependency).
 *
 * Existing environment variables always win — a file on disk should never
 * silently override what the operator set explicitly.
 */
export function loadEnvFile(file: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

/**
 * Walk up from `start` looking for a `.env`, stopping at the filesystem root.
 * Lets the CLI work from anywhere inside the repo.
 */
export function loadEnvFromAncestors(start: string = process.cwd(), levels = 5): boolean {
  let dir = path.resolve(start);
  for (let i = 0; i <= levels; i++) {
    if (loadEnvFile(path.join(dir, '.env'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}
