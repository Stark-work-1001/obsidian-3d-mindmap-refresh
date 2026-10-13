// Persistent node identity.
//
// Session ids do not survive edits made while the map is closed, so saved
// data (sizes, key-concept marks, associations, anchors, collapsed state)
// refers to nodes by *path*: the trimmed text of every ancestor from the root
// down, joined by U+001F. A segment gets `#<index>` when a sibling has the same
// text. This is the 1.15-1.17 format, kept byte-for-byte.
//
// Resolution tries the exact path, then the path without duplicate indices,
// then the same two forms with the root (file name) segment ignored, so data
// survives a file rename even if the rename happened while the plugin was off.
import { walkPreorder } from './tree-utils';
import type { OutlineNode, OutlineTree } from './types';

export const PATH_SEPARATOR = '\u001F';
const DUPLICATE_INDEX = /#\d+/g;

export function pathSegment(node: OutlineNode): string {
  const text = node.text.trim();
  const siblings = node.parent?.children;
  if (!siblings || siblings.length < 2) return text;
  for (const sibling of siblings) {
    if (sibling !== node && sibling.text.trim() === text) return `${text}#${siblings.indexOf(node)}`;
  }
  return text;
}

export function nodePath(node: OutlineNode): string {
  const parts: string[] = [];
  for (let n: OutlineNode | null = node; n; n = n.parent) parts.unshift(pathSegment(n));
  return parts.join(PATH_SEPARATOR);
}

export function textPath(node: OutlineNode): string {
  const parts: string[] = [];
  for (let n: OutlineNode | null = node; n; n = n.parent) parts.unshift(n.text.trim());
  return parts.join(PATH_SEPARATOR);
}

export function withoutRoot(path: string): string {
  const index = path.indexOf(PATH_SEPARATOR);
  return index < 0 ? '' : path.slice(index + 1);
}

/** Replace the root segment (used when the note file is renamed). */
export function replaceRoot(path: string, rootText: string): string {
  const index = path.indexOf(PATH_SEPARATOR);
  return index < 0 ? rootText : rootText + path.slice(index);
}

export class PathIndex {
  private readonly exact = new Map<string, OutlineNode>();
  private readonly plain = new Map<string, OutlineNode>();
  private readonly exactNoRoot = new Map<string, OutlineNode>();
  private readonly plainNoRoot = new Map<string, OutlineNode>();
  private readonly pathById = new Map<string, string>();

  constructor(tree: OutlineTree) {
    walkPreorder(tree.root, node => {
      const exact = nodePath(node);
      const plain = textPath(node);
      this.pathById.set(node.id, exact);
      if (!this.exact.has(exact)) this.exact.set(exact, node);
      if (!this.plain.has(plain)) this.plain.set(plain, node);
      if (node.kind !== 'root') {
        const a = withoutRoot(exact), b = withoutRoot(plain);
        if (!this.exactNoRoot.has(a)) this.exactNoRoot.set(a, node);
        if (!this.plainNoRoot.has(b)) this.plainNoRoot.set(b, node);
      }
    });
  }

  pathOf(id: string): string | null { return this.pathById.get(id) ?? null; }

  resolve(path: string): OutlineNode | null {
    const stripped = path.replace(DUPLICATE_INDEX, '');
    const hit = this.exact.get(path) ?? this.plain.get(stripped);
    if (hit) return hit;
    const rest = withoutRoot(path);
    if (!rest) return null;
    return this.exactNoRoot.get(rest) ?? this.plainNoRoot.get(rest.replace(DUPLICATE_INDEX, '')) ?? null;
  }
}

// --- Associations: user-created links between two nodes ---------------------

export interface StoredAssociation {
  aPath: string;
  bPath: string;
  aText: string;
  bText: string;
  createdAt: number;
  hidden?: boolean;
  /** Optional short label describing the relationship (user supplied). */
  label?: string;
}

export function associationKey(a: string, b: string): string {
  return a < b ? `${a}${PATH_SEPARATOR}${b}` : `${b}${PATH_SEPARATOR}${a}`;
}

export type ToggleAssociationResult =
  | { kind: 'self'; links: StoredAssociation[] }
  | { kind: 'removed'; links: StoredAssociation[]; link: StoredAssociation }
  | { kind: 'created'; links: StoredAssociation[]; link: StoredAssociation };

export function toggleAssociation(links: StoredAssociation[], a: OutlineNode, b: OutlineNode, now = Date.now()): ToggleAssociationResult {
  const aPath = nodePath(a), bPath = nodePath(b);
  if (aPath === bPath) return { kind: 'self', links };
  const key = associationKey(aPath, bPath);
  const existing = links.find(l => associationKey(l.aPath, l.bPath) === key);
  if (existing) return { kind: 'removed', links: links.filter(l => l !== existing), link: existing };
  const link: StoredAssociation = { aPath, bPath, aText: a.text.trim().slice(0, 60), bText: b.text.trim().slice(0, 60), createdAt: now };
  return { kind: 'created', links: [...links, link], link };
}

export function resolveAssociations(index: PathIndex, links: StoredAssociation[]):
{ resolved: { link: StoredAssociation; a: OutlineNode; b: OutlineNode }[]; dangling: StoredAssociation[] } {
  const resolved: { link: StoredAssociation; a: OutlineNode; b: OutlineNode }[] = [];
  const dangling: StoredAssociation[] = [];
  for (const link of links) {
    const a = index.resolve(link.aPath), b = index.resolve(link.bPath);
    if (a && b && a !== b) resolved.push({ link, a, b }); else dangling.push(link);
  }
  return { resolved, dangling };
}

// --- Key concepts (manually marked emphasis) --------------------------------

export interface StoredMark {
  path: string;
  text: string;
  createdAt: number;
}

/** Upper bound for stored manual marks per note (data size guard). */
export const MAX_MARKS_PER_NOTE = 1000;

export function toggleMark(marks: StoredMark[], node: OutlineNode, now = Date.now()): { marks: StoredMark[]; added: boolean } {
  const path = nodePath(node);
  if (marks.some(m => m.path === path)) return { marks: marks.filter(m => m.path !== path), added: false };
  const next = [...marks, { path, text: node.text.trim().slice(0, 60), createdAt: now }];
  return { marks: next.length > MAX_MARKS_PER_NOTE ? next.slice(next.length - MAX_MARKS_PER_NOTE) : next, added: true };
}

export function resolveMarks(index: PathIndex, marks: StoredMark[]): { ids: string[]; dangling: StoredMark[] } {
  const ids: string[] = [];
  const dangling: StoredMark[] = [];
  for (const mark of marks) {
    const node = index.resolve(mark.path);
    if (node) ids.push(node.id); else dangling.push(mark);
  }
  return { ids, dangling };
}

/**
 * Keep saved paths attached when nodes are renamed or moved inside the map.
 * `before`/`after` are path maps (id -> path) of two consecutive parses; ids
 * are stable across edits, so a changed path for the same id is a rename.
 */
export function pathRenames(before: Map<string, string>, after: Map<string, string>): Map<string, string> {
  const renames = new Map<string, string>();
  for (const [id, oldPath] of before) {
    const newPath = after.get(id);
    if (newPath && newPath !== oldPath) renames.set(oldPath, newPath);
  }
  return renames;
}

export function pathMap(tree: OutlineTree): Map<string, string> {
  const map = new Map<string, string>();
  walkPreorder(tree.root, node => map.set(node.id, nodePath(node)));
  return map;
}
