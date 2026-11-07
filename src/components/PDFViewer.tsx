import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Annotation, CitationAnnotation, MeasureUnit, PenType, Point, ToolType, TextAnnotation } from '../types';
import {
  annotationParts,
  canvasMeasure,
  drawParts,
  footnoteParts,
  getBounds,
  Handle,
  HANDLE_CURSORS,
  handlePositions,
  isHit,
  newId,
  RenderPart,
  resizeAnnotation,
  snapAngle,
  translateAnnotation,
  TEXT_BASELINE,
  TEXT_FONT,
  TEXT_LINE_HEIGHT,
  HIGHLIGHT_OPACITY,
} from '../utils/annotations';
import { citationNumbers } from '../utils/citations';
import { extractTextInRect, pdfYear } from '../utils/pdfText';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

// Layout constants (CSS px, not scaled by zoom)
// Top padding leaves room for the floating tool dock
const PAD_TOP = 68;
const PAD_BOTTOM = 32;
const PAD_X = 16;
const PAGE_GAP = 32;
const RENDER_MARGIN = '800px 0px';

export interface ViewerApi {
  getFitWidthZoom: () => number | null;
  getFitPageZoom: () => number | null;
  exportPageImage: (pageNum: number) => string | null;
}

interface PageSize {
  width: number;
  height: number;
}

interface PDFViewerProps {
  pdfData: Uint8Array;
  /** Changes when a different document is opened (not on save/reload). */
  docId: number;
  zoom: number;
  onZoomChange: (updater: (z: number) => number) => void;
  activeTool: ToolType;
  activeColor: string;
  /** Width for the active tool (font size for text). */
  strokeWidth: number;
  penType: PenType;
  measureUnit: MeasureUnit;
  annotations: Annotation[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAddAnnotation: (ann: Annotation) => void;
  onUpdateAnnotation: (ann: Annotation) => void;
  onDeleteAnnotations: (ids: string[]) => void;
  onDocumentLoaded: (numPages: number) => void;
  /** PDF metadata of a newly opened document (not called on reload). */
  onMetadata?: (meta: { title?: string; author?: string; year?: string }) => void;
  onThumbnailGenerated: (pageNum: number, dataUrl: string) => void;
  onCurrentPageChange: (pageNum: number) => void;
  targetJumpPage: number | null;
  onJumpComplete: () => void;
  apiRef: React.RefObject<ViewerApi | null>;
}

type Gesture =
  | { kind: 'move'; page: number; start: Point; orig: Annotation }
  | { kind: 'resize'; page: number; handle: Handle; orig: Annotation }
  | { kind: 'erase'; page: number }
  | { kind: 'draw'; page: number; straight: boolean; holdAnchor: Point; last: Point }
  | { kind: 'shape'; page: number; start: Point };

/** How long the pointer must rest before a freehand stroke snaps straight. */
const HOLD_TO_STRAIGHTEN_MS = 450;
/** Movement (screen px) still counted as "holding still". */
const HOLD_TOLERANCE_PX = 4;
const HANDLE_PX = 8;

interface TextEditorState {
  page: number;
  x: number;
  y: number;
  value: string;
  fontSize: number;
  color: string;
  editingId?: string;
}

const SHAPE_TOOLS: ToolType[] = ['rect', 'circle', 'line', 'arrow', 'measure', 'cite'];

function isCancelled(err: unknown) {
  return (err as { name?: string })?.name === 'RenderingCancelledException';
}


export const PDFViewer: React.FC<PDFViewerProps> = (props) => {
  const {
    pdfData,
    docId,
    zoom,
    activeTool,
    activeColor,
    strokeWidth,
    penType,
    measureUnit,
    annotations,
    selectedId,
    targetJumpPage,
    apiRef,
  } = props;

  // Latest props for use inside async code / stable handlers
  const propsRef = useRef(props);
  propsRef.current = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pageSizes, setPageSizes] = useState<PageSize[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set());
  const [textEditor, setTextEditor] = useState<TextEditorState | null>(null);
  const pageSizesRef = useRef(pageSizes);
  pageSizesRef.current = pageSizes;
  const textEditorRef = useRef(textEditor);
  textEditorRef.current = textEditor;

  const pdfCanvasRefs = useRef(new Map<number, HTMLCanvasElement>());
  const hlCanvasRefs = useRef(new Map<number, HTMLCanvasElement>());
  const annCanvasRefs = useRef(new Map<number, HTMLCanvasElement>());
  const renderTasks = useRef(new Map<number, pdfjsLib.RenderTask>());
  const renderTokens = useRef(new Map<number, number>());
  const renderedScale = useRef(new Map<number, number>());
  const visibleRef = useRef(new Set<number>());
  const docRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const loadedDocIdRef = useRef<number | null>(null);
  const restoreScrollRef = useRef<{ top: number; left: number } | null>(null);
  const lastScrollRef = useRef({ top: 0, left: 0 });
  const prevZoomRef = useRef(zoom);
  const zoomAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const reportedPageRef = useRef(1);

  // Interaction state (refs: updated at pointer rate without re-rendering)
  const gestureRef = useRef<Gesture | null>(null);
  const draftRef = useRef<Annotation | null>(null);
  /** Live replacement for an annotation being moved or resized. */
  const previewRef = useRef<Annotation | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const erasedRef = useRef(new Set<string>());

  // Cumulative page heights at scale 1 for layout math
  const prefixHeights = useMemo(() => {
    const arr = [0];
    for (const s of pageSizes) arr.push(arr[arr.length - 1] + s.height);
    return arr;
  }, [pageSizes]);
  const maxPageWidth = useMemo(() => Math.max(0, ...pageSizes.map((s) => s.width)), [pageSizes]);

  const pageTop = useCallback(
    (pageNum: number, z: number) => PAD_TOP + prefixHeights[pageNum - 1] * z + (pageNum - 1) * PAGE_GAP,
    [prefixHeights]
  );

  /** Page index (1-based) at a given content y offset. */
  const pageAtY = useCallback(
    (y: number, z: number) => {
      let lo = 1;
      let hi = pageSizes.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (pageTop(mid, z) <= y) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
    [pageSizes.length, pageTop]
  );

  // ---------------------------------------------------------------- loading
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    const container = containerRef.current;
    restoreScrollRef.current =
      loadedDocIdRef.current === docId && container
        ? { top: container.scrollTop, left: container.scrollLeft }
        : null;

    const task = pdfjsLib.getDocument({
      data: pdfData.slice(0),
      // Bundled by scripts/copy-pdfjs-assets.mjs, so rendering works offline.
      cMapUrl: new URL('pdfjs/cmaps/', document.baseURI).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('pdfjs/standard_fonts/', document.baseURI).href,
    });

    task.promise
      .then(async (doc) => {
        const sizes: PageSize[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          sizes.push({ width: vp.width, height: vp.height });
          if (cancelled) return;
        }
        if (cancelled) return;

        // Swap documents: cancel in-flight renders of the old one, then destroy it
        renderTasks.current.forEach((t) => t.cancel());
        renderTasks.current.clear();
        renderedScale.current.clear();
        const prev = docRef.current;
        docRef.current = doc;
        loadedDocIdRef.current = docId;
        if (!restoreScrollRef.current) {
          visibleRef.current = new Set();
          setVisiblePages(new Set());
          reportedPageRef.current = 1;
        }
        const isNewDocument = !restoreScrollRef.current;
        setPdfDoc(doc);
        setPageSizes(sizes);
        propsRef.current.onDocumentLoaded(doc.numPages);
        if (isNewDocument) {
          doc
            .getMetadata()
            .then(({ info }) => {
              const i = (info ?? {}) as Record<string, unknown>;
              const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
              propsRef.current.onMetadata?.({
                title: str(i.Title),
                author: str(i.Author),
                year: pdfYear(i.CreationDate) ?? pdfYear(i.ModDate),
              });
            })
            .catch(() => {});
        }
        if (prev && prev !== doc) prev.destroy();
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Error loading PDF document:', err);
        setLoadError(err?.message ?? String(err));
      });

    return () => {
      cancelled = true;
      // Only destroy the task if it never became the active document
      task.promise.then(
        (doc) => {
          if (docRef.current !== doc) doc.destroy();
        },
        () => {}
      );
    };
  }, [pdfData, docId]);

  // Destroy document on unmount
  useEffect(() => {
    return () => {
      renderTasks.current.forEach((t) => t.cancel());
      docRef.current?.destroy();
      docRef.current = null;
    };
  }, []);

  // Restore scroll after reload of the same document, or reset for a new one
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || pageSizes.length === 0) return;
    const restore = restoreScrollRef.current;
    if (restore) {
      container.scrollTop = restore.top;
      container.scrollLeft = restore.left;
    } else {
      container.scrollTop = 0;
      container.scrollLeft = 0;
    }
    lastScrollRef.current = { top: container.scrollTop, left: container.scrollLeft };
    restoreScrollRef.current = null;
  }, [pageSizes]);

  // ------------------------------------------------------------- thumbnails
  useEffect(() => {
    if (!pdfDoc) return;
    let cancelled = false;
    (async () => {
      for (let i = 1; i <= pdfDoc.numPages && !cancelled; i++) {
        try {
          const page = await pdfDoc.getPage(i);
          const base = page.getViewport({ scale: 1 });
          const vp = page.getViewport({ scale: 180 / base.width });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(vp.width);
          canvas.height = Math.ceil(vp.height);
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          if (!cancelled) propsRef.current.onThumbnailGenerated(i, canvas.toDataURL('image/jpeg', 0.8));
        } catch (err) {
          if (!cancelled && !isCancelled(err)) console.warn(`Thumbnail ${i} failed`, err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfDoc]);

  // ------------------------------------------------------ visibility tracking
  useEffect(() => {
    const container = containerRef.current;
    if (!container || pageSizes.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const p = Number((entry.target as HTMLElement).dataset.page);
          if (entry.isIntersecting && !visibleRef.current.has(p)) {
            visibleRef.current.add(p);
            changed = true;
          } else if (!entry.isIntersecting && visibleRef.current.has(p)) {
            visibleRef.current.delete(p);
            changed = true;
          }
        }
        if (changed) setVisiblePages(new Set(visibleRef.current));
      },
      { root: container, rootMargin: RENDER_MARGIN }
    );
    container.querySelectorAll<HTMLElement>('[data-page]').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [pageSizes]);

  // ------------------------------------------------------------ PDF rendering
  const renderPage = useCallback(async (doc: pdfjsLib.PDFDocumentProxy, pageNum: number, scale: number) => {
    const token = (renderTokens.current.get(pageNum) ?? 0) + 1;
    renderTokens.current.set(pageNum, token);
    renderTasks.current.get(pageNum)?.cancel();
    renderTasks.current.delete(pageNum);

    try {
      const page = await doc.getPage(pageNum);
      if (renderTokens.current.get(pageNum) !== token) return;
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: scale * dpr });

      // Render off-screen, then blit: the visible canvas never goes blank and
      // never has two render() calls in flight.
      const off = document.createElement('canvas');
      off.width = Math.max(1, Math.round(viewport.width));
      off.height = Math.max(1, Math.round(viewport.height));
      const offCtx = off.getContext('2d');
      if (!offCtx) return;
      const task = page.render({ canvasContext: offCtx, viewport });
      renderTasks.current.set(pageNum, task);
      await task.promise;
      if (renderTokens.current.get(pageNum) !== token) return;
      renderTasks.current.delete(pageNum);

      const canvas = pdfCanvasRefs.current.get(pageNum);
      if (!canvas) return;
      canvas.width = off.width;
      canvas.height = off.height;
      canvas.getContext('2d')?.drawImage(off, 0, 0);
      renderedScale.current.set(pageNum, scale);
    } catch (err) {
      if (!isCancelled(err)) console.error(`Error rendering page ${pageNum}:`, err);
    }
  }, []);

  useEffect(() => {
    if (!pdfDoc) return;
    // Short debounce so rapid zooming (Ctrl+wheel) doesn't thrash the renderer;
    // the old bitmap is CSS-stretched in the meantime.
    const handle = window.setTimeout(() => {
      for (const p of visiblePages) {
        if (renderedScale.current.get(p) !== zoom) renderPage(pdfDoc, p, zoom);
      }
    }, 60);
    return () => window.clearTimeout(handle);
  }, [pdfDoc, zoom, visiblePages, renderPage]);

  // --------------------------------------------------------- overlay drawing
  const redrawPage = useCallback((pageNum: number) => {
    const { annotations: anns, zoom: z, selectedId: sel } = propsRef.current;
    const size = pageSizesRef.current[pageNum - 1];
    const hl = hlCanvasRefs.current.get(pageNum);
    const an = annCanvasRefs.current.get(pageNum);
    if (!size || !hl || !an) return;

    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(size.width * z * dpr));
    const h = Math.max(1, Math.round(size.height * z * dpr));
    const ctxs: CanvasRenderingContext2D[] = [];
    for (const c of [hl, an]) {
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.setTransform(w / size.width, 0, 0, h / size.height, 0, 0);
      ctxs.push(ctx);
    }
    const [hlCtx, anCtx] = ctxs;

    const preview = previewRef.current;
    const editingId = textEditorRef.current?.editingId;
    const numbers = citationNumbers(anns);
    const partCtx = { measure: canvasMeasure, citeNumbers: numbers };
    let selected: Annotation | null = null;
    const pageCites: CitationAnnotation[] = [];

    const draw = (a: Annotation) => drawParts(anCtx, annotationParts(a, partCtx), hlCtx);

    for (const ann of anns) {
      if (ann.pageNumber !== pageNum || erasedRef.current.has(ann.id) || ann.id === editingId) continue;
      const a = preview && preview.id === ann.id ? preview : ann;
      draw(a);
      if (a.type === 'cite') pageCites.push(a);
      if (a.id === sel) selected = a;
    }

    const draft = draftRef.current;
    if (draft && draft.pageNumber === pageNum) draw(draft);

    if (pageCites.length) {
      drawParts(anCtx, footnoteParts(pageCites, numbers, size.width, size.height, canvasMeasure), hlCtx);
    }

    if (selected) {
      const b = getBounds(selected);
      const pad = 4 / z;
      anCtx.save();
      anCtx.strokeStyle = '#b9432f';
      anCtx.lineWidth = 1 / z;
      anCtx.setLineDash([4 / z, 3 / z]);
      anCtx.strokeRect(b.x - pad, b.y - pad, b.width + 2 * pad, b.height + 2 * pad);
      // Resize handles
      anCtx.setLineDash([]);
      anCtx.lineWidth = 1.5 / z;
      anCtx.fillStyle = '#ffffff';
      const hs = HANDLE_PX / z;
      for (const h of handlePositions(selected)) {
        anCtx.beginPath();
        if (h.handle === 'p1' || h.handle === 'p2') anCtx.arc(h.x, h.y, hs / 2, 0, Math.PI * 2);
        else anCtx.rect(h.x - hs / 2, h.y - hs / 2, hs, hs);
        anCtx.fill();
        anCtx.stroke();
      }
      anCtx.restore();
    }
  }, []);

  // Redraw overlays synchronously before paint whenever inputs change
  useLayoutEffect(() => {
    for (const p of visiblePages) redrawPage(p);
  }, [annotations, zoom, selectedId, visiblePages, pageSizes, textEditor, redrawPage]);

  // ------------------------------------------------------- zoom & scrolling
  // Keep the point under the cursor (or the viewport center) fixed while zooming
  useLayoutEffect(() => {
    const prev = prevZoomRef.current;
    prevZoomRef.current = zoom;
    const container = containerRef.current;
    if (!container || prev === zoom || pageSizes.length === 0) return;

    const anchor = zoomAnchorRef.current ?? { x: container.clientWidth / 2, y: container.clientHeight / 2 };
    zoomAnchorRef.current = null;
    const { top, left } = lastScrollRef.current;

    const y = top + anchor.y;
    const page = pageAtY(y, prev);
    const offsetInPage = (y - pageTop(page, prev)) / prev;
    const newTop = pageTop(page, zoom) + offsetInPage * zoom - anchor.y;

    const x = left + anchor.x - PAD_X;
    const newLeft = x * (zoom / prev) + PAD_X - anchor.x;

    container.scrollTop = Math.max(0, newTop);
    container.scrollLeft = Math.max(0, newLeft);
    lastScrollRef.current = { top: container.scrollTop, left: container.scrollLeft };
  }, [zoom, pageSizes, pageAtY, pageTop]);

  // Ctrl + wheel zoom (needs a non-passive listener)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      zoomAnchorRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const factor = Math.exp(-e.deltaY * 0.0015);
      propsRef.current.onZoomChange((z) => Math.round(z * factor * 100) / 100);
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, []);

  const scrollRafRef = useRef<number | null>(null);
  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;
    lastScrollRef.current = { top: container.scrollTop, left: container.scrollLeft };
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const c = containerRef.current;
      if (!c || pageSizesRef.current.length === 0) return;
      const page = pageAtY(c.scrollTop + c.clientHeight * 0.35, propsRef.current.zoom);
      if (page !== reportedPageRef.current) {
        reportedPageRef.current = page;
        propsRef.current.onCurrentPageChange(page);
      }
    });
  };

  // Jump to page
  useEffect(() => {
    if (!targetJumpPage || pageSizes.length === 0) return;
    const container = containerRef.current;
    if (container && targetJumpPage >= 1 && targetJumpPage <= pageSizes.length) {
      container.scrollTo({ top: pageTop(targetJumpPage, zoom) - 8, behavior: 'smooth' });
    }
    propsRef.current.onJumpComplete();
  }, [targetJumpPage, pageSizes, pageTop, zoom]);

  // --------------------------------------------------------- imperative API
  useEffect(() => {
    apiRef.current = {
      getFitWidthZoom: () => {
        const c = containerRef.current;
        if (!c || !maxPageWidth) return null;
        return (c.clientWidth - PAD_X * 2 - 8) / maxPageWidth;
      },
      getFitPageZoom: () => {
        const c = containerRef.current;
        const size = pageSizesRef.current[reportedPageRef.current - 1] ?? pageSizesRef.current[0];
        if (!c || !size) return null;
        return Math.min((c.clientWidth - PAD_X * 2 - 8) / size.width, (c.clientHeight - PAD_TOP - PAD_BOTTOM) / size.height);
      },
      exportPageImage: (pageNum) => {
        const pdfCanvas = pdfCanvasRefs.current.get(pageNum);
        const size = pageSizesRef.current[pageNum - 1];
        if (!pdfCanvas || !size || !renderedScale.current.has(pageNum)) return null;
        const out = document.createElement('canvas');
        out.width = pdfCanvas.width;
        out.height = pdfCanvas.height;
        const ctx = out.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(pdfCanvas, 0, 0);
        ctx.setTransform(out.width / size.width, 0, 0, out.height / size.height, 0, 0);
        const all = propsRef.current.annotations;
        const numbers = citationNumbers(all);
        const anns = all.filter((a) => a.pageNumber === pageNum);
        const parts: RenderPart[] = anns.flatMap((a) => annotationParts(a, { measure: canvasMeasure, citeNumbers: numbers }));
        const cites = anns.filter((a): a is CitationAnnotation => a.type === 'cite');
        parts.push(...footnoteParts(cites, numbers, size.width, size.height, canvasMeasure));
        const isMultiply = (p: RenderPart) => p.kind === 'path' && !!p.multiply;
        ctx.globalCompositeOperation = 'multiply';
        drawParts(ctx, parts.filter(isMultiply));
        ctx.globalCompositeOperation = 'source-over';
        drawParts(ctx, parts.filter((p) => !isMultiply(p)));
        return out.toDataURL('image/png');
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, maxPageWidth]);

  // --------------------------------------------------------- interaction
  const getPoint = (e: React.PointerEvent, pageNum: number): Point => {
    const canvas = annCanvasRefs.current.get(pageNum);
    const size = pageSizesRef.current[pageNum - 1];
    if (!canvas || !size) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * size.width,
      y: ((e.clientY - rect.top) / rect.height) * size.height,
    };
  };

  const topHit = (pageNum: number, pt: Point): Annotation | null => {
    const tol = 6 / zoom;
    for (let i = annotations.length - 1; i >= 0; i--) {
      const a = annotations[i];
      if (a.pageNumber === pageNum && !erasedRef.current.has(a.id) && isHit(a, pt, tol)) return a;
    }
    return null;
  };

  const buildShape = (start: Point, end: Point, pageNum: number, shift: boolean): Annotation | null => {
    let p2 = end;
    if (shift) {
      if (activeTool === 'rect' || activeTool === 'circle') {
        const d = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y));
        p2 = { x: start.x + Math.sign(end.x - start.x || 1) * d, y: start.y + Math.sign(end.y - start.y || 1) * d };
      } else {
        const angle = Math.round(Math.atan2(end.y - start.y, end.x - start.x) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(end.x - start.x, end.y - start.y);
        p2 = { x: start.x + len * Math.cos(angle), y: start.y + len * Math.sin(angle) };
      }
    }
    const base = { pageNumber: pageNum, createdAt: Date.now(), strokeColor: activeColor, strokeWidth };
    switch (activeTool) {
      case 'rect':
        return {
          ...base,
          id: newId('rect'),
          type: 'rect',
          x: Math.min(start.x, p2.x),
          y: Math.min(start.y, p2.y),
          width: Math.abs(p2.x - start.x),
          height: Math.abs(p2.y - start.y),
        };
      case 'circle':
        return {
          ...base,
          id: newId('circle'),
          type: 'circle',
          x: (start.x + p2.x) / 2,
          y: (start.y + p2.y) / 2,
          radiusX: Math.abs(p2.x - start.x) / 2,
          radiusY: Math.abs(p2.y - start.y) / 2,
        };
      case 'line':
      case 'arrow':
        return { ...base, id: newId(activeTool), type: activeTool, x1: start.x, y1: start.y, x2: p2.x, y2: p2.y };
      case 'measure':
        return { ...base, id: newId('measure'), type: 'measure', x1: start.x, y1: start.y, x2: p2.x, y2: p2.y, unit: measureUnit };
      case 'cite':
        return {
          id: newId('cite'),
          type: 'cite',
          pageNumber: pageNum,
          createdAt: Date.now(),
          color: activeColor,
          x: Math.min(start.x, end.x),
          y: Math.min(start.y, end.y),
          width: Math.abs(end.x - start.x),
          height: Math.abs(end.y - start.y),
          note: '',
          quote: '',
        };
      default:
        return null;
    }
  };

  const shapeIsBigEnough = (a: Annotation) => {
    const min = 3;
    switch (a.type) {
      case 'rect': return a.width > min || a.height > min;
      case 'cite': return a.width > 8 && a.height > 4;
      case 'circle': return a.radiusX > min / 2 || a.radiusY > min / 2;
      case 'line':
      case 'arrow':
      case 'measure': return Math.hypot(a.x2 - a.x1, a.y2 - a.y1) > min;
      default: return true;
    }
  };

  const eraseAt = (pageNum: number, pt: Point) => {
    const hit = topHit(pageNum, pt);
    if (hit) {
      erasedRef.current.add(hit.id);
      redrawPage(pageNum);
    }
  };

  const commitText = useCallback(() => {
    const ed = textEditorRef.current;
    if (!ed) return;
    textEditorRef.current = null;
    setTextEditor(null);
    const text = ed.value.replace(/\s+$/, '');
    const { annotations: anns, onAddAnnotation, onUpdateAnnotation, onDeleteAnnotations } = propsRef.current;
    if (ed.editingId) {
      const orig = anns.find((a) => a.id === ed.editingId);
      if (!orig || orig.type !== 'text') return;
      if (!text.trim()) onDeleteAnnotations([orig.id]);
      else if (text !== orig.text) onUpdateAnnotation({ ...orig, text });
      return;
    }
    if (!text.trim()) return;
    const ann: TextAnnotation = {
      id: newId('text'),
      pageNumber: ed.page,
      type: 'text',
      x: ed.x,
      y: ed.y,
      text,
      fontSize: ed.fontSize,
      color: ed.color,
      createdAt: Date.now(),
    };
    onAddAnnotation(ann);
  }, []);

  const startTextEdit = (ann: TextAnnotation) => {
    setTextEditor({
      page: ann.pageNumber,
      x: ann.x,
      y: ann.y,
      value: ann.text,
      fontSize: ann.fontSize,
      color: ann.color,
      editingId: ann.id,
    });
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>, pageNum: number) => {
    if (e.button !== 0) return;
    const pt = getPoint(e, pageNum);

    if (textEditorRef.current) {
      // First click outside an open editor just commits it
      e.preventDefault();
      commitText();
      return;
    }

    if (activeTool === 'text') {
      e.preventDefault();
      const hit = topHit(pageNum, pt);
      if (hit?.type === 'text') {
        startTextEdit(hit);
      } else {
        setTextEditor({
          page: pageNum,
          x: pt.x,
          y: pt.y,
          value: '',
          fontSize: strokeWidth,
          color: activeColor,
        });
      }
      return;
    }

    e.currentTarget.setPointerCapture(e.pointerId);

    // Grabbing a handle of the current selection resizes it
    if (activeTool === 'select' || activeTool === 'pan' || activeTool === 'cite') {
      const h = handleAt(pageNum, pt);
      if (h) {
        gestureRef.current = { kind: 'resize', page: pageNum, handle: h.handle, orig: h.ann };
        previewRef.current = h.ann;
        return;
      }
    }

    switch (activeTool) {
      case 'select':
      case 'pan': {
        const hit = topHit(pageNum, pt);
        props.onSelect(hit ? hit.id : null);
        if (hit) {
          gestureRef.current = { kind: 'move', page: pageNum, start: pt, orig: hit };
          previewRef.current = hit;
        }
        break;
      }
      case 'eraser':
        erasedRef.current = new Set();
        gestureRef.current = { kind: 'erase', page: pageNum };
        eraseAt(pageNum, pt);
        break;
      case 'pen':
        gestureRef.current = { kind: 'draw', page: pageNum, straight: false, holdAnchor: pt, last: pt };
        armHoldTimer(pageNum);
        draftRef.current = {
          id: newId('pen'),
          pageNumber: pageNum,
          type: 'pen',
          penType,
          points: [pt],
          color: activeColor,
          width: strokeWidth,
          opacity: 1,
          createdAt: Date.now(),
        };
        redrawPage(pageNum);
        break;
      case 'highlighter':
        gestureRef.current = { kind: 'draw', page: pageNum, straight: false, holdAnchor: pt, last: pt };
        armHoldTimer(pageNum);
        draftRef.current = {
          id: newId('hl'),
          pageNumber: pageNum,
          type: 'highlighter',
          points: [pt],
          color: activeColor,
          width: strokeWidth,
          opacity: HIGHLIGHT_OPACITY,
          createdAt: Date.now(),
        };
        redrawPage(pageNum);
        break;
      case 'cite': {
        // Clicking an existing citation selects it (and shows it in the panel)
        const hit = topHit(pageNum, pt);
        if (hit?.type === 'cite') {
          props.onSelect(hit.id);
          gestureRef.current = { kind: 'move', page: pageNum, start: pt, orig: hit };
          previewRef.current = hit;
          break;
        }
        gestureRef.current = { kind: 'shape', page: pageNum, start: pt };
        draftRef.current = null;
        break;
      }
      default:
        if (SHAPE_TOOLS.includes(activeTool)) {
          gestureRef.current = { kind: 'shape', page: pageNum, start: pt };
          draftRef.current = null;
        }
    }
  };

  /** Mark a passage: capture the text under it, then add the citation. */
  const addCitation = async (draft: CitationAnnotation) => {
    let quote = '';
    try {
      if (pdfDoc) quote = await extractTextInRect(pdfDoc, draft.pageNumber, draft);
    } catch (err) {
      console.warn('Could not extract text for citation:', err);
    }
    propsRef.current.onAddAnnotation({ ...draft, quote });
  };

  /** Handle of the selected annotation under the pointer, if any. */
  const handleAt = (pageNum: number, pt: Point): { handle: Handle; ann: Annotation } | null => {
    const sel = annotations.find((a) => a.id === selectedId);
    if (!sel || sel.pageNumber !== pageNum) return null;
    const r = (HANDLE_PX / 2 + 3) / zoom;
    // Endpoints/corners first so they win over edges at small sizes
    const hs = handlePositions(sel);
    for (const h of hs) {
      if (Math.abs(pt.x - h.x) <= r && Math.abs(pt.y - h.y) <= r) return { handle: h.handle, ann: sel };
    }
    return null;
  };

  const clearHoldTimer = () => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  /**
   * Hold-to-straighten: if the pointer rests while drawing, the freehand
   * stroke becomes a straight line from its start in the drawing direction.
   * The end then follows the pointer until release.
   */
  const armHoldTimer = (pageNum: number) => {
    clearHoldTimer();
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      const g = gestureRef.current;
      const draft = draftRef.current;
      if (!g || g.kind !== 'draw' || g.straight || g.page !== pageNum) return;
      if (!draft || (draft.type !== 'pen' && draft.type !== 'highlighter')) return;
      const start = draft.points[0];
      const z = propsRef.current.zoom;
      if (Math.hypot(g.last.x - start.x, g.last.y - start.y) * z < 12) return; // too short to have a direction
      g.straight = true;
      draft.points = [start, snapAngle(start, g.last)];
      redrawPage(pageNum);
    }, HOLD_TO_STRAIGHTEN_MS);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>, pageNum: number) => {
    const g = gestureRef.current;
    const pt = getPoint(e, pageNum);

    // Hover feedback: resize cursors over handles, move cursor over annotations
    if (!g) {
      const canvas = e.currentTarget;
      let cursor = '';
      if (activeTool === 'select' || activeTool === 'cite') {
        const h = handleAt(pageNum, pt);
        if (h) cursor = HANDLE_CURSORS[h.handle];
        else if (activeTool === 'select' && topHit(pageNum, pt)) cursor = 'move';
      }
      if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
      return;
    }
    if (g.page !== pageNum) return;

    switch (g.kind) {
      case 'move':
        previewRef.current = translateAnnotation(g.orig, pt.x - g.start.x, pt.y - g.start.y);
        redrawPage(pageNum);
        break;
      case 'resize':
        previewRef.current = resizeAnnotation(g.orig, g.handle, pt, e.shiftKey);
        redrawPage(pageNum);
        break;
      case 'erase':
        eraseAt(pageNum, pt);
        break;
      case 'draw': {
        const draft = draftRef.current;
        if (!draft || (draft.type !== 'pen' && draft.type !== 'highlighter')) break;
        g.last = pt;
        if (g.straight) {
          draft.points = [draft.points[0], snapAngle(draft.points[0], pt)];
          redrawPage(pageNum);
          break;
        }
        // Restart the hold timer only on real movement, not hand jitter
        if (Math.hypot(pt.x - g.holdAnchor.x, pt.y - g.holdAnchor.y) * zoom > HOLD_TOLERANCE_PX) {
          g.holdAnchor = pt;
          armHoldTimer(pageNum);
        }
        const last = draft.points[draft.points.length - 1];
        if (Math.hypot(pt.x - last.x, pt.y - last.y) * zoom >= 1.5) {
          draft.points.push(pt);
          redrawPage(pageNum);
        }
        break;
      }
      case 'shape':
        draftRef.current = buildShape(g.start, pt, pageNum, e.shiftKey);
        redrawPage(pageNum);
        break;
    }
  };

  const finishGesture = (e: React.PointerEvent<HTMLCanvasElement>, pageNum: number, cancelled: boolean) => {
    const g = gestureRef.current;
    if (!g || g.page !== pageNum) return;
    gestureRef.current = null;
    clearHoldTimer();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);

    const draft = draftRef.current;
    draftRef.current = null;
    const preview = previewRef.current;
    previewRef.current = null;
    const erased = [...erasedRef.current];
    erasedRef.current = new Set();

    if (!cancelled) {
      switch (g.kind) {
        case 'move':
        case 'resize':
          if (preview && JSON.stringify(preview) !== JSON.stringify(g.orig)) props.onUpdateAnnotation(preview);
          break;
        case 'erase':
          if (erased.length) props.onDeleteAnnotations(erased);
          break;
        case 'draw':
          if (draft) props.onAddAnnotation(draft);
          break;
        case 'shape':
          if (draft && shapeIsBigEnough(draft)) {
            if (draft.type === 'cite') addCitation(draft);
            else props.onAddAnnotation(draft);
          } else if (activeTool === 'cite') {
            props.onSelect(null);
          }
          break;
      }
    }
    redrawPage(pageNum);
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>, pageNum: number) => {
    if (activeTool !== 'select') return;
    const canvas = annCanvasRefs.current.get(pageNum);
    const size = pageSizesRef.current[pageNum - 1];
    if (!canvas || !size) return;
    const rect = canvas.getBoundingClientRect();
    const pt = {
      x: ((e.clientX - rect.left) / rect.width) * size.width,
      y: ((e.clientY - rect.top) / rect.height) * size.height,
    };
    const hit = topHit(pageNum, pt);
    if (hit?.type === 'text') startTextEdit(hit);
  };

  // Clear selection when leaving the select tool; abort any in-flight gesture
  useEffect(() => {
    if (activeTool !== 'select' && activeTool !== 'cite' && propsRef.current.selectedId) {
      propsRef.current.onSelect(null);
    }
    gestureRef.current = null;
    draftRef.current = null;
    previewRef.current = null;
    clearHoldTimer();
  }, [activeTool]);

  // Keyboard: Delete removes selection, Escape cancels
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA'].includes(target.tagName) || target.isContentEditable) return;
      const { selectedId: sel, onDeleteAnnotations, onSelect } = propsRef.current;
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        e.preventDefault();
        onDeleteAnnotations([sel]);
        onSelect(null);
      } else if (e.key === 'Escape') {
        const g = gestureRef.current;
        gestureRef.current = null;
        draftRef.current = null;
        previewRef.current = null;
        erasedRef.current = new Set();
        if (holdTimerRef.current !== null) {
          window.clearTimeout(holdTimerRef.current);
          holdTimerRef.current = null;
        }
        if (g) redrawPage(g.page);
        else if (sel) onSelect(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [redrawPage]);

  // ------------------------------------------------------------------ render
  const cursor =
    activeTool === 'select'
      ? 'default'
      : activeTool === 'text'
        ? 'text'
        : activeTool === 'pan'
          ? 'grab'
          : activeTool === 'cite'
            ? 'cell'
            : 'crosshair';

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 h-full overflow-auto bg-viewer relative"
    >
      {loadError ? (
        <div className="h-full flex flex-col items-center justify-center text-ink-2 p-8 text-center">
          <p className="text-sm text-accent mb-1">Could not open this PDF</p>
          <p className="text-xs text-ink-3 max-w-md">{loadError}</p>
        </div>
      ) : pageSizes.length === 0 ? (
        <div className="h-full flex items-center justify-center text-ink-3 text-[13px]">Loading document…</div>
      ) : (
        <div
          className="flex flex-col items-center"
          style={{ width: 'max-content', minWidth: '100%', padding: `${PAD_TOP}px ${PAD_X}px ${PAD_BOTTOM}px` }}
        >
          {pageSizes.map((size, i) => {
            const pageNum = i + 1;
            const isVisible = visiblePages.has(pageNum);
            const w = size.width * zoom;
            const h = size.height * zoom;
            const editor = textEditor && textEditor.page === pageNum ? textEditor : null;
            return (
              <div
                key={pageNum}
                data-page={pageNum}
                className="relative bg-white shrink-0 shadow-[0_1px_2px_rgba(0,0,0,0.06),0_8px_28px_-12px_rgba(0,0,0,0.18)]"
                style={{ isolation: 'isolate', width: w, height: h, marginBottom: i < pageSizes.length - 1 ? PAGE_GAP : 0, cursor }}
              >
                {isVisible && (
                  <>
                    <canvas
                      ref={(el) => {
                        if (el) pdfCanvasRefs.current.set(pageNum, el);
                        else {
                          pdfCanvasRefs.current.delete(pageNum);
                          renderedScale.current.delete(pageNum);
                          renderTasks.current.get(pageNum)?.cancel();
                          renderTasks.current.delete(pageNum);
                        }
                      }}
                      className="absolute inset-0 w-full h-full block"
                    />
                    <canvas
                      ref={(el) => {
                        if (el) hlCanvasRefs.current.set(pageNum, el);
                        else hlCanvasRefs.current.delete(pageNum);
                      }}
                      className="absolute inset-0 w-full h-full pointer-events-none"
                      style={{ mixBlendMode: 'multiply' }}
                    />
                    <canvas
                      ref={(el) => {
                        if (el) annCanvasRefs.current.set(pageNum, el);
                        else annCanvasRefs.current.delete(pageNum);
                      }}
                      onPointerDown={(e) => handlePointerDown(e, pageNum)}
                      onPointerMove={(e) => handlePointerMove(e, pageNum)}
                      onPointerUp={(e) => finishGesture(e, pageNum, false)}
                      onPointerCancel={(e) => finishGesture(e, pageNum, true)}
                      onDoubleClick={(e) => handleDoubleClick(e, pageNum)}
                      className="absolute inset-0 w-full h-full z-10 touch-none"
                    />
                  </>
                )}

                {editor && (
                  <TextEditorBox
                    editor={editor}
                    zoom={zoom}
                    onChange={(value) => setTextEditor((prev) => (prev ? { ...prev, value } : prev))}
                    onCommit={commitText}
                    onCancel={() => {
                      textEditorRef.current = null;
                      setTextEditor(null);
                    }}
                  />
                )}

                <div className="absolute -bottom-6 inset-x-0 text-center text-ink-3 text-[11px] tabular-nums pointer-events-none select-none">
                  {pageNum} / {pageSizes.length}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

interface TextEditorBoxProps {
  editor: TextEditorState;
  zoom: number;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

const TextEditorBox: React.FC<TextEditorBoxProps> = ({ editor, zoom, onChange, onCommit, onCancel }) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fontPx = editor.fontSize * zoom;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const id = window.setTimeout(() => {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  // Auto-size to content
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
    el.style.width = '0px';
    el.style.width = `${Math.max(el.scrollWidth + fontPx, 80)}px`;
  }, [editor.value, fontPx]);

  // Align the textarea's first baseline with the canvas text baseline
  const halfLeading = ((TEXT_LINE_HEIGHT - 1) / 2) * fontPx;
  const topOffset = halfLeading + fontPx * (0.9 - TEXT_BASELINE);

  return (
    <textarea
      ref={ref}
      value={editor.value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        } else if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          onCommit();
        }
      }}
      onPointerDown={(e) => e.stopPropagation()}
      placeholder="Type a note…"
      spellCheck={false}
      rows={1}
      className="absolute z-30 resize-none overflow-hidden bg-white/80 outline-1 outline-dashed outline-[#b9432f] rounded-sm p-0 m-0 border-0 whitespace-pre select-text"
      style={{
        left: editor.x * zoom,
        top: editor.y * zoom - topOffset,
        fontSize: fontPx,
        lineHeight: TEXT_LINE_HEIGHT,
        fontFamily: TEXT_FONT,
        color: editor.color,
      }}
    />
  );
};
