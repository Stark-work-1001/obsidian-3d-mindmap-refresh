// Deterministic synthetic Markdown fixtures for tests and benchmarks.
// Every generator returns { name, markdown, nodes } where `nodes` is the
// number of outline nodes (headings + list items) the plugin should parse.
// No randomness: a seeded generator keeps runs comparable across versions.

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const words = ['vector', 'matrix', 'entropy', 'lattice', 'gradient', 'kernel', 'spectrum', 'manifold',
  'tensor', 'operator', 'boundary', 'invariant', 'symmetry', 'flux', 'potential', 'basis', 'eigenvalue',
  'diffusion', 'equilibrium', 'transform'];
const title = (r, i) => `${words[Math.floor(r() * words.length)]} ${words[Math.floor(r() * words.length)]} ${i}`;

/** 20 chapters, ~5 topics each, nested list items up to depth 3. */
export function balanced(count = 300, seed = 7) {
  const r = rng(seed);
  const chapters = 20;
  const lines = [];
  let made = 0;
  const perChapter = Math.floor(count / chapters);
  for (let c = 0; c < chapters && made < count; c++) {
    const budget = c === chapters - 1 ? count - made : perChapter;
    lines.push(`# Chapter ${c + 1}: ${title(r, c)}`); made++;
    let used = 1;
    const topics = Math.max(1, Math.min(5, Math.floor(budget / 6)));
    for (let t = 0; t < topics && used < budget; t++) {
      lines.push(`## Topic ${c + 1}.${t + 1}`); made++; used++;
      const room = Math.floor((budget - used) / (topics - t));
      for (let k = 0; k < room && used < budget; k++) {
        const depth = k % 7 === 0 ? 0 : k % 3 === 0 ? 2 : 1;
        lines.push(`${'  '.repeat(depth)}- ${title(r, k)}`); made++; used++;
      }
    }
    while (used < budget) { lines.push(`- extra ${title(r, used)}`); made++; used++; }
  }
  return { name: `balanced-${count}`, markdown: lines.join('\n') + '\n', nodes: made };
}

/** Chapters whose sizes follow a 1/k distribution. */
export function uneven(count = 1200, seed = 11) {
  const r = rng(seed);
  const chapters = 12;
  const weights = Array.from({ length: chapters }, (_, k) => 1 / (k + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const sizes = weights.map(w => Math.max(1, Math.floor((w / total) * count)));
  sizes[0] += count - sizes.reduce((a, b) => a + b, 0);
  const lines = [];
  sizes.forEach((size, c) => {
    lines.push(`# Part ${c + 1}`);
    for (let i = 1; i < size; i++) lines.push(`${'  '.repeat(i % 4 === 0 ? 0 : i % 4 === 1 ? 1 : 2)}- ${title(r, i)}`);
  });
  return { name: `uneven-${count}`, markdown: lines.join('\n') + '\n', nodes: count };
}

/** Several deep nested list chains (depth `depth`). */
export function deepChains(count = 3000, depth = 500) {
  const lines = [];
  let made = 0;
  for (let c = 0; made < count; c++) {
    lines.push(`# Chain ${c + 1}`); made++;
    for (let d = 0; d < depth - 1 && made < count; d++) { lines.push(`${'  '.repeat(d)}- step ${c + 1}.${d + 1}`); made++; }
  }
  return { name: `deep-${count}`, markdown: lines.join('\n') + '\n', nodes: made };
}

/** One heading with count-1 direct children. */
export function wide(count = 3000) {
  const lines = ['# Everything'];
  for (let i = 1; i < count; i++) lines.push(`- item ${i}`);
  return { name: `wide-${count}`, markdown: lines.join('\n') + '\n', nodes: count };
}

/** Notes, inline/display math, wikilinks with aliases and headings, relative links. */
export function notesAndLinks() {
  const markdown = [
    '# Formula and links',
    '> Energy: $E=mc^2$ and [[link_target#Anchor|Meaningful alias]].',
    '',
    '- Child with $a^2+b^2=c^2$',
    '  > $$\\int_0^1 x^2 \\, dx = \\frac{1}{3}$$',
    '- Sibling linking [[#Second chapter]] and [[folder/other note]]',
    '',
    '# Second chapter',
    '- Duplicate',
    '- Duplicate',
    '  - Nested under duplicate',
    '',
  ].join('\n');
  return { name: 'notes-links', markdown, nodes: 7 };
}

/** Skipped heading levels, code fences, odd indentation, empty items, unclosed formulas. */
export function malformed() {
  const markdown = [
    '---',
    'mindmap-root: Custom root',
    '---',
    '# Top',
    '### Skipped level',
    '```',
    '# not a heading',
    '- not an item',
    '```',
    '-   ',
    '\t- tab indented',
    '      - deep jump',
    '- unclosed $x + y',
    '#### Even deeper',
    '1. ordered',
    '   2) ordered child',
    '- [ ] task',
    '- [x] done task',
    '',
  ].join('\n');
  return { name: 'malformed', markdown, nodes: null };
}

export const suites = { balanced, uneven, deepChains, wide, notesAndLinks, malformed };
