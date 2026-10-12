import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);
fs.mkdirSync('_tmp/logs', { recursive: true });
const buildId = crypto.createHash('sha256').update(fs.readFileSync('src/refresh.js'))
  .update(fs.readFileSync('src/recovered.js')).update(fs.readFileSync('src/rust-layout.js'))
  .update(fs.readFileSync('src/physics-worker.js')).update(fs.readFileSync('crates/graph-physics/src/physics.rs'))
  .update(fs.readFileSync('crates/graph-physics/src/lib.rs')).update(fs.readFileSync('styles.css'))
  .update(fs.readFileSync('scripts/build.mjs'))
  .update(fs.readFileSync('crates/graph-physics/Cargo.toml'))
  .update(fs.readFileSync('Cargo.lock'))
  .update(fs.readFileSync('src/learning-layouts.js'))
  .digest('hex').slice(0, 12);
if (!process.argv.includes('--js-only')) {
  const cargoBin = path.join(process.env.USERPROFILE || '', '.cargo', 'bin');
  const buildEnv = { ...process.env, PATH: `${cargoBin}${path.delimiter}${process.env.PATH}`, CARGO_BUILD_JOBS: '2' };
  execFileSync(path.join(root, 'node_modules', 'wasm-pack', 'binary', 'wasm-pack.exe'),
    ['build', 'crates/graph-physics', '--target', 'web', '--release', '--no-opt'], { stdio: 'inherit', env: buildEnv });
}
const worker = await esbuild.build({ entryPoints: ['src/physics-worker.js'], bundle: true, write: false,
  format: 'iife', target: 'es2020', minify: true, define: { 'import.meta.url': '"embedded:graph-physics"' } });
fs.writeFileSync('src/generated-physics.js',
  `// Generated from Rust sources by scripts/build.mjs.\nexport const workerCode = ${JSON.stringify(worker.outputFiles[0].text)};\n` +
  `export const wasmBase64 = ${JSON.stringify(fs.readFileSync('crates/graph-physics/pkg/graph_physics_bg.wasm').toString('base64'))};\n`);
let entry = fs.readFileSync('src/recovered.js', 'utf8');
entry = `import { installRefresh } from './refresh.js';\n` + entry + `\n
installRefresh({ Layout: io, Scene: qc, Renderer: es, Labels: Nc, View: lo, Toolbar: th, Plugin: rh,
  layoutKinds: Oi, layoutNames: cr, layoutHints: Cu, layoutGroups: rm, radiusFor: Dc,
  obsidian: Gt, openMenu: Ji, closeMenu: pn, button: ut, buildId: '${buildId}',
  THREE: { Material: Ks, BasicMaterial: ic, InstancedMesh: qr, SphereGeometry: Xo, Color: He, DynamicDrawUsage: 35048 } });
module.exports.refreshBuildId = '${buildId}';
`;
// InstancedMesh is recovered from the original Three.js bundle; fail if the
// expected prototype is not present instead of silently using another class.
const match = entry.match(/([\w$]+) = class extends tn \{\s*constructor\(e, t, n\)/);
if (!match) throw new Error('Recovered InstancedMesh class not found');
entry = entry.replace('InstancedMesh: qr', `InstancedMesh: ${match[1]}`);
await esbuild.build({ stdin: { contents: entry, resolveDir: path.join(root, 'src'), sourcefile: 'entry.js' },
  outfile: 'main.js', bundle: true, platform: 'browser', format: 'cjs', target: 'es2020',
  external: ['obsidian'], minify: true, sourcemap: 'external', legalComments: 'eof',
  banner: { js: `/* 3D Mind Map 1.17.0 | refresh ${buildId} | Rust/WASM worker | offline runtime */` } });
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
manifest.version = '1.17.0';
manifest.description = '将笔记大纲变为可编辑的 3D 思维导图，支持多种布局、公式备注、重点标记及自定义背景。';
fs.writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync('versions.json', JSON.stringify({ '1.17.0': manifest.minAppVersion }, null, 2) + '\n');
fs.writeFileSync('_tmp/logs/build.json', JSON.stringify({ version: manifest.version, buildId, builtAt: new Date().toISOString() }, null, 2));
console.log(`Built 1.17.0 (${buildId})`);
