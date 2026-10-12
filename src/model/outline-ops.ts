// Pure functions that turn an outline operation into minimal text edits.
// Every function takes an EditContext snapshot and returns edits against it;
// nothing here mutates the tree or the note.
import { buildLineTable, lineOffset, spaces } from './markdown-parser';
import { childIndex, lastLineOf } from './tree-utils';
import { insertAt } from './text-edits';
import type { LineTable, OutlineNode, OutlineTree, TextEdit } from './types';

export interface EditContext {
  text: string;
  table: LineTable;
  unit: number;
  maxHeadingLevel: number;
}

export function editContext(tree: OutlineTree): EditContext {
  return { text: tree.text, table: buildLineTable(tree.text), unit: tree.indentUnit, maxHeadingLevel: tree.maxHeadingLevel };
}

/** Single-line node text; escapes text that Markdown would read as structure. */
export function sanitizeNodeText(text: string): string {
  let value = text.replace(/\r/g, '').replace(/\s*\n\s*/g, ' ').replace(/\t/g, ' ').trim();
  if (/^(#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s|>|\|)/.test(value)) value = `\\${value}`;
  return value;
}

/** Marker for a new item next to `node` (keeps ordered numbering style). */
export function siblingMarker(node: OutlineNode): string {
  if (/^\s*(\d{1,9})([.)])\s*$/.exec(node.marker)) return node.marker.trim().replace(/\d+/, String(childIndex(node) + 2));
  const bullet = /^[\s]*([-*+])/.exec(node.marker);
  return `${bullet ? bullet[1] : '-'} `;
}

/** Insert whole lines after source line `afterLine`. */
export function insertLinesAfter(ctx: EditContext, afterLine: number, lines: string[]): TextEdit {
  const next = afterLine + 1;
  if (next < ctx.table.lines.length) return insertAt(ctx.table.lines[next].start, `${lines.join('\n')}\n`);
  const lead = ctx.text.length > 0 && !ctx.text.endsWith('\n') ? '\n' : '';
  return insertAt(ctx.text.length, lead + lines.join('\n') + (ctx.text.length ? '\n' : ''));
}

export function blockRange(ctx: EditContext, node: OutlineNode): { from: number; to: number } {
  return { from: lineOffset(ctx.table, node.line), to: lineOffset(ctx.table, lastLineOf(node) + 1) };
}

export function blockText(ctx: EditContext, node: OutlineNode): string {
  const range = blockRange(ctx, node);
  return ctx.text.slice(range.from, range.to);
}

export function renameEdits(_ctx: EditContext, node: OutlineNode, text: string): TextEdit[] {
  return [{ from: node.contentStart, to: node.contentEnd, insert: sanitizeNodeText(text) }];
}

/** Markdown line for a new child of `parent`. */
export function childLine(ctx: EditContext, parent: OutlineNode, text: string): string {
  if (parent.kind === 'list-item') return spaces(parent.indent + ctx.unit) + siblingMarker(parent) + text;
  const headings = parent.children.filter(c => c.kind === 'heading');
  if (headings.length) {
    const level = Math.min(...headings.map(h => h.headingLevel));
    return `${'#'.repeat(Math.max(1, Math.min(6, level)))} ${text}`;
  }
  if (parent.kind === 'heading' && parent.headingLevel === parent.level && parent.level < ctx.maxHeadingLevel) {
    return `${'#'.repeat(Math.max(1, Math.min(6, parent.level + 1)))} ${text}`;
  }
  return `- ${text}`;
}

export function siblingLine(ctx: EditContext, node: OutlineNode, text: string): string {
  if (node.kind === 'heading') return `${'#'.repeat(node.headingLevel)} ${text}`;
  if (node.kind === 'list-item') return spaces(node.indent) + siblingMarker(node) + text;
  return childLine(ctx, node, text);
}

export function addChildEdits(ctx: EditContext, parent: OutlineNode, text: string): TextEdit[] {
  return [insertLinesAfter(ctx, lastLineOf(parent), [childLine(ctx, parent, text)])];
}

export function addSiblingEdits(ctx: EditContext, node: OutlineNode, text: string): TextEdit[] {
  if (node.kind === 'root') return addChildEdits(ctx, node, text);
  return [insertLinesAfter(ctx, lastLineOf(node), [siblingLine(ctx, node, text)])];
}

export function removeEdits(ctx: EditContext, node: OutlineNode): TextEdit[] {
  if (node.kind === 'root') return [];
  const range = blockRange(ctx, node);
  return [{ from: range.from, to: range.to, insert: '' }];
}

/** List items can be indented when the previous sibling is a list item. */
export function canIndent(_ctx: EditContext, node: OutlineNode): boolean {
  if (node.kind !== 'list-item' || !node.parent) return false;
  const index = childIndex(node);
  return index > 0 && node.parent.children[index - 1].kind === 'list-item';
}

export function canOutdent(ctx: EditContext, node: OutlineNode): boolean {
  return node.kind === 'list-item' && node.indent >= ctx.unit;
}

/** Shift the indentation of a list item's whole block by one unit. */
export function indentEdits(ctx: EditContext, node: OutlineNode, direction: 1 | -1): TextEdit[] {
  if (direction > 0 && !canIndent(ctx, node)) return [];
  if (direction < 0 && !canOutdent(ctx, node)) return [];
  const last = lastLineOf(node);
  const edits: TextEdit[] = [];
  for (let line = node.line; line <= last; line++) {
    const info = ctx.table.lines[line];
    if (!info || !info.text.trim()) continue;
    const leading = /^\s*/.exec(info.text)![0];
    const target = Math.max(0, info.indent + direction * ctx.unit);
    if (leading.length === target && !leading.includes('\t')) continue;
    edits.push({ from: info.start, to: info.start + leading.length, insert: spaces(target) });
  }
  return edits;
}

/** Ensure a moved block is terminated by exactly one newline. */
function terminated(block: string): string {
  return block.endsWith('\n') ? block : `${block}\n`;
}

/** Move a node (with its subtree and note) before/after an adjacent sibling. */
export function moveEdits(ctx: EditContext, node: OutlineNode, delta: -1 | 1): TextEdit[] {
  if (node.kind === 'root' || !node.parent) return [];
  const siblings = node.parent.children;
  const index = siblings.indexOf(node);
  const targetIndex = index + delta;
  if (index < 0 || targetIndex < 0 || targetIndex >= siblings.length) return [];
  const block = blockText(ctx, node);
  if (!block) return [];
  const target = siblings[targetIndex];
  const removal = removeEdits(ctx, node)[0];
  if (delta < 0) return [removal, insertAt(lineOffset(ctx.table, target.line), terminated(block))];
  const after = lineOffset(ctx.table, lastLineOf(target) + 1);
  if (after >= ctx.text.length && !ctx.text.endsWith('\n')) {
    return [removal, insertAt(ctx.text.length, `\n${block.replace(/\n$/, '')}`)];
  }
  return [removal, insertAt(after, terminated(block))];
}

export function noteLines(_ctx: EditContext, node: OutlineNode, note: string): string[] {
  const indent = spaces(node.indent);
  return note.replace(/\r/g, '').split('\n').map(line => (line.trim() ? `${indent}> ${line.replace(/\s+$/, '')}` : `${indent}>`));
}

export function clearNoteEdits(ctx: EditContext, node: OutlineNode): TextEdit[] {
  if (!node.noteRange || node.noteLineCount <= 0) return [];
  return [{ from: node.noteRange.from, to: lineOffset(ctx.table, node.line + node.noteLineCount + 1), insert: '' }];
}

export function setNoteEdits(ctx: EditContext, node: OutlineNode, note: string): TextEdit[] {
  const value = note.replace(/\r/g, '').trimEnd();
  if (!value.trim()) return clearNoteEdits(ctx, node);
  const lines = noteLines(ctx, node, value);
  if (node.noteRange && node.noteLineCount > 0) {
    return [{ from: node.noteRange.from, to: lineOffset(ctx.table, node.line + node.noteLineCount + 1), insert: `${lines.join('\n')}\n` }];
  }
  return [insertLinesAfter(ctx, node.line, lines)];
}
