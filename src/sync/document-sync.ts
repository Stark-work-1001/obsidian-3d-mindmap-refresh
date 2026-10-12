// Keeps an OutlineModel and one Markdown note in agreement.
//
// Writing: every change is computed against the exact text the model last
// saw (`beforeText`). The NoteIO only applies it if the note still contains
// that text -- in an open editor (compare, then a transaction) or on disk
// (atomic read-compare-write). If the note changed meanwhile, nothing is
// overwritten: the model adopts the newer text and the operation is retried
// once by node identity; if it no longer applies the user is told.
//
// Reading: external changes arrive through `NoteIO.subscribe`, are coalesced
// by a short debounce, suspended while the user types in an inline editor and
// always consumed before a new operation runs.
import { t } from '../i18n';
import type { OutlineModel } from '../model/outline-model';
import type { RunResult, TextEdit, TreeDiff } from '../model/types';

export type WriteOutcome =
  | { kind: 'written'; via: 'editor' | 'vault' }
  | { kind: 'conflict'; current: string }
  | { kind: 'failed'; error: string };

export interface NoteIO {
  /** Apply `edits` (or replace with `after`) only if the note currently equals `before`. */
  write(before: string, after: string, edits: TextEdit[]): Promise<WriteOutcome>;
  /** Most recent text: an open editor if any, otherwise the file on disk. */
  read(): Promise<string | null>;
  subscribe(onText: (text: string, origin: string) => void): () => void;
}

export type TreeOrigin = 'local' | 'external' | 'conflict' | 'undo';
export interface TreeEvent { diff: TreeDiff; origin: TreeOrigin }
export interface SyncNotice { level: 'info' | 'warning' | 'error'; message: string }

type Operation = (model: OutlineModel) => RunResult;

export class DocumentSync {
  private pendingExternal: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private suspended = false;
  private closed = false;
  private unsubscribe: (() => void) | null = null;
  private lastWritten: string | null = null;
  private writes: Promise<void> = Promise.resolve();
  private readonly treeListeners = new Set<(event: TreeEvent) => void>();
  private readonly noticeListeners = new Set<(notice: SyncNotice) => void>();
  readonly stats = { writes: 0, conflicts: 0, rebased: 0, echoes: 0, externalApplied: 0, coalesced: 0 };

  constructor(readonly model: OutlineModel, private readonly io: NoteIO, private debounceMs = 150) {}

  onTree(fn: (event: TreeEvent) => void): () => void { this.treeListeners.add(fn); return () => this.treeListeners.delete(fn); }
  onNotice(fn: (notice: SyncNotice) => void): () => void { this.noticeListeners.add(fn); return () => this.noticeListeners.delete(fn); }
  private emitTree(event: TreeEvent): void { for (const fn of this.treeListeners) { try { fn(event); } catch (e) { console.error(e); } } }
  private notify(notice: SyncNotice): void { for (const fn of this.noticeListeners) { try { fn(notice); } catch (e) { console.error(e); } } }

  setDebounce(ms: number): void { this.debounceMs = Math.max(0, ms); }

  attach(): void {
    if (!this.unsubscribe) this.unsubscribe = this.io.subscribe((text, origin) => this.receive(text, origin));
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pendingExternal = null;
    this.closed = true;
  }

  /** Pause applying external text (e.g. while an inline editor is open). */
  beginEditing(): void { this.suspended = true; }
  endEditing(): void { this.suspended = false; this.flushExternal(); }

  private receive(text: string, _origin: string): void {
    if (this.closed) return;
    if (text === this.model.text || text === this.lastWritten) { this.stats.echoes++; return; }
    if (this.pendingExternal !== null) this.stats.coalesced++;
    this.pendingExternal = text;
    if (this.suspended) return;
    if (this.timer) clearTimeout(this.timer);
    if (this.debounceMs === 0) { this.flushExternal(); return; }
    this.timer = setTimeout(() => this.flushExternal(), this.debounceMs);
  }

  /** Apply any queued external text now. Returns true when the tree changed. */
  flushExternal(): boolean {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.suspended || this.pendingExternal === null || this.closed) return false;
    const text = this.pendingExternal;
    this.pendingExternal = null;
    const result = this.model.replaceText(text);
    if (!result) return false;
    this.stats.externalApplied++;
    this.emitTree({ diff: result.diff, origin: 'external' });
    return true;
  }

  /**
   * Run an operation optimistically and write it. The returned result is the
   * local outcome; the write and any conflict handling happen asynchronously.
   */
  perform(op: Operation, origin: TreeOrigin = 'local'): RunResult {
    // Never compute an edit against text we already know is stale.
    if (!this.suspended) this.flushExternal();
    const result = op(this.model);
    if (!result.ok || !result.edits.length) {
      if (result.reason && result.reason !== 'noop') this.notify({ level: 'warning', message: result.reason });
      return result;
    }
    this.emitTree({ diff: result.diff, origin });
    this.enqueueWrite(result, op, 1);
    return result;
  }

  private enqueueWrite(result: RunResult, op: Operation, retries: number): void {
    this.lastWritten = result.text;
    this.stats.writes++;
    this.writes = this.writes.then(() => this.write(result, op, retries));
  }

  private async write(result: RunResult, op: Operation, retries: number): Promise<void> {
    if (this.closed) return;
    let outcome: WriteOutcome;
    try { outcome = await this.io.write(result.beforeText, result.text, result.edits); }
    catch (error) { outcome = { kind: 'failed', error: error instanceof Error ? error.message : String(error) }; }
    if (outcome.kind === 'written') return;
    if (outcome.kind === 'failed') {
      this.notify({ level: 'error', message: t('sync.writeFailed', { error: outcome.error }) });
      await this.recoverFromDisk();
      return;
    }
    // Conflict: the note no longer matches what this edit was computed from.
    this.stats.conflicts++;
    this.pendingExternal = null;
    const adopted = this.model.replaceText(outcome.current);
    if (adopted) this.emitTree({ diff: adopted.diff, origin: 'conflict' });
    if (retries > 0) {
      const retry = op(this.model);
      if (retry.ok && retry.edits.length) {
        this.stats.rebased++;
        this.emitTree({ diff: retry.diff, origin: 'local' });
        this.notify({ level: 'info', message: t('sync.rebased', { label: result.label }) });
        // Write synchronously inside the current queue slot.
        this.lastWritten = retry.text;
        await this.write(retry, op, retries - 1);
        return;
      }
    }
    this.notify({ level: 'warning', message: t('sync.conflictNotApplied', { label: result.label }) });
  }

  /** Re-read the note after a failed write so the map shows what is really there. */
  async recoverFromDisk(): Promise<void> {
    const current = await this.io.read();
    if (current === null) return;
    const adopted = this.model.replaceText(current);
    if (adopted) this.emitTree({ diff: adopted.diff, origin: 'conflict' });
  }

  /** Resolves when every queued write has finished (used by tests and on close). */
  async settled(): Promise<void> { await this.writes; }

  undo(): RunResult { return this.perform(m => m.undo(), 'undo'); }
  redo(): RunResult { return this.perform(m => m.redo(), 'undo'); }
}
