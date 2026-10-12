import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { CameraRig, lookRotation, type Sphere } from '../src/camera/camera-rig';

function rig(): CameraRig {
  const r = new CameraRig(new PerspectiveCamera(52, 1280 / 720, 1, 10000));
  r.viewport = { width: 1280, height: 720 };
  r.bounds = { x: 0, y: 0, z: 0, r: 400 };
  r.flyTo({ pivot: new Vector3(0, 0, 0), orientation: lookRotation(new Vector3(300, 200, 300), new Vector3()), offset: new Vector3(0, 0, Math.hypot(300, 200, 300)) }, 0);
  return r;
}
const ndc = (r: CameraRig, p: Vector3) => p.clone().project(r.camera);
const settle = (r: CameraRig, dt: number, ms = 3000) => { for (let t = 0; t < ms; t += dt) r.update(dt, 1e9); };

test('damping is frame-rate independent (60 Hz vs 240 Hz)', () => {
  const a = rig(), b = rig();
  a.orbit(300, 80); b.orbit(300, 80);
  a.pan(40, -20); b.pan(40, -20);
  a.dolly(-3); b.dolly(-3);
  // Exactly 100 ms of elapsed time at each refresh rate.
  for (let k = 0; k < 6; k++) a.update(100 / 6, 1e9);
  for (let k = 0; k < 24; k++) b.update(100 / 24, 1e9);
  assert.ok(a.position.distanceTo(b.position) < 1e-6 * a.distance + 1e-6, `${a.position.toArray()} vs ${b.position.toArray()}`);
  assert.ok(1 - Math.abs(a.orientation.dot(b.orientation)) < 1e-9);
});

test('orbiting keeps the pivot at the same screen position and preserves distance', () => {
  const r = rig();
  r.setPivot(new Vector3(60, -20, 10));
  const before = ndc(r, new Vector3(60, -20, 10));
  const distance = r.distance;
  r.orbit(450, -120);
  for (let k = 0; k < 10; k++) { r.update(16, 1e9); const now = ndc(r, new Vector3(60, -20, 10)); assert.ok(Math.hypot(now.x - before.x, now.y - before.y) < 1e-6, 'pivot drifted during damping'); }
  settle(r, 16);
  assert.ok(Math.abs(r.distance - distance) < 1e-6);
});

test('switching the pivot never moves the camera', () => {
  const r = rig();
  const p0 = r.position, q0 = r.orientation;
  for (const mode of ['selected', 'centre', 'free'] as const) {
    r.pivotMode = mode;
    r.setPivot(new Vector3(Math.random() * 100, 50, -30));
    r.update(16, 1e9);
    assert.ok(r.position.distanceTo(p0) < 1e-6);
    assert.ok(1 - Math.abs(r.orientation.dot(q0)) < 1e-12);
  }
});

test('turntable never crosses the poles and keeps the horizon level', () => {
  const r = rig();
  for (let k = 0; k < 50; k++) { r.orbit(37, -400); settle(r, 16, 200); }
  const forward = r.forward();
  assert.ok(Math.abs(forward.y) < Math.cos(0.03), `forward ${forward.toArray()}`);
  const right = new Vector3(1, 0, 0).applyQuaternion(r.orientation);
  assert.ok(Math.abs(right.y) < 1e-6, `roll ${right.y}`);
});

test('trackball rotates freely and reset levels the horizon', () => {
  const r = rig();
  r.rotationStyle = 'trackball';
  for (let k = 0; k < 20; k++) { r.orbit(53, -170); settle(r, 16, 200); }
  r.resetRoll(false);
  const right = new Vector3(1, 0, 0).applyQuaternion(r.orientation);
  assert.ok(Math.abs(right.y) < 1e-6);
});

test('animations take the shortest rotation', () => {
  const r = rig();
  const start = r.orientation;
  const target = start.clone().premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (350 * Math.PI) / 180));
  r.flyTo({ orientation: target }, 1000);
  const t0 = performance.now();
  let maxAngle = 0;
  for (let ms = 0; ms <= 1000; ms += 50) { r.update(50, t0 + ms); maxAngle = Math.max(maxAngle, start.angleTo(r.orientation)); }
  assert.ok(maxAngle <= (10.5 * Math.PI) / 180, `rotated ${(maxAngle * 180) / Math.PI} degrees`);
});

test('panning moves content at the pivot depth exactly with the cursor', () => {
  for (const mode of ['free', 'selected'] as const) {
    const r = rig();
    r.pivotMode = mode;
    const point = new Vector3(0, 0, 0);
    const a = ndc(r, point);
    r.pan(100, -50);
    settle(r, 16);
    const b = ndc(r, point);
    const px = ((b.x - a.x) / 2) * 1280, py = (-(b.y - a.y) / 2) * 720;
    assert.ok(Math.abs(px - 100) < 0.5 && Math.abs(py + 50) < 0.5, `${mode}: moved ${px.toFixed(2)}, ${py.toFixed(2)} px`);
  }
});

test('zoom towards the cursor keeps the point under the cursor fixed', () => {
  const r = rig();
  const target = new Vector3(80, 30, -40);
  const before = ndc(r, target);
  r.dolly(-4, target);
  settle(r, 16);
  const after = ndc(r, target);
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 1e-6);
  assert.ok(r.position.distanceTo(target) < Math.hypot(300, 200, 300) * 0.8);
});

test('zooming in never passes into the target sphere', () => {
  const r = rig();
  const target = new Vector3(0, 0, 0);
  for (let k = 0; k < 60; k++) r.dolly(-6, target, 10);
  settle(r, 16);
  assert.ok(r.position.distanceTo(target) >= 16 - 1e-6, `distance ${r.position.distanceTo(target)}`);
});

test('field-of-view zoom magnifies without moving the camera', () => {
  const r = rig();
  const p = r.position;
  r.zoomFov(-5);
  settle(r, 16);
  assert.ok(r.position.distanceTo(p) < 1e-6);
  assert.ok(r.fov < 52);
});

test('fitting keeps every sphere inside the area not covered by panels', () => {
  const r = rig();
  r.insets = { top: 60, right: 320, bottom: 0, left: 0 };
  const spheres: Sphere[] = [];
  for (let i = 0; i < 400; i++) spheres.push({ x: Math.cos(i) * 900, y: (i % 13) * 40 - 200, z: Math.sin(i * 1.7) * 300, r: 4 + (i % 5) * 3 });
  r.frame(spheres, { ms: 0 });
  r.update(16, 1e9);
  const W = 1280, H = 720;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of spheres) {
    for (const [dx, dy, dz] of [[s.r, 0, 0], [-s.r, 0, 0], [0, s.r, 0], [0, -s.r, 0], [0, 0, s.r], [0, 0, -s.r]]) {
      const p = new Vector3(s.x + dx, s.y + dy, s.z + dz).project(r.camera);
      const sx = ((p.x + 1) / 2) * W, sy = ((1 - p.y) / 2) * H;
      minX = Math.min(minX, sx); maxX = Math.max(maxX, sx); minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
    }
  }
  assert.ok(minX >= -0.5 && maxX <= W - 320 + 0.5, `x ${minX.toFixed(1)}..${maxX.toFixed(1)}`);
  assert.ok(minY >= 60 - 0.5 && maxY <= H + 0.5, `y ${minY.toFixed(1)}..${maxY.toFixed(1)}`);
  // The content is centred in the free area (within a few percent).
  assert.ok(Math.abs((minX + maxX) / 2 - (W - 320) / 2) < 0.06 * W);
});

test('clipping planes follow the scene and close surfaces', () => {
  const r = rig();
  r.nearestSurface = p => ({ distance: p.length() - 10, x: 0, y: 0, z: 0, r: 10 });
  r.update(16, 1e9);
  assert.ok(r.camera.far >= r.position.length() + 400);
  assert.ok(r.camera.far < 5000, `far ${r.camera.far}`);
  assert.ok(r.camera.near > 0 && r.camera.near <= (r.position.length() - 10) * 0.5 + 1e-6);
});

test('any input interrupts a running animation without a jump', () => {
  const r = rig();
  r.flyTo({ pivot: new Vector3(2000, 0, 0) }, 2000);
  const t0 = performance.now();
  r.update(16, t0 + 500);
  const mid = r.position;
  r.orbit(1, 0);
  assert.equal(r.animating, false);
  r.update(1, t0 + 501);
  assert.ok(r.position.distanceTo(mid) < 5, 'continues from where it was');
});

test('following a moving node translates the camera rigidly', () => {
  const r = rig();
  r.pivotMode = 'selected';
  r.setPivot(new Vector3(10, 0, 0));
  const q = r.orientation, p = r.position;
  r.follow(new Vector3(35, 5, -12));
  r.update(16, 1e9);
  assert.ok(r.position.distanceTo(p.clone().add(new Vector3(25, 5, -12))) < 1e-6);
  assert.ok(1 - Math.abs(r.orientation.dot(q)) < 1e-12);
});

test('legacy spherical poses convert both ways', () => {
  const legacy = { radius: 620, azimuth: Math.PI / 4, polar: Math.PI / 2.55, targetX: 5, targetY: -3, targetZ: 9 };
  const r = rig();
  r.restore(CameraRig.fromSpherical(legacy), 0);
  r.update(16, 1e9);
  const back = r.toSpherical();
  for (const key of Object.keys(legacy) as (keyof typeof legacy)[]) assert.ok(Math.abs(back[key] - legacy[key]) < 1e-6, key);
});
