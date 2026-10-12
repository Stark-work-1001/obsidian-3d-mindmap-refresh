// The 3D mind map view: binds one Markdown note to an outline model, the
// layout engine, the WebGL renderer and the interface panels.
//
// Data flow: note text -> OutlineModel (parse, identity) -> buildGraph ->
// LayoutEngine (positions) -> SceneRenderer (draws on demand). Edits go the
// other way through DocumentSync, which never overwrites newer note text.
// Camera movement, selection and navigation never write to the note; they
// only update plugin data (camera pose, collapsed branches) in data.json.
import { ItemView, Keymap, MarkdownView, Notice, Scope, TFile, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import { MathUtils, Quaternion, Vector3 } from 'three';
import { lookRotation, type PivotMode } from '../camera/camera-rig';
import { poseBookmark, poseFromBookmark } from '../camera/pose';
import { NavigationHistory, type NavigationEntry } from '../camera/navigation-history';
import { t } from '../i18n';
import { layoutInfo } from '../layout/catalog';
import { LayoutEngine, type LayoutReason } from '../layout/layout-engine';
import { PathIndex, pathMap, pathRenames, toggleAssociation, toggleMark, type StoredAssociation } from '../model/node-paths';
import { OutlineModel } from '../model/outline-model';
import { descendantCount, walkPreorder } from '../model/tree-utils';
import type { OutlineNode, RunResult } from '../model/types';
import type { Settings } from '../persistence/settings';
import { effectiveBackground, isLight, mix, parseHex, readableText } from '../render/colors';
import { plainText } from '../render/label-format';
import type { EdgeInstance } from '../render/edge-layer';
import type { LinkInstance } from '../render/link-layer';
import { pickSphere } from '../render/picking';
import { SceneRenderer } from '../render/scene-renderer';
import { DocumentSync, type SyncNotice, type TreeEvent } from '../sync/document-sync';
import { ObsidianNoteIO } from '../sync/obsidian-note-io';
import { HoverCard } from '../ui/hover-card';
import { Inspector, type InspectorController } from '../ui/inspector';
import { Menu } from '../ui/menu';
import { BackgroundModal, ConfirmModal, NotePicker } from '../ui/modals';
import { NodeEditor, type CommitIntent } from '../ui/node-editor';
import { OutlinePanel } from '../ui/outline-panel';
import { SearchBar } from '../ui/search-bar';
import { Toolbar, type Crumb, type InteractionMode, type ToolbarController } from '../ui/toolbar';
import { DiagnosticsModal, summarise } from './diagnostics';
import { computeEmphasis, subtreeMask, type EmphasisOutput } from './emphasis';
import { buildGraph, type BuiltGraph } from './graph-builder';
import { inspectorData, nodeLabel } from './inspector-data';
import { Interaction, type InteractionHost } from './interaction';
import { handleKey, type KeyboardHost } from './keyboard';
import { buildMenu, type MenuHost, type ViewAction } from './view-menus';
import type { ViewHost } from './view-host';

export const VIEW_TYPE = '3d-mindmap-view';

const ORBIT_TO_PIVOT: Record<Settings['orbitCenter'], PivotMode> = { free: 'free', selected: 'selected', root: 'centre' };
/** Deleting a branch at least this large asks for confirmation (it can still be undone). */
const CONFIRM_DELETE_NODES = 8;
const NEW_NODE = '\u0000new';
const PICK_TOLERANCE_PX = 7;
/** Below this width panels overlay the map instead of sitting beside it (see styles.css). */
const NARROW_PX = 640;
/** Room kept around framed content for labels of nodes at the edge (px). */
const FRAME_PADDING = { x: 56, y: 26 };

interface PendingCreate { kind: 'child' | 'sibling'; anchorId: string }
interface DragState { index: number; id: string; plane: Vector3; previous: [number, number, number] | null }

let cssProbe: CanvasRenderingContext2D | null = null;
/** Any CSS colour -> #rrggbb (via the canvas parser), or the fallback. */
function cssColor(value: string, fallback: string): string {
  if (!value) return fallback;
  cssProbe ??= document.createElement('canvas').getContext('2d');
  if (!cssProbe) return fallback;
  cssProbe.fillStyle = fallback;
  cssProbe.fillStyle = value;
  const out = String(cssProbe.fillStyle);
  return /^#[0-9a-f]{6}$/i.test(out) ? out : fallback;
}

export class MindMapView extends ItemView {
  file: TFile | null = null;
  private model: OutlineModel | null = null;
  private sync: DocumentSync | null = null;
  private graph: BuiltGraph | null = null;
  private parentIndex = new Int32Array(0);
  /** id -> node path of the previous parse, to carry saved data across renames. */
  private paths = new Map<string, string>();
  private engine!: LayoutEngine;
  private renderer: SceneRenderer | null = null;
  private toolbar!: Toolbar;
  private inspector!: Inspector;
  private outline!: OutlinePanel;
  private search!: SearchBar;
  private editor!: NodeEditor;
  private hover!: HoverCard;
  private interaction: Interaction | null = null;
  private stage!: HTMLElement;
  private notice: HTMLElement | null = null;
  private selectedId: string | null = null;
  private hovered = -1;
  private focusId: string | null = null;
  private mode: InteractionMode = 'navigate';
  private connectSource: string | null = null;
  private hits: number[] = [];
  private hitIndex = -1;
  private hiddenHits = 0;
  private emphasis: EmphasisOutput | null = null;
  private readonly nav = new NavigationHistory();
  private pending: PendingCreate | null = null;
  private drag: DragState | null = null;
  private hoverTimer: number | null = null;
  private poseTimer: number | null = null;
  private cameraWasMoving = false;
  /** A saved pose was restored: verify the map is in view once it has settled. */
  private checkFraming = false;
  /** Frame the whole map once a newly chosen layout has taken shape. */
  private autoFit = false;
  private pendingFocusPath: string | null = null;
  private pendingPath: string | null = null;
  private unsubscribers: (() => void)[] = [];
  private markCursor = -1;
  private motionQuery: MediaQueryList | null = null;
  private edgeKinds: { kind: 'hierarchy' | 'order'; a: number; b: number }[] = [];
  /** Association and note-link curves before emphasis is applied. */
  private linkBase: LinkInstance[] = [];
  private linkStyleKey = '';
  private theme = { background: '#1e1e1e', text: '#f6f8fa', accent: '#7f6df2', light: false };
  private bindToken = 0;
  private closed = false;

  constructor(leaf: WorkspaceLeaf, private readonly host: ViewHost) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return this.file ? t('view.title', { name: this.file.basename }) : t('view.titleEmpty'); }
  override getIcon(): string { return 'network'; }
  private get settings(): Settings { return this.host.config; }
  get currentFile(): TFile | null { return this.file; }

  private get narrow(): boolean { return this.contentEl.hasClass('is-narrow'); }
  private get inspectorVisible(): boolean {
    return !!this.inspector?.isOpen && (!this.narrow || this.inspector.el.hasClass('is-pinned-open'));
  }

  private get reducedMotion(): boolean {
    const m = this.settings.motion;
    return m === 'reduce' || (m === 'system' && !!this.motionQuery?.matches);
  }
  private get animationMs(): number { return this.settings.animate && !this.reducedMotion ? 480 : 0; }

  // --- workspace state -----------------------------------------------------------------
  override getState(): Record<string, unknown> {
    return { file: this.file?.path ?? this.pendingPath ?? null, focus: this.focusPath() };
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = (state ?? {}) as { file?: unknown; focus?: unknown };
    if (typeof s.focus === 'string') this.pendingFocusPath = s.focus;
    if (typeof s.file === 'string') {
      const file = this.app.vault.getAbstractFileByPath(s.file);
      if (file instanceof TFile && file.extension === 'md') await this.bindFile(file);
      else this.waitForFile(s.file);
    }
    await super.setState(state, result);
  }

  /**
   * Obsidian calls this with `{ focus: true }` when the leaf becomes active
   * (for example on the click that switches to the map); the default blurs the
   * view, so keyboard shortcuts would not reach the map until a second click.
   */
  override setEphemeralState(state: unknown): void {
    super.setEphemeralState(state);
    if ((state as { focus?: boolean } | null)?.focus && this.stage && !this.contentEl.contains(document.activeElement)) this.stage.focus({ preventScroll: true });
  }

  override onResize(): void {
    this.renderer?.resize();
    this.updateInsets();
  }

  /** The note may not be indexed yet while Obsidian starts: bind once it is. */
  private waitForFile(path: string): void {
    this.pendingPath = path;
    this.showNotice(t('view.waiting', { path }));
    const attempt = () => {
      if (this.file || this.pendingPath !== path) return;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) void this.bindFile(file);
    };
    this.app.workspace.onLayoutReady(attempt);
    this.registerEvent(this.app.vault.on('create', f => { if (f.path === path) attempt(); }));
  }

  // --- lifecycle -------------------------------------------------------------------------
  override async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('om3d-root');
    this.motionQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    this.motionQuery?.addEventListener?.('change', this.onMotionChange);

    this.toolbar = new Toolbar(root, this.toolbarController());
    const body = root.createDiv({ cls: 'om3d-body' });
    this.outline = new OutlinePanel(body, id => this.locate(id, { history: true }));
    this.outline.setOpen(false);
    this.stage = body.createDiv({ cls: 'om3d-stage' });
    this.stage.tabIndex = 0;
    this.stage.setAttribute('role', 'application');
    this.stage.setAttribute('aria-roledescription', t('view.roleDescription'));
    this.stage.setAttribute('aria-label', t('view.canvasLabel'));
    this.inspector = new Inspector(body, this.inspectorController(), this);
    this.inspector.setOpen(this.settings.showInspector);

    this.engine = new LayoutEngine(() => this.host.createPhysics(() => this.renderer?.requestFrame()));
    this.renderer = new SceneRenderer(this.stage, this.engine);
    this.renderer.rig.framePadding = FRAME_PADDING;
    this.renderer.beforeCamera = () => this.beforeCamera();
    this.renderer.afterFrame = moving => this.afterFrame(moving);
    this.renderer.labels.el.addEventListener('click', this.onLabelLinkClick);
    if (this.renderer.unavailable) this.showNotice(t('view.webglUnavailable'), true);
    else this.interaction = new Interaction(this.stage, this.interactionHost());

    this.editor = new NodeEditor(this.stage, (id, text, intent, initial) => this.onEditorCommit(id, text, intent, initial));
    this.hover = new HoverCard(this.stage, this.app, this);
    this.search = new SearchBar(this.stage, { query: q => this.runSearch(q), step: d => this.stepSearch(d), close: () => this.clearSearch() });

    // Map shortcuts take precedence over Obsidian's global hotkeys (F2 is
    // "Rename file", Ctrl+F "Search") while the map has focus: a view scope is
    // consulted before the app scope. Keys the map does not use pass through.
    this.scope = new Scope(this.app.scope);
    // A catch-all handler must return undefined for keys it does not use:
    // any other value ends the lookup and Obsidian's hotkeys would not run.
    this.scope.register(null, null, evt => {
      const target = evt.target as Node | null;
      if (target !== document.body && !this.stage.contains(target)) return undefined;
      if (!handleKey(evt, this.keyboardHost())) return undefined;
      (evt as KeyboardEvent & { om3dHandled?: boolean }).om3dHandled = true;
      return false;
    });
    this.registerDomEvent(this.stage, 'keydown', e => {
      if ((e as KeyboardEvent & { om3dHandled?: boolean }).om3dHandled) return;
      if (handleKey(e, this.keyboardHost())) { e.preventDefault(); e.stopPropagation(); }
    });
    this.registerEvent(this.app.workspace.on('css-change', () => this.applyTheme()));
    this.registerDomEvent(window, 'resize', () => this.updateInsets());
    if (typeof ResizeObserver !== 'undefined') {
      // Narrow panes: icon-only toolbar, panels overlay the map (see styles.css).
      const observer = new ResizeObserver(() => {
        const narrow = root.clientWidth < NARROW_PX;
        if (narrow !== root.hasClass('is-narrow')) {
          root.toggleClass('is-narrow', narrow);
          // In narrow panes panels cover the map: the inspector only shows when asked for.
          this.inspector.el.removeClass('is-pinned-open');
          this.toolbar.sync();
        }
        this.updateInsets();
      });
      observer.observe(root);
      this.register(() => observer.disconnect());
    }
    this.applyAllSettings();
    if (!this.file && !this.pendingPath) this.showNotice(t('view.empty'));
  }

  override async onClose(): Promise<void> {
    this.closed = true;
    this.savePose();
    this.teardownFile();
    this.motionQuery?.removeEventListener?.('change', this.onMotionChange);
    if (this.hoverTimer !== null) window.clearTimeout(this.hoverTimer);
    if (this.poseTimer !== null) window.clearTimeout(this.poseTimer);
    Menu.closeAll(false);
    this.interaction?.dispose();
    this.editor?.dispose();
    this.hover?.dispose();
    this.search?.dispose();
    this.inspector?.dispose();
    this.outline?.dispose();
    this.toolbar?.dispose();
    this.renderer?.labels.el.removeEventListener('click', this.onLabelLinkClick);
    this.renderer?.dispose();
    this.renderer = null;
    this.engine?.dispose();
  }

  private readonly onMotionChange = () => this.applyAllSettings();

  private showNotice(message: string, warning = false): void {
    this.notice ??= this.stage?.createDiv({ cls: 'om3d-notice' }) ?? null;
    if (!this.notice) return;
    this.notice.setText(message);
    this.notice.toggleClass('is-warning', warning);
    this.notice.hidden = false;
  }

  private hideNotice(): void { if (this.notice) this.notice.hidden = true; }

  private status(message: string, level: 'info' | 'warning' = 'info'): void {
    this.toolbar?.setStatus(message, level);
  }

  // --- binding a note ------------------------------------------------------------------
  async bindFile(file: TFile): Promise<void> {
    if (this.closed) return;
    if (this.file?.path === file.path && this.model) return;
    const token = ++this.bindToken;
    this.savePose();
    this.teardownFile();
    this.file = file;
    this.pendingPath = null;
    const io = new ObsidianNoteIO(this.app, file);
    const text = await io.read();
    if (token !== this.bindToken || this.closed) return;
    if (text === null) { this.showNotice(t('view.readFailed', { name: file.basename }), true); return; }
    const s = this.settings;
    const model = new OutlineModel(text, file.basename, s.maxHeadingLevel, s.coreNameStripSuffix);
    this.model = model;
    this.restoreCollapsed(file, model);
    this.paths = pathMap(model.current);
    const sync = new DocumentSync(model, io, s.syncDebounceMs);
    this.sync = sync;
    this.unsubscribers.push(sync.onTree(e => this.onTree(e)), sync.onNotice(n => this.onSyncNotice(n)));
    sync.attach();
    this.hideNotice();
    this.rebuild('open');
    this.restoreView(file);
    this.reportLoad();
    this.app.workspace.requestSaveLayout();
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
    this.renderer?.requestFrame();
  }

  /** The note was renamed or moved in the vault (data.json is updated by the plugin). */
  fileRenamed(file: TFile): void {
    if (!this.model || this.file !== file) return;
    this.model.setBasename(file.basename);
    this.paths = pathMap(this.model.current);
    this.rebuild('settings', false);
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
  }

  fileDeleted(): void {
    this.teardownFile();
    this.rebuildEmpty();
    this.showNotice(t('view.deleted'), true);
  }

  private teardownFile(): void {
    this.cancelEditor();
    for (const off of this.unsubscribers.splice(0)) off();
    this.sync?.detach();
    this.sync = null;
    this.model = null;
    this.graph = null;
    this.file = null;
    this.selectedId = null;
    this.focusId = null;
    this.connectSource = null;
    this.hovered = -1;
    this.hits = [];
    this.hitIndex = -1;
    this.nav.clear();
    this.hover?.hide();
    this.inspector?.show(null);
  }

  private rebuildEmpty(): void {
    this.engine.setGraph([], [], this.settings.layout, this.engineSettings(), 'open');
    const r = this.renderer;
    if (r) { r.nodes.setGraph([]); r.labels.setEntries([], []); r.edges.setEdges([]); r.links.setLinks([]); r.setGuide(null, 0, 0); r.invalidatePositions(); }
    this.refreshPanels();
    this.toolbar.sync();
    this.updateCrumbs();
  }

  private restoreCollapsed(file: TFile, model: OutlineModel): void {
    const stored = this.host.store.getCollapsed(file.path);
    if (stored.length) {
      const index = new PathIndex(model.current);
      for (const path of stored) { const node = index.resolve(path); if (node) model.setCollapsed(node.id, true); }
    } else if (this.settings.collapseDepth > 0) model.collapseToDepth(this.settings.collapseDepth);
  }

  private persistCollapsed(): void {
    if (!this.model || !this.file) return;
    const index = new PathIndex(this.model.current);
    const paths: string[] = [];
    walkPreorder(this.model.root, n => { if (n.collapsed && n.children.length) { const p = index.pathOf(n.id); if (p) paths.push(p); } });
    this.host.store.setCollapsed(this.file.path, paths);
  }

  private reportLoad(): void {
    const model = this.model;
    if (!model) return;
    const warnings = model.warnings;
    if (warnings.length) this.status(warnings.length > 1 ? t('status.warnings', { first: warnings[0], count: warnings.length - 1 }) : warnings[0], 'warning');
    else this.status(t('status.loaded', { count: model.stats.nodeCount }));
  }

  // --- model changes ---------------------------------------------------------------------
  private onTree(event: TreeEvent): void {
    if (!this.model || !this.file) return;
    this.carryPaths();
    this.rebuild('edit');
    if (event.origin === 'external') this.status(t('status.external'));
  }

  /** Re-key saved sizes, marks, associations and pins after renames or moves. */
  private carryPaths(): void {
    if (!this.model || !this.file) return;
    const after = pathMap(this.model.current);
    const renames = pathRenames(this.paths, after);
    if (renames.size) this.host.store.renamePaths(this.file.path, renames);
    this.paths = after;
  }

  private onSyncNotice(notice: SyncNotice): void {
    if (notice.level === 'info') { this.status(notice.message); return; }
    new Notice(notice.message, notice.level === 'error' ? 8000 : 5000);
    this.status(notice.message, 'warning');
  }

  private engineSettings() {
    const s = this.settings;
    return { gap: s.edgeGap, chargeStrength: s.chargeStrength, animate: s.animate };
  }

  /** Rebuild derived data from the model; `updateEngine` false keeps positions (decorations only). */
  private rebuild(reason: LayoutReason, updateEngine = true): void {
    const model = this.model, file = this.file;
    if (!model || !file) return;
    const s = this.settings, store = this.host.store;
    this.host.formulas.enabled = s.enableFormula;
    const graph = buildGraph({
      tree: model.current, filePath: file.path, fileBasename: file.basename, settings: s,
      sizes: store.getSizes(file.path), marks: store.getMarks(file.path), associations: store.getLinks(file.path),
      anchors: store.getAnchors(file.path, s.layout), formulas: s.enableFormula ? this.host.formulas : null,
    });
    if (!updateEngine && (graph.ids.length !== this.engine.count || graph.ids.some((id, i) => this.engine.ids[i] !== id))) updateEngine = true;
    this.graph = graph;
    const parent = new Int32Array(graph.visible.length).fill(-1);
    graph.visible.forEach((n, i) => { const p = n.parent ? graph.index.get(n.parent.id) : undefined; if (p !== undefined) parent[i] = p; });
    this.parentIndex = parent;
    if (this.selectedId && !graph.index.has(this.selectedId)) this.selectedId = this.visibleAncestor(this.selectedId);
    if (this.focusId && !model.find(this.focusId)) this.focusId = null;
    if (this.connectSource && !graph.index.has(this.connectSource)) this.connectSource = null;
    if (updateEngine) {
      this.engine.reducedMotion = this.reducedMotion;
      this.engine.setGraph(graph.engineNodes, graph.physicsEdges, s.layout, this.engineSettings(), reason);
    }
    const r = this.renderer;
    if (r) {
      r.nodes.setGraph(graph.colors);
      r.labels.setEntries(graph.ids, graph.labels);
      this.setEdges();
      this.updateGuide();
      r.invalidatePositions();
    }
    this.hovered = -1;
    if (this.search?.isOpen && this.search.query) this.runSearch(this.search.query, false);
    else this.updateEmphasis();
    this.refreshPanels();
    this.toolbar.sync();
    this.updateCrumbs();
  }

  private visibleAncestor(id: string): string | null {
    for (let n = this.model?.find(id) ?? null; n; n = n.parent) if (this.graph?.index.has(n.id)) return n.id;
    return null;
  }

  // --- edges, theme and settings -----------------------------------------------------------
  private edgeColor(): number {
    const s = this.settings;
    return parseHex(s.linkColor.trim() || mix(this.theme.text, this.theme.background, 0.55), 0x8a8a8a);
  }

  private setEdges(): void {
    const r = this.renderer, g = this.graph;
    if (!r || !g) return;
    const s = this.settings;
    const color = this.edgeColor();
    const edges: EdgeInstance[] = [];
    this.edgeKinds = [];
    for (const [a, b] of g.hierarchy) { edges.push({ a, b, style: s.linkStyle, color, alpha: s.linkOpacity, width: s.linkWidth }); this.edgeKinds.push({ kind: 'hierarchy', a, b }); }
    for (const [a, b] of g.documentOrder) { edges.push({ a, b, style: 'dotted', color, alpha: s.linkOpacity * 0.6, width: Math.max(0.5, s.linkWidth * 0.6) }); this.edgeKinds.push({ kind: 'order', a, b }); }
    r.edges.setEdges(edges);
    const links: LinkInstance[] = [];
    if (s.showAssociations) {
      const c = parseHex(s.assocColor, 0xe8a33d);
      for (const a of g.associations) links.push({ a: a.a, b: a.b, color: c, alpha: 0.9, width: Math.max(1, s.linkWidth * 0.9), style: s.assocStyle, arrow: false, bulge: s.assocCurve ? s.assocBulge : 0 });
    }
    if (s.showNoteLinks) {
      const c = parseHex(this.theme.accent, 0x7f6df2);
      for (const l of g.noteLinks) links.push({ a: l.a, b: l.b, color: c, alpha: 0.85, width: Math.max(1, s.linkWidth * 0.8), style: 'dashed', arrow: s.edgeDirection, bulge: s.assocCurve ? s.assocBulge * 0.8 : 0 });
    }
    this.linkBase = links;
    this.linkStyleKey = '';
    r.links.setLinks(links);
    this.styleEdges();
    r.invalidate(false);
  }

  /** Hierarchy edges along the selection path are accented; edges in faded regions recede. */
  private styleEdges(): void {
    const r = this.renderer, e = this.emphasis;
    if (!r || !e) return;
    // The selection path uses the high-contrast text colour (note links use the accent colour).
    const s = this.settings, color = this.edgeColor(), accent = parseHex(this.theme.text, 0xf6f8fa);
    this.edgeKinds.forEach((edge, k) => {
      const hierarchy = edge.kind === 'hierarchy';
      const base = hierarchy ? s.linkOpacity : s.linkOpacity * 0.6;
      const width = hierarchy ? s.linkWidth : Math.max(0.5, s.linkWidth * 0.6);
      const onPath = hierarchy && e.path[edge.a] === 1 && e.path[edge.b] === 1;
      const dim = e.dimmed[edge.a] === 1 || e.dimmed[edge.b] === 1;
      const alpha = dim ? base * 0.25 : onPath ? Math.min(1, base * 1.6 + 0.25) : base;
      r.edges.setStyle(k, onPath ? accent : color, alpha, onPath ? width * 1.6 : width);
    });
    r.edges.commitStyles();
    // Curves fade with a faded endpoint and stand out when they touch the selection.
    const selected = this.indexOf(this.selectedId);
    const styled = this.linkBase.map(l => {
      const dim = e.dimmed[l.a] === 1 || e.dimmed[l.b] === 1;
      const touches = selected >= 0 && (l.a === selected || l.b === selected);
      return dim ? { ...l, alpha: l.alpha * 0.2 } : touches ? { ...l, alpha: 1, width: l.width * 1.4 } : l;
    });
    const key = styled.map(l => `${l.alpha.toFixed(2)}:${l.width.toFixed(2)}`).join(',');
    if (key !== this.linkStyleKey) { this.linkStyleKey = key; if (!r.links.restyle(styled)) r.links.setLinks(styled); }
  }

  private updateGuide(): void {
    const r = this.renderer;
    if (!r) return;
    const guide = this.settings.learningPath ? this.engine.guide : null;
    r.setGuide(guide, parseHex(this.theme.accent, 0x7f6df2), this.theme.light ? 0.55 : 0.45);
  }

  private applyTheme(): void {
    const s = this.settings;
    const css = getComputedStyle(this.contentEl);
    const v = (name: string, fallback: string) => cssColor(css.getPropertyValue(name).trim(), fallback);
    const themeBg = v('--background-primary', '#1e1e1e');
    const spec = { mode: s.bgMode, top: s.bgTop, bottom: s.bgBottom, theme: themeBg };
    const background = effectiveBackground(spec);
    this.theme = { background, text: readableText(background), accent: v('--interactive-accent', '#7f6df2'), light: isLight(background) };
    const r = this.renderer;
    r?.setBackground({ ...spec, animated: s.animatedBackground === 'subtle' }, this.reducedMotion);
    r?.nodes.setAppearance(s.glowStrength, this.theme.light);
    this.stage.style.setProperty('--om3d-label-color', this.theme.text);
    this.stage.style.setProperty('--om3d-label-halo', background);
    this.stage.style.setProperty('--om3d-accent', this.theme.accent);
    this.stage.toggleClass('is-light', this.theme.light);
    this.stage.toggleClass('is-dark', !this.theme.light);
    this.setEdges();
    this.updateGuide();
    r?.invalidate();
  }

  private applyLabels(): void {
    const r = this.renderer;
    if (!r) return;
    const s = this.settings;
    r.showLabels = s.showLabels;
    r.labelOptions = { ...r.labelOptions, maxDistance: s.labelDistance, budget: s.maxLabels, avoid: s.labelAvoid };
    r.invalidate();
  }

  private applyCamera(pivotChanged: boolean, fovChanged: boolean): void {
    const rig = this.renderer?.rig;
    if (!rig) return;
    const s = this.settings;
    rig.rotationStyle = s.rotationStyle;
    rig.smoothingMs = this.reducedMotion ? 0 : s.cameraSmoothingMs;
    rig.pivotMode = ORBIT_TO_PIVOT[s.orbitCenter];
    if (fovChanged) rig.setFov(s.fieldOfView);
    if (pivotChanged) { this.followPoint = null; this.updatePivot(); }
    this.renderer?.requestFrame();
  }

  private applyAllSettings(): void {
    const s = this.settings;
    this.engine.reducedMotion = this.reducedMotion;
    this.hover.enabled = s.showNoteOnHover;
    this.applyTheme();
    this.applyLabels();
    this.applyCamera(true, true);
    this.inspector.setOpen(s.showInspector);
    this.sync?.setDebounce(s.syncDebounceMs);
    this.updateInsets();
    if (this.model) this.rebuild('settings');
    this.toolbar.sync();
  }

  /** Called by the plugin after settings changed (from any view or the settings tab). */
  applySettings(previous: Settings): void {
    if (!this.renderer) return;
    const s = this.settings;
    const changed = new Set((Object.keys(s) as (keyof Settings)[]).filter(k => JSON.stringify(s[k]) !== JSON.stringify(previous[k])));
    if (!changed.size) return;
    const has = (...keys: (keyof Settings)[]) => keys.some(k => changed.has(k));
    if (has('motion')) this.engine.reducedMotion = this.reducedMotion;
    if (has('maxHeadingLevel', 'coreNameStripSuffix') && this.model) {
      this.model.setMaxHeadingLevel(s.maxHeadingLevel);
      this.model.setCoreNameStripSuffix(s.coreNameStripSuffix);
      this.carryPaths();
    }
    if (has('bgMode', 'bgTop', 'bgBottom', 'animatedBackground', 'themeFollowsObsidian', 'glowStrength', 'motion')) this.applyTheme();
    if (has('layout')) {
      this.rebuild('layout');
      this.frameNewLayout();
    } else if (has('nodeScale', 'sizeByHierarchy', 'edgeGap', 'linkDistance', 'chargeStrength', 'linkLevel1', 'groupRules', 'pinRules',
      'rootAsTitlePlate', 'nodeColorMode', 'nodeColor', 'enableFormula', 'animate', 'maxHeadingLevel', 'coreNameStripSuffix')) {
      this.rebuild('settings');
    } else if (has('linkOpacity', 'linkWidth', 'linkStyle', 'linkColor', 'assocStyle', 'assocColor', 'assocCurve', 'assocBulge',
      'showAssociations', 'showNoteLinks', 'edgeDirection')) {
      this.setEdges();
    }
    if (has('learningPath')) { this.updateGuide(); this.renderer.requestFrame(); }
    if (has('showLabels', 'labelDistance', 'maxLabels', 'labelAvoid')) this.applyLabels();
    if (has('orbitCenter', 'rotationStyle', 'fieldOfView', 'cameraSmoothingMs', 'motion')) this.applyCamera(has('orbitCenter'), has('fieldOfView'));
    if (has('showInspector')) { this.inspector.setOpen(s.showInspector); this.updateInsets(); }
    if (has('syncDebounceMs')) this.sync?.setDebounce(s.syncDebounceMs);
    if (has('showNoteOnHover')) { this.hover.enabled = s.showNoteOnHover; if (!s.showNoteOnHover) this.hover.hide(); }
    this.toolbar.sync();
  }

  // --- camera ------------------------------------------------------------------------------
  private followPoint: Vector3 | null = null;
  private focusIndices: number[] | null = null;

  private positionAt(i: number): Vector3 {
    const p = this.engine.positions;
    return new Vector3(p[i * 4], p[i * 4 + 1], p[i * 4 + 2]);
  }

  private indexOf(id: string | null): number {
    return id ? this.graph?.index.get(id) ?? -1 : -1;
  }

  /** Where the orbit pivot should be in the current orbit mode (null: free). */
  private pivotTarget(): Vector3 | null {
    const rig = this.renderer?.rig;
    if (!rig || !this.engine.count) return null;
    if (rig.pivotMode === 'selected') { const i = this.indexOf(this.selectedId); return i >= 0 ? this.positionAt(i) : null; }
    if (rig.pivotMode === 'centre') { const b = this.engine.bounds(this.focusIndices ?? undefined); return new Vector3(b.x, b.y, b.z); }
    return null;
  }

  /**
   * Orbit Selected / Orbit Graph Center: the camera moves rigidly with the
   * pivot's motion (layout animation, physics) so the target never slides on
   * screen, and the pivot is re-anchored without moving the camera.
   */
  private beforeCamera(): void {
    const rig = this.renderer?.rig;
    if (!rig) return;
    const p = this.pivotTarget();
    if (!p) { this.followPoint = null; return; }
    if (this.followPoint) {
      const delta = p.clone().sub(this.followPoint);
      if (delta.lengthSq() > 1e-10) rig.follow(rig.pivot.add(delta));
    }
    this.followPoint = p;
    if (!rig.animating && rig.pivot.distanceToSquared(p) > 1e-6) rig.setPivot(p);
  }

  private afterFrame(_moving: boolean): void {
    const rig = this.renderer?.rig;
    if (!rig) return;
    if (this.editor.editingId) this.placeEditor();
    if (this.hover.target !== null && this.hovered >= 0) { const p = this.screenAt(this.hovered); if (p) this.hover.place(p); }
    if (rig.moving) this.cameraWasMoving = true;
    else if (this.cameraWasMoving) { this.cameraWasMoving = false; this.schedulePoseSave(); }
    if (this.autoFit && !this.engine.active) { this.autoFit = false; this.frameAll({ ms: this.animationMs }); }
    if (this.checkFraming && !this.engine.active && !rig.moving) { this.checkFraming = false; if (!this.mapInView()) this.frameAll({ ms: this.animationMs }); }
  }

  /** Is the map reasonably framed: centre on screen and neither tiny nor overflowing? */
  private mapInView(): boolean {
    const r = this.renderer;
    if (!r || !this.engine.count) return true;
    const b = this.engine.bounds(this.focusIndices ?? undefined);
    const c = r.project(b);
    const { width, height } = r.viewport;
    if (!c || c.x < 0 || c.y < 0 || c.x > width || c.y > height) return false;
    const distance = Math.max(1e-6, r.camera.position.distanceTo(new Vector3(b.x, b.y, b.z)));
    const radiusPx = (b.r / (distance * Math.tan(MathUtils.degToRad(r.camera.fov) / 2))) * (height / 2);
    const size = Math.min(width, height);
    return radiusPx > size * 0.12 && radiusPx < size * 4;
  }

  private updatePivot(): void {
    this.followPoint = null;
    this.renderer?.requestFrame();
  }

  private screenAt(i: number): { x: number; y: number } | null {
    return this.renderer?.project(this.positionAt(i)) ?? null;
  }

  private updateInsets(): void {
    const rig = this.renderer?.rig;
    if (!rig || !this.stage) return;
    const s = this.stage.getBoundingClientRect();
    const inset = { top: 0, right: 0, bottom: 0, left: 0 };
    // Panels normally sit beside the canvas; in narrow panes they overlay it.
    for (const panel of [this.inspector?.el, this.outline?.el]) {
      if (!panel || panel.classList.contains('is-hidden')) continue;
      const p = panel.getBoundingClientRect();
      if (Math.min(s.right, p.right) - Math.max(s.left, p.left) <= 0 || Math.min(s.bottom, p.bottom) - Math.max(s.top, p.top) <= 0) continue;
      if (p.left - s.left > s.right - p.right) inset.right = Math.max(inset.right, s.right - p.left);
      else inset.left = Math.max(inset.left, p.right - s.left);
    }
    rig.insets = inset;
    rig.apply();
    this.renderer?.requestFrame();
  }

  private defaultOrientation(): Quaternion {
    const elevation = layoutInfo(this.settings.layout).viewElevation, azimuth = 0.3;
    const from = new Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
    return lookRotation(from, new Vector3());
  }

  private frameAll(o: { ms?: number; orientation?: Quaternion } = {}): void {
    const rig = this.renderer?.rig;
    if (!rig || !this.engine.count) return;
    rig.frame(this.engine.spheres(this.focusIndices ?? undefined, true), { ms: o.ms ?? this.animationMs, orientation: o.orientation });
    this.updatePivot();
  }

  /** Frame a node with its parent and children, so it is seen in context. */
  private frameNode(i: number, ms = this.animationMs): void {
    const rig = this.renderer?.rig;
    if (!rig) return;
    const list = [i];
    if (this.parentIndex[i] >= 0) list.push(this.parentIndex[i]);
    for (let k = 0; k < this.parentIndex.length; k++) if (this.parentIndex[k] === i) list.push(k);
    rig.frame(this.engine.spheres(list, true), { ms, margin: 1.25 });
    this.updatePivot();
  }

  /** Keep a node on screen during keyboard navigation (no history entry). */
  private ensureVisible(i: number): void {
    const p = this.screenAt(i), r = this.renderer;
    if (!r) return;
    const { width, height } = r.viewport;
    if (p && p.x > 40 && p.x < width - 40 && p.y > 40 && p.y < height - 40) return;
    this.frameNode(i);
  }

  private frameNewLayout(): void {
    if (this.engine.targets) { this.frameAll({ orientation: this.defaultOrientation() }); return; }
    // Force layout: frame once now (start positions) and again when it settles.
    this.autoFit = true;
    this.frameAll({ orientation: this.defaultOrientation() });
  }

  // --- poses ---------------------------------------------------------------------------------
  private schedulePoseSave(): void {
    if (this.poseTimer !== null) window.clearTimeout(this.poseTimer);
    this.poseTimer = window.setTimeout(() => { this.poseTimer = null; this.savePose(); }, 1200);
  }

  private savePose(): void {
    if (this.poseTimer !== null) { window.clearTimeout(this.poseTimer); this.poseTimer = null; }
    const rig = this.renderer?.rig, file = this.file;
    if (!rig || !file || !this.model || !this.engine.count) return;
    this.host.store.setPose(file.path, poseFromBookmark(rig.bookmark(), { layout: this.settings.layout, focusPath: this.focusPath() }));
  }

  private restoreView(file: TFile): void {
    const rig = this.renderer?.rig;
    if (!rig) return;
    const s = this.settings;
    const pose = this.host.store.getPose(file.path);
    const focusPath = this.pendingFocusPath ?? pose?.focusPath ?? null;
    this.pendingFocusPath = null;
    if (focusPath && this.graph) {
      const node = this.graph.pathIndex.resolve(focusPath);
      if (node && node.children.length && this.graph.index.has(node.id)) { this.focusId = node.id; this.updateEmphasis(); }
    }
    // Only 2.0 poses are restored: 1.x placed nodes differently, so its camera
    // would look at the wrong place. A restored pose is checked once the
    // layout has settled (see afterFrame) and replaced if the map is not in view.
    const bookmark = pose && pose.v >= 6 && pose.layout === s.layout && !s.autoFocusOnOpen ? poseBookmark(pose, s.fieldOfView) : null;
    if (bookmark) { rig.restore(bookmark, 0); this.checkFraming = true; }
    else this.frameAll({ ms: 0, orientation: this.defaultOrientation() });
    if (!bookmark && layoutInfo(s.layout).physics) this.autoFit = true;
    this.updatePivot();
    this.updateCrumbs();
  }

  // --- navigation ----------------------------------------------------------------------------
  private focusPath(): string | null {
    return this.focusId && this.graph ? this.graph.pathIndex.pathOf(this.focusId) : null;
  }

  private label(id: string | null): string {
    const node = this.model?.find(id);
    return node && this.model ? nodeLabel(node, this.model.current) : '';
  }

  private locationLabel(): string {
    if (this.selectedId) return this.label(this.selectedId);
    if (this.focusId) return this.label(this.focusId);
    return t('nav.overview');
  }

  private currentEntry(): NavigationEntry | null {
    const rig = this.renderer?.rig;
    if (!rig || !this.graph) return null;
    return {
      label: this.locationLabel(), camera: rig.bookmark(), focusPath: this.focusPath(),
      selectedPath: this.selectedId ? this.graph.pathIndex.pathOf(this.selectedId) : null, pivotMode: rig.pivotMode,
    };
  }

  private pushHistory(): void {
    const entry = this.currentEntry();
    if (entry) this.nav.push(entry);
  }

  private goHistory(direction: -1 | 1): void {
    const current = this.currentEntry();
    if (!current || !this.graph) return;
    const entry = direction < 0 ? this.nav.goBack(current) : this.nav.goForward(current);
    if (!entry) return;
    const focus = entry.focusPath ? this.graph.pathIndex.resolve(entry.focusPath) : null;
    this.focusId = focus && this.graph.index.has(focus.id) ? focus.id : null;
    const selected = entry.selectedPath ? this.graph.pathIndex.resolve(entry.selectedPath) : null;
    this.selectedId = selected && this.graph.index.has(selected.id) ? selected.id : null;
    this.renderer?.rig.restore(entry.camera, this.animationMs);
    this.afterNavigation();
    this.status(t('nav.returned', { label: entry.label }));
  }

  private afterNavigation(): void {
    this.updatePivot();
    this.updateEmphasis();
    this.showInspectorFor(this.selectedId);
    this.outline.select(this.selectedId);
    this.updateCrumbs();
    this.toolbar.sync();
    this.app.workspace.requestSaveLayout();
  }

  /** Whole map (leaves an entered branch). */
  overview(): void {
    if (!this.graph) return;
    this.pushHistory();
    this.focusId = null;
    this.updateEmphasis();
    this.frameAll();
    this.afterNavigation();
  }

  /** Enter a branch: everything else fades, the camera frames the branch. */
  enterBranch(id: string): void {
    const model = this.model;
    const node = model?.find(id);
    if (!model || !node) return;
    if (!node.children.length) { this.locate(id, { history: true }); return; }
    this.pushHistory();
    if (node.collapsed) { model.setCollapsed(id, false); this.persistCollapsed(); this.rebuild('expand'); }
    this.focusId = id;
    if (!this.selectedId || !this.isInside(this.selectedId, id)) this.selectedId = id;
    this.updateEmphasis();
    this.frameAll();
    this.afterNavigation();
    this.status(t('nav.entered', { label: this.label(id) }));
  }

  /** Leave the entered branch for its parent branch, or the overview. */
  upLevel(): void {
    const focus = this.model?.find(this.focusId);
    if (!focus) { this.overview(); return; }
    let parent = focus.parent;
    while (parent && parent.kind !== 'root' && !this.graph?.index.has(parent.id)) parent = parent.parent;
    if (!parent || parent.kind === 'root') this.overview();
    else this.enterBranch(parent.id);
  }

  private isInside(id: string, ancestorId: string): boolean {
    for (let n = this.model?.find(id) ?? null; n; n = n.parent) if (n.id === ancestorId) return true;
    return false;
  }

  /** Show a node: expand collapsed ancestors, select it and frame it in context. */
  locate(id: string, o: { history?: boolean } = {}): void {
    const model = this.model;
    const node = model?.find(id);
    if (!model || !node || !this.graph) return;
    if (o.history) this.pushHistory();
    let expanded = false;
    for (let p = node.parent; p; p = p.parent) if (p.collapsed) { model.setCollapsed(p.id, false); expanded = true; }
    if (expanded) { this.persistCollapsed(); this.rebuild('expand'); }
    if (this.focusId && !this.isInside(id, this.focusId)) this.focusId = null;
    const i = this.indexOf(id);
    this.selectedId = i >= 0 ? id : this.visibleAncestor(id);
    this.updateEmphasis();
    if (i >= 0) this.frameNode(i);
    this.afterNavigation();
  }

  private updateCrumbs(): void {
    if (!this.toolbar) return;
    const model = this.model;
    if (!model || !this.file) { this.toolbar.setCrumbs([]); return; }
    const short = (s: string) => (s.length > 32 ? `${s.slice(0, 31)}\u2026` : s);
    const crumbs: Crumb[] = [{ label: model.current.coreName || this.file.basename, title: t('crumbs.overview'), onClick: () => this.overview(), current: !this.focusId && !this.selectedId }];
    const chain: OutlineNode[] = [];
    const tail = this.model?.find(this.selectedId) ?? this.model?.find(this.focusId);
    for (let n = tail ?? null; n && n.kind !== 'root'; n = n.parent) chain.unshift(n);
    for (const n of chain) {
      const isFocus = n.id === this.focusId;
      const isLast = n === chain[chain.length - 1];
      const hasChildren = n.children.length > 0;
      crumbs.push({
        label: short(nodeLabel(n, model.current)),
        title: isFocus ? t('crumbs.branch') : hasChildren ? t('crumbs.enter') : t('crumbs.locate'),
        onClick: () => (hasChildren && !isLast ? this.enterBranch(n.id) : this.locate(n.id, { history: true })),
        current: isLast,
      });
    }
    this.toolbar.setCrumbs(crumbs);
  }

  // --- selection, emphasis, hover ----------------------------------------------------------
  private selectedNode(): OutlineNode | null { return this.model?.find(this.selectedId) ?? null; }

  select(id: string | null, o: { history?: boolean } = {}): void {
    if (id !== null && !this.graph?.index.has(id)) id = null;
    if (o.history && id !== this.selectedId) this.pushHistory();
    this.selectedId = id;
    this.afterNavigation();
  }

  private updateEmphasis(): void {
    const g = this.graph, r = this.renderer;
    if (!g) { this.emphasis = null; this.focusIndices = null; return; }
    const n = g.ids.length;
    const selected = this.indexOf(this.selectedId);
    let focus: Uint8Array | null = null;
    this.focusIndices = null;
    const fi = this.indexOf(this.focusId);
    if (fi >= 0) {
      focus = subtreeMask(this.parentIndex, fi);
      const list: number[] = [];
      for (let i = 0; i < n; i++) if (focus[i]) list.push(i);
      this.focusIndices = list;
    }
    let hits: Uint8Array | null = null;
    if (this.search?.isOpen && this.search.query) { hits = new Uint8Array(n); for (const i of this.hits) if (i < n) hits[i] = 1; }
    const marks = new Uint8Array(n);
    for (const id of g.markIds) { const i = g.index.get(id); if (i !== undefined) marks[i] = 1; }
    let related: Uint8Array | null = null;
    if (selected >= 0) {
      related = new Uint8Array(n);
      const s = this.settings;
      if (s.showAssociations) for (const a of g.associations) { if (a.a === selected) related[a.b] = 1; if (a.b === selected) related[a.a] = 1; }
      if (s.showNoteLinks) for (const l of g.noteLinks) { if (l.a === selected) related[l.b] = 1; if (l.b === selected) related[l.a] = 1; }
    }
    this.emphasis = computeEmphasis({
      count: n, parent: this.parentIndex, depth: g.depth, selected, hovered: this.hovered, focus, hits,
      currentHit: this.hitIndex >= 0 ? this.hits[this.hitIndex] ?? -1 : -1, marks, related, connectSource: this.indexOf(this.connectSource),
    });
    if (r) {
      r.nodes.setState(this.emphasis.level, this.emphasis.rim, this.emphasis.dimmed);
      r.labels.setTiers(this.emphasis.tiers, this.emphasis.states);
      this.styleEdges();
      r.invalidate();
    }
  }

  private setHover(index: number | null, at: { x: number; y: number }): void {
    const i = index ?? -1;
    if (i === this.hovered) return;
    this.hovered = i;
    this.updateEmphasis();
    this.stage.toggleClass('is-pointing', i >= 0);
    if (this.hoverTimer !== null) { window.clearTimeout(this.hoverTimer); this.hoverTimer = null; }
    this.hover.hide();
    if (i < 0 || !this.settings.showNoteOnHover || this.editor.editingId || this.drag) return;
    this.hoverTimer = window.setTimeout(() => {
      this.hoverTimer = null;
      const node = this.graph?.visible[i];
      if (!node || !this.file || !this.model || this.hovered !== i) return;
      void this.hover.show(node.id, nodeLabel(node, this.model.current), node.note, this.screenAt(i) ?? at, this.file.path);
    }, this.settings.hoverNoteDelayMs);
  }

  private showInspectorFor(id: string | null): void {
    if (!this.inspector) return;
    const node = this.model?.find(id);
    if (!node || !this.graph || !this.file || !this.model) { this.inspector.show(null); return; }
    const file = this.file;
    this.inspector.show(inspectorData(node, {
      tree: this.model.current, graph: this.graph, settings: this.settings, filePath: file.path, fileBasename: file.basename,
      associations: this.host.store.getLinks(file.path), sizes: this.host.store.getSizes(file.path),
      resolveLink: linktext => this.app.metadataCache.getFirstLinkpathDest(linktext, file.path)?.path ?? null,
    }));
  }

  private refreshPanels(): void {
    if (!this.outline || !this.inspector) return;
    this.outline.update(this.model?.root ?? null, this.selectedId);
    this.showInspectorFor(this.inspector.editingId ?? this.selectedId);
  }

  private moveSelection(direction: 'up' | 'down' | 'left' | 'right'): void {
    const g = this.graph;
    if (!g || !g.ids.length) return;
    const order = this.focusIndices ?? g.ids.map((_, i) => i);
    const current = this.indexOf(this.selectedId);
    let next = -1;
    if (current < 0) next = order[0];
    else if (direction === 'up' || direction === 'down') {
      const k = order.indexOf(current);
      next = order[Math.max(0, Math.min(order.length - 1, (k < 0 ? 0 : k) + (direction === 'down' ? 1 : -1)))];
    } else if (direction === 'right') {
      next = this.parentIndex.indexOf(current);
    } else next = this.parentIndex[current];
    if (next === undefined || next < 0) return;
    this.select(g.ids[next]);
    this.ensureVisible(next);
  }

  private typeJump(char: string): void {
    const g = this.graph;
    if (!g) return;
    const c = char.toLocaleLowerCase();
    const order = this.focusIndices ?? g.ids.map((_, i) => i);
    const matches = order.filter(i => g.labels[i].text.trim().toLocaleLowerCase().startsWith(c));
    if (!matches.length) return;
    const current = matches.indexOf(this.indexOf(this.selectedId));
    const next = matches[(current + 1) % matches.length];
    this.select(g.ids[next]);
    this.ensureVisible(next);
  }

  // --- search ------------------------------------------------------------------------------
  private toggleSearch(): void {
    if (this.search.isOpen) this.search.close(); else this.search.open();
  }

  private runSearch(query: string, frame = true): void {
    const g = this.graph, model = this.model;
    const q = query.trim().toLocaleLowerCase();
    this.hits = [];
    this.hitIndex = -1;
    this.hiddenHits = 0;
    if (g && model && q) {
      const matches = (n: OutlineNode, text: string) => text.toLocaleLowerCase().includes(q) || (n.note?.toLocaleLowerCase().includes(q) ?? false);
      g.visible.forEach((n, i) => { if (matches(n, g.labels[i].text)) this.hits.push(i); });
      walkPreorder(model.root, n => { if (n.kind !== 'root' && !g.index.has(n.id) && matches(n, n.text)) this.hiddenHits++; });
      if (this.hits.length) this.hitIndex = 0;
    }
    this.search.setCount(this.hitIndex, this.hits.length);
    if (this.hiddenHits) this.status(t('search.hiddenMatches', { count: this.hiddenHits }));
    this.updateEmphasis();
    if (frame && this.hitIndex >= 0) this.frameNode(this.hits[this.hitIndex]);
  }

  private stepSearch(delta: 1 | -1): void {
    if (!this.hits.length) return;
    this.hitIndex = (this.hitIndex + delta + this.hits.length) % this.hits.length;
    this.search.setCount(this.hitIndex, this.hits.length);
    const i = this.hits[this.hitIndex];
    this.selectedId = this.graph?.ids[i] ?? null;
    this.afterNavigation();
    this.frameNode(i);
  }

  private clearSearch(): void {
    this.hits = [];
    this.hitIndex = -1;
    this.hiddenHits = 0;
    this.updateEmphasis();
    this.stage.focus({ preventScroll: true });
  }

  // --- modes, clicks, links ------------------------------------------------------------------
  setMode(mode: InteractionMode): void {
    this.mode = mode;
    this.connectSource = null;
    this.stage.toggleClass('mode-arrange', mode === 'arrange');
    this.stage.toggleClass('mode-connect', mode === 'connect');
    this.status(t(mode === 'navigate' ? 'mode.navigate.status' : mode === 'arrange' ? 'mode.arrange.status' : 'mode.connect.status'));
    this.updateEmphasis();
    this.toolbar.sync();
  }

  private onClick(index: number | null, event: MouseEvent): void {
    const g = this.graph;
    if (!g) return;
    const id = index !== null ? g.ids[index] ?? null : null;
    if (this.mode === 'connect') { if (id) this.connectClick(id); return; }
    if (id && (event.ctrlKey || event.metaKey)) { void this.openInEditor(this.model?.find(id) ?? null, Keymap.isModEvent(event)); return; }
    this.select(id);
  }

  private onDoubleClick(index: number | null): void {
    if (this.mode === 'connect' || !this.graph) return;
    if (index === null) { if (this.focusId) this.upLevel(); else this.overview(); return; }
    const id = this.graph.ids[index];
    const node = this.model?.find(id);
    if (node?.children.length) this.enterBranch(id); else this.locate(id, { history: true });
  }

  private connectClick(id: string): void {
    const model = this.model, file = this.file;
    if (!model || !file) return;
    if (!this.connectSource || this.connectSource === id) {
      this.connectSource = this.connectSource === id ? null : id;
      this.updateEmphasis();
      this.status(this.connectSource ? t('connect.pickSecond', { label: this.label(id) }) : t('mode.connect.status'));
      return;
    }
    const a = model.find(this.connectSource), b = model.find(id);
    this.connectSource = null;
    if (!a || !b) return;
    const result = toggleAssociation(this.host.store.getLinks(file.path), a, b);
    if (result.kind === 'self') return;
    this.host.store.setLinks(file.path, result.links);
    this.status(t(result.kind === 'created' ? 'connect.created' : 'connect.removed', { a: this.label(a.id), b: this.label(b.id) }));
    this.rebuild('edit');
  }

  private readonly onLabelLinkClick = (e: MouseEvent) => {
    const target = (e.target as HTMLElement | null)?.closest<HTMLElement>('.om3d-wikilink, .om3d-link');
    if (!target || !this.file) return;
    e.preventDefault();
    e.stopPropagation();
    const link = target.dataset.link, href = target.dataset.href;
    if (link) this.openLink(link, e);
    else if (href && /^(https?:|mailto:)/i.test(href)) window.open(href, '_blank', 'noopener');
    else if (href) this.openLink(decodeURIComponent(href), e);
  };

  /** Links to a heading of this note locate the node; anything else opens in Obsidian. */
  private openLink(linktext: string, event: MouseEvent): void {
    const file = this.file, model = this.model;
    if (!file || !model) return;
    const [path, ...headings] = linktext.split('#');
    const dest = path.trim() ? this.app.metadataCache.getFirstLinkpathDest(path.trim(), file.path) : file;
    if (dest?.path === file.path && headings.length && !headings[0].startsWith('^')) {
      const want = headings[headings.length - 1].trim().toLocaleLowerCase();
      let found: OutlineNode | null = null;
      walkPreorder(model.root, n => { if (!found && n.kind === 'heading' && n.text.trim().toLocaleLowerCase() === want) found = n; });
      if (found) { this.locate((found as OutlineNode).id, { history: true }); return; }
    }
    void this.app.workspace.openLinkText(linktext, file.path, Keymap.isModEvent(event));
  }

  /** Open the note in an editor (reusing one that shows it), at the node's line. */
  private async openInEditor(node: OutlineNode | null, newLeaf: ReturnType<typeof Keymap.isModEvent> = false): Promise<void> {
    const file = this.file;
    if (!file) return;
    const existing = this.app.workspace.getLeavesOfType('markdown').find(l => l.view instanceof MarkdownView && l.view.file?.path === file.path);
    const leaf = existing && !newLeaf ? existing : this.app.workspace.getLeaf(newLeaf || 'split');
    await leaf.openFile(file, { active: true, eState: node && node.kind !== 'root' ? { line: node.line } : undefined });
  }

  // --- editing -------------------------------------------------------------------------------
  private perform(op: (m: OutlineModel) => RunResult, select: 'target' | 'keep' = 'target'): RunResult | null {
    if (!this.sync) return null;
    const result = this.sync.perform(op);
    if (result.ok && result.edits.length && select === 'target' && result.targetId) this.select(result.targetId);
    return result;
  }

  private editorPosition(id: string): { x: number; y: number } | null {
    const i = this.indexOf(id);
    const p = i >= 0 ? this.screenAt(i) : null;
    return p ? { x: p.x + 14, y: p.y + 10 } : null;
  }

  private placeEditor(): void {
    const id = this.editor.editingId === NEW_NODE ? this.pending?.anchorId ?? null : this.editor.editingId;
    const p = id ? this.editorPosition(id) : null;
    if (p) this.editor.moveTo(p);
  }

  private beginCreate(kind: 'child' | 'sibling'): void {
    const model = this.model;
    if (!model || !this.sync) return;
    let anchor = this.selectedNode() ?? model.root;
    if (kind === 'sibling' && anchor.kind === 'root') kind = 'child';
    if (kind === 'child' && anchor.collapsed && anchor.children.length) { model.setCollapsed(anchor.id, false); this.persistCollapsed(); this.rebuild('expand'); }
    anchor = model.find(anchor.id) ?? model.root;
    this.pending = { kind, anchorId: anchor.id };
    this.sync.beginEditing();
    this.hover.hide();
    const shown = this.graph?.index.has(anchor.id) ? anchor.id : null;
    this.editor.open(NEW_NODE, '', shown ? this.editorPosition(shown) : null, t(kind === 'child' ? 'editor.newChild' : 'editor.newSibling'));
  }

  private beginRename(): void {
    const node = this.selectedNode();
    if (!node || node.kind === 'root' || !this.sync) return;
    this.pending = null;
    this.sync.beginEditing();
    this.hover.hide();
    this.editor.open(node.id, node.text, this.editorPosition(node.id));
  }

  private cancelEditor(): void {
    if (!this.editor?.editingId) return;
    this.editor.cancel();
    this.pending = null;
    this.sync?.endEditing();
  }

  private onEditorCommit(id: string, text: string, intent: CommitIntent, initial: string): void {
    this.sync?.endEditing();
    const pending = this.pending;
    this.pending = null;
    if (intent !== 'blur') this.stage.focus({ preventScroll: true });
    if (intent === 'escape') return;
    const clean = text.replace(/\s+/g, ' ').trim();
    if (id === NEW_NODE) {
      if (!pending || !clean) return;
      const result = this.perform(m => (pending.kind === 'child' ? m.addChild(pending.anchorId, clean) : m.addSibling(pending.anchorId, clean)));
      if (!result?.ok || !result.targetId) return;
      if (intent === 'enter') this.beginCreate('sibling');
      else if (intent === 'tab') this.beginCreate('child');
      else if (intent === 'shift-enter') this.inspector.beginNote();
      return;
    }
    if (clean && clean !== initial.replace(/\s+/g, ' ').trim()) this.perform(m => m.rename(id, clean), 'keep');
    if (intent === 'tab') this.beginCreate('child');
    else if (intent === 'shift-enter') this.inspector.beginNote();
  }

  private removeSelected(): void {
    const node = this.selectedNode();
    if (!node || node.kind === 'root') return;
    const count = descendantCount(node);
    const label = this.label(node.id);
    const siblings = node.parent?.children ?? [];
    const k = siblings.indexOf(node);
    const next = siblings[k - 1] ?? siblings[k + 1] ?? (node.parent && node.parent.kind !== 'root' ? node.parent : null);
    const run = () => {
      const result = this.perform(m => m.remove(node.id), 'keep');
      if (!result?.ok) return;
      this.select(next && this.graph?.index.has(next.id) ? next.id : null);
      this.status(count ? t('status.removedBranch', { label, count }) : t('status.removed', { label }));
    };
    if (count + 1 >= CONFIRM_DELETE_NODES) {
      new ConfirmModal(this.app, t('confirm.delete.title'), t('confirm.delete.message', { label, count }), t('confirm.delete.confirm'), run).open();
    } else run();
  }

  private structural(action: 'indent' | 'outdent' | 'moveUp' | 'moveDown'): void {
    const node = this.selectedNode();
    if (!node || node.kind === 'root') return;
    const id = node.id;
    this.perform(m => (action === 'indent' ? m.indent(id) : action === 'outdent' ? m.outdent(id) : m.move(id, action === 'moveUp' ? -1 : 1)), 'keep');
  }

  private undoRedo(redo: boolean): void {
    if (!this.sync || !this.model) return;
    const label = redo ? this.model.redoLabel : this.model.undoLabel;
    if (!label) { this.status(t(redo ? 'status.nothingToRedo' : 'status.nothingToUndo')); return; }
    const result = redo ? this.sync.redo() : this.sync.undo();
    if (result.ok) this.status(t(redo ? 'status.redone' : 'status.undone', { label }));
  }

  private toggleCollapse(expand?: boolean): void {
    const node = this.selectedNode();
    if (!node || !node.children.length || !this.model) return;
    const collapse = expand === undefined ? !node.collapsed : !expand;
    if (node.collapsed === collapse) return;
    this.model.setCollapsed(node.id, collapse);
    this.persistCollapsed();
    this.rebuild('expand');
  }

  private collapseToDepth(depth: number): void {
    if (!this.model) return;
    this.model.collapseToDepth(depth);
    this.persistCollapsed();
    this.rebuild('expand');
    this.status(t('status.levels', { count: depth }));
  }

  private expandAll(): void {
    if (!this.model) return;
    this.model.expandAll();
    this.persistCollapsed();
    this.rebuild('expand');
  }

  // --- plugin data: marks, associations, sizes, pinned positions -----------------------------
  private toggleMarkSelected(): void {
    const node = this.selectedNode(), file = this.file;
    if (!node || !file || node.kind === 'root') return;
    const result = toggleMark(this.host.store.getMarks(file.path), node);
    this.host.store.setMarks(file.path, result.marks);
    this.rebuild('settings', false);
    this.status(t(result.added ? 'status.marked' : 'status.unmarked', { label: this.label(node.id) }));
  }

  private nextMark(): void {
    const g = this.graph;
    if (!g || !g.markIds.size) return;
    const order = g.ids.map((id, i) => (g.markIds.has(id) ? i : -1)).filter(i => i >= 0);
    this.markCursor = (order.indexOf(this.indexOf(this.selectedId)) + 1) % order.length;
    this.locate(g.ids[order[this.markCursor]], { history: true });
  }

  private clearMarks(): void {
    const file = this.file;
    if (!file) return;
    const count = this.host.store.getMarks(file.path).length;
    new ConfirmModal(this.app, t('confirm.clearMarks.title'), t('confirm.clearMarks.message', { count }), t('confirm.clearMarks.confirm'), () => {
      this.host.store.setMarks(file.path, []);
      this.rebuild('settings', false);
    }).open();
  }

  private sameLink(a: StoredAssociation, b: StoredAssociation): boolean {
    return a.aPath === b.aPath && a.bPath === b.bPath && a.createdAt === b.createdAt;
  }

  private removeAssociation(link: StoredAssociation): void {
    const file = this.file;
    if (!file) return;
    this.host.store.setLinks(file.path, this.host.store.getLinks(file.path).filter(l => !this.sameLink(l, link)));
    this.rebuild('edit');
  }

  private toggleAssociationHidden(link: StoredAssociation): void {
    const file = this.file;
    if (!file) return;
    this.host.store.setLinks(file.path, this.host.store.getLinks(file.path).map(l => (this.sameLink(l, link) ? { ...l, hidden: !l.hidden } : l)));
    this.rebuild('edit');
  }

  private clearAssociations(): void {
    const file = this.file;
    if (!file) return;
    const count = this.host.store.getLinks(file.path).length;
    new ConfirmModal(this.app, t('confirm.clearAssociations.title'), t('confirm.clearAssociations.message', { count }), t('confirm.clearAssociations.confirm'), () => {
      this.host.store.setLinks(file.path, []);
      this.rebuild('edit');
    }).open();
  }

  private setSize(multiplier: number | null): void {
    const id = this.inspector.editingId ?? this.selectedId, file = this.file;
    const path = id && this.graph ? this.graph.pathIndex.pathOf(id) : null;
    if (!file || !path) return;
    this.host.store.setNodeSize(file.path, path, multiplier);
    this.rebuild('settings');
  }

  private releaseAnchor(): void {
    const id = this.selectedId, file = this.file;
    const path = id && this.graph ? this.graph.pathIndex.pathOf(id) : null;
    if (!id || !file || !path) return;
    this.host.store.setAnchor(file.path, this.settings.layout, path, null);
    this.engine.setAnchor(id, null);
    this.rebuild('settings', false);
  }

  private releaseAll(): void {
    const g = this.graph, file = this.file;
    if (!g || !file) return;
    this.host.store.clearAnchors(file.path, this.settings.layout);
    g.anchored.forEach((v, i) => { if (v) this.engine.setAnchor(g.ids[i], null); });
    this.rebuild('settings', false);
  }

  // --- arranging (dragging nodes) --------------------------------------------------------------
  private dragStart(index: number): boolean {
    const g = this.graph, file = this.file;
    if (!g || !file || index < 0 || index >= g.ids.length) return false;
    const previous = this.host.store.getAnchors(file.path, this.settings.layout)[g.paths[index]] ?? null;
    this.drag = { index, id: g.ids[index], plane: this.positionAt(index), previous };
    this.hover.hide();
    this.select(g.ids[index]);
    return true;
  }

  private dragMove(x: number, y: number): void {
    const d = this.drag, r = this.renderer;
    if (!d || !r) return;
    const world = r.screenToWorld(x, y, d.plane);
    if (world) { this.engine.drag(d.id, { x: world.x, y: world.y, z: world.z }); r.requestFrame(); }
  }

  private dragEnd(cancelled: boolean): void {
    const d = this.drag, file = this.file, g = this.graph;
    this.drag = null;
    if (!d || !file || !g) return;
    if (cancelled) {
      this.engine.release(d.id, d.previous ? { x: d.previous[0], y: d.previous[1], z: d.previous[2] } : null);
      return;
    }
    const p = this.engine.positionOf(d.id);
    if (!p) return;
    this.engine.release(d.id, p);
    this.host.store.setAnchor(file.path, this.settings.layout, g.paths[d.index], [p.x, p.y, p.z]);
    this.rebuild('settings', false);
    this.status(t('status.pinned', { label: this.label(d.id) }));
  }

  // --- actions -----------------------------------------------------------------------------------
  private escape(): void {
    if (Menu.isOpen) { Menu.closeAll(); return; }
    if (this.connectSource) { this.connectSource = null; this.updateEmphasis(); this.status(t('mode.connect.status')); return; }
    if (this.mode !== 'navigate') { this.setMode('navigate'); return; }
    if (this.search.isOpen) { this.search.close(); return; }
    if (this.focusId) { this.upLevel(); return; }
    if (this.selectedId) this.select(null);
  }

  runAction(action: ViewAction): void {
    const id = this.selectedId;
    switch (action) {
      case 'addChild': this.beginCreate('child'); break;
      case 'addSibling': this.beginCreate('sibling'); break;
      case 'rename': this.beginRename(); break;
      case 'editNote': if (id && this.selectedNode()?.kind !== 'root') this.inspector.beginNote(); break;
      case 'remove': this.removeSelected(); break;
      case 'indent': case 'outdent': case 'moveUp': case 'moveDown': this.structural(action); break;
      case 'undo': this.undoRedo(false); break;
      case 'redo': this.undoRedo(true); break;
      case 'toggleCollapse': this.toggleCollapse(); break;
      case 'expandAll': this.expandAll(); break;
      case 'overview': this.overview(); break;
      case 'enterBranch': if (id) this.enterBranch(id); break;
      case 'upLevel': this.upLevel(); break;
      case 'locate': if (id) this.locate(id, { history: true }); break;
      case 'toggleMark': this.toggleMarkSelected(); break;
      case 'nextMark': this.nextMark(); break;
      case 'clearMarks': this.clearMarks(); break;
      case 'rearrange': this.engine.rearrange(); this.renderer?.requestFrame(); if (this.engine.targets) this.frameAll(); else this.autoFit = true; break;
      case 'reheat': this.engine.reheat(); this.renderer?.requestFrame(); break;
      case 'releaseAll': this.releaseAll(); break;
      case 'resetCamera': this.pushHistory(); this.focusId = null; this.updateEmphasis(); this.frameAll({ orientation: this.defaultOrientation() }); this.afterNavigation(); break;
      case 'resetRoll': this.renderer?.rig.resetRoll(!this.reducedMotion); this.renderer?.requestFrame(); break;
      case 'background': this.openBackground(); break;
      case 'connect': this.setMode('connect'); break;
      case 'clearAssociations': this.clearAssociations(); break;
      case 'exportPng': void this.exportPng(); break;
      case 'openNote': void this.openInEditor(this.selectedNode()); break;
      case 'diagnostics': new DiagnosticsModal(this.app, this.diagnostics()).open(); break;
      case 'reload': this.reloadRenderer(); break;
      case 'settings': this.host.openSettings(); break;
    }
  }

  private openBackground(): void {
    const s = this.settings;
    new BackgroundModal(this.app, { mode: s.bgMode, top: s.bgTop, bottom: s.bgBottom, animated: s.animatedBackground === 'subtle' }, choice => {
      this.host.updateSettings({ bgMode: choice.mode, bgTop: choice.top, bgBottom: choice.bottom, animatedBackground: choice.animated ? 'subtle' : 'off' });
    }).open();
  }

  async exportPng(): Promise<void> {
    const r = this.renderer, file = this.file;
    if (!r || !file) return;
    if (!this.settings.enablePngExport) { new Notice(t('export.disabled')); return; }
    const url = r.exportPng(this.theme.background, this.theme.text, this.theme.background);
    if (!url) { new Notice(t('export.failed', { error: t('view.webglUnavailable') })); return; }
    const path = await this.host.exportPng(file.path, url);
    if (path) new Notice(t('export.done', { path }));
  }

  /** Counts and timings only (no note content): safe to share in an issue. */
  diagnostics(): Record<string, unknown> {
    const r = this.renderer, g = this.graph, e = this.engine;
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
    return {
      version: this.host.version,
      generatedAt: new Date().toISOString(),
      layout: this.settings.layout,
      nodes: { visible: g?.ids.length ?? 0, total: this.model?.stats.nodeCount ?? 0, maxDepth: this.model?.stats.maxDepth ?? 0 },
      edges: { hierarchy: g?.hierarchy.length ?? 0, chapterOrder: g?.documentOrder.length ?? 0, associations: g?.associations.length ?? 0, noteLinks: g?.noteLinks.length ?? 0 },
      physics: { backend: e.physicsBackend, diagnostics: e.physicsDiagnostics },
      layoutRun: e.lastRun ? { ms: Math.round(e.lastRun.ms * 100) / 100, overlap: e.lastRun.overlap, separation: e.lastRun.separation } : null,
      renderer: r ? {
        webgl: !r.unavailable, frames: r.stats.frames, renders: r.stats.renders, drawCalls: r.stats.drawCalls, triangles: r.stats.triangles,
        labelsShown: r.stats.labels, labelElements: r.stats.labelElements, frameMs: summarise(r.stats.recent), viewport: r.viewport,
        pixelRatio: r.renderer?.getPixelRatio() ?? 0,
      } : null,
      dom: { viewElements: this.contentEl.querySelectorAll('*').length },
      memoryMB: memory ? { used: Math.round(memory.usedJSHeapSize / 1048576), total: Math.round(memory.totalJSHeapSize / 1048576) } : null,
      sync: this.sync ? { ...this.sync.stats } : null,
      reducedMotion: this.reducedMotion,
    };
  }

  /** Recreate the WebGL renderer (recovery after a lost GPU context or driver problem). */
  private reloadRenderer(): void {
    const bookmark = this.renderer?.rig.bookmark() ?? null;
    this.interaction?.dispose();
    this.interaction = null;
    if (this.renderer) { this.renderer.labels.el.removeEventListener('click', this.onLabelLinkClick); this.renderer.dispose(); }
    this.engine.dispose();
    this.engine = new LayoutEngine(() => this.host.createPhysics(() => this.renderer?.requestFrame()));
    this.renderer = new SceneRenderer(this.stage, this.engine);
    this.renderer.rig.framePadding = FRAME_PADDING;
    this.renderer.beforeCamera = () => this.beforeCamera();
    this.renderer.afterFrame = moving => this.afterFrame(moving);
    this.renderer.labels.el.addEventListener('click', this.onLabelLinkClick);
    if (this.renderer.unavailable) this.showNotice(t('view.webglUnavailable'), true);
    else { this.hideNotice(); this.interaction = new Interaction(this.stage, this.interactionHost()); }
    this.applyAllSettings();
    if (bookmark) this.renderer.rig.restore(bookmark, 0);
    this.status(t('status.reloaded'));
  }

  // --- controllers for the interface components ------------------------------------------------
  private toolbarController(): ToolbarController {
    return {
      documentName: () => this.file?.basename ?? null,
      pickDocument: () => new NotePicker(this.app, this.file?.path ?? null, f => void this.bindFile(f)).open(),
      mode: () => this.mode,
      setMode: m => this.setMode(m),
      menu: group => buildMenu(group, this.menuHost()),
      history: () => ({ back: this.nav.canGoBack, forward: this.nav.canGoForward, backLabel: this.nav.peekBack()?.label ?? null, forwardLabel: this.nav.peekForward()?.label ?? null }),
      back: () => this.goHistory(-1),
      forward: () => this.goHistory(1),
      toggleSearch: () => this.toggleSearch(),
      togglePanel: panel => {
        if (panel === 'inspector' && this.narrow) {
          // Narrow pane: open or close for now without changing the saved preference.
          if (!this.inspector.isOpen) this.inspector.setOpen(true);
          this.inspector.el.toggleClass('is-pinned-open', !this.inspector.el.hasClass('is-pinned-open'));
          this.updateInsets();
          this.toolbar.sync();
        } else if (panel === 'inspector') this.host.updateSettings({ showInspector: !this.inspector.isOpen });
        else { this.outline.setOpen(!this.outline.isOpen); this.updateInsets(); this.toolbar.sync(); }
      },
      panelOpen: panel => (panel === 'outline' ? this.outline?.isOpen : this.inspectorVisible) ?? false,
    };
  }

  private menuHost(): MenuHost {
    const node = this.selectedNode(), g = this.graph, file = this.file, model = this.model;
    const view = this;
    return {
      get settings() { return view.settings; },
      update: patch => this.host.updateSettings(patch),
      run: action => this.runAction(action),
      collapseToDepth: depth => this.collapseToDepth(depth),
      setMode: mode => this.setMode(mode),
      state: {
        hasFile: !!model,
        selected: !!node,
        selectedIsRoot: node?.kind === 'root',
        selectedHasChildren: !!node?.children.length,
        selectedCollapsed: !!node?.collapsed && !!node.children.length,
        selectedMarked: !!node && !!g?.manualMarkIds.has(node.id),
        inBranch: !!this.focusId,
        canUndo: !!model?.canUndo,
        canRedo: !!model?.canRedo,
        undoLabel: model?.undoLabel ?? null,
        redoLabel: model?.redoLabel ?? null,
        anchoredCount: g ? g.anchored.reduce((a, v) => a + v, 0) : 0,
        associationCount: file ? this.host.store.getLinks(file.path).length : 0,
        markCount: g?.markIds.size ?? 0,
        physics: layoutInfo(this.settings.layout).physics,
        pngEnabled: this.settings.enablePngExport,
      },
    };
  }

  private inspectorController(): InspectorController {
    const target = () => this.inspector.editingId ?? this.selectedId;
    return {
      app: this.app,
      sourcePath: () => this.file?.path ?? '',
      rename: text => { const id = target(); if (id) this.perform(m => m.rename(id, text), 'keep'); },
      saveNote: text => { const id = target(); if (id) this.perform(m => (text.trim() ? m.setNote(id, text) : m.clearNote(id)), 'keep'); },
      clearNote: () => { const id = target(); if (id) this.perform(m => m.clearNote(id), 'keep'); },
      locate: id => this.locate(id, { history: true }),
      openLink: (linktext, event) => this.openLink(linktext, event),
      removeAssociation: link => this.removeAssociation(link),
      toggleAssociationHidden: link => this.toggleAssociationHidden(link),
      startConnect: () => {
        const source = this.selectedId;
        this.setMode('connect');
        if (source) { this.connectSource = source; this.updateEmphasis(); this.status(t('connect.pickSecond', { label: this.label(source) })); }
      },
      toggleMark: () => this.toggleMarkSelected(),
      setSize: multiplier => this.setSize(multiplier),
      releaseAnchor: () => this.releaseAnchor(),
      enterBranch: () => { if (this.selectedId) this.enterBranch(this.selectedId); },
      frame: () => { if (this.selectedId) this.locate(this.selectedId, { history: true }); },
      editingChanged: editing => {
        if (editing) this.sync?.beginEditing(); else this.sync?.endEditing();
        if (editing && this.narrow) this.inspector.el.addClass('is-pinned-open');
        this.toolbar.sync();
        this.updateInsets();
      },
    };
  }

  private interactionHost(): InteractionHost {
    return {
      mode: () => this.mode,
      pick: (x, y, exact) => {
        const r = this.renderer;
        if (!r || !this.engine.count) return null;
        const { width, height } = r.viewport;
        const hit = pickSphere(r.camera, x, y, width, height, this.engine.positions, this.engine.radii, this.engine.count, undefined, exact ? 0 : PICK_TOLERANCE_PX);
        return hit ? { index: hit.index, point: hit.point } : null;
      },
      hover: (index, at) => this.setHover(index, at),
      click: (index, event) => this.onClick(index, event),
      doubleClick: index => this.onDoubleClick(index),
      orbit: (dx, dy) => { this.renderer?.rig.orbit(dx, dy); this.renderer?.requestFrame(); },
      pan: (dx, dy) => { this.renderer?.rig.pan(dx, dy); this.renderer?.requestFrame(); },
      dolly: (steps, x, y, hit) => {
        const r = this.renderer;
        if (!r) return;
        const rig = r.rig;
        if (this.settings.zoomToCursor) {
          const point = hit?.point ?? r.screenToWorld(x, y, rig.pivot);
          rig.dolly(steps, point ?? undefined, hit ? this.engine.radii[hit.index] : 0);
        } else {
          const i = rig.pivotMode === 'selected' ? this.indexOf(this.selectedId) : -1;
          rig.dolly(steps, undefined, i >= 0 ? this.engine.radii[i] : 0);
        }
        r.requestFrame();
      },
      zoomFov: steps => { this.renderer?.rig.zoomFov(steps); this.renderer?.requestFrame(); },
      dragNodeStart: index => this.dragStart(index),
      dragNodeMove: (_index, x, y) => this.dragMove(x, y),
      dragNodeEnd: (_index, cancelled) => this.dragEnd(cancelled),
      history: direction => this.goHistory(direction),
      interacted: () => { this.autoFit = false; this.hover.hide(); },
    };
  }

  private keyboardHost(): KeyboardHost {
    return {
      undo: () => this.undoRedo(false),
      redo: () => this.undoRedo(true),
      search: () => this.search.open(),
      addChild: () => this.beginCreate('child'),
      addSibling: () => this.beginCreate('sibling'),
      editNote: () => this.runAction('editNote'),
      rename: () => this.beginRename(),
      remove: () => this.removeSelected(),
      toggleCollapse: expand => this.toggleCollapse(expand),
      indent: direction => this.structural(direction > 0 ? 'indent' : 'outdent'),
      move: delta => this.structural(delta < 0 ? 'moveUp' : 'moveDown'),
      select: direction => this.moveSelection(direction),
      typeJump: char => this.typeJump(char),
      escape: () => this.escape(),
      enterBranch: () => { if (this.selectedId) this.enterBranch(this.selectedId); },
      overview: () => this.overview(),
      history: direction => this.goHistory(direction),
      orbit: (dx, dy) => { this.renderer?.rig.orbit(dx, dy); this.renderer?.requestFrame(); },
      dolly: steps => { this.renderer?.rig.dolly(steps); this.renderer?.requestFrame(); },
    };
  }

  // --- outline pane bridge (core Outline view -> map) ----------------------------------------
  /** Locate the `occurrence`-th heading with this text (clicked in Obsidian's Outline pane). */
  revealHeading(text: string, occurrence: number): boolean {
    const model = this.model;
    if (!model) return false;
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    const want = norm(text);
    const matches: OutlineNode[] = [];
    walkPreorder(model.root, n => { if (n.kind === 'heading' && (norm(plainText(n.text)) === want || norm(n.text) === want)) matches.push(n); });
    const node = matches[Math.min(occurrence, matches.length - 1)];
    if (!node) return false;
    this.locate(node.id, { history: true });
    return true;
  }

  // --- entry points for plugin commands ---------------------------------------------------------
  toggleConnectMode(): void { this.setMode(this.mode === 'connect' ? 'navigate' : 'connect'); }
  history(direction: -1 | 1): void { this.goHistory(direction); }
  openSearch(): void { this.search.open(); }
  focusStage(): void { this.stage.focus({ preventScroll: true }); }

  /** 1.x "focus parent subtree": the selected branch, or the branch containing a selected leaf. */
  focusParentBranch(): void {
    const node = this.selectedNode();
    if (!node) return;
    const target = node.children.length ? node : node.parent && node.parent.kind !== 'root' ? node.parent : null;
    if (target) this.enterBranch(target.id);
  }

  /** Test and benchmark access (not part of the user interface). */
  get internals() {
    return { engine: this.engine, renderer: this.renderer, model: this.model, sync: this.sync, graph: this.graph, emphasis: this.emphasis, select: (id: string | null) => this.select(id), runAction: (a: ViewAction) => this.runAction(a) };
  }
}
