import * as THREE from 'three';
import { PITCH } from '../sim/constants';
import { SHARED, litMaterial } from './look';

/** Goal frames plus a shader net that ripples where the ball hits it. */
export interface Goals {
  group: THREE.Group;
  impact(x: number, y: number, z: number, strength: number, time: number): void;
  update(time: number): void;
}

const NET_DEPTH = PITCH.goalDepth;
const ROOF_DEPTH = PITCH.goalRoofDepth;

function netGeometry(): THREE.BufferGeometry {
  // Built for the goal at +x, in metres. Attribute `aOut` = outward direction for ripples.
  const hw = PITCH.goalHalfWidth;
  const h = PITCH.goalHeight;
  const pos: number[] = [];
  const uv: number[] = [];
  const out: number[] = [];
  const idx: number[] = [];

  // A surface defined by f(u,v) over a grid.
  const surface = (nu: number, nv: number, f: (u: number, v: number) => [number, number, number], o: [number, number, number], scaleU: number, scaleV: number) => {
    const base = pos.length / 3;
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const u = i / nu;
        const v = j / nv;
        const p = f(u, v);
        pos.push(p[0], p[1], p[2]);
        uv.push(u * scaleU, v * scaleV);
        out.push(o[0], o[1], o[2]);
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = base + j * (nu + 1) + i;
        idx.push(a, a + 1, a + nu + 2, a, a + nu + 2, a + nu + 1);
      }
    }
  };
  const profile = (v: number): [number, number] => {
    // v: 0 at crossbar → roof → down the back to the ground.
    const roofLen = ROOF_DEPTH;
    const backLen = Math.hypot(NET_DEPTH - ROOF_DEPTH, h);
    const total = roofLen + backLen;
    const s = v * total;
    if (s <= roofLen) return [s, h];
    const t = (s - roofLen) / backLen;
    return [ROOF_DEPTH + (NET_DEPTH - ROOF_DEPTH) * t, h * (1 - t)];
  };
  const total = ROOF_DEPTH + Math.hypot(NET_DEPTH - ROOF_DEPTH, h);
  // Roof + back as one folded sheet.
  surface(
    20,
    14,
    (u, v) => {
      const [d, y] = profile(v);
      return [d, y, -hw + u * 2 * hw];
    },
    [1, 0.3, 0],
    hw * 2,
    total,
  );
  // Side panels.
  for (const s of [-1, 1]) {
    surface(
      8,
      8,
      (u, v) => {
        const [d, y] = profile(u);
        return [d * 1, y * (1 - v), s * hw];
      },
      [0.2, 0, s],
      total,
      h,
    );
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aOut', new THREE.Float32BufferAttribute(out, 3));
  g.setIndex(idx);
  return g;
}

function netMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uHit: { value: new THREE.Vector4(0, 0, 0, -10) }, // local xyz, time
      uStrength: { value: 0 },
      uTime: { value: 0 },
      uFlood: SHARED.uFlood,
    },
    vertexShader: /* glsl */ `
      attribute vec3 aOut;
      uniform vec4 uHit;
      uniform float uStrength, uTime;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec3 p = position;
        float t = uTime - uHit.w;
        if (t >= 0.0 && t < 2.5) {
          float d = length(p - uHit.xyz);
          float env = exp(-d * d * 1.2) * exp(-t * 3.0);
          float wave = cos(t * 18.0 - d * 5.0);
          p += normalize(aOut) * env * wave * uStrength * 0.5;
        }
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform float uFlood;
      void main() {
        vec2 g = vUv / 0.14;
        vec2 f = abs(fract(g) - 0.5);
        vec2 w = fwidth(g);
        float lx = 1.0 - smoothstep(0.5 - w.x * 1.2, 0.5, f.x + 0.06);
        float ly = 1.0 - smoothstep(0.5 - w.y * 1.2, 0.5, f.y + 0.06);
        float line = max(1.0 - lx, 1.0 - ly);
        // When the mesh is tiny on screen, fade to a soft haze instead of moiré.
        float far = smoothstep(0.25, 0.8, max(w.x, w.y));
        float a = mix(line * 0.8, 0.24, far);
        // Warm daylight on the net, cooler and brighter under the floodlights.
        vec3 c = mix(vec3(0.86, 0.84, 0.8), vec3(0.95, 0.97, 1.0), uFlood);
        gl_FragColor = vec4(c, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

export function createGoals(): Goals {
  const group = new THREE.Group();
  const postMat = litMaterial({ color: 0xf4f3ee, roughness: 0.35 });
  const nets: THREE.ShaderMaterial[] = [];
  const pr = PITCH.postRadius;
  const hw = PITCH.goalHalfWidth;
  const h = PITCH.goalHeight;

  for (const side of [-1, 1]) {
    const g = new THREE.Group();
    const postGeo = new THREE.CylinderGeometry(pr, pr, h + pr, 10);
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(0, (h + pr) / 2, s * hw);
      post.castShadow = true;
      g.add(post);
    }
    const barGeo = new THREE.CylinderGeometry(pr, pr, hw * 2 + pr * 2, 10);
    barGeo.rotateX(Math.PI / 2);
    const bar = new THREE.Mesh(barGeo, postMat);
    bar.position.set(0, h, 0);
    bar.castShadow = true;
    g.add(bar);
    // Thin back supports.
    const supMat = litMaterial({ color: 0xcfd0cc, roughness: 0.5 });
    const supGeo = new THREE.CylinderGeometry(0.025, 0.025, Math.hypot(NET_DEPTH - ROOF_DEPTH, h), 6);
    for (const s of [-1, 1]) {
      const sup = new THREE.Mesh(supGeo, supMat);
      sup.position.set((ROOF_DEPTH + NET_DEPTH) / 2, h / 2, s * hw);
      sup.rotation.z = Math.atan2(NET_DEPTH - ROOF_DEPTH, h);
      g.add(sup);
    }
    const nm = netMaterial();
    nets.push(nm);
    const net = new THREE.Mesh(netGeometry(), nm);
    net.renderOrder = 5;
    g.add(net);

    g.position.set(side * PITCH.halfL, 0, 0);
    if (side < 0) g.rotation.y = Math.PI;
    group.add(g);
  }

  return {
    group,
    impact(x, y, z, strength, time) {
      const side = x > 0 ? 1 : 0;
      const m = nets[side];
      // Into the goal's local frame (+x goal unrotated; -x goal rotated by PI).
      const lx = x > 0 ? x - PITCH.halfL : -(x + PITCH.halfL);
      const lz = x > 0 ? z : -z;
      m.uniforms.uHit.value.set(lx, y, lz, time);
      m.uniforms.uStrength.value = Math.min(1, strength / 20);
    },
    update(time) {
      for (const n of nets) n.uniforms.uTime.value = time;
    },
  };
}
