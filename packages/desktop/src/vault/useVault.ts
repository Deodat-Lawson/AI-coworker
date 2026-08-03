/**
 * The renderer's view of the vault.
 *
 * The main process owns the files; this hook owns everything derived from them —
 * the link resolver, backlinks, tag counts — plus a content cache so opening a
 * note you were just looking at is instant. Writes are debounced the way an
 * autosaving editor needs, and flushed whenever a note is closed or the window
 * goes away, so nothing is ever left only in memory.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type BacklinkEntry,
  type NoteMeta,
  type ResolverIndex,
  type SearchHit,
  type VaultFile,
  type VaultSettings,
  buildBacklinks,
  buildResolver,
  isMarkdown,
  resolveLink,
  tagCounts,
} from '@ai-coworker/shared';

import { api, unwrap } from '../lib/api.js';

import type { VaultBookmark, VaultSearchOptions, VaultState } from '../../electron/ipc.js';

const SAVE_DELAY = 600;

export interface VaultController {
  ready: boolean;
  root: string;
  files: VaultFile[];
  markdownFiles: VaultFile[];
  meta: Record<string, NoteMeta>;
  folders: string[];
  settings: VaultSettings;
  bookmarks: VaultBookmark[];
  resolver: ResolverIndex;
  backlinks: Map<string, BacklinkEntry[]>;
  tags: Map<string, number>;
  /** Cached text, or null while it loads. Requesting triggers the load. */
  content(path: string): string | null;
  contents: Map<string, string>;
  read(path: string): Promise<string>;
  write(path: string, content: string): void;
  flush(): Promise<void>;
  create(path: string, content?: string): Promise<string>;
  createFolder(path: string): Promise<string>;
  rename(from: string, to: string): Promise<{ path: string; updated: string[] }>;
  remove(path: string): Promise<void>;
  search(query: string, options?: VaultSearchOptions): Promise<SearchHit[]>;
  saveSettings(patch: Partial<VaultSettings>): Promise<void>;
  saveBookmarks(items: VaultBookmark[]): Promise<void>;
  dailyNote(): Promise<string>;
  mentions(path: string): Promise<{ from: string; line: number; context: string }[]>;
  template(path: string, title: string): Promise<string>;
  saveAttachment(name: string, dataBase64: string): Promise<string>;
  reveal(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  exportNote(path: string, format: 'pdf' | 'html' | 'md', html?: string): Promise<string | null>;
  resolve(target: string, from: string): string | undefined;
  resourceUrl(path: string): string;
  /** True when a note has edits that have not reached disk yet. */
  dirty(path: string): boolean;
  /** Increments whenever cached text changes; views embedding other notes watch it. */
  contentVersion: number;
  refresh(): Promise<void>;
}

export function useVault(): VaultController {
  const [state, setState] = useState<VaultState | null>(null);
  const [, bump] = useState(0);
  /** Ticks when a file's cached text arrives or changes underneath us. */
  const [contentVersion, tickContent] = useState(0);
  /** The listener below needs the *current* snapshot, not the one it closed over. */
  const stateRef = useRef<VaultState | null>(null);
  const contentsRef = useRef(new Map<string, string>());
  const pendingRef = useRef(new Map<string, string>());
  const timersRef = useRef(new Map<string, number>());
  const loadingRef = useRef(new Set<string>());

  const apply = useCallback((next: VaultState) => {
    const cache = contentsRef.current;
    const previous = stateRef.current;

    // A file whose mtime moved is re-read in the background and the cache is
    // only replaced if the text genuinely differs. Dropping the entry instead
    // would make `content()` return null for a note that is open, unmounting
    // the editor mid-edit — and with it the caret, selection and undo history.
    // Our own autosaves land here too, and must be invisible.
    for (const file of next.files) {
      if (pendingRef.current.has(file.path)) continue;
      if (!cache.has(file.path)) continue;
      const before = previous?.files.find((f) => f.path === file.path);
      if (!before || before.mtime === file.mtime) continue;
      void api.vaultRead(file.path).then((result) => {
        if (!result.ok) return;
        if (pendingRef.current.has(file.path)) return;
        if (cache.get(file.path) === result.value) return;
        cache.set(file.path, result.value);
        tickContent((n) => n + 1);
      });
    }

    for (const path of [...cache.keys()]) {
      if (!next.files.some((f) => f.path === path)) cache.delete(path);
    }
    stateRef.current = next;
    setState(next);
  }, []);

  const refresh = useCallback(async () => {
    apply(await unwrap(api.vaultState()));
  }, [apply]);

  useEffect(() => {
    void refresh();
    return api.onVaultChange(apply);
  }, [apply, refresh]);

  const files = state?.files ?? [];
  const meta = state?.meta ?? {};

  const resolver = useMemo(() => buildResolver(meta, files), [meta, files]);
  const backlinks = useMemo(() => buildBacklinks(meta, resolver), [meta, resolver]);
  const tags = useMemo(() => tagCounts(meta), [meta]);
  const markdownFiles = useMemo(() => files.filter((f) => isMarkdown(f.path)), [files]);

  const read = useCallback(async (path: string): Promise<string> => {
    const pending = pendingRef.current.get(path);
    if (pending !== undefined) return pending;
    const cached = contentsRef.current.get(path);
    if (cached !== undefined) return cached;
    const text = await unwrap(api.vaultRead(path));
    contentsRef.current.set(path, text);
    return text;
  }, []);

  const content = useCallback(
    (path: string): string | null => {
      const pending = pendingRef.current.get(path);
      if (pending !== undefined) return pending;
      const cached = contentsRef.current.get(path);
      if (cached !== undefined) return cached;
      if (!loadingRef.current.has(path)) {
        loadingRef.current.add(path);
        void api
          .vaultRead(path)
          .then((result) => {
            if (result.ok) contentsRef.current.set(path, result.value);
            else contentsRef.current.set(path, '');
          })
          .finally(() => {
            loadingRef.current.delete(path);
            tickContent((n) => n + 1);
          });
      }
      return null;
    },
    [],
  );

  const flushPath = useCallback(async (path: string) => {
    const text = pendingRef.current.get(path);
    if (text === undefined) return;
    pendingRef.current.delete(path);
    const timer = timersRef.current.get(path);
    if (timer) {
      window.clearTimeout(timer);
      timersRef.current.delete(path);
    }
    contentsRef.current.set(path, text);
    await unwrap(api.vaultWrite(path, text));
  }, []);

  const write = useCallback(
    (path: string, text: string) => {
      pendingRef.current.set(path, text);
      contentsRef.current.set(path, text);
      const timer = timersRef.current.get(path);
      if (timer) window.clearTimeout(timer);
      timersRef.current.set(
        path,
        window.setTimeout(() => {
          void flushPath(path);
        }, SAVE_DELAY),
      );
      bump((n) => n + 1);
    },
    [flushPath],
  );

  const flush = useCallback(async () => {
    await Promise.all([...pendingRef.current.keys()].map((path) => flushPath(path)));
  }, [flushPath]);

  // Never lose the last few hundred milliseconds of typing on quit.
  useEffect(() => {
    const handler = () => {
      for (const [path, text] of pendingRef.current) void api.vaultWrite(path, text);
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const resolve = useCallback(
    (target: string, from: string) => resolveLink(resolver, target, from),
    [resolver],
  );

  return useMemo<VaultController>(
    () => ({
      ready: state !== null,
      root: state?.root ?? '',
      files,
      markdownFiles,
      meta,
      folders: state?.folders ?? [],
      settings: state?.settings ?? ({} as VaultSettings),
      bookmarks: state?.bookmarks ?? [],
      resolver,
      backlinks,
      tags,
      contents: contentsRef.current,
      content,
      read,
      write,
      flush,
      create: async (path, text) => {
        const created = await unwrap(api.vaultCreate(path, text ?? ''));
        contentsRef.current.set(created, text ?? '');
        await refresh();
        return created;
      },
      createFolder: async (path) => {
        const created = await unwrap(api.vaultCreateFolder(path));
        await refresh();
        return created;
      },
      rename: async (from, to) => {
        await flushPath(from);
        const result = await unwrap(api.vaultRename(from, to));
        const cached = contentsRef.current.get(from);
        contentsRef.current.delete(from);
        if (cached !== undefined) contentsRef.current.set(result.path, cached);
        for (const touched of result.updated) contentsRef.current.delete(touched);
        await refresh();
        return result;
      },
      remove: async (path) => {
        pendingRef.current.delete(path);
        contentsRef.current.delete(path);
        await unwrap(api.vaultDelete(path));
        await refresh();
      },
      search: async (query, options) => unwrap(api.vaultSearch(query, options)),
      saveSettings: async (patch) => {
        await unwrap(api.vaultSaveSettings(patch));
      },
      saveBookmarks: async (items) => {
        await unwrap(api.vaultSaveBookmarks(items));
      },
      dailyNote: async () => {
        const path = await unwrap(api.vaultDailyNote());
        await refresh();
        return path;
      },
      mentions: (path) => unwrap(api.vaultMentions(path)),
      template: (path, title) => unwrap(api.vaultTemplate(path, title)),
      saveAttachment: async (name, dataBase64) => {
        const path = await unwrap(api.vaultSaveAttachment(name, dataBase64));
        await refresh();
        return path;
      },
      reveal: async (path) => {
        await unwrap(api.vaultReveal(path));
      },
      openExternal: async (url) => {
        await unwrap(api.vaultOpenExternal(url));
      },
      exportNote: (path, format, html) => unwrap(api.vaultExport(path, format, html)),
      resolve,
      resourceUrl: (path) => `vault://file/${path.split('/').map(encodeURIComponent).join('/')}`,
      dirty: (path) => pendingRef.current.has(path),
      contentVersion,
      refresh,
    }),
    // Only the snapshot, the content counter, and the stable callbacks below
    // can change it — anything else would rebuild the editor on every render.
    [
      state,
      contentVersion,
      backlinks,
      content,
      files,
      markdownFiles,
      meta,
      read,
      refresh,
      resolve,
      resolver,
      tags,
      write,
      flush,
      flushPath,
    ],
  );
}
