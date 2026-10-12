import test from 'node:test';
import assert from 'node:assert/strict';
import { LEARNING_LAYOUTS, placeLearning, placeTidyTree, placeWeightedRadial, separateNodes } from '../src/learning-layouts.js';

function fixture(count = 3000) {
  return Array.from({ length: count }, (_, i) => ({ id: `n${i}`, parentId: i % 150 === 0 ? null : `n${Math.floor(i / 150) * 150}`,
    depth: i % 150 === 0 ? 1 : 2, radius: 5, x: 0, y: 0, z: 0 }));
}
const finite = nodes => nodes.every(n => [n.x,n.y,n.z].every(Number.isFinite));

for (const layout of LEARNING_LAYOUTS) test(`${layout.name}: deterministic, finite, separated 3000-node coordinates`, () => {
  const a = fixture(), b = fixture();
  placeLearning(layout.id, a, { linkDistance: 62 }); placeLearning(layout.id, b, { linkDistance: 62 });
  assert.ok(finite(a));
  assert.deepEqual(a.map(n => [n.x,n.y,n.z]), b.map(n => [n.x,n.y,n.z]));
  assert.equal(new Set(a.map(n => `${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)}`)).size, 3000);
  const scaled = fixture(); placeLearning(layout.id, scaled, { linkDistance: 124 });
  assert.ok(Math.abs(scaled[20].x) > Math.abs(a[20].x) * 1.5);
});

test('all learning layouts preserve fixed coordinates', () => {
  for (const item of LEARNING_LAYOUTS) {
    const nodes = fixture(300); nodes[15].anchor = { x: 123, y: -40, z: 90 };
    placeLearning(item.id, nodes, { linkDistance: 62 }); separateNodes(nodes);
    assert.deepEqual([nodes[15].x,nodes[15].y,nodes[15].z], [123,-40,90]);
  }
});

test('tidy tree places parent above its descendants and radial layout respects hierarchy', () => {
  const nodes = fixture(300); placeTidyTree(nodes);
  assert.ok(finite(nodes)); assert.ok(nodes[0].y > nodes[1].y);
  placeWeightedRadial(nodes); assert.ok(finite(nodes));
  assert.ok(nodes[0].y > nodes[1].y);
});

test('3000-deep chains and malformed cycles do not recurse or hang', () => {
  const chain = Array.from({ length: 3000 }, (_, i) => ({ id: `n${i}`, parentId: i ? `n${i-1}` : null, radius: 4 }));
  for (const item of LEARNING_LAYOUTS) { placeLearning(item.id, chain); assert.ok(finite(chain)); }
  placeTidyTree(chain); assert.ok(finite(chain));
  const cyclic = [{ id:'a',parentId:'b',radius:5 },{id:'b',parentId:'a',radius:5}];
  for (const item of LEARNING_LAYOUTS) { placeLearning(item.id, cyclic); assert.ok(finite(cyclic)); }
});

test('local separation spreads colliding spheres without moving anchors', () => {
  const nodes = [{ id:'a',x:0,y:0,z:0,radius:8,anchor:{x:0,y:0,z:0} },{id:'b',x:0,y:0,z:0,radius:8}];
  separateNodes(nodes, { linkDistance:60 }, 10);
  assert.ok(Math.hypot(nodes[1].x,nodes[1].y,nodes[1].z) > 8);
  assert.deepEqual([nodes[0].x,nodes[0].y,nodes[0].z], [0,0,0]);
});
