/**
 * Graph view.
 *
 * A force simulation on a canvas: links pull, nodes push apart, a weak force
 * holds the whole thing near the middle. Local graph is the same simulation run
 * over a breadth-limited neighbourhood of one note.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type GraphSettings,
  type NoteMeta,
  type VaultFile,
  type ResolverIndex,
  buildGraph,
} from '@ai-coworker/shared';

interface Simulated {
  id: string;
  label: string;
  kind: 'note' | 'unresolved' | 'attachment' | 'tag';
  links: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed?: boolean;
}

interface Props {
  meta: Record<string, NoteMeta>;
  files: VaultFile[];
  resolver: ResolverIndex;
  settings: GraphSettings;
  onSettings(patch: Partial<GraphSettings>): void;
  onOpen(path: string, newTab: boolean): void;
  /** Set for a local graph: the note at the centre. */
  focus?: string;
  depth?: number;
  compact?: boolean;
  accent: string;
}

const COLORS: Record<Simulated['kind'], string> = {
  note: '#7f8798',
  unresolved: '#4a5162',
  attachment: '#6b7280',
  tag: '#8a7fb8',
};

export default function GraphView({
  meta,
  files,
  resolver,
  settings,
  onSettings,
  onOpen,
  focus,
  depth = 1,
  compact = false,
  accent,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const nodesRef = useRef<Simulated[]>([]);
  const edgesRef = useRef<{ source: Simulated; target: Simulated }[]>([]);
  const viewRef = useRef({ x: 0, y: 0, scale: 1 });
  const alphaRef = useRef(1);
  const fittedRef = useRef(false);
  const frameRef = useRef(0);
  const hoverRef = useRef<Simulated | null>(null);
  const dragRef = useRef<{ node: Simulated | null; panning: boolean; lastX: number; lastY: number }>({
    node: null,
    panning: false,
    lastX: 0,
    lastY: 0,
  });
  const [filter, setFilter] = useState('');
  const [showControls, setShowControls] = useState(false);

  const graph = useMemo(() => {
    const full = buildGraph(meta, files, resolver, {
      showAttachments: settings.showAttachments,
      showTags: settings.showTags,
      showUnresolved: settings.showUnresolved,
    });
    if (!focus) return full;
    // Local graph: keep everything within `depth` hops of the focused note.
    const adjacency = new Map<string, Set<string>>();
    for (const edge of full.edges) {
      if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
      if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
      adjacency.get(edge.source)!.add(edge.target);
      adjacency.get(edge.target)!.add(edge.source);
    }
    const keep = new Set<string>([focus]);
    let frontier = [focus];
    for (let d = 0; d < depth; d += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const neighbour of adjacency.get(id) ?? []) {
          if (!keep.has(neighbour)) {
            keep.add(neighbour);
            next.push(neighbour);
          }
        }
      }
      frontier = next;
    }
    return {
      nodes: full.nodes.filter((n) => keep.has(n.id)),
      edges: full.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    };
  }, [depth, files, focus, meta, resolver, settings.showAttachments, settings.showTags, settings.showUnresolved]);

  // Build the simulation, keeping positions of nodes that were already there.
  useEffect(() => {
    const previous = new Map(nodesRef.current.map((n) => [n.id, n]));
    const radius = Math.max(120, Math.sqrt(graph.nodes.length) * 42);
    const nodes = graph.nodes.map((node, index) => {
      const existing = previous.get(node.id);
      const angle = (index / Math.max(1, graph.nodes.length)) * Math.PI * 2;
      return {
        ...node,
        x: existing?.x ?? Math.cos(angle) * radius * (0.4 + Math.random() * 0.6),
        y: existing?.y ?? Math.sin(angle) * radius * (0.4 + Math.random() * 0.6),
        vx: 0,
        vy: 0,
      } as Simulated;
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    if (focus) {
      const centre = byId.get(focus);
      if (centre) {
        centre.x = 0;
        centre.y = 0;
        centre.fixed = true;
      }
    }
    nodesRef.current = nodes;
    edgesRef.current = graph.edges
      .map((edge) => ({ source: byId.get(edge.source)!, target: byId.get(edge.target)! }))
      .filter((e) => e.source && e.target);
    alphaRef.current = 1;
    fittedRef.current = false;
  }, [focus, graph]);

  /** Once the layout settles, frame it so nothing sits off the edge. */
  const fitToView = useCallback(() => {
    const canvas = canvasRef.current;
    const nodes = nodesRef.current;
    if (!canvas || nodes.length === 0) return;
    const minX = Math.min(...nodes.map((n) => n.x));
    const maxX = Math.max(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    const maxY = Math.max(...nodes.map((n) => n.y));
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const padding = 96;
    const scale = Math.min(
      1.6,
      // Never zoom out past readability: a stray node is better cropped than
      // shrinking every label into nothing.
      Math.max(0.45, Math.min((canvas.clientWidth - padding) / width, (canvas.clientHeight - padding) / height)),
    );
    viewRef.current = {
      scale,
      x: -((minX + maxX) / 2) * scale,
      y: -((minY + maxY) / 2) * scale,
    };
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const step = useCallback(() => {
    const nodes = nodesRef.current;
    const edges = edgesRef.current;
    const alpha = alphaRef.current;
    if (alpha > 0.002) {
      const repel = settings.repelForce * 90;
      for (let i = 0; i < nodes.length; i += 1) {
        const a = nodes[i]!;
        for (let j = i + 1; j < nodes.length; j += 1) {
          const b = nodes[j]!;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let distanceSq = dx * dx + dy * dy;
          if (distanceSq < 0.01) {
            dx = (Math.random() - 0.5) * 2;
            dy = (Math.random() - 0.5) * 2;
            distanceSq = dx * dx + dy * dy;
          }
          if (distanceSq > 640_000) continue;
          const force = (repel / distanceSq) * alpha;
          const fx = dx * force;
          const fy = dy * force;
          a.vx -= fx;
          a.vy -= fy;
          b.vx += fx;
          b.vy += fy;
        }
      }
      for (const edge of edges) {
        const dx = edge.target.x - edge.source.x;
        const dy = edge.target.y - edge.source.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const force = ((distance - settings.linkDistance) / distance) * settings.linkForce * 0.06 * alpha;
        const fx = dx * force;
        const fy = dy * force;
        edge.source.vx += fx;
        edge.source.vy += fy;
        edge.target.vx -= fx;
        edge.target.vy -= fy;
      }
      for (const node of nodes) {
        if (node.fixed) {
          node.vx = 0;
          node.vy = 0;
          continue;
        }
        // Strong enough that an unlinked note drifts to the edge rather than
        // off into space, which would make the whole graph zoom out to nothing.
        node.vx -= node.x * settings.centerForce * 0.12 * alpha;
        node.vy -= node.y * settings.centerForce * 0.12 * alpha;
        node.vx *= 0.82;
        node.vy *= 0.82;
        node.x += node.vx;
        node.y += node.vy;
      }
      alphaRef.current = alpha * 0.985;
      if (!fittedRef.current && alphaRef.current <= 0.06) {
        fittedRef.current = true;
        fitToView();
      }
    }
    draw();
    frameRef.current = requestAnimationFrame(step);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.centerForce, settings.linkDistance, settings.linkForce, settings.repelForce]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
      canvas.width = width * ratio;
      canvas.height = height * ratio;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const view = viewRef.current;
    context.save();
    context.translate(width / 2 + view.x, height / 2 + view.y);
    context.scale(view.scale, view.scale);

    const query = filter.trim().toLowerCase();
    const matches = (node: Simulated) => !query || node.label.toLowerCase().includes(query);
    const hover = hoverRef.current;
    const near = new Set<string>();
    if (hover) {
      near.add(hover.id);
      for (const edge of edgesRef.current) {
        if (edge.source.id === hover.id) near.add(edge.target.id);
        if (edge.target.id === hover.id) near.add(edge.source.id);
      }
    }

    context.lineWidth = Math.max(0.4, settings.linkThickness * 0.7);
    for (const edge of edgesRef.current) {
      const active = !hover || near.has(edge.source.id) || near.has(edge.target.id);
      context.strokeStyle = active ? 'rgba(150,160,180,0.45)' : 'rgba(120,130,150,0.10)';
      context.beginPath();
      context.moveTo(edge.source.x, edge.source.y);
      context.lineTo(edge.target.x, edge.target.y);
      context.stroke();
      if (settings.showArrows && active) drawArrow(context, edge.source, edge.target);
    }

    const zoom = view.scale * settings.textFadeThreshold;
    const showText = zoom >= 0.45;
    for (const node of nodesRef.current) {
      const radius = (3.2 + Math.sqrt(node.links) * 2.1) * settings.nodeSize;
      const dim = (hover && !near.has(node.id)) || !matches(node);
      context.globalAlpha = dim ? 0.22 : 1;
      context.fillStyle =
        node.id === focus ? accent : node.id === hover?.id ? accent : COLORS[node.kind];
      context.beginPath();
      context.arc(node.x, node.y, radius, 0, Math.PI * 2);
      context.fill();
      if (node.kind === 'unresolved') {
        context.strokeStyle = 'rgba(200,205,220,0.35)';
        context.lineWidth = 1;
        context.stroke();
      }
      if (showText && !dim) {
        context.globalAlpha = Math.max(0.25, Math.min(1, (zoom - 0.4) * 3));
        context.fillStyle = 'rgba(214,220,232,0.92)';
        context.font = `${11 / Math.max(0.7, view.scale)}px -apple-system, system-ui, sans-serif`;
        context.textAlign = 'center';
        context.fillText(node.label, node.x, node.y + radius + 11 / Math.max(0.7, view.scale));
      }
      context.globalAlpha = 1;
    }
    context.restore();
  }, [accent, filter, focus, settings.linkThickness, settings.nodeSize, settings.showArrows, settings.textFadeThreshold]);

  useEffect(() => {
    frameRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameRef.current);
  }, [step]);

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const view = viewRef.current;
    return {
      x: (clientX - rect.left - rect.width / 2 - view.x) / view.scale,
      y: (clientY - rect.top - rect.height / 2 - view.y) / view.scale,
    };
  }, []);

  const nodeAt = useCallback(
    (clientX: number, clientY: number): Simulated | null => {
      const point = toWorld(clientX, clientY);
      let best: Simulated | null = null;
      let bestDistance = Infinity;
      for (const node of nodesRef.current) {
        const radius = (3.2 + Math.sqrt(node.links) * 2.1) * settings.nodeSize + 5;
        const distance = Math.hypot(node.x - point.x, node.y - point.y);
        if (distance < radius && distance < bestDistance) {
          best = node;
          bestDistance = distance;
        }
      }
      return best;
    },
    [settings.nodeSize, toWorld],
  );

  return (
    <div className={`graph-view${compact ? ' is-compact' : ''}`}>
      <canvas
        ref={canvasRef}
        className="graph-canvas"
        onMouseDown={(event) => {
          const node = nodeAt(event.clientX, event.clientY);
          dragRef.current = {
            node,
            panning: !node,
            lastX: event.clientX,
            lastY: event.clientY,
          };
          if (node) {
            node.fixed = true;
            alphaRef.current = Math.max(alphaRef.current, 0.35);
          }
        }}
        onMouseMove={(event) => {
          const drag = dragRef.current;
          if (drag.node) {
            const point = toWorld(event.clientX, event.clientY);
            drag.node.x = point.x;
            drag.node.y = point.y;
            alphaRef.current = Math.max(alphaRef.current, 0.25);
            return;
          }
          if (drag.panning) {
            viewRef.current.x += event.clientX - drag.lastX;
            viewRef.current.y += event.clientY - drag.lastY;
            drag.lastX = event.clientX;
            drag.lastY = event.clientY;
            return;
          }
          const hover = nodeAt(event.clientX, event.clientY);
          if (hover !== hoverRef.current) {
            hoverRef.current = hover;
            (event.currentTarget as HTMLCanvasElement).style.cursor = hover ? 'pointer' : 'grab';
          }
        }}
        onMouseUp={(event) => {
          const drag = dragRef.current;
          if (drag.node) {
            const moved =
              Math.abs(event.clientX - drag.lastX) > 3 || Math.abs(event.clientY - drag.lastY) > 3;
            if (drag.node.id !== focus) drag.node.fixed = false;
            if (!moved && drag.node.kind === 'note') {
              onOpen(drag.node.id, event.metaKey || event.ctrlKey);
            }
          }
          dragRef.current = { node: null, panning: false, lastX: 0, lastY: 0 };
        }}
        onMouseLeave={() => {
          dragRef.current = { node: null, panning: false, lastX: 0, lastY: 0 };
          hoverRef.current = null;
        }}
        onWheel={(event) => {
          const view = viewRef.current;
          const factor = Math.exp(-event.deltaY * 0.0016);
          view.scale = Math.min(6, Math.max(0.12, view.scale * factor));
        }}
      />

      {!compact ? (
        <div className="graph-controls">
          <input
            className="graph-filter"
            placeholder="Filter…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <button className="ghost" onClick={() => setShowControls((v) => !v)} type="button">
            {showControls ? 'Hide settings' : 'Settings'}
          </button>
          <button
            className="ghost"
            type="button"
            onClick={() => {
              alphaRef.current = 1;
              fittedRef.current = false;
            }}
          >
            Reset
          </button>
          {showControls ? (
            <div className="graph-panel">
              <Toggle
                label="Tags"
                value={settings.showTags}
                onChange={(v) => onSettings({ showTags: v })}
              />
              <Toggle
                label="Attachments"
                value={settings.showAttachments}
                onChange={(v) => onSettings({ showAttachments: v })}
              />
              <Toggle
                label="Existing files only"
                value={!settings.showUnresolved}
                onChange={(v) => onSettings({ showUnresolved: !v })}
              />
              <Toggle
                label="Arrows"
                value={settings.showArrows}
                onChange={(v) => onSettings({ showArrows: v })}
              />
              <Slider
                label="Node size"
                min={0.3}
                max={3}
                step={0.1}
                value={settings.nodeSize}
                onChange={(v) => onSettings({ nodeSize: v })}
              />
              <Slider
                label="Link distance"
                min={20}
                max={220}
                step={5}
                value={settings.linkDistance}
                onChange={(v) => onSettings({ linkDistance: v })}
              />
              <Slider
                label="Repel"
                min={1}
                max={40}
                step={1}
                value={settings.repelForce}
                onChange={(v) => onSettings({ repelForce: v })}
              />
              <Slider
                label="Centre"
                min={0}
                max={1}
                step={0.02}
                value={settings.centerForce}
                onChange={(v) => onSettings({ centerForce: v })}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {graph.nodes.length === 0 ? (
        <div className="graph-empty">Nothing to draw yet — link a couple of notes with [[…]].</div>
      ) : null}
    </div>
  );
}

function drawArrow(
  context: CanvasRenderingContext2D,
  source: { x: number; y: number },
  target: { x: number; y: number },
): void {
  const angle = Math.atan2(target.y - source.y, target.x - source.x);
  const distance = Math.hypot(target.x - source.x, target.y - source.y);
  if (distance < 14) return;
  const tipX = target.x - Math.cos(angle) * 7;
  const tipY = target.y - Math.sin(angle) * 7;
  context.beginPath();
  context.moveTo(tipX, tipY);
  context.lineTo(tipX - Math.cos(angle - 0.4) * 6, tipY - Math.sin(angle - 0.4) * 6);
  context.lineTo(tipX - Math.cos(angle + 0.4) * 6, tipY - Math.sin(angle + 0.4) * 6);
  context.closePath();
  context.fill();
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange(next: boolean): void;
}) {
  return (
    <label className="graph-row">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange(next: number): void;
}) {
  return (
    <label className="graph-row">
      <span className="graph-row-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
