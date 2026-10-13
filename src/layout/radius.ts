// The single effective-radius model. Rendering (instance scale), picking
// (ray-sphere), layout spacing, physics collisions and camera framing all use
// the value computed here, so what you see is what collides and what you click.
//
//   effective = hierarchySize(ring, content) x globalScale x nodeMultiplier
//
// hierarchySize keeps the 1.x formula (deeper = smaller, notes/formulas and
// many children slightly larger). globalScale is the "Node size" setting;
// nodeMultiplier is a per-node emphasis stored relative to the global scale,
// so changing the global scale keeps every override's relative meaning.

export interface RadiusInputs {
  ring: number;
  hasNote: boolean;
  hasFormula: boolean;
  childCount: number;
}

export const UNIFORM_BASE_RADIUS = 6;

export function hierarchySize(input: RadiusInputs, byHierarchy = true): number {
  const base = byHierarchy ? Math.max(2.6, 9 - input.ring * 1.15) : UNIFORM_BASE_RADIUS;
  const content = (input.hasNote ? 1.08 : 1) * (input.hasFormula ? 1.04 : 1);
  const branching = 1 + Math.min(0.5, Math.log2(1 + input.childCount) * 0.1);
  return base * content * branching;
}

export function effectiveRadius(input: RadiusInputs, globalScale: number, multiplier = 1, byHierarchy = true): number {
  const r = hierarchySize(input, byHierarchy) * globalScale * (Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1);
  return Math.min(300, Math.max(0.1, r));
}
