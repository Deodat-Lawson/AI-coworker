/**
 * Canvas: an infinite board of cards and arrows, stored as JSON Canvas so the
 * file is the same one Obsidian reads and writes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type CanvasData,
  type CanvasEdge,
  type CanvasNode,
  type CanvasSide,
  CANVAS_COLORS,
  canvasColor,
  parseCanvas,
  stringifyCanvas,
} from '@ai-coworker/shared';

import { renderMarkdown, type RenderContext } from './markdown.js';

interface Props {
  path: string;
  raw: string | null;
  ctx: RenderContext;
  onSave(text: string): void;
  onOpenFile(path: string, newTab: boolean): void;
  resolve(target: string, from: string): string | undefined;
  fileOptions: { path: string; label: string }[];
}

interface Pointer {
  mode: 'pan' | 'move' | 'resize' | 'connect' | 'marquee' | null;
  startX: number;
  startY: number;
  originals: Map<string, { x: number; y: number; width: number; height: number }>;
  fromNode?: string;
  fromSide?: CanvasSide;
  toPoint?: { x: number; y: number };
}

const SIDES: CanvasSide[] = ['top', 'right', 'bottom', 'left'];

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

export default function CanvasView({
  path,
  raw,
  ctx,
  onSave,
  onOpenFile,
  resolve,
  fileOptions,
}: Props) {
  const [data, setData] = useState<CanvasData>({ nodes: [], edges: [] });
  const [selection, setSelection] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const pointerRef = useRef<Pointer>({ mode: null, startX: 0, startY: 0, originals: new Map() });
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const loadedRef = useRef<string>('');

  useEffect(() => {
    if (raw === null || loadedRef.current === path) return;
    loadedRef.current = path;
    const loaded = parseCanvas(raw);
    setData(loaded);
    setSelection([]);

    // Frame the board on open: a canvas is laid out around its own origin, and
    // an untouched view would start at a corner with everything off screen.
    const surface = surfaceRef.current;
    if (!surface || loaded.nodes.length === 0) {
      setView({ x: (surface?.clientWidth ?? 800) / 2, y: (surface?.clientHeight ?? 600) / 2, scale: 1 });
      return;
    }
    const minX = Math.min(...loaded.nodes.map((n) => n.x));
    const maxX = Math.max(...loaded.nodes.map((n) => n.x + n.width));
    const minY = Math.min(...loaded.nodes.map((n) => n.y));
    const maxY = Math.max(...loaded.nodes.map((n) => n.y + n.height));
    const padding = 80;
    const scale = Math.min(
      1,
      Math.max(
        0.25,
        Math.min(
          (surface.clientWidth - padding) / Math.max(1, maxX - minX),
          (surface.clientHeight - padding) / Math.max(1, maxY - minY),
        ),
      ),
    );
    setView({
      scale,
      x: surface.clientWidth / 2 - ((minX + maxX) / 2) * scale,
      y: surface.clientHeight / 2 - ((minY + maxY) / 2) * scale,
    });
  }, [path, raw]);

  const persist = useCallback(
    (next: CanvasData) => {
      setData(next);
      onSave(stringifyCanvas(next));
    },
    [onSave],
  );

  const toWorld = useCallback(
    (clientX: number, clientY: number) => {
      const rect = surfaceRef.current!.getBoundingClientRect();
      return {
        x: (clientX - rect.left - view.x) / view.scale,
        y: (clientY - rect.top - view.y) / view.scale,
      };
    },
    [view],
  );

  const addNode = useCallback(
    (node: CanvasNode) => {
      persist({ ...data, nodes: [...data.nodes, node] });
      setSelection([node.id]);
      if (node.type === 'text') setEditing(node.id);
    },
    [data, persist],
  );

  const updateNodes = useCallback(
    (ids: string[], patch: (node: CanvasNode) => CanvasNode, save = true) => {
      const next = {
        ...data,
        nodes: data.nodes.map((n) => (ids.includes(n.id) ? patch(n) : n)),
      };
      if (save) persist(next);
      else setData(next);
    },
    [data, persist],
  );

  const removeSelection = useCallback(() => {
    if (!selection.length) return;
    persist({
      nodes: data.nodes.filter((n) => !selection.includes(n.id)),
      edges: data.edges.filter((e) => !selection.includes(e.fromNode) && !selection.includes(e.toNode) && !selection.includes(e.id)),
    });
    setSelection([]);
  }, [data, persist, selection]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (editing) return;
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        removeSelection();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setSelection(data.nodes.map((n) => n.id));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [data.nodes, editing, removeSelection]);

  const nodeById = useMemo(() => new Map(data.nodes.map((n) => [n.id, n])), [data.nodes]);

  const handleSurfaceMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (event.target !== event.currentTarget && !(event.target as HTMLElement).classList.contains('canvas-surface')) {
        return;
      }
      if (event.button === 1 || event.altKey || event.shiftKey === false) {
        // Plain drag on empty space pans; shift-drag draws a selection box.
      }
      const world = toWorld(event.clientX, event.clientY);
      pointerRef.current = {
        mode: event.shiftKey ? 'marquee' : 'pan',
        startX: event.shiftKey ? world.x : event.clientX,
        startY: event.shiftKey ? world.y : event.clientY,
        originals: new Map(),
      };
      if (!event.shiftKey) setSelection([]);
    },
    [toWorld],
  );

  const handleMouseMove = useCallback(
    (event: React.MouseEvent) => {
      const pointer = pointerRef.current;
      if (!pointer.mode) return;
      if (pointer.mode === 'pan') {
        setView((v) => ({
          ...v,
          x: v.x + event.clientX - pointer.startX,
          y: v.y + event.clientY - pointer.startY,
        }));
        pointer.startX = event.clientX;
        pointer.startY = event.clientY;
        return;
      }
      const world = toWorld(event.clientX, event.clientY);
      if (pointer.mode === 'marquee') {
        setMarquee({
          x: Math.min(pointer.startX, world.x),
          y: Math.min(pointer.startY, world.y),
          w: Math.abs(world.x - pointer.startX),
          h: Math.abs(world.y - pointer.startY),
        });
        return;
      }
      if (pointer.mode === 'connect') {
        pointer.toPoint = world;
        setMarquee(null);
        setData((d) => ({ ...d }));
        return;
      }
      const dx = world.x - pointer.startX;
      const dy = world.y - pointer.startY;
      if (pointer.mode === 'move') {
        updateNodes(
          [...pointer.originals.keys()],
          (node) => {
            const original = pointer.originals.get(node.id)!;
            return { ...node, x: Math.round(original.x + dx), y: Math.round(original.y + dy) };
          },
          false,
        );
      } else if (pointer.mode === 'resize') {
        updateNodes(
          [...pointer.originals.keys()],
          (node) => {
            const original = pointer.originals.get(node.id)!;
            return {
              ...node,
              width: Math.max(80, Math.round(original.width + dx)),
              height: Math.max(60, Math.round(original.height + dy)),
            };
          },
          false,
        );
      }
    },
    [toWorld, updateNodes],
  );

  const handleMouseUp = useCallback(
    (event: React.MouseEvent) => {
      const pointer = pointerRef.current;
      if (pointer.mode === 'marquee' && marquee) {
        const hit = data.nodes
          .filter(
            (n) =>
              n.x < marquee.x + marquee.w &&
              n.x + n.width > marquee.x &&
              n.y < marquee.y + marquee.h &&
              n.y + n.height > marquee.y,
          )
          .map((n) => n.id);
        setSelection(hit);
      }
      if (pointer.mode === 'connect' && pointer.fromNode) {
        const world = toWorld(event.clientX, event.clientY);
        const target = [...data.nodes]
          .reverse()
          .find(
            (n) =>
              world.x >= n.x && world.x <= n.x + n.width && world.y >= n.y && world.y <= n.y + n.height,
          );
        if (target && target.id !== pointer.fromNode) {
          const edge: CanvasEdge = {
            id: nextId('e'),
            fromNode: pointer.fromNode,
            fromSide: pointer.fromSide,
            toNode: target.id,
            toSide: oppositeSide(pointer.fromSide ?? 'right'),
            toEnd: 'arrow',
          };
          persist({ ...data, edges: [...data.edges, edge] });
        }
      }
      if (pointer.mode === 'move' || pointer.mode === 'resize') persist(data);
      pointerRef.current = { mode: null, startX: 0, startY: 0, originals: new Map() };
      setMarquee(null);
    },
    [data, marquee, persist, toWorld],
  );

  const beginDrag = useCallback(
    (event: React.MouseEvent, id: string, mode: 'move' | 'resize') => {
      event.stopPropagation();
      const ids = selection.includes(id) && mode === 'move' ? selection : [id];
      if (!selection.includes(id)) setSelection(event.shiftKey ? [...selection, id] : [id]);
      else if (event.shiftKey) setSelection(selection.filter((s) => s !== id));
      const world = toWorld(event.clientX, event.clientY);
      const originals = new Map<string, { x: number; y: number; width: number; height: number }>();
      for (const nodeId of ids) {
        const node = nodeById.get(nodeId);
        if (node) originals.set(nodeId, { x: node.x, y: node.y, width: node.width, height: node.height });
      }
      pointerRef.current = { mode, startX: world.x, startY: world.y, originals };
    },
    [nodeById, selection, toWorld],
  );

  const pointer = pointerRef.current;

  return (
    <div className="canvas-view">
      <div className="canvas-toolbar">
        <button
          type="button"
          onClick={() => {
            const centre = toWorld(
              (surfaceRef.current?.clientWidth ?? 600) / 2,
              (surfaceRef.current?.clientHeight ?? 400) / 2,
            );
            addNode({
              id: nextId('n'),
              type: 'text',
              text: '',
              x: Math.round(centre.x - 125),
              y: Math.round(centre.y - 60),
              width: 250,
              height: 120,
            });
          }}
        >
          Add card
        </button>
        <select
          value=""
          onChange={(event) => {
            if (!event.target.value) return;
            const centre = toWorld(
              (surfaceRef.current?.clientWidth ?? 600) / 2,
              (surfaceRef.current?.clientHeight ?? 400) / 2,
            );
            addNode({
              id: nextId('n'),
              type: 'file',
              file: event.target.value,
              x: Math.round(centre.x - 160),
              y: Math.round(centre.y - 100),
              width: 320,
              height: 200,
            });
            event.target.value = '';
          }}
        >
          <option value="">Add note…</option>
          {fileOptions.map((file) => (
            <option key={file.path} value={file.path}>
              {file.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={selection.length < 1}
          onClick={() => {
            const nodes = selection.map((id) => nodeById.get(id)!).filter(Boolean);
            if (!nodes.length) return;
            const x = Math.min(...nodes.map((n) => n.x)) - 24;
            const y = Math.min(...nodes.map((n) => n.y)) - 44;
            const width = Math.max(...nodes.map((n) => n.x + n.width)) - x + 24;
            const height = Math.max(...nodes.map((n) => n.y + n.height)) - y + 24;
            persist({
              ...data,
              nodes: [
                { id: nextId('g'), type: 'group', label: 'Group', x, y, width, height },
                ...data.nodes,
              ],
            });
          }}
        >
          Group
        </button>
        <span className="canvas-colors">
          {Object.keys(CANVAS_COLORS).map((key) => (
            <button
              key={key}
              type="button"
              className="canvas-swatch"
              style={{ background: CANVAS_COLORS[key] }}
              title={`Colour ${key}`}
              disabled={!selection.length}
              onClick={() => updateNodes(selection, (node) => ({ ...node, color: key }))}
            />
          ))}
          <button
            type="button"
            className="canvas-swatch is-none"
            disabled={!selection.length}
            title="No colour"
            onClick={() =>
              updateNodes(selection, (node) => {
                const { color, ...rest } = node as CanvasNode & { color?: string };
                void color;
                return rest as CanvasNode;
              })
            }
          />
        </span>
        <button type="button" disabled={!selection.length} onClick={removeSelection}>
          Delete
        </button>
        <span className="canvas-zoom">
          <button type="button" onClick={() => setView((v) => ({ ...v, scale: Math.max(0.15, v.scale - 0.15) }))}>
            −
          </button>
          <span>{Math.round(view.scale * 100)}%</span>
          <button type="button" onClick={() => setView((v) => ({ ...v, scale: Math.min(3, v.scale + 0.15) }))}>
            +
          </button>
          <button
            type="button"
            onClick={() => {
              loadedRef.current = '';
              setView({ x: 0, y: 0, scale: 1 });
              // Re-running the load effect re-frames the board.
              window.setTimeout(() => {
                loadedRef.current = path;
                const surface = surfaceRef.current;
                if (!surface || data.nodes.length === 0) return;
                const minX = Math.min(...data.nodes.map((n) => n.x));
                const maxX = Math.max(...data.nodes.map((n) => n.x + n.width));
                const minY = Math.min(...data.nodes.map((n) => n.y));
                const maxY = Math.max(...data.nodes.map((n) => n.y + n.height));
                setView({
                  scale: 1,
                  x: surface.clientWidth / 2 - (minX + maxX) / 2,
                  y: surface.clientHeight / 2 - (minY + maxY) / 2,
                });
              }, 0);
            }}
          >
            Reset
          </button>
        </span>
      </div>

      <div
        ref={surfaceRef}
        className="canvas-surface"
        onMouseDown={handleSurfaceMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const world = toWorld(event.clientX, event.clientY);
          addNode({
            id: nextId('n'),
            type: 'text',
            text: '',
            x: Math.round(world.x - 125),
            y: Math.round(world.y - 60),
            width: 250,
            height: 120,
          });
        }}
        onWheel={(event) => {
          if (event.ctrlKey || event.metaKey) {
            const factor = Math.exp(-event.deltaY * 0.002);
            setView((v) => ({ ...v, scale: Math.min(3, Math.max(0.15, v.scale * factor)) }));
          } else {
            setView((v) => ({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY }));
          }
        }}
      >
        <div
          className="canvas-world"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          <svg className="canvas-edges" width="100%" height="100%">
            {data.edges.map((edge) => {
              const from = nodeById.get(edge.fromNode);
              const to = nodeById.get(edge.toNode);
              if (!from || !to) return null;
              const start = anchor(from, edge.fromSide ?? nearestSide(from, to));
              const end = anchor(to, edge.toSide ?? nearestSide(to, from));
              const stroke = canvasColor(edge.color, 'rgba(160,170,190,0.8)');
              return (
                <g key={edge.id} className={selection.includes(edge.id) ? 'is-selected' : ''}>
                  <path
                    d={curve(start, end)}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={2}
                    markerEnd={edge.toEnd === 'none' ? undefined : 'url(#canvas-arrow)'}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelection([edge.id]);
                    }}
                  />
                  {edge.label ? (
                    <text
                      x={(start.x + end.x) / 2}
                      y={(start.y + end.y) / 2 - 6}
                      textAnchor="middle"
                      className="canvas-edge-label"
                    >
                      {edge.label}
                    </text>
                  ) : null}
                </g>
              );
            })}
            {pointer.mode === 'connect' && pointer.fromNode && pointer.toPoint
              ? (() => {
                  const from = nodeById.get(pointer.fromNode!);
                  if (!from) return null;
                  const start = anchor(from, pointer.fromSide ?? 'right');
                  return (
                    <path
                      d={curve(start, pointer.toPoint!)}
                      fill="none"
                      stroke="var(--accent)"
                      strokeWidth={2}
                      strokeDasharray="4 4"
                    />
                  );
                })()
              : null}
            <defs>
              <marker
                id="canvas-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(160,170,190,0.9)" />
              </marker>
            </defs>
          </svg>

          {data.nodes.map((node) => {
            const selected = selection.includes(node.id);
            const accentColor = node.color ? canvasColor(node.color, '') : '';
            return (
              <div
                key={node.id}
                className={`canvas-node is-${node.type}${selected ? ' is-selected' : ''}`}
                style={{
                  left: node.x,
                  top: node.y,
                  width: node.width,
                  height: node.height,
                  borderColor: accentColor || undefined,
                }}
                onMouseDown={(event) => beginDrag(event, node.id, 'move')}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  if (node.type === 'text') setEditing(node.id);
                  else if (node.type === 'file') onOpenFile(node.file, event.metaKey || event.ctrlKey);
                }}
              >
                {node.type === 'group' ? (
                  <input
                    className="canvas-group-label"
                    value={node.label ?? ''}
                    onMouseDown={(event) => event.stopPropagation()}
                    onChange={(event) =>
                      updateNodes([node.id], (n) => ({ ...n, label: event.target.value }) as CanvasNode)
                    }
                  />
                ) : null}

                {node.type === 'text' ? (
                  editing === node.id ? (
                    <textarea
                      className="canvas-text-edit"
                      autoFocus
                      value={node.text}
                      onMouseDown={(event) => event.stopPropagation()}
                      onChange={(event) =>
                        updateNodes([node.id], (n) => ({ ...n, text: event.target.value }) as CanvasNode, false)
                      }
                      onBlur={() => {
                        setEditing(null);
                        persist(data);
                      }}
                    />
                  ) : (
                    <div
                      className="canvas-text markdown-body"
                      dangerouslySetInnerHTML={{
                        __html: renderMarkdown(node.text || '_Empty card_', { ...ctx, embedded: true }),
                      }}
                    />
                  )
                ) : null}

                {node.type === 'file' ? (
                  <FileCard node={node} ctx={ctx} resolve={resolve} onOpen={onOpenFile} />
                ) : null}

                {node.type === 'link' ? (
                  <a className="canvas-link" href={node.url} onClick={(e) => e.preventDefault()}>
                    {node.url}
                  </a>
                ) : null}

                {node.type !== 'group' ? (
                  <>
                    {SIDES.map((side) => (
                      <span
                        key={side}
                        className={`canvas-handle handle-${side}`}
                        onMouseDown={(event) => {
                          event.stopPropagation();
                          pointerRef.current = {
                            mode: 'connect',
                            startX: 0,
                            startY: 0,
                            originals: new Map(),
                            fromNode: node.id,
                            fromSide: side,
                          };
                        }}
                      />
                    ))}
                    <span
                      className="canvas-resize"
                      onMouseDown={(event) => beginDrag(event, node.id, 'resize')}
                    />
                  </>
                ) : (
                  <span
                    className="canvas-resize"
                    onMouseDown={(event) => beginDrag(event, node.id, 'resize')}
                  />
                )}
              </div>
            );
          })}

          {marquee ? (
            <div
              className="canvas-marquee"
              style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FileCard({
  node,
  ctx,
  resolve,
  onOpen,
}: {
  node: Extract<CanvasNode, { type: 'file' }>;
  ctx: RenderContext;
  resolve(target: string, from: string): string | undefined;
  onOpen(path: string, newTab: boolean): void;
}) {
  const resolved = resolve(node.file, '') ?? node.file;
  const text = ctx.readFile(resolved);
  const isImage = /\.(png|jpe?g|gif|svg|webp|avif)$/i.test(resolved);
  return (
    <div className="canvas-file">
      <button
        className="canvas-file-title"
        type="button"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => onOpen(resolved, event.metaKey || event.ctrlKey)}
      >
        {resolved.split('/').pop()}
      </button>
      <div className="canvas-file-body markdown-body">
        {isImage ? (
          <img src={ctx.resourceUrl(resolved)} alt={resolved} />
        ) : text === null ? (
          <div className="hint">Loading…</div>
        ) : (
          <div
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(text, { ...ctx, sourcePath: resolved, embedded: true, depth: 3 }),
            }}
          />
        )}
      </div>
    </div>
  );
}

function anchor(node: CanvasNode, side: CanvasSide): { x: number; y: number } {
  switch (side) {
    case 'top':
      return { x: node.x + node.width / 2, y: node.y };
    case 'bottom':
      return { x: node.x + node.width / 2, y: node.y + node.height };
    case 'left':
      return { x: node.x, y: node.y + node.height / 2 };
    default:
      return { x: node.x + node.width, y: node.y + node.height / 2 };
  }
}

function nearestSide(from: CanvasNode, to: CanvasNode): CanvasSide {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'bottom' : 'top';
}

function oppositeSide(side: CanvasSide): CanvasSide {
  return { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[side] as CanvasSide;
}

function curve(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dx = Math.abs(b.x - a.x) * 0.5;
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}
