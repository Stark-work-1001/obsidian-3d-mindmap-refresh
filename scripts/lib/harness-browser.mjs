// Shared by the browser tools (bench, UI smoke test): a static server for the
// repository on 127.0.0.1 and an installed Chromium-based browser started by
// playwright-core (Edge by default; BENCH_BROWSER=chrome or BENCH_EXECUTABLE).
// Development only: nothing is fetched from or sent to the network.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import pw from 'playwright-core';

export const root = path.resolve(import.meta.dirname, '..', '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };

export async function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

export async function launch({ headed = false } = {}) {
  const options = { headless: !headed, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] };
  if (process.env.BENCH_EXECUTABLE) options.executablePath = process.env.BENCH_EXECUTABLE;
  else options.channel = process.env.BENCH_BROWSER === 'chrome' ? 'chrome' : 'msedge';
  return pw.chromium.launch(options);
}

/** Open the harness and wait until the plugin view is ready. */
export async function openHarness(browser, origin, query, viewport = { width: 1280, height: 760 }) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.stack ?? e)));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text()) && !/404/.test(m.text())) errors.push(m.text()); });
  const params = new URLSearchParams({ build: 'dist', theme: 'dark', w: '1240', h: '700', ...query });
  await page.goto(`${origin}/tests/harness/index.html?${params}`);
  await page.waitForFunction(() => window.H && (window.H.view || window.H.error), null, { timeout: 60000 });
  const failed = await page.evaluate(() => window.H.error ?? null);
  if (failed) throw new Error(failed);
  return { page, errors };
}
