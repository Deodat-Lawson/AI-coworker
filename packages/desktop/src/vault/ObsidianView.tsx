/**
 * The vault workspace: ribbon, sidebars, split panes with tabs, a status bar,
 * and the modals that sit over all of it.
 *
 * Everything the workspace can do is a command, so the palette, the hotkeys and
 * the menus are three faces of one list.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type FrontmatterValue,
  type VaultSearchHit,
  type VaultSettings,
  dirname,
  isMarkdown,
  sanitizeFileName,
  splitFrontmatter,
  stringifyYaml,
} from '@ai-coworker/shared';

import { Icon } from '../components/icons.js';
import CanvasView from './CanvasView.js';
import GraphView, { type GraphRecords, type RecordKind } from './GraphView.js';
import NoteView from './NoteView.js';
import {
  BacklinksPane,
  BookmarksPane,
  FileExplorer,
  OutlinePane,
  PropertiesPane,
  SearchPane,
  TagPane,
  type MenuItem,
} from './Panes.js';
import SettingsModal, { formatHotkey } from './SettingsModal.js';
import Suggester, { type SuggestItem } from './Suggester.js';
import { eventToBinding, resolveBinding, type Command } from './commands.js';
import { renderMarkdown } from './markdown.js';
import { useUi } from './ui.js';
import { useVault } from './useVault.js';

import type { EditorHandle, EditorMode } from './Editor.js';
import type { VaultBookmark } from '../../electron/ipc.js';

type TabKind = 'note' | 'graph' | 'canvas' | 'extra';

interface Tab {
  id: string;
  kind: TabKind;
  path?: string;
  extraId?: string;
  mode: EditorMode;
  history: { path: string; line?: number }[];
  index: number;
  gotoLine?: number;
}

interface Leaf {
  id: string;
  tabs: Tab[];
  activeId: string;
}

export interface ExtraView {
  id: string;
  label: string;
  icon: React.ReactNode;
  /** One line, in the ribbon's tooltip: what this is, for somebody who has not
   *  opened it yet. An icon can only ever be a reminder of a name. */
  hint?: string;
  render(): React.ReactNode;
}

interface Props {
  extraViews?: ExtraView[];
  /**
   * The structured records to draw in the graph beside the notes. Clicking one
   * opens the extra view whose id matches — `projects`, `artifacts`, `tasks` —
   * so the graph is a way in rather than a separate picture.
   */
  records?: GraphRecords;
}

let sequence = 0;
function uid(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

function newTab(patch: Partial<Tab> = {}): Tab {
  return {
    id: uid('tab'),
    kind: 'note',
    mode: 'live',
    history: [],
    index: -1,
    ...patch,
  };
}

export default function ObsidianView({ extraViews = [], records }: Props) {
  const vault = useVault();
  const ui = useUi();

  const [leaves, setLeaves] = useState<Leaf[]>(() => {
    const tab = newTab();
    return [{ id: uid('leaf'), tabs: [tab], activeId: tab.id }];
  });
  const [activeLeafId, setActiveLeafId] = useState<string>(() => '');
  const [splitDirection, setSplitDirection] = useState<'row' | 'column'>('row');

  const [leftPane, setLeftPane] = useState<'files' | 'search' | 'tags' | 'bookmarks'>('files');
  const [leftOpen, setLeftOpen] = useState(true);
  const [leftWidth, setLeftWidth] = useState(248);
  const [rightPane, setRightPane] = useState<'outline' | 'links' | 'properties' | 'graph'>('outline');
  const [rightOpen, setRightOpen] = useState(true);
  const [rightWidth, setRightWidth] = useState(280);

  const [query, setQuery] = useState('');
  const [searchOptions, setSearchOptions] = useState({ caseSensitive: false, wholeWord: false });
  const [results, setResults] = useState<VaultSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeTag, setActiveTag] = useState<string | null>(null);

  const [modal, setModal] = useState<'switcher' | 'palette' | 'headings' | 'tags' | 'settings' | null>(
    null,
  );
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [caretLine, setCaretLine] = useState(0);

  const editorRefs = useRef(new Map<string, React.RefObject<EditorHandle>>());
  const dragRef = useRef<{ side: 'left' | 'right'; startX: number; startWidth: number } | null>(null);

  const getEditorRef = useCallback((leafId: string) => {
    let ref = editorRefs.current.get(leafId);
    if (!ref) {
      ref = { current: null } as React.RefObject<EditorHandle>;
      editorRefs.current.set(leafId, ref);
    }
    return ref;
  }, []);

  const activeLeaf = leaves.find((l) => l.id === activeLeafId) ?? leaves[0]!;
  const activeTab = activeLeaf.tabs.find((t) => t.id === activeLeaf.activeId);
  const activePath = activeTab?.kind === 'note' || activeTab?.kind === 'canvas' ? activeTab.path ?? null : null;
  const activeMeta = activePath ? vault.meta[activePath] : undefined;
  const activeEditor = () => getEditorRef(activeLeaf.id).current;

  useEffect(() => {
    if (!activeLeafId && leaves[0]) setActiveLeafId(leaves[0].id);
  }, [activeLeafId, leaves]);

  // -- opening ---------------------------------------------------------------

  const updateLeaf = useCallback((leafId: string, patch: (leaf: Leaf) => Leaf) => {
    setLeaves((current) => current.map((leaf) => (leaf.id === leafId ? patch(leaf) : leaf)));
  }, []);

  const openPath = useCallback(
    (
      path: string,
      options: { newTab?: boolean; newLeaf?: boolean; line?: number; mode?: EditorMode } = {},
    ) => {
      const kind: TabKind = path.endsWith('.canvas') ? 'canvas' : 'note';
      const targetLeafId = options.newLeaf ? uid('leaf') : activeLeaf.id;

      if (options.newLeaf) {
        const tab = newTab({
          kind,
          path,
          mode: options.mode ?? (vault.settings.defaultViewMode || 'live'),
          history: [{ path }],
          index: 0,
          gotoLine: options.line,
        });
        setLeaves((current) => [...current, { id: targetLeafId, tabs: [tab], activeId: tab.id }]);
        setActiveLeafId(targetLeafId);
        return;
      }

      updateLeaf(activeLeaf.id, (leaf) => {
        const existing = leaf.tabs.find((t) => t.path === path);
        if (existing && !options.newTab) {
          return {
            ...leaf,
            activeId: existing.id,
            tabs: leaf.tabs.map((t) =>
              t.id === existing.id ? { ...t, gotoLine: options.line, mode: options.mode ?? t.mode } : t,
            ),
          };
        }
        const current = leaf.tabs.find((t) => t.id === leaf.activeId);
        if (!options.newTab && current && current.kind === 'note' && !current.path) {
          // Reuse the empty starter tab instead of stacking another one.
          return {
            ...leaf,
            tabs: leaf.tabs.map((t) =>
              t.id === current.id
                ? {
                    ...t,
                    kind,
                    path,
                    mode: options.mode ?? (vault.settings.defaultViewMode || 'live'),
                    history: [{ path }],
                    index: 0,
                    gotoLine: options.line,
                  }
                : t,
            ),
          };
        }
        if (!options.newTab && current) {
          const history = [...current.history.slice(0, current.index + 1), { path, line: options.line }];
          return {
            ...leaf,
            tabs: leaf.tabs.map((t) =>
              t.id === current.id
                ? { ...t, kind, path, history, index: history.length - 1, gotoLine: options.line }
                : t,
            ),
          };
        }
        const tab = newTab({
          kind,
          path,
          mode: options.mode ?? (vault.settings.defaultViewMode || 'live'),
          history: [{ path }],
          index: 0,
          gotoLine: options.line,
        });
        return { ...leaf, tabs: [...leaf.tabs, tab], activeId: tab.id };
      });
    },
    [activeLeaf.id, updateLeaf, vault.settings.defaultViewMode],
  );

  const openSpecial = useCallback(
    (kind: TabKind, extraId?: string) => {
      updateLeaf(activeLeaf.id, (leaf) => {
        const existing = leaf.tabs.find((t) => t.kind === kind && t.extraId === extraId);
        if (existing) return { ...leaf, activeId: existing.id };
        const tab = newTab({ kind, extraId });
        return { ...leaf, tabs: [...leaf.tabs, tab], activeId: tab.id };
      });
    },
    [activeLeaf.id, updateLeaf],
  );

  /** A record node in the graph goes to the list that record came from. */
  const openRecordList = useCallback(
    (kind: RecordKind) => openSpecial('extra', `${kind}s`),
    [openSpecial],
  );

  const closeTab = useCallback(
    (leafId: string, tabId: string) => {
      setLeaves((current) => {
        const next = current
          .map((leaf) => {
            if (leaf.id !== leafId) return leaf;
            const tabs = leaf.tabs.filter((t) => t.id !== tabId);
            if (tabs.length === 0) return { ...leaf, tabs, activeId: '' };
            const activeId = leaf.activeId === tabId ? tabs[tabs.length - 1]!.id : leaf.activeId;
            return { ...leaf, tabs, activeId };
          })
          .filter((leaf) => leaf.tabs.length > 0);
        if (next.length === 0) {
          const tab = newTab();
          return [{ id: uid('leaf'), tabs: [tab], activeId: tab.id }];
        }
        return next;
      });
    },
    [],
  );

  /** Follow a [[link]], creating the note when it does not exist yet. */
  const followLink = useCallback(
    async (target: string, subpath: string, resolved: string, newTab_: boolean) => {
      if (resolved) {
        let line: number | undefined;
        if (subpath) {
          const meta = vault.meta[resolved];
          if (subpath.startsWith('#^')) line = meta?.blocks[subpath.slice(2)];
          else {
            const wanted = subpath.slice(1).toLowerCase();
            line = meta?.headings.find((h) => h.text.toLowerCase() === wanted)?.line;
          }
        }
        openPath(resolved, { newTab: newTab_, line });
        return;
      }
      if (!target.trim()) return;
      const folder = vault.settings.newFileFolder;
      const name = sanitizeFileName(target);
      const created = await vault.create(
        [folder, `${name}.md`].filter(Boolean).join('/'),
        `# ${name}\n\n`,
      );
      openPath(created, { newTab: newTab_ });
    },
    [openPath, vault],
  );

  // -- search ----------------------------------------------------------------

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      void vault
        .search(query, searchOptions)
        .then(setResults)
        .finally(() => setSearching(false));
    }, 140);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, searchOptions.caseSensitive, searchOptions.wholeWord, vault.files.length]);

  // -- notes helpers ---------------------------------------------------------

  const createNote = useCallback(
    async (folder?: string, name?: string) => {
      const title = name ?? (await ui.prompt('New note', 'Untitled'));
      if (title === null) return;
      const clean = sanitizeFileName(title) || 'Untitled';
      const target = [folder ?? vault.settings.newFileFolder, `${clean}.md`].filter(Boolean).join('/');
      const created = await vault.create(target, '');
      openPath(created, { mode: 'live' });
      window.setTimeout(() => activeEditor()?.focus(), 80);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openPath, ui, vault],
  );

  const setProperty = useCallback(
    async (key: string, value: FrontmatterValue | undefined) => {
      if (!activePath) return;
      const text = await vault.read(activePath);
      const { frontmatter, lines } = splitFrontmatter(text);
      const next: Record<string, FrontmatterValue> = { ...frontmatter };
      if (value === undefined) delete next[key];
      else next[key] = value;
      const body = lines ? text.split('\n').slice(lines).join('\n') : text;
      const head = Object.keys(next).length ? `---\n${stringifyYaml(next)}\n---\n` : '';
      vault.write(activePath, `${head}${body.replace(/^\n+/, '')}`);
    },
    [activePath, vault],
  );

  const toggleBookmark = useCallback(async () => {
    if (!activePath) return;
    const existing = vault.bookmarks.find((b) => b.type === 'file' && b.path === activePath);
    const next = existing
      ? vault.bookmarks.filter((b) => b !== existing)
      : [
          ...vault.bookmarks,
          {
            type: 'file' as const,
            path: activePath,
            title: activeMeta?.title ?? activePath,
            ctime: Date.now(),
          },
        ];
    await vault.saveBookmarks(next);
    ui.notify(existing ? 'Bookmark removed' : 'Bookmarked');
  }, [activeMeta, activePath, ui, vault]);

  // -- commands --------------------------------------------------------------

  const commands = useMemo<Command[]>(() => {
    const editor = () => getEditorRef(activeLeaf.id).current;
    const list: Command[] = [
      { id: 'quick-switcher', name: 'Quick switcher: open note', hotkey: 'Mod+O', group: 'Navigate', run: () => setModal('switcher') },
      { id: 'command-palette', name: 'Open command palette', hotkey: 'Mod+P', group: 'Navigate', run: () => setModal('palette') },
      { id: 'search', name: 'Search in all notes', hotkey: 'Mod+Shift+F', group: 'Navigate', run: () => { setLeftOpen(true); setLeftPane('search'); } },
      { id: 'go-heading', name: 'Go to heading in this note', hotkey: 'Mod+Shift+O', group: 'Navigate', run: () => setModal('headings') },
      { id: 'go-tag', name: 'Jump to tag', group: 'Navigate', run: () => setModal('tags') },
      { id: 'new-note', name: 'Create new note', hotkey: 'Mod+N', group: 'Files', run: () => void createNote() },
      { id: 'new-canvas', name: 'Create new canvas', group: 'Files', run: () => void (async () => {
        const name = await ui.prompt('New canvas', 'Untitled');
        if (name === null) return;
        const created = await vault.create(`${sanitizeFileName(name) || 'Untitled'}.canvas`, '{"nodes":[],"edges":[]}\n');
        openPath(created);
      })() },
      { id: 'new-folder', name: 'Create new folder', group: 'Files', run: () => void (async () => {
        const name = await ui.prompt('New folder', '');
        if (name) await vault.createFolder(sanitizeFileName(name));
      })() },
      { id: 'daily-note', name: "Open today's daily note", hotkey: 'Mod+Shift+D', group: 'Files', run: () => void vault.dailyNote().then((path) => openPath(path)) },
      { id: 'insert-template', name: 'Insert template', hotkey: 'Mod+Alt+T', group: 'Files', run: () => void insertTemplate() },
      { id: 'rename', name: 'Rename this note', hotkey: 'F2', group: 'Files', run: () => void renameActive() },
      { id: 'delete-file', name: 'Delete this note', group: 'Files', run: () => void deleteActive() },
      { id: 'reveal', name: 'Show in system explorer', group: 'Files', run: () => { if (activePath) void vault.reveal(activePath); } },
      { id: 'export-pdf', name: 'Export to PDF', group: 'Files', run: () => void exportActive('pdf') },
      { id: 'export-html', name: 'Export to HTML', group: 'Files', run: () => void exportActive('html') },
      { id: 'copy-link', name: 'Copy link to this note', group: 'Files', run: () => {
        if (!activePath) return;
        void navigator.clipboard.writeText(`[[${activePath.replace(/\.md$/, '')}]]`);
        ui.notify('Link copied');
      } },
      { id: 'bookmark', name: 'Bookmark this note', hotkey: 'Mod+D', group: 'Files', run: () => void toggleBookmark() },

      { id: 'toggle-mode', name: 'Toggle live preview / reading view', hotkey: 'Mod+E', group: 'View', run: () => cycleMode() },
      { id: 'source-mode', name: 'View as source', group: 'View', run: () => setMode('source') },
      { id: 'reading-mode', name: 'View as reading', group: 'View', run: () => setMode('reading') },
      { id: 'graph', name: 'Open graph view', hotkey: 'Mod+G', group: 'View', run: () => openSpecial('graph') },
      { id: 'local-graph', name: 'Open local graph', group: 'View', run: () => { setRightOpen(true); setRightPane('graph'); } },
      { id: 'backlinks', name: 'Show backlinks', group: 'View', run: () => { setRightOpen(true); setRightPane('links'); } },
      { id: 'outline', name: 'Show outline', group: 'View', run: () => { setRightOpen(true); setRightPane('outline'); } },
      { id: 'properties', name: 'Show properties', group: 'View', run: () => { setRightOpen(true); setRightPane('properties'); } },
      { id: 'toggle-left', name: 'Toggle left sidebar', hotkey: 'Mod+Alt+ArrowLeft', group: 'View', run: () => setLeftOpen((v) => !v) },
      { id: 'toggle-right', name: 'Toggle right sidebar', hotkey: 'Mod+Alt+ArrowRight', group: 'View', run: () => setRightOpen((v) => !v) },
      { id: 'split-right', name: 'Split right', hotkey: 'Mod+\\', group: 'View', run: () => { setSplitDirection('row'); if (activePath) openPath(activePath, { newLeaf: true }); } },
      { id: 'split-down', name: 'Split down', hotkey: 'Mod+Shift+\\', group: 'View', run: () => { setSplitDirection('column'); if (activePath) openPath(activePath, { newLeaf: true }); } },
      { id: 'new-tab', name: 'New tab', hotkey: 'Mod+T', group: 'View', run: () => updateLeaf(activeLeaf.id, (leaf) => { const tab = newTab(); return { ...leaf, tabs: [...leaf.tabs, tab], activeId: tab.id }; }) },
      { id: 'close-tab', name: 'Close this tab', hotkey: 'Mod+W', group: 'View', run: () => { if (activeTab) closeTab(activeLeaf.id, activeTab.id); } },
      { id: 'back', name: 'Navigate back', hotkey: 'Mod+Alt+[', group: 'View', run: () => navigate(-1) },
      { id: 'forward', name: 'Navigate forward', hotkey: 'Mod+Alt+]', group: 'View', run: () => navigate(1) },
      { id: 'settings', name: 'Open settings', hotkey: 'Mod+,', group: 'View', run: () => setModal('settings') },

      { id: 'bold', name: 'Toggle bold', hotkey: 'Mod+B', group: 'Edit', run: () => editor()?.wrapSelection('**') },
      { id: 'italic', name: 'Toggle italic', hotkey: 'Mod+I', group: 'Edit', run: () => editor()?.wrapSelection('*') },
      { id: 'strikethrough', name: 'Toggle strikethrough', group: 'Edit', run: () => editor()?.wrapSelection('~~') },
      { id: 'highlight', name: 'Toggle highlight', hotkey: 'Mod+Shift+H', group: 'Edit', run: () => editor()?.wrapSelection('==') },
      { id: 'code', name: 'Toggle inline code', group: 'Edit', run: () => editor()?.wrapSelection('`') },
      { id: 'math', name: 'Insert math block', group: 'Edit', run: () => editor()?.insertAtCaret('$$\n\n$$', 3) },
      { id: 'quote', name: 'Toggle blockquote', group: 'Edit', run: () => editor()?.toggleLinePrefix('> ') },
      { id: 'bullet', name: 'Toggle bullet list', group: 'Edit', run: () => editor()?.toggleLinePrefix('- ', ['1. ', '> ']) },
      { id: 'numbered', name: 'Toggle numbered list', group: 'Edit', run: () => editor()?.toggleLinePrefix('1. ', ['- ', '> ']) },
      { id: 'checkbox', name: 'Toggle checkbox', hotkey: 'Mod+Enter', group: 'Edit', run: () => toggleCheckbox() },
      { id: 'table', name: 'Insert table', group: 'Edit', run: () => editor()?.insertAtCaret('\n| Column | Column |\n| --- | --- |\n|  |  |\n') },
      { id: 'callout', name: 'Insert callout', group: 'Edit', run: () => editor()?.insertAtCaret('> [!note] Title\n> \n', 18) },
      { id: 'code-block', name: 'Insert code block', group: 'Edit', run: () => editor()?.insertAtCaret('```\n\n```', 4) },
      { id: 'mermaid', name: 'Insert diagram (mermaid)', group: 'Edit', run: () => editor()?.insertAtCaret('```mermaid\ngraph TD\n  A[Start] --> B[End]\n```\n') },
      { id: 'link', name: 'Insert internal link', group: 'Edit', run: () => editor()?.insertAtCaret('[[]]', 2) },
      { id: 'undo', name: 'Undo', group: 'Edit', hidden: true, run: () => editor()?.undo() },
      { id: 'redo', name: 'Redo', group: 'Edit', hidden: true, run: () => editor()?.redo() },
    ];
    for (const heading of [1, 2, 3, 4, 5, 6]) {
      list.push({
        id: `heading-${heading}`,
        name: `Set heading ${heading}`,
        group: 'Edit',
        run: () => editor()?.toggleLinePrefix(`${'#'.repeat(heading)} `, ['# ', '## ', '### ', '#### ', '##### ', '###### ']),
      });
    }
    for (const view of extraViews) {
      list.push({
        id: `extra-${view.id}`,
        name: `Open ${view.label.toLowerCase()}`,
        group: 'Knowledge',
        run: () => openSpecial('extra', view.id),
      });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLeaf.id, activePath, activeTab, extraViews, openPath, openSpecial, toggleBookmark, vault]);

  function setMode(mode: EditorMode) {
    if (!activeTab) return;
    updateLeaf(activeLeaf.id, (leaf) => ({
      ...leaf,
      tabs: leaf.tabs.map((t) => (t.id === leaf.activeId ? { ...t, mode } : t)),
    }));
  }

  function cycleMode() {
    if (!activeTab) return;
    setMode(activeTab.mode === 'reading' ? 'live' : 'reading');
  }

  function navigate(direction: -1 | 1) {
    if (!activeTab) return;
    const index = activeTab.index + direction;
    const entry = activeTab.history[index];
    if (!entry) return;
    updateLeaf(activeLeaf.id, (leaf) => ({
      ...leaf,
      tabs: leaf.tabs.map((t) =>
        t.id === leaf.activeId ? { ...t, index, path: entry.path, gotoLine: entry.line } : t,
      ),
    }));
  }

  function toggleCheckbox() {
    const editor = activeEditor();
    if (!editor) return;
    const text = editor.getValue();
    const { from } = editor.getSelection();
    const start = text.lastIndexOf('\n', from - 1) + 1;
    const endIndex = text.indexOf('\n', from);
    const end = endIndex === -1 ? text.length : endIndex;
    const line = text.slice(start, end);
    let next: string;
    if (/^\s*[-*+]\s+\[[ xX/-]\]/.test(line)) {
      next = /\[ \]/.test(line) ? line.replace('[ ]', '[x]') : line.replace(/\[.\]/, '[ ]');
    } else if (/^\s*[-*+]\s+/.test(line)) {
      next = line.replace(/^(\s*[-*+]\s+)/, '$1[ ] ');
    } else {
      next = line.replace(/^(\s*)/, '$1- [ ] ');
    }
    editor.replaceRange(start, end, next, start + next.length);
  }

  async function renameActive() {
    if (!activePath) return;
    const current = activePath.split('/').pop()!;
    const name = await ui.prompt('Rename note', current.replace(/\.md$/, ''));
    if (!name) return;
    const extension = current.includes('.') ? current.slice(current.lastIndexOf('.')) : '.md';
    const target = [dirname(activePath), `${sanitizeFileName(name)}${extension}`]
      .filter(Boolean)
      .join('/');
    const result = await vault.rename(activePath, target);
    setLeaves((current_) =>
      current_.map((leaf) => ({
        ...leaf,
        tabs: leaf.tabs.map((t) => (t.path === activePath ? { ...t, path: result.path } : t)),
      })),
    );
    if (result.updated.length) {
      ui.notify(`Updated links in ${result.updated.length} note${result.updated.length === 1 ? '' : 's'}`);
    }
  }

  async function deleteActive() {
    if (!activePath) return;
    const yes =
      !vault.settings.confirmDelete ||
      (await ui.confirm(`Delete "${activePath.split('/').pop()}"?`, {
        confirmLabel: 'Delete',
        danger: true,
      }));
    if (!yes) return;
    const path = activePath;
    await vault.remove(path);
    setLeaves((current) =>
      current
        .map((leaf) => {
          const tabs = leaf.tabs.filter((t) => t.path !== path);
          return { ...leaf, tabs, activeId: tabs.some((t) => t.id === leaf.activeId) ? leaf.activeId : (tabs[tabs.length - 1]?.id ?? '') };
        })
        .filter((leaf) => leaf.tabs.length > 0),
    );
  }

  async function exportActive(format: 'pdf' | 'html') {
    if (!activePath) return;
    const text = await vault.read(activePath);
    const html = renderMarkdown(text, {
      sourcePath: activePath,
      resolve: (target, from) => vault.resolve(target, from),
      resourceUrl: (p) => vault.resourceUrl(p),
      readFile: (p) => vault.contents.get(p) ?? null,
    });
    const written = await vault.exportNote(activePath, format, html);
    if (written) ui.notify(`Exported to ${written}`);
  }

  async function insertTemplate() {
    const folder = vault.settings.templateFolder;
    const templates = vault.markdownFiles.filter(
      (f) => folder && (f.folder === folder || f.folder.startsWith(`${folder}/`)),
    );
    if (!templates.length) {
      ui.notify(`No templates in "${folder || 'the template folder'}"`);
      return;
    }
    const name = await ui.prompt(
      'Insert template',
      templates[0]!.basename,
      { message: templates.map((t) => t.basename).join(', ') },
    );
    if (!name) return;
    const chosen = templates.find((t) => t.basename.toLowerCase() === name.toLowerCase());
    if (!chosen) {
      ui.notify(`No template called "${name}"`);
      return;
    }
    const title = activePath?.split('/').pop()?.replace(/\.md$/, '') ?? 'Untitled';
    const body = await vault.template(chosen.path, title);
    activeEditor()?.insertAtCaret(body);
  }

  // -- hotkeys ---------------------------------------------------------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (menu) setMenu(null);
        return;
      }
      const binding = eventToBinding(event);
      if (!binding) return;
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
      // While typing, an unmodified *character* is text, not a shortcut; named
      // keys like F2 stay live.
      if (typing && !binding.includes('+') && binding.length === 1) return;
      const command = commands.find((c) => resolveBinding(c, vault.settings.hotkeys) === binding);
      if (!command) return;
      // The editor owns its own formatting shortcuts while it has focus.
      if (typing && ['bold', 'italic', 'highlight', 'undo', 'redo'].includes(command.id)) return;
      event.preventDefault();
      command.run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commands, menu, vault.settings.hotkeys]);

  // -- theme -----------------------------------------------------------------

  // Read by the mirror effect below without being one of its dependencies.
  const vaultRef = useRef(vault);
  vaultRef.current = vault;

  // What the shell has resolved the appearance to. Watched rather than read
  // once, because "match system" can flip while the app is open.
  const [appTheme, setAppTheme] = useState<'dark' | 'light'>(() =>
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  );
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setAppTheme(root.dataset.theme === 'light' ? 'light' : 'dark');
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  /**
   * The vault draws from the app's theme tokens, so nothing has to be stamped
   * for it to follow — flipping the app flips the Knowledge tab with it, in the
   * same shades, because they are literally the same values.
   *
   * What is still worth doing is keeping `.obsidian/app.json` truthful: the
   * folder is a real Obsidian vault, and Obsidian opened on the same folder
   * reads that key.
   *
   * This fires on a *change* of theme and on nothing else, including not on
   * mount. Writing the file touches the vault, the watcher reloads the tree,
   * and anything with a file open loses its place — so doing it as the tab
   * opens would mean every visit to Knowledge jolted the editor to correct a
   * key nobody was looking at. A stale value in the file costs nothing until
   * somebody actually flips the theme, which is when this catches it up.
   */
  const mirroredTheme = useRef<string | null>(appTheme);
  useEffect(() => {
    if (mirroredTheme.current === appTheme) return;
    mirroredTheme.current = appTheme;
    if (vaultRef.current.settings.theme !== appTheme) {
      void vaultRef.current.saveSettings({ theme: appTheme });
    }
  }, [appTheme]);

  // The accent is the one thing that is still the vault's own — kept in a
  // variable of its own so leaving the tab does not leave a colour behind.
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.getPropertyValue('--vault-accent');
    if (vault.settings.accentColor) {
      root.style.setProperty('--vault-accent', vault.settings.accentColor);
    }
    return () => {
      if (previous) root.style.setProperty('--vault-accent', previous);
      else root.style.removeProperty('--vault-accent');
    };
  }, [vault.settings.accentColor]);

  // -- sidebar resizing ------------------------------------------------------

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const delta = event.clientX - drag.startX;
      if (drag.side === 'left') setLeftWidth(Math.min(520, Math.max(180, drag.startWidth + delta)));
      else setRightWidth(Math.min(560, Math.max(200, drag.startWidth - delta)));
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // -- derived ---------------------------------------------------------------

  const backlinks = activePath ? (vault.backlinks.get(activePath) ?? []) : [];
  const [mentions, setMentions] = useState<{ from: string; line: number; context: string }[]>([]);

  // Unlinked mentions have to read every note, so they are computed where all
  // the text already lives rather than from whatever the UI happens to have
  // cached.
  useEffect(() => {
    if (!activePath || rightPane !== 'links' || !rightOpen) {
      // Keep the identity when it is already empty; a fresh [] here would
      // re-trigger this effect and spin.
      setMentions((previous) => (previous.length ? [] : previous));
      return;
    }
    let live = true;
    void vault.mentions(activePath).then((found) => {
      if (live) setMentions(found);
    });
    return () => {
      live = false;
    };
  }, [activePath, rightOpen, rightPane, vault.files, vault.mentions]);

  const titleOf = useCallback(
    (path: string) => vault.meta[path]?.title ?? path.split('/').pop()?.replace(/\.md$/, '') ?? path,
    [vault.meta],
  );

  const switcherItems = useMemo<SuggestItem[]>(
    () =>
      vault.files.map((file) => ({
        id: file.path,
        label: vault.meta[file.path]?.title ?? file.basename,
        detail: file.folder || undefined,
        haystack: `${file.path} ${(vault.meta[file.path]?.aliases ?? []).join(' ')}`,
        run: () => openPath(file.path),
      })),
    [openPath, vault.files, vault.meta],
  );

  const paletteItems = useMemo<SuggestItem[]>(
    () =>
      commands
        .filter((command) => !command.hidden)
        .map((command) => ({
          id: command.id,
          label: command.name,
          group: command.group,
          aside: formatHotkey(resolveBinding(command, vault.settings.hotkeys) ?? ''),
          run: command.run,
        })),
    [commands, vault.settings.hotkeys],
  );

  if (!vault.ready) {
    return <div className="ob-loading">Opening your vault…</div>;
  }

  const showRibbon = vault.settings.showRibbon !== false;

  return (
    <div className="ob" onClick={() => menu && setMenu(null)}>
      {showRibbon ? (
        <div className="ob-ribbon">
          <RibbonButton label="New note" hint="A blank markdown file in your vault" hotkey="⌘N" onClick={() => void createNote()}>
            <Icon name="note-plus" />
          </RibbonButton>
          <RibbonButton
            label="Search"
            hint="Find text across every note"
            hotkey="⌘⇧F"
            active={leftOpen && leftPane === 'search'}
            onClick={() => { setLeftOpen(true); setLeftPane('search'); }}
          >
            <Icon name="search" />
          </RibbonButton>
          <RibbonButton label="Go to note" hint="Jump to a note by name" hotkey="⌘O" onClick={() => setModal('switcher')}>
            <Icon name="switch" />
          </RibbonButton>
          <RibbonButton
            label="Graph"
            hint="Your notes as the links between them"
            hotkey="⌘G"
            active={activeTab?.kind === 'graph'}
            onClick={() => openSpecial('graph')}
          >
            <Icon name="graph" />
          </RibbonButton>
          <RibbonButton label="Today's note" hint="One note per day, created on demand" hotkey="⌘⇧D" onClick={() => void vault.dailyNote().then((p) => openPath(p))}>
            <Icon name="calendar" />
          </RibbonButton>
          <RibbonButton label="Command palette" hint="Everything this workspace can do" hotkey="⌘P" onClick={() => setModal('palette')}>
            <Icon name="command" />
          </RibbonButton>

          {extraViews.length ? <div className="ob-ribbon-rule" /> : null}
          {extraViews.map((view) => (
            <RibbonButton
              key={view.id}
              label={view.label}
              hint={view.hint}
              active={activeTab?.kind === 'extra' && activeTab.extraId === view.id}
              onClick={() => openSpecial('extra', view.id)}
            >
              {view.icon}
            </RibbonButton>
          ))}

          <div className="ob-ribbon-spacer" />
          <RibbonButton label="Vault settings" hotkey="⌘," onClick={() => setModal('settings')}>
            <Icon name="settings" />
          </RibbonButton>
        </div>
      ) : null}

      {leftOpen ? (
        <div className="ob-side is-left" style={{ width: leftWidth }}>
          <div className="side-tabs">
            {(['files', 'search', 'tags', 'bookmarks'] as const).map((pane) => (
              <button
                key={pane}
                className={`side-tab${leftPane === pane ? ' is-active' : ''}`}
                onClick={() => setLeftPane(pane)}
                type="button"
              >
                {pane === 'files' ? 'Files' : pane === 'search' ? 'Search' : pane === 'tags' ? 'Tags' : 'Bookmarks'}
              </button>
            ))}
          </div>
          {leftPane === 'files' ? (
            <FileExplorer
              vault={vault}
              activePath={activePath}
              onOpen={(path, newTab_) => openPath(path, { newTab: newTab_ })}
              onMenu={(event, items) => {
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY, items });
              }}
              onNewNote={(folder) => void createNote(folder)}
              onNewFolder={(folder) => {
                void (async () => {
                  const name = await ui.prompt('New folder', '');
                  if (name) await vault.createFolder([folder, sanitizeFileName(name)].filter(Boolean).join('/'));
                })();
              }}
            />
          ) : null}
          {leftPane === 'search' ? (
            <SearchPane
              query={query}
              onQuery={setQuery}
              results={results}
              running={searching}
              options={searchOptions}
              onOptions={(patch) => setSearchOptions((o) => ({ ...o, ...patch }))}
              onOpen={(path, line) => openPath(path, { line })}
              onBookmark={() => {
                if (!query.trim()) return;
                void vault.saveBookmarks([
                  ...vault.bookmarks,
                  { type: 'search', query, title: query, ctime: Date.now() },
                ]);
                ui.notify('Search bookmarked');
              }}
            />
          ) : null}
          {leftPane === 'tags' ? (
            <TagPane
              tags={vault.tags}
              active={activeTag}
              onSelect={(tag) => {
                setActiveTag(tag);
                setQuery(`tag:#${tag}`);
                setLeftPane('search');
              }}
            />
          ) : null}
          {leftPane === 'bookmarks' ? (
            <BookmarksPane
              bookmarks={vault.bookmarks}
              onOpen={(bookmark) => {
                if (bookmark.type === 'search' && bookmark.query) {
                  setQuery(bookmark.query);
                  setLeftPane('search');
                } else if (bookmark.path) {
                  openPath(bookmark.path);
                }
              }}
              onRemove={(bookmark) => {
                void vault.saveBookmarks(vault.bookmarks.filter((b) => b !== bookmark));
              }}
            />
          ) : null}
          <div
            className="ob-resizer"
            onMouseDown={(event) =>
              (dragRef.current = { side: 'left', startX: event.clientX, startWidth: leftWidth })
            }
          />
        </div>
      ) : null}

      <div className={`ob-main is-${splitDirection}`}>
        {leaves.map((leaf) => (
          <div
            key={leaf.id}
            className={`ob-leaf${leaf.id === activeLeaf.id ? ' is-active' : ''}`}
            onMouseDown={() => setActiveLeafId(leaf.id)}
          >
            <div className="tab-bar">
              <div className="tab-nav">
                <button className="ghost" onClick={() => navigate(-1)} title="Back" type="button">
                  ‹
                </button>
                <button className="ghost" onClick={() => navigate(1)} title="Forward" type="button">
                  ›
                </button>
              </div>
              <div className="tab-list">
                {leaf.tabs.map((tab) => (
                  <div
                    key={tab.id}
                    className={`tab${tab.id === leaf.activeId ? ' is-active' : ''}`}
                    onClick={() => updateLeaf(leaf.id, (l) => ({ ...l, activeId: tab.id }))}
                    onAuxClick={(event) => {
                      if (event.button === 1) closeTab(leaf.id, tab.id);
                    }}
                  >
                    <span className="tab-title">{tabTitle(tab, titleOf, extraViews)}</span>
                    {tab.path && vault.dirty(tab.path) ? <span className="tab-dot" /> : null}
                    <button
                      className="tab-close"
                      onClick={(event) => {
                        event.stopPropagation();
                        closeTab(leaf.id, tab.id);
                      }}
                      type="button"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  className="tab-add"
                  onClick={() =>
                    updateLeaf(leaf.id, (l) => {
                      const tab = newTab();
                      return { ...l, tabs: [...l.tabs, tab], activeId: tab.id };
                    })
                  }
                  type="button"
                  title="New tab (⌘T)"
                >
                  ＋
                </button>
              </div>
              <div className="tab-actions">
                {/* An empty tab is still a note tab, and it has no reading view
                    to toggle and nothing to rename — so it gets no controls. */}
                {(() => {
                  const tab = leaf.tabs.find((t) => t.id === leaf.activeId);
                  return tab?.kind === 'note' && tab.path;
                })() ? (
                  <>
                    <button
                      className="ghost"
                      onClick={() => cycleMode()}
                      title="Toggle reading view (⌘E)"
                      type="button"
                    >
                      {leaf.tabs.find((t) => t.id === leaf.activeId)?.mode === 'reading' ? (
                        <Icon name="edit" size={15} />
                      ) : (
                        <Icon name="eye" size={15} />
                      )}
                    </button>
                    <button
                      className="ghost"
                      title="More"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setMenu({
                          x: event.clientX - 180,
                          y: event.clientY + 8,
                          items: [
                            { label: 'Source mode', action: () => setMode('source') },
                            { label: 'Live preview', action: () => setMode('live') },
                            { label: 'Reading view', action: () => setMode('reading') },
                            { separator: true, label: '' },
                            { label: 'Rename…', action: () => void renameActive() },
                            { label: 'Export to PDF…', action: () => void exportActive('pdf') },
                            { label: 'Export to HTML…', action: () => void exportActive('html') },
                            { label: 'Show in system explorer', action: () => activePath && void vault.reveal(activePath) },
                            { separator: true, label: '' },
                            { label: 'Delete note', danger: true, action: () => void deleteActive() },
                          ],
                        });
                      }}
                    >
                      <Icon name="more" size={15} />
                    </button>
                  </>
                ) : null}
              </div>
            </div>

            <div className="leaf-body">
              {(() => {
                const tab = leaf.tabs.find((t) => t.id === leaf.activeId);
                if (!tab) return <div className="empty">Nothing open.</div>;
                if (tab.kind === 'graph') {
                  return (
                    <GraphView
                      meta={vault.meta}
                      files={vault.files}
                      resolver={vault.resolver}
                      settings={vault.settings.graph}
                      accent={vault.settings.accentColor}
                      onSettings={(patch) =>
                        void vault.saveSettings({ graph: { ...vault.settings.graph, ...patch } })
                      }
                      onOpen={(path, newTab_) => openPath(path, { newTab: newTab_ })}
                      records={records}
                      onOpenRecord={openRecordList}
                    />
                  );
                }
                if (tab.kind === 'extra') {
                  const view = extraViews.find((v) => v.id === tab.extraId);
                  return <div className="extra-view">{view?.render() ?? null}</div>;
                }
                if (!tab.path) {
                  const recent = vault.markdownFiles
                    .slice()
                    .sort((a, b) => b.mtime - a.mtime)
                    .slice(0, 6);
                  return (
                    <div className="leaf-empty">
                      <div className="leaf-empty-title">
                        {vault.markdownFiles.length} notes in this vault
                      </div>
                      <p className="leaf-empty-sub">
                        Write in markdown, link with <code>[[double brackets]]</code>, and the graph
                        draws itself from the links.
                      </p>
                      <div className="leaf-empty-actions">
                        <button className="primary" onClick={() => void createNote()} type="button">
                          New note
                        </button>
                        <button onClick={() => setModal('switcher')} type="button">
                          Go to note
                        </button>
                        <button onClick={() => openSpecial('graph')} type="button">
                          Open graph
                        </button>
                      </div>
                      {recent.length ? (
                        <div className="leaf-empty-recent">
                          <div className="leaf-empty-recent-head">Recently edited</div>
                          {recent.map((file) => (
                            <button key={file.path} onClick={() => openPath(file.path)} type="button">
                              <span className="leaf-recent-title">{titleOf(file.path)}</span>
                              {file.folder ? (
                                <span className="leaf-recent-where">{file.folder}</span>
                              ) : null}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                }
                if (tab.kind === 'canvas') {
                  return (
                    <CanvasView
                      path={tab.path}
                      raw={vault.content(tab.path)}
                      ctx={{
                        sourcePath: tab.path,
                        resolve: (target, from) => vault.resolve(target, from || tab.path!),
                        resourceUrl: (p) => vault.resourceUrl(p),
                        readFile: (p) => vault.content(p),
                      }}
                      onSave={(text) => vault.write(tab.path!, text)}
                      onOpenFile={(path, newTab_) => openPath(path, { newTab: newTab_ })}
                      resolve={(target, from) => vault.resolve(target, from)}
                      fileOptions={vault.markdownFiles.map((f) => ({ path: f.path, label: f.basename }))}
                    />
                  );
                }
                return (
                  <NoteView
                    key={tab.path}
                    vault={vault}
                    path={tab.path}
                    mode={tab.mode}
                    editorRef={getEditorRef(leaf.id)}
                    gotoLine={tab.gotoLine}
                    onOpenLink={(target, subpath, resolved, newTab_) =>
                      void followLink(target, subpath, resolved, newTab_)
                    }
                    onTagClick={(tag) => {
                      setActiveTag(tag);
                      setQuery(`tag:#${tag}`);
                      setLeftPane('search');
                      setLeftOpen(true);
                    }}
                    onCaret={setCaretLine}
                  />
                );
              })()}
            </div>
          </div>
        ))}
      </div>

      {rightOpen ? (
        <div className="ob-side is-right" style={{ width: rightWidth }}>
          <div
            className="ob-resizer is-left-edge"
            onMouseDown={(event) =>
              (dragRef.current = { side: 'right', startX: event.clientX, startWidth: rightWidth })
            }
          />
          <div className="side-tabs">
            {(['outline', 'links', 'properties', 'graph'] as const).map((pane) => (
              <button
                key={pane}
                className={`side-tab${rightPane === pane ? ' is-active' : ''}`}
                onClick={() => setRightPane(pane)}
                type="button"
              >
                {pane === 'graph' ? 'Local' : pane[0]!.toUpperCase() + pane.slice(1)}
              </button>
            ))}
          </div>
          {rightPane === 'outline' ? (
            <OutlinePane
              meta={activeMeta}
              onGo={(line) => activeEditor()?.scrollToLine(line, true)}
            />
          ) : null}
          {rightPane === 'links' ? (
            <BacklinksPane
              path={activePath}
              meta={vault.meta}
              backlinks={backlinks}
              mentions={mentions}
              titleOf={titleOf}
              onOpen={(path, line) => {
                const resolved = vault.meta[path] ? path : vault.resolve(path, activePath ?? '');
                if (resolved) openPath(resolved, { line });
              }}
              onLink={(from, line) => {
                void (async () => {
                  if (!activeMeta) return;
                  const text = await vault.read(from);
                  const lines = text.split('\n');
                  const name = activeMeta.basename;
                  const pattern = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
                  lines[line] = lines[line]!.replace(pattern, (m) => `[[${m}]]`);
                  vault.write(from, lines.join('\n'));
                  ui.notify('Mention linked');
                })();
              }}
            />
          ) : null}
          {rightPane === 'properties' ? (
            <PropertiesPane meta={activeMeta} onChange={(key, value) => void setProperty(key, value)} />
          ) : null}
          {rightPane === 'graph' ? (
            <div className="pane">
              <div className="pane-head">
                <span>Local graph</span>
              </div>
              <div className="pane-body no-pad">
                {activePath ? (
                  <GraphView
                    meta={vault.meta}
                    files={vault.files}
                    resolver={vault.resolver}
                    settings={vault.settings.graph}
                    accent={vault.settings.accentColor}
                    onSettings={(patch) =>
                      void vault.saveSettings({ graph: { ...vault.settings.graph, ...patch } })
                    }
                    onOpen={(path, newTab_) => openPath(path, { newTab: newTab_ })}
                    records={records}
                    onOpenRecord={openRecordList}
                    focus={activePath}
                    depth={2}
                    compact
                  />
                ) : (
                  <div className="empty">Open a note.</div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="ob-status">
        <button className="ghost" onClick={() => setLeftOpen((v) => !v)} type="button" title="Toggle left sidebar">
          ⇤
        </button>
        <span className="status-item">{vault.markdownFiles.length} notes</span>
        {activeMeta ? (
          <>
            <span className="status-item">{activeMeta.words} words</span>
            <span className="status-item">{activeMeta.chars} characters</span>
            <span className="status-item">line {caretLine + 1}</span>
            <span className="status-item">{backlinks.length} backlinks</span>
          </>
        ) : null}
        {activePath && vault.dirty(activePath) ? <span className="status-item is-dim">saving…</span> : null}
        <span className="status-spacer" />
        <span className="status-item is-dim" title={vault.root}>
          {vault.root.split('/').slice(-2).join('/')}
        </span>
        <button className="ghost" onClick={() => setRightOpen((v) => !v)} type="button" title="Toggle right sidebar">
          ⇥
        </button>
      </div>

      {modal === 'switcher' ? (
        <Suggester
          placeholder="Find or create a note…"
          items={switcherItems}
          fallback={(text) => ({
            id: `create:${text}`,
            label: `Create "${text}"`,
            detail: 'new note',
            run: () => void createNote(undefined, text),
          })}
          onClose={() => setModal(null)}
        />
      ) : null}

      {modal === 'palette' ? (
        <Suggester placeholder="Run a command…" items={paletteItems} onClose={() => setModal(null)} />
      ) : null}

      {modal === 'headings' ? (
        <Suggester
          placeholder="Go to heading…"
          items={(activeMeta?.headings ?? []).map((heading) => ({
            id: `${heading.line}`,
            label: heading.text,
            detail: '#'.repeat(heading.level),
            run: () => activeEditor()?.scrollToLine(heading.line, true),
          }))}
          emptyText="This note has no headings."
          onClose={() => setModal(null)}
        />
      ) : null}

      {modal === 'tags' ? (
        <Suggester
          placeholder="Jump to tag…"
          items={[...vault.tags.entries()].map(([tag, count]) => ({
            id: tag,
            label: `#${tag}`,
            aside: String(count),
            run: () => {
              setQuery(`tag:#${tag}`);
              setLeftPane('search');
              setLeftOpen(true);
            },
          }))}
          onClose={() => setModal(null)}
        />
      ) : null}

      {modal === 'settings' ? (
        <SettingsModal
          settings={vault.settings}
          folders={vault.folders}
          templates={vault.markdownFiles
            .filter(
              (f) =>
                vault.settings.templateFolder &&
                (f.folder === vault.settings.templateFolder ||
                  f.folder.startsWith(`${vault.settings.templateFolder}/`)),
            )
            .map((f) => f.path)}
          commands={commands.filter((c) => !c.hidden)}
          vaultRoot={vault.root}
          onChange={(patch: Partial<VaultSettings>) => void vault.saveSettings(patch)}
          onClose={() => setModal(null)}
        />
      ) : null}

      {menu ? (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          {menu.items.map((item, index) =>
            item.separator ? (
              <div className="context-separator" key={`sep-${index}`} />
            ) : (
              <button
                key={item.label}
                className={`context-item${item.danger ? ' is-danger' : ''}`}
                onClick={() => {
                  setMenu(null);
                  item.action?.();
                }}
                type="button"
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function tabTitle(
  tab: Tab,
  titleOf: (path: string) => string,
  extraViews: ExtraView[],
): string {
  if (tab.kind === 'graph') return 'Graph';
  if (tab.kind === 'extra') return extraViews.find((v) => v.id === tab.extraId)?.label ?? 'View';
  if (!tab.path) return 'New tab';
  if (tab.kind === 'canvas') return tab.path.split('/').pop()!.replace(/\.canvas$/, '');
  return isMarkdown(tab.path) ? titleOf(tab.path) : tab.path.split('/').pop()!;
}

/**
 * One icon in the ribbon, with its name attached.
 *
 * The name is not a `title` attribute. A native tooltip arrives a second and a
 * half after the pointer stops, which is long after somebody has given up
 * guessing what "◈" meant — so the label is drawn beside the button the moment
 * it is hovered, along with the shortcut and, where one helps, a line saying
 * what the thing actually is.
 */
function RibbonButton({
  label,
  hint,
  hotkey,
  active,
  onClick,
  children,
}: {
  label: string;
  hint?: string;
  hotkey?: string;
  active?: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`ribbon-button${active ? ' is-active' : ''}`}
      onClick={onClick}
      type="button"
      aria-label={label}
      aria-pressed={active}
    >
      {children}
      <span className="ribbon-tip">
        <span className="ribbon-tip-name">
          {label}
          {hint ? <span className="ribbon-tip-hint">{hint}</span> : null}
        </span>
        {hotkey ? <span className="ribbon-tip-key">{hotkey}</span> : null}
      </span>
    </button>
  );
}
