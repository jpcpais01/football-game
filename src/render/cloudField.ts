import * as THREE from 'three';
import { CLOUD_SPAN, SHARED, STAND_SHADOW_GLSL } from './look';
import { StripBake } from './stripBake';

/**
 * The drifting cloud shadows' noise, baked. The field never changes shape, it only slides
 * with the (constant) wind, so it's rendered once into a texture around where the clouds
 * are now and every lit surface reads it with one fetch. As the wind carries it off, the
 * window is re-centred (a bake every few minutes, a band a frame into a back buffer).
 *
 * 1024 texels over 24 units: ~1.5 m of ground per texel, against clouds whose edges blur over
 * tens of metres; the noise is stored before its smoothstep, so the edges keep their shape.
 */
const SIZE = 1024;
/** How far the clouds may drift from the window's centre before it's re-centred. */
const RECENTRE = 4;

export class CloudField {
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private bake = new StripBake(
    () =>
      new THREE.WebGLRenderTarget(SIZE, SIZE, {
        type: THREE.HalfFloatType,
        format: THREE.RedFormat,
        depthBuffer: false,
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      }),
    8,
    this.scene,
    this.cam,
  );
  /** The window shown (as the lookup uses it), and the one being baked. */
  private origin = new THREE.Vector2(1e6, 1e6);
  private bakeOrigin = new THREE.Vector2();
  private drift = new THREE.Vector2();

  constructor() {
    SHARED.uCloudMap.value = this.bake.texture;
    const mat = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: { ...SHARED, uTimeC: SHARED.uTime, uBakeOrigin: { value: this.bakeOrigin } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `
        ${STAND_SHADOW_GLSL}
        uniform vec2 uBakeOrigin;
        varying vec2 vUv;
        void main() {
          // Texel centres land exactly where the lookup in cloudShadow samples them.
          gl_FragColor = vec4(cloudField(uBakeOrigin + (vUv - 0.5) * ${CLOUD_SPAN.toFixed(1)}), 0.0, 0.0, 1.0);
        }`,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  /** Whether update() will bake this frame. */
  due(): boolean {
    if (this.bake.busy) return true;
    if (SHARED.uClouds.value <= 0) return false;
    // Where the field has slid to (as cloudShadow works it out).
    this.drift.copy(SHARED.uWind.value).multiplyScalar(SHARED.uTime.value * 0.012);
    return Math.abs(this.drift.x + this.origin.x) >= RECENTRE || Math.abs(this.drift.y + this.origin.y) >= RECENTRE;
  }

  update(renderer: THREE.WebGLRenderer): void {
    if (!this.bake.busy) {
      if (!this.due()) return;
      // The lookup is q - origin with q = ground * 0.016 - drift: centre the window on -drift
      // (RECENTRE leaves the clouds plenty of room to drift while the old window is shown).
      this.bakeOrigin.set(-Math.round(this.drift.x), -Math.round(this.drift.y));
      this.bake.start();
    }
    // The very first window has nothing to stand in for it: all at once.
    if (this.bake.step(renderer, this.origin.x === 1e6)) {
      this.origin.copy(this.bakeOrigin);
      SHARED.uCloudOrigin.value.copy(this.origin);
      SHARED.uCloudMap.value = this.bake.texture;
    }
  }
}
