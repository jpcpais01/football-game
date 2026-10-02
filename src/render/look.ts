import * as THREE from 'three';

/**
 * Art direction in one place: late-afternoon light, a soft 3-band toon ramp, thin dark
 * outlines, and the main stand's shadow falling across the near side of the pitch.
 */

// Direction the sunlight travels (from the sun toward the ground).
export const SUN_DIR = new THREE.Vector3(0.38, -0.72, -0.58).normalize();

// Ground-level shadow edge of the near stand roof: z > SHADOW_Z0 + SHADOW_KY*y + SHADOW_KX*x
export const SHADOW_Z0 = 24.5;
export const SHADOW_KY = 0.8;
export const SHADOW_KX = 0.05;

export const COLORS = {
  sky: 0xd9e4e8,
  horizon: 0xf1dcc0,
  fog: 0xd8d0bd,
  outline: 0x1d2219,
  shadowTint: new THREE.Color(0x8d9bb5),
  sun: 0xfff0d8,
  hemiSky: 0xd6e3ff,
  hemiGround: 0x5d6b45,
};

/** GLSL: 0 = lit, 1 = inside the stand's shadow. Expects a world position. */
export const STAND_SHADOW_GLSL = /* glsl */ `
float standShadow(vec3 wp) {
  float edge = ${SHADOW_Z0.toFixed(3)} + ${SHADOW_KY.toFixed(3)} * wp.y + ${SHADOW_KX.toFixed(3)} * wp.x;
  // Soft penumbra; the shadow only exists along the length of the stand.
  float s = smoothstep(edge - 0.9, edge + 0.9, wp.z);
  s *= 1.0 - smoothstep(64.0, 72.0, abs(wp.x - wp.y * 0.5));
  return s;
}
`;

let rampTex: THREE.DataTexture | null = null;

/** Three soft bands; shadows never go muddy. */
export function toonRamp(): THREE.DataTexture {
  if (rampTex) return rampTex;
  const data = new Uint8Array([120, 120, 120, 255, 190, 190, 190, 255, 255, 255, 255, 255]);
  rampTex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  rampTex.minFilter = THREE.NearestFilter;
  rampTex.magFilter = THREE.NearestFilter;
  rampTex.generateMipmaps = false;
  rampTex.needsUpdate = true;
  return rampTex;
}

/** Toon material that also receives the stand shadow and a touch of rim light. */
export function toonMaterial(opts: { color?: number; vertexColors?: boolean } = {}): THREE.MeshToonMaterial {
  const mat = new THREE.MeshToonMaterial({
    color: opts.color ?? 0xffffff,
    gradientMap: toonRamp(),
    vertexColors: opts.vertexColors ?? false,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uShadowTint = { value: COLORS.shadowTint };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vec4 wpos = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          wpos = instanceMatrix * wpos;
        #endif
        vWorldPos = (modelMatrix * wpos).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWorldPos;\nuniform vec3 uShadowTint;\n${STAND_SHADOW_GLSL}`)
      .replace(
        '#include <opaque_fragment>',
        `
        float sh = standShadow(vWorldPos);
        outgoingLight *= mix(vec3(1.0), uShadowTint, sh * 0.85);
        // Soft rim so silhouettes read against the grass.
        float rim = 1.0 - max(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0)), 0.0);
        outgoingLight += diffuseColor.rgb * pow(rim, 3.0) * 0.12;
        #include <opaque_fragment>`,
      );
  };
  return mat;
}

/** Inverted-hull outline material. Thickness is in object units. */
export function outlineMaterial(thickness: number, color = COLORS.outline): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      transformed += normalize(normal) * ${thickness.toFixed(4)};`,
    );
  };
  return mat;
}
