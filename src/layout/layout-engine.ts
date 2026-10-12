// Owns node positions for one view. Deterministic layouts are computed here
// and animated with collision-aware transitions; the force layout runs in the
// physics worker. The renderer reads `positions` (x, y, z, pad per node) and
// only re-uploads when `update()` reports a change.
import { DEFAULT_SIM_PARAMS, type PhysicsDiagnostics, type SimulationParams } from '../physics/types';
import type { PhysicsClient } from '../physics/physics-client';
import type { GraphPayload } from '../physics/protocol';
import { layoutInfo, type LayoutId } from './catalog';
import { fnv1a36 } from '../model/id-matching';
import { runLayout, type LayoutRun } from './run-layout';
import { Transition } from './transition';
import type { ArrangementMemory, LayoutNode, LayoutOptions, Vec3 } from './types';

export type EdgeKind = 'hierarchy' | 'documentOrder' | 'association' | 'noteLink';

export interface EngineNode {
  id: string;
  parentId: string | null;
  depth: number;
  ring: number;
  order: number;
  childCount: number;
  radius: number;
  anchor: Vec3 | null;
}

export interface EngineEdge { source: string; target: string; kind: EdgeKind }

/** Why the graph is being (re)laid out; controls memory and simulation energy. */
export type LayoutReason = 'open' | 'layout' | 'edit' | 'expand' | 'settings' | 'rearrange';

export interface EngineSettings {
  gap: number;
  chargeStrength: number;
  animate: boolean;
}

const EDGE_SPRING: Record<EdgeKind, { strength: number; extraGap: number }> = {
  hierarchy: { strength: 1, extraGap: 1 },
  documentOrder: { strength: 0.22, extraGap: 2.5 },
  association: { strength: 0.6, extraGap: 1.3 },
  noteLink: { strength: 0.35, extraGap: 1.6 },
};

export function simulationParams(settings: EngineSettings): SimulationParams {
  // Values follow 1.x so the force layout keeps its character; spacing is a gap.
  return {
    ...DEFAULT_SIM_PARAMS, repulsion: Math.abs(settings.chargeStrength) * 55, attraction: 0.12,
    link_distance: settings.gap + 13, gravity: 0.002, damping: 0.78, max_velocity: 45, dt: 0.4, theta: 0.85,
    alpha_min: 0.002, shell_spacing: (settings.gap + 13) * 0.9,
  };
}

function jitter(id: string, scale: number): Vec3 {
  const h = parseInt(fnv1a36(id).slice(0, 6), 36);
  const a = (h % 6283) / 1000, b = ((h >>> 3) % 3141) / 1000;
  return { x: Math.cos(a) * Math.sin(b) * scale, y: Math.cos(b) * scale, z: Math.sin(a) * Math.sin(b) * scale };
}

export class LayoutEngine {
  ids: string[] = [];
  index = new Map<string, number>();
  positions = new Float32Array(0);
  radii = new Float32Array(0);
  kind: LayoutId = 'force';
  guide: Vec3[] | null = null;
  lastRun: LayoutRun | null = null;
  /** Final positions of the running transition (x, y, z per node), for framing ahead of the animation. */
  targets: Float64Array | null = null;
  /** Increments every time positions change (renderer dirty tracking). */
  revision = 0;
  private nodes: EngineNode[] = [];
  private transition: Transition | null = null;
  private memory = new Map<LayoutId, ArrangementMemory>();
  private physics: PhysicsClient | null = null;
  private dragged = new Set<number>();
  private topology = '';
  private paramsKey = '';
  private settings: EngineSettings = { gap: 49, chargeStrength: -260, animate: true };
  reducedMotion = false;

  constructor(private readonly createPhysics: () => PhysicsClient) {}

  get count(): number { return this.ids.length; }
  get active(): boolean { return !!this.transition || !!this.physics?.moving || this.dragged.size > 0; }
  get physicsDiagnostics(): PhysicsDiagnostics | null { return this.physics?.diagnostics ?? null; }
  get physicsBackend(): string { return this.physics ? this.physics.backend : 'none'; }

  positionOf(id: string): Vec3 | null {
    const i = this.index.get(id);
    return i === undefined ? null : { x: this.positions[i * 4], y: this.positions[i * 4 + 1], z: this.positions[i * 4 + 2] };
  }

  /** Replace the graph. Existing nodes keep their on-screen positions as the start. */
  setGraph(nodes: EngineNode[], edges: EngineEdge[], kind: LayoutId, settings: EngineSettings, reason: LayoutReason): void {
    const previous = new Map<string, Vec3>();
    for (let i = 0; i < this.ids.length; i++) previous.set(this.ids[i], { x: this.positions[i * 4], y: this.positions[i * 4 + 1], z: this.positions[i * 4 + 2] });
    const kindChanged = kind !== this.kind;
    // Did any surviving node change size (note added, children added, resized)?
    let radiiChanged = nodes.length !== this.ids.length;
    for (let k = 0; k < nodes.length && !radiiChanged; k++) {
      const old = this.index.get(nodes[k].id);
      if (old === undefined || Math.abs(this.radii[old] - nodes[k].radius) > 1e-3 * Math.max(1, nodes[k].radius)) radiiChanged = true;
    }
    this.kind = kind;
    this.settings = settings;
    this.nodes = nodes;
    this.ids = nodes.map(n => n.id);
    this.index = new Map(this.ids.map((id, i) => [id, i]));
    this.radii = Float32Array.from(nodes, n => n.radius);
    this.dragged.clear();
    const positions = new Float32Array(nodes.length * 4);
    nodes.forEach((n, i) => {
      const p = previous.get(n.id) ?? (() => {
        // New node: start beside its parent so it grows out of the structure.
        const parent = n.parentId ? this.index.get(n.parentId) : undefined;
        const base = parent !== undefined && parent < i ? { x: positions[parent * 4], y: positions[parent * 4 + 1], z: positions[parent * 4 + 2] } : { x: 0, y: 0, z: 0 };
        const j = jitter(n.id, n.radius * 3 + 4);
        return { x: base.x + j.x, y: base.y + j.y, z: base.z + j.z };
      })();
      positions[i * 4] = p.x; positions[i * 4 + 1] = p.y; positions[i * 4 + 2] = p.z;
    });
    this.positions = positions;
    this.revision++;
    if (layoutInfo(kind).physics) this.startPhysics(edges, reason, kindChanged, radiiChanged);
    else { this.physics?.dispose(); this.physics = null; this.relayout(reason); }
  }

  private layoutOptions(): LayoutOptions { return { gap: this.settings.gap, clearance: 0.12 }; }

  /** Run the deterministic layout and animate towards it. */
  relayout(reason: LayoutReason): void {
    const nodes: LayoutNode[] = this.nodes.map((n, i) => ({
      id: n.id, parentId: n.parentId, depth: n.depth, ring: n.ring, order: n.order, childCount: n.childCount,
      radius: n.radius, anchor: n.anchor, x: this.positions[i * 4], y: this.positions[i * 4 + 1], z: this.positions[i * 4 + 2],
    }));
    const keepArrangement = reason === 'edit' || reason === 'expand' || reason === 'settings';
    const run = runLayout(this.kind, nodes, this.layoutOptions(), keepArrangement ? this.memory.get(this.kind) : undefined);
    if (run.chapters) this.memory.set(this.kind, run.chapters);
    this.lastRun = run;
    this.guide = run.guide;
    const from = new Float64Array(nodes.length * 3), to = new Float64Array(nodes.length * 3);
    nodes.forEach((n, i) => {
      from[i * 3] = this.positions[i * 4]; from[i * 3 + 1] = this.positions[i * 4 + 1]; from[i * 3 + 2] = this.positions[i * 4 + 2];
      to[i * 3] = n.x; to[i * 3 + 1] = n.y; to[i * 3 + 2] = n.z;
    });
    this.targets = to;
    let moved = 0;
    for (let k = 0; k < to.length; k++) moved = Math.max(moved, Math.abs(to[k] - from[k]));
    // Nothing moves (e.g. a rename): no animation, no frames.
    const animate = this.settings.animate && !this.reducedMotion && reason !== 'open' && nodes.length > 0 && moved > 0.01;
    if (!animate) {
      this.transition = null;
      for (let i = 0; i < nodes.length; i++) { this.positions[i * 4] = to[i * 3]; this.positions[i * 4 + 1] = to[i * 3 + 1]; this.positions[i * 4 + 2] = to[i * 3 + 2]; }
      this.revision++;
      return;
    }
    this.transition = new Transition(from, to, Float64Array.from(this.radii), Uint8Array.from(this.nodes, n => (n.anchor ? 1 : 0)), performance.now());
  }

  private payload(edges: EngineEdge[]): GraphPayload {
    const n = this.nodes.length;
    const pairs: number[] = [], rest: number[] = [], strength: number[] = [];
    for (const e of edges) {
      const a = this.index.get(e.source), b = this.index.get(e.target);
      if (a === undefined || b === undefined || a === b) continue;
      const spring = EDGE_SPRING[e.kind];
      pairs.push(a, b);
      rest.push(this.radii[a] + this.radii[b] + this.settings.gap * spring.extraGap);
      strength.push(spring.strength);
    }
    const fixed = new Float32Array(n * 4);
    this.nodes.forEach((node, i) => { if (node.anchor) { fixed[i * 4] = node.anchor.x; fixed[i * 4 + 1] = node.anchor.y; fixed[i * 4 + 2] = node.anchor.z; fixed[i * 4 + 3] = 1; } });
    return {
      count: n, edges: Uint32Array.from(pairs), edgeRest: Float32Array.from(rest), edgeStrength: Float32Array.from(strength),
      positions: this.positions.slice(), fixed, radii: this.radii.slice(), levels: Float32Array.from(this.nodes, nd => nd.ring),
      params: simulationParams(this.settings),
    };
  }

  private startPhysics(edges: EngineEdge[], reason: LayoutReason, kindChanged: boolean, radiiChanged: boolean): void {
    this.transition = null;
    this.targets = null;
    this.guide = null;
    const topology = `${this.ids.join('\u0001')}#${edges.map(e => `${e.source}>${e.target}:${e.kind}`).join('\u0001')}`;
    this.physics ??= this.createPhysics();
    if (topology === this.topology && !kindChanged && (reason === 'settings' || reason === 'edit')) {
      // Same nodes and edges (a rename, a note edit, a setting): keep the
      // simulation; only a size change needs a gentle nudge to resolve overlaps.
      const params = JSON.stringify(simulationParams(this.settings));
      if (params !== this.paramsKey) { this.paramsKey = params; this.physics.setParams(simulationParams(this.settings)); }
      if (radiiChanged) { this.physics.setRadii(this.radii); this.physics.reheat(0.15); }
      return;
    }
    this.paramsKey = JSON.stringify(simulationParams(this.settings));
    this.topology = topology;
    const temperature = reason === 'edit' ? 0.3 : reason === 'expand' ? 0.55 : 1;
    this.physics.start(this.payload(edges), temperature);
  }

  /** Re-energise the simulation (force layout) or re-run the layout. */
  reheat(): void {
    if (this.physics) this.physics.reheat(0.6);
    else this.relayout('rearrange');
  }

  /** Advance animations; returns true when positions changed this frame. */
  update(now: number): boolean {
    let changed = false;
    if (this.transition) {
      const tmp = new Float64Array(this.ids.length * 3);
      const running = this.transition.sample(now, tmp);
      for (let i = 0; i < this.ids.length; i++) {
        if (this.dragged.has(i)) continue;
        this.positions[i * 4] = tmp[i * 3]; this.positions[i * 4 + 1] = tmp[i * 3 + 1]; this.positions[i * 4 + 2] = tmp[i * 3 + 2];
      }
      if (!running) this.transition = null;
      changed = true;
    }
    if (this.physics && (this.physics.moving || this.dragged.size)) {
      if (this.physics.sample(now, this.positions)) changed = true;
    }
    if (changed) this.revision++;
    return changed;
  }

  /** Move a node interactively. In deterministic layouts its subtree follows. */
  drag(id: string, to: Vec3): void {
    const i = this.index.get(id);
    if (i === undefined) return;
    this.dragged.add(i);
    this.targets = null;
    if (this.physics) { this.physics.setFixed(i, to); this.revision++; return; }
    this.transition = null;
    const dx = to.x - this.positions[i * 4], dy = to.y - this.positions[i * 4 + 1], dz = to.z - this.positions[i * 4 + 2];
    for (const k of this.subtreeIndices(i)) { this.positions[k * 4] += dx; this.positions[k * 4 + 1] += dy; this.positions[k * 4 + 2] += dz; }
    this.revision++;
  }

  /** Finish a drag. `anchor` keeps the node where it was dropped. */
  release(id: string, anchor: Vec3 | null): void {
    const i = this.index.get(id);
    if (i === undefined) return;
    this.dragged.delete(i);
    this.nodes[i] = { ...this.nodes[i], anchor };
    if (this.physics) { this.physics.setFixed(i, anchor); return; }
    if (anchor) this.relayout('edit');
  }

  setAnchor(id: string, anchor: Vec3 | null): void {
    const i = this.index.get(id);
    if (i === undefined) return;
    this.nodes[i] = { ...this.nodes[i], anchor };
    if (this.physics) this.physics.setFixed(i, anchor);
    else this.relayout('edit');
  }

  /** Forget arrangement memory and lay out from scratch (Rearrange command). */
  rearrange(): void {
    this.memory.delete(this.kind);
    this.reheat();
  }

  subtreeIndices(root: number): number[] {
    const children = new Map<string, number[]>();
    this.nodes.forEach((n, i) => { if (n.parentId) { const list = children.get(n.parentId); if (list) list.push(i); else children.set(n.parentId, [i]); } });
    const out: number[] = [];
    const stack = [root];
    const seen = new Set<number>();
    while (stack.length) {
      const k = stack.pop()!;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
      for (const c of children.get(this.ids[k]) ?? []) stack.push(c);
    }
    return out;
  }

  /** Bounding sphere of the given node indices (all nodes by default). */
  bounds(indices?: number[]): { x: number; y: number; z: number; r: number } {
    const list = indices ?? this.ids.map((_, i) => i);
    if (!list.length) return { x: 0, y: 0, z: 0, r: 100 };
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const i of list) {
      const r = this.radii[i];
      minX = Math.min(minX, this.positions[i * 4] - r); maxX = Math.max(maxX, this.positions[i * 4] + r);
      minY = Math.min(minY, this.positions[i * 4 + 1] - r); maxY = Math.max(maxY, this.positions[i * 4 + 1] + r);
      minZ = Math.min(minZ, this.positions[i * 4 + 2] - r); maxZ = Math.max(maxZ, this.positions[i * 4 + 2] + r);
    }
    const x = (minX + maxX) / 2, y = (minY + maxY) / 2, z = (minZ + maxZ) / 2;
    return { x, y, z, r: Math.max(1, Math.hypot(maxX - x, maxY - y, maxZ - z)) };
  }

  /** Spheres for camera framing. */
  spheres(indices?: number[], final = false): { x: number; y: number; z: number; r: number }[] {
    const list = indices ?? this.ids.map((_, i) => i);
    const t = final && this.targets && this.targets.length === this.ids.length * 3 ? this.targets : null;
    return list.map(i => (t
      ? { x: t[i * 3], y: t[i * 3 + 1], z: t[i * 3 + 2], r: this.radii[i] }
      : { x: this.positions[i * 4], y: this.positions[i * 4 + 1], z: this.positions[i * 4 + 2], r: this.radii[i] }));
  }

  /** Closest sphere surface to a point (camera clearance and clipping). */
  nearestSurface(x: number, y: number, z: number): { distance: number; x: number; y: number; z: number; r: number } | null {
    let best = -1, bestD = Infinity;
    const p = this.positions;
    for (let i = 0; i < this.ids.length; i++) {
      const d = Math.hypot(p[i * 4] - x, p[i * 4 + 1] - y, p[i * 4 + 2] - z) - this.radii[i];
      if (d < bestD) { bestD = d; best = i; }
    }
    return best < 0 ? null : { distance: bestD, x: p[best * 4], y: p[best * 4 + 1], z: p[best * 4 + 2], r: this.radii[best] };
  }

  dispose(): void {
    this.physics?.dispose();
    this.physics = null;
    this.transition = null;
  }
}
