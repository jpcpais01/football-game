import * as THREE from 'three';
import { FLOOD_POOL_GLSL, SHARED, STAND_EXT, STAND_HMAX, STAND_MAP_GLSL, SUN_DIR } from './look';
import { PITCH_SIZE_X, PITCH_SIZE_Z } from './pitch';

/**
 * The ground's shadow on the pitch, baked rather than shadow-mapped every frame.
 *
 * Every opaque mesh of the ground (stands, roofs, pylons, gantry, boards) is drawn once,
 * squashed flat along the sunlight onto the ground plane, into a top-down map. Each texel
 * keeps the height of the highest thing on its sun ray (max blending), so anything - the
 * grass, a player's head, a fan in the top tier - is in shade exactly when something
 * stands higher on its own ray toward the sun (STAND_MAP_GLSL). The real roofline, the open
 * corners and the floodlight pylons all land on the grass, for one cheap texture read.
 *
 * Re-baked only when the ground is rebuilt or the sun has moved a fraction of a degree
 * (the evening sun drifts all match: a bake every few seconds).
 */
const W = 2048;
const H = 1600;
/** Sun movement (radians) that earns a new bake: ~0.2°, well under a pixel at the touchline. */
const REBAKE = 0.0035;

export class StandShadow {
  private rt = new THREE.WebGLRenderTarget(W, H, {
    // One channel (the height) is all that's read: a quarter of the memory and bandwidth.
    format: THREE.RedFormat,
    depthBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  private uSun = { value: new THREE.Vector3() };
  private mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.MaxEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    uniforms: { uSun: this.uSun },
    vertexShader: /* glsl */ `
      uniform vec3 uSun;
      varying float vH;
      void main() {
        vec4 wp = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
        #endif
        wp = modelMatrix * wp;
        vH = wp.y;
        // Follow the sunlight down to the ground.
        vec2 g = wp.xz - uSun.xz * (max(wp.y, 0.0) / uSun.y);
        gl_Position = vec4(g / vec2(${STAND_EXT.x.toFixed(1)}, ${STAND_EXT.z.toFixed(1)}), 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vH;
      void main() { gl_FragColor = vec4(clamp(vH / ${STAND_HMAX.toFixed(1)}, 0.0, 1.0), 0.0, 0.0, 1.0); }
    `,
  });
  /** Sees the whole world: the vertex shader does its own projection. */
  private cam = new THREE.OrthographicCamera(-1e4, 1e4, 1e4, -1e4, -1e4, 1e4);
  private group: THREE.Object3D | null = null;
  private clear = new THREE.Color();
  private saved: { o: THREE.Object3D; visible: boolean; material?: THREE.Material | THREE.Material[] }[] = [];
  /** Counts bakes (GroundLight follows it). */
  version = 0;

  constructor() {
    SHARED.uStandMap.value = this.rt.texture;
  }

  /** Re-bakes if the ground or the sun has changed. `on`: false when there's no sun to cast. */
  update(renderer: THREE.WebGLRenderer, group: THREE.Object3D, on: boolean): void {
    if (!on) return;
    if (group === this.group && this.uSun.value.angleTo(SUN_DIR) < REBAKE) return;
    this.group = group;
    this.uSun.value.copy(SUN_DIR);
    SHARED.uStandSun.value.copy(SUN_DIR);
    this.bake(renderer, group);
    this.version++;
  }

  private bake(renderer: THREE.WebGLRenderer, group: THREE.Object3D): void {
    // What's solid and showing casts (userData.noStandShadow opts out), and so does what's
    // only hidden from the camera (userData.castsHidden: the near stand while the view is at
    // ground level): its shadow is there either way.
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      let show = o.visible || !!o.userData.castsHidden;
      if (o.userData.noStandShadow) show = false;
      if (mesh.isMesh) {
        const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        this.saved.push({ o, visible: o.visible, material: mesh.material });
        o.visible = show && !m.transparent && m.depthWrite;
        mesh.material = this.mat;
      } else {
        this.saved.push({ o, visible: o.visible });
        o.visible = show && !(o as THREE.Points).isPoints && !(o as THREE.Line).isLine && !(o as THREE.Sprite).isSprite;
      }
    });
    const prevTarget = renderer.getRenderTarget();
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clear);
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, false, false);
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(group, this.cam);
    renderer.autoClear = autoClear;
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(this.clear, prevAlpha);
    for (const s of this.saved) {
      s.o.visible = s.visible;
      if (s.material) (s.o as THREE.Mesh).material = s.material;
    }
    this.saved.length = 0;
  }
}

/**
 * The light on the grass that only changes with the sun or the ground: the stands' soft
 * shadow (six taps of the stand map and five smoothsteps) and the floodlight pools (a loop
 * over every bank), baked over the pitch quad instead of worked out for every grass pixel
 * every frame. r = stand shadow (before uStandOn), g = floodlight pool.
 * Re-baked when the stand map is, when the penumbra has widened a little, or for new banks.
 */
export class GroundLight {
  // ~11 cm texels: well inside the 0.3-1.5 m penumbra and the 10-15 m pool ramps.
  private rt = new THREE.WebGLRenderTarget(1120, 784, {
    type: THREE.HalfFloatType,
    format: THREE.RGFormat,
    depthBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private key = { version: -1, soft: -1, lamps: null as unknown, n: -1, norm: -1 };

  constructor() {
    SHARED.uGroundLight.value = this.rt.texture;
    const mat = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: { ...SHARED },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `
        ${STAND_MAP_GLSL}
        ${FLOOD_POOL_GLSL}
        varying vec2 vUv;
        void main() {
          // The pitch quad's own mapping (as its noise textures).
          vec2 p = (vUv - 0.5) * vec2(${PITCH_SIZE_X.toFixed(2)}, ${PITCH_SIZE_Z.toFixed(2)});
          float pool = clamp(0.1 + 0.9 * floodPool(vec3(p.x, 0.0, p.y)), 0.45, 1.8);
          gl_FragColor = vec4(standShadowGroundRaw(p), pool, 0.0, 1.0);
        }`,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  update(renderer: THREE.WebGLRenderer, stands: StandShadow): void {
    const k = this.key;
    const soft = SHARED.uStandSoft.value;
    if (k.version === stands.version && Math.abs(soft - k.soft) < 0.02 && k.lamps === SHARED.uLamps.value && k.n === SHARED.uLampN.value && k.norm === SHARED.uLampNorm.value) return;
    k.version = stands.version;
    k.soft = soft;
    k.lamps = SHARED.uLamps.value;
    k.n = SHARED.uLampN.value;
    k.norm = SHARED.uLampNorm.value;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.render(this.scene, this.cam);
    renderer.setRenderTarget(prev);
  }
}
