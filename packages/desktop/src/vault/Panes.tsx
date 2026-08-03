/**
 * The side panes: files, search, tags, bookmarks, outline, backlinks,
 * outgoing links and properties. Each is a small read-only view over the vault
 * index, plus the handful of actions that belong to it.
 */

import { useMemo, useState } from 'react';

import {
  type BacklinkEntry,
  type FrontmatterValue,
  type NoteMeta,
  type SearchHit,
  type VaultFile,
  dirname,
  isMarkdown,
  stripInline,
} from '@ai-coworker/shared';

import { useUi } from './ui.js';

import type { VaultController } from './useVault.js';
import type { VaultBookmark } from '../../electron/ipc.js';

export interface MenuItem {
  label: string;
  danger?: boolean;
  separator?: boolean;
  action?(): void;
}

export type ContextMenuHandler = (event: React.MouseEvent, items: MenuItem[]) => void;

// ---------------------------------------------------------------------------
// File explorer
// ---------------------------------------------------------------------------

interface TreeNode {
  name: string;
  path: string;
  folder: boolean;
  children: TreeNode[];
  file?: VaultFile;
}

function buildTree(files: VaultFile[], folders: string[]): TreeNode {
  const root: TreeNode = { name: '', path: '', folder: true, children: [] };
  const folderNodes = new Map<string, TreeNode>([['', root]]);

  const ensureFolder = (path: string): TreeNode => {
    const existing = folderNodes.get(path);
    if (existing) return existing;
    const parent = ensureFolder(dirname(path));
    const node: TreeNode = {
      name: path.split('/').pop() ?? path,
      path,
      folder: true,
      children: [],
    };
    parent.children.push(node);
    folderNodes.set(path, node);
    return node;
  };

  for (const folder of [...folders].sort()) ensureFolder(folder);
  for (const file of files) {
    ensureFolder(file.folder).children.push({
      name: file.name,
      path: file.path,
      folder: false,
      children: [],
      file,
    });
  }

  const sort = (node: TreeNode) => {
    node.children.sort((a, b) => {
      if (a.folder !== b.folder) return a.folder ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    node.children.forEach(sort);
  };
  sort(root);
  return root;
}

export function FileExplorer({
  vault,
  activePath,
  onOpen,
  onMenu,
  onNewNote,
  onNewFolder,
}: {
  vault: VaultController;
  activePath: string | null;
  onOpen(path: string, newTab: boolean): void;
  onMenu: ContextMenuHandler;
  onNewNote(folder: string): void;
  onNewFolder(folder: string): void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const tree = useMemo(() => buildTree(vault.files, vault.folders), [vault.files, vault.folders]);
  const ui = useUi();

  const toggle = (path: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const move = async (from: string, toFolder: string) => {
    const name = from.split('/').pop()!;
    const target = toFolder ? `${toFolder}/${name}` : name;
    if (target === from || target.startsWith(`${from}/`)) return;
    await vault.rename(from, target);
  };

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    if (node.folder) {
      const isCollapsed = collapsed.has(node.path);
      return (
        <div key={`folder:${node.path}`}>
          <div
            className={`tree-row is-folder${dropTarget === node.path ? ' is-drop' : ''}`}
            style={{ paddingLeft: 6 + depth * 12 }}
            onClick={() => toggle(node.path)}
            onDragOver={(event) => {
              event.preventDefault();
              setDropTarget(node.path);
            }}
            onDragLeave={() => setDropTarget((t) => (t === node.path ? null : t))}
            onDrop={(event) => {
              event.preventDefault();
              setDropTarget(null);
              if (dragging) void move(dragging, node.path);
            }}
            onContextMenu={(event) =>
              onMenu(event, [
                { label: 'New note', action: () => onNewNote(node.path) },
                { label: 'New folder', action: () => onNewFolder(node.path) },
                { separator: true, label: '' },
                {
                  label: 'Rename folder',
                  action: () => {
                    void (async () => {
                      const name = await ui.prompt('Rename folder', node.name);
                      if (name && name !== node.name) {
                        await vault.rename(node.path, [dirname(node.path), name].filter(Boolean).join('/'));
                      }
                    })();
                  },
                },
                {
                  label: 'Delete folder',
                  danger: true,
                  action: () => {
                    void (async () => {
                      const yes = await ui.confirm(`Delete "${node.name}"?`, {
                        message: 'The folder and everything in it moves to the vault trash.',
                        confirmLabel: 'Delete',
                        danger: true,
                      });
                      if (yes) await vault.remove(node.path);
                    })();
                  },
                },
                { label: 'Reveal in Finder', action: () => void vault.reveal(node.path) },
              ])
            }
          >
            <span className={`tree-twisty${isCollapsed ? '' : ' is-open'}`}>▸</span>
            <span className="tree-name">{node.name}</span>
            <span className="tree-count">{node.children.length}</span>
          </div>
          {!isCollapsed ? node.children.map((child) => renderNode(child, depth + 1)) : null}
        </div>
      );
    }

    const meta = vault.meta[node.path];
    const label = isMarkdown(node.path) ? node.name.replace(/\.md$/, '') : node.name;
    return (
      <div
        key={node.path}
        className={`tree-row is-file${activePath === node.path ? ' is-active' : ''}${vault.dirty(node.path) ? ' is-dirty' : ''}`}
        style={{ paddingLeft: 6 + depth * 12 }}
        draggable
        onDragStart={() => setDragging(node.path)}
        onDragEnd={() => setDragging(null)}
        onClick={(event) => onOpen(node.path, event.metaKey || event.ctrlKey)}
        onContextMenu={(event) =>
          onMenu(event, [
            { label: 'Open in new tab', action: () => onOpen(node.path, true) },
            { separator: true, label: '' },
            {
              label: 'Rename',
              action: () => {
                void (async () => {
                  const name = await ui.prompt('Rename', node.name);
                  if (name && name !== node.name) {
                    await vault.rename(node.path, [node.file?.folder, name].filter(Boolean).join('/'));
                  }
                })();
              },
            },
            {
              label: 'Make a copy',
              action: () => {
                void (async () => {
                  const text = await vault.read(node.path);
                  const copy = node.path.replace(/(\.[^.]+)$/, ' copy$1');
                  await vault.create(copy, text);
                })();
              },
            },
            { label: 'Reveal in Finder', action: () => void vault.reveal(node.path) },
            { separator: true, label: '' },
            {
              label: 'Delete',
              danger: true,
              action: () => {
                void (async () => {
                  const yes =
                    !vault.settings.confirmDelete ||
                    (await ui.confirm(`Delete "${node.name}"?`, {
                      confirmLabel: 'Delete',
                      danger: true,
                    }));
                  if (yes) await vault.remove(node.path);
                })();
              },
            },
          ])
        }
        title={meta ? `${meta.words} words · ${new Date(meta.mtime).toLocaleString()}` : node.path}
      >
        <span className="tree-name">{label}</span>
        {!isMarkdown(node.path) ? <span className="tree-ext">{node.file?.extension}</span> : null}
      </div>
    );
  };

  return (
    <div className="pane">
      <div className="pane-head">
        <span>Files</span>
        <span className="pane-actions">
          <button className="ghost" title="New note" onClick={() => onNewNote('')} type="button">
            ＋
          </button>
          <button className="ghost" title="New folder" onClick={() => onNewFolder('')} type="button">
            ⊞
          </button>
        </span>
      </div>
      <div
        className="pane-body tree"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (dragging) void move(dragging, '');
        }}
      >
        {tree.children.length === 0 ? (
          <div className="empty">No notes yet. Press ⌘N.</div>
        ) : (
          tree.children.map((child) => renderNode(child, 0))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export function SearchPane({
  query,
  onQuery,
  results,
  running,
  options,
  onOptions,
  onOpen,
  onBookmark,
}: {
  query: string;
  onQuery(next: string): void;
  results: SearchHit[];
  running: boolean;
  options: { caseSensitive: boolean; wholeWord: boolean };
  onOptions(patch: Partial<{ caseSensitive: boolean; wholeWord: boolean }>): void;
  onOpen(path: string, line?: number): void;
  onBookmark(): void;
}) {
  const total = results.reduce((sum, hit) => sum + hit.total, 0);
  return (
    <div className="pane">
      <div className="pane-head">
        <span>Search</span>
        <span className="pane-actions">
          <button
            className={`ghost${options.caseSensitive ? ' is-on' : ''}`}
            title="Match case"
            onClick={() => onOptions({ caseSensitive: !options.caseSensitive })}
            type="button"
          >
            Aa
          </button>
          <button
            className={`ghost${options.wholeWord ? ' is-on' : ''}`}
            title="Whole word"
            onClick={() => onOptions({ wholeWord: !options.wholeWord })}
            type="button"
          >
            ab
          </button>
          <button className="ghost" title="Bookmark this search" onClick={onBookmark} type="button">
            ☆
          </button>
        </span>
      </div>
      <div className="pane-search">
        <input
          autoFocus
          value={query}
          placeholder="Search — try tag:#idea or path:Projects"
          onChange={(event) => onQuery(event.target.value)}
        />
      </div>
      <div className="pane-body">
        {query.trim() ? (
          <div className="search-summary">
            {running ? 'Searching…' : `${total} match${total === 1 ? '' : 'es'} in ${results.length} file${results.length === 1 ? '' : 's'}`}
          </div>
        ) : (
          <div className="hint search-help">
            <div><code>tag:#idea</code> notes with a tag</div>
            <div><code>path:Projects</code> inside a folder</div>
            <div><code>file:auth</code> by file name</div>
            <div><code>section:Risks</code> under a heading</div>
            <div><code>task:</code> notes with checkboxes</div>
            <div><code>"exact phrase"</code> and <code>-exclude</code></div>
            <div><code>/regex/</code> for the rest</div>
          </div>
        )}
        {results.map((hit) => (
          <div className="search-hit" key={hit.path}>
            <button className="search-file" onClick={() => onOpen(hit.path)} type="button">
              {hit.title}
              <span className="search-count">{hit.total}</span>
            </button>
            {hit.matches.map((match, index) => (
              <button
                key={`${match.line}:${match.col}:${index}`}
                className="search-line"
                onClick={() => onOpen(hit.path, match.line)}
                type="button"
              >
                {highlightMatch(match.text, match.col, match.length)}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function highlightMatch(text: string, col: number, length: number): React.ReactNode {
  const trimmedOffset = text.length - text.trimStart().length;
  const start = Math.max(0, col - trimmedOffset);
  const before = text.slice(Math.max(0, start - 40), start);
  const match = text.slice(start, start + length);
  const after = text.slice(start + length, start + length + 80);
  return (
    <>
      {before}
      <mark>{match}</mark>
      {after}
    </>
  );
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export function TagPane({
  tags,
  onSelect,
  active,
}: {
  tags: Map<string, number>;
  onSelect(tag: string): void;
  active: string | null;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const sorted = useMemo(
    () => [...tags.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    [tags],
  );

  const visible = sorted.filter(([tag]) => {
    const parts = tag.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      if (collapsed.has(parts.slice(0, i).join('/'))) return false;
    }
    return true;
  });

  return (
    <div className="pane">
      <div className="pane-head">
        <span>Tags</span>
        <span className="pane-count">{tags.size}</span>
      </div>
      <div className="pane-body">
        {visible.length === 0 ? (
          <div className="empty">No tags yet. Write #like-this in a note.</div>
        ) : (
          visible.map(([tag, count]) => {
            const depth = tag.split('/').length - 1;
            const hasChildren = sorted.some(([other]) => other.startsWith(`${tag}/`));
            return (
              <div
                key={tag}
                className={`tag-row${active === tag ? ' is-active' : ''}`}
                style={{ paddingLeft: 8 + depth * 12 }}
                onClick={() => onSelect(tag)}
              >
                {hasChildren ? (
                  <span
                    className={`tree-twisty${collapsed.has(tag) ? '' : ' is-open'}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setCollapsed((previous) => {
                        const next = new Set(previous);
                        if (next.has(tag)) next.delete(tag);
                        else next.add(tag);
                        return next;
                      });
                    }}
                  >
                    ▸
                  </span>
                ) : (
                  <span className="tree-twisty is-leaf" />
                )}
                <span className="tag-name">#{tag.split('/').pop()}</span>
                <span className="tree-count">{count}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------

export function BookmarksPane({
  bookmarks,
  onOpen,
  onRemove,
}: {
  bookmarks: VaultBookmark[];
  onOpen(bookmark: VaultBookmark): void;
  onRemove(bookmark: VaultBookmark): void;
}) {
  return (
    <div className="pane">
      <div className="pane-head">
        <span>Bookmarks</span>
        <span className="pane-count">{bookmarks.length}</span>
      </div>
      <div className="pane-body">
        {bookmarks.length === 0 ? (
          <div className="empty">Nothing bookmarked. Press ⌘D on a note.</div>
        ) : (
          bookmarks.map((bookmark, index) => (
            <div className="bookmark-row" key={`${bookmark.type}:${bookmark.path ?? bookmark.query}:${index}`}>
              <button className="bookmark-open" onClick={() => onOpen(bookmark)} type="button">
                <span className="bookmark-kind">{bookmark.type === 'search' ? '⌕' : bookmark.type === 'graph' ? '◍' : '▤'}</span>
                {bookmark.title ?? bookmark.path ?? bookmark.query}
              </button>
              <button className="ghost" onClick={() => onRemove(bookmark)} type="button" title="Remove">
                ×
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

export function OutlinePane({
  meta,
  onGo,
}: {
  meta: NoteMeta | undefined;
  onGo(line: number): void;
}) {
  return (
    <div className="pane">
      <div className="pane-head">
        <span>Outline</span>
      </div>
      <div className="pane-body">
        {!meta || meta.headings.length === 0 ? (
          <div className="empty">No headings.</div>
        ) : (
          meta.headings.map((heading) => (
            <div
              key={`${heading.line}:${heading.slug}`}
              className="outline-row"
              style={{ paddingLeft: 8 + (heading.level - 1) * 12 }}
              onClick={() => onGo(heading.line)}
            >
              {heading.text || '—'}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Backlinks and outgoing links
// ---------------------------------------------------------------------------

export function BacklinksPane({
  path,
  meta,
  backlinks,
  mentions,
  titleOf,
  onOpen,
  onLink,
}: {
  path: string | null;
  meta: Record<string, NoteMeta>;
  backlinks: BacklinkEntry[];
  mentions: { from: string; line: number; context: string }[];
  titleOf(path: string): string;
  onOpen(path: string, line?: number): void;
  onLink(from: string, line: number): void;
}) {
  const [showMentions, setShowMentions] = useState(true);
  const grouped = useMemo(() => {
    const map = new Map<string, BacklinkEntry[]>();
    for (const entry of backlinks) {
      const list = map.get(entry.from);
      if (list) list.push(entry);
      else map.set(entry.from, [entry]);
    }
    return [...map.entries()];
  }, [backlinks]);

  const groupedMentions = useMemo(() => {
    const map = new Map<string, { line: number; context: string }[]>();
    for (const entry of mentions) {
      const list = map.get(entry.from);
      if (list) list.push(entry);
      else map.set(entry.from, [entry]);
    }
    return [...map.entries()];
  }, [mentions]);

  const outgoing = path ? (meta[path]?.links ?? []) : [];

  return (
    <div className="pane">
      <div className="pane-head">
        <span>Links</span>
      </div>
      <div className="pane-body">
        <div className="pane-section">Backlinks<span className="pane-count">{backlinks.length}</span></div>
        {grouped.length === 0 ? (
          <div className="empty">No note links here yet.</div>
        ) : (
          grouped.map(([from, entries]) => (
            <div className="backlink-group" key={from}>
              <button className="backlink-file" onClick={() => onOpen(from)} type="button">
                {titleOf(from)}
                <span className="search-count">{entries.length}</span>
              </button>
              {entries.map((entry, index) => (
                <button
                  key={`${entry.link.line}:${index}`}
                  className="backlink-context"
                  onClick={() => onOpen(from, entry.link.line)}
                  type="button"
                >
                  {stripInline(entry.context) || '—'}
                </button>
              ))}
            </div>
          ))
        )}

        <div className="pane-section">
          Outgoing<span className="pane-count">{outgoing.length}</span>
        </div>
        {outgoing.length === 0 ? (
          <div className="empty">This note links nowhere.</div>
        ) : (
          outgoing.map((link, index) => (
            <button
              key={`${link.line}:${index}`}
              className="backlink-context"
              onClick={() => {
                if (link.external) return;
                onOpen(link.target, undefined);
              }}
              type="button"
            >
              {link.external ? `↗ ${link.target}` : `→ ${link.alias || link.target}${link.subpath}`}
            </button>
          ))
        )}

        <div className="pane-section" onClick={() => setShowMentions((v) => !v)}>
          Unlinked mentions<span className="pane-count">{mentions.length}</span>
        </div>
        {showMentions
          ? groupedMentions.map(([from, entries]) => (
              <div className="backlink-group" key={`m:${from}`}>
                <button className="backlink-file" onClick={() => onOpen(from)} type="button">
                  {titleOf(from)}
                  <span className="search-count">{entries.length}</span>
                </button>
                {entries.map((entry, index) => (
                  <div className="mention-row" key={`${entry.line}:${index}`}>
                    <button
                      className="backlink-context"
                      onClick={() => onOpen(from, entry.line)}
                      type="button"
                    >
                      {stripInline(entry.context)}
                    </button>
                    <button
                      className="ghost mention-link"
                      onClick={() => onLink(from, entry.line)}
                      type="button"
                      title="Turn this mention into a link"
                    >
                      Link
                    </button>
                  </div>
                ))}
              </div>
            ))
          : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

export function PropertiesPane({
  meta,
  onChange,
}: {
  meta: NoteMeta | undefined;
  onChange(key: string, value: FrontmatterValue | undefined): void;
}) {
  const [newKey, setNewKey] = useState('');
  const entries = Object.entries(meta?.frontmatter ?? {});

  return (
    <div className="pane">
      <div className="pane-head">
        <span>Properties</span>
        <span className="pane-count">{entries.length}</span>
      </div>
      <div className="pane-body">
        {!meta ? (
          <div className="empty">Open a note.</div>
        ) : (
          <>
            {entries.map(([key, value]) => (
              <div className="prop-edit" key={key}>
                <label>{key}</label>
                <input
                  value={formatValue(value)}
                  onChange={(event) => onChange(key, parseValue(event.target.value))}
                />
                <button className="ghost" onClick={() => onChange(key, undefined)} type="button">
                  ×
                </button>
              </div>
            ))}
            <div className="prop-add">
              <input
                placeholder="Add property…"
                value={newKey}
                onChange={(event) => setNewKey(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && newKey.trim()) {
                    onChange(newKey.trim(), '');
                    setNewKey('');
                  }
                }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function formatValue(value: FrontmatterValue): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((v) => formatValue(v)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function parseValue(text: string): FrontmatterValue {
  if (text.includes(',')) return text.split(',').map((part) => part.trim()).filter(Boolean);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text.trim() && !Number.isNaN(Number(text))) return Number(text);
  return text;
}
