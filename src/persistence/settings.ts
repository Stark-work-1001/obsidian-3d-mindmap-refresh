// Plugin settings: defaults, value ranges and normalisation of untrusted
// stored data. Every key that 1.15-1.17 stored is still accepted so existing
// data.json files load unchanged; new keys get defaults.
import { RULE_MODES, type GroupRule, type MatchRule, type RuleMode } from '../model/rules';
import { LAYOUT_IDS, type LayoutId } from '../layout/catalog';

export type LinkStyle = 'solid' | 'dashed' | 'dotted' | 'dashdot';
export const LINK_STYLES: LinkStyle[] = ['solid', 'dashed', 'dotted', 'dashdot'];
export const LINK_STYLE_PATTERNS: Record<LinkStyle, { period: number; on: number; on2?: number }> = {
  solid: { period: 1, on: 1 },
  dashed: { period: 26, on: 16 },
  dotted: { period: 11, on: 2.6 },
  dashdot: { period: 34, on: 16, on2: 3 },
};

/** free = pivot travels with panning; selected = selected node; root = graph centre. */
export type OrbitCenter = 'free' | 'root' | 'selected';
export const ORBIT_CENTERS: OrbitCenter[] = ['free', 'root', 'selected'];
export type RotationStyle = 'turntable' | 'trackball';
export type BackgroundMode = 'theme' | 'solid' | 'gradient';
export type NodeColorMode = 'depth' | 'hash' | 'single';
export type MotionPreference = 'system' | 'reduce' | 'full';
export type AnimatedBackground = 'off' | 'subtle';

export interface Settings {
  layout: LayoutId;
  nodeScale: number;
  sizeByHierarchy: boolean;
  linkOpacity: number;
  showLabels: boolean;
  labelDistance: number;
  maxLabels: number;
  labelAvoid: boolean;
  animate: boolean;
  enableFormula: boolean;
  syncDebounceMs: number;
  noteFormat: 'blockquote' | 'comment';
  chargeStrength: number;
  /** Legacy centre-to-centre spring length, kept in sync with edgeGap for older versions. */
  linkDistance: number;
  /** Visible gap between the surfaces of a parent and child sphere. */
  edgeGap: number;
  collapseDepth: number;
  maxHeadingLevel: number;
  rootAsTitlePlate: boolean;
  linkLevel1: boolean;
  coreNameStripSuffix: boolean;
  autoFocusOnOpen: boolean;
  enablePngExport: boolean;
  logLevel: 'none' | 'info' | 'debug';
  themeFollowsObsidian: boolean;
  nodeColorMode: NodeColorMode;
  nodeColor: string;
  linkWidth: number;
  linkStyle: LinkStyle;
  assocStyle: LinkStyle;
  assocColor: string;
  linkColor: string;
  assocCurve: boolean;
  assocBulge: number;
  showAssociations: boolean;
  showNoteLinks: boolean;
  edgeDirection: boolean;
  glowStrength: number;
  bloomStrength: number;
  bgMode: BackgroundMode;
  bgTop: string;
  bgBottom: string;
  animatedBackground: AnimatedBackground;
  pinRules: MatchRule[];
  groupRules: GroupRule[];
  showNoteOnHover: boolean;
  hoverNoteDelayMs: number;
  orbitCenter: OrbitCenter;
  rotationStyle: RotationStyle;
  zoomToCursor: boolean;
  fieldOfView: number;
  cameraSmoothingMs: number;
  motion: MotionPreference;
  learningPath: boolean;
  showInspector: boolean;
}

export const NODE_SCALE_MIN = 0.1;
export const NODE_SCALE_MAX = 6;
export const NODE_SCALE_PRESETS = [0.2, 0.4, 0.7, 1, 1.5, 2.4, 3.5, 6];
export const NODE_SCALE_STEP = 1.15;
export const EDGE_GAP_MIN = 4;
export const EDGE_GAP_MAX = 1200;
export const LINK_DISTANCE_MIN = 20;
export const LINK_DISTANCE_MAX = 1200;
/** Approximate diameter sum of two default spheres; converts legacy link distance to a gap. */
export const LEGACY_RADIUS_ALLOWANCE = 13;
export const FOV_MIN = 20;
export const FOV_MAX = 75;
export const DEFAULT_LINK_COLOR = '#8a8a8a';

export const DEFAULT_SETTINGS: Settings = {
  layout: 'force',
  nodeScale: 1,
  sizeByHierarchy: true,
  linkOpacity: 0.42,
  showLabels: true,
  labelDistance: 2600,
  maxLabels: 160,
  labelAvoid: true,
  animate: true,
  enableFormula: true,
  syncDebounceMs: 150,
  noteFormat: 'blockquote',
  chargeStrength: -260,
  linkDistance: 62,
  edgeGap: 49,
  collapseDepth: 0,
  maxHeadingLevel: 6,
  rootAsTitlePlate: true,
  linkLevel1: true,
  coreNameStripSuffix: false,
  autoFocusOnOpen: false,
  enablePngExport: true,
  logLevel: 'none',
  themeFollowsObsidian: true,
  nodeColorMode: 'depth',
  nodeColor: '#1c7ed6',
  linkWidth: 2.4,
  linkStyle: 'solid',
  assocStyle: 'dashdot',
  assocColor: '#e8a33d',
  linkColor: '',
  assocCurve: true,
  assocBulge: 0.22,
  showAssociations: true,
  showNoteLinks: true,
  edgeDirection: true,
  glowStrength: 1,
  bloomStrength: 0,
  bgMode: 'theme',
  bgTop: '#ffffff',
  bgBottom: '#d7dde5',
  animatedBackground: 'off',
  pinRules: [],
  groupRules: [],
  showNoteOnHover: true,
  hoverNoteDelayMs: 220,
  orbitCenter: 'free',
  rotationStyle: 'turntable',
  zoomToCursor: true,
  fieldOfView: 52,
  cameraSmoothingMs: 90,
  motion: 'system',
  learningPath: true,
  showInspector: true,
};

const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/;
export function isColor(value: unknown): value is string {
  return typeof value === 'string' && COLOR_RE.test(value.trim());
}
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  (typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback);

function normalizeRuleBase(raw: Record<string, unknown>, index: number, count: number, prefix: string): MatchRule | null {
  if (typeof raw.pattern !== 'string' || !raw.pattern.trim()) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `${prefix}-${index}-${count}`,
    pattern: raw.pattern.slice(0, 200),
    mode: oneOf<RuleMode>(raw.mode, RULE_MODES, 'contains'),
    depthMax: typeof raw.depthMax === 'number' && raw.depthMax >= 0 ? Math.min(12, Math.round(raw.depthMax)) : null,
    requireNote: raw.requireNote === true,
    requireTaskDone: raw.requireTaskDone === true,
    enabled: raw.enabled !== false,
  };
}

export function normalizePinRules(value: unknown): MatchRule[] {
  if (!Array.isArray(value)) return [];
  const rules: MatchRule[] = [];
  value.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const rule = normalizeRuleBase(raw as Record<string, unknown>, index, rules.length, 'rule');
    if (rule) rules.push(rule);
  });
  return rules.slice(0, 32);
}

export function normalizeGroupRules(value: unknown): GroupRule[] {
  if (!Array.isArray(value)) return [];
  const rules: GroupRule[] = [];
  value.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const record = raw as Record<string, unknown>;
    const base = normalizeRuleBase(record, index, rules.length, 'group');
    if (!base) return;
    const color = isColor(record.color) ? record.color.trim() : '';
    const hide = record.hide === true;
    if (color || hide) rules.push({ ...base, color, hide });
  });
  return rules.slice(0, 32);
}

/** Accept any stored object and return complete, range-checked settings. */
export function normalizeSettings(raw: unknown): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS, pinRules: [], groupRules: [] };
  if (!raw || typeof raw !== 'object') return s;
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (typeof value === typeof DEFAULT_SETTINGS[key]) (s as unknown as Record<string, unknown>)[key] = value;
  }
  s.layout = oneOf<LayoutId>(s.layout, LAYOUT_IDS, 'force');
  s.noteFormat = oneOf(s.noteFormat, ['blockquote', 'comment'] as const, 'blockquote');
  s.nodeColorMode = oneOf<NodeColorMode>(s.nodeColorMode, ['depth', 'hash', 'single'], 'depth');
  s.linkStyle = oneOf(s.linkStyle, LINK_STYLES, 'solid');
  s.assocStyle = oneOf(s.assocStyle, LINK_STYLES, 'dashdot');
  s.orbitCenter = oneOf(s.orbitCenter, ORBIT_CENTERS, 'free');
  s.rotationStyle = oneOf<RotationStyle>(s.rotationStyle, ['turntable', 'trackball'], 'turntable');
  s.bgMode = oneOf<BackgroundMode>(s.bgMode, ['theme', 'solid', 'gradient'], 'theme');
  s.motion = oneOf<MotionPreference>(s.motion, ['system', 'reduce', 'full'], 'system');
  s.animatedBackground = oneOf<AnimatedBackground>(s.animatedBackground, ['off', 'subtle'], 'off');
  s.logLevel = oneOf(s.logLevel, ['none', 'info', 'debug'] as const, 'none');
  s.glowStrength = clamp(Number(s.glowStrength) || 0, 0, 4);
  s.bloomStrength = clamp(Number(s.bloomStrength) || 0, 0, 1.6);
  s.maxHeadingLevel = clamp(Math.round(s.maxHeadingLevel) || 6, 1, 6);
  s.assocBulge = clamp(s.assocBulge, 0.05, 0.6);
  s.pinRules = normalizePinRules(input.pinRules);
  s.groupRules = normalizeGroupRules(input.groupRules);
  for (const key of ['bgTop', 'bgBottom', 'assocColor', 'nodeColor'] as const) {
    if (!isColor(s[key])) s[key] = DEFAULT_SETTINGS[key];
  }
  if (typeof s.linkColor !== 'string' || (s.linkColor.trim() !== '' && !isColor(s.linkColor))) s.linkColor = '';
  s.nodeScale = clamp(s.nodeScale || 1, NODE_SCALE_MIN, NODE_SCALE_MAX);
  s.linkWidth = clamp(s.linkWidth, 0.2, 14);
  s.linkOpacity = clamp(s.linkOpacity, 0, 1);
  s.linkDistance = clamp(Math.round(s.linkDistance), LINK_DISTANCE_MIN, LINK_DISTANCE_MAX);
  // edgeGap is new in 2.0: derive it from the legacy centre distance when absent.
  if (typeof input.edgeGap !== 'number' || !Number.isFinite(input.edgeGap)) s.edgeGap = s.linkDistance - LEGACY_RADIUS_ALLOWANCE;
  s.edgeGap = clamp(Math.round(s.edgeGap), EDGE_GAP_MIN, EDGE_GAP_MAX);
  s.linkDistance = clamp(s.edgeGap + LEGACY_RADIUS_ALLOWANCE, LINK_DISTANCE_MIN, LINK_DISTANCE_MAX);
  s.chargeStrength = clamp(s.chargeStrength, -600, -40);
  s.syncDebounceMs = clamp(Math.round(s.syncDebounceMs), 0, 2000);
  s.maxLabels = clamp(Math.round(s.maxLabels), 20, 600);
  s.labelDistance = clamp(s.labelDistance, 400, 20000);
  s.hoverNoteDelayMs = clamp(Math.round(s.hoverNoteDelayMs), 0, 2000);
  s.fieldOfView = clamp(s.fieldOfView, FOV_MIN, FOV_MAX);
  s.cameraSmoothingMs = clamp(s.cameraSmoothingMs, 0, 600);
  return s;
}
