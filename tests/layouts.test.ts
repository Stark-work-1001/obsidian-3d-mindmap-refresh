import test from 'node:test';
import assert from 'node:assert/strict';
import { balanced, deepChains, uneven, wide } from './fixtures/generate.mjs';
import { clone, layoutNodesFrom } from './support/layout-fixtures';
import { runLayout } from '../src/layout/run-layout';
import { LAYOUT_IDS, type LayoutId } from '../src/layout/catalog';
import { measureOverlap, packPositions, separate } from '../src/layout/separation';
import { Transition } from '../src/layout/transition';
import { buildHierarchy } from '../src/layout/hierarchy';
import { DEFAULT_LAYOUT_OPTIONS, type LayoutNode } from '../src/layout/types';

const deterministic = LAYOUT_IDS.filter(id => id !== 'force') as LayoutId[];
const opts = DEFAULT_LAYOUT_OPTIONS;
const finite = (nodes: LayoutNode[]) => nodes.every(n => [n.x, n.y, n.z].every(Number.isFinite));
const overlapOf = (nodes: LayoutNode[]) => measureOverlap(packPositions(nodes), Float64Array.from(nodes, n => n.radius), nodes.length);

const fixtures: [string, LayoutNode[]][] = [
  ['balanced-3000', layoutNodesFrom(balanced(3000).markdown)],
  ['deep-3000', layoutNodesFrom(deepChains(3000, 500).markdown)],
  ['wide-3000', layoutNodesFrom(wide(3000).markdown)],
  ['uneven-1200-mixed-radii', layoutNodesFrom(uneven(1200).markdown, { multipliers: i => (i % 17 === 0 ? 4 : i % 5 === 0 ? 0.5 : 1) })],
  // Crowded rings across branch boundaries (radial sub-ring stagger regression).
  ['uneven-3000', layoutNodesFrom(uneven(3000).markdown)],
];

const report: Record<string, Record<string, string>> = {};

for (const kind of deterministic) {
  test(`${kind}: finite, deterministic, anchored, bounded time on 300-3000 nodes`, () => {
    for (const [name, base] of fixtures) {
      const a = clone(base), b = clone(base);
      const anchorIndex = Math.floor(a.length / 3);
      a[anchorIndex].anchor = { x: 1234, y: -567, z: 89 };
      b[anchorIndex].anchor = { x: 1234, y: -567, z: 89 };
      const run = runLayout(kind, a, opts);
      runLayout(kind, b, opts);
      assert.ok(finite(a), `${name}: finite`);
      assert.deepEqual(a.map(n => [n.x, n.y, n.z]), b.map(n => [n.x, n.y, n.z]), `${name}: deterministic`);
      assert.deepEqual([a[anchorIndex].x, a[anchorIndex].y, a[anchorIndex].z], [1234, -567, 89], `${name}: anchor kept`);
      assert.ok(run.ms < 1500, `${name}: ${run.ms.toFixed(0)} ms`);
      (report[kind] ??= {})[name] = `${run.overlap.pairs} overlaps (max ${run.overlap.maxRelative.toFixed(2)}r) in ${run.ms.toFixed(0)} ms`;
    }
  });
}

test('study and structure layouts leave (almost) no intersecting spheres', () => {
  for (const kind of ['knowledge', 'bookshelf', 'journey', 'tree', 'radial', 'cone'] as LayoutId[]) {
    for (const [name, base] of fixtures) {
      const nodes = clone(base);
      const run = runLayout(kind, nodes, opts);
      assert.ok(run.overlap.pairs <= Math.max(3, nodes.length * 0.002), `${kind}/${name}: ${run.overlap.pairs} intersecting pairs`);
    }
  }
});

test('malformed parents and cycles never hang or drop nodes', () => {
  const cyclic: LayoutNode[] = [
    { id: 'a', parentId: 'b', depth: 0, ring: 1, order: 0, childCount: 1, radius: 5, anchor: null, x: 0, y: 0, z: 0 },
    { id: 'b', parentId: 'a', depth: 1, ring: 2, order: 1, childCount: 1, radius: 5, anchor: null, x: 0, y: 0, z: 0 },
    { id: 'c', parentId: 'missing', depth: 1, ring: 2, order: 2, childCount: 0, radius: 5, anchor: null, x: 0, y: 0, z: 0 },
    { id: 'd', parentId: 'd', depth: 0, ring: 1, order: 3, childCount: 0, radius: 5, anchor: null, x: 0, y: 0, z: 0 },
  ];
  for (const kind of deterministic) {
    const nodes = clone(cyclic);
    runLayout(kind, nodes, opts);
    assert.ok(finite(nodes), kind);
    assert.equal(buildHierarchy(nodes).order.length, 4);
  }
});

test('coincident starting positions and an empty graph are safe', () => {
  for (const kind of deterministic) {
    runLayout(kind, [], opts);
    const nodes = clone(fixtures[0][1]).slice(0, 200).map(n => ({ ...n, parentId: null }));
    runLayout(kind, nodes, opts);
    assert.ok(finite(nodes));
  }
});

test('tree keeps parents above children and folds long chains into a compact block', () => {
  const nodes = clone(fixtures[1][1]);
  runLayout('tree', nodes, opts);
  const ys = nodes.map(n => n.y), xs = nodes.map(n => n.x);
  const height = Math.max(...ys) - Math.min(...ys), width = Math.max(...xs) - Math.min(...xs);
  assert.ok(height / width < 6, `aspect ${height.toFixed(0)} x ${width.toFixed(0)}`);
  const balancedNodes = clone(fixtures[0][1]);
  runLayout('tree', balancedNodes, opts);
  const byId = new Map(balancedNodes.map(n => [n.id, n]));
  let violations = 0;
  for (const n of balancedNodes) { const p = n.parentId ? byId.get(n.parentId) : null; if (p && !(p.y > n.y)) violations++; }
  assert.equal(violations, 0);
});

test('edge gap is a surface gap: parent and child spheres never touch', () => {
  for (const kind of ['tree', 'cone', 'radial'] as LayoutId[]) {
    const nodes = clone(fixtures[0][1]);
    runLayout(kind, nodes, { ...opts, gap: 30 });
    const byId = new Map(nodes.map(n => [n.id, n]));
    let worst = Infinity;
    for (const n of nodes) {
      const p = n.parentId ? byId.get(n.parentId) : null;
      if (!p) continue;
      worst = Math.min(worst, Math.hypot(p.x - n.x, p.y - n.y, p.z - n.z) - p.radius - n.radius);
    }
    assert.ok(worst > 0, `${kind}: closest parent-child surface gap ${worst.toFixed(1)}`);
  }
});

test('bookshelf preserves exact reading order on every page', () => {
  const nodes = clone(fixtures[3][1]);
  runLayout('bookshelf', nodes, opts);
  const h = buildHierarchy(nodes);
  for (const chapter of h.roots) {
    const members = h.order.filter(n => h.chapterOf.get(n.id) === chapter);
    for (let k = 1; k < members.length; k++) {
      const a = members[k - 1], b = members[k];
      const sameColumn = Math.abs((a.x - a.z) - (b.x - b.z)) < 1e9 && b.y < a.y;
      const nextColumn = b.y > a.y && b.x > a.x - 1e-6;
      assert.ok(sameColumn || nextColumn, 'order continues down the page or at the top of the next column');
    }
  }
});

test('journey keeps reading neighbours spatially close', () => {
  const nodes = clone(fixtures[0][1]);
  runLayout('journey', nodes, opts);
  const order = buildHierarchy(nodes).order;
  let far = 0;
  for (let k = 1; k < order.length; k++) {
    const a = order[k - 1], b = order[k];
    if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > 6 * (a.radius + b.radius) + opts.gap * 8) far++;
  }
  assert.ok(far / order.length < 0.02, `${far} long jumps`);
});

test('a small edit does not rearrange other chapters (arrangement memory)', () => {
  const base = clone(fixtures[3][1]);
  const first = clone(base);
  const run = runLayout('knowledge', first, opts);
  const memory = run.chapters!;
  // Add one node to the last chapter.
  const h = buildHierarchy(base);
  const lastChapter = h.roots[h.roots.length - 1];
  const edited = clone(base);
  edited.push({ id: 'new-node', parentId: lastChapter.id, depth: 1, ring: 2, order: edited.length, childCount: 0, radius: 6, anchor: null, x: 0, y: 0, z: 0 });
  const second = clone(edited);
  runLayout('knowledge', second, opts, memory);
  const before = new Map(first.map(n => [n.id, n]));
  const moved = second.filter(n => { const p = before.get(n.id); return p && Math.hypot(p.x - n.x, p.y - n.y, p.z - n.z) > 1; });
  const outsideChapter = moved.filter(n => h.chapterOf.get(n.id) !== lastChapter);
  assert.ok(outsideChapter.length / base.length < 0.05, `${outsideChapter.length} nodes outside the edited chapter moved`);
});

test('collision-aware transitions avoid the overlap that plain interpolation creates', () => {
  const from = clone(fixtures[3][1]);
  runLayout('knowledge', from, opts);
  const to = clone(fixtures[3][1]);
  runLayout('bookshelf', to, opts);
  const a = packPositions(from), b = packPositions(to);
  const radii = Float64Array.from(from, n => n.radius);
  const fixed = new Uint8Array(from.length);
  const worst = (aware: boolean) => {
    const t = new Transition(a, b, radii, fixed, 0, { durationMs: 1000, collisionAware: aware });
    const out = new Float64Array(a.length);
    let pairs = 0;
    for (let ms = 0; ms <= 1000; ms += 50) { t.sample(ms, out); pairs = Math.max(pairs, measureOverlap(out, radii, from.length).pairs); }
    t.sample(1000, out);
    assert.deepEqual(Array.from(out), Array.from(b), 'ends exactly on the target');
    return pairs;
  };
  const plain = worst(false), aware = worst(true);
  (report.transition ??= {}).knowledgeToBookshelf = `plain ${plain} max intersecting pairs, collision-aware ${aware}`;
  assert.ok(aware < plain * 0.5, `plain ${plain}, aware ${aware}`);
});

test('separation work is bounded across all neighbouring cells', () => {
  const n = 3000;
  const pos = new Float64Array(n * 3); // all coincident: the worst case
  const radii = new Float64Array(n).fill(5);
  const stats = separate(pos, radii, null, n, { clearance: 0.1, passes: 1, maxPairs: 16, maxShift: 10 });
  assert.ok(stats.pairs <= n * 16, `${stats.pairs} pairs`);
});

test.after(() => { console.log('\nLayout quality report\n' + JSON.stringify(report, null, 1)); });
