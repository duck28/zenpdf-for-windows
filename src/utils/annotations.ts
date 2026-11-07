import { Annotation, CitationAnnotation, Point } from '../types';
import { formatMeasurement } from './tools';

/**
 * Shared annotation geometry.
 *
 * All annotation coordinates are stored in "page units": the pdf.js viewport
 * at scale 1 (page rotation applied, origin top-left, y pointing down).
 * Every annotation is turned into a list of render parts (vector paths and
 * text runs). The canvas preview and the PDF export both draw those same
 * parts, so what you see is what gets saved.
 */

export type PathCmd =
  | { op: 'M'; x: number; y: number }
  | { op: 'L'; x: number; y: number }
  | { op: 'Q'; cx: number; cy: number; x: number; y: number }
  | { op: 'C'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }
  | { op: 'Z' };

export type LineCap = 'round' | 'butt' | 'square';

export interface PathPart {
  kind: 'path';
  cmds: PathCmd[];
  stroke?: { color: string; width: number; cap: LineCap; dash?: number[]; opacity?: number };
  fill?: { color: string; opacity?: number };
  /** Multiply blend (highlighter): text below stays readable. */
  multiply?: boolean;
}

export interface TextPart {
  kind: 'text';
  text: string;
  x: number;
  /** Baseline y. */
  y: number;
  size: number;
  color: string;
  bold?: boolean;
}

export type RenderPart = PathPart | TextPart;

/** Text width in page units for a given size; differs per backend (canvas / PDF font). */
export type MeasureFn = (text: string, size: number, bold?: boolean) => number;

export const TEXT_LINE_HEIGHT = 1.2;
export const TEXT_BASELINE = 0.8; // first baseline offset from top, in em
export const TEXT_FONT = 'Helvetica, Arial, sans-serif';
export const HIGHLIGHT_OPACITY = 0.4;

// ---------------------------------------------------------------- paths
/** Freehand stroke smoothed with quadratic curves through segment midpoints. */
function smoothPath(points: Point[]): PathCmd[] {
  if (points.length === 0) return [];
  const pts = points.length === 1 ? [points[0], { x: points[0].x + 0.01, y: points[0].y }] : points;
  const cmds: PathCmd[] = [{ op: 'M', x: pts[0].x, y: pts[0].y }];
  if (pts.length === 2) {
    cmds.push({ op: 'L', x: pts[1].x, y: pts[1].y });
    return cmds;
  }
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    cmds.push({ op: 'Q', cx: pts[i].x, cy: pts[i].y, x: mx, y: my });
  }
  const last = pts[pts.length - 1];
  cmds.push({ op: 'L', x: last.x, y: last.y });
  return cmds;
}

/**
 * Calligraphic stroke: a flat nib held at 45° swept along the points.
 * Each segment becomes a quad with consistent winding so the union fills
 * cleanly with the nonzero rule.
 */
function nibPath(points: Point[], width: number): PathCmd[] {
  const angle = -Math.PI / 4;
  const nx = (Math.cos(angle) * width) / 2;
  const ny = (Math.sin(angle) * width) / 2;
  const pts = points.length === 1 ? [points[0], { x: points[0].x + 0.01, y: points[0].y }] : points;
  const cmds: PathCmd[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    let quad = [
      { x: a.x + nx, y: a.y + ny },
      { x: b.x + nx, y: b.y + ny },
      { x: b.x - nx, y: b.y - ny },
      { x: a.x - nx, y: a.y - ny },
    ];
    // Shoelace: force positive orientation
    let area = 0;
    for (let k = 0; k < 4; k++) {
      const p = quad[k];
      const q = quad[(k + 1) % 4];
      area += p.x * q.y - q.x * p.y;
    }
    if (area < 0) quad = quad.reverse();
    cmds.push({ op: 'M', x: quad[0].x, y: quad[0].y });
    for (let k = 1; k < 4; k++) cmds.push({ op: 'L', x: quad[k].x, y: quad[k].y });
    cmds.push({ op: 'Z' });
  }
  return cmds;
}

function rectPath(x: number, y: number, w: number, h: number): PathCmd[] {
  return [
    { op: 'M', x, y },
    { op: 'L', x: x + w, y },
    { op: 'L', x: x + w, y: y + h },
    { op: 'L', x, y: y + h },
    { op: 'Z' },
  ];
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number): PathCmd[] {
  const k = 0.5522847498;
  const ox = rx * k;
  const oy = ry * k;
  return [
    { op: 'M', x: cx + rx, y: cy },
    { op: 'C', c1x: cx + rx, c1y: cy + oy, c2x: cx + ox, c2y: cy + ry, x: cx, y: cy + ry },
    { op: 'C', c1x: cx - ox, c1y: cy + ry, c2x: cx - rx, c2y: cy + oy, x: cx - rx, y: cy },
    { op: 'C', c1x: cx - rx, c1y: cy - oy, c2x: cx - ox, c2y: cy - ry, x: cx, y: cy - ry },
    { op: 'C', c1x: cx + ox, c1y: cy - ry, c2x: cx + rx, c2y: cy - oy, x: cx + rx, y: cy },
    { op: 'Z' },
  ];
}

export function arrowHeadLength(strokeWidth: number) {
  return Math.max(10, strokeWidth * 4);
}

const MEASURE_TICK = 6;
const MEASURE_LABEL_SIZE = 9;
const CITE_BADGE_SIZE = 8;

export function textLines(text: string) {
  return text.split(/\r?\n/);
}

/** Label box for a ruler annotation (page units). */
function measureLabel(ann: { x1: number; y1: number; x2: number; y2: number; unit: Parameters<typeof formatMeasurement>[1] }, measure: MeasureFn) {
  const text = formatMeasurement(Math.hypot(ann.x2 - ann.x1, ann.y2 - ann.y1), ann.unit);
  const w = measure(text, MEASURE_LABEL_SIZE, true) + 8;
  const h = MEASURE_LABEL_SIZE + 6;
  const mx = (ann.x1 + ann.x2) / 2;
  const my = (ann.y1 + ann.y2) / 2;
  return { text, x: mx - w / 2, y: my - h - 4, w, h };
}

/** Badge with the footnote number at the top-right of a citation. */
function citeBadge(ann: CitationAnnotation, n: number, measure: MeasureFn) {
  const text = String(n);
  const w = Math.max(measure(text, CITE_BADGE_SIZE, true) + 6, CITE_BADGE_SIZE + 5);
  const h = CITE_BADGE_SIZE + 5;
  return { text, x: ann.x + ann.width + 3, y: ann.y - h / 2, w, h };
}

// --------------------------------------------------------- render parts
export interface PartContext {
  measure: MeasureFn;
  citeNumbers?: Map<string, number>;
}

export function annotationParts(ann: Annotation, ctx: PartContext): RenderPart[] {
  switch (ann.type) {
    case 'pen': {
      const w = ann.width;
      switch (ann.penType ?? 'ballpoint') {
        case 'fountain':
          return [
            { kind: 'path', cmds: nibPath(ann.points, w * 2), fill: { color: ann.color } },
            // Hairline core keeps strokes parallel to the nib from vanishing
            { kind: 'path', cmds: smoothPath(ann.points), stroke: { color: ann.color, width: Math.max(0.4, w * 0.25), cap: 'round' } },
          ];
        case 'marker':
          return [{ kind: 'path', cmds: smoothPath(ann.points), stroke: { color: ann.color, width: w * 1.5, cap: 'square', opacity: 0.85 } }];
        case 'pencil': {
          const jitter = Math.max(0.3, w * 0.25);
          const shifted = ann.points.map((p, i) => ({ x: p.x + (i % 2 ? jitter : -jitter) * 0.5, y: p.y + jitter * 0.5 }));
          return [
            { kind: 'path', cmds: smoothPath(ann.points), stroke: { color: ann.color, width: w * 0.8, cap: 'round', opacity: 0.55 } },
            { kind: 'path', cmds: smoothPath(shifted), stroke: { color: ann.color, width: w * 0.5, cap: 'round', opacity: 0.35 } },
          ];
        }
        case 'dashed':
          return [{ kind: 'path', cmds: smoothPath(ann.points), stroke: { color: ann.color, width: w, cap: 'butt', dash: [w * 3 + 2, w * 2 + 2] } }];
        default:
          return [{ kind: 'path', cmds: smoothPath(ann.points), stroke: { color: ann.color, width: w, cap: 'round', opacity: ann.opacity ?? 1 } }];
      }
    }
    case 'highlighter':
      return [{
        kind: 'path',
        cmds: smoothPath(ann.points),
        stroke: { color: ann.color, width: ann.width, cap: 'butt', opacity: ann.opacity ?? HIGHLIGHT_OPACITY },
        multiply: true,
      }];
    case 'rect':
      return [{
        kind: 'path',
        cmds: rectPath(ann.x, ann.y, ann.width, ann.height),
        stroke: { color: ann.strokeColor, width: ann.strokeWidth, cap: 'round' },
        fill: ann.fillColor ? { color: ann.fillColor } : undefined,
      }];
    case 'circle':
      return [{
        kind: 'path',
        cmds: ellipsePath(ann.x, ann.y, Math.abs(ann.radiusX), Math.abs(ann.radiusY)),
        stroke: { color: ann.strokeColor, width: ann.strokeWidth, cap: 'round' },
        fill: ann.fillColor ? { color: ann.fillColor } : undefined,
      }];
    case 'line':
    case 'arrow': {
      const cmds: PathCmd[] = [
        { op: 'M', x: ann.x1, y: ann.y1 },
        { op: 'L', x: ann.x2, y: ann.y2 },
      ];
      if (ann.type === 'arrow') {
        const angle = Math.atan2(ann.y2 - ann.y1, ann.x2 - ann.x1);
        const len = arrowHeadLength(ann.strokeWidth);
        for (const da of [-Math.PI / 6, Math.PI / 6]) {
          cmds.push({ op: 'M', x: ann.x2, y: ann.y2 });
          cmds.push({ op: 'L', x: ann.x2 - len * Math.cos(angle + da), y: ann.y2 - len * Math.sin(angle + da) });
        }
      }
      return [{ kind: 'path', cmds, stroke: { color: ann.strokeColor, width: ann.strokeWidth, cap: 'round' } }];
    }
    case 'measure': {
      const len = Math.hypot(ann.x2 - ann.x1, ann.y2 - ann.y1) || 1;
      // Perpendicular unit vector for end ticks
      const px = -(ann.y2 - ann.y1) / len;
      const py = (ann.x2 - ann.x1) / len;
      const cmds: PathCmd[] = [
        { op: 'M', x: ann.x1, y: ann.y1 },
        { op: 'L', x: ann.x2, y: ann.y2 },
      ];
      for (const [x, y] of [[ann.x1, ann.y1], [ann.x2, ann.y2]]) {
        cmds.push({ op: 'M', x: x + px * MEASURE_TICK, y: y + py * MEASURE_TICK });
        cmds.push({ op: 'L', x: x - px * MEASURE_TICK, y: y - py * MEASURE_TICK });
      }
      const label = measureLabel(ann, ctx.measure);
      return [
        { kind: 'path', cmds, stroke: { color: ann.strokeColor, width: ann.strokeWidth, cap: 'butt' } },
        {
          kind: 'path',
          cmds: rectPath(label.x, label.y, label.w, label.h),
          fill: { color: '#ffffff', opacity: 0.9 },
          stroke: { color: ann.strokeColor, width: 0.5, cap: 'butt' },
        },
        { kind: 'text', text: label.text, x: label.x + 4, y: label.y + label.h - 4.5, size: MEASURE_LABEL_SIZE, color: ann.strokeColor, bold: true },
      ];
    }
    case 'cite': {
      const parts: RenderPart[] = [
        // Light tint over the marked passage
        { kind: 'path', cmds: rectPath(ann.x, ann.y, ann.width, ann.height), fill: { color: ann.color, opacity: 0.12 }, multiply: true },
        // Margin bracket
        {
          kind: 'path',
          cmds: [
            { op: 'M', x: ann.x - 2, y: ann.y },
            { op: 'L', x: ann.x - 5, y: ann.y },
            { op: 'L', x: ann.x - 5, y: ann.y + ann.height },
            { op: 'L', x: ann.x - 2, y: ann.y + ann.height },
          ],
          stroke: { color: ann.color, width: 1.5, cap: 'butt' },
        },
      ];
      const n = ctx.citeNumbers?.get(ann.id);
      if (n !== undefined) {
        const b = citeBadge(ann, n, ctx.measure);
        const r = b.h / 2;
        parts.push({
          kind: 'path',
          cmds: [
            { op: 'M', x: b.x + r, y: b.y },
            { op: 'L', x: b.x + b.w - r, y: b.y },
            { op: 'Q', cx: b.x + b.w, cy: b.y, x: b.x + b.w, y: b.y + r },
            { op: 'Q', cx: b.x + b.w, cy: b.y + b.h, x: b.x + b.w - r, y: b.y + b.h },
            { op: 'L', x: b.x + r, y: b.y + b.h },
            { op: 'Q', cx: b.x, cy: b.y + b.h, x: b.x, y: b.y + r },
            { op: 'Q', cx: b.x, cy: b.y, x: b.x + r, y: b.y },
            { op: 'Z' },
          ],
          fill: { color: ann.color },
        });
        const tw = ctx.measure(b.text, CITE_BADGE_SIZE, true);
        parts.push({ kind: 'text', text: b.text, x: b.x + (b.w - tw) / 2, y: b.y + b.h - 3, size: CITE_BADGE_SIZE, color: '#ffffff', bold: true });
      }
      return parts;
    }
    case 'text':
      return textLines(ann.text).map((line, i) => ({
        kind: 'text' as const,
        text: line,
        x: ann.x,
        y: ann.y + ann.fontSize * (TEXT_BASELINE + i * TEXT_LINE_HEIGHT),
        size: ann.fontSize,
        color: ann.color,
      }));
  }
}

// ----------------------------------------------------------- footnotes
const FOOTNOTE_SIZE = 8;
const FOOTNOTE_LEADING = 10;
const FOOTNOTE_MARGIN_X = 40;
const FOOTNOTE_MARGIN_BOTTOM = 22;
const FOOTNOTE_INDENT = 12;

function wrapText(text: string, maxWidth: number, size: number, measure: MeasureFn): string[] {
  const out: string[] = [];
  for (const para of textLines(text)) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate, size) <= maxWidth || !line) {
        line = candidate;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * Footnotes for the citations on one page, stacked above the bottom margin
 * on a white panel so they stay legible over existing page content.
 */
export function footnoteParts(
  cites: CitationAnnotation[],
  numbers: Map<string, number>,
  pageWidth: number,
  pageHeight: number,
  measure: MeasureFn
): RenderPart[] {
  const withNotes = cites
    .filter((c) => c.note.trim())
    .sort((a, b) => (numbers.get(a.id) ?? 0) - (numbers.get(b.id) ?? 0));
  if (withNotes.length === 0) return [];

  const maxWidth = pageWidth - FOOTNOTE_MARGIN_X * 2 - FOOTNOTE_INDENT;
  const blocks = withNotes.map((c) => ({
    n: numbers.get(c.id) ?? 0,
    color: c.color,
    lines: wrapText(c.note.trim(), maxWidth, FOOTNOTE_SIZE, measure),
  }));
  const totalLines = blocks.reduce((s, b) => s + b.lines.length, 0);
  const blockHeight = totalLines * FOOTNOTE_LEADING + 8;
  const top = pageHeight - FOOTNOTE_MARGIN_BOTTOM - blockHeight;
  const left = FOOTNOTE_MARGIN_X;

  const parts: RenderPart[] = [
    {
      kind: 'path',
      cmds: rectPath(left - 4, top - 4, pageWidth - 2 * FOOTNOTE_MARGIN_X + 8, blockHeight + 6),
      fill: { color: '#ffffff', opacity: 0.92 },
    },
    {
      kind: 'path',
      cmds: [
        { op: 'M', x: left, y: top },
        { op: 'L', x: left + Math.min(140, (pageWidth - 2 * FOOTNOTE_MARGIN_X) / 3), y: top },
      ],
      stroke: { color: '#475569', width: 0.5, cap: 'butt' },
    },
  ];

  let y = top + 4 + FOOTNOTE_SIZE;
  for (const b of blocks) {
    parts.push({ kind: 'text', text: String(b.n), x: left, y: y - 2, size: FOOTNOTE_SIZE - 1.5, color: b.color, bold: true });
    for (const line of b.lines) {
      parts.push({ kind: 'text', text: line, x: left + FOOTNOTE_INDENT, y, size: FOOTNOTE_SIZE, color: '#1e293b' });
      y += FOOTNOTE_LEADING;
    }
  }
  return parts;
}

// ------------------------------------------------------- canvas backend
let measureCtx: CanvasRenderingContext2D | null = null;
export const canvasMeasure: MeasureFn = (text, size, bold) => {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * size * 0.55;
  measureCtx.font = `${bold ? 'bold ' : ''}${size}px ${TEXT_FONT}`;
  return measureCtx.measureText(text).width;
};

function tracePath(ctx: CanvasRenderingContext2D, cmds: PathCmd[]) {
  ctx.beginPath();
  for (const c of cmds) {
    switch (c.op) {
      case 'M': ctx.moveTo(c.x, c.y); break;
      case 'L': ctx.lineTo(c.x, c.y); break;
      case 'Q': ctx.quadraticCurveTo(c.cx, c.cy, c.x, c.y); break;
      case 'C': ctx.bezierCurveTo(c.c1x, c.c1y, c.c2x, c.c2y, c.x, c.y); break;
      case 'Z': ctx.closePath(); break;
    }
  }
}

/**
 * Draws parts. The context must already be transformed so that one unit
 * equals one page unit. `multiplyCtx` receives the multiply-blended parts
 * (a separate layer with CSS mix-blend-mode: multiply); defaults to `ctx`.
 */
export function drawParts(
  ctx: CanvasRenderingContext2D,
  parts: RenderPart[],
  multiplyCtx: CanvasRenderingContext2D = ctx
) {
  for (const part of parts) {
    const c = part.kind === 'path' && part.multiply ? multiplyCtx : ctx;
    c.save();
    if (part.kind === 'text') {
      c.font = `${part.bold ? 'bold ' : ''}${part.size}px ${TEXT_FONT}`;
      c.fillStyle = part.color;
      c.textBaseline = 'alphabetic';
      c.fillText(part.text, part.x, part.y);
    } else {
      tracePath(c, part.cmds);
      if (part.fill) {
        c.globalAlpha = part.fill.opacity ?? 1;
        c.fillStyle = part.fill.color;
        c.fill('nonzero');
      }
      if (part.stroke) {
        c.globalAlpha = part.stroke.opacity ?? 1;
        c.strokeStyle = part.stroke.color;
        c.lineWidth = part.stroke.width;
        c.lineCap = part.stroke.cap;
        c.lineJoin = 'round';
        c.setLineDash(part.stroke.dash ?? []);
        c.stroke();
      }
    }
    c.restore();
  }
}

// -------------------------------------------------- bounds & hit testing
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const boundsOf = (xs: number[], ys: number[], pad: number): Bounds => {
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  return { x: minX, y: minY, width: Math.max(...xs) + pad - minX, height: Math.max(...ys) + pad - minY };
};

export function getBounds(ann: Annotation): Bounds {
  switch (ann.type) {
    case 'pen':
    case 'highlighter': {
      const pad = ann.type === 'pen' && ann.penType === 'fountain' ? ann.width : ann.width / 2;
      return boundsOf(ann.points.map((p) => p.x), ann.points.map((p) => p.y), pad);
    }
    case 'rect':
      return boundsOf([ann.x, ann.x + ann.width], [ann.y, ann.y + ann.height], ann.strokeWidth / 2);
    case 'circle': {
      const rx = Math.abs(ann.radiusX);
      const ry = Math.abs(ann.radiusY);
      return boundsOf([ann.x - rx, ann.x + rx], [ann.y - ry, ann.y + ry], ann.strokeWidth / 2);
    }
    case 'line':
    case 'arrow': {
      const pad = ann.type === 'arrow' ? arrowHeadLength(ann.strokeWidth) : ann.strokeWidth;
      return boundsOf([ann.x1, ann.x2], [ann.y1, ann.y2], pad);
    }
    case 'measure': {
      const l = measureLabel(ann, canvasMeasure);
      return boundsOf([ann.x1, ann.x2, l.x, l.x + l.w], [ann.y1, ann.y2, l.y, l.y + l.h], MEASURE_TICK);
    }
    case 'cite':
      return boundsOf([ann.x - 6, ann.x + ann.width + 16], [ann.y - 8, ann.y + ann.height], 0);
    case 'text': {
      const lines = textLines(ann.text);
      const width = Math.max(...lines.map((l) => canvasMeasure(l, ann.fontSize)), ann.fontSize);
      return { x: ann.x, y: ann.y, width, height: lines.length * ann.fontSize * TEXT_LINE_HEIGHT };
    }
  }
}

function distToSegment(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

const inBounds = (p: Point, b: Bounds, tol: number) =>
  p.x >= b.x - tol && p.x <= b.x + b.width + tol && p.y >= b.y - tol && p.y <= b.y + b.height + tol;

/** Hit test in page units; `tol` is the click tolerance in page units. */
export function isHit(ann: Annotation, p: Point, tol: number): boolean {
  switch (ann.type) {
    case 'pen':
    case 'highlighter': {
      const r = (ann.type === 'pen' && ann.penType === 'fountain' ? ann.width : ann.width / 2) + tol;
      if (ann.points.length === 1) return Math.hypot(p.x - ann.points[0].x, p.y - ann.points[0].y) <= r;
      for (let i = 0; i < ann.points.length - 1; i++) {
        if (distToSegment(p, ann.points[i], ann.points[i + 1]) <= r) return true;
      }
      return false;
    }
    case 'circle': {
      const rx = Math.abs(ann.radiusX) + tol;
      const ry = Math.abs(ann.radiusY) + tol;
      const dx = (p.x - ann.x) / rx;
      const dy = (p.y - ann.y) / ry;
      return dx * dx + dy * dy <= 1;
    }
    case 'line':
    case 'arrow':
      return distToSegment(p, { x: ann.x1, y: ann.y1 }, { x: ann.x2, y: ann.y2 }) <= ann.strokeWidth / 2 + tol;
    case 'measure': {
      if (distToSegment(p, { x: ann.x1, y: ann.y1 }, { x: ann.x2, y: ann.y2 }) <= ann.strokeWidth / 2 + tol) return true;
      const l = measureLabel(ann, canvasMeasure);
      return inBounds(p, { x: l.x, y: l.y, width: l.w, height: l.h }, tol);
    }
    default:
      return inBounds(p, getBounds(ann), tol);
  }
}

export function translateAnnotation<T extends Annotation>(ann: T, dx: number, dy: number): T {
  switch (ann.type) {
    case 'pen':
    case 'highlighter':
      return { ...ann, points: ann.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    case 'line':
    case 'arrow':
    case 'measure':
      return { ...ann, x1: ann.x1 + dx, y1: ann.y1 + dy, x2: ann.x2 + dx, y2: ann.y2 + dy };
    default:
      return { ...ann, x: (ann as { x: number }).x + dx, y: (ann as { y: number }).y + dy };
  }
}

// ------------------------------------------------------------- resizing
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'p1' | 'p2';

export const HANDLE_CURSORS: Record<Handle, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  p1: 'crosshair',
  p2: 'crosshair',
};

const hasEndpoints = (a: Annotation): a is Extract<Annotation, { x1: number }> =>
  a.type === 'line' || a.type === 'arrow' || a.type === 'measure';

/** The box the user resizes (unpadded geometry, not the selection outline). */
export function geometryBox(ann: Annotation): Bounds {
  switch (ann.type) {
    case 'pen':
    case 'highlighter':
      return boundsOf(ann.points.map((p) => p.x), ann.points.map((p) => p.y), 0);
    case 'rect':
    case 'cite':
      return { x: ann.x, y: ann.y, width: ann.width, height: ann.height };
    case 'circle':
      return { x: ann.x - Math.abs(ann.radiusX), y: ann.y - Math.abs(ann.radiusY), width: Math.abs(ann.radiusX) * 2, height: Math.abs(ann.radiusY) * 2 };
    case 'text':
      return getBounds(ann);
    default:
      return boundsOf([ann.x1, ann.x2], [ann.y1, ann.y2], 0);
  }
}

export function handlePositions(ann: Annotation): { handle: Handle; x: number; y: number }[] {
  if (hasEndpoints(ann)) {
    return [
      { handle: 'p1', x: ann.x1, y: ann.y1 },
      { handle: 'p2', x: ann.x2, y: ann.y2 },
    ];
  }
  const b = geometryBox(ann);
  const l = b.x;
  const t = b.y;
  const r = b.x + b.width;
  const bt = b.y + b.height;
  const mx = l + b.width / 2;
  const my = t + b.height / 2;
  const corners: { handle: Handle; x: number; y: number }[] = [
    { handle: 'nw', x: l, y: t },
    { handle: 'ne', x: r, y: t },
    { handle: 'se', x: r, y: bt },
    { handle: 'sw', x: l, y: bt },
  ];
  // Text scales uniformly from its corners; flat strokes have no height to drag
  if (ann.type === 'text') return corners;
  const edges: { handle: Handle; x: number; y: number }[] = [];
  if (b.height > 0.5) edges.push({ handle: 'e', x: r, y: my }, { handle: 'w', x: l, y: my });
  if (b.width > 0.5) edges.push({ handle: 'n', x: mx, y: t }, { handle: 's', x: mx, y: bt });
  return [...corners, ...edges];
}

/** Snap a direction from `a` to `b` onto 0/45/90° when within `tolDeg` (all directions if tolDeg ≥ 22.5). */
export function snapAngle(a: Point, b: Point, tolDeg = 5): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return b;
  const angle = Math.atan2(dy, dx);
  const step = Math.PI / 4;
  const snapped = Math.round(angle / step) * step;
  if (Math.abs(snapped - angle) > (tolDeg * Math.PI) / 180) return b;
  return { x: a.x + len * Math.cos(snapped), y: a.y + len * Math.sin(snapped) };
}

/**
 * Resize an annotation by dragging one of its handles to `pt`.
 * `uniform` keeps the aspect ratio (Shift, and always for text).
 */
export function resizeAnnotation(orig: Annotation, handle: Handle, pt: Point, uniform: boolean): Annotation {
  if (hasEndpoints(orig)) {
    if (handle === 'p1') {
      const p = uniform ? snapAngle({ x: orig.x2, y: orig.y2 }, pt, 23) : pt;
      return { ...orig, x1: p.x, y1: p.y };
    }
    const p = uniform ? snapAngle({ x: orig.x1, y: orig.y1 }, pt, 23) : pt;
    return { ...orig, x2: p.x, y2: p.y };
  }

  const ob = geometryBox(orig);
  let l = ob.x;
  let t = ob.y;
  let r = ob.x + ob.width;
  let b = ob.y + ob.height;
  if (handle.includes('w')) l = pt.x;
  if (handle.includes('e')) r = pt.x;
  if (handle.includes('n')) t = pt.y;
  if (handle.includes('s')) b = pt.y;

  const isText = orig.type === 'text';
  const isCorner = handle.length === 2;
  if ((uniform || isText) && isCorner && ob.width > 0 && ob.height > 0) {
    const s = Math.max(Math.abs(r - l) / ob.width, Math.abs(b - t) / ob.height, 0.05);
    if (handle.includes('w')) l = r - ob.width * s;
    else r = l + ob.width * s;
    if (handle.includes('n')) t = b - ob.height * s;
    else b = t + ob.height * s;
  }

  // Signed scale lets strokes mirror when dragged past the opposite edge
  const sx = ob.width > 0 ? (r - l) / ob.width : 1;
  const sy = ob.height > 0 ? (b - t) / ob.height : 1;
  const mapX = (x: number) => (ob.width > 0 ? l + (x - ob.x) * sx : x + (l - ob.x));
  const mapY = (y: number) => (ob.height > 0 ? t + (y - ob.y) * sy : y + (t - ob.y));
  const nb = { x: Math.min(l, r), y: Math.min(t, b), w: Math.max(1, Math.abs(r - l)), h: Math.max(1, Math.abs(b - t)) };

  switch (orig.type) {
    case 'rect':
    case 'cite':
      return { ...orig, x: nb.x, y: nb.y, width: nb.w, height: nb.h };
    case 'circle':
      return { ...orig, x: nb.x + nb.w / 2, y: nb.y + nb.h / 2, radiusX: nb.w / 2, radiusY: nb.h / 2 };
    case 'pen':
    case 'highlighter':
      return { ...orig, points: orig.points.map((p) => ({ x: mapX(p.x), y: mapY(p.y) })) };
    case 'text': {
      const s = Math.abs(sx);
      return { ...orig, x: nb.x, y: nb.y, fontSize: Math.min(200, Math.max(4, Math.round(orig.fontSize * s * 10) / 10)) };
    }
    default:
      return orig;
  }
}

export function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
