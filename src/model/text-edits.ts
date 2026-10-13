// Text edits are (from, to, insert) replacements against one snapshot of the
// note. They are validated as non-overlapping before use and can be inverted
// for undo.
import { t } from '../i18n';
import type { TextEdit } from './types';

export function sortEdits(edits: readonly TextEdit[]): TextEdit[] {
  return [...edits].sort((a, b) => a.from - b.from || a.to - b.to);
}

/** Returns an error message, or null when the edits are applicable to `text`. */
export function validateEdits(text: string, edits: readonly TextEdit[]): string | null {
  let previousEnd = -1;
  for (const edit of sortEdits(edits)) {
    if (edit.from < 0 || edit.to < edit.from || edit.to > text.length) {
      return t('edit.outOfRange', { from: edit.from, to: edit.to, length: text.length });
    }
    if (previousEnd >= 0 && edit.from < previousEnd) return t('edit.overlap', { from: edit.from, to: edit.to });
    previousEnd = edit.to;
  }
  return null;
}

export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  let out = '';
  let cursor = 0;
  for (const edit of sortEdits(edits)) {
    if (edit.from < cursor) continue;
    out += text.slice(cursor, edit.from) + edit.insert;
    cursor = Math.max(cursor, edit.to);
  }
  return out + text.slice(cursor);
}

/** Edits that turn the result of `applyEdits(text, edits)` back into `text`. */
export function invertEdits(text: string, edits: readonly TextEdit[]): TextEdit[] {
  let shift = 0;
  return sortEdits(edits).map(edit => {
    const from = edit.from + shift;
    const inverse = { from, to: from + edit.insert.length, insert: text.slice(edit.from, edit.to) };
    shift += edit.insert.length - (edit.to - edit.from);
    return inverse;
  }).reverse();
}

export function insertAt(offset: number, insert: string): TextEdit {
  return { from: offset, to: offset, insert };
}
