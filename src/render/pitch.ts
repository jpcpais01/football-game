import * as THREE from 'three';
import { PITCH } from '../sim/constants';
import { SHARED, STAND_SHADOW_GLSL } from './look';

/**
 * The pitch is one quad with a procedural, physically lit grass material:
 * - mowing stripes whose brightness depends on the view direction (blades lean one way or
 *   the other), so they shimmer as the camera moves, like a real broadcast,
 * - chalk lines, goalmouth wear and fine grain computed per pixel (no textures),
 * - real sun shadows from the players, the stand's shadow, dew sheen in the evening.
 */
const MARGIN = 9;
const SIZE_X = PITCH.length + MARGIN * 2;
const SIZE_Z = PITCH.width + MARGIN * 2;

const NOISE_GLSL = /* glsl */ `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { return vnoise(p) * 0.6 + vnoise(p * 2.13) * 0.28 + vnoise(p * 4.7) * 0.12; }
`;

/**
 * The grass's noise never changes, so it's computed once on the GPU (the same functions,
 * the same values) into two textures, instead of ~14 value-noise lookups per pixel every
 * frame. Fine detail goes in a 2048 map (grain cells are ~14 cm, a texel is 6 cm); the
 * slow fields in a smaller one. Mipmaps also calm the grain's shimmer in the distance.
 *  fine:   r = patchiness fbm(p*0.08), g = grain vnoise(p*7), b = wear fbm(p*0.6), a = chalk vnoise(p*3)
 *  coarse: r = wind fbm(p*0.045),      g = wet vnoise(p*0.5)
 */
function bakeNoise(renderer: THREE.WebGLRenderer): { fine: THREE.Texture; coarse: THREE.Texture } {
  const bake = (w: number, h: number, body: string) => {
    const rt = new THREE.WebGLRenderTarget(w, h, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    rt.texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    const mat = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `${NOISE_GLSL}
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
  };
}

export function createPitch(renderer: THREE.WebGLRenderer): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(SIZE_X, SIZE_Z, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const noise = bakeNoise(renderer);

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, SHARED, { uTimeC: SHARED.uTime, uNoiseFine: { value: noise.fine }, uNoiseCoarse: { value: noise.coarse } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGrassWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGrassWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vGrassWorld;
        uniform float uDew;
        uniform float uFlood;
        uniform vec3 uShadeTint;
        uniform vec3 uFloodColor;
        uniform float uTime;
        ${STAND_SHADOW_GLSL}
        const float HL = ${PITCH.halfL.toFixed(2)};
        const float HW = ${PITCH.halfW.toFixed(2)};
        uniform sampler2D uNoiseFine;
        uniform sampler2D uNoiseCoarse;
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
          // Chalk.
          float d = linesDist(p);
          float aa = fwidth(d) * 0.8 + 0.01;
          gLine = 1.0 - smoothstep(0.06 - aa, 0.06 + aa, d);
          col = mix(col, vec3(0.92, 0.92, 0.88) * (0.94 + nf.a * 0.06), gLine * 0.9);
          gWet = (0.6 + 0.4 * nc.g) * (1.0 - gLine);
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
        roughnessFactor = mix(0.95, 0.42, uDew * gWet);`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        {
          float sh = standShadow(vGrassWorld);
          float sun = (1.0 - sh * 0.9) * (1.0 - cloudShadow(vGrassWorld) * 0.42);
          reflectedLight.directDiffuse *= sun;
          reflectedLight.directSpecular *= sun;
          // Dew glinting under the floodlights.
          vec2 gc = floor(vGrassWorld.xz * 7.0);
          float glint = step(0.9975, cHash(gc + floor(uTime * 1.3 + cHash(gc) * 5.0))) * (1.0 - gLine);
          reflectedLight.directSpecular += uFloodColor * glint * uDew * 2.5;
          reflectedLight.indirectDiffuse += diffuseColor.rgb * uShadeTint * sh * 0.45;
          // Floodlight pools: a touch brighter through the middle, falling off to the corners.
          vec2 q = vGrassWorld.xz / vec2(HL, HW);
          float pool = 1.12 - 0.3 * smoothstep(0.35, 1.25, length(q * vec2(0.85, 1.0)));
          reflectedLight.indirectDiffuse += diffuseColor.rgb * uFloodColor * uFlood * 0.5 * pool;
        }`,
      );
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.renderOrder = -10;
  return mesh;
}
