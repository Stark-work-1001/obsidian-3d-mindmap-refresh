// Emphasis, fading and label priority derived from the view state.
//
// Every state has its own visual channel so they stay distinguishable when
// they coincide: the selected node has a rim and the strongest emission;
// search hits, key concepts and the hovered node use graded emission and a
// label state (CSS); nodes outside an entered branch or a search are moved
// to the faded batch. No extra geometry is added for any of it.
import { EMPHASIS } from '../render/node-layer';
import { LABEL_STATE, LABEL_TIER } from '../render/labels';

export interface EmphasisInput {
  count: number;
  /** Index of each node's parent in the same arrays, -1 for top-level nodes. */
  parent: Int32Array;
  depth: Int32Array;
  selected: number;
  hovered: number;
  /** Nodes of the entered branch (1) or null when the whole map is in focus. */
  focus: Uint8Array | null;
  /** Search hits (1) or null when no search is active. */
  hits: Uint8Array | null;
  currentHit: number;
  marks: Uint8Array;
  /** Nodes related to the selection through associations or note links. */
  related: Uint8Array | null;
  connectSource: number;
}

export interface EmphasisOutput {
  level: Float32Array;
  rim: Uint8Array;
  dimmed: Uint8Array;
  tiers: Uint8Array;
  states: Uint8Array;
  /** 1 for nodes on the path from a top-level node down to the selection. */
  path: Uint8Array;
}

export function computeEmphasis(input: EmphasisInput): EmphasisOutput {
  const n = input.count;
  const level = new Float32Array(n), rim = new Uint8Array(n), dimmed = new Uint8Array(n);
  const tiers = new Uint8Array(n), states = new Uint8Array(n), path = new Uint8Array(n);
  const searching = !!input.hits && input.hits.some(v => v === 1);

  // Ancestors of the selection (the "where am I" path) and its direct children.
  const children = new Uint8Array(n);
  if (input.selected >= 0 && input.selected < n) {
    for (let k = input.selected, guard = 0; k >= 0 && guard <= n; k = input.parent[k], guard++) path[k] = 1;
    for (let i = 0; i < n; i++) if (input.parent[i] === input.selected) children[i] = 1;
  }

  for (let i = 0; i < n; i++) {
    let tier: number = input.depth[i] === 0 ? LABEL_TIER.chapter : input.depth[i] === 1 ? LABEL_TIER.topic : LABEL_TIER.normal;
    let lv: number = EMPHASIS.none;
    let state: number = LABEL_STATE.none;
    if (path[i]) { lv = EMPHASIS.path; tier = Math.min(tier, LABEL_TIER.related); }
    if (children[i] || input.related?.[i]) { tier = Math.min(tier, LABEL_TIER.related); if (input.related?.[i]) state = LABEL_STATE.related; }
    if (input.marks[i]) { lv = Math.max(lv, EMPHASIS.mark); tier = Math.min(tier, LABEL_TIER.important); state = LABEL_STATE.mark; }
    if (i === input.hovered) { lv = Math.max(lv, EMPHASIS.hover); tier = LABEL_TIER.selected; state = LABEL_STATE.hover; }
    if (input.hits?.[i]) { lv = Math.max(lv, EMPHASIS.search); tier = Math.min(tier, LABEL_TIER.important); state = LABEL_STATE.search; }
    if (i === input.currentHit) { tier = LABEL_TIER.selected; state = LABEL_STATE.searchCurrent; }
    if (i === input.connectSource) { lv = Math.max(lv, EMPHASIS.search); tier = LABEL_TIER.selected; state = LABEL_STATE.connect; }
    if (i === input.selected) { lv = EMPHASIS.selected; rim[i] = 1; tier = LABEL_TIER.selected; state = LABEL_STATE.selected; }

    const outsideFocus = !!input.focus && !input.focus[i];
    const notAHit = searching && !input.hits![i];
    if ((outsideFocus || notAHit) && i !== input.selected && i !== input.connectSource) {
      dimmed[i] = 1;
      if (tier > LABEL_TIER.important) tier = LABEL_TIER.outOfFocus;
    }
    level[i] = lv;
    tiers[i] = tier;
    states[i] = state;
  }
  return { level, rim, dimmed, tiers, states, path };
}

/** Indices of `root` and all its descendants, using parent links. */
export function subtreeMask(parent: Int32Array, root: number): Uint8Array {
  const n = parent.length;
  const mask = new Uint8Array(n);
  if (root < 0 || root >= n) return mask;
  mask[root] = 1;
  // Parents always precede their children in document order, so one pass suffices.
  for (let i = 0; i < n; i++) if (!mask[i] && parent[i] >= 0 && mask[parent[i]]) mask[i] = 1;
  return mask;
}
