// Links written in a node's text or note. They are explicit relationships
// (the author wrote them), unlike spatial nearness. Links to headings of the
// same note are resolved to nodes; links to other notes are kept as linktext
// for Obsidian to resolve relative to the note's path.
import { walkPreorder } from './tree-utils';
import type { OutlineNode, OutlineTree } from './types';

export interface WrittenLink {
  sourceId: string;
  /** Where the link was written. */
  where: 'text' | 'note';
  /** Link target as written (path without the #subpath). Empty for same-note links. */
  path: string;
  /** Heading chain after '#', e.g. ['Chapter', 'Section']; block references excluded. */
  headings: string[];
  display: string;
  raw: string;
}

const WIKI = /!?\[\[([^\]|#]*)((?:#[^\]|]*)?)(?:\|([^\]]*))?\]\]/g;
const MARKDOWN = /\[([^\]]*)\]\((?!https?:|mailto:)([^)#\s]*)(#[^)\s]*)?\)/g;

function splitHeadings(subpath: string): string[] {
  if (!subpath || subpath.startsWith('#^')) return [];
  return subpath.split('#').map(s => s.trim()).filter(Boolean);
}

export function extractLinks(node: OutlineNode): WrittenLink[] {
  const out: WrittenLink[] = [];
  const scan = (text: string | null, where: WrittenLink['where']) => {
    if (!text) return;
    let m: RegExpExecArray | null;
    WIKI.lastIndex = 0;
    while ((m = WIKI.exec(text))) {
      if (m[2]?.startsWith('#^')) continue;
      const path = m[1].trim(), headings = splitHeadings(m[2] ?? '');
      out.push({ sourceId: node.id, where, path, headings, display: (m[3] ?? '').trim() || [path, ...headings].filter(Boolean).join(' \u203A '), raw: m[0] });
    }
    MARKDOWN.lastIndex = 0;
    while ((m = MARKDOWN.exec(text))) {
      const path = decodeURIComponent(m[2] ?? '').replace(/\.md$/i, '').trim();
      out.push({ sourceId: node.id, where, path, headings: splitHeadings(decodeURIComponent(m[3] ?? '')), display: m[1].trim() || path, raw: m[0] });
    }
  };
  scan(node.text, 'text');
  scan(node.note, 'note');
  return out;
}

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Same-note heading target for a link, or null (other note / unknown heading). */
export function resolveSameNote(tree: OutlineTree, link: WrittenLink, fileBasename: string, filePath: string): OutlineNode | null {
  const path = link.path.replace(/\\/g, '/');
  const samePath = !path || path === fileBasename || path === filePath || `${path}.md` === filePath || filePath.endsWith(`/${path}.md`);
  if (!samePath || !link.headings.length) return null;
  const last = normalise(link.headings[link.headings.length - 1]);
  const candidates: OutlineNode[] = [];
  walkPreorder(tree.root, n => { if (n.kind === 'heading' && normalise(n.text) === last) candidates.push(n); });
  if (candidates.length <= 1) return candidates[0] ?? null;
  // Disambiguate with the heading chain ([[#A#B]] = B under A).
  const chain = link.headings.slice(0, -1).map(normalise);
  return candidates.find(c => {
    let p = c.parent, k = chain.length - 1;
    while (p && k >= 0) { if (p.kind === 'heading' && normalise(p.text) === chain[k]) k--; p = p.parent; }
    return k < 0;
  }) ?? candidates[0];
}

export interface ResolvedNoteLinks {
  /** source node id -> links */
  outgoing: Map<string, WrittenLink[]>;
  /** same-note links resolved to node pairs */
  internal: { link: WrittenLink; sourceId: string; targetId: string }[];
  /** target node id -> links pointing at it from this note */
  incoming: Map<string, { link: WrittenLink; sourceId: string }[]>;
}

export function collectNoteLinks(tree: OutlineTree, fileBasename: string, filePath: string): ResolvedNoteLinks {
  const outgoing = new Map<string, WrittenLink[]>();
  const internal: ResolvedNoteLinks['internal'] = [];
  const incoming = new Map<string, { link: WrittenLink; sourceId: string }[]>();
  walkPreorder(tree.root, node => {
    if (node.kind === 'root') return;
    const links = extractLinks(node);
    if (!links.length) return;
    outgoing.set(node.id, links);
    for (const link of links) {
      const target = resolveSameNote(tree, link, fileBasename, filePath);
      if (!target || target.id === node.id) continue;
      internal.push({ link, sourceId: node.id, targetId: target.id });
      const list = incoming.get(target.id);
      if (list) list.push({ link, sourceId: node.id }); else incoming.set(target.id, [{ link, sourceId: node.id }]);
    }
  });
  return { outgoing, internal, incoming };
}
