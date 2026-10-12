// Shape of the plugin's data.json. Per-note maps are keyed by vault path
// (forward slashes). Node references use node paths (model/node-paths.ts).
import type { StoredAssociation, StoredMark } from '../model/node-paths';
import type { Settings } from './settings';

export const SCHEMA_VERSION = 2;

/** Camera pose stored per note. Legacy spherical fields are kept for older plugin versions. */
export interface StoredPose {
  /** Pose geometry version: 5 = spherical (1.15-1.17), 6 = position/orientation (2.0). */
  v: number;
  radius: number;
  azimuth: number;
  polar: number;
  targetX: number;
  targetY: number;
  targetZ: number;
  layout?: string;
  /** Legacy (<= 1.17): session ids, only valid while the note text is unchanged. */
  focusId?: string | null;
  collapsed?: string[];
  /** 2.0: node path of the entered branch. */
  focusPath?: string | null;
  camera?: {
    position: [number, number, number];
    quaternion: [number, number, number, number];
    pivot: [number, number, number];
    fov: number;
  };
  updatedAt?: number;
}

/** Anchored (user-placed) positions: layout id -> node path -> [x, y, z]. */
export type StoredAnchors = Record<string, Record<string, [number, number, number]>>;

export interface PluginData {
  schemaVersion: number;
  settings: Settings;
  poses: Record<string, StoredPose>;
  links: Record<string, StoredAssociation[]>;
  /** Manually marked key concepts (called "pins" in 1.x data). */
  pins: Record<string, StoredMark[]>;
  /** Per-node size multipliers relative to the global node scale (2.0 semantics). */
  sizes: Record<string, Record<string, number>>;
  anchors: Record<string, StoredAnchors>;
  /** Collapsed nodes by node path. */
  collapsed: Record<string, string[]>;
}
