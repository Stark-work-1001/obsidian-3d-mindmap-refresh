// Physics worker logic, independent of the Worker global so it can be tested
// in Node. The simulation advances on its own clock (`stepsPerSecond`), not on
// render frames: a 240 Hz display and a 60 Hz display settle a layout in the
// same wall-clock time. Work per tick is capped, and catch-up is limited so a
// slow machine falls behind gracefully instead of queueing work.
import { JsPhysicsEngine } from './js-engine';
import { WasmBackend, type WasmEngine } from './wasm-backend';
import type { FromWorker, ToWorker } from './protocol';
import type { PhysicsBackend } from './types';

export interface WasmGlue {
  init(module: WebAssembly.Module): Promise<{ memory: WebAssembly.Memory }>;
  create(count: number, edges: Uint32Array, params: unknown): WasmEngine;
}

export interface WorkerHost {
  post(message: FromWorker, transfer?: Transferable[]): void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface CoreOptions {
  /** Upper bound on steps per tick (limits catch-up after a stall). */
  maxStepsPerTick?: number;
  /** Stop stepping within a tick after this much compute time. */
  tickBudgetMs?: number;
}

export function createWorkerCore(host: WorkerHost, glue: WasmGlue | null, options: CoreOptions = {}) {
  const MAX_STEPS_PER_TICK = options.maxStepsPerTick ?? 6;
  const TICK_BUDGET_MS = options.tickBudgetMs ?? 14;
  let backend: PhysicsBackend | null = null;
  let memory: WebAssembly.Memory | null = null;
  let compiled: WebAssembly.Module | null = null;
  let wasmFailure: string | null = null;
  let generation = 0;
  let stepsPerSecond = 180;
  let running = false;
  let paused = false;
  let active = false;
  let timer: unknown = null;
  let clock = 0;
  let awaitingReturn = false;
  let frameDue = false;
  let spare: ArrayBuffer | null = null;
  let lastComputeMs = 0;
  let measured = { steps: 0, since: 0, rate: 0 };

  const post = (m: FromWorker, t?: Transferable[]) => host.post(m, t);

  async function makeBackend(m: Extract<ToWorker, { type: 'INIT' }>): Promise<{ backend: PhysicsBackend; reason?: string }> {
    if (glue && m.wasm && !wasmFailure) {
      try {
        if (!compiled) {
          compiled = await WebAssembly.compile(m.wasm);
          memory = (await glue.init(compiled)).memory;
        }
        const engine = glue.create(m.count, m.edges, m.params);
        return { backend: new WasmBackend(engine, () => memory!) };
      } catch (error) {
        wasmFailure = error instanceof Error ? error.message : String(error);
      }
    }
    const reason = !glue || !m.wasm ? 'WebAssembly unavailable' : wasmFailure ?? 'WebAssembly unavailable';
    return { backend: new JsPhysicsEngine(m.count, m.edges, m.params), reason };
  }

  function schedule(delay: number): void {
    if (timer !== null || !running || paused) return;
    timer = host.setTimer(() => { timer = null; tick(); }, Math.max(0, delay));
  }

  function stop(): void {
    running = false;
    if (timer !== null) { host.clearTimer(timer); timer = null; }
  }

  function start(): void {
    if (!backend) return;
    if (!running) { running = true; clock = host.now(); measured = { steps: 0, since: clock, rate: measured.rate }; }
    active = true;
    schedule(0);
  }

  function publish(): void {
    if (!backend) return;
    if (awaitingReturn) { frameDue = true; return; }
    const view = backend.positions();
    const buffer = spare && spare.byteLength === view.byteLength ? spare : new ArrayBuffer(view.byteLength);
    spare = null;
    new Float32Array(buffer).set(view);
    awaitingReturn = true;
    frameDue = false;
    post({ type: 'FRAME', generation, buffer, active, diagnostics: Array.from(backend.diagnostics()), computeMs: lastComputeMs, stepsPerSecond: measured.rate }, [buffer]);
  }

  function tick(): void {
    if (!backend || !running || paused) return;
    const now = host.now();
    const interval = 1000 / stepsPerSecond;
    // The epsilon absorbs floating-point drift; the 1 ms floor prevents a
    // zero-delay reschedule loop when `now - clock` is a hair below `interval`.
    let due = Math.floor((now - clock) / interval + 1e-6);
    if (due < 1) { schedule(Math.max(1, interval - (now - clock))); return; }
    if (due > MAX_STEPS_PER_TICK) { due = MAX_STEPS_PER_TICK; clock = now - MAX_STEPS_PER_TICK * interval; }
    let done = 0;
    const t0 = host.now();
    while (done < due) {
      active = backend.stepN(1);
      done++;
      if (!active || host.now() - t0 > TICK_BUDGET_MS) break;
    }
    lastComputeMs = (host.now() - t0) / Math.max(1, done);
    clock += done * interval;
    measured.steps += done;
    if (now - measured.since >= 1000) { measured.rate = (measured.steps * 1000) / (now - measured.since); measured = { steps: 0, since: now, rate: measured.rate }; }
    publish();
    if (!active) { stop(); return; }
    schedule(Math.max(1, clock + interval - host.now()));
  }

  async function handle(m: ToWorker): Promise<void> {
    try {
      switch (m.type) {
        case 'INIT': {
          stop();
          backend?.free();
          backend = null;
          generation = m.generation;
          stepsPerSecond = Math.max(10, Math.min(1000, m.stepsPerSecond || 180));
          const made = await makeBackend(m);
          if (m.generation !== generation) { made.backend.free(); return; }
          backend = made.backend;
          backend.setEdges(m.edges, m.edgeRest, m.edgeStrength);
          backend.setPositions(m.positions);
          backend.setConstraints(m.radii, m.levels, m.fixed);
          if (m.temperature !== undefined && m.temperature < 1) backend.setTemperature(m.temperature);
          post({ type: 'READY', generation, backend: backend.kind, reason: made.reason });
          start();
          return;
        }
        case 'PARAMS': if (m.generation === generation && backend) { backend.setParams(m.params); start(); } return;
        case 'FIXED': if (m.generation === generation && backend) { backend.setFixed(m.index, m.x, m.y, m.z, m.fixed); start(); } return;
        case 'RADII': if (m.generation === generation && backend) { backend.setRadii(m.radii); start(); } return;
        case 'POSITIONS': if (m.generation === generation && backend) { backend.setPositions(m.positions); start(); } return;
        case 'REHEAT': if (m.generation === generation && backend) { backend.reheat(m.energy); start(); } return;
        case 'RETURN':
          spare = m.buffer;
          awaitingReturn = false;
          if (frameDue) publish();
          return;
        case 'PAUSE': paused = true; if (timer !== null) { host.clearTimer(timer); timer = null; } return;
        case 'RESUME': paused = false; if (running) { clock = host.now(); schedule(0); } return;
        case 'DISPOSE': stop(); backend?.free(); backend = null; return;
      }
    } catch (error) {
      post({ type: 'ERROR', generation, message: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) });
    }
  }

  return { handle, get running() { return running; }, get backendKind() { return backend?.kind ?? null; } };
}
