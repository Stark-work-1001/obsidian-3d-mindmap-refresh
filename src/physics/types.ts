// Shared types for the layout physics: parameters (same names and meaning as
// the Rust SimulationParams), the backend interface implemented by both the
// WASM engine and the JavaScript fallback, and diagnostics.

export interface SimulationParams {
  repulsion: number;
  attraction: number;
  link_distance: number;
  gravity: number;
  damping: number;
  max_velocity: number;
  dt: number;
  theta: number;
  alpha_min: number;
  collision_scale: number;
  collision_strength: number;
  max_pairs_per_node: number;
  shell_strength: number;
  shell_spacing: number;
  cooling: number;
  min_temperature: number;
  calm_steps: number;
}

export const DEFAULT_SIM_PARAMS: SimulationParams = {
  repulsion: 400, attraction: 0.02, link_distance: 30, gravity: 0.05, damping: 0.85, max_velocity: 40, dt: 0.3,
  theta: 0.8, alpha_min: 0.001, collision_scale: 1.15, collision_strength: 0.5, max_pairs_per_node: 64,
  shell_strength: 0.015, shell_spacing: 0, cooling: 0.0115, min_temperature: 0.004, calm_steps: 8,
};

export const STOP_RUNNING = 0;
export const STOP_SETTLED = 1;
export const STOP_COOLED = 2;

/** Index layout of the diagnostics vector returned by both backends. */
export const DIAG = {
  steps: 0, kineticEnergy: 1, maxDisplacement: 2, meanDisplacement: 3, overlappingPairs: 4, pairsExamined: 5,
  budgetExhausted: 6, largeNodes: 7, nanResets: 8, temperature: 9, stopReason: 10,
} as const;
export const DIAG_LENGTH = 11;

export interface PhysicsDiagnostics {
  backend: 'wasm' | 'js' | 'none';
  steps: number;
  kineticEnergy: number;
  maxDisplacement: number;
  meanDisplacement: number;
  overlappingPairs: number;
  pairsExamined: number;
  budgetExhausted: number;
  largeNodes: number;
  nanResets: number;
  temperature: number;
  stopReason: 'running' | 'settled' | 'cooled';
  lastStepMs: number;
  stepsPerSecond: number;
  fallbackReason?: string;
}

export function decodeDiagnostics(d: ArrayLike<number>, backend: PhysicsDiagnostics['backend'], lastStepMs = 0, stepsPerSecond = 0): PhysicsDiagnostics {
  const stop = d[DIAG.stopReason];
  return {
    backend, steps: d[DIAG.steps], kineticEnergy: d[DIAG.kineticEnergy], maxDisplacement: d[DIAG.maxDisplacement],
    meanDisplacement: d[DIAG.meanDisplacement], overlappingPairs: d[DIAG.overlappingPairs], pairsExamined: d[DIAG.pairsExamined],
    budgetExhausted: d[DIAG.budgetExhausted], largeNodes: d[DIAG.largeNodes], nanResets: d[DIAG.nanResets],
    temperature: d[DIAG.temperature], stopReason: stop === STOP_SETTLED ? 'settled' : stop === STOP_COOLED ? 'cooled' : 'running',
    lastStepMs, stepsPerSecond,
  };
}

/** Engine operations shared by the WASM wrapper and the JavaScript engine. */
export interface PhysicsBackend {
  readonly kind: 'wasm' | 'js';
  setEdges(edges: Uint32Array, rest: Float32Array, strength: Float32Array): void;
  setParams(params: SimulationParams): void;
  setPositions(flat: Float32Array): void;
  setConstraints(radii: Float32Array, levels: Float32Array, fixed: Float32Array): void;
  setRadii(radii: Float32Array): void;
  setFixed(index: number, x: number, y: number, z: number, fixed: boolean): void;
  reheat(energy: number): void;
  setTemperature(level: number): void;
  /** Runs up to `count` steps; false when the run has stopped. */
  stepN(count: number): boolean;
  /** Stride-4 positions (x, y, z, pad). May be a view into engine memory. */
  positions(): Float32Array;
  diagnostics(): ArrayLike<number>;
  free(): void;
}
