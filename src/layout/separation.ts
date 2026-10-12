// Overlap measurement and bounded local separation for deterministic layouts
// and transitions. Positions live in flat Float64Arrays (x, y, z per node).
//
// Work bound: every pass visits at most `maxPairs` candidate pairs and
// 8 x maxPairs grid entries per node, across *all* neighbouring cells
// (1.17 reset its counter per cell, so the bound did not hold). Pairs are
// generated once (own cell after the node + 13 forward cells) and filtered by
// exact cell, so hash collisions cannot duplicate work or forces.

const FORWARD = [
  [1, -1, -1], [1, -1, 0], [1, -1, 1], [1, 0, -1], [1, 0, 0], [1, 0, 1], [1, 1, -1], [1, 1, 0], [1, 1, 1],
  [0, 1, -1], [0, 1, 0], [0, 1, 1], [0, 0, 1],
] as const;

function hashCell(x: number, y: number, z: number, mask: number): number {
  let h = Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(z, 0xc2b2ae3d);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return h & mask;
}

export class PointGrid {
  mask = 0;
  start = new Uint32Array(0);
  sorted = new Int32Array(0);
  slot = new Int32Array(0);
  keys = new Int32Array(0);
  private bucket = new Uint32Array(0);
  private cursor = new Uint32Array(0);

  build(pos: Float64Array, count: number, cell: number): void {
    const inv = 1 / Math.max(cell, 1e-6);
    let table = 64;
    while (table < count * 2) table *= 2;
    this.mask = table - 1;
    if (this.keys.length < count * 3) { this.keys = new Int32Array(count * 3); this.slot = new Int32Array(count); this.bucket = new Uint32Array(count); this.sorted = new Int32Array(count); }
    if (this.start.length < table + 1) { this.start = new Uint32Array(table + 1); this.cursor = new Uint32Array(table); } else this.start.fill(0, 0, table + 1);
    for (let i = 0; i < count; i++) {
      const x = Math.floor(pos[i * 3] * inv), y = Math.floor(pos[i * 3 + 1] * inv), z = Math.floor(pos[i * 3 + 2] * inv);
      this.keys[i * 3] = x; this.keys[i * 3 + 1] = y; this.keys[i * 3 + 2] = z;
      const b = hashCell(x, y, z, this.mask);
      this.bucket[i] = b;
      this.start[b + 1]++;
    }
    for (let b = 0; b < table; b++) this.start[b + 1] += this.start[b];
    this.cursor.set(this.start.subarray(0, table));
    for (let i = 0; i < count; i++) { const at = this.cursor[this.bucket[i]]++; this.sorted[at] = i; this.slot[i] = at; }
  }

  /**
   * Visit each unordered pair in neighbouring cells once. `visit` returns
   * nothing; iteration for node i stops after `maxPairs` pairs or 8x that
   * many visited entries. Returns { pairs, exhausted }.
   */
  forEachPair(count: number, maxPairs: number, visit: (i: number, j: number) => void): { pairs: number; exhausted: number } {
    const cap = maxPairs * 8;
    let total = 0, exhausted = 0;
    for (let i = 0; i < count; i++) {
      const x = this.keys[i * 3], y = this.keys[i * 3 + 1], z = this.keys[i * 3 + 2];
      let pairs = 0, visited = 0;
      const end = this.start[hashCell(x, y, z, this.mask) + 1];
      for (let s = this.slot[i] + 1; s < end && pairs < maxPairs && visited < cap; s++) {
        const j = this.sorted[s]; visited++;
        if (this.keys[j * 3] !== x || this.keys[j * 3 + 1] !== y || this.keys[j * 3 + 2] !== z) continue;
        pairs++; visit(i, j);
      }
      for (let f = 0; f < FORWARD.length && pairs < maxPairs && visited < cap; f++) {
        const cx = x + FORWARD[f][0], cy = y + FORWARD[f][1], cz = z + FORWARD[f][2];
        const b = hashCell(cx, cy, cz, this.mask);
        for (let s = this.start[b]; s < this.start[b + 1] && pairs < maxPairs && visited < cap; s++) {
          const j = this.sorted[s]; visited++;
          if (this.keys[j * 3] !== cx || this.keys[j * 3 + 1] !== cy || this.keys[j * 3 + 2] !== cz) continue;
          pairs++; visit(i, j);
        }
      }
      total += pairs;
      if (pairs >= maxPairs || visited >= cap) exhausted++;
    }
    return { pairs: total, exhausted };
  }
}

export interface OverlapStats {
  /** Pairs closer than (r_i + r_j) x (1 + clearance) * tolerance. */
  pairs: number;
  /** Largest penetration of the plain sphere surfaces (r_i + r_j - d), >= 0. */
  maxPenetration: number;
  /** Largest penetration relative to the smaller radius. */
  maxRelative: number;
}

/** Exact count of intersecting spheres (no work budget). */
export function measureOverlap(pos: Float64Array, radii: ArrayLike<number>, count: number): OverlapStats {
  let maxR = 0;
  for (let i = 0; i < count; i++) maxR = Math.max(maxR, radii[i]);
  const grid = new PointGrid();
  grid.build(pos, count, Math.max(1e-3, 2 * maxR));
  let pairs = 0, maxPenetration = 0, maxRelative = 0;
  grid.forEachPair(count, Number.MAX_SAFE_INTEGER / 16, (i, j) => {
    const dx = pos[i * 3] - pos[j * 3], dy = pos[i * 3 + 1] - pos[j * 3 + 1], dz = pos[i * 3 + 2] - pos[j * 3 + 2];
    const need = radii[i] + radii[j];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= need * need) return;
    const pen = need - Math.sqrt(d2);
    if (pen < 1e-6) return;
    pairs++;
    if (pen > maxPenetration) maxPenetration = pen;
    const rel = pen / Math.max(1e-6, Math.min(radii[i], radii[j]));
    if (rel > maxRelative) maxRelative = rel;
  });
  return { pairs, maxPenetration, maxRelative };
}

export interface SeparationOptions {
  clearance: number;
  passes: number;
  maxPairs: number;
  /** Largest move of one node per pass (keeps the layout's silhouette). */
  maxShift: number;
}

/**
 * Push overlapping spheres apart. `fixed[i] = 1` nodes never move; their
 * partner takes the full correction. Coincident pairs separate along a
 * deterministic per-pair direction.
 */
export function separate(pos: Float64Array, radii: ArrayLike<number>, fixed: Uint8Array | null, count: number, options: SeparationOptions):
{ pairs: number; exhausted: number; moved: number } {
  let maxR = 0;
  for (let i = 0; i < count; i++) maxR = Math.max(maxR, radii[i]);
  const grid = new PointGrid();
  const scale = 1 + options.clearance;
  let pairsTotal = 0, exhaustedTotal = 0, moved = 0;
  for (let pass = 0; pass < options.passes; pass++) {
    grid.build(pos, count, Math.max(1e-3, 2 * maxR * scale));
    let changed = 0;
    const { pairs, exhausted } = grid.forEachPair(count, options.maxPairs, (i, j) => {
      let dx = pos[i * 3] - pos[j * 3], dy = pos[i * 3 + 1] - pos[j * 3 + 1], dz = pos[i * 3 + 2] - pos[j * 3 + 2];
      const need = (radii[i] + radii[j]) * scale;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= need * need) return;
      let d = Math.sqrt(d2);
      if (d < 1e-6) {
        const a = (i * 7 + j * 13 + pass) * 2.399963229728653;
        dx = Math.cos(a); dy = 0.35 * Math.sin(a * 0.7); dz = Math.sin(a); d = Math.hypot(dx, dy, dz);
      }
      const fi = fixed?.[i] ?? 0, fj = fixed?.[j] ?? 0;
      if (fi && fj) return;
      const shift = Math.min(options.maxShift, (need - Math.min(d, need)) * 0.52) / d;
      const wi = fj ? 2 : fi ? 0 : 1, wj = fi ? 2 : fj ? 0 : 1;
      pos[i * 3] += dx * shift * wi; pos[i * 3 + 1] += dy * shift * wi; pos[i * 3 + 2] += dz * shift * wi;
      pos[j * 3] -= dx * shift * wj; pos[j * 3 + 1] -= dy * shift * wj; pos[j * 3 + 2] -= dz * shift * wj;
      changed++;
    });
    pairsTotal += pairs; exhaustedTotal += exhausted; moved += changed;
    if (!changed) break;
  }
  return { pairs: pairsTotal, exhausted: exhaustedTotal, moved };
}

/** Copy LayoutNode-like objects into a flat array and back. */
export function packPositions(nodes: { x: number; y: number; z: number }[], out = new Float64Array(nodes.length * 3)): Float64Array {
  nodes.forEach((n, i) => { out[i * 3] = n.x; out[i * 3 + 1] = n.y; out[i * 3 + 2] = n.z; });
  return out;
}

export function unpackPositions(pos: Float64Array, nodes: { x: number; y: number; z: number }[]): void {
  nodes.forEach((n, i) => { n.x = pos[i * 3]; n.y = pos[i * 3 + 1]; n.z = pos[i * 3 + 2]; });
}
