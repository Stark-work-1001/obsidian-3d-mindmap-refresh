// Finds `$inline$` and `$$block$$` math in node text, skipping code spans,
// escaped dollars and plain currency amounts such as `$5`.
import type { FormulaSpan } from './types';

export const MAX_FORMULAS_PER_TEXT = 32;

export function scanFormulas(text: string): FormulaSpan[] {
  const result: FormulaSpan[] = [];
  if (!text || !text.includes('$')) return result;
  const codeSpans: [number, number][] = [];
  const codeRe = /`+[^`]*`+/g;
  let match: RegExpExecArray | null;
  while ((match = codeRe.exec(text))) codeSpans.push([match.index, match.index + match[0].length]);
  const inCode = (index: number) => codeSpans.some(([a, b]) => index >= a && index < b);
  const push = (kind: FormulaSpan['kind'], start: number, end: number, raw: string, tex: string) => {
    if (result.length >= MAX_FORMULAS_PER_TEXT) return;
    if (tex.trim()) result.push({ kind, tex, raw, start, end });
  };
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '$' || inCode(i)) { i++; continue; }
    if (i > 0 && text[i - 1] === '\\') { i++; continue; }
    if (text[i + 1] === '$') {
      const close = text.indexOf('$$', i + 2);
      if (close === -1) { i += 2; continue; }
      push('block', i, close + 2, text.slice(i, close + 2), text.slice(i + 2, close));
      i = close + 2;
      continue;
    }
    let j = i + 1;
    let close = -1;
    while (j < text.length) {
      if (text[j] === '\\') { j += 2; continue; }
      if (text[j] === '$' && !inCode(j)) { close = j; break; }
      if (text[j] === '\n') break;
      j++;
    }
    if (close === -1) { i++; continue; }
    const tex = text.slice(i + 1, close);
    if (!tex.trim() || /^\s|\s$/.test(tex)) { i++; continue; }
    if (/^[\d.,\s]+$/.test(tex)) { i = close + 1; continue; }
    push('inline', i, close + 1, text.slice(i, close + 1), tex);
    i = close + 1;
  }
  return result;
}
