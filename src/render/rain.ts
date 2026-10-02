import * as THREE from 'three';
import { SHARED } from './look';

/**
 * Rain on a floodlit night, all on the GPU:
 * - streaks: thousands of drops, each a short line along its fall (the eye's motion blur),
 *   slanted by the shared wind, falling through a box that follows the camera but with the
 *   drops anchored in the world (they don't slide as the camera pans). Lit by the floods,
 *   brighter up in the light, fading into the haze with distance.
 * - splashes: tiny crowns flicking up off the grass, each at a new random spot every time.
 * Nothing on the CPU per frame but a few uniforms.
 */
const DROPS = 9000;
const SPLASHES = 2600;
/** Rain box (metres) around the middle of the view. */
const BX = 110;
const BY = 34;
const BZ = 100;

const common = /* glsl */ `
  uniform float uTime;
  uniform vec3 uCentre;
  uniform vec2 uWind;
  float wrap(float v, float c, float size) { return c + (fract((v - c) / size + 0.5) - 0.5) * size; }
`;

export class Rain {
  readonly group = new THREE.Group();
  private uniforms = {
    uTime: SHARED.uTime,
    uWind: SHARED.uWind,
    uFlood: SHARED.uFlood,
    uFloodColor: SHARED.uFloodColor,
    uCentre: { value: new THREE.Vector3() },
    uCam: { value: new THREE.Vector3() },
    uScale: { value: 300 },
  };

  constructor() {
    // Streaks: two vertices per drop (aEnd 0 = head, 1 = tail).
    const seeds = new Float32Array(DROPS * 2 * 4);
    const end = new Float32Array(DROPS * 2);
    for (let i = 0; i < DROPS; i++) {
      const s = [Math.random(), Math.random(), Math.random(), Math.random()];
      seeds.set(s, i * 8);
      seeds.set(s, i * 8 + 4);
      end[i * 2 + 1] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DROPS * 2 * 3), 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    const streaks = new THREE.LineSegments(
      g,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: this.uniforms,
        vertexShader: /* glsl */ `
          ${common}
          uniform vec3 uCam;
          attribute vec4 aSeed;
          attribute float aEnd;
          varying float vA;
          void main() {
            float speed = 8.5 + aSeed.w * 3.0;
            vec3 vel = vec3(uWind.x * 2.2, -speed, uWind.y * 2.2);
            float y = fract(aSeed.y - uTime * speed / ${BY.toFixed(1)}) * ${BY.toFixed(1)};
            float fall = (${BY.toFixed(1)} - y) / speed;
            vec3 p = vec3(aSeed.x * ${BX.toFixed(1)} + vel.x * fall, y, aSeed.z * ${BZ.toFixed(1)} + vel.z * fall);
            p.x = wrap(p.x, uCentre.x, ${BX.toFixed(1)});
            p.z = wrap(p.z, uCentre.z, ${BZ.toFixed(1)});
            // The streak: how far the drop falls while the eye takes it in.
            p -= vel * 0.07 * aEnd;
            float d = distance(p, uCam);
            // Bright in the floodlight up high, a glint near the camera, gone into the haze.
            vA = (0.55 + 0.45 * smoothstep(2.0, 25.0, p.y)) * smoothstep(3.0, 14.0, d) * (1.0 - smoothstep(45.0, 110.0, d)) * (0.5 + 0.5 * aSeed.w)
              * mix(1.0, 0.25, aEnd);
            gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uFlood;
          uniform vec3 uFloodColor;
          varying float vA;
          void main() {
            gl_FragColor = vec4(mix(vec3(0.55, 0.62, 0.75), uFloodColor, 0.6) * vA * (0.2 + 0.22 * uFlood), 1.0);
          }
        `,
      }),
    );
    streaks.frustumCulled = false;
    streaks.renderOrder = 7;

    // Splashes: points that pop up off the turf for a moment at a fresh spot each cycle.
    const ss = new Float32Array(SPLASHES * 4);
    for (let i = 0; i < ss.length; i++) ss[i] = Math.random();
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPLASHES * 3), 3));
    sg.setAttribute('aSeed', new THREE.BufferAttribute(ss, 4));
    const splashes = new THREE.Points(
      sg,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: this.uniforms,
        vertexShader: /* glsl */ `
          ${common}
          uniform vec3 uCam;
          uniform float uScale;
          attribute vec4 aSeed;
          varying float vA;
          float h(float n) { return fract(sin(n * 91.7 + aSeed.z * 311.3) * 43758.5); }
          void main() {
            float period = 0.45 + aSeed.w * 0.5;
            float t = uTime / period + aSeed.y;
            float cyc = floor(t);
            float ph = fract(t);
            vec3 p = vec3(wrap((aSeed.x + h(cyc)) * 70.0, uCentre.x, 70.0), 0.0, wrap((aSeed.z + h(cyc + 0.5)) * 50.0, uCentre.z, 50.0));
            // A crown: up and gone in a tenth of a second.
            float life = 1.0 - smoothstep(0.0, 0.22, ph);
            p.y = 0.04 + 0.09 * sin(min(ph / 0.22, 1.0) * 3.1416);
            vA = life * (1.0 - smoothstep(40.0, 80.0, distance(p, uCam)));
            vec4 mv = viewMatrix * vec4(p, 1.0);
            gl_PointSize = max(1.0, 0.07 * uScale / -mv.z) * step(0.01, life);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uFlood;
          uniform vec3 uFloodColor;
          varying float vA;
          void main() {
            gl_FragColor = vec4(mix(vec3(0.7, 0.76, 0.85), uFloodColor, 0.5) * vA * 0.22, 1.0);
          }
        `,
      }),
    );
    splashes.frustumCulled = false;
    splashes.renderOrder = 7;
    this.group.add(streaks, splashes);
    this.group.visible = false;
  }

  /** `on`: raining. Centre the rain between the camera and what it looks at. */
  update(on: boolean, camera: THREE.PerspectiveCamera, focusX: number, focusZ: number, renderHeight: number): void {
    this.group.visible = on;
    if (!on) return;
    const c = camera.position;
    this.uniforms.uCam.value.copy(c);
    this.uniforms.uCentre.value.set((c.x + focusX) / 2, 0, (c.z + focusZ) / 2);
    this.uniforms.uScale.value = renderHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
  }
}
