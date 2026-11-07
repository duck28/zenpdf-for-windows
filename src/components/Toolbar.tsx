import React, { useEffect, useRef, useState } from 'react';
import {
  PanelLeft,
  FolderOpen,
  Save,
  Minus as ZoomOutIcon,
  Plus as ZoomInIcon,
  MoveHorizontal,
  Maximize,
  MousePointer2,
  Highlighter,
  PenTool,
  Type,
  Square,
  Circle,
  Minus,
  MoveRight,
  Eraser,
  Undo2,
  Redo2,
  Image as ImageIcon,
  ChevronDown,
  Loader2,
  Ruler,
  BookMarked,
  Pen,
  Pencil,
  Brush,
  Feather,
  Plus,
  FileDown,
} from 'lucide-react';
import { MeasureUnit, PenType, ToolType } from '../types';
import { MEASURE_UNITS, PEN_TYPES, WIDTH_SPECS } from '../utils/tools';
import { Logo } from './Logo';

const PRESET_COLORS = [
  '#1f1e1c', // Sumi ink
  '#b9432f', // Vermilion
  '#3f6e8c', // Indigo dye
  '#5b7f4a', // Moss
  '#e9b949', // Highlighter gold
  '#d97aa6', // Sakura
  '#8a6fb0', // Wisteria
  '#ffffff', // White
];

const PEN_ICONS: Record<PenType, React.ElementType> = {
  ballpoint: PenTool,
  fountain: Feather,
  marker: Brush,
  pencil: Pencil,
  dashed: Pen,
};

const SHAPES: { tool: ToolType; icon: React.ElementType; label: string }[] = [
  { tool: 'rect', icon: Square, label: 'Rectangle (R)' },
  { tool: 'circle', icon: Circle, label: 'Ellipse (O)' },
  { tool: 'line', icon: Minus, label: 'Line (L)' },
  { tool: 'arrow', icon: MoveRight, label: 'Arrow (A)' },
];

/** Closes a popover when clicking outside of it. */
function useClickOutside(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  return ref;
}

const iconBtn =
  'h-8 min-w-8 px-1.5 inline-flex items-center justify-center gap-1.5 rounded-md text-ink-2 hover:text-ink hover:bg-raised transition-colors disabled:opacity-35 disabled:pointer-events-none';

const IconButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }
> = ({ active, className = '', children, ...rest }) => (
  <button
    {...rest}
    className={`${iconBtn} ${active ? '!bg-raised !text-ink' : ''} ${className}`}
  >
    {children}
  </button>
);

const Divider = () => <span className="w-px h-4 bg-line mx-1 shrink-0" />;

const Popover: React.FC<{ children: React.ReactNode; align?: 'left' | 'center' | 'right'; className?: string }> = ({
  children,
  align = 'left',
  className = '',
}) => (
  <div
    className={`absolute top-full mt-2 z-50 bg-surface border border-line rounded-lg shadow-[0_8px_24px_-12px_rgba(0,0,0,0.25)] ${
      align === 'left' ? 'left-0' : align === 'right' ? 'right-0' : 'left-1/2 -translate-x-1/2'
    } ${className}`}
  >
    {children}
  </div>
);

const MenuItem: React.FC<{
  icon: React.ElementType;
  label: string;
  hint?: string;
  active?: boolean;
  onClick: () => void;
}> = ({ icon: Icon, label, hint, active, onClick }) => (
  <button
    onClick={onClick}
    className={`w-full flex items-start gap-2.5 px-3 py-2 text-left text-xs hover:bg-raised transition-colors ${
      active ? 'text-ink' : 'text-ink-2'
    }`}
  >
    <Icon className="w-4 h-4 mt-px shrink-0" />
    <span className="flex-1">
      <span className="block text-ink">{label}</span>
      {hint && <span className="block text-[11px] text-ink-3 mt-0.5">{hint}</span>}
    </span>
    {active && <span className="w-1.5 h-1.5 rounded-full bg-accent mt-1.5" />}
  </button>
);

// ======================================================================
// Top bar: document, view and file actions
// ======================================================================

interface TopBarProps {
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  documentTitle: string | null;
  isDirty?: boolean;
  hasDocument: boolean;
  /** PDF-only actions (fit, flatten, PNG) are hidden for text documents. */
  isPdf: boolean;
  isSaving: boolean;
  onOpenFile: () => void;
  onSaveFile: () => void;
  onSaveAsFile: () => void;
  onExportFlattened: () => void;
  onExportPageImage: () => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onSetZoom: (zoom: number) => void;
  onFitWidth: () => void;
  onFitPage: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  isSidebarOpen,
  onToggleSidebar,
  documentTitle,
  isDirty,
  hasDocument,
  isPdf,
  isSaving,
  onOpenFile,
  onSaveFile,
  onSaveAsFile,
  onExportFlattened,
  onExportPageImage,
  zoom,
  onZoomIn,
  onZoomOut,
  onSetZoom,
  onFitWidth,
  onFitPage,
}) => {
  const [showExportMenu, setShowExportMenu] = useState(false);
  const exportRef = useClickOutside(showExportMenu, () => setShowExportMenu(false));

  return (
    <header className="h-12 bg-surface border-b border-line flex items-center gap-2 px-2.5 shrink-0 z-30 select-none">
      {/* Left: navigation & identity */}
      <div className="flex items-center gap-1 min-w-0 flex-1">
        <IconButton onClick={onToggleSidebar} active={isSidebarOpen} title="Toggle sidebar (Ctrl+B)">
          <PanelLeft className="w-4 h-4" />
        </IconButton>
        <div className="flex items-center gap-2 pl-1.5 pr-1 text-ink">
          <Logo size={22} />
        </div>
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`text-[13px] truncate ${documentTitle ? 'text-ink' : 'text-ink-3'}`}
            title={documentTitle ?? undefined}
          >
            {documentTitle || 'ZenPDF'}
          </span>
          {isDirty && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" title="Unsaved changes" />}
        </div>
      </div>

      {/* Right: view & file */}
      <div className="flex items-center gap-1 shrink-0">
        {hasDocument && (
          <>
            <IconButton onClick={onZoomOut} title="Zoom out (Ctrl −)">
              <ZoomOutIcon className="w-3.5 h-3.5" />
            </IconButton>
            <button
              onClick={() => onSetZoom(1)}
              className="h-8 w-12 rounded-md text-[12px] tabular-nums text-ink-2 hover:text-ink hover:bg-raised transition-colors"
              title="Reset to 100% (Ctrl+0)"
            >
              {Math.round(zoom * 100)}%
            </button>
            <IconButton onClick={onZoomIn} title="Zoom in (Ctrl +, or Ctrl + wheel)">
              <ZoomInIcon className="w-3.5 h-3.5" />
            </IconButton>
            {isPdf && (
              <>
                <IconButton onClick={onFitWidth} title="Fit width">
                  <MoveHorizontal className="w-4 h-4" />
                </IconButton>
                <IconButton onClick={onFitPage} title="Fit whole page">
                  <Maximize className="w-3.5 h-3.5" />
                </IconButton>
              </>
            )}
            <Divider />
          </>
        )}

        <IconButton onClick={onOpenFile} title="Open PDF, text or Markdown (Ctrl+O)">
          <FolderOpen className="w-4 h-4" />
        </IconButton>
        <IconButton onClick={onSaveFile} disabled={!hasDocument || isSaving} title={isPdf ? 'Save — annotations stay editable (Ctrl+S)' : 'Save (Ctrl+S)'}>
          {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
        </IconButton>

        <div className="relative" ref={exportRef}>
          <button
            onClick={() => setShowExportMenu((v) => !v)}
            disabled={!hasDocument}
            className="ml-1 h-8 px-3 inline-flex items-center gap-1.5 rounded-md bg-ink text-on-ink text-[12px] hover:opacity-85 transition-opacity disabled:opacity-30 disabled:pointer-events-none"
            title="Export"
          >
            <span>Export</span>
            <ChevronDown className="w-3.5 h-3.5 opacity-70" />
          </button>
          {showExportMenu && (
            <Popover align="right" className="w-64 py-1">
              <MenuItem
                icon={Save}
                label="Save as…"
                hint={isPdf ? 'Annotations stay editable · Ctrl+Shift+S' : 'Ctrl+Shift+S'}
                onClick={() => {
                  setShowExportMenu(false);
                  onSaveAsFile();
                }}
              />
              {isPdf && (
                <>
              <MenuItem
                icon={FileDown}
                label="Export flattened copy…"
                hint="Separate file with annotations merged into pages"
                onClick={() => {
                  setShowExportMenu(false);
                  onExportFlattened();
                }}
              />
              <div className="h-px bg-line my-1" />
              <MenuItem
                icon={ImageIcon}
                label="Current page as PNG"
                hint="Includes annotations"
                onClick={() => {
                  setShowExportMenu(false);
                  onExportPageImage();
                }}
              />
                </>
              )}
            </Popover>
          )}
        </div>
      </div>
    </header>
  );
};

// ======================================================================
// Tool dock: floats centered over the editing area
// ======================================================================

interface ToolDockProps {
  activeTool: ToolType;
  onSelectTool: (tool: ToolType) => void;
  activeColor: string;
  onSelectColor: (color: string) => void;
  strokeWidth: number;
  onSelectStrokeWidth: (width: number) => void;
  penType: PenType;
  onSelectPenType: (type: PenType) => void;
  measureUnit: MeasureUnit;
  onSelectMeasureUnit: (unit: MeasureUnit) => void;
  isCitationPanelOpen: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

export const ToolDock: React.FC<ToolDockProps> = ({
  activeTool,
  onSelectTool,
  activeColor,
  onSelectColor,
  strokeWidth,
  onSelectStrokeWidth,
  penType,
  onSelectPenType,
  measureUnit,
  onSelectMeasureUnit,
  isCitationPanelOpen,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}) => {
  const [showShapeMenu, setShowShapeMenu] = useState(false);
  const [showPenMenu, setShowPenMenu] = useState(false);
  const [showColorMenu, setShowColorMenu] = useState(false);
  const shapeRef = useClickOutside(showShapeMenu, () => setShowShapeMenu(false));
  const penRef = useClickOutside(showPenMenu, () => setShowPenMenu(false));
  const colorRef = useClickOutside(showColorMenu, () => setShowColorMenu(false));
  const [lastShape, setLastShape] = useState<ToolType>('rect');

  const activeShape = SHAPES.find((s) => s.tool === activeTool);
  useEffect(() => {
    if (activeShape) setLastShape(activeShape.tool);
  }, [activeShape]);
  const ShapeIcon = (activeShape ?? SHAPES.find((s) => s.tool === lastShape))?.icon ?? Square;
  const PenIcon = PEN_ICONS[penType];
  const showColor = !['select', 'pan', 'eraser'].includes(activeTool);
  const widthSpec = WIDTH_SPECS[activeTool];

  /** Tool button with an optional menu chevron. */
  const splitButton = (
    active: boolean,
    Icon: React.ElementType,
    title: string,
    onMain: () => void,
    onMenu: () => void
  ) => (
    <div className={`flex items-center rounded-md transition-colors ${active ? 'bg-raised' : ''}`}>
      <button
        onClick={onMain}
        title={title}
        className={`h-8 w-8 inline-flex items-center justify-center rounded-md transition-colors ${
          active ? 'text-ink' : 'text-ink-2 hover:text-ink hover:bg-raised'
        }`}
      >
        <Icon className="w-4 h-4" />
      </button>
      <button
        onClick={onMenu}
        title="Options"
        className="h-8 w-4 -ml-1 inline-flex items-center justify-center rounded-md text-ink-3 hover:text-ink"
      >
        <ChevronDown className="w-3 h-3" />
      </button>
    </div>
  );

  return (
    <div className="flex flex-wrap items-center justify-center gap-0.5 px-1.5 py-1 bg-surface/90 backdrop-blur-md border border-line rounded-xl shadow-[0_6px_24px_-14px_rgba(0,0,0,0.35)] select-none">
      <IconButton active={activeTool === 'select'} onClick={() => onSelectTool('select')} title="Select, move & resize (V) — double-click text to edit">
        <MousePointer2 className="w-4 h-4" />
      </IconButton>

      <Divider />

      <IconButton active={activeTool === 'highlighter'} onClick={() => onSelectTool('highlighter')} title="Highlighter (H) — hold still to straighten">
        <Highlighter className="w-4 h-4" />
      </IconButton>

      <div className="relative" ref={penRef}>
        {splitButton(
          activeTool === 'pen',
          PenIcon,
          `${PEN_TYPES.find((p) => p.type === penType)?.label} pen (P) — hold still to straighten`,
          () => onSelectTool('pen'),
          () => setShowPenMenu((v) => !v)
        )}
        {showPenMenu && (
          <Popover className="w-52 py-1">
            {PEN_TYPES.map(({ type, label, hint }) => (
              <MenuItem
                key={type}
                icon={PEN_ICONS[type]}
                label={label}
                hint={hint}
                active={penType === type}
                onClick={() => {
                  onSelectPenType(type);
                  onSelectTool('pen');
                  setShowPenMenu(false);
                }}
              />
            ))}
          </Popover>
        )}
      </div>

      <IconButton active={activeTool === 'text'} onClick={() => onSelectTool('text')} title="Text (T)">
        <Type className="w-4 h-4" />
      </IconButton>

      <div className="relative" ref={shapeRef}>
        {splitButton(
          !!activeShape,
          ShapeIcon,
          `${(activeShape ?? SHAPES.find((s) => s.tool === lastShape))?.label} — Shift constrains`,
          () => onSelectTool(activeShape?.tool ?? lastShape),
          () => setShowShapeMenu((v) => !v)
        )}
        {showShapeMenu && (
          <Popover className="w-max p-1 flex gap-0.5">
            {SHAPES.map(({ tool, icon: Icon, label }) => (
              <IconButton
                key={tool}
                active={activeTool === tool}
                onClick={() => {
                  onSelectTool(tool);
                  setShowShapeMenu(false);
                }}
                title={label}
              >
                <Icon className="w-4 h-4" />
              </IconButton>
            ))}
          </Popover>
        )}
      </div>

      <IconButton active={activeTool === 'measure'} onClick={() => onSelectTool('measure')} title="Ruler (M) — Shift snaps to 45°">
        <Ruler className="w-4 h-4" />
      </IconButton>
      <IconButton
        active={activeTool === 'cite' || isCitationPanelOpen}
        onClick={() => onSelectTool('cite')}
        title="Citation (C) — mark a paragraph to add a footnote"
      >
        <BookMarked className="w-4 h-4" />
      </IconButton>
      <IconButton active={activeTool === 'eraser'} onClick={() => onSelectTool('eraser')} title="Eraser (E) — click or drag">
        <Eraser className="w-4 h-4" />
      </IconButton>

      {(showColor || widthSpec || activeTool === 'measure') && <Divider />}

      {showColor && (
        <div className="relative" ref={colorRef}>
          <button
            onClick={() => setShowColorMenu((v) => !v)}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-raised transition-colors"
            title="Color"
          >
            <span className="w-4 h-4 rounded-full ring-1 ring-line ring-offset-2 ring-offset-surface" style={{ backgroundColor: activeColor }} />
          </button>
          {showColorMenu && (
            // Explicit width: an absolutely positioned popover would otherwise shrink
            // to the 32px trigger and the grid cells would collapse onto each other.
            <Popover align="center" className="w-max p-3">
              <div className="grid grid-cols-[repeat(5,1.25rem)] gap-3">
                {PRESET_COLORS.map((c) => {
                  const selected = activeColor.toLowerCase() === c;
                  return (
                    <button
                      key={c}
                      onClick={() => {
                        onSelectColor(c);
                        setShowColorMenu(false);
                      }}
                      className={`w-5 h-5 shrink-0 rounded-full transition-transform hover:scale-110 ${
                        selected ? 'ring-[1.5px] ring-ink ring-offset-2 ring-offset-surface' : 'ring-1 ring-line'
                      }`}
                      style={{ backgroundColor: c }}
                      title={c}
                      aria-pressed={selected}
                    />
                  );
                })}
                <label
                  className={`w-5 h-5 shrink-0 rounded-full flex items-center justify-center cursor-pointer relative overflow-hidden ${
                    PRESET_COLORS.includes(activeColor.toLowerCase())
                      ? 'border border-dashed border-ink-3 hover:border-ink'
                      : 'ring-[1.5px] ring-ink ring-offset-2 ring-offset-surface'
                  }`}
                  style={PRESET_COLORS.includes(activeColor.toLowerCase()) ? undefined : { backgroundColor: activeColor }}
                  title="Custom color"
                >
                  <Plus className="w-3 h-3 text-ink-3" />
                  <input
                    type="color"
                    value={activeColor}
                    onChange={(e) => onSelectColor(e.target.value)}
                    className="absolute inset-0 opacity-0 cursor-pointer"
                  />
                </label>
              </div>
            </Popover>
          )}
        </div>
      )}

      {widthSpec && (
        <div
          className="flex items-center gap-2 pl-1 pr-1.5"
          title={`${widthSpec.label} (${widthSpec.min}–${widthSpec.max} ${widthSpec.unit})`}
        >
          <input
            type="range"
            min={widthSpec.min}
            max={widthSpec.max}
            step={widthSpec.step}
            value={strokeWidth}
            onChange={(e) => onSelectStrokeWidth(Number(e.target.value))}
            className="zen-range w-20 cursor-pointer"
            aria-label={widthSpec.label}
          />
          <input
            type="number"
            min={widthSpec.min}
            max={widthSpec.max}
            step={widthSpec.step}
            value={strokeWidth}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (!Number.isNaN(v)) onSelectStrokeWidth(Math.min(widthSpec.max, Math.max(widthSpec.min, v)));
            }}
            className="w-9 bg-transparent text-[12px] text-ink-2 tabular-nums text-right focus:outline-none focus:text-ink [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
            aria-label={`${widthSpec.label} value`}
          />
          <span className="text-[11px] text-ink-3 -ml-1">{activeTool === 'text' ? 'pt' : ''}</span>
        </div>
      )}

      {activeTool === 'measure' && (
        <select
          value={measureUnit}
          onChange={(e) => onSelectMeasureUnit(e.target.value as MeasureUnit)}
          className="h-7 bg-transparent text-[12px] text-ink-2 rounded-md px-1 hover:bg-raised focus:outline-none"
          title="Measurement unit"
        >
          {MEASURE_UNITS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      )}

      <Divider />

      <IconButton onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)">
        <Undo2 className="w-4 h-4" />
      </IconButton>
      <IconButton onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)">
        <Redo2 className="w-4 h-4" />
      </IconButton>
    </div>
  );
};
