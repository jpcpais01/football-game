import * as THREE from 'three';
import { PITCH } from '../sim/constants';
import { COLORS, STAND_SHADOW_GLSL } from './look';

/**
 * The whole pitch is one quad and one shader: mowing stripes, chalk lines, goalmouth
 * wear and the stand shadow are all computed per pixel. No textures to download.
 */
export function createPitch(): THREE.Mesh {
  const margin = 9;
  const w = PITCH.length + margin * 2;
  const h = PITCH.width + margin * 2;
  const geo = new THREE.PlaneGeometry(w, h, 1, 1);
  geo.rotateX(-Math.PI / 2);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uShadowTint: { value: COLORS.shadowTint },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vWorld;
      uniform vec3 uShadowTint;
      ${STAND_SHADOW_GLSL}

      const float HL = ${PITCH.halfL.toFixed(2)};
      const float HW = ${PITCH.halfW.toFixed(2)};

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      float fbm(vec2 p) { return noise(p) * 0.6 + noise(p * 2.13) * 0.28 + noise(p * 4.7) * 0.12; }

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
        vec2 q = vec2(abs(p.x), p.y); // mirror ends
        float d = rectDist(p, vec2(-HL, -HW), vec2(HL, HW));
        d = min(d, abs(p.x) + step(HW, abs(p.y)) * 1e3);
        d = min(d, abs(length(p) - ${PITCH.circleRadius.toFixed(2)}));
        d = min(d, max(length(p) - 0.22, 0.0));
        // Penalty and six-yard boxes (mirrored)
        d = min(d, rectDist(q, vec2(HL - ${PITCH.boxDepth.toFixed(2)}, -${PITCH.boxHalfWidth.toFixed(2)}), vec2(HL, ${PITCH.boxHalfWidth.toFixed(2)})));
        d = min(d, rectDist(q, vec2(HL - ${PITCH.sixDepth.toFixed(2)}, -${PITCH.sixHalfWidth.toFixed(2)}), vec2(HL, ${PITCH.sixHalfWidth.toFixed(2)})));
        vec2 spot = vec2(HL - ${PITCH.penaltySpot.toFixed(2)}, 0.0);
        d = min(d, max(length(q - spot) - 0.2, 0.0));
        // Penalty arc outside the box
        float arc = abs(length(q - spot) - ${PITCH.circleRadius.toFixed(2)});
        arc += step(HL - ${PITCH.boxDepth.toFixed(2)}, q.x) * 1e3;
        d = min(d, arc);
        // Corner arcs
        vec2 c = vec2(abs(p.x), abs(p.y)) - vec2(HL, HW);
        float ca = abs(length(c) - 1.0) + step(0.0, c.x) * 1e3 + step(0.0, c.y) * 1e3;
        d = min(d, ca);
        return d;
      }

      vec3 toLin(vec3 c) { return pow(c, vec3(2.2)); }

      void main() {
        vec2 p = vWorld.xz;
        // Mowing: 18 stripes along the length plus a faint cross pattern.
        float stripeW = ${(PITCH.length / 18).toFixed(4)};
        float sIdx = floor((p.x + HL) / stripeW);
        float stripe = mod(sIdx, 2.0);
        float cross = mod(floor((p.y + HW) / (HW / 3.0)), 2.0);
        vec3 light = vec3(0.44, 0.6, 0.31);
        vec3 dark = vec3(0.37, 0.53, 0.26);
        vec3 col = mix(dark, light, stripe);
        col *= 1.0 + (cross - 0.5) * 0.035;

        // Large-scale patchiness and fine grain.
        float n = fbm(p * 0.09);
        col *= 0.93 + n * 0.12;
        col *= 0.97 + noise(p * 5.0) * 0.06;

        // Wear in the goalmouths and centre circle.
        vec2 q = vec2(abs(p.x), p.y);
        float wearGoal = 1.0 - smoothstep(0.0, 6.5, length((q - vec2(HL - 3.0, 0.0)) * vec2(1.0, 0.7)));
        float wearSpot = 1.0 - smoothstep(0.0, 2.0, length(q - vec2(HL - 11.0, 0.0)));
        float wearMid = (1.0 - smoothstep(0.0, 4.0, length(p))) * 0.6;
        float wearBase = wearGoal + wearSpot * 0.7 + wearMid;
        if (wearBase > 0.001) {
          float wear = clamp(wearBase * (0.55 + fbm(p * 0.6) * 0.9), 0.0, 1.0);
          col = mix(col, vec3(0.55, 0.53, 0.36), wear * 0.55);
        }

        // Outside the field of play: slightly darker, unstriped.
        float outside = step(HL, abs(p.x)) + step(HW, abs(p.y));
        col = mix(col, (light + dark) * 0.47, clamp(outside, 0.0, 1.0) * 0.6);

        // Chalk lines.
        float d = linesDist(p);
        float aa = fwidth(d) * 0.8 + 0.01;
        float line = 1.0 - smoothstep(0.06 - aa, 0.06 + aa, d);
        vec3 chalk = vec3(0.93, 0.93, 0.88) * (0.92 + noise(p * 3.0) * 0.08);
        col = mix(col, chalk, line * 0.92);

        // Sun and stand shadow.
        vec3 lin = toLin(col * 1.05);
        float sh = standShadow(vec3(p.x, 0.0, p.y));
        lin *= mix(vec3(1.0), uShadowTint, sh * 0.85);

        gl_FragColor = vec4(lin, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -10;
  return mesh;
}
