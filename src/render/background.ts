// Scene background: theme colour, solid colour, two-colour vertical gradient,
// and an optional slow "aurora" drift of the gradient.
//
// The animation is subordinate to the graph: low contrast (it only shifts the
// gradient's own two colours), no parallax and no depth cues, ~15 fps, paused
// while the view is hidden, and disabled under prefers-reduced-motion.
import { Color, Mesh, PlaneGeometry, ShaderMaterial, type Scene } from 'three';

export interface BackgroundSettings { mode: 'theme' | 'solid' | 'gradient'; top: string; bottom: string; theme: string; animated: boolean }

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.9999, 1.0); }`;

const FRAGMENT = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uBottom;
uniform float uTime;
uniform float uAnimated;
varying vec2 vUv;
void main() {
  float y = vUv.y;
  if (uAnimated > 0.5) {
    // Two broad, slow waves bend the blend line by a few percent of the height.
    y += 0.035 * sin(uTime * 0.11 + vUv.x * 2.1) + 0.02 * sin(uTime * 0.07 - vUv.x * 3.3 + 1.7);
  }
  vec3 colour = mix(uBottom, uTop, smoothstep(0.0, 1.0, y));
  // Ordered dithering hides 8-bit banding in long gradients.
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  gl_FragColor = vec4(colour + n / 255.0, 1.0);
}`;

export class Background {
  private readonly material = new ShaderMaterial({
    vertexShader: VERTEX, fragmentShader: FRAGMENT, depthTest: false, depthWrite: false,
    uniforms: { uTop: { value: new Color() }, uBottom: { value: new Color() }, uTime: { value: 0 }, uAnimated: { value: 0 } },
  });
  private readonly quad = new Mesh(new PlaneGeometry(2, 2), this.material);
  private settings: BackgroundSettings | null = null;
  private reducedMotion = false;

  constructor(private readonly scene: Scene) {
    this.quad.frustumCulled = false;
    this.quad.renderOrder = -1000;
    this.quad.visible = false;
    scene.add(this.quad);
  }

  /** True when frames must keep coming for the animation. */
  get animating(): boolean { return !!this.settings?.animated && this.settings.mode === 'gradient' && !this.reducedMotion; }

  set(settings: BackgroundSettings, reducedMotion: boolean): void {
    this.settings = settings;
    this.reducedMotion = reducedMotion;
    const safe = (c: string, fallback: string) => { try { return new Color(c); } catch { return new Color(fallback); } };
    if (settings.mode === 'gradient' && settings.top !== settings.bottom) {
      this.scene.background = null;
      this.material.uniforms.uTop.value.copy(safe(settings.top, '#ffffff'));
      this.material.uniforms.uBottom.value.copy(safe(settings.bottom, '#222222'));
      this.material.uniforms.uAnimated.value = this.animating ? 1 : 0;
      this.quad.visible = true;
    } else {
      this.quad.visible = false;
      this.scene.background = safe(settings.mode === 'theme' ? settings.theme : settings.top, '#202020');
    }
  }

  tick(seconds: number): void { this.material.uniforms.uTime.value = seconds; }

  dispose(): void {
    this.quad.removeFromParent();
    this.quad.geometry.dispose();
    this.material.dispose();
  }
}
