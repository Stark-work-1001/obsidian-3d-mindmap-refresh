// Conversion between the camera rig's bookmark and the pose stored per note.
// 2.0 stores position, orientation and pivot (v6) and, for older plugin
// versions, the equivalent spherical description (v5 fields).
import { MathUtils, Quaternion, Vector3 } from 'three';
import type { StoredPose } from '../persistence/schema';
import { CameraRig, type CameraBookmark } from './camera-rig';

const round = (v: number, k = 1000) => Math.round(v * k) / k;

export function poseFromBookmark(b: CameraBookmark, extra: { layout: string; focusPath: string | null; now?: number }): StoredPose {
  const q = new Quaternion().fromArray(b.orientation);
  const pivot = new Vector3().fromArray(b.pivot);
  const position = new Vector3().fromArray(b.offset).applyQuaternion(q).add(pivot);
  const d = position.clone().sub(pivot);
  const radius = Math.max(1, d.length());
  return {
    v: 6,
    radius: round(radius), azimuth: round(Math.atan2(d.z, d.x)), polar: round(Math.acos(MathUtils.clamp(d.y / radius, -1, 1))),
    targetX: round(pivot.x), targetY: round(pivot.y), targetZ: round(pivot.z),
    layout: extra.layout, focusPath: extra.focusPath,
    camera: {
      position: position.toArray().map(v => round(v)) as [number, number, number],
      quaternion: b.orientation.map(v => round(v, 1e6)) as [number, number, number, number],
      pivot: b.pivot.map(v => round(v)) as [number, number, number],
      fov: round(b.fov),
    },
    updatedAt: extra.now ?? Date.now(),
  };
}

/** Stored pose (2.0 camera, or 1.x spherical) -> camera bookmark; null when unusable. */
export function poseBookmark(pose: StoredPose, fov: number): CameraBookmark | null {
  const finite = (values: number[]) => values.every(Number.isFinite);
  const c = pose.camera;
  if (pose.v >= 6 && c && Array.isArray(c.position) && Array.isArray(c.quaternion) && Array.isArray(c.pivot)
    && finite([...c.position, ...c.quaternion, ...c.pivot, c.fov])) {
    const q = new Quaternion().fromArray(c.quaternion);
    if (q.lengthSq() < 1e-6) return null;
    q.normalize();
    const offset = new Vector3().fromArray(c.position).sub(new Vector3().fromArray(c.pivot)).applyQuaternion(q.clone().invert());
    return { pivot: [...c.pivot], orientation: q.toArray() as [number, number, number, number], offset: offset.toArray() as [number, number, number], fov: c.fov || fov };
  }
  if (finite([pose.radius, pose.azimuth, pose.polar, pose.targetX, pose.targetY, pose.targetZ]) && pose.radius > 0) {
    return CameraRig.fromSpherical(pose, fov);
  }
  return null;
}
