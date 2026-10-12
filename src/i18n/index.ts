// Interface-string lookup. All project-owned text shown to users lives in
// en.ts under stable keys; code refers to keys, never to display text, so no
// behaviour depends on how a label is worded or translated.
import { en, type StringKey } from './en';

export type { StringKey };
export type StringParams = Record<string, string | number>;

const catalog: Record<StringKey, string> = en;

/** Resolve a string and substitute `{name}` placeholders. */
/** Dates in the interface language (English), independent of the system locale. */
export function formatDate(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function t(key: StringKey, params?: StringParams): string {
  const template = catalog[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
}

/** Pluralise with a `one`/`other` pair of keys. */
export function tn(count: number, one: StringKey, other: StringKey, params?: StringParams): string {
  return t(count === 1 ? one : other, { count, ...params });
}

export function hasString(key: string): key is StringKey {
  return Object.prototype.hasOwnProperty.call(catalog, key);
}
