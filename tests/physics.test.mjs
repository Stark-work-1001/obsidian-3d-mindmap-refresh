import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSync, GraphPhysicsWasm } from '../crates/graph-physics/pkg/graph_physics.js';

const wasm = initSync({ module: fs.readFileSync(new URL('../crates/graph-physics/pkg/graph_physics_bg.wasm', import.meta.url)) });
const params = { repulsion: 14000, attraction: .12, link_distance: 80, gravity: .002,
  damping: .78, max_velocity: 45, dt: .4, theta: .85, alpha_min: .002 };
const positions = engine => new Float32Array(wasm.memory.buffer, engine.positions_ptr(), engine.positions_len());

test('WASM uses stride four and keeps an anchored node fixed while its neighbor moves', () => {
  const engine = new GraphPhysicsWasm(2, new Uint32Array([0, 1]), params);
  try {
    engine.set_positions(new Float32Array([10, 20, 30, 0, 100, 20, 30, 0]));
    engine.set_constraints(new Float32Array([8, 8]), new Float32Array([0, 1]), new Float32Array([10, 20, 30, 1, 0, 0, 0, 0]));
    engine.step_n(20);
    const p = positions(engine);
    assert.equal(engine.positions_stride(), 4); assert.equal(p.length, 8);
    assert.deepEqual([...p.slice(0, 3)], [10, 20, 30]);
    assert.notEqual(p[4], 100); assert.ok([...p].every(Number.isFinite));
  } finally { engine.free(); }
});

test('3000 coincident nodes do not cause unbounded octree subdivision', () => {
  const engine = new GraphPhysicsWasm(3000, new Uint32Array(), params);
  try {
    engine.set_positions(new Float32Array(12000));
    engine.step();
    assert.ok([...positions(engine)].every(Number.isFinite));
  } finally { engine.free(); }
});

test('larger radii create stronger collision separation', () => {
  function distance(radius) {
    const engine = new GraphPhysicsWasm(2, new Uint32Array(), { ...params, repulsion: 0, gravity: 0 });
    try {
      engine.set_positions(new Float32Array([-.5, 0, 0, 0, .5, 0, 0, 0]));
      engine.set_constraints(new Float32Array([radius, radius]), new Float32Array(2), new Float32Array(8));
      engine.step_n(10);
      const p = positions(engine); return Math.abs(p[4] - p[0]);
    } finally { engine.free(); }
  }
  assert.ok(distance(12) > distance(3) * 2);
});

test('changing link distance changes geometry and reheats the simulation', () => {
  const engine = new GraphPhysicsWasm(2, new Uint32Array([0, 1]), { ...params, repulsion: 0, gravity: 0 });
  try {
    engine.set_positions(new Float32Array([-40, 0, 0, 0, 40, 0, 0, 0]));
    engine.step_n(60); const before = positions(engine)[4] - positions(engine)[0];
    engine.set_params({ ...params, repulsion: 0, gravity: 0, link_distance: 200 });
    assert.equal(engine.is_converged(), false);
    engine.step_n(80); const after = positions(engine)[4] - positions(engine)[0];
    assert.ok(after > before * 1.5);
  } finally { engine.free(); }
});

test('empty graphs and dangling edge indices are safe', () => {
  const empty = new GraphPhysicsWasm(0, new Uint32Array(), params);
  const edge = new GraphPhysicsWasm(1, new Uint32Array([0, 200]), params);
  try { assert.equal(empty.step(), false); edge.step(); assert.ok([...positions(edge)].every(Number.isFinite)); }
  finally { empty.free(); edge.free(); }
});
