import * as THREE from 'three';
import { PITCH } from '../sim/constants';
import type { Match } from '../sim/match';
import type { Player } from '../sim/player';
import { V3, clamp, lerp } from '../sim/vec';
import type { Officials } from '../render/officials';
import type { CameraRig } from '../render/cameraRig';
import type { Ground } from '../meta/club';

type P3 = [number, number, number];

interface Shot {
  kind: 'walk' | 'wide' | 'captains';
  dur: number;
  /** Camera position and look point at the start and end of the shot. */
  from: [P3, P3];
  to: [P3, P3];
  fov: number;
  /** From this shot on, the giant tifo is let down. */
  hang?: boolean;
}

/** The front of the far stand, where the tunnel comes out. */
const MOUTH_Z = -(PITCH.halfW + 7.5);
const WALK = 1.45;
/** The line-up for the toss: both teams in a row behind the centre spot, facing the camera. */
const LINE_Z = -5.5;

/** The wide establishing shots of each ground (the bare pitch has none). */
const WIDE: Record<Ground, Shot[]> = {
  stadium: [
    // Craning over the home end's corner, the whole bowl full.
    { kind: 'wide', dur: 3, from: [[-70, 34, 52], [10, 4, -12]], to: [[-46, 30, 60], [18, 6, -18]], fov: 40 },
    // Low on the pitch, up at the home end and its card display.
    { kind: 'wide', dur: 3, from: [[-22, 3.5, 20], [-80, 13, 2]], to: [[-27, 4.5, 5], [-80, 14, -6]], fov: 40 },
    // The main stand: the giant tifo drops from the roof and the camera follows it down.
    { kind: 'wide', dur: 5, from: [[-7, 2.2, 27], [0, 40, -52]], to: [[6, 2.6, 21], [0, 27, -52]], fov: 44, hang: true },
  ],
  old: [
    { kind: 'wide', dur: 3, from: [[-70, 30, 52], [10, 4, -12]], to: [[-46, 27, 60], [18, 6, -18]], fov: 40 },
    // The old main stand and its gable.
    { kind: 'wide', dur: 3, from: [[12, 3, 22], [0, 9, -60]], to: [[-8, 3, 18], [0, 10, -60]], fov: 40 },
    // The Shed, packed and bouncing.
    { kind: 'wide', dur: 5, from: [[-30, 2.5, 14], [-80, 9, 0]], to: [[-36, 3, -10], [-80, 10, 2]], fov: 40 },
  ],
  bare: [],
};

/**
 * Before kick-off: the teams walk out of the tunnel, wide shots of the ground (the last one
 * on the home fans' giant tifo), then the referees and the two captains at the centre spot.
 * A tap cuts to the next shot. Purely presentational: the match is not stepped while it
 * runs, and every player is put back exactly as the match left him when it ends.
 */
export class Cutscene {
  readonly el = document.createElement('div');
  private shots: Shot[] = [];
  private i = -1;
  private t = 0;
  private match: Match | null = null;
  private officials: Officials | null = null;
  private saved: Record<string, unknown>[] = [];
  private home: Player[] = [];
  private away: Player[] = [];
  private spots = new Map<Player, { x: number; z: number; lx: number; lz: number }>();
  private cam = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 40 };
  private title: HTMLElement;
  private sub: HTMLElement;
  private onDone: () => void = () => {};
  /** The giant tifo is down (or coming down). */
  hang = 0;

  constructor(parent: HTMLElement) {
    this.el.className = 'cutscene hidden';
    this.el.innerHTML = '<i class="cs-bar top"></i><i class="cs-bar bot"></i><div class="cs-cap"><b></b><span></span></div><div class="cs-skip">Tap to skip ›</div>';
    this.title = this.el.querySelector('b')!;
    this.sub = this.el.querySelector('.cs-cap span')!;
    this.el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.next();
    });
    parent.appendChild(this.el);
  }

  get active(): boolean {
    return this.i >= 0;
  }

  start(match: Match, officials: Officials, ground: Ground, onDone: () => void): void {
    this.match = match;
    this.officials = officials;
    this.onDone = onDone;
    // Everything the walk-out touches, to be handed back untouched.
    this.saved = match.players.map((p) => {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p)) o[k] = v instanceof V3 ? v.clone() : v;
      return o;
    });
    // Captain first, then the rest; the keeper brings up the rear.
    const order = (t: number) => {
      const team = match.teams[t];
      const cap = team.players[team.captain];
      return [cap, ...team.players.filter((p) => p !== cap && p.role !== 'GK'), ...team.players.filter((p) => p !== cap && p.role === 'GK')];
    };
    this.home = order(0);
    this.away = order(1);
    // Where each ends up: the captains with the referee at the centre spot, the rest in line.
    this.spots.clear();
    [this.home, this.away].forEach((list, t) => {
      const s = t === 0 ? -1 : 1;
      list.forEach((p, k) => {
        if (k === 0) this.spots.set(p, { x: s * 0.95, z: 0.9, lx: 0, lz: 0.9 });
        else this.spots.set(p, { x: s * (1.55 + k * 1.05), z: LINE_Z, lx: s * (1.55 + k * 1.05), lz: 30 });
      });
    });
    const [ref, a1, a2] = officials.all;
    this.spots.set(ref, { x: 0, z: -0.1, lx: 0, lz: 30 });
    this.spots.set(a1, { x: -1.9, z: -0.9, lx: -1.9, lz: 30 });
    this.spots.set(a2, { x: 1.9, z: -0.9, lx: 1.9, lz: 30 });

    const walk: Shot = { kind: 'walk', dur: 3, from: [[3.4, 1.55, -28.4], [0, 1.25, -36.5]], to: [[2.8, 1.5, -29.6], [0, 1.2, -35.4]], fov: 34 };
    const toss: Shot = { kind: 'captains', dur: 4, from: [[0.7, 1.75, 7.6], [0, 1.15, 0]], to: [[0.2, 1.6, 5.6], [0, 1.2, 0]], fov: 34 };
    this.shots = [walk, ...WIDE[ground], toss];
    this.hang = 0;
    this.el.classList.remove('hidden');
    this.i = -1;
    this.next();
  }

  /** Cut to the next shot (a tap), or end. */
  next(): void {
    if (!this.match) return;
    this.i++;
    this.t = 0;
    const shot = this.shots[this.i];
    if (!shot) return this.finish();
    if (shot.hang) this.hang = 1;
    if (shot.kind === 'walk') this.lineUpInTunnel();
    if (shot.kind === 'captains') this.placeAtSpots();
    const m = this.match;
    const name = (t: number) => {
      const p = m.teams[t].players[m.teams[t].captain];
      return p.name ? p.name.split(' ').slice(-1)[0] : `#${p.number || p.index + 1}`;
    };
    const cap = shot.kind === 'walk' ? [m.teams[0].info.name, `v ${m.teams[1].info.name}`] : shot.kind === 'captains' ? ['Captains', `${name(0)} · ${name(1)}`] : null;
    this.el.classList.toggle('captioned', cap !== null);
    if (cap) {
      this.title.textContent = cap[0];
      this.sub.textContent = cap[1];
      // Restart the caption's fade-in.
      const c = this.el.querySelector('.cs-cap') as HTMLElement;
      c.style.animation = 'none';
      void c.offsetWidth;
      c.style.animation = '';
    }
  }

  /** Abandon it (a new match replaced this one): no hand-back, no callback. */
  cancel(): void {
    if (!this.active) return;
    this.i = -1;
    this.match = null;
    this.el.classList.add('hidden');
  }

  private finish(): void {
    const m = this.match!;
    // Hand every player back exactly as the match had him.
    m.players.forEach((p, n) => {
      const o = p as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(this.saved[n])) {
        if (v instanceof V3) (o[k] as V3).copy(v);
        else o[k] = v;
      }
    });
    for (const o of this.officials!.all) o.squareUp = false;
    this.officials!.reset();
    this.cancel();
    this.onDone();
  }

  update(dt: number, rig: CameraRig): void {
    if (!this.active) return;
    const shot = this.shots[this.i];
    this.t += dt;
    if (this.t >= shot.dur) {
      this.next();
      if (!this.active) return;
      return this.update(0, rig);
    }
    this.walk(dt);
    // A slow, even drift through the shot, eased only at the very start.
    const u = clamp(this.t / shot.dur, 0, 1);
    const e = u < 0.15 ? (u * u) / 0.3 : u - 0.075;
    const k = e / 0.925;
    const [p0, l0] = shot.from;
    const [p1, l1] = shot.to;
    this.cam.pos.set(lerp(p0[0], p1[0], k), lerp(p0[1], p1[1], k), lerp(p0[2], p1[2], k));
    this.cam.look.set(lerp(l0[0], l1[0], k), lerp(l0[1], l1[1], k), lerp(l0[2], l1[2], k));
    this.cam.fov = shot.fov;
    rig.cut = this.cam;
  }

  /** Two files in the tunnel mouth, captains at the front, the officials leading them out. */
  private lineUpInTunnel(): void {
    const put = (p: Player, x: number, z: number) => {
      p.pos.set(x, 0, z);
      p.prevPos.copy(p.pos);
      p.vel.set(0, 0, WALK);
      p.facing = p.prevFacing = Math.PI / 2;
      p.lookAt = null;
      p.squareUp = false;
      p.action = 'none';
    };
    this.home.forEach((p, k) => put(p, -0.85, MOUTH_Z + 3.4 - k * 1.25));
    this.away.forEach((p, k) => put(p, 0.85, MOUTH_Z + 3.4 - k * 1.25));
    const [ref, a1, a2] = this.officials!.all;
    put(ref, 0, MOUTH_Z + 5.4);
    put(a1, -1.45, MOUTH_Z + 5.1);
    put(a2, 1.45, MOUTH_Z + 5.1);
  }

  /** Everyone on his mark for the toss (a cut hides the jump). */
  private placeAtSpots(): void {
    for (const [p, s] of this.spots) {
      p.pos.set(s.x, 0, s.z);
      p.prevPos.copy(p.pos);
      p.vel.set(0, 0, 0);
      p.facing = p.prevFacing = Math.atan2(s.lz - s.z, s.lx - s.x);
      p.lookTarget.set(s.lx, 0, s.lz);
      p.lookAt = p.lookTarget;
      p.squareUp = true;
    }
  }

  /** Out of the tunnel in two files, then each to his mark, at a walk. */
  private walk(dt: number): void {
    if (dt <= 0) return;
    dt = Math.min(dt, 1 / 30);
    for (const [p, s] of this.spots) {
      // Straight out of the tunnel until clear of the dugouts, then across to his mark.
      const out = p.pos.z < MOUTH_Z + 12;
      const tx = out ? p.pos.x : s.x;
      const tz = out ? p.pos.z + 4 : s.z;
      const dx = tx - p.pos.x;
      const dz = tz - p.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.3) {
        p.moveX = p.moveZ = p.wantSpeed = 0;
        p.lookTarget.set(s.lx, 0, s.lz);
        p.lookAt = p.lookTarget;
        p.squareUp = true;
      } else {
        p.moveX = dx / d;
        p.moveZ = dz / d;
        p.wantSpeed = Math.min(WALK, d * 1.2 + 0.3);
        p.lookAt = null;
        p.squareUp = false;
      }
      p.sprinting = false;
      p.move(dt);
      // Drawn where he is now (the match isn't stepping, so nothing to interpolate).
      p.prevPos.copy(p.pos);
      p.prevFacing = p.facing;
    }
  }
}
