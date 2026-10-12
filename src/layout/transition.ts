// Animated change between two layouts.
//
// Plain linear interpolation makes clusters pass through each other half way
// (measured in tests/layouts.test.ts). Here every frame's interpolated
// positions get one bounded separation pass; the correction is kept as an
// offset that fades out with the easing, so the animation still ends exactly
// on the target layout. Duration scales with how far nodes travel.
import { separate } from './separation';

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export interface TransitionOptions {
  durationMs?: number;
  collisionAware?: boolean;
}

export class Transition {
  readonly durationMs: number;
  private readonly offset: Float64Array;
  private readonly scratch: Float64Array;
  private readonly startAt: number;
  done = false;

  constructor(
    private readonly from: Float64Array,
    private readonly to: Float64Array,
    private readonly radii: Float64Array,
    private readonly fixed: Uint8Array,
    now: number,
    options: TransitionOptions = {},
  ) {
    const n = radii.length;
    this.offset = new Float64Array(n * 3);
    this.scratch = new Float64Array(n * 3);
    this.startAt = now;
    this.durationMs = options.durationMs ?? Transition.durationFor(from, to);
    this.collisionAware = options.collisionAware ?? true;
  }

  private readonly collisionAware: boolean;

  /** 300-900 ms depending on the median travel relative to the layout size. */
  static durationFor(from: Float64Array, to: Float64Array): number {
    const n = from.length / 3;
    if (!n) return 0;
    const travel: number[] = [];
    let extent = 1;
    for (let i = 0; i < n; i++) {
      travel.push(Math.hypot(to[i * 3] - from[i * 3], to[i * 3 + 1] - from[i * 3 + 1], to[i * 3 + 2] - from[i * 3 + 2]));
      extent = Math.max(extent, Math.hypot(to[i * 3], to[i * 3 + 1], to[i * 3 + 2]));
    }
    travel.sort((a, b) => a - b);
    const median = travel[Math.floor(n / 2)];
    return Math.round(Math.min(900, Math.max(300, 260 + 520 * Math.sqrt(Math.min(1, median / extent)))));
  }

  /** Writes positions for `now` into `out` (x, y, z per node). Returns false once finished. */
  sample(now: number, out: Float64Array): boolean {
    const t = this.durationMs > 0 ? Math.min(1, (now - this.startAt) / this.durationMs) : 1;
    const e = easeInOutCubic(t);
    const fade = 1 - e;
    const { from, to, offset } = this;
    for (let i = 0; i < out.length; i++) out[i] = from[i] + (to[i] - from[i]) * e + offset[i] * fade;
    if (t >= 1) { out.set(to); this.done = true; return false; }
    if (this.collisionAware && e < 0.85 && fade > 1e-3) {
      this.scratch.set(out);
      let maxR = 0;
      for (let i = 0; i < this.radii.length; i++) maxR = Math.max(maxR, this.radii[i]);
      separate(this.scratch, this.radii, this.fixed, this.radii.length, { clearance: 0.05, passes: 1, maxPairs: 12, maxShift: maxR * 0.6 });
      for (let i = 0; i < out.length; i++) {
        const delta = this.scratch[i] - out[i];
        if (delta) { offset[i] += delta / fade; out[i] = this.scratch[i]; }
      }
    }
    return true;
  }
}
