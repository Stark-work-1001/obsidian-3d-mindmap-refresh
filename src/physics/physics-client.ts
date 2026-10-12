// Main-thread side of the layout physics.
//
// - Starts the worker from bundled source (Blob URL). If that is impossible
//   (no Worker, CSP) or the worker fails, the same core runs on the main
//   thread with the JavaScript engine and a 4 ms budget per tick.
// - Every state change bumps the generation; frames of older generations
//   are dropped and their buffers returned immediately.
// - Rendering samples positions with `sample(now, out)`: the client blends
//   from what was last shown to the newest frame over the measured frame
//   interval, so motion is smooth at any display refresh rate and never jumps.
import { createWorkerCore } from './worker-core';
import { decodeDiagnostics, type PhysicsDiagnostics, type SimulationParams } from './types';
import type { FromWorker, GraphPayload, ToWorker } from './protocol';

export interface PhysicsClientOptions {
  workerSource: string | null;
  wasm: () => ArrayBuffer | null;
  stepsPerSecond?: number;
  /** Called when a new frame arrives (request a render). */
  onFrame?: () => void;
  onStatus?: (diagnostics: PhysicsDiagnostics) => void;
  /** Testing / diagnostics: skip the worker. */
  forceMainThread?: boolean;
  initTimeoutMs?: number;
}

interface Channel {
  send(message: ToWorker, transfer?: Transferable[]): void;
  dispose(): void;
}

export class PhysicsClient {
  generation = 0;
  active = false;
  backend: 'wasm' | 'js' | 'none' = 'none';
  fallbackReason: string | undefined;
  diagnostics: PhysicsDiagnostics = decodeDiagnostics(new Array(11).fill(0), 'none');
  private channel: Channel | null = null;
  private mainThread = false;
  private payload: GraphPayload | null = null;
  private from = new Float32Array(0);
  private to = new Float32Array(0);
  private shown = new Float32Array(0);
  private blendStart = 0;
  private blendMs = 16;
  private lastFrameAt = 0;
  private haveFrame = false;
  private initTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  framesReceived = 0;
  framesDropped = 0;

  constructor(private readonly options: PhysicsClientOptions) {}

  private openChannel(): Channel {
    if (!this.mainThread && !this.options.forceMainThread && this.options.workerSource && typeof Worker !== 'undefined') {
      try {
        const url = URL.createObjectURL(new Blob([this.options.workerSource], { type: 'text/javascript' }));
        const worker = new Worker(url);
        URL.revokeObjectURL(url);
        worker.onmessage = (event: MessageEvent<FromWorker>) => this.receive(event.data);
        worker.onerror = event => { event.preventDefault?.(); this.failover(`worker error: ${event.message ?? 'unknown'}`); };
        return { send: (m, t) => worker.postMessage(m, t ?? []), dispose: () => worker.terminate() };
      } catch (error) {
        this.fallbackReason = `worker unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    this.mainThread = true;
    const core = createWorkerCore({
      post: message => queueMicrotask(() => this.receive(message)),
      now: () => performance.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }, null, { tickBudgetMs: 4, maxStepsPerTick: 3 });
    let queue = Promise.resolve();
    return { send: m => { queue = queue.then(() => core.handle(m)); }, dispose: () => { void core.handle({ type: 'DISPOSE' }); } };
  }

  private failover(reason: string): void {
    if (this.disposed || this.mainThread) return;
    console.warn('[3D Mind Map] physics worker failed, continuing on the main thread:', reason);
    this.fallbackReason = reason;
    this.channel?.dispose();
    this.channel = null;
    this.mainThread = true;
    if (this.payload) {
      // Continue from what is on screen rather than from the initial layout.
      const resume = { ...this.payload, positions: this.haveFrame ? this.shown.slice() : this.payload.positions };
      this.start(resume);
    }
  }

  start(payload: GraphPayload, temperature = 1): void {
    if (this.disposed) return;
    this.payload = payload;
    this.generation++;
    const n = payload.count;
    this.from = new Float32Array(n * 4);
    this.to = new Float32Array(n * 4);
    this.shown = new Float32Array(n * 4);
    this.from.set(payload.positions.subarray(0, n * 4));
    this.to.set(this.from);
    this.shown.set(this.from);
    this.haveFrame = false;
    this.active = true;
    this.channel ??= this.openChannel();
    const wasm = this.mainThread ? null : this.options.wasm();
    const copy = <T extends Float32Array | Uint32Array>(a: T) => a.slice() as T;
    const message: ToWorker = {
      type: 'INIT', generation: this.generation, wasm, stepsPerSecond: this.options.stepsPerSecond ?? 180, temperature, count: n,
      edges: copy(payload.edges), edgeRest: copy(payload.edgeRest), edgeStrength: copy(payload.edgeStrength),
      positions: copy(payload.positions), fixed: copy(payload.fixed), radii: copy(payload.radii), levels: copy(payload.levels),
      params: payload.params,
    };
    const transfer: Transferable[] = [message.edges.buffer, message.edgeRest.buffer, message.edgeStrength.buffer,
      message.positions.buffer, message.fixed.buffer, message.radii.buffer, message.levels.buffer];
    if (wasm) transfer.push(wasm);
    this.channel.send(message, this.mainThread ? [] : transfer);
    if (!this.mainThread) {
      if (this.initTimer) clearTimeout(this.initTimer);
      const generation = this.generation;
      this.initTimer = setTimeout(() => { if (this.backend === 'none' && generation === this.generation) this.failover('worker did not start in time'); }, this.options.initTimeoutMs ?? 10000);
    }
  }

  private receive(message: FromWorker): void {
    if (this.disposed) return;
    if (message.type === 'READY') {
      if (message.generation !== this.generation) return;
      if (this.initTimer) { clearTimeout(this.initTimer); this.initTimer = null; }
      this.backend = message.backend;
      if (message.reason) this.fallbackReason = message.reason;
      return;
    }
    if (message.type === 'ERROR') {
      console.error('[3D Mind Map] physics error:', message.message);
      if (message.generation === this.generation) this.failover(message.message.split('\n')[0]);
      return;
    }
    // FRAME: always hand the buffer back so the worker can send the next one.
    const stale = message.generation !== this.generation;
    if (!stale) {
      const incoming = new Float32Array(message.buffer);
      if (incoming.length === this.to.length) {
        const now = performance.now();
        if (this.lastFrameAt) this.blendMs = Math.min(60, Math.max(8, now - this.lastFrameAt));
        this.lastFrameAt = now;
        this.from.set(this.shown);
        this.to.set(incoming);
        this.blendStart = now;
        this.haveFrame = true;
        this.framesReceived++;
      }
      this.active = message.active;
      this.diagnostics = { ...decodeDiagnostics(message.diagnostics, this.backend, message.computeMs, message.stepsPerSecond), fallbackReason: this.fallbackReason };
      this.options.onStatus?.(this.diagnostics);
    } else this.framesDropped++;
    this.channel?.send({ type: 'RETURN', buffer: message.buffer }, this.mainThread ? [] : [message.buffer]);
    if (!stale) this.options.onFrame?.();
  }

  /** True while blending towards the newest frame or while the simulation runs. */
  get moving(): boolean {
    return this.active || (this.haveFrame && performance.now() - this.blendStart < this.blendMs);
  }

  /** Write interpolated stride-4 positions into `out`. Returns false before the first frame. */
  sample(now: number, out: Float32Array): boolean {
    if (!this.haveFrame) return false;
    const alpha = Math.min(1, Math.max(0, (now - this.blendStart) / this.blendMs));
    const a = this.from, b = this.to, s = this.shown;
    for (let i = 0; i < s.length; i++) s[i] = a[i] + (b[i] - a[i]) * alpha;
    out.set(s.subarray(0, Math.min(s.length, out.length)));
    return true;
  }

  /** Last positions shown (stride 4). */
  get current(): Float32Array { return this.shown; }

  setFixed(index: number, position: { x: number; y: number; z: number } | null): void {
    if (index < 0 || index >= this.shown.length / 4) return;
    if (position) {
      // Show the drag immediately; the worker confirms on its next frame.
      for (const arr of [this.from, this.to, this.shown]) { arr[index * 4] = position.x; arr[index * 4 + 1] = position.y; arr[index * 4 + 2] = position.z; }
    }
    this.active = true;
    this.channel?.send({ type: 'FIXED', generation: this.generation, index, x: position?.x ?? 0, y: position?.y ?? 0, z: position?.z ?? 0, fixed: !!position });
  }

  setRadii(radii: Float32Array): void { this.active = true; this.channel?.send({ type: 'RADII', generation: this.generation, radii: radii.slice() }); }
  setParams(params: SimulationParams): void { this.active = true; this.channel?.send({ type: 'PARAMS', generation: this.generation, params }); }
  setPositions(positions: Float32Array): void { this.active = true; this.channel?.send({ type: 'POSITIONS', generation: this.generation, positions: positions.slice() }); }
  reheat(energy = 0.6): void { this.active = true; this.channel?.send({ type: 'REHEAT', generation: this.generation, energy }); }
  pause(): void { this.channel?.send({ type: 'PAUSE' }); }
  resume(): void { this.channel?.send({ type: 'RESUME' }); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.initTimer) clearTimeout(this.initTimer);
    this.channel?.send({ type: 'DISPOSE' });
    this.channel?.dispose();
    this.channel = null;
    this.active = false;
  }
}
