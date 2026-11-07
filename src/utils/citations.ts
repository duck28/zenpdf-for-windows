import { Annotation, CitationAnnotation, CitationStyle, DocumentSource } from '../types';

export const CITATION_STYLES: { style: CitationStyle; label: string }[] = [
  { style: 'apa', label: 'APA 7' },
  { style: 'mla', label: 'MLA 9' },
  { style: 'chicago', label: 'Chicago' },
  { style: 'bibtex', label: 'BibTeX' },
];

export function isCitation(a: Annotation): a is CitationAnnotation {
  return a.type === 'cite';
}

/** Citations in reading order (page, then top-to-bottom, left-to-right). */
export function sortedCitations(annotations: Annotation[]): CitationAnnotation[] {
  return annotations
    .filter(isCitation)
    .sort((a, b) => a.pageNumber - b.pageNumber || a.y - b.y || a.x - b.x);
}

/** Footnote numbers follow reading order across the whole document. */
export function citationNumbers(annotations: Annotation[]): Map<string, number> {
  const map = new Map<string, number>();
  sortedCitations(annotations).forEach((c, i) => map.set(c.id, i + 1));
  return map;
}

export function citationPage(c: CitationAnnotation) {
  return c.pageLabel?.trim() || String(c.pageNumber);
}

// ------------------------------------------------------------ formatting
const clean = (s: string) => s.trim().replace(/\s+/g, ' ');
const stripEndDot = (s: string) => s.replace(/[.\s]+$/, '');

/** "Jane Doe; John Smith" or "Doe, Jane and Smith, John" → list of authors. */
function splitAuthors(author: string): string[] {
  return author
    .split(/\s*;\s*|\s+and\s+|\s*&\s*/i)
    .map(clean)
    .filter(Boolean);
}

/** Returns [family, given]. */
function nameParts(name: string): [string, string] {
  if (name.includes(',')) {
    const [family, given] = name.split(',', 2).map(clean);
    return [family, given ?? ''];
  }
  const parts = name.split(' ');
  if (parts.length === 1) return [parts[0], ''];
  return [parts[parts.length - 1], parts.slice(0, -1).join(' ')];
}

const initials = (given: string) =>
  given
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((g) => `${g[0].toUpperCase()}.`)
    .join(' ');

function apaAuthors(authors: string[]) {
  const fmt = authors.map((a) => {
    const [family, given] = nameParts(a);
    return given ? `${family}, ${initials(given)}` : family;
  });
  if (fmt.length <= 1) return fmt[0] ?? '';
  return `${fmt.slice(0, -1).join(', ')}, & ${fmt[fmt.length - 1]}`;
}

/** "Smith, John" → "John Smith" (later authors are written in natural order). */
function naturalName(name: string) {
  const [family, given] = nameParts(name);
  return given ? `${given} ${family}` : family;
}

function invertedFirst(name: string) {
  const [family, given] = nameParts(name);
  return given ? `${family}, ${given}` : family;
}

function mlaAuthors(authors: string[]) {
  if (authors.length === 0) return '';
  const first = invertedFirst(authors[0]);
  if (authors.length === 1) return first;
  if (authors.length === 2) return `${first}, and ${naturalName(authors[1])}`;
  return `${first}, et al.`;
}

function chicagoAuthors(authors: string[]) {
  if (authors.length === 0) return '';
  const first = invertedFirst(authors[0]);
  if (authors.length === 1) return first;
  const rest = authors.slice(1).map(naturalName);
  return `${first}, ${rest.slice(0, -1).map((a) => `${a}, `).join('')}and ${rest[rest.length - 1]}`;
}

function shortAuthor(authors: string[], joiner: string) {
  if (authors.length === 0) return '';
  const fam = nameParts(authors[0])[0];
  if (authors.length === 1) return fam;
  if (authors.length === 2) return `${fam} ${joiner} ${nameParts(authors[1])[0]}`;
  return `${fam} et al.`;
}

const pagePrefix = (page: string) => (/[-–,]/.test(page) ? 'pp.' : 'p.');

/** Full reference for the marked passage. */
export function formatCitation(style: CitationStyle, src: DocumentSource, page: string): string {
  const authors = splitAuthors(src.author);
  const title = stripEndDot(clean(src.title)) || 'Untitled document';
  const year = clean(src.year);
  const publisher = stripEndDot(clean(src.publisher));
  const url = clean(src.url);

  switch (style) {
    case 'apa': {
      const who = authors.length ? apaAuthors(authors) : title;
      const parts = [
        `${stripEndDot(who)}. (${year || 'n.d.'}).`,
        authors.length ? `${title}.` : '',
        publisher ? `${publisher}.` : '',
        url,
      ];
      return `${parts.filter(Boolean).join(' ')} (${pagePrefix(page)} ${page})`;
    }
    case 'mla': {
      const parts = [
        authors.length ? `${stripEndDot(mlaAuthors(authors))}.` : '',
        `${title}.`,
        [publisher, year].filter(Boolean).join(', '),
      ].filter(Boolean);
      let s = parts.join(' ');
      s = `${stripEndDot(s)}, ${pagePrefix(page)} ${page}.`;
      if (url) s += ` ${url}.`;
      return s;
    }
    case 'chicago': {
      // Chicago notes-bibliography style footnote
      const who = authors.length ? `${stripEndDot(chicagoAuthors(authors))}, ` : '';
      const pub = [publisher, year].filter(Boolean).join(', ');
      return `${who}${title}${pub ? ` (${pub})` : ''}, ${page}.${url ? ` ${url}.` : ''}`;
    }
    case 'bibtex': {
      const keyAuthor = authors.length ? nameParts(authors[0])[0] : title.split(' ')[0];
      const key = `${keyAuthor}${year}`.replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'source';
      const fields: [string, string][] = [
        ['author', authors.join(' and ')],
        ['title', title],
        ['year', year],
        ['publisher', publisher],
        ['url', url],
        ['pages', page.replace(/[–-]/, '--')],
      ];
      const body = fields
        .filter(([, v]) => v)
        .map(([k, v]) => `  ${k} = {${v}}`)
        .join(',\n');
      return `@misc{${key},\n${body}\n}`;
    }
  }
}

/** Short in-text citation, e.g. (Doe, 2020, p. 4). */
export function formatInText(style: CitationStyle, src: DocumentSource, page: string): string {
  const authors = splitAuthors(src.author);
  const who = shortAuthor(authors, style === 'apa' ? '&' : 'and') || `"${stripEndDot(clean(src.title)) || 'Untitled'}"`;
  const year = clean(src.year) || 'n.d.';
  switch (style) {
    case 'mla':
      return `(${who} ${page})`;
    case 'chicago':
      return `(${who} ${year}, ${page})`;
    default:
      return `(${who}, ${year}, ${pagePrefix(page)} ${page})`;
  }
}

/** Quote of the marked passage followed by its in-text citation. */
export function formatQuote(style: CitationStyle, src: DocumentSource, c: CitationAnnotation): string {
  const quote = clean(c.quote);
  const cite = formatInText(style === 'bibtex' ? 'apa' : style, src, citationPage(c));
  return quote ? `“${quote}” ${cite}` : cite;
}

export function citationMatches(c: CitationAnnotation, query: string, n: number): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${c.quote}\n${c.note}\np. ${citationPage(c)}\n#${n} [${n}]`.toLowerCase();
  return q.split(/\s+/).every((term) => hay.includes(term));
}

export async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  }
}
