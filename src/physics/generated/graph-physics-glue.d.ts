/* tslint:disable */
/* eslint-disable */

export class GraphPhysicsWasm {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * [steps, kinetic_energy, max_displacement, mean_displacement, overlapping_pairs,
     *  pairs_examined, budget_exhausted, large_nodes, nan_resets, temperature, stop_reason]
     */
    diagnostics(): Float32Array;
    edge_count(): number;
    energy(): number;
    get_params(): any;
    is_converged(): boolean;
    constructor(node_count: number, edges_flat: Uint32Array, params: any);
    positions_len(): number;
    positions_ptr(): number;
    positions_stride(): number;
    reheat(energy: number): void;
    set_constraints(radii: Float32Array, levels: Float32Array, fixed: Float32Array): void;
    set_edges(edges_flat: Uint32Array, rest: Float32Array, strength: Float32Array): void;
    set_fixed(index: number, x: number, y: number, z: number, fixed: boolean): void;
    set_params(params: any): void;
    set_positions(positions_flat: Float32Array): void;
    set_radii(radii: Float32Array): void;
    set_temperature(level: number): void;
    step(): boolean;
    /**
     * Run up to `count` steps; returns whether the simulation is still active.
     */
    step_n(count: number): boolean;
    /**
     * 0 = running, 1 = settled, 2 = cooled.
     */
    stop_reason(): number;
    temperature(): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_graphphysicswasm_free: (a: number, b: number) => void;
    readonly graphphysicswasm_diagnostics: (a: number, b: number) => void;
    readonly graphphysicswasm_edge_count: (a: number) => number;
    readonly graphphysicswasm_energy: (a: number) => number;
    readonly graphphysicswasm_get_params: (a: number, b: number) => void;
    readonly graphphysicswasm_is_converged: (a: number) => number;
    readonly graphphysicswasm_new: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly graphphysicswasm_positions_len: (a: number) => number;
    readonly graphphysicswasm_positions_ptr: (a: number) => number;
    readonly graphphysicswasm_positions_stride: (a: number) => number;
    readonly graphphysicswasm_reheat: (a: number, b: number) => void;
    readonly graphphysicswasm_set_constraints: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly graphphysicswasm_set_edges: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly graphphysicswasm_set_fixed: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly graphphysicswasm_set_params: (a: number, b: number, c: number) => void;
    readonly graphphysicswasm_set_positions: (a: number, b: number, c: number) => void;
    readonly graphphysicswasm_set_radii: (a: number, b: number, c: number) => void;
    readonly graphphysicswasm_set_temperature: (a: number, b: number) => void;
    readonly graphphysicswasm_step: (a: number) => number;
    readonly graphphysicswasm_step_n: (a: number, b: number) => number;
    readonly graphphysicswasm_stop_reason: (a: number) => number;
    readonly graphphysicswasm_temperature: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
