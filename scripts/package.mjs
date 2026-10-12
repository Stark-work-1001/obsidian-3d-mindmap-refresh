// Build the public archives from an explicit allowlist and audit them.
//
//   node scripts/package.mjs            (run `npm run build` first)
//
// release/obsidian-3d-mindmap-<version>.zip         installable plugin folder
// release/obsidian-3d-mindmap-<version>-source.zip  reproducible source
// release/SHA256SUMS.txt
//
// Only allowlisted paths are collected. Every archive is then read back and
// audited: no build debris (node_modules, target, _tmp, dist, .git, maps), no
// plugin data or vault files (data.json, .obsidian), no machine-specific paths
// or user names, no credentials. Any finding aborts with exit code 1.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditEntries } from './lib/audit.mjs';
import { createZip, readZip } from './lib/zip.mjs';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;
const id = manifest.id;
const dist = path.join(root, 'dist', id);
const outDir = path.join(root, 'release');

function fail(message) { console.error(`package: ${message}`); process.exit(1); }

/** Allowlisted source paths (files or directories, relative to the repository). */
const SOURCE_ALLOWLIST = [
  '.editorconfig', '.gitattributes', '.gitignore', '.npmrc', '.github/workflows/release.yml',
  'CHANGELOG.md', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md',
  'Cargo.toml', 'Cargo.lock', 'crates/graph-physics/Cargo.toml', 'crates/graph-physics/LICENSE', 'crates/graph-physics/src',
  'docs', 'licenses', 'reference', 'scripts', 'src', 'tests',
  'manifest.json', 'versions.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'styles.css',
];
const RELEASE_FILES = ['main.js', 'manifest.json', 'styles.css'];

function collect(rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) fail(`allowlisted path missing: ${rel}`);
  if (fs.statSync(full).isFile()) return [rel.replace(/\\/g, '/')];
  return fs.readdirSync(full).flatMap(name => collect(path.join(rel, name)));
}

// --- audit -------------------------------------------------------------------------
const user = os.userInfo().username;
function audit(label, entries) {
  // The audit modules hold the patterns themselves; their text is not scanned.
  const findings = auditEntries(entries, { user, skipContent: ['scripts/lib/audit.mjs', 'tests/package-audit.test.mjs'] });
  if (findings.length) fail(`${label} audit failed:\n  ${findings.join('\n  ')}`);
  console.log(`${label}: ${entries.length} files, audit passed`);
}
// --- release archive --------------------------------------------------------------
for (const f of RELEASE_FILES) if (!fs.existsSync(path.join(dist, f))) fail(`dist/${id}/${f} missing: run npm run build`);
const builtManifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
if (builtManifest.version !== version || builtManifest.id !== id) fail('dist/ is from a different version: rebuild');
const releaseEntries = [
  ...RELEASE_FILES.map(f => ({ name: `${id}/${f}`, data: fs.readFileSync(path.join(dist, f)) })),
  ...['LICENSE', 'THIRD_PARTY_NOTICES.md'].map(f => ({ name: `${id}/${f}`, data: fs.readFileSync(path.join(root, f)) })),
];
const sourceEntries = [...new Set(SOURCE_ALLOWLIST.flatMap(collect))].map(rel => ({ name: `${id}-${version}-source/${rel}`, data: fs.readFileSync(path.join(root, rel)) }));

fs.mkdirSync(outDir, { recursive: true });
const archives = [
  { file: `${id}-${version}.zip`, entries: releaseEntries },
  { file: `${id}-${version}-source.zip`, entries: sourceEntries },
];
const sums = [];
for (const archive of archives) {
  audit(`${archive.file} (input)`, archive.entries);
  const zip = createZip(archive.entries);
  const target = path.join(outDir, archive.file);
  fs.writeFileSync(target, zip);
  // Audit what was actually written, not what we meant to write.
  const back = readZip(fs.readFileSync(target));
  if (back.length !== archive.entries.length) fail(`${archive.file}: entry count mismatch`);
  audit(archive.file, back);
  sums.push(`${crypto.createHash('sha256').update(zip).digest('hex')}  ${archive.file}`);
  console.log(`wrote release/${archive.file} (${(zip.length / 1024).toFixed(0)} KiB)`);
}
for (const f of RELEASE_FILES) sums.push(`${crypto.createHash('sha256').update(fs.readFileSync(path.join(dist, f))).digest('hex')}  ${f}`);
fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
console.log('wrote release/SHA256SUMS.txt');
