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

/** Floodlight pylon positions (x, z); also used for the faint floodlight shadows. */
export const PYLONS: [number, number][] = [
  [-74.5, -56],
  [74.5, -56],
  [-74.5, 56],
  [74.5, 56],
];

export const SHARED = {
  /** Ground edge of the near stand's shadow: z > uShadowZ0 + 0.8y + 0.05x is in shade. */
  uShadowZ0: { value: 24.0 },
  /** 0 = floodlights off, 1 = full evening floodlighting. */
  uFlood: { value: 0 },
  /** Dew on the grass late in the match (sheen). */
  uDew: { value: 0 },
  /** Cool ambient that fills the shaded side. */
  uShadeTint: { value: new THREE.Color(0x9fb0cc) },
  /** Floodlight colour (slightly cool white). */
  uFloodColor: { value: new THREE.Color(0xe8eeff) },
  uTime: { value: 0 },
};

export const COLORS = {
  fog: 0xd9cdb6,
  sun: 0xffe2b8,
  hemiSky: 0xcfdcf5,
  hemiGround: 0x5b6a3f,
};

/** GLSL: 0 = lit by the sun, 1 = inside the near stand's shadow. Needs uShadowZ0. */
export const STAND_SHADOW_GLSL = /* glsl */ `
uniform float uShadowZ0;
float standShadow(vec3 wp) {
  float edge = uShadowZ0 + 0.8 * wp.y + 0.05 * wp.x;
  float s = smoothstep(edge - 1.2, edge + 1.2, wp.z);
  s *= 1.0 - smoothstep(64.0, 72.0, abs(wp.x - wp.y * 0.5));
  return s;
}
`;

/** Shared uniform declarations for custom ShaderMaterials that want the evening look. */
export function sharedUniforms(): Record<string, { value: unknown }> {
  return SHARED as unknown as Record<string, { value: unknown }>;
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
    Object.assign(shader.uniforms, SHARED, o.uniforms ?? {});
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
          reflectedLight.directDiffuse *= 1.0 - sh * 0.94;
          reflectedLight.directSpecular *= 1.0 - sh * 0.94;
          vec3 wn = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
          // Cool sky fill in the shade, floodlight wash from above in the evening.
          reflectedLight.indirectDiffuse += diffuseColor.rgb * uShadeTint * sh * 0.28;
          reflectedLight.indirectDiffuse += diffuseColor.rgb * uFloodColor * uFlood * (0.55 + 0.45 * wn.y) * 0.55;
          ${o.groundAO ? 'float ao = mix(0.62, 1.0, smoothstep(0.0, 0.6, vWorldPos.y)); reflectedLight.indirectDiffuse *= ao; reflectedLight.directDiffuse *= mix(0.85, 1.0, ao);' : ''}
          ${o.groundAO ? 'float rim = pow(1.0 - max(dot(normal, normalize(vViewPosition)), 0.0), 3.0); reflectedLight.indirectDiffuse += diffuseColor.rgb * rim * (0.18 + uFlood * 0.12);' : ''}
        }`,
      );
  };
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
    uniforms: { uOpacity: { value: opacity }, ...SHARED },
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
