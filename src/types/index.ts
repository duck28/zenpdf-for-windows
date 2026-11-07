export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number;
  children?: FileEntry[];
}

export type ToolType =
  | 'select'
  | 'pan'
  | 'pen'
  | 'highlighter'
  | 'text'
  | 'rect'
  | 'circle'
  | 'line'
  | 'arrow'
  | 'measure'
  | 'cite'
  | 'eraser';

export type PenType = 'ballpoint' | 'fountain' | 'marker' | 'pencil' | 'dashed';

export type MeasureUnit = 'cm' | 'mm' | 'in';

export type CitationStyle = 'apa' | 'mla' | 'chicago' | 'bibtex';

export interface Point {
  x: number;
  y: number;
}

export interface BaseAnnotation {
  id: string;
  pageNumber: number; // 1-based
  createdAt: number;
}

export interface PenAnnotation extends BaseAnnotation {
  type: 'pen';
  points: Point[];
  color: string;
  width: number;
  opacity: number;
  penType?: PenType;
}

export interface HighlightAnnotation extends BaseAnnotation {
  type: 'highlighter';
  points: Point[];
  color: string;
  width: number;
  opacity: number;
}

export interface TextAnnotation extends BaseAnnotation {
  type: 'text';
  x: number;
  y: number;
  text: string;
  fontSize: number;
  color: string;
  bgColor?: string;
}

export interface RectAnnotation extends BaseAnnotation {
  type: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  strokeColor: string;
  strokeWidth: number;
  fillColor?: string;
}

export interface CircleAnnotation extends BaseAnnotation {
  type: 'circle';
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  strokeColor: string;
  strokeWidth: number;
  fillColor?: string;
}

export interface LineAnnotation extends BaseAnnotation {
  type: 'line' | 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  strokeColor: string;
  strokeWidth: number;
}

/** Ruler / dimension line. Coordinates are page units (1/72 inch). */
export interface MeasureAnnotation extends BaseAnnotation {
  type: 'measure';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  strokeColor: string;
  strokeWidth: number;
  unit: MeasureUnit;
}

/** A marked passage with a numbered footnote. */
export interface CitationAnnotation extends BaseAnnotation {
  type: 'cite';
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  /** Footnote text printed at the bottom of the page. */
  note: string;
  /** Text extracted from the PDF under the marked region (editable). */
  quote: string;
  /** Page label used in citations; defaults to the page number. */
  pageLabel?: string;
}

export type Annotation =
  | PenAnnotation
  | HighlightAnnotation
  | TextAnnotation
  | RectAnnotation
  | CircleAnnotation
  | LineAnnotation
  | MeasureAnnotation
  | CitationAnnotation;

/** Bibliographic information about the open document, used for citations. */
export interface DocumentSource {
  author: string;
  title: string;
  year: string;
  publisher: string;
  url: string;
}

export interface DocumentInfo {
  filePath: string;
  fileName: string;
  fileData?: Uint8Array;
  numPages: number;
  isDirty?: boolean;
}
