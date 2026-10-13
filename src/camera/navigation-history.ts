// Back/forward history for exploration: overview -> chapter -> branch ->
// concept -> related concept. Each entry restores camera, focus and selection.
import type { CameraBookmark, PivotMode } from './camera-rig';

export interface NavigationEntry {
  label: string;
  camera: CameraBookmark;
  /** Node path (persistent identity) of the entered branch, or null for the whole map. */
  focusPath: string | null;
  selectedPath: string | null;
  pivotMode: PivotMode;
}

export class NavigationHistory {
  private back: NavigationEntry[] = [];
  private ahead: NavigationEntry[] = [];
  constructor(private readonly limit = 60) {}

  get canGoBack(): boolean { return this.back.length > 0; }
  get canGoForward(): boolean { return this.ahead.length > 0; }
  peekBack(): NavigationEntry | null { return this.back.at(-1) ?? null; }
  peekForward(): NavigationEntry | null { return this.ahead.at(-1) ?? null; }

  /** Record the state being left before a navigation. */
  push(entry: NavigationEntry): void {
    const last = this.back.at(-1);
    if (last && last.focusPath === entry.focusPath && last.selectedPath === entry.selectedPath && sameCamera(last.camera, entry.camera)) return;
    this.back.push(entry);
    if (this.back.length > this.limit) this.back.shift();
    this.ahead.length = 0;
  }

  /** Go back: returns the entry to restore and remembers `current` for forward. */
  goBack(current: NavigationEntry): NavigationEntry | null {
    const entry = this.back.pop();
    if (!entry) return null;
    this.ahead.push(current);
    return entry;
  }

  goForward(current: NavigationEntry): NavigationEntry | null {
    const entry = this.ahead.pop();
    if (!entry) return null;
    this.back.push(current);
    return entry;
  }

  clear(): void { this.back.length = 0; this.ahead.length = 0; }
}

function sameCamera(a: CameraBookmark, b: CameraBookmark): boolean {
  const close = (x: number[], y: number[]) => x.every((v, i) => Math.abs(v - y[i]) < 1e-3);
  return close(a.pivot, b.pivot) && close(a.orientation, b.orientation) && close(a.offset, b.offset) && Math.abs(a.fov - b.fov) < 1e-3;
}
