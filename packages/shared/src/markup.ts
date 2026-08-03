/**
 * Message markup.
 *
 * Messages are stored as the plain text somebody typed — `**bold**`, `@sarah`,
 * `#general`, `:tada:` — never as a pre-rendered blob. That keeps a transcript
 * readable in a terminal or a JSON file, lets the agent reason over what was
 * actually said, and means the renderer is the only thing that has to change
 * when formatting grows.
 *
 * This module is the single parser both sides share: the relay uses it to work
 * out who was mentioned, the desktop app uses it to draw.
 */

import type { AgentAddress } from './domain.js';

// ---------------------------------------------------------------------------
// Emoji shortcodes
// ---------------------------------------------------------------------------

/** The shortcodes worth typing. Deliberately small — no 1,800-entry dependency. */
export const EMOJI: Record<string, string> = {
  '+1': '👍', '-1': '👎', thumbsup: '👍', thumbsdown: '👎', ok_hand: '👌', clap: '👏',
  wave: '👋', raised_hands: '🙌', pray: '🙏', muscle: '💪', point_right: '👉', eyes: '👀',
  smile: '😄', smiley: '😃', grin: '😁', laughing: '😆', joy: '😂', rofl: '🤣',
  slightly_smiling_face: '🙂', upside_down_face: '🙃', wink: '😉', blush: '😊',
  heart_eyes: '😍', star_struck: '🤩', thinking_face: '🤔', thinking: '🤔',
  neutral_face: '😐', expressionless: '😑', no_mouth: '😶', smirk: '😏',
  unamused: '😒', roll_eyes: '🙄', grimacing: '😬', lying_face: '🤥',
  relieved: '😌', pensive: '😔', sleepy: '😪', sleeping: '😴', mask: '😷',
  sunglasses: '😎', nerd_face: '🤓', confused: '😕', worried: '😟', frowning: '🙁',
  cry: '😢', sob: '😭', scream: '😱', fearful: '😨', cold_sweat: '😰',
  weary: '😩', tired_face: '😫', triumph: '😤', rage: '😡', angry: '😠',
  exploding_head: '🤯', partying_face: '🥳', melting_face: '🫠', salute: '🫡',
  face_with_monocle: '🧐', shushing_face: '🤫', zipper_mouth_face: '🤐',
  heart: '❤️', broken_heart: '💔', sparkling_heart: '💖', fire: '🔥', boom: '💥',
  sparkles: '✨', star: '⭐', star2: '🌟', zap: '⚡', rainbow: '🌈',
  tada: '🎉', confetti_ball: '🎊', gift: '🎁', balloon: '🎈', cake: '🎂',
  rocket: '🚀', airplane: '✈️', ship: '🚢', car: '🚗', construction: '🚧',
  white_check_mark: '✅', heavy_check_mark: '✔️', ballot_box_with_check: '☑️',
  x: '❌', negative_squared_cross_mark: '❎', warning: '⚠️', no_entry: '⛔',
  bulb: '💡', bell: '🔔', no_bell: '🔕', mag: '🔍', lock: '🔒', unlock: '🔓',
  key: '🔑', hammer: '🔨', wrench: '🔧', gear: '⚙️', nut_and_bolt: '🔩',
  bug: '🐛', ant: '🐜', snail: '🐌', turtle: '🐢', rabbit: '🐇', dog: '🐶',
  cat: '🐱', bear: '🐻', panda_face: '🐼', fox_face: '🦊', unicorn: '🦄',
  chart_with_upwards_trend: '📈', chart_with_downwards_trend: '📉', bar_chart: '📊',
  clipboard: '📋', memo: '📝', pencil: '✏️', books: '📚', book: '📖',
  page_facing_up: '📄', file_folder: '📁', open_file_folder: '📂', link: '🔗',
  calendar: '📅', date: '📆', alarm_clock: '⏰', hourglass: '⌛', stopwatch: '⏱️',
  computer: '💻', desktop_computer: '🖥️', keyboard: '⌨️', iphone: '📱',
  satellite: '🛰️', telescope: '🔭', microscope: '🔬', test_tube: '🧪', dna: '🧬',
  coffee: '☕', tea: '🍵', beer: '🍺', beers: '🍻', champagne: '🍾', pizza: '🍕',
  hamburger: '🍔', taco: '🌮', doughnut: '🍩', cookie: '🍪', apple: '🍎',
  sunny: '☀️', cloud: '☁️', umbrella: '☔', snowflake: '❄️', ocean: '🌊',
  earth_americas: '🌎', moon: '🌙', sun_with_face: '🌞', seedling: '🌱',
  herb: '🌿', four_leaf_clover: '🍀', maple_leaf: '🍁', cactus: '🌵',
  trophy: '🏆', medal: '🏅', dart: '🎯', game_die: '🎲', chess_pawn: '♟️',
  crystal_ball: '🔮', magic_wand: '🪄', robot: '🤖', alien: '👽', ghost: '👻',
  skull: '💀', poop: '💩', hankey: '💩', shipit: '🚢', ship_it: '🚢',
  eyes_shaking: '👀', 100: '💯', ok: '🆗', new: '🆕', top: '🔝', soon: '🔜',
  arrow_up: '⬆️', arrow_down: '⬇️', arrow_right: '➡️', arrow_left: '⬅️',
  recycle: '♻️', infinity: '♾️', question: '❓', exclamation: '❗',
  wastebasket: '🗑️', pushpin: '📌', paperclip: '📎', scissors: '✂️',
  handshake: '🤝', crossed_fingers: '🤞', v: '✌️', vulcan_salute: '🖖',
  raised_hand: '✋', open_hands: '👐', writing_hand: '✍️', selfie: '🤳',
};

/** The palette the emoji picker offers, in the order it shows them. */
export const EMOJI_PICKER_ROWS: { label: string; codes: string[] }[] = [
  { label: 'Reactions', codes: ['+1', '-1', 'tada', 'heart', 'fire', 'eyes', 'white_check_mark', 'rocket'] },
  { label: 'Faces', codes: ['smile', 'joy', 'sob', 'thinking_face', 'sunglasses', 'exploding_head', 'partying_face', 'salute'] },
  { label: 'Work', codes: ['clipboard', 'memo', 'bug', 'hammer', 'chart_with_upwards_trend', 'calendar', 'bulb', 'warning'] },
  { label: 'Life', codes: ['coffee', 'pizza', 'beer', 'seedling', 'sunny', 'ocean', 'trophy', 'robot'] },
];

export function emojiFor(code: string): string | null {
  return EMOJI[code.toLowerCase()] ?? null;
}

/** Suggest shortcodes for `:par` style autocomplete. */
export function searchEmoji(prefix: string, limit = 8): { code: string; char: string }[] {
  const needle = prefix.toLowerCase().replace(/^:/, '');
  if (!needle) return [];
  const starts: { code: string; char: string }[] = [];
  const contains: { code: string; char: string }[] = [];
  for (const [code, char] of Object.entries(EMOJI)) {
    if (code.startsWith(needle)) starts.push({ code, char });
    else if (code.includes(needle)) contains.push({ code, char });
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

export interface MentionScan {
  /** Handles as typed: the local part of an address, or a full address. */
  handles: string[];
  channels: string[];
  broadcast?: 'channel' | 'here' | 'everyone';
}

const MENTION_RE = /@([a-z0-9][a-z0-9._-]*(?:@[a-z0-9.-]+)?)/gi;
const CHANNEL_RE = /(?:^|[\s(])#([a-z0-9][a-z0-9._-]*)/gi;

/** Pull the raw @ and # tokens out of a message body. */
export function scanMentions(text: string): MentionScan {
  const handles: string[] = [];
  const channels: string[] = [];
  let broadcast: MentionScan['broadcast'];
  const stripped = stripCode(text);

  for (const match of stripped.matchAll(MENTION_RE)) {
    const raw = match[1]!.toLowerCase().replace(/[.\-_]+$/, '');
    if (raw === 'channel') broadcast = broadcast === 'everyone' ? broadcast : 'channel';
    else if (raw === 'here') broadcast ??= 'here';
    else if (raw === 'everyone') broadcast = 'everyone';
    else if (!handles.includes(raw)) handles.push(raw);
  }
  for (const match of stripped.matchAll(CHANNEL_RE)) {
    const name = match[1]!.toLowerCase();
    if (!channels.includes(name)) channels.push(name);
  }
  return { handles, channels, broadcast };
}

/** Blank out code spans and fences so `@` inside them is not a mention. */
function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

/**
 * Turn typed handles into real addresses against a membership list. Unmatched
 * handles are simply not mentions — a message that says "email me @ 5" should
 * not ping anybody.
 */
export function resolveMentions(
  text: string,
  members: { address: AgentAddress; displayName: string }[],
): { mentions: AgentAddress[]; broadcast?: 'channel' | 'here' | 'everyone'; channels: string[] } {
  const scan = scanMentions(text);
  const byHandle = new Map<string, AgentAddress>();
  for (const member of members) {
    byHandle.set(member.address.toLowerCase(), member.address);
    const local = member.address.split('@')[0]!.toLowerCase();
    if (!byHandle.has(local)) byHandle.set(local, member.address);
    const firstName = member.displayName.split(/\s+/)[0]?.toLowerCase();
    if (firstName && !byHandle.has(firstName)) byHandle.set(firstName, member.address);
  }
  const mentions: AgentAddress[] = [];
  for (const handle of scan.handles) {
    const address = byHandle.get(handle);
    if (address && !mentions.includes(address)) mentions.push(address);
  }
  return { mentions, broadcast: scan.broadcast, channels: scan.channels };
}

/** The handle a person is @-mentioned by inside a workspace. */
export function handleFor(address: AgentAddress): string {
  return address.split('@')[0] || address;
}

// ---------------------------------------------------------------------------
// Rich text
// ---------------------------------------------------------------------------

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'bold'; children: Inline[] }
  | { type: 'italic'; children: Inline[] }
  | { type: 'strike'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; label: string }
  | { type: 'mention'; handle: string; broadcast: boolean }
  | { type: 'channel'; name: string }
  | { type: 'emoji'; char: string; code: string };

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; children: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] };

const URL_RE = /^(https?:\/\/|www\.)[^\s<>()]+[^\s<>().,;:!?'"]/i;

/** Parse a message body into blocks the renderer can walk. */
export function parseMessage(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block.
    const fence = /^```(\S*)\s*$/.exec(line.trim());
    if (fence) {
      const lang = fence[1] ?? '';
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!.trim())) {
        body.push(lines[i]!);
        i++;
      }
      i++; // closing fence
      blocks.push({ type: 'code', lang, text: body.join('\n') });
      continue;
    }

    // Blockquote: consecutive "> " lines fold into one quote.
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', children: parseInline(body.join('\n')) });
      continue;
    }

    // Lists.
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = ordered ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[i]!) : /^\s*[-*•]\s+(.*)$/.exec(lines[i]!);
        if (!m) break;
        items.push(parseInline(m[1]!));
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // Paragraph: run of non-empty lines, soft-wrapped.
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^```/.test(lines[i]!.trim()) &&
      !/^\s*>\s?/.test(lines[i]!) &&
      !/^\s*[-*•]\s+/.test(lines[i]!) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i++;
    }
    blocks.push({ type: 'paragraph', children: parseInline(para.join('\n')) });
  }

  if (!blocks.length) blocks.push({ type: 'paragraph', children: [] });
  return blocks;
}

/**
 * Inline parser. Hand-rolled rather than pulled from a markdown library so the
 * exact dialect is ours: `@mentions`, `#channels` and `:emoji:` are first-class,
 * and stray asterisks in prose stay stray asterisks.
 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = '';
  let i = 0;

  const flush = () => {
    if (buffer) {
      out.push({ type: 'text', text: buffer });
      buffer = '';
    }
  };

  while (i < text.length) {
    const rest = text.slice(i);
    const ch = text[i]!;

    // `code`
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ type: 'code', text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // [label](href)
    if (ch === '[') {
      const m = /^\[([^\]]+)\]\((\S+?)\)/.exec(rest);
      if (m) {
        flush();
        out.push({ type: 'link', href: normalizeHref(m[2]!), label: m[1]! });
        i += m[0].length;
        continue;
      }
    }

    // Bare URLs, only at a word boundary.
    if ((ch === 'h' || ch === 'w') && (i === 0 || /\s|[([<]/.test(text[i - 1]!))) {
      const m = URL_RE.exec(rest);
      if (m) {
        flush();
        out.push({ type: 'link', href: normalizeHref(m[0]), label: m[0] });
        i += m[0].length;
        continue;
      }
    }

    // **bold** / __bold__
    const bold = matchDelimited(rest, '**') ?? matchDelimited(rest, '__');
    if (bold) {
      flush();
      out.push({ type: 'bold', children: parseInline(bold.inner) });
      i += bold.length;
      continue;
    }

    // ~~strike~~ or ~strike~
    const strike = matchDelimited(rest, '~~') ?? matchDelimited(rest, '~');
    if (strike) {
      flush();
      out.push({ type: 'strike', children: parseInline(strike.inner) });
      i += strike.length;
      continue;
    }

    // *italic* / _italic_  (underscores only between word boundaries, so
    // snake_case_identifiers survive)
    const italic =
      matchDelimited(rest, '*') ??
      (i === 0 || /[\s(]/.test(text[i - 1]!) ? matchDelimited(rest, '_') : null);
    if (italic) {
      flush();
      out.push({ type: 'italic', children: parseInline(italic.inner) });
      i += italic.length;
      continue;
    }

    // :emoji:
    if (ch === ':') {
      const m = /^:([a-z0-9_+-]{1,40}):/i.exec(rest);
      const char = m ? emojiFor(m[1]!) : null;
      if (m && char) {
        flush();
        out.push({ type: 'emoji', char, code: m[1]!.toLowerCase() });
        i += m[0].length;
        continue;
      }
    }

    // @mention
    if (ch === '@') {
      const m = /^@([a-z0-9][a-z0-9._-]*(?:@[a-z0-9.-]+)?)/i.exec(rest);
      if (m) {
        const handle = m[1]!.replace(/[.\-_]+$/, '');
        flush();
        out.push({
          type: 'mention',
          handle: handle.toLowerCase(),
          broadcast: ['channel', 'here', 'everyone'].includes(handle.toLowerCase()),
        });
        i += 1 + handle.length;
        continue;
      }
    }

    // #channel
    if (ch === '#' && (i === 0 || /[\s(]/.test(text[i - 1]!))) {
      const m = /^#([a-z0-9][a-z0-9._-]*)/i.exec(rest);
      if (m) {
        flush();
        out.push({ type: 'channel', name: m[1]!.toLowerCase() });
        i += m[0].length;
        continue;
      }
    }

    buffer += ch;
    i++;
  }

  flush();
  return out;
}

/**
 * Match `<delim>inner<delim>` at the start of `text`, where inner is non-empty
 * and does not start or end with whitespace.
 */
function matchDelimited(text: string, delim: string): { inner: string; length: number } | null {
  if (!text.startsWith(delim)) return null;
  const from = delim.length;
  if (/\s/.test(text[from] ?? ' ')) return null;
  let search = from;
  for (;;) {
    const end = text.indexOf(delim, search);
    if (end === -1 || end === from) return null;
    if (/\s/.test(text[end - 1]!)) {
      search = end + delim.length;
      continue;
    }
    // A longer delimiter wins: don't let `*` swallow half of `**bold**`.
    if (delim === '*' && text[end + 1] === '*') {
      search = end + 1;
      continue;
    }
    return { inner: text.slice(from, end), length: end + delim.length };
  }
}

function normalizeHref(href: string): string {
  return /^www\./i.test(href) ? `https://${href}` : href;
}

/** Flatten a message to one line — for notifications, previews and prompts. */
export function messagePreview(text: string, max = 120): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\[([^\]]+)\]\(\S+?\)/g, '$1')
    .replace(/:([a-z0-9_+-]{1,40}):/gi, (m, code: string) => emojiFor(code) ?? m)
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
