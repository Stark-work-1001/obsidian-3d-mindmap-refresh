import { initSync, GraphPhysicsWasm } from '../crates/graph-physics/pkg/graph_physics.js';

let wasm, engine, spare, ticks = 0, epoch = 0;
self.onmessage = ({ data: m }) => {
  try {
    if (m.type === 'INIT') {
      engine?.free();
      wasm = initSync({ module: m.bytes });
      engine = new GraphPhysicsWasm(m.count, m.edges, m.params);
      engine.set_positions(m.positions);
      engine.set_constraints(m.radii, m.levels, m.fixed);
      ticks = 0;
      self.postMessage({ type: 'READY' });
    } else if (m.type === 'STEP') {
      const start = performance.now();
      const active = engine.step_n(2);
      ticks += 2;
      const view = new Float32Array(wasm.memory.buffer, engine.positions_ptr(), engine.positions_len());
      const buffer = spare?.byteLength === view.byteLength ? spare : new ArrayBuffer(view.byteLength);
      spare = null;
      new Float32Array(buffer).set(view);
      self.postMessage({ type: 'TICK', buffer, epoch, ms: performance.now() - start,
        active: active && !engine.is_converged() && ticks < 600, energy: engine.energy(), ticks }, [buffer]);
    } else if (m.type === 'RETURN') {
      spare = m.buffer;
    } else if (m.type === 'REHEAT') {
      epoch = m.epoch;
      engine.set_params(m.params);
      engine.set_positions(m.positions);
      engine.set_constraints(m.radii, m.levels, m.fixed);
      ticks = 0;
    }
  } catch (e) {
    self.postMessage({ type: 'ERROR', error: String(e?.stack || e) });
  }
};
