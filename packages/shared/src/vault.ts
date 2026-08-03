/**
 * The vault: a folder of markdown files, indexed the way Obsidian indexes one.
 *
 * Everything here is pure — no filesystem, no DOM — so the same parser produces
 * the index in the Electron main process and re-parses a buffer as you type in
 * the renderer. That symmetry is what keeps backlinks, the graph and the outline
 * from drifting from the text on screen.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FrontmatterValue =
  | string
  | number
  | boolean
  | null
  | FrontmatterValue[]
  | { [key: string]: FrontmatterValue };

export interface VaultFile {
  /** Posix path relative to the vault root, e.g. "Projects/Auth.md". */
  path: string;
  name: string;
  basename: string;
  extension: string;
  folder: string;
  size: number;
  mtime: number;
  ctime: number;
}

export interface Heading {
  level: number;
  text: string;
  line: number;
  /** Anchor slug, used by [[note#heading]]. */
  slug: string;
}

export interface LinkRef {
  /** Everything between the brackets: "Note#Heading|Alias". */
  raw: string;
  target: string;
  /** "#Heading", "#^blockid", or "". */
  subpath: string;
  alias?: string;
  line: number;
  /** Column of the opening bracket. */
  col: number;
  embed: boolean;
  /** Markdown links to http(s)/mailto keep their href here instead. */
  external?: string;
  /** The source line, so the backlinks pane can show it without re-reading. */
  context?: string;
}

export interface TaskItem {
  text: string;
  /** The character inside the brackets: " ", "x", "/", "-", ">" … */
  status: string;
  checked: boolean;
  line: number;
  indent: number;
}

export interface NoteMeta {
  path: string;
  basename: string;
  /** Frontmatter `title`, else a level-1 heading, else the filename. */
  title: string;
  aliases: string[];
  /** Frontmatter tags and inline #tags, deduped, without the leading '#'. */
  tags: string[];
  frontmatter: Record<string, FrontmatterValue>;
  /** Line the body starts on, after any frontmatter block. */
  bodyLine: number;
  headings: Heading[];
  links: LinkRef[];
  embeds: LinkRef[];
  tasks: TaskItem[];
  /** "^blockid" anchors → line number. */
  blocks: Record<string, number>;
  words: number;
  chars: number;
  excerpt: string;
  size: number;
  mtime: number;
  ctime: number;
}

export interface VaultSnapshot {
  root: string;
  files: VaultFile[];
  meta: Record<string, NoteMeta>;
  folders: string[];
}

export interface SearchMatch {
  line: number;
  col: number;
  length: number;
  text: string;
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  matches: SearchMatch[];
  total: number;
}

export const MARKDOWN_EXTENSIONS = ['md', 'markdown'];
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif'];
export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'ogg', 'flac', '3gp'];
export const VIDEO_EXTENSIONS = ['mp4', 'webm', 'ogv', 'mov', 'mkv'];
export const ATTACHMENT_EXTENSIONS = [
  ...IMAGE_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  'pdf',
  'canvas',
];

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function normalizeVaultPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+/g, '/');
}

export function basename(p: string): string {
  const name = normalizeVaultPath(p).split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export function extname(p: string): string {
  const name = normalizeVaultPath(p).split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function dirname(p: string): string {
  const parts = normalizeVaultPath(p).split('/');
  parts.pop();
  return parts.join('/');
}

export function joinPath(...parts: string[]): string {
  return normalizeVaultPath(parts.filter(Boolean).join('/'));
}

export function isMarkdown(p: string): boolean {
  return MARKDOWN_EXTENSIONS.includes(extname(p));
}

/** Strip characters a file name cannot carry, the way Obsidian does. */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|#^[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function headingSlug(text: string): string {
  return text.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
}

// ---------------------------------------------------------------------------
// YAML frontmatter — the subset Obsidian's properties actually use
// ---------------------------------------------------------------------------

interface FrontmatterSplit {
  frontmatter: Record<string, FrontmatterValue>;
  /** Number of lines the frontmatter block occupies, including both fences. */
  lines: number;
  raw: string;
}

export function splitFrontmatter(content: string): FrontmatterSplit {
  if (!/^---\r?\n/.test(content)) return { frontmatter: {}, lines: 0, raw: '' };
  const rest = content.slice(content.indexOf('\n') + 1);
  const end = rest.search(/^---[ \t]*(\r?\n|$)/m);
  if (end === -1) return { frontmatter: {}, lines: 0, raw: '' };
  const raw = rest.slice(0, end);
  const consumed = content.slice(0, content.indexOf('\n') + 1 + end);
  const closing = rest.slice(end).split('\n')[0] ?? '---';
  const lines = (consumed + closing).split('\n').length;
  return { frontmatter: parseYaml(raw), lines, raw };
}

/**
 * A deliberately small YAML reader: scalars, block and inline sequences, and
 * one level of nested maps. Anything stranger is kept as its literal string so
 * a round trip never destroys what the user wrote.
 */
export function parseYaml(text: string): Record<string, FrontmatterValue> {
  const lines = text.split(/\r?\n/);
  const root: Record<string, FrontmatterValue> = {};
  let index = 0;

  function indentOf(line: string): number {
    return line.length - line.trimStart().length;
  }

  function parseBlock(minIndent: number): Record<string, FrontmatterValue> {
    const out: Record<string, FrontmatterValue> = {};
    while (index < lines.length) {
      const line = lines[index]!;
      if (!line.trim() || line.trimStart().startsWith('#')) {
        index += 1;
        continue;
      }
      const indent = indentOf(line);
      if (indent < minIndent) break;
      const match = /^([^:]+):[ \t]*(.*)$/.exec(line.trim());
      if (!match) {
        index += 1;
        continue;
      }
      const key = match[1]!.trim().replace(/^["']|["']$/g, '');
      const inline = match[2]!.trim();
      index += 1;
      if (inline) {
        out[key] = parseScalar(inline);
        continue;
      }
      // Look ahead: a block sequence, a nested map, or an empty value.
      const next = lines[index];
      if (next && /^\s*-\s?/.test(next) && indentOf(next) >= indent) {
        const items: FrontmatterValue[] = [];
        while (index < lines.length) {
          const item = lines[index]!;
          if (!item.trim()) {
            index += 1;
            continue;
          }
          if (indentOf(item) < indent || !/^\s*-\s?/.test(item)) break;
          items.push(parseScalar(item.trim().replace(/^-\s?/, '')));
          index += 1;
        }
        out[key] = items;
      } else if (next && next.trim() && indentOf(next) > indent) {
        out[key] = parseBlock(indentOf(next));
      } else {
        out[key] = null;
      }
    }
    return out;
  }

  Object.assign(root, parseBlock(0));
  return root;
}

function parseScalar(value: string): FrontmatterValue {
  const text = value.trim();
  if (!text) return null;
  if (/^".*"$/.test(text) || /^'.*'$/.test(text)) return text.slice(1, -1);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (/^\[.*\]$/.test(text)) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner).map((part) => parseScalar(part));
  }
  return text;
}

function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === '[' || ch === '{') {
      depth += 1;
      current += ch;
    } else if (ch === ']' || ch === '}') {
      depth -= 1;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current);
  return out.map((s) => s.trim());
}

export function stringifyYaml(value: Record<string, FrontmatterValue>, indent = 0): string {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) {
      lines.push(`${pad}${key}:`);
    } else if (Array.isArray(item)) {
      if (item.length === 0) {
        lines.push(`${pad}${key}: []`);
      } else {
        lines.push(`${pad}${key}:`);
        for (const entry of item) lines.push(`${pad}  - ${scalarToYaml(entry)}`);
      }
    } else if (typeof item === 'object') {
      lines.push(`${pad}${key}:`);
      lines.push(stringifyYaml(item as Record<string, FrontmatterValue>, indent + 2));
    } else {
      lines.push(`${pad}${key}: ${scalarToYaml(item)}`);
    }
  }
  return lines.join('\n');
}

function scalarToYaml(value: FrontmatterValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(scalarToYaml).join(', ')}]`;
  if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value);
  // Quote anything that would otherwise be read back as structure.
  if (/^[\s]|[\s]$|^[-?:,[\]{}#&*!|>'"%@`]|:\s|^\d+$|^(true|false|null)$/i.test(text)) {
    return `"${text.replace(/"/g, '\\"')}"`;
  }
  return text;
}

/** Replace (or insert, or remove) the frontmatter block of a document. */
export function withFrontmatter(
  content: string,
  frontmatter: Record<string, FrontmatterValue>,
): string {
  const existing = splitFrontmatter(content);
  const bodyStart = existing.lines
    ? content.split('\n').slice(existing.lines).join('\n')
    : content;
  const keys = Object.keys(frontmatter);
  if (keys.length === 0) return bodyStart.replace(/^\n+/, '');
  return `---\n${stringifyYaml(frontmatter)}\n---\n${bodyStart.replace(/^\n+/, '\n').replace(/^\n/, '')}`;
}

// ---------------------------------------------------------------------------
// Metadata extraction
// ---------------------------------------------------------------------------

const WIKILINK = /(!)?\[\[([^\]\n]+)\]\]/g;
const MDLINK = /(!)?\[([^\]\n]*)\]\(([^)\n]+)\)/g;
const TAG = /(^|[\s(>[])#([\p{L}\p{N}_/-]*[\p{L}\p{N}_/-])/gu;
const BLOCK_ID = /[ \t]\^([\w-]+)[ \t]*$/;

/** Split "Note#Heading|Alias" into its parts. */
export function parseLinkTarget(raw: string, embed = false, line = 0, col = 0): LinkRef {
  let rest = raw;
  let alias: string | undefined;
  const pipe = rest.indexOf('|');
  if (pipe !== -1) {
    alias = rest.slice(pipe + 1).trim();
    rest = rest.slice(0, pipe);
  }
  let subpath = '';
  const hash = rest.indexOf('#');
  if (hash !== -1) {
    subpath = rest.slice(hash);
    rest = rest.slice(0, hash);
  }
  return { raw, target: rest.trim(), subpath, alias, line, col, embed };
}

/** True inside a fenced code block, so links and tags there are left alone. */
function fenceScanner(): (line: string) => boolean {
  let fence: string | null = null;
  return (line: string) => {
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (match) {
      const marker = match[1]![0]!;
      if (fence === null) {
        fence = marker;
        return true;
      }
      if (marker === fence) {
        fence = null;
        return true;
      }
    }
    return fence !== null;
  };
}

export function parseNoteMeta(
  path: string,
  content: string,
  stat: { size?: number; mtime?: number; ctime?: number } = {},
): NoteMeta {
  const { frontmatter, lines: fmLines } = splitFrontmatter(content);
  const lines = content.split(/\r?\n/);
  const headings: Heading[] = [];
  const links: LinkRef[] = [];
  const embeds: LinkRef[] = [];
  const tasks: TaskItem[] = [];
  const blocks: Record<string, number> = {};
  const tagSet = new Set<string>();

  for (const value of collectStrings(frontmatter.tags ?? frontmatter.tag)) {
    for (const part of value.split(/[,\s]+/)) {
      const clean = part.replace(/^#/, '').trim();
      if (clean) tagSet.add(clean);
    }
  }
  const aliases = collectStrings(frontmatter.aliases ?? frontmatter.alias);

  const inFence = fenceScanner();
  const excerptParts: string[] = [];
  let words = 0;

  for (let i = fmLines; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (inFence(line)) continue;

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const text = heading[2]!.replace(/\s*#+\s*$/, '').trim();
      headings.push({ level: heading[1]!.length, text, line: i, slug: headingSlug(text) });
    }

    const task = /^(\s*)[-*+]\s+\[(.)\]\s*(.*)$/.exec(line);
    if (task) {
      tasks.push({
        indent: task[1]!.length,
        status: task[2]!,
        checked: task[2]! !== ' ',
        text: task[3]!.trim(),
        line: i,
      });
    }

    const block = BLOCK_ID.exec(line);
    if (block) blocks[block[1]!] = i;

    const context = line.trim().slice(0, 300);

    WIKILINK.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WIKILINK.exec(line))) {
      const ref = parseLinkTarget(match[2]!, Boolean(match[1]), i, match.index);
      ref.context = context;
      (ref.embed ? embeds : links).push(ref);
    }

    MDLINK.lastIndex = 0;
    while ((match = MDLINK.exec(line))) {
      const href = match[3]!.trim().replace(/^<|>$/g, '').split(/\s+"/)[0]!;
      const embed = Boolean(match[1]);
      if (/^[a-z][\w+.-]*:/i.test(href)) {
        const ref: LinkRef = {
          raw: href,
          target: href,
          subpath: '',
          alias: match[2] || undefined,
          line: i,
          col: match.index,
          embed,
          external: href,
          context,
        };
        (embed ? embeds : links).push(ref);
      } else {
        const decoded = decodeURI(href);
        const ref = parseLinkTarget(
          match[2] ? `${decoded}|${match[2]}` : decoded,
          embed,
          i,
          match.index,
        );
        ref.context = context;
        (embed ? embeds : links).push(ref);
      }
    }

    TAG.lastIndex = 0;
    while ((match = TAG.exec(line))) {
      // A bare "#" heading marker and hex colours are not tags.
      if (/^\d+$/.test(match[2]!)) continue;
      tagSet.add(match[2]!);
    }

    const plain = line.trim();
    if (plain) {
      words += plain.split(/\s+/).filter(Boolean).length;
      if (excerptParts.join(' ').length < 220 && !heading && !plain.startsWith('---')) {
        excerptParts.push(stripInline(plain));
      }
    }
  }

  const title =
    typeof frontmatter.title === 'string' && frontmatter.title.trim()
      ? frontmatter.title.trim()
      : (headings.find((h) => h.level === 1)?.text ?? basename(path));

  return {
    path,
    basename: basename(path),
    title,
    aliases,
    tags: [...tagSet],
    frontmatter,
    bodyLine: fmLines,
    headings,
    links,
    embeds,
    tasks,
    blocks,
    words,
    chars: content.length - (fmLines ? content.split('\n').slice(0, fmLines).join('\n').length : 0),
    excerpt: excerptParts.join(' ').slice(0, 220),
    size: stat.size ?? content.length,
    mtime: stat.mtime ?? Date.now(),
    ctime: stat.ctime ?? Date.now(),
  };
}

function collectStrings(value: FrontmatterValue | undefined): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((v) => collectStrings(v));
  if (typeof value === 'object') return [];
  return [String(value)].filter((s) => s.trim().length > 0);
}

/** Strip markdown syntax for previews and search snippets. */
export function stripInline(text: string): string {
  return text
    .replace(/!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, target: string, alias: string) => alias || target)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|~~|==|`)/g, '')
    .replace(/^\s*>+\s?/, '')
    .replace(/^\s*[-*+]\s+(\[.\]\s*)?/, '')
    .replace(/^\s*\d+\.\s+/, '')
    .replace(/^#{1,6}\s+/, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Link resolution
// ---------------------------------------------------------------------------

export interface ResolverIndex {
  /** lowercased name/alias/path → candidate paths */
  byName: Map<string, string[]>;
  paths: Set<string>;
}

export function buildResolver(meta: Record<string, NoteMeta>, files: VaultFile[]): ResolverIndex {
  const byName = new Map<string, string[]>();
  const paths = new Set<string>();
  const add = (key: string, path: string) => {
    const k = key.toLowerCase();
    const list = byName.get(k);
    if (list) {
      if (!list.includes(path)) list.push(path);
    } else {
      byName.set(k, [path]);
    }
  };
  for (const file of files) {
    paths.add(file.path);
    add(file.path, file.path);
    add(file.basename, file.path);
    if (isMarkdown(file.path)) {
      // "Folder/Note" without the extension is a valid link target too.
      add(file.path.replace(/\.[^/.]+$/, ''), file.path);
    }
  }
  for (const note of Object.values(meta)) {
    for (const alias of note.aliases) add(alias, note.path);
    if (note.title !== note.basename) add(note.title, note.path);
  }
  return { byName, paths };
}

/**
 * Resolve a link the way Obsidian does: exact path first, then shortest path
 * that matches the name, preferring one in the same folder as the source.
 */
export function resolveLink(
  index: ResolverIndex,
  target: string,
  fromPath = '',
): string | undefined {
  const clean = normalizeVaultPath(target.trim());
  if (!clean) return fromPath || undefined;
  const candidates =
    index.byName.get(clean.toLowerCase()) ??
    index.byName.get(`${clean.toLowerCase()}.md`) ??
    (index.paths.has(`${clean}.md`) ? [`${clean}.md`] : undefined);
  if (!candidates || candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  const folder = dirname(fromPath);
  const sameFolder = candidates.find((c) => dirname(c) === folder);
  if (sameFolder) return sameFolder;
  return [...candidates].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0];
}

export interface BacklinkEntry {
  from: string;
  link: LinkRef;
  /** The source line, for the preview shown in the backlinks pane. */
  context: string;
}

export function buildBacklinks(
  meta: Record<string, NoteMeta>,
  index: ResolverIndex,
): Map<string, BacklinkEntry[]> {
  const out = new Map<string, BacklinkEntry[]>();
  for (const note of Object.values(meta)) {
    for (const link of [...note.links, ...note.embeds]) {
      if (link.external) continue;
      const to = resolveLink(index, link.target, note.path);
      if (!to) continue;
      const entry: BacklinkEntry = { from: note.path, link, context: link.context ?? '' };
      const list = out.get(to);
      if (list) list.push(entry);
      else out.set(to, [entry]);
    }
  }
  return out;
}

/**
 * Notes that name this one in plain text without linking to it. Obsidian calls
 * these unlinked mentions, and they are where most link-worthy connections hide.
 */
export function unlinkedMentions(
  meta: Record<string, NoteMeta>,
  contents: Map<string, string>,
  target: NoteMeta,
  linkedFrom: Set<string>,
): { from: string; line: number; context: string }[] {
  const names = [target.basename, target.title, ...target.aliases]
    .filter((n) => n && n.length > 2)
    .map((n) => n.toLowerCase());
  if (!names.length) return [];
  const out: { from: string; line: number; context: string }[] = [];
  for (const [notePath, content] of contents) {
    if (notePath === target.path || linkedFrom.has(notePath)) continue;
    if (!meta[notePath]) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const lower = lines[i]!.toLowerCase();
      if (!names.some((n) => lower.includes(n))) continue;
      // Skip a mention that is already inside a link to somewhere.
      if (/\[\[[^\]]*\]\]/.test(lines[i]!) && names.some((n) => lower.includes(`[[${n}`))) continue;
      out.push({ from: notePath, line: i, context: lines[i]!.trim().slice(0, 300) });
      if (out.length > 200) return out;
    }
  }
  return out;
}

export interface GraphNode {
  id: string;
  label: string;
  /** 'note' | 'unresolved' | 'attachment' | 'tag' */
  kind: 'note' | 'unresolved' | 'attachment' | 'tag';
  links: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export function buildGraph(
  meta: Record<string, NoteMeta>,
  files: VaultFile[],
  index: ResolverIndex,
  options: { showUnresolved?: boolean; showAttachments?: boolean; showTags?: boolean } = {},
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (isMarkdown(file.path)) {
      nodes.set(file.path, { id: file.path, label: basename(file.path), kind: 'note', links: 0 });
    } else if (options.showAttachments) {
      nodes.set(file.path, { id: file.path, label: file.name, kind: 'attachment', links: 0 });
    }
  }

  const connect = (source: string, target: string) => {
    const key = `${source} -> ${target}`;
    if (seen.has(key) || source === target) return;
    seen.add(key);
    edges.push({ source, target });
    const a = nodes.get(source);
    const b = nodes.get(target);
    if (a) a.links += 1;
    if (b) b.links += 1;
  };

  for (const note of Object.values(meta)) {
    if (!nodes.has(note.path)) continue;
    for (const link of [...note.links, ...note.embeds]) {
      if (link.external) continue;
      const to = resolveLink(index, link.target, note.path);
      if (to) {
        if (nodes.has(to)) connect(note.path, to);
      } else if (options.showUnresolved && link.target) {
        const id = `unresolved:${link.target.toLowerCase()}`;
        if (!nodes.has(id)) nodes.set(id, { id, label: link.target, kind: 'unresolved', links: 0 });
        connect(note.path, id);
      }
    }
    if (options.showTags) {
      for (const tag of note.tags) {
        const id = `tag:${tag}`;
        if (!nodes.has(id)) nodes.set(id, { id, label: `#${tag}`, kind: 'tag', links: 0 });
        connect(note.path, id);
      }
    }
  }

  return { nodes: [...nodes.values()], edges };
}

/** Every tag in the vault with its count, including implicit parents of a/b. */
export function tagCounts(meta: Record<string, NoteMeta>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const note of Object.values(meta)) {
    const seen = new Set<string>();
    for (const tag of note.tags) {
      const parts = tag.split('/');
      for (let i = 1; i <= parts.length; i += 1) seen.add(parts.slice(0, i).join('/'));
    }
    for (const tag of seen) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Fuzzy matching, for the quick switcher and the command palette
// ---------------------------------------------------------------------------

export interface FuzzyResult {
  score: number;
  /** Indices of matched characters, for highlighting. */
  positions: number[];
}

export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  if (!query) return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q[qi]!;
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    // Reward consecutive characters and matches at word boundaries.
    if (found === ti && positions.length) {
      streak += 1;
      score += 8 + streak * 2;
    } else {
      streak = 0;
      score += 1;
    }
    if (found === 0 || /[\s/_\-.]/.test(t[found - 1] ?? '')) score += 10;
    positions.push(found);
    ti = found + 1;
  }
  score -= Math.max(0, t.length - q.length) * 0.05;
  return { score, positions };
}

// ---------------------------------------------------------------------------
// Vault settings — the durable, user-facing knobs Obsidian exposes
// ---------------------------------------------------------------------------

export interface VaultSettings {
  theme: 'dark' | 'light' | 'system';
  accentColor: string;
  fontSize: number;
  lineWidth: number;
  readableLineLength: boolean;
  showLineNumbers: boolean;
  defaultViewMode: 'source' | 'live' | 'reading';
  spellcheck: boolean;
  strictLineBreaks: boolean;
  showFrontmatter: boolean;
  foldHeadings: boolean;
  newFileFolder: string;
  attachmentFolder: string;
  dailyNoteFormat: string;
  dailyNoteFolder: string;
  dailyNoteTemplate: string;
  templateFolder: string;
  alwaysUpdateLinks: boolean;
  useMarkdownLinks: boolean;
  confirmDelete: boolean;
  trashOption: 'system' | 'local' | 'permanent';
  showRibbon: boolean;
  graph: GraphSettings;
  hotkeys: Record<string, string>;
}

export interface GraphSettings {
  showTags: boolean;
  showAttachments: boolean;
  showUnresolved: boolean;
  showArrows: boolean;
  textFadeThreshold: number;
  nodeSize: number;
  linkThickness: number;
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;
}

export function defaultVaultSettings(): VaultSettings {
  return {
    theme: 'dark',
    accentColor: '#6ea8fe',
    fontSize: 16,
    lineWidth: 700,
    readableLineLength: true,
    showLineNumbers: false,
    defaultViewMode: 'live',
    spellcheck: true,
    strictLineBreaks: false,
    showFrontmatter: true,
    foldHeadings: true,
    newFileFolder: '',
    attachmentFolder: 'attachments',
    dailyNoteFormat: 'YYYY-MM-DD',
    dailyNoteFolder: 'Daily',
    dailyNoteTemplate: '',
    templateFolder: 'Templates',
    alwaysUpdateLinks: true,
    useMarkdownLinks: false,
    confirmDelete: true,
    trashOption: 'local',
    showRibbon: true,
    graph: {
      showTags: false,
      showAttachments: false,
      showUnresolved: true,
      showArrows: false,
      textFadeThreshold: 1.1,
      nodeSize: 1,
      linkThickness: 1,
      centerForce: 0.4,
      repelForce: 10,
      linkForce: 1,
      linkDistance: 60,
    },
    hotkeys: {},
  };
}

// ---------------------------------------------------------------------------
// Date formatting for daily notes and template variables (moment-style tokens)
// ---------------------------------------------------------------------------

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function formatDate(pattern: string, date = new Date()): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const hours12 = date.getHours() % 12 || 12;
  const tokens: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    YY: pad(date.getFullYear() % 100),
    MMMM: MONTHS[date.getMonth()]!,
    MMM: MONTHS[date.getMonth()]!.slice(0, 3),
    MM: pad(date.getMonth() + 1),
    M: String(date.getMonth() + 1),
    dddd: DAYS[date.getDay()]!,
    ddd: DAYS[date.getDay()]!.slice(0, 3),
    DD: pad(date.getDate()),
    D: String(date.getDate()),
    HH: pad(date.getHours()),
    H: String(date.getHours()),
    hh: pad(hours12),
    h: String(hours12),
    mm: pad(date.getMinutes()),
    m: String(date.getMinutes()),
    ss: pad(date.getSeconds()),
    s: String(date.getSeconds()),
    A: date.getHours() < 12 ? 'AM' : 'PM',
    a: date.getHours() < 12 ? 'am' : 'pm',
    ww: pad(weekOfYear(date)),
    w: String(weekOfYear(date)),
  };
  // `[text]` escapes a literal, matched in the same pass so its contents are
  // never mistaken for tokens. Longest tokens first so YYYY beats YY.
  const keys = Object.keys(tokens).sort((a, b) => b.length - a.length);
  const regex = new RegExp(`\\[([^\\]]*)\\]|${keys.join('|')}`, 'g');
  return pattern.replace(regex, (match: string, literal?: string) =>
    literal === undefined ? (tokens[match] ?? match) : literal,
  );
}

function weekOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 1);
  const diff = (date.getTime() - start.getTime()) / 86_400_000;
  return Math.ceil((diff + start.getDay() + 1) / 7);
}

/** Expand the template variables Obsidian's core Templates plugin supports. */
export function applyTemplate(
  body: string,
  context: { title: string; date?: Date },
): string {
  const date = context.date ?? new Date();
  return body
    .replace(/\{\{\s*title\s*\}\}/gi, context.title)
    .replace(/\{\{\s*date\s*:\s*([^}]+)\}\}/gi, (_m, fmt: string) => formatDate(fmt.trim(), date))
    .replace(/\{\{\s*time\s*:\s*([^}]+)\}\}/gi, (_m, fmt: string) => formatDate(fmt.trim(), date))
    .replace(/\{\{\s*date\s*\}\}/gi, formatDate('YYYY-MM-DD', date))
    .replace(/\{\{\s*time\s*\}\}/gi, formatDate('HH:mm', date));
}
