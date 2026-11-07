import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BookMarked, Check, ChevronDown, ChevronRight, Copy, Quote, Search, Trash2, X } from 'lucide-react';
import { CitationAnnotation, CitationStyle, DocumentSource } from '../types';
import {
  CITATION_STYLES,
  citationMatches,
  citationPage,
  copyToClipboard,
  formatCitation,
  formatInText,
  formatQuote,
} from '../utils/citations';

interface CitationPanelProps {
  citations: CitationAnnotation[]; // in reading order
  numbers: Map<string, number>;
  selectedId: string | null;
  onSelect: (c: CitationAnnotation) => void;
  onUpdate: (c: CitationAnnotation) => void;
  onDelete: (id: string) => void;
  source: DocumentSource;
  onSourceChange: (s: DocumentSource) => void;
  onClose: () => void;
}

const STYLE_KEY = 'zenpdf.citationStyle';

function loadStyle(): CitationStyle {
  try {
    const v = localStorage.getItem(STYLE_KEY);
    if (v && CITATION_STYLES.some((s) => s.style === v)) return v as CitationStyle;
  } catch {
    /* storage unavailable */
  }
  return 'apa';
}

/** Highlights search terms inside a string. */
function Highlight({ text, query }: { text: string; query: string }) {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length || !text) return <>{text}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return (
    <>
      {text.split(re).map((chunk, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="bg-accent/20 text-ink rounded-sm">
            {chunk}
          </mark>
        ) : (
          <React.Fragment key={i}>{chunk}</React.Fragment>
        )
      )}
    </>
  );
}

function CopyButton({ text, label, primary }: { text: string; label: string; primary?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation();
        if (await copyToClipboard(text)) {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        }
      }}
      className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors ${
        primary
          ? 'bg-ink text-on-ink hover:opacity-85'
          : 'text-ink-2 hover:text-ink hover:bg-raised'
      }`}
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copied' : label}
    </button>
  );
}

/** Text field that commits on blur, so typing doesn't flood the undo history. */
function CommitField({
  value,
  onCommit,
  placeholder,
  multiline,
  rows = 2,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const common = {
    value: draft,
    placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: () => draft !== value && onCommit(draft),
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
    className:
      'w-full bg-raised border border-line text-xs rounded px-2 py-1.5 text-ink placeholder:text-ink-3 focus:outline-none focus:border-ink-3 select-text',
  };
  return multiline ? (
    <textarea {...common} rows={rows} className={`${common.className} resize-y leading-snug`} />
  ) : (
    <input
      {...common}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

export const CitationPanel: React.FC<CitationPanelProps> = ({
  citations,
  numbers,
  selectedId,
  onSelect,
  onUpdate,
  onDelete,
  source,
  onSourceChange,
  onClose,
}) => {
  const [query, setQuery] = useState('');
  const [style, setStyle] = useState<CitationStyle>(loadStyle);
  const [showSource, setShowSource] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STYLE_KEY, style);
    } catch {
      /* ignore */
    }
  }, [style]);

  const filtered = useMemo(
    () => citations.filter((c) => citationMatches(c, query, numbers.get(c.id) ?? 0)),
    [citations, query, numbers]
  );

  // Keep the selected card visible (e.g. after clicking a marker in the page)
  useEffect(() => {
    if (!selectedId) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-cite="${selectedId}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  const sourceMissing = !source.author.trim() || !source.year.trim();

  const allFootnotes = citations
    .map((c) => `${numbers.get(c.id)}. ${formatCitation(style === 'bibtex' ? 'chicago' : style, source, citationPage(c))}${c.note.trim() ? ` ${c.note.trim()}` : ''}`)
    .join('\n');

  const setSourceField = (key: keyof DocumentSource, v: string) => onSourceChange({ ...source, [key]: v });

  return (
    <aside className="w-80 bg-surface border-l border-line flex flex-col h-full shrink-0 z-20 select-none">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-10 border-b border-line bg-surface shrink-0">
        <BookMarked className="w-4 h-4 text-accent" />
        <span className="text-xs font-semibold text-ink flex-1">
          Citations <span className="text-ink-3 font-normal">({citations.length})</span>
        </span>
        <select
          value={style}
          onChange={(e) => setStyle(e.target.value as CitationStyle)}
          className="bg-raised border border-line text-[11px] text-ink rounded px-1.5 py-0.5 focus:outline-none focus:border-ink-3"
          title="Citation style"
        >
          {CITATION_STYLES.map((s) => (
            <option key={s.style} value={s.style}>
              {s.label}
            </option>
          ))}
        </select>
        <button onClick={onClose} className="p-1 text-ink-2 hover:text-ink rounded hover:bg-raised" title="Close panel (switch to Select)">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Search */}
      <div className="p-2 border-b border-line shrink-0">
        <div className="relative">
          <Search className="w-3 h-3 absolute left-2 top-2 text-ink-3" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search quotes, footnotes, pages…"
            className="w-full bg-raised border border-line text-xs rounded pl-7 pr-7 py-1 text-ink placeholder:text-ink-3 focus:outline-none focus:border-ink-3"
          />
          {query && (
            <button onClick={() => setQuery('')} className="absolute right-1.5 top-1.5 text-ink-3 hover:text-ink">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Source document */}
      <div className="border-b border-line shrink-0">
        <button
          onClick={() => setShowSource((v) => !v)}
          className="w-full flex items-center gap-1.5 px-3 py-2 text-[11px] text-ink hover:bg-raised"
        >
          {showSource ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          <span className="font-medium">Source document</span>
          <span className="flex-1 truncate text-left text-ink-3 ml-1">{source.title || 'Untitled'}</span>
          {sourceMissing && <span className="w-1.5 h-1.5 rounded-full bg-accent" title="Author or year missing" />}
        </button>
        {showSource && (
          <div className="px-3 pb-3 space-y-1.5">
            {(
              [
                ['author', 'Author(s) — e.g. Doe, Jane; Smith, John'],
                ['title', 'Title'],
                ['year', 'Year'],
                ['publisher', 'Publisher / journal'],
                ['url', 'URL or DOI'],
              ] as [keyof DocumentSource, string][]
            ).map(([key, ph]) => (
              <CommitField key={key} value={source[key]} placeholder={ph} onCommit={(v) => setSourceField(key, v)} />
            ))}
          </div>
        )}
      </div>

      {/* List */}
      <div ref={listRef} className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {citations.length === 0 ? (
          <div className="p-4 text-center text-xs text-ink-3 leading-relaxed">
            <Quote className="w-6 h-6 mx-auto mb-2 text-ink-3" />
            Drag a box over a paragraph to mark it. Its text is captured automatically and a numbered footnote is
            added to the page.
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-4 text-center text-xs text-ink-3">No citations match “{query}”.</div>
        ) : (
          filtered.map((c) => {
            const n = numbers.get(c.id) ?? 0;
            const isSel = c.id === selectedId;
            const page = citationPage(c);
            const fullRef = formatCitation(style, source, page);
            return (
              <div
                key={c.id}
                data-cite={c.id}
                onClick={() => onSelect(c)}
                className={`group rounded border cursor-pointer transition-colors ${
                  isSel ? 'bg-raised border-line' : 'border-transparent hover:bg-raised'
                }`}
              >
                <div className="flex items-start gap-2 p-2">
                  <span
                    className="mt-0.5 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold text-white flex items-center justify-center shrink-0"
                    style={{ backgroundColor: c.color }}
                  >
                    {n}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs text-ink leading-snug ${isSel ? '' : 'line-clamp-3'}`}>
                      {c.quote ? (
                        <>
                          “<Highlight text={c.quote} query={query} />”
                        </>
                      ) : (
                        <span className="italic text-ink-3">No text captured (scanned page?)</span>
                      )}
                    </p>
                    {!isSel && c.note && (
                      <p className="text-[11px] text-ink-3 mt-1 truncate">
                        <Highlight text={c.note} query={query} />
                      </p>
                    )}
                  </div>
                  <span className="text-[10px] text-ink-3 shrink-0 mt-0.5">p. {page}</span>
                </div>

                {isSel && (
                  <div className="px-2 pb-2 space-y-2 border-t border-line pt-2" onClick={(e) => e.stopPropagation()}>
                    <label className="block">
                      <span className="text-[10px] uppercase tracking-wide text-ink-3">Footnote</span>
                      <CommitField
                        multiline
                        value={c.note}
                        placeholder="Footnote text printed at the bottom of the page…"
                        onCommit={(note) => onUpdate({ ...c, note })}
                      />
                    </label>
                    <label className="block">
                      <span className="text-[10px] uppercase tracking-wide text-ink-3">Quoted text</span>
                      <CommitField multiline rows={3} value={c.quote} onCommit={(quote) => onUpdate({ ...c, quote })} />
                    </label>
                    <label className="flex items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wide text-ink-3 shrink-0">Page label</span>
                      <CommitField
                        value={c.pageLabel ?? ''}
                        placeholder={String(c.pageNumber)}
                        onCommit={(pageLabel) => onUpdate({ ...c, pageLabel: pageLabel.trim() || undefined })}
                      />
                    </label>

                    <div>
                      <span className="text-[10px] uppercase tracking-wide text-ink-3">
                        {CITATION_STYLES.find((s) => s.style === style)?.label} reference
                      </span>
                      <pre className="mt-0.5 p-2 rounded bg-raised border border-line text-[11px] text-ink whitespace-pre-wrap break-words font-sans select-text">
                        {fullRef}
                      </pre>
                      {style !== 'bibtex' && (
                        <p className="mt-1 text-[11px] text-ink-2 select-text">
                          In text: <span className="text-ink">{formatInText(style, source, page)}</span>
                        </p>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <CopyButton primary text={fullRef} label="Copy reference" />
                      <CopyButton text={formatQuote(style, source, c)} label="Copy quote" />
                      <button
                        onClick={() => onDelete(c.id)}
                        className="ml-auto p-1 text-ink-3 hover:text-accent"
                        title="Delete citation"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {citations.length > 0 && (
        <div className="p-2 border-t border-line flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-ink-3 flex-1">
            {filtered.length} of {citations.length} shown
          </span>
          <CopyButton text={allFootnotes} label="Copy all footnotes" />
        </div>
      )}
    </aside>
  );
};
