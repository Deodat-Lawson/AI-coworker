/**
 * Graph view.
 *
 * A force simulation on a canvas: links pull, nodes push apart, a weak force
 * holds the whole thing near the middle. Local graph is the same simulation run
 * over a breadth-limited neighbourhood of one note.
 *
 * The drawing is where the work is. A graph in one grey is a picture of how many
 * notes you have; it cannot tell you that everything in one corner is a meeting
 * and everything in the other is design, which is the thing you actually wanted
 * to see. So every node belongs to a group — its folder, its first tag, or what
 * kind of thing it is — and the group picks the colour, out of eight hues held
 * at one lightness so no group shouts. A legend says which is which and doubles
 * as a filter: click a colour and the rest of the graph steps back.
 *
 * The other half of Knowledge is drawn in too. Projects, artifacts and tasks are
 * records kept beside the notes, and as three lists they are three words you have
 * to be told the meaning of; as nodes joined to the notes that belong to them, a
 * project is visibly the thing its notes and its artifacts hang off. They get
 * their own colours *and their own shapes* — a diamond, a hexagon, a rounded
 * square against the circles — so the distinction survives being colour-blind,
 * and clicking one goes to its list.
 *
 * Everything else is in service of reading it: nodes of a colour pull towards
 * each other so a folder becomes a place rather than a hue sprinkled through a
 * hairball, and a wash of that colour marks where it ended up; an edge fades from
 * the colour of one end to the colour of the other, so a link between two groups
 * is visible as a link between two groups; labels are placed in order of how much
 * points at them and dropped where they would collide, so a readable few appear
 * instead of an unreadable all; the camera follows the layout while it settles;
 * and a dot grid slides under the whole thing so panning feels like moving over
 * something rather than watching numbers change.
 *
 * Every colour comes from a theme token, read out of the document rather than
 * written here, so the graph follows the app into light mode instead of drawing
 * pale grey labels on white.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type GraphColorBy,
  type GraphEdge,
  type GraphNode,
  type GraphSettings,
  type NoteMeta,
  type VaultFile,
  type ResolverIndex,
  buildGraph,
} from '@ai-coworker/shared';

/** The three structured records the graph can draw beside the notes. */
export type RecordKind = 'project' | 'artifact' | 'task';

/**
 * A node in the graph this view draws, which is the vault's graph plus the
 * records. `GraphNode` stays as the vault defines it — buildGraph has no idea
 * projects exist, and giving it kinds it can never produce would be a lie in the
 * one place that is meant to be the source of truth about a vault.
 */
type NodeKind = GraphNode['kind'] | RecordKind;

interface Node extends Omit<GraphNode, 'kind'> {
  kind: NodeKind;
}

export interface GraphRecords {
  projects: { id: string; name: string; status?: string }[];
  artifacts: { id: string; title: string; projectId?: string }[];
  tasks: { id: string; title: string; projectId?: string; status?: string }[];
  /** Knowledge-base notes, which are how a vault file learns its project. */
  notes: { path?: string; projectId?: string }[];
}

interface Simulated {
  id: string;
  label: string;
  kind: NodeKind;
  links: number;
  /** Which legend entry this node belongs to. */
  group: string;
  colour: string;
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
  /** The projects, artifacts and tasks to draw beside the notes. */
  records?: GraphRecords;
  /** Clicking one of those nodes goes to the list it came from. */
  onOpenRecord?(kind: RecordKind): void;
  /** Set for a local graph: the note at the centre. */
  focus?: string;
  depth?: number;
  compact?: boolean;
  accent: string;
}

/** The tokens the canvas draws with, resolved to literals for this theme. */
interface Palette {
  ramp: string[];
  project: string;
  artifact: string;
  task: string;
  tag: string;
  unresolved: string;
  attachment: string;
  link: string;
  linkDim: string;
  label: string;
  labelHalo: string;
  grid: string;
  core: string;
}

const RAMP_TOKENS = [
  '--graph-1',
  '--graph-2',
  '--graph-3',
  '--graph-4',
  '--graph-5',
  '--graph-6',
  '--graph-7',
  '--graph-8',
];

/**
 * How far back everything the question is not about steps.
 *
 * Far enough to answer "which of these is connected to the one I am pointing at",
 * not so far that the rest of the graph disappears and you lose your place in it.
 */
const DIM = 0.28;

/** Labels are drawn at this size on screen at every zoom level. */
const LABEL_PX = 11;
const LABEL_FONT = '-apple-system, system-ui, sans-serif';

/** Only ever reached if the stylesheet failed to load, which is not a thing that
 *  happens — but a canvas handed an empty string draws nothing at all, whereas a
 *  canvas handed a colour draws a graph. */
const RAMP_FALLBACK = ['#6fa8ff', '#3fc9b2', '#6ed36a', '#e3b23c', '#ef8a54', '#f2789c', '#ad8bf5', '#8bd0e8'];

/**
 * Read the palette off the document.
 *
 * Watched rather than read once: "match system" means the theme can flip while
 * the graph is on screen, and a canvas does not re-inherit a CSS variable the
 * way a div does — it has to be told.
 */
function usePalette(): Palette {
  const read = useCallback((): Palette => {
    const style = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    return {
      ramp: RAMP_TOKENS.map((name, index) => token(name, RAMP_FALLBACK[index]!)),
      project: token('--graph-project', '#f6c445'),
      artifact: token('--graph-artifact', '#4fd1c5'),
      task: token('--graph-task', '#f78da7'),
      tag: token('--graph-tag', '#a99cd8'),
      unresolved: token('--graph-unresolved', '#464d5e'),
      attachment: token('--graph-attachment', '#7c8598'),
      link: token('--graph-link', 'rgba(150,160,180,0.42)'),
      linkDim: token('--graph-link-dim', 'rgba(120,130,150,0.1)'),
      label: token('--graph-label', 'rgba(214,220,232,0.92)'),
      labelHalo: token('--graph-label-halo', 'rgba(10,12,16,0.82)'),
      grid: token('--graph-grid', 'rgba(255,255,255,0.04)'),
      core: token('--graph-core', 'rgba(255,255,255,0.5)'),
    };
  }, []);

  const [palette, setPalette] = useState<Palette>(read);
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setPalette(read()));
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    return () => observer.disconnect();
  }, [read]);
  return palette;
}

/** The group a node belongs to under the chosen grouping. */
function groupOf(id: string, kind: Simulated['kind'], meta: Record<string, NoteMeta>, colorBy: GraphColorBy): string {
  // A tag, an attachment, or a link to a note that does not exist is not a note
  // and never joins a group of them — grouping those with the folder they happen
  // to be mentioned in would be a colour that means nothing.
  if (kind !== 'note') return kind;
  if (colorBy === 'kind') return 'note';
  if (colorBy === 'tag') {
    const tag = meta[id]?.tags[0];
    return tag ? `#${tag.split('/')[0]}` : '';
  }
  const cut = id.lastIndexOf('/');
  return cut === -1 ? '' : id.slice(0, cut).split('/')[0]!;
}

/**
 * The same colour, at an alpha.
 *
 * Canvas has no `color-mix`, and the cluster fields and haloes need the group's
 * own colour at a few percent. Handles the two forms a CSS custom property can
 * hand back — a hex triple or six, and an `rgb()`/`rgba()` function.
 */
function withAlpha(colour: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour.trim());
  if (hex) {
    const digits = hex[1]!.length === 3 ? [...hex[1]!].map((d) => d + d).join('') : hex[1]!;
    const value = Number.parseInt(digits, 16);
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
  }
  const parts = /^rgba?\(([^)]+)\)$/.exec(colour.trim());
  if (parts) {
    const [r, g, b] = parts[1]!.split(/[,/\s]+/).filter(Boolean).map(Number);
    return `rgba(${r ?? 0}, ${g ?? 0}, ${b ?? 0}, ${alpha})`;
  }
  return colour;
}

/**
 * Splice the structured records into the note graph.
 *
 * The vault graph knows about files. The other half of Knowledge — projects,
 * artifacts, tasks — is stored beside it and, until now, was only ever three
 * lists. Drawn in, a project becomes visibly the thing its notes and its
 * artifacts hang off, and "what is an artifact" stops being a question you have
 * to read an explanation to answer.
 *
 * A note joins a project through the knowledge base rather than through its
 * text: the record carries the `projectId`, and its `path` is the same relative
 * path the vault uses, which is what lets the two halves meet at all.
 */
function withRecords(
  graph: { nodes: Node[]; edges: GraphEdge[] },
  records: GraphRecords | undefined,
): { nodes: Node[]; edges: GraphEdge[] } {
  if (!records) return graph;
  const { projects, artifacts, tasks, notes } = records;
  if (!projects.length && !artifacts.length && !tasks.length) return graph;

  const nodes: Node[] = [...graph.nodes];
  const edges: GraphEdge[] = [...graph.edges];
  const present = new Set(nodes.map((n) => n.id));
  const links = new Map<string, number>();

  const add = (id: string, label: string, kind: NodeKind) => {
    if (present.has(id)) return;
    present.add(id);
    nodes.push({ id, label, kind, links: 0 });
  };
  const connect = (source: string, target: string) => {
    if (!present.has(source) || !present.has(target) || source === target) return;
    edges.push({ source, target });
    links.set(source, (links.get(source) ?? 0) + 1);
    links.set(target, (links.get(target) ?? 0) + 1);
  };

  for (const project of projects) add(`project:${project.id}`, project.name, 'project');
  for (const artifact of artifacts) add(`artifact:${artifact.id}`, artifact.title, 'artifact');
  for (const task of tasks) add(`task:${task.id}`, task.title, 'task');

  for (const artifact of artifacts) {
    if (artifact.projectId) connect(`artifact:${artifact.id}`, `project:${artifact.projectId}`);
  }
  for (const task of tasks) {
    if (task.projectId) connect(`task:${task.id}`, `project:${task.projectId}`);
  }
  for (const note of notes) {
    if (note.path && note.projectId) connect(note.path, `project:${note.projectId}`);
  }

  // The link count drives node size, so the counts the vault already worked out
  // have to survive being added to rather than being replaced.
  return {
    nodes: nodes.map((node) =>
      links.has(node.id) ? { ...node, links: node.links + links.get(node.id)! } : node,
    ),
    edges,
  };
}

/** What a group is called in the legend. */
function groupLabel(group: string, colorBy: GraphColorBy): string {
  if (group === 'project') return 'Projects';
  if (group === 'artifact') return 'Artifacts';
  if (group === 'task') return 'Tasks';
  if (group === 'tag') return 'Tags';
  if (group === 'attachment') return 'Attachments';
  if (group === 'unresolved') return 'Not written yet';
  if (group === 'note') return 'Notes';
  if (group !== '') return group;
  return colorBy === 'tag' ? 'Untagged' : 'Top level';
}

export default function GraphView({
  meta,
  files,
  resolver,
  settings,
  onSettings,
  onOpen,
  records,
  onOpenRecord,
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
  /** False once you have panned, zoomed or dragged: the camera stops steering. */
  const autoFrameRef = useRef(true);
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
  /** A legend entry clicked: everything outside it steps back. */
  const [isolated, setIsolated] = useState<string | null>(null);

  const palette = usePalette();
  const colorBy: GraphColorBy = settings.colorBy ?? 'folder';

  const graph = useMemo(() => {
    const built = buildGraph(meta, files, resolver, {
      showAttachments: settings.showAttachments,
      showTags: settings.showTags,
      showUnresolved: settings.showUnresolved,
    });
    const full = settings.showRecords === false ? built : withRecords(built, records);
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
  }, [
    depth,
    files,
    focus,
    meta,
    records,
    resolver,
    settings.showAttachments,
    settings.showRecords,
    settings.showTags,
    settings.showUnresolved,
  ]);

  /**
   * Group every node, then hand the ramp out.
   *
   * Biggest group first so the most of the graph gets the first hue, and ties
   * broken by name so the same vault comes back the same colours next time —
   * a graph that reshuffles its palette on every reload is unreadable even
   * though every individual frame looks fine.
   */
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of graph.nodes) {
      const group = groupOf(node.id, node.kind, meta, colorBy);
      counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    // Not groups of notes, so never given a hue out of the ramp, and always
    // listed after the groups that are.
    const fixed: Record<string, string> = {
      project: palette.project,
      artifact: palette.artifact,
      task: palette.task,
      tag: palette.tag,
      attachment: palette.attachment,
      unresolved: palette.unresolved,
    };
    const ranked = [...counts.keys()]
      .filter((group) => !(group in fixed))
      .sort((a, b) => (counts.get(b)! - counts.get(a)!) || a.localeCompare(b));
    const colours = new Map<string, string>();
    ranked.forEach((group, index) => {
      colours.set(group, palette.ramp[index % palette.ramp.length]!);
    });
    for (const [group, colour] of Object.entries(fixed)) {
      if (counts.has(group)) colours.set(group, colour);
    }
    // The legend follows the same order, with the three non-note kinds last:
    // they are the graph's furniture, not one of its subjects.
    const order = [...ranked, ...Object.keys(fixed).filter((k) => counts.has(k))];
    return {
      colours,
      entries: order.map((group) => ({
        group,
        label: groupLabel(group, colorBy),
        colour: colours.get(group)!,
        count: counts.get(group)!,
      })),
    };
  }, [colorBy, graph.nodes, meta, palette]);

  // Build the simulation, keeping positions of nodes that were already there.
  useEffect(() => {
    const previous = new Map(nodesRef.current.map((n) => [n.id, n]));
    const radius = Math.max(120, Math.sqrt(graph.nodes.length) * 42);
    const nodes = graph.nodes.map((node, index) => {
      const existing = previous.get(node.id);
      const angle = (index / Math.max(1, graph.nodes.length)) * Math.PI * 2;
      const group = groupOf(node.id, node.kind, meta, colorBy);
      return {
        ...node,
        group,
        colour: groups.colours.get(group) ?? palette.attachment,
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
    autoFrameRef.current = true;
  }, [colorBy, focus, graph, groups, meta, palette.attachment]);

  // A group that no longer exists must not keep the rest of the graph dimmed.
  useEffect(() => {
    if (isolated && !groups.colours.has(isolated)) setIsolated(null);
  }, [groups, isolated]);

  /**
   * How big a node is, in screen pixels — not world units.
   *
   * Zoom moves the nodes apart; it does not grow them. Sizing them in world
   * units instead means the fitted view of a large vault draws every note as a
   * two-pixel speck with a label too small to read, and the size of a dot ends
   * up telling you about the zoom rather than about the note. In screen pixels a
   * node is always a node, and the only thing that changes with zoom is how much
   * room there is between them.
   */
  const screenRadiusOf = useCallback(
    (node: Simulated) => (5.2 + Math.sqrt(node.links) * 3) * settings.nodeSize,
    [settings.nodeSize],
  );

  /**
   * Keep the camera on the graph while the graph is still moving.
   *
   * Framing it once, the moment the simulation looked settled, is not enough:
   * the cluster force goes on gathering nodes for a while after that, so a graph
   * framed early ends up as a small knot in the middle of an empty canvas. So
   * the view eases towards the fit every frame instead, which also means opening
   * the graph *shows* it settling and framing itself rather than cutting to a
   * finished picture.
   *
   * It stops the instant you touch anything. Nobody wants the camera arguing
   * with them about where to look.
   */
  const easeToFit = useCallback(() => {
    const canvas = canvasRef.current;
    const nodes = nodesRef.current;
    if (!canvas || nodes.length === 0) return;

    // What has to fit is the labels, not the dots. A node is a few pixels wide
    // and its name is a hundred, so framing the dots is how "2026-08-06 Design
    // crit" ends up as "…6 Design crit" against the left edge.
    //
    // The arithmetic is done in screen pixels rather than world units on
    // purpose. A label is drawn at a fixed size on screen, so in world units it
    // *shrinks as you zoom in* — measure the box in world units and every zoom
    // step makes the box look smaller, which invites another zoom step, and the
    // camera runs itself all the way to the stops. In screen space the label is
    // a constant and the fit has one stable answer.
    const context = canvas.getContext('2d');
    if (context) context.font = `${LABEL_PX}px ${LABEL_FONT}`;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      if (node.x < minX) minX = node.x;
      if (node.x > maxX) maxX = node.x;
      if (node.y < minY) minY = node.y;
      if (node.y > maxY) maxY = node.y;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    // Everything below is screen pixels against world distances, which is what
    // the scale converts between: `scale * dx` is how far from the centre a node
    // lands on screen, and it plus the node and its label has to stay inside.
    const halfWidth = Math.max(40, canvas.clientWidth / 2 - 18);
    const halfHeight = Math.max(40, canvas.clientHeight / 2 - 18);
    let scale = 1.6;
    for (const node of nodes) {
      const radius = screenRadiusOf(node);
      const dx = Math.abs(node.x - cx);
      const dy = Math.abs(node.y - cy);
      const halfLabel = context ? context.measureText(node.label).width / 2 : 0;
      // A label wider than the pane cannot be helped by zooming out, so it is
      // allowed to overhang rather than shrinking the whole graph to nothing.
      const reach = Math.min(Math.max(radius, halfLabel), halfWidth * 0.8);
      if (dx > 0.5) scale = Math.min(scale, (halfWidth - reach) / dx);
      if (dy > 0.5) scale = Math.min(scale, (halfHeight - radius - LABEL_PX * 1.7) / dy);
    }
    const target = Math.min(1.6, Math.max(0.15, scale));

    const view = viewRef.current;
    // Nine per cent a frame: fast enough to keep up with a settling layout,
    // slow enough that it reads as the camera following rather than jumping.
    const ease = 0.09;
    view.scale += (target - view.scale) * ease;
    view.x += (-cx * view.scale - view.x) * ease;
    view.y += (-cy * view.scale - view.y) * ease;
  }, [screenRadiusOf]);

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
    const query = filter.trim().toLowerCase();
    const hover = hoverRef.current;
    const nodes = nodesRef.current;
    const edges = edgesRef.current;

    // What is being asked about: a hovered node and its neighbours, a text
    // filter, an isolated group. Anything else is drawn stepped back rather than
    // hidden, so the shape of the whole graph survives the question.
    const near = new Set<string>();
    if (hover) {
      near.add(hover.id);
      for (const edge of edges) {
        if (edge.source.id === hover.id) near.add(edge.target.id);
        if (edge.target.id === hover.id) near.add(edge.source.id);
      }
    }
    const lit = (node: Simulated) =>
      (!hover || near.has(node.id)) &&
      (!query || node.label.toLowerCase().includes(query)) &&
      (!isolated || node.group === isolated);

    context.save();
    context.translate(width / 2 + view.x, height / 2 + view.y);
    context.scale(view.scale, view.scale);

    if (!compact) drawGrid(context, width, height, view, palette.grid);

    // --- cluster fields ------------------------------------------------------
    // A wash of the group's own colour where its nodes are. This is what turns
    // a set of coloured dots into regions you can name from across the room —
    // and it is drawn from the live positions, so it is always the truth about
    // where the group is rather than a label somebody placed once.
    if (!compact && (settings.clusterForce ?? 0) > 0) {
      const fields = new Map<string, { x: number; y: number; n: number; colour: string }>();
      for (const node of nodes) {
        const field = fields.get(node.group);
        if (field) {
          field.x += node.x;
          field.y += node.y;
          field.n += 1;
        } else {
          fields.set(node.group, { x: node.x, y: node.y, n: 1, colour: node.colour });
        }
      }
      if (fields.size > 1) {
        for (const [group, field] of fields) {
          if (field.n < 2) continue;
          const cx = field.x / field.n;
          const cy = field.y / field.n;
          let spread = 0;
          for (const node of nodes) {
            if (node.group !== group) continue;
            spread = Math.max(spread, Math.hypot(node.x - cx, node.y - cy));
          }
          const reach = spread + 46;
          const strength = isolated && isolated !== group ? 0.03 : 0.1;
          const wash = context.createRadialGradient(cx, cy, 0, cx, cy, reach);
          wash.addColorStop(0, withAlpha(field.colour, strength));
          wash.addColorStop(0.62, withAlpha(field.colour, strength * 0.45));
          wash.addColorStop(1, withAlpha(field.colour, 0));
          context.fillStyle = wash;
          context.beginPath();
          context.arc(cx, cy, reach, 0, Math.PI * 2);
          context.fill();
        }
      }
    }

    // --- edges ---------------------------------------------------------------
    // Fading from one end's colour to the other is what makes a link between two
    // groups legible as one. Below the gradient threshold — a vault big enough
    // that per-edge gradients would cost more than they are worth — the flat
    // link colour takes over and the picture still reads.
    const gradients = edges.length <= 600;
    // Screen pixels again: a hairline that thins as you zoom out is a graph
    // that loses its edges exactly when you are looking at all of them.
    context.lineWidth = Math.max(0.6, settings.linkThickness * 1.15) / view.scale;
    context.lineCap = 'round';
    for (const edge of edges) {
      const active = lit(edge.source) || lit(edge.target);
      if (!active) {
        context.strokeStyle = palette.linkDim;
      } else if (gradients) {
        const gradient = context.createLinearGradient(edge.source.x, edge.source.y, edge.target.x, edge.target.y);
        gradient.addColorStop(0, edge.source.colour);
        gradient.addColorStop(1, edge.target.colour);
        context.strokeStyle = gradient;
        context.globalAlpha = hover ? 0.85 : 0.6;
      } else {
        context.strokeStyle = palette.link;
      }
      context.beginPath();
      context.moveTo(edge.source.x, edge.source.y);
      context.lineTo(edge.target.x, edge.target.y);
      context.stroke();
      context.globalAlpha = 1;
      if (settings.showArrows && active) {
        context.fillStyle = palette.link;
        drawArrow(context, edge.source, edge.target, screenRadiusOf(edge.target) / view.scale);
      }
    }

    // --- nodes ---------------------------------------------------------------
    const shaded = nodes.length <= 400;
    const zoom = view.scale * settings.textFadeThreshold;
    // Low, because the label pass below drops anything that would collide: the
    // number of labels regulates itself, so the zoom threshold only has to catch
    // the point where even the surviving ones are pointless. It used to be high
    // enough that the fitted view of any real vault had no labels at all.
    const showText = zoom >= 0.2;
    // A ring that breathes, so the note the local graph is about is obviously
    // the one in the middle.
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 620);

    for (const node of nodes) {
      // Screen pixels, converted back to world units for the canvas transform.
      const radius = screenRadiusOf(node) / view.scale;
      const bright = lit(node);
      const isHover = node.id === hover?.id;
      const isFocus = node.id === focus;
      context.globalAlpha = bright ? 1 : DIM;

      if (isFocus) {
        context.strokeStyle = accent;
        context.globalAlpha = (bright ? 0.5 : DIM) * (0.35 + pulse * 0.65);
        context.lineWidth = 2 / view.scale;
        context.beginPath();
        context.arc(node.x, node.y, radius + (4 + pulse * 3) / view.scale, 0, Math.PI * 2);
        context.stroke();
        context.globalAlpha = bright ? 1 : DIM;
      }

      // The halo. Earned by being hovered, being the focus, or being one of the
      // notes everything else points at.
      if (bright && (isHover || isFocus || node.links >= 6)) {
        context.shadowColor = isFocus ? accent : node.colour;
        context.shadowBlur = (isHover ? 18 : 12) / view.scale;
      }

      const fill = isFocus ? accent : node.colour;
      if (shaded && screenRadiusOf(node) > 3.5) {
        const shade = context.createRadialGradient(
          node.x - radius * 0.34,
          node.y - radius * 0.4,
          radius * 0.08,
          node.x,
          node.y,
          radius * 1.04,
        );
        shade.addColorStop(0, palette.core);
        shade.addColorStop(0.42, fill);
        shade.addColorStop(1, fill);
        context.fillStyle = shade;
      } else {
        context.fillStyle = fill;
      }
      nodePath(context, node.kind, node.x, node.y, radius);
      context.fill();
      context.shadowBlur = 0;

      // A note that does not exist yet is drawn as the outline of one.
      if (node.kind === 'unresolved') {
        context.globalAlpha = bright ? 0.85 : DIM;
        context.strokeStyle = palette.unresolved;
        context.lineWidth = 1.2 / view.scale;
        nodePath(context, node.kind, node.x, node.y, radius + 1.5 / view.scale);
        context.stroke();
      }

      context.globalAlpha = 1;
    }

    // --- labels --------------------------------------------------------------
    // A second pass, so a name is never half-covered by a node drawn after it,
    // and so the ones that fit can be chosen.
    //
    // Every node having a label is not the same as every label being readable:
    // at any zoom where the whole graph is visible, the names collide into a
    // grey mush and the graph stops being worth looking at. So labels are placed
    // in order of how much points at the note, and one that would land on top of
    // a label already placed is dropped. Zoom in and the collisions resolve
    // themselves, which is the honest way for detail to arrive; hover, and the
    // one you asked about is drawn whatever it lands on.
    const size = LABEL_PX / view.scale;
    context.font = `400 ${size}px ${LABEL_FONT}`;
    context.textAlign = 'center';
    context.textBaseline = 'top';
    context.lineJoin = 'round';
    const placed: { left: number; right: number; top: number; bottom: number }[] = [];
    const ordered = [...nodes].sort((a, b) => b.links - a.links);
    if (hover) ordered.unshift(hover);
    for (const node of ordered) {
      const isHover = node.id === hover?.id;
      const bright = lit(node);
      if (!isHover && (!showText || !bright)) continue;
      const radius = screenRadiusOf(node) / view.scale;
      const y = node.y + radius + size * 0.42;
      const half = context.measureText(node.label).width / 2;
      const box = {
        left: node.x - half,
        right: node.x + half,
        top: y,
        bottom: y + size * 1.15,
      };
      if (!isHover) {
        const clash = placed.some(
          (other) =>
            box.left < other.right &&
            box.right > other.left &&
            box.top < other.bottom &&
            box.bottom > other.top,
        );
        if (clash) continue;
      }
      placed.push(box);
      context.globalAlpha = isHover ? 1 : Math.max(0.45, Math.min(1, (zoom - 0.4) * 3));
      context.font = `${isHover ? 600 : 400} ${size}px ${LABEL_FONT}`;
      // Outlined in the page colour first, so a label crossing a link stays
      // readable instead of being cut in half by it.
      context.lineWidth = 3 / view.scale;
      context.strokeStyle = palette.labelHalo;
      context.strokeText(node.label, node.x, y);
      context.fillStyle = palette.label;
      context.fillText(node.label, node.x, y);
      context.globalAlpha = 1;
    }
    context.restore();
  }, [
    accent,
    compact,
    filter,
    focus,
    isolated,
    palette,
    screenRadiusOf,
    settings.clusterForce,
    settings.linkThickness,
    settings.showArrows,
    settings.textFadeThreshold,
  ]);

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
      // Same colour, same neighbourhood. Each group is pulled towards its own
      // centre of mass, which turns the colours into places: folders end up as
      // visible lobes instead of a hue sprinkled evenly through one hairball.
      // Links still decide the fine structure — this only decides where the
      // clusters sit relative to each other.
      const cluster = settings.clusterForce ?? 0;
      if (cluster > 0) {
        const centres = new Map<string, { x: number; y: number; n: number }>();
        for (const node of nodes) {
          const centre = centres.get(node.group);
          if (centre) {
            centre.x += node.x;
            centre.y += node.y;
            centre.n += 1;
          } else {
            centres.set(node.group, { x: node.x, y: node.y, n: 1 });
          }
        }
        if (centres.size > 1) {
          for (const node of nodes) {
            const centre = centres.get(node.group)!;
            // A group of one has no cluster to join, and pulling it towards
            // itself would just pin it wherever it landed.
            if (centre.n < 2) continue;
            node.vx += (centre.x / centre.n - node.x) * cluster * 0.045 * alpha;
            node.vy += (centre.y / centre.n - node.y) * cluster * 0.045 * alpha;
          }
        }
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
      if (autoFrameRef.current) easeToFit();
    }
    draw();
    frameRef.current = requestAnimationFrame(step);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    draw,
    settings.centerForce,
    settings.clusterForce,
    settings.linkDistance,
    settings.linkForce,
    settings.repelForce,
  ]);

  useEffect(() => {
    frameRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameRef.current);
  }, [step]);

  // Dragging the sidebar wider, or splitting the pane, changes what fits. Waking
  // the simulation is enough to re-frame: the camera only steers while the layout
  // is alive, and at this alpha nothing actually moves.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (autoFrameRef.current) alphaRef.current = Math.max(alphaRef.current, 0.05);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

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
        // Generous by five screen pixels, which is what makes a small node
        // clickable without having to zoom in on it first.
        const radius = (screenRadiusOf(node) + 5) / viewRef.current.scale;
        const distance = Math.hypot(node.x - point.x, node.y - point.y);
        if (distance < radius && distance < bestDistance) {
          best = node;
          bestDistance = distance;
        }
      }
      return best;
    },
    [screenRadiusOf, toWorld],
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
          autoFrameRef.current = false;
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
            } else if (
              !moved &&
              (drag.node.kind === 'project' ||
                drag.node.kind === 'artifact' ||
                drag.node.kind === 'task')
            ) {
              // A record node is a way into the list it came from, which is what
              // makes the graph navigation rather than a picture of one.
              onOpenRecord?.(drag.node.kind);
            }
          }
          dragRef.current = { node: null, panning: false, lastX: 0, lastY: 0 };
        }}
        onMouseLeave={() => {
          dragRef.current = { node: null, panning: false, lastX: 0, lastY: 0 };
          hoverRef.current = null;
        }}
        onWheel={(event) => {
          autoFrameRef.current = false;
          const view = viewRef.current;
          const factor = Math.exp(-event.deltaY * 0.0016);
          view.scale = Math.min(6, Math.max(0.12, view.scale * factor));
        }}
      />

      {!compact ? (
        <>
          <div className="graph-controls">
            <input
              className="graph-filter"
              placeholder="Filter…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <button
              className={showControls ? 'graph-btn is-on' : 'graph-btn'}
              onClick={() => setShowControls((v) => !v)}
              type="button"
            >
              Settings
            </button>
            <button
              className="graph-btn"
              type="button"
              title="Re-run the layout and frame it"
              onClick={() => {
                alphaRef.current = 1;
                autoFrameRef.current = true;
              }}
            >
              Re-lay out
            </button>
            {showControls ? (
              <div className="graph-panel">
                <div className="graph-section">Colour by</div>
                <div className="graph-segment">
                  {(['folder', 'tag', 'kind'] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={colorBy === option ? 'is-on' : undefined}
                      onClick={() => onSettings({ colorBy: option })}
                    >
                      {option}
                    </button>
                  ))}
                </div>

                <div className="graph-section">Show</div>
                <Toggle
                  label="Projects, artifacts and tasks"
                  value={settings.showRecords !== false}
                  onChange={(v) => onSettings({ showRecords: v })}
                />
                <Toggle label="Tags" value={settings.showTags} onChange={(v) => onSettings({ showTags: v })} />
                <Toggle
                  label="Attachments"
                  value={settings.showAttachments}
                  onChange={(v) => onSettings({ showAttachments: v })}
                />
                <Toggle
                  label="Notes not written yet"
                  value={settings.showUnresolved}
                  onChange={(v) => onSettings({ showUnresolved: v })}
                />
                <Toggle label="Arrows" value={settings.showArrows} onChange={(v) => onSettings({ showArrows: v })} />

                <div className="graph-section">Forces</div>
                <Slider
                  label="Cluster"
                  min={0}
                  max={1}
                  step={0.05}
                  value={settings.clusterForce ?? 0.5}
                  onChange={(v) => {
                    onSettings({ clusterForce: v });
                    // A force this structural changes the whole shape, so wake
                    // the simulation up rather than nudging a settled layout.
                    alphaRef.current = Math.max(alphaRef.current, 0.6);
                    autoFrameRef.current = true;
                  }}
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
                  label="Link length"
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

          {/* The key to the colours, and a filter: click a group to hold the
              graph still around it. Without this the colours are decoration. */}
          {groups.entries.length > 1 ? (
            <div className="graph-legend">
              <div className="graph-legend-head">
                {colorBy === 'folder' ? 'By folder' : colorBy === 'tag' ? 'By tag' : 'By kind'}
                {isolated ? (
                  <button className="graph-legend-clear" type="button" onClick={() => setIsolated(null)}>
                    show all
                  </button>
                ) : null}
              </div>
              {groups.entries.map((entry) => (
                <button
                  key={entry.group}
                  type="button"
                  className={`graph-legend-row${isolated === entry.group ? ' is-on' : ''}`}
                  onClick={() => setIsolated(isolated === entry.group ? null : entry.group)}
                  title={`Show only ${entry.label}`}
                >
                  <span className="graph-swatch" style={{ background: entry.colour }} />
                  <span className="graph-legend-label">{entry.label}</span>
                  <span className="graph-legend-count">{entry.count}</span>
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {graph.nodes.length === 0 ? (
        <div className="graph-empty">Nothing to draw yet — link a couple of notes with [[…]].</div>
      ) : null}
    </div>
  );
}

/**
 * The outline of a node.
 *
 * Records are not notes, and saying so with colour alone leaves the distinction
 * invisible to anyone who cannot separate amber from blue — and hard to hold on
 * to for everyone else, since a legend is across the pane from the node you are
 * looking at. So a note is a circle, a project is a diamond, an artifact is a
 * hexagon and a task is a rounded square, and the shape carries the same fact
 * the colour does.
 */
function nodePath(
  context: CanvasRenderingContext2D,
  kind: NodeKind,
  x: number,
  y: number,
  r: number,
): void {
  context.beginPath();
  if (kind === 'project') {
    // A diamond of the same visual weight as the circle it sits beside.
    const d = r * 1.32;
    context.moveTo(x, y - d);
    context.lineTo(x + d, y);
    context.lineTo(x, y + d);
    context.lineTo(x - d, y);
    context.closePath();
    return;
  }
  if (kind === 'artifact') {
    const d = r * 1.14;
    for (let i = 0; i < 6; i += 1) {
      const angle = (Math.PI / 3) * i - Math.PI / 2;
      const px = x + Math.cos(angle) * d;
      const py = y + Math.sin(angle) * d;
      if (i === 0) context.moveTo(px, py);
      else context.lineTo(px, py);
    }
    context.closePath();
    return;
  }
  if (kind === 'task') {
    const d = r * 1.02;
    const radius = Math.min(d * 0.42, d);
    context.roundRect(x - d, y - d, d * 2, d * 2, radius);
    return;
  }
  context.arc(x, y, r, 0, Math.PI * 2);
}

/**
 * The dot grid under everything.
 *
 * Panning a plain black canvas gives you nothing to hold on to; a grid moving
 * under the graph is what makes it feel like a surface. The step is quantised to
 * powers of two so it doubles instead of breathing as you zoom, and it is drawn
 * in world space so it moves with the graph rather than under it.
 */
function drawGrid(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  view: { x: number; y: number; scale: number },
  colour: string,
): void {
  const base = 60;
  const step = base * 2 ** Math.round(Math.log2(30 / (base * view.scale)));
  // A dot that is a device pixel is invisible; one and a half is a texture.
  const dot = 1.4 / view.scale;
  const left = (-width / 2 - view.x) / view.scale;
  const top = (-height / 2 - view.y) / view.scale;
  const right = left + width / view.scale;
  const bottom = top + height / view.scale;
  context.fillStyle = colour;
  for (let x = Math.ceil(left / step) * step; x < right; x += step) {
    for (let y = Math.ceil(top / step) * step; y < bottom; y += step) {
      context.fillRect(x, y, dot, dot);
    }
  }
}

function drawArrow(
  context: CanvasRenderingContext2D,
  source: { x: number; y: number },
  target: { x: number; y: number },
  clear: number,
): void {
  const angle = Math.atan2(target.y - source.y, target.x - source.x);
  const distance = Math.hypot(target.x - source.x, target.y - source.y);
  if (distance < clear + 10) return;
  // Landing on the edge of the node rather than inside it, so the head is not
  // half-swallowed by whatever it is pointing at.
  const tipX = target.x - Math.cos(angle) * (clear + 2);
  const tipY = target.y - Math.sin(angle) * (clear + 2);
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
