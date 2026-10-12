import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import initWasm, { GraphPhysicsWasm } from '../src/physics/generated/graph-physics-glue.js';
import { WASM_BASE64 } from '../src/physics/generated/wasm-asset';
import { createWorkerCore, type WasmGlue, type WorkerHost } from '../src/physics/worker-core';
import { PhysicsClient } from '../src/physics/physics-client';
import { DEFAULT_SIM_PARAMS, DIAG } from '../src/physics/types';
import type { FromWorker, GraphPayload, ToWorker } from '../src/physics/protocol';

// The committed module (src/physics/generated), so tests need no Rust toolchain.
const wasmBytes = () => {
  const bytes = Buffer.from(WASM_BASE64, 'base64');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};
const glue: WasmGlue = {
  init: async module => (await initWasm({ module_or_path: module })) as unknown as { memory: WebAssembly.Memory },
  create: (count, edges, params) => new GraphPhysicsWasm(count, edges, params) as never,
};

/** Deterministic virtual clock and timer queue. */
function fakeHost() {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let id = 0;
  const posted: FromWorker[] = [];
  const host: WorkerHost = {
    post: m => posted.push(m),
    now: () => now,
    setTimer: (fn, ms) => { timers.push({ at: now + ms, fn, id: ++id }); return id; },
    clearTimer: h => { const i = timers.findIndex(t => t.id === h); if (i >= 0) timers.splice(i, 1); },
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      now = Math.max(now, next.at);
      next.fn();
      await Promise.resolve();
    }
    now = end;
  };
  return { host, posted, advance, get now() { return now; } };
}

function treePayload(n: number): GraphPayload {
  const edges: number[] = [];
  for (let i = 1; i < n; i++) edges.push(Math.floor((i - 1) / 4), i);
  const positions = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { positions[i * 4] = Math.cos(i) * i; positions[i * 4 + 1] = Math.sin(i) * i; positions[i * 4 + 2] = (i % 5) * 3; }
  return {
    count: n, edges: Uint32Array.from(edges), edgeRest: new Float32Array(n - 1).fill(60), edgeStrength: new Float32Array(n - 1).fill(1),
    positions, fixed: new Float32Array(n * 4), radii: new Float32Array(n).fill(5), levels: new Float32Array(n),
    params: { ...DEFAULT_SIM_PARAMS, repulsion: 14000, attraction: 0.12, link_distance: 60, gravity: 0.002, damping: 0.78, max_velocity: 45, dt: 0.4, theta: 0.85, alpha_min: 0.002 },
  };
}

const init = (payload: GraphPayload, generation: number, wasm: ArrayBuffer | null, stepsPerSecond = 100): ToWorker =>
  ({ type: 'INIT', generation, wasm, stepsPerSecond, ...payload });

test('worker core uses WASM and advances by wall-clock time, not by message rate', async () => {
  const h = fakeHost();
  const core = createWorkerCore(h.host, glue);
  await core.handle(init(treePayload(200), 1, wasmBytes(), 100));
  const ready = h.posted.find(m => m.type === 'READY') as Extract<FromWorker, { type: 'READY' }>;
  assert.equal(ready.backend, 'wasm');
  // Return every frame immediately; after 500 ms of virtual time ~50 steps must have run.
  for (let k = 0; k < 50; k++) {
    await h.advance(10);
    for (const m of h.posted.splice(0)) if (m.type === 'FRAME') await core.handle({ type: 'RETURN', buffer: m.buffer });
  }
  await core.handle({ type: 'PAUSE' });
  const before = h.now;
  await h.advance(1000);
  assert.equal(h.posted.filter(m => m.type === 'FRAME').length, 0, 'paused worker does not run');
  assert.ok(h.now - before === 1000);
});

test('only one frame is outstanding until the client returns the buffer', async () => {
  const h = fakeHost();
  const core = createWorkerCore(h.host, glue);
  await core.handle(init(treePayload(300), 1, wasmBytes(), 200));
  await h.advance(500);
  const frames = h.posted.filter(m => m.type === 'FRAME') as Extract<FromWorker, { type: 'FRAME' }>[];
  assert.equal(frames.length, 1, 'no queue builds up without RETURN');
  await core.handle({ type: 'RETURN', buffer: frames[0].buffer });
  const after = h.posted.filter(m => m.type === 'FRAME');
  assert.equal(after.length, 2, 'the newest frame is sent as soon as the buffer is back');
  const latest = after[1] as Extract<FromWorker, { type: 'FRAME' }>;
  assert.ok(latest.diagnostics[DIAG.steps] > 5, `steps ${latest.diagnostics[DIAG.steps]}`);
});

test('steps per second is independent of how often frames are consumed', async () => {
  const run = async (consumeEveryMs: number) => {
    const h = fakeHost();
    const core = createWorkerCore(h.host, glue);
    await core.handle(init(treePayload(100), 1, wasmBytes(), 120));
    let last: Extract<FromWorker, { type: 'FRAME' }> | null = null;
    for (let t = 0; t < 1000; t += consumeEveryMs) {
      await h.advance(consumeEveryMs);
      for (const m of h.posted.splice(0)) if (m.type === 'FRAME') { last = m; await core.handle({ type: 'RETURN', buffer: m.buffer }); }
    }
    return last!.diagnostics[DIAG.steps];
  };
  const fast = await run(4), slow = await run(33);
  assert.ok(Math.abs(fast - slow) <= 8, `steps after 1 s: ${fast} (240 Hz consumer) vs ${slow} (30 Hz consumer)`);
  assert.ok(fast >= 100 && fast <= 125, `steps ${fast}`);
});

test('invalid WASM falls back to the JavaScript engine with a reason', async () => {
  const h = fakeHost();
  const core = createWorkerCore(h.host, glue);
  await core.handle(init(treePayload(50), 1, new Uint8Array([0, 1, 2, 3]).buffer, 100));
  const ready = h.posted.find(m => m.type === 'READY') as Extract<FromWorker, { type: 'READY' }>;
  assert.equal(ready.backend, 'js');
  assert.ok(ready.reason && ready.reason.length > 0);
  await h.advance(100);
  assert.ok(h.posted.some(m => m.type === 'FRAME'));
});

test('a run ends with a final inactive frame', async () => {
  const h = fakeHost();
  const core = createWorkerCore(h.host, glue);
  await core.handle(init(treePayload(60), 1, wasmBytes(), 500));
  let final: Extract<FromWorker, { type: 'FRAME' }> | null = null;
  for (let t = 0; t < 20000 && !final; t += 20) {
    await h.advance(20);
    for (const m of h.posted.splice(0)) if (m.type === 'FRAME') { if (!m.active) final = m; await core.handle({ type: 'RETURN', buffer: m.buffer }); }
  }
  assert.ok(final, 'simulation stopped');
  assert.ok(final!.diagnostics[DIAG.stopReason] > 0);
  assert.equal(core.running, false);
});

test('client runs on the main thread when no worker is available', async t => {
  const client = new PhysicsClient({ workerSource: null, wasm: () => null, forceMainThread: true, stepsPerSecond: 300 });
  t.after(() => client.dispose());
  const p = treePayload(80);
  client.start(p);
  client.start({ ...p, positions: p.positions.map(v => v + 1000) });
  const out = new Float32Array(80 * 4);
  const deadline = Date.now() + 3000;
  while (!client.sample(performance.now(), out) && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
  assert.equal(client.backend, 'js');
  assert.ok(out[0] > 500, 'samples come from the newest generation only');
});

test('client ignores stale frames, returns their buffers and blends linearly from what is shown', () => {
  const sent: ToWorker[] = [];
  const client = new PhysicsClient({ workerSource: null, wasm: () => null, forceMainThread: true });
  const p = treePayload(2);
  p.positions.set([0, 0, 0, 0, 10, 0, 0, 0]);
  client.start(p);
  (client as any).channel = { send: (m: ToWorker) => sent.push(m), dispose() {} };
  const frame = (generation: number, x0: number) => {
    const buffer = new Float32Array([x0, 0, 0, 0, 10, 0, 0, 0]).buffer;
    (client as any).receive({ type: 'FRAME', generation, buffer, active: true, diagnostics: new Array(11).fill(0), computeMs: 1, stepsPerSecond: 100 });
    return buffer;
  };
  const stale = frame(client.generation - 1, 999);
  assert.equal(client.framesDropped, 1);
  assert.ok(sent.some(m => m.type === 'RETURN' && m.buffer === stale), 'stale buffer handed back');
  frame(client.generation, 100);
  const out = new Float32Array(8);
  const start = (client as any).blendStart as number;
  const ms = (client as any).blendMs as number;
  client.sample(start, out);
  assert.equal(out[0], 0, 'blend starts at the shown position');
  client.sample(start + ms / 2, out);
  assert.ok(Math.abs(out[0] - 50) < 1e-4, `midpoint ${out[0]}`);
  client.sample(start + ms * 3, out);
  assert.equal(out[0], 100, 'blend ends at the frame and does not overshoot');
  // A new frame mid-blend continues from the displayed value (no jump back).
  client.sample(start + ms / 2, out);
  frame(client.generation, 200);
  client.sample((client as any).blendStart, out);
  assert.ok(Math.abs(out[0] - 50) < 1e-4, `continues from ${out[0]}`);
});