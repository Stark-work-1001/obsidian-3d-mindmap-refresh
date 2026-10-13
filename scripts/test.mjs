// Test runner: bundles every tests/**/*.test.ts with esbuild into
// _tmp/test-build and runs them (plus plain *.test.mjs files) with node:test.
//   node scripts/test.mjs [filter]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const filter = process.argv[2] ?? '';
const out = path.join(root, '_tmp', 'test-build');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

function collect(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'harness' ? [] : collect(full);
    return /\.test\.(ts|mjs)$/.test(entry.name) ? [full] : [];
  });
}

const files = collect(path.join(root, 'tests')).filter(f => f.includes(filter));
const runnable = [];
for (const file of files) {
  if (file.endsWith('.mjs')) { runnable.push(file); continue; }
  const target = path.join(out, path.relative(path.join(root, 'tests'), file).replace(/[\\/]/g, '__').replace(/\.ts$/, '.mjs'));
  await esbuild.build({
    entryPoints: [file], outfile: target, bundle: true, platform: 'node', format: 'esm', target: 'node20',
    sourcemap: 'inline', logLevel: 'warning', alias: { obsidian: path.join(root, 'tests', 'support', 'obsidian-node-stub.ts') },
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    define: { 'process.env.OM3D_ROOT': JSON.stringify(root) },
  });
  runnable.push(target);
}
if (!runnable.length) { console.error('no tests matched'); process.exit(1); }
const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...runnable], { stdio: 'inherit', cwd: root });
process.exit(result.status ?? 1);
