/**
 * The vault on disk.
 *
 * A vault is just a folder of markdown files — nested folders, attachments,
 * canvases, and an `.obsidian/` directory for settings. Nothing here is a
 * database: every operation is a file operation, so the same folder opens in
 * Obsidian proper and nothing is lost either way.
 *
 * The class keeps three things in memory: the file list, the parsed metadata
 * for every markdown file, and the raw text. That is what makes backlinks,
 * the graph, tag counts and search instant without touching the disk again.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import {
  type CanvasData,
  type FrontmatterValue,
  type NoteMeta,
  type ResolverIndex,
  type VaultSearchHit,
  type SearchMatch,
  type VaultFile,
  type VaultSettings,
  type VaultSnapshot,
  ATTACHMENT_EXTENSIONS,
  applyTemplate,
  basename as vaultBasename,
  buildResolver,
  defaultVaultSettings,
  dirname as vaultDirname,
  extname,
  formatDate,
  isMarkdown,
  joinPath,
  normalizeVaultPath,
  parseNoteMeta,
  resolveLink,
  sanitizeFileName,
  splitFrontmatter,
  stringifyYaml,
  unlinkedMentions,
} from '@ai-coworker/shared';

const CONFIG_DIR = '.obsidian';
const TRASH_DIR = '.trash';
const IGNORED_DIRS = new Set(['.git', 'node_modules', CONFIG_DIR, TRASH_DIR]);

export interface VaultEvents {
  change: [reason: string];
}

export interface Bookmark {
  type: 'file' | 'folder' | 'search' | 'graph' | 'heading' | 'block';
  path?: string;
  subpath?: string;
  query?: string;
  title?: string;
  ctime: number;
}

export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  limit?: number;
  /** Restrict to a folder. */
  folder?: string;
}

interface RenameResult {
  path: string;
  updated: string[];
}

export class Vault extends EventEmitter {
  readonly root: string;
  private files = new Map<string, VaultFile>();
  private contents = new Map<string, string>();
  private metaCache = new Map<string, NoteMeta>();
  private settingsData: VaultSettings = defaultVaultSettings();
  private bookmarksData: Bookmark[] = [];
  private watcher: fsSync.FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private suppressWatch = 0;

  private constructor(root: string) {
    super();
    this.root = root;
  }

  static async open(root: string): Promise<Vault> {
    await fs.mkdir(root, { recursive: true });
    const vault = new Vault(root);
    await vault.loadSettings();
    await vault.scan();
    return vault;
  }

  // --- scanning ------------------------------------------------------------

  async scan(): Promise<void> {
    this.files.clear();
    this.contents.clear();
    this.metaCache.clear();
    await this.walk('');
    this.emit('change', 'scan');
  }

  private async walk(rel: string): Promise<void> {
    const abs = path.join(this.root, rel);
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await this.walk(relPath);
        continue;
      }
      if (entry.name.startsWith('.')) continue;
      const ext = extname(relPath);
      if (!isMarkdown(relPath) && !ATTACHMENT_EXTENSIONS.includes(ext)) continue;
      await this.index(relPath);
    }
  }

  private async index(relPath: string): Promise<void> {
    const abs = path.join(this.root, relPath);
    let stat: fsSync.Stats;
    try {
      stat = await fs.stat(abs);
    } catch {
      return;
    }
    const file: VaultFile = {
      path: relPath,
      name: relPath.split('/').pop() ?? relPath,
      basename: vaultBasename(relPath),
      extension: extname(relPath),
      folder: vaultDirname(relPath),
      size: stat.size,
      mtime: stat.mtimeMs,
      ctime: stat.birthtimeMs || stat.ctimeMs,
    };
    this.files.set(relPath, file);
    if (isMarkdown(relPath)) {
      const content = await fs.readFile(abs, 'utf8').catch(() => '');
      this.contents.set(relPath, content);
      this.metaCache.set(
        relPath,
        parseNoteMeta(relPath, content, { size: stat.size, mtime: file.mtime, ctime: file.ctime }),
      );
    }
  }

  // --- accessors -----------------------------------------------------------

  snapshot(): VaultSnapshot {
    const folders = new Set<string>();
    for (const file of this.files.values()) {
      const parts = file.folder.split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i += 1) folders.add(parts.slice(0, i).join('/'));
    }
    // Empty folders still belong in the explorer.
    for (const folder of this.emptyFolders) folders.add(folder);
    return {
      root: this.root,
      files: [...this.files.values()].sort((a, b) => a.path.localeCompare(b.path)),
      meta: Object.fromEntries(this.metaCache),
      folders: [...folders].sort(),
    };
  }

  private emptyFolders: string[] = [];

  /** Folders with no indexed files still need to appear in the file explorer. */
  async refreshFolders(): Promise<void> {
    const out: string[] = [];
    const walk = async (rel: string) => {
      const entries = await fs
        .readdir(path.join(this.root, rel), { withFileTypes: true })
        .catch(() => [] as fsSync.Dirent[]);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        out.push(relPath);
        await walk(relPath);
      }
    };
    await walk('');
    this.emptyFolders = out;
  }

  get settings(): VaultSettings {
    return this.settingsData;
  }

  get bookmarks(): Bookmark[] {
    return this.bookmarksData;
  }

  meta(relPath: string): NoteMeta | undefined {
    return this.metaCache.get(relPath);
  }

  allMeta(): Record<string, NoteMeta> {
    return Object.fromEntries(this.metaCache);
  }

  exists(relPath: string): boolean {
    return this.files.has(normalizeVaultPath(relPath));
  }

  async read(relPath: string): Promise<string> {
    const clean = normalizeVaultPath(relPath);
    const cached = this.contents.get(clean);
    if (cached !== undefined) return cached;
    return fs.readFile(this.abs(clean), 'utf8');
  }

  async readBinary(relPath: string): Promise<Buffer> {
    return fs.readFile(this.abs(normalizeVaultPath(relPath)));
  }

  abs(relPath: string): string {
    const clean = normalizeVaultPath(relPath);
    const full = path.resolve(this.root, clean);
    // Never let a crafted link escape the vault.
    const rootResolved = path.resolve(this.root);
    if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
      throw new Error(`Path escapes the vault: ${relPath}`);
    }
    return full;
  }

  // --- mutations -----------------------------------------------------------

  async write(relPath: string, content: string): Promise<void> {
    const clean = normalizeVaultPath(relPath);
    const abs = this.abs(clean);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    this.suppress();
    await fs.writeFile(abs, content, 'utf8');
    await this.index(clean);
    this.emit('change', 'write');
  }

  async writeBinary(relPath: string, data: Buffer): Promise<void> {
    const clean = normalizeVaultPath(relPath);
    const abs = this.abs(clean);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    this.suppress();
    await fs.writeFile(abs, data);
    await this.index(clean);
    this.emit('change', 'write');
  }

  /** Create a file, appending " 1", " 2" … if the name is taken. */
  async create(relPath: string, content = ''): Promise<string> {
    const clean = this.uniquePath(normalizeVaultPath(relPath));
    await this.write(clean, content);
    return clean;
  }

  uniquePath(relPath: string): string {
    if (!this.files.has(relPath) && !fsSync.existsSync(this.abs(relPath))) return relPath;
    const ext = extname(relPath);
    const stem = ext ? relPath.slice(0, -(ext.length + 1)) : relPath;
    for (let i = 1; i < 1000; i += 1) {
      const candidate = `${stem} ${i}${ext ? `.${ext}` : ''}`;
      if (!this.files.has(candidate) && !fsSync.existsSync(this.abs(candidate))) return candidate;
    }
    return `${stem} ${Date.now()}${ext ? `.${ext}` : ''}`;
  }

  async createFolder(relPath: string): Promise<string> {
    const clean = normalizeVaultPath(relPath);
    await fs.mkdir(this.abs(clean), { recursive: true });
    await this.refreshFolders();
    this.emit('change', 'folder');
    return clean;
  }

  async delete(relPath: string, mode?: VaultSettings['trashOption']): Promise<void> {
    const clean = normalizeVaultPath(relPath);
    const how = mode ?? this.settingsData.trashOption;
    const abs = this.abs(clean);
    this.suppress();
    if (how === 'local') {
      const target = path.join(this.root, TRASH_DIR, clean);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rm(target, { recursive: true, force: true });
      await fs.rename(abs, target).catch(async () => {
        await fs.rm(abs, { recursive: true, force: true });
      });
    } else {
      await fs.rm(abs, { recursive: true, force: true });
    }
    this.forget(clean);
    await this.refreshFolders();
    this.emit('change', 'delete');
  }

  private forget(clean: string): void {
    const isFolder = !this.files.has(clean);
    if (isFolder) {
      for (const key of [...this.files.keys()]) {
        if (key === clean || key.startsWith(`${clean}/`)) {
          this.files.delete(key);
          this.contents.delete(key);
          this.metaCache.delete(key);
        }
      }
    } else {
      this.files.delete(clean);
      this.contents.delete(clean);
      this.metaCache.delete(clean);
    }
  }

  /**
   * Rename or move, rewriting every inbound link so nothing breaks — the single
   * most important thing a vault does for you.
   */
  async rename(from: string, to: string, updateLinks = true): Promise<RenameResult> {
    const src = normalizeVaultPath(from);
    const isFolder = !this.files.has(src);
    const dest = this.uniquePath(normalizeVaultPath(to));
    const absFrom = this.abs(src);
    const absTo = this.abs(dest);

    // The resolver as it stands *before* the move: inbound links still point at
    // the old path, and that is what we have to recognise.
    const previousIndex = buildResolver(this.allMeta(), [...this.files.values()]);

    this.suppress();
    await fs.mkdir(path.dirname(absTo), { recursive: true });
    await fs.rename(absFrom, absTo);

    const moves: { from: string; to: string }[] = [];
    if (isFolder) {
      for (const key of [...this.files.keys()]) {
        if (key === src || key.startsWith(`${src}/`)) {
          moves.push({ from: key, to: key.replace(src, dest) });
        }
      }
    } else {
      moves.push({ from: src, to: dest });
    }

    this.forget(src);
    for (const move of moves) await this.index(move.to);
    await this.refreshFolders();

    const updated: string[] = [];
    if (updateLinks && this.settingsData.alwaysUpdateLinks) {
      for (const move of moves) {
        updated.push(...(await this.rewriteLinks(previousIndex, move.from, move.to)));
      }
    }
    this.emit('change', 'rename');
    return { path: dest, updated: [...new Set(updated)] };
  }

  /**
   * Point every inbound link at the new location, keeping the shape the author
   * used: a bare `[[Name]]` stays bare, a `[[Folder/Name]]` keeps its folder,
   * and subpaths and aliases are left alone.
   */
  private async rewriteLinks(
    index: ResolverIndex,
    from: string,
    to: string,
  ): Promise<string[]> {
    const newName = vaultBasename(to);
    const newPath = isMarkdown(to) ? to.replace(/\.[^/.]+$/, '') : to;
    const touched: string[] = [];

    const pointsAtMoved = (target: string, notePath: string): boolean =>
      Boolean(target) && resolveLink(index, target, notePath) === from;

    for (const [notePath, content] of [...this.contents.entries()]) {
      if (notePath === to) continue;
      const meta = this.metaCache.get(notePath);
      if (!meta) continue;
      const relevant = [...meta.links, ...meta.embeds].some(
        (link) => !link.external && pointsAtMoved(link.target, notePath),
      );
      if (!relevant) continue;

      const next = content
        .replace(/(!?)\[\[([^\]\n]+)\]\]/g, (whole: string, bang: string, inner: string) => {
          const pipe = inner.indexOf('|');
          const alias = pipe === -1 ? '' : inner.slice(pipe);
          const head = pipe === -1 ? inner : inner.slice(0, pipe);
          const hash = head.indexOf('#');
          const sub = hash === -1 ? '' : head.slice(hash);
          const target = (hash === -1 ? head : head.slice(0, hash)).trim();
          if (!pointsAtMoved(target, notePath)) return whole;
          return `${bang}[[${target.includes('/') ? newPath : newName}${sub}${alias}]]`;
        })
        .replace(
          /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g,
          (whole: string, bang: string, text: string, href: string) => {
            if (/^[a-z][\w+.-]*:/i.test(href)) return whole;
            const [rawPath, ...rest] = href.split('#');
            const decoded = decodeURI(rawPath ?? '');
            const hash = rest.length ? `#${rest.join('#')}` : '';
            if (!pointsAtMoved(decoded, notePath)) return whole;
            const replacement = decoded.includes('/') ? to : (to.split('/').pop() ?? to);
            return `${bang}[${text}](${encodeURI(replacement)}${hash})`;
          },
        );

      if (next !== content) {
        await this.write(notePath, next);
        touched.push(notePath);
      }
    }
    return touched;
  }

  // --- notes ---------------------------------------------------------------

  /** Create a note from the "new note" command, honouring the configured folder. */
  async createNote(name: string, folder?: string, body = ''): Promise<string> {
    const clean = sanitizeFileName(name) || 'Untitled';
    const dir = folder ?? this.settingsData.newFileFolder;
    return this.create(joinPath(dir, `${clean}.md`), body);
  }

  /** Today's daily note, created from the template if it does not exist yet. */
  async dailyNote(date = new Date()): Promise<string> {
    const { dailyNoteFormat, dailyNoteFolder, dailyNoteTemplate } = this.settingsData;
    const name = formatDate(dailyNoteFormat || 'YYYY-MM-DD', date);
    const target = joinPath(dailyNoteFolder, `${name}.md`);
    if (this.files.has(target)) return target;
    let body = '';
    if (dailyNoteTemplate) {
      const template = await this.read(dailyNoteTemplate).catch(() => '');
      body = applyTemplate(template, { title: name, date });
    }
    await this.write(target, body);
    return target;
  }

  templates(): VaultFile[] {
    const folder = this.settingsData.templateFolder;
    if (!folder) return [];
    return [...this.files.values()].filter(
      (f) => isMarkdown(f.path) && (f.folder === folder || f.folder.startsWith(`${folder}/`)),
    );
  }

  async renderTemplate(templatePath: string, title: string): Promise<string> {
    const raw = await this.read(templatePath).catch(() => '');
    return applyTemplate(raw, { title });
  }

  /** Merge keys into a note's frontmatter without disturbing its body. */
  async setFrontmatter(
    relPath: string,
    patch: Record<string, FrontmatterValue | undefined>,
  ): Promise<void> {
    const content = await this.read(relPath);
    const { frontmatter, lines } = splitFrontmatter(content);
    const next: Record<string, FrontmatterValue> = { ...frontmatter };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    const body = lines ? content.split('\n').slice(lines).join('\n') : content;
    const head = Object.keys(next).length ? `---\n${stringifyYaml(next)}\n---\n` : '';
    await this.write(relPath, `${head}${body.replace(/^\n+/, '')}`);
  }

  // --- canvas --------------------------------------------------------------

  async readCanvas(relPath: string): Promise<CanvasData> {
    const raw = await this.read(relPath).catch(() => '');
    try {
      const data = JSON.parse(raw) as CanvasData;
      return { nodes: data.nodes ?? [], edges: data.edges ?? [] };
    } catch {
      return { nodes: [], edges: [] };
    }
  }

  /**
   * Notes that name this one without linking to it. Computed here rather than
   * in the UI because it has to read every note in the vault, and only this
   * side holds all of them in memory.
   */
  unlinkedMentions(relPath: string): { from: string; line: number; context: string }[] {
    const meta = this.metaCache.get(normalizeVaultPath(relPath));
    if (!meta) return [];
    const index = buildResolver(this.allMeta(), [...this.files.values()]);
    const linked = new Set<string>();
    for (const note of this.metaCache.values()) {
      for (const link of [...note.links, ...note.embeds]) {
        if (link.external) continue;
        if (resolveLink(index, link.target, note.path) === meta.path) linked.add(note.path);
      }
    }
    return unlinkedMentions(this.allMeta(), this.contents, meta, linked);
  }

  // --- search --------------------------------------------------------------

  search(query: string, options: SearchOptions = {}): VaultSearchHit[] {
    const parsed = parseQuery(query);
    if (!parsed.terms.length && !parsed.filters.length) return [];
    const limit = options.limit ?? 200;
    const hits: VaultSearchHit[] = [];

    for (const [notePath, content] of this.contents.entries()) {
      if (options.folder && !notePath.startsWith(`${options.folder}/`) && notePath !== options.folder) {
        continue;
      }
      const meta = this.metaCache.get(notePath);
      if (!meta) continue;
      if (!passesFilters(parsed.filters, notePath, meta, content)) continue;

      const matches: SearchMatch[] = [];
      let score = 0;
      let missing = false;

      for (const term of parsed.terms) {
        const found = findMatches(content, term, options);
        if (term.negated) {
          if (found.length) {
            missing = true;
            break;
          }
          continue;
        }
        if (!found.length) {
          missing = true;
          break;
        }
        score += found.length;
        matches.push(...found.slice(0, 8));
      }
      if (missing) continue;

      // Title hits are what people usually mean.
      const plainTerms = parsed.terms.filter((t) => !t.negated).map((t) => t.text.toLowerCase());
      if (plainTerms.some((t) => meta.title.toLowerCase().includes(t))) score += 40;
      if (plainTerms.some((t) => meta.basename.toLowerCase().includes(t))) score += 25;

      hits.push({
        path: notePath,
        title: meta.title,
        score,
        matches: matches.sort((a, b) => a.line - b.line).slice(0, 8),
        total: matches.length,
      });
    }

    return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
  }

  // --- settings ------------------------------------------------------------

  private configFile(name: string): string {
    return path.join(this.root, CONFIG_DIR, name);
  }

  private async loadSettings(): Promise<void> {
    await fs.mkdir(path.join(this.root, CONFIG_DIR), { recursive: true });
    try {
      const raw = await fs.readFile(this.configFile('app.json'), 'utf8');
      const saved = JSON.parse(raw) as Partial<VaultSettings>;
      this.settingsData = { ...defaultVaultSettings(), ...saved, graph: { ...defaultVaultSettings().graph, ...(saved.graph ?? {}) } };
    } catch {
      this.settingsData = defaultVaultSettings();
    }
    try {
      const raw = await fs.readFile(this.configFile('bookmarks.json'), 'utf8');
      this.bookmarksData = (JSON.parse(raw) as { items?: Bookmark[] }).items ?? [];
    } catch {
      this.bookmarksData = [];
    }
    await this.refreshFolders();
  }

  async updateSettings(patch: Partial<VaultSettings>): Promise<VaultSettings> {
    this.settingsData = {
      ...this.settingsData,
      ...patch,
      graph: { ...this.settingsData.graph, ...(patch.graph ?? {}) },
    };
    await fs.mkdir(path.join(this.root, CONFIG_DIR), { recursive: true });
    await fs.writeFile(
      this.configFile('app.json'),
      `${JSON.stringify(this.settingsData, null, 2)}\n`,
      'utf8',
    );
    this.emit('change', 'settings');
    return this.settingsData;
  }

  async setBookmarks(items: Bookmark[]): Promise<void> {
    this.bookmarksData = items;
    await fs.mkdir(path.join(this.root, CONFIG_DIR), { recursive: true });
    await fs.writeFile(
      this.configFile('bookmarks.json'),
      `${JSON.stringify({ items }, null, 2)}\n`,
      'utf8',
    );
    this.emit('change', 'bookmarks');
  }

  // --- external changes ----------------------------------------------------

  /**
   * Watch the folder so edits made in another editor show up here. Writes we
   * make ourselves are suppressed for a moment to avoid a rescan storm.
   */
  watch(): void {
    if (this.watcher) return;
    try {
      this.watcher = fsSync.watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const name = String(filename).replace(/\\/g, '/');
        if (name.startsWith(CONFIG_DIR) || name.startsWith(TRASH_DIR) || name.includes('/.')) return;
        if (Date.now() < this.suppressWatch) return;
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null;
          void this.scan();
        }, 250);
      });
    } catch {
      // Recursive watching is unsupported on some platforms; the app still works,
      // it just will not notice edits made outside it until the next open.
      this.watcher = null;
    }
  }

  private suppress(ms = 400): void {
    this.suppressWatch = Date.now() + ms;
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.watchTimer) clearTimeout(this.watchTimer);
  }
}

// ---------------------------------------------------------------------------
// Query parsing — the operators Obsidian's search bar accepts
// ---------------------------------------------------------------------------

interface QueryTerm {
  text: string;
  negated: boolean;
  regex?: RegExp;
  phrase?: boolean;
}

interface QueryFilter {
  key: 'tag' | 'path' | 'file' | 'section' | 'task' | 'line';
  value: string;
  negated: boolean;
}

export function parseQuery(query: string): { terms: QueryTerm[]; filters: QueryFilter[] } {
  const terms: QueryTerm[] = [];
  const filters: QueryFilter[] = [];
  const tokens = query.match(/-?\w+:"[^"]*"|-?\w+:\S+|-?"[^"]*"|-?\/(?:[^/\\]|\\.)+\/\w*|\S+/g) ?? [];

  for (const token of tokens) {
    const negated = token.startsWith('-');
    const body = negated ? token.slice(1) : token;
    const filterMatch = /^(tag|path|file|section|task|line):(.*)$/i.exec(body);
    if (filterMatch) {
      filters.push({
        key: filterMatch[1]!.toLowerCase() as QueryFilter['key'],
        value: filterMatch[2]!.replace(/^["']|["']$/g, '').replace(/^#/, ''),
        negated,
      });
      continue;
    }
    const regexMatch = /^\/((?:[^/\\]|\\.)+)\/(\w*)$/.exec(body);
    if (regexMatch) {
      try {
        terms.push({ text: regexMatch[1]!, negated, regex: new RegExp(regexMatch[1]!, `${regexMatch[2]}g`.replace('gg', 'g')) });
      } catch {
        terms.push({ text: body, negated });
      }
      continue;
    }
    if (/^".*"$/.test(body)) {
      terms.push({ text: body.slice(1, -1), negated, phrase: true });
      continue;
    }
    if (body.toUpperCase() === 'OR' || body.toUpperCase() === 'AND') continue;
    if (body) terms.push({ text: body, negated });
  }
  return { terms, filters };
}

function passesFilters(
  filters: QueryFilter[],
  notePath: string,
  meta: NoteMeta,
  content: string,
): boolean {
  for (const filter of filters) {
    let matched = false;
    const value = filter.value.toLowerCase();
    switch (filter.key) {
      case 'tag':
        matched = meta.tags.some((t) => t.toLowerCase() === value || t.toLowerCase().startsWith(`${value}/`));
        break;
      case 'path':
        matched = notePath.toLowerCase().includes(value);
        break;
      case 'file':
        matched = meta.basename.toLowerCase().includes(value);
        break;
      case 'section':
        matched = meta.headings.some((h) => h.text.toLowerCase().includes(value));
        break;
      case 'task':
        matched = value
          ? meta.tasks.some((t) => t.text.toLowerCase().includes(value))
          : meta.tasks.length > 0;
        break;
      case 'line':
        matched = content.split('\n').some((l) => l.toLowerCase().includes(value));
        break;
    }
    if (filter.negated ? matched : !matched) return false;
  }
  return true;
}

function findMatches(content: string, term: QueryTerm, options: SearchOptions): SearchMatch[] {
  const lines = content.split('\n');
  const out: SearchMatch[] = [];
  const needle = options.caseSensitive ? term.text : term.text.toLowerCase();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const haystack = options.caseSensitive ? line : line.toLowerCase();
    if (term.regex) {
      term.regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = term.regex.exec(line))) {
        out.push({ line: i, col: m.index, length: m[0].length, text: line.trim() });
        if (m[0].length === 0) break;
      }
      continue;
    }
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      if (options.wholeWord) {
        const before = haystack[at - 1];
        const after = haystack[at + needle.length];
        const isWord = (c: string | undefined) => c !== undefined && /[\w]/.test(c);
        if (isWord(before) || isWord(after)) {
          from = at + needle.length;
          continue;
        }
      }
      out.push({ line: i, col: at, length: needle.length, text: line.trim() });
      from = at + Math.max(1, needle.length);
    }
  }
  return out;
}
