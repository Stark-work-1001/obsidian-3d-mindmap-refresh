// Geometry helpers shared by the deterministic layouts.
import { buildHierarchy, type Hierarchy } from './hierarchy';
import { PointGrid } from './separation';
import type { ArrangementMemory, LayoutNode, LayoutOptions, Vec3 } from './types';

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function siblingGap(options: LayoutOptions): number {
  return Math.max(4, options.gap * 0.4);
}

export function maxRadius(nodes: readonly LayoutNode[]): number {
  let r = 0.1;
  for (const n of nodes) if (n.radius > r) r = n.radius;
  return r;
}

export function medianRadius(nodes: readonly LayoutNode[]): number {
  if (!nodes.length) return 6;
  const sorted = nodes.map(n => n.radius).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Centre-to-centre distance used by motifs that think in "link lengths". */
export function linkLength(nodes: readonly LayoutNode[], options: LayoutOptions): number {
  return options.gap + 2 * medianRadius(nodes);
}

/**
 * Translate nodes so their centroid sits at the origin (skipped when any
 * node is anchored, since anchors are absolute). Returns the translation.
 */
export function centre(nodes: LayoutNode[]): Vec3 {
  if (!nodes.length || nodes.some(n => n.anchor)) return { x: 0, y: 0, z: 0 };
  let x = 0, y = 0, z = 0;
  for (const n of nodes) { x += n.x; y += n.y; z += n.z; }
  x /= nodes.length; y /= nodes.length; z /= nodes.length;
  for (const n of nodes) { n.x -= x; n.y -= y; n.z -= z; }
  return { x: -x, y: -y, z: -z };
}

/**
 * Honour user anchors: an anchored node is moved to its anchor and its whole
 * subtree follows rigidly, so a placed branch keeps its internal shape.
 */
export function applyAnchors(nodes: LayoutNode[], h: Hierarchy = buildHierarchy(nodes)): void {
  if (!nodes.some(n => n.anchor)) return;
  for (const node of h.order) {
    if (!node.anchor) continue;
    const dx = node.anchor.x - node.x, dy = node.anchor.y - node.y, dz = node.anchor.z - node.z;
    if (!dx && !dy && !dz) continue;
    const stack = [...(h.children.get(node.id) ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      n.x += dx; n.y += dy; n.z += dz;
      for (const c of h.children.get(n.id) ?? []) stack.push(c);
    }
    // Exact, not accumulated: the node lands on its anchor bit for bit.
    node.x = node.anchor.x; node.y = node.anchor.y; node.z = node.anchor.z;
  }
}

export interface Disc { id: string; radius: number; preferred: { x: number; z: number } }

/**
 * Place discs (chapter clusters) in the x-z plane without overlap. Discs that
 * have a remembered position start there and are heavier, so an edit inside
 * one chapter moves its neighbours only as much as needed.
 */
export function arrangeDiscs(discs: Disc[], gap: number, memory?: ArrangementMemory): Map<string, { x: number; z: number }> {
  const pos = discs.map(d => {
    const m = memory?.get(d.id);
    if (!m) return { x: d.preferred.x, z: d.preferred.z, heavy: false };
    // Held in place only if it has not changed size since it was placed.
    return { x: m.x, z: m.z, heavy: m.radius === undefined || Math.abs(m.radius - d.radius) < 1e-6 };
  });
  const n = discs.length;
  let moved = false;
  const resolve = (i: number, j: number) => {
    let dx = pos[j].x - pos[i].x, dz = pos[j].z - pos[i].z;
    const need = discs[i].radius + discs[j].radius + gap;
    let d = Math.hypot(dx, dz);
    if (d >= need - 1e-6) return;
    if (d < 1e-6) { const a = (i * 7 + j * 13) * GOLDEN_ANGLE; dx = Math.cos(a); dz = Math.sin(a); d = 1; }
    if (pos[i].heavy && pos[j].heavy) return;
    const push = need - d;
    const wi = pos[i].heavy ? 0 : pos[j].heavy ? 1 : 0.5;
    pos[i].x -= (dx / d) * push * wi; pos[i].z -= (dz / d) * push * wi;
    pos[j].x += (dx / d) * push * (1 - wi); pos[j].z += (dz / d) * push * (1 - wi);
    moved = true;
  };
  // Small sets: all pairs. Large sets (thousands of topics): a uniform grid.
  const grid = n > 64 ? new PointGrid() : null;
  const flat = grid ? new Float64Array(n * 3) : null;
  const maxDisc = Math.max(0, ...discs.map(d => d.radius));
  for (let iteration = 0; iteration < 400; iteration++) {
    moved = false;
    if (grid && flat) {
      for (let i = 0; i < n; i++) { flat[i * 3] = pos[i].x; flat[i * 3 + 2] = pos[i].z; }
      grid.build(flat, n, 2 * maxDisc + gap);
      grid.forEachPair(n, 64, resolve);
    } else {
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) resolve(i, j);
    }
    if (!moved) break;
  }
  return new Map(discs.map((d, i) => [d.id, { x: pos[i].x, z: pos[i].z }]));
}

/** Default centres for clusters around a ring (variable radii, document order). */
export function ringPlacement(radii: number[], gap: number): { x: number; z: number }[] {
  const n = radii.length;
  if (n === 0) return [];
  if (n === 1) return [{ x: 0, z: 0 }];
  // Arc needed between neighbours, then a ring radius that fits all arcs.
  const arcs = radii.map((r, i) => r + radii[(i + 1) % n] + gap);
  const circumference = arcs.reduce((a, b) => a + b, 0);
  let R = Math.max(circumference / (2 * Math.PI), ...radii.map(r => r * 1.2));
  if (n === 2) R = (radii[0] + radii[1] + gap) / 2;
  const out: { x: number; z: number }[] = [];
  let angle = -Math.PI / 2;
  for (let i = 0; i < n; i++) {
    out.push({ x: Math.cos(angle) * R, z: Math.sin(angle) * R });
    angle += (arcs[i] / circumference) * Math.PI * 2;
  }
  return out;
}

export interface Box { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }

export function emptyBox(): Box { return { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity }; }

export function growBox(b: Box, x: number, y: number, z: number, r: number): void {
  b.minX = Math.min(b.minX, x - r); b.maxX = Math.max(b.maxX, x + r);
  b.minY = Math.min(b.minY, y - r); b.maxY = Math.max(b.maxY, y + r);
  b.minZ = Math.min(b.minZ, z - r); b.maxZ = Math.max(b.maxZ, z + r);
}

export interface Placement { x: number; y: number; z: number }

/**
 * Shelf-pack rectangles (width x depth) in order into rows of roughly square
 * overall shape. Returns the min corner of every rectangle.
 */
export function shelfPack(sizes: { w: number; d: number }[], aspect = 1.2): { x: number; z: number; width: number; depth: number }[] & { width?: number; depth?: number } {
  const area = sizes.reduce((s, r) => s + r.w * r.d, 0);
  const widest = sizes.reduce((m, r) => Math.max(m, r.w), 0);
  const target = Math.max(widest, Math.sqrt(area * aspect));
  const out: { x: number; z: number; width: number; depth: number }[] = [];
  let x = 0, z = 0, rowDepth = 0, width = 0;
  for (const s of sizes) {
    if (x > 0 && x + s.w > target * 1.0001) { z += rowDepth; x = 0; rowDepth = 0; }
    out.push({ x, z, width: s.w, depth: s.d });
    x += s.w;
    width = Math.max(width, x);
    rowDepth = Math.max(rowDepth, s.d);
  }
  const result = out as ReturnType<typeof shelfPack>;
  result.width = width;
  result.depth = z + rowDepth;
  return result;
}

/** Positions of a local radial tree around `root` in the x-z plane (relative offsets). */
export function radialDisc(root: LayoutNode, h: Hierarchy, options: LayoutOptions, drop: number): { offsets: Map<string, Vec3>; radius: number } {
  const offsets = new Map<string, Vec3>([[root.id, { x: 0, y: 0, z: 0 }]]);
  const sGap = siblingGap(options);
  // Order of the subtree and depth relative to root.
  const order: LayoutNode[] = [];
  const rel = new Map<string, number>();
  const tails: LayoutNode[] = [];
  const stack: [LayoutNode, number][] = [[root, 0]];
  while (stack.length) {
    const [n, d] = stack.pop()!;
    order.push(n); rel.set(n.id, d);
    // Deeper descendants are folded into a block beside their depth-cap ancestor.
    if (d === DEPTH_CAP && (h.children.get(n.id)?.length ?? 0) > 0) { tails.push(n); continue; }
    const kids = h.children.get(n.id) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], d + 1]);
  }
  if (order.length === 1) return { offsets, radius: root.radius };
  // Space demand of a subtree grows sub-linearly so big branches do not starve small ones.
  const weight = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    const kids = h.children.get(n.id) ?? [];
    weight.set(n.id, Math.max(1, Math.pow(kids.reduce((s, c) => s + (weight.get(c.id) ?? 1), 0), 0.85)));
  }
  const maxDepth = Math.max(...rel.values());
  const maxR = new Array(maxDepth + 1).fill(0);
  for (const n of order) maxR[rel.get(n.id)!] = Math.max(maxR[rel.get(n.id)!], n.radius);
  // Ring radius per relative depth: one level step out, enlarged when the
  // narrowest sector at that depth cannot hold its sphere.
  const sector = new Map<string, [number, number]>([[root.id, [0, Math.PI * 2]]]);
  const ring = new Array(maxDepth + 1).fill(0);
  for (const n of order) {
    const kids = h.children.get(n.id) ?? [];
    if (!kids.length) continue;
    const [a0, a1] = sector.get(n.id)!;
    const total = kids.reduce((s, c) => s + (weight.get(c.id) ?? 1), 0);
    let a = a0;
    for (const c of kids) {
      const w = ((a1 - a0) * (weight.get(c.id) ?? 1)) / total;
      sector.set(c.id, [a, a + w]);
      a += w;
    }
  }
  // A crowded level does not blow up the ring radius: it is split into up to
  // 16 staggered sub-rings (siblings alternate), multiplying the arc length
  // available to each sphere while keeping every branch inside its sector.
  const inner = new Array(maxDepth + 1).fill(0);
  const subRings = new Array(maxDepth + 1).fill(1);
  const subStep = new Array(maxDepth + 1).fill(0);
  for (let d = 1; d <= maxDepth; d++) {
    const base = ring[d - 1] + maxR[d - 1] + maxR[d] + options.gap;
    let need = base;
    for (const n of order) {
      if (rel.get(n.id) !== d) continue;
      const [a0, a1] = sector.get(n.id)!;
      need = Math.max(need, (2 * n.radius + sGap) / Math.max(1e-6, a1 - a0));
    }
    const k = need <= base ? 1 : Math.min(16, Math.ceil(need / base));
    inner[d] = need <= base ? base : Math.max(base, need / k);
    subRings[d] = k;
    subStep[d] = 2 * maxR[d] + sGap * 0.5;
    ring[d] = inner[d] + (k - 1) * subStep[d];
  }
  // Sub-ring stagger follows the angular order of the whole level (not each
  // parent's children), so neighbours across a branch boundary also alternate.
  const ringIndex = new Map<string, number>();
  const byDepth = new Map<number, LayoutNode[]>();
  for (const n of order) { const d = rel.get(n.id)!; if (d > 0) (byDepth.get(d) ?? byDepth.set(d, []).get(d)!).push(n); }
  for (const level of byDepth.values()) {
    const mid = (n: LayoutNode) => { const [a0, a1] = sector.get(n.id)!; return (a0 + a1) / 2; };
    level.sort((p, q) => mid(p) - mid(q)).forEach((n, i) => ringIndex.set(n.id, i));
  }
  let radius = root.radius;
  for (const n of order) {
    const d = rel.get(n.id)!;
    if (d === 0) continue;
    const [a0, a1] = sector.get(n.id)!;
    const angle = (a0 + a1) / 2;
    const R = inner[d] + ((ringIndex.get(n.id) ?? 0) % subRings[d]) * subStep[d];
    offsets.set(n.id, { x: Math.cos(angle) * R, y: -d * drop, z: Math.sin(angle) * R });
    radius = Math.max(radius, R + n.radius);
  }
  for (const anchor of tails) {
    const a = offsets.get(anchor.id)!;
    const len = Math.hypot(a.x, a.z) || 1;
    const u = { x: a.x / len, y: 0, z: a.z / len }, w = { x: -u.z, y: 0, z: u.x };
    const members = descendants(h, anchor);
    const step = 2 * Math.max(...members.map(m => m.radius)) + sGap;
    const block = serpentineBlock(members, u, w, step);
    const start = anchor.radius + options.gap + step / 2;
    members.forEach((m, k) => {
      const o = block.offsets[k];
      offsets.set(m.id, { x: a.x + u.x * start + o.x, y: a.y - drop, z: a.z + u.z * start + o.z });
    });
    radius = Math.max(radius, len + start + block.depth + block.halfWidth);
  }
  return { offsets, radius };
}

/** Depths beyond this are folded into compact blocks by the radial-family layouts. */
export const DEPTH_CAP = 10;

/**
 * Depth used for offsets that grow with depth (indentation, lateral steps):
 * linear up to `knee`, logarithmic beyond, so a 500-level chain stays
 * bounded while ordinary outlines are unaffected.
 */
export function compressedDepth(depth: number, knee = 8): number {
  return depth <= knee ? depth : knee + Math.log2(depth - knee + 1);
}

/**
 * Serpentine block (reading order) for nodes too deep for ring/cone
 * placement. Rows run along `v`, successive rows step along `u`. Returns
 * offsets relative to the block's attachment point and its extent along u.
 */
export function serpentineBlock(members: LayoutNode[], u: Vec3, v: Vec3, step: number): { offsets: Vec3[]; depth: number; halfWidth: number } {
  const perRow = Math.max(1, Math.ceil(Math.sqrt(members.length)));
  const offsets = members.map((_, k) => {
    const row = Math.floor(k / perRow), col = k % perRow;
    const along = (row % 2 === 0 ? col : perRow - 1 - col) - (perRow - 1) / 2;
    return { x: u.x * row * step + v.x * along * step, y: u.y * row * step + v.y * along * step, z: u.z * row * step + v.z * along * step };
  });
  return { offsets, depth: Math.ceil(members.length / perRow) * step, halfWidth: ((perRow - 1) / 2) * step };
}

/** Descendants of `anchor` in pre-order (excluding the anchor). */
export function descendants(h: Hierarchy, anchor: LayoutNode): LayoutNode[] {
  const out: LayoutNode[] = [];
  const stack = [...(h.children.get(anchor.id) ?? [])].reverse();
  while (stack.length) {
    const n = stack.pop()!;
    out.push(n);
    const kids = h.children.get(n.id) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}
