// WebGL scene and render loop for one view.
//
// Render on demand: a frame is drawn only when something changed (layout or
// physics motion, camera damping/animation, a style change, the optional
// background animation) -- a settled map costs no CPU or GPU time, and the
// loop stops entirely while the view is hidden. GPU buffers are uploaded only
// when positions or styles change. Frame timings are kept for diagnostics.
import {
  AmbientLight, BufferGeometry, DirectionalLight, Float32BufferAttribute, Line, LineDashedMaterial, PerspectiveCamera, Scene, Vector3, WebGLRenderer,
} from 'three';
import { CameraRig } from '../camera/camera-rig';
import type { LayoutEngine } from '../layout/layout-engine';
import { Background, type BackgroundSettings } from './background';
import { EdgeLayer } from './edge-layer';
import { LabelLayer, type LabelOptions } from './labels';
import { LinkLayer } from './link-layer';
import { NodeLayer } from './node-layer';

export interface FrameStats {
  frames: number;
  renders: number;
  lastFrameMs: number;
  /** Ring buffer of recent CPU frame times (ms). */
  recent: number[];
  drawCalls: number;
  triangles: number;
  labels: number;
  labelElements: number;
}

export class SceneRenderer {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(52, 1, 0.1, 10000);
  readonly rig: CameraRig;
  readonly nodes = new NodeLayer();
  readonly edges = new EdgeLayer();
  readonly links = new LinkLayer();
  readonly labels: LabelLayer;
  readonly background: Background;
  renderer: WebGLRenderer | null = null;
  canvas: HTMLCanvasElement | null = null;
  private guide: Line | null = null;
  private raf = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastTime = 0;
  private seenRevision = -1;
  private labelsDirty = true;
  private stylesDirty = false;
  private visible = true;
  private disposed = false;
  private wasMoving = false;
  private wasSettling = false;
  private width = 800;
  private height = 600;
  private resizeObserver: ResizeObserver | null = null;
  private intersection: IntersectionObserver | null = null;
  labelOptions: LabelOptions = { maxDistance: 2600, fontSize: 13, avoid: true, budget: 160 };
  showLabels = true;
  /** Called every frame before the camera updates (e.g. follow the selected node). */
  beforeCamera: (() => void) | null = null;
  /** Called after a frame in which the camera or positions changed. */
  afterFrame: ((moving: boolean) => void) | null = null;
  stats: FrameStats = { frames: 0, renders: 0, lastFrameMs: 0, recent: [], drawCalls: 0, triangles: 0, labels: 0, labelElements: 0 };
  unavailable = false;

  constructor(private readonly host: HTMLElement, readonly engine: LayoutEngine, onLabelClick?: (index: number, e: MouseEvent) => void) {
    this.rig = new CameraRig(this.camera);
    this.rig.nearestSurface = p => this.engine.nearestSurface(p.x, p.y, p.z);
    this.scene.add(new AmbientLight(0xffffff, 1.35));
    const key = new DirectionalLight(0xffffff, 1.5); key.position.set(320, 520, 420);
    const fill = new DirectionalLight(0xffffff, 0.55); fill.position.set(-380, -220, -300);
    this.scene.add(key, fill, this.nodes.group, this.edges.mesh, this.links.group);
    this.background = new Background(this.scene);
    try {
      this.renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
      const canvas = this.renderer.domElement;
      canvas.className = 'om3d-canvas';
      this.canvas = canvas;
      host.appendChild(canvas);
      canvas.addEventListener('webglcontextlost', this.onContextLost, false);
      canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);
    } catch (error) {
      console.error('[3D Mind Map] WebGL unavailable', error);
      this.unavailable = true;
    }
    this.labels = new LabelLayer(host, onLabelClick);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(host);
    }
    if (typeof IntersectionObserver !== 'undefined') {
      this.intersection = new IntersectionObserver(entries => this.setVisible(entries.some(e => e.isIntersecting)));
      this.intersection.observe(host);
    }
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize();
  }

  private readonly onContextLost = (event: Event) => { event.preventDefault(); this.cancelFrame(); };
  private readonly onContextRestored = () => { this.stylesDirty = true; this.seenRevision = -1; this.requestFrame(); };
  private readonly onVisibility = () => this.setVisible(document.visibilityState === 'visible' && this.host.isConnected);

  get viewport(): { width: number; height: number } { return { width: this.width, height: this.height }; }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible) { this.lastTime = 0; this.requestFrame(); } else this.cancelFrame();
  }

  resize(): void {
    const rect = this.host.getBoundingClientRect();
    this.width = Math.max(120, Math.floor(rect.width || 800));
    this.height = Math.max(120, Math.floor(rect.height || 600));
    const large = this.engine.count > 1500;
    this.renderer?.setPixelRatio(Math.min(large ? 1.5 : 2, globalThis.devicePixelRatio || 1));
    this.renderer?.setSize(this.width, this.height, false);
    this.rig.viewport = { width: this.width, height: this.height };
    this.rig.apply();
    this.edges.setPixelScale(this.camera.fov, this.height);
    this.links.setPixelScale(this.camera.fov, this.height);
    this.labelsDirty = true;
    this.requestFrame();
  }

  /** Mark styles (colours, emphasis, labels) as changed and draw. */
  invalidate(labels = true): void {
    this.stylesDirty = true;
    if (labels) this.labelsDirty = true;
    this.requestFrame();
  }

  /** Positions were replaced wholesale (new graph). */
  invalidatePositions(): void { this.seenRevision = -1; this.invalidate(); }

  requestFrame(): void {
    if (this.disposed || !this.visible || this.unavailable || this.raf) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.raf = requestAnimationFrame(this.frame);
  }

  private cancelFrame(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  setGuide(points: { x: number; y: number; z: number }[] | null, color: number, opacity: number): void {
    if (this.guide) { this.guide.removeFromParent(); this.guide.geometry.dispose(); (this.guide.material as LineDashedMaterial).dispose(); this.guide = null; }
    if (!points || points.length < 2) return;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(points.flatMap(p => [p.x, p.y, p.z]), 3));
    this.guide = new Line(geometry, new LineDashedMaterial({ color, dashSize: 14, gapSize: 10, transparent: true, opacity, depthWrite: false }));
    this.guide.computeLineDistances();
    this.guide.renderOrder = -2;
    this.scene.add(this.guide);
  }

  setBackground(settings: BackgroundSettings, reducedMotion: boolean): void {
    this.background.set(settings, reducedMotion);
    this.requestFrame();
  }

  private readonly frame = (now: number): void => {
    this.raf = 0;
    if (this.disposed || !this.visible || !this.renderer) return;
    const t0 = performance.now();
    const dt = this.lastTime ? Math.min(100, now - this.lastTime) : 16;
    this.lastTime = now;
    const engineMoved = this.engine.update(now);
    const positionsChanged = engineMoved || this.engine.revision !== this.seenRevision;
    if (positionsChanged) {
      this.seenRevision = this.engine.revision;
      const { positions, radii } = this.engine;
      this.nodes.setPositions(positions, radii);
      this.edges.setPositions(positions, radii);
      const b = this.engine.bounds();
      this.links.setPositions(positions, radii, b);
      this.rig.bounds = b;
      this.labelsDirty = true;
    }
    // Once the layout has come to rest, bend association curves around spheres in their way.
    const settling = this.engine.active;
    if (!settling && (this.wasSettling || positionsChanged) && this.links.linkCount) {
      const b = this.engine.bounds();
      this.links.avoidSpheres(this.engine.positions, this.engine.radii, b, this.engine.count);
      this.links.setPositions(this.engine.positions, this.engine.radii, b);
    }
    this.wasSettling = settling;
    this.beforeCamera?.();
    const cameraMoving = this.rig.update(dt, now);
    if (cameraMoving || this.wasMoving) this.labelsDirty = true;
    this.wasMoving = cameraMoving;
    if (this.background.animating) this.background.tick(now / 1000);
    this.renderer.render(this.scene, this.camera);
    this.stats.renders++;
    if (this.labelsDirty || this.stylesDirty) {
      if (this.showLabels) this.labels.update(this.camera, this.engine.positions, this.engine.radii, this.width, this.height, this.labelOptions);
      else this.labels.hideAll();
      this.labelsDirty = false;
      this.stylesDirty = false;
    }
    const info = this.renderer.info.render;
    this.stats.frames++;
    this.stats.drawCalls = info.calls;
    this.stats.triangles = info.triangles;
    this.stats.labels = this.labels.visibleCount;
    this.stats.labelElements = this.labels.allocated;
    this.stats.lastFrameMs = performance.now() - t0;
    this.stats.recent.push(this.stats.lastFrameMs);
    if (this.stats.recent.length > 240) this.stats.recent.shift();
    const moving = this.engine.active || cameraMoving;
    this.afterFrame?.(moving || positionsChanged);
    if (moving) this.requestFrame();
    else if (this.background.animating) {
      // Idle but animated background: ~15 fps is enough for a slow drift.
      this.timer = setTimeout(() => { this.timer = null; this.requestFrame(); }, 66);
    } else this.lastTime = 0;
  };

  /** Draw once synchronously and read the canvas (labels composited on top). */
  exportPng(background: string, textColor: string, strokeColor: string): string | null {
    if (!this.renderer || !this.canvas) return null;
    this.renderer.render(this.scene, this.camera);
    const source = this.canvas;
    const out = document.createElement('canvas');
    out.width = source.width; out.height = source.height;
    const ctx = out.getContext('2d');
    if (!ctx) return source.toDataURL('image/png');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(source, 0, 0);
    const scale = source.width / Math.max(1, this.width);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const label of this.labels.shownLabels()) {
      const size = Math.round(this.labelOptions.fontSize * scale);
      ctx.font = `${label.kind === 'heading' ? '600 ' : ''}${size}px sans-serif`;
      ctx.globalAlpha = Math.min(1, label.opacity + 0.2);
      const text = label.text.length > 60 ? `${label.text.slice(0, 59)}\u2026` : label.text;
      ctx.lineWidth = Math.max(2, size * 0.22);
      ctx.strokeStyle = strokeColor;
      ctx.strokeText(text, label.x * scale, label.y * scale);
      ctx.fillStyle = textColor;
      ctx.fillText(text, label.x * scale, label.y * scale);
    }
    ctx.globalAlpha = 1;
    return out.toDataURL('image/png');
  }

  /** World position under a pixel on the view plane through `through`. */
  screenToWorld(x: number, y: number, through: Vector3): Vector3 | null {
    const ndcX = (x / this.width) * 2 - 1, ndcY = -(y / this.height) * 2 + 1;
    const origin = this.camera.position.clone();
    const dir = new Vector3(ndcX, ndcY, 0.5).unproject(this.camera).sub(origin).normalize();
    const normal = this.camera.getWorldDirection(new Vector3());
    const denom = dir.dot(normal);
    if (Math.abs(denom) < 1e-6) return null;
    const t = through.clone().sub(origin).dot(normal) / denom;
    return t > 0 ? origin.addScaledVector(dir, t) : null;
  }

  /** Screen position (CSS px) of a world point, or null when behind the camera. */
  project(p: { x: number; y: number; z: number }): { x: number; y: number } | null {
    const v = new Vector3(p.x, p.y, p.z).project(this.camera);
    if (v.z > 1) return null;
    return { x: (v.x * 0.5 + 0.5) * this.width, y: (-v.y * 0.5 + 0.5) * this.height };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelFrame();
    this.resizeObserver?.disconnect();
    this.intersection?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.setGuide(null, 0, 0);
    this.nodes.dispose(); this.edges.dispose(); this.links.dispose(); this.background.dispose(); this.labels.dispose();
    if (this.canvas) {
      this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
      this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
      this.canvas.remove();
    }
    try { this.renderer?.dispose(); this.renderer?.forceContextLoss(); } catch { /* already lost */ }
    this.renderer = null;
  }
}
