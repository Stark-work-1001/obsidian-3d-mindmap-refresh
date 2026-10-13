// End-to-end check inside a real Obsidian (development tool).
//
//   node scripts/obsidian-check.mjs --vault <test vault> [--port 9333] [--obsidian <path to Obsidian.exe>] [--keep-open]
//
// Safety: the vault must contain a file named `.3dmm-test-vault` (create it in
// a throwaway vault); the script refuses to run otherwise, and refuses if
// Obsidian is already running. It starts Obsidian with a DevTools port bound to
// 127.0.0.1, drives the plugin with real mouse and keyboard input through the
// Chrome DevTools Protocol, writes screenshots and report.json to
// _tmp/obsidian-check/ and closes Obsidian again. It edits notes in the test
// vault (and undoes the edits), so never point it at a vault you care about.
//
// The vault needs the plugin installed and enabled and the notes below; they
// are created when missing:
//   Study guide.md          headings, lists, tasks, notes, formulas, links
//   Other note.md           link target
//   Large outline 3000.md   generated balanced outline (tests/fixtures)
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pw from 'playwright-core';
import { balanced } from '../tests/fixtures/generate.mjs';

const root = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const vault = path.resolve(opt('--vault', '') || '.');
const port = Number(opt('--port', '9333'));
const exe = opt('--obsidian', path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Obsidian', 'Obsidian.exe'));
const outDir = path.join(root, '_tmp', 'obsidian-check');
const ID = 'obsidian-3d-mindmap';
const fail = m => { console.error(`obsidian-check: ${m}`); process.exit(1); };

if (!fs.existsSync(path.join(vault, '.3dmm-test-vault'))) fail(`${vault} is not marked as a test vault (.3dmm-test-vault missing)`);
if (!fs.existsSync(path.join(vault, '.obsidian', 'plugins', ID, 'main.js'))) fail('install the plugin into the test vault first (scripts/install-to-vault.mjs)');
if (process.platform === 'win32') {
  const running = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Obsidian.exe', '/NH'], { encoding: 'utf8' });
  if (/Obsidian\.exe/i.test(running)) fail('Obsidian is already running; close it first');
}
fs.mkdirSync(outDir, { recursive: true });

const STUDY = `# Mechanics
> Classical mechanics describes motion with $F = ma$.
> See [[Other note#Energy|energy notes]] for more.

- Newton's laws
  - First law: inertia
  - Second law $F = ma$
  - Third law
- Work and energy
- [ ] Review problem set 3

# Thermodynamics
- Entropy
- Entropy
  - Second law, see [[#Mechanics]]

# Waves
## Light
- Interference
`;
const ensure = (name, text) => { const f = path.join(vault, name); if (!fs.existsSync(f)) fs.writeFileSync(f, text); };
ensure('Study guide.md', STUDY);
ensure('Other note.md', '# Energy\nEnergy is conserved.\n');
ensure('Large outline 3000.md', balanced(3000).markdown);
// The run edits and restores Study guide.md; if it aborts, put the note back and close Obsidian.
const studyPath = path.join(vault, 'Study guide.md');
const studyOriginal = fs.readFileSync(studyPath, 'utf8');
let pageRef = null;
async function abort(error) {
  console.error(error);
  try { await pageRef?.evaluate(() => { setTimeout(() => window.close(), 100); }); } catch { /* already closed */ }
  await new Promise(r => setTimeout(r, 2500));
  if (fs.readFileSync(studyPath, 'utf8') !== studyOriginal) { fs.writeFileSync(studyPath, studyOriginal); console.error('restored Study guide.md'); }
  process.exit(1);
}
process.on('uncaughtException', abort);
process.on('unhandledRejection', abort);

// --- launch and connect -----------------------------------------------------------
const child = spawn(exe, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { detached: true, stdio: 'ignore' });
child.unref();
for (let k = 0; k < 80; k++) {
  try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch { /* starting */ }
  await new Promise(r => setTimeout(r, 500));
}
const browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
let page = null;
for (let k = 0; k < 80 && !page; k++) {
  for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (await p.evaluate(() => !!window.app?.vault).catch(() => false)) page = p;
  if (!page) await new Promise(r => setTimeout(r, 500));
}
if (!page) fail('no Obsidian window found (is the test vault registered and set to open?)');
pageRef = page;

const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail: typeof detail === 'string' ? detail.slice(0, 600) : JSON.stringify(detail).slice(0, 600) }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? `\n     ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); };
const wait = ms => page.waitForTimeout(ms);
const shot = name => page.screenshot({ path: path.join(outDir, `${name}.png`) });
const ev = (fn, arg) => page.evaluate(fn, arg);
const NON_ENGLISH = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/;

// Reload once with listeners attached so plugin start-up errors are captured.
await ev(() => { localStorage.setItem('language', 'en'); location.reload(); }).catch(() => {});
await page.waitForFunction(id => !!window.app?.plugins?.plugins?.[id] && window.app.workspace.layoutReady, ID, { timeout: 60000 });
await wait(1500);
const trust = await ev(() => [...document.querySelectorAll('.modal-container button')].map(b => b.innerText));
if (trust.length) fail(`unexpected dialog: ${trust.join(' / ')}`);

const facts = await ev(id => ({ obsidian: /Obsidian ([\d.]+)/.exec(document.title)?.[1] ?? null, version: window.app.plugins.plugins[id].manifest.version }), ID);
check(`plugin ${facts.version} loaded in Obsidian ${facts.obsidian}`, facts.version === JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version, facts);

// --- data migration (when the vault was upgraded from 1.x) -------------------------
const migration = await ev(async id => {
  const p = window.app.plugins.plugins[id];
  const dir = p.manifest.dir;
  const a = window.app.vault.adapter;
  if (!(await a.exists(`${dir}/data.backup-v1.json`))) return null;
  const old = JSON.parse(await a.read(`${dir}/data.backup-v1.json`));
  const now = JSON.parse(await a.read(`${dir}/data.json`));
  const scale = old.settings?.nodeScale ?? 1;
  const sizesOk = Object.entries(old.sizes ?? {}).every(([file, sizes]) => Object.entries(sizes).every(([k, v]) => Math.abs(now.sizes[file.replace(/\\/g, '/')][k] * scale - v) < 1e-3));
  const count = o => Object.values(o ?? {}).reduce((s, v) => s + (Array.isArray(v) ? v.length : Object.keys(v).length), 0);
  return { schema: now.schemaVersion, sizesOk, links: [count(old.links), count(now.links)], pins: [count(old.pins), count(now.pins)], poses: [Object.keys(old.poses ?? {}).length, Object.keys(now.poses ?? {}).length], scale: [scale, now.settings.nodeScale] };
}, ID);
if (migration) {
  check('1.x data migrated to schema 2 with a backup', migration.schema === 2, migration);
  check('node sizes converted to multipliers of the global scale (appearance unchanged)', migration.sizesOk, migration);
  check('associations, key concepts, camera poses and settings kept', migration.links[0] === migration.links[1] && migration.pins[0] === migration.pins[1] && migration.poses[1] >= migration.poses[0] && migration.scale[0] === migration.scale[1], migration);
}

// --- open the study note as a map (dark theme) -------------------------------------------
await ev(() => window.app.changeTheme('obsidian'));
// Start from a clean workspace: no leftover maps, editors or outline panes, right sidebar closed.
await ev(async () => {
  const ws = window.app.workspace;
  for (const l of [...ws.getLeavesOfType('3d-mindmap-view'), ...ws.getLeavesOfType('outline')]) l.detach();
  // Keep one leaf in the main area (no splits left over from earlier runs).
  const main = [];
  ws.iterateRootLeaves(l => main.push(l));
  for (const l of main.slice(1)) l.detach();
  ws.rightSplit?.collapse?.();
  await new Promise(r => setTimeout(r, 500));
  const file = window.app.vault.getAbstractFileByPath('Study guide.md');
  const leaf = main[0] && main[0].parent ? main[0] : ws.getLeaf('tab');
  await leaf.openFile(file, { active: true });
  ws.setActiveLeaf(leaf, { focus: true });
});
await wait(600);
await ev(() => window.app.commands.executeCommandById('obsidian-3d-mindmap:3d-mindmap-open-new-leaf'));
await page.waitForFunction(() => window.app.plugins.plugins['obsidian-3d-mindmap'].views()[0]?.internals.graph, null, { timeout: 20000 });
const settle = () => ev(async () => {
  const n = window.app.plugins.plugins['obsidian-3d-mindmap'].views()[0].internals;
  const t0 = performance.now();
  while (performance.now() - t0 < 25000 && (n.engine.active || n.renderer.rig.moving)) await new Promise(r => setTimeout(r, 100));
  return Math.round(performance.now() - t0);
});
await settle();
await wait(400);
const view = await ev(() => {
  const v = window.app.plugins.plugins['obsidian-3d-mindmap'].views()[0];
  const n = v.internals, g = n.graph;
  const S = '\u001F';
  const label = text => g.labels.findIndex(l => l.text === text);
  const waves = label('Waves');
  return {
    title: v.getDisplayText(), nodes: g.ids.length, webgl: !n.renderer.unavailable, backend: n.engine.physicsBackend, layout: n.engine.kind,
    marked: [...g.markIds].map(id => g.labels[g.index.get(id)]?.text), associations: g.associations.length, wavesMultiplier: waves >= 0 ? g.multipliers[waves] : null,
    distance: n.renderer.rig.distance, katex: !!document.querySelector('.om3d-label .katex'), path: g.paths[waves]?.split(S),
  };
});
check('map opens from the command (WebGL available)', view.webgl && view.nodes > 10, view);
check('force layout runs on the WebAssembly worker inside Obsidian', view.layout !== 'force' || view.backend === 'wasm', view);
if (migration) {
  check('migrated key concept and association appear in the map', view.marked.includes("Newton's laws") && view.associations >= 1, view);
  check('migrated node size multiplier applied (2.5 / 1.5)', Math.abs(view.wavesMultiplier - 2.5 / 1.5) < 1e-3, view);
}
const fonts = await ev(async () => {
  // Select a node whose text has a formula, so its label is shown.
  const n = window.app.plugins.plugins['obsidian-3d-mindmap'].views()[0].internals;
  const i = n.graph.labels.findIndex(l => l.html.includes('class="katex"'));
  if (i < 0) return { formulaNode: false };
  n.select(n.graph.ids[i]);
  await new Promise(r => setTimeout(r, 400));
  const el = document.querySelector('.om3d-label .katex');
  const loaded = await document.fonts.load('16px KaTeX_Main', 'x');
  const main = [...document.fonts].filter(f => f.family.replace(/"/g, '') === 'KaTeX_Main' && f.status === 'loaded').length;
  return { formulaNode: true, shown: !!el, family: el ? getComputedStyle(el).fontFamily : null, loaded: loaded.length, mainFacesLoaded: main };
});
check('formulas render with the bundled KaTeX fonts (no vendor folder needed)', fonts.formulaNode && fonts.shown && /KaTeX_Main/.test(fonts.family ?? '') && fonts.mainFacesLoaded > 0, fonts);
await shot('01-dark-study-guide');

// Screen point of a node by label text.
const point = text => ev(t => {
  const n = window.app.plugins.plugins['obsidian-3d-mindmap'].views()[0].internals;
  const i = n.graph.labels.findIndex(l => l.text === t);
  const p = n.engine.positions;
  const s = n.renderer.project({ x: p[i * 4], y: p[i * 4 + 1], z: p[i * 4 + 2] });
  const r = n.renderer.canvas.getBoundingClientRect();
  if (!s) throw new Error(`${t} is behind the camera`);
  const x = r.left + s.x, y = r.top + s.y;
  // The point must be on the map itself (canvas or a label), not under a panel or another pane.
  const hit = document.elementFromPoint(x, y);
  if (hit !== n.renderer.canvas && !hit?.closest?.('.om3d-labels')) throw new Error(`${t} is covered by ${hit?.className ?? 'nothing'} at ${Math.round(x)},${Math.round(y)}`);
  return { x, y, i };
}, text);
const editorText = () => ev(() => window.app.workspace.getLeavesOfType('markdown').map(l => l.view).find(v => v.file?.path === 'Study guide.md')?.editor.getValue() ?? null);
const fileText = () => ev(() => window.app.vault.adapter.read('Study guide.md'));

// --- selection, hover, branches, history (real mouse and keyboard) -----------------
const original = await editorText();
check('the note is open in an editor next to the map', typeof original === 'string' && original.includes('# Mechanics'));
const paneWidth = await ev(() => document.querySelector('.om3d-root')?.clientWidth ?? 0);
check('the map has a normal-width pane for the interaction checks', paneWidth >= 640, paneWidth);
// --- toolbar fits the pane (wide and narrow) ---------------------------------------------------
const fit = () => ev(() => {
  const root = document.querySelector('.om3d-root');
  const box = root.getBoundingClientRect();
  const hidden = [...root.querySelectorAll('.om3d-toolbar button')].filter(b => {
    const r = b.getBoundingClientRect();
    return r.width < 4 || r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1;
  }).map(b => b.getAttribute('aria-label'));
  return { width: Math.round(box.width), overflow: root.scrollWidth - root.clientWidth, hidden, buttons: root.querySelectorAll('.om3d-toolbar button').length };
});
const wide = await fit();
check(`all ${wide.buttons} toolbar controls visible at ${wide.width} px, no horizontal overflow`, !wide.hidden.length && wide.overflow <= 0, wide);

let pt = await point('Mechanics');
await page.mouse.click(pt.x, pt.y);
await wait(300);
check('clicking a sphere selects it; the inspector shows it', (await ev(() => document.querySelector('.om3d-title-input')?.value)) === 'Mechanics');
await page.mouse.move(pt.x + 1, pt.y + 1);
await wait(900);
const hover = await ev(() => { const h = document.querySelector('.om3d-hovercard'); return h && !h.hidden ? h.innerText : null; });
check('hovering a node with a note shows its rendered note', !!hover && hover.includes('Classical mechanics'), hover ?? 'no card');
pt = await point('Thermodynamics');
await page.mouse.dblclick(pt.x, pt.y);
await wait(800);
const dimmed = () => ev(() => Array.from(window.app.plugins.plugins['obsidian-3d-mindmap'].views()[0].internals.emphasis?.dimmed ?? []).filter(Boolean).length);
const inBranch = await dimmed();
const crumbs = await ev(() => document.querySelector('.om3d-crumbs')?.innerText ?? '');
check('double-click enters the branch (breadcrumb, rest faded)', inBranch > 0 && crumbs.includes('Thermodynamics'), { inBranch, crumbs });
await shot('02-dark-branch');
await page.keyboard.press('Escape');
await wait(600);
const out = await dimmed();
await page.keyboard.press('Alt+ArrowLeft');
await wait(700);
const back = await dimmed();
check('Escape leaves the branch, Alt+Left returns to it', out === 0 && back > 0, { out, back });
await page.keyboard.press('Escape');
await wait(400);

// --- keyboard focus after working in another pane ------------------------------------
await ev(() => { const v = window.app.workspace.getLeavesOfType('markdown').map(l => l.view).find(x => x.file?.path === 'Study guide.md'); v.editor.focus(); });
await ev(() => window.app.workspace.setActiveLeaf(window.app.workspace.getLeavesOfType('3d-mindmap-view')[0], { focus: false }));
await wait(300);
pt = await point('Light');
await page.mouse.click(pt.x, pt.y);
await page.keyboard.press('F2');
const f2 = await page.waitForSelector('.om3d-node-editor:not([hidden])', { timeout: 1500 }).then(() => true).catch(() => false);
check('one click on the map is enough for its shortcuts, and F2 renames the node (not the file)', f2, await ev(() => document.activeElement?.className?.toString()));
await page.keyboard.press('Escape');
await wait(300);
await page.keyboard.press('Control+p');
const palette = await page.waitForSelector('.prompt', { timeout: 1500 }).then(() => true).catch(() => false);
check("Obsidian's own hotkeys (Ctrl+P) still work while the map has focus", palette);
await page.keyboard.press('Escape');
await wait(300);
pt = await point('Light');
await page.mouse.click(pt.x, pt.y);

// --- editing through the open editor, undo, concurrent typing ---------------------------
pt = await point("Newton's laws");
await page.mouse.click(pt.x, pt.y);
await page.keyboard.press('Tab');
await page.waitForSelector('.om3d-node-editor:not([hidden])', { timeout: 3000 });
await page.keyboard.type('In-app child');
await page.keyboard.press('Enter');
await wait(250);
await page.keyboard.press('Escape');
await wait(500);
let text = await editorText();
check('Tab + Enter in the map adds a child in the open editor', text.includes("- Newton's laws\n  - First law: inertia") && /  - Third law\n  - In-app child\n/.test(text), text);
await page.keyboard.press('Control+z');
await wait(500);
check('Ctrl+Z in the map restores the note exactly', (await editorText()) === original);

// A node is selected in the map; someone types in the editor; immediately
// afterwards (before the map has caught up) the map renames the node.
pt = await point('Waves');
await page.mouse.click(pt.x, pt.y);
await wait(200);
await ev(() => {
  const ed = window.app.workspace.getLeavesOfType('markdown').map(l => l.view).find(v => v.file?.path === 'Study guide.md').editor;
  ed.replaceRange('- Typed in the editor\n', { line: ed.lastLine(), ch: 0 });
});
await page.keyboard.press('F2');
await page.waitForSelector('.om3d-node-editor:not([hidden])', { timeout: 3000 });
await page.keyboard.press('Control+a');
await page.keyboard.type('Waves and optics');
await page.keyboard.press('Enter');
await wait(800);
text = await editorText();
check('concurrent edits: the text typed in the editor and the map rename both survive', text.includes('- Typed in the editor') && text.includes('# Waves and optics') && !text.includes('# Waves\n'), text);
await ev(t => window.app.workspace.getLeavesOfType('markdown').map(l => l.view).find(v => v.file?.path === 'Study guide.md').editor.setValue(t), original);
await wait(800);
check('the map follows when the editor content is replaced', (await ev(() => window.app.plugins.plugins['obsidian-3d-mindmap'].views()[0].internals.graph.labels.some(l => l.text === 'Waves'))));

// Without an open editor the map writes to disk atomically; disk changes reach the map.
await ev(() => { for (const l of window.app.workspace.getLeavesOfType('markdown')) if (l.view.file?.path === 'Study guide.md') l.detach(); });
await wait(2500);
const diskBefore = await fileText();
pt = await point('Entropy');
await page.mouse.click(pt.x, pt.y);
await page.keyboard.press('Enter');
await page.waitForSelector('.om3d-node-editor:not([hidden])', { timeout: 3000 });
await page.keyboard.type('Written to disk');
await page.keyboard.press('Enter');
await wait(200);
await page.keyboard.press('Escape');
await wait(1200);
check('without an editor the map writes the note file', (await fileText()).includes('- Written to disk'));
await ev(async () => { const f = window.app.vault.getAbstractFileByPath('Study guide.md'); await window.app.vault.process(f, t => `${t}\n# Added on disk\n`); });
await wait(1500);
check('a change made on disk (sync, another app) appears in the map', await ev(() => window.app.plugins.plugins['obsidian-3d-mindmap'].views()[0].internals.graph.labels.some(l => l.text === 'Added on disk')));
await ev(async t => { const f = window.app.vault.getAbstractFileByPath('Study guide.md'); await window.app.vault.process(f, () => t); }, diskBefore);
await wait(1200);
check('note restored after the editing checks', (await fileText()) === original);

// --- Obsidian's Outline pane drives the map ------------------------------------------
await ev(async () => {
  const file = window.app.vault.getAbstractFileByPath('Study guide.md');
  const leaf = window.app.workspace.getLeaf('split');
  await leaf.openFile(file, { active: true });
  const right = window.app.workspace.getLeavesOfType('outline')[0] ?? window.app.workspace.getRightLeaf(false);
  if (right.view?.getViewType() !== 'outline') await right.setViewState({ type: 'outline', active: false });
  window.app.workspace.rightSplit?.expand?.();
  await window.app.workspace.revealLeaf?.(right);
  window.app.workspace.setActiveLeaf(leaf, { focus: true });
});
await wait(1500);
const outlineItem = page.locator('.workspace-leaf-content[data-type="outline"] .tree-item-inner:visible', { hasText: 'Thermodynamics' }).first();
if (await outlineItem.count()) {
  await outlineItem.click();
  await wait(1200);
  check('clicking a heading in the Outline pane shows it in the map', (await ev(() => document.querySelector('.om3d-title-input')?.value)) === 'Thermodynamics');
} else check('clicking a heading in the Outline pane shows it in the map', false, 'outline pane item not found');
await shot('03-dark-outline-pane');

// --- light theme -----------------------------------------------------------------------
await ev(() => window.app.changeTheme('moonstone'));
await wait(1000);
const light = await ev(() => {
  const stage = document.querySelector('.om3d-stage');
  return { isLight: stage?.classList.contains('is-light'), label: stage?.style.getPropertyValue('--om3d-label-color'), bg: getComputedStyle(document.body).getPropertyValue('--background-primary').trim() };
});
check('switching Obsidian to the light theme re-colours the map (labels dark on light)', light.isLight && light.label === '#1f2328', light);
await shot('04-light-study-guide');

await ev(() => { const v = window.app.plugins.plugins['obsidian-3d-mindmap'].views()[0]; v.containerEl.style.maxWidth = '380px'; });
await wait(600);
const narrowFit = await fit();
const narrowState = await ev(() => ({ narrow: document.querySelector('.om3d-root').classList.contains('is-narrow'), inspector: getComputedStyle(document.querySelector('.om3d-inspector')).display }));
check(`narrow pane (${narrowFit.width} px): toolbar wraps, nothing clipped, inspector stays out of the way`, !narrowFit.hidden.length && narrowFit.overflow <= 0 && narrowState.narrow && narrowState.inspector === 'none', { ...narrowFit, ...narrowState });
await shot('04b-light-narrow-pane');
await ev(() => { const v = window.app.plugins.plugins['obsidian-3d-mindmap'].views()[0]; v.containerEl.style.maxWidth = ''; });
await wait(600);

// --- every visible string of the plugin is English ----------------------------------------
const strings = new Set();
const menuButtons = page.locator('.om3d-toolbar button[aria-haspopup="menu"]');
const menuCount = await menuButtons.count();
for (let k = 0; k < menuCount; k++) {
  await menuButtons.nth(k).click();
  await wait(250);
  for (const s of await page.evaluate(() => [...document.querySelectorAll('.om3d-menu *')].map(e => e.innerText ?? ''))) if (s.trim()) strings.add(s.trim());
  if (k === 2) await shot('05-light-layout-menu');
  await page.keyboard.press('Escape');
  await wait(150);
}
for (const s of await page.evaluate(() => [...document.querySelectorAll('.om3d-root *')].filter(e => !e.closest('.om3d-labels')).flatMap(e => [e.innerText ?? '', e.getAttribute('aria-label') ?? '', e.getAttribute('title') ?? '']))) if (s.trim()) strings.add(s.trim());
await ev(id => { window.app.setting.open(); window.app.setting.openTabById(id); }, ID);
await page.waitForSelector('.modal.mod-settings', { timeout: 5000 }).catch(() => {});
await wait(1200);
for (const s of await page.evaluate(() => [...document.querySelectorAll('.vertical-tab-content *')].map(e => e.innerText ?? ''))) if (s.trim()) strings.add(s.trim());
await shot('06-light-settings');
await ev(() => window.app.setting.close());
for (const name of await ev(id => Object.values(window.app.commands.commands).filter(c => c.id.startsWith(`${id}:`)).map(c => c.name), ID)) strings.add(name);
for (const s of await ev(() => [...document.querySelectorAll('.notice')].map(n => n.innerText))) strings.add(s);
const bad = [...strings].filter(s => NON_ENGLISH.test(s) || /\{[a-zA-Z]+\}/.test(s));
check(`all ${strings.size} plugin strings in Obsidian (toolbar, menus, inspector, settings, commands, notices) are English`, !bad.length, bad.join(' | '));
check(`${menuCount} toolbar menus`, menuCount === 7, menuCount);

// --- export, file rename ------------------------------------------------------------------
await ev(() => window.app.plugins.plugins['obsidian-3d-mindmap'].views()[0].exportPng());
await wait(1500);
const png = await ev(async () => { const f = window.app.vault.getAbstractFileByPath('Study guide.3d.png'); if (!f) return 0; const size = f.stat.size; await window.app.vault.delete(f); return size; });
check('PNG export writes an image next to the note', png > 5000, png);
const renamed = await ev(async () => {
  const p = window.app.plugins.plugins['obsidian-3d-mindmap'];
  const marks = p.store.getMarks('Study guide.md').length;
  await window.app.fileManager.renameFile(window.app.vault.getAbstractFileByPath('Study guide.md'), 'Folder/Study guide moved.md');
  await new Promise(r => setTimeout(r, 800));
  const after = { movedMarks: p.store.getMarks('Folder/Study guide moved.md').length, title: p.views()[0].getDisplayText(), oldGone: !p.store.getPose('Study guide.md') };
  await window.app.fileManager.renameFile(window.app.vault.getAbstractFileByPath('Folder/Study guide moved.md'), 'Study guide.md');
  await new Promise(r => setTimeout(r, 800));
  return { marks, ...after, back: p.store.getMarks('Study guide.md').length };
});
check('renaming/moving the note keeps its map data and updates the title', renamed.marks > 0 && renamed.movedMarks === renamed.marks && renamed.oldGone && renamed.title.includes('Study guide moved') && renamed.back === renamed.marks, renamed);

// --- 3,000-node outline: idle cost and camera frame timing in the real app ----------------------
await ev(async () => {
  const v = window.app.plugins.plugins['obsidian-3d-mindmap'].views()[0];
  await v.bindFile(window.app.vault.getAbstractFileByPath('Large outline 3000.md'));
});
await page.waitForFunction(() => window.app.plugins.plugins['obsidian-3d-mindmap'].views()[0].internals.graph?.ids.length > 2900, null, { timeout: 30000 });
const settledMs = await settle();
await wait(500);
const perf = await ev(async () => {
  const v = window.app.plugins.plugins['obsidian-3d-mindmap'].views()[0];
  const n = v.internals, r = n.renderer;
  const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))] * 10) / 10 : null; };
  const renders0 = r.stats.renders;
  await new Promise(res => setTimeout(res, 3000));
  const idleRenders = r.stats.renders - renders0;
  const intervals = [], cpu = [];
  let last = 0;
  const t0 = performance.now();
  await new Promise(res => {
    const loop = ts => {
      if (last) intervals.push(ts - last);
      last = ts;
      r.rig.orbit(3, 0.4); r.requestFrame();
      if (performance.now() - t0 < 5000) requestAnimationFrame(loop); else res();
    };
    requestAnimationFrame(loop);
  });
  cpu.push(...r.stats.recent);
  const d = v.diagnostics();
  return {
    nodes: n.graph.ids.length, idleRendersIn3s: idleRenders, displayFps: Math.round(intervals.length / 5),
    intervalMs: { p50: pct(intervals, 50), p95: pct(intervals, 95), p99: pct(intervals, 99) }, renderCpuMs: { p50: pct(cpu, 50), p95: pct(cpu, 95) },
    drawCalls: d.renderer?.drawCalls, labels: d.renderer?.labelsShown, dom: d.dom.viewElements, memoryMB: d.memoryMB, physics: { backend: d.physics.backend, stop: d.physics.diagnostics?.stopReason, stepMs: d.physics.diagnostics?.lastStepMs },
  };
});
check('a settled 3,000-node map draws nothing while idle', perf.idleRendersIn3s === 0, perf);
check('3,000 nodes: camera orbit at display rate (render CPU p95 < 16.7 ms)', perf.renderCpuMs.p95 < 16.7 && perf.displayFps >= 50, perf);
await shot('07-light-large-outline');

// --- unload and reload the plugin ----------------------------------------------------------------
await ev(async id => { await window.app.plugins.disablePlugin(id); }, ID);
await wait(800);
const leftovers = await ev(() => ({ roots: document.querySelectorAll('.om3d-root').length, katex: !!document.getElementById('om3d-katex'), menus: document.querySelectorAll('.om3d-menu').length }));
check('disabling the plugin removes its views, menus and styles', leftovers.roots === 0 && !leftovers.katex && leftovers.menus === 0, leftovers);
await ev(async id => { await window.app.plugins.enablePlugin(id); }, ID);
await wait(1500);
check('re-enabling the plugin loads it again', await ev(id => !!window.app.plugins.plugins[id], ID));

check('no errors in the Obsidian console during the run', errors.length === 0, errors.join('\n'));
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ at: new Date().toISOString(), obsidian: facts.obsidian, plugin: facts.version, settledMs, perf, checks, errors }, null, 2));
const failed = checks.filter(c => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed. Screenshots and report: ${path.relative(root, outDir)}`);
if (!argv.includes('--keep-open')) await ev(() => { setTimeout(() => window.close(), 100); }).catch(() => {});
await browser.close().catch(() => {});
process.exit(failed ? 1 : 0);
