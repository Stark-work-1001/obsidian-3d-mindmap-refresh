// Label HTML for node text: inline Markdown (bold, italic, highlight,
// strike, code), wikilinks (aliases shown, targets kept in data-link for
// navigation), external links, and KaTeX formulas. Ported from 1.15 with
// identical output; KaTeX output is cached (LRU) per formula.
import katex from 'katex';
import { scanFormulas } from '../model/formula-scan';

export const LABEL_MAX_CHARS = 140;
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const escapeHtml = (text: string) => text.replace(/[&<>"]/g, c => ESCAPES[c]);

export function truncate(text: string, max = LABEL_MAX_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}\u2026`;
}

function inlineMarkdown(html: string): string {
  return html
    .replace(/!\[\[([^\]]*)\]\]/g, '<span class="om3d-embed">![$1]</span>')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '<span class="om3d-wikilink" data-link="$1">$2</span>')
    .replace(/\[\[([^\]]+)\]\]/g, '<span class="om3d-wikilink" data-link="$1">$1</span>')
    .replace(/\[([^\]]*)\]\(([^)]+)\)/g, '<span class="om3d-link" data-href="$2">$1</span>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>');
}

const codeSpans = () => /(`+)([^`]*?)\1/g;

function textWithCode(text: string): string {
  let out = '', cursor = 0, m: RegExpExecArray | null;
  const re = codeSpans();
  while ((m = re.exec(text))) {
    out += inlineMarkdown(escapeHtml(text.slice(cursor, m.index)));
    out += `<code class="om3d-code">${escapeHtml(m[2].trim())}</code>`;
    cursor = m.index + m[0].length;
  }
  return out + inlineMarkdown(escapeHtml(text.slice(cursor)));
}

/**
 * Every option KaTeX reads that affects safety or limits is set explicitly, so
 * nothing can be inherited from a modified Object.prototype (advisory
 * GHSA-238p-pmpm-9mq7 affects KaTeX < 0.18.2 only through inherited values).
 */
export function katexOptions(display: boolean): katex.KatexOptions {
  return {
    displayMode: display, output: 'html', throwOnError: true, errorColor: '#e5484d', strict: 'ignore',
    // KaTeX's default values, given as own properties.
    // macros: a fresh object; KaTeX only reads its own properties (and needs hasOwnProperty).
    trust: false, macros: {}, maxSize: Infinity, maxExpand: 1000,
    globalGroup: false, fleqn: false, leqno: false, colorIsTextColor: false, minRuleThickness: 0,
  };
}

export class FormulaCache {
  private cache = new Map<string, string | null>();
  enabled = true;
  hits = 0;
  misses = 0;
  constructor(private readonly limit = 400) {}

  render(tex: string, display: boolean): string | null {
    if (!this.enabled || !tex.trim()) return null;
    const key = (display ? 'D:' : 'I:') + tex;
    if (this.cache.has(key)) {
      const value = this.cache.get(key)!;
      this.cache.delete(key); this.cache.set(key, value);
      this.hits++;
      return value;
    }
    this.misses++;
    let html: string | null = null;
    try {
      html = katex.renderToString(tex, katexOptions(display));
    } catch { html = null; }
    this.cache.set(key, html);
    if (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value!);
    return html;
  }

  clear(): void { this.cache.clear(); }

}

function withFormulas(text: string, formulas: FormulaCache): string {
  const spans = scanFormulas(text);
  if (!spans.length) return textWithCode(text);
  let out = '', cursor = 0;
  for (const span of spans) {
    out += textWithCode(text.slice(cursor, span.start));
    const html = formulas.render(span.tex, span.kind === 'block');
    out += html
      ? `<span class="om3d-formula${span.kind === 'block' ? ' om3d-formula-block' : ''}">${html}</span>`
      : `<span class="om3d-formula-error">${escapeHtml(span.raw)}</span>`;
    cursor = span.end;
  }
  return out + textWithCode(text.slice(cursor));
}

/** HTML for a node label (same structure as 1.15). */
export function labelHtml(text: string, formulas: FormulaCache | null, max = LABEL_MAX_CHARS): string {
  const value = text.length > max ? truncate(text, max) : text;
  const render = (part: string) => (formulas?.enabled ? withFormulas(part, formulas) : textWithCode(part));
  let out = '', cursor = 0, m: RegExpExecArray | null;
  const re = codeSpans();
  while ((m = re.exec(value))) {
    out += render(value.slice(cursor, m.index));
    out += `<code class="om3d-code">${escapeHtml(m[2].trim())}</code>`;
    cursor = m.index + m[0].length;
  }
  return out + render(value.slice(cursor));
}

/** Plain text (no markup) for titles, search and accessibility names. */
export function plainText(text: string): string {
  return text
    .replace(/!?\[\[([^\]|#]*?)(?:#([^|\]]*))?(?:\|([^\]]*))?\]\]/g, (_m, target: string, anchor: string, alias: string) => alias?.trim() || [target, anchor].filter(Boolean).join(' \u203A '))
    .replace(/\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__|~~|==|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
