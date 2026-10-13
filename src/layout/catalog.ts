// Layout catalogue: stable ids (stored in settings and poses), purpose
// categories and string keys. Ids never change; display names live in i18n.
import type { StringKey } from '../i18n';

export const LAYOUT_IDS = [
  'knowledge', 'bookshelf', 'journey',
  'tree', 'radial', 'cone',
  'force',
  'bond', 'pennate', 'rdf', 'shell', 'orbital', 'coil', 'lattice', 'disk', 'rays', 'slabs', 'curtain',
  'dandelion', 'nebula', 'grid', 'scatter', 'hub',
] as const;
export type LayoutId = (typeof LAYOUT_IDS)[number];

/**
 * study: reading and reviewing a note in a purposeful order.
 * structure: parent-child relationships are the primary reading.
 * explore: force simulation, for discovering how associations pull nodes.
 * experimental: visual motifs kept for those who like them; they place
 * nodes by shape, not by meaning, and are listed in a separate submenu.
 */
export type LayoutCategory = 'study' | 'structure' | 'explore' | 'experimental';

export interface LayoutInfo {
  id: LayoutId;
  category: LayoutCategory;
  name: StringKey;
  hint: StringKey;
  /** Uses the physics engine (Rust/WASM worker, JavaScript fallback). */
  physics: boolean;
  /** Suggested camera elevation in radians above the horizon for overviews. */
  viewElevation: number;
}

const info = (id: LayoutId, category: LayoutCategory, viewElevation = 0.55, physics = false): LayoutInfo =>
  ({ id, category, name: `layout.${id}.name` as StringKey, hint: `layout.${id}.hint` as StringKey, physics, viewElevation });

export const LAYOUTS: LayoutInfo[] = [
  info('knowledge', 'study', 0.62),
  info('bookshelf', 'study', 0.12),
  info('journey', 'study', 0.95),
  info('tree', 'structure', 0.3),
  info('radial', 'structure', 1.1),
  info('cone', 'structure', 0.4),
  info('force', 'explore', 0.45, true),
  ...(['bond', 'pennate', 'rdf', 'shell', 'orbital', 'coil', 'lattice', 'disk', 'rays', 'slabs', 'curtain',
    'dandelion', 'nebula', 'grid', 'scatter', 'hub'] as const).map(id => info(id, 'experimental')),
];

export const LAYOUT_BY_ID = new Map(LAYOUTS.map(l => [l.id, l]));
export const CATEGORY_ORDER: LayoutCategory[] = ['study', 'structure', 'explore', 'experimental'];

export function layoutInfo(id: string): LayoutInfo {
  return LAYOUT_BY_ID.get(id as LayoutId) ?? LAYOUT_BY_ID.get('force')!;
}
