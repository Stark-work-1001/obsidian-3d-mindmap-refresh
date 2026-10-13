// Pointer, wheel and touch handling for the 3D canvas, with explicit modes
// so selecting, rotating, moving nodes and connecting never conflict:
//
//   Navigate  left-drag rotates (also when it starts on a node), right/middle
//             or Shift+left drag pans, click selects, double-click enters a
//             branch (on empty space: overview)
//   Arrange   left-drag on a node moves it and pins its position
//   Connect   click two nodes to create (or remove) an association
//
// Wheel: dolly towards the point under the cursor; trackpad pinch (ctrl+wheel)
// the same with finer steps; Alt+wheel narrows the field of view (magnify
// without moving). Touch: one finger rotates, two fingers pinch and pan.
// Mouse back/forward buttons navigate history.
import type { Vector3 } from 'three';
import type { InteractionMode } from '../ui/toolbar';

export interface InteractionHost {
  mode(): InteractionMode;
  /** Sphere under a pixel; xact disables the small-target tolerance. */
  pick(x: number, y: number, exact?: boolean): { index: number; point: Vector3 } | null;
  hover(index: number | null, at: { x: number; y: number }): void;
  click(index: number | null, event: PointerEvent): void;
  doubleClick(index: number | null): void;
  orbit(dx: number, dy: number): void;
  pan(dx: number, dy: number): void;
  dolly(steps: number, x: number, y: number, hit: { index: number; point: Vector3 } | null): void;
  zoomFov(steps: number): void;
  dragNodeStart(index: number): boolean;
  dragNodeMove(index: number, x: number, y: number): void;
  dragNodeEnd(index: number, cancelled: boolean): void;
  history(direction: -1 | 1): void;
  interacted(): void;
}

const DRAG_THRESHOLD = { mouse: 4, pen: 4, touch: 8 } as Record<string, number>;
const LINE_HEIGHT = 16;

/** Wheel delta in "notches" (one classic mouse notch = 1), consistent across modes and devices. */
export function normalizeWheel(event: { deltaY: number; deltaMode: number; ctrlKey: boolean }, pageHeight: number): number {
  let dy = event.deltaY;
  if (event.deltaMode === 1) dy *= LINE_HEIGHT;
  else if (event.deltaMode === 2) dy *= pageHeight;
  // Pinch gestures arrive as ctrl+wheel with small deltas: scale them up.
  const steps = event.ctrlKey ? dy / 25 : dy / 100;
  return Math.max(-4, Math.min(4, steps));
}

type Gesture = 'none' | 'pending' | 'orbit' | 'pan' | 'node' | 'pinch';

export class Interaction {
  private readonly pointers = new Map<number, { x: number; y: number; type: string }>();
  private gesture: Gesture = 'none';
  private start = { x: 0, y: 0, button: 0, shift: false };
  private downNode: number | null = null;
  private pinch = { distance: 0, x: 0, y: 0 };
  private hoverFrame = 0;
  private lastHover = { x: -1, y: -1 };
  private lastTap = 0;

  constructor(private readonly el: HTMLElement, private readonly host: InteractionHost) {
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onCancel);
    el.addEventListener('pointerleave', this.onLeave);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('dblclick', this.onDoubleClick);
    el.addEventListener('contextmenu', this.onContextMenu);
    el.addEventListener('auxclick', this.onAuxClick);
  }

  private labelIndex(target: EventTarget | null): number | null {
    const label = (target as HTMLElement | null)?.closest?.('.om3d-label') as HTMLElement | null;
    const index = label ? Number(label.dataset.index) : NaN;
    return Number.isInteger(index) && index >= 0 ? index : null;
  }

  /** Node under the pointer: a sphere hit directly wins over a label drawn over it. */
  private nodeAt(target: EventTarget | null, x: number, y: number): number | null {
    const label = this.labelIndex(target);
    if (label === null) return this.host.pick(x, y)?.index ?? null;
    return this.host.pick(x, y, true)?.index ?? label;
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private readonly onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('.om3d-wikilink, .om3d-link')) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, { ...p, type: e.pointerType });
    try { this.el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    this.el.focus({ preventScroll: true });
    this.host.interacted();
    if (this.pointers.size === 2) {
      // Second finger: switch to pinch / two-finger pan.
      if (this.gesture === 'node' && this.downNode !== null) this.host.dragNodeEnd(this.downNode, true);
      const [a, b] = [...this.pointers.values()];
      this.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.gesture = 'pinch';
      return;
    }
    if (this.pointers.size > 2) return;
    this.start = { x: p.x, y: p.y, button: e.button, shift: e.shiftKey };
    this.downNode = e.button === 0 ? this.nodeAt(e.target, p.x, p.y) : null;
    this.gesture = 'pending';
    e.preventDefault();
  };

  private readonly onMove = (e: PointerEvent) => {
    const p = this.local(e);
    const prev = this.pointers.get(e.pointerId);
    if (!prev) { this.scheduleHover(p); return; }
    this.pointers.set(e.pointerId, { ...p, type: e.pointerType });
    if (this.gesture === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.host.dolly(Math.log(this.pinch.distance / distance) / 0.12, mid.x, mid.y, this.host.pick(mid.x, mid.y));
      this.host.pan(mid.x - this.pinch.x, mid.y - this.pinch.y);
      this.pinch = { distance, ...mid };
      return;
    }
    const dx = p.x - prev.x, dy = p.y - prev.y;
    if (this.gesture === 'pending') {
      if (Math.hypot(p.x - this.start.x, p.y - this.start.y) < (DRAG_THRESHOLD[e.pointerType] ?? 4)) return;
      const panButton = this.start.button === 1 || this.start.button === 2 || (this.start.button === 0 && this.start.shift);
      if (!panButton && this.host.mode() === 'arrange' && this.downNode !== null && this.host.dragNodeStart(this.downNode)) this.gesture = 'node';
      else this.gesture = panButton ? 'pan' : 'orbit';
      this.host.hover(null, p);
    }
    if (this.gesture === 'orbit') this.host.orbit(dx, dy);
    else if (this.gesture === 'pan') this.host.pan(dx, dy);
    else if (this.gesture === 'node' && this.downNode !== null) this.host.dragNodeMove(this.downNode, p.x, p.y);
  };

  private readonly onUp = (e: PointerEvent) => {
    const p = this.local(e);
    const had = this.pointers.delete(e.pointerId);
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* released */ }
    if (!had) return;
    if (this.gesture === 'pinch') { if (!this.pointers.size) this.gesture = 'none'; return; }
    if (this.gesture === 'pending' && this.start.button === 0) {
      const index = this.downNode;
      // Touch double tap
      const now = performance.now();
      if (e.pointerType === 'touch' && now - this.lastTap < 300) { this.host.doubleClick(index); this.lastTap = 0; }
      else { this.lastTap = now; this.host.click(index, e); }
    } else if (this.gesture === 'node' && this.downNode !== null) this.host.dragNodeEnd(this.downNode, false);
    this.gesture = 'none';
    this.downNode = null;
  };

  private readonly onCancel = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.gesture === 'node' && this.downNode !== null) this.host.dragNodeEnd(this.downNode, true);
    this.gesture = 'none';
    this.downNode = null;
  };

  private readonly onLeave = (e: PointerEvent) => {
    if (!this.pointers.size) this.host.hover(null, this.local(e));
  };

  private scheduleHover(p: { x: number; y: number }): void {
    this.lastHover = p;
    if (this.hoverFrame) return;
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      const hit = this.host.pick(this.lastHover.x, this.lastHover.y);
      this.host.hover(hit?.index ?? null, this.lastHover);
    });
  }

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.host.interacted();
    const p = this.local(e);
    const steps = normalizeWheel(e, this.el.clientHeight || 600);
    if (e.altKey) { this.host.zoomFov(steps); return; }
    if (e.shiftKey) { this.host.pan(-e.deltaX || 0, -e.deltaY * 0.5); return; }
    this.host.dolly(steps, p.x, p.y, this.host.pick(p.x, p.y));
  };

  private readonly onDoubleClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('.om3d-wikilink, .om3d-link')) return;
    const p = this.local(e);
    this.host.doubleClick(this.nodeAt(e.target, p.x, p.y));
  };

  private readonly onContextMenu = (e: MouseEvent) => e.preventDefault();

  private readonly onAuxClick = (e: MouseEvent) => {
    if (e.button === 3) { e.preventDefault(); this.host.history(-1); }
    if (e.button === 4) { e.preventDefault(); this.host.history(1); }
  };

  dispose(): void {
    if (this.hoverFrame) cancelAnimationFrame(this.hoverFrame);
    const el = this.el;
    el.removeEventListener('pointerdown', this.onDown);
    el.removeEventListener('pointermove', this.onMove);
    el.removeEventListener('pointerup', this.onUp);
    el.removeEventListener('pointercancel', this.onCancel);
    el.removeEventListener('pointerleave', this.onLeave);
    el.removeEventListener('wheel', this.onWheel);
    el.removeEventListener('dblclick', this.onDoubleClick);
    el.removeEventListener('contextmenu', this.onContextMenu);
    el.removeEventListener('auxclick', this.onAuxClick);
  }
}
