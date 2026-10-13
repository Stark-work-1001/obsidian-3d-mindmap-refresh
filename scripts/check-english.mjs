// English-only check for project-owned text (development tool).
//
//   node scripts/check-english.mjs [--no-bundle]
//
// 1. Sources, styles, manifest and documentation must not contain CJK text,
//    neither literally nor as \uXXXX escapes, except the entries in
//    scripts/english-allowlist.json (data formats kept for compatibility with
//    existing notes, each with a reason).
// 2. Every interface string in src/i18n/en.ts is English and its {placeholders}
//    are well formed; keys that no code uses are reported.
// 3. The built bundle (dist/obsidian-3d-mindmap/main.js) contains no CJK text
//    beyond the same allowlisted data.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const allow = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'english-allowlist.json'), 'utf8'));
const CJK = '\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff\\uff00-\\uffef';
const literal = new RegExp(`[${CJK}]`, 'u');
const escaped = /\\u(?:30[0-9a-f]{2}|3[4-9a-f][0-9a-f]{2}|[4-9][0-9a-f]{3}|a[c-f][0-9a-f]{2}|[bc][0-9a-f]{3}|d[0-7][0-9a-f]{2}|f[9a][0-9a-f]{2}|ff[0-9a-f]{2})/i;
const problems = [];

function walk(dir, filter) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return ['generated', 'node_modules'].includes(e.name) ? [] : walk(full, filter);
    return filter(e.name) ? [full] : [];
  });
}

const allowed = (file, line) => allow.entries.some(a => file.replace(/\\/g, '/').endsWith(a.file) && line.includes(a.contains));

const files = [
  ...walk(path.join(root, 'src'), n => n.endsWith('.ts')),
  ...walk(path.join(root, 'docs'), n => n.endsWith('.md')),
  ...walk(path.join(root, 'scripts'), n => /\.(mjs|js)$/.test(n) && n !== 'check-english.mjs'),
  ...['styles.css', 'manifest.json', 'README.md', 'CHANGELOG.md', 'package.json', 'THIRD_PARTY_NOTICES.md'].map(f => path.join(root, f)).filter(f => fs.existsSync(f)),
];
for (const file of files) {
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
    if ((literal.test(line) || escaped.test(line)) && !allowed(file, line)) problems.push(`${path.relative(root, file)}:${i + 1}: ${line.trim().slice(0, 140)}`);
  });
}

// Interface strings.
const enSource = fs.readFileSync(path.join(root, 'src', 'i18n', 'en.ts'), 'utf8');
const entries = [...enSource.matchAll(/^\s*'([\w.]+)':\s*'((?:[^'\\]|\\.)*)',?\s*$/gm)].map(m => ({ key: m[1], value: JSON.parse(`"${m[2].replace(/"/g, '\\"').replace(/\\'/g, "'")}"`) }));
const used = walk(path.join(root, 'src'), n => n.endsWith('.ts')).filter(f => !f.endsWith(path.join('i18n', 'en.ts'))).map(f => fs.readFileSync(f, 'utf8')).join('\n');
const unused = [];
for (const { key, value } of entries) {
  if (literal.test(value)) problems.push(`en.ts: ${key} is not English: ${value}`);
  if (/\{[^}]*$|^[^{]*\}|\{\s*\}/.test(value)) problems.push(`en.ts: ${key} has a malformed placeholder: ${value}`);
  const prefix = key.replace(/\.[^.]+$/, '.');
  const dynamic = /^(layout\.[a-z]+\.(name|hint)|style\.|background\.mode\.|settings\.rule\.mode\.)/.test(key);
  if (!used.includes(`'${key}'`) && !dynamic && !used.includes(`\`${prefix}`)) unused.push(key);
}

// Built bundle.
const bundle = path.join(root, 'dist', 'obsidian-3d-mindmap', 'main.js');
let bundleHits = 0;
if (!process.argv.includes('--no-bundle')) {
  if (!fs.existsSync(bundle)) problems.push('dist/obsidian-3d-mindmap/main.js not found: build first or pass --no-bundle');
  else {
    const code = fs.readFileSync(bundle, 'utf8');
    const decoded = code.replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
    const re = new RegExp(`.{0,40}[${CJK}]+.{0,40}`, 'gu');
    for (const m of decoded.matchAll(re)) {
      bundleHits++;
      if (!allow.bundle.some(a => m[0].includes(a.contains))) problems.push(`bundle: …${m[0].replace(/\s+/g, ' ')}…`);
    }
  }
}

console.log(`checked ${files.length} files, ${entries.length} interface strings${process.argv.includes('--no-bundle') ? '' : `, bundle (${bundleHits} allowlisted data matches)`}`);
if (unused.length) console.log(`note: ${unused.length} strings are not referenced by code: ${unused.join(', ')}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.map(p => `  ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('English check passed.');
