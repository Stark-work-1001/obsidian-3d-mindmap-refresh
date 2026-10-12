// PhysicsBackend over the wasm-bindgen GraphPhysicsWasm class.
import type { PhysicsBackend, SimulationParams } from './types';

export interface WasmEngine {
  set_edges(edges: Uint32Array, rest: Float32Array, strength: Float32Array): void;
  set_params(params: unknown): void;
  set_positions(flat: Float32Array): void;
  set_constraints(radii: Float32Array, levels: Float32Array, fixed: Float32Array): void;
  set_radii(radii: Float32Array): void;
  set_fixed(index: number, x: number, y: number, z: number, fixed: boolean): void;
  reheat(energy: number): void;
  set_temperature(level: number): void;
  step_n(count: number): boolean;
  positions_ptr(): number;
  positions_len(): number;
  diagnostics(): Float32Array;
  free(): void;
}

export class WasmBackend implements PhysicsBackend {
  readonly kind = 'wasm' as const;
  constructor(private readonly engine: WasmEngine, private readonly memory: () => WebAssembly.Memory) {}
  setEdges(edges: Uint32Array, rest: Float32Array, strength: Float32Array): void { this.engine.set_edges(edges, rest, strength); }
  setParams(params: SimulationParams): void { this.engine.set_params(params); }
  setPositions(flat: Float32Array): void { this.engine.set_positions(flat); }
  setConstraints(radii: Float32Array, levels: Float32Array, fixed: Float32Array): void { this.engine.set_constraints(radii, levels, fixed); }
  setRadii(radii: Float32Array): void { this.engine.set_radii(radii); }
  setFixed(index: number, x: number, y: number, z: number, fixed: boolean): void { this.engine.set_fixed(index, x, y, z, fixed); }
  reheat(energy: number): void { this.engine.reheat(energy); }
  setTemperature(level: number): void { this.engine.set_temperature(level); }
  stepN(count: number): boolean { return this.engine.step_n(count); }
  /** A fresh view each call: WASM memory may grow and detach older views. */
  positions(): Float32Array { return new Float32Array(this.memory().buffer, this.engine.positions_ptr(), this.engine.positions_len()); }
  diagnostics(): Float32Array { return this.engine.diagnostics(); }
  free(): void { this.engine.free(); }
}
