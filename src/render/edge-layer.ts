// Straight edges (hierarchy and document order) as one instanced draw call.
//
// Each instance is a tapered tube from the parent's sphere surface to the
// child's (thicker at the parent = direction cue). Width is in world units
// with a minimum on-screen width so distant edges remain visible; such
// edges are made more transparent instead of growing thick. Dash patterns
// are measured along the edge, independent of distance.
import {
  CylinderGeometry, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, ShaderMaterial, Color,
} from 'three';
import { LINK_STYLE_PATTERNS, type LinkStyle } from '../persistence/settings';

export const DASH_MODE: Record<LinkStyle, number> = { solid: 0, dashed: 1, dotted: 2, dashdot: 3 };

export const EDGE_VERTEX = /* glsl */ `
attribute vec3 iStart;
attribute vec3 iEnd;
attribute float iRadius;
attribute vec4 iColor;
attribute float iDash;
uniform float uPixelScale;
uniform float uMinPixels;
varying vec4 vColor;
varying float vAlong;
varying float vDash;
void main() {
  vec3 dir = iEnd - iStart;
  float len = length(dir);
  vec3 d = len > 1e-5 ? dir / len : vec3(0.0, 1.0, 0.0);
  vec3 ref = abs(d.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 a = normalize(cross(d, ref));
  vec3 b = cross(d, a);
  float t = position.y + 0.5;
  vec3 centre = iStart + dir * t;
  float depth = max(1.0, -(modelViewMatrix * vec4(centre, 1.0)).z);
  float minR = 0.5 * uMinPixels * depth * uPixelScale;
  float r = max(iRadius, minR);
  vColor = vec4(iColor.rgb, iColor.a * clamp(iRadius / max(minR, 1e-4), 0.35, 1.0));
  vAlong = t * len;
  vDash = iDash;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(centre + (a * position.x + b * position.z) * r, 1.0);
}`;

export const EDGE_FRAGMENT = /* glsl */ `
uniform vec4 uPatterns[4];
varying vec4 vColor;
varying float vAlong;
varying float vDash;
void main() {
  int mode = int(vDash + 0.5);
  if (mode > 0) {
    vec4 p = uPatterns[mode];
    float m = mod(vAlong, p.x);
    float on = step(m, p.y);
    if (p.z > 0.0) on = max(on, step(p.x - p.z, m));
    if (on < 0.5) discard;
  }
  if (vColor.a < 0.01) discard;
  gl_FragColor = vec4(vColor.rgb, vColor.a);
}`;

export function dashUniform(): { value: number[] } {
  const v: number[] = [];
  for (const style of ['solid', 'dashed', 'dotted', 'dashdot'] as LinkStyle[]) {
    const p = LINK_STYLE_PATTERNS[style];
    v.push(p.period, p.on, p.on2 ?? 0, 0);
  }
  return { value: v };
}

export interface EdgeInstance { a: number; b: number; style: LinkStyle; color: number; alpha: number; width: number }

export class EdgeLayer {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private capacity = 0;
  private start!: InstancedBufferAttribute;
  private end!: InstancedBufferAttribute;
  private radius!: InstancedBufferAttribute;
  private color!: InstancedBufferAttribute;
  private dash!: InstancedBufferAttribute;
  private pairs = new Int32Array(0);
  private count = 0;
  readonly material: ShaderMaterial;
  private readonly tmp = new Color();

  constructor() {
    this.material = new ShaderMaterial({
      vertexShader: EDGE_VERTEX, fragmentShader: EDGE_FRAGMENT, transparent: true, depthWrite: false,
      uniforms: { uPixelScale: { value: 0.002 }, uMinPixels: { value: 1.1 }, uPatterns: dashUniform() },
    });
    this.mesh = new Mesh(new InstancedBufferGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    this.mesh.visible = false;
    this.allocate(64);
  }

  private readonly base = new CylinderGeometry(0.62, 1, 1, 6, 1, true);

  /** (Re)build the instanced geometry; the old one is disposed so GPU buffers are freed. */
  private allocate(capacity: number): void {
    this.capacity = capacity;
    const old = this.mesh.geometry;
    const g = new InstancedBufferGeometry();
    g.setIndex(this.base.index);
    g.setAttribute('position', this.base.getAttribute('position'));
    g.instanceCount = 0;
    this.mesh.geometry = g;
    old.dispose();
    const make = (size: number) => new InstancedBufferAttribute(new Float32Array(capacity * size), size).setUsage(DynamicDrawUsage);
    this.start = make(3); this.end = make(3); this.radius = make(1); this.color = make(4); this.dash = make(1);
    g.setAttribute('iStart', this.start); g.setAttribute('iEnd', this.end); g.setAttribute('iRadius', this.radius);
    g.setAttribute('iColor', this.color); g.setAttribute('iDash', this.dash);
  }

  get drawCalls(): number { return this.count ? 1 : 0; }
  get edgeCount(): number { return this.count; }

  /** Set the edge list (node indices) with style, colour, opacity and width. */
  private last: { positions: Float32Array; radii: Float32Array } | null = null;

  setEdges(edges: EdgeInstance[]): void {
    if (edges.length > this.capacity) this.allocate(2 ** Math.ceil(Math.log2(edges.length)));
    this.count = edges.length;
    this.pairs = new Int32Array(edges.length * 2);
    edges.forEach((e, k) => {
      this.pairs[k * 2] = e.a; this.pairs[k * 2 + 1] = e.b;
      this.tmp.setHex(e.color);
      this.color.array[k * 4] = this.tmp.r; this.color.array[k * 4 + 1] = this.tmp.g; this.color.array[k * 4 + 2] = this.tmp.b; this.color.array[k * 4 + 3] = e.alpha;
      this.radius.array[k] = e.width / 2;
      this.dash.array[k] = DASH_MODE[e.style];
    });
    this.color.needsUpdate = this.radius.needsUpdate = this.dash.needsUpdate = true;
    this.mesh.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this.last) this.setPositions(this.last.positions, this.last.radii);
  }

  /** Update colour/opacity of edge k (e.g. reading-path highlight or focus fading). */
  setStyle(k: number, color: number, alpha: number, width?: number): void {
    this.tmp.setHex(color);
    this.color.array[k * 4] = this.tmp.r; this.color.array[k * 4 + 1] = this.tmp.g; this.color.array[k * 4 + 2] = this.tmp.b; this.color.array[k * 4 + 3] = alpha;
    if (width !== undefined) this.radius.array[k] = width / 2;
  }

  commitStyles(): void { this.color.needsUpdate = true; this.radius.needsUpdate = true; }

  /** Recompute endpoints on the sphere surfaces; overlapping spheres hide their edge. */
  setPositions(positions: Float32Array, radii: Float32Array): void {
    this.last = { positions, radii };
    let maxIndex = -1;
    for (let k = 0; k < this.count * 2; k++) maxIndex = Math.max(maxIndex, this.pairs[k]);
    if (maxIndex * 4 >= positions.length) return; // positions of an older graph
    const s = this.start.array as Float32Array, e = this.end.array as Float32Array;
    for (let k = 0; k < this.count; k++) {
      const a = this.pairs[k * 2], b = this.pairs[k * 2 + 1];
      const ax = positions[a * 4], ay = positions[a * 4 + 1], az = positions[a * 4 + 2];
      const bx = positions[b * 4], by = positions[b * 4 + 1], bz = positions[b * 4 + 2];
      const dx = bx - ax, dy = by - ay, dz = bz - az;
      const len = Math.hypot(dx, dy, dz);
      const ra = radii[a], rb = radii[b];
      if (len <= ra + rb + 1e-3) { s[k * 3] = e[k * 3] = ax; s[k * 3 + 1] = e[k * 3 + 1] = ay; s[k * 3 + 2] = e[k * 3 + 2] = az; continue; }
      const ux = dx / len, uy = dy / len, uz = dz / len;
      s[k * 3] = ax + ux * ra; s[k * 3 + 1] = ay + uy * ra; s[k * 3 + 2] = az + uz * ra;
      e[k * 3] = bx - ux * rb; e[k * 3 + 1] = by - uy * rb; e[k * 3 + 2] = bz - uz * rb;
    }
    this.start.needsUpdate = true;
    this.end.needsUpdate = true;
  }

  /** World units per pixel at unit depth, for the minimum on-screen width. */
  setPixelScale(fovDeg: number, viewportHeight: number): void {
    this.material.uniforms.uPixelScale.value = (2 * Math.tan((fovDeg * Math.PI) / 360)) / Math.max(1, viewportHeight);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.base.dispose();
    this.material.dispose();
  }
}
