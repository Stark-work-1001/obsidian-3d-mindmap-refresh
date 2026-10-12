// Camera model: a pivot point, an orientation (quaternion) and the camera's
// offset from the pivot expressed in the camera's own frame. The rendered
// position is pivot + orientation * offset.
//
// Why this representation:
// - Orbiting rotates the orientation only; the offset is unchanged, so the
//   camera travels on the arc around the pivot (no chord cutting) and the
//   pivot keeps its screen position while the motion is damped.
// - Panning changes the offset (pivot fixed: orbit-selected / graph-centre
//   modes) or moves the pivot with the camera (free mode). Same rule always.
// - Changing the pivot recomputes the offset from the current position: the
//   camera does not move until a focus animation is explicitly requested.
//
// Damping is exponential in elapsed time (1 - e^{-dt/tau}), so it behaves the
// same at 60 Hz and 240 Hz. Rotations interpolate with quaternion slerp (always
// the short way). Any user input cancels a running animation immediately.
import { MathUtils, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';

export type RotationStyle = 'turntable' | 'trackball';
export type PivotMode = 'free' | 'selected' | 'centre';

export interface Sphere { x: number; y: number; z: number; r: number }
export interface Insets { top: number; right: number; bottom: number; left: number }

export interface CameraBookmark {
  pivot: [number, number, number];
  orientation: [number, number, number, number];
  offset: [number, number, number];
  fov: number;
}

interface State { pivot: Vector3; orientation: Quaternion; offset: Vector3; fov: number }

const WORLD_UP = new Vector3(0, 1, 0);
const MIN_ELEVATION = 0.035; // radians away from straight up/down in turntable mode
const _v1 = new Vector3(), _v2 = new Vector3(), _v3 = new Vector3();
const _q1 = new Quaternion(), _q2 = new Quaternion();
const _m = new Matrix4();

const cloneState = (s: State): State => ({ pivot: s.pivot.clone(), orientation: s.orientation.clone(), offset: s.offset.clone(), fov: s.fov });
const copyState = (to: State, from: State) => { to.pivot.copy(from.pivot); to.orientation.copy(from.orientation); to.offset.copy(from.offset); to.fov = from.fov; };

export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Orientation looking from `from` towards `to` with world up (no roll). */
export function lookRotation(from: Vector3, to: Vector3, out = new Quaternion()): Quaternion {
  const forward = _v1.subVectors(to, from);
  if (forward.lengthSq() < 1e-12) return out.identity();
  _m.lookAt(from, to, Math.abs(forward.normalize().dot(WORLD_UP)) > 0.9999 ? new Vector3(0, 0, -1) : WORLD_UP);
  return out.setFromRotationMatrix(_m);
}

interface Flight { from: State; to: State; start: number; duration: number }

export class CameraRig {
  readonly camera: PerspectiveCamera;
  private readonly cur: State;
  private readonly goal: State;
  private flight: Flight | null = null;
  smoothingMs = 90;
  rotationStyle: RotationStyle = 'turntable';
  pivotMode: PivotMode = 'free';
  /** Radians per pixel = rotateSpeed * PI / viewport height. */
  rotateSpeed = 1;
  viewport = { width: 800, height: 600 };
  insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  /** Extra screen margin (px) kept free when framing, e.g. for labels beside edge nodes. */
  framePadding = { x: 0, y: 0 };
  /** Bounding sphere of the whole scene (clipping planes, zoom limits). */
  bounds: Sphere = { x: 0, y: 0, z: 0, r: 100 };
  /** Nearest sphere to a point: used for clipping planes and clearance. */
  nearestSurface: ((p: Vector3) => { distance: number; x: number; y: number; z: number; r: number } | null) | null = null;
  /** Minimum distance kept between the camera and any sphere surface. */
  clearance = 2;

  constructor(camera: PerspectiveCamera) {
    this.camera = camera;
    const pivot = new Vector3();
    const position = new Vector3(400, 300, 400);
    const orientation = lookRotation(position, pivot);
    const offset = position.clone().sub(pivot).applyQuaternion(orientation.clone().invert());
    this.cur = { pivot, orientation, offset, fov: camera.fov };
    this.goal = cloneState(this.cur);
    this.apply();
  }

  // --- derived quantities ------------------------------------------------------
  private positionOf(s: State, out: Vector3): Vector3 { return out.copy(s.offset).applyQuaternion(s.orientation).add(s.pivot); }
  get position(): Vector3 { return this.positionOf(this.cur, new Vector3()); }
  get pivot(): Vector3 { return this.cur.pivot.clone(); }
  get orientation(): Quaternion { return this.cur.orientation.clone(); }
  get fov(): number { return this.cur.fov; }
  get distance(): number { return this.cur.offset.length(); }
  get animating(): boolean { return this.flight !== null; }
  forward(out = new Vector3()): Vector3 { return out.set(0, 0, -1).applyQuaternion(this.cur.orientation); }

  /** True while the rendered camera has not reached its goal. */
  get moving(): boolean {
    if (this.flight) return true;
    const c = this.cur, g = this.goal;
    return c.pivot.distanceToSquared(g.pivot) > 1e-6 || c.offset.distanceToSquared(g.offset) > 1e-6
      || 1 - Math.abs(c.orientation.dot(g.orientation)) > 1e-9 || Math.abs(c.fov - g.fov) > 1e-4;
  }

  // --- user input (acts on the goal; cancels animations) ------------------------
  private interrupt(): void {
    if (this.flight) { this.flight = null; copyState(this.goal, this.cur); }
  }

  /** Drag-rotate around the pivot by a pixel delta. */
  orbit(dxPx: number, dyPx: number): void {
    this.interrupt();
    const k = (this.rotateSpeed * Math.PI) / Math.max(200, this.viewport.height);
    const g = this.goal;
    const yaw = -dxPx * k;
    let pitch = -dyPx * k;
    const rot = _q1;
    if (this.rotationStyle === 'turntable') {
      const right = _v1.set(1, 0, 0).applyQuaternion(g.orientation);
      // Keep both the view direction and the pivot-to-camera direction off the poles.
      const forward = _v2.set(0, 0, -1).applyQuaternion(g.orientation);
      const offsetWorld = _v3.copy(g.offset).applyQuaternion(g.orientation);
      const elevations = [Math.acos(MathUtils.clamp(-forward.y, -1, 1))];
      if (offsetWorld.lengthSq() > 1e-9) elevations.push(Math.acos(MathUtils.clamp(offsetWorld.normalize().y, -1, 1)));
      for (const e of elevations) pitch = MathUtils.clamp(pitch, MIN_ELEVATION - e, Math.PI - MIN_ELEVATION - e);
      rot.setFromAxisAngle(WORLD_UP, yaw).multiply(_q2.setFromAxisAngle(right, pitch));
    } else {
      const up = _v1.set(0, 1, 0).applyQuaternion(g.orientation);
      const right = _v2.set(1, 0, 0).applyQuaternion(g.orientation);
      rot.setFromAxisAngle(up, yaw).multiply(_q2.setFromAxisAngle(right, pitch));
    }
    g.orientation.premultiply(rot).normalize();
    if (this.rotationStyle === 'turntable') this.level(g.orientation);
  }

  /** Remove roll so the horizon stays level (turntable mode, reset). */
  private level(q: Quaternion): void {
    const forward = _v1.set(0, 0, -1).applyQuaternion(q);
    if (Math.abs(forward.y) > 0.9999) return;
    _m.lookAt(new Vector3(), forward, WORLD_UP);
    q.setFromRotationMatrix(_m);
  }

  /** World units per screen pixel at the pivot's depth (projection-derived). */
  worldPerPixel(state: State = this.goal): number {
    const depth = Math.max(this.camera.near, state.offset.z);
    return (2 * depth * Math.tan(MathUtils.degToRad(state.fov) / 2)) / Math.max(1, this.viewport.height);
  }

  /** Slide the view by a pixel delta; the content under the cursor follows it. */
  pan(dxPx: number, dyPx: number): void {
    this.interrupt();
    const g = this.goal;
    const wpp = this.worldPerPixel(g);
    const dx = -dxPx * wpp, dy = dyPx * wpp;
    if (this.pivotMode === 'free') {
      g.pivot.add(_v1.set(dx, dy, 0).applyQuaternion(g.orientation));
    } else {
      // Pivot stays on its node or centre; the camera slides relative to it.
      g.offset.x += dx;
      g.offset.y += dy;
    }
  }

  /**
   * Dolly towards `target` (the point under the cursor, or the pivot) by
   * `steps` wheel notches (negative = closer). Never passes through the target
   * sphere when `targetRadius` is given.
   */
  dolly(steps: number, target?: Vector3, targetRadius = 0): void {
    this.interrupt();
    const g = this.goal;
    const position = this.positionOf(g, new Vector3());
    const t = target ?? g.pivot;
    const scale = Math.exp(MathUtils.clamp(steps, -6, 6) * 0.12);
    const current = position.distanceTo(t);
    const minimum = Math.max(this.camera.near * 4, targetRadius * 1.6 + this.clearance);
    const maximum = Math.max(this.bounds.r * 40, 2000);
    const wanted = MathUtils.clamp(current * scale, Math.min(minimum, current), Math.max(maximum, current));
    const s = current > 1e-9 ? wanted / current : 1;
    const next = _v1.copy(position).sub(t).multiplyScalar(s).add(t);
    if (this.pivotMode === 'free') g.pivot.sub(t).multiplyScalar(s).add(t);
    g.offset.copy(next).sub(g.pivot).applyQuaternion(_q1.copy(g.orientation).invert());
  }

  /** Magnify by narrowing the field of view (camera does not move). */
  zoomFov(steps: number): void {
    this.interrupt();
    this.goal.fov = MathUtils.clamp(this.goal.fov * Math.exp(steps * 0.08), 20, 75);
  }

  setFov(fov: number): void { this.interrupt(); this.goal.fov = MathUtils.clamp(fov, 20, 75); }

  /** Change the orbit pivot without moving the camera. */
  setPivot(point: Vector3): void {
    for (const s of [this.cur, this.goal]) {
      const position = this.positionOf(s, _v1);
      s.pivot.copy(point);
      s.offset.copy(position).sub(point).applyQuaternion(_q1.copy(s.orientation).invert());
    }
    if (this.flight) { this.flight = null; copyState(this.goal, this.cur); }
  }

  /** Translate the whole camera rigidly with a moving pivot (follow a node). */
  follow(point: Vector3): void {
    const delta = _v2.subVectors(point, this.cur.pivot);
    if (delta.lengthSq() < 1e-12) return;
    for (const s of [this.cur, this.goal, ...(this.flight ? [this.flight.from, this.flight.to] : [])]) s.pivot.add(delta);
  }

  /** Level the horizon (trackball mode recovery) keeping the view direction. */
  resetRoll(animate = true): void {
    const target = cloneState(this.goal);
    this.level(target.orientation);
    this.flyTo(target, animate ? 300 : 0);
  }

  // --- animations ------------------------------------------------------------------
  flyTo(target: Partial<State>, ms = 450): void {
    const to: State = {
      pivot: target.pivot?.clone() ?? this.cur.pivot.clone(),
      orientation: target.orientation?.clone() ?? this.cur.orientation.clone(),
      offset: target.offset?.clone() ?? this.cur.offset.clone(),
      fov: target.fov ?? this.cur.fov,
    };
    if (ms <= 0) { copyState(this.cur, to); copyState(this.goal, to); this.flight = null; this.apply(); return; }
    this.flight = { from: cloneState(this.cur), to, start: performance.now(), duration: ms };
  }

  /**
   * Distance and centre that fit `spheres` inside the viewport (minus UI
   * insets) for a given orientation and field of view. Closed form: in the
   * camera frame each sphere needs depth >= (|x| + r) / (half-width * tan(fovX/2)).
   */
  fit(spheres: Sphere[], orientation: Quaternion = this.goal.orientation, fov = this.goal.fov, margin = 1.08): { pivot: Vector3; distance: number } | null {
    if (!spheres.length) return null;
    const inv = _q1.copy(orientation).invert();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, cx = 0, cy = 0, cz = 0;
    for (const s of spheres) { cx += s.x; cy += s.y; cz += s.z; }
    cx /= spheres.length; cy /= spheres.length; cz /= spheres.length;
    const local = spheres.map(s => {
      const p = new Vector3(s.x - cx, s.y - cy, s.z - cz).applyQuaternion(inv);
      minX = Math.min(minX, p.x - s.r); maxX = Math.max(maxX, p.x + s.r);
      minY = Math.min(minY, p.y - s.r); maxY = Math.max(maxY, p.y + s.r);
      return { p, r: s.r };
    });
    // Centre on the projected extent, not on the centroid.
    const shift = new Vector3((minX + maxX) / 2, (minY + maxY) / 2, 0);
    const pivot = shift.clone().applyQuaternion(orientation).add(new Vector3(cx, cy, cz));
    const { width, height } = this.viewport;
    const freeW = Math.max(40, width - this.insets.left - this.insets.right - 2 * this.framePadding.x) / width;
    const freeH = Math.max(40, height - this.insets.top - this.insets.bottom - 2 * this.framePadding.y) / height;
    const tanY = Math.tan(MathUtils.degToRad(fov) / 2);
    const tanX = tanY * (width / Math.max(1, height));
    let distance = 0;
    for (const { p, r } of local) {
      const x = Math.abs(p.x - shift.x), y = Math.abs(p.y - shift.y);
      const need = Math.max((x + r) / (freeW * tanX), (y + r) / (freeH * tanY), r * 1.6 + this.clearance);
      distance = Math.max(distance, p.z + need * margin);
    }
    return { pivot, distance: Math.max(distance, this.camera.near * 10) };
  }

  /** Animate to frame spheres, optionally with a new orientation. */
  frame(spheres: Sphere[], options: { orientation?: Quaternion; ms?: number; margin?: number } = {}): boolean {
    const orientation = options.orientation ?? this.goal.orientation;
    const fitted = this.fit(spheres, orientation, this.goal.fov, options.margin);
    if (!fitted) return false;
    this.flyTo({ pivot: fitted.pivot, orientation, offset: new Vector3(0, 0, fitted.distance) }, options.ms ?? 450);
    return true;
  }

  // --- per-frame update ---------------------------------------------------------
  /** Advance damping/animation by `dtMs`; returns true while still moving. */
  update(dtMs: number, now = performance.now()): boolean {
    const c = this.cur, g = this.goal;
    if (this.flight) {
      const f = this.flight;
      const t = f.duration > 0 ? Math.min(1, (now - f.start) / f.duration) : 1;
      const e = easeInOut(t);
      c.pivot.lerpVectors(f.from.pivot, f.to.pivot, e);
      c.orientation.slerpQuaternions(f.from.orientation, f.to.orientation, e);
      // Distance interpolates logarithmically: zooming feels uniform.
      const la = Math.max(1e-6, f.from.offset.length()), lb = Math.max(1e-6, f.to.offset.length());
      const dir = _v1.copy(f.from.offset).divideScalar(la).lerp(_v2.copy(f.to.offset).divideScalar(lb), e);
      if (dir.lengthSq() < 1e-12) dir.set(0, 0, 1);
      c.offset.copy(dir.normalize()).multiplyScalar(Math.exp(Math.log(la) + (Math.log(lb) - Math.log(la)) * e));
      c.fov = f.from.fov + (f.to.fov - f.from.fov) * e;
      copyState(g, c);
      if (t >= 1) { copyState(c, f.to); copyState(g, f.to); this.flight = null; }
    } else {
      const a = this.smoothingMs <= 0 ? 1 : 1 - Math.exp(-Math.max(0, dtMs) / this.smoothingMs);
      c.pivot.lerp(g.pivot, a);
      c.orientation.slerp(g.orientation, a);
      c.offset.lerp(g.offset, a);
      c.fov += (g.fov - c.fov) * a;
      if (a >= 1 || !this.moving) copyState(c, g);
    }
    this.keepClear();
    this.apply();
    return this.moving;
  }

  /** Push the camera out of any sphere it would otherwise clip into. */
  private keepClear(): void {
    if (!this.nearestSurface) return;
    const position = this.positionOf(this.cur, _v1);
    const near = this.nearestSurface(position);
    if (!near || near.distance >= this.clearance) return;
    const centre = _v2.set(near.x, near.y, near.z);
    const away = _v3.subVectors(position, centre);
    if (away.lengthSq() < 1e-9) away.set(0, 0, 1).applyQuaternion(this.cur.orientation);
    away.setLength(near.r + this.clearance);
    const corrected = centre.add(away);
    for (const s of [this.cur, this.goal]) s.offset.copy(corrected).sub(s.pivot).applyQuaternion(_q1.copy(s.orientation).invert());
  }

  /** Write the current state to the three.js camera, including clipping and view offset. */
  apply(): void {
    const cam = this.camera;
    this.positionOf(this.cur, cam.position);
    cam.quaternion.copy(this.cur.orientation);
    cam.fov = this.cur.fov;
    cam.aspect = this.viewport.width / Math.max(1, this.viewport.height);
    // Near/far from the visible scene: far just beyond the scene bounds, near
    // as large as the closest surface allows (better depth precision than a
    // fixed 1..40000 range).
    const b = this.bounds;
    const toCentre = Math.hypot(cam.position.x - b.x, cam.position.y - b.y, cam.position.z - b.z);
    const far = Math.max(50, toCentre + b.r * 1.1 + 10);
    const nearest = this.nearestSurface?.(cam.position)?.distance ?? toCentre - b.r;
    cam.far = far;
    cam.near = MathUtils.clamp(nearest * 0.5, Math.max(0.05, far / 20000), Math.max(0.1, far / 40));
    // Shift the principal point to the centre of the area not covered by panels.
    const { width, height } = this.viewport;
    const ox = (this.insets.right - this.insets.left) / 2, oy = (this.insets.bottom - this.insets.top) / 2;
    if (ox || oy) cam.setViewOffset(width, height, ox, oy, width, height); else cam.clearViewOffset();
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  }

  // --- persistence -----------------------------------------------------------------
  bookmark(): CameraBookmark {
    const s = this.flight ? this.flight.to : this.goal;
    return { pivot: s.pivot.toArray() as [number, number, number], orientation: s.orientation.toArray() as [number, number, number, number], offset: s.offset.toArray() as [number, number, number], fov: s.fov };
  }

  restore(b: CameraBookmark, ms = 0): void {
    this.flyTo({ pivot: new Vector3().fromArray(b.pivot), orientation: new Quaternion().fromArray(b.orientation).normalize(), offset: new Vector3().fromArray(b.offset), fov: b.fov }, ms);
  }

  /** 1.x spherical pose (radius, azimuth, polar around target) -> state. */
  static fromSpherical(p: { radius: number; azimuth: number; polar: number; targetX: number; targetY: number; targetZ: number }, fov = 52): CameraBookmark {
    const target = new Vector3(p.targetX, p.targetY, p.targetZ);
    const s = Math.sin(p.polar);
    const position = new Vector3(p.targetX + p.radius * s * Math.cos(p.azimuth), p.targetY + p.radius * Math.cos(p.polar), p.targetZ + p.radius * s * Math.sin(p.azimuth));
    const orientation = lookRotation(position, target);
    return { pivot: target.toArray() as [number, number, number], orientation: orientation.toArray() as [number, number, number, number], offset: [0, 0, p.radius], fov };
  }

  /** Spherical description of the current pose (kept in data.json for older versions). */
  toSpherical(): { radius: number; azimuth: number; polar: number; targetX: number; targetY: number; targetZ: number } {
    const position = this.position, pivot = this.cur.pivot;
    const d = position.clone().sub(pivot);
    const radius = Math.max(1, d.length());
    return { radius, azimuth: Math.atan2(d.z, d.x), polar: Math.acos(MathUtils.clamp(d.y / radius, -1, 1)), targetX: pivot.x, targetY: pivot.y, targetZ: pivot.z };
  }
}
