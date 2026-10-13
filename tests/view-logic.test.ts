// View-level logic that runs without a browser: emphasis rules, keyboard
// mapping, wheel normalisation, pose storage, menus, inspector provenance and
// the node layer's batch bookkeeping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';
import { CameraRig, lookRotation, type CameraBookmark } from '../src/camera/camera-rig';
import { poseBookmark, poseFromBookmark } from '../src/camera/pose';
import { t } from '../src/i18n';
import { LAYOUTS } from '../src/layout/catalog';
import { OutlineModel } from '../src/model/outline-model';
import { toggleAssociation } from '../src/model/node-paths';
import { DEFAULT_SETTINGS, type Settings } from '../src/persistence/settings';
import { NodeLayer } from '../src/render/node-layer';
import { LABEL_STATE, LABEL_TIER } from '../src/render/labels';
import { computeEmphasis, subtreeMask } from '../src/view/emphasis';
import { buildGraph } from '../src/view/graph-builder';
import { inspectorData } from '../src/view/inspector-data';
import { normalizeWheel } from '../src/view/interaction';
import { handleKey, type KeyboardHost } from '../src/view/keyboard';
import { buildMenu, type MenuHost } from '../src/view/view-menus';
import type { MenuItem } from '../src/ui/menu';

// --- emphasis -------------------------------------------------------------------
//   0 A          tree used below (depth in brackets)
//   ├ 1 A1 [1]
//   │ └ 2 A1a [2]
//   └ 3 A2 [1]
//   4 B
//   └ 5 B1 [1]
const parent = Int32Array.from([-1, 0, 1, 0, -1, 4]);
const depth = Int32Array.from([0, 1, 2, 1, 0, 1]);
const base = { count: 6, parent, depth, selected: -1, hovered: -1, focus: null, hits: null, currentHit: -1, marks: new Uint8Array(6), related: null, connectSource: -1 };

test('emphasis: selection gets the rim and the strongest level; its ancestors form the path', () => {
  const e = computeEmphasis({ ...base, selected: 2 });
  assert.equal(e.rim[2], 1);
  assert.equal(e.rim.reduce((a, b) => a + b, 0), 1, 'only the selection has a rim');
  assert.equal(e.level[2], 1);
  assert.deepEqual(Array.from(e.path), [1, 1, 1, 0, 0, 0]);
  assert.equal(e.tiers[2], LABEL_TIER.selected);
  assert.equal(e.states[2], LABEL_STATE.selected);
  assert.ok(e.level[0] > 0 && e.level[0] < e.level[2]);
  assert.equal(e.dimmed.reduce((a, b) => a + b, 0), 0, 'nothing fades without a branch or search');
});

test('emphasis: an entered branch fades everything outside it, except the selection', () => {
  const focus = subtreeMask(parent, 0);
  assert.deepEqual(Array.from(focus), [1, 1, 1, 1, 0, 0]);
  const e = computeEmphasis({ ...base, focus, selected: 5 });
  assert.deepEqual(Array.from(e.dimmed), [0, 0, 0, 0, 1, 0]);
});

test('emphasis: search fades non-hits; hits, current hit, marks and hover stay distinguishable', () => {
  const hits = Uint8Array.from([0, 1, 0, 1, 0, 0]);
  const marks = Uint8Array.from([0, 0, 0, 0, 0, 1]);
  const e = computeEmphasis({ ...base, hits, currentHit: 3, marks, hovered: 0 });
  assert.equal(e.states[1], LABEL_STATE.search);
  assert.equal(e.states[3], LABEL_STATE.searchCurrent);
  assert.equal(e.states[5], LABEL_STATE.mark);
  assert.equal(e.states[0], LABEL_STATE.hover);
  assert.equal(e.dimmed[1], 0);
  assert.equal(e.dimmed[2], 1);
  assert.equal(e.rim.reduce((a, b) => a + b, 0), 0, 'only selection uses the rim');
});

// --- keyboard ---------------------------------------------------------------------
function recorder() {
  const calls: string[] = [];
  const host = new Proxy({}, { get: (_t, name) => (...args: unknown[]) => calls.push(`${String(name)}(${args.map(a => JSON.stringify(a)).join(',')})`) }) as KeyboardHost;
  const press = (key: string, mods: Partial<KeyboardEvent> = {}, target: unknown = null) =>
    handleKey({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isComposing: false, target, ...mods } as KeyboardEvent, host);
  return { calls, press };
}

test('keyboard: 1.x shortcuts are kept, new navigation keys added', () => {
  const { calls, press } = recorder();
  press('Tab'); press('Tab', { shiftKey: true }); press('Enter'); press('Enter', { shiftKey: true });
  press('z', { ctrlKey: true }); press('Z', { ctrlKey: true, shiftKey: true }); press('y', { metaKey: true });
  press('ArrowUp', { altKey: true }); press('ArrowLeft', { altKey: true }); press('ArrowRight');
  press(' '); press('F2'); press('Delete'); press('Escape'); press('Home'); press('Enter', { ctrlKey: true }); press('k');
  press('ArrowLeft', { shiftKey: true });
  assert.deepEqual(calls, [
    'addChild()', 'indent(-1)', 'addSibling()', 'editNote()', 'undo()', 'redo()', 'redo()',
    'move(-1)', 'history(-1)', 'select("right")', 'toggleCollapse()', 'rename()', 'remove()', 'escape()', 'overview()', 'enterBranch()', 'typeJump("k")',
    'orbit(-36,0)',
  ]);
});

test('keyboard: ignored while composing (IME) or typing in a field', () => {
  const { calls, press } = recorder();
  assert.equal(press('Enter', { isComposing: true }), false);
  const input = { closest: (sel: string) => (sel.includes('textarea') ? {} : null) };
  assert.equal(press('Tab', {}, input), false);
  assert.deepEqual(calls, []);
});

// --- wheel ------------------------------------------------------------------------
test('wheel: pixel, line and page modes give comparable steps; pinch is finer; steps are clamped', () => {
  const px = normalizeWheel({ deltaY: 100, deltaMode: 0, ctrlKey: false }, 800);
  const line = normalizeWheel({ deltaY: 3, deltaMode: 1, ctrlKey: false }, 800);
  assert.equal(px, 1);
  assert.ok(Math.abs(line - 0.48) < 1e-9);
  assert.equal(normalizeWheel({ deltaY: 1, deltaMode: 2, ctrlKey: false }, 800), 4);
  assert.ok(Math.abs(normalizeWheel({ deltaY: 5, deltaMode: 0, ctrlKey: true }, 800) - 0.2) < 1e-9);
  assert.equal(normalizeWheel({ deltaY: -100000, deltaMode: 0, ctrlKey: false }, 800), -4);
});

// --- poses ------------------------------------------------------------------------
const close = (a: number[], b: number[], eps = 1e-3) => a.every((v, i) => Math.abs(v - b[i]) < eps);

test('pose: 2.0 bookmark round-trips through stored data', () => {
  const orientation = lookRotation(new Vector3(300, 120, -80), new Vector3(10, 0, 5)).toArray() as [number, number, number, number];
  const b: CameraBookmark = { pivot: [10, 0, 5], orientation, offset: [12, -7, 330], fov: 48 };
  const pose = poseFromBookmark(b, { layout: 'tree', focusPath: null, now: 1 });
  const back = poseBookmark(JSON.parse(JSON.stringify(pose)), 52)!;
  assert.ok(close(back.pivot, b.pivot) && close(back.offset, b.offset, 1e-2) && back.fov === 48);
  assert.ok(Math.abs(new Quaternion().fromArray(back.orientation).dot(new Quaternion().fromArray(orientation))) > 0.999999);
  assert.equal(pose.v, 6);
  assert.ok(pose.radius > 0 && Number.isFinite(pose.azimuth) && Number.isFinite(pose.polar), 'legacy fields are kept for 1.x');
});

test('pose: 1.x spherical poses are converted; corrupt poses are rejected', () => {
  const legacy = { v: 5, radius: 400, azimuth: 0.5, polar: 1.1, targetX: 1, targetY: 2, targetZ: 3 };
  const b = poseBookmark(legacy, 52)!;
  const q = new Quaternion().fromArray(b.orientation);
  const position = new Vector3().fromArray(b.offset).applyQuaternion(q).add(new Vector3().fromArray(b.pivot));
  const s = Math.sin(1.1);
  assert.ok(close(position.toArray(), [1 + 400 * s * Math.cos(0.5), 2 + 400 * Math.cos(1.1), 3 + 400 * s * Math.sin(0.5)], 1e-6));
  assert.equal(poseBookmark({ ...legacy, radius: Number.NaN }, 52), null);
  assert.equal(poseBookmark({ v: 6, radius: -1, azimuth: 0, polar: 0, targetX: 0, targetY: 0, targetZ: 0, camera: { position: [0, 0, 1], quaternion: [0, 0, 0, 0], pivot: [0, 0, 0], fov: 50 } }, 52), null);
  assert.ok(CameraRig.fromSpherical(legacy).offset[2] === 400);
});

// --- menus ------------------------------------------------------------------------
function flatten(items: MenuItem[], out: MenuItem[] = []): MenuItem[] {
  for (const item of items) { out.push(item); if (item.kind === 'submenu') flatten(item.items(), out); }
  return out;
}

test('menus: every group renders, all labels are filled in, every layout is offered once', () => {
  const settings: Settings = { ...DEFAULT_SETTINGS };
  const host: MenuHost = {
    settings, update: () => {}, run: () => {}, collapseToDepth: () => {}, setMode: () => {},
    state: { hasFile: true, selected: true, selectedIsRoot: false, selectedHasChildren: true, selectedCollapsed: false, selectedMarked: false, inBranch: true,
      canUndo: true, canRedo: false, undoLabel: 'Rename', redoLabel: null, anchoredCount: 2, associationCount: 3, markCount: 1, physics: true, pngEnabled: true },
  };
  const layoutRadios: string[] = [];
  for (const group of ['edit', 'study', 'layout', 'view', 'appearance', 'relationships', 'more'] as const) {
    for (const item of flatten(buildMenu(group, host))) {
      const text = 'label' in item ? item.label : 'text' in item ? item.text : '';
      if (item.kind !== 'separator') assert.ok(text.trim() && !/\{\w+\}/.test(text), `${group}: "${text}"`);
      if ('hint' in item && item.hint) assert.ok(!/\{\w+\}/.test(item.hint));
      if (group === 'layout' && item.kind === 'radio') layoutRadios.push(item.label);
    }
  }
  assert.deepEqual(layoutRadios.sort(), LAYOUTS.map(l => t(l.name)).sort());
});

// --- inspector provenance -------------------------------------------------------------
test('inspector: associations, written links and backlinks keep their source', () => {
  const text = '# Alpha\n- See [[#Beta]] and [[Other note]]\n# Beta\n- Leaf\n';
  const model = new OutlineModel(text, 'Doc');
  const tree = model.current;
  const [alpha, beta] = tree.root.children;
  const linker = alpha.children[0];
  const leaf = beta.children[0];
  const associations = [toggleAssociation([], alpha, leaf, 5).links[0]];
  const settings = { ...DEFAULT_SETTINGS };
  const graph = buildGraph({ tree, filePath: 'Doc.md', fileBasename: 'Doc', settings, sizes: {}, marks: [], associations, anchors: {}, formulas: null });
  const ctx = { tree, graph, settings, filePath: 'Doc.md', fileBasename: 'Doc', associations, sizes: {}, resolveLink: (l: string) => (l === 'Other note' ? 'Other note.md' : null) };
  const a = inspectorData(alpha, ctx);
  assert.equal(a.associations.length, 1);
  assert.equal(a.associations[0].otherId, leaf.id);
  const l = inspectorData(linker, ctx);
  assert.deepEqual(l.outgoing.map(o => o.target.kind), ['node', 'document']);
  assert.equal(l.outgoing[1].target.kind === 'document' && l.outgoing[1].target.resolved, 'Other note.md');
  const b = inspectorData(beta, ctx);
  assert.deepEqual(b.incoming.map(i => i.sourceId), [linker.id]);
  assert.deepEqual(b.ancestors, []);
  assert.deepEqual(inspectorData(leaf, ctx).ancestors.map(x => x.label), ['Beta']);
});

// --- node layer ------------------------------------------------------------------------
test('node layer: moving nodes between the solid and faded batch keeps their transforms', () => {
  const layer = new NodeLayer();
  layer.setGraph([0xff0000, 0x00ff00, 0x0000ff, 0xffffff]);
  const positions = new Float32Array([0, 0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0, 30, 0, 0, 0]);
  const radii = new Float32Array([1, 2, 3, 4]);
  layer.setPositions(positions, radii);
  layer.setState(new Float32Array(4), new Uint8Array(4), Uint8Array.from([1, 0, 1, 0]));
  const [solid, faded] = layer.group.children as unknown as { count: number; instanceMatrix: { array: Float32Array } }[];
  assert.equal(solid.count, 2);
  assert.equal(faded.count, 2);
  const xs = (m: { count: number; instanceMatrix: { array: Float32Array } }) => Array.from({ length: m.count }, (_, k) => [m.instanceMatrix.array[k * 16 + 12], m.instanceMatrix.array[k * 16]]);
  assert.deepEqual(xs(solid), [[10, 2], [30, 4]]);
  assert.deepEqual(xs(faded), [[0, 1], [20, 3]]);
  layer.dispose();
});

// --- formulas -----------------------------------------------------------------------------
test('labels render inline and display formulas with KaTeX (regression: hardened options)', async () => {
  const { FormulaCache, labelHtml, katexOptions } = await import('../src/render/label-format');
  const cache = new FormulaCache();
  const inline = labelHtml('Energy $E = mc^2$ here', cache);
  assert.ok(inline.includes('class="katex"') && !inline.includes('om3d-formula-error'), inline.slice(0, 200));
  assert.ok(labelHtml('$$\\frac{1}{2}mv^2$$', cache).includes('class="katex"'));
  assert.ok(labelHtml('Broken $\\frac{1$', cache).includes('om3d-formula-error'), 'invalid TeX is shown as source, not thrown');
  const options = katexOptions(false);
  for (const key of ['trust', 'macros', 'maxSize', 'maxExpand', 'strict', 'globalGroup']) assert.ok(Object.prototype.hasOwnProperty.call(options, key), `${key} is an own property`);
  assert.equal(options.trust, false);
  assert.ok(!labelHtml('\\href{javascript:alert(1)}{x} $\\href{javascript:alert(1)}{x}$', cache).includes('href="javascript'), 'links in formulas are not trusted');
});
