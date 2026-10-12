// Summarise benchmark result files (from scripts/bench.mjs) as Markdown tables.
//
//   node scripts/bench-report.mjs _tmp/bench/a.json [_tmp/bench/b.json ...]
//
// Rows are grouped by build, outline size and scenario; with repeated runs the
// median of each statistic is shown (and the range of the frame-interval p95).
import fs from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node scripts/bench-report.mjs <result.json>...'); process.exit(1); }
const rows = files.flatMap(f => JSON.parse(fs.readFileSync(f, 'utf8')).results).filter(r => !r.error && !r.unsupported);
const median = values => { const v = values.filter(x => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
const fmt = (v, d = 1) => (v == null ? '–' : Number(v).toFixed(d));
const groups = new Map();
for (const r of rows) {
  const key = `${r.scenario}|${r.count}|${r.build}`;
  (groups.get(key) ?? groups.set(key, []).get(key)).push(r);
}
const scenarios = [...new Set(rows.map(r => r.scenario))];
const order = { baseline: 0, dist: 1 };
for (const scenario of scenarios) {
  console.log(`\n### ${scenario}\n`);
  console.log('| Nodes | Build | Runs | Frame interval p50 / p95 / p99 (ms) | p95 range | Main-thread work per frame p50 / p95 (ms) | Work per second (ms) | Frames drawn per second | Worker step (ms) | Errors |');
  console.log('| ---: | --- | ---: | --- | --- | --- | ---: | ---: | ---: | ---: |');
  const keys = [...groups.keys()].filter(k => k.startsWith(`${scenario}|`)).sort((a, b) => {
    const [, ca, ba] = a.split('|'), [, cb, bb] = b.split('|');
    return Number(ca) - Number(cb) || (order[ba] ?? 9) - (order[bb] ?? 9);
  });
  for (const key of keys) {
    const g = groups.get(key);
    const [, count, build] = key.split('|');
    const p95s = g.map(r => r.frameIntervalMs.p95);
    console.log(`| ${count} | ${build === 'dist' ? `2.0 (${g[0].version})` : `${g[0].version}`} | ${g.length} | ${fmt(median(g.map(r => r.frameIntervalMs.p50)))} / ${fmt(median(p95s))} / ${fmt(median(g.map(r => r.frameIntervalMs.p99)))} | ${fmt(Math.min(...p95s))}–${fmt(Math.max(...p95s))} | ${fmt(median(g.map(r => r.rafWorkMs.p50)))} / ${fmt(median(g.map(r => r.rafWorkMs.p95)))} | ${fmt(median(g.map(r => r.rafWorkMs.totalPerSecond)), 0)} | ${fmt(median(g.map(r => r.renderedPerSecond)), 0)} | ${fmt(median(g.map(r => r.workerStepMs?.p50 ?? null)))} | ${g.reduce((a, r) => a + (r.pageErrors?.length ?? 0), 0)} |`);
  }
}
const meta = JSON.parse(fs.readFileSync(files[0], 'utf8')).meta;
console.log(`\n_${meta.cpu}, ${meta.cores} threads, ${meta.memGB} GB; ${rows[0]?.gpu ?? ''}; ${meta.platform}; Node ${meta.node}; viewport ${meta.viewport.width}x${meta.viewport.height} @${meta.deviceScaleFactor}x; ${meta.headless ? 'headless' : 'headed'}; ${meta.seconds} s per run._`);
