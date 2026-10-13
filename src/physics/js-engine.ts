// JavaScript implementation of the layout engine in crates/graph-physics.
// Same forces, collision grid, work bounds, annealing and diagnostics; used
// when WebAssembly (with SIMD) is unavailable. Hash constants differ from the
// Rust code, which only changes bucket order, not which pairs are found.
import {
  DEFAULT_SIM_PARAMS, DIAG, DIAG_LENGTH, STOP_COOLED, STOP_RUNNING, STOP_SETTLED,
  type PhysicsBackend, type SimulationParams,
} from './types';

const EMPTY = -1;
const OCTREE_THRESHOLD = 64;
const MIN_CELL = 0.001;
const MIN_RADIUS = 0.1;
const MAX_RADIUS = 300;
const DEFAULT_RADIUS = 6;
const FORWARD: readonly (readonly [number, number, number])[] = [
  [1, -1, -1], [1, -1, 0], [1, -1, 1], [1, 0, -1], [1, 0, 0], [1, 0, 1], [1, 1, -1], [1, 1, 0], [1, 1, 1],
  [0, 1, -1], [0, 1, 0], [0, 1, 1], [0, 0, 1],
];

const finite = (v: number) => Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function sanitizeParams(input: Partial<SimulationParams>): SimulationParams {
  const d = DEFAULT_SIM_PARAMS;
  const p = { ...d, ...input };
  const fix = (v: number, lo: number, hi: number, fallback: number) => (finite(v) ? clamp(v, lo, hi) : fallback);
  return {
    repulsion: fix(p.repulsion, 0, 1e7, d.repulsion), attraction: fix(p.attraction, 0, 10, d.attraction),
    link_distance: fix(p.link_distance, 0.1, 1e5, d.link_distance), gravity: fix(p.gravity, 0, 10, d.gravity),
    damping: fix(p.damping, 0, 0.999, d.damping), max_velocity: fix(p.max_velocity, 0.01, 1e5, d.max_velocity),
    dt: fix(p.dt, 1e-4, 10, d.dt), theta: fix(p.theta, 0, 2, d.theta), alpha_min: fix(p.alpha_min, 0, 1e6, d.alpha_min),
    collision_scale: fix(p.collision_scale, 1, 4, d.collision_scale), collision_strength: fix(p.collision_strength, 0, 2, d.collision_strength),
    max_pairs_per_node: Math.round(fix(p.max_pairs_per_node, 1, 4096, d.max_pairs_per_node)),
    shell_strength: fix(p.shell_strength, 0, 10, d.shell_strength), shell_spacing: fix(p.shell_spacing, 0, 1e5, 0),
    cooling: fix(p.cooling, 0, 0.5, d.cooling), min_temperature: fix(p.min_temperature, 1e-6, 0.5, d.min_temperature),
    calm_steps: Math.round(fix(p.calm_steps, 1, 1000, d.calm_steps)),
  };
}

/** Barnes-Hut octree over stride-4 positions, stored in growable typed arrays. */
class Octree {
  private cap = 0;
  count = 0;
  com = new Float64Array(0);
  mass = new Float64Array(0);
  size = new Float64Array(0);
  center = new Float64Array(0);
  lo = new Float64Array(0);
  hi = new Float64Array(0);
  children = new Int32Array(0);
  item = new Int32Array(0);
  childCount = new Uint8Array(0);
  private stackCell = new Int32Array(64);
  private stackItem = new Int32Array(64);
  private traversal = new Int32Array(64);

  private grow(min: number): void {
    if (min <= this.cap) return;
    const cap = Math.max(min, this.cap * 2, 64);
    const g64 = (a: Float64Array, k: number) => { const b = new Float64Array(cap * k); b.set(a); return b; };
    this.com = g64(this.com, 3); this.mass = g64(this.mass, 1); this.size = g64(this.size, 1);
    this.center = g64(this.center, 3); this.lo = g64(this.lo, 3); this.hi = g64(this.hi, 3);
    const c = new Int32Array(cap * 8); c.set(this.children); this.children = c;
    const it = new Int32Array(cap); it.set(this.item); this.item = it;
    const cc = new Uint8Array(cap); cc.set(this.childCount); this.childCount = cc;
    this.cap = cap;
  }

  private push(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
    const i = this.count++;
    this.grow(this.count);
    this.com[i * 3] = this.com[i * 3 + 1] = this.com[i * 3 + 2] = 0;
    this.mass[i] = 0;
    this.size[i] = Math.abs(x1 - x0);
    this.center[i * 3] = (x0 + x1) / 2; this.center[i * 3 + 1] = (y0 + y1) / 2; this.center[i * 3 + 2] = (z0 + z1) / 2;
    this.lo[i * 3] = x0; this.lo[i * 3 + 1] = y0; this.lo[i * 3 + 2] = z0;
    this.hi[i * 3] = x1; this.hi[i * 3 + 1] = y1; this.hi[i * 3 + 2] = z1;
    this.children.fill(EMPTY, i * 8, i * 8 + 8);
    this.item[i] = EMPTY;
    this.childCount[i] = 0;
    return i;
  }

  rebuild(pos: Float32Array, n: number): void {
    this.count = 0;
    if (!n) return;
    this.grow(n * 2);
    let x0 = pos[0], y0 = pos[1], z0 = pos[2], x1 = x0, y1 = y0, z1 = z0;
    for (let i = 1; i < n; i++) {
      const x = pos[i * 4], y = pos[i * 4 + 1], z = pos[i * 4 + 2];
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (z < z0) z0 = z;
      if (x > x1) x1 = x; if (y > y1) y1 = y; if (z > z1) z1 = z;
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    const half = Math.max(1, (x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2);
    this.push(cx - half, cy - half, cz - half, cx + half, cy + half, cz + half);
    for (let i = 0; i < n; i++) this.insert(i, pos);
  }

  private childFor(parent: number, x: number, y: number, z: number): number {
    const c = this.center;
    const octant = (x >= c[parent * 3] ? 1 : 0) | (y >= c[parent * 3 + 1] ? 2 : 0) | (z >= c[parent * 3 + 2] ? 4 : 0);
    const existing = this.children[parent * 8 + octant];
    if (existing !== EMPTY) return existing;
    const lo = this.lo, hi = this.hi, k = parent * 3;
    const child = this.push(
      octant & 1 ? c[k] : lo[k], octant & 2 ? c[k + 1] : lo[k + 1], octant & 4 ? c[k + 2] : lo[k + 2],
      octant & 1 ? hi[k] : c[k], octant & 2 ? hi[k + 1] : c[k + 1], octant & 4 ? hi[k + 2] : c[k + 2]);
    this.children[parent * 8 + octant] = child;
    this.childCount[parent]++;
    return child;
  }

  private insert(item: number, pos: Float32Array): void {
    let top = 0;
    this.stackCell[top] = 0; this.stackItem[top] = item; top++;
    while (top) {
      top--;
      const cell = this.stackCell[top], it = this.stackItem[top];
      const x = pos[it * 4], y = pos[it * 4 + 1], z = pos[it * 4 + 2];
      const m = this.mass[cell] + 1;
      this.com[cell * 3] = (this.com[cell * 3] * this.mass[cell] + x) / m;
      this.com[cell * 3 + 1] = (this.com[cell * 3 + 1] * this.mass[cell] + y) / m;
      this.com[cell * 3 + 2] = (this.com[cell * 3 + 2] * this.mass[cell] + z) / m;
      const coincident = this.size[cell] <= MIN_CELL && this.mass[cell] > 0;
      this.mass[cell] = m;
      if (coincident) continue;
      const occupant = this.item[cell];
      if (occupant === EMPTY && this.childCount[cell] === 0) { this.item[cell] = it; continue; }
      if (top + 2 >= this.stackCell.length) {
        const a = new Int32Array(this.stackCell.length * 2); a.set(this.stackCell); this.stackCell = a;
        const b = new Int32Array(this.stackItem.length * 2); b.set(this.stackItem); this.stackItem = b;
      }
      if (occupant !== EMPTY) {
        this.item[cell] = EMPTY;
        this.stackCell[top] = this.childFor(cell, pos[occupant * 4], pos[occupant * 4 + 1], pos[occupant * 4 + 2]);
        this.stackItem[top] = occupant; top++;
      }
      this.stackCell[top] = this.childFor(cell, x, y, z);
      this.stackItem[top] = it; top++;
    }
  }

  /** Adds the repulsion on `item` into out[0..3]. */
  repulsion(x: number, y: number, z: number, item: number, strength: number, theta: number, out: Float64Array, o: number): void {
    if (!this.count) return;
    let top = 0;
    this.traversal[top++] = 0;
    while (top) {
      const cell = this.traversal[--top];
      const m = this.mass[cell];
      if (m === 0) continue;
      const dx = x - this.com[cell * 3], dy = y - this.com[cell * 3 + 1], dz = z - this.com[cell * 3 + 2];
      const d2 = Math.max(1, dx * dx + dy * dy + dz * dz);
      const d = Math.sqrt(d2);
      if (this.childCount[cell] === 0 || this.size[cell] / d < theta) {
        if (this.item[cell] !== item) {
          const f = (strength * m) / (d2 * d);
          out[o] += dx * f; out[o + 1] += dy * f; out[o + 2] += dz * f;
        }
      } else {
        if (top + 8 > this.traversal.length) { const t = new Int32Array(this.traversal.length * 2); t.set(this.traversal); this.traversal = t; }
        for (let k = 0; k < 8; k++) { const child = this.children[cell * 8 + k]; if (child !== EMPTY) this.traversal[top++] = child; }
      }
    }
  }
}

function hashCell(x: number, y: number, z: number, mask: number): number {
  let h = Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(z, 0xc2b2ae3d);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return h & mask;
}

/** Counting-sorted uniform grid with exact-cell candidate filtering. */
class CellGrid {
  mask = 0;
  start = new Uint32Array(0);
  cursor = new Uint32Array(0);
  sorted = new Int32Array(0);
  slot = new Int32Array(0);
  keys = new Int32Array(0);
  bucket = new Uint32Array(0);

  build(pos: Float32Array, n: number, members: Int32Array, memberCount: number, cell: number): void {
    const inv = 1 / Math.max(cell, 1e-3);
    let table = 64;
    while (table < memberCount * 2) table *= 2;
    this.mask = table - 1;
    if (this.keys.length < n * 3) { this.keys = new Int32Array(n * 3); this.slot = new Int32Array(n); this.bucket = new Uint32Array(n); }
    if (this.start.length < table + 1) { this.start = new Uint32Array(table + 1); this.cursor = new Uint32Array(table); } else this.start.fill(0, 0, table + 1);
    if (this.sorted.length < memberCount) this.sorted = new Int32Array(Math.max(memberCount, 16));
    for (let k = 0; k < memberCount; k++) {
      const i = members[k];
      const x = Math.floor(pos[i * 4] * inv), y = Math.floor(pos[i * 4 + 1] * inv), z = Math.floor(pos[i * 4 + 2] * inv);
      this.keys[i * 3] = x; this.keys[i * 3 + 1] = y; this.keys[i * 3 + 2] = z;
      const b = hashCell(x, y, z, this.mask);
      this.bucket[i] = b;
      this.start[b + 1]++;
    }
    for (let b = 0; b < table; b++) this.start[b + 1] += this.start[b];
    this.cursor.set(this.start.subarray(0, table));
    for (let k = 0; k < memberCount; k++) {
      const i = members[k];
      const at = this.cursor[this.bucket[i]]++;
      this.sorted[at] = i;
      this.slot[i] = at;
    }
  }

  sameCell(j: number, x: number, y: number, z: number): boolean {
    return this.keys[j * 3] === x && this.keys[j * 3 + 1] === y && this.keys[j * 3 + 2] === z;
  }
}

function pairDirection(i: number, j: number, out: Float64Array): void {
  let h = Math.imul(i + 1, 0x9e3779b9) ^ Math.imul(j + 1, 0x7f4a7c15);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  const u = (h & 0xffff) / 65535, v = ((h >>> 16) & 0xffff) / 65535;
  const z = 1 - 2 * u, r = Math.sqrt(Math.max(0, 1 - z * z)), phi = v * Math.PI * 2;
  out[0] = r * Math.cos(phi); out[1] = r * Math.sin(phi); out[2] = z;
}

export class JsPhysicsEngine implements PhysicsBackend {
  readonly kind = 'js' as const;
  readonly n: number;
  private pos: Float32Array;
  private vel: Float64Array;
  private force: Float64Array;
  private radii: Float32Array;
  private levels: Float32Array;
  private fixed: Float64Array;
  private isFixed: Uint8Array;
  private edges = new Uint32Array(0);
  private edgeRest = new Float32Array(0);
  private edgeStrength = new Float32Array(0);
  private params: SimulationParams;
  private octree = new Octree();
  private fine = new CellGrid();
  private coarse = new CellGrid();
  private small: Int32Array;
  private all: Int32Array;
  private large: Int32Array;
  private radiusScratch: Float32Array;
  private diag = new Float64Array(DIAG_LENGTH);
  private dir = new Float64Array(3);
  private temperature = 1;
  private calm = 0;
  private stopReason = STOP_RUNNING;
  private stepCount = 0;
  private collisionGain = 1;
  kineticEnergy = 1;

  constructor(nodeCount: number, edges: Uint32Array | number[], params: Partial<SimulationParams> = {}) {
    const n = Math.max(0, Math.floor(nodeCount));
    this.n = n;
    this.pos = new Float32Array(n * 4);
    this.vel = new Float64Array(n * 3);
    this.force = new Float64Array(n * 3);
    this.radii = new Float32Array(n).fill(DEFAULT_RADIUS);
    this.levels = new Float32Array(n);
    this.fixed = new Float64Array(n * 3);
    this.isFixed = new Uint8Array(n);
    this.small = new Int32Array(n);
    this.large = new Int32Array(n);
    this.all = new Int32Array(n).map((_, i) => i);
    this.radiusScratch = new Float32Array(n);
    this.params = sanitizeParams(params);
    const golden = (1 + Math.sqrt(5)) / 2;
    const scale = 50 * Math.max(1, Math.sqrt(n));
    for (let i = 0; i < n; i++) {
      const theta = (Math.PI * 2 * i) / golden;
      const phi = n <= 1 ? 0 : Math.acos(clamp(1 - (2 * (i + 0.5)) / n, -1, 1));
      const r = scale * Math.sqrt((i + 1) / Math.max(1, n));
      this.pos[i * 4] = r * Math.sin(phi) * Math.cos(theta);
      this.pos[i * 4 + 1] = r * Math.sin(phi) * Math.sin(theta);
      this.pos[i * 4 + 2] = r * Math.cos(phi);
    }
    this.setEdges(edges instanceof Uint32Array ? edges : Uint32Array.from(edges), new Float32Array(0), new Float32Array(0));
  }

  private restart(level: number): void {
    const l = finite(level) ? clamp(level, 0, 1) : 1;
    this.temperature = this.stopReason === STOP_RUNNING ? Math.max(this.temperature, l) : Math.max(l, this.params.min_temperature * 2);
    this.stopReason = STOP_RUNNING;
    this.calm = 0;
  }

  setEdges(edges: Uint32Array, rest: Float32Array, strength: Float32Array): void {
    const n = this.n;
    const map = new Map<number, [number, number, number, number]>();
    for (let e = 0; e < Math.floor(edges.length / 2); e++) {
      const a = edges[e * 2], b = edges[e * 2 + 1];
      if (a >= n || b >= n || a === b) continue;
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const key = lo * n + hi;
      if (map.has(key)) continue;
      const r = e < rest.length && finite(rest[e]) && rest[e] > 0 ? rest[e] : NaN;
      const s = e < strength.length && finite(strength[e]) && strength[e] >= 0 ? Math.min(100, strength[e]) : 1;
      map.set(key, [lo, hi, r, s]);
    }
    const list = [...map.values()].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    this.edges = new Uint32Array(list.length * 2);
    this.edgeRest = new Float32Array(list.length);
    this.edgeStrength = new Float32Array(list.length);
    list.forEach(([a, b, r, s], e) => { this.edges[e * 2] = a; this.edges[e * 2 + 1] = b; this.edgeRest[e] = r; this.edgeStrength[e] = s; });
    this.restart(1);
  }

  get edgeCount(): number { return this.edgeRest.length; }

  setParams(params: SimulationParams): void { this.params = sanitizeParams(params); this.restart(0.8); }

  setPositions(flat: Float32Array): void {
    const n = this.n;
    const stride = flat.length >= n * 4 ? 4 : 3;
    const count = Math.min(n, Math.floor(flat.length / stride));
    for (let i = 0; i < count; i++) {
      const x = flat[i * stride], y = flat[i * stride + 1], z = flat[i * stride + 2];
      if (finite(x) && finite(y) && finite(z)) { this.pos[i * 4] = x; this.pos[i * 4 + 1] = y; this.pos[i * 4 + 2] = z; }
      this.vel[i * 3] = this.vel[i * 3 + 1] = this.vel[i * 3 + 2] = 0;
    }
    this.restart(1);
  }

  setConstraints(radii: Float32Array, levels: Float32Array, fixed: Float32Array): void {
    for (let i = 0; i < this.n; i++) {
      const r = i < radii.length && finite(radii[i]) ? radii[i] : DEFAULT_RADIUS;
      this.radii[i] = clamp(r, MIN_RADIUS, MAX_RADIUS);
      const l = i < levels.length && finite(levels[i]) ? levels[i] : 0;
      this.levels[i] = Math.max(0, l);
      const pinned = fixed.length >= (i + 1) * 4 && fixed[i * 4 + 3] > 0.5
        && finite(fixed[i * 4]) && finite(fixed[i * 4 + 1]) && finite(fixed[i * 4 + 2]);
      this.isFixed[i] = pinned ? 1 : 0;
      if (pinned) { this.fixed[i * 3] = fixed[i * 4]; this.fixed[i * 3 + 1] = fixed[i * 4 + 1]; this.fixed[i * 3 + 2] = fixed[i * 4 + 2]; }
    }
    this.restart(1);
  }

  setRadii(radii: Float32Array): void {
    for (let i = 0; i < this.n; i++) this.radii[i] = clamp(i < radii.length && finite(radii[i]) ? radii[i] : DEFAULT_RADIUS, MIN_RADIUS, MAX_RADIUS);
    this.restart(0.4);
  }

  setFixed(index: number, x: number, y: number, z: number, fixed: boolean): void {
    if (index < 0 || index >= this.n) return;
    if (fixed && finite(x) && finite(y) && finite(z)) {
      this.isFixed[index] = 1;
      this.fixed[index * 3] = x; this.fixed[index * 3 + 1] = y; this.fixed[index * 3 + 2] = z;
      this.pos[index * 4] = x; this.pos[index * 4 + 1] = y; this.pos[index * 4 + 2] = z;
      this.vel[index * 3] = this.vel[index * 3 + 1] = this.vel[index * 3 + 2] = 0;
    } else this.isFixed[index] = 0;
    this.restart(0.3);
  }

  reheat(energy: number): void { this.restart(energy); }
  setTemperature(level: number): void {
    this.temperature = finite(level) ? clamp(level, this.params.min_temperature * 2, 1) : 1;
    this.stopReason = STOP_RUNNING;
    this.calm = 0;
  }
  isConverged(): boolean { return this.stopReason !== STOP_RUNNING; }
  positions(): Float32Array { return this.pos; }
  diagnostics(): Float64Array { return this.diag; }
  free(): void { /* garbage collected */ }

  stepN(count: number): boolean {
    let active = false;
    for (let k = 0; k < count; k++) { active = this.step(); if (!active) break; }
    return active && !this.isConverged();
  }

  step(): boolean {
    const n = this.n;
    if (n === 0 || this.isConverged()) return false;
    this.stepCount++;
    const diag = this.diag;
    const steps = diag[DIAG.steps] + 1;
    diag.fill(0);
    diag[DIAG.steps] = steps;
    const p = this.params, pos = this.pos, F = this.force;
    const t = Math.max(this.temperature, 1e-6);
    this.collisionGain = Math.max(t, 0.25) / t;
    F.fill(0);

    if (n > OCTREE_THRESHOLD) {
      this.octree.rebuild(pos, n);
      for (let i = 0; i < n; i++) this.octree.repulsion(pos[i * 4], pos[i * 4 + 1], pos[i * 4 + 2], i, p.repulsion, p.theta, F, i * 3);
    } else {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const dx = pos[i * 4] - pos[j * 4], dy = pos[i * 4 + 1] - pos[j * 4 + 1], dz = pos[i * 4 + 2] - pos[j * 4 + 2];
          const d2 = Math.max(1, dx * dx + dy * dy + dz * dz);
          const f = p.repulsion / (d2 * Math.sqrt(d2));
          F[i * 3] += dx * f; F[i * 3 + 1] += dy * f; F[i * 3 + 2] += dz * f;
          F[j * 3] -= dx * f; F[j * 3 + 1] -= dy * f; F[j * 3 + 2] -= dz * f;
        }
      }
    }

    for (let e = 0; e < this.edgeRest.length; e++) {
      const a = this.edges[e * 2], b = this.edges[e * 2 + 1];
      const dx = pos[b * 4] - pos[a * 4], dy = pos[b * 4 + 1] - pos[a * 4 + 1], dz = pos[b * 4 + 2] - pos[a * 4 + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1e-4) continue;
      const rest = Number.isNaN(this.edgeRest[e]) ? p.link_distance : this.edgeRest[e];
      const f = (p.attraction * this.edgeStrength[e] * (d - rest)) / d;
      F[a * 3] += dx * f; F[a * 3 + 1] += dy * f; F[a * 3 + 2] += dz * f;
      F[b * 3] -= dx * f; F[b * 3 + 1] -= dy * f; F[b * 3 + 2] -= dz * f;
    }

    const spacing = p.shell_spacing > 0 ? p.shell_spacing : p.link_distance * 0.9;
    for (let i = 0; i < n; i++) {
      const x = pos[i * 4], y = pos[i * 4 + 1], z = pos[i * 4 + 2];
      F[i * 3] -= x * p.gravity; F[i * 3 + 1] -= y * p.gravity; F[i * 3 + 2] -= z * p.gravity;
      if (this.levels[i] > 0 && p.shell_strength > 0) {
        const dist = Math.max(0.01, Math.sqrt(x * x + y * y + z * z));
        const f = ((this.levels[i] * spacing - dist) / dist) * p.shell_strength;
        F[i * 3] += x * f; F[i * 3 + 1] += y * f; F[i * 3 + 2] += z * f;
      }
    }

    this.collide();

    const maxV2 = p.max_velocity * p.max_velocity;
    let totalV2 = 0, totalDisp = 0, movable = 0, maxDisp = 0;
    for (let i = 0; i < n; i++) {
      if (this.isFixed[i]) {
        pos[i * 4] = this.fixed[i * 3]; pos[i * 4 + 1] = this.fixed[i * 3 + 1]; pos[i * 4 + 2] = this.fixed[i * 3 + 2];
        this.vel[i * 3] = this.vel[i * 3 + 1] = this.vel[i * 3 + 2] = 0;
        continue;
      }
      let vx = (this.vel[i * 3] + F[i * 3] * p.dt * t) * p.damping;
      let vy = (this.vel[i * 3 + 1] + F[i * 3 + 1] * p.dt * t) * p.damping;
      let vz = (this.vel[i * 3 + 2] + F[i * 3 + 2] * p.dt * t) * p.damping;
      const v2 = vx * vx + vy * vy + vz * vz;
      if (v2 > maxV2) { const s = p.max_velocity / Math.sqrt(v2); vx *= s; vy *= s; vz *= s; }
      const nx = pos[i * 4] + vx * p.dt, ny = pos[i * 4 + 1] + vy * p.dt, nz = pos[i * 4 + 2] + vz * p.dt;
      if (!finite(nx) || !finite(ny) || !finite(nz)) { this.vel[i * 3] = this.vel[i * 3 + 1] = this.vel[i * 3 + 2] = 0; diag[DIAG.nanResets]++; continue; }
      this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
      pos[i * 4] = nx; pos[i * 4 + 1] = ny; pos[i * 4 + 2] = nz;
      const d = Math.sqrt(vx * vx + vy * vy + vz * vz) * p.dt;
      if (d > maxDisp) maxDisp = d;
      totalDisp += d;
      totalV2 += vx * vx + vy * vy + vz * vz;
      movable++;
    }
    this.kineticEnergy = movable ? totalV2 / movable : 0;
    this.temperature *= 1 - p.cooling;
    this.calm = this.kineticEnergy < p.alpha_min ? this.calm + 1 : 0;
    if (this.calm >= p.calm_steps) this.stopReason = STOP_SETTLED;
    else if (p.cooling > 0 && this.temperature < p.min_temperature) this.stopReason = STOP_COOLED;
    diag[DIAG.kineticEnergy] = this.kineticEnergy;
    diag[DIAG.maxDisplacement] = maxDisp;
    diag[DIAG.meanDisplacement] = movable ? totalDisp / movable : 0;
    diag[DIAG.temperature] = this.temperature;
    diag[DIAG.stopReason] = this.stopReason;
    return true;
  }

  private applyPair(i: number, j: number): void {
    const pos = this.pos, F = this.force, p = this.params;
    const dx = pos[i * 4] - pos[j * 4], dy = pos[i * 4 + 1] - pos[j * 4 + 1], dz = pos[i * 4 + 2] - pos[j * 4 + 2];
    const minimum = (this.radii[i] + this.radii[j]) * p.collision_scale;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= minimum * minimum) return;
    this.diag[DIAG.overlappingPairs]++;
    const d = Math.sqrt(d2);
    let ux: number, uy: number, uz: number;
    if (d > 1e-4) { ux = dx / d; uy = dy / d; uz = dz / d; } else { pairDirection(i, j, this.dir); ux = this.dir[0]; uy = this.dir[1]; uz = this.dir[2]; }
    const push = (minimum - d) * p.collision_strength * this.collisionGain;
    const fi = this.isFixed[i], fj = this.isFixed[j];
    if (fi && fj) return;
    const wi = fj ? 2 : fi ? 0 : 1, wj = fi ? 2 : fj ? 0 : 1;
    F[i * 3] += ux * push * wi; F[i * 3 + 1] += uy * push * wi; F[i * 3 + 2] += uz * push * wi;
    F[j * 3] -= ux * push * wj; F[j * 3 + 1] -= uy * push * wj; F[j * 3 + 2] -= uz * push * wj;
  }

  private collide(): void {
    const n = this.n, p = this.params, diag = this.diag, pos = this.pos;
    this.radiusScratch.set(this.radii);
    this.radiusScratch.sort();
    const rRef = Math.max(MIN_RADIUS, this.radiusScratch[Math.min(n - 1, Math.floor(n * 0.9))] * 1.5);
    const rMax = Math.max(MIN_RADIUS, this.radiusScratch[n - 1]);
    let smallCount = 0, largeCount = 0;
    for (let i = 0; i < n; i++) { if (this.radii[i] > rRef) this.large[largeCount++] = i; else this.small[smallCount++] = i; }
    diag[DIAG.largeNodes] = largeCount;
    const budget = p.max_pairs_per_node, cap = budget * 8;
    const rotate = this.stepCount % FORWARD.length;
    const fine = this.fine;
    fine.build(pos, n, this.small, smallCount, 2 * rRef * p.collision_scale);
    for (let k = 0; k < smallCount; k++) {
      const i = this.small[k];
      const x = fine.keys[i * 3], y = fine.keys[i * 3 + 1], z = fine.keys[i * 3 + 2];
      let pairs = 0, visited = 0;
      const b = hashCell(x, y, z, fine.mask);
      const end = fine.start[b + 1];
      for (let s = fine.slot[i] + 1; s < end && pairs < budget && visited < cap; s++) {
        const j = fine.sorted[s]; visited++;
        if (!fine.sameCell(j, x, y, z)) continue;
        pairs++; this.applyPair(i, j);
      }
      for (let f = 0; f < FORWARD.length && pairs < budget && visited < cap; f++) {
        const o = FORWARD[(f + rotate) % FORWARD.length];
        const cx = x + o[0], cy = y + o[1], cz = z + o[2];
        const nb = hashCell(cx, cy, cz, fine.mask);
        for (let s = fine.start[nb]; s < fine.start[nb + 1] && pairs < budget && visited < cap; s++) {
          const j = fine.sorted[s]; visited++;
          if (!fine.sameCell(j, cx, cy, cz)) continue;
          pairs++; this.applyPair(i, j);
        }
      }
      diag[DIAG.pairsExamined] += pairs;
      if (pairs >= budget || visited >= cap) diag[DIAG.budgetExhausted]++;
    }
    if (!largeCount) return;
    const coarse = this.coarse;
    coarse.build(pos, n, this.all, n, 2 * rMax * p.collision_scale);
    const lBudget = budget * 4, lCap = cap * 4;
    for (let k = 0; k < largeCount; k++) {
      const i = this.large[k];
      const x = coarse.keys[i * 3], y = coarse.keys[i * 3 + 1], z = coarse.keys[i * 3 + 2];
      let pairs = 0, visited = 0;
      outer: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const cx = x + dx, cy = y + dy, cz = z + dz;
        const b = hashCell(cx, cy, cz, coarse.mask);
        for (let s = coarse.start[b]; s < coarse.start[b + 1]; s++) {
          if (pairs >= lBudget || visited >= lCap) break outer;
          const j = coarse.sorted[s]; visited++;
          if (j === i || !coarse.sameCell(j, cx, cy, cz)) continue;
          if (this.radii[j] > rRef && j < i) continue;
          pairs++; this.applyPair(i, j);
        }
      }
      diag[DIAG.pairsExamined] += pairs;
      if (pairs >= lBudget || visited >= lCap) diag[DIAG.budgetExhausted]++;
    }
  }

  /** Largest remaining overlap (O(n^2), tests only). */
  worstOverlap(): number {
    let worst = 0;
    const p = this.pos;
    for (let i = 0; i < this.n; i++) for (let j = i + 1; j < this.n; j++) {
      const need = (this.radii[i] + this.radii[j]) * this.params.collision_scale;
      const d = Math.hypot(p[i * 4] - p[j * 4], p[i * 4 + 1] - p[j * 4 + 1], p[i * 4 + 2] - p[j * 4 + 2]);
      worst = Math.max(worst, need - d);
    }
    return worst;
  }
}
