// Experimental visual motifs from 1.x (molecular bond angles, muscle fibres,
// shells, lattices, ...). They arrange nodes by shape, not by meaning, and
// are offered in a separate "Experimental" submenu. Ported from the recovered
// 1.15 implementation with every recursion made iterative (deep outlines no
// longer risk stack overflow); where the original depended on recursion order
// (coil, lattice, hub) the call order is emulated so shapes are unchanged.
import { buildHierarchy, type Hierarchy } from './hierarchy';
import { linkLength } from './common';
import type { LayoutNode, LayoutOptions, LayoutResult, Vec3 } from './types';

const SR = Math.PI * (3 - Math.sqrt(5));
type V = Vec3;
const v = (x: number, y: number, z: number): V => ({ x, y, z });
const add = (a: V, b: V): V => v(a.x + b.x, a.y + b.y, a.z + b.z);
const mul = (a: V, k: number): V => v(a.x * k, a.y * k, a.z * k);
const dot = (a: V, b: V) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V, b: V): V => v(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const norm = (a: V): V => { const l = Math.hypot(a.x, a.y, a.z) || 1; return v(a.x / l, a.y / l, a.z / l); };
const setPos = (n: LayoutNode, p: V) => { n.x = p.x; n.y = p.y; n.z = p.z; };
const posOf = (n: LayoutNode): V => v(n.x, n.y, n.z);

function frame(d: V): { u: V; w: V } {
  const up = Math.abs(d.y) < 0.9 ? v(0, 1, 0) : v(1, 0, 0);
  const u = norm(cross(up, d));
  return { u, w: cross(d, u) };
}

function fibonacciSphere(n: number): V[] {
  const out: V[] = [];
  for (let i = 0; i < n; i++) {
    const y = n === 1 ? 0 : 1 - (2 * i) / (n - 1);
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    out.push(norm(v(Math.cos(SR * i) * r, y, Math.sin(SR * i) * r)));
  }
  return out;
}

/** Rodrigues rotation of `p` around unit `axis` by `angle`. */
function rotate(p: V, axis: V, angle: number): V {
  const c = Math.cos(angle), s = Math.sin(angle);
  return add(add(mul(p, c), mul(axis, dot(axis, p) * (1 - c))), mul(cross(axis, p), s));
}

function fnv(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 1831565813) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function polyhedron(count: number): V[] {
  const e = 1 / Math.sqrt(3);
  switch (count) {
    case 1: return [v(0, 0, 1)];
    case 2: return [v(0, 0, 1), v(0, 0, -1)];
    case 3: return [v(1, 0, 0), v(-0.5, Math.sqrt(3) / 2, 0), v(-0.5, -Math.sqrt(3) / 2, 0)];
    case 4: return [v(e, e, e), v(e, -e, -e), v(-e, e, -e), v(-e, -e, e)];
    case 5: return [v(1, 0, 0), v(-0.5, Math.sqrt(3) / 2, 0), v(-0.5, -Math.sqrt(3) / 2, 0), v(0, 0, 1), v(0, 0, -1)];
    case 6: return [v(1, 0, 0), v(-1, 0, 0), v(0, 1, 0), v(0, -1, 0), v(0, 0, 1), v(0, 0, -1)];
    default: return fibonacciSphere(count);
  }
}

function rotationBetween(a: V, b: V): (p: V) => V {
  const d = dot(a, b);
  if (d > 0.999999) return p => p;
  if (d < -0.999999) { const axis = norm(frame(a).u); return p => rotate(p, axis, Math.PI); }
  const axis = norm(cross(a, b));
  const angle = Math.acos(Math.max(-1, Math.min(1, d)));
  return p => rotate(p, axis, angle);
}

/** Bond directions (VSEPR polyhedron) for `count` children, one vertex facing back. */
function bondDirections(incoming: V, count: number, twist: number): V[] {
  if (count <= 0) return [];
  const back = norm(mul(incoming, -1));
  const poly = polyhedron(count + 1);
  let backIndex = 0;
  for (let i = 1; i < poly.length; i++) if (dot(poly[i], back) > dot(poly[backIndex], back)) backIndex = i;
  const r = rotationBetween(poly[backIndex], back);
  const out: V[] = [];
  poly.forEach((p, i) => { if (i !== backIndex) out.push(norm(rotate(r(p), back, twist))); });
  return out;
}

interface Ctx { h: Hierarchy; ld: number; levelGap: number; spread: number; nodes: LayoutNode[] }
const kids = (c: Ctx, n: LayoutNode) => c.h.children.get(n.id) ?? [];
const roots = (c: Ctx) => c.h.roots.filter(r => !r.anchor);
const level = (c: Ctx, n: LayoutNode) => (c.h.depth.get(n.id) ?? 0) + 1;

/** Roots on a Fibonacci sphere (a single root sits at the origin facing up). */
function placeRoots(c: Ctx, list: LayoutNode[], radius: number): V[] {
  const dirs = fibonacciSphere(Math.max(1, list.length));
  const single = list.length === 1 && !c.nodes.some(n => n.anchor);
  return list.map((n, i) => {
    if (single) { setPos(n, v(0, 0, 0)); return v(0, 1, 0); }
    setPos(n, mul(dirs[i], radius));
    return norm(dirs[i]);
  });
}

function byLevel(c: Ctx): Map<number, LayoutNode[]> {
  const map = new Map<number, LayoutNode[]>();
  for (const n of c.h.order) { if (n.anchor) continue; const l = level(c, n); const list = map.get(l); if (list) list.push(n); else map.set(l, [n]); }
  return map;
}
const parentAngle = (c: Ctx, n: LayoutNode) => { const p = n.parentId ? c.h.byId.get(n.parentId) : undefined; return p ? Math.atan2(p.z, p.x) : 0; };
const sortByParentAngle = (c: Ctx, list: LayoutNode[]) => [...list].sort((a, b) => parentAngle(c, a) - parentAngle(c, b));
const circle = (count: number, index: number, offset = 0) => { const a = offset + (index * Math.PI * 2) / Math.max(1, count); return { cx: Math.cos(a), cz: Math.sin(a) }; };

const motifs: Record<string, (c: Ctx) => void> = {
  disk(c) {
    const levels = byLevel(c);
    for (const l of [...levels.keys()].sort((a, b) => a - b)) {
      const list = sortByParentAngle(c, levels.get(l)!);
      const R = c.ld * Math.sqrt(l) * 1.9;
      list.forEach((n, i) => { const { cx, cz } = circle(list.length, i, l * 0.9); setPos(n, v(cx * R, ((i % 5) - 2) * c.ld * 0.06, cz * R)); });
    }
  },
  rays(c) {
    const list = roots(c);
    const dirs = placeRoots(c, list, c.ld);
    const s = c.ld * 0.22;
    list.forEach((root, k) => {
      const dir = norm(dirs[k]);
      const { u, w } = frame(dir);
      const stack = [root];
      while (stack.length) {
        const d = stack.pop()!;
        kids(c, d).forEach((m, f) => {
          const a = f * 2.399963;
          const off = mul(add(mul(u, Math.cos(a)), mul(w, Math.sin(a))), s * (f === 0 ? 0 : Math.min(3, f)));
          setPos(m, add(posOf(d), add(mul(dir, c.ld), off)));
          stack.push(m);
        });
      }
    });
  },
  slabs(c) {
    const levels = byLevel(c);
    const gap = c.ld * 0.9;
    for (const l of levels.keys()) {
      const list = sortByParentAngle(c, levels.get(l)!);
      const cols = Math.max(1, Math.ceil(Math.sqrt(list.length)));
      list.forEach((n, i) => {
        const row = Math.floor(i / cols), col = i % cols, x = row % 2 === 0 ? col : cols - 1 - col;
        setPos(n, v((x - (cols - 1) / 2) * gap, -l * c.levelGap, (row - (cols - 1) / 2) * gap));
      });
    }
  },
  curtain(c) {
    const list = roots(c);
    const step = c.ld * 1.6;
    list.forEach((root, o) => {
      const x = (o - (list.length - 1) / 2) * step;
      setPos(root, v(x, 0, 0));
      const stack: [LayoutNode, number, number][] = [[root, 0, 0]];
      while (stack.length) {
        const [node, u, h] = stack.pop()!;
        const ks = kids(c, node);
        ks.forEach((g, i) => {
          setPos(g, v(x, -(u + 1) * c.levelGap * 0.8, h + (i - (ks.length - 1) / 2) * c.ld * 0.7));
          stack.push([g, u + 1, h + (i - (ks.length - 1) / 2) * c.ld * 0.35]);
        });
      }
    });
  },
  dandelion(c) {
    const list = roots(c);
    const dirs = placeRoots(c, list, c.ld * 2.2);
    list.forEach((root, k) => {
      const stack: [LayoutNode, V, number][] = [[root, dirs[k], 0]];
      while (stack.length) {
        const [e, t, r] = stack.pop()!;
        const ks = kids(c, e);
        if (!ks.length) continue;
        const o = c.ld * Math.max(0.55, 1 - r * 0.08);
        const a = fibonacciSphere(ks.length);
        const { u: hx, w: dz } = frame(t);
        ks.forEach((child, i) => {
          const d = r === 0 ? norm(add(add(mul(t, a[i].y), mul(hx, a[i].x)), mul(dz, a[i].z))) : norm(a[i]);
          setPos(child, add(posOf(e), mul(d, o)));
          stack.push([child, d, r + 1]);
        });
      }
    });
  },
  nebula(c) {
    const list = roots(c);
    const dirs = placeRoots(c, list, c.ld * 3);
    list.forEach((root, k) => {
      const a = norm(dirs[k]);
      const { u: fu, w: fw } = frame(a);
      const stack: [LayoutNode, number][] = [[root, 0]];
      while (stack.length) {
        const [node, u] = stack.pop()!;
        for (const p of kids(c, node)) {
          const g = rng(fnv(p.id));
          const th = g() * Math.PI * 2, ph = Math.acos(2 * g() - 1);
          const f = c.ld * (0.7 + u * 0.45) * (0.6 + g() * 0.6);
          const m = norm(v(Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)));
          const s = norm(add(add(mul(a, m.y), mul(fu, m.x)), mul(fw, m.z)));
          setPos(p, add(posOf(node), mul(s, f)));
          stack.push([p, u + 1]);
        }
      }
    });
  },
  grid(c) {
    const list = c.h.order.filter(n => !n.anchor);
    const k = Math.max(1, Math.ceil(Math.cbrt(list.length)));
    const gap = c.ld * 0.9;
    list.forEach((n, i) => setPos(n, v((i % k - (k - 1) / 2) * gap, (Math.floor(i / k) % k - (k - 1) / 2) * gap, (Math.floor(i / (k * k)) - (k - 1) / 2) * gap)));
  },
  scatter(c) {
    for (const n of c.h.order) {
      if (n.anchor) continue;
      const r = rng(fnv(n.id));
      const s = r() * Math.PI * 2, o = Math.acos(2 * r() - 1), a = c.ld * (1 + level(c, n) * 1.15) * (0.75 + r() * 0.5);
      setPos(n, v(Math.sin(o) * Math.cos(s) * a, Math.cos(o) * a * 0.75, Math.sin(o) * Math.sin(s) * a));
    }
  },
  hub(c) {
    const list = roots(c);
    const R = c.ld * 3;
    list.forEach((root, o) => {
      const { cx, cz } = circle(list.length, o);
      setPos(root, v(cx * R, 0, cz * R));
      const dir = norm(v(cx, 0, cz));
      const { u: fu, w: fw } = frame(dir);
      // The original advanced one shared counter per visited node and read it
      // while placing each sibling, after the previous sibling's subtree was
      // visited; frames reproduce that order.
      let counter = 0;
      interface F { d: LayoutNode; ks: LayoutNode[]; g: number; i: number }
      const enter = (d: LayoutNode): F => { counter++; return { d, ks: kids(c, d), g: c.ld * Math.max(0.5, 1.6 - counter * 0.35), i: 0 }; };
      const frames: F[] = [enter(root)];
      while (frames.length) {
        const f = frames[frames.length - 1];
        if (f.i >= f.ks.length) { frames.pop(); continue; }
        const index = f.i++;
        const m = f.ks[index];
        const p = circle(f.ks.length, index, counter * 0.7);
        setPos(m, add(posOf(f.d), add(mul(fu, p.cx * f.g), mul(fw, p.cz * f.g))));
        frames.push(enter(m));
      }
    });
  },
  bond(c) {
    const list = roots(c);
    const dirs = placeRoots(c, list, c.ld);
    list.forEach((root, k) => {
      const stack: [LayoutNode, V, number][] = [[root, dirs[k], 0]];
      while (stack.length) {
        const [t, n, s] = stack.pop()!;
        const ks = kids(c, t);
        const a = bondDirections(n, ks.length, s * SR);
        ks.forEach((child, u) => { setPos(child, add(posOf(t), mul(a[u], c.ld))); stack.push([child, a[u], s + 1]); });
      }
    });
  },
  orbital(c) {
    const list = roots(c);
    const dirs = placeRoots(c, list, c.ld);
    list.forEach((root, k) => {
      const stack: [LayoutNode, V, number][] = [[root, dirs[k], 0]];
      while (stack.length) {
        const [t, n, s] = stack.pop()!;
        const ks = kids(c, t);
        if (!ks.length) continue;
        const a = norm(n);
        const { u: l, w } = frame(a);
        const lobes = [a, mul(a, -1), l, mul(l, -1), w, mul(w, -1)];
        const dirs2 = ks.length <= lobes.length ? lobes.slice(0, ks.length) : bondDirections(a, ks.length, s * SR);
        ks.forEach((child, g) => { setPos(child, add(posOf(t), mul(dirs2[g], c.ld))); stack.push([child, dirs2[g], s + 1]); });
      }
    });
  },
  coil(c) {
    const list = roots(c);
    const dirs = placeRoots(c, list, c.ld);
    const placed: V[] = [];
    const maxBend = (52 * Math.PI) / 180;
    // Frames emulate the original recursion: a child's subtree is grown
    // before the next sibling is placed (self-avoidance sees it).
    interface F { t: LayoutNode; n: V; s: number; ks: LayoutNode[]; dirs: V[]; r: () => number; i: number }
    list.forEach((root, k) => {
      const enter = (t: LayoutNode, n: V, s: number): F | null => {
        const ks = kids(c, t);
        if (!ks.length) return null;
        placed.push(posOf(t));
        return { t, n, s, ks, dirs: ks.length > 1 ? bondDirections(n, ks.length, s * SR) : [], r: rng(fnv(t.id)), i: 0 };
      };
      const frames: F[] = [];
      const first = enter(root, dirs[k], 0);
      if (first) frames.push(first);
      while (frames.length) {
        const f = frames[frames.length - 1];
        if (f.i >= f.ks.length) { frames.pop(); continue; }
        const index = f.i++;
        const h = f.ks[index];
        let p: V;
        if (index === 0) {
          const { u, w } = frame(f.n);
          const bend = maxBend * (f.r() * 2 - 1), turn = f.r() * Math.PI * 2;
          p = norm(rotate(f.n, norm(add(u, mul(w, Math.sin(turn)))), bend));
        } else p = f.dirs[index] ?? f.n;
        let best = p, bestDist = -1;
        for (let k2 = 0; k2 < 6; k2++) {
          const m = k2 === 0 ? p : norm(rotate(p, f.n, (k2 * Math.PI) / 3));
          const cand = add(posOf(f.t), mul(m, c.ld));
          let closest = Infinity;
          for (const q of placed) closest = Math.min(closest, Math.hypot(cand.x - q.x, cand.y - q.y, cand.z - q.z));
          if (closest > bestDist) { bestDist = closest; best = m; }
          if (closest > c.ld * 0.9) break;
        }
        setPos(h, add(posOf(f.t), mul(best, c.ld)));
        const next = enter(h, best, f.s + 1);
        if (next) frames.push(next);
      }
    });
  },
  lattice(c) {
    const ld = c.ld / Math.sqrt(3);
    const tetra = [v(1, 1, 1), v(1, -1, -1), v(-1, 1, -1), v(-1, -1, 1)];
    const second: V[] = [];
    for (const a of tetra) for (const b of tetra) { const p = add(a, b); if ((p.x || p.y || p.z) && !second.some(q => q.x === p.x && q.y === p.y && q.z === p.z)) second.push(p); }
    const key = (p: V) => `${p.x},${p.y},${p.z}`;
    const used = new Set<string>();
    const list = c.h.roots;
    const dirs = fibonacciSphere(Math.max(1, list.length));
    const single = list.length === 1 && !c.nodes.some(n => n.anchor);
    interface F { node: LayoutNode; cell: V; parity: number; parentKey: string; ks: LayoutNode[]; i: number; preferred: V[]; fallback: V[]; bonds: V[] }
    const enter = (node: LayoutNode, cell: V, parity: number, parent: V | null): F | null => {
      used.add(key(cell));
      setPos(node, mul(cell, ld));
      const ks = kids(c, node);
      if (!ks.length) return null;
      const sign = parity === 0 ? 1 : -1;
      const bonds = tetra.map(t => mul(t, sign));
      const parentKey = parent ? key(parent) : '';
      return { node, cell, parity, parentKey, ks, i: 0, bonds,
        preferred: bonds.filter(b => !used.has(key(add(cell, b))) && key(add(cell, b)) !== parentKey),
        fallback: second.filter(b => !used.has(key(add(cell, b)))) };
    };
    list.forEach((root, d) => {
      const start = single ? v(0, 0, 0) : v(Math.round(dirs[d].x * (10 + 6 * d)), Math.round(dirs[d].y * (10 + 6 * d)), Math.round(dirs[d].z * (10 + 6 * d)));
      const frames: F[] = [];
      const first = enter(root, start, 0, null);
      if (first) frames.push(first);
      while (frames.length) {
        const f = frames[frames.length - 1];
        if (f.i >= f.ks.length) { frames.pop(); continue; }
        const y = f.i++;
        const child = f.ks[y];
        const step = f.preferred[y] ?? f.fallback[y - f.preferred.length] ?? f.bonds[y % f.bonds.length];
        const cell = add(f.cell, step);
        if (used.has(key(cell))) { setPos(child, mul(cell, ld)); continue; }
        const next = enter(child, cell, 1 - f.parity, f.cell);
        if (next) frames.push(next);
      }
    });
  },
  pennate(c) {
    const list = roots(c);
    const dirs = placeRoots(c, list, c.ld);
    const angle = (25 * Math.PI) / 180;
    list.forEach((root, k) => {
      const stack: [LayoutNode, V, number, number][] = [[root, dirs[k], c.ld, 0]];
      while (stack.length) {
        const [t, n, r, s] = stack.pop()!;
        const ks = kids(c, t);
        if (!ks.length) continue;
        const weights = ks.map((k2, i) => ({ k: k2, i, w: Math.max(1, c.h.subtree.get(k2.id) ?? 1) })).sort((a, b) => b.w - a.w || a.i - b.i);
        const total = weights.reduce((sum, x) => sum + x.w, 0);
        const { u } = frame(n);
        weights.forEach((d, p) => {
          let g: V, scale: number;
          if (p === 0) { g = n; scale = 1; } else {
            const f = rotate(u, n, (p - 1) * SR + s * 0.6);
            g = norm(rotate(n, f, angle));
            scale = Math.max(0.42, Math.min(1, Math.cbrt(d.w / total)));
          }
          const m = Math.max(r * 0.35, r * scale);
          setPos(d.k, add(posOf(t), mul(g, m)));
          stack.push([d.k, g, m, s + 1]);
        });
      }
    });
  },
  rdf(c) {
    const levels = byLevel(c);
    for (const l of [...levels.keys()].sort((a, b) => a - b)) {
      const list = [...levels.get(l)!].sort((a, b) => {
        const pa = a.parentId ? c.h.byId.get(a.parentId) : undefined, pb = b.parentId ? c.h.byId.get(b.parentId) : undefined;
        const ka = pa ? Math.atan2(pa.z, pa.x) * 1e3 + level(c, pa) * 1e6 : 0, kb = pb ? Math.atan2(pb.z, pb.x) * 1e3 + level(c, pb) * 1e6 : 0;
        return ka - kb;
      });
      const pts = fibonacciSphere(Math.max(1, list.length));
      list.forEach((n, i) => setPos(n, mul(pts[i], l * c.ld)));
    }
  },
  shell(c) {
    const list = c.h.order.filter(n => !n.anchor);
    const shells: LayoutNode[][] = [[]];
    let n = 1, capacity = 2, filled = 0;
    for (const node of list) {
      if (filled >= capacity) { n++; capacity = 2 * n * n; filled = 0; shells.push([]); }
      shells[n - 1].push(node);
      filled++;
    }
    shells.forEach((shell, i) => {
      const R = c.ld * (i + 1) * (i + 1);
      const pts = fibonacciSphere(Math.max(1, shell.length));
      shell.forEach((node, k) => setPos(node, mul(pts[k], R)));
    });
  },
};

export const EXPERIMENTAL_LAYOUTS = Object.keys(motifs);

export function layoutExperimental(kind: string, nodes: LayoutNode[], options: LayoutOptions): LayoutResult {
  const motif = motifs[kind];
  if (!motif || !nodes.length) return {};
  const ld = linkLength(nodes, options);
  for (const n of nodes) if (!n.anchor) { n.x = 0; n.y = 0; n.z = 0; }
  motif({ h: buildHierarchy(nodes), ld, levelGap: ld * (60 / 62), spread: 0.62, nodes });
  return {};
}
