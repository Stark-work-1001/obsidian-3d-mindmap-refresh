// NoteIO backed by Obsidian. Uses only public API: Editor (getValue,
// transaction, offsetToPos) for notes open in an editor, and
// Vault.process for atomic read-compare-write when no editor is open.
// There is deliberately no "replace the whole note" fallback: a mismatch is
// always reported as a conflict instead of overwriting newer content.
import { MarkdownView, type App, type Editor, type TFile } from 'obsidian';
import type { NoteIO, WriteOutcome } from './document-sync';
import type { TextEdit } from '../model/types';

class StaleNoteError extends Error {
  constructor(readonly current: string) { super('note changed'); }
}

/** One contiguous replacement equivalent to applying `edits` to `before`. */
export function mergedChange(before: string, after: string, edits: TextEdit[]): TextEdit {
  let from = Math.min(...edits.map(e => e.from));
  let to = Math.max(...edits.map(e => e.to));
  if (!Number.isFinite(from)) { from = 0; to = before.length; }
  return { from, to, insert: after.slice(from, after.length - (before.length - to)) };
}

export class ObsidianNoteIO implements NoteIO {
  constructor(private readonly app: App, private readonly file: TFile) {}

  private editors(): Editor[] {
    const result: Editor[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === this.file.path && view.editor) result.push(view.editor);
    }
    return result;
  }

  async read(): Promise<string | null> {
    const editor = this.editors()[0];
    if (editor) return editor.getValue();
    try { return await this.app.vault.read(this.file); } catch { return null; }
  }

  async write(before: string, after: string, edits: TextEdit[]): Promise<WriteOutcome> {
    const editors = this.editors();
    if (editors.length) {
      for (const editor of editors) {
        const current = editor.getValue();
        if (current !== before) return { kind: 'conflict', current };
      }
      const editor = editors[0];
      const change = mergedChange(before, after, edits);
      editor.transaction({ changes: [{ from: editor.offsetToPos(change.from), to: editor.offsetToPos(change.to), text: change.insert }] }, '3d-mindmap');
      const result = editor.getValue();
      if (result !== after) return { kind: 'conflict', current: result };
      return { kind: 'written', via: 'editor' };
    }
    try {
      await this.app.vault.process(this.file, data => {
        if (data !== before) throw new StaleNoteError(data);
        return after;
      });
      return { kind: 'written', via: 'vault' };
    } catch (error) {
      if (error instanceof StaleNoteError) return { kind: 'conflict', current: error.current };
      return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  subscribe(onText: (text: string, origin: string) => void): () => void {
    const refs = [
      this.app.workspace.on('editor-change', (editor, info) => {
        if (info?.file?.path === this.file.path) onText(editor.getValue(), 'editor');
      }),
      this.app.metadataCache.on('changed', (file, data) => {
        if (file.path !== this.file.path) return;
        // While the note is open in an editor, the editor is the newest source;
        // a save event may carry a slightly older snapshot.
        const editor = this.editors()[0];
        onText(editor ? editor.getValue() : data, editor ? 'editor' : 'disk');
      }),
    ];
    return () => {
      this.app.workspace.offref(refs[0]);
      this.app.metadataCache.offref(refs[1]);
    };
  }
}
