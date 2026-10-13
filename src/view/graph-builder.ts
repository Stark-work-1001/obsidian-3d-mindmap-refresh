// Pure transformation: outline + settings + saved per-note data -> the
// index-aligned arrays that the layout engine and renderer consume.
import { t } from '../i18n';
import { effectiveRadius } from '../layout/radius';
import type { EngineEdge, EngineNode } from '../layout/layout-engine';
import { collectNoteLinks, type ResolvedNoteLinks, type WrittenLink } from '../model/note-links';
import { nodePath, PathIndex, resolveAssociations, resolveMarks, type StoredAssociation, type StoredMark } from '../model/node-paths';
import { groupColor, hiddenByRules, scanRules, type RuleScan } from '../model/rules';
import { descendantCount, visibleNodes } from '../model/tree-utils';
import type { OutlineNode, OutlineTree } from '../model/types';
import type { Settings } from '../persistence/settings';
import { nodeColor, parseHex } from '../render/colors';
import { labelHtml, plainText, type FormulaCache } from '../render/label-format';
import type { LabelEntry } from '../render/labels';

export interface GraphInput {
  tree: OutlineTree;
  filePath: string;
  fileBasename: string;
  settings: Settings;
  sizes: Record<string, number>;
  marks: StoredMark[];
  associations: StoredAssociation[];
  anchors: Record<string, [number, number, number]>;
  formulas: FormulaCache | null;
}

export interface BuiltGraph {
  visible: OutlineNode[];
  ids: string[];
  index: Map<string, number>;
  paths: string[];
  pathIndex: PathIndex;
  engineNodes: EngineNode[];
  physicsEdges: EngineEdge[];
  hierarchy: [number, number][];
  documentOrder: [number, number][];
  associations: { link: StoredAssociation; a: number; b: number }[];
  danglingAssociations: StoredAssociation[];
  hiddenAssociations: number;
  collapsedAssociations: number;
  noteLinks: { a: number; b: number; link: WrittenLink }[];
  noteLinkInfo: ResolvedNoteLinks;
  markIds: Set<string>;
  manualMarkIds: Set<string>;
  danglingMarks: StoredMark[];
  ruleScan: RuleScan;
  colors: number[];
  labels: LabelEntry[];
  multipliers: Float32Array;
  hasOverride: Uint8Array;
  anchored: Uint8Array;
  depth: Int32Array;
}

function labelFor(node: OutlineNode, text: string, formulas: FormulaCache | null, marked: boolean, anchored: boolean): string {
  const task = node.taskMarker === null ? '' : `<span class="om3d-task${node.taskMarker.trim() ? ' is-done' : ''}" aria-hidden="true"></span>`;
  const body = node.kind === 'root' ? labelHtml(text, null) : labelHtml(text, formulas);
  const mark = marked ? `<span class="om3d-badge-mark" title="${t('label.keyConcept')}"></span>` : '';
  const pin = anchored ? `<span class="om3d-badge-pin" title="${t('label.pinnedPosition')}"></span>` : '';
  const note = node.note ? `<span class="om3d-note-dot" title="${t('label.hasNote')}"></span>` : '';
  const collapsed = node.collapsed && node.children.length ? `<span class="om3d-badge">+${descendantCount(node)}</span>` : '';
  return `${task}<span class="om3d-label-text">${body}</span>${mark}${pin}${note}${collapsed}`;
}

export function buildGraph(input: GraphInput): BuiltGraph {
  const { tree, settings } = input;
  const hidden = hiddenByRules(tree.root, settings.groupRules);
  const titlePlate = settings.rootAsTitlePlate !== false;
  const visible = visibleNodes(tree.root).filter(n => !hidden.has(n.id) && !(titlePlate && n.kind === 'root'));
  const ids = visible.map(n => n.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const pathIndex = new PathIndex(tree);
  const paths = visible.map(n => pathIndex.pathOf(n.id) ?? nodePath(n));
  const depthOffset = titlePlate ? 1 : 0;
  const ruleScan = scanRules(tree.root, settings.pinRules);
  const manual = resolveMarks(pathIndex, input.marks);
  const manualMarkIds = new Set(manual.ids);
  const markIds = new Set([...manual.ids, ...ruleScan.ids]);
  const multipliers = new Float32Array(visible.length);
  const hasOverride = new Uint8Array(visible.length);
  const anchored = new Uint8Array(visible.length);
  const depth = new Int32Array(visible.length);

  const engineNodes: EngineNode[] = visible.map((n, i) => {
    const multiplier = input.sizes[paths[i]];
    hasOverride[i] = typeof multiplier === 'number' ? 1 : 0;
    multipliers[i] = typeof multiplier === 'number' && multiplier > 0 ? multiplier : 1;
    const anchor = input.anchors[paths[i]];
    anchored[i] = anchor ? 1 : 0;
    depth[i] = Math.max(0, n.depth - depthOffset);
    return {
      id: n.id, parentId: n.parent && index.has(n.parent.id) ? n.parent.id : null, depth: depth[i], ring: n.ring, order: i,
      childCount: n.children.length,
      radius: effectiveRadius({ ring: n.ring, hasNote: !!n.note, hasFormula: n.formulas.length > 0, childCount: n.children.length }, settings.nodeScale, multipliers[i], settings.sizeByHierarchy),
      anchor: anchor ? { x: anchor[0], y: anchor[1], z: anchor[2] } : null,
    };
  });

  const hierarchy: [number, number][] = [];
  const physicsEdges: EngineEdge[] = [];
  visible.forEach((n, i) => {
    if (n.parent && index.has(n.parent.id)) {
      hierarchy.push([index.get(n.parent.id)!, i]);
      physicsEdges.push({ source: n.parent.id, target: n.id, kind: 'hierarchy' });
    }
  });

  // Top-level headings in document order, joined into a chain (a ring for 3+).
  const documentOrder: [number, number][] = [];
  if (settings.linkLevel1 !== false) {
    const tops = visible.map((n, i) => ({ n, i })).filter(({ n }) => n.kind === 'heading' && n.headingLevel === 1).map(({ i }) => i);
    for (let k = 0; k + 1 < tops.length; k++) documentOrder.push([tops[k], tops[k + 1]]);
    if (tops.length >= 3) documentOrder.push([tops[tops.length - 1], tops[0]]);
    for (const [a, b] of documentOrder) physicsEdges.push({ source: ids[a], target: ids[b], kind: 'documentOrder' });
  }

  const shownAssociations = input.associations.filter(l => !l.hidden);
  const resolved = resolveAssociations(pathIndex, shownAssociations);
  const associations: BuiltGraph['associations'] = [];
  let collapsedAssociations = 0;
  for (const r of resolved.resolved) {
    const a = index.get(r.a.id), b = index.get(r.b.id);
    if (a === undefined || b === undefined) { collapsedAssociations++; continue; }
    associations.push({ link: r.link, a, b });
    physicsEdges.push({ source: ids[a], target: ids[b], kind: 'association' });
  }

  const noteLinkInfo = collectNoteLinks(tree, input.fileBasename, input.filePath);
  const noteLinks: BuiltGraph['noteLinks'] = [];
  for (const l of noteLinkInfo.internal) {
    const a = index.get(l.sourceId), b = index.get(l.targetId);
    if (a === undefined || b === undefined) continue;
    noteLinks.push({ a, b, link: l.link });
    physicsEdges.push({ source: ids[a], target: ids[b], kind: 'noteLink' });
  }

  const colors = visible.map(n => {
    const group = groupColor(n, settings.groupRules);
    const base = nodeColor(n.ring, n.text, settings.nodeColorMode, settings.nodeColor);
    return group ? parseHex(group, base) : base;
  });
  const labels: LabelEntry[] = visible.map((n, i) => {
    const text = n.kind === 'root' ? tree.coreName : n.text;
    return { html: labelFor(n, text, input.formulas, markIds.has(n.id), !!anchored[i]), text: plainText(text) || t(n.kind === 'heading' ? 'model.emptyHeading' : 'model.emptyItem'), kind: n.kind };
  });

  return {
    visible, ids, index, paths, pathIndex, engineNodes, physicsEdges, hierarchy, documentOrder, associations,
    danglingAssociations: resolved.dangling, hiddenAssociations: input.associations.length - shownAssociations.length,
    collapsedAssociations, noteLinks, noteLinkInfo, markIds, manualMarkIds, danglingMarks: manual.dangling, ruleScan, colors, labels,
    multipliers, hasOverride, anchored, depth,
  };
}
