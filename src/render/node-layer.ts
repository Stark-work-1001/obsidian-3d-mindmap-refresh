// Spheres for all nodes in at most two instanced draw calls (solid and
// faded), however many nodes are emphasised.
//
// Emphasis is material-only: the sphere's own colour is added as emission
// (capped so hue and shading survive), and the selected node gets a rim
// inside its silhouette -- brighter on dark backgrounds, darker on light ones
// where brightening would vanish. No halo sprites, shells or bloom.
import {
  BufferGeometry, Color, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, MeshStandardMaterial, SphereGeometry,
} from 'three';

/** Emphasis levels; the strongest applicable level wins. */
export const EMPHASIS = { none: 0, path: 0.3, hover: 0.5, search: 0.7, mark: 0.75, selected: 1 } as const;

interface EmphasisUniforms { uGain: { value: number }; uLight: { value: number } }

function emphasisMaterial(opacity: number, uniforms: EmphasisUniforms): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: 0xffffff, roughness: 0.42, metalness: 0.06,
    transparent: opacity < 1, opacity, depthWrite: opacity >= 1,
  });
  material.onBeforeCompile = shader => {
    shader.uniforms.uGain = uniforms.uGain;
    shader.uniforms.uLight = uniforms.uLight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aEmphasis;\nattribute float aRim;\nvarying float vEmphasis;\nvarying float vRim;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEmphasis = aEmphasis;\nvRim = aRim;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGain;\nuniform float uLight;\nvarying float vEmphasis;\nvarying float vRim;')
      .replace('#include <emissivemap_fragment>', [
        '#include <emissivemap_fragment>',
        'float om3dRim = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 2.2) * vRim;',
        // Light backgrounds: deepen colour and darken the rim for contrast.
        'diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * (1.0 - 0.55 * om3dRim), uLight);',
        'vec3 om3dBoost = diffuseColor.rgb * min(0.9, vEmphasis * uGain * mix(1.0, 0.45, uLight));',
        'totalEmissiveRadiance += om3dBoost + (1.0 - uLight) * mix(diffuseColor.rgb, vec3(1.0), 0.45) * om3dRim * 0.8;',
      ].join('\n'));
  };
  material.customProgramCacheKey = () => `om3d-node-${opacity < 1 ? 'faded' : 'solid'}`;
  return material;
}

/** Sphere tessellation by node count (silhouette quality vs vertex cost). */
export function sphereDetail(count: number): [number, number] {
  return count <= 600 ? [24, 16] : count <= 1500 ? [18, 12] : [12, 8];
}

class Batch {
  readonly mesh: InstancedMesh;
  readonly emphasis: InstancedBufferAttribute;
  readonly rim: InstancedBufferAttribute;
  readonly color: InstancedBufferAttribute;
  constructor(geometry: BufferGeometry, material: MeshStandardMaterial, readonly capacity: number) {
    this.mesh = new InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.color = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(DynamicDrawUsage);
    this.mesh.instanceColor = this.color;
    this.emphasis = new InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(DynamicDrawUsage);
    this.rim = new InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }
  attach(geometry: BufferGeometry): void {
    geometry.setAttribute('aEmphasis', this.emphasis);
    geometry.setAttribute('aRim', this.rim);
  }
}

export class NodeLayer {
  readonly group = new Group();
  private readonly uniforms: EmphasisUniforms = { uGain: { value: 0.75 }, uLight: { value: 0 } };
  private readonly solidMaterial = emphasisMaterial(1, this.uniforms);
  private readonly fadedMaterial = emphasisMaterial(0.16, this.uniforms);
  private geometry: SphereGeometry | null = null;
  private solid: Batch | null = null;
  private faded: Batch | null = null;
  private count = 0;
  /** Per node: batch (0 solid, 1 faded) and slot inside it. */
  private batchOf = new Uint8Array(0);
  private slotOf = new Int32Array(0);
  private baseColor: Float32Array = new Float32Array(0);
  private level: Float32Array = new Float32Array(0);
  private selected: Uint8Array = new Uint8Array(0);
  private dimmed: Uint8Array = new Uint8Array(0);
  /** Last positions and radii, to rewrite transforms when nodes change batch. */
  private positions: Float32Array | null = null;
  private radii: Float32Array | null = null;
  private readonly tmp = new Color();

  constructor() {
    this.fadedMaterial.depthWrite = false;
  }

  get drawCalls(): number { return (this.solid?.mesh.count ? 1 : 0) + (this.faded?.mesh.count ? 1 : 0); }

  /** Allocate for `count` nodes with colours (0xRRGGBB). */
  setGraph(colors: ArrayLike<number>): void {
    const count = colors.length;
    const [ws, hs] = sphereDetail(count);
    const geometryKey = `${ws}x${hs}`;
    if (!this.geometry || this.geometry.userData.key !== geometryKey) {
      this.geometry?.dispose();
      this.geometry = new SphereGeometry(1, ws, hs);
      this.geometry.userData.key = geometryKey;
      this.disposeBatches();
    }
    if (!this.solid || this.solid.capacity < count) {
      this.disposeBatches();
      const capacity = Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(1, count))));
      const solidGeometry = this.geometry.clone(), fadedGeometry = this.geometry.clone();
      this.solid = new Batch(solidGeometry, this.solidMaterial, capacity);
      this.faded = new Batch(fadedGeometry, this.fadedMaterial, capacity);
      this.solid.attach(solidGeometry);
      this.faded.attach(fadedGeometry);
      this.faded.mesh.renderOrder = 1;
      this.group.add(this.solid.mesh, this.faded.mesh);
    }
    this.count = count;
    this.baseColor = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.tmp.setHex(colors[i]);
      this.baseColor[i * 3] = this.tmp.r; this.baseColor[i * 3 + 1] = this.tmp.g; this.baseColor[i * 3 + 2] = this.tmp.b;
    }
    this.level = new Float32Array(count);
    this.selected = new Uint8Array(count);
    this.dimmed = new Uint8Array(count);
    this.partition();
  }

  /** Assign nodes to the solid or faded batch and rewrite per-instance attributes. */
  private partition(): void {
    if (!this.solid || !this.faded) return;
    this.batchOf = new Uint8Array(this.count);
    this.slotOf = new Int32Array(this.count);
    let s = 0, f = 0;
    for (let i = 0; i < this.count; i++) {
      const batch = this.dimmed[i] ? this.faded : this.solid;
      const slot = this.dimmed[i] ? f++ : s++;
      this.batchOf[i] = this.dimmed[i] ? 1 : 0;
      this.slotOf[i] = slot;
      batch.color.array[slot * 3] = this.baseColor[i * 3];
      batch.color.array[slot * 3 + 1] = this.baseColor[i * 3 + 1];
      batch.color.array[slot * 3 + 2] = this.baseColor[i * 3 + 2];
      batch.emphasis.array[slot] = this.level[i];
      batch.rim.array[slot] = this.selected[i];
    }
    this.solid.mesh.count = s;
    this.faded.mesh.count = f;
    for (const b of [this.solid, this.faded]) { b.color.needsUpdate = true; b.emphasis.needsUpdate = true; b.rim.needsUpdate = true; }
    // Slots changed: transforms must follow their nodes into the new slots.
    if (this.positions && this.radii && this.positions.length >= this.count * 4 && this.radii.length >= this.count) this.setPositions(this.positions, this.radii);
  }

  /** Write sphere transforms (stride-4 positions) — called only when positions changed. */
  setPositions(positions: Float32Array, radii: Float32Array): void {
    this.positions = positions;
    this.radii = radii;
    if (!this.solid || !this.faded) return;
    const s = this.solid.mesh.instanceMatrix.array as Float32Array, f = this.faded.mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < this.count; i++) {
      const m = this.batchOf[i] ? f : s;
      const o = this.slotOf[i] * 16, r = radii[i];
      m[o] = r; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
      m[o + 4] = 0; m[o + 5] = r; m[o + 6] = 0; m[o + 7] = 0;
      m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = r; m[o + 11] = 0;
      m[o + 12] = positions[i * 4]; m[o + 13] = positions[i * 4 + 1]; m[o + 14] = positions[i * 4 + 2]; m[o + 15] = 1;
    }
    this.solid.mesh.instanceMatrix.needsUpdate = true;
    this.faded.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Emphasis level per node (0..1), selected flags and faded flags. */
  setState(level: Float32Array, selected: Uint8Array, dimmed: Uint8Array): void {
    let repartition = false;
    for (let i = 0; i < this.count; i++) if (dimmed[i] !== this.dimmed[i]) { repartition = true; break; }
    this.level = level; this.selected = selected; this.dimmed = dimmed;
    if (repartition) { this.partition(); return; }
    if (!this.solid || !this.faded) return;
    for (let i = 0; i < this.count; i++) {
      const b = this.batchOf[i] ? this.faded : this.solid;
      b.emphasis.array[this.slotOf[i]] = level[i];
      b.rim.array[this.slotOf[i]] = selected[i];
    }
    for (const b of [this.solid, this.faded]) { b.emphasis.needsUpdate = true; b.rim.needsUpdate = true; }
  }

  /** Emphasis strength (0-4 setting) and whether the background is light. */
  setAppearance(strength: number, lightBackground: boolean): void {
    this.uniforms.uGain.value = 0.3 + 0.45 * Math.min(2, Math.max(0, strength));
    if (strength <= 0) this.uniforms.uGain.value = 0;
    this.uniforms.uLight.value = lightBackground ? 1 : 0;
  }

  private disposeBatches(): void {
    for (const b of [this.solid, this.faded]) {
      if (!b) continue;
      b.mesh.removeFromParent();
      b.mesh.geometry.dispose();
      b.mesh.dispose();
    }
    this.solid = this.faded = null;
  }

  dispose(): void {
    this.disposeBatches();
    this.geometry?.dispose();
    this.solidMaterial.dispose();
    this.fadedMaterial.dispose();
  }
}
