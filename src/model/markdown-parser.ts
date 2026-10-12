// Markdown outline parser: headings and list items become nodes, blockquotes
// directly under a node become its note. Ported from the recovered 1.15.0
// implementation; behaviour (node set, levels, ranges, notes, fresh IDs) is
// verified against reference/recovered-1.15.0.js by tests/model-parity.test.ts.
import { t } from '../i18n';
import { assignFreshIds, matchIds, createIdGenerator } from './id-matching';
import { scanFormulas } from './formula-scan';
import type { CoreNameSource, LineTable, OutlineNode, OutlineStats, OutlineTree } from './types';

export const DEFAULT_INDENT_UNIT = 2;
export const TAB_WIDTH = 4;
export const DEFAULT_MAX_HEADING_LEVEL = 6;
export const RECOMMENDED_NODE_LIMIT = 3000;
export const LONG_NODE_CHARS = 1000;

const HEADING_RE = /^(\s{0,3})(#{1,6})(\s+)(.*)$/;
const LIST_RE = /^(\s*)([-*+]|(?:\d{1,9})[.)])(\s+)(.*)$/;
const QUOTE_RE = /^(\s*)(>+)(\s?)(.*)$/;
const TASK_RE = /^\[([^\]]*)\]\s+/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const FRONTMATTER_FENCE = /^---\s*$/;
const THEMATIC_BREAK_RE = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;

/** Width of leading whitespace; a tab counts as TAB_WIDTH columns. */
export function indentWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += TAB_WIDTH;
    else break;
  }
  return width;
}

export function buildLineTable(text: string): LineTable {
  const lines: LineTable['lines'] = [];
  const lineStarts: number[] = [];
  let start = 0;
  while (start <= text.length) {
    let newline = text.indexOf('\n', start);
    if (newline === -1) newline = text.length;
    let end = newline;
    if (end > start && text[end - 1] === '\r') end -= 1;
    const lineText = text.slice(start, end);
    lines.push({ start, end, text: lineText, indent: indentWidth(lineText) });
    lineStarts.push(start);
    if (newline === text.length) break;
    start = newline + 1;
  }
  return { text, lines, lineStarts };
}

/** Offset of the start of `line`, clamped to the text. */
export function lineOffset(table: LineTable, line: number): number {
  if (line < 0) return 0;
  return line >= table.lines.length ? table.text.length : table.lines[line].start;
}

export function spaces(count: number): string {
  return ' '.repeat(Math.max(0, Math.round(count)));
}

/** Smallest list indent (1 → 2, capped at 4) decides the indent unit. */
export function detectIndentUnit(indents: number[]): number {
  const positive = indents.filter(i => i > 0 && i <= 16);
  if (!positive.length) return DEFAULT_INDENT_UNIT;
  const smallest = Math.min(...positive);
  return smallest === 1 ? 2 : smallest <= 4 ? smallest : 4;
}

// --- Core-node name -----------------------------------------------------------
// The root node is named after the file. Users can override it with a
// frontmatter key or by separating a display name from the rest of the file
// name with a full-width vertical bar. The Chinese keys and suffixes below are
// data formats used in existing notes and file names, not interface text, and
// must keep matching for compatibility.
const CORE_NAME_SEPARATOR = '\uFF5C';
const CORE_NAME_KEYS = ['mindmap-root', 'mindmapRoot', '\u5BFC\u56FE\u6838\u5FC3', '\u6838\u5FC3\u8282\u70B9'];
const FILE_NAME_SUFFIXES = [
  /[\s_-]*(?:v|\u7248\u672C)\d+(?:\.\d+)*$/i,
  /[\s_-]*(?:\u7B54\u6848\u7248|\u89E3\u6790\u7248|\u7EAF\u6587\u672C\u7248|\u7EAF\u6B63\u6587\u7248|\u6761\u76EE\u7248|\u9AD8\u6E05\u7248|\u626B\u63CF\u7248|\u91CD\u5236\u7248|\u526F\u672C|\u5B9A\u7A3F|\u7EC8\u7A3F|\u8349\u7A3F)$/i,
  /[\s_-]*copy(?:\s*\d+)?$/i,
  /[\s_-]*\d{4}[-_.]\d{1,2}[-_.]\d{1,2}$/i,
];

function markedCoreName(basename: string): string | null {
  const index = basename.indexOf(CORE_NAME_SEPARATOR);
  return index <= 0 ? null : basename.slice(0, index).trim() || null;
}

export function stripFileNameSuffixes(name: string): string {
  let result = name.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of FILE_NAME_SUFFIXES) {
      const next = result.replace(pattern, '').trim();
      if (next !== result && next) { result = next; changed = true; }
    }
  }
  return result;
}

export function parseFrontmatter(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!/^---[ \t]*\r?\n/.test(text)) return result;
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^---[ \t]*$/.test(line)) break;
    const match = /^([A-Za-z_\u4e00-\u9fa5][^\s:]*)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    if (value && !(key in result)) result[key] = value;
  }
  return result;
}

export function resolveCoreName(basename: string, frontmatter: Record<string, string>, stripSuffix = false):
{ name: string; source: CoreNameSource; raw: string } {
  const raw = (basename ?? '').trim();
  for (const key of CORE_NAME_KEYS) {
    const value = (frontmatter[key] ?? '').trim();
    if (value) return { name: value, source: 'frontmatter', raw };
  }
  const marked = markedCoreName(raw);
  if (marked) return { name: (stripSuffix && stripFileNameSuffixes(marked)) || marked, source: 'marker', raw };
  return { name: (stripSuffix ? stripFileNameSuffixes(raw) : raw) || raw || t('model.untitled'), source: 'filename', raw };
}

// --- Node construction ------------------------------------------------------

interface NodeSeed {
  kind: OutlineNode['kind'];
  text: string;
  rawText: string;
  level: number;
  headingLevel: number;
  indent: number;
  marker: string;
  taskMarker: string | null;
  line: number;
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
  pathId: string;
}

function createNode(seed: NodeSeed): OutlineNode {
  return {
    id: '', kind: seed.kind, text: seed.text, rawText: seed.rawText, depth: 0, level: seed.level, ring: seed.level,
    headingLevel: seed.headingLevel, indent: seed.indent, marker: seed.marker, taskMarker: seed.taskMarker,
    line: seed.line, range: { from: seed.from, to: seed.to }, contentStart: seed.contentFrom, contentEnd: seed.contentTo,
    note: null, noteRange: null, noteLineCount: 0, formulas: [], children: [], parent: null, collapsed: false,
    pathId: seed.pathId,
  };
}

function attach(parent: OutlineNode, child: OutlineNode): void {
  child.parent = parent;
  child.depth = parent.depth + 1;
  child.ring = Math.max(child.level, parent.ring + 1);
  parent.children.push(child);
}

/** Pre-order walk without recursion (deep chains are common in long lists). */
export function walkPreorder(root: OutlineNode, visit: (node: OutlineNode) => void): void {
  const stack: OutlineNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    visit(node);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
}

function computeStats(root: OutlineNode, warnings: string[]): OutlineStats {
  const stats: OutlineStats = { nodeCount: 0, maxDepth: 0, maxLevel: 0, headingCount: 0, listCount: 0, noteCount: 0, formulaCount: 0 };
  walkPreorder(root, node => {
    if (node.kind === 'root') return;
    stats.nodeCount++;
    stats.maxDepth = Math.max(stats.maxDepth, node.depth);
    stats.maxLevel = Math.max(stats.maxLevel, node.level);
    if (node.kind === 'heading') stats.headingCount++; else stats.listCount++;
    if (node.note) stats.noteCount++;
    const formulas = scanFormulas(node.text);
    node.formulas = formulas;
    stats.formulaCount += formulas.length;
    for (const formula of formulas) {
      if (formula.raw.indexOf('$', 1) === -1) { warnings.push(t('parser.unclosedFormula', { text: node.text.slice(0, 40) })); break; }
    }
    if (node.text.length > LONG_NODE_CHARS) warnings.push(t('parser.longNode', { count: node.text.length }));
  });
  if (stats.nodeCount > RECOMMENDED_NODE_LIMIT) warnings.push(t('parser.tooManyNodes', { count: stats.nodeCount, limit: RECOMMENDED_NODE_LIMIT }));
  return stats;
}

export interface ParseOptions {
  basename?: string;
  previous?: OutlineTree | null;
  maxHeadingLevel?: number;
  coreNameStripSuffix?: boolean;
}

export function parseOutline(text: string, options: ParseOptions = {}): OutlineTree {
  const warnings: string[] = [];
  const lines = buildLineTable(text).lines;
  let bodyStart = 0;
  if (lines.length && FRONTMATTER_FENCE.test(lines[0].text)) {
    for (let i = 1; i < lines.length; i++) if (FRONTMATTER_FENCE.test(lines[i].text)) { bodyStart = i + 1; break; }
  }
  const listIndents: number[] = [];
  for (let i = bodyStart; i < lines.length; i++) {
    const match = LIST_RE.exec(lines[i].text);
    if (match) listIndents.push(indentWidth(match[1]));
  }
  const indentUnit = detectIndentUnit(listIndents) || DEFAULT_INDENT_UNIT;
  const basename = options.basename ?? 'Mind Map';
  const cap = Math.min(6, Math.max(1, Math.round(options.maxHeadingLevel ?? DEFAULT_MAX_HEADING_LEVEL)));
  const root = createNode({
    kind: 'root', text: basename, rawText: '', level: 0, headingLevel: 0, indent: -indentUnit, marker: '',
    taskMarker: null, line: Math.min(bodyStart, Math.max(0, lines.length - 1)), from: 0, to: text.length,
    contentFrom: 0, contentTo: 0, pathId: 'r',
  });

  const headingStack: OutlineNode[] = [];
  let lastItem: OutlineNode | null = null;
  let fence: string | null = null;
  let afterBlank = true;
  let noteOwner: OutlineNode | null = null;
  let noteLines: string[] = [];
  let noteFirst = -1;
  let noteLast = -1;
  const currentHeading = () => (headingStack.length ? headingStack[headingStack.length - 1] : root);
  const flushNote = () => {
    if (noteOwner && noteLines.length) {
      noteOwner.note = noteLines.join('\n').trim();
      noteOwner.noteLineCount = noteLast - noteFirst + 1;
      noteOwner.noteRange = { from: lines[noteFirst].start, to: lines[noteLast].end };
    }
    noteOwner = null; noteLines = []; noteFirst = -1; noteLast = -1;
  };
  const listParentFor = (indent: number): OutlineNode => {
    let node = lastItem;
    while (node && node.kind === 'list-item') {
      if (node.indent < indent) return node;
      node = node.parent && node.parent.kind === 'list-item' ? node.parent : null;
    }
    return currentHeading();
  };

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    const raw = line.text;
    const fenceMatch = FENCE_RE.exec(raw);
    if (fenceMatch) {
      const marker = fenceMatch[1][0].repeat(3);
      if (fence) { if (raw.trimStart().startsWith(fence)) fence = null; } else fence = marker;
      afterBlank = false;
      flushNote();
      continue;
    }
    if (fence) continue;
    if (!raw.trim()) { afterBlank = true; flushNote(); continue; }

    const quote = QUOTE_RE.exec(raw);
    if (quote) {
      const owner = lastItem ?? currentHeading();
      const quoteIndent = indentWidth(quote[1]);
      const previousLine = noteOwner === owner ? noteLast : owner.noteLineCount > 0 ? owner.line + owner.noteLineCount : owner.line;
      if (owner !== root && i === previousLine + 1 && (owner.kind === 'list-item' ? quoteIndent >= owner.indent : true)) {
        if (noteOwner !== owner) { flushNote(); noteOwner = owner; noteLines = []; }
        if (noteFirst === -1) noteFirst = i;
        noteLast = i;
        noteLines.push(quote[4]);
        afterBlank = false;
        continue;
      }
    }

    const heading = HEADING_RE.exec(raw);
    if (heading) {
      flushNote();
      lastItem = null;
      const hashes = heading[2].length;
      const content = heading[4].trim();
      while (headingStack.length && headingStack[headingStack.length - 1].headingLevel >= hashes) headingStack.pop();
      const parent = currentHeading();
      if (parent.headingLevel && hashes > parent.headingLevel + 1) {
        warnings.push(t('parser.headingSkip', { from: parent.headingLevel, to: hashes, line: i + 1 }));
      }
      const node = createNode({
        kind: 'heading', text: content, rawText: raw, level: hashes >= 1 && hashes <= cap ? hashes : parent.level + 1,
        headingLevel: hashes, indent: indentWidth(heading[1]), marker: `${heading[2]} `, taskMarker: null, line: i,
        from: line.start, to: line.end, contentFrom: line.start + heading[0].length - heading[4].length,
        contentTo: line.end, pathId: `${parent.pathId}/h${i}`,
      });
      attach(parent, node);
      headingStack.push(node);
      afterBlank = false;
      continue;
    }

    const item = LIST_RE.exec(raw);
    if (item) {
      flushNote();
      const indent = indentWidth(item[1]);
      const marker = item[1] + item[2] + item[3];
      let content = item[4];
      let taskMarker: string | null = null;
      const task = TASK_RE.exec(content);
      if (task) { taskMarker = task[1]; content = content.slice(task[0].length); }
      const parent = listParentFor(indent);
      const node = createNode({
        kind: 'list-item', text: content.trim(), rawText: raw, level: parent.level + 1, headingLevel: 0, indent,
        marker, taskMarker, line: i, from: line.start, to: line.end, contentFrom: line.start + marker.length,
        contentTo: line.end, pathId: `${parent.pathId}/l${i}`,
      });
      attach(parent, node);
      lastItem = node;
      afterBlank = false;
      continue;
    }

    if (THEMATIC_BREAK_RE.test(raw)) { flushNote(); lastItem = null; afterBlank = false; continue; }
    if (lastItem && !afterBlank && line.indent >= lastItem.indent + lastItem.marker.length) {
      // Lazy continuation line of a list item.
      lastItem.text = `${lastItem.text} ${raw.trim()}`.trim();
      lastItem.rawText = `${lastItem.rawText}\n${raw}`;
      lastItem.contentEnd = line.end;
      lastItem.range.to = line.end;
      afterBlank = false;
      continue;
    }
    flushNote();
    afterBlank = false;
  }
  flushNote();

  const stats = computeStats(root, warnings);
  const used = new Set<string>(['root']);
  const nextId = createIdGenerator(text, used);
  root.id = 'root';
  if (options.previous?.root) matchIds(options.previous.root, root, used, nextId);
  else assignFreshIds(root, used, nextId);
  const core = resolveCoreName(basename, parseFrontmatter(text), options.coreNameStripSuffix === true);
  return {
    root, text, basename, coreName: core.name, coreNameSource: core.source, maxHeadingLevel: cap, indentUnit, stats, warnings,
  };
}
