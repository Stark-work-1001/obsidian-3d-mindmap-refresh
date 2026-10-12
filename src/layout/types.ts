// Layout data contracts. Layout functions receive nodes in document
// (pre-order) order and write x, y, z. They never read or write the note.

export interface Vec3 { x: number; y: number; z: number }

export interface LayoutNode extends Vec3 {
  id: string;
  /** Parent among the *visible* nodes, or null for a top-level node. */
  parentId: string | null;
  /** Depth relative to the visible top level (0 = chapter). */
  depth: number;
  /** Outline ring (absolute level in the note) used for sizing. */
  ring: number;
  /** Position in document reading order (0-based, visible nodes only). */
  order: number;
  childCount: number;
  /** Effective sphere radius (see radius.ts); identical everywhere. */
  radius: number;
  /** User-placed position for the current layout, if any. */
  anchor: Vec3 | null;
}

export interface LayoutOptions {
  /** Visible gap between the surfaces of a parent and a child sphere. */
  gap: number;
  /** Extra clearance used by separation (fraction of the radius sum). */
  clearance: number;
}

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = { gap: 49, clearance: 0.12 };

/**
 * Chapter-level placements remembered between runs for spatial stability.
 * `radius` is the cluster size when it was placed: an unchanged chapter is
 * held in place, a chapter that grew or is new moves to make room.
 */
export type ArrangementMemory = Map<string, Vec3 & { radius?: number }>;

export interface LayoutResult {
  /** Optional guide polyline (e.g. reading order in the learning journey). */
  guide?: Vec3[];
  /** Chapter centres used, for arrangement memory. */
  chapters?: ArrangementMemory;
}

export type LayoutFunction = (nodes: LayoutNode[], options: LayoutOptions, memory?: ArrangementMemory) => LayoutResult | void;
