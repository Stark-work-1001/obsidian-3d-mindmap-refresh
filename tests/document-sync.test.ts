import test from 'node:test';
import assert from 'node:assert/strict';
import { DocumentSync, type NoteIO, type WriteOutcome } from '../src/sync/document-sync';
import { mergedChange } from '../src/sync/obsidian-note-io';
import { OutlineModel } from '../src/model/outline-model';
import { applyEdits } from '../src/model/text-edits';
import type { TextEdit } from '../src/model/types';

/** In-memory note with the same compare-then-write contract as Vault.process. */
class FakeNote implements NoteIO {
  listeners = new Set<(text: string, origin: string) => void>();
  writes = 0;
  constructor(public text: string) {}
  async read() { return this.text; }
  async write(before: string, after: string, edits: TextEdit[]): Promise<WriteOutcome> {
    await Promise.resolve();
    if (this.text !== before) return { kind: 'conflict', current: this.text };
    assert.equal(applyEdits(before, edits), after);
    this.text = after; this.writes++;
    for (const l of this.listeners) l(after, 'disk');
    return { kind: 'written', via: 'vault' };
  }
  subscribe(fn: (text: string, origin: string) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  externalEdit(text: string) { this.text = text; for (const l of this.listeners) l(text, 'disk'); }
}

const initial = '# Topic\n- alpha\n- beta\n- gamma\n';

function setup(debounce = 1000) {
  const note = new FakeNote(initial);
  const model = new OutlineModel(initial, 'Note');
  const sync = new DocumentSync(model, note, debounce);
  sync.attach();
  const notices: string[] = [];
  sync.onNotice(n => notices.push(`${n.level}:${n.message}`));
  const idOf = (text: string) => { let id = ''; const walk = (n: any) => { if (n.text === text) id = n.id; n.children.forEach(walk); }; walk(model.root); return id; };
  return { note, model, sync, notices, idOf };
}

test('a normal edit is written to the note', async () => {
  const { note, sync, idOf } = setup();
  sync.perform(m => m.rename(idOf('beta'), 'BETA'));
  await sync.settled();
  assert.equal(note.text, '# Topic\n- alpha\n- BETA\n- gamma\n');
});

test('a newer external edit is never overwritten by stale generated text', async () => {
  const { note, model, sync, notices, idOf } = setup();
  // The note changes outside the map, but the debounce has not delivered it yet.
  note.text = '# Topic\n- alpha\n- beta\n- gamma\n- delta (typed elsewhere)\n';
  const beta = idOf('beta');
  sync.perform(m => m.rename(beta, 'BETA'));
  await sync.settled();
  // Both changes survive: the external line and the rename (re-applied by id).
  assert.equal(note.text, '# Topic\n- alpha\n- BETA\n- gamma\n- delta (typed elsewhere)\n');
  assert.equal(model.text, note.text);
  assert.equal(sync.stats.conflicts, 1);
  assert.equal(sync.stats.rebased, 1);
  assert.ok(notices.some(n => n.startsWith('info:')));
});

test('when the target node no longer exists the change is dropped and the user is told', async () => {
  const { note, model, sync, notices, idOf } = setup();
  const beta = idOf('beta');
  note.text = '# Topic\n- alpha\n- gamma\n';
  sync.perform(m => m.rename(beta, 'BETA'));
  await sync.settled();
  assert.equal(note.text, '# Topic\n- alpha\n- gamma\n');
  assert.equal(model.text, note.text);
  assert.ok(notices.some(n => n.startsWith('warning:')));
});

test('pending external text is consumed before an operation runs', async () => {
  const { note, model, sync, idOf } = setup(10_000);
  note.externalEdit('# Topic\n- alpha\n- beta\n- gamma\n- new\n');
  assert.equal(model.text, initial, 'still debounced');
  sync.perform(m => m.rename(idOf('alpha'), 'ALPHA'));
  await sync.settled();
  assert.equal(note.text, '# Topic\n- ALPHA\n- beta\n- gamma\n- new\n');
  assert.equal(sync.stats.conflicts, 0);
});

test('echoes of our own writes are ignored; external edits arrive after the debounce', async () => {
  const { note, model, sync, idOf } = setup(5);
  sync.perform(m => m.rename(idOf('alpha'), 'A'));
  await sync.settled();
  assert.ok(sync.stats.echoes >= 1);
  note.externalEdit('# Topic\n- A\n');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(model.text, '# Topic\n- A\n');
});

test('external text is held while an inline editor is open', async () => {
  const { note, model, sync } = setup(0);
  sync.beginEditing();
  note.externalEdit('# Other\n');
  assert.equal(model.text, initial);
  sync.endEditing();
  assert.equal(model.text, '# Other\n');
});

test('undo after an external edit does not apply to the changed text', async () => {
  const { note, model, sync, idOf } = setup(0);
  sync.perform(m => m.rename(idOf('alpha'), 'A'));
  await sync.settled();
  note.externalEdit('# Topic\n- A\n- beta\n- gamma\n- extra\n');
  const result = sync.undo();
  await sync.settled();
  assert.equal(result.ok, false);
  assert.equal(note.text, '# Topic\n- A\n- beta\n- gamma\n- extra\n');
  assert.equal(model.text, note.text);
});

test('rapid successive edits are all written in order', async () => {
  const { note, sync, idOf } = setup();
  for (const name of ['alpha', 'beta', 'gamma']) sync.perform(m => m.rename(idOf(name), name.toUpperCase()));
  await sync.settled();
  assert.equal(note.text, '# Topic\n- ALPHA\n- BETA\n- GAMMA\n');
});

test('merged editor change reproduces multi-edit operations exactly', () => {
  const before = '- a\n- b\n- c\n- d\n';
  const model = new OutlineModel(before, 'N');
  const d = model.root.children[3].id;
  const result = model.move(d, -1);
  const change = mergedChange(before, result.text, result.edits);
  assert.equal(applyEdits(before, [change]), result.text);
  assert.ok(change.to - change.from < before.length, 'change stays local');
});
