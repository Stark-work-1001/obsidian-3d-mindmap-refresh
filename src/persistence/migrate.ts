// data.json migrations. Pure functions: given whatever was stored (possibly
// written by 1.15-1.17, possibly hand-edited or truncated) return a complete
// PluginData of the current schema. Unknown keys are dropped only inside the
// known maps; nothing is ever deleted from user maps because it looks odd.
import { normalizeSettings, NODE_SCALE_MAX, NODE_SCALE_MIN } from './settings';
import { SCHEMA_VERSION, type PluginData, type StoredPose } from './schema';
import type { StoredAssociation, StoredMark } from '../model/node-paths';

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function normalizePose(raw: unknown): StoredPose | null {
  if (!isRecord(raw)) return null;
  const pose: StoredPose = {
    v: finite(raw.v, 1),
    radius: Math.max(1, finite(raw.radius, 620)),
    azimuth: finite(raw.azimuth, Math.PI / 4),
    polar: Math.min(Math.PI - 0.01, Math.max(0.01, finite(raw.polar, Math.PI / 2.55))),
    targetX: finite(raw.targetX), targetY: finite(raw.targetY), targetZ: finite(raw.targetZ),
  };
  if (typeof raw.layout === 'string') pose.layout = raw.layout;
  if (typeof raw.focusId === 'string') pose.focusId = raw.focusId;
  if (typeof raw.focusPath === 'string') pose.focusPath = raw.focusPath;
  if (Array.isArray(raw.collapsed)) pose.collapsed = raw.collapsed.filter((x): x is string => typeof x === 'string');
  if (typeof raw.updatedAt === 'number') pose.updatedAt = raw.updatedAt;
  if (isRecord(raw.camera)) {
    const c = raw.camera;
    const vec = (v: unknown, n: number) => (Array.isArray(v) && v.length === n && v.every(x => typeof x === 'number' && Number.isFinite(x)) ? v : null);
    const position = vec(c.position, 3), quaternion = vec(c.quaternion, 4), pivot = vec(c.pivot, 3);
    if (position && quaternion && pivot) {
      pose.camera = { position: position as [number, number, number], quaternion: quaternion as [number, number, number, number],
        pivot: pivot as [number, number, number], fov: Math.min(75, Math.max(20, finite(c.fov, 52))) };
    }
  }
  return pose;
}

function normalizeLinks(raw: unknown): StoredAssociation[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).filter(l => typeof l.aPath === 'string' && typeof l.bPath === 'string').map(l => {
    const link: StoredAssociation = {
      aPath: l.aPath as string, bPath: l.bPath as string,
      aText: typeof l.aText === 'string' ? l.aText : '', bText: typeof l.bText === 'string' ? l.bText : '',
      createdAt: finite(l.createdAt),
    };
    if (l.hidden === true) link.hidden = true;
    if (typeof l.label === 'string' && l.label.trim()) link.label = l.label.slice(0, 80);
    return link;
  });
}

function normalizeMarks(raw: unknown): StoredMark[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).filter(m => typeof m.path === 'string')
    .map(m => ({ path: m.path as string, text: typeof m.text === 'string' ? m.text : '', createdAt: finite(m.createdAt) }));
}

function mapRecord<T>(raw: unknown, fn: (value: unknown) => T | null): Record<string, T> {
  const out: Record<string, T> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const mapped = fn(value);
    if (mapped !== null) out[key.replace(/\\/g, '/')] = mapped;
  }
  return out;
}

export interface MigrationReport {
  from: number;
  to: number;
  notes: string[];
}

/**
 * v1 (no schemaVersion, 1.15-1.17) -> v2:
 * - sizes were absolute scales that replaced the global scale; they become
 *   multipliers of the global scale (value / nodeScale), so the current
 *   appearance is preserved exactly and later global changes scale them too.
 * - edgeGap is derived from linkDistance (settings normalisation).
 * - anchors and path-keyed collapsed state start empty; legacy collapsed ids
 *   in poses are converted when the note is next opened unchanged.
 */
export function migrateData(raw: unknown): { data: PluginData; report: MigrationReport } {
  const input = isRecord(raw) ? raw : {};
  const from = typeof input.schemaVersion === 'number' ? input.schemaVersion : 1;
  const report: MigrationReport = { from, to: SCHEMA_VERSION, notes: [] };
  const settings = normalizeSettings(input.settings);
  const data: PluginData = {
    schemaVersion: SCHEMA_VERSION,
    settings,
    poses: mapRecord(input.poses, normalizePose),
    links: mapRecord(input.links, v => { const l = normalizeLinks(v); return l.length ? l : null; }),
    pins: mapRecord(input.pins, v => { const m = normalizeMarks(v); return m.length ? m : null; }),
    sizes: mapRecord(input.sizes, v => {
      if (!isRecord(v)) return null;
      const out: Record<string, number> = {};
      for (const [path, value] of Object.entries(v)) if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[path] = value;
      return Object.keys(out).length ? out : null;
    }),
    anchors: mapRecord(input.anchors, v => {
      if (!isRecord(v)) return null;
      const out: Record<string, Record<string, [number, number, number]>> = {};
      for (const [layout, nodes] of Object.entries(v)) {
        if (!isRecord(nodes)) continue;
        const kept: Record<string, [number, number, number]> = {};
        for (const [path, p] of Object.entries(nodes)) {
          if (Array.isArray(p) && p.length === 3 && p.every(x => typeof x === 'number' && Number.isFinite(x))) kept[path] = p as [number, number, number];
        }
        if (Object.keys(kept).length) out[layout] = kept;
      }
      return Object.keys(out).length ? out : null;
    }),
    collapsed: mapRecord(input.collapsed, v => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null)),
  };
  if (from < 2) {
    let converted = 0;
    for (const sizes of Object.values(data.sizes)) {
      for (const [path, absolute] of Object.entries(sizes)) {
        const multiplier = Math.round((absolute / settings.nodeScale) * 1000) / 1000;
        sizes[path] = Math.min(NODE_SCALE_MAX, Math.max(NODE_SCALE_MIN / NODE_SCALE_MAX, multiplier));
        converted++;
      }
    }
    if (converted) report.notes.push(`converted ${converted} node size overrides to multipliers of the global scale ${settings.nodeScale}`);
  }
  return { data, report };
}
