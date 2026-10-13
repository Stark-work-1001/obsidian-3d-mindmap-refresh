// Curved relationship links: user associations and note links between nodes
// of the same note. Each link is a quadratic Bezier tube evaluated in the
// vertex shader (one draw call for all links); note links get an arrowhead at
// the target (one more draw call). Control points bulge away from the graph
// centre; for small sets the bulge grows until the curve clears other spheres.
import {
  ConeGeometry, CylinderGeometry, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, ShaderMaterial, Color,
} from 'three';
import { dashUniform, DASH_MODE, EDGE_FRAGMENT } from './edge-layer';
import type { LinkStyle } from '../persistence/settings';

const CURVE_VERTEX = /* glsl */ `
attribute vec3 iStart;
attribute vec3 iControl;
attribute vec3 iEnd;
attribute float iRadius;
attribute vec4 iColor;
attribute float iDash;
attribute float iLength;
uniform float uPixelScale;
uniform float uMinPixels;
varying vec4 vColor;
varying float vAlong;
varying float vDash;
void main() {
  float t = position.y + 0.5;
  float u = 1.0 - t;
  vec3 p = u * u * iStart + 2.0 * u * t * iControl + t * t * iEnd;
  vec3 tangent = 2.0 * u * (iControl - iStart) + 2.0 * t * (iEnd - iControl);
  vec3 d = length(tangent) > 1e-5 ? normalize(tangent) : vec3(0.0, 1.0, 0.0);
  vec3 n = cross(iEnd - iStart, iControl - iStart);
  n = length(n) > 1e-5 ? normalize(n) : (abs(d.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0));
  vec3 a = normalize(cross(d, n));
  vec3 b = cross(d, a);
  float depth = max(1.0, -(modelViewMatrix * vec4(p, 1.0)).z);
  float minR = 0.5 * uMinPixels * depth * uPixelScale;
  float r = max(iRadius, minR);
  vColor = vec4(iColor.rgb, iColor.a * clamp(iRadius / max(minR, 1e-4), 0.45, 1.0));
  vAlong = t * iLength;
  vDash = iDash;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p + (a * position.x + b * position.z) * r, 1.0);
}`;

const ARROW_VERTEX = /* glsl */ `
attribute vec3 iTip;
attribute vec3 iDir;
attribute float iSize;
attribute vec4 iColor;
varying vec4 vColor;
varying float vAlong;
varying float vDash;
void main() {
  vec3 d = normalize(iDir);
  vec3 ref = abs(d.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 a = normalize(cross(d, ref));
  vec3 b = cross(d, a);
  // Cone geometry: apex at +y/2, base at -y/2 (height 1, radius 1).
  vec3 local = a * position.x * iSize + b * position.z * iSize + d * (position.y - 0.5) * iSize * 2.4;
  vColor = iColor; vAlong = 0.0; vDash = 0.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(iTip + local, 1.0);
}`;

export interface LinkInstance {
  a: number;
  b: number;
  color: number;
  alpha: number;
  width: number;
  style: LinkStyle;
  /** Arrowhead at `b` (note links point from the linking node to the target). */
  arrow: boolean;
  /** Relative bulge (fraction of the distance between endpoints). */
  bulge: number;
}

function attr(capacity: number, size: number): InstancedBufferAttribute {
  return new InstancedBufferAttribute(new Float32Array(Math.max(1, capacity) * size), size).setUsage(DynamicDrawUsage);
}

export class LinkLayer {
  readonly group = new Group();
  private readonly curveBase = new CylinderGeometry(1, 1, 1, 6, 24, true);
  private readonly arrowBase = new ConeGeometry(1, 1, 8, 1, false);
  private readonly curveMaterial = new ShaderMaterial({
    vertexShader: CURVE_VERTEX, fragmentShader: EDGE_FRAGMENT, transparent: true, depthWrite: false,
    uniforms: { uPixelScale: { value: 0.002 }, uMinPixels: { value: 1.2 }, uPatterns: dashUniform() },
  });
  private readonly arrowMaterial = new ShaderMaterial({
    vertexShader: ARROW_VERTEX, fragmentShader: EDGE_FRAGMENT, transparent: true, depthWrite: false,
    uniforms: { uPatterns: dashUniform() },
  });
  private readonly curves = new Mesh(new InstancedBufferGeometry(), this.curveMaterial);
  private readonly arrows = new Mesh(new InstancedBufferGeometry(), this.arrowMaterial);
  private links: LinkInstance[] = [];
  private bulges = new Float32Array(0);
  private readonly tmp = new Color();
  /** Last positions, so a new link list is placed immediately (not at the origin). */
  private last: { positions: Float32Array; radii: Float32Array; centre: { x: number; y: number; z: number } } | null = null;

  constructor() {
    for (const m of [this.curves, this.arrows]) { m.frustumCulled = false; m.visible = false; m.renderOrder = 1; }
    this.group.add(this.curves, this.arrows);
  }

  get drawCalls(): number { return (this.curves.visible ? 1 : 0) + (this.arrows.visible ? 1 : 0); }
  get linkCount(): number { return this.links.length; }

  setLinks(links: LinkInstance[]): void {
    this.links = links;
    this.bulges = Float32Array.from(links, l => l.bulge);
    const n = links.length, arrows = links.filter(l => l.arrow).length;
    const curve = new InstancedBufferGeometry();
    curve.setIndex(this.curveBase.index);
    curve.setAttribute('position', this.curveBase.getAttribute('position'));
    for (const [name, size] of [['iStart', 3], ['iControl', 3], ['iEnd', 3], ['iRadius', 1], ['iColor', 4], ['iDash', 1], ['iLength', 1]] as const) curve.setAttribute(name, attr(n, size));
    curve.instanceCount = n;
    const arrow = new InstancedBufferGeometry();
    arrow.setIndex(this.arrowBase.index);
    arrow.setAttribute('position', this.arrowBase.getAttribute('position'));
    for (const [name, size] of [['iTip', 3], ['iDir', 3], ['iSize', 1], ['iColor', 4]] as const) arrow.setAttribute(name, attr(arrows, size));
    arrow.instanceCount = arrows;
    this.curves.geometry.dispose(); this.arrows.geometry.dispose();
    this.curves.geometry = curve; this.arrows.geometry = arrow;
    const color = curve.getAttribute('iColor') as InstancedBufferAttribute, radius = curve.getAttribute('iRadius') as InstancedBufferAttribute, dash = curve.getAttribute('iDash') as InstancedBufferAttribute;
    const arrowColor = arrow.getAttribute('iColor') as InstancedBufferAttribute, arrowSize = arrow.getAttribute('iSize') as InstancedBufferAttribute;
    let k = 0;
    links.forEach((l, i) => {
      this.tmp.setHex(l.color);
      color.setXYZW(i, this.tmp.r, this.tmp.g, this.tmp.b, l.alpha);
      radius.setX(i, l.width / 2);
      dash.setX(i, DASH_MODE[l.style]);
      if (l.arrow) { arrowColor.setXYZW(k, this.tmp.r, this.tmp.g, this.tmp.b, Math.min(1, l.alpha + 0.15)); arrowSize.setX(k, Math.max(1.5, l.width * 1.6)); k++; }
    });
    this.curves.visible = n > 0;
    this.arrows.visible = arrows > 0;
    if (this.last && this.last.positions.length >= Math.max(0, ...links.map(l => Math.max(l.a, l.b) + 1)) * 4) this.setPositions(this.last.positions, this.last.radii, this.last.centre);
  }

  /** Update colour, opacity and width in place; false when the links themselves differ. */
  restyle(links: LinkInstance[]): boolean {
    if (links.length !== this.links.length || links.some((l, i) => l.a !== this.links[i].a || l.b !== this.links[i].b || l.arrow !== this.links[i].arrow || l.bulge !== this.links[i].bulge)) return false;
    const g = this.curves.geometry, ag = this.arrows.geometry;
    const color = g.getAttribute('iColor') as InstancedBufferAttribute, radius = g.getAttribute('iRadius') as InstancedBufferAttribute, dash = g.getAttribute('iDash') as InstancedBufferAttribute;
    const arrowColor = ag.getAttribute('iColor') as InstancedBufferAttribute, arrowSize = ag.getAttribute('iSize') as InstancedBufferAttribute;
    let k = 0;
    links.forEach((l, i) => {
      this.tmp.setHex(l.color);
      color.setXYZW(i, this.tmp.r, this.tmp.g, this.tmp.b, l.alpha);
      radius.setX(i, l.width / 2);
      dash.setX(i, DASH_MODE[l.style]);
      if (l.arrow) { arrowColor.setXYZW(k, this.tmp.r, this.tmp.g, this.tmp.b, Math.min(1, l.alpha + 0.15)); arrowSize.setX(k, Math.max(1.5, l.width * 1.6)); k++; }
    });
    for (const a of [color, radius, dash, arrowColor, arrowSize]) a.needsUpdate = true;
    this.links = links;
    return true;
  }

  /** Recompute curve endpoints, control points and arrows from node positions. */
  setPositions(positions: Float32Array, radii: Float32Array, centre: { x: number; y: number; z: number }): void {
    this.last = { positions, radii, centre };
    const g = this.curves.geometry, ag = this.arrows.geometry;
    if (!this.links.length) return;
    const start = g.getAttribute('iStart') as InstancedBufferAttribute, control = g.getAttribute('iControl') as InstancedBufferAttribute;
    const end = g.getAttribute('iEnd') as InstancedBufferAttribute, length = g.getAttribute('iLength') as InstancedBufferAttribute;
    const tip = ag.getAttribute('iTip') as InstancedBufferAttribute, dir = ag.getAttribute('iDir') as InstancedBufferAttribute;
    let k = 0;
    this.links.forEach((l, i) => {
      const ax = positions[l.a * 4], ay = positions[l.a * 4 + 1], az = positions[l.a * 4 + 2];
      const bx = positions[l.b * 4], by = positions[l.b * 4 + 1], bz = positions[l.b * 4 + 2];
      const dx = bx - ax, dy = by - ay, dz = bz - az;
      const dist = Math.max(1e-3, Math.hypot(dx, dy, dz));
      // Bulge direction: away from the graph centre, perpendicular to the link.
      const mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2;
      let ox = mx - centre.x, oy = my - centre.y, oz = mz - centre.z;
      const along = (ox * dx + oy * dy + oz * dz) / (dist * dist);
      ox -= dx * along; oy -= dy * along; oz -= dz * along;
      let ol = Math.hypot(ox, oy, oz);
      if (ol < 1e-6) { ox = -dz; oy = 0; oz = dx; ol = Math.hypot(ox, oy, oz) || 1; if (ol < 1e-6) { ox = 0; oy = 1; oz = 0; ol = 1; } }
      const bend = this.bulges[i] * dist;
      const cx = mx + (ox / ol) * bend, cy = my + (oy / ol) * bend, cz = mz + (oz / ol) * bend;
      // Trim the ends to the sphere surfaces along the curve's end tangents.
      const trim = (px: number, py: number, pz: number, qx: number, qy: number, qz: number, r: number): [number, number, number] => {
        const tx = qx - px, ty = qy - py, tz = qz - pz, tl = Math.hypot(tx, ty, tz) || 1;
        return [px + (tx / tl) * r, py + (ty / tl) * r, pz + (tz / tl) * r];
      };
      const s = trim(ax, ay, az, cx, cy, cz, radii[l.a]);
      const e = trim(bx, by, bz, cx, cy, cz, radii[l.b] + (l.arrow ? Math.max(1.5, l.width * 1.6) * 2.4 : 0));
      start.setXYZ(i, s[0], s[1], s[2]);
      control.setXYZ(i, cx, cy, cz);
      end.setXYZ(i, e[0], e[1], e[2]);
      length.setX(i, dist * (1 + this.bulges[i] * 0.6));
      if (l.arrow) {
        const t = trim(bx, by, bz, cx, cy, cz, radii[l.b]);
        tip.setXYZ(k, t[0], t[1], t[2]);
        dir.setXYZ(k, bx - cx, by - cy, bz - cz);
        k++;
      }
    });
    for (const a of [start, control, end, length, tip, dir]) a.needsUpdate = true;
  }

  /**
   * Increase each link's bulge until its curve clears other spheres (small
   * sets only: cost is links x nodes). Call after layout settles.
   */
  avoidSpheres(positions: Float32Array, radii: Float32Array, centre: { x: number; y: number; z: number }, count: number): void {
    // Bounded: at most ~8 M distance tests, run once when the layout comes to rest.
    if (this.links.length > 60 || this.links.length * count > 120000) return;
    const factors = [1, 1.7, 2.6, 3.8, 5.2];
    this.links.forEach((l, i) => {
      const ax = positions[l.a * 4], ay = positions[l.a * 4 + 1], az = positions[l.a * 4 + 2];
      const bx = positions[l.b * 4], by = positions[l.b * 4 + 1], bz = positions[l.b * 4 + 2];
      const dx = bx - ax, dy = by - ay, dz = bz - az, dist = Math.max(1e-3, Math.hypot(dx, dy, dz));
      const mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2;
      let ox = mx - centre.x, oy = my - centre.y, oz = mz - centre.z;
      const along = (ox * dx + oy * dy + oz * dz) / (dist * dist);
      ox -= dx * along; oy -= dy * along; oz -= dz * along;
      const ol = Math.hypot(ox, oy, oz) || 1;
      for (const f of factors) {
        const bend = l.bulge * f * dist;
        const cx = mx + (ox / ol) * bend, cy = my + (oy / ol) * bend, cz = mz + (oz / ol) * bend;
        let clear = true;
        for (let s = 1; s < 14 && clear; s++) {
          const t = s / 14, u = 1 - t;
          const px = u * u * ax + 2 * u * t * cx + t * t * bx, py = u * u * ay + 2 * u * t * cy + t * t * by, pz = u * u * az + 2 * u * t * cz + t * t * bz;
          for (let n = 0; n < count; n++) {
            if (n === l.a || n === l.b) continue;
            const r = radii[n] * 1.6 + l.width;
            const qx = positions[n * 4] - px, qy = positions[n * 4 + 1] - py, qz = positions[n * 4 + 2] - pz;
            if (qx * qx + qy * qy + qz * qz < r * r) { clear = false; break; }
          }
        }
        this.bulges[i] = l.bulge * f;
        if (clear) break;
      }
    });
  }

  setPixelScale(fovDeg: number, viewportHeight: number): void {
    this.curveMaterial.uniforms.uPixelScale.value = (2 * Math.tan((fovDeg * Math.PI) / 360)) / Math.max(1, viewportHeight);
  }

  dispose(): void {
    this.curves.geometry.dispose(); this.arrows.geometry.dispose();
    this.curveBase.dispose(); this.arrowBase.dispose();
    this.curveMaterial.dispose(); this.arrowMaterial.dispose();
  }
}
