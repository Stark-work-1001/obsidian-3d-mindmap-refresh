// Reproducible browser benchmark for the plugin (development tool).
//
//   node scripts/bench.mjs [--build dist|baseline] [--counts 300,1200,3000]
//                          [--fixtures balanced] [--scenarios simulation,idle,camera,editing,transitions]
//                          [--seconds 5] [--repeat 1] [--headed] [--out file.json]
//
// Summarise one or more result files with: node scripts/bench-report.mjs <file.json>...
//
// It serves the repository on 127.0.0.1, launches an installed Chromium-based
// browser (Edge by default; set BENCH_BROWSER=chrome or BENCH_EXECUTABLE=path)
// through playwright-core, loads tests/harness with in-memory fixtures and
// records frame-interval and rAF-work percentiles, draw calls, label DOM count,
// worker step time and heap growth. Nothing leaves the machine.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import pw from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const builds = (args.build ?? 'dist').split(',');
const counts = (args.counts ?? '300,1200,3000').split(',').map(Number);
const fixtureNames = (args.fixtures ?? 'balanced').split(',');
const scenarios = (args.scenarios ?? 'simulation,idle,camera,editing,transitions').split(',');
const seconds = Number(args.seconds ?? 5);
const repeat = Math.max(1, Number(args.repeat ?? 1));
const viewport = { width: 1280, height: 720 };

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const launch = { headless: args.headed !== 'true', args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] };
if (process.env.BENCH_EXECUTABLE) launch.executablePath = process.env.BENCH_EXECUTABLE;
else launch.channel = process.env.BENCH_BROWSER === 'chrome' ? 'chrome' : 'msedge';
const browser = await pw.chromium.launch(launch);

const results = [];
// Repetitions are interleaved across builds so slow drifts of the machine affect both alike.
for (let rep = 0; rep < repeat; rep++) for (const fixture of fixtureNames) for (const count of counts) for (const scenario of scenarios) for (const build of builds) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1.5 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const layout = scenario === 'simulation' ? 'force' : (args.layout ?? 'force');
  await page.goto(`http://127.0.0.1:${port}/tests/harness/index.html?build=${build}&fixture=${fixture}&count=${count}&theme=dark&layout=${layout}&w=1280&h=680`);
  await page.waitForFunction(() => window.H && (window.H.view || window.H.error), null, { timeout: 60000 });
  const failed = await page.evaluate(() => window.H.error ?? null);
  if (failed) { console.error(build, fixture, count, scenario, failed); results.push({ build, fixture, count, scenario, error: failed }); await page.close(); continue; }
  const gpu = await page.evaluate(() => { const c = document.createElement('canvas').getContext('webgl2'); const d = c.getExtension('WEBGL_debug_renderer_info'); return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'n/a'; });
  const result = await page.evaluate(async ([s, sec]) => window.H.scenario(s, sec), [scenario, seconds]);
  const version = await page.evaluate(() => window.H.manifest.version);
  const row = { build, version, fixture, count, scenario, rep, gpu, ...result, pageErrors: errors };
  results.push(row);
  console.log(`${build} ${version} ${fixture}-${count} ${scenario}: interval p50 ${result.frameIntervalMs.p50} p95 ${result.frameIntervalMs.p95} p99 ${result.frameIntervalMs.p99} ms | rAF work p50 ${result.rafWorkMs.p50} p95 ${result.rafWorkMs.p95} ms (${result.rafWorkMs.totalPerSecond} ms/s) | renders/s ${result.renderedPerSecond} | calls ${result.drawCalls.p50} | labels ${result.labelsDomMax} | worker ${result.workerStepMs?.p50 ?? '-'} ms | heap +${result.heapDeltaMB} MB${errors.length ? ' | ERRORS ' + errors.length : ''}`);
  await page.close();
}
await browser.close();
server.close();

const meta = { at: new Date().toISOString(), node: process.version, platform: `${os.platform()} ${os.release()}`, cpu: os.cpus()[0]?.model, cores: os.cpus().length, memGB: Math.round(os.totalmem() / 2 ** 30), viewport, deviceScaleFactor: 1.5, headless: launch.headless, seconds, repeat };
const out = args.out ?? path.join(root, '_tmp', 'bench', `${builds.join('+')}-${Date.now()}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ meta, results }, null, 2));
console.log('wrote', path.relative(root, out));
