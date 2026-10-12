import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const vault = process.argv[2];
if (!vault) throw Error('Usage: node scripts/deploy.mjs <vault path>');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const versions = JSON.parse(fs.readFileSync(path.join(root, 'versions.json')));
if (manifest.version !== pkg.version || versions[manifest.version] !== manifest.minAppVersion)
  throw Error('Version metadata mismatch');
const target = path.resolve(vault, '.obsidian', 'plugins', 'obsidian-3d-mindmap');
if (manifest.id !== 'obsidian-3d-mindmap') throw Error('Unexpected plugin ID');
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  fs.copyFileSync(path.join(root, file), path.join(target, file));
  const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  if (hash(path.join(root, file)) !== hash(path.join(target, file))) throw Error(`Copy verification failed: ${file}`);
}
fs.cpSync(path.join(root, 'vendor'), path.join(target, 'vendor'), { recursive: true });
console.log(`Installed ${manifest.version} in ${target}; reload this plugin to activate.`);
