import * as THREE from 'three';

/**
 * "Evening Kickoff" art direction in one place.
 *
 * The match is set between late afternoon and evening: a low warm sun with real soft
 * shadows, the floodlights quietly coming up as the match goes on, warm highlights and
 * slightly cool shadows. Everything that changes with the time of day reads from the shared
 * uniforms below (driven by Atmosphere), so every material stays in sync.
 */

/** Direction the sunlight travels (from the sun toward the ground). Mutated by Atmosphere. */
export const SUN_DIR = new THREE.Vector3(0.42, -0.55, -0.72).normalize();

/** Floodlight banks at the roof corners (x, z); also used for the faint floodlight shadows. */
export const PYLONS: [number, number][] = [
  [-65.3, -45.8],
  [65.3, -45.8],
  [-65.3, 45.8],
  [65.3, 45.8],
];

/** The stands' shadow map (see standShadow.ts): its ground area (half extents, m) and the
 * height (m) its 0..1 texels span. */
export const STAND_EXT = { x: 130, z: 100 };
export const STAND_HMAX = 64;
/** Width of the baked cloud window, in cloud-space units (one is 62.5 m of ground). */
export const CLOUD_SPAN = 24;
/** Floodlight banks a ground can hand the pitch for its light pools (see floodLamps). */
export const MAX_LAMPS = 12;

export const SHARED = {
  /** Height of the highest thing on each ground point's sun ray (standShadow.ts). */
  uStandMap: { value: null as THREE.Texture | null },
  /** The sun direction the map was baked for: lookups must project along the same ray. */
  uStandSun: { value: new THREE.Vector3(0, -1, 0) },
  /** Depth of the stands' shade (0 = no stand shadow: a night match, no sun). */
  uStandOn: { value: 0 },
  /** Width (m) of the shadow's soft edge on the grass: wider when the sun is low. */
  uStandSoft: { value: 0.4 },
  /** The grass's baked light over the pitch quad: r = stand shadow, g = floodlight pool (GroundLight). */
  uGroundLight: { value: null as THREE.Texture | null },
  /** Floodlight banks (xyz) and where each is aimed (xyz of uLampAim), uLampN of them,
   * uLampNorm scaling their light to an average of 1 over the pitch (0 banks = even light). */
  uLamps: { value: Array.from({ length: MAX_LAMPS }, () => new THREE.Vector3()) },
  uLampAim: { value: Array.from({ length: MAX_LAMPS }, () => new THREE.Vector3()) },
  uLampN: { value: 0 },
  uLampNorm: { value: 1 },
  /** 0 = floodlights off, 1 = full evening floodlighting. */
  uFlood: { value: 0 },
  /** Dew on the grass late in the match (sheen). */
  uDew: { value: 0 },
  /** Cool ambient that fills the shaded side. */
  uShadeTint: { value: new THREE.Color(0x9fb0cc) },
  /** Floodlight colour (slightly cool white). */
  uFloodColor: { value: new THREE.Color(0xe8eeff) },
  uTime: { value: 0 },
  /** The one shared wind (xz direction × strength): grass, flags, banners, particles. */
  uWind: { value: new THREE.Vector2(0.85, 0.35) },
  /** Strength of drifting cloud shadows on the pitch (sunny ≈ 1). */
  uClouds: { value: 0.5 },
  /** The cloud field baked around uCloudOrigin (cloud space; see CloudField). */
  uCloudMap: { value: null as THREE.Texture | null },
  uCloudOrigin: { value: new THREE.Vector2(1e6, 1e6) },
  /** 0 = dry, 1 = pouring: wet, darker grass with standing water, beams through the rain. */
  uRain: { value: 0 },
  /** Sun colour for the warm rim light. */
  uSunColor: { value: new THREE.Color(0xffe2b8) },
};

export const COLORS = {
  fog: 0xd9cdb6,
  sun: 0xffe2b8,
  hemiSky: 0xcfdcf5,
  hemiGround: 0x5b6a3f,
};

/**
 * GLSL: the stands' baked shadow. `standShadow(p)`: 0 = in the sun, uStandOn = in the shade
 * of something standing higher on p's sun ray (the roofs, the stands, a pylon, a board), so
 * the grass, a player's head and a seat all agree. `standShadowGroundRaw` is the grass version,
 * with a soft edge.
 */
export const STAND_MAP_GLSL = /* glsl */ `
uniform sampler2D uStandMap;
uniform vec3 uStandSun;
uniform float uStandOn;
uniform float uStandSoft;
vec2 standUv(vec2 g) { return g / vec2(${(STAND_EXT.x * 2).toFixed(1)}, ${(STAND_EXT.z * 2).toFixed(1)}) + 0.5; }
float standShadow(vec3 wp) {
  if (uStandOn <= 0.0) return 0.0;
  float y = max(wp.y, 0.0);
  vec2 uv = standUv(wp.xz - uStandSun.xz * (y / uStandSun.y));
  if (abs(uv.x - 0.5) > 0.5 || abs(uv.y - 0.5) > 0.5) return 0.0;
  float h = texture2D(uStandMap, uv).r * ${STAND_HMAX.toFixed(1)};
  return smoothstep(y + 0.35, y + 0.9, h) * uStandOn;
}
/** The grass's soft stand shadow before uStandOn (baked per sun position: see GroundLight). */
float standShadowGroundRaw(vec2 p) {
  vec2 uv = standUv(p);
  vec2 r = uStandSoft / vec2(${(STAND_EXT.x * 2).toFixed(1)}, ${(STAND_EXT.z * 2).toFixed(1)});
  // Anything over ~0.4 m on the ray shades the grass; five taps make the penumbra.
  const float T0 = ${(0.25 / STAND_HMAX).toFixed(5)}, T1 = ${(0.6 / STAND_HMAX).toFixed(5)};
  float s = smoothstep(T0, T1, texture2D(uStandMap, uv).r) * 2.0;
  s += smoothstep(T0, T1, texture2D(uStandMap, uv + r * vec2(0.8, 0.6)).r);
  s += smoothstep(T0, T1, texture2D(uStandMap, uv + r * vec2(-0.6, 0.8)).r);
  s += smoothstep(T0, T1, texture2D(uStandMap, uv + r * vec2(-0.8, -0.6)).r);
  s += smoothstep(T0, T1, texture2D(uStandMap, uv + r * vec2(0.6, -0.8)).r);
  return s / 6.0;
}
`;

/** GLSL: the stands' shadow (STAND_MAP_GLSL) and the drifting cloud shadows. */
export const STAND_SHADOW_GLSL = /* glsl */ `
uniform vec2 uWind;
uniform float uClouds;
uniform float uTimeC;
float cHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float cNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(cHash(i), cHash(i + vec2(1, 0)), u.x), mix(cHash(i + vec2(0, 1)), cHash(i + vec2(1, 1)), u.x), u.y);
}
/** Soft shadows of clouds drifting over the ground with the wind (0 = clear, 1 = shaded). */
uniform sampler2D uCloudMap;
uniform vec2 uCloudOrigin;
float cloudField(vec2 q) { return cNoise(q) * 0.65 + cNoise(q * 2.3 + 7.1) * 0.35; }
float cloudShadow(vec3 wp) {
  if (uClouds <= 0.0) return 0.0; // clear sky (rain, dusk): skip the noise
  // The field only slides with the wind: read it from its bake (one fetch instead of eight
  // hashes), worked out live only beyond the baked window.
  vec2 q = wp.xz * 0.016 - uWind * uTimeC * 0.012;
  vec2 t = (q - uCloudOrigin) / ${CLOUD_SPAN.toFixed(1)} + 0.5;
  float n = max(abs(t.x - 0.5), abs(t.y - 0.5)) < 0.499 ? texture2D(uCloudMap, t).r : cloudField(q);
  return smoothstep(0.5, 0.72, n) * uClouds;
}
${STAND_MAP_GLSL}
`;

/**
 * GLSL: the floodlight pools on the grass. Each bank is aimed at its own patch of the pitch,
 * so its light lands as a soft, stretched pool; where they overlap the grass is brightest.
 * Averages 1 over the pitch (even light when the ground has no banks).
 */
export const FLOOD_POOL_GLSL = /* glsl */ `
uniform vec3 uLamps[${MAX_LAMPS}];
uniform vec3 uLampAim[${MAX_LAMPS}];
uniform float uLampN;
uniform float uLampNorm;
float floodPool(vec3 p) {
  if (uLampN < 0.5) return 1.0;
  float e = 0.0;
  for (int i = 0; i < ${MAX_LAMPS}; i++) {
    if (float(i) >= uLampN) break;
    vec3 d = uLamps[i] - p;
    float r2 = dot(d, d);
    vec3 l = d * inversesqrt(r2);
    float beam = smoothstep(0.8, 0.96, dot(-l, uLampAim[i]));
    e += l.y / r2 * (0.3 + beam);
  }
  return e * uLampNorm;
}
`;

/** Floodlight banks as the pitch's light pools see them: positions, aims, normalisation. */
export interface FloodLamps {
  pos: THREE.Vector3[];
  aim: THREE.Vector3[];
  n: number;
  norm: number;
}

/** Aims each bank at a patch of the pitch on its own side, and scales the lot to average 1. */
export function floodLamps(spots: THREE.Vector3[]): FloodLamps {
  const n = Math.min(MAX_LAMPS, spots.length);
  const pos = Array.from({ length: MAX_LAMPS }, (_, i) => (i < n ? spots[i].clone() : new THREE.Vector3()));
  const aim = pos.map((p, i) => (i < n ? new THREE.Vector3(p.x * 0.4, 0, p.z * 0.32).sub(p).normalize() : new THREE.Vector3()));
  // Same sum as FLOOD_POOL_GLSL, averaged over the pitch.
  const d = new THREE.Vector3();
  let sum = 0;
  let count = 0;
  for (let x = -50; x <= 50; x += 5) {
    for (let z = -32; z <= 32; z += 4) {
      for (let i = 0; i < n; i++) {
        d.set(pos[i].x - x, pos[i].y, pos[i].z - z);
        const r2 = d.lengthSq();
        d.divideScalar(Math.sqrt(r2));
        const c = -d.dot(aim[i]);
        const t = Math.min(1, Math.max(0, (c - 0.8) / 0.16));
        sum += (d.y / r2) * (0.3 + t * t * (3 - 2 * t));
      }
      count++;
    }
  }
  return { pos, aim, n, norm: sum > 0 ? count / sum : 1 };
}

/** Hands the pitch a ground's floodlight banks (null: no banks, even light). */
export function useFloodLamps(l: FloodLamps | null): void {
  SHARED.uLampN.value = l ? l.n : 0;
  if (!l) return;
  SHARED.uLamps.value = l.pos;
  SHARED.uLampAim.value = l.aim;
  SHARED.uLampNorm.value = l.norm;
}

/** Shared uniform declarations for custom ShaderMaterials that want the evening look. */
export function sharedUniforms(): Record<string, { value: unknown }> {
  return { ...SHARED, uTimeC: SHARED.uTime } as unknown as Record<string, { value: unknown }>;
}

export interface LitOptions {
  color?: number;
  vertexColors?: boolean;
  roughness?: number;
  metalness?: number;
  /** Darken toward the ground (cheap ambient occlusion for players). */
  groundAO?: boolean;
  /** Extra GLSL run at the end of diffuse colour setup (has vUv, vWorldPos, diffuseColor). */
  diffuseHook?: string;
  /** Extra declarations for the fragment shader (attributes are passed as varyings). */
  fragDecl?: string;
  /** Extra vertex declarations / body (runs after worldpos). */
  vertDecl?: string;
  vertBody?: string;
  /** Extra uniforms. */
  uniforms?: Record<string, { value: unknown }>;
  emissive?: number;
}

/**
 * Soft physically-based material with the evening extras:
 * - no direct sun inside the stand's shadow (so the real shadow map fades there too),
 * - cool sky fill in the shade, floodlight wash from above as the evening comes,
 * - optional ground occlusion and a soft warm rim so players read against the grass.
 */
export function litMaterial(o: LitOptions = {}): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: o.color ?? 0xffffff,
    vertexColors: o.vertexColors ?? false,
    roughness: o.roughness ?? 0.82,
    metalness: o.metalness ?? 0,
    emissive: o.emissive ?? 0x000000,
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, SHARED, { uTimeC: SHARED.uTime }, o.uniforms ?? {});
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWorldPos;\nvarying vec2 vUv2;\n${o.vertDecl ?? ''}`)
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vec4 wpos = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          wpos = instanceMatrix * wpos;
        #endif
        vWorldPos = (modelMatrix * wpos).xyz;
        vUv2 = uv;
        ${o.vertBody ?? ''}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vWorldPos;
        varying vec2 vUv2;
        uniform float uFlood;
        uniform float uDew;
        uniform vec3 uShadeTint;
        uniform vec3 uFloodColor;
        uniform float uTime;
        uniform vec3 uSunColor;
        ${STAND_SHADOW_GLSL}
        ${o.fragDecl ?? ''}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        ${o.diffuseHook ?? ''}`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        {
          float sh = standShadow(vWorldPos);
          float sun = (1.0 - sh) * (1.0 - cloudShadow(vWorldPos) * 0.42);
          reflectedLight.directDiffuse *= sun;
          reflectedLight.directSpecular *= sun;
          vec3 wn = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
          // Bright sky fill in the shade (blue, luminous), floodlight wash in the evening.
          reflectedLight.indirectDiffuse += diffuseColor.rgb * uShadeTint * sh * 0.45;
          reflectedLight.indirectDiffuse += diffuseColor.rgb * uFloodColor * uFlood * (0.55 + 0.45 * wn.y) * 0.55;
          ${o.groundAO ? 'float ao = mix(0.62, 1.0, smoothstep(0.0, 0.6, vWorldPos.y)); reflectedLight.indirectDiffuse *= ao; reflectedLight.directDiffuse *= mix(0.85, 1.0, ao);' : ''}
          ${o.groundAO ? 'float rim = pow(1.0 - max(dot(normal, normalize(vViewPosition)), 0.0), 2.5); reflectedLight.indirectDiffuse += mix(diffuseColor.rgb, uSunColor, 0.55) * rim * (0.32 * sun + uFlood * 0.15);' : ''}
        }`,
      );
  };
  // The shader code depends on the options: key the compiled program on them, or every
  // litMaterial would share the first one compiled (three keys on the callback's source).
  const key = JSON.stringify([o.groundAO, o.diffuseHook, o.fragDecl, o.vertDecl, o.vertBody]);
  mat.customProgramCacheKey = () => key;
  // A plain one (only colour, roughness, metalness, emissive) can be batched with others.
  if (!(o.groundAO || o.diffuseHook || o.fragDecl || o.vertDecl || o.vertBody || o.uniforms || o.vertexColors)) mat.userData.plain = mat.onBeforeCompile;
  return mat;
}

/** Whether a mesh's material is a plain litMaterial nothing has customised since. */
export function isPlainLit(m: THREE.Material): m is THREE.MeshStandardMaterial {
  const s = m as THREE.MeshStandardMaterial;
  return !!s.userData.plain && s.userData.plain === s.onBeforeCompile && !s.map && !s.transparent && s.opacity === 1 && !s.clippingPlanes && s.alphaTest === 0;
}

/** Everything about a plain litMaterial that isn't per-vertex in a batch: its batch key. */
export function plainBatchKey(m: THREE.MeshStandardMaterial): string {
  return [m.side, m.flatShading, m.depthWrite, m.depthTest, m.polygonOffset, m.polygonOffsetFactor, m.polygonOffsetUnits, m.envMapIntensity, m.fog, m.toneMapped, m.shadowSide].join();
}

/**
 * One material for many plain litMaterials merged into one mesh: colour, roughness,
 * metalness and emissive come per vertex (attributes color, aRM, aEm), so the batch
 * shades exactly as its parts did, in one draw.
 */
export function batchedLitMaterial(like: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  const mat = litMaterial({
    vertexColors: true,
    vertDecl: 'attribute vec2 aRM;\nattribute vec3 aEm;\nvarying vec2 vRM;\nvarying vec3 vEm;',
    vertBody: 'vRM = aRM; vEm = aEm;',
    fragDecl: 'varying vec2 vRM;\nvarying vec3 vEm;',
  });
  for (const k of ['side', 'flatShading', 'depthWrite', 'depthTest', 'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits', 'envMapIntensity', 'fog', 'toneMapped', 'shadowSide'] as const)
    (mat as unknown as Record<string, unknown>)[k] = like[k];
  const base = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    base.call(mat, shader, r);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vRM.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vRM.y;')
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance = vEm;');
  };
  const key = mat.customProgramCacheKey() + 'batch';
  mat.customProgramCacheKey = () => key;
  return mat;
}

/** Shadow-blob material (contact shadows, floodlight shadows). */
export function blobMaterial(opacity: number, opts: { elongated?: boolean; floodScaled?: boolean; standFade?: boolean } = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    uniforms: { uOpacity: { value: opacity }, ...SHARED, uTimeC: SHARED.uTime },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorld;
      void main() {
        vUv = uv;
        vec4 wp = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
        #endif
        wp = modelMatrix * wp;
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorld;
      uniform float uOpacity;
      uniform float uFlood;
      ${STAND_SHADOW_GLSL}
      void main() {
        vec2 q = (vUv - 0.5) * 2.0;
        ${opts.elongated ? 'q.y = q.y < 0.0 ? q.y * 2.2 : q.y;' : ''}
        float r = length(q);
        float a = (1.0 - smoothstep(0.2, 1.0, r)) * uOpacity;
        ${opts.floodScaled ? 'a *= uFlood;' : ''}
        ${opts.standFade ? 'a *= 1.0 - 0.5 * standShadow(vec3(vWorld.x, 0.0, vWorld.z));' : ''}
        gl_FragColor = vec4(0.06, 0.08, 0.06, a);
      }
    `,
  });
}
