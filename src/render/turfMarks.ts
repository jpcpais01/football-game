import * as THREE from 'three';
import type { Match } from '../sim/match';
import { NOISE_GLSL, PITCH_SIZE_X, PITCH_SIZE_Z } from './pitch';

/**
 * Scars a match leaves on the turf. A texture over the whole pitch (same mapping as the
 * grass noise) that slide tackles are drawn into as they happen and that stays for the rest
 * of the match:
 *  r = torn turf (bare soil), g = flattened, bruised grass.
 * Each slide is drawn as it travels, in short pieces, with its noise in world space along
 * the slide, so the mark grows under the player seamlessly; marks from different slides
 * combine with max blending.
 *
 * The mark itself: a streak of grass flattened by the body, ragged at the edges and a little
 * wavy; soil torn up where the boot first bites and in streaks along the studs' path; a few
 * clods thrown out to the sides. Every slide has its own seed, and harder slides tear more.
 */
const W = 2048;
const H = 1024;

interface Track {
  sx: number;
  sz: number;
  dx: number;
  dz: number;
  /** Distance along the slide already drawn. */
  done: number;
  seed: number;
  strength: number;
}

export class TurfMarks {
  readonly texture: THREE.Texture;
  private rt: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.ShaderMaterial;
  private tracks = new Map<number, Track>();
  private match: Match | null = null;
  private dirty = true;
  private clearColor = new THREE.Color();

  constructor() {
    this.rt = new THREE.WebGLRenderTarget(W, H, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.texture = this.rt.texture;
    this.mat = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      uniforms: {
        uS: { value: new THREE.Vector2() },
        uDir: { value: new THREE.Vector2(1, 0) },
        uFrom: { value: 0 },
        uTo: { value: 0 },
        uSeed: { value: 0 },
        uStrength: { value: 1 },
      },
      vertexShader: /* glsl */ `
        uniform vec2 uS;
        uniform vec2 uDir;
        uniform float uFrom;
        uniform float uTo;
        varying vec2 vW;
        void main() {
          // position.x: 0 = from, 1 = to; position.y: -1..1 across. Padded for ragged edges
          // and thrown clods.
          vec2 perp = vec2(-uDir.y, uDir.x);
          float d = mix(uFrom - 0.35, uTo + 0.35, position.x);
          vW = uS + uDir * d + perp * position.y * 0.8;
          gl_Position = vec4(vW / vec2(${(PITCH_SIZE_X / 2).toFixed(2)}, ${(PITCH_SIZE_Z / 2).toFixed(2)}), 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        ${NOISE_GLSL}
        uniform vec2 uS;
        uniform vec2 uDir;
        uniform float uFrom;
        uniform float uTo;
        uniform float uSeed;
        uniform float uStrength;
        varying vec2 vW;
        void main() {
          vec2 r = vW - uS;
          float d = dot(r, uDir);
          float c = dot(r, vec2(-uDir.y, uDir.x));
          // Only this piece of the slide (pieces butt up against each other); soft at the start.
          if (d < uFrom - 0.3 || d > uTo) discard;
          float start = smoothstep(-0.3, 0.05, d);
          vec2 o = vec2(uSeed * 17.3, uSeed * 9.1);
          // The body's footprint: narrow where the boot goes in, widening as hip and thigh
          // come down, wandering and ragged along its length.
          float hw = (0.1 + 0.16 * smoothstep(0.0, 0.9, d)) * (0.85 + 0.3 * vnoise(vec2(d * 1.7, 3.0) + o));
          float cc = c - 0.07 * (vnoise(vec2(d * 0.9, 7.0) + o) - 0.5);
          float rag = (vnoise(vec2(d * 9.0, c * 9.0) + o) - 0.5) * 0.06;
          float body = 1.0 - smoothstep(hw * 0.55, hw + rag, abs(cc));
          // Streaks along the slide (studs, knee, the ball of the hip).
          float streak = vnoise(vec2(d * 0.7, cc * 16.0) + o);
          float fine = vnoise(vec2(d * 2.6, cc * 26.0) + o.yx);
          float flattened = body * start * (0.5 + 0.5 * streak);
          // Torn soil: where the boot bites in, then in streaks, more on a hard slide.
          float bite = exp(-max(d, 0.0) * 2.2) * (1.0 - smoothstep(0.0, 0.1, abs(cc) - 0.04));
          float tear = streak * 0.55 + fine * 0.45 + bite * 0.6 + (uStrength - 0.75) * 0.5;
          float dirt = body * start * smoothstep(0.62, 0.86, tear) * (0.55 + 0.45 * fine);
          // Clods thrown out to the sides.
          vec2 cell = floor(vW * 11.0);
          float side = smoothstep(hw + 0.4, hw, abs(cc)) * step(hw * 0.8, abs(cc));
          float clod = step(1.0 - 0.07 * uStrength, hash(cell + o)) * side * start * 0.75;
          gl_FragColor = vec4(max(dirt, clod) * uStrength, flattened * (0.75 + 0.25 * uStrength), 0.0, 1.0);
        }`,
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const quad = new THREE.Mesh(g, this.mat);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  /** Draw any slide in progress (and clear the turf for a new match). */
  update(match: Match, renderer: THREE.WebGLRenderer): void {
    if (match !== this.match) {
      this.match = match;
      this.tracks.clear();
      this.dirty = true;
    }
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.autoClear;
    let bound = false;
    const bind = () => {
      if (bound) return;
      bound = true;
      renderer.autoClear = false;
      renderer.setRenderTarget(this.rt);
    };
    if (this.dirty) {
      this.dirty = false;
      bind();
      renderer.getClearColor(this.clearColor);
      const a = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      renderer.setClearColor(this.clearColor, a);
      // An empty stamp: compiles the shader now rather than on the first slide.
      this.mat.uniforms.uFrom.value = 1;
      this.mat.uniforms.uTo.value = 0;
      renderer.render(this.scene, this.cam);
    }
    const u = this.mat.uniforms;
    for (const p of match.players) {
      let t = this.tracks.get(p.id);
      // The body is down a moment after the slide starts.
      if (p.action !== 'slide' || p.actionT < 0.06) {
        if (t && p.action !== 'slide') this.tracks.delete(p.id);
        continue;
      }
      // Marked under the lead thigh and boot, a little ahead of the hips.
      const x = p.pos.x + p.actionDirX * 0.45;
      const z = p.pos.z + p.actionDirZ * 0.45;
      if (!t) {
        t = { sx: x, sz: z, dx: p.actionDirX, dz: p.actionDirZ, done: 0, seed: Math.random() * 100, strength: 0.55 + 0.45 * Math.min(1, (p.slideV0 - 6) / 2.5) * (0.7 + 0.3 * Math.random()) };
        this.tracks.set(p.id, t);
      }
      const d = (x - t.sx) * t.dx + (z - t.sz) * t.dz;
      // Drawn in pieces as it travels; the last bit once he's stopped.
      if (d - t.done < 0.08 && (p.speed > 0.3 || d - t.done < 0.005)) continue;
      bind();
      u.uS.value.set(t.sx, t.sz);
      u.uDir.value.set(t.dx, t.dz);
      u.uFrom.value = t.done;
      u.uTo.value = d;
      u.uSeed.value = t.seed;
      u.uStrength.value = t.strength;
      renderer.render(this.scene, this.cam);
      t.done = u.uTo.value;
    }
    if (bound) {
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevClear;
    }
  }
}
