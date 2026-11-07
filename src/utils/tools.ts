import { MeasureUnit, PenType, ToolType } from '../types';

/** What the thickness slider controls for a tool, and its range. */
export interface WidthSpec {
  min: number;
  max: number;
  step: number;
  default: number;
  label: string;
  unit: string;
}

const STROKE: WidthSpec = { min: 0.5, max: 20, step: 0.5, default: 2, label: 'Thickness', unit: 'pt' };

export const WIDTH_SPECS: Partial<Record<ToolType, WidthSpec>> = {
  pen: STROKE,
  highlighter: { min: 4, max: 48, step: 1, default: 16, label: 'Thickness', unit: 'pt' },
  text: { min: 6, max: 72, step: 1, default: 16, label: 'Font size', unit: 'pt' },
  rect: STROKE,
  circle: STROKE,
  line: STROKE,
  arrow: STROKE,
  measure: { min: 0.5, max: 6, step: 0.5, default: 1, label: 'Thickness', unit: 'pt' },
};

/** Tools that share one width setting. */
export function widthKey(tool: ToolType): ToolType {
  return tool === 'circle' || tool === 'line' || tool === 'arrow' ? 'rect' : tool;
}

export function defaultToolWidths(): Partial<Record<ToolType, number>> {
  const out: Partial<Record<ToolType, number>> = {};
  for (const [tool, spec] of Object.entries(WIDTH_SPECS)) out[tool as ToolType] = spec!.default;
  return out;
}

export const PEN_TYPES: { type: PenType; label: string; hint: string }[] = [
  { type: 'ballpoint', label: 'Ballpoint', hint: 'Smooth, even line' },
  { type: 'fountain', label: 'Fountain', hint: 'Calligraphic, angled nib' },
  { type: 'marker', label: 'Marker', hint: 'Bold, flat, slightly translucent' },
  { type: 'pencil', label: 'Pencil', hint: 'Soft, textured graphite' },
  { type: 'dashed', label: 'Dashed', hint: 'Dashed line' },
];

export const MEASURE_UNITS: MeasureUnit[] = ['cm', 'mm', 'in'];

/** Page units are PDF points (1/72 inch). */
export function formatMeasurement(points: number, unit: MeasureUnit): string {
  const inches = points / 72;
  switch (unit) {
    case 'in':
      return `${inches.toFixed(2)} in`;
    case 'mm':
      return `${(inches * 25.4).toFixed(1)} mm`;
    default:
      return `${(inches * 2.54).toFixed(2)} cm`;
  }
}
