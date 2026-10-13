// Layouts whose primary reading is the parent-child structure.
import { buildHierarchy, type Hierarchy } from './hierarchy';
import { arrangeDiscs, DEPTH_CAP, descendants, emptyBox, growBox, radialDisc, ringPlacement, serpentineBlock, shelfPack, siblingGap, type Box } from './common';
import type { ArrangementMemory, LayoutNode, LayoutOptions, LayoutResult, Vec3 } from './types';

/** Single-child runs at least this long are folded into serpentine columns. */
export const CHAIN_FOLD_MIN = 12;
const CHAIN_ROWS = 8;

function place(h: Hierarchy, rootPositions: Map<string, Vec3>, offsets: Map<string, Vec3>): void {
  for (const root of h.roots) {
    const p = rootPositions.get(root.id) ?? { x: 0, y: 0, z: 0 };
    root.x = p.x; root.y = p.y; root.z = p.z;
  }
  for (const node of h.order) {
    for (const child of h.children.get(node.id) ?? []) {
      const o = offsets.get(child.id) ?? { x: 0, y: 0, z: 0 };
      child.x = node.x + o.x; child.y = node.y + o.y; child.z = node.z + o.z;
    }
  }
}

/** The single-child run that starts at `head` (inclusive), if it is long enough to fold. */
function chainFrom(h: Hierarchy, head: LayoutNode): LayoutNode[] | null {
  const parent = head.parentId ? h.byId.get(head.parentId) : null;
  if (parent && (h.children.get(parent.id)?.length ?? 0) === 1) return null; // not the start of the run
  const run = [head];
  let node = head;
  while ((h.children.get(node.id)?.length ?? 0) === 1) {
    node = h.children.get(node.id)![0];
    run.push(node);
  }
  return run.length >= CHAIN_FOLD_MIN ? run : null;
}

function unionShifted(target: Box, b: Box, dx: number, dy: number, dz: number): void {
  target.minX = Math.min(target.minX, b.minX + dx); target.maxX = Math.max(target.maxX, b.maxX + dx);
  target.minY = Math.min(target.minY, b.minY + dy); target.maxY = Math.max(target.maxY, b.maxY + dy);
  target.minZ = Math.min(target.minZ, b.minZ + dz); target.maxZ = Math.max(target.maxZ, b.maxZ + dz);
}

/**
 * Hierarchy tree. Every subtree has a footprint in the x-z plane; children's
 * footprints are shelf-packed (document order) under their parent, so wide
 * sibling lists wrap into rows instead of becoming one enormous line. Long
 * single-child chains fold into serpentine columns.
 */
export function layoutTree(nodes: LayoutNode[], options: LayoutOptions): LayoutResult {
  const h = buildHierarchy(nodes);
  const sGap = siblingGap(options);
  const offsets = new Map<string, Vec3>();
  const boxes = new Map<string, Box>();
  for (let i = h.order.length - 1; i >= 0; i--) {
    const v = h.order[i];
    const box = emptyBox();
    growBox(box, 0, 0, 0, v.radius);
    const run = chainFrom(h, v);
    if (run) {
      // Serpentine: down a column, up the next, keeping consecutive nodes adjacent.
      const maxR = Math.max(...run.map(n => n.radius));
      const rowStep = 2 * maxR + Math.max(sGap, options.gap * 0.5);
      const colStep = 2 * maxR + sGap * 2;
      const rel: Vec3[] = run.map((_, k) => {
        const col = Math.floor(k / CHAIN_ROWS), r = k % CHAIN_ROWS;
        const row = col % 2 === 0 ? r : CHAIN_ROWS - 1 - r;
        return { x: col * colStep, y: -row * rowStep, z: 0 };
      });
      for (let k = 1; k < run.length; k++) {
        offsets.set(run[k].id, { x: rel[k].x - rel[k - 1].x, y: rel[k].y - rel[k - 1].y, z: 0 });
      }
      for (let k = 0; k < run.length; k++) growBox(box, rel[k].x, rel[k].y, rel[k].z, run[k].radius);
      // The tail's own children hang below the whole folded block.
      const tail = run[run.length - 1];
      const tailBox = boxes.get(tail.id)!;
      const bottom = -(Math.min(run.length, CHAIN_ROWS) - 1) * rowStep;
      const extra = rel[run.length - 1].y - bottom;
      for (const c of h.children.get(tail.id) ?? []) { const o = offsets.get(c.id)!; o.y -= extra; }
      unionShifted(box, tailBox, rel[run.length - 1].x, rel[run.length - 1].y - extra, 0);
      boxes.set(v.id, box);
      continue;
    }
    const kids = h.children.get(v.id) ?? [];
    if (kids.length) {
      const maxChild = Math.max(...kids.map(c => c.radius));
      const drop = v.radius + maxChild + options.gap;
      const sizes = kids.map(c => { const b = boxes.get(c.id)!; return { w: b.maxX - b.minX + sGap, d: b.maxZ - b.minZ + sGap }; });
      const packed = shelfPack(sizes);
      const cx = (packed.width ?? 0) / 2, cz = (packed.depth ?? 0) / 2;
      kids.forEach((c, k) => {
        const b = boxes.get(c.id)!;
        const slot = packed[k];
        const ox = slot.x + sGap / 2 - b.minX - cx;
        const oz = slot.z + sGap / 2 - b.minZ - cz;
        offsets.set(c.id, { x: ox, y: -drop, z: oz });
        unionShifted(box, b, ox, -drop, oz);
      });
    }
    boxes.set(v.id, box);
  }
  // Forest: pack top-level subtrees in document order.
  const sizes = h.roots.map(r => { const b = boxes.get(r.id)!; return { w: b.maxX - b.minX + options.gap, d: b.maxZ - b.minZ + options.gap }; });
  const packed = shelfPack(sizes, 1.6);
  const rootPositions = new Map<string, Vec3>();
  h.roots.forEach((r, k) => {
    const b = boxes.get(r.id)!;
    rootPositions.set(r.id, { x: packed[k].x + options.gap / 2 - b.minX - (packed.width ?? 0) / 2, y: 0, z: packed[k].z + options.gap / 2 - b.minZ - (packed.depth ?? 0) / 2 });
  });
  place(h, rootPositions, offsets);
  return {};
}

function forestWithVirtualRoot(nodes: LayoutNode[]): { all: LayoutNode[]; virtual: LayoutNode | null } {
  const ids = new Set(nodes.map(n => n.id));
  const roots = nodes.filter(n => !n.parentId || !ids.has(n.parentId) || n.parentId === n.id);
  if (roots.length <= 1) return { all: nodes, virtual: null };
  const virtual: LayoutNode = { id: '\u0000centre', parentId: null, depth: -1, ring: 0, order: -1, childCount: roots.length, radius: 0.1, anchor: null, x: 0, y: 0, z: 0 };
  const rewired = new Map(roots.map(r => [r.id, virtual.id]));
  // Lay out over shallow copies so the virtual parent never leaks into the caller's nodes.
  const copies = nodes.map(n => ({ ...n, parentId: rewired.get(n.id) ?? n.parentId }));
  return { all: [virtual, ...copies], virtual };
}

/**
 * Radial tree: sectors sized by subtree demand, ring radii large enough that
 * the narrowest sector at each depth holds its sphere; a gentle downward cone
 * by depth gives a 3D cue without hiding the rings when viewed from above.
 */
export function layoutRadial(nodes: LayoutNode[], options: LayoutOptions): LayoutResult {
  if (!nodes.length) return {};
  const { all, virtual } = forestWithVirtualRoot(nodes);
  const h = buildHierarchy(all);
  const root = virtual ?? h.roots[0];
  const step = options.gap + 2 * Math.max(...nodes.map(n => n.radius));
  const disc = radialDisc(root, h, options, step * 0.22);
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const [id, o] of disc.offsets) {
    const n = byId.get(id);
    if (n) { n.x = o.x; n.y = o.y; n.z = o.z; }
  }
  // Any node outside the main tree (second component) is laid out as its own disc.
  for (const extra of h.roots) {
    if (extra === root) continue;
    const local = radialDisc(extra, h, options, step * 0.22);
    for (const [id, o] of local.offsets) { const n = byId.get(id); if (n) { n.x = o.x + disc.radius * 2; n.y = o.y; n.z = o.z; } }
  }
  return {};
}

/**
 * Cone tree (Robertson et al.): each parent sits at the apex of a cone whose
 * base circle holds its children, sized bottom-up from the children's own
 * cone footprints. Top-level cones are arranged around a ring.
 */
export function layoutCone(nodes: LayoutNode[], options: LayoutOptions, memory?: ArrangementMemory): LayoutResult {
  const h = buildHierarchy(nodes);
  const sGap = siblingGap(options);
  const foot = new Map<string, number>();
  const offsets = new Map<string, Vec3>();
  for (let i = h.order.length - 1; i >= 0; i--) {
    const v = h.order[i];
    const kids = h.children.get(v.id) ?? [];
    if (!kids.length) { foot.set(v.id, v.radius); continue; }
    const drop = v.radius + Math.max(...kids.map(c => c.radius)) + options.gap;
    if (h.depth.get(v.id) === DEPTH_CAP) {
      // Very deep remainder: a reading-order block in the plane below the node.
      const members = descendants(h, v);
      const step = 2 * Math.max(...members.map(m => m.radius)) + sGap;
      const block = serpentineBlock(members, { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 }, step);
      const rel = new Map<string, Vec3>([[v.id, { x: 0, y: 0, z: 0 }]]);
      members.forEach((m, k) => rel.set(m.id, { x: block.offsets[k].x, y: -drop, z: block.offsets[k].z - block.depth / 2 }));
      for (const m of members) {
        const p = rel.get(m.parentId!)!, q = rel.get(m.id)!;
        offsets.set(m.id, { x: q.x - p.x, y: q.y - p.y, z: q.z - p.z });
      }
      foot.set(v.id, Math.max(v.radius, Math.hypot(block.halfWidth, block.depth / 2) + step / 2));
      continue;
    }
    if (kids.length === 1) {
      offsets.set(kids[0].id, { x: 0, y: -drop, z: 0 });
      foot.set(v.id, Math.max(v.radius, foot.get(kids[0].id)!));
      continue;
    }
    const f = kids.map(c => foot.get(c.id)!);
    const demand = f.map(r => 2 * r + sGap);
    const total = demand.reduce((a, b) => a + b, 0);
    let R = total / (2 * Math.PI);
    // Neighbouring footprints must not intersect along the chord.
    for (let k = 0; k < kids.length; k++) {
      const j = (k + 1) % kids.length;
      const theta = ((demand[k] + demand[j]) / 2 / total) * Math.PI * 2;
      R = Math.max(R, (f[k] + f[j] + sGap) / (2 * Math.max(1e-3, Math.sin(Math.min(Math.PI / 2, theta / 2)))));
    }
    let angle = 0;
    kids.forEach((c, k) => {
      const share = (demand[k] / total) * Math.PI * 2;
      const a = angle + share / 2;
      angle += share;
      offsets.set(c.id, { x: Math.cos(a) * R, y: -drop, z: Math.sin(a) * R });
    });
    foot.set(v.id, R + Math.max(...f));
  }
  const radii = h.roots.map(r => foot.get(r.id)!);
  const preferred = ringPlacement(radii, options.gap * 2);
  const placed = arrangeDiscs(h.roots.map((r, k) => ({ id: r.id, radius: radii[k], preferred: preferred[k] })), options.gap * 2, memory);
  const rootPositions = new Map<string, Vec3>();
  const chapters: ArrangementMemory = new Map();
  h.roots.forEach((r, k) => { const p = placed.get(r.id)!; rootPositions.set(r.id, { x: p.x, y: 0, z: p.z }); chapters.set(r.id, { x: p.x, y: 0, z: p.z, radius: radii[k] }); });
  place(h, rootPositions, offsets);
  return { chapters };
}
