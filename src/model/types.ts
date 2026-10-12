// Core outline data model. A Markdown note is parsed into a tree of headings
// and list items; every node keeps the exact source ranges needed to edit the
// note surgically. Nothing in this folder depends on Obsidian or the DOM.

export type NodeKind = 'root' | 'heading' | 'list-item';

export interface TextRange {
  from: number;
  to: number;
}

export interface FormulaSpan {
  kind: 'inline' | 'block';
  tex: string;
  raw: string;
  start: number;
  end: number;
}

export interface OutlineNode {
  /** Session-stable identifier (see id-matching.ts). Not persisted. */
  id: string;
  kind: NodeKind;
  /** Display text without the Markdown marker (`#`, `-`, `1.`, task box). */
  text: string;
  /** Original source line(s) including the marker. */
  rawText: string;
  /** Number of ancestors in the tree (root = 0). */
  depth: number;
  /** Outline level: `#` count for headings (capped), parent + 1 otherwise. */
  level: number;
  /** Visual ring used for sizing/colour: max(level, parent.ring + 1). */
  ring: number;
  headingLevel: number;
  indent: number;
  marker: string;
  taskMarker: string | null;
  /** 0-based source line of the node. */
  line: number;
  range: TextRange;
  contentStart: number;
  contentEnd: number;
  /** Blockquote note attached directly below the node, without `>` markers. */
  note: string | null;
  noteRange: TextRange | null;
  noteLineCount: number;
  formulas: FormulaSpan[];
  children: OutlineNode[];
  parent: OutlineNode | null;
  collapsed: boolean;
  /** Structural path built from source lines; changes when lines move. */
  pathId: string;
}

export interface OutlineStats {
  nodeCount: number;
  maxDepth: number;
  maxLevel: number;
  headingCount: number;
  listCount: number;
  noteCount: number;
  formulaCount: number;
}

export type CoreNameSource = 'frontmatter' | 'marker' | 'filename';

export interface OutlineTree {
  root: OutlineNode;
  text: string;
  basename: string;
  coreName: string;
  coreNameSource: CoreNameSource;
  maxHeadingLevel: number;
  indentUnit: number;
  stats: OutlineStats;
  warnings: string[];
}

export interface LineInfo {
  start: number;
  end: number;
  text: string;
  indent: number;
}

export interface LineTable {
  text: string;
  lines: LineInfo[];
  lineStarts: number[];
}

/** A single replacement in the note text. Ranges refer to the text before the edit. */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

export interface TreeDiff {
  added: string[];
  removed: string[];
  renamed: string[];
  noteChanged: string[];
  moved: string[];
  collapsedChanged: string[];
  any: boolean;
}

export type ChangeKind = 'add' | 'remove' | 'rename' | 'note';

export interface RunResult {
  ok: boolean;
  text: string;
  beforeText: string;
  tree: OutlineTree;
  diff: TreeDiff;
  label: string;
  edits: TextEdit[];
  targetId: string | null;
  reason?: string;
  changes: { kind: ChangeKind; nodeId: string }[];
}
