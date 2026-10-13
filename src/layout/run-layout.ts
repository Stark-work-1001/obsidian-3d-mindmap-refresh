// Runs one deterministic layout: dispatch, centring, user anchors and a
// bounded separation pass. Reports overlap statistics for diagnostics.
import type { LayoutId } from './catalog';
import { applyAnchors, centre, linkLength } from './common';
import { layoutExperimental } from './experimental-layouts';
import { buildHierarchy } from './hierarchy';
import { measureOverlap, packPositions, separate, unpackPositions, type OverlapStats } from './separation';
import { layoutCone, layoutRadial, layoutTree } from './structure-layouts';
import { layoutBookshelf, layoutJourney, layoutKnowledge } from './study-layouts';
import type { ArrangementMemory, LayoutNode, LayoutOptions, Vec3 } from './types';

export interface LayoutRun {
  guide: Vec3[] | null;
  chapters: Map<string, Vec3> | null;
  overlap: OverlapStats;
  separation: { pairs: number; exhausted: number; moved: number };
  ms: number;
}

export function runLayout(kind: LayoutId, nodes: LayoutNode[], options: LayoutOptions, memory?: ArrangementMemory): LayoutRun {
  const t0 = performance.now();
  let result: ReturnType<typeof layoutTree> | void = {};
  switch (kind) {
    case 'knowledge': result = layoutKnowledge(nodes, options, memory); break;
    case 'bookshelf': result = layoutBookshelf(nodes, options); break;
    case 'journey': result = layoutJourney(nodes, options); break;
    case 'tree': result = layoutTree(nodes, options); break;
    case 'radial': result = layoutRadial(nodes, options); break;
    case 'cone': result = layoutCone(nodes, options, memory); break;
    case 'force': break;
    default: result = layoutExperimental(kind, nodes, options);
  }
  for (const n of nodes) if (!Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.z)) { n.x = 0; n.y = 0; n.z = 0; }
  // Centre fresh layouts; with arrangement memory the remembered frame is kept.
  if (!memory && kind !== 'bookshelf' && kind !== 'journey') {
    const shift = centre(nodes);
    for (const c of result?.chapters?.values() ?? []) { c.x += shift.x; c.y += shift.y; c.z += shift.z; }
  }
  const h = buildHierarchy(nodes);
  applyAnchors(nodes, h);
  const pos = packPositions(nodes);
  const radii = Float64Array.from(nodes, n => n.radius);
  const fixed = Uint8Array.from(nodes, n => (n.anchor ? 1 : 0));
  const separation = separate(pos, radii, fixed, nodes.length, {
    clearance: options.clearance, passes: 6, maxPairs: 48, maxShift: linkLength(nodes, options) * 0.35,
  });
  unpackPositions(pos, nodes);
  return {
    guide: result?.guide ?? null, chapters: result?.chapters ?? null,
    overlap: measureOverlap(pos, radii, nodes.length), separation, ms: performance.now() - t0,
  };
}
