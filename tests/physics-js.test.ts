// The JavaScript fallback must satisfy the same invariants as the Rust engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JsPhysicsEngine } from '../src/physics/js-engine';
import { DIAG, STOP_SETTLED, type SimulationParams } from '../src/physics/types';

const params: Partial<SimulationParams> = { repulsion: 14000, attraction: 0.12, link_distance: 80, gravity: 0.002, damping: 0.78, max_velocity: 45, dt: 0.4, theta: 0.85, alpha_min: 0.002 };

test('coincident nodes separate without NaN', () => {
  const e = new JsPhysicsEngine(3000, [], params);
  e.setPositions(new Float32Array(12000));
  for (let i = 0; i < 40; i++) e.step();
  const p = e.positions();
  assert.ok(p.every(Number.isFinite));
  let spread = 0;
  for (let i = 0; i < 3000; i++) spread = Math.max(spread, Math.hypot(p[i * 4], p[i * 4 + 1], p[i * 4 + 2]));
  assert.ok(spread > 10, `spread ${spread}`);
});

test('collision work is bounded per node', () => {
  const e = new JsPhysicsEngine(2000, [], { ...params, max_pairs_per_node: 16 });
  e.setPositions(new Float32Array(8000));
  e.step();
  assert.ok(e.diagnostics()[DIAG.pairsExamined] <= 2000 * 16);
  assert.ok(e.diagnostics()[DIAG.budgetExhausted] > 0);
});

test('each overlapping pair is counted once', () => {
  const e = new JsPhysicsEngine(27, [], { ...params, repulsion: 0, gravity: 0, max_pairs_per_node: 4096 });
  const flat = new Float32Array(27 * 4);
  for (let i = 0; i < 27; i++) { flat[i * 4] = i % 3; flat[i * 4 + 1] = Math.floor(i / 3) % 3; flat[i * 4 + 2] = Math.floor(i / 9); }
  e.setPositions(flat);
  e.step();
  assert.equal(e.diagnostics()[DIAG.overlappingPairs], 351);
  assert.equal(e.diagnostics()[DIAG.pairsExamined], 351);
});

test('large nodes collide with small neighbours', () => {
  const n = 200;
  const e = new JsPhysicsEngine(n, [], { ...params, repulsion: 0, gravity: 0 });
  const radii = new Float32Array(n).fill(4); radii[0] = 60;
  const flat = new Float32Array(n * 4);
  for (let i = 1; i < n; i++) { const a = i * 2.399; flat[i * 4] = 30 * Math.cos(a) + i * 0.3; flat[i * 4 + 1] = 30 * Math.sin(a); flat[i * 4 + 2] = (i % 7) * 3; }
  e.setPositions(flat);
  e.setConstraints(radii, new Float32Array(n), new Float32Array(0));
  for (let i = 0; i < 600; i++) e.step();
  const p = e.positions();
  let closest = Infinity;
  for (let i = 1; i < n; i++) closest = Math.min(closest, Math.hypot(p[i * 4] - p[0], p[i * 4 + 1] - p[1], p[i * 4 + 2] - p[2]));
  assert.ok(closest > 64 * 1.15 * 0.9, `closest ${closest}`);
});

test('fixed nodes stay fixed and invalid input is sanitised', () => {
  const e = new JsPhysicsEngine(3, [0, 1, 1, 7, 2, 2, 1, 0], params);
  assert.equal(e.edgeCount, 1);
  e.setPositions(new Float32Array([10, 20, 30, 0, NaN, 0, 0, 0, 5, 5, 5, 0]));
  e.setConstraints(new Float32Array([8, Infinity, -1]), new Float32Array([0, 1, NaN]), new Float32Array([10, 20, 30, 1, NaN, 0, 0, 1]));
  for (let i = 0; i < 50; i++) e.step();
  const p = e.positions();
  assert.deepEqual([p[0], p[1], p[2]], [10, 20, 30]);
  assert.ok(p.every(Number.isFinite));
});

test('a spring overshoot is not mistaken for convergence', () => {
  const e = new JsPhysicsEngine(2, [0, 1], { ...params, repulsion: 0, gravity: 0, shell_strength: 0, cooling: 0, damping: 0.95 });
  e.setEdges(new Uint32Array([0, 1]), new Float32Array([150]), new Float32Array([1]));
  e.setPositions(new Float32Array([-10, 0, 0, 0, 10, 0, 0, 0]));
  let steps = 0;
  while (e.step() && steps < 20000) steps++;
  assert.equal(e.diagnostics()[DIAG.stopReason], STOP_SETTLED);
  const p = e.positions();
  assert.ok(Math.abs(Math.abs(p[4] - p[0]) - 150) < 2);
});

test('a tree stops in bounded steps with little residual motion and no overlap', () => {
  const n = 300;
  const edges: number[] = [];
  for (let i = 1; i < n; i++) edges.push(Math.floor((i - 1) / 4), i);
  const e = new JsPhysicsEngine(n, edges, params);
  let steps = 0;
  while (e.step() && steps < 5000) steps++;
  assert.ok(e.isConverged());
  assert.ok(steps < 700, `steps ${steps}`);
  assert.ok(e.diagnostics()[DIAG.maxDisplacement] < 0.05);
  assert.ok(e.worstOverlap() < 1);
});

test('3000-node step stays within a practical time budget', () => {
  const n = 3000;
  const edges: number[] = [];
  for (let i = 1; i < n; i++) edges.push(Math.floor((i - 1) / 6), i);
  const e = new JsPhysicsEngine(n, edges, params);
  for (let i = 0; i < 5; i++) e.step();
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) e.step();
  const ms = (performance.now() - t0) / 20;
  assert.ok(ms < 60, `JS step took ${ms.toFixed(1)} ms`);
});
