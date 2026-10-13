// Deterministic knowledge layouts. Positions communicate structure, not
// inferred semantic relationships. All traversals are iterative.
export const LEARNING_LAYOUTS = [
  { id: 'knowledge', name: '知识星座', hint: '章节分成星团，先看全貌，再聚焦概念。' },
  { id: 'bookshelf', name: '章节书架', hint: '按章节分区，按文档顺序排列，适合精读。' },
  { id: 'journey', name: '学习路径', hint: '章节沿空间路线展开，适合顺序学习与复习。' },
];
export const LEARNING_KINDS = new Set(LEARNING_LAYOUTS.map(x => x.id));

export function hierarchy(nodes) {
  const map = new Map(nodes.map(n => [n.id, n])), children = new Map();
  for (const n of nodes) {
    if (!map.has(n.parentId) || n.parentId === n.id) continue;
    if (!children.has(n.parentId)) children.set(n.parentId, []);
    children.get(n.parentId).push(n);
  }
  const roots = nodes.filter(n => !map.has(n.parentId) || n.parentId === n.id);
  const seen = new Set(), groups = [];
  const visit = root => {
    const members = [], stack = [{ node: root, level: 0 }];
    while (stack.length) {
      const item = stack.pop();
      if (seen.has(item.node.id)) continue;
      seen.add(item.node.id); members.push(item);
      const next = children.get(item.node.id) || [];
      for (let i = next.length - 1; i >= 0; i--) stack.push({ node: next[i], level: item.level + 1 });
    }
    groups.push({ root, members });
  };
  roots.forEach(visit);
  // Malformed cycles do not hang a layout or silently discard nodes.
  for (const n of nodes) if (!seen.has(n.id)) visit(n);
  return { map, children, groups };
}

function spacing(nodes, options) {
  const maxRadius = nodes.reduce((r, n) => Math.max(r, n.radius || 6), 1);
  return Math.max(18, (options.linkDistance || 62) * .58, maxRadius * 2.6);
}

function anchor(nodes) {
  for (const n of nodes) if (n.anchor) Object.assign(n, n.anchor);
}

export function placeLearning(kind, nodes, options = {}) {
  const tree = hierarchy(nodes), gap = spacing(nodes, options);
  if (!nodes.length) return;
  const chapters = tree.groups.map(group => {
    const descendants = group.members.slice(1), columns = Math.max(1, Math.ceil(Math.sqrt(descendants.length || 1)));
    const rows = Math.ceil(descendants.length / columns);
    return { ...group, columns, rows, width: Math.max(2, columns) * gap,
      height: Math.max(2, rows) * gap, extent: Math.sqrt(Math.max(1, descendants.length)) * gap * .65 + gap * 2 };
  });
  const maxExtent = Math.max(...chapters.map(g => g.extent));
  const ring = chapters.length === 1 ? 0 : (maxExtent + gap) / Math.max(.12, Math.sin(Math.PI / chapters.length));
  const chapterColumns = Math.max(1, Math.ceil(Math.sqrt(chapters.length)));
  const pageWidth = Math.max(...chapters.map(g => g.width)) + gap * 4;
  const pageHeight = Math.max(...chapters.map(g => g.height)) + gap * 4;
  for (let index = 0; index < chapters.length; index++) {
    const g = chapters[index], theta = index * Math.PI * 2 / chapters.length;
    let cx, cy, cz;
    if (kind === 'knowledge') {
      cx = Math.cos(theta) * ring; cz = Math.sin(theta) * ring; cy = Math.sin(theta * 2) * gap * 1.2;
    } else {
      const row = Math.floor(index / chapterColumns);
      const column = kind === 'journey' && row % 2 ? chapterColumns - 1 - index % chapterColumns : index % chapterColumns;
      cx = (column - (chapterColumns - 1) / 2) * pageWidth;
      cy = kind === 'bookshelf' ? -row * pageHeight : Math.sin(index * .55) * gap * 1.4;
      cz = kind === 'bookshelf' ? 0 : row * pageHeight;
    }
    Object.assign(g.root, { x: cx, y: cy + gap * 1.4, z: cz });
    for (let order = 1; order < g.members.length; order++) {
      const { node, level } = g.members[order], i = order - 1;
      const tier = Math.log2(1 + level);
      if (kind === 'knowledge') {
        const angle = i * 2.399963229728653, r = gap * .65 * Math.sqrt(i + 1.5);
        node.x = cx + Math.cos(angle) * r;
        node.z = cz + Math.sin(angle) * r;
        node.y = cy - tier * gap * .6;
      } else {
        const row = Math.floor(i / g.columns), col = i % g.columns;
        node.x = cx + (col - (g.columns - 1) / 2) * gap;
        if (kind === 'bookshelf') {
          node.y = cy - (row + .5) * gap;
          node.z = cz - tier * gap * .75;
        } else {
          node.y = cy - tier * gap * .55;
          node.z = cz + (row + 1) * gap;
        }
      }
    }
  }
  center(nodes); anchor(nodes);
}

// Refine the existing hierarchy tree: leaf order is the Markdown order, leaves
// occupy a compact 2D footprint, parents sit above their descendant centroid.
export function placeTidyTree(nodes, options = {}) {
  const tree = hierarchy(nodes), gap = spacing(nodes, options);
  const pages = [];
  for (const group of tree.groups) {
    const leaves = group.members.filter(({ node }) => !(tree.children.get(node.id)?.length));
    const cols = Math.max(1, Math.ceil(Math.sqrt(leaves.length)));
    const sums = new Map();
    leaves.forEach(({ node }, i) => sums.set(node.id, { x: (i % cols) * gap, z: Math.floor(i / cols) * gap, count: 1 }));
    for (let i = group.members.length - 1; i >= 0; i--) {
      const { node, level } = group.members[i], list = tree.children.get(node.id) || [];
      if (list.length) {
        const sum = { x: 0, z: 0, count: 0 };
        for (const child of list) { const value = sums.get(child.id); if (value) { sum.x += value.x; sum.z += value.z; sum.count += value.count; } }
        if (sum.count) sums.set(node.id, sum);
      }
      const value = sums.get(node.id) || { x: 0, z: 0, count: 1 };
      node.x = value.x / value.count;
      node.z = value.z / value.count;
      node.y = -Math.log2(level + 1) * gap * 2.4;
    }
    pages.push({ group, width: cols * gap, height: Math.ceil(leaves.length / cols) * gap });
  }
  const columns = Math.max(1, Math.ceil(Math.sqrt(pages.length)));
  const width = Math.max(gap, ...pages.map(p => p.width)) + gap * 4;
  const height = Math.max(gap, ...pages.map(p => p.height)) + gap * 4;
  pages.forEach((p, i) => p.group.members.forEach(({ node }) => {
    node.x += (i % columns) * width; node.z += Math.floor(i / columns) * height;
  }));
  center(nodes); anchor(nodes);
}

export function placeWeightedRadial(nodes, options = {}) {
  const tree = hierarchy(nodes), gap = spacing(nodes, options), weights = new Map(), sectors = new Map();
  const ordered = tree.groups.flatMap(g => g.members);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const n = ordered[i].node, children = tree.children.get(n.id) || [];
    weights.set(n.id, children.length ? children.reduce((s, c) => s + (weights.get(c.id) || 1), 0) : 1);
  }
  const total = tree.groups.reduce((s, g) => s + weights.get(g.root.id), 0) || 1;
  let cursor = -Math.PI;
  for (const group of tree.groups) {
    const width = Math.PI * 2 * weights.get(group.root.id) / total;
    sectors.set(group.root.id, { start: cursor, end: cursor + width }); cursor += width;
  }
  const rings = new Map();
  for (const { level } of ordered) rings.set(level, (rings.get(level) || 0) + 1);
  for (const { node, level } of ordered) {
    const sector = sectors.get(node.id) || { start: 0, end: Math.PI * 2 };
    const angle = (sector.start + sector.end) / 2;
    const radius = Math.max((level + 1) * gap * 1.6, (rings.get(level) || 1) * gap / (Math.PI * 2));
    node.x = Math.cos(angle) * radius; node.z = Math.sin(angle) * radius;
    node.y = -Math.log2(level + 1) * gap * 1.2;
    const children = tree.children.get(node.id) || [];
    let start = sector.start, weight = children.reduce((sum, n) => sum + (weights.get(n.id) || 1), 0);
    for (const child of children) {
      const width = (sector.end - sector.start) * (weights.get(child.id) || 1) / (weight || 1);
      sectors.set(child.id, { start, end: start + width }); start += width;
    }
  }
  center(nodes); anchor(nodes);
}

export function center(nodes) {
  if (!nodes.length) return;
  const movable = nodes.filter(n => !n.anchor);
  if (!movable.length) return;
  const c = movable.reduce((p, n) => ({ x: p.x + n.x, y: p.y + n.y, z: p.z + n.z }), { x: 0, y: 0, z: 0 });
  for (const n of movable) { n.x -= c.x / movable.length; n.y -= c.y / movable.length; n.z -= c.z / movable.length; }
}

// Bounded spatial correction shared by all deterministic layouts. It preserves
// their overall silhouette while spreading overlapping spheres locally.
export function separateNodes(nodes, options = {}, passes = 5) {
  if (!nodes.length) return;
  const maxRadius = nodes.reduce((r, n) => Math.max(r, n.radius || 6), 1);
  const cell = maxRadius * 2.5, limit = Math.max(1, (options.linkDistance || 62) * .18);
  for (let pass = 0; pass < passes; pass++) {
    const grid = new Map();
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i], x = Math.floor(n.x / cell), y = Math.floor(n.y / cell), z = Math.floor(n.z / cell);
      let examined = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const list = grid.get(`${x+dx},${y+dy},${z+dz}`) || [];
        for (const j of list) {
          if (++examined > 96) break;
          const other = nodes[j];
          let vx = n.x - other.x, vy = n.y - other.y, vz = n.z - other.z;
          const minimum = ((n.radius || 6) + (other.radius || 6)) * 1.12;
          let d = Math.hypot(vx, vy, vz);
          if (d >= minimum) continue;
          if (d < .00001) { const angle = (i + j * 7 + pass) * 2.399963; vx = Math.cos(angle); vy = .35; vz = Math.sin(angle); d = Math.hypot(vx, vy, vz); }
          const shift = Math.min(limit, (minimum - Math.min(d, minimum)) * .52) / d;
          if (!n.anchor) { n.x += vx * shift; n.y += vy * shift; n.z += vz * shift; }
          if (!other.anchor) { other.x -= vx * shift; other.y -= vy * shift; other.z -= vz * shift; }
        }
      }
      const key = `${x},${y},${z}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(i);
    }
  }
  anchor(nodes);
}
