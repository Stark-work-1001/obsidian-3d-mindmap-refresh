// Study layouts. Positions communicate the note's structure and reading
// order only; nearness never implies a semantic or prerequisite relation.
import { buildHierarchy } from './hierarchy';
import { arrangeDiscs, compressedDepth, GOLDEN_ANGLE, medianRadius, radialDisc, ringPlacement, shelfPack, siblingGap } from './common';
import type { ArrangementMemory, LayoutNode, LayoutOptions, LayoutResult, Vec3 } from './types';

/**
 * Knowledge constellation: one cluster per chapter. Topics (the chapter's
 * children) sit on a ring around the chapter; each topic's own branch is a
 * small radial disc, so a branch stays together and its edges stay short.
 * Clusters are arranged around a ring (or a sunflower spiral when there are
 * many) and remembered between edits.
 */
export function layoutKnowledge(nodes: LayoutNode[], options: LayoutOptions, memory?: ArrangementMemory): LayoutResult {
  const h = buildHierarchy(nodes);
  if (!nodes.length) return {};
  const sGap = siblingGap(options);
  const step = options.gap + 2 * medianRadius(nodes);
  const drop = step * 0.16;
  const local = new Map<string, Map<string, Vec3>>();
  const clusterRadius: number[] = [];
  for (const chapter of h.roots) {
    const offsets = new Map<string, Vec3>([[chapter.id, { x: 0, y: step * 0.35, z: 0 }]]);
    const topics = h.children.get(chapter.id) ?? [];
    const discs = topics.map(t => radialDisc(t, h, options, drop));
    let R = 0;
    if (discs.length > 16) {
      // Many topics: a sunflower disc around the chapter instead of one huge ring.
      const meanR = discs.reduce((a, d) => a + d.radius, 0) / discs.length;
      const spacing = 2 * meanR + sGap;
      const inner = chapter.radius + options.gap;
      const placed = arrangeDiscs(topics.map((t, k) => ({
        id: t.id, radius: discs[k].radius,
        preferred: { x: Math.cos(k * GOLDEN_ANGLE) * (inner + spacing * Math.sqrt(k + 1)), z: Math.sin(k * GOLDEN_ANGLE) * (inner + spacing * Math.sqrt(k + 1)) },
      })).concat([{ id: chapter.id, radius: chapter.radius + options.gap * 0.5, preferred: { x: 0, z: 0 } }]), sGap,
      new Map([[chapter.id, { x: 0, y: 0, z: 0, radius: chapter.radius + options.gap * 0.5 }]]));
      topics.forEach((t, k) => {
        const p = placed.get(t.id)!;
        for (const [id, o] of discs[k].offsets) offsets.set(id, { x: p.x + o.x, y: o.y, z: p.z + o.z });
        R = Math.max(R, Math.hypot(p.x, p.z));
      });
      local.set(chapter.id, offsets);
      clusterRadius.push(Math.max(chapter.radius, R + Math.max(...discs.map(d => d.radius))));
      continue;
    }
    if (discs.length === 1) R = chapter.radius + discs[0].radius + options.gap;
    else if (discs.length > 1) {
      const demand = discs.map(d => 2 * d.radius + sGap);
      const total = demand.reduce((a, b) => a + b, 0);
      R = Math.max(total / (2 * Math.PI), chapter.radius + Math.max(...discs.map(d => d.radius)) + options.gap);
      for (let k = 0; k < discs.length; k++) {
        const j = (k + 1) % discs.length;
        const theta = ((demand[k] + demand[j]) / 2 / total) * Math.PI * 2;
        R = Math.max(R, (discs[k].radius + discs[j].radius + sGap) / (2 * Math.max(1e-3, Math.sin(Math.min(Math.PI / 2, theta / 2)))));
      }
      let angle = -Math.PI / 2;
      discs.forEach((d, k) => {
        const share = (demand[k] / total) * Math.PI * 2;
        const a = angle + share / 2;
        angle += share;
        for (const [id, o] of d.offsets) offsets.set(id, { x: Math.cos(a) * R + o.x, y: o.y, z: Math.sin(a) * R + o.z });
      });
    }
    if (discs.length === 1) for (const [id, o] of discs[0].offsets) offsets.set(id, { x: R + o.x, y: o.y, z: o.z });
    local.set(chapter.id, offsets);
    clusterRadius.push(Math.max(chapter.radius, R + (discs.length ? Math.max(...discs.map(d => d.radius)) : 0)));
  }
  const n = h.roots.length;
  let preferred: { x: number; z: number }[];
  if (n <= 16) preferred = ringPlacement(clusterRadius, options.gap * 3);
  else {
    const mean = clusterRadius.reduce((a, b) => a + b, 0) / n;
    preferred = clusterRadius.map((_, k) => ({ x: Math.cos(k * GOLDEN_ANGLE) * (mean * 2.4 + options.gap) * Math.sqrt(k + 0.5), z: Math.sin(k * GOLDEN_ANGLE) * (mean * 2.4 + options.gap) * Math.sqrt(k + 0.5) }));
  }
  const placed = arrangeDiscs(h.roots.map((r, k) => ({ id: r.id, radius: clusterRadius[k], preferred: preferred[k] })), options.gap * 3, memory);
  const chapters: ArrangementMemory = new Map();
  const byId = h.byId;
  h.roots.forEach((chapter, k) => {
    const c = placed.get(chapter.id)!;
    const remembered = memory?.get(chapter.id);
    // A gentle wave in height gives depth cues; remembered clusters keep theirs.
    const lift = remembered ? remembered.y : n > 1 ? Math.sin(Math.atan2(c.z, c.x) * 2) * step * 0.8 : 0;
    chapters.set(chapter.id, { x: c.x, y: lift, z: c.z, radius: clusterRadius[k] });
    for (const [id, o] of local.get(chapter.id)!) {
      const node = byId.get(id);
      if (node) { node.x = c.x + o.x; node.y = lift + o.y; node.z = c.z + o.z; }
    }
  });
  return { chapters };
}

/**
 * Chapter bookshelf: each chapter is an upright page read top to bottom in
 * exact document order, with indentation showing depth (like the outline
 * itself) and a slight recession of deeper items. Long chapters wrap into
 * further columns; books stand side by side on shelves in reading order.
 */
export function layoutBookshelf(nodes: LayoutNode[], options: LayoutOptions): LayoutResult {
  const h = buildHierarchy(nodes);
  if (!nodes.length) return {};
  const books = h.roots.map(chapter => {
    const members: { node: LayoutNode; depth: number }[] = [];
    const stack: [LayoutNode, number][] = [[chapter, 0]];
    while (stack.length) {
      const [node, d] = stack.pop()!;
      members.push({ node, depth: d });
      const kids = h.children.get(node.id) ?? [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], d + 1]);
    }
    const maxR = Math.max(...members.map(m => m.node.radius));
    const maxIndent = Math.max(...members.map(m => compressedDepth(m.depth)));
    const rowStep = Math.max(2 * maxR + Math.max(6, options.gap * 0.25), 18);
    const indent = Math.max(2 * maxR + 4, options.gap * 0.45);
    const colWidth = indent * maxIndent + 2 * maxR + 180;
    // Rows per column chosen so a long chapter forms a page about 1.3x wider than tall.
    const rows = Math.max(8, Math.min(members.length, Math.round(Math.sqrt((members.length * colWidth) / (rowStep * 1.3)))));
    const cols = Math.ceil(members.length / rows);
    return { members, rowStep, indent, rows, colWidth, width: cols * colWidth, height: Math.min(members.length, rows) * rowStep };
  });
  const packed = shelfPack(books.map(b => ({ w: b.width + options.gap * 1.5, d: b.height + options.gap * 2.5 })), 1.7);
  const zStep = options.gap * 0.35;
  const chapters = new Map<string, Vec3>();
  books.forEach((book, k) => {
    const left = packed[k].x - (packed.width ?? 0) / 2;
    const top = -(packed[k].z - (packed.depth ?? 0) / 2);
    book.members.forEach(({ node, depth }, i) => {
      const col = Math.floor(i / book.rows), row = i % book.rows;
      node.x = left + col * book.colWidth + compressedDepth(depth) * book.indent;
      node.y = top - row * book.rowStep;
      node.z = -compressedDepth(depth) * zStep;
    });
    chapters.set(h.roots[k].id, { x: left, y: top, z: 0 });
  });
  return { chapters };
}

/** Serpentine route: straight rows joined by half-circle turns, parameterised by arc length. */
function serpentine(rowLength: number, rowGap: number) {
  const turn = (Math.PI * rowGap) / 2;
  const period = rowLength + turn;
  return (s: number): { x: number; z: number; tx: number; tz: number } => {
    const row = Math.floor(s / period);
    const u = s - row * period;
    const dir = row % 2 === 0 ? 1 : -1;
    const z0 = row * rowGap;
    if (u <= rowLength) {
      const x = dir > 0 ? u : rowLength - u;
      return { x, z: z0, tx: dir, tz: 0 };
    }
    const a = ((u - rowLength) / turn) * Math.PI;
    const cx = dir > 0 ? rowLength : 0;
    const x = cx + dir * Math.sin(a) * (rowGap / 2);
    const z = z0 + rowGap / 2 - Math.cos(a) * (rowGap / 2);
    return { x, z, tx: dir * Math.cos(a), tz: Math.sin(a) };
  };
}

/**
 * Learning journey: the note's reading order laid along a route. Chapter
 * nodes sit on the route; deeper items step aside from it in proportion to
 * depth. The route is returned as a guide line, labelled as document order.
 */
export function layoutJourney(nodes: LayoutNode[], options: LayoutOptions): LayoutResult {
  const h = buildHierarchy(nodes);
  if (!nodes.length) return {};
  const sequence = h.order;
  const sGap = siblingGap(options);
  const maxR = Math.max(...nodes.map(n => n.radius));
  const maxDepth = compressedDepth(Math.max(...[...h.depth.values()]), 6);
  const lateral = 2 * maxR + sGap;
  const rowGap = maxDepth * lateral + 2 * maxR + options.gap * 2;
  const along = Math.max(8, options.gap * 0.35);
  const s: number[] = [0];
  for (let k = 1; k < sequence.length; k++) {
    const chapterBreak = h.depth.get(sequence[k].id) === 0 ? options.gap * 1.5 : 0;
    s.push(s[k - 1] + sequence[k - 1].radius + sequence[k].radius + along + chapterBreak);
  }
  const total = s[s.length - 1] || 1;
  const rowLength = Math.max(rowGap * 4, Math.sqrt(total * rowGap * 1.3));
  const path = serpentine(rowLength, rowGap);
  const drop = options.gap * 0.18;
  const chapters = new Map<string, Vec3>();
  sequence.forEach((node, k) => {
    const p = path(s[k]);
    const d = compressedDepth(h.depth.get(node.id) ?? 0, 6);
    // Deeper items step to the same side of every row (-z): the outside of
    // each turn, where the route has room, never the inside where arcs shrink.
    node.x = p.x;
    node.z = p.z - d * lateral;
    node.y = -d * drop;
    if (d === 0) chapters.set(node.id, { x: node.x, y: node.y, z: node.z });
  });
  const guide: Vec3[] = [];
  const stepLength = Math.max(10, rowGap / 8);
  for (let t = 0; t <= total; t += stepLength) { const p = path(t); guide.push({ x: p.x, y: -maxR * 0.2, z: p.z }); }
  const end = path(total); guide.push({ x: end.x, y: -maxR * 0.2, z: end.z });
  // Centre the route (and its guide) on the origin.
  const cx = rowLength / 2, cz = (Math.floor(total / (rowLength + (Math.PI * rowGap) / 2)) * rowGap) / 2;
  for (const n of nodes) { n.x -= cx; n.z -= cz; }
  for (const g of guide) { g.x -= cx; g.z -= cz; }
  for (const c of chapters.values()) { c.x -= cx; c.z -= cz; }
  return { guide, chapters };
}
