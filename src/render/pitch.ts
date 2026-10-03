import * as THREE from 'three';
import { PITCH } from '../sim/constants';
import { FLOOD_POOL_GLSL, SHARED, STAND_SHADOW_GLSL } from './look';

/**
 * The pitch is one quad with a procedural, physically lit grass material:
 * - mowing stripes whose brightness depends on the view direction (blades lean one way or
 *   the other), so they shimmer as the camera moves, like a real broadcast,
 * - chalk lines, goalmouth wear and fine grain computed per pixel (no textures),
 * - real sun shadows from the players and the ground's stands (baked: standShadow.ts), dew
 *   sheen in the evening, the floodlights' pools of light at night.
 */
const MARGIN = 9;
const SIZE_X = PITCH.length + MARGIN * 2;
const SIZE_Z = PITCH.width + MARGIN * 2;
export { SIZE_X as PITCH_SIZE_X, SIZE_Z as PITCH_SIZE_Z };

export const NOISE_GLSL = /* glsl */ `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { return vnoise(p) * 0.6 + vnoise(p * 2.13) * 0.28 + vnoise(p * 4.7) * 0.12; }
`;

/** Distance (m) to the nearest chalk line: baked once into a texture (see bakeNoise). */
const LINES_GLSL = /* glsl */ `
const float HL = ${PITCH.halfL.toFixed(2)};
const float HW = ${PITCH.halfW.toFixed(2)};
float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
float rectDist(vec2 p, vec2 mn, vec2 mx) {
  float d = segDist(p, vec2(mn.x, mn.y), vec2(mx.x, mn.y));
  d = min(d, segDist(p, vec2(mx.x, mn.y), vec2(mx.x, mx.y)));
  d = min(d, segDist(p, vec2(mx.x, mx.y), vec2(mn.x, mx.y)));
  d = min(d, segDist(p, vec2(mn.x, mx.y), vec2(mn.x, mn.y)));
  return d;
}
float linesDist(vec2 p) {
  vec2 q = vec2(abs(p.x), p.y);
  float d = rectDist(p, vec2(-HL, -HW), vec2(HL, HW));
  d = min(d, abs(p.x) + step(HW, abs(p.y)) * 1e3);
  d = min(d, abs(length(p) - ${PITCH.circleRadius.toFixed(2)}));
  d = min(d, max(length(p) - 0.22, 0.0));
  d = min(d, rectDist(q, vec2(HL - ${PITCH.boxDepth.toFixed(2)}, -${PITCH.boxHalfWidth.toFixed(2)}), vec2(HL, ${PITCH.boxHalfWidth.toFixed(2)})));
  d = min(d, rectDist(q, vec2(HL - ${PITCH.sixDepth.toFixed(2)}, -${PITCH.sixHalfWidth.toFixed(2)}), vec2(HL, ${PITCH.sixHalfWidth.toFixed(2)})));
  vec2 spot = vec2(HL - ${PITCH.penaltySpot.toFixed(2)}, 0.0);
  d = min(d, max(length(q - spot) - 0.2, 0.0));
  float arc = abs(length(q - spot) - ${PITCH.circleRadius.toFixed(2)});
  arc += step(HL - ${PITCH.boxDepth.toFixed(2)}, q.x) * 1e3;
  d = min(d, arc);
  vec2 c = vec2(abs(p.x), abs(p.y)) - vec2(HL, HW);
  float ca = abs(length(c) - 1.0) + step(0.0, c.x) * 1e3 + step(0.0, c.y) * 1e3;
  d = min(d, ca);
  return d;
}
`;

/**
 * The grass's noise never changes, so it's computed once on the GPU (the same functions,
 * the same values) into two textures, instead of ~14 value-noise lookups per pixel every
 * frame. Fine detail goes in a 2048 map (grain cells are ~14 cm, a texel is 6 cm); the
 * slow fields in a smaller one. Mipmaps also calm the grain's shimmer in the distance.
 *  fine:   r = patchiness fbm(p*0.08), g = grain vnoise(p*7), b = wear fbm(p*0.6), a = chalk vnoise(p*3)
 *  coarse: r = wind fbm(p*0.045),      g = wet vnoise(p*0.5)
 */
function bakeNoise(renderer: THREE.WebGLRenderer): { fine: THREE.Texture; coarse: THREE.Texture; lines: THREE.Texture } {
  const bake = (w: number, h: number, body: string, mips = true) => {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      generateMipmaps: mips,
      minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    rt.texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    const mat = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `${NOISE_GLSL}
        ${LINES_GLSL}
        varying vec2 vUv;
        void main() {
          // Same world position the pitch shader will look it up at.
          vec2 p = (vUv - 0.5) * vec2(${SIZE_X.toFixed(2)}, ${SIZE_Z.toFixed(2)});
          ${body}
        }`,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    const scene = new THREE.Scene();
    scene.add(quad);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prev);
    mat.dispose();
    quad.geometry.dispose();
    return rt.texture;
  };
  return {
    fine: bake(2048, 1024, 'gl_FragColor = vec4(fbm(p * 0.08), vnoise(p * 7.0), fbm(p * 0.6), vnoise(p * 3.0));'),
    coarse: bake(512, 256, 'gl_FragColor = vec4(fbm(p * 0.045), vnoise(p * 0.5), 0.0, 1.0);'),
    // The chalk lines as a distance field (metres, up to 1): ~13 segment and arc distances
    // per pixel every frame become one texture read. A texel is 6 cm; the lines are 12 cm.
    lines: bake(2048, 1024, 'gl_FragColor = vec4(min(linesDist(p), 1.0), 0.0, 0.0, 1.0);', false),
  };
}

/** `marks`: the turf's scars (see turfMarks.ts), same mapping as the noise. */
export function createPitch(renderer: THREE.WebGLRenderer, marks: THREE.Texture): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(SIZE_X, SIZE_Z, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const noise = bakeNoise(renderer);

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, SHARED, { uTimeC: SHARED.uTime, uNoiseFine: { value: noise.fine }, uNoiseCoarse: { value: noise.coarse }, uLines: { value: noise.lines }, uMarks: { value: marks } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGrassWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGrassWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vGrassWorld;
        uniform float uDew;
        uniform float uRain;
        float gPuddle;
        uniform float uFlood;
        uniform vec3 uShadeTint;
        uniform vec3 uFloodColor;
        uniform float uTime;
        ${STAND_SHADOW_GLSL}
        ${FLOOD_POOL_GLSL}
        const float HL = ${PITCH.halfL.toFixed(2)};
        const float HW = ${PITCH.halfW.toFixed(2)};
        uniform sampler2D uNoiseFine;
        uniform sampler2D uNoiseCoarse;
        uniform sampler2D uLines;
        uniform sampler2D uMarks;
        float gLine;
        float gWet;
        vec3 grass(vec2 p, vec3 viewDir) {
          vec2 nuv = p / vec2(${SIZE_X.toFixed(2)}, ${SIZE_Z.toFixed(2)}) + 0.5;
          vec4 nf = texture2D(uNoiseFine, nuv);
          vec4 nc = texture2D(uNoiseCoarse, nuv);
          float stripeW = ${(PITCH.length / 18).toFixed(4)};
          float stripe = mod(floor((p.x + HL) / stripeW), 2.0) * 2.0 - 1.0; // -1 / +1
          // Blades lean toward +x or -x: brightness flips with the viewing direction.
          float lean = stripe * (0.45 + 0.55 * clamp(-viewDir.x * 1.6 + 0.35, -1.0, 1.0));
          // Lush, sunlit green: rich but never neon.
          vec3 base = vec3(0.33, 0.47, 0.24);
          vec3 col = base * (1.0 + lean * 0.075);
          // Faint cross cut.
          col *= 1.0 + (mod(floor((p.y + HW) / (HW / 3.0)), 2.0) - 0.5) * 0.03;
          // Patchiness and grain.
          col *= 0.92 + nf.r * 0.14;
          col *= 0.95 + nf.g * 0.08;
          // Wear in the goalmouths, penalty spots and centre.
          vec2 q = vec2(abs(p.x), p.y);
          float wb = (1.0 - smoothstep(0.0, 6.5, length((q - vec2(HL - 3.0, 0.0)) * vec2(1.0, 0.7))))
                   + (1.0 - smoothstep(0.0, 2.0, length(q - vec2(HL - 11.0, 0.0)))) * 0.7
                   + (1.0 - smoothstep(0.0, 4.0, length(p))) * 0.6;
          if (wb > 0.001) {
            float wear = clamp(wb * (0.55 + nf.b * 0.9), 0.0, 1.0);
            col = mix(col, vec3(0.52, 0.48, 0.34), wear * 0.45);
          }
          // Wind over the grass: soft lighter waves rolling across the pitch.
          vec2 wd = normalize(uWind);
          float wph = dot(p, wd) * 0.21 - uTime * 1.5 + nc.r * 5.0;
          float wave = smoothstep(0.35, 1.0, sin(wph)) * (0.6 + 0.4 * sin(dot(p, vec2(-wd.y, wd.x)) * 0.05 + uTime * 0.3));
          col *= 1.0 + wave * 0.075;
          float outside = clamp(step(HL, abs(p.x)) + step(HW, abs(p.y)), 0.0, 1.0);
          col = mix(col, base * 0.96, outside * 0.6);
          // Slide-tackle scars: grass flattened pale and yellowish, torn down to the soil
          // (damp dark earth, lighter where it's crumbled), the chalk scuffed off with it.
          vec2 mk = texture2D(uMarks, nuv).rg;
          col = mix(col, col * vec3(1.14, 1.1, 0.86), mk.g * 0.55);
          vec3 soil = mix(vec3(0.27, 0.2, 0.13), vec3(0.42, 0.33, 0.22), nf.g);
          col = mix(col, soil, mk.r);
          // Chalk.
          float d = texture2D(uLines, nuv).r;
          float aa = fwidth(d) * 0.8 + 0.01;
          gLine = (1.0 - smoothstep(0.06 - aa, 0.06 + aa, d)) * (1.0 - mk.r * 0.85);
          col = mix(col, vec3(0.92, 0.92, 0.88) * (0.94 + nf.a * 0.06), gLine * 0.9);
          gWet = (0.6 + 0.4 * nc.g) * (1.0 - gLine) * (1.0 - mk.r * 0.7);
          // Rain: soaked grass goes darker and deeper green; water stands in the low spots
          // and the worn goalmouths, and in the mud of the slide marks.
          gPuddle = smoothstep(0.79, 0.88, nc.g * 0.55 + nf.r * 0.45 + wb * 0.18 + mk.r * 0.3) * uRain;
          col *= mix(vec3(1.0), vec3(0.7, 0.78, 0.72), uRain);
          col = mix(col, col * vec3(0.4, 0.45, 0.52), gPuddle * 0.8);
          return pow(col, vec3(2.2));
        }`,
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec3 gView = normalize(cameraPosition - vGrassWorld);
        vec4 diffuseColor = vec4( grass(vGrassWorld.xz, gView), opacity );`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(0.95, mix(0.42, 0.24, uRain), uDew * gWet);
        roughnessFactor = mix(roughnessFactor, 0.07, gPuddle);`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        {
          float sh = standShadowGround(vGrassWorld.xz);
          float sun = (1.0 - sh) * (1.0 - cloudShadow(vGrassWorld) * 0.42);
          reflectedLight.directDiffuse *= sun;
          reflectedLight.directSpecular *= sun;
          reflectedLight.indirectDiffuse += diffuseColor.rgb * uShadeTint * sh * 0.3;
          // Floodlights: each bank's pool of light, brightest where they overlap.
          if (uFlood > 0.0) {
            float pool = clamp(0.1 + 0.9 * floodPool(vGrassWorld), 0.45, 1.8);
            reflectedLight.indirectDiffuse += diffuseColor.rgb * uFloodColor * uFlood * 0.5 * pool;
          }
          // Standing water mirrors the floodlit stands, brightest at a glancing angle, with
          // rings spreading where the drops land.
          if (gPuddle > 0.001) {
            float fres = pow(1.0 - clamp(gView.y, 0.0, 1.0), 3.0);
            vec2 rc = floor(vGrassWorld.xz * 3.0);
            vec2 rf = fract(vGrassWorld.xz * 3.0) - 0.5;
            float rp = fract(uTime * 1.4 + cHash(rc) * 7.0);
            float ring = (1.0 - smoothstep(0.0, 0.06, abs(length(rf - (vec2(cHash(rc + 3.1), cHash(rc + 5.7)) - 0.5) * 0.4) - rp * 0.45))) * (1.0 - rp);
            reflectedLight.indirectSpecular += uFloodColor * gPuddle * (0.02 + 0.12 * fres + 0.16 * ring) * uFlood;
          }
        }`,
      );
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.renderOrder = -10;
  return mesh;
}
