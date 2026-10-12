// Undo/redo of text edits. An entry is only replayed when the note still has
// exactly the text it produced, so undo never applies to content that changed
// outside the map; in that case history is cleared instead.
import type { TextEdit } from './types';

export interface HistoryEntry {
  edits: TextEdit[];
  inverse: TextEdit[];
  label: string;
  beforeText: string;
  afterText: string;
}

export class EditHistory {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  constructor(private readonly limit = 200) {}

  push(entry: HistoryEntry): void {
    if (!entry.edits.length) return;
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get undoDepth(): number { return this.undoStack.length; }
  get redoDepth(): number { return this.redoStack.length; }
  peekUndoLabel(): string | null { return this.undoStack.at(-1)?.label ?? null; }
  peekRedoLabel(): string | null { return this.redoStack.at(-1)?.label ?? null; }

  takeUndo(currentText: string): HistoryEntry | null {
    const entry = this.undoStack.at(-1);
    if (!entry) return null;
    if (entry.afterText !== currentText) { this.clear(); return null; }
    this.undoStack.pop();
    this.redoStack.push(entry);
    return entry;
  }

  takeRedo(currentText: string): HistoryEntry | null {
    const entry = this.redoStack.at(-1);
    if (!entry) return null;
    if (entry.beforeText !== currentText) { this.clear(); return null; }
    this.redoStack.pop();
    this.undoStack.push(entry);
    return entry;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
