import React, { useState, useEffect, useRef, useCallback } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { Sidebar } from './components/Sidebar';
import { TopBar, ToolDock } from './components/Toolbar';
import { Logo } from './components/Logo';
import { PDFViewer, ViewerApi } from './components/PDFViewer';
import { CitationPanel } from './components/CitationPanel';
import { TextEditor } from './components/TextEditor';
import { FileEntry, Annotation, ToolType, PenType, MeasureUnit, DocumentSource } from './types';
import { defaultToolWidths, widthKey } from './utils/tools';
import { citationNumbers, sortedCitations } from './utils/citations';
import {
  bakeAnnotationsToPdf,
  uint8ArrayToBase64,
  base64ToUint8Array,
  triggerBlobDownload,
} from './utils/pdfExport';
import { loadAnnotationsFromPdf, saveAnnotationsToPdf } from './utils/pdfAnnotations';
import { FileUp, FolderOpen } from 'lucide-react';
import './App.css';

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

const isTextName = (name: string) => /\.(txt|md|markdown)$/i.test(name);
const isMarkdownName = (name: string) => /\.(md|markdown)$/i.test(name);
const isSupportedName = (name: string) => /\.pdf$/i.test(name) || isTextName(name);

// Session restore: the last open file and folder are reopened on launch
const LAST_FILE_KEY = 'zenpdf.lastFile';
const LAST_FOLDER_KEY = 'zenpdf.lastFolder';
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v) localStorage.setItem(k, v);
      else localStorage.removeItem(k);
    } catch {
      /* storage unavailable */
    }
  },
};

export function App() {
  // Document State
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  /** Content of an open .txt / .md file (null when a PDF or nothing is open). */
  const [textContent, setTextContent] = useState<string | null>(null);
  const isTextDoc = textContent !== null;
  const hasDocument = !!pdfBytes || isTextDoc;
  const [docId, setDocId] = useState(0);
  const [isDirty, setIsDirty] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState(false);

  // Sidebar & Folder Workspace State
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [folderTree, setFolderTree] = useState<FileEntry[]>([]);

  // Navigation & Zoom State
  const [zoom, setZoom] = useState<number>(1.0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [numPages, setNumPages] = useState<number>(0);
  const [targetJumpPage, setTargetJumpPage] = useState<number | null>(null);
  const [pageThumbnails, setPageThumbnails] = useState<string[]>([]);
  const viewerApiRef = useRef<ViewerApi | null>(null);

  // Annotation & Tool State
  const [activeTool, setActiveTool] = useState<ToolType>('select');
  const [activeColor, setActiveColor] = useState<string>('#e9b949');
  // Each tool remembers its own thickness (font size for text)
  const [toolWidths, setToolWidths] = useState(defaultToolWidths);
  const strokeWidth = toolWidths[widthKey(activeTool)] ?? 2;
  const setStrokeWidth = (w: number) => setToolWidths((prev) => ({ ...prev, [widthKey(activeTool)]: w }));
  const [penType, setPenType] = useState<PenType>('ballpoint');
  const [measureUnit, setMeasureUnit] = useState<MeasureUnit>('cm');
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);

  // Bibliographic info for the open document (citations)
  const emptySource: DocumentSource = { author: '', title: '', year: '', publisher: '', url: '' };
  const [docSource, setDocSource] = useState<DocumentSource>(emptySource);
  const isCitationPanelOpen = activeTool === 'cite' && !!pdfBytes;

  // History for Undo / Redo
  const [undoStack, setUndoStack] = useState<Annotation[][]>([]);
  const [redoStack, setRedoStack] = useState<Annotation[][]>([]);

  // Helper: Load folder directory
  const refreshFolder = useCallback(async (path: string) => {
    try {
      if (isTauri()) {
        const entries = await invoke<FileEntry[]>('list_directory', { path });
        setFolderTree(entries);
      }
    } catch (err) {
      console.error('Failed to list directory:', err);
    }
  }, []);

  const handleOpenFolder = async () => {
    try {
      if (isTauri()) {
        const selected = await invoke<string | null>('pick_folder');
        if (selected) {
          setFolderPath(selected);
          await refreshFolder(selected);
        }
      } else {
        alert('Folder browsing via native file system is active when running the desktop app.');
      }
    } catch (err) {
      console.error('Error opening folder:', err);
    }
  };

  const confirmDiscard = () =>
    !isDirty ||
    window.confirm(
      isTextDoc
        ? 'You have unsaved changes. Discard them and open another document?'
        : 'You have unsaved annotations. Discard them and open another document?'
    );

  // A citation source stored in the file beats the PDF's own metadata
  const sourceFromFileRef = useRef(false);

  /**
   * Open raw file bytes: ZenPDF annotations saved in the file are lifted back
   * out as editable objects, and the page content shown underneath is clean.
   */
  const loadDocument = async (raw: Uint8Array, name: string, path: string | null) => {
    const { bytes, annotations: saved, source } = await loadAnnotationsFromPdf(raw);
    setTextContent(null);
    setPdfBytes(bytes);
    setFileName(name);
    setFilePath(path);
    setDocId((id) => id + 1);
    setAnnotations(saved);
    setSelectedAnnotationId(null);
    setUndoStack([]);
    setRedoStack([]);
    setIsDirty(false);
    setPageThumbnails([]);
    setNumPages(0);
    setCurrentPage(1);
    sourceFromFileRef.current = !!source;
    setDocSource(source ?? { ...emptySource, title: name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ') });
  };

  const handleMetadata = useCallback((meta: { title?: string; author?: string; year?: string }) => {
    if (sourceFromFileRef.current) return;
    setDocSource((prev) => ({
      ...prev,
      title: meta.title ?? prev.title,
      author: prev.author || meta.author || '',
      year: prev.year || meta.year || '',
    }));
  }, []);

  /** Open a .txt / .md file in the text editor. */
  const loadTextDocument = (content: string, name: string, path: string | null) => {
    setPdfBytes(null);
    setTextContent(content);
    setFileName(name);
    setFilePath(path);
    setDocId((id) => id + 1);
    setAnnotations([]);
    setSelectedAnnotationId(null);
    setUndoStack([]);
    setRedoStack([]);
    setIsDirty(false);
    setPageThumbnails([]);
    setNumPages(0);
    setCurrentPage(1);
    setActiveTool('select');
  };

  const openPdfFromPath = async (absPath: string, opts: { silent?: boolean } = {}) => {
    if (absPath === filePath) return;
    if (!opts.silent && !confirmDiscard()) return;
    const name = absPath.split(/[/\\]/).pop() || 'document.pdf';
    try {
      if (isTextName(name)) {
        const content = await invoke<string>('read_text_file', { path: absPath });
        loadTextDocument(content, name, absPath);
      } else {
        const base64Data = await invoke<string>('read_pdf_file', { path: absPath });
        await loadDocument(base64ToUint8Array(base64Data), name, absPath);
      }
    } catch (err) {
      console.error('Failed to open file from path:', err);
      if (opts.silent) store.set(LAST_FILE_KEY, null);
      else alert(`Could not open ${name}: ${err}`);
    }
  };

  /** Browser fallback: open a File picked or dropped by the user. */
  const openBrowserFile = async (file: File) => {
    if (!isSupportedName(file.name) && file.type !== 'application/pdf') return;
    if (!confirmDiscard()) return;
    if (isTextName(file.name)) loadTextDocument(await file.text(), file.name, null);
    else await loadDocument(new Uint8Array(await file.arrayBuffer()), file.name, null);
  };

  const handleOpenFile = async () => {
    try {
      if (isTauri()) {
        const selected = await invoke<string | null>('pick_file');
        if (selected) await openPdfFromPath(selected);
      } else {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/pdf,.pdf,.txt,.md,.markdown';
        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (file) await openBrowserFile(file);
        };
        input.click();
      }
    } catch (err) {
      console.error('Error picking file:', err);
    }
  };

  const handleRevealInExplorer = async (path: string) => {
    try {
      if (isTauri()) await invoke('reveal_in_explorer', { path });
    } catch (err) {
      console.error('Error revealing in Explorer:', err);
    }
  };

  // ------------------------------------------------ annotations + history
  const commitAnnotations = (next: Annotation[]) => {
    setUndoStack((prev) => [...prev.slice(-199), annotations]);
    setRedoStack([]);
    setAnnotations(next);
    setIsDirty(true);
  };

  const handleAddAnnotation = (ann: Annotation) => {
    commitAnnotations([...annotations, ann]);
    // New citations open straight into the panel for editing
    if (ann.type === 'cite') setSelectedAnnotationId(ann.id);
  };

  const handleUpdateAnnotation = (ann: Annotation) =>
    commitAnnotations(annotations.map((a) => (a.id === ann.id ? ann : a)));

  const handleDeleteAnnotations = (ids: string[]) => {
    const remove = new Set(ids);
    if (!annotations.some((a) => remove.has(a.id))) return;
    commitAnnotations(annotations.filter((a) => !remove.has(a.id)));
    if (selectedAnnotationId && remove.has(selectedAnnotationId)) setSelectedAnnotationId(null);
  };

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    setRedoStack((prev) => [...prev, annotations]);
    setAnnotations(undoStack[undoStack.length - 1]);
    setUndoStack((prev) => prev.slice(0, -1));
    setSelectedAnnotationId(null);
    setIsDirty(true);
  };

  const handleRedo = () => {
    if (redoStack.length === 0) return;
    setUndoStack((prev) => [...prev, annotations]);
    setAnnotations(redoStack[redoStack.length - 1]);
    setRedoStack((prev) => prev.slice(0, -1));
    setSelectedAnnotationId(null);
    setIsDirty(true);
  };

  // ------------------------------------------------------------- saving
  // The in-memory PDF never contains our annotations; each save writes them
  // as separate, editable PDF annotation objects on top of it.
  const buildSavedPdf = () => saveAnnotationsToPdf(pdfBytes!, annotations, docSource);

  const saveTextAs = async () => {
    const name = fileName ?? 'untitled.md';
    if (isTauri()) {
      const savePath = await invoke<string | null>('pick_save_path', { defaultName: name });
      if (!savePath) return;
      await invoke('write_text_file', { path: savePath, content: textContent ?? '' });
      const newName = savePath.split(/[/\\]/).pop() || savePath;
      setFilePath(savePath);
      setFileName(newName);
      setIsDirty(false);
      if (folderPath) refreshFolder(folderPath);
    } else {
      const blob = new Blob([textContent ?? ''], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
      setIsDirty(false);
    }
  };

  const handleSaveAsFile = async () => {
    if (!hasDocument || isSaving) return;
    setIsSaving(true);
    try {
      if (isTextDoc) {
        await saveTextAs();
        return;
      }
      const out = await buildSavedPdf();
      if (isTauri()) {
        const base = fileName?.replace(/\.pdf$/i, '') ?? 'document';
        const savePath = await invoke<string | null>('pick_save_path', { defaultName: `${base}.pdf` });
        if (!savePath) return;
        await invoke('write_pdf_file', { path: savePath, base64Data: uint8ArrayToBase64(out) });
        setFilePath(savePath);
        setFileName(savePath.split(/[/\\]/).pop() || savePath);
        setIsDirty(false);
        if (folderPath) refreshFolder(folderPath);
      } else {
        triggerBlobDownload(out, fileName || 'annotated.pdf');
        setIsDirty(false);
      }
    } catch (err) {
      console.error('Error in Save As:', err);
      alert(`Save As failed: ${err}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveFile = async () => {
    if (!hasDocument || isSaving) return;
    if (!isTauri() || !filePath) {
      await handleSaveAsFile();
      return;
    }
    setIsSaving(true);
    try {
      if (isTextDoc) {
        await invoke('write_text_file', { path: filePath, content: textContent });
      } else {
        const out = await buildSavedPdf();
        await invoke('write_pdf_file', { path: filePath, base64Data: uint8ArrayToBase64(out) });
      }
      setIsDirty(false);
    } catch (err) {
      console.error('Error saving file:', err);
      alert(`Save failed: ${err}`);
    } finally {
      setIsSaving(false);
    }
  };

  /** A separate, permanently flattened copy (for sharing); the working file stays editable. */
  const handleExportFlattened = async () => {
    if (!pdfBytes || isSaving) return;
    setIsSaving(true);
    try {
      const out = await bakeAnnotationsToPdf(pdfBytes, annotations);
      const base = fileName?.replace(/\.pdf$/i, '') ?? 'document';
      if (isTauri()) {
        const savePath = await invoke<string | null>('pick_save_path', { defaultName: `${base}_flattened.pdf` });
        if (!savePath) return;
        await invoke('write_pdf_file', { path: savePath, base64Data: uint8ArrayToBase64(out) });
        if (folderPath) refreshFolder(folderPath);
      } else {
        triggerBlobDownload(out, `${base}_flattened.pdf`);
      }
    } catch (err) {
      console.error('Error exporting flattened PDF:', err);
      alert(`Export failed: ${err}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleExportPageImage = () => {
    const dataUrl = viewerApiRef.current?.exportPageImage(currentPage);
    if (!dataUrl) {
      alert('The current page is not rendered yet. Scroll to it and try again.');
      return;
    }
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `${fileName ? fileName.replace(/\.pdf$/i, '') : 'page'}_page_${currentPage}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // ------------------------------------------------------------- zoom
  const updateZoom = useCallback((updater: (z: number) => number) => setZoom((z) => clampZoom(updater(z))), []);
  const handleZoomIn = () => updateZoom((z) => z * 1.15);
  const handleZoomOut = () => updateZoom((z) => z / 1.15);
  const handleFitWidth = () => {
    const z = viewerApiRef.current?.getFitWidthZoom();
    if (z) setZoom(clampZoom(z));
  };
  const handleFitPage = () => {
    const z = viewerApiRef.current?.getFitPageZoom();
    if (z) setZoom(clampZoom(z));
  };

  // ------------------------------------------------- keyboard shortcuts
  const shortcutRef = useRef<(e: KeyboardEvent) => void>(() => {});
  shortcutRef.current = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const key = e.key.toLowerCase();
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
    // While typing, only file shortcuts pass through (native undo etc. keep working)
    if (typing && !((e.ctrlKey || e.metaKey) && (key === 'o' || key === 's'))) return;

    if (e.ctrlKey || e.metaKey) {
      if (key === 'o') {
        e.preventDefault();
        handleOpenFile();
      } else if (key === 's') {
        e.preventDefault();
        if (e.shiftKey) handleSaveAsFile();
        else handleSaveFile();
      } else if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      } else if (key === 'y') {
        e.preventDefault();
        handleRedo();
      } else if (key === '=' || key === '+') {
        e.preventDefault();
        handleZoomIn();
      } else if (key === '-') {
        e.preventDefault();
        handleZoomOut();
      } else if (key === '0') {
        e.preventDefault();
        setZoom(1);
      } else if (key === 'b') {
        e.preventDefault();
        setIsSidebarOpen((prev) => !prev);
      }
      return;
    }
    if (e.altKey || isTextDoc) return;

    const toolKeys: Record<string, ToolType> = {
      '1': 'select',
      '2': 'highlighter',
      '3': 'pen',
      '4': 'text',
      '5': 'rect',
      '6': 'eraser',
      v: 'select',
      h: 'highlighter',
      p: 'pen',
      t: 'text',
      r: 'rect',
      o: 'circle',
      l: 'line',
      a: 'arrow',
      m: 'measure',
      c: 'cite',
      e: 'eraser',
    };
    const tool = toolKeys[key];
    if (tool) setActiveTool(tool);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => shortcutRef.current(e);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // ------------------------------------------------------- drag & drop
  const openPathRef = useRef(openPdfFromPath);
  openPathRef.current = openPdfFromPath;

  // Tauri intercepts OS file drops, so HTML drop events never carry files there.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === 'drop') {
          const doc = event.payload.paths.find((p) => isSupportedName(p));
          if (doc) openPathRef.current(doc);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err) => console.error('Drag & drop listener failed:', err));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const handleDragOver = (e: React.DragEvent) => e.preventDefault();

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    if (isTauri()) return; // handled by onDragDropEvent
    const file = e.dataTransfer.files?.[0];
    if (file) await openBrowserFile(file);
  };

  // ---------------------------------------------------- session restore
  // Remember what's open so the next launch picks up where the user left off.
  useEffect(() => {
    if (filePath) store.set(LAST_FILE_KEY, filePath);
  }, [filePath]);
  useEffect(() => {
    if (folderPath) store.set(LAST_FOLDER_KEY, folderPath);
  }, [folderPath]);

  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !isTauri()) return;
    restoredRef.current = true;
    const lastFolder = store.get(LAST_FOLDER_KEY);
    const lastFile = store.get(LAST_FILE_KEY);
    (async () => {
      if (lastFolder) {
        setFolderPath(lastFolder);
        await refreshFolder(lastFolder);
      }
      if (lastFile && (await invoke<boolean>('file_exists', { path: lastFile }).catch(() => false))) {
        await openPathRef.current(lastFile, { silent: true });
      } else if (lastFile) {
        store.set(LAST_FILE_KEY, null);
      }
    })();
  }, [refreshFolder]);

  // Warn before closing with unsaved annotations (browser / dev)
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  const handleThumbnail = useCallback((pageNum: number, dataUrl: string) => {
    setPageThumbnails((prev) => {
      const next = [...prev];
      next[pageNum] = dataUrl;
      return next;
    });
  }, []);

  return (
    <div
      className="flex flex-col h-screen w-screen overflow-hidden bg-app text-ink font-sans"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <TopBar
        isSidebarOpen={isSidebarOpen}
        onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
        documentTitle={fileName}
        isDirty={isDirty}
        hasDocument={hasDocument}
        isPdf={!!pdfBytes}
        isSaving={isSaving}
        onOpenFile={handleOpenFile}
        onSaveFile={handleSaveFile}
        onSaveAsFile={handleSaveAsFile}
        onExportFlattened={handleExportFlattened}
        onExportPageImage={handleExportPageImage}
        zoom={zoom}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onSetZoom={(z) => setZoom(clampZoom(z))}
        onFitWidth={handleFitWidth}
        onFitPage={handleFitPage}
      />

      <div className="flex flex-1 overflow-hidden relative">
        <Sidebar
          isOpen={isSidebarOpen}
          onToggle={() => setIsSidebarOpen(!isSidebarOpen)}
          folderPath={folderPath}
          folderTree={folderTree}
          currentFilePath={filePath}
          onSelectFile={openPdfFromPath}
          onOpenFolder={handleOpenFolder}
          onRefreshFolder={() => folderPath && refreshFolder(folderPath)}
          onRevealInExplorer={handleRevealInExplorer}
          numPages={numPages}
          currentPage={currentPage}
          onJumpToPage={(p) => setTargetJumpPage(p)}
          pageThumbnails={pageThumbnails}
          annotations={annotations}
          selectedAnnotationId={selectedAnnotationId}
          onSelectAnnotation={(ann) => {
            setActiveTool('select');
            setSelectedAnnotationId(ann.id);
            setTargetJumpPage(ann.pageNumber);
          }}
          onDeleteAnnotation={(id) => handleDeleteAnnotations([id])}
        />

        {pdfBytes ? (
          /* Editing area: the tool dock is centered on this column, not the window */
          <div className="relative flex-1 min-w-0 flex">
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 max-w-[calc(100%-24px)] w-max">
              <ToolDock
                activeTool={activeTool}
                onSelectTool={setActiveTool}
                activeColor={activeColor}
                onSelectColor={setActiveColor}
                strokeWidth={strokeWidth}
                onSelectStrokeWidth={setStrokeWidth}
                penType={penType}
                onSelectPenType={setPenType}
                measureUnit={measureUnit}
                onSelectMeasureUnit={setMeasureUnit}
                isCitationPanelOpen={isCitationPanelOpen}
                canUndo={undoStack.length > 0}
                canRedo={redoStack.length > 0}
                onUndo={handleUndo}
                onRedo={handleRedo}
              />
            </div>
          <PDFViewer
            pdfData={pdfBytes}
            docId={docId}
            zoom={zoom}
            onZoomChange={updateZoom}
            activeTool={activeTool}
            activeColor={activeColor}
            strokeWidth={strokeWidth}
            penType={penType}
            measureUnit={measureUnit}
            annotations={annotations}
            selectedId={selectedAnnotationId}
            onSelect={setSelectedAnnotationId}
            onAddAnnotation={handleAddAnnotation}
            onUpdateAnnotation={handleUpdateAnnotation}
            onDeleteAnnotations={handleDeleteAnnotations}
            onDocumentLoaded={setNumPages}
            onMetadata={handleMetadata}
            onThumbnailGenerated={handleThumbnail}
            onCurrentPageChange={setCurrentPage}
            targetJumpPage={targetJumpPage}
            onJumpComplete={() => setTargetJumpPage(null)}
            apiRef={viewerApiRef}
          />
          </div>
        ) : isTextDoc ? (
          <TextEditor
            content={textContent ?? ''}
            onChange={(next) => {
              setTextContent(next);
              setIsDirty(true);
            }}
            isMarkdown={isMarkdownName(fileName ?? '')}
            zoom={zoom}
            docId={docId}
          />
        ) : (
          /* Welcome: one mark, one line, two actions */
          <div className="flex-1 flex flex-col items-center justify-center p-8 bg-app text-center select-none">
            <Logo size={88} className="text-ink mb-8" />
            <h1 className="text-[22px] font-light tracking-[0.2em] text-ink mb-2">ZENPDF</h1>
            <p className="text-[13px] text-ink-3 mb-10">Read, mark and cite — quietly.</p>

            <div className="flex items-center gap-2">
              <button
                onClick={handleOpenFile}
                className="h-9 px-4 inline-flex items-center gap-2 rounded-md bg-ink text-on-ink text-[13px] hover:opacity-85 transition-opacity"
              >
                <FileUp className="w-4 h-4" />
                Open file
              </button>
              <button
                onClick={handleOpenFolder}
                className="h-9 px-4 inline-flex items-center gap-2 rounded-md text-ink-2 text-[13px] hover:bg-raised hover:text-ink transition-colors"
              >
                <FolderOpen className="w-4 h-4" />
                Open folder
              </button>
            </div>

            <p className="mt-16 text-[11px] text-ink-3 tracking-wide">
              or drop a PDF, text or Markdown file anywhere · <kbd className="font-sans">Ctrl O</kbd>
            </p>
          </div>
        )}

        {isCitationPanelOpen && (
          <CitationPanel
            citations={sortedCitations(annotations)}
            numbers={citationNumbers(annotations)}
            selectedId={selectedAnnotationId}
            onSelect={(c) => {
              setSelectedAnnotationId(c.id);
              setTargetJumpPage(c.pageNumber);
            }}
            onUpdate={handleUpdateAnnotation}
            onDelete={(id) => handleDeleteAnnotations([id])}
            source={docSource}
            onSourceChange={setDocSource}
            onClose={() => setActiveTool('select')}
          />
        )}
      </div>
    </div>
  );
}

export default App;
