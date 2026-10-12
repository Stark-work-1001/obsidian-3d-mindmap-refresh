// Collects what the inspector shows about one node. Every relationship keeps
// its provenance: associations come from the plugin's data (created by the
// user in the map), note links from text the author wrote. Nothing is
// inferred from where nodes happen to sit in a layout.
import { t } from '../i18n';
import { resolveSameNote } from '../model/note-links';
import { firstMatch } from '../model/rules';
import { ancestorsOf, descendantCount, displayText, findNode } from '../model/tree-utils';
import type { StoredAssociation } from '../model/node-paths';
import type { OutlineNode, OutlineTree } from '../model/types';
import type { Settings } from '../persistence/settings';
import type { InspectorData } from '../ui/inspector';
import type { BuiltGraph } from './graph-builder';

export interface InspectorContext {
  tree: OutlineTree;
  graph: BuiltGraph;
  settings: Settings;
  filePath: string;
  fileBasename: string;
  /** All stored associations of the note, including hidden ones. */
  associations: StoredAssociation[];
  sizes: Record<string, number>;
  /** Vault path a link resolves to, or null when it does not resolve. */
  resolveLink(linktext: string): string | null;
}

export function kindLabel(node: OutlineNode): string {
  if (node.kind === 'root') return t('inspector.kind.root');
  if (node.kind === 'heading') return t('inspector.kind.heading', { level: node.headingLevel });
  if (node.taskMarker !== null) return node.taskMarker.trim() ? t('inspector.kind.taskDone') : t('inspector.kind.task');
  return t('inspector.kind.item');
}

export function nodeLabel(node: OutlineNode, tree: OutlineTree): string {
  if (node.kind === 'root') return tree.coreName;
  return displayText(node, 80) || t(node.kind === 'heading' ? 'model.emptyHeading' : 'model.emptyItem');
}

export function inspectorData(node: OutlineNode, c: InspectorContext): InspectorData {
  const { tree, graph } = c;
  const path = graph.pathIndex.pathOf(node.id) ?? '';
  const index = graph.index.get(node.id);
  const manual = graph.manualMarkIds.has(node.id);
  const rule = !manual ? firstMatch(node, c.settings.pinRules) : null;

  const associations: InspectorData['associations'] = [];
  for (const link of c.associations) {
    const other = link.aPath === path ? link.bPath : link.bPath === path ? link.aPath : null;
    if (other === null) continue;
    const target = graph.pathIndex.resolve(other);
    associations.push({ link, otherId: target?.id ?? null, otherLabel: target ? nodeLabel(target, tree) : (link.aPath === path ? link.bText : link.aText) });
  }

  const outgoing: InspectorData['outgoing'] = (graph.noteLinkInfo.outgoing.get(node.id) ?? []).map(link => {
    const same = resolveSameNote(tree, link, c.fileBasename, c.filePath);
    if (same) return { display: link.display, where: link.where, target: { kind: 'node' as const, id: same.id, label: nodeLabel(same, tree) } };
    const linktext = link.path + (link.headings.length ? `#${link.headings.join('#')}` : '');
    return { display: link.display, where: link.where, target: { kind: 'document' as const, linktext, resolved: link.path ? c.resolveLink(link.path) : null } };
  });

  const incoming: InspectorData['incoming'] = (graph.noteLinkInfo.incoming.get(node.id) ?? []).map(({ link, sourceId }) => {
    const source = findNode(tree.root, sourceId);
    const label = source ? nodeLabel(source, tree) : sourceId;
    return { sourceId, sourceLabel: label, display: link.display, where: link.where };
  });

  return {
    id: node.id,
    isRoot: node.kind === 'root',
    text: node.text,
    title: nodeLabel(node, tree),
    kindLabel: kindLabel(node),
    ancestors: ancestorsOf(node).reverse().filter(a => a.kind !== 'root' || !c.settings.rootAsTitlePlate).map(a => ({ id: a.id, label: nodeLabel(a, tree) })),
    childCount: node.children.length,
    descendantCount: descendantCount(node),
    note: node.note,
    marked: graph.markIds.has(node.id),
    markedByRule: rule ? rule.pattern : null,
    anchored: index !== undefined ? !!graph.anchored[index] : false,
    sizeMultiplier: c.sizes[path] ?? 1,
    hasOverride: typeof c.sizes[path] === 'number',
    associations,
    outgoing,
    incoming,
  };
}
