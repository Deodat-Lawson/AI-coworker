/**
 * Canvas files, in the JSON Canvas format Obsidian writes (`*.canvas`).
 *
 * Keeping to the published format means a canvas made here opens in Obsidian
 * and vice versa — the file is the interchange, exactly like the markdown.
 */

export type CanvasColor = string; // "1".."6" for the preset palette, or "#rrggbb"

export interface CanvasNodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
}

export interface CanvasTextNode extends CanvasNodeBase {
  type: 'text';
  text: string;
}

export interface CanvasFileNode extends CanvasNodeBase {
  type: 'file';
  file: string;
  subpath?: string;
}

export interface CanvasLinkNode extends CanvasNodeBase {
  type: 'link';
  url: string;
}

export interface CanvasGroupNode extends CanvasNodeBase {
  type: 'group';
  label?: string;
  background?: string;
  backgroundStyle?: 'cover' | 'ratio' | 'repeat';
}

export type CanvasNode = CanvasTextNode | CanvasFileNode | CanvasLinkNode | CanvasGroupNode;

export type CanvasSide = 'top' | 'right' | 'bottom' | 'left';

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: CanvasSide;
  toNode: string;
  toSide?: CanvasSide;
  color?: CanvasColor;
  label?: string;
  fromEnd?: 'none' | 'arrow';
  toEnd?: 'none' | 'arrow';
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export function emptyCanvas(): CanvasData {
  return { nodes: [], edges: [] };
}

export function parseCanvas(raw: string): CanvasData {
  try {
    const data = JSON.parse(raw) as Partial<CanvasData>;
    return { nodes: data.nodes ?? [], edges: data.edges ?? [] };
  } catch {
    return emptyCanvas();
  }
}

export function stringifyCanvas(data: CanvasData): string {
  return `${JSON.stringify({ nodes: data.nodes, edges: data.edges }, null, 2)}\n`;
}

/** The six preset colours, matching Obsidian's canvas palette. */
export const CANVAS_COLORS: Record<string, string> = {
  '1': '#e05252',
  '2': '#e0873a',
  '3': '#e0c03a',
  '4': '#4fb06d',
  '5': '#4a9fd6',
  '6': '#a56ed6',
};

export function canvasColor(color: CanvasColor | undefined, fallback: string): string {
  if (!color) return fallback;
  return CANVAS_COLORS[color] ?? color;
}
