// Messages between the main thread (PhysicsClient) and the physics worker.
// Every state-changing message carries a generation number; frames from an
// older generation are discarded by the client. At most one FRAME buffer is
// outstanding: the worker keeps simulating but only posts again after the
// client RETURNs the previous buffer, so no queue can build up.
import type { SimulationParams } from './types';

export interface GraphPayload {
  count: number;
  edges: Uint32Array;
  edgeRest: Float32Array;
  edgeStrength: Float32Array;
  /** Stride 4 (x, y, z, pad). */
  positions: Float32Array;
  /** Stride 4 (x, y, z, 1 = fixed). */
  fixed: Float32Array;
  radii: Float32Array;
  levels: Float32Array;
  params: SimulationParams;
}

export type ToWorker =
  | ({ type: 'INIT'; generation: number; wasm: ArrayBuffer | null; stepsPerSecond: number; temperature?: number } & GraphPayload)
  | { type: 'PARAMS'; generation: number; params: SimulationParams }
  | { type: 'FIXED'; generation: number; index: number; x: number; y: number; z: number; fixed: boolean }
  | { type: 'RADII'; generation: number; radii: Float32Array }
  | { type: 'POSITIONS'; generation: number; positions: Float32Array }
  | { type: 'REHEAT'; generation: number; energy: number }
  | { type: 'RETURN'; buffer: ArrayBuffer }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'DISPOSE' };

export type FromWorker =
  | { type: 'READY'; generation: number; backend: 'wasm' | 'js'; reason?: string }
  | { type: 'FRAME'; generation: number; buffer: ArrayBuffer; active: boolean; diagnostics: number[]; computeMs: number; stepsPerSecond: number }
  | { type: 'ERROR'; generation: number; message: string };
