import * as THREE from 'three';
import { flipAttribute, RING } from './pingPong';
import { PITCH } from '../sim/constants';
import type { Match } from '../sim/match';
import { SHARED } from './look';
import type { Terraces } from '../ui/terraces';

/**
 * Life in the air, all in one draw call of point sprites (they land as crisp squares in the
 * pixel look): drifting motes, grass flicks from strikes and slides, breath puffs on cold
 * evenings, goal confetti and flare smoke in the stands. Everything follows the shared wind.
 */

const MAX = 2200;
/** Confetti lying on the pitch (a ring: the oldest pieces go first). */
const GROUND = 1600;
const MOTES = 170;
const FLOOD_MOTE = new THREE.Color(0.85, 0.9, 1);

enum Kind {
  Mote = 0,
  Grass = 1,
  Breath = 2,
  Confetti = 3,
  Smoke = 4,
  Flare = 5,
}

export class Particles {
  readonly points: THREE.Points;
  private pos = new Float32Array(MAX * 3);
  private col = new Float32Array(MAX * 3);
  private size = new Float32Array(MAX);
  private alpha = new Float32Array(MAX);
  private vel = new Float32Array(MAX * 3);
  private life = new Float32Array(MAX);
  private maxLife = new Float32Array(MAX);
  private kind = new Uint8Array(MAX);
  private baseSize = new Float32Array(MAX);
  private next = MOTES;
  /** Particles alive beyond the motes (0 most of a match: then only the motes are drawn
   * and uploaded), and whether any were last frame. */
  private live = 0;
  /** One past the highest slot that is alive (or just died and still needs its alpha zeroed). */
  private hi = MOTES;
  /** New particles were spawned: frames left in which the colours are uploaded whole (one per buffer). */
  private colDirty = 0;
  private gPos = new Float32Array(GROUND * 3);
  private gCol = new Float32Array(GROUND * 3);
  private gSize = new Float32Array(GROUND);
  private gAlpha = new Float32Array(GROUND);
  private gLife = new Float32Array(GROUND);
  private gNext = 0;
  private gLive = 0;
  private gLanded = false;
  private groundGeo: THREE.BufferGeometry;
  private ground: THREE.Points;
  private mat: THREE.ShaderMaterial;
  private geo: THREE.BufferGeometry;
  private c = new THREE.Color();
  private breathT = new Float32Array(22);
  private home: number;
  private away: number;

  constructor(home: number, away: number) {
    this.home = home;
    this.away = away;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uScale: { value: 400 } },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aAlpha;
        attribute vec3 color;
        uniform float uScale;
        varying vec3 vCol;
        varying float vA;
        varying float vSoft;
        void main() {
          if (aAlpha < 0.01) {
            // Dead: off screen, so it doesn't even reach the rasteriser.
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            gl_PointSize = 1.0;
            return;
          }
          vCol = color;
          vA = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = max(1.0, aSize * uScale / -mv.z);
          vSoft = clamp((gl_PointSize - 3.0) / 6.0, 0.0, 1.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vCol;
        varying float vA;
        varying float vSoft;
        void main() {
          if (vA < 0.01) discard;
          // Tiny particles stay crisp pixels; big ones (smoke, breath) become soft puffs.
          float d = length(gl_PointCoord - 0.5);
          if (vSoft > 0.0 && d > 0.5) discard;
          float a = vA * mix(1.0, smoothstep(0.5, 0.12, d), vSoft);
          gl_FragColor = vec4(vCol, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 8;
    // Landed confetti: its own little layer, so it stays put for a while instead of being
    // recycled with the rest (same sprites, drawn with the particles).
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(this.gPos, 3).setUsage(THREE.DynamicDrawUsage));
    gg.setAttribute('color', new THREE.BufferAttribute(this.gCol, 3).setUsage(THREE.DynamicDrawUsage));
    gg.setAttribute('aSize', new THREE.BufferAttribute(this.gSize, 1).setUsage(THREE.DynamicDrawUsage));
    gg.setAttribute('aAlpha', new THREE.BufferAttribute(this.gAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.groundGeo = gg;
    const ground = new THREE.Points(gg, this.mat);
    ground.visible = false;
    this.ground = ground;
    ground.frustumCulled = false;
    ground.renderOrder = 7;
    this.points.add(ground);
    for (let i = 0; i < MOTES; i++) this.spawnMote(i, 0, 0, true);
  }

  /** Pixels-per-metre-at-1m for point sizes (depends on the render height). */
  setScale(renderHeight: number, fovDeg: number): void {
    this.mat.uniforms.uScale.value = renderHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  private alloc(): number {
    // All gone: the ring starts again at the bottom, so the live window stays short.
    if (this.live === 0 && this.hi === MOTES) this.next = MOTES;
    const i = this.next;
    if (i >= this.hi) this.hi = i + 1;
    this.next = this.next + 1 >= MAX ? MOTES : this.next + 1;
    return i;
  }

  private spawn(kind: Kind, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, color: number): void {
    const i = this.alloc();
    if (this.life[i] <= 0) this.live++;
    this.colDirty = RING;
    this.kind[i] = kind;
    const i3 = i * 3;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.baseSize[i] = size;
    this.c.setHex(color);
    this.col[i3] = this.c.r;
    this.col[i3 + 1] = this.c.g;
    this.col[i3 + 2] = this.c.b;
  }

  private spawnMote(i: number, cx: number, cz: number, anywhere: boolean): void {
    this.kind[i] = Kind.Mote;
    const x = cx + (Math.random() - 0.5) * 70;
    const z = cz + (Math.random() - 0.5) * 44;
    const y = anywhere ? 0.4 + Math.random() * 8 : 0.4 + Math.random() * 8;
    const i3 = i * 3;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.vel[i3] = 0;
    this.vel[i3 + 1] = (Math.random() - 0.5) * 0.08;
    this.vel[i3 + 2] = 0;
    this.life[i] = 1;
    this.maxLife[i] = 1;
    this.baseSize[i] = 0.035 + Math.random() * 0.03;
  }

  /** Grass bits kicked up at (x, z). */
  grassBurst(x: number, z: number, strength: number, dirX = 0, dirZ = 0): void {
    const n = Math.round(4 + strength * 10);
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const s = 0.8 + Math.random() * 2.2 * (0.5 + strength);
      const shade = Math.random() < 0.3 ? 0x6b8a3a : Math.random() < 0.5 ? 0x4c7a2c : 0x8a7a4a;
      this.spawn(Kind.Grass, x, 0.05, z, Math.cos(a) * s * 0.5 + dirX * s, 1.2 + Math.random() * 2.4 * (0.5 + strength), Math.sin(a) * s * 0.5 + dirZ * s, 0.5 + Math.random() * 0.5, 0.05 + Math.random() * 0.03, shade);
    }
    if (SHARED.uRain.value > 0.5) this.spray(x, z, 6 + strength * 14, 1 + strength, dirX, dirZ);
  }

  /** Rain: water flung off the soaked turf (strikes, slides, a ball skidding through). */
  spray(x: number, z: number, n: number, power: number, dirX = 0, dirZ = 0): void {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const s = (0.5 + Math.random() * 1.8) * power;
      this.spawn(Kind.Grass, x, 0.04, z, Math.cos(a) * s * 0.6 + dirX * s * 1.5, 0.8 + Math.random() * 1.8 * power, Math.sin(a) * s * 0.6 + dirZ * s * 1.5, 0.35 + Math.random() * 0.3, 0.035 + Math.random() * 0.025, Math.random() < 0.5 ? 0xd8e2f0 : 0xa9b8cc);
    }
  }

  /**
   * Ticker tape and confetti thrown from an end (0 = home, behind the left goal): it
   * flutters out over the goalmouth on the wind and settles on the grass.
   */
  throwConfetti(end: 0 | 1, amount: number): void {
    const s = end === 0 ? -1 : 1;
    const teamCol = end === 0 ? this.home : this.away;
    for (let k = 0; k < amount; k++) {
      const x = s * (PITCH.halfL + 6 + Math.random() * 14);
      const r = Math.random();
      const color = r < 0.45 ? teamCol : r < 0.78 ? 0xf6f1e3 : r < 0.9 ? 0xffd447 : 0x9fd0ff;
      this.spawn(Kind.Confetti, x, 5 + Math.random() * 8, (Math.random() - 0.5) * 46, -s * (1.5 + Math.random() * 4), -0.5, (Math.random() - 0.5) * 1.6, 16, 0.09 + Math.random() * 0.05, color);
    }
  }

  /** A piece of confetti has landed: it lies on the grass for half a minute or so. */
  private land(i: number): void {
    const j = this.gNext;
    this.gNext = (j + 1) % GROUND;
    if (this.gLife[j] <= 0) this.gLive++;
    this.gPos[j * 3] = this.pos[i * 3];
    this.gPos[j * 3 + 1] = 0.03;
    this.gPos[j * 3 + 2] = this.pos[i * 3 + 2];
    this.gCol[j * 3] = this.col[i * 3];
    this.gCol[j * 3 + 1] = this.col[i * 3 + 1];
    this.gCol[j * 3 + 2] = this.col[i * 3 + 2];
    this.gSize[j] = this.baseSize[i] * 0.8;
    this.gLife[j] = 30 + Math.random() * 30;
    this.gLanded = true;
  }

  /** Goal: confetti and ticker tape from the stands. */
  confetti(cx: number, team: 0 | 1): void {
    const teamCol = team === 0 ? this.home : this.away;
    for (let k = 0; k < 420; k++) {
      const x = cx + (Math.random() - 0.5) * 90;
      const z = -(PITCH.halfW + 8 + Math.random() * 14);
      const y = 6 + Math.random() * 12;
      const r = Math.random();
      const color = r < 0.45 ? teamCol : r < 0.75 ? 0xf6f1e3 : r < 0.88 ? 0xffd447 : 0x9fd0ff;
      this.spawn(Kind.Confetti, x, y, z, (Math.random() - 0.3) * 1.5, -0.4 - Math.random() * 0.8, 1.5 + Math.random() * 2.5, 4 + Math.random() * 2.5, 0.09 + Math.random() * 0.05, color);
    }
  }

  update(dt: number, time: number, match: Match, focusX: number, focusZ: number, terraces?: Terraces): void {
    const wind = SHARED.uWind.value;
    const flood = SHARED.uFlood.value;
    // Motes: warm sparkles in the sun, cool specks under floodlights.
    this.c.setRGB(1, 0.94, 0.78).lerp(FLOOD_MOTE, Math.min(1, flood * 1.2));
    const moteR = this.c.r;
    const moteG = this.c.g;
    const moteB = this.c.b;

    // Rain: the ball throws up a wake skidding over the wet grass; sprinting boots splash.
    if (SHARED.uRain.value > 0.5 && dt > 0) {
      const b = match.ball;
      const bs = Math.hypot(b.vel.x, b.vel.z);
      if (b.pos.y < 0.2 && bs > 4 && Math.random() < bs * dt * 2.5) this.spray(b.pos.x, b.pos.z, 2, 0.4 + bs * 0.04, b.vel.x * 0.05, b.vel.z * 0.05);
      for (const p of match.players) if (p.speed > 6 && Math.random() < dt * 3) this.spray(p.pos.x, p.pos.z, 2, 0.5, p.vel.x * 0.04, p.vel.z * 0.04);
    }
    // Breath puffs on cold evenings, from players who are working hard.
    if (flood > 0.45) {
      for (const p of match.players) {
        this.breathT[p.id] -= dt;
        if (p.speed > 5.5 && this.breathT[p.id] <= 0) {
          this.breathT[p.id] = 0.45 + Math.random() * 0.3;
          const fx = Math.cos(p.facing);
          const fz = Math.sin(p.facing);
          this.spawn(Kind.Breath, p.pos.x + fx * 0.25, 1.68 * p.look.height, p.pos.z + fz * 0.25, p.vel.x * 0.6 + fx * 0.6, 0.15, p.vel.z * 0.6 + fz * 0.6, 0.7, 0.12, 0xeef2ff);
        }
        // Slide tackles throw up grass.
        if (p.action === 'slide' && p.actionT < 0.5 && Math.random() < 0.5) this.grassBurst(p.pos.x, p.pos.z, 0.3, p.vel.x * 0.15, p.vel.z * 0.15);
      }
    }
    // Confetti the terraces throw.
    if (terraces && terraces.confetti.length) {
      for (const c of terraces.confetti) this.throwConfetti(c.end, c.amount);
      terraces.confetti.length = 0;
    }
    // Confetti on the grass: lies there, then fades away.
    this.ground.visible = this.gLive > 0;
    if (this.gLive > 0 && dt > 0) {
      for (let j = 0; j < GROUND; j++) {
        if (this.gLife[j] <= 0) continue;
        this.gLife[j] -= dt;
        if (this.gLife[j] <= 0) this.gLive--;
        this.gAlpha[j] = this.gLife[j] > 0 ? Math.min(0.95, this.gLife[j] / 6) : 0;
      }
      const gg = this.groundGeo.attributes;
      (gg.aAlpha as THREE.BufferAttribute).needsUpdate = true;
      if (this.gLanded) {
        this.gLanded = false;
        (gg.position as THREE.BufferAttribute).needsUpdate = true;
        (gg.color as THREE.BufferAttribute).needsUpdate = true;
        (gg.aSize as THREE.BufferAttribute).needsUpdate = true;
      }
    }

    // Pyro in the ends (the terraces director decides what burns where): each flare spits
    // sparks and pours out smoke that the wind carries off over the stand; smoke bombs
    // billow in the club's colour.
    if (terraces && dt > 0) {
      for (const f of terraces.pyro) {
        const age = terraces.t - f.born;
        if (age < 0) continue;
        const fade = Math.min(1, age / 0.6, (f.life - age) / 1.5);
        if (fade <= 0) continue;
        if (f.smoke) {
          if (Math.random() < 4.5 * dt * fade) {
            const col = f.end === 0 ? this.home : this.away;
            this.spawn(Kind.Smoke, f.x + (Math.random() - 0.5) * 1.2, f.y - 0.6, f.z + (Math.random() - 0.5) * 1.2, wind.x * 0.6 + (Math.random() - 0.5) * 1.2, 0.5 + Math.random() * 0.6, wind.y * 0.6 + (Math.random() - 0.5) * 1.2, 7 + Math.random() * 3, 2.5, col);
          }
          continue;
        }
        if (Math.random() < 0.6 * fade) {
          this.spawn(Kind.Flare, f.x + (Math.random() - 0.5) * 0.35, f.y + Math.random() * 0.2, f.z + (Math.random() - 0.5) * 0.35, (Math.random() - 0.5) * 1.6, 0.6 + Math.random() * 1.6, (Math.random() - 0.5) * 1.6, 0.18 + Math.random() * 0.15, 0.2 + Math.random() * 0.25, Math.random() < 0.4 ? 0xffd9a0 : 0xff4a2a);
        }
        if (Math.random() < 2.2 * dt * fade) {
          this.spawn(Kind.Smoke, f.x, f.y + 0.4, f.z, wind.x * 0.8 + (Math.random() - 0.5) * 0.5, 0.55 + Math.random() * 0.45, wind.y * 0.8 + (Math.random() - 0.5) * 0.5, 8 + Math.random() * 3, 1.7, Math.random() < 0.5 ? 0xe2b3ad : 0xc9b8b6);
        }
      }
    }

    // Only the window of slots in use is walked (and uploaded): beyond hi everything is dead.
    const end = this.hi;
    let hi = MOTES;
    for (let i = 0; i < end; i++) {
      const k = this.kind[i];
      const i3 = i * 3;
      if (k === Kind.Mote && i < MOTES) {
        // Drift with the wind, bob gently, wrap around the camera's view.
        this.pos[i3] += (wind.x * 0.55 + Math.sin(time * 0.7 + i) * 0.12) * dt;
        this.pos[i3 + 1] += (Math.sin(time * 0.9 + i * 1.7) * 0.12 + this.vel[i3 + 1]) * dt;
        this.pos[i3 + 2] += (wind.y * 0.55 + Math.cos(time * 0.6 + i * 0.7) * 0.12) * dt;
        const dx = this.pos[i3] - focusX;
        const dz = this.pos[i3 + 2] - focusZ;
        if (dx > 35) this.pos[i3] -= 70;
        if (dx < -35) this.pos[i3] += 70;
        if (dz > 24) this.pos[i3 + 2] -= 44;
        if (dz < -20) this.pos[i3 + 2] += 44;
        if (this.pos[i3 + 1] > 9 || this.pos[i3 + 1] < 0.3) this.pos[i3 + 1] = 0.4 + Math.random() * 8;
        const tw = 0.5 + 0.5 * Math.sin(time * 2.3 + i * 3.1);
        this.col[i3] = moteR;
        this.col[i3 + 1] = moteG;
        this.col[i3 + 2] = moteB;
        this.alpha[i] = (0.18 + 0.32 * tw) * (match.phase === 'goal' ? 0.6 : 1);
        this.size[i] = this.baseSize[i];
        continue;
      }
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      hi = i + 1;
      this.life[i] -= dt;
      const died = this.life[i] <= 0;
      if (died) this.live--;
      const t = 1 - this.life[i] / this.maxLife[i]; // 0 → 1 over the life
      let vx = this.vel[i3];
      let vy = this.vel[i3 + 1];
      let vz = this.vel[i3 + 2];
      switch (k) {
        case Kind.Grass:
          vy -= 9.8 * dt;
          vx *= 1 - dt * 1.5;
          vz *= 1 - dt * 1.5;
          if (this.pos[i3 + 1] < 0.02 && vy < 0) {
            vy = 0;
            vx *= 0.5;
            vz *= 0.5;
          }
          this.alpha[i] = 1 - t * t;
          this.size[i] = this.baseSize[i];
          break;
        case Kind.Breath:
          vx *= 1 - dt * 3;
          vz *= 1 - dt * 3;
          this.alpha[i] = 0.35 * (1 - t);
          this.size[i] = this.baseSize[i] * (1 + t * 2.2);
          break;
        case Kind.Confetti:
          // Flutter down, carried by the wind.
          vx += (wind.x * 0.6 - vx) * dt * 0.8 + Math.sin(time * 5 + i) * 1.2 * dt;
          vz += (wind.y * 0.6 - vz) * dt * 0.3;
          vy += (-1.25 - vy) * dt * 2;
          if (this.pos[i3 + 1] < 0.05) {
            // On the grass (the pitch and its surrounds): it stays there for a while.
            if (Math.abs(this.pos[i3]) < PITCH.halfL + 4 && Math.abs(this.pos[i3 + 2]) < PITCH.halfW + 4) this.land(i);
            if (!died) this.live--;
            this.life[i] = 0;
            this.alpha[i] = 0;
            continue;
          }
          this.alpha[i] = Math.min(1, (1 - t) * 3);
          this.size[i] = this.baseSize[i] * (0.6 + 0.4 * Math.abs(Math.sin(time * 9 + i)));
          break;
        case Kind.Smoke:
          vx += (wind.x * 1.2 - vx) * dt * 0.4;
          vz += (wind.y * 1.2 - vz) * dt * 0.4;
          vy *= 1 - dt * 0.2;
          this.alpha[i] = 0.2 * Math.sin(Math.min(1, t * 1.3) * Math.PI) * (0.5 + 0.5 * flood);
          this.size[i] = this.baseSize[i] * (1 + t * 4.5);
          break;
        case Kind.Flare:
          vy -= 4 * dt;
          this.alpha[i] = 0.95 * (1 - t);
          this.size[i] = this.baseSize[i] * (0.8 + Math.random() * 0.4);
          break;
      }
      this.vel[i3] = vx;
      this.vel[i3 + 1] = vy;
      this.vel[i3 + 2] = vz;
      this.pos[i3] += vx * dt;
      this.pos[i3 + 1] += vy * dt;
      this.pos[i3 + 2] += vz * dt;
    }
    // Upload (and draw) only what's in use: the motes, plus the rest while any is alive.
    this.hi = hi;
    this.geo.setDrawRange(0, end);
    // Into the buffers not in use (see pingPong); new colours go to each, one a frame.
    const names = ['position', 'aSize', 'aAlpha', 'color'];
    for (let k = 0; k < 4; k++) flipAttribute(this.geo, names[k], k === 3 && this.colDirty === 0 ? MOTES : end);
    if (this.colDirty > 0) this.colDirty--;
  }
}
