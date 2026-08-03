/**
 * One open note: the title bar, the editor, and the find/replace strip.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { isMarkdown, type NoteMeta } from '@ai-coworker/shared';

import Editor, { type EditorHandle, type EditorMode, type Suggestion } from './Editor.js';
import { invalidateMermaid, renderMermaidIn } from './mermaid.js';
import type { RenderContext } from './markdown.js';
import type { VaultController } from './useVault.js';

interface Props {
  vault: VaultController;
  path: string;
  mode: EditorMode;
  editorRef: React.RefObject<EditorHandle>;
  /** Set once after opening to jump to a search hit or a backlink. */
  gotoLine?: number;
  onOpenLink(target: string, subpath: string, resolved: string, newTab: boolean): void;
  onTagClick(tag: string): void;
  onCaret(line: number): void;
}

export default function NoteView({
  vault,
  path,
  mode,
  editorRef,
  gotoLine,
  onOpenLink,
  onTagClick,
  onCaret,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [find, setFind] = useState<{ query: string; replace: string; open: boolean } | null>(null);
  const content = vault.content(path);
  const meta: NoteMeta | undefined = vault.meta[path];

  const ctx = useMemo<RenderContext>(
    () => ({
      sourcePath: path,
      resolve: (target, from) => vault.resolve(target, from || path),
      resourceUrl: (target) => vault.resourceUrl(target),
      readFile: (target) => vault.content(target),
      strictLineBreaks: vault.settings.strictLineBreaks,
    }),
    [path, vault],
  );

  // Diagrams live inside HTML the editor writes directly, so watch for them.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const dark = vault.settings.theme !== 'light';
    const run = () => void renderMermaidIn(root, dark);
    run();
    const observer = new MutationObserver(() => run());
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [path, vault.settings.theme]);

  useEffect(() => {
    const root = containerRef.current;
    if (root) invalidateMermaid(root);
  }, [content, mode]);

  useEffect(() => {
    if (gotoLine === undefined) return;
    const timer = window.setTimeout(() => editorRef.current?.scrollToLine(gotoLine, true), 60);
    return () => window.clearTimeout(timer);
  }, [editorRef, gotoLine, path]);

  const suggest = useCallback(
    (kind: 'link' | 'tag', query: string): Suggestion[] => {
      if (kind === 'tag') {
        const lower = query.toLowerCase();
        return [...vault.tags.keys()]
          .filter((tag) => tag.toLowerCase().includes(lower))
          .sort()
          .slice(0, 30)
          .map((tag) => ({ id: tag, label: `#${tag}`, insert: tag }));
      }

      // `[[Note#` completes that note's headings; `[[Note#^` its block anchors.
      const hash = query.indexOf('#');
      if (hash !== -1) {
        const head = query.slice(0, hash);
        const sub = query.slice(hash + 1);
        const targetPath = head ? vault.resolve(head, path) : path;
        const targetMeta = targetPath ? vault.meta[targetPath] : undefined;
        if (!targetMeta) return [];
        if (sub.startsWith('^')) {
          const needle = sub.slice(1).toLowerCase();
          return Object.entries(targetMeta.blocks)
            .filter(([id]) => id.toLowerCase().includes(needle))
            .slice(0, 30)
            .map(([id, line]) => ({
              id: `block:${id}`,
              label: `^${id}`,
              detail: `line ${line + 1}`,
              insert: `${head}#^${id}`,
            }));
        }
        const needle = sub.toLowerCase();
        return targetMeta.headings
          .filter((heading) => heading.text.toLowerCase().includes(needle))
          .slice(0, 30)
          .map((heading) => ({
            id: `heading:${heading.line}`,
            label: heading.text,
            detail: '#'.repeat(heading.level),
            insert: `${head}#${heading.text}`,
          }));
      }

      const lower = query.toLowerCase();
      const scored = vault.files
        .filter((file) => isMarkdown(file.path) || !file.path.startsWith('.'))
        .map((file) => {
          const noteMeta = vault.meta[file.path];
          const names = [file.basename, noteMeta?.title ?? '', ...(noteMeta?.aliases ?? [])];
          const hit = names.find((name) => name.toLowerCase().includes(lower));
          if (query && !hit && !file.path.toLowerCase().includes(lower)) return null;
          return {
            id: file.path,
            label: file.basename,
            detail: file.folder || undefined,
            insert: file.basename,
            score: hit === file.basename ? 2 : 1,
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));

      const results: Suggestion[] = scored.slice(0, 30).map(({ score, ...rest }) => {
        void score;
        return rest;
      });
      // Offer to create the note you are typing the name of — last, so a
      // real match is always the default.
      if (query.trim() && !vault.resolve(query.trim(), path)) {
        results.push({
          id: `new:${query}`,
          label: query.trim(),
          detail: 'new note',
          insert: query.trim(),
        });
      }
      return results;
    },
    [path, vault],
  );

  const handlePaste = useCallback(
    async (event: React.ClipboardEvent) => {
      const file = [...event.clipboardData.items].find((item) => item.type.startsWith('image/'));
      if (!file) return;
      const blob = file.getAsFile();
      if (!blob) return;
      event.preventDefault();
      const buffer = await blob.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      const extension = blob.type.split('/')[1] ?? 'png';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const saved = await vault.saveAttachment(`Pasted image ${stamp}.${extension}`, base64);
      editorRef.current?.insertAtCaret(`![[${saved}]]`);
    },
    [editorRef, vault],
  );

  const runFind = useCallback(
    (direction: 1 | -1) => {
      if (!find?.query) return;
      const text = editorRef.current?.getValue() ?? '';
      const { to } = editorRef.current?.getSelection() ?? { to: 0 };
      const haystack = text.toLowerCase();
      const needle = find.query.toLowerCase();
      let at = direction === 1 ? haystack.indexOf(needle, to) : haystack.lastIndexOf(needle, Math.max(0, to - needle.length - 1));
      if (at === -1) at = direction === 1 ? haystack.indexOf(needle) : haystack.lastIndexOf(needle);
      if (at === -1) return;
      const line = text.slice(0, at).split('\n').length - 1;
      editorRef.current?.replaceRange(at, at + needle.length, text.slice(at, at + needle.length), at + needle.length);
      editorRef.current?.scrollToLine(line, true);
    },
    [editorRef, find],
  );

  const replaceAll = useCallback(() => {
    if (!find?.query) return;
    const text = editorRef.current?.getValue() ?? '';
    const next = text.split(find.query).join(find.replace);
    if (next !== text) editorRef.current?.replaceRange(0, text.length, next, 0);
  }, [editorRef, find]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && !event.shiftKey) {
        event.preventDefault();
        setFind((current) => ({ query: current?.query ?? '', replace: current?.replace ?? '', open: true }));
      }
      if (event.key === 'Escape' && find?.open) setFind(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [find?.open]);

  if (!isMarkdown(path)) {
    return <AttachmentView vault={vault} path={path} />;
  }

  if (content === null) {
    return <div className="note-loading">Opening {path}…</div>;
  }

  return (
    <div className="note-view" ref={containerRef} onPaste={(event) => void handlePaste(event)}>
      {find?.open ? (
        <div className="find-bar">
          <input
            autoFocus
            placeholder="Find"
            value={find.query}
            onChange={(event) => setFind({ ...find, query: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') runFind(event.shiftKey ? -1 : 1);
            }}
          />
          <button onClick={() => runFind(-1)} type="button">
            ↑
          </button>
          <button onClick={() => runFind(1)} type="button">
            ↓
          </button>
          <input
            placeholder="Replace"
            value={find.replace}
            onChange={(event) => setFind({ ...find, replace: event.target.value })}
          />
          <button onClick={replaceAll} type="button">
            Replace all
          </button>
          <button className="ghost" onClick={() => setFind(null)} type="button">
            ×
          </button>
        </div>
      ) : null}

      <div
        className={`note-scroll${vault.settings.readableLineLength ? ' is-readable' : ''}`}
        style={
          {
            '--editor-font-size': `${vault.settings.fontSize}px`,
            '--editor-width': `${vault.settings.lineWidth}px`,
          } as React.CSSProperties
        }
      >
        <Editor
          ref={editorRef}
          value={content}
          mode={mode}
          ctx={ctx}
          spellcheck={vault.settings.spellcheck}
          showLineNumbers={vault.settings.showLineNumbers}
          revision={vault.contentVersion}
          onChange={(next) => vault.write(path, next)}
          onCaret={(_offset, line) => onCaret(line)}
          suggest={suggest}
          onOpenLink={(target, subpath, resolved, event) =>
            onOpenLink(target, subpath, resolved, event.metaKey || event.ctrlKey)
          }
          onTagClick={onTagClick}
          onExternal={(href) => void vault.openExternal(href)}
        />
        {meta ? (
          <div className="note-footer">
            {meta.words} words · {meta.chars} characters · updated{' '}
            {new Date(meta.mtime).toLocaleString()}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AttachmentView({ vault, path }: { vault: VaultController; path: string }) {
  const url = vault.resourceUrl(path);
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return (
    <div className="attachment-view">
      {['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp'].includes(extension) ? (
        <img src={url} alt={path} />
      ) : extension === 'pdf' ? (
        <iframe src={url} title={path} />
      ) : ['mp4', 'webm', 'mov', 'ogv'].includes(extension) ? (
        <video src={url} controls />
      ) : ['mp3', 'wav', 'm4a', 'ogg', 'flac'].includes(extension) ? (
        <audio src={url} controls />
      ) : (
        <div className="empty">
          No preview for .{extension}
          <button onClick={() => void vault.reveal(path)} type="button">
            Reveal in Finder
          </button>
        </div>
      )}
    </div>
  );
}
