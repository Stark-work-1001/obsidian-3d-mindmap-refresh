// Colour helpers: node palette, CSS colour parsing and contrast decisions for
// labels and emphasis on light, dark, solid and gradient backgrounds.

/** Depth palette (1.x values), chosen for distinguishable hues on both themes. */
export const DEPTH_PALETTE = [0x6f42c1, 0x2f9e44, 0x1c7ed6, 0xe8590c, 0xc2255c, 0x0b7285, 0x9a6700, 0x5f3dc4, 0x2b8a3e, 0x1971c2, 0xd9480f, 0xa61e4d];

export type NodeColorMode = 'depth' | 'hash' | 'single';

export function parseHex(color: string, fallback: number): number {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(color.trim());
  if (!m) return fallback;
  const hex = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
  return parseInt(hex, 16);
}

/** Node colour: by outline depth, by a hash of the node text (same text, same colour), or single. */
export function nodeColor(ring: number, text: string, mode: NodeColorMode, single: string): number {
  if (mode === 'single') return parseHex(single, 0x1c7ed6);
  if (mode === 'hash') {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    return DEPTH_PALETTE[h % DEPTH_PALETTE.length];
  }
  return DEPTH_PALETTE[Math.max(0, ring - 1) % DEPTH_PALETTE.length];
}

const NAMED: Record<string, string> = { white: '#ffffff', black: '#000000', gray: '#808080', grey: '#808080', red: '#ff0000', green: '#008000', blue: '#0000ff' };

/** RGB 0-255 from #rgb/#rrggbb/#rrggbbaa or a few names; mid-grey otherwise. */
export function rgb(color: string): [number, number, number] {
  const value = (NAMED[color.trim().toLowerCase()] ?? color).trim().replace('#', '');
  if (/^[0-9a-f]{3}$/i.test(value)) return [0, 1, 2].map(i => parseInt(value[i] + value[i], 16)) as [number, number, number];
  if (/^[0-9a-f]{6,8}$/i.test(value)) return [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16)) as [number, number, number];
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(color.trim());
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return [128, 128, 128];
}

/** WCAG relative luminance (0-1). */
export function luminance(color: string): number {
  const [r, g, b] = rgb(color).map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function mix(a: string, b: string, t = 0.5): string {
  const ca = rgb(a), cb = rgb(b);
  const h = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  return `#${h(ca[0] + (cb[0] - ca[0]) * t)}${h(ca[1] + (cb[1] - ca[1]) * t)}${h(ca[2] + (cb[2] - ca[2]) * t)}`;
}

export interface BackgroundSpec { mode: 'theme' | 'solid' | 'gradient'; top: string; bottom: string; theme: string }

/** The colour labels and emphasis are judged against (gradient: its midpoint). */
export function effectiveBackground(spec: BackgroundSpec): string {
  return spec.mode === 'solid' ? spec.top : spec.mode === 'gradient' ? mix(spec.top, spec.bottom) : spec.theme;
}

export function isLight(color: string): boolean { return luminance(color) > 0.4; }

/** Text colour with at least 4.5:1 contrast on the given background. */
export function readableText(background: string): string {
  return contrastRatio('#1f2328', background) >= contrastRatio('#f6f8fa', background) ? '#1f2328' : '#f6f8fa';
}
