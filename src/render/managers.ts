import * as THREE from 'three';
import type { Match } from '../sim/match';
import { Player } from '../sim/player';
import type { Kit } from '../sim/teams';
import { coachOutfit, type Coach, type CoachStyle, type CoachTemper, type Outfit } from '../meta/club';
import { V3, clamp, lerp, smoothstep } from '../sim/vec';
import { ARMS, DUGOUT, squatLegs, type Arms, type BenchPose } from './bench';
import { litMaterial } from './look';

/**
 * The two managers, out in their technical areas in front of the dugouts. Each has a temper
 * for the day (fiery, cool or a showman) and a look (a dark suit, a long coat with the club
 * scarf, the club tracksuit or a padded jacket). They drift along the line with the play,
 * arms folded, hands in pockets, stroking the chin, checking the watch when it's tight late
 * on; they shout through cupped hands, point, wave the team forward. A goal sends them off:
 * a sprint down the touchline, a fist pump and a finger to the temple, or a water bottle
 * booted along the line. A foul brings the arms out wide, a miss hands to the head or down
 * on the haunches. At the end they meet for the handshake, then one applauds the fans and
 * the other trudges off.
 *
 * Purely visual (Math.random, never the match's rng), like the benches.
 */

type Temper = CoachTemper;
type Style = CoachStyle;
type Act =
  | 'none'
  | 'run' // celebration sprint down the line
  | 'fistpump'
  | 'temple' // a finger to the temple: "all planned"
  | 'turnaway'
  | 'crouch'
  | 'groan'
  | 'rage'
  | 'what'
  | 'bottle'
  | 'relief'
  | 'shake'
  | 'applaud'
  | 'slump';
type Idle = 'folded' | 'hips' | 'behind' | 'pockets' | 'watch' | 'chin' | 'shout' | 'point' | 'beckon' | 'clap';

const POSE: Record<Idle | 'what' | 'fist' | 'temple' | 'chest' | 'shake' | 'face' | 'applaud', Arms> = {
  folded: ARMS.folded,
  hips: ARMS.hips,
  behind: ARMS.behind,
  pockets: [-0.06, -0.06, 0.4, 0.4, 0.2, 0.2, -0.55, -0.55],
  watch: [0.95, -0.04, 1.85, 0.35, 0.08, 0.14, -1.25, 0],
  chin: [0.5, 0.75, 1.95, 2.45, 0.06, 0.12, -1.45, -1.1],
  shout: [1.45, 1.45, 2.4, 2.4, 0.5, 0.5, -0.9, -0.9],
  point: [-0.05, 1.55, 0.35, 0.08, 0.12, 0.25, 0, 0],
  beckon: [1.25, 1.25, 0.9, 0.9, 0.35, 0.35, -0.3, -0.3],
  clap: ARMS.clap,
  what: [0.45, 0.45, 0.75, 0.75, 1.15, 1.15, 0.6, 0.6],
  fist: [0.1, 1.6, 0.4, 2.3, 0.15, 0.45, 0, -0.3],
  temple: [0.4, 1.95, 1.9, 2.6, 0.06, 0.75, -1.4, -0.7],
  chest: [0.55, 0.6, 2.1, 2.1, 0.1, 0.1, -1.2, -1.2],
  shake: [-0.05, 0.85, 0.35, 0.45, 0.12, -0.05, 0, -0.25],
  face: [2.0, 2.0, 2.5, 2.5, 0.3, 0.3, -0.6, -0.6],
  applaud: [2.2, 2.2, 1.0, 1.0, 0.25, 0.25, -0.5, -0.5],
};

/** Where he stands: just in front of the dugout, a stride back from the assistant's line. */
const LINE_Z = DUGOUT.z + 1.15;
const BACK_Z = DUGOUT.z + 0.6;
const FRONT_Z = DUGOUT.z + 1.95;
const BOTTLE_Z = DUGOUT.z + 0.95;
const KICK_DUR = 0.7;
const KICK_AT = 0.45;

interface Bottle {
  obj: THREE.Group;
  pos: V3;
  vel: V3;
  /** Tumble about a horizontal axis across its flight: angle, rate, axis heading. */
  ang: number;
  spin: number;
  yaw: number;
  moving: boolean;
}

interface Boss {
  p: Player;
  team: number;
  /** Centre of his technical area (x). */
  hx: number;
  /** +1 / -1: along the line away from halfway. */
  away: number;
  temper: Temper;
  style: Style;
  act: Act;
  actAt: number;
  actEnd: number;
  next: Act;
  nextDur: number;
  idle: Idle;
  idleUntil: number;
  /** Pacing: a spot along the line he heads to for a while. */
  paceX: number;
  paceUntil: number;
  /** Celebration sprint / walk destination. */
  goX: number;
  goZ: number;
  kickT: number;
  kickDir: V3;
  /** At the handshake: the two of them have met. */
  met: boolean;
  bottle: Bottle;
  ph: number;
  // Smoothed upper-body pose.
  arms: number[];
  w: number;
  flex: number;
  side: number;
  tw: number;
  head: number;
  squat: number;
  lift: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
const ease = (k: number) => smoothstep(0, 1, k);

export class Managers {
  readonly all: Player[] = [];
  readonly group = new THREE.Group();
  private bosses: Boss[] = [];
  private t = 0;
  private lastPhase = '';
  private shotLive = [false, false];
  private missAt = [-1, -1];
  private lastFoulT = -1;
  private out: BenchPose = {
    legs: 0, hipY: 0, hipL: 0, hipR: 0, kneeL: 0, kneeR: 0, legOutL: 0, legOutR: 0, legYawL: 0, legYawR: 0, ankleL: 0, ankleR: 0,
    arms: 0, armL: 0, armR: 0, elbowL: 0, elbowR: 0, armOutL: 0, armOutR: 0, armRotL: 0, armRotR: 0,
    flex: 0, side: 0, twist: 0, headPitch: 0, lift: 0, look: true,
    kick: 0, kickHip: 0, kickKnee: 0, kickAnkle: 0, plantHip: 0, plantKnee: 0,
  };
  private look = new V3();

  constructor(private readonly firstId: number) {
    const attrs = { pace: 0.45, accel: 0.5, control: 0.5, passing: 0.5, shooting: 0.5, strength: 0.6, defending: 0.5, keeping: 0.5, agility: 0.45, stamina: 0.7, jumping: 0.4, power: 0.5, height: 1.79, weight: 86 };
    const body = new THREE.CylinderGeometry(0.036, 0.036, 0.19, 8);
    const cap = new THREE.CylinderGeometry(0.02, 0.026, 0.04, 8);
    cap.translate(0, 0.115, 0);
    for (let team = 0; team < 2; team++) {
      const sgn = team === 0 ? -1 : 1;
      const p = new Player(firstId + team, team, 30, 'MID', 0, 0, { ...attrs }, { skin: 0xd9a77c, hair: 0x8f8f8f, hairStyle: 0, height: 1, build: 1.1 });
      p.number = -1;
      this.all.push(p);
      const obj = new THREE.Group();
      obj.add(new THREE.Mesh(body, litMaterial({ color: team === 0 ? 0x2f86d8 : 0x49b85c, roughness: 0.35 })));
      obj.add(new THREE.Mesh(cap, litMaterial({ color: 0xf2f2ee, roughness: 0.5 })));
      this.group.add(obj);
      this.bosses.push({
        p, team, hx: sgn * DUGOUT.x, away: sgn, temper: 'cool', style: 'suit', act: 'none', actAt: 0, actEnd: 0, next: 'none', nextDur: 0,
        idle: 'folded', idleUntil: 0, paceX: sgn * DUGOUT.x, paceUntil: 0, goX: 0, goZ: 0, kickT: -1, kickDir: new V3(1, 0, 0), met: false,
        bottle: { obj, pos: new V3(), vel: new V3(), ang: 0, spin: 0, yaw: 0, moving: false },
        ph: Math.random() * 100, arms: [...ARMS.folded], w: 1, flex: 0, side: 0, tw: 0, head: 0, squat: 0, lift: 0,
      });
    }
    this.reset();
  }

  /** New match: yours as you made him (`coach`), theirs a fresh temper and outfit; both back
   * in their areas, bottles by the dugouts. */
  reset(coach?: Coach): void {
    const styles: Style[] = ['suit', 'coat', 'track', 'puffer'];
    const tempers: Temper[] = ['fiery', 'cool', 'showman'];
    const hairs = [0x8f8f8f, 0xd6d3cc, 0x1b1410, 0x4a3324, -1];
    const skins = [0xf1c9a5, 0xd9a77c, 0xc68a5c, 0x8d5a3b];
    const s0 = pick(styles);
    for (const b of this.bosses) {
      const mine = b.team === 0 && coach;
      b.style = mine ? coach.style : b.team === 0 ? s0 : pick(styles.filter((s) => s !== this.bosses[0].style));
      b.temper = mine ? coach.temper : pick(tempers);
      const p = b.p;
      p.look.skin = mine ? coach.skin : pick(skins);
      const hair = mine ? coach.hair : pick(hairs);
      // Bald: a close crop in a shade of his skin.
      p.look.hair = hair < 0 ? new THREE.Color(p.look.skin).multiplyScalar(0.82).getHex() : hair;
      p.look.hairStyle = hair < 0 ? 0 : mine ? coach.hairStyle : pick([0, 2, 3]);
      p.attrs.height = mine ? coach.height : rand(1.7, 1.9);
      p.attrs.weight = mine ? [70, 84, 100][coach.build] * (coach.height / 1.8) : rand(74, 98);
      p.name = mine ? coach.name : '';
      p.pos.set(b.hx, 0, LINE_Z);
      p.prevPos.copy(p.pos);
      p.vel.set(0, 0, 0);
      p.facing = p.prevFacing = Math.PI / 2;
      b.act = 'none';
      b.next = 'none';
      b.kickT = -1;
      b.idleUntil = 0;
      b.paceUntil = 0;
      b.squat = 0;
      this.placeBottle(b);
    }
    this.lastPhase = '';
  }

  /** His clothes for the day (null for anyone else). */
  outfit(p: Player, kit: Kit): Outfit | null {
    const b = this.bosses[p.id - this.firstId];
    if (!b || b.p !== p) return null;
    return coachOutfit(b.style, kit, b.team === 1);
  }

  private placeBottle(b: Boss): void {
    const o = b.bottle;
    o.pos.set(b.hx + b.away * rand(1.2, 2.6), 0, BOTTLE_Z + rand(-0.15, 0.1));
    o.vel.set(0, 0, 0);
    o.ang = 0;
    o.spin = 0;
    o.moving = false;
    this.drawBottle(o);
  }

  private drawBottle(o: Bottle): void {
    // pos.y is its lowest point: the centre sits half its height up stood on its base,
    // a radius up lying on its side. It tumbles end over end across the way it flies.
    const c = Math.abs(Math.cos(o.ang));
    const s = Math.abs(Math.sin(o.ang));
    o.obj.position.set(o.pos.x, o.pos.y + 0.095 * c + 0.036 * s, o.pos.z);
    o.obj.rotation.set(0, -o.yaw, 0);
    o.obj.rotateZ(o.ang);
  }

  /** The pose for a manager (null for anyone else). */
  pose(p: Player, leg: number): BenchPose | null {
    const b = this.bosses[p.id - this.firstId];
    if (!b || b.p !== p) return null;
    const o = this.out;
    const t = this.t;
    const sq = ease(b.squat);
    if (sq > 0) squatLegs(o, leg, sq);
    else {
      o.legs = 0;
      o.ankleL = o.ankleR = 0;
    }
    o.legOutL = o.legOutR = 0.2 * sq;
    o.legYawL = o.legYawR = 0.3 * sq;
    const a = b.arms;
    o.arms = b.w;
    o.armL = a[0];
    o.armR = a[1];
    o.elbowL = a[2];
    o.elbowR = a[3];
    o.armOutL = a[4];
    o.armOutR = a[5];
    o.armRotL = a[6];
    o.armRotR = a[7];
    o.flex = b.flex + 0.42 * sq;
    o.side = b.side;
    o.twist = b.tw;
    o.headPitch = b.head;
    o.lift = b.lift;
    o.look = b.head < 0.25 && b.act !== 'turnaway' && b.act !== 'slump';
    // Live movement on top of the eased pose.
    const k = b.act !== 'none' && t >= b.actAt ? smoothstep(0, 0.3, t - b.actAt) * smoothstep(0, 0.4, b.actEnd - t) : 0;
    const idleOn = b.act === 'none' || t < b.actAt ? 1 : 1 - k;
    const ph = t + b.ph;
    if (b.act === 'fistpump' && k > 0) {
      const pump = Math.max(0, Math.sin(ph * 9));
      o.armR -= 0.55 * pump * k;
      o.elbowR += 0.35 * pump * k;
    } else if (b.act === 'rage' || b.act === 'what') {
      const fling = Math.sin(ph * (b.act === 'rage' ? 7 : 4.5));
      o.armOutL += 0.3 * fling * k;
      o.armOutR += 0.3 * fling * k;
      o.armL += 0.25 * Math.max(0, fling) * k;
      o.armR += 0.25 * Math.max(0, fling) * k;
      o.twist += 0.18 * Math.sin(ph * 3.1) * k;
    } else if (b.act === 'shake' && b.met) {
      o.armR += 0.14 * Math.sin(ph * 13) * k;
    } else if (b.act === 'applaud' || (b.act === 'none' && b.idle === 'clap')) {
      const ck = b.act === 'none' ? 1 : k;
      const c = Math.max(0, Math.sin(ph * 12)) * 0.22 * ck;
      o.armOutL += c;
      o.armOutR += c;
    } else if (b.act === 'turnaway') {
      o.twist += 0.15 * Math.sin(ph * 6) * k;
    }
    if (idleOn > 0 && b.idle === 'beckon') {
      const wave = Math.sin(ph * 6.5);
      o.armL += 0.35 * wave * idleOn;
      o.armR += 0.35 * wave * idleOn;
      o.elbowL += 0.4 * Math.max(0, -wave) * idleOn;
      o.elbowR += 0.4 * Math.max(0, -wave) * idleOn;
    } else if (idleOn > 0 && b.idle === 'point') {
      o.armOutR += 0.35 * Math.sin(ph * 1.3) * idleOn;
    } else if (idleOn > 0 && b.idle === 'shout') {
      o.flex -= 0.08 * Math.max(0, Math.sin(ph * 4)) * idleOn;
    }
    // The bottle kick (right foot).
    if (b.kickT >= 0) {
      const u = clamp(b.kickT / KICK_DUR, 0, 1);
      const c = KICK_AT / KICK_DUR;
      const back = c * 0.6;
      let hip: number;
      let knee: number;
      if (u < back) {
        hip = lerp(0, -0.5, ease(u / back));
        knee = lerp(0.2, 1.5, ease(u / back));
      } else if (u < c) {
        const v = (u - back) / (c - back);
        hip = lerp(-0.5, 0.95, ease(v));
        knee = lerp(1.5, 0.1, Math.pow(v, 1.4));
      } else {
        const v = (u - c) / (1 - c);
        hip = lerp(lerp(0.95, 1.45, smoothstep(0, 0.35, v)), 0.05, smoothstep(0.35, 1, v));
        knee = lerp(0.12, 0.2, v);
      }
      o.kick = smoothstep(0, 0.12, u) * (1 - smoothstep(0.85, 1, u));
      o.kickHip = hip;
      o.kickKnee = knee;
      o.kickAnkle = -0.6 * smoothstep(0.3, 0.6, u) * (1 - smoothstep(0.75, 1, u));
      o.plantHip = 0.15;
      o.plantKnee = 0.3;
      const wide = Math.sin(Math.PI * u);
      o.armOutL = lerp(o.armOutL, 0.75, wide);
      o.armOutR = lerp(o.armOutR, 0.6, wide);
      o.arms = Math.max(o.arms, wide);
      o.flex -= 0.15 * smoothstep(c, 1, u) * (1 - smoothstep(0.85, 1, u));
    } else o.kick = 0;
    return o;
  }

  /** `lines`: the assistant referees, who run along the dugouts' side. */
  update(m: Match, dt: number, lines: Player[]): void {
    if (dt <= 0) return;
    dt = Math.min(dt, 1 / 30);
    this.t += dt;
    this.events(m);
    for (const b of this.bosses) {
      if (b.act !== 'none' && this.t >= b.actEnd) {
        const n = b.next;
        b.next = 'none';
        b.act = 'none';
        if (n !== 'none') this.start(b, n, 0, b.nextDur);
      }
      this.think(b, m);
      this.move(b, m, dt, lines);
      this.shape(b, dt);
      this.bottlePhysics(b.bottle, dt);
    }
  }

  private start(b: Boss, a: Act, delay: number, dur: number, next: Act = 'none', nextDur = 0): void {
    b.act = a;
    b.actAt = this.t + delay;
    b.actEnd = b.actAt + dur;
    b.next = next;
    b.nextDur = nextDur;
    b.kickT = -1;
  }

  /** Watch the match for what a manager reacts to. */
  private events(m: Match): void {
    const t = this.t;
    if (m.phase !== this.lastPhase) {
      if (m.phase === 'goal' && m.scorer) {
        for (const b of this.bosses) {
          if (b.team === m.scorer.team) {
            if (b.temper === 'showman' || (b.temper === 'fiery' && Math.random() < 0.6)) {
              b.goX = b.hx + b.away * rand(8, 13);
              b.goZ = FRONT_Z + 0.25;
              this.start(b, 'run', rand(0, 0.3), rand(6, 8), 'fistpump', 2);
            } else this.start(b, 'fistpump', rand(0.2, 0.5), 1.6, 'temple', 2.2);
          } else {
            const near = Math.abs(b.bottle.pos.x - b.p.pos.x) < 7 && !b.bottle.moving;
            if (b.temper === 'fiery' && near) this.kickBottle(b);
            else if (b.temper === 'fiery') this.start(b, 'rage', rand(0.3, 0.8), 3, 'groan', 2);
            else if (b.temper === 'showman') this.start(b, 'crouch', rand(0.3, 0.8), rand(3, 4.5));
            else this.start(b, 'turnaway', rand(0.4, 1), rand(3.5, 5));
          }
        }
      } else if (m.phase === 'fulltime') {
        for (const b of this.bosses) this.start(b, 'shake', rand(1, 1.6), 7.5, this.result(m, b.team) >= 0 ? 'applaud' : 'slump', rand(7, 10));
      } else if (m.phase === 'kickoff' && m.half === 2 && this.lastPhase === 'halftime') {
        for (const b of this.bosses) this.placeBottle(b);
      }
      this.lastPhase = m.phase;
    }
    // A shot that doesn't go in: hands to the head on that side, relief on the other.
    for (let team = 0; team < 2; team++) {
      const live = m.shotTeam() === team && m.excitement > 0.45;
      if (this.shotLive[team] && !live) this.missAt[team] = t + 0.45;
      this.shotLive[team] = live;
      if (this.missAt[team] > 0 && t >= this.missAt[team]) {
        this.missAt[team] = -1;
        if (m.phase === 'goal') continue;
        for (const b of this.bosses) {
          if (b.act !== 'none') continue;
          if (b.team === team) {
            if (b.temper !== 'cool' && Math.random() < 0.35) this.start(b, 'crouch', rand(0, 0.25), rand(1.8, 2.6));
            else this.start(b, 'groan', rand(0, 0.25), rand(1.6, 2.4));
          } else if (Math.random() < 0.6) this.start(b, 'relief', rand(0.1, 0.4), rand(1.5, 2.2));
        }
      }
    }
    // Fouls: up in arms when one of his is fouled, or his man is booked.
    const f = m.lastFoul;
    if (f && f.time !== this.lastFoulT) {
      this.lastFoulT = f.time;
      for (const b of this.bosses) {
        if (b.act !== 'none' && b.act !== 'relief') continue;
        const wronged = b.team === f.victim.team;
        const booked = b.team === f.offender.team && (f.yellow || f.penalty);
        if (!wronged && !booked) continue;
        const hot = b.temper === 'fiery' || f.penalty;
        if (hot || Math.random() < 0.55) this.start(b, hot ? 'rage' : 'what', rand(0.15, 0.5), hot ? rand(2.5, 3.5) : rand(1.6, 2.2));
      }
    }
  }

  /** +1 winning, 0 level, -1 losing. */
  private result(m: Match, team: number): number {
    return Math.sign(m.teams[team].score - m.teams[1 - team].score);
  }

  private kickBottle(b: Boss): void {
    this.start(b, 'bottle', rand(0.1, 0.4), 6, 'groan', 1.8);
    const d = b.kickDir.set(b.away * rand(0.6, 1) * (Math.random() < 0.8 ? 1 : -1), 0, rand(-0.35, 0.05));
    const n = Math.hypot(d.x, d.z);
    d.x /= n;
    d.z /= n;
  }

  /** Between reactions: what he does with himself. */
  private think(b: Boss, m: Match): void {
    const t = this.t;
    if (t < b.idleUntil) return;
    const att = m.attackingTeam();
    const hot = m.phase === 'play' && m.excitement > 0.5;
    const late = m.half === 2 && m.displayMinute >= 75;
    const res = this.result(m, b.team);
    const loud = b.temper === 'cool' ? 0.4 : b.temper === 'fiery' ? 1.4 : 1;
    const w: [Idle, number][] = [
      ['folded', b.temper === 'cool' ? 3 : 1.5],
      ['hips', 1.2],
      ['behind', 0.8],
      ['pockets', b.temper === 'cool' ? 2 : 0.8],
      ['chin', b.temper === 'cool' ? 1.5 : 0.6],
      ['watch', late && res > 0 ? 3 : late && res === 0 ? 1 : 0.1],
      ['shout', (hot ? 2 : 0.6) * loud * (late && res < 0 ? 2 : 1)],
      ['point', (hot && att !== b.team ? 2 : 0.7) * loud],
      ['beckon', (hot && att === b.team ? 2.5 : late && res < 0 ? 1.5 : 0.2) * loud],
      ['clap', 0.4 * loud],
    ];
    let sum = 0;
    for (const [, v] of w) sum += v;
    let r = Math.random() * sum;
    for (const [i, v] of w) if ((r -= v) <= 0) {
      b.idle = i;
      break;
    }
    const busy = b.idle === 'shout' || b.idle === 'beckon' || b.idle === 'clap' || b.idle === 'point';
    b.idleUntil = t + (busy ? rand(1.8, 3.5) : rand(4, 9)) / (late && res <= 0 ? 1.5 : 1);
  }

  private move(b: Boss, m: Match, dt: number, lines: Player[]): void {
    const p = b.p;
    const t = this.t;
    const acting = b.act !== 'none' && t >= b.actAt;
    const late = m.half === 2 && m.displayMinute >= 70 && this.result(m, b.team) <= 0;
    // Where he wants to be: drifting with the play along his area, pacing when it's tense.
    if (t >= b.paceUntil) {
      const restless = (b.temper === 'cool' ? 0.15 : b.temper === 'fiery' ? 0.55 : 0.4) + (late ? 0.3 : 0);
      b.paceX = Math.random() < restless ? rand(-2.5, 2.5) : 0;
      b.paceUntil = t + rand(3, 8);
    }
    let tx = b.hx + clamp((m.ball.pos.x - b.hx) * 0.16 + b.paceX, -3.5, 3.5);
    let tz = LINE_Z + (m.phase === 'play' && m.attackingTeam() === b.team ? 0.25 * smoothstep(0.5, 0.85, m.excitement) : 0);
    let pace = 1.3;
    this.look.copy(m.ball.pos);
    let square = false;
    if (acting) {
      switch (b.act) {
        case 'run':
          tx = b.goX;
          tz = b.goZ;
          pace = 6.5;
          this.look.set(b.goX + b.away * 10, 0, b.goZ);
          break;
        case 'rage':
          tz = FRONT_Z;
          pace = 2.2;
          break;
        case 'turnaway':
          tx = p.pos.x + b.away * 0.3;
          tz = BACK_Z;
          this.look.set(p.pos.x, 0, p.pos.z - 10);
          square = true;
          break;
        case 'crouch':
        case 'groan':
        case 'what':
        case 'relief':
        case 'fistpump':
        case 'temple':
          tx = p.pos.x;
          tz = p.pos.z;
          break;
        case 'bottle': {
          const o = b.bottle;
          const d = b.kickDir;
          // Up behind the bottle, a little left of its line (it's the right foot).
          tx = o.pos.x - d.x * 0.42 + d.z * 0.14;
          tz = o.pos.z - d.z * 0.42 - d.x * 0.14;
          pace = 2.6;
          this.look.set(o.pos.x + d.x * 6, 0, o.pos.z + d.z * 6);
          square = Math.hypot(tx - p.pos.x, tz - p.pos.z) < 1.2;
          if (b.kickT < 0) {
            if (Math.hypot(tx - p.pos.x, tz - p.pos.z) < 0.14 && p.speed < 0.6) b.kickT = 0;
            else if (t > b.actAt + 3.5) b.actEnd = t; // never got there: hands on head instead
          }
          if (b.kickT >= 0) {
            const was = b.kickT;
            b.kickT += dt;
            tx = p.pos.x;
            tz = p.pos.z;
            if (was < KICK_AT && b.kickT >= KICK_AT) {
              const s = rand(8, 12);
              o.vel.set(d.x * s, rand(2.5, 4.5), d.z * s);
              o.spin = rand(14, 22) * (Math.random() < 0.5 ? 1 : -1);
              o.yaw = Math.atan2(d.z, d.x);
              o.pos.y = Math.max(o.pos.y, 0.05);
              o.moving = true;
            }
            if (b.kickT >= KICK_DUR) {
              b.kickT = -1;
              b.actEnd = t; // on to the next: hands on head
            }
          }
          break;
        }
        case 'shake': {
          // Meet the other manager on halfway, in front of the tunnel.
          const other = this.bosses[1 - b.team].p;
          tx = b.away * 0.38;
          tz = LINE_Z + 0.2;
          pace = 1.6;
          if (Math.hypot(tx - p.pos.x, tz - p.pos.z) < 1) {
            this.look.copy(other.pos);
            square = true;
          }
          // Not met yet: the handshake waits.
          b.met = Math.hypot(other.pos.x - p.pos.x, other.pos.z - p.pos.z) < 1.25;
          if (!b.met) b.actEnd = Math.max(b.actEnd, t + 2.5);
          break;
        }
        case 'applaud':
          tx = p.pos.x + b.away * 0.6;
          tz = LINE_Z;
          pace = 0.9;
          this.look.set(p.pos.x, 0, p.pos.z - 30);
          square = true;
          break;
        case 'slump':
          tx = b.hx;
          tz = BACK_Z;
          pace = 0.9;
          this.look.set(b.hx, 0, BACK_Z - 5);
          break;
      }
    }
    // The assistant referee runs along here: step back out of his way.
    if (!acting) for (const l of lines) if (Math.abs(l.pos.x - tx) < 1.8 && Math.abs(l.pos.z - tz) < 1) tz = BACK_Z;
    const dx = tx - p.pos.x;
    const dz = tz - p.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.12) {
      p.moveX = p.moveZ = 0;
      p.wantSpeed = 0;
    } else {
      p.moveX = dx / d;
      p.moveZ = dz / d;
      p.wantSpeed = Math.min(pace, d * 2 + 0.3);
    }
    if (b.squat > 0.05 || b.kickT >= 0) p.wantSpeed = 0;
    p.lookTarget.copy(this.look);
    p.lookAt = p.lookTarget;
    p.squareUp = square;
    p.move(dt);
    p.facing = Math.atan2(Math.sin(p.facing), Math.cos(p.facing));
    p.prevFacing = p.facing;
    p.prevPos.copy(p.pos);
  }

  /** The upper body he's going for, eased in. */
  private shape(b: Boss, dt: number): void {
    const t = this.t;
    const p = b.p;
    let arms: Arms | null = POSE[b.idle];
    let flex = b.idle === 'shout' ? -0.06 : b.idle === 'watch' ? 0.12 : 0;
    let head = b.idle === 'watch' ? 0.45 : 0;
    let squat = 0;
    let lift = 0;
    // Walking, the hands come out of the pockets and off the hips.
    const walking = smoothstep(0.6, 2, p.speed);
    let w = 1 - walking;
    if (b.idle === 'folded' || b.idle === 'pockets' || b.idle === 'behind') w = 1 - 0.6 * walking;
    const k = b.act !== 'none' && t >= b.actAt ? smoothstep(0, 0.3, t - b.actAt) * smoothstep(0, 0.4, b.actEnd - t) : 0;
    if (k > 0) {
      let a: Arms | null = arms;
      switch (b.act) {
        case 'run': {
          // Running: arms pump naturally; there, the leap and both fists up.
          const there = Math.hypot(b.goX - p.pos.x, b.goZ - p.pos.z) < 0.6 && p.speed < 2;
          a = there ? ARMS.up : null;
          if (there) {
            const j = Math.max(0, Math.sin((t + b.ph) * 7));
            lift = 0.14 * j * j;
            flex = -0.2;
            head = -0.2;
          }
          break;
        }
        case 'fistpump':
          a = POSE.fist;
          flex = -0.1;
          head = -0.1;
          break;
        case 'temple':
          a = POSE.temple;
          break;
        case 'turnaway':
          a = ARMS.hips;
          head = 0.45;
          flex = 0.1;
          break;
        case 'crouch':
          a = POSE.face;
          squat = 1;
          head = 0.55;
          break;
        case 'groan':
          a = ARMS.head;
          flex = -0.18;
          head = -0.25;
          break;
        case 'rage':
        case 'what':
          a = POSE.what;
          flex = -0.08;
          break;
        case 'relief':
          a = POSE.chest;
          head = -0.3;
          flex = -0.12;
          break;
        case 'bottle':
          a = b.kickT >= 0 ? ARMS.hips : null;
          flex = 0.1;
          break;
        case 'shake':
          a = b.met ? POSE.shake : null;
          break;
        case 'applaud':
          a = POSE.applaud;
          head = -0.15;
          break;
        case 'slump':
          a = POSE.pockets;
          head = 0.5;
          flex = 0.12;
          break;
      }
      if (a) {
        arms = a;
        w = lerp(w, 1, k);
      } else w = lerp(w, 0, k);
    }
    if (b.act === 'slump' && t >= b.actAt) w = 1;
    const e = 1 - Math.exp(-dt * 6);
    if (arms) for (let i = 0; i < 8; i++) b.arms[i] += (arms[i] - b.arms[i]) * e;
    b.w += (w - b.w) * e;
    b.flex += (flex * Math.max(k, b.act === 'none' ? 1 : 0) - b.flex) * e;
    b.head += (head - b.head) * e;
    // A slow sway while he stands and watches.
    b.side = 0.04 * Math.sin((t + b.ph) * 0.4) * (1 - walking);
    b.tw = 0;
    b.squat = clamp(b.squat + (squat > 0 ? dt / 0.45 : -dt / 0.5), 0, 1);
    b.lift = lift;
  }

  private bottlePhysics(o: Bottle, dt: number): void {
    if (!o.moving) return;
    o.vel.y -= 9.81 * dt;
    o.pos.x += o.vel.x * dt;
    o.pos.y += o.vel.y * dt;
    o.pos.z += o.vel.z * dt;
    o.ang += o.spin * dt;
    // Not through the back of the dugout.
    if (o.pos.z < DUGOUT.z - 0.7) {
      o.pos.z = DUGOUT.z - 0.7;
      o.vel.z = Math.abs(o.vel.z) * 0.4;
    }
    if (o.pos.y <= 0) {
      o.pos.y = 0;
      if (o.vel.y < -1.2) {
        o.vel.y = -o.vel.y * 0.38;
        o.vel.x *= 0.62;
        o.vel.z *= 0.62;
        o.spin *= Math.random() < 0.3 ? -0.6 : 0.6;
      } else {
        o.vel.y = 0;
        const f = Math.exp(-dt * 3.5);
        o.vel.x *= f;
        o.vel.z *= f;
        // It settles onto its side (or, now and then, back on its base).
        const rest = Math.round((o.ang - Math.PI / 2) / Math.PI) * Math.PI + Math.PI / 2;
        o.spin *= Math.exp(-dt * 6);
        o.ang += (rest - o.ang) * (1 - Math.exp(-dt * 8));
        if (Math.hypot(o.vel.x, o.vel.z) < 0.05 && Math.abs(o.spin) < 0.5) {
          o.vel.set(0, 0, 0);
          o.ang = rest;
          o.moving = false;
        }
      }
    }
    this.drawBottle(o);
  }
}
