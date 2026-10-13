// Build layout input from Markdown fixtures exactly like the view does.
import { parseOutline } from '../../src/model/markdown-parser';
import { walkPreorder } from '../../src/model/tree-utils';
import { effectiveRadius } from '../../src/layout/radius';
import type { LayoutNode } from '../../src/layout/types';

export function layoutNodesFrom(markdown: string, options: { scale?: number; multipliers?: (index: number) => number } = {}): LayoutNode[] {
  const tree = parseOutline(markdown, { basename: 'Fixture' });
  const nodes: LayoutNode[] = [];
  walkPreorder(tree.root, n => {
    if (n.kind === 'root') return;
    const parentId = n.parent && n.parent.kind !== 'root' ? n.parent.id : null;
    const index = nodes.length;
    nodes.push({
      id: n.id, parentId, depth: n.depth - 1, ring: n.ring, order: index, childCount: n.children.length,
      radius: effectiveRadius({ ring: n.ring, hasNote: !!n.note, hasFormula: n.formulas.length > 0, childCount: n.children.length }, options.scale ?? 1, options.multipliers?.(index) ?? 1),
      anchor: null, x: 0, y: 0, z: 0,
    });
  });
  return nodes;
}

export const clone = (nodes: LayoutNode[]) => nodes.map(n => ({ ...n, anchor: n.anchor ? { ...n.anchor } : null }));
