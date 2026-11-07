import {
  PDFDocument,
  PDFDict,
  PDFArray,
  PDFName,
  PDFRef,
  PDFString,
  PDFHexString,
  PDFFont,
  PDFOperator,
  StandardFonts,
  LineCapStyle,
  LineJoinStyle,
  pushGraphicsState,
  popGraphicsState,
  moveTo,
  lineTo,
  appendBezierCurve,
  closePath,
  stroke,
  fill,
  fillAndStroke,
  setLineWidth,
  setLineCap,
  setLineJoin,
  setDashPattern,
  setStrokingRgbColor,
  setFillingRgbColor,
  setGraphicsState,
  beginText,
  endText,
  setFontAndSize,
  showText,
  rotateAndSkewTextDegreesAndTranslate,
} from 'pdf-lib';
import { Annotation, CitationAnnotation, DocumentSource } from '../types';
import { annotationParts, footnoteParts, LineCap, MeasureFn, RenderPart } from './annotations';
import { citationNumbers } from './citations';
import { makePageMapper, makeSanitizer, PageMapper } from './pdfExport';

/**
 * Editable saving.
 *
 * Every ZenPDF annotation is written as a real PDF annotation object
 * (/Ink, /Square, /Circle, /Line, /FreeText) with a vector appearance stream,
 * so any PDF viewer shows it as an annotation, never merged into the page.
 * The original ZenPDF data is kept on the annotation under a private key,
 * so reopening the file in ZenPDF restores fully editable objects.
 */

const DATA_KEY = 'ZenPDF';
const FOOTNOTES_KEY = 'ZenPDFFootnotes';
const SOURCE_KEY = 'ZenPDFSource';
const FORMAT_VERSION = 1;

const ANNOTATION_TYPES = new Set<Annotation['type']>([
  'pen', 'highlighter', 'text', 'rect', 'circle', 'line', 'arrow', 'measure', 'cite',
]);

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const v = [0, 2, 4].map((i) => parseInt(h.substring(i, i + 2), 16) / 255);
  return v.map((n) => (Number.isNaN(n) ? 0 : n)) as [number, number, number];
}

const CAPS: Record<LineCap, LineCapStyle> = {
  round: LineCapStyle.Round,
  butt: LineCapStyle.Butt,
  square: LineCapStyle.Projecting,
};

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  sanitize: (s: string) => string;
  measure: MeasureFn;
}

interface Appearance {
  ops: PDFOperator[];
  extGStates: Record<string, { CA: number; ca: number; multiply: boolean }>;
  rect: [number, number, number, number];
}

/** Turn render parts into content-stream operators in PDF user space. */
function buildAppearance(parts: RenderPart[], map: PageMapper, fonts: Fonts): Appearance {
  const ops: PDFOperator[] = [];
  const extGStates: Appearance['extGStates'] = {};
  const gsNames = new Map<string, string>();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const extend = (vx: number, vy: number, pad: number) => {
    const [x, y] = map.map(vx, vy);
    minX = Math.min(minX, x - pad);
    minY = Math.min(minY, y - pad);
    maxX = Math.max(maxX, x + pad);
    maxY = Math.max(maxY, y + pad);
  };
  const gsFor = (CA: number, ca: number, multiply: boolean) => {
    if (CA >= 1 && ca >= 1 && !multiply) return null;
    const key = `${CA}|${ca}|${multiply}`;
    let name = gsNames.get(key);
    if (!name) {
      name = `GS${gsNames.size}`;
      gsNames.set(key, name);
      extGStates[name] = { CA, ca, multiply };
    }
    return name;
  };

  for (const part of parts) {
    if (part.kind === 'text') {
      if (!part.text) continue;
      const font = part.bold ? fonts.bold : fonts.regular;
      const text = fonts.sanitize(part.text);
      const [x, y] = map.map(part.x, part.y);
      ops.push(
        pushGraphicsState(),
        beginText(),
        setFillingRgbColor(...hexToRgb(part.color)),
        setFontAndSize(part.bold ? 'F2' : 'F1', part.size),
        rotateAndSkewTextDegreesAndTranslate(map.rotation, 0, 0, x, y),
        showText(font.encodeText(text)),
        endText(),
        popGraphicsState()
      );
      const w = fonts.measure(part.text, part.size, part.bold);
      extend(part.x, part.y - part.size, 1);
      extend(part.x + w, part.y + part.size * 0.3, 1);
      continue;
    }

    const pad = (part.stroke?.width ?? 0) / 2 + 1;
    ops.push(pushGraphicsState());
    const gs = gsFor(part.stroke?.opacity ?? 1, part.fill?.opacity ?? 1, !!part.multiply);
    if (gs) ops.push(setGraphicsState(gs));
    if (part.stroke) {
      ops.push(
        setLineWidth(part.stroke.width),
        setLineCap(CAPS[part.stroke.cap]),
        setLineJoin(LineJoinStyle.Round),
        setDashPattern(part.stroke.dash ?? [], 0),
        setStrokingRgbColor(...hexToRgb(part.stroke.color))
      );
    }
    if (part.fill) ops.push(setFillingRgbColor(...hexToRgb(part.fill.color)));

    let cx = 0;
    let cy = 0;
    let sx = 0;
    let sy = 0;
    const P = (x: number, y: number) => {
      extend(x, y, pad);
      return map.map(x, y);
    };
    for (const c of part.cmds) {
      switch (c.op) {
        case 'M':
          ops.push(moveTo(...P(c.x, c.y)));
          cx = sx = c.x;
          cy = sy = c.y;
          break;
        case 'L':
          ops.push(lineTo(...P(c.x, c.y)));
          cx = c.x;
          cy = c.y;
          break;
        case 'Q': {
          // Exact quadratic → cubic conversion
          const c1 = P(cx + (2 / 3) * (c.cx - cx), cy + (2 / 3) * (c.cy - cy));
          const c2 = P(c.x + (2 / 3) * (c.cx - c.x), c.y + (2 / 3) * (c.cy - c.y));
          ops.push(appendBezierCurve(...c1, ...c2, ...P(c.x, c.y)));
          cx = c.x;
          cy = c.y;
          break;
        }
        case 'C':
          ops.push(appendBezierCurve(...P(c.c1x, c.c1y), ...P(c.c2x, c.c2y), ...P(c.x, c.y)));
          cx = c.x;
          cy = c.y;
          break;
        case 'Z':
          ops.push(closePath());
          cx = sx;
          cy = sy;
          break;
      }
    }
    ops.push(part.fill && part.stroke ? fillAndStroke() : part.fill ? fill() : stroke(), popGraphicsState());
  }

  if (!Number.isFinite(minX)) {
    minX = minY = 0;
    maxX = maxY = 1;
  }
  return { ops, extGStates, rect: [minX, minY, maxX, maxY] };
}

function subtypeFor(ann: Annotation): string {
  switch (ann.type) {
    case 'pen':
    case 'highlighter':
      return 'Ink';
    case 'rect':
    case 'cite':
      return 'Square';
    case 'circle':
      return 'Circle';
    case 'line':
    case 'arrow':
    case 'measure':
      return 'Line';
    case 'text':
      return 'FreeText';
  }
}

function describe(ann: Annotation): string {
  switch (ann.type) {
    case 'text':
      return ann.text;
    case 'cite':
      return [ann.note, ann.quote ? `“${ann.quote}”` : ''].filter(Boolean).join('\n\n');
    default:
      return '';
  }
}

function addAnnotationObject(
  doc: PDFDocument,
  pageIndex: number,
  appearance: Appearance,
  fonts: Fonts,
  fields: Record<string, unknown>
) {
  const ctx = doc.context;
  const page = doc.getPage(pageIndex);
  const extG: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(appearance.extGStates)) {
    extG[name] = ctx.obj({ Type: 'ExtGState', CA: s.CA, ca: s.ca, BM: s.multiply ? 'Multiply' : 'Normal' });
  }
  const resources = ctx.obj({
    Font: { F1: fonts.regular.ref, F2: fonts.bold.ref },
    ...(Object.keys(extG).length ? { ExtGState: extG } : {}),
  } as unknown as Record<string, never>);

  // BBox == Rect with an identity Matrix: the appearance is drawn in page space.
  const form = ctx.formXObject(appearance.ops, { BBox: appearance.rect, Resources: resources });
  const formRef = ctx.register(form);

  const annot = ctx.obj({
    Type: 'Annot',
    Rect: appearance.rect,
    F: 4, // Print
    AP: { N: formRef },
    P: page.ref,
    M: PDFString.fromDate(new Date()),
    ...fields,
  } as unknown as Record<string, never>);
  // Append to /Annots directly: pdf-lib's addAnnot() also rewrites the page's
  // content streams, and the original page content must stay untouched.
  const ref = ctx.register(annot);
  const existing = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (existing) existing.push(ref);
  else page.node.set(PDFName.of('Annots'), ctx.obj([ref]));
}

/**
 * Write annotations into `cleanBytes` (a PDF without ZenPDF annotations)
 * as editable PDF annotations. Returns the new file bytes.
 */
export async function saveAnnotationsToPdf(
  cleanBytes: Uint8Array,
  annotations: Annotation[],
  source: DocumentSource | null
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(cleanBytes, { ignoreEncryption: true });
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const sanitize = makeSanitizer(regular);
  const fonts: Fonts = {
    regular,
    bold,
    sanitize,
    measure: (t, size, isBold) => (isBold ? bold : regular).widthOfTextAtSize(sanitize(t), size),
  };
  const pages = doc.getPages();
  const numbers = citationNumbers(annotations);
  const citesByPage = new Map<number, CitationAnnotation[]>();

  for (const ann of annotations) {
    const idx = ann.pageNumber - 1;
    if (idx < 0 || idx >= pages.length) continue;
    const map = makePageMapper(pages[idx]);
    const parts = annotationParts(ann, { measure: fonts.measure, citeNumbers: numbers });
    const appearance = buildAppearance(parts, map, fonts);
    const color = hexToRgb('color' in ann ? ann.color : ann.strokeColor);
    const fields: Record<string, unknown> = {
      Subtype: subtypeFor(ann),
      NM: PDFString.of(ann.id),
      C: color,
      Contents: PDFHexString.fromText(describe(ann)),
      [DATA_KEY]: PDFHexString.fromText(JSON.stringify({ v: FORMAT_VERSION, annotation: ann })),
    };

    // Subtype-specific required entries, so other viewers understand them
    if (ann.type === 'pen' || ann.type === 'highlighter') {
      fields.InkList = [ann.points.flatMap((p) => map.map(p.x, p.y))];
      fields.BS = { W: ann.width };
      if (ann.type === 'highlighter') fields.CA = ann.opacity;
    } else if (ann.type === 'line' || ann.type === 'arrow' || ann.type === 'measure') {
      fields.L = [...map.map(ann.x1, ann.y1), ...map.map(ann.x2, ann.y2)];
      fields.BS = { W: ann.strokeWidth };
      if (ann.type === 'arrow') fields.LE = ['None', 'OpenArrow'];
    } else if (ann.type === 'rect' || ann.type === 'circle') {
      fields.BS = { W: ann.strokeWidth };
    } else if (ann.type === 'text') {
      const [r, g, b] = color;
      fields.DA = PDFString.of(`/Helv ${ann.fontSize} Tf ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
    } else if (ann.type === 'cite') {
      fields.BS = { W: 0 };
      fields.Subj = PDFString.of(`Citation ${numbers.get(ann.id) ?? ''}`.trim());
      citesByPage.set(ann.pageNumber, [...(citesByPage.get(ann.pageNumber) ?? []), ann]);
    }
    addAnnotationObject(doc, idx, appearance, fonts, fields);
  }

  // Footnotes: one generated annotation per page, rebuilt on every save
  for (const [pageNumber, cites] of citesByPage) {
    const map = makePageMapper(pages[pageNumber - 1]);
    const parts = footnoteParts(cites, numbers, map.viewWidth, map.viewHeight, fonts.measure);
    if (!parts.length) continue;
    const text = cites
      .filter((c) => c.note.trim())
      .map((c) => `${numbers.get(c.id)}. ${c.note.trim()}`)
      .join('\n');
    addAnnotationObject(doc, pageNumber - 1, buildAppearance(parts, map, fonts), fonts, {
      Subtype: 'FreeText',
      DA: PDFString.of('/Helv 8 Tf 0 g'),
      Contents: PDFHexString.fromText(text),
      [FOOTNOTES_KEY]: true,
    });
  }

  if (source) {
    doc.catalog.set(PDFName.of(SOURCE_KEY), PDFHexString.fromText(JSON.stringify(source)));
  }

  // No object streams: keeps the ZenPDF markers detectable by a fast byte scan
  return doc.save({ useObjectStreams: false });
}

// ---------------------------------------------------------------- loading
function includesAscii(bytes: Uint8Array, needle: string): boolean {
  const n = Array.from(needle, (c) => c.charCodeAt(0));
  const first = n[0];
  outer: for (let i = bytes.indexOf(first); i !== -1 && i <= bytes.length - n.length; i = bytes.indexOf(first, i + 1)) {
    for (let j = 1; j < n.length; j++) if (bytes[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

function decodeTextObject(obj: unknown): string | null {
  if (obj instanceof PDFHexString || obj instanceof PDFString) return obj.decodeText();
  return null;
}

function isValidAnnotation(a: unknown): a is Annotation {
  const x = a as Annotation;
  return !!x && typeof x === 'object' && typeof x.id === 'string' && ANNOTATION_TYPES.has(x.type);
}

/**
 * Read ZenPDF annotations back out of a file. Returns the file with those
 * annotation objects removed (so pdf.js doesn't draw them a second time
 * underneath the editable overlay), plus the annotations themselves.
 * Files without ZenPDF data are returned untouched.
 */
export async function loadAnnotationsFromPdf(bytes: Uint8Array): Promise<{
  bytes: Uint8Array;
  annotations: Annotation[];
  source: DocumentSource | null;
}> {
  const untouched = { bytes, annotations: [] as Annotation[], source: null };
  // Our own saves keep the marker in plain text; files re-saved by other
  // tools may hide it inside compressed object streams.
  const maybe =
    includesAscii(bytes, DATA_KEY) ||
    (bytes.length < 60 * 1024 * 1024 && includesAscii(bytes, '/ObjStm') && includesAscii(bytes, '/Annots'));
  if (!maybe) return untouched;

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return untouched;
  }
  const ctx = doc.context;
  const annotations: Annotation[] = [];
  const seen = new Set<string>();
  let changed = false;

  doc.getPages().forEach((page, pageIndex) => {
    const annots = page.node.Annots();
    if (!annots) return;
    const keep: unknown[] = [];
    let removed = false;
    for (let i = 0; i < annots.size(); i++) {
      const entry = annots.get(i);
      const dict = entry instanceof PDFRef ? ctx.lookupMaybe(entry, PDFDict) : entry instanceof PDFDict ? entry : undefined;
      const data = dict?.get(PDFName.of(DATA_KEY));
      const isFootnotes = !!dict?.get(PDFName.of(FOOTNOTES_KEY));
      if (!dict || (!data && !isFootnotes)) {
        keep.push(entry);
        continue;
      }
      removed = true;
      if (data) {
        try {
          const parsed = JSON.parse(decodeTextObject(data) ?? 'null');
          const ann = parsed?.annotation;
          if (isValidAnnotation(ann)) {
            // Page index from the file wins (pages may have been reordered elsewhere)
            const fixed = { ...ann, pageNumber: pageIndex + 1 } as Annotation;
            if (seen.has(fixed.id)) fixed.id = `${fixed.id}_${pageIndex}_${i}`;
            seen.add(fixed.id);
            annotations.push(fixed);
          }
        } catch (err) {
          console.warn('Skipping unreadable ZenPDF annotation', err);
        }
      }
      // Drop the annotation and its appearance stream
      const ap = dict.lookupMaybe(PDFName.of('AP'), PDFDict);
      const n = ap?.get(PDFName.of('N'));
      if (n instanceof PDFRef) ctx.delete(n);
      if (entry instanceof PDFRef) ctx.delete(entry);
    }
    if (removed) {
      changed = true;
      if (keep.length) page.node.set(PDFName.of('Annots'), ctx.obj(keep as never[]) as PDFArray);
      else page.node.delete(PDFName.of('Annots'));
    }
  });

  let source: DocumentSource | null = null;
  const src = decodeTextObject(doc.catalog.get(PDFName.of(SOURCE_KEY)));
  if (src) {
    try {
      const s = JSON.parse(src);
      source = {
        author: String(s.author ?? ''),
        title: String(s.title ?? ''),
        year: String(s.year ?? ''),
        publisher: String(s.publisher ?? ''),
        url: String(s.url ?? ''),
      };
    } catch {
      /* ignore */
    }
    doc.catalog.delete(PDFName.of(SOURCE_KEY));
    changed = true;
  }

  if (!changed) return untouched;
  return { bytes: await doc.save({ useObjectStreams: false }), annotations, source };
}
