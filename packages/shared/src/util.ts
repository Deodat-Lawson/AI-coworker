import type { CalendarBlock, TimeSlot, WorkingHours } from './domain.js';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * Web Crypto rather than `node:crypto`: this module is bundled into the desktop
 * renderer as well as the relay, and a node-only import breaks that build.
 * Present in every Node we support and in every browser Electron ships. The
 * renderer now shares the vault index with the agent, so this has to hold on
 * both sides.
 */
export function id(prefix: string): string {
  const webCrypto = (globalThis as {
    crypto?: { randomUUID?(): string; getRandomValues?(array: Uint8Array): Uint8Array };
  }).crypto;
  if (webCrypto?.randomUUID) {
    return `${prefix}_${webCrypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }
  const bytes = new Uint8Array(8);
  if (webCrypto?.getRandomValues) webCrypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Format a timestamp for agent prompts and UI, in a fixed readable shape. */
export function formatTime(ts: number, timeZone?: string): string {
  return new Date(ts).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
}

export function formatDay(ts: number, timeZone?: string): string {
  return new Date(ts).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone,
  });
}

export function overlaps(a: TimeSlot, b: TimeSlot): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Enumerate candidate slots inside a window that fall within working hours and
 * do not collide with an existing calendar block.
 *
 * Slots are aligned to `granularityMins` past the hour so two independently
 * computed availability sets actually intersect.
 */
export function freeSlots(options: {
  windowStart: number;
  windowEnd: number;
  durationMins: number;
  workingHours: WorkingHours;
  busy: CalendarBlock[];
  granularityMins?: number;
  maxSlots?: number;
  /** Reference for "now" — slots in the past are never offered. */
  now?: number;
}): TimeSlot[] {
  const {
    windowStart,
    windowEnd,
    durationMins,
    workingHours,
    busy,
    granularityMins = 30,
    maxSlots = 40,
    now = Date.now(),
  } = options;

  const duration = durationMins * MINUTE;
  const step = granularityMins * MINUTE;
  const out: TimeSlot[] = [];

  // Align the cursor to the granularity grid in absolute epoch terms so that
  // every agent proposes slots on the same lattice.
  const from = Math.max(windowStart, now);
  let cursor = Math.ceil(from / step) * step;

  while (cursor + duration <= windowEnd && out.length < maxSlots) {
    const slot: TimeSlot = { start: cursor, end: cursor + duration };
    if (withinWorkingHours(slot, workingHours) && !busy.some((b) => overlaps(slot, b))) {
      out.push(slot);
    }
    cursor += step;
  }
  return out;
}

export function withinWorkingHours(slot: TimeSlot, wh: WorkingHours): boolean {
  const start = new Date(slot.start);
  const end = new Date(slot.end);
  if (!wh.days.includes(start.getDay())) return false;
  // A meeting must not spill past the end of the working day.
  if (start.getDay() !== end.getDay()) return false;
  const startMin = start.getHours() * 60 + start.getMinutes();
  const endMin = end.getHours() * 60 + end.getMinutes();
  return startMin >= wh.startMinute && endMin <= wh.endMinute;
}

/** Intersect several agents' availability sets; returns slots common to all. */
export function intersectSlots(sets: TimeSlot[][]): TimeSlot[] {
  if (sets.length === 0) return [];
  const [first, ...rest] = sets;
  const key = (s: TimeSlot) => `${s.start}:${s.end}`;
  let acc = new Map(first.map((s) => [key(s), s]));
  for (const set of rest) {
    const next = new Map<string, TimeSlot>();
    for (const s of set) {
      const k = key(s);
      if (acc.has(k)) next.set(k, s);
    }
    acc = next;
    if (acc.size === 0) break;
  }
  return [...acc.values()].sort((a, b) => a.start - b.start);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  );
}

/** Deterministic pseudo-random in [0,1) from a string. Used by the mock brain. */
export function hashUnit(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

export function pick<T>(items: T[], seed: string): T {
  if (items.length === 0) throw new Error('pick() on empty array');
  return items[Math.floor(hashUnit(seed) * items.length)]!;
}
