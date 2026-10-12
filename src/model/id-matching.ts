// Session-stable node identity.
//
// A fresh parse numbers nodes in pre-order: `x<counter base36><4 chars of
// FNV-1a(text + counter)>`. This is byte-for-byte the scheme of 1.15-1.17, so
// identifiers saved by older versions (collapsed state in camera poses) can
// still be resolved when the note text is unchanged.
//
// When a note is re-parsed after an edit, each sibling list is matched against
// the previous parse by (kind, heading level, normalised text) using a longest
// common subsequence; unmatched nodes left between two matches are paired in
// order, so a renamed node keeps its identifier. Compared with 1.17, common
// prefixes and suffixes are matched before the quadratic LCS, and very large
// remaining windows fall back to an ordered key match, so memory stays bounded
// (the old implementation allocated (n+1)^2 cells for an n-child heading).
import type { OutlineNode } from './types';

export function fnv1a36(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Fresh identifiers. The hash of `text + counter` is computed by hashing the
 * text once and continuing FNV-1a over the counter digits: identical output to
 * hashing the concatenation (FNV-1a is sequential), but linear instead of
 * O(nodes x text length). The 1.17 approach took ~23 s for a 3000-node outline
 * with deep indentation.
 */
export function createIdGenerator(text: string, used: Set<string>): () => string {
  let base = 2166136261;
  for (let i = 0; i < text.length; i++) {
    base ^= text.charCodeAt(i);
    base = Math.imul(base, 16777619);
  }
  let counter = 0;
  return () => {
    let id = '';
    do {
      counter++;
      const digits = String(counter);
      let hash = base;
      for (let i = 0; i < digits.length; i++) {
        hash ^= digits.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      id = `x${counter.toString(36)}${(hash >>> 0).toString(36).slice(0, 4)}`;
    } while (used.has(id));
    used.add(id);
    return id;
  };
}

function matchKey(node: OutlineNode): string {
  return `${node.kind}|${node.headingLevel}|${node.text.replace(/\s+/g, ' ').trim()}`;
}

/** Give every descendant of `node` a new identifier, in pre-order. */
export function assignFreshIds(node: OutlineNode, used: Set<string>, next: () => string): void {
  const stack: OutlineNode[] = [];
  for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  while (stack.length) {
    const current = stack.pop()!;
    current.id = next();
    used.add(current.id);
    for (let i = current.children.length - 1; i >= 0; i--) stack.push(current.children[i]);
  }
}

/** Maximum DP cells for the quadratic LCS before falling back to ordered matching. */
export const LCS_CELL_BUDGET = 1_500_000;

/** Returns a map: new index -> old index. */
export function matchSiblings(previous: OutlineNode[], next: OutlineNode[]): Map<number, number> {
  const oldKeys = previous.map(matchKey);
  const newKeys = next.map(matchKey);
  const pairs: [number, number][] = [];
  let prefix = 0;
  while (prefix < oldKeys.length && prefix < newKeys.length && oldKeys[prefix] === newKeys[prefix]) { pairs.push([prefix, prefix]); prefix++; }
  let suffix = 0;
  while (suffix < oldKeys.length - prefix && suffix < newKeys.length - prefix
    && oldKeys[oldKeys.length - 1 - suffix] === newKeys[newKeys.length - 1 - suffix]) suffix++;
  const oldEnd = oldKeys.length - suffix;
  const newEnd = newKeys.length - suffix;
  const r = oldEnd - prefix;
  const s = newEnd - prefix;
  if (r > 0 && s > 0) {
    if ((r + 1) * (s + 1) <= LCS_CELL_BUDGET) {
      const width = s + 1;
      const table = new Uint32Array((r + 1) * (s + 1));
      for (let m = r - 1; m >= 0; m--) {
        for (let f = s - 1; f >= 0; f--) {
          table[m * width + f] = oldKeys[prefix + m] === newKeys[prefix + f]
            ? table[(m + 1) * width + f + 1] + 1
            : Math.max(table[(m + 1) * width + f], table[m * width + f + 1]);
        }
      }
      let m = 0, f = 0;
      while (m < r && f < s) {
        if (oldKeys[prefix + m] === newKeys[prefix + f]) { pairs.push([prefix + m, prefix + f]); m++; f++; }
        else if (table[(m + 1) * width + f] >= table[m * width + f + 1]) m++;
        else f++;
      }
    } else {
      // Ordered greedy match on equal keys: linear memory, still monotone.
      const queues = new Map<string, number[]>();
      for (let m = prefix; m < oldEnd; m++) {
        const list = queues.get(oldKeys[m]);
        if (list) list.push(m); else queues.set(oldKeys[m], [m]);
      }
      let floor = prefix - 1;
      for (let f = prefix; f < newEnd; f++) {
        const list = queues.get(newKeys[f]);
        while (list && list.length && list[0] <= floor) list.shift();
        if (list && list.length) { const m = list.shift()!; pairs.push([m, f]); floor = m; }
      }
    }
  }
  for (let k = 0; k < suffix; k++) pairs.push([oldEnd + k, newEnd + k]);
  pairs.sort((a, b) => a[1] - b[1]);

  // Pair the unmatched nodes that sit in the same gap between two matches.
  const result: [number, number][] = [...pairs];
  const matchedNew = new Set(pairs.map(([, f]) => f));
  const matchedOld = new Set(pairs.map(([m]) => m));
  let oldStart = 0, newStart = 0;
  for (const [m, f] of [...pairs, [previous.length, next.length] as [number, number]]) {
    const oldGap: number[] = [];
    const newGap: number[] = [];
    for (let k = oldStart; k < m; k++) if (!matchedOld.has(k)) oldGap.push(k);
    for (let k = newStart; k < f; k++) if (!matchedNew.has(k)) newGap.push(k);
    const n = Math.min(oldGap.length, newGap.length);
    for (let k = 0; k < n; k++) result.push([oldGap[k], newGap[k]]);
    oldStart = m + 1;
    newStart = f + 1;
  }
  const map = new Map<number, number>();
  for (const [m, f] of result) map.set(f, m);
  return map;
}

/**
 * Copy identifiers from `previous` to `next` where nodes correspond. The
 * traversal order equals the recursive 1.15 implementation, so freshly
 * numbered nodes receive the same identifiers.
 */
export function matchIds(previous: OutlineNode, next: OutlineNode, used: Set<string>, nextId: () => string): void {
  interface Frame { oldList: OutlineNode[]; newList: OutlineNode[]; map: Map<number, number> | null; index: number }
  const frames: Frame[] = [];
  const open = (oldNode: OutlineNode, newNode: OutlineNode) => {
    if (newNode.children.length) frames.push({ oldList: oldNode.children, newList: newNode.children, map: null, index: 0 });
  };
  open(previous, next);
  while (frames.length) {
    const frame = frames[frames.length - 1];
    if (frame.index >= frame.newList.length) { frames.pop(); continue; }
    if (!frame.oldList.length) {
      for (const node of frame.newList) { node.id = nextId(); used.add(node.id); assignFreshIds(node, used, nextId); }
      frames.pop();
      continue;
    }
    frame.map ??= matchSiblings(frame.oldList, frame.newList);
    const index = frame.index++;
    const node = frame.newList[index];
    const oldIndex = frame.map.get(index);
    if (oldIndex === undefined) {
      node.id = nextId();
      used.add(node.id);
      assignFreshIds(node, used, nextId);
    } else {
      const oldNode = frame.oldList[oldIndex];
      node.id = oldNode.id;
      used.add(node.id);
      open(oldNode, node);
    }
  }
}
