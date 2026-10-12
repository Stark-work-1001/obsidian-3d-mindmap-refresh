// The editable outline: owns the current parse, turns operations into text
// edits, re-parses with identity matching and records undo history. It never
// writes anywhere itself; DocumentSync decides how the text reaches the note.
import { t } from '../i18n';
import { EditHistory } from './history';
import { parseOutline } from './markdown-parser';
import * as ops from './outline-ops';
import { applyEdits, invertEdits, validateEdits } from './text-edits';
import { copyCollapsed, diffTrees, emptyDiff, findNode, nodeAtLine, visibleNodes, walkPreorder, lastLineOf } from './tree-utils';
import type { OutlineNode, OutlineTree, RunResult, TextEdit, TreeDiff } from './types';

export interface RunOptions {
  /** false for undo/redo replays. */
  history?: boolean;
  /** Select the node that ends up on this source line (new nodes). */
  expectLine?: number;
}

function changesOf(diff: TreeDiff): RunResult['changes'] {
  return [
    ...diff.added.map(nodeId => ({ kind: 'add' as const, nodeId })),
    ...diff.removed.map(nodeId => ({ kind: 'remove' as const, nodeId })),
    ...diff.renamed.map(nodeId => ({ kind: 'rename' as const, nodeId })),
    ...diff.noteChanged.map(nodeId => ({ kind: 'note' as const, nodeId })),
  ];
}

export class OutlineModel {
  readonly history = new EditHistory();
  private cap: number;
  private stripSuffix: boolean;
  private tree: OutlineTree;

  constructor(text: string, basename: string, maxHeadingLevel = 6, stripSuffix = false) {
    this.cap = maxHeadingLevel;
    this.stripSuffix = stripSuffix;
    this.tree = this.parse(text, basename, null);
  }

  private parse(text: string, basename: string, previous: OutlineTree | null): OutlineTree {
    return parseOutline(text, { basename, previous, maxHeadingLevel: this.cap, coreNameStripSuffix: this.stripSuffix });
  }

  get text(): string { return this.tree.text; }
  get root(): OutlineNode { return this.tree.root; }
  get current(): OutlineTree { return this.tree; }
  get stats() { return this.tree.stats; }
  get warnings(): string[] { return this.tree.warnings; }
  get maxHeadingLevel(): number { return this.cap; }
  get canUndo(): boolean { return this.history.canUndo; }
  get canRedo(): boolean { return this.history.canRedo; }
  get undoLabel(): string | null { return this.history.peekUndoLabel(); }
  get redoLabel(): string | null { return this.history.peekRedoLabel(); }

  find(id: string | null | undefined): OutlineNode | null { return id ? findNode(this.tree.root, id) : null; }

  private reparse(): boolean {
    const previous = this.tree;
    const next = this.parse(previous.text, previous.basename, previous);
    copyCollapsed(previous, next);
    this.tree = next;
    return true;
  }

  setMaxHeadingLevel(level: number): boolean {
    const value = Math.min(6, Math.max(1, Math.round(level)));
    if (value === this.cap) return false;
    this.cap = value;
    return this.reparse();
  }

  setCoreNameStripSuffix(strip: boolean): boolean {
    if (strip === this.stripSuffix) return false;
    this.stripSuffix = strip;
    return this.reparse();
  }

  /** Re-label the file name used for the root (after a vault rename). */
  setBasename(basename: string): void {
    if (basename === this.tree.basename) return;
    const previous = this.tree;
    const next = this.parse(previous.text, basename, previous);
    copyCollapsed(previous, next);
    this.tree = next;
  }

  private noop(label: string, reason?: string): RunResult {
    const tree = this.tree;
    return { ok: false, text: tree.text, beforeText: tree.text, tree, diff: emptyDiff(), label, edits: [], targetId: null, reason, changes: [] };
  }

  run(edits: TextEdit[], label: string, options: RunOptions = {}): RunResult {
    const before = this.tree;
    const text = before.text;
    if (!edits.length) return this.noop(label, 'noop');
    const invalid = validateEdits(text, edits);
    if (invalid) return this.noop(label, invalid);
    const after = applyEdits(text, edits);
    const inverse = invertEdits(text, edits);
    const tree = this.parse(after, before.basename, before);
    copyCollapsed(before, tree);
    const diff = diffTrees(before, tree);
    this.tree = tree;
    if (options.history !== false) this.history.push({ edits, inverse, label, afterText: after, beforeText: text });
    const targetId = options.expectLine !== undefined ? nodeAtLine(tree, options.expectLine)?.id ?? null : diff.added[0] ?? null;
    return { ok: true, text: after, beforeText: text, tree, diff, label, edits, targetId, changes: changesOf(diff) };
  }

  private ctx() { return ops.editContext(this.tree); }

  addChild(id: string, text = ''): RunResult {
    const node = this.find(id);
    if (!node) return this.noop('addChild');
    return this.run(ops.addChildEdits(this.ctx(), node, text), t('history.addChild'), { expectLine: lastLineOf(node) + 1 });
  }

  addSibling(id: string, text = ''): RunResult {
    const node = this.find(id);
    if (!node) return this.noop('addSibling');
    return this.run(ops.addSiblingEdits(this.ctx(), node, text), t('history.addSibling'), { expectLine: lastLineOf(node) + 1 });
  }

  rename(id: string, text: string): RunResult {
    const node = this.find(id);
    if (!node || ops.sanitizeNodeText(text) === node.text) return this.noop('rename');
    return this.run(ops.renameEdits(this.ctx(), node, text), t('history.rename'));
  }

  remove(id: string): RunResult {
    const node = this.find(id);
    if (!node || node.kind === 'root') return this.noop('remove');
    return this.run(ops.removeEdits(this.ctx(), node), t('history.remove'));
  }

  indent(id: string): RunResult {
    const node = this.find(id);
    return node ? this.run(ops.indentEdits(this.ctx(), node, 1), t('history.indent')) : this.noop('indent');
  }

  outdent(id: string): RunResult {
    const node = this.find(id);
    return node ? this.run(ops.indentEdits(this.ctx(), node, -1), t('history.outdent')) : this.noop('outdent');
  }

  move(id: string, delta: -1 | 1): RunResult {
    const node = this.find(id);
    return node ? this.run(ops.moveEdits(this.ctx(), node, delta), delta < 0 ? t('history.moveUp') : t('history.moveDown')) : this.noop('move');
  }

  setNote(id: string, note: string): RunResult {
    const node = this.find(id);
    return node ? this.run(ops.setNoteEdits(this.ctx(), node, note), t('history.editNote')) : this.noop('setNote');
  }

  clearNote(id: string): RunResult {
    const node = this.find(id);
    return node ? this.run(ops.clearNoteEdits(this.ctx(), node), t('history.clearNote')) : this.noop('clearNote');
  }

  /** Apply pre-computed edits (used by structural operations such as reparenting). */
  applyOperation(edits: TextEdit[], label: string, expectLine?: number): RunResult {
    return this.run(edits, label, expectLine === undefined ? {} : { expectLine });
  }

  toggleCollapse(id: string): boolean {
    const node = this.find(id);
    if (!node || node.kind === 'root') return false;
    node.collapsed = !node.collapsed;
    return node.collapsed;
  }

  setCollapsed(id: string, collapsed: boolean): boolean {
    const node = this.find(id);
    if (!node || node.kind === 'root') return false;
    node.collapsed = collapsed;
    return collapsed;
  }

  /** Collapse every node at or below `ring` that has children. Returns changed count. */
  collapseToDepth(ring: number): number {
    let changed = 0;
    walkPreorder(this.tree.root, node => {
      if (node.kind === 'root') return;
      const collapse = node.children.length > 0 && node.ring >= ring;
      if (node.collapsed !== collapse) { node.collapsed = collapse; changed++; }
    });
    return changed;
  }

  expandAll(): number {
    let changed = 0;
    walkPreorder(this.tree.root, node => { if (node.collapsed) { node.collapsed = false; changed++; } });
    return changed;
  }

  /** Hide one more level: collapse the deepest visible ring with children. */
  collapseStep(): number {
    const visible = visibleNodes(this.tree.root);
    if (visible.length < 2) return 0;
    let deepest = 0;
    for (const node of visible) deepest = Math.max(deepest, node.ring);
    for (let ring = deepest; ring >= 1; ring--) {
      const candidates = visible.filter(n => n.ring === ring && !n.collapsed && n.children.length > 0);
      if (candidates.length) { for (const n of candidates) n.collapsed = true; return candidates.length; }
    }
    return 0;
  }

  /** Reveal one more level: expand the shallowest collapsed ring. */
  expandStep(): number {
    const all: OutlineNode[] = [];
    walkPreorder(this.tree.root, n => all.push(n));
    let shallowest = Number.POSITIVE_INFINITY;
    for (const n of all) if (n.collapsed && n.children.length > 0) shallowest = Math.min(shallowest, n.ring);
    if (!Number.isFinite(shallowest)) return 0;
    let changed = 0;
    for (const n of all) if (n.ring === shallowest && n.collapsed && n.children.length > 0) { n.collapsed = false; changed++; }
    return changed;
  }

  undo(): RunResult {
    const entry = this.history.takeUndo(this.text);
    return entry ? this.run(entry.inverse, t('history.undo'), { history: false }) : this.noop('undo');
  }

  redo(): RunResult {
    const entry = this.history.takeRedo(this.text);
    return entry ? this.run(entry.edits, t('history.redo'), { history: false }) : this.noop('redo');
  }

  /** Adopt text that changed outside the map (keeps identities, clears history). */
  replaceText(text: string): RunResult | null {
    if (text === this.text) return null;
    const before = this.tree;
    const tree = this.parse(text, before.basename, before);
    copyCollapsed(before, tree);
    const diff = diffTrees(before, tree);
    this.tree = tree;
    this.history.clear();
    return { ok: true, text, beforeText: before.text, tree, diff, label: t('history.externalEdit'), edits: [], targetId: null, changes: changesOf(diff) };
  }

  signature(): string {
    return `${this.tree.text.length}:${this.tree.stats.nodeCount}`;
  }
}
