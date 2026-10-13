// Browser sweep over every layout and several outline shapes (development tool).
//
//   node scripts/layout-sweep.mjs [--count 3000] [--fixtures balanced,deepChains,wide,uneven,malformed]
//
// For each fixture it opens the built plugin in tests/harness, switches through
// all 23 layouts and records: page errors, layout time, overlapping sphere
// pairs after layout, how long the map took to come to rest, labels shown and
// draw calls. Screenshots of the study and structure layouts go to
// _tmp/layout-sweep/; the table is printed and saved as JSON.
import fs from 'node:fs';
import path from 'node:path';
import { launch, openHarness, root, serve } from './lib/harness-browser.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const count = Number(args.count ?? 3000);
const fixtures = (args.fixtures ?? 'balanced,deepChains,wide,uneven,malformed').split(',');
const outDir = path.join(root, '_tmp', 'layout-sweep');
fs.mkdirSync(outDir, { recursive: true });
const { server, origin } = await serve();
const browser = await launch();
const rows = [];
for (const fixture of fixtures) {
  const { page, errors } = await openHarness(browser, origin, { fixture, count: String(count), layout: 'tree', theme: 'light' });
  const ids = ['knowledge', 'bookshelf', 'journey', 'tree', 'radial', 'cone', 'force', 'bond', 'pennate', 'rdf', 'shell', 'orbital', 'coil', 'lattice', 'disk', 'rays', 'slabs', 'curtain', 'dandelion', 'nebula', 'grid', 'scatter', 'hub'];
  for (const id of ids) {
    const before = errors.length;
    const r = await page.evaluate(async layout => {
      const H = window.H;
      const t0 = performance.now();
      H.setLayout(layout);
      const settledMs = await H.waitSettled(20000);
      const n = H.internals();
      const e = n.engine, p = e.positions, rad = e.radii;
      // Overlapping pairs after layout (grid hashing, exact test).
      let overlaps = 0;
      const cell = Math.max(1, Math.max(...rad) * 2), grid = new Map();
      for (let i = 0; i < e.count; i++) {
        const k = `${Math.floor(p[i * 4] / cell)},${Math.floor(p[i * 4 + 1] / cell)},${Math.floor(p[i * 4 + 2] / cell)}`;
        (grid.get(k) ?? grid.set(k, []).get(k)).push(i);
      }
      for (let i = 0; i < e.count; i++) {
        const cx = Math.floor(p[i * 4] / cell), cy = Math.floor(p[i * 4 + 1] / cell), cz = Math.floor(p[i * 4 + 2] / cell);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          for (const j of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            if (j <= i) continue;
            const d = Math.hypot(p[i * 4] - p[j * 4], p[i * 4 + 1] - p[j * 4 + 1], p[i * 4 + 2] - p[j * 4 + 2]);
            if (d < (rad[i] + rad[j]) * 0.98) overlaps++;
          }
        }
      }
      await new Promise(res => setTimeout(res, 200));
      const s = H.stats();
      return { layout, nodes: e.count, layoutMs: e.lastRun ? Math.round(e.lastRun.ms) : null, settledMs: settledMs === null ? null : Math.round(settledMs), totalMs: Math.round(performance.now() - t0), overlaps, labels: s.labelsShown, calls: s.calls, physics: e.physicsBackend };
    }, id);
    r.errors = errors.length - before;
    r.fixture = fixture;
    rows.push(r);
    if (fixture === fixtures[0] && ['knowledge', 'bookshelf', 'journey', 'tree', 'radial', 'cone', 'force'].includes(id)) await page.screenshot({ path: path.join(outDir, `${fixture}-${count}-${id}.png`) });
    console.log(`${fixture.padEnd(10)} ${id.padEnd(10)} nodes ${String(r.nodes).padStart(5)} layout ${String(r.layoutMs ?? '-').padStart(5)} ms  rest ${String(r.settledMs ?? 'timeout').padStart(6)} ms  overlaps ${String(r.overlaps).padStart(4)}  labels ${String(r.labels).padStart(3)}  calls ${r.calls}  ${r.physics}${r.errors ? `  ERRORS ${r.errors}` : ''}`);
  }
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await page.close();
}
await browser.close();
server.close();
fs.writeFileSync(path.join(outDir, `sweep-${count}.json`), JSON.stringify(rows, null, 2));
const bad = rows.filter(r => r.errors);
console.log(`\n${rows.length} runs, ${bad.length} with page errors. Results: ${path.relative(root, path.join(outDir, `sweep-${count}.json`))}`);
process.exit(bad.length ? 1 : 0);
