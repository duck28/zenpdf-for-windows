import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, Search, ExternalLink, RefreshCw, FolderPlus, Trash2, FileText, X } from 'lucide-react';
import { FileEntry, Annotation } from '../types';

interface SidebarProps {
  isOpen: boolean;
  onToggle: () => void;
  folderPath: string | null;
  folderTree: FileEntry[];
  currentFilePath: string | null;
  onSelectFile: (path: string) => void;
  onOpenFolder: () => void;
  onRefreshFolder: () => void;
  onRevealInExplorer: (path: string) => void;
  numPages: number;
  currentPage: number;
  onJumpToPage: (page: number) => void;
  pageThumbnails: string[];
  annotations: Annotation[];
  selectedAnnotationId: string | null;
  onSelectAnnotation: (ann: Annotation) => void;
  onDeleteAnnotation: (id: string) => void;
}

const ANNOTATION_LABELS: Record<Annotation['type'], string> = {
  pen: 'Ink',
  highlighter: 'Highlight',
  text: 'Text',
  rect: 'Rectangle',
  circle: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
  measure: 'Measurement',
  cite: 'Citation',
};

const annotationColor = (ann: Annotation) => ('color' in ann ? ann.color : ann.strokeColor);

type Tab = 'files' | 'thumbnails' | 'annotations';

export const Sidebar: React.FC<SidebarProps> = ({
  isOpen,
  folderPath,
  folderTree,
  currentFilePath,
  onSelectFile,
  onOpenFolder,
  onRefreshFolder,
  onRevealInExplorer,
  numPages,
  currentPage,
  onJumpToPage,
  pageThumbnails,
  annotations,
  selectedAnnotationId,
  onSelectAnnotation,
  onDeleteAnnotation,
}) => {
  const [activeTab, setActiveTab] = useState<Tab>('files');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const thumbListRef = useRef<HTMLDivElement>(null);

  // Keep the current page's thumbnail in view while scrolling the document
  useEffect(() => {
    if (activeTab !== 'thumbnails') return;
    const el = thumbListRef.current?.querySelector<HTMLElement>(`[data-thumb="${currentPage}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [currentPage, activeTab, isOpen]);

  if (!isOpen) return null;

  const toggleFolder = (path: string) => setExpandedFolders((prev) => ({ ...prev, [path]: !prev[path] }));

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

  const q = searchQuery.toLowerCase();

  const renderTree = (entries: FileEntry[], depth = 0): React.ReactNode =>
    entries.map((item) => {
      if (item.is_dir) {
        const isExpanded = expandedFolders[item.path] ?? depth < 1;
        const children = (item.children ?? []).filter((c) => c.is_dir || c.name.toLowerCase().includes(q));
        if (q && children.length === 0 && !item.name.toLowerCase().includes(q)) return null;

        return (
          <div key={item.path}>
            <div
              onClick={() => toggleFolder(item.path)}
              className="flex items-center gap-1 h-7 pr-2 text-[13px] text-ink-2 hover:text-ink hover:bg-raised rounded-md cursor-pointer transition-colors"
              style={{ paddingLeft: depth * 12 + 4 }}
            >
              {isExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-ink-3 shrink-0" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-ink-3 shrink-0" />
              )}
              <span className="truncate flex-1">{item.name}</span>
            </div>
            {isExpanded && children.length > 0 && <div>{renderTree(children, depth + 1)}</div>}
          </div>
        );
      }

      if (q && !item.name.toLowerCase().includes(q)) return null;
      const isSelected = currentFilePath === item.path;
      return (
        <div
          key={item.path}
          onClick={() => onSelectFile(item.path)}
          onContextMenu={(e) => {
            e.preventDefault();
            onRevealInExplorer(item.path);
          }}
          className={`group relative flex items-center gap-2 h-7 pr-2 text-[13px] rounded-md cursor-pointer transition-colors ${
            isSelected ? 'bg-raised text-ink' : 'text-ink-2 hover:bg-raised hover:text-ink'
          }`}
          style={{ paddingLeft: depth * 12 + 22 }}
          title={`${item.path}\nRight-click to reveal in Explorer`}
        >
          {isSelected && <span className="absolute left-1.5 w-1 h-1 rounded-full bg-accent" />}
          <span className="truncate flex-1">{item.name.replace(/\.pdf$/i, '')}</span>
          <span className="text-[11px] text-ink-3 tabular-nums shrink-0 group-hover:hidden">{formatFileSize(item.size)}</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRevealInExplorer(item.path);
            }}
            className="hidden group-hover:block text-ink-3 hover:text-ink"
            title="Reveal in Explorer"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>
      );
    });

  const tabs: { id: Tab; label: string }[] = [
    { id: 'files', label: 'Files' },
    { id: 'thumbnails', label: 'Pages' },
    { id: 'annotations', label: annotations.length ? `Notes ${annotations.length}` : 'Notes' },
  ];

  return (
    <aside className="w-64 bg-surface border-r border-line flex flex-col h-full shrink-0 z-20 select-none">
      {/* Tabs: text with a hairline indicator */}
      <nav className="flex items-center gap-4 px-4 h-10 border-b border-line shrink-0">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`relative h-full text-[12px] tracking-wide transition-colors ${
              activeTab === t.id ? 'text-ink' : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            {t.label}
            {activeTab === t.id && <span className="absolute left-0 right-0 -bottom-px h-px bg-ink" />}
          </button>
        ))}
      </nav>

      {activeTab === 'files' && (
        <div className="flex flex-col flex-1 overflow-hidden">
          {folderPath ? (
            <>
              <div className="px-3 pt-3 pb-2 space-y-2 shrink-0">
                <div className="flex items-center gap-1">
                  <span className="flex-1 text-[11px] uppercase tracking-[0.12em] text-ink-3 truncate" title={folderPath}>
                    {folderPath.split(/[/\\]/).pop()}
                  </span>
                  <button onClick={onRefreshFolder} className="p-1 rounded text-ink-3 hover:text-ink hover:bg-raised" title="Refresh">
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={onOpenFolder} className="p-1 rounded text-ink-3 hover:text-ink hover:bg-raised" title="Change folder">
                    <FolderPlus className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-ink-3" />
                  <input
                    type="text"
                    placeholder="Filter"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full h-7 bg-raised text-[12px] rounded-md pl-7 pr-6 text-ink placeholder:text-ink-3 focus:outline-none"
                  />
                  {searchQuery && (
                    <button onClick={() => setSearchQuery('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink">
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
              <div className="flex-1 overflow-y-auto px-2 pb-3">
                {folderTree.length === 0 ? (
                  <p className="p-4 text-center text-[12px] text-ink-3">No documents in this folder.</p>
                ) : (
                  renderTree(folderTree)
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
              <p className="text-[12px] text-ink-3 mb-3 leading-relaxed">Open a folder to browse its documents.</p>
              <button
                onClick={onOpenFolder}
                className="h-8 px-3 inline-flex items-center gap-1.5 rounded-md text-[12px] text-ink-2 hover:text-ink hover:bg-raised transition-colors"
              >
                <FolderPlus className="w-3.5 h-3.5" />
                Choose folder
              </button>
            </div>
          )}
        </div>
      )}

      {activeTab === 'thumbnails' && (
        <div ref={thumbListRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {numPages === 0 ? (
            <p className="text-center pt-4 text-[12px] text-ink-3">No document open.</p>
          ) : (
            Array.from({ length: numPages }).map((_, i) => {
              const pageNum = i + 1;
              const isCurrent = pageNum === currentPage;
              const thumbUrl = pageThumbnails[pageNum];
              return (
                <button
                  key={pageNum}
                  data-thumb={pageNum}
                  onClick={() => onJumpToPage(pageNum)}
                  className="w-full flex flex-col items-center gap-1.5 group"
                >
                  <div
                    className={`w-full aspect-[1/1.3] bg-white rounded-sm overflow-hidden flex items-center justify-center transition-shadow ${
                      isCurrent ? 'ring-1 ring-ink ring-offset-4 ring-offset-surface' : 'ring-1 ring-line group-hover:ring-ink-3'
                    }`}
                  >
                    {thumbUrl ? (
                      <img src={thumbUrl} alt={`Page ${pageNum}`} className="w-full h-full object-contain" />
                    ) : (
                      <FileText className="w-5 h-5 text-ink-3" />
                    )}
                  </div>
                  <span className={`text-[11px] tabular-nums ${isCurrent ? 'text-ink' : 'text-ink-3'}`}>{pageNum}</span>
                </button>
              );
            })
          )}
        </div>
      )}

      {activeTab === 'annotations' && (
        <div className="flex-1 overflow-y-auto p-2">
          {annotations.length === 0 ? (
            <p className="text-center p-4 text-[12px] text-ink-3 leading-relaxed">
              Nothing marked yet. Pick a tool and begin.
            </p>
          ) : (
            [...annotations]
              .sort((a, b) => a.pageNumber - b.pageNumber || a.createdAt - b.createdAt)
              .map((ann) => {
                const detail =
                  ann.type === 'text' ? ann.text : ann.type === 'cite' ? ann.note || (ann.quote ? `“${ann.quote}”` : '') : '';
                return (
                  <div
                    key={ann.id}
                    onClick={() => onSelectAnnotation(ann)}
                    className={`group flex items-start gap-2.5 px-2 py-2 rounded-md cursor-pointer transition-colors ${
                      ann.id === selectedAnnotationId ? 'bg-raised' : 'hover:bg-raised'
                    }`}
                  >
                    <span
                      className="mt-1 w-2 h-2 rounded-full shrink-0 ring-1 ring-line"
                      style={{ backgroundColor: annotationColor(ann) }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[13px] text-ink flex-1">{ANNOTATION_LABELS[ann.type]}</span>
                        <span className="text-[11px] text-ink-3 tabular-nums">p. {ann.pageNumber}</span>
                      </div>
                      {detail && <p className="text-[12px] text-ink-3 truncate mt-0.5">{detail}</p>}
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteAnnotation(ann.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 mt-0.5 text-ink-3 hover:text-accent transition-opacity"
                      title="Delete"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })
          )}
        </div>
      )}
    </aside>
  );
};
