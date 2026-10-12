// Interactive UI smoke test in a real browser (development tool).
//
//   npm run test:ui            (node scripts/ui-smoke.mjs [--headed])
//
// Loads the built plugin (dist/) into tests/harness with an in-memory note and
// drives it with real mouse and keyboard input in light and dark themes:
// menus, selection, branches, history, inline create/rename + undo, connect
// mode, arranging, search, external edits, settings tab, diagnostics and PNG
// export. Every visible string is checked to be English. Screenshots and a
// JSON report go to _tmp/ui-smoke/. Exit code 1 when a check fails.
import fs from 'node:fs';
import path from 'node:path';
import { launch, openHarness, root, serve } from './lib/harness-browser.mjs';

const headed = process.argv.includes('--headed');
const outDir = path.join(root, '_tmp', 'ui-smoke');
fs.mkdirSync(outDir, { recursive: true });
const NON_ENGLISH = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/;
const PLACEHOLDER = /\{[a-zA-Z]+\}/;
const checks = [];
const check = (theme, name, ok, detail = '') => { checks.push({ theme, name, ok: !!ok, detail: String(detail).slice(0, 400) }); };

const { server, origin } = await serve();
const browser = await launch({ headed });

/** Screen point (page coordinates) of node `index`. */
async function nodePoint(page, index) {
  return page.evaluate(i => {
    const n = window.H.internals();
    const p = n.engine.positions;
    const s = n.renderer.project({ x: p[i * 4], y: p[i * 4 + 1], z: p[i * 4 + 2] });
    const rect = n.renderer.canvas.getBoundingClientRect();
    return s ? { x: rect.left + s.x, y: rect.top + s.y } : null;
  }, index);
}
const noteText = page => page.evaluate(() => window.H.app.__store.get('Fixture.md'));
const indexOf = (page, text) => page.evaluate(t => window.H.internals().graph.labels.findIndex(l => l.text === t), text);
const settle = page => page.evaluate(() => window.H.waitSettled(15000));

for (const theme of ['dark', 'light']) {
  const { page, errors } = await openHarness(browser, origin, { fixture: 'notesAndLinks', theme, layout: 'tree' });
  const strings = new Set();
  const collect = async selector => {
    for (const s of await page.evaluate(sel => {
      const out = [];
      for (const el of document.querySelectorAll(sel)) {
        if (el.closest('.om3d-labels')) continue;
        out.push(el.textContent ?? '', el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? '', el.getAttribute('placeholder') ?? '');
      }
      return out;
    }, selector)) if (s.trim()) strings.add(s.trim());
  };
  await settle(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, `${theme}-1-overview.png`) });
  await collect('.om3d-toolbar, .om3d-toolbar *, .om3d-inspector *, .om3d-stage > :not(.om3d-labels) *');
  const formulas = await page.evaluate(() => window.H.internals().graph.labels.filter(l => l.html.includes('class="katex"')).length);
  check(theme, 'formulas in node text render with KaTeX', formulas >= 1, formulas);

  // Menus: open each with the mouse, read it, close with Escape (focus returns to the button).
  const menuButtons = await page.$$('.om3d-toolbar button[aria-haspopup="menu"]');
  check(theme, 'toolbar has 7 menus', menuButtons.length === 7, menuButtons.length);
  for (const [k, button] of menuButtons.entries()) {
    await button.click();
    const open = await page.waitForSelector('.om3d-menu', { timeout: 2000 }).catch(() => null);
    check(theme, `menu ${k} opens`, !!open);
    await collect('.om3d-menu, .om3d-menu *');
    if (k === 2) await page.screenshot({ path: path.join(outDir, `${theme}-2-layout-menu.png`) });
    await page.keyboard.press('Escape');
    const closed = await page.evaluate(() => !document.querySelector('.om3d-menu'));
    const focused = await page.evaluate(b => document.activeElement === b, button);
    check(theme, `menu ${k} closes with Escape and returns focus`, closed && focused, `closed=${closed} focused=${focused}`);
  }
  // Keyboard-only menu navigation: ArrowDown opens, arrows move, Escape closes.
  await menuButtons[0].focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(80);
  const roving = await page.evaluate(() => document.activeElement?.closest('.om3d-menu') !== null && document.activeElement?.getAttribute('role')?.startsWith('menuitem'));
  check(theme, 'menu keyboard focus', roving);
  await page.keyboard.press('Escape');

  // Selection by clicking a sphere.
  const chapter = await indexOf(page, 'Second chapter');
  let pt = await nodePoint(page, chapter);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(150);
  const inspectorTitle = await page.$eval('.om3d-title-input', el => el.value).catch(() => null);
  check(theme, 'click selects node and inspector shows it', inspectorTitle === 'Second chapter', inspectorTitle);
  await collect('.om3d-inspector *');

  // Enter the branch by double-click, leave with Escape, return with Alt+Left.
  await page.mouse.dblclick(pt.x, pt.y);
  await page.waitForTimeout(700);
  const crumbs = await page.$eval('.om3d-crumbs', el => el.textContent);
  const dimmed = await page.evaluate(() => { const n = window.H.internals(); return n.graph ? Array.from(n.emphasis?.dimmed ?? []).filter(Boolean).length : -1; });
  check(theme, 'double-click enters branch (breadcrumb + faded rest)', crumbs.includes('Second chapter') && dimmed > 0, `${crumbs} dimmed=${dimmed}`);
  await page.screenshot({ path: path.join(outDir, `${theme}-3-branch.png`) });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const afterEsc = await page.evaluate(() => Array.from(window.H.internals().emphasis?.dimmed ?? []).filter(Boolean).length);
  check(theme, 'Escape leaves the branch', afterEsc === 0, afterEsc);
  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForTimeout(600);
  const back = await page.evaluate(() => Array.from(window.H.internals().emphasis?.dimmed ?? []).filter(Boolean).length);
  check(theme, 'Alt+Left returns to the branch', back > 0, back);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Inline create (Tab = child), chain with Enter (sibling), cancel with Escape; then undo.
  const before = await noteText(page);
  pt = await nodePoint(page, await indexOf(page, 'Duplicate'));
  await page.mouse.click(pt.x, pt.y);
  await page.keyboard.press('Tab');
  await page.waitForSelector('.om3d-node-editor:not([hidden])', { timeout: 2000 });
  await page.keyboard.type('Smoke child');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const chained = await page.evaluate(() => !document.querySelector('.om3d-node-editor').hidden);
  await page.keyboard.type('Smoke sibling');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  let text = await noteText(page);
  check(theme, 'Tab/Enter create child and sibling in the note', chained && text.includes('- Duplicate\n  - Smoke child\n  - Smoke sibling\n'), text);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(250);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  text = await noteText(page);
  check(theme, 'Ctrl+Z restores the note exactly', text === before, text);
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(400);
  text = await noteText(page);
  check(theme, 'Ctrl+Y redoes', text.includes('  - Smoke child') && !text.includes('Smoke sibling'), text);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);

  // Rename with F2.
  pt = await nodePoint(page, await indexOf(page, 'Nested under duplicate'));
  await page.mouse.click(pt.x, pt.y);
  await page.keyboard.press('F2');
  await page.waitForSelector('.om3d-node-editor:not([hidden])', { timeout: 2000 });
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Renamed item');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  text = await noteText(page);
  check(theme, 'F2 renames in the note', text.includes('  - Renamed item') && !text.includes('Nested under duplicate'), text);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  check(theme, 'rename undone', (await noteText(page)) === before);

  // Camera moves never write to the note.
  const rev = await page.evaluate(() => window.H.app.__store.get('Fixture.md'));
  await page.mouse.move(400, 400); await page.mouse.down(); await page.mouse.move(520, 450, { steps: 8 }); await page.mouse.up();
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(500);
  check(theme, 'rotating and zooming leave the note unchanged', (await noteText(page)) === rev);

  // Rotation centre: switching modes keeps the camera where it is; in "selected"
  // mode a node moved by the force layout stays fixed on screen.
  const cameraPos = () => page.evaluate(async () => {
    const r = window.H.internals().renderer;
    for (let k = 0; k < 200 && r.rig.moving; k++) await new Promise(res => requestAnimationFrame(res));
    return r.camera.position.toArray();
  });
  const p0 = await cameraPos();
  await page.evaluate(() => window.H.plugin.updateSettings({ orbitCenter: 'root' }));
  await page.waitForTimeout(300);
  const p1 = await cameraPos();
  await page.evaluate(() => window.H.plugin.updateSettings({ orbitCenter: 'selected' }));
  await page.waitForTimeout(300);
  const p2 = await cameraPos();
  const drift = Math.max(...p0.map((v, k) => Math.abs(v - p1[k])), ...p0.map((v, k) => Math.abs(v - p2[k])));
  check(theme, 'switching the rotation centre does not move the camera', drift < 1e-3, drift);
  await page.evaluate(() => window.H.plugin.updateSettings({ layout: 'force' }));
  await settle(page);
  const target = await indexOf(page, 'Second chapter');
  await page.evaluate(i => window.H.internals().select(window.H.internals().graph.ids[i]), target);
  await page.waitForTimeout(300);
  const track = await page.evaluate(async i => {
    const n = window.H.internals();
    const id = n.graph.ids[i];
    const start = { x: n.engine.positions[i * 4], y: n.engine.positions[i * 4 + 1], z: n.engine.positions[i * 4 + 2] };
    const samples = [];
    // Move the node through the world (as a layout or a drag would) for 60 frames.
    for (let k = 1; k <= 60; k++) {
      n.engine.drag(id, { x: start.x + 3 * k, y: start.y + 1.5 * k, z: start.z - 2 * k });
      n.renderer.requestFrame();
      await new Promise(r => requestAnimationFrame(r));
      const p = n.engine.positions;
      const s = n.renderer.project({ x: p[i * 4], y: p[i * 4 + 1], z: p[i * 4 + 2] });
      if (k > 3) samples.push([s.x, s.y, Math.hypot(p[i * 4] - start.x, p[i * 4 + 1] - start.y, p[i * 4 + 2] - start.z)]);
    }
    n.engine.release(id, null);
    const xs = samples.map(s => s[0]), ys = samples.map(s => s[1]), ws = samples.map(s => s[2]);
    return { screen: Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)), world: Math.max(...ws) - Math.min(...ws), frames: samples.length };
  }, target);
  check(theme, 'selected node stays put on screen while it moves through the world', track.world > 1 && track.screen < 1.5, JSON.stringify(track));
  await page.evaluate(() => window.H.plugin.updateSettings({ orbitCenter: 'free', layout: 'tree' }));
  await settle(page);

  // Connect mode: click two nodes -> one association in plugin data, note unchanged.
  await page.keyboard.press('Home');
  await page.waitForTimeout(700);
  await page.click('.om3d-segmented button:nth-child(3)');
  const a = await nodePoint(page, await indexOf(page, 'Formula and links'));
  const b = await nodePoint(page, await indexOf(page, 'Nested under duplicate'));
  await page.mouse.click(a.x, a.y); await page.waitForTimeout(120);
  await page.mouse.click(b.x, b.y); await page.waitForTimeout(300);
  const links = await page.evaluate(() => window.H.plugin.store.getLinks('Fixture.md').length);
  check(theme, 'connect mode creates an association', links === 1 && (await noteText(page)) === before, links);
  await page.screenshot({ path: path.join(outDir, `${theme}-4-association.png`) });
  await collect('.om3d-inspector *, .om3d-status');
  await page.keyboard.press('Escape');

  // Arrange mode: drag a node, its position is pinned for this layout.
  await page.click('.om3d-segmented button:nth-child(2)');
  const c = await nodePoint(page, await indexOf(page, 'Duplicate'));
  await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.mouse.move(c.x + 70, c.y + 40, { steps: 10 }); await page.mouse.up();
  await page.waitForTimeout(300);
  const anchors = await page.evaluate(() => Object.keys(window.H.plugin.store.getAnchors('Fixture.md', window.H.plugin.config.layout)).length);
  check(theme, 'arrange drag pins the node', anchors === 1 && (await noteText(page)) === before, anchors);
  await page.keyboard.press('Escape');

  // Search.
  await page.keyboard.press('Control+f');
  await page.waitForSelector('.om3d-search:not([hidden])', { timeout: 2000 });
  await page.keyboard.type('Duplicate');
  await page.waitForTimeout(400);
  const count = await page.$eval('.om3d-search-count', el => el.textContent);
  check(theme, 'search finds the three matching nodes', count === '1 of 3', count);
  await collect('.om3d-search, .om3d-search *');
  await page.screenshot({ path: path.join(outDir, `${theme}-5-search.png`) });
  await page.keyboard.press('Escape');

  // External edit while the map is open.
  await page.evaluate(() => window.H.app.vault.externalEdit('Fixture.md', window.H.app.__store.get('Fixture.md') + '\n# Added outside\n- Fresh item\n'));
  await page.waitForTimeout(800);
  const added = await indexOf(page, 'Added outside');
  check(theme, 'external edits appear in the map', added >= 0, added);

  // Settings tab, commands, diagnostics, export.
  await page.evaluate(() => { const tab = window.H.plugin.settingTabs[0]; document.body.append(tab.containerEl); tab.display(); });
  await collect('.vertical-tab-content *');
  for (const name of await page.evaluate(() => window.H.plugin.commands.map(c => c.name))) strings.add(name);
  await page.evaluate(() => window.H.view().runAction('diagnostics'));
  const report = await page.$eval('.om3d-diagnostics-report', el => el.textContent).catch(() => '');
  check(theme, 'diagnostics contain no note text', report.length > 50 && !/Duplicate|Formula|Fixture/.test(report), report.slice(0, 200));
  await collect('.modal-container *');
  await page.evaluate(() => document.querySelectorAll('.modal-container').forEach(m => m.remove()));
  await page.evaluate(() => window.H.view().exportPng());
  await page.waitForTimeout(300);
  const png = await page.evaluate(() => { const v = window.H.app.__store.get('Fixture.3d.png'); return v ? v.byteLength ?? v.length : 0; });
  check(theme, 'PNG export writes next to the note', png > 1000, png);
  for (const n of await page.evaluate(() => window.H.notices)) strings.add(n);
  await collect('.om3d-inspector *, .om3d-toolbar *');

  const bad = [...strings].filter(s => NON_ENGLISH.test(s) || PLACEHOLDER.test(s));
  check(theme, `all ${strings.size} interface strings are English with no unfilled placeholders`, !bad.length, bad.join(' | '));
  check(theme, 'no page errors', !errors.length, errors.join('\n'));
  await page.screenshot({ path: path.join(outDir, `${theme}-6-final.png`) });
  fs.writeFileSync(path.join(outDir, `${theme}-strings.txt`), [...strings].sort().join('\n'));
  await page.close();
}

await browser.close();
server.close();
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ at: new Date().toISOString(), checks }, null, 2));
const failed = checks.filter(c => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} [${c.theme}] ${c.name}${c.ok ? '' : `\n       ${c.detail}`}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Screenshots: ${path.relative(root, outDir)}`);
process.exit(failed.length ? 1 : 0);
