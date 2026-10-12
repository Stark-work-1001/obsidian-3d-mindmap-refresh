// Install the built plugin into a vault you name (development/manual install).
//
//   node scripts/install-to-vault.mjs --vault <path-to-vault>            dry run: shows what would happen
//   node scripts/install-to-vault.mjs --vault <path-to-vault> --yes      install
//   node scripts/install-to-vault.mjs --vault <path-to-vault> --rollback --yes
//
// Safety:
// - Writes only to <vault>/.obsidian/plugins/obsidian-3d-mindmap/. Refuses if
//   that folder holds a different plugin, and never touches other plugins
//   (for example Obsidian 3D Graph).
// - Never reads, writes or deletes data.json (your settings and saved maps).
//   2.0 upgrades data.json itself on first load and keeps data.backup-v1.json.
// - Existing main.js / manifest.json / styles.css are copied to
//   .backups/<time>_<version>/ first; --rollback restores the latest backup.
// - Copies are verified by SHA-256. Nothing is downloaded or uploaded.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ID = 'obsidian-3d-mindmap';
const FILES = ['main.js', 'manifest.json', 'styles.css'];
const root = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const option = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const fail = message => { console.error(`install: ${message}`); process.exit(1); };
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

const vaultArg = option('--vault');
if (!vaultArg) fail('usage: node scripts/install-to-vault.mjs --vault <path-to-vault> [--yes] [--rollback]');
const vault = path.resolve(vaultArg);
if (!fs.existsSync(path.join(vault, '.obsidian'))) fail(`${vault} is not an Obsidian vault (no .obsidian folder)`);
const target = path.join(vault, '.obsidian', 'plugins', ID);
const apply = flag('--yes');
const say = message => console.log(`${apply ? '' : '[dry run] '}${message}`);

if (fs.existsSync(path.join(target, 'manifest.json'))) {
  const installed = readJson(path.join(target, 'manifest.json'));
  if (installed.id !== ID) fail(`${target} contains the plugin "${installed.id}", not ${ID}; nothing was changed`);
}

function backupCurrent() {
  if (!FILES.some(f => fs.existsSync(path.join(target, f)))) return null;
  const current = fs.existsSync(path.join(target, 'manifest.json')) ? readJson(path.join(target, 'manifest.json')).version : 'unknown';
  // Time first, so the newest backup sorts last.
  const dir = path.join(target, '.backups', `${new Date().toISOString().replace(/[:.]/g, '-')}_${current}`);
  say(`back up ${current} -> ${path.relative(vault, dir)}`);
  if (apply) {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of FILES) if (fs.existsSync(path.join(target, f))) fs.copyFileSync(path.join(target, f), path.join(dir, f));
  }
  return dir;
}

function copyVerified(fromDir) {
  for (const f of FILES) {
    const src = path.join(fromDir, f);
    if (!fs.existsSync(src)) fail(`${src} missing`);
    say(`copy ${f} (${(fs.statSync(src).size / 1024).toFixed(0)} KiB)`);
    if (!apply) continue;
    fs.copyFileSync(src, path.join(target, f));
    if (sha(src) !== sha(path.join(target, f))) fail(`verification failed for ${f}`);
  }
}

if (flag('--rollback')) {
  const backups = path.join(target, '.backups');
  const latest = fs.existsSync(backups) ? fs.readdirSync(backups).sort().at(-1) : undefined;
  if (!latest) fail('no backup to roll back to');
  say(`roll back to ${latest}`);
  backupCurrent();
  copyVerified(path.join(backups, latest));
} else {
  const dist = path.join(root, 'dist', ID);
  const manifest = readJson(path.join(dist, 'manifest.json'));
  if (manifest.id !== ID) fail(`dist/ contains ${manifest.id}`);
  say(`install ${manifest.name} ${manifest.version} into ${path.relative(vault, target) || target}`);
  if (apply) fs.mkdirSync(target, { recursive: true });
  backupCurrent();
  copyVerified(dist);
  if (fs.existsSync(path.join(target, 'data.json'))) say('data.json (settings and saved maps) left untouched');
  if (fs.existsSync(path.join(target, 'vendor'))) say('vendor/ from 1.x is no longer used by 2.0 and can be deleted by hand');
}
console.log(apply ? 'Done. In Obsidian, reload the plugin (Settings > Community plugins: turn it off and on) to activate.' : 'Nothing was written. Add --yes to apply.');
