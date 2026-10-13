// Small, allocation-light helpers over OutlineNode trees. All traversals are
// iterative so 3000-level list chains cannot overflow the call stack.
import { t } from '../i18n';
import { walkPreorder } from './markdown-parser';
import type { OutlineNode, OutlineTree, TreeDiff } from './types';

export { walkPreorder };

export function findNode(root: OutlineNode, id: string | null | undefined): OutlineNode | null {
  if (!id) return null;
  let found: OutlineNode | null = null;
  const stack: OutlineNode[] = [root];
  while (stack.length && !found) {
    const node = stack.pop()!;
    if (node.id === id) found = node;
    else for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return found;
}

export function indexById(tree: OutlineTree): Map<string, OutlineNode> {
  const map = new Map<string, OutlineNode>();
  walkPreorder(tree.root, node => map.set(node.id, node));
  return map;
}

export function ancestorsOf(node: OutlineNode): OutlineNode[] {
  const list: OutlineNode[] = [];
  for (let p = node.parent; p; p = p.parent) list.push(p);
  return list;
}

/** Last source line belonging to `node`'s subtree, including notes. */
export function lastLineOf(node: OutlineNode): number {
  let last = node.line + (node.noteLineCount || 0);
  walkPreorder(node, n => { last = Math.max(last, n.line + (n.noteLineCount || 0)); });
  return last;
}

/** Visible subtree (collapsed nodes keep their children hidden) in pre-order. */
export function visibleNodes(root: OutlineNode): OutlineNode[] {
  const list: OutlineNode[] = [];
  const stack: OutlineNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    list.push(node);
    if (!node.collapsed) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return list;
}

export function descendantCount(node: OutlineNode): number {
  let count = -1;
  walkPreorder(node, () => { count++; });
  return count;
}

/** Number of visible nodes in each subtree (restricted to `visible` if given). */
export function subtreeSizes(root: OutlineNode, visible?: Set<string>): Map<string, number> {
  const sizes = new Map<string, number>();
  const order: OutlineNode[] = [];
  walkPreorder(root, n => order.push(n));
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i];
    let size = 1;
    for (const child of node.children) if (!visible || visible.has(child.id)) size += sizes.get(child.id) ?? 1;
    sizes.set(node.id, size);
  }
  return sizes;
}

export function childIndex(node: OutlineNode): number {
  return node.parent ? node.parent.children.indexOf(node) : -1;
}

export function displayText(node: OutlineNode, max = 120): string {
  const text = node.text.trim() || (node.kind === 'heading' ? t('model.emptyHeading') : t('model.emptyItem'));
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

export function emptyDiff(): TreeDiff {
  return { added: [], removed: [], renamed: [], noteChanged: [], moved: [], collapsedChanged: [], any: false };
}

export function diffTrees(before: OutlineTree, after: OutlineTree): TreeDiff {
  const a = indexById(before);
  const b = indexById(after);
  const diff = emptyDiff();
  for (const [id, node] of b) {
    const old = a.get(id);
    if (!old) { diff.added.push(id); continue; }
    if (old.text !== node.text) diff.renamed.push(id);
    if ((old.note ?? '') !== (node.note ?? '')) diff.noteChanged.push(id);
    if (old.parent?.id !== node.parent?.id || old.collapsed !== node.collapsed) diff.moved.push(id);
  }
  for (const id of a.keys()) if (!b.has(id)) diff.removed.push(id);
  diff.any = diff.added.length + diff.removed.length + diff.renamed.length + diff.noteChanged.length + diff.moved.length > 0;
  return diff;
}

/** Carry collapsed flags across a re-parse for nodes that kept their id. */
export function copyCollapsed(from: OutlineTree, to: OutlineTree): void {
  const old = indexById(from);
  walkPreorder(to.root, node => {
    const prior = old.get(node.id);
    if (prior) node.collapsed = prior.collapsed;
  });
}

export function nodeAtLine(tree: OutlineTree, line: number): OutlineNode | null {
  let found: OutlineNode | null = null;
  walkPreorder(tree.root, node => { if (!found && node.kind !== 'root' && node.line === line) found = node; });
  return found;
}
