import { PDFDocument, PDFFont, PDFPage, rgb, degrees, StandardFonts, LineCapStyle, BlendMode } from 'pdf-lib';
import { Annotation, CitationAnnotation } from '../types';
import { annotationParts, footnoteParts, LineCap, MeasureFn, PathCmd, RenderPart } from './annotations';
import { citationNumbers } from './citations';

// Convert hex string "#rrggbb" to pdf-lib rgb(r, g, b)
export function hexToPdfRgb(hex: string) {
  let cleanHex = hex.replace('#', '');
  if (cleanHex.length === 3) {
    cleanHex = cleanHex.split('').map((c) => c + c).join('');
  }
  const r = parseInt(cleanHex.substring(0, 2), 16) / 255;
  const g = parseInt(cleanHex.substring(2, 4), 16) / 255;
  const b = parseInt(cleanHex.substring(4, 6), 16) / 255;
  return rgb(isNaN(r) ? 0 : r, isNaN(g) ? 0 : g, isNaN(b) ? 0 : b);
}

/**
 * Maps page units (pdf.js viewport at scale 1: rotation applied, origin
 * top-left of the crop box, y down) to PDF user space.
 */
export type PageMapper = ReturnType<typeof makePageMapper>;

export function makePageMapper(page: PDFPage) {
  const crop = page.getCropBox();
  const rotation = (((page.getRotation().angle % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  const { x: x0, y: y0, width: w, height: h } = crop;
  const swapped = rotation === 90 || rotation === 270;

  const map = (vx: number, vy: number): [number, number] => {
    switch (rotation) {
      case 90:
        return [x0 + vy, y0 + vx];
      case 180:
        return [x0 + w - vx, y0 + vy];
      case 270:
        return [x0 + w - vy, y0 + h - vx];
      default:
        return [x0 + vx, y0 + h - vy];
    }
  };
  return { map, rotation, viewWidth: swapped ? h : w, viewHeight: swapped ? w : h };
}

/** SVG path string in PDF space, y negated because drawSvgPath flips y. */
function toSvgPath(cmds: PathCmd[], map: (x: number, y: number) => [number, number]) {
  const pt = (x: number, y: number) => {
    const [px, py] = map(x, y);
    return `${px.toFixed(3)} ${(-py).toFixed(3)}`;
  };
  // Track the current point so quadratics can be converted to exact cubics
  // (pdf-lib's own Q handling is only an approximation).
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  return cmds
    .map((c) => {
      switch (c.op) {
        case 'M':
          cx = sx = c.x;
          cy = sy = c.y;
          return `M ${pt(c.x, c.y)}`;
        case 'L':
          cx = c.x;
          cy = c.y;
          return `L ${pt(c.x, c.y)}`;
        case 'Q': {
          const c1x = cx + (2 / 3) * (c.cx - cx);
          const c1y = cy + (2 / 3) * (c.cy - cy);
          const c2x = c.x + (2 / 3) * (c.cx - c.x);
          const c2y = c.y + (2 / 3) * (c.cy - c.y);
          cx = c.x;
          cy = c.y;
          return `C ${pt(c1x, c1y)} ${pt(c2x, c2y)} ${pt(c.x, c.y)}`;
        }
        case 'C':
          cx = c.x;
          cy = c.y;
          return `C ${pt(c.c1x, c.c1y)} ${pt(c.c2x, c.c2y)} ${pt(c.x, c.y)}`;
        case 'Z':
          cx = sx;
          cy = sy;
          return 'Z';
      }
    })
    .join(' ');
}

const CAPS: Record<LineCap, LineCapStyle> = {
  round: LineCapStyle.Round,
  butt: LineCapStyle.Butt,
  square: LineCapStyle.Projecting,
};

/** Replace characters the standard Helvetica fonts cannot encode. */
export function makeSanitizer(font: PDFFont) {
  const charset = new Set(font.getCharacterSet());
  return (text: string) =>
    Array.from(text)
      .map((ch) => (charset.has(ch.codePointAt(0)!) ? ch : '?'))
      .join('');
}

/**
 * Creates a FLATTENED copy: annotations (and citation footnotes) are drawn
 * permanently into the page content. Used only for "Export flattened copy";
 * normal saving keeps them editable (see pdfAnnotations.ts).
 */
export async function bakeAnnotationsToPdf(
  originalPdfBytes: Uint8Array,
  annotations: Annotation[]
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(originalPdfBytes, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const sanitize = makeSanitizer(font);
  const pages = pdfDoc.getPages();
  const numbers = citationNumbers(annotations);

  const measure: MeasureFn = (text, size, isBold) => (isBold ? bold : font).widthOfTextAtSize(sanitize(text), size);

  const drawPart = (page: PDFPage, part: RenderPart, map: ReturnType<typeof makePageMapper>) => {
    if (part.kind === 'text') {
      if (!part.text) return;
      const [x, y] = map.map(part.x, part.y);
      page.drawText(sanitize(part.text), {
        x,
        y,
        size: part.size,
        font: part.bold ? bold : font,
        color: hexToPdfRgb(part.color),
        rotate: degrees(map.rotation),
      });
      return;
    }
    const path = toSvgPath(part.cmds, map.map);
    if (!path) return;
    page.drawSvgPath(path, {
      x: 0,
      y: 0,
      color: part.fill ? hexToPdfRgb(part.fill.color) : undefined,
      opacity: part.fill?.opacity,
      borderColor: part.stroke ? hexToPdfRgb(part.stroke.color) : undefined,
      borderWidth: part.stroke?.width ?? 0,
      borderOpacity: part.stroke?.opacity,
      borderLineCap: part.stroke ? CAPS[part.stroke.cap] : undefined,
      borderDashArray: part.stroke?.dash,
      blendMode: part.multiply ? BlendMode.Multiply : undefined,
    });
  };

  const citesByPage = new Map<number, CitationAnnotation[]>();

  for (const ann of annotations) {
    const pageIndex = ann.pageNumber - 1;
    if (pageIndex < 0 || pageIndex >= pages.length) continue;
    const page = pages[pageIndex];
    const map = makePageMapper(page);
    for (const part of annotationParts(ann, { measure, citeNumbers: numbers })) drawPart(page, part, map);
    if (ann.type === 'cite') {
      citesByPage.set(ann.pageNumber, [...(citesByPage.get(ann.pageNumber) ?? []), ann]);
    }
  }

  for (const [pageNumber, cites] of citesByPage) {
    const page = pages[pageNumber - 1];
    const map = makePageMapper(page);
    for (const part of footnoteParts(cites, numbers, map.viewWidth, map.viewHeight, measure)) {
      drawPart(page, part, map);
    }
  }

  return await pdfDoc.save();
}

/**
 * Helper to download bytes directly in browser/WebView2 if needed
 */
export function triggerBlobDownload(data: Uint8Array, filename: string, mimeType = 'application/pdf') {
  const blob = new Blob([data as unknown as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Uint8Array to Base64 helper (chunked to stay fast on large files)
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Base64 to Uint8Array helper
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
