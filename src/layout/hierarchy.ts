// Builds children lists, roots, depths and subtree sizes for layout input.
// Iterative; tolerant of malformed input (missing parents become roots,
// cycles are broken), so a layout never hangs or loses nodes.
import type { LayoutNode } from './types';

export interface Hierarchy {
  byId: Map<string, LayoutNode>;
  /** Children in document order, restricted to the traversal tree. */
  children: Map<string, LayoutNode[]>;
  roots: LayoutNode[];
  /** Pre-order traversal from the roots (every node exactly once). */
  order: LayoutNode[];
  /** Depth from the actual parent chain (0 for roots). */
  depth: Map<string, number>;
  /** Number of nodes in each subtree (including the node). */
  subtree: Map<string, number>;
  /** Top-level ancestor (chapter) of every node. */
  chapterOf: Map<string, LayoutNode>;
}

export function buildHierarchy(nodes: LayoutNode[]): Hierarchy {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const rawChildren = new Map<string, LayoutNode[]>();
  const isRoot = (n: LayoutNode) => !n.parentId || n.parentId === n.id || !byId.has(n.parentId);
  for (const n of nodes) {
    if (isRoot(n)) continue;
    const list = rawChildren.get(n.parentId!);
    if (list) list.push(n); else rawChildren.set(n.parentId!, [n]);
  }
  const roots = nodes.filter(isRoot);
  const order: LayoutNode[] = [];
  const depth = new Map<string, number>();
  const chapterOf = new Map<string, LayoutNode>();
  const children = new Map<string, LayoutNode[]>();
  const visit = (root: LayoutNode) => {
    const stack: [LayoutNode, number, LayoutNode][] = [[root, 0, root]];
    while (stack.length) {
      const [node, d, chapter] = stack.pop()!;
      if (depth.has(node.id)) continue;
      order.push(node);
      depth.set(node.id, d);
      chapterOf.set(node.id, chapter);
      const kids = (rawChildren.get(node.id) ?? []).filter(k => !depth.has(k.id));
      if (kids.length) children.set(node.id, kids);
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], d + 1, chapter]);
    }
  };
  roots.forEach(visit);
  // Nodes caught in a parent cycle are unreachable from any root: promote them.
  for (const n of nodes) {
    if (depth.has(n.id)) continue;
    roots.push(n);
    visit(n);
  }
  // A child may have been reached earlier through another path; keep only tree edges.
  for (const [id, kids] of children) children.set(id, kids.filter(k => depth.get(k.id) === depth.get(id)! + 1 && chapterOf.get(k.id) === chapterOf.get(id)));
  const subtree = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i];
    let size = 1;
    for (const child of children.get(node.id) ?? []) size += subtree.get(child.id) ?? 1;
    subtree.set(node.id, size);
  }
  return { byId, children, roots, order, depth, subtree, chapterOf };
}

export function kidsOf(h: Hierarchy, node: LayoutNode): LayoutNode[] {
  return h.children.get(node.id) ?? [];
}
