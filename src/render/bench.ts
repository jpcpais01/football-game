import { PITCH } from '../sim/constants';
import type { Match } from '../sim/match';
import { Player } from '../sim/player';
import type { SimPlayer } from '../meta/cards';
import { V3, clamp, lerp, smoothstep } from '../sim/vec';

/**
 * The substitutes. Seven real players per dugout, drawn by the players' renderer with the
 * same bodies and kits as the twenty-two on the pitch, living their own small match day:
 * mostly sat on the bench (each in his own way: upright, elbows on knees, leaning back with
 * a leg out), now and then getting up to stretch, walking out to watch from the front of
 * the technical area, squatting at the line, or warming up toward the corner. They follow
 * the game: on the edge of the seat when their side attacks, hands on heads at a miss,
 * leaping up for a goal, slumped when they concede, appealing a foul, clapping at the end.
 *
 * Purely visual (Math.random, never the match's rng): the simulation doesn't know they exist.
 */

/** Dugout centre: team 0's at -x, team 1's at +x, on the far touchline. */
export const DUGOUT = { x: 9, z: -(PITCH.halfW + 2.6) };
const SEAT_Z = DUGOUT.z - 0.55;
const SEAT_TOP = 0.45;
/** Front edge of the dugout: inside it, people walk straight in and out. */
const FRONT_Z = DUGOUT.z + 0.95;
const PER_BENCH = 7;

const THIGH = 0.43;
const SHIN = 0.42;
/** Ankle joint above the ground (skeleton units; just clear of the renderer's ground guard). */
const ANKLE_Y = 0.075;

type Want = 'sit' | 'stand' | 'squat' | 'warm';
type React = 'none' | 'cheer' | 'despair' | 'groan' | 'appeal' | 'clap' | 'sulk';

/** Smoothed pose shape: leg angles for the seat, trunk, head and arms. */
interface Shape {
  thL: number; // thigh angle (seat)
  thR: number;
  ftL: number; // feet: +1 forward, -1 tucked under the bench
  ftR: number;
  loL: number; // legs apart
  loR: number;
  ywL: number; // knees out
  ywR: number;
  flex: number;
  side: number;
  tw: number;
  head: number;
  aL: number;
  aR: number;
  eL: number;
  eR: number;
  oL: number;
  oR: number;
  rL: number;
  rR: number;
  arms: number;
}

const zero = (): Shape => ({ thL: 1.4, thR: 1.4, ftL: 0.4, ftR: 0.4, loL: 0.14, loR: 0.14, ywL: 0, ywR: 0, flex: 0, side: 0, tw: 0, head: 0, aL: 0, aR: 0, eL: 0.3, eR: 0.3, oL: 0.1, oR: 0.1, rL: 0, rR: 0, arms: 0 });

type Arms = [aL: number, aR: number, eL: number, eR: number, oL: number, oR: number, rL: number, rR: number];
const ARMS = {
  thighs: [0.42, 0.4, 0.55, 0.6, 0.14, 0.12, 0, 0] as Arms,
  knees: [0.3, 0.32, 1.25, 1.2, 0.06, 0.05, -0.35, -0.3] as Arms,
  folded: [0.5, 0.45, 1.95, 1.8, 0.06, 0.04, -1.45, -1.4] as Arms,
  clasped: [0.62, 0.6, 0.45, 0.45, -0.06, -0.06, 0, 0] as Arms,
  hips: [-0.2, -0.2, 1.6, 1.6, 0.62, 0.62, -0.9, -0.9] as Arms,
  behind: [-0.42, -0.42, 0.85, 0.85, 0.08, 0.08, -0.8, -0.8] as Arms,
  head: [2.3, 2.25, 2.05, 2.0, 0.85, 0.85, 0, 0] as Arms,
  up: [2.8, 2.75, 0.3, 0.3, 0.45, 0.45, 0, 0] as Arms,
  appeal: [0.6, 0.65, 0.6, 0.55, 0.9, 0.9, 0.5, 0.5] as Arms,
  clap: [0.85, 0.85, 1.35, 1.35, 0.22, 0.22, -0.3, -0.3] as Arms,
  squat: [0.75, 0.7, 0.95, 0.9, 0.28, 0.26, -0.2, -0.2] as Arms,
};

/** The sitting styles: thighs, feet, spread, trunk, arms. */
const SEATS: { th: [number, number]; ft: [number, number]; lo: number; yw: number; flex: number; arms: Arms }[] = [
  { th: [1.4, 1.38], ft: [0.4, 0.5], lo: 0.14, yw: 0, flex: -0.04, arms: ARMS.thighs }, // upright, hands on thighs
  { th: [1.45, 1.45], ft: [-0.35, -0.2], lo: 0.2, yw: 0.08, flex: 0.55, arms: ARMS.knees }, // elbows on knees
  { th: [1.05, 1.4], ft: [1, 0.5], lo: 0.12, yw: 0, flex: -0.2, arms: ARMS.folded }, // back, arms folded, a leg out
  { th: [1.42, 1.42], ft: [0.1, 0.1], lo: 0.3, yw: 0.22, flex: 0.32, arms: ARMS.clasped }, // legs wide, hands clasped
  { th: [1.1, 1.08], ft: [1, 1], lo: 0.1, yw: -0.05, flex: -0.15, arms: ARMS.thighs }, // slouched, legs stretched
];
const STANDS: (Arms | null)[] = [ARMS.folded, ARMS.hips, ARMS.behind, null];

interface Sub {
  p: Player;
  team: number;
  seatX: number;
  want: Want;
  until: number;
  spotX: number;
  spotZ: number;
  /** 0..1: how far down onto the bench / into the squat. */
  sit: number;
  squat: number;
  style: number;
  stand: number;
  /** Warm-up: stretching on the spot until this time. */
  stretchUntil: number;
  react: React;
  reactAt: number;
  reactEnd: number;
  /** A personal phase and variant (fidgets, which reaction he goes for). */
  ph: number;
  v: number;
  cur: Shape;
  tgt: Shape;
  lift: number;
  clap: number;
}

export interface BenchPose {
  /** 0 = the player's own (walking / standing) legs, 1 = the bench pose's. */
  legs: number;
  hipY: number;
  hipL: number;
  hipR: number;
  kneeL: number;
  kneeR: number;
  legOutL: number;
  legOutR: number;
  legYawL: number;
  legYawR: number;
  ankleL: number;
  ankleR: number;
  /** 0 = natural arm swing, 1 = the pose's arms. */
  arms: number;
  armL: number;
  armR: number;
  elbowL: number;
  elbowR: number;
  armOutL: number;
  armOutR: number;
  armRotL: number;
  armRotR: number;
  flex: number;
  side: number;
  twist: number;
  headPitch: number;
  lift: number;
  look: boolean;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const ease = (k: number) => smoothstep(0, 1, k);

export class Benches {
  readonly all: Player[] = [];
  private subs: Sub[] = [];
  private t = 0;
  private lastPhase = '';
  private shotLive = [false, false];
  private groanAt = [-1, -1];
  private lastFoulT = -1;
  private edge = [0, 0];
  private out: BenchPose = {
    legs: 0, hipY: 0, hipL: 0, hipR: 0, kneeL: 0, kneeR: 0, legOutL: 0, legOutR: 0, legYawL: 0, legYawR: 0, ankleL: 0, ankleR: 0,
    arms: 0, armL: 0, armR: 0, elbowL: 0, elbowR: 0, armOutL: 0, armOutR: 0, armRotL: 0, armRotR: 0,
    flex: 0, side: 0, twist: 0, headPitch: 0, lift: 0, look: true,
  };
  private look = new V3();

  constructor(private readonly firstId: number) {
    const attrs = { pace: 0.5, accel: 0.5, control: 0.5, passing: 0.5, shooting: 0.5, strength: 0.5, defending: 0.5, keeping: 0.5, agility: 0.5, stamina: 0.8, jumping: 0.5, power: 0.5, height: 1.8, weight: 76 };
    for (let team = 0; team < 2; team++) {
      const cx = (team === 0 ? -1 : 1) * DUGOUT.x;
      for (let i = 0; i < PER_BENCH; i++) {
        const p = new Player(firstId + this.all.length, team, 11 + i, i === 0 ? 'GK' : 'MID', 0, 0, { ...attrs }, { skin: 0xc68a5c, hair: 0x1b1410, hairStyle: 0, height: 1, build: 1 });
        p.number = 12 + i;
        this.all.push(p);
        this.subs.push({
          p, team, seatX: cx - 2.7 + i * 0.9, want: 'sit', until: 0, spotX: 0, spotZ: 0, sit: 1, squat: 0, style: 0, stand: 0, stretchUntil: 0,
          react: 'none', reactAt: 0, reactEnd: 0, ph: Math.random() * 100, v: Math.floor(Math.random() * 3), cur: zero(), tgt: zero(), lift: 0, clap: 0,
        });
      }
    }
    this.reset();
  }

  /** New match: who's on each bench, everyone sat down. */
  reset(squads?: [SimPlayer[], SimPlayer[]]): void {
    for (const s of this.subs) {
      const sp = squads?.[s.team][s.p.index - 11];
      if (sp) {
        Object.assign(s.p.attrs, sp.attrs);
        Object.assign(s.p.look, sp.look);
        s.p.name = sp.name;
        s.p.number = sp.number;
      }
      s.p.pos.set(s.seatX, 0, SEAT_Z);
      s.p.prevPos.copy(s.p.pos);
      s.p.vel.set(0, 0, 0);
      s.p.facing = s.p.prevFacing = Math.PI / 2;
      s.want = 'sit';
      s.sit = 1;
      s.squat = 0;
      s.style = Math.floor(Math.random() * SEATS.length);
      s.until = this.t + rand(3, 25);
      s.react = 'none';
    }
    this.lastPhase = '';
  }

  /** The bench pose for a substitute (null for anyone else). `leg` and `sc` are his leg
   * length and overall scale in the skeleton, so he sits on the bench and squats on his feet. */
  pose(p: Player, leg: number, sc: number): BenchPose | null {
    const s = this.subs[p.id - this.firstId];
    if (!s || s.p !== p) return null;
    const o = this.out;
    const c = s.cur;
    const st = ease(s.sit);
    const sq = ease(s.squat);
    if (st >= sq) {
      // On the bench: the thighs rest on the seat, each shin finds the floor (two-bone IK:
      // feet forward or tucked under).
      const hj = (SEAT_TOP + 0.075) / sc;
      const solve = (th: number, ft: number) => {
        const kneeY = hj - THIGH * leg * Math.cos(th);
        const a = Math.acos(clamp((kneeY - ANKLE_Y) / (SHIN * leg), -1, 1));
        return th - a * ft;
      };
      o.legs = st;
      o.hipY = hj + 0.03;
      o.hipL = c.thL;
      o.hipR = c.thR;
      o.kneeL = solve(c.thL, c.ftL);
      o.kneeR = solve(c.thR, c.ftR);
      // Feet flat on the floor (or heels down for a leg stretched out).
      o.ankleL = -0.35 * smoothstep(0.6, 1, o.kneeL) * st;
      o.ankleR = -0.35 * smoothstep(0.6, 1, o.kneeR) * st;
    } else {
      // Squatting at the line: on the toes, knees out, shins leaning forward.
      const th = 1.85;
      const a = 0.55;
      o.legs = sq;
      o.hipY = ANKLE_Y + SHIN * leg * Math.cos(a) + THIGH * leg * Math.cos(th) + 0.03;
      o.hipL = o.hipR = th;
      o.kneeL = o.kneeR = th + a;
      o.ankleL = o.ankleR = -0.7 * sq;
    }
    o.legOutL = c.loL;
    o.legOutR = c.loR;
    o.legYawL = c.ywL;
    o.legYawR = -c.ywR;
    o.arms = c.arms;
    o.armL = c.aL;
    o.armR = c.aR;
    o.elbowL = c.eL;
    o.elbowR = c.eR;
    o.armOutL = c.oL + s.clap;
    o.armOutR = c.oR + s.clap;
    o.armRotL = c.rL;
    o.armRotR = c.rR;
    o.flex = c.flex;
    o.side = c.side;
    o.twist = c.tw;
    o.headPitch = c.head;
    o.lift = s.lift;
    o.look = c.head < 0.25;
    return o;
  }

  update(m: Match, dt: number): void {
    if (dt <= 0) return;
    dt = Math.min(dt, 1 / 30);
    this.t += dt;
    const t = this.t;
    this.events(m);
    for (let team = 0; team < 2; team++) {
      const att = m.phase === 'play' && m.attackingTeam() === team ? smoothstep(0.55, 0.85, m.excitement) : 0;
      this.edge[team] += (att - this.edge[team]) * (1 - Math.exp(-dt * 2));
    }
    for (const s of this.subs) {
      const reacting = s.react !== 'none' && t >= s.reactAt;
      if (s.react !== 'none' && t >= s.reactEnd) s.react = 'none';
      if (!reacting && t >= s.until) this.decide(s);
      this.move(s, m, dt, reacting);
      this.shape(s, m, dt, reacting);
    }
  }

  /** Watch the match for things a bench reacts to. */
  private events(m: Match): void {
    const t = this.t;
    if (m.phase !== this.lastPhase) {
      if (m.phase === 'goal' && m.scorer) {
        const st = m.scorer.team;
        for (const s of this.subs) {
          if (s.team === st) {
            this.react(s, 'cheer', rand(0.05, 0.5), rand(4, 7));
            // A couple run out onto the touchline.
            if (Math.random() < 0.3 && s.p.role !== 'GK') this.goTo(s, 'stand', s.seatX + rand(-1.5, 1.5), DUGOUT.z + rand(0.9, 1.05), rand(7, 11));
          } else this.react(s, Math.random() < 0.7 ? 'despair' : 'sulk', rand(0.3, 1.2), rand(3, 6));
        }
      } else if (m.phase === 'fulltime') {
        const [a, b] = [m.teams[0].score, m.teams[1].score];
        for (const s of this.subs) {
          const won = s.team === 0 ? a >= b : b >= a;
          this.react(s, won ? 'clap' : 'sulk', rand(0.2, 1.5), rand(6, 10));
        }
      }
      this.lastPhase = m.phase;
    }
    // A shot that doesn't go in: hands on heads on that bench.
    for (let team = 0; team < 2; team++) {
      const live = m.shotTeam() === team && m.excitement > 0.45;
      if (this.shotLive[team] && !live) this.groanAt[team] = t + 0.5;
      this.shotLive[team] = live;
      if (this.groanAt[team] > 0 && t >= this.groanAt[team]) {
        this.groanAt[team] = -1;
        if (m.phase !== 'goal') for (const s of this.subs) if (s.team === team && Math.random() < 0.65) this.react(s, 'groan', rand(0, 0.35), rand(1.6, 2.6));
      }
    }
    // A foul on one of theirs: one or two get up and appeal.
    const f = m.lastFoul;
    if (f && f.time !== this.lastFoulT) {
      this.lastFoulT = f.time;
      let n = Math.random() < 0.5 ? 1 : 2;
      for (const s of this.subs) if (n > 0 && s.team === f.victim.team && s.react === 'none' && Math.random() < 0.4) this.react(s, 'appeal', rand(0.1, 0.5), rand(2, 3)), n--;
    }
  }

  private react(s: Sub, r: React, delay: number, dur: number): void {
    s.react = r;
    s.reactAt = this.t + delay;
    s.reactEnd = s.reactAt + dur;
    s.v = Math.floor(Math.random() * 3);
  }

  private goTo(s: Sub, want: Want, x: number, z: number, dur: number): void {
    s.want = want;
    s.spotX = x;
    s.spotZ = z;
    s.until = this.t + dur;
    s.stand = Math.floor(Math.random() * STANDS.length);
  }

  /** What next, when he's done with what he was doing. */
  private decide(s: Sub): void {
    const t = this.t;
    const up = this.subs.filter((o) => o.team === s.team && o !== s && o.want !== 'sit').length;
    const cx = (s.team === 0 ? -1 : 1) * DUGOUT.x;
    if (s.want !== 'sit') {
      // Back to the bench (now and then a squat at the line first).
      if (s.want === 'stand' && Math.random() < 0.25) this.goTo(s, 'squat', s.spotX + rand(-0.5, 0.5), DUGOUT.z + rand(0.95, 1.05), rand(5, 10));
      else {
        s.want = 'sit';
        s.style = Math.floor(Math.random() * SEATS.length);
        s.until = t + rand(10, 30);
      }
      return;
    }
    const r = Math.random();
    if (up >= 2 || r < 0.66) {
      // Stay put; maybe shift into another way of sitting.
      if (Math.random() < 0.6) s.style = Math.floor(Math.random() * SEATS.length);
      s.until = t + rand(6, 22);
    } else if (r < 0.77) {
      this.goTo(s, 'stand', s.seatX + rand(-0.25, 0.25), DUGOUT.z + rand(0.1, 0.4), rand(4, 10)); // up to stretch the legs
    } else if (r < 0.87) {
      this.goTo(s, 'stand', cx + rand(-4.5, 4.5), DUGOUT.z + rand(0.95, 1.05), rand(8, 18)); // out to watch
    } else if (r < 0.95) {
      this.goTo(s, 'squat', cx + rand(-3, 3), DUGOUT.z + rand(0.95, 1.05), rand(6, 14));
    } else if (s.p.role !== 'GK') {
      // Warm-up: jog out toward the corner, stretch, jog on, back after a while.
      const sgn = s.team === 0 ? -1 : 1;
      this.goTo(s, 'warm', cx + sgn * rand(5, 11), DUGOUT.z + rand(0.3, 0.9), rand(18, 32));
      s.stretchUntil = 0;
    } else s.until = t + rand(6, 15);
  }

  private move(s: Sub, m: Match, dt: number, reacting: boolean): void {
    const p = s.p;
    const t = this.t;
    // Reactions that bring him to his feet; the rest he has where he is.
    const upNow = reacting && (s.react === 'cheer' || s.react === 'appeal' || s.react === 'clap' || (s.react === 'sulk' && s.sit < 0.5));
    let want: Want = upNow && s.want === 'sit' ? 'stand' : s.want;
    let sx = s.spotX;
    let sz = s.spotZ;
    if (want === 'sit' || (upNow && s.want === 'sit')) {
      sx = s.seatX;
      sz = SEAT_Z + 0.42;
    }
    if (upNow && s.want === 'squat') want = 'stand';
    const rate = dt / (reacting && s.react === 'cheer' ? 0.45 : 0.9);
    if (s.sit > 0 && want !== 'sit') s.sit = Math.max(0, s.sit - rate);
    else if (s.squat > 0 && want !== 'squat') s.squat = Math.max(0, s.squat - rate);
    if (s.sit > 0 || s.squat > 0) {
      // Down (or on the way up / down): planted, square to the pitch. Rising from the bench
      // carries the hips forward over the feet.
      const k = ease(s.sit);
      if (s.sit > 0) p.pos.set(s.seatX, 0, lerp(SEAT_Z + 0.42, SEAT_Z, k));
      p.vel.set(0, 0, 0);
      const ballA = Math.atan2(m.ball.pos.z - p.pos.z, m.ball.pos.x - p.pos.x);
      const face = s.squat > 0 ? Math.PI / 2 + clamp(ballA - Math.PI / 2, -0.5, 0.5) : Math.PI / 2;
      p.facing += (face - p.facing) * (1 - Math.exp(-dt * 4));
      if (want === 'sit' && s.sit > 0) s.sit = Math.min(1, s.sit + rate);
      if (want === 'squat' && s.squat > 0) s.squat = Math.min(1, s.squat + rate);
      p.leanFwd = p.leanSide = 0;
      p.prevPos.copy(p.pos);
      p.prevFacing = p.facing;
      return;
    }
    // On his feet: walk (or jog) to the spot, out and in through the front of the dugout.
    const warm = want === 'warm';
    if (warm && t < s.stretchUntil) {
      sx = p.pos.x;
      sz = p.pos.z;
    }
    let tx = sx;
    let tz = sz;
    const inside = (z: number) => z < FRONT_Z;
    if (Math.abs(tx - p.pos.x) > 0.35 && (inside(p.pos.z) || inside(tz))) {
      // Leave the dugout straight out, walk along the front, come in straight.
      if (inside(p.pos.z)) tx = p.pos.x;
      tz = FRONT_Z + 0.25;
    }
    const dx = tx - p.pos.x;
    const dz = tz - p.pos.z;
    const d = Math.hypot(dx, dz);
    const final = tx === sx && tz === sz;
    if (d < (final ? 0.12 : 0.3) && final) {
      p.moveX = p.moveZ = 0;
      p.wantSpeed = 0;
      if (warm && t >= s.stretchUntil && p.speed < 0.3) {
        // Arrived: stretch here a while, then jog on to the next spot.
        s.stretchUntil = t + rand(4, 7);
        s.v = Math.floor(Math.random() * 3);
        const cx = (s.team === 0 ? -1 : 1) * DUGOUT.x;
        const sgn = s.team === 0 ? -1 : 1;
        s.spotX = cx + sgn * rand(5, 12);
        s.spotZ = DUGOUT.z + rand(0.3, 0.9);
      }
    } else {
      p.moveX = dx / d;
      p.moveZ = dz / d;
      const pace = warm ? 3.2 : reacting && s.react === 'cheer' ? 4.5 : 1.35;
      p.wantSpeed = Math.min(pace, d * 2 + 0.3);
    }
    // Arrived at the bench / the line: turn to the pitch and go down.
    const there = final && d < 0.15 && p.speed < 0.4;
    if (want === 'sit' && there) {
      this.look.set(p.pos.x, 0, p.pos.z + 10);
      if (Math.abs(p.facing - Math.PI / 2) < 0.25) s.sit = 0.001;
    } else if (want === 'squat' && there) {
      s.squat = 0.001;
      this.look.copy(m.ball.pos);
    } else if (warm && t >= s.stretchUntil) {
      this.look.set(s.spotX, 0, s.spotZ);
    } else this.look.copy(m.ball.pos);
    p.lookTarget.copy(this.look);
    p.lookAt = p.lookTarget;
    p.squareUp = false;
    p.facing = Math.atan2(Math.sin(p.facing), Math.cos(p.facing));
    p.move(dt);
    p.prevPos.copy(p.pos);
    p.prevFacing = p.facing;
  }

  /** The pose he's going for, eased in so nothing snaps. */
  private shape(s: Sub, m: Match, dt: number, reacting: boolean): void {
    const g = s.tgt;
    const p = s.p;
    const t = this.t;
    const st = ease(s.sit);
    const sq = ease(s.squat);
    const standing = 1 - Math.max(st, sq);
    const edge = this.edge[s.team];
    const seat = SEATS[s.style];
    // Legs on the bench (sitting forward on the edge when his side's attacking).
    g.thL = lerp(seat.th[0], 1.38, edge * 0.6);
    g.thR = lerp(seat.th[1], 1.38, edge * 0.6);
    g.ftL = lerp(seat.ft[0], -0.4, edge * 0.6);
    g.ftR = lerp(seat.ft[1], -0.3, edge * 0.6);
    g.loL = g.loR = sq > st ? 0.22 : seat.lo;
    g.ywL = g.ywR = sq > st ? 0.3 : seat.yw;
    // Trunk: the seat's lean, forward in a squat, and over the knees in a tense moment.
    g.flex = st * lerp(seat.flex, 0.5, edge * 0.7) + sq * 0.42;
    g.side = 0;
    g.head = 0;
    // Arms: the seat's, the squat's, or how he stands; tense moments pull them in.
    let arms: Arms | null = st >= sq ? seat.arms : ARMS.squat;
    let w = Math.max(st, sq);
    if (standing > 0.5) {
      const warmStretch = s.want === 'warm' && t < s.stretchUntil;
      arms = warmStretch ? null : STANDS[s.stand];
      w = arms ? 1 - smoothstep(0.3, 1.0, p.speed) : 0;
    }
    if (edge > 0.3 && st > 0.5 && arms !== ARMS.folded) arms = ARMS.knees;
    s.lift = 0;
    s.clap = 0;
    // Reactions on top.
    if (reacting) {
      const u = t - s.reactAt;
      const left = s.reactEnd - t;
      const k = smoothstep(0, 0.3, u) * smoothstep(0, 0.4, left);
      w = lerp(w, 1, k);
      switch (s.react) {
        case 'cheer': {
          arms = s.v === 1 ? ([2.65, 0.4, 0.4, 1.9, 0.5, 0.3, 0, 0] as Arms) : ARMS.up;
          const jump = Math.max(0, Math.sin((t + s.ph) * 7.5));
          if (standing > 0.95) s.lift = 0.09 * jump * jump * k;
          g.flex -= 0.2 * k;
          g.head -= 0.15 * k;
          break;
        }
        case 'despair':
          arms = s.v === 0 ? ARMS.head : st > 0.5 ? ARMS.knees : ARMS.hips;
          g.flex += (s.v === 0 ? 0.25 : 0.45) * k;
          g.head += 0.5 * k;
          break;
        case 'sulk':
          arms = ARMS.hips;
          g.head += 0.4 * k;
          g.flex += 0.1 * k;
          break;
        case 'groan':
          arms = ARMS.head;
          g.flex -= 0.18 * k;
          g.head -= 0.25 * k;
          break;
        case 'appeal':
          arms = ARMS.appeal;
          g.flex -= 0.05 * k;
          break;
        case 'clap':
          arms = ARMS.clap;
          s.clap = Math.max(0, Math.sin((t + s.ph) * 13)) * 0.2 * k;
          break;
      }
    }
    // Seated or squatting, the shoulders turn a little with the head toward the ball.
    const rel = Math.atan2(m.ball.pos.z - p.pos.z, m.ball.pos.x - p.pos.x) - p.facing;
    g.tw = -clamp(Math.atan2(Math.sin(rel), Math.cos(rel)) * 0.35, -0.4, 0.4) * Math.max(st, sq);
    // Warm-up stretches on the spot: a hamstring reach, an overhead side bend, trunk twists.
    if (s.want === 'warm' && t < s.stretchUntil && standing > 0.9 && !reacting) {
      const k = smoothstep(0, 0.6, s.stretchUntil - t);
      const osc = Math.sin((t + s.ph) * (s.v === 2 ? 2.2 : 1.5));
      if (s.v === 0) {
        g.flex += 0.65 * k;
        arms = [0.95, 0.9, 0.1, 0.12, 0.06, 0.06, 0, 0];
      } else if (s.v === 1) {
        arms = ARMS.up;
        g.side += 0.35 * osc * k;
      } else {
        arms = ARMS.hips;
        g.tw += 0.55 * osc * k;
      }
      w = k;
    }
    if (arms) {
      g.aL = arms[0];
      g.aR = arms[1];
      g.eL = arms[2];
      g.eR = arms[3];
      g.oL = arms[4];
      g.oR = arms[5];
      g.rL = arms[6];
      g.rR = arms[7];
    } else w = 0;
    // Little fidgets: a slow sway of the trunk and a hand shifting on the thigh.
    const fid = Math.sin((t + s.ph) * 0.37) * Math.sin((t + s.ph) * 0.11);
    g.side += 0.05 * fid * st;
    g.aL += 0.08 * fid * st;
    g.arms = w;
    const c = s.cur;
    const a = 1 - Math.exp(-dt * 4.5);
    for (const key in g) {
      const kk = key as keyof Shape;
      c[kk] += (g[kk] - c[kk]) * a;
    }
  }
}
