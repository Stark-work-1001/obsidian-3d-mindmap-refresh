// Plugin entry: data store, view registration, commands and vault events.
// Plugin id, view type and command ids are unchanged from 1.x, so existing
// workspaces, hotkeys and data.json keep working.
import { Notice, Plugin, TFile, normalizePath, type WorkspaceLeaf } from 'obsidian';
import katexCss from 'virtual:katex-css';
import workerSource from 'virtual:physics-worker';
import { t } from './i18n';
import { LAYOUTS } from './layout/catalog';
import { readOutlineClick } from './outline-bridge';
import { PhysicsClient } from './physics/physics-client';
import { WASM_BASE64 } from './physics/generated/wasm-asset';
import { LINK_STYLES, ORBIT_CENTERS, type BackgroundMode, type Settings } from './persistence/settings';
import { PluginStore } from './persistence/store';
import type { PluginData } from './persistence/schema';
import { FormulaCache } from './render/label-format';
import { MindMapSettingTab } from './settings-tab';
import { NotePicker } from './ui/modals';
import { MindMapView, VIEW_TYPE } from './view/mind-map-view';
import type { ViewHost } from './view/view-host';
import type { ViewAction } from './view/view-menus';

/** Command ids from 1.x (hotkeys are bound to these). */
const CMD = {
  OPEN_ACTIVE: '3d-mindmap-open-active',
  OPEN_NEW_LEAF: '3d-mindmap-open-new-leaf',
  TOGGLE_LAYOUT: '3d-mindmap-toggle-layout',
  ADD_CHILD: '3d-mindmap-add-child',
  ADD_SIBLING: '3d-mindmap-add-sibling',
  EDIT_NOTE: '3d-mindmap-edit-note',
  TOGGLE_COLLAPSE: '3d-mindmap-toggle-collapse',
  FOCUS_PARENT: '3d-mindmap-focus-parent',
  EXIT_FOCUS: '3d-mindmap-exit-focus',
  DELETE_NODE: '3d-mindmap-delete-node',
  SEARCH: '3d-mindmap-search',
  RESET_CAMERA: '3d-mindmap-reset-camera',
  EXPORT_PNG: '3d-mindmap-export-png',
  PICK_FILE: '3d-mindmap-pick-file',
  TOGGLE_ASSOC: '3d-mindmap-toggle-assoc',
  NEXT_LINK_STYLE: '3d-mindmap-next-link-style',
  CYCLE_BG: '3d-mindmap-cycle-bg',
  CLEAR_PINS: '3d-mindmap-clear-pins',
  TOGGLE_PIN: '3d-mindmap-toggle-pin',
  BENCH: '3d-mindmap-bench',
  SELFTEST: '3d-mindmap-selftest',
  HEAL: '3d-mindmap-heal',
  CYCLE_ORBIT: '3d-mindmap-cycle-orbit',
  LOCATE_SELECTED: '3d-mindmap-locate-selected',
  // New in 2.0
  OVERVIEW: '3d-mindmap-overview',
  BACK: '3d-mindmap-back',
  FORWARD: '3d-mindmap-forward',
} as const;

const HOVER_SOURCE = 'obsidian-3d-mindmap';
const BACKGROUNDS: BackgroundMode[] = ['theme', 'solid', 'gradient'];

let wasmBytes: Uint8Array | null = null;
function decodeWasm(): ArrayBuffer | null {
  try {
    if (!wasmBytes) {
      const binary = atob(WASM_BASE64);
      wasmBytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) wasmBytes[i] = binary.charCodeAt(i);
    }
    // A copy: the buffer is transferred to the worker.
    return wasmBytes.slice().buffer;
  } catch (error) {
    console.error('[3D Mind Map] WASM decode failed', error);
    return null;
  }
}

export default class MindMapPlugin extends Plugin implements ViewHost {
  store!: PluginStore;
  readonly formulas = new FormulaCache();
  readonly version = typeof __PLUGIN_VERSION__ === 'string' ? __PLUGIN_VERSION__ : '0.0.0';
  private katexStyle: HTMLStyleElement | null = null;
  private settingTab: MindMapSettingTab | null = null;

  get config(): Settings { return this.store.settings; }

  override async onload(): Promise<void> {
    let raw: unknown = null;
    let readable = true;
    try { raw = await this.loadData(); }
    catch (error) { readable = false; console.error('[3D Mind Map] could not read data.json', error); }
    // An unreadable data.json is never overwritten: the store stays read-only.
    this.store = new PluginStore({
      load: async () => (readable ? raw : null),
      save: async (data: PluginData) => { if (readable) await this.saveData(data); },
    });
    await this.store.load();
    if (!readable) new Notice(t('notice.loadFailed'), 10000);
    else await this.backupBeforeMigration(raw);
    this.formulas.enabled = this.config.enableFormula;

    this.registerView(VIEW_TYPE, leaf => new MindMapView(leaf, this));
    this.addRibbonIcon('network', t('plugin.ribbon'), () => void this.activateView('replace'));
    this.settingTab = new MindMapSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.registerCommands();
    this.registerVaultEvents();
    this.registerDomEvent(document, 'click', event => this.onOutlineClick(event), true);
    this.registerHoverLinkSource(HOVER_SOURCE, { display: t('plugin.name'), defaultMod: true });
    this.injectKatexStyles();
  }

  override onunload(): void {
    this.katexStyle?.remove();
    this.katexStyle = null;
    void this.store?.flush();
  }

  /** Keep a copy of 1.x data before its first migration (plugin folder only). */
  private async backupBeforeMigration(raw: unknown): Promise<void> {
    const report = this.store.lastMigration;
    if (!raw || !report || report.from === report.to || !this.manifest.dir) return;
    const path = normalizePath(`${this.manifest.dir}/data.backup-v${report.from}.json`);
    try {
      if (!(await this.app.vault.adapter.exists(path))) {
        await this.app.vault.adapter.write(path, JSON.stringify(raw, null, 2));
        new Notice(t('notice.migrated'), 8000);
      }
    } catch (error) { console.warn('[3D Mind Map] backup failed', error); }
  }

  /** KaTeX styles and fonts are bundled (offline, independent of how the plugin was installed). */
  private injectKatexStyles(): void {
    if (document.getElementById('om3d-katex')) return;
    const style = document.createElement('style');
    style.id = 'om3d-katex';
    style.textContent = katexCss;
    document.head.appendChild(style);
    this.katexStyle = style;
  }

  log(message: string, data?: unknown): void {
    if (this.store?.settings.logLevel === 'none') return;
    if (this.store?.settings.logLevel === 'info' && data !== undefined && !(data instanceof Error)) return;
    console.log(`[3D Mind Map] ${message}`, data ?? '');
  }

  // --- ViewHost --------------------------------------------------------------------------
  createPhysics(onFrame: () => void): PhysicsClient {
    return new PhysicsClient({ workerSource, wasm: decodeWasm, onFrame });
  }

  updateSettings(patch: Partial<Settings>): void {
    const previous = this.store.settings;
    const next = this.store.updateSettings(patch);
    this.formulas.enabled = next.enableFormula;
    for (const view of this.views()) view.applySettings(previous);
  }

  async exportPng(notePath: string, dataUrl: string): Promise<string | null> {
    try {
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const path = normalizePath(`${notePath.replace(/\.md$/i, '') || 'mindmap'}.3d.png`);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, bytes.buffer);
      else await this.app.vault.createBinary(path, bytes.buffer);
      return path;
    } catch (error) {
      new Notice(t('export.failed', { error: error instanceof Error ? error.message : String(error) }));
      return null;
    }
  }

  openSettings(): void {
    // The settings modal has no public API to open a tab; fall back to a hint.
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    try { setting?.open(); setting?.openTabById(this.manifest.id); }
    catch { /* not available */ }
  }

  // --- views ---------------------------------------------------------------------------------
  views(): MindMapView[] {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).map(l => l.view).filter((v): v is MindMapView => v instanceof MindMapView);
  }

  private activeMapView(): MindMapView | null {
    const active = this.app.workspace.getActiveViewOfType(MindMapView);
    if (active) return active;
    const all = this.views();
    return all.length === 1 ? all[0] : null;
  }

  private withView(fn: (view: MindMapView) => void): void {
    const view = this.activeMapView();
    if (view) fn(view); else new Notice(t('notice.noView'));
  }

  async activateView(mode: 'replace' | 'tab'): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') { new Notice(t('notice.noNote')); return; }
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE).find(l => l.view instanceof MindMapView && l.view.currentFile?.path === file.path);
    let leaf: WorkspaceLeaf;
    if (existing && mode === 'replace') leaf = existing;
    else {
      leaf = this.app.workspace.getLeaf(mode === 'tab' ? 'tab' : false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true, state: { file: file.path } });
    }
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    if (leaf.view instanceof MindMapView) leaf.view.focusStage();
  }

  // --- commands ------------------------------------------------------------------------------
  private registerCommands(): void {
    this.addCommand({ id: CMD.OPEN_ACTIVE, name: t('command.openActive'), callback: () => void this.activateView('replace') });
    this.addCommand({ id: CMD.OPEN_NEW_LEAF, name: t('command.openNewLeaf'), hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'm' }], callback: () => void this.activateView('tab') });
    this.addCommand({ id: CMD.TOGGLE_LAYOUT, name: t('command.nextLayout'), callback: () => this.cycleLayout() });
    this.addCommand({ id: CMD.TOGGLE_ASSOC, name: t('command.connectMode'), callback: () => this.withView(v => v.toggleConnectMode()) });
    this.addCommand({ id: CMD.NEXT_LINK_STYLE, name: t('command.nextEdgeStyle'), callback: () => this.cycleEdgeStyle() });
    this.addCommand({ id: CMD.PICK_FILE, name: t('command.pickNote'), callback: () => this.withView(v => new NotePicker(this.app, v.currentFile?.path ?? null, f => void v.bindFile(f)).open()) });
    this.addCommand({ id: CMD.BENCH, name: t('command.diagnostics'), callback: () => this.withView(v => v.runAction('diagnostics')) });
    this.addCommand({ id: CMD.SELFTEST, name: t('command.selfTest'), callback: () => this.withView(v => v.runAction('diagnostics')) });
    this.addCommand({ id: CMD.CYCLE_BG, name: t('command.nextBackground'), callback: () => this.cycleBackground() });
    this.addCommand({ id: CMD.HEAL, name: t('command.reload'), callback: () => this.withView(v => v.runAction('reload')) });
    this.addCommand({ id: CMD.CYCLE_ORBIT, name: t('command.nextOrbit'), callback: () => this.cycleOrbit() });
    this.addCommand({ id: CMD.SEARCH, name: t('command.search'), callback: () => this.withView(v => v.openSearch()) });
    this.addCommand({ id: CMD.FOCUS_PARENT, name: t('command.focusParent'), callback: () => this.withView(v => v.focusParentBranch()) });
    const actions: [string, Parameters<typeof t>[0], ViewAction][] = [
      [CMD.ADD_CHILD, 'command.addChild', 'addChild'],
      [CMD.ADD_SIBLING, 'command.addSibling', 'addSibling'],
      [CMD.EDIT_NOTE, 'command.editNote', 'editNote'],
      [CMD.DELETE_NODE, 'command.delete', 'remove'],
      [CMD.TOGGLE_COLLAPSE, 'command.toggleCollapse', 'toggleCollapse'],
      [CMD.EXIT_FOCUS, 'command.exitFocus', 'upLevel'],
      [CMD.RESET_CAMERA, 'command.resetCamera', 'resetCamera'],
      [CMD.LOCATE_SELECTED, 'command.locate', 'locate'],
      [CMD.EXPORT_PNG, 'command.exportPng', 'exportPng'],
      [CMD.CLEAR_PINS, 'command.clearMarks', 'clearMarks'],
      [CMD.TOGGLE_PIN, 'command.toggleMark', 'toggleMark'],
      [CMD.OVERVIEW, 'command.overview', 'overview'],
    ];
    for (const [id, name, action] of actions) this.addCommand({ id, name: t(name), callback: () => this.withView(v => v.runAction(action)) });
    this.addCommand({ id: CMD.BACK, name: t('command.back'), callback: () => this.withView(v => v.history(-1)) });
    this.addCommand({ id: CMD.FORWARD, name: t('command.forward'), callback: () => this.withView(v => v.history(1)) });
  }

  private cycleLayout(): void {
    const main = LAYOUTS.filter(l => l.category !== 'experimental');
    const index = main.findIndex(l => l.id === this.config.layout);
    const next = main[(index + 1) % main.length];
    this.updateSettings({ layout: next.id });
    new Notice(t('notice.layout', { name: t(next.name) }));
  }

  private cycleEdgeStyle(): void {
    const next = LINK_STYLES[(LINK_STYLES.indexOf(this.config.linkStyle) + 1) % LINK_STYLES.length];
    this.updateSettings({ linkStyle: next });
    new Notice(t('notice.edgeStyle', { name: t(`style.${next}`) }));
  }

  private cycleBackground(): void {
    const next = BACKGROUNDS[(BACKGROUNDS.indexOf(this.config.bgMode) + 1) % BACKGROUNDS.length];
    this.updateSettings({ bgMode: next });
    new Notice(t('notice.background', { name: t(`background.mode.${next}`) }));
  }

  private cycleOrbit(): void {
    const order = ['free', 'selected', 'root'] as const;
    const next = order[(order.indexOf(this.config.orbitCenter) + 1) % order.length];
    if (!ORBIT_CENTERS.includes(next)) return;
    this.updateSettings({ orbitCenter: next });
    new Notice(t('notice.orbit', { name: t(next === 'free' ? 'orbit.free' : next === 'selected' ? 'orbit.selected' : 'orbit.centre') }));
  }

  // --- vault events --------------------------------------------------------------------------
  private registerVaultEvents(): void {
    this.registerEvent(this.app.workspace.on('file-open', file => {
      if (!file || file.extension !== 'md') return;
      // Views follow the active note only until they show one (as in 1.x).
      for (const view of this.views()) if (!view.currentFile) void view.bindFile(file);
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (!(file instanceof TFile)) return;
      this.store.renameFile(oldPath, file.path, file.basename);
      for (const view of this.views()) if (view.currentFile === file) view.fileRenamed(file);
      this.app.workspace.requestSaveLayout();
    }));
    this.registerEvent(this.app.vault.on('delete', file => {
      if (!(file instanceof TFile)) return;
      for (const view of this.views()) if (view.currentFile?.path === file.path) view.fileDeleted();
      this.store.forgetFile(file.path);
    }));
  }

  private onOutlineClick(event: MouseEvent): void {
    const click = readOutlineClick(event.target);
    if (!click) return;
    // The core Outline pane shows the active Markdown note.
    const file = this.app.workspace.getActiveFile();
    const views = this.views().filter(v => v.currentFile && (!file || v.currentFile.path === file.path));
    for (const view of views) view.revealHeading(click.text, click.occurrence);
  }
}
