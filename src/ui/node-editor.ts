// Inline text editor that floats at a node while creating or renaming it.
// Enter commits (Tab: commit and add a child, Shift+Enter: commit and edit
// the note), Escape cancels; IME composition is respected.
import { t } from '../i18n';
import { el, isolatePointer } from './dom';

export type CommitIntent = 'enter' | 'tab' | 'shift-enter' | 'blur' | 'escape';

export class NodeEditor {
  readonly el: HTMLTextAreaElement;
  private id: string | null = null;
  private composing = false;
  private initial = '';

  constructor(host: HTMLElement, private readonly onCommit: (id: string, text: string, intent: CommitIntent, initial: string) => void) {
    this.el = el('textarea', 'om3d-node-editor', host);
    this.el.rows = 1;
    this.el.spellcheck = false;
    this.el.hidden = true;
    this.el.setAttribute('aria-label', t('editor.label'));
    isolatePointer(this.el);
    this.el.addEventListener('compositionstart', () => { this.composing = true; });
    this.el.addEventListener('compositionend', () => { this.composing = false; });
    this.el.addEventListener('input', () => this.grow());
    this.el.addEventListener('keydown', e => {
      e.stopPropagation();
      if (this.composing || e.isComposing) return;
      if (e.key === 'Escape') { e.preventDefault(); this.finish('escape'); }
      else if (e.key === 'Enter') { e.preventDefault(); this.finish(e.shiftKey ? 'shift-enter' : 'enter'); }
      else if (e.key === 'Tab') { e.preventDefault(); this.finish('tab'); }
    });
    this.el.addEventListener('blur', () => { if (this.id) this.finish('blur'); });
  }

  get editingId(): string | null { return this.id; }

  open(id: string, text: string, at: { x: number; y: number } | null, placeholder = t('editor.placeholder')): void {
    this.id = id;
    this.initial = text;
    this.el.value = text;
    this.el.placeholder = placeholder;
    this.el.hidden = false;
    this.moveTo(at ?? { x: 80, y: 120 });
    this.grow();
    // Focus synchronously: keys typed right after Enter/Tab must land in the new editor.
    this.el.focus({ preventScroll: true });
    this.el.select();
  }

  moveTo(at: { x: number; y: number }): void {
    if (!this.id) return;
    this.el.style.left = `${Math.round(at.x)}px`;
    this.el.style.top = `${Math.round(at.y)}px`;
  }

  private grow(): void {
    this.el.style.height = 'auto';
    this.el.style.height = `${Math.min(160, Math.max(28, this.el.scrollHeight + 2))}px`;
    this.el.style.width = `${Math.min(420, Math.max(180, this.el.value.length * 8 + 48))}px`;
  }

  private finish(intent: CommitIntent): void {
    const id = this.id;
    if (!id) return;
    this.id = null;
    const text = this.el.value;
    this.el.hidden = true;
    this.onCommit(id, text, intent, this.initial);
  }

  /** Close without committing (view closing, note switched). */
  cancel(): void {
    if (!this.id) return;
    this.id = null;
    this.el.hidden = true;
  }

  dispose(): void { this.id = null; this.el.remove(); }
}
