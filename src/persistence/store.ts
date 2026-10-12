// Plugin data store: loads/migrates data.json, exposes per-note accessors and
// saves with a short debounce. `flush()` is awaited on unload so the last
// change is never lost (1.17 left a pending timer behind on unload).
import { migrateData, type MigrationReport } from './migrate';
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from './settings';
import { SCHEMA_VERSION, type PluginData, type StoredAnchors, type StoredPose } from './schema';
import { replaceRoot, PATH_SEPARATOR, type StoredAssociation, type StoredMark } from '../model/node-paths';

export interface DataIO {
  load(): Promise<unknown>;
  save(data: PluginData): Promise<void>;
}

export const normalizeKey = (path: string): string => path.replace(/\\/g, '/');

export class PluginStore {
  private data: PluginData = {
    schemaVersion: SCHEMA_VERSION, settings: { ...DEFAULT_SETTINGS }, poses: {}, links: {}, pins: {}, sizes: {}, anchors: {}, collapsed: {},
  };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;
  private saving: Promise<void> = Promise.resolve();
  lastMigration: MigrationReport | null = null;

  constructor(private readonly io: DataIO, private readonly delayMs = 600) {}

  async load(): Promise<Settings> {
    const raw = await this.io.load();
    const { data, report } = migrateData(raw);
    this.data = data;
    this.lastMigration = report;
    this.loaded = true;
    if (raw && report.from !== report.to) this.scheduleSave(0);
    return this.data.settings;
  }

  get settings(): Settings { return this.data.settings; }
  get snapshot(): PluginData { return this.data; }

  updateSettings(patch: Partial<Settings>): Settings {
    this.data.settings = normalizeSettings({ ...this.data.settings, ...patch });
    this.scheduleSave();
    return this.data.settings;
  }

  // --- per-note maps ---------------------------------------------------------
  private setOrDelete<T>(map: Record<string, T>, file: string, value: T, empty: boolean): void {
    const key = normalizeKey(file);
    if (empty) delete map[key]; else map[key] = value;
    this.scheduleSave();
  }

  getLinks(file: string): StoredAssociation[] { return this.data.links[normalizeKey(file)] ?? []; }
  setLinks(file: string, links: StoredAssociation[]): void { this.setOrDelete(this.data.links, file, links, !links.length); }

  getMarks(file: string): StoredMark[] { return this.data.pins[normalizeKey(file)] ?? []; }
  setMarks(file: string, marks: StoredMark[]): void { this.setOrDelete(this.data.pins, file, marks, !marks.length); }

  getSizes(file: string): Record<string, number> { return this.data.sizes[normalizeKey(file)] ?? {}; }
  setNodeSize(file: string, path: string, multiplier: number | null): void {
    const key = normalizeKey(file);
    const sizes = { ...(this.data.sizes[key] ?? {}) };
    if (multiplier === null || !Number.isFinite(multiplier) || Math.abs(multiplier - 1) < 1e-6) delete sizes[path];
    else sizes[path] = Math.round(multiplier * 1000) / 1000;
    this.setOrDelete(this.data.sizes, file, sizes, !Object.keys(sizes).length);
  }

  getAnchors(file: string, layout: string): Record<string, [number, number, number]> {
    return this.data.anchors[normalizeKey(file)]?.[layout] ?? {};
  }
  setAnchor(file: string, layout: string, path: string, position: [number, number, number] | null): void {
    const key = normalizeKey(file);
    const all: StoredAnchors = { ...(this.data.anchors[key] ?? {}) };
    const nodes = { ...(all[layout] ?? {}) };
    if (position) nodes[path] = position.map(v => Math.round(v * 100) / 100) as [number, number, number];
    else delete nodes[path];
    if (Object.keys(nodes).length) all[layout] = nodes; else delete all[layout];
    this.setOrDelete(this.data.anchors, file, all, !Object.keys(all).length);
  }
  clearAnchors(file: string, layout: string): void {
    const key = normalizeKey(file);
    const all = { ...(this.data.anchors[key] ?? {}) };
    delete all[layout];
    this.setOrDelete(this.data.anchors, file, all, !Object.keys(all).length);
  }

  getCollapsed(file: string): string[] { return this.data.collapsed[normalizeKey(file)] ?? []; }
  setCollapsed(file: string, paths: string[]): void { this.setOrDelete(this.data.collapsed, file, paths, !paths.length); }

  getPose(file: string): StoredPose | undefined {
    const key = normalizeKey(file);
    return this.data.poses[key] ?? this.data.poses[key.toLowerCase()];
  }
  setPose(file: string, pose: StoredPose): void { this.data.poses[normalizeKey(file)] = pose; this.scheduleSave(); }

  /**
   * Rewrite saved node paths after renames inside a note (old path -> new
   * path). Prefix matches cover descendants of a renamed node.
   */
  renamePaths(file: string, renames: Map<string, string>): number {
    if (!renames.size) return 0;
    const key = normalizeKey(file);
    let changed = 0;
    const map = (path: string): string => {
      const direct = renames.get(path);
      if (direct !== undefined) { changed++; return direct; }
      // Descendant of a renamed node: longest matching ancestor prefix wins.
      let best: [string, string] | null = null;
      for (const [from, to] of renames) {
        if (path.startsWith(from + PATH_SEPARATOR) && (!best || from.length > best[0].length)) best = [from, to];
      }
      if (best) { changed++; return best[1] + path.slice(best[0].length); }
      return path;
    };
    this.rewritePaths(key, map);
    if (changed) this.scheduleSave();
    return changed;
  }

  private rewritePaths(key: string, map: (path: string) => string): void {
    const sizes = this.data.sizes[key];
    if (sizes) this.data.sizes[key] = Object.fromEntries(Object.entries(sizes).map(([p, v]) => [map(p), v]));
    const marks = this.data.pins[key];
    if (marks) this.data.pins[key] = marks.map(m => ({ ...m, path: map(m.path) }));
    const links = this.data.links[key];
    if (links) this.data.links[key] = links.map(l => ({ ...l, aPath: map(l.aPath), bPath: map(l.bPath) }));
    const anchors = this.data.anchors[key];
    if (anchors) {
      this.data.anchors[key] = Object.fromEntries(Object.entries(anchors).map(([layout, nodes]) =>
        [layout, Object.fromEntries(Object.entries(nodes).map(([p, v]) => [map(p), v]))]));
    }
    const collapsed = this.data.collapsed[key];
    if (collapsed) this.data.collapsed[key] = collapsed.map(map);
    const pose = this.data.poses[key];
    if (pose?.focusPath) pose.focusPath = map(pose.focusPath);
  }

  /** A note file was renamed or moved: move its data and update root segments. */
  renameFile(oldPath: string, newPath: string, newBasename: string): void {
    const from = normalizeKey(oldPath), to = normalizeKey(newPath);
    if (from === to) return;
    for (const map of [this.data.poses, this.data.links, this.data.pins, this.data.sizes, this.data.anchors, this.data.collapsed] as Record<string, unknown>[]) {
      if (from in map) { map[to] = map[from]; delete map[from]; }
    }
    this.rewritePaths(to, path => replaceRoot(path, newBasename.trim()));
    this.scheduleSave();
  }

  forgetFile(path: string): void {
    const key = normalizeKey(path);
    for (const map of [this.data.poses, this.data.links, this.data.pins, this.data.sizes, this.data.anchors, this.data.collapsed] as Record<string, unknown>[]) delete map[key];
    this.scheduleSave();
  }

  scheduleSave(delay = this.delayMs): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, delay);
  }

  /** Write now (also cancels a pending debounce). Serialised so writes never interleave. */
  async flush(): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (!this.loaded) return;
    const snapshot = JSON.parse(JSON.stringify(this.data)) as PluginData;
    this.saving = this.saving.then(() => this.io.save(snapshot)).catch(error => console.error('[3D Mind Map] save failed', error));
    await this.saving;
  }
}
