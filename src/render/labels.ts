// DOM labels for the most relevant visible nodes.
//
// - A fixed pool of elements is reused; a node keeps its element while it
//   stays visible (no re-creation, no flicker) and innerHTML is only written
//   when the element changes node or the node's text changes.
// - Candidates are scored in preallocated typed arrays (no per-frame object
//   allocation): tier first (selected / key concept / search / ancestors /
//   chapters / topics / rest), then distance.
// - A coarse screen-space occupancy grid prevents labels from overlapping.
//   A label that does not fit above its node tries below, right and left
//   before it is hidden; the label of the node in focus is always shown.
import type { PerspectiveCamera } from 'three';

export const LABEL_TIER = { selected: 0, important: 1, related: 2, chapter: 3, topic: 4, normal: 5, outOfFocus: 8 } as const;
/** Label states, exposed as data-state for styling; independent of the tier. */
export const LABEL_STATE = { none: 0, selected: 1, hover: 2, search: 3, searchCurrent: 4, mark: 5, related: 6, connect: 7 } as const;
const STATE_NAMES = ['', 'selected', 'hover', 'search', 'search-current', 'mark', 'related', 'connect'];
const PLACEMENT_SHIFT = ['translate(-50%,-100%)', 'translate(-50%,0)', 'translate(0,-50%)', 'translate(-100%,-50%)'];
const PLACEMENT_NAMES = ['above', 'below', 'right', 'left'];

export interface LabelEntry {
  html: string;
  /** Plain text, for the tooltip, accessibility and width estimate. */
  text: string;
  kind: 'root' | 'heading' | 'list-item';
}

export interface LabelOptions {
  maxDistance: number;
  fontSize: number;
  avoid: boolean;
  budget: number;
}

export class LabelLayer {
  readonly el: HTMLDivElement;
  private pool: HTMLDivElement[] = [];
  private poolNode: Int32Array = new Int32Array(0);
  private nodeSlot = new Int32Array(0);
  private entries: LabelEntry[] = [];
  private tiers: Uint8Array = new Uint8Array(0);
  private states: Uint8Array = new Uint8Array(0);
  private keys = new Float64Array(0);
  private order = new Uint32Array(0);
  private sx = new Float32Array(0);
  private sy = new Float32Array(0);
  /** Projected centre y of the sphere (labels placed below or beside it). */
  private cy = new Float32Array(0);
  /** Placement per node: 0 above, 1 below, 2 right, 3 left. */
  private placement = new Uint8Array(0);
  private boxW = new Float32Array(0);
  private boxH = new Float32Array(0);
  private depth = new Float32Array(0);
  private widths = new Float32Array(0);
  private contentVersion = new Uint32Array(0);
  private poolVersion = new Int32Array(0);
  private grid = new Uint8Array(0);
  private gridKey = '';
  visibleCount = 0;
  private readonly ids: string[] = [];
  /** Last opacity written per pool element (style reads normalise the value). */
  private slotOpacity: string[] = [];

  constructor(container: HTMLElement, private readonly onClick?: (index: number, event: MouseEvent) => void) {
    this.el = container.ownerDocument.createElement('div');
    this.el.className = 'om3d-labels';
    this.el.setAttribute('aria-hidden', 'true');
    container.appendChild(this.el);
    this.el.addEventListener('click', event => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('.om3d-label');
      if (!target || (event.target as HTMLElement).closest('.om3d-wikilink, .om3d-link')) return;
      const index = Number(target.dataset.index);
      if (Number.isInteger(index) && index >= 0) this.onClick?.(index, event);
    });
  }

  /** Set label content for all nodes (index-aligned with positions). */
  setEntries(ids: string[], entries: LabelEntry[]): void {
    const n = entries.length;
    const previous = new Map(this.ids.map((id, i) => [id, i]));
    const oldEntries = this.entries, oldVersions = this.contentVersion, oldSlots = this.nodeSlot;
    this.ids.length = 0; this.ids.push(...ids);
    this.entries = entries;
    this.tiers = new Uint8Array(n).fill(LABEL_TIER.normal);
    this.states = new Uint8Array(n);
    this.keys = new Float64Array(n);
    this.order = new Uint32Array(n);
    this.sx = new Float32Array(n); this.sy = new Float32Array(n); this.cy = new Float32Array(n); this.depth = new Float32Array(n);
    this.placement = new Uint8Array(n); this.boxW = new Float32Array(n); this.boxH = new Float32Array(n);
    this.widths = Float32Array.from(entries, e => Math.min(30, Math.max(3, e.text.length)));
    this.contentVersion = new Uint32Array(n);
    this.nodeSlot = new Int32Array(n).fill(-1);
    // Keep elements attached to nodes that still exist (by id), so labels do not blink on edits.
    const slotNode = new Int32Array(this.pool.length).fill(-1);
    for (let i = 0; i < n; i++) {
      const old = previous.get(ids[i]);
      if (old === undefined) continue;
      const slot = oldSlots[old] ?? -1;
      this.contentVersion[i] = oldEntries[old]?.html === entries[i].html ? oldVersions[old] : oldVersions[old] + 1;
      if (slot >= 0) { this.nodeSlot[i] = slot; slotNode[slot] = i; }
    }
    for (let s = 0; s < this.pool.length; s++) {
      this.poolNode[s] = slotNode[s];
      if (slotNode[s] < 0) this.hide(s);
      else this.pool[s].dataset.index = String(slotNode[s]);
    }
  }

  setTiers(tiers: Uint8Array, states?: Uint8Array): void { this.tiers = tiers; if (states) this.states = states; }

  private hide(slot: number): void {
    const el = this.pool[slot];
    if (el.style.visibility !== 'hidden') { el.style.visibility = 'hidden'; el.classList.remove('is-shown'); }
  }

  private ensurePool(size: number): void {
    while (this.pool.length < size) {
      const el = this.el.ownerDocument.createElement('div');
      el.className = 'om3d-label';
      el.style.visibility = 'hidden';
      this.el.appendChild(el);
      this.pool.push(el);
    }
    if (this.poolNode.length < this.pool.length) {
      const next = new Int32Array(this.pool.length).fill(-1); next.set(this.poolNode); this.poolNode = next;
      const versions = new Int32Array(this.pool.length).fill(-1); versions.set(this.poolVersion); this.poolVersion = versions;
    }
  }

  /** Project, rank and place labels. Cost is O(n log n) only while something moves. */
  update(camera: PerspectiveCamera, positions: Float32Array, radii: Float32Array, width: number, height: number, options: LabelOptions): void {
    const n = this.entries.length;
    const view = camera.matrixWorldInverse.elements, proj = camera.projectionMatrix.elements;
    let candidates = 0;
    for (let i = 0; i < n; i++) {
      const x = positions[i * 4], yc = positions[i * 4 + 1], z = positions[i * 4 + 2], lift = radii[i] * 1.25;
      // View-space centre; the label anchor sits `lift` above it in world y.
      const cvx = view[0] * x + view[4] * yc + view[8] * z + view[12];
      const cvy = view[1] * x + view[5] * yc + view[9] * z + view[13];
      const cvz = view[2] * x + view[6] * yc + view[10] * z + view[14];
      const vx = cvx + view[4] * lift, vy = cvy + view[5] * lift, vz = cvz + view[6] * lift;
      const d = -vz;
      if (d <= camera.near) continue;
      const tier = this.tiers[i];
      if (d > options.maxDistance && tier > LABEL_TIER.chapter) continue;
      const cx = proj[0] * vx + proj[4] * vy + proj[8] * vz + proj[12];
      const cy = proj[1] * vx + proj[5] * vy + proj[9] * vz + proj[13];
      const cw = proj[3] * vx + proj[7] * vy + proj[11] * vz + proj[15];
      const nx = cx / cw, ny = cy / cw;
      if (nx < -1.1 || nx > 1.1 || ny < -1.1 || ny > 1.15) continue;
      this.sx[i] = (nx * 0.5 + 0.5) * width;
      this.sy[i] = (-ny * 0.5 + 0.5) * height;
      const ccy = proj[1] * cvx + proj[5] * cvy + proj[9] * cvz + proj[13];
      const ccw = proj[3] * cvx + proj[7] * cvy + proj[11] * cvz + proj[15];
      this.cy[i] = Math.abs(ccw) > 1e-9 ? (-(ccy / ccw) * 0.5 + 0.5) * height : this.sy[i];
      this.depth[i] = d;
      this.keys[i] = tier * 1e9 + d;
      this.order[candidates++] = i;
    }
    const ranked = this.order.subarray(0, candidates).sort((a, b) => this.keys[a] - this.keys[b]);
    // Fine cells (8 px wide) so neighbouring labels are not rejected by quantisation.
    const cellW = 8, cellH = Math.max(6, options.fontSize * 0.6);
    const cols = Math.max(1, Math.ceil(width / cellW)), rows = Math.max(1, Math.ceil(height / cellH));
    const key = `${cols}x${rows}`;
    if (key !== this.gridKey) { this.grid = new Uint8Array(cols * rows); this.gridKey = key; } else this.grid.fill(0);
    const budget = Math.max(0, options.budget);
    this.ensurePool(Math.min(budget, n));
    const keep = new Uint8Array(this.pool.length);
    const chosen: number[] = [];
    for (let k = 0; k < ranked.length && chosen.length < budget; k++) {
      const i = ranked[k];
      const tier = this.tiers[i];
      const scale = Math.max(0.6, Math.min(1.15, 1 - (this.depth[i] / Math.max(1, options.maxDistance)) * 0.45));
      const w = this.widths[i] * options.fontSize * 0.58 * scale + 8, h = options.fontSize * 1.45 * scale;
      this.boxW[i] = w; this.boxH[i] = h;
      this.placement[i] = 0;
      if (options.avoid) {
        // Candidate boxes (left, top): above, below, right, left of the sphere.
        const sx = this.sx[i], top = this.sy[i], centre = this.cy[i];
        const reach = Math.max(2, (centre - top) * 0.8);
        let chosen = -1;
        for (let p = 0; p < 4 && chosen < 0; p++) {
          const left = p === 0 || p === 1 ? sx - w / 2 : p === 2 ? sx + reach + 4 : sx - reach - 4 - w;
          const upper = p === 0 ? top - h : p === 1 ? centre + reach : centre - h / 2;
          // Boxes are tested slightly inset: labels may touch, not overlap.
          const x0 = Math.max(0, Math.floor((left + 2) / cellW)), x1 = Math.min(cols - 1, Math.floor((left + w - 2) / cellW));
          const y0 = Math.max(0, Math.floor((upper + 1) / cellH)), y1 = Math.min(rows - 1, Math.floor((upper + h - 1) / cellH));
          let blocked = x1 < x0 || y1 < y0;
          for (let gy = y0; gy <= y1 && !blocked; gy++) for (let gx = x0; gx <= x1; gx++) if (this.grid[gy * cols + gx]) { blocked = true; break; }
          if (!blocked) {
            chosen = p;
            for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) this.grid[gy * cols + gx] = 1;
          }
        }
        if (chosen < 0) {
          // Only the node in focus (selected, hovered, current match) may overlap others;
          // key concepts and matches rank first but still give way when there is no room.
          if (tier > LABEL_TIER.selected) continue;
          chosen = 0;
        }
        this.placement[i] = chosen;
      }
      chosen.push(i);
      this.keys[i] = scale; // reuse as scale storage for placement below
      if (this.nodeSlot[i] >= 0) keep[this.nodeSlot[i]] = 1;
    }
    // Free elements whose node is no longer shown; then place the chosen ones.
    const free: number[] = [];
    for (let s = 0; s < this.pool.length; s++) {
      if (keep[s]) continue;
      const node = this.poolNode[s];
      if (node >= 0) this.nodeSlot[node] = -1;
      this.poolNode[s] = -1;
      this.hide(s);
      free.push(s);
    }
    for (const i of chosen) {
      let slot = this.nodeSlot[i];
      if (slot < 0) { slot = free.pop()!; this.nodeSlot[i] = slot; this.poolNode[slot] = i; this.poolVersion[slot] = -1; }
      const el = this.pool[slot];
      const entry = this.entries[i];
      if (this.poolVersion[slot] !== this.contentVersion[i] || el.dataset.index !== String(i)) {
        el.innerHTML = entry.html;
        el.dataset.index = String(i);
        el.dataset.kind = entry.kind;
        el.title = entry.text;
        this.poolVersion[slot] = this.contentVersion[i];
      }
      // Attribute writes invalidate style even when the value is unchanged: write only on change.
      const tier = this.tiers[i];
      const tierText = String(tier);
      if (el.dataset.tier !== tierText) el.dataset.tier = tierText;
      const state = STATE_NAMES[this.states[i] ?? 0] ?? '';
      if ((el.dataset.state ?? '') !== state) { if (state) el.dataset.state = state; else delete el.dataset.state; }
      const scale = this.keys[i];
      const anchor = this.anchor(i);
      el.style.transform = `translate3d(${anchor.x.toFixed(1)}px,${anchor.y.toFixed(1)}px,0) ${PLACEMENT_SHIFT[this.placement[i]]} scale(${scale.toFixed(3)})`;
      const place = PLACEMENT_NAMES[this.placement[i]];
      if (el.dataset.place !== place) el.dataset.place = place;
      const opacity = (tier <= LABEL_TIER.related ? 1 : Math.max(0.45, 1 - (this.depth[i] / Math.max(1, options.maxDistance)) * 0.55)).toFixed(2);
      if (this.slotOpacity[slot] !== opacity) { this.slotOpacity[slot] = opacity; el.style.opacity = opacity; }
      if (el.style.visibility !== 'visible') { el.style.visibility = 'visible'; el.classList.add('is-shown'); }
    }
    this.visibleCount = chosen.length;
  }

  get allocated(): number { return this.pool.length; }

  /** Screen point the label element is attached to, for its placement. */
  private anchor(i: number): { x: number; y: number } {
    const top = this.sy[i], centre = this.cy[i], reach = Math.max(2, (centre - top) * 0.8);
    switch (this.placement[i]) {
      case 1: return { x: this.sx[i], y: centre + reach };
      case 2: return { x: this.sx[i] + reach + 4, y: centre };
      case 3: return { x: this.sx[i] - reach - 4, y: centre };
      default: return { x: this.sx[i], y: top };
    }
  }

  /** Labels currently shown (for PNG export): screen position and text. */
  shownLabels(): { x: number; y: number; text: string; kind: string; opacity: number }[] {
    const out: { x: number; y: number; text: string; kind: string; opacity: number }[] = [];
    for (let s = 0; s < this.pool.length; s++) {
      const i = this.poolNode[s];
      if (i < 0) continue;
      // Centre-bottom of the label box, whatever side of the node it is on.
      const a = this.anchor(i), w = this.boxW[i], h = this.boxH[i];
      const p = this.placement[i];
      const x = p === 2 ? a.x + w / 2 : p === 3 ? a.x - w / 2 : a.x;
      const y = p === 1 ? a.y + h : p === 2 || p === 3 ? a.y + h / 2 : a.y;
      out.push({ x, y, text: this.entries[i].text, kind: this.entries[i].kind, opacity: Number(this.pool[s].style.opacity) || 1 });
    }
    return out;
  }

  hideAll(): void { for (let s = 0; s < this.pool.length; s++) this.hide(s); }

  dispose(): void { this.el.remove(); this.pool = []; }
}
