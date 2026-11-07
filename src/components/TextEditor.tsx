import React, { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Columns2, Eye, PencilLine } from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';

type MdMode = 'edit' | 'split' | 'preview';

interface TextEditorProps {
  content: string;
  onChange: (next: string) => void;
  /** Markdown files get an Edit / Split / Preview switch. */
  isMarkdown: boolean;
  /** Text scale, driven by the top bar zoom. */
  zoom: number;
  /** Changes whenever a different file is opened (resets scroll & focus). */
  docId: number;
}

const MODE_KEY = 'zenpdf.mdMode';

const readMode = (): MdMode => {
  try {
    const m = localStorage.getItem(MODE_KEY);
    if (m === 'edit' || m === 'split' || m === 'preview') return m;
  } catch {
    /* storage unavailable */
  }
  return 'split';
};

/** Plain-text and Markdown editor shown in place of the PDF viewer. */
export const TextEditor: React.FC<TextEditorProps> = ({ content, onChange, isMarkdown, zoom, docId }) => {
  const [mode, setMode] = useState<MdMode>(readMode);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* storage unavailable */
    }
  }, [mode]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.scrollTop = 0;
    ta.setSelectionRange(0, 0);
    ta.focus();
  }, [docId]);

  // Markdown may contain raw HTML; sanitize so a file can't run script in the app.
  const html = useMemo(
    () => (isMarkdown && mode !== 'edit' ? DOMPurify.sanitize(marked.parse(content, { async: false, gfm: true })) : ''),
    [content, isMarkdown, mode]
  );

  // Tab inserts spaces instead of leaving the editor
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    const ta = e.currentTarget;
    const { selectionStart: start, selectionEnd: end } = ta;
    const next = content.slice(0, start) + '  ' + content.slice(end);
    onChange(next);
    requestAnimationFrame(() => ta.setSelectionRange(start + 2, start + 2));
  };

  // Links must never navigate the app window itself: web links open in the browser.
  const handlePreviewClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1));
      e.currentTarget.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth' });
    } else if (/^(https?:|mailto:)/i.test(href)) {
      if (isTauri()) openUrl(href).catch((err) => console.error('Could not open link:', err));
      else window.open(href, '_blank', 'noopener');
    }
  };

  const fontSize = Math.round(14 * zoom * 10) / 10;
  const showEditor = !isMarkdown || mode !== 'preview';
  const showPreview = isMarkdown && mode !== 'edit';

  const modeBtn = (m: MdMode, Icon: React.ElementType, label: string) => (
    <button
      key={m}
      onClick={() => setMode(m)}
      title={label}
      className={`h-7 px-2.5 inline-flex items-center gap-1.5 rounded-md text-[12px] transition-colors ${
        mode === m ? 'bg-raised text-ink' : 'text-ink-2 hover:text-ink hover:bg-raised'
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );

  return (
    <div className="relative flex-1 min-w-0 flex flex-col bg-app">
      {isMarkdown && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-0.5 px-1 py-1 bg-surface/90 backdrop-blur-md border border-line rounded-xl shadow-[0_6px_24px_-14px_rgba(0,0,0,0.35)] select-none">
          {modeBtn('edit', PencilLine, 'Edit')}
          {modeBtn('split', Columns2, 'Split')}
          {modeBtn('preview', Eye, 'Preview')}
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {showEditor && (
          <div className={`flex-1 min-w-0 flex justify-center ${showPreview ? 'border-r border-line' : ''}`}>
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              spellCheck={!isMarkdown}
              style={{ fontSize }}
              className={`w-full h-full max-w-[860px] resize-none bg-transparent text-ink leading-relaxed px-10 pb-16 focus:outline-none ${
                isMarkdown ? 'pt-16 font-mono' : 'pt-10'
              }`}
              placeholder="Start writing…"
            />
          </div>
        )}
        {showPreview && (
          <div className="flex-1 min-w-0 overflow-y-auto">
            <article
              className="md-preview max-w-[760px] mx-auto px-10 pt-16 pb-16 text-ink"
              style={{ fontSize: Math.round(15 * zoom * 10) / 10 }}
              onClick={handlePreviewClick}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        )}
      </div>
    </div>
  );
};
