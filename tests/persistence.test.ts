import test from 'node:test';
import assert from 'node:assert/strict';
import { loadReference } from './support/reference';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/persistence/settings';
import { migrateData } from '../src/persistence/migrate';
import { PluginStore } from '../src/persistence/store';
import { SCHEMA_VERSION, type PluginData } from '../src/persistence/schema';

const ref = loadReference();

test('settings normalisation agrees with 1.15 for every legacy key', () => {
  const samples: unknown[] = [
    undefined, null, 'garbage', {},
    { layout: 'tree', nodeScale: 9, linkWidth: 0, linkDistance: 5, maxLabels: 9999, syncDebounceMs: -3, glowStrength: 7 },
    { layout: 'nope', bgMode: 'x', bgTop: 'javascript:alert(1)', linkColor: 'url(x)', nodeColorMode: 'hash', assocBulge: 2 },
    { linkStyle: 'dotted', assocStyle: 'bad', orbitCenter: 'selected', maxHeadingLevel: 2.6, showLabels: 'yes', animate: false },
    { pinRules: [{ pattern: 'a', mode: 'regex', depthMax: 40 }, { pattern: '' }, 'x'], groupRules: [{ pattern: 'b', color: '#fff' }, { pattern: 'c' }] },
  ];
  const legacyKeys = Object.keys(ref.Bi).filter(k => k !== 'labelDistance');
  for (const sample of samples) {
    const a = ref.tl(sample), b = normalizeSettings(sample) as unknown as Record<string, unknown>;
    for (const key of legacyKeys) assert.deepEqual(b[key], a[key], `key ${key} for ${JSON.stringify(sample)}`);
  }
});

test('edgeGap is derived from the legacy link distance and stays consistent', () => {
  const s = normalizeSettings({ linkDistance: 100 });
  assert.equal(s.edgeGap, 87);
  assert.equal(s.linkDistance, 100);
  const t = normalizeSettings({ linkDistance: 100, edgeGap: 30 });
  assert.equal(t.edgeGap, 30);
  assert.equal(t.linkDistance, 43);
  assert.equal(normalizeSettings({ edgeGap: 1 }).edgeGap, 4);
});

const legacy = {
  settings: { ...ref.Bi, nodeScale: 2, layout: 'radial' },
  poses: { 'folder\\Note.md': { radius: 500, azimuth: 1, polar: 1.2, targetX: 1, targetY: 2, targetZ: 3, v: 5, layout: 'tree', collapsed: ['x1abc'], focusId: null } },
  links: { 'Note.md': [{ aPath: 'Note\u001FA', bPath: 'Note\u001FB', aText: 'A', bText: 'B', createdAt: 1 }, { bad: true }] },
  pins: { 'Note.md': [{ path: 'Note\u001FA', text: 'A', createdAt: 2 }] },
  sizes: { 'Note.md': { 'Note\u001FA': 3, 'Note\u001FB': 1, 'Note\u001FC': 'x' } },
};

test('v1 data migrates: sizes become multipliers of the global scale, maps survive', () => {
  const { data, report } = migrateData(legacy);
  assert.equal(data.schemaVersion, SCHEMA_VERSION);
  assert.equal(report.from, 1);
  assert.equal(data.settings.layout, 'radial');
  assert.deepEqual(data.sizes['Note.md'], { 'Note\u001FA': 1.5, 'Note\u001FB': 0.5 });
  // Effective scale is unchanged: multiplier x global == old absolute value.
  assert.equal(data.sizes['Note.md']['Note\u001FA'] * data.settings.nodeScale, 3);
  assert.equal(data.links['Note.md'].length, 1);
  assert.equal(data.pins['Note.md'][0].path, 'Note\u001FA');
  assert.ok(data.poses['folder/Note.md'], 'backslash keys are normalised');
  assert.deepEqual(data.poses['folder/Note.md'].collapsed, ['x1abc']);
  assert.deepEqual(data.anchors, {});
});

test('migration is idempotent', () => {
  const once = migrateData(legacy).data;
  const twice = migrateData(JSON.parse(JSON.stringify(once))).data;
  assert.deepEqual(twice, once);
});

test('garbage input yields defaults without throwing', () => {
  for (const raw of [null, 7, [], { settings: 'x', poses: [1], sizes: { a: [1] }, anchors: { f: { force: { p: [1, 'x', 3] } } } }]) {
    const { data } = migrateData(raw);
    assert.equal(data.settings.layout, DEFAULT_SETTINGS.layout);
    assert.deepEqual(data.anchors, {});
  }
});

function memoryIO(initial: unknown) {
  const io = { saved: [] as PluginData[], async load() { return structuredClone(initial); }, async save(d: PluginData) { io.saved.push(structuredClone(d)); } };
  return io;
}

test('store debounces saves and flush writes immediately', async () => {
  const io = memoryIO(null);
  const store = new PluginStore(io, 50);
  await store.load();
  store.updateSettings({ nodeScale: 2 });
  store.updateSettings({ nodeScale: 3 });
  assert.equal(io.saved.length, 0);
  await store.flush();
  assert.equal(io.saved.length, 1);
  assert.equal(io.saved[0].settings.nodeScale, 3);
});

test('renaming a note moves its data and rewrites root segments', async () => {
  const io = memoryIO(legacy);
  const store = new PluginStore(io, 10);
  await store.load();
  store.renameFile('Note.md', 'Renamed.md', 'Renamed');
  assert.equal(store.getLinks('Note.md').length, 0);
  assert.equal(store.getLinks('Renamed.md')[0].aPath, 'Renamed\u001FA');
  assert.equal(store.getMarks('Renamed.md')[0].path, 'Renamed\u001FA');
  assert.ok('Renamed\u001FA' in store.getSizes('Renamed.md'));
  await store.flush();
});

test('renaming a node keeps size, mark, association and anchor data attached to it and its descendants', async () => {
  const store = new PluginStore(memoryIO(null), 10);
  await store.load();
  store.setNodeSize('N.md', 'N\u001FA', 2);
  store.setNodeSize('N.md', 'N\u001FA\u001Fchild', 1.5);
  store.setMarks('N.md', [{ path: 'N\u001FA\u001Fchild', text: 'child', createdAt: 0 }]);
  store.setLinks('N.md', [{ aPath: 'N\u001FA', bPath: 'N\u001FB', aText: 'A', bText: 'B', createdAt: 0 }]);
  store.setAnchor('N.md', 'force', 'N\u001FA', [1, 2, 3]);
  const changed = store.renamePaths('N.md', new Map([['N\u001FA', 'N\u001FAlpha']]));
  assert.equal(changed, 5);
  assert.deepEqual(store.getSizes('N.md'), { 'N\u001FAlpha': 2, 'N\u001FAlpha\u001Fchild': 1.5 });
  assert.equal(store.getMarks('N.md')[0].path, 'N\u001FAlpha\u001Fchild');
  assert.equal(store.getLinks('N.md')[0].aPath, 'N\u001FAlpha');
  assert.deepEqual(store.getAnchors('N.md', 'force'), { 'N\u001FAlpha': [1, 2, 3] });
  // A sibling whose name merely starts with the same text is not touched.
  store.setNodeSize('N.md', 'N\u001FAB', 3);
  store.renamePaths('N.md', new Map([['N\u001FAlpha', 'N\u001FA2']]));
  assert.ok('N\u001FAB' in store.getSizes('N.md'));
  await store.flush();
});
