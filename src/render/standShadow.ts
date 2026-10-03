import * as THREE from 'three';
import { FLOOD_POOL_GLSL, SHARED, STAND_EXT, STAND_HMAX, STAND_MAP_GLSL, SUN_DIR } from './look';
import { PITCH_SIZE_X, PITCH_SIZE_Z } from './pitch';
import { StripBake } from './stripBake';

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
/** The layer a bake's share of the casters is put on (the bake camera sees only it). */
const BAKE_LAYER = 31;

export class StandShadow {
  // Two maps: the one shown, and the one being baked (a share of the ground a frame).
  private rts = [0, 1].map(
    () =>
      new THREE.WebGLRenderTarget(W, H, {
        // One channel (the height) is all that's read: a quarter of the memory and bandwidth.
        format: THREE.RedFormat,
        depthBuffer: false,
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      }),
  );
  private front = 0;
  /** The bake in progress: what casts, and how far through it is (-1: none). */
  private casters: THREE.Mesh[] = [];
  private next = -1;
  private chunk = 1;
  /** The last bake was for a new ground (done in one go). */
  fresh = true;
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
  private cam = (() => {
    const c = new THREE.OrthographicCamera(-1e4, 1e4, 1e4, -1e4, -1e4, 1e4);
    c.layers.set(BAKE_LAYER);
    return c;
  })();
  private group: THREE.Object3D | null = null;
  private clear = new THREE.Color();
  private saved: { o: THREE.Object3D; visible: boolean; material?: THREE.Material | THREE.Material[] }[] = [];
  /** Counts bakes (GroundLight follows it). */
  version = 0;

  constructor() {
    SHARED.uStandMap.value = this.rts[0].texture;
  }

  /** Re-bakes if the ground or the sun has changed. `on`: false when there's no sun to cast. */
  /** Whether update() will bake this frame. */
  due(group: THREE.Object3D, on: boolean): boolean {
    return this.next >= 0 || (on && (group !== this.group || this.uSun.value.angleTo(SUN_DIR) >= REBAKE));
  }

  /**
   * Re-bakes if the ground or the sun has changed. `on`: false when there's no sun to cast.
   * A new ground is baked at once; the sun moving on is baked into the back map a twelfth of
   * the casters a frame (max blending: the order doesn't matter), then swapped in, with the
   * sun direction it was baked for (all at once in one frame cost a phone ~6 ms of GPU).
   */
  update(renderer: THREE.WebGLRenderer, group: THREE.Object3D, on: boolean): void {
    if (this.next < 0) {
      if (!this.due(group, on)) return;
      this.fresh = group !== this.group;
      this.group = group;
      this.uSun.value.copy(SUN_DIR);
      this.casters.length = 0;
      this.collect(group, false);
      this.next = 0;
      this.chunk = this.fresh ? this.casters.length : Math.ceil(this.casters.length / 12);
    } else if (group !== this.group) {
      // The ground changed mid-bake: start again for the new one.
      this.next = -1;
      return this.update(renderer, group, on);
    }
    const back = this.rts[1 - this.front];
    this.draw(renderer, back, this.next === 0, this.next, Math.min(this.casters.length, this.next + this.chunk));
    this.next += this.chunk;
    if (this.next < this.casters.length) return;
    this.next = -1;
    this.front = 1 - this.front;
    SHARED.uStandMap.value = back.texture;
    SHARED.uStandSun.value.copy(this.uSun.value);
    this.version++;
  }

  /**
   * What casts: what's solid and showing (userData.noStandShadow opts out), and what's only
   * hidden from the camera (userData.castsHidden: the near stand while the view is at
   * ground level): its shadow is there either way.
   */
  private collect(o: THREE.Object3D, parentShown: boolean | null): void {
    let show = (parentShown !== false || o === this.group) && (o.visible || !!o.userData.castsHidden);
    if (o.userData.noStandShadow) show = false;
    if (!show) return;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (!m.transparent && m.depthWrite) this.casters.push(mesh);
    }
    if ((o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as THREE.Sprite).isSprite) return;
    for (const c of o.children) this.collect(c, true);
  }

  /** Casters [from, to) into `rt` (cleared first with `clear`). */
  private draw(renderer: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget, clear: boolean, from: number, to: number): void {
    const group = this.group!;
    // Only this share of the casters is drawn (on the bake camera's layer, in the bake
    // material); everything is made visible so the walk reaches them wherever they sit.
    group.traverse((o) => {
      this.saved.push({ o, visible: o.visible });
      o.visible = true;
    });
    for (let i = from; i < to; i++) {
      const c = this.casters[i];
      this.saved.push({ o: c, visible: true, material: c.material });
      c.material = this.mat;
      c.layers.enable(BAKE_LAYER);
    }
    const prevTarget = renderer.getRenderTarget();
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clear);
    renderer.setRenderTarget(rt);
    if (clear) {
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, false, false);
    }
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(group, this.cam);
    renderer.autoClear = autoClear;
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(this.clear, prevAlpha);
    for (let i = this.saved.length - 1; i >= 0; i--) {
      const s = this.saved[i];
      if (s.material) {
        (s.o as THREE.Mesh).material = s.material;
        s.o.layers.disable(BAKE_LAYER);
      } else s.o.visible = s.visible;
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
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  // Twelve bands, one a frame (a whole bake in one frame cost a phone ~6 ms of GPU).
  private bake = new StripBake(
    () =>
      new THREE.WebGLRenderTarget(1120, 784, {
        type: THREE.HalfFloatType,
        format: THREE.RGFormat,
        depthBuffer: false,
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      }),
    12,
    this.scene,
    this.cam,
  );
  /** The bake in progress is for new floodlights (or the first): done in one go. */
  private all = true;
  private key = { version: -1, soft: -1, lamps: null as unknown, n: -1, norm: -1 };

  constructor() {
    SHARED.uGroundLight.value = this.bake.texture;
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

  /** Whether update() will bake this frame (given the stands as they are now). */
  due(stands: StandShadow): boolean {
    const k = this.key;
    return this.bake.busy || !(k.version === stands.version && Math.abs(SHARED.uStandSoft.value - k.soft) < 0.02 && k.lamps === SHARED.uLamps.value && k.n === SHARED.uLampN.value && k.norm === SHARED.uLampNorm.value);
  }

  update(renderer: THREE.WebGLRenderer, stands: StandShadow): void {
    if (!this.bake.busy) {
      if (!this.due(stands)) return;
      const k = this.key;
      // A new ground or new floodlights: all at once (it shows straight away). The sun
      // moving on: a band a frame.
      this.all = k.lamps !== SHARED.uLamps.value || k.n !== SHARED.uLampN.value || k.norm !== SHARED.uLampNorm.value || stands.fresh;
      k.version = stands.version;
      k.soft = SHARED.uStandSoft.value;
      k.lamps = SHARED.uLamps.value;
      k.n = SHARED.uLampN.value;
      k.norm = SHARED.uLampNorm.value;
      this.bake.start();
    }
    if (this.bake.step(renderer, this.all)) SHARED.uGroundLight.value = this.bake.texture;
  }
}
