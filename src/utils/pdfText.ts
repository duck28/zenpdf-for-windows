import type { PDFDocumentProxy } from 'pdfjs-dist';

/**
 * Text from the PDF whose glyph runs have their center inside a rectangle
 * given in page units (pdf.js viewport at scale 1, origin top-left).
 */
export async function extractTextInRect(
  doc: PDFDocumentProxy,
  pageNum: number,
  rect: { x: number; y: number; width: number; height: number }
): Promise<string> {
  const page = await doc.getPage(pageNum);
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  let out = '';
  for (const item of content.items) {
    if (!('str' in item)) continue;
    const [a, b, c, d, e, f] = item.transform as number[];
    const ax = Math.hypot(a, b) || 1;
    const cy = Math.hypot(c, d) || 1;
    // Center of the text run in PDF space: baseline origin + half width along
    // the text direction + half height along the up direction.
    const cxPdf = e + ((a / ax) * item.width) / 2 + ((c / cy) * item.height) / 2;
    const cyPdf = f + ((b / ax) * item.width) / 2 + ((d / cy) * item.height) / 2;
    const [vx, vy] = vp.convertToViewportPoint(cxPdf, cyPdf);
    if (vx >= rect.x && vx <= rect.x + rect.width && vy >= rect.y && vy <= rect.y + rect.height) {
      out += item.str + (item.hasEOL ? '\n' : '');
    } else if (item.hasEOL && out && !out.endsWith('\n')) {
      out += '\n';
    }
  }
  return out
    .replace(/-\n(?=\p{Ll})/gu, '') // re-join hyphenated words
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Parse a PDF date ("D:20200131...") into a year. */
export function pdfYear(date: unknown): string | undefined {
  const m = typeof date === 'string' ? date.match(/(?:D:)?(\d{4})/) : null;
  return m ? m[1] : undefined;
}
