// Ray-sphere picking against the same radii used for rendering and layout.
// Linear scan: ~3000 sphere tests take well under 0.1 ms, cheaper than
// maintaining an acceleration structure for positions that move every frame.
import { MathUtils, Raycaster, Vector2, Vector3, type PerspectiveCamera } from 'three';

const raycaster = new Raycaster();
const ndc = new Vector2();
const v = new Vector3();

export interface PickHit { index: number; distance: number; point: Vector3 }

/** Ray for a pixel (CSS px relative to the canvas). Honours the camera's view offset. */
export function rayAt(camera: PerspectiveCamera, x: number, y: number, width: number, height: number) {
  ndc.set((x / Math.max(1, width)) * 2 - 1, -(y / Math.max(1, height)) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray;
}

export function pickSphere(camera: PerspectiveCamera, x: number, y: number, width: number, height: number,
  positions: Float32Array, radii: Float32Array, count: number, skip?: (i: number) => boolean, tolerancePx = 0): PickHit | null {
  const ray = rayAt(camera, x, y, width, height);
  const o = ray.origin, d = ray.direction;
  // Small or distant spheres stay clickable: a minimum radius in screen pixels.
  const perUnit = tolerancePx > 0 ? ((2 * Math.tan(MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, height)) * tolerancePx / Math.max(1e-6, camera.zoom) : 0;
  let best = -1, bestT = Infinity;
  for (let i = 0; i < count; i++) {
    if (skip?.(i)) continue;
    const cx = positions[i * 4] - o.x, cy = positions[i * 4 + 1] - o.y, cz = positions[i * 4 + 2] - o.z;
    const along = cx * d.x + cy * d.y + cz * d.z;
    const r = Math.max(radii[i], along * perUnit);
    if (along < -r) continue;
    const perp2 = cx * cx + cy * cy + cz * cz - along * along;
    if (perp2 > r * r) continue;
    const t = along - Math.sqrt(Math.max(0, r * r - perp2));
    if (t < bestT && t > 0) { bestT = t; best = i; }
  }
  if (best < 0) return null;
  return { index: best, distance: bestT, point: v.copy(d).multiplyScalar(bestT).add(o).clone() };
}

/** Where the cursor ray meets the plane through `point` facing the camera. */
export function pointOnViewPlane(camera: PerspectiveCamera, x: number, y: number, width: number, height: number, point: Vector3): Vector3 | null {
  const ray = rayAt(camera, x, y, width, height);
  const normal = camera.getWorldDirection(new Vector3());
  const denom = ray.direction.dot(normal);
  if (Math.abs(denom) < 1e-6) return null;
  const t = v.copy(point).sub(ray.origin).dot(normal) / denom;
  return t > 0 ? ray.origin.clone().addScaledVector(ray.direction, t) : null;
}
