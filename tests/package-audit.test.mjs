// The packaging audit must reject private or machine-specific content, and
// the zip writer must round-trip byte-exact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditEntries } from '../scripts/lib/audit.mjs';
import { createZip, readZip } from '../scripts/lib/zip.mjs';

const entry = (name, text) => ({ name, data: Buffer.from(text) });

test('audit rejects build debris, plugin data and vault folders by path', () => {
  for (const name of ['p/node_modules/x/index.js', 'p/target/release/a', 'p/_tmp/meta.json', 'p/.obsidian/app.json', 'p/data.json', 'p/main.js.map', 'p/.env.local', 'p/.git/config', 'p/crates/graph-physics/pkg/x.js']) {
    assert.ok(auditEntries([entry(name, 'ok')]).length > 0, name);
  }
  assert.deepEqual(auditEntries([entry('p/src/main.ts', 'export {}'), entry('p/data-model.md', 'notes')]), []);
});

test('audit rejects machine paths, the local user name and credentials in content', () => {
  const bad = [
    'see C:\\Users\\alice\\vault', 'C:\\\\Users\\\\bob\\\\x', '/Users/carol/notes', '/home/dave/x/', 'D:\\playground\\repo',
    'built by someuser here', '-----BEGIN RSA PRIVATE KEY-----', 'token = "abcdefghijklmnopqrstu"', 'ghp_' + 'a'.repeat(36),
  ];
  for (const text of bad) assert.ok(auditEntries([entry('p/f.txt', text)], { user: 'someuser' }).length > 0, text);
  assert.deepEqual(auditEntries([entry('p/f.txt', 'runs on /home/runner/work in CI; settings.token is a key name')], { user: 'someuser' }), []);
  assert.deepEqual(auditEntries([entry('p/font.woff2', 'C:\\Users\\x\\')]), [], 'binary files are not scanned');
});

test('zip writer round-trips and is deterministic', () => {
  const entries = [entry('a/b.txt', 'hello '.repeat(100)), { name: 'a/c.bin', data: Buffer.from([0, 1, 2, 255]) }, entry('a/\u00e9.md', '')];
  const zip = createZip(entries);
  assert.deepEqual(createZip(entries), zip);
  const back = readZip(zip);
  assert.deepEqual(back.map(e => e.name).sort(), entries.map(e => e.name).sort());
  for (const e of entries) assert.deepEqual(back.find(b => b.name === e.name).data, e.data);
});
