// Comparison with the 1.17 study layouts on identical input. Prints a table;
// run with: node scripts/test.mjs layout-report
import test from 'node:test';
import { balanced, deepChains, uneven, wide } from './fixtures/generate.mjs';
import { clone, layoutNodesFrom } from './support/layout-fixtures';
import { runLayout } from '../src/layout/run-layout';
import { measureOverlap, packPositions } from '../src/layout/separation';
import { DEFAULT_LAYOUT_OPTIONS, type LayoutNode } from '../src/layout/types';
// @ts-expect-error plain JavaScript reference implementation without types
import * as old from '../reference/learning-layouts-1.17.0.js';

test('layout comparison report (1.17 vs 2.0)', () => {
  const fx: [string, LayoutNode[]][] = [
    ['balanced-3000', layoutNodesFrom(balanced(3000).markdown)], ['deep-3000', layoutNodesFrom(deepChains(3000, 500).markdown)],
    ['wide-3000', layoutNodesFrom(wide(3000).markdown)], ['uneven-1200-mixed', layoutNodesFrom(uneven(1200).markdown, { multipliers: i => (i % 17 === 0 ? 4 : i % 5 === 0 ? 0.5 : 1) })],
  ];
  const overlap = (n: LayoutNode[]) => measureOverlap(packPositions(n), Float64Array.from(n, x => x.radius), n.length).pairs;
  const extent = (n: LayoutNode[]) => ['x', 'y', 'z'].map(k => { const v = n.map(a => (a as any)[k] as number); return (Math.max(...v) - Math.min(...v)).toFixed(0); }).join(' x ');
  const rows = ['| layout | fixture | 1.17 intersecting | 2.0 intersecting | 1.17 extent | 2.0 extent |', '|---|---|---|---|---|---|'];
  const runs: [string, (n: any[]) => void][] = [
    ['knowledge', n => old.placeLearning('knowledge', n, { linkDistance: 62 })], ['bookshelf', n => old.placeLearning('bookshelf', n, { linkDistance: 62 })],
    ['journey', n => old.placeLearning('journey', n, { linkDistance: 62 })], ['tree', n => old.placeTidyTree(n, { linkDistance: 62 })], ['radial', n => old.placeWeightedRadial(n, { linkDistance: 62 })],
  ];
  for (const [kind, oldRun] of runs) for (const [name, base] of fx) {
    const a = clone(base).map(n => ({ ...n, depth: n.ring }));
    oldRun(a); old.separateNodes(a, { linkDistance: 62 });
    const b = clone(base); runLayout(kind as never, b, DEFAULT_LAYOUT_OPTIONS);
    rows.push(`| ${kind} | ${name} | ${overlap(a)} | ${overlap(b)} | ${extent(a)} | ${extent(b)} |`);
  }
  console.log(rows.join('\n'));
});
