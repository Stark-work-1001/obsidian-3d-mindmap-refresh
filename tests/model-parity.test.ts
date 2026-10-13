// Differential tests: the TypeScript model must reproduce the recovered 1.15
// parser, node identities, path keys, rules and formula scanning exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadReference } from './support/reference';
import { balanced, deepChains, malformed, notesAndLinks, uneven, wide } from './fixtures/generate.mjs';
import { parseOutline } from '../src/model/markdown-parser';
import { scanFormulas } from '../src/model/formula-scan';
import { OutlineModel } from '../src/model/outline-model';
import { nodePath, PathIndex, resolveAssociations, resolveMarks } from '../src/model/node-paths';
import { groupColor, hiddenByRules, scanRules, type GroupRule, type MatchRule } from '../src/model/rules';
import type { OutlineNode } from '../src/model/types';

const ref = loadReference();

function flatten(root: any): any[] {
  const out: any[] = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    out.push({
      id: n.id, kind: n.kind, text: n.text, rawText: n.rawText, depth: n.depth, level: n.level, ring: n.ring,
      headingLevel: n.headingLevel, indent: n.indent, marker: n.marker, taskMarker: n.taskMarker, line: n.line,
      range: n.range, contentStart: n.contentStart, contentEnd: n.contentEnd, note: n.note, noteRange: n.noteRange,
      noteLineCount: n.noteLineCount, formulas: n.formulas, pathId: n.pathId, collapsed: n.collapsed,
      parent: n.parent?.id ?? null, children: n.children.length,
    });
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return out;
}

const texts: [string, string][] = [
  ['balanced-300', balanced(300).markdown],
  ['balanced-3000', balanced(3000).markdown],
  ['uneven-1200', uneven(1200).markdown],
  ['deep-900', deepChains(900, 300).markdown],
  ['wide-1000', wide(1000).markdown],
  ['notes-links', notesAndLinks().markdown],
  ['malformed', malformed().markdown],
  ['crlf', '# A\r\n- b\r\n  > note one\r\n  > note two\r\n- c\r\n'],
  ['frontmatter', '---\ntitle: x\n---\n# H\n- a\n'],
  ['tabs', '- a\n\t- b\n\t\t- c\n- d\n'],
  ['lazy', '- item\n  continues here\n- next\n'],
  ['empty', ''],
  ['marker-name', '# H\n'],
];

for (const [name, text] of texts) {
  test(`parser parity: ${name}`, () => {
    for (const cap of [6, 3]) {
      const a = ref.qp(text, { basename: 'Book\uFF5Cnotes-v2', maxHeadingLevel: cap, coreNameStripSuffix: true });
      const b = parseOutline(text, { basename: 'Book\uFF5Cnotes-v2', maxHeadingLevel: cap, coreNameStripSuffix: true });
      assert.deepEqual(flatten(b.root), flatten(a.root));
      assert.deepEqual(b.stats, a.stats);
      assert.equal(b.coreName, a.coreName);
      assert.equal(b.coreNameSource, a.coreNameSource);
      assert.equal(b.indentUnit, a.indentUnit);
      assert.equal(b.maxHeadingLevel, a.maxHeadingLevel);
      assert.equal(b.warnings.length, a.warnings.length);
    }
  });
}

test('core name from frontmatter keys, including legacy non-English keys', () => {
  for (const key of ['mindmap-root', '\u5BFC\u56FE\u6838\u5FC3']) {
    const text = `---\n${key}: Custom\n---\n# A\n`;
    assert.equal(parseOutline(text, { basename: 'f' }).coreName, ref.qp(text, { basename: 'f' }).coreName);
    assert.equal(parseOutline(text, { basename: 'f' }).coreName, 'Custom');
  }
});

test('formula scanning parity', () => {
  const samples = ['$a$', '$$b$$ and $c$', 'cost $5 and $6', '`$code$` $x$', '\\$no$ $yes$', '$ spaced $', '$a\nb$', '$$open',
    'mixed $x^2$ text $$\\int_0^1$$ end', '$1,000$', 'a $b$ c $d$ e $f$'];
  for (const s of samples) assert.deepEqual(scanFormulas(s), ref.qp(`- ${s}`, {}).root.children[0]?.formulas ?? ref.qa(s));
});

test('node paths parity on duplicate siblings', () => {
  const text = notesAndLinks().markdown + balanced(300).markdown;
  const a = ref.qp(text, { basename: 'File' }), b = parseOutline(text, { basename: 'File' });
  const fa = flatten(a.root), fb = flatten(b.root);
  const nodesA: any[] = [], nodesB: OutlineNode[] = [];
  const walk = (n: any, list: any[]) => { list.push(n); n.children.forEach((c: any) => walk(c, list)); };
  walk(a.root, nodesA); walk(b.root, nodesB);
  assert.equal(fa.length, fb.length);
  nodesA.forEach((n, i) => assert.equal(nodePath(nodesB[i]), ref.Cn(n)));
});

test('association and mark resolution parity', () => {
  const text = balanced(300).markdown;
  const a = ref.qp(text, { basename: 'File' }), b = parseOutline(text, { basename: 'File' });
  const nodesA: any[] = []; const walk = (n: any) => { nodesA.push(n); n.children.forEach(walk); }; walk(a.root);
  const links = [0, 5, 17, 40].map((i, k) => ({ aPath: ref.Cn(nodesA[i + 1]), bPath: ref.Cn(nodesA[i + 60]), aText: '', bText: '', createdAt: k }));
  links.push({ aPath: 'File\u001Fmissing', bPath: ref.Cn(nodesA[3]), aText: '', bText: '', createdAt: 9 });
  const ra = ref.Av(a, links), rb = resolveAssociations(new PathIndex(b), links);
  assert.deepEqual(rb.resolved.map(r => [r.a.id, r.b.id]), ra.resolved.map((r: any) => [r.a.id, r.b.id]));
  assert.equal(rb.dangling.length, ra.dangling.length);
  const pins = links.map(l => ({ path: l.aPath, text: '', createdAt: 0 }));
  assert.deepEqual(resolveMarks(new PathIndex(b), pins).ids, ref.Rv(a, pins).ids);
});

test('association resolution survives a file rename (root segment ignored)', () => {
  const b = parseOutline('# A\n- x\n- y\n', { basename: 'New name' });
  const index = new PathIndex(b);
  assert.equal(index.resolve('Old name\u001FA\u001Fx')?.text, 'x');
});

test('rule matching parity', () => {
  const text = balanced(1200).markdown + '- [x] done topic\n> with note\n';
  const a = ref.qp(text, { basename: 'File' }), b = parseOutline(text, { basename: 'File' });
  const base = { depthMax: null, requireNote: false, requireTaskDone: false, enabled: true };
  const rules: MatchRule[] = [
    { id: 'r1', pattern: 'Topic', mode: 'contains', ...base },
    { id: 'r2', pattern: 'chapter', mode: 'regex', ...base },
    { id: 'r3', pattern: 'done', mode: 'contains', ...base, requireTaskDone: true },
    { id: 'r4', pattern: '([', mode: 'regex', ...base },
    { id: 'r5', pattern: '1', mode: 'endsWith', ...base, depthMax: 2 },
  ];
  const sa = ref.cm(a.root, rules), sb = scanRules(b.root, rules);
  assert.deepEqual(sb.ids, sa.ids);
  assert.deepEqual(sb.perRule.map(p => [p.count, p.broken]), sa.perRule.map((p: any) => [p.count, p.broken]));
  const groups: GroupRule[] = [{ ...rules[0], color: '#ff0000', hide: false }, { ...rules[4], color: '', hide: true }];
  assert.deepEqual([...hiddenByRules(b.root, groups)].sort(), [...ref.Cc(a.root, groups)].sort());
  const nodesA: any[] = [], nodesB: OutlineNode[] = [];
  const walk = (n: any, list: any[]) => { list.push(n); n.children.forEach((c: any) => walk(c, list)); };
  walk(a.root, nodesA); walk(b.root, nodesB);
  nodesA.forEach((n, i) => assert.equal(groupColor(nodesB[i], groups), ref.Pv(n, groups)));
});

// --- Editing parity ---------------------------------------------------------

function pick(model: any, k: number): string {
  const ids: string[] = [];
  const walk = (n: any) => { if (n.kind !== 'root') ids.push(n.id); n.children.forEach(walk); };
  walk(model.root);
  return ids[(k * 7919) % ids.length];
}

test('edit operations produce identical text and identities', () => {
  const text = balanced(300).markdown + notesAndLinks().markdown;
  const a = new ref.ja(text, 'File'), b = new OutlineModel(text, 'File');
  const steps: [string, (m: any, id: string) => any][] = [
    ['addChild', (m, id) => m.addChild(id, 'new child')],
    ['addSibling', (m, id) => m.addSibling(id, 'new sibling')],
    ['rename', (m, id) => m.rename(id, 'renamed **text**')],
    ['setNote', (m, id) => m.setNote(id, 'line one\n\nline $x$ two')],
    ['clearNote', (m, id) => m.clearNote(id)],
    ['outdent', (m, id) => m.outdent(id)],
    ['move', (m, id) => m.move(id, 1)],
    ['move', (m, id) => m.move(id, -1)],
    ['remove', (m, id) => m.remove(id)],
    ['undo', m => m.undo()],
    ['undo', m => m.undo()],
    ['redo', m => m.redo()],
  ];
  for (let k = 0; k < 60; k++) {
    const [name, op] = steps[k % steps.length];
    const id = pick(a, k + 3);
    assert.equal(pick(b, k + 3), id, `ids diverged before step ${k} (${name})`);
    const ra = op(a, id), rb = op(b, id);
    assert.equal(rb.ok, ra.ok, `${name} ok at step ${k}`);
    assert.equal(b.text, a.text, `${name} text at step ${k}`);
    assert.deepEqual(flatten(b.root).map(n => n.id), flatten(a.root).map(n => n.id), `${name} ids at step ${k}`);
    assert.equal(rb.targetId, ra.targetId, `${name} target at step ${k}`);
  }
});

test('re-parse after external edits keeps the same identities as 1.15 in most cases', () => {
  let text = balanced(1200).markdown;
  const a = new ref.ja(text, 'File'), b = new OutlineModel(text, 'File');
  let same = 0, total = 0;
  for (let k = 0; k < 120; k++) {
    const lines = text.split('\n');
    const at = (k * 104729) % Math.max(1, lines.length - 1);
    if (k % 3 === 0) lines.splice(at, 0, `- inserted ${k}`);
    else if (k % 3 === 1) lines.splice(at, 1);
    else lines[at] = lines[at].replace(/\w+$/, `changed${k}`);
    text = lines.join('\n');
    a.replaceText(text); b.replaceText(text);
    const ia = flatten(a.root).map(n => n.id), ib = flatten(b.root).map(n => n.id);
    total++;
    if (JSON.stringify(ia) === JSON.stringify(ib)) same++;
    assert.equal(ib.length, ia.length);
  }
  assert.ok(same / total >= 0.95, `identity agreement ${same}/${total}`);
});

test('fresh parse of a 3000-node deep outline is linear in text size', () => {
  const text = deepChains(3000, 500).markdown;
  const t0 = performance.now();
  const tree = parseOutline(text, { basename: 'File' });
  const elapsed = performance.now() - t0;
  assert.equal(tree.stats.nodeCount, 3000);
  assert.ok(elapsed < 1500, `fresh parse took ${elapsed} ms`);
});

test('wide sibling lists do not allocate quadratic tables (3000 children)', () => {
  const text = wide(3000).markdown;
  const m = new OutlineModel(text, 'File');
  const before = new Map(flatten(m.root).map(n => [n.text, n.id]));
  const t0 = performance.now();
  m.replaceText(text.replace('- item 1\n', '- item 1\n- inserted\n'));
  const elapsed = performance.now() - t0;
  const after = flatten(m.root);
  assert.equal(after.length, before.size + 1);
  for (const n of after) if (n.text !== 'inserted') assert.equal(n.id, before.get(n.text));
  assert.ok(elapsed < 500, `re-parse took ${elapsed} ms`);
});
