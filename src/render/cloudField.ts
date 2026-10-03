import * as THREE from 'three';
import { CLOUD_SPAN, SHARED, STAND_SHADOW_GLSL } from './look';

/**
 * The drifting cloud shadows' noise, baked. The field never changes shape, it only slides
 * with the (constant) wind, so it's rendered once into a texture around where the clouds
 * are now and every lit surface reads it with one fetch. As the wind carries it off, the
 * window is re-centred (a quick bake every few minutes).
 *
 * 1024 texels over 24 units: ~1.5 m of ground per texel, against clouds whose edges blur over
 * tens of metres; the noise is stored before its smoothstep, so the edges keep their shape.
 */
const SIZE = 1024;
/** How far the clouds may drift from the window's centre before it's re-centred. */
const RECENTRE = 4;

export class CloudField {
  private rt = new THREE.WebGLRenderTarget(SIZE, SIZE, {
    type: THREE.HalfFloatType,
    format: THREE.RedFormat,
    depthBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private origin = new THREE.Vector2(1e6, 1e6);
  private drift = new THREE.Vector2();

  constructor() {
    SHARED.uCloudMap.value = this.rt.texture;
    const mat = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: { ...SHARED, uTimeC: SHARED.uTime, uBakeOrigin: { value: this.origin } },
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

  update(renderer: THREE.WebGLRenderer): void {
    if (SHARED.uClouds.value <= 0) return;
    // Where the field has slid to (as cloudShadow works it out).
    this.drift.copy(SHARED.uWind.value).multiplyScalar(SHARED.uTime.value * 0.012);
    if (Math.abs(this.drift.x + this.origin.x) < RECENTRE && Math.abs(this.drift.y + this.origin.y) < RECENTRE) return;
    // The lookup is q - origin with q = ground * 0.016 - drift: centre the window on -drift.
    this.origin.set(-Math.round(this.drift.x), -Math.round(this.drift.y));
    SHARED.uCloudOrigin.value.copy(this.origin);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.render(this.scene, this.cam);
    renderer.setRenderTarget(prev);
  }
}
