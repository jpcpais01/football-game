import { DT, GOAL_SEQ, PITCH, PLAYER } from './constants';
import { predictBallAt, rollTimeAt, rollingPass } from './kick';
import type { Match } from './match';
import type { Player } from './player';
import { DIVE_HANDS, DIVE_HIPS, DIVE_RADIUS, divePose, planDive, type DivePose } from './keeperPose';
import { V3, angleDiff, clamp, dist2D } from './vec';

interface Intercept {
  t: number; // -1 = can't reach in the horizon
  x: number;
  z: number;
  /** Time in hand there by his real running (runTime): the ball's arrival minus his. */
  slack: number;
}

const SAMPLES = 36;
const SAMPLE_DT = 0.1;

const BOX_SPOTS: [number, number][] = [
  [-6, -2],
  [-8, 3],
  [-11, -4],
  [-5, 4.5],
  [-12, 1],
  [-14, -6],
];

/**
 * Individuality. Every player reads the same field (shape, space, opponents, teammates),
 * but weighs it in his own way:
 * - discipline: how tightly he keeps to his place in the shape,
 * - creativity: how far he roams looking for pockets of space, and how forward-minded,
 * - work: how quickly he gets moving and how much he sprints to recover,
 * - react: reading of the game (how fast his target follows a change in play).
 */
export interface Traits {
  discipline: number;
  creativity: number;
  work: number;
  react: number;
}

/** Stable pseudo-random in [0, 1) per player and channel (no Rng draws: keeps sims reproducible). */
function hash01(id: number, k: number): number {
  const s = Math.sin(id * 127.1 + k * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function traitsFor(p: Player): Traits {
  const a = p.attrs;
  const r = (k: number) => hash01(p.id, k) - 0.5;
  const role = p.role === 'DEF' ? 0 : p.role === 'MID' ? 1 : 2;
  return {
    discipline: clamp([0.75, 0.55, 0.35][role] + a.defending * 0.15 + r(1) * 0.4, 0.1, 1),
    creativity: clamp([0.25, 0.55, 0.75][role] + a.passing * 0.15 + r(2) * 0.4, 0.05, 1),
    work: clamp(0.4 + a.pace * 0.15 + a.stamina * 0.15 + r(3) * 0.5, 0.15, 1),
    react: clamp(0.4 + (a.defending + a.passing) * 0.15 + r(4) * 0.4, 0.15, 1),
  };
}

/** Team brains. Coordinates in comments are "team frame": +x is the goal the team attacks. */
export class AI {
  readonly intercept: Intercept[] = [];
  readonly chaser: (Player | null)[] = [null, null];
  readonly sx = new Float32Array(SAMPLES);
  readonly sy = new Float32Array(SAMPLES);
  readonly sz = new Float32Array(SAMPLES);
  private sampleCount = 0;
  private nextIntercept = 0;
  private nextDecision: number[] = [];
  private tackleReady: number[] = [];
  private run: { x: number; z: number; until: number }[] = [];
  private curves: { key: number; t: number[]; s: number[]; v: number[] }[] = [];
  private dribX: number[] = [];
  private dribZ: number[] = [];
  private dribSprint: boolean[] = [];
  /** Offside line per attacking team, in that team's frame. */
  private offside: number[] = [PITCH.halfL, PITCH.halfL];
  private keeperDiveT = [-10, -10];
  diveHeight: number[] = [];
  /** Planned dive pose per player (keepers), shared with the renderer. */
  diveRoll: number[] = [];
  diveLift: number[] = [];
  private lastOwner: Player | null = null;
  private possStart = 0;
  private patience = 0.6;
  private tmp = new V3();
  private tmp2 = new V3();
  private pose: DivePose = { roll: 0, lift: 0 };
  /** Per-player character (fixed for the match): see `traitsFor`. */
  readonly traits: Traits[] = [];
  /** Off-ball: smoothed goal each player is drifting toward (world). */
  private goalX: number[] = [];
  private goalZ: number[] = [];
  /** Off-ball: chosen pocket of space, as an offset from the shape slot (team frame). */
  private seekDX: number[] = [];
  private seekDZ: number[] = [];
  private seekAt: number[] = [];
  /** Zonal marking: who each defender has picked up (refreshed per team). */
  private mark: (Player | null)[] = [];
  private markAt = [0, 0];
  private offBallT: number[] = [];

  constructor(private m: Match) {
    for (let i = 0; i < 22; i++) {
      const p = m.players[i];
      this.traits.push(traitsFor(p));
      this.goalX.push(p.pos.x);
      this.goalZ.push(p.pos.z);
      this.seekDX.push(0);
      this.seekDZ.push(0);
      this.seekAt.push(0);
      this.mark.push(null);
      this.offBallT.push(-1);
      this.intercept.push({ t: -1, x: 0, z: 0, slack: -9 });
      this.nextDecision.push(0);
      this.tackleReady.push(0);
      this.run.push({ x: 0, z: 0, until: -1 });
      this.dribX.push(1);
      this.dribZ.push(0);
      this.dribSprint.push(false);
      this.diveHeight.push(0.5);
      this.diveRoll.push(1.3);
      this.diveLift.push(0);
    }
  }

  setRun(p: Player, x: number, z: number, seconds = 3): void {
    const r = this.run[p.id];
    r.x = clamp(x, -PITCH.halfL + 1, PITCH.halfL - 1);
    r.z = clamp(z, -PITCH.halfW + 1, PITCH.halfW - 1);
    r.until = this.m.time + seconds;
  }

  /**
   * Time for a player to get to (x, z) — the same running he really does (Player.move):
   * a reaction, the sideways part of his momentum turned onto the line, a brake if he's
   * going the other way, then the sprint-start curve (explosive first steps, acceleration
   * fading toward top speed). `reach`: done once he's that close.
   */
  runTime(q: Player, x: number, z: number, react = 0.15, reach = 0): number {
    const dx = x - q.pos.x;
    const dz = z - q.pos.z;
    const full = Math.hypot(dx, dz);
    const d = full - reach;
    if (d < 0.3) return react * 0.5;
    const ux = dx / full;
    const uz = dz / full;
    let v = q.vel.x * ux + q.vel.z * uz;
    let t = react + (Math.abs(q.vel.x * uz - q.vel.z * ux) / PLAYER.lateral) * 0.6;
    if (v < 0) {
      t += -v / PLAYER.brake;
      v = 0;
    }
    // Along his sprint curve from a standstill: start where his speed already is.
    const c = this.sprintCurve(q);
    const n = c.v.length;
    let k0 = 0;
    while (k0 < n - 1 && c.v[k0 + 1] <= v) k0++;
    const s0 = c.s[k0];
    const goal = s0 + d;
    const last = n - 1;
    if (goal >= c.s[last]) return t + c.t[last] - c.t[k0] + (goal - c.s[last]) / c.v[last];
    let lo = k0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c.s[mid] < goal) lo = mid;
      else hi = mid;
    }
    const f = (goal - c.s[lo]) / Math.max(1e-6, c.s[hi] - c.s[lo]);
    return t + c.t[lo] + (c.t[hi] - c.t[lo]) * f - c.t[k0];
  }

  /** A player's sprint from a standstill (Player.move's acceleration), tabulated; cached. */
  private sprintCurve(q: Player): { t: number[]; s: number[]; v: number[] } {
    const top = q.topSpeed;
    const a = q.accelRate;
    const key = Math.round(top * 50) * 1000 + Math.round(a * 50);
    const hit = this.curves[q.id];
    if (hit && hit.key === key) return hit;
    const c = { key, t: [0], s: [0], v: [0] };
    const h = 0.05;
    let v = 0;
    let s = 0;
    for (let k = 1; v < top - 0.05 && k < 200; k++) {
      const v1 = Math.min(top, v + (a * Math.max(0.1, 1 - Math.pow(v / (top + 0.4), 1.6)) + 0.6) * h);
      s += ((v + v1) / 2) * h;
      v = v1;
      c.t.push(k * h);
      c.s.push(s);
      c.v.push(v);
    }
    this.curves[q.id] = c;
    return c;
  }

  /**
   * Where to go to get to the ball — one rule: the earliest point on the ball's path he can
   * reach before it does (the intercept, predicted with the real ball physics). A ball
   * coming at him is met on its way, one going past is cut off, one running away is caught
   * where he can catch it. In the last stride, straight onto the ball.
   */
  meetPoint(p: Player, out: V3): V3 {
    const b = this.m.ball;
    const d = this.m.ballDist(p);
    if (d < 3) {
      // Close: get in its way. A ball coming past is met by stepping across onto its line
      // (the nearest point of its path ahead of it); one at his feet or running away, by
      // going to where it'll be in a moment.
      const sp = Math.hypot(b.vel.x, b.vel.z);
      if (sp > 2) {
        const ux = b.vel.x / sp;
        const uz = b.vel.z / sp;
        const along = (p.pos.x - b.pos.x) * ux + (p.pos.z - b.pos.z) * uz;
        if (along > 0.3) return out.set(b.pos.x + ux * along, 0, b.pos.z + uz * along);
      }
      if (d < 1.5) return out.set(b.pos.x + b.vel.x * 0.1, 0, b.pos.z + b.vel.z * 0.1);
    }
    const ip = this.intercept[p.id];
    return out.set(ip.x, 0, ip.z);
  }

  /**
   * A team-mate's kick is coming through and it's not for him: if its line passes close
   * (and low enough to hit him) in the next moment, step off it, to the side he's on.
   */
  private dodge(p: Player): boolean {
    const m = this.m;
    const k = m.lastKicker;
    if (!k || k === p || k.team !== p.team || m.lastTouch !== k || m.owner || m.heldBy || m.passTarget === p) return false;
    if (m.time - m.lastKickTime > 2) return false;
    const b = m.ball;
    const sp = Math.hypot(b.vel.x, b.vel.z);
    if (sp < 8) return false;
    const rx = p.pos.x - b.pos.x;
    const rz = p.pos.z - b.pos.z;
    const t = (rx * b.vel.x + rz * b.vel.z) / (sp * sp);
    if (t <= 0.05 || t > 1.2) return false;
    const lat = (rx * b.vel.z - rz * b.vel.x) / sp;
    if (Math.abs(lat) > 1.3) return false;
    const i = Math.min(this.sampleCount - 1, Math.round(t / SAMPLE_DT));
    if (this.sy[i] > 2.0) return false; // it'll fly over him
    const side = Math.sign(lat) || 1;
    this.moveTo(p, p.pos.x + (b.vel.z / sp) * side * 2.2, p.pos.z - (b.vel.x / sp) * side * 2.2, true, true);
    return true;
  }

  /** Active planned run (e.g. onto a through ball), if any. */
  runTarget(p: Player): { x: number; z: number } | null {
    const r = this.run[p.id];
    return r.until > this.m.time ? r : null;
  }

  /** Second-last defender line (team frame) the given attacking team must stay behind. */
  offsideLineFor(team: number): number {
    return this.offside[team];
  }

  /**
   * Through ball: the spot in space that a runner reaches at the same moment as the ball,
   * before any defender or the keeper. Tries every candidate runner, several run lines
   * (toward goal, straight, his current run, the stick) and lead distances; scores safety,
   * timing, progress, danger, offside, the stick and the requested weight.
   */
  planThrough(
    p: Player,
    aimX: number,
    aimZ: number,
    aimed: boolean,
    power: number,
    lofted: boolean,
    only: Player | null,
  ): { receiver: Player; x: number; z: number; arrive: number; time: number } | null {
    const m = this.m;
    const team = m.teams[p.team];
    const dir = team.dir;
    const gx = PITCH.halfL * dir;
    const b = m.ball.pos;
    const opps = m.teams[1 - p.team].players;
    const line = this.offside[p.team];
    const prefLead = 5 + 13 * power;
    const LEADS = [4, 6.5, 9, 12, 15, 19];
    let best: { receiver: Player; x: number; z: number; arrive: number; time: number } | null = null;
    let bestS = -1e9;
    const dirs: [number, number][] = [];
    for (const q of team.players) {
      if (q === p || q.role === 'GK') continue;
      if (only && q !== only) continue;
      if (q.pos.x * dir < b.x * dir - 12) continue; // well behind the ball: not a through ball
      if (dist2D(q.pos.x, q.pos.z, b.x, b.z) > 48) continue;
      const offsideNow = q.pos.x * dir > line + 0.3 && q.pos.x * dir > b.x * dir;
      // Candidate run lines.
      dirs.length = 0;
      {
        const tx = gx - q.pos.x;
        const tz = -q.pos.z * 0.6;
        const n = Math.hypot(tx, tz) || 1;
        dirs.push([tx / n, tz / n]);
      }
      dirs.push([dir, 0]);
      // Diagonal runs into the channels either side.
      dirs.push([dir * Math.cos(0.45), Math.sin(0.45)]);
      dirs.push([dir * Math.cos(0.45), -Math.sin(0.45)]);
      if (q.speed > 2) dirs.push([q.vel.x / q.speed, q.vel.z / q.speed]);
      if (aimed) dirs.push([aimX, aimZ]);
      for (const [ux, uz] of dirs) {
        if (ux * dir < -0.2) continue; // through balls go forward
        for (const L of LEADS) {
          const x = clamp(q.pos.x + ux * L, -PITCH.halfL + 3, PITCH.halfL - 3);
          const z = clamp(q.pos.z + uz * L, -PITCH.halfW + 1.5, PITCH.halfW - 1.5);
          // Not into the six-yard box: that's the keeper's ball.
          if ((gx - x) * dir < PITCH.sixDepth + 1 && Math.abs(z) < PITCH.sixHalfWidth + 1) continue;
          const D = dist2D(b.x, b.z, x, z);
          if (D < 6) continue;
          const tr = this.runTime(q, x, z, 0.12);
          // Ball: rolling (≈1.2 m/s² of grass + air) or a lofted pass (~flight + a bounce).
          let tb: number;
          let arrive = 0;
          let v0 = 0;
          if (lofted) {
            tb = 0.55 + D / 17;
          } else {
            // Weight it so the ball gets there a touch before the runner (real physics).
            const rp = rollingPass(D, Math.max(0.5, tr - 0.15));
            if (!rp) continue;
            tb = rp.t;
            arrive = rp.arrive;
            v0 = rp.v0;
          }
          // What matters for taking it in stride is the ball's speed relative to the runner
          // (running onto it at full pace, a 12 m/s ball is easy; standing, it isn't).
          const pdx = (x - b.x) / D;
          const pdz = (z - b.z) / D;
          const runAlong = Math.max(0, (x - q.pos.x) * pdx + (z - q.pos.z) * pdz) / Math.max(0.3, Math.hypot(x - q.pos.x, z - q.pos.z));
          const relArrive = lofted ? 0 : arrive - q.topSpeed * 0.85 * runAlong;
          if (relArrive > 2.5) continue;
          const meet = Math.max(tr, tb);
          // Defenders and keeper: can anyone get to the spot first?
          let spot = 9;
          let lane = 9;
          for (const o of opps) {
            const keeper = o.role === 'GK' && this.inOwnBox(o, x, z);
            const reach = keeper ? 1.6 : 0.8;
            const top = o.topSpeed;
            spot = Math.min(spot, this.runTime(o, x, z, 0.05) - reach / top - meet);
            if (!lofted) {
              // Anyone standing close to the path will simply step across it.
              {
                const lx = x - b.x;
                const lz = z - b.z;
                const t0 = clamp(((o.pos.x - b.x) * lx + (o.pos.z - b.z) * lz) / (D * D), 0, 1);
                if (t0 > 0.05 && t0 < 0.97) {
                  const perp = Math.hypot(o.pos.x - (b.x + lx * t0), o.pos.z - (b.z + lz * t0));
                  lane = Math.min(lane, (perp - 2.2) * 1.5);
                }
              }
              for (let k = 1; k <= 5; k++) {
                const f = k / 6;
                const px = b.x + (x - b.x) * f;
                const pz = b.z + (z - b.z) * f;
                // When the ball really gets there (same physics table as the strike).
                const tk = rollTimeAt(v0, D * f);
                if (tk < 0) continue;
                lane = Math.min(lane, this.runTime(o, px, pz, 0.05) - 0.9 / top - tk);
              }
            }
          }
          const progress = ((x - b.x) * dir) / 20;
          const threat = 1 - clamp(dist2D(x, z, gx, 0) / 38, 0, 1);
          let sc =
            progress * 0.9 +
            threat * 0.9 +
            // Must beat every defender and the keeper by a real margin.
            clamp((spot - 0.2) / 0.4, -3, 1) * 1.4 +
            (lofted ? 0 : clamp((lane - 0.15) / 0.3, -3, 1) * 1.4) -
            Math.abs(tb - tr) * 0.35 -
            Math.max(0, relArrive + 1) * 0.35 +
            q.attrs.pace * 0.25 +
            (q.role === 'FWD' ? 0.2 : 0);
          if (offsideNow) sc -= 4;
          if (aimed) {
            const pd = Math.max(0.1, D);
            const align = ((x - b.x) * aimX + (z - b.z) * aimZ) / pd;
            sc += align * 2.2 - (align < 0.45 ? 3 : 0);
            sc -= Math.abs(L - prefLead) / 7;
          }
          if (sc > bestS) {
            bestS = sc;
            best = { receiver: q, x, z, arrive, time: meet };
          }
        }
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ perception

  private computeIntercepts(): void {
    const m = this.m;
    const b = m.ball;
    let n = 0;
    if (m.heldBy || m.phase !== 'play') {
      for (let i = 0; i < SAMPLES; i++) {
        this.sx[i] = b.pos.x;
        this.sy[i] = b.pos.y;
        this.sz[i] = b.pos.z;
      }
      n = SAMPLES;
    } else {
      let next = 0;
      predictBallAt(b, SAMPLES * SAMPLE_DT, (pb, t) => {
        if (t + 1e-6 >= next * SAMPLE_DT && n < SAMPLES) {
          this.sx[n] = pb.pos.x;
          this.sy[n] = pb.pos.y;
          this.sz[n] = pb.pos.z;
          n++;
          next++;
        }
        return n >= SAMPLES;
      });
      while (n < SAMPLES) {
        this.sx[n] = this.sx[n - 1];
        this.sy[n] = this.sy[n - 1];
        this.sz[n] = this.sz[n - 1];
        n++;
      }
    }
    this.sampleCount = n;

    // Each player's meeting point: the earliest point on the ball's path he could reach at
    // full stride. Deliberately ambitious — it has him attack the ball instead of waiting
    // for it (and as he closes in it settles on where they really meet). How much time he
    // actually has there, by the way he really runs, is the slack: that sets his pace.
    for (const p of m.players) {
      const ip = this.intercept[p.id];
      ip.t = -1;
      const top = p.topSpeed * 0.92;
      // Best effort if unreachable in the horizon: the point he gets closest to in time.
      let bestDef = 1e9;
      let bestI = n - 1;
      for (let i = 0; i < n; i++) {
        const t = i * SAMPLE_DT;
        const y = this.sy[i];
        const maxH = p.role === 'GK' && this.inOwnBox(p, this.sx[i], this.sz[i]) ? 2.5 : p.headReach;
        if (y > maxH) continue;
        const d = dist2D(p.pos.x, p.pos.z, this.sx[i], this.sz[i]) - PLAYER.reach * 0.8;
        const deficit = d - Math.max(0, t - 0.2) * top;
        if (deficit < bestDef) {
          bestDef = deficit;
          bestI = i;
        }
        if (d <= Math.max(0, t - 0.2) * top) {
          ip.t = t;
          bestI = i;
          break;
        }
      }
      ip.x = this.sx[bestI];
      ip.z = this.sz[bestI];
      ip.slack = bestI * SAMPLE_DT - this.runTime(p, ip.x, ip.z, 0.05, PLAYER.reach * 0.75);
    }

    for (let t = 0; t < 2; t++) {
      let best: Player | null = null;
      let bt = 1e9;
      for (const p of m.teams[t].players) {
        const ip = this.intercept[p.id];
        if (p.role === 'GK' && !this.inOwnBox(p, ip.x, ip.z)) continue;
        const score = ip.t >= 0 ? ip.t : 10 + dist2D(p.pos.x, p.pos.z, ip.x, ip.z) / p.topSpeed;
        if (score < bt) {
          bt = score;
          best = p;
        }
      }
      this.chaser[t] = best;
      // Offside line for the *other* team: second-last defender of team t.
      const dir = m.teams[t].dir;
      let a = -1e9;
      let bb = -1e9;
      for (const p of m.teams[t].players) {
        const v = -p.pos.x * dir; // depth toward own goal in attacker's frame
        if (v > a) {
          bb = a;
          a = v;
        } else if (v > bb) bb = v;
      }
      const ballInAttFrame = b.pos.x * -dir;
      this.offside[1 - t] = Math.max(bb, ballInAttFrame, 0);
    }
  }

  inOwnBox(p: Player, x: number, z: number): boolean {
    const own = -this.m.teams[p.team].dir;
    return x * own > PITCH.halfL - PITCH.boxDepth && Math.abs(z) < PITCH.boxHalfWidth;
  }

  // ------------------------------------------------------------------ main

  update(): void {
    const m = this.m;
    if (m.time >= this.nextIntercept) {
      this.computeIntercepts();
      this.nextIntercept = m.time + 0.1;
    }
    // A keeper without the ball shouldn't stay human-controlled.
    // (Unless he's playing it with his feet: a pass to him from a team-mate, or the ball at his feet.)
    const keeperFeet = m.owner === m.controlled || (m.passTarget === m.controlled && m.lastKicker?.team === m.controlled.team);
    if (m.controlled.role === 'GK' && m.heldBy !== m.controlled && !keeperFeet && m.phase === 'play' && !(m.setPiece && m.setPiece.taker === m.controlled)) {
      const ch = this.chaser[m.humanTeam];
      if (ch && ch.role !== 'GK') m.setControlled(ch);
    }
    // Auto-switch on defence / loose balls to the teammate who should take the ball.
    const att = m.attackingTeam();
    const c = m.controlled;
    if (m.phase === 'play' && att !== m.humanTeam && m.shotTeam() !== m.humanTeam && m.switchT > 0.45 && c.action !== 'tackle' && c.action !== 'slide') {
      const ci = this.intercept[c.id];
      const ct = ci.t >= 0 ? ci.t : 9;
      const cd = m.ballDist(c);
      // Is the stick pushing toward the ball? (Then the player clearly means to chase.)
      let toward = 0;
      if (m.noInputT === 0 && cd > 0.5) {
        const bx = (m.ball.pos.x - c.pos.x) / cd;
        const bz = (m.ball.pos.z - c.pos.z) / cd;
        toward = c.touchX * bx + c.touchZ * bz;
      }
      const idle = m.noInputT > 0.25;
      const margin = idle ? 0.25 : toward > 0.6 ? 0.9 : 0.4;
      let best: Player | null = null;
      let bestScore = 0;
      for (const q of m.teams[m.humanTeam].players) {
        if (q === c || q.role === 'GK' || q.action === 'stumble' || q.action === 'fall') continue;
        const qi = this.intercept[q.id];
        const qt = qi.t >= 0 ? qi.t : 9;
        const qd = m.ballDist(q);
        // Clearly closer to the ball (half the distance and at least 4 m nearer)…
        const muchCloser = qd < cd * 0.5 && cd - qd > 4;
        // …or gets there meaningfully sooner.
        const sooner = ct - qt > margin && cd > 2.5;
        if (!muchCloser && !sooner) continue;
        const score = (ct - qt) + (cd - qd) * 0.15;
        if (score > bestScore) {
          bestScore = score;
          best = q;
        }
      }
      if (best) m.setControlled(best);
    }

    if (m.owner !== this.lastOwner) {
      this.lastOwner = m.owner;
      this.possStart = m.time;
      this.patience = 0.35 + m.rng.next() * 0.9;
    }

    for (const p of m.players) {
      const isTaker = m.setPiece !== null && m.setPiece.taker === p;
      if (p === m.controlled && !isTaker && m.phase !== 'goal' && !m.autoPlay) continue;
      this.think(p);
    }
  }

  private think(p: Player): void {
    const m = this.m;
    p.lookAt = null;
    p.squareUp = false;
    p.burst = false;
    p.sprinting = false;
    switch (m.phase) {
      case 'goal':
        return this.celebrate(p);
      case 'out':
        // Play's stopped: ease off and watch the ball.
        p.wantSpeed = Math.max(0, p.wantSpeed - DT * 5);
        p.lookTarget.copy(m.ball.pos);
        p.lookAt = p.lookTarget;
        return;
      case 'halftime':
      case 'fulltime':
        p.wantSpeed = 0;
        return;
      case 'kickoff':
      case 'setpiece':
        return this.setPieceThink(p);
    }
    if (m.owner === p) return this.carrierThink(p);
    if (p.role === 'GK') return this.keeperThink(p);

    const att = m.attackingTeam();
    const run = this.run[p.id];
    if (m.passTarget === p) {
      // Run with the body where he's going (squaring up to the ball only in the last few
      // metres, in moveTo): facing a ball played from behind would have him backpedalling.
      this.meetPoint(p, this.tmp);
      this.moveTo(p, this.tmp.x, this.tmp.z, true, false);
      // As it arrives he opens his body to it, set to take it.
      p.squareUp = m.ballDist(p) < 6;
      p.burst = m.ballDist(p) < 2.5;
      p.sprinting = m.ballDist(p) > 6;
      return;
    }
    // A team-mate's kick coming through: get out of its way.
    if (this.dodge(p)) return;
    // A cross is on: attackers fill the box, defenders drop in to mark it.
    const crossCarrier = m.owner && m.inCrossZone(m.owner.team, m.owner.pos.x, m.owner.pos.z) ? m.owner : null;
    const pressing = crossCarrier !== null && crossCarrier.team !== p.team && this.chaser[p.team] === p;
    if (crossCarrier && crossCarrier !== p && !pressing && run.until <= m.time) {
      const spot = this.boxSpot(p, crossCarrier, crossCarrier.team === p.team);
      if (spot) {
        this.moveTo(p, spot[0], spot[1], dist2D(p.pos.x, p.pos.z, spot[0], spot[1]) > 6, true);
        return;
      }
    }

    if (att === p.team) {
      // Forwards (and sometimes midfielders) attack the space behind the last line.
      const carrier = m.owner ?? m.heldBy;
      if (run.until <= m.time && carrier && carrier !== p && (p.role === 'FWD' || p.role === 'MID')) {
        const dir = m.teams[p.team].dir;
        const cx = carrier.pos.x * dir;
        const line = this.offside[p.team];
        const nearLine = p.pos.x * dir > line - 9 && p.pos.x * dir < line + 0.5;
        const chance = (p.role === 'FWD' ? 0.006 : 0.0015) * (cx > -10 ? 1 : 0.3);
        if (nearLine && m.rng.next() < chance) {
          const tz = p.pos.z * 0.6 + (m.rng.next() - 0.5) * 12;
          this.setRun(p, (line + 7 + m.rng.next() * 6) * dir, tz);
          run.until = m.time + 2.2;
        }
      }
      if (run.until > m.time) {
        this.moveTo(p, run.x, run.z, true, false);
        return;
      }
      return this.offBall(p, true);
    }
    // Our own shot in flight: nobody runs onto it; follow it in (rebounds) in shape.
    if (m.shotTeam() === p.team) return this.offBall(p, true);
    // Defending or loose ball.
    if (this.chaser[p.team] === p) {
      if (m.owner && m.owner.team !== p.team) return this.press(p, m.owner);
      const ip = this.intercept[p.id];
      this.moveTo(p, ip.x, ip.z, true, true);
      p.burst = m.ballDist(p) < 2.5;
      return;
    }
    // Second defender: cover goal-side of the ball if close.
    if (m.owner && m.owner.team !== p.team && this.isSecondPresser(p)) {
      const gx = -m.teams[p.team].dir * PITCH.halfL;
      const bx = m.ball.pos.x;
      const bz = m.ball.pos.z;
      const dx = gx - bx;
      const dz = -bz;
      const d = Math.max(0.1, Math.hypot(dx, dz));
      this.moveTo(p, bx + (dx / d) * 6, bz + (dz / d) * 6, false, false);
      p.lookTarget.copy(m.ball.pos);
      p.lookAt = p.lookTarget;
      return;
    }
    this.offBall(p, false);
  }

  /**
   * Off-ball movement as a small steering field. The shape slot is the anchor; on top of
   * it each player adds the force that matters to him right now:
   * - attacking: drift into a pocket of space with a clear lane from the ball,
   * - defending: pick up the most dangerous attacker in his zone and stand goal-side,
   * - always: keep apart from teammates, so the team spreads by itself.
   * The result is not followed directly: each player's goal eases toward it at his own
   * reading speed, so a turnover ripples through the team instead of snapping everyone
   * at once, and those who read it late have to sprint to recover.
   */
  private offBall(p: Player, attacking: boolean): void {
    const m = this.m;
    const tr = this.traits[p.id];
    const dir = m.teams[p.team].dir;
    this.slot(p, this.tmp);
    const ax = this.tmp.x;
    const az = this.tmp.z;
    let tx = ax;
    let tz = az;

    if (attacking) {
      if (m.time >= this.seekAt[p.id]) this.seekSpace(p, ax, az);
      tx += this.seekDX[p.id] * dir;
      tz += this.seekDZ[p.id] * dir;
    } else {
      if (m.time >= this.markAt[p.team]) this.assignMarks(p.team);
      const a = this.mark[p.id];
      if (a) {
        // Goal-side of his man, shaded toward the ball; tighter the nearer our goal.
        const gx = -dir * PITCH.halfL;
        const gdx = gx - a.pos.x;
        const gdz = -a.pos.z * 0.7;
        const gd = Math.max(0.1, Math.hypot(gdx, gdz));
        const bdx = m.ball.pos.x - a.pos.x;
        const bdz = m.ball.pos.z - a.pos.z;
        const bd = Math.max(0.1, Math.hypot(bdx, bdz));
        const danger = 1 - clamp((a.pos.x * -dir + PITCH.halfL) / PITCH.halfL, 0, 1);
        const gap = 1.4 + (1 - danger) * 2.2;
        let mx = a.pos.x + (gdx / gd) * gap + (bdx / bd) * 0.9;
        const mz = a.pos.z + (gdz / gd) * gap + (bdz / bd) * 0.9;
        // Defenders step out of the line only so far; beyond that they pass him on.
        if (p.role === 'DEF') mx = dir * Math.min(mx * dir, ax * dir + 5);
        const w = clamp(0.45 + danger * 0.35 + (1 - tr.discipline) * 0.15, 0, 0.92);
        tx += (mx - tx) * w;
        tz += (mz - tz) * w;
      }
    }

    // Separation: nobody crowds a teammate's space.
    let sx = 0;
    let sz = 0;
    for (const q of m.teams[p.team].players) {
      if (q === p || q.role === 'GK') continue;
      const dx = tx - q.pos.x;
      const dz = tz - q.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 49 || d2 < 1e-4) continue;
      const d = Math.sqrt(d2);
      const f = ((7 - d) / 7) * 2.6;
      sx += (dx / d) * f;
      sz += (dz / d) * f;
    }
    tx = clamp(tx + sx, -PITCH.halfL + 1.5, PITCH.halfL - 1.5);
    tz = clamp(tz + sz, -PITCH.halfW + 1, PITCH.halfW - 1);

    // Reading of the game: the goal follows the field at the player's own pace.
    if (m.time - this.offBallT[p.id] > 0.25) {
      this.goalX[p.id] = tx;
      this.goalZ[p.id] = tz;
    }
    this.offBallT[p.id] = m.time;
    const tau = 0.18 + (1 - tr.react) * 0.55;
    const k = 1 - Math.exp(-DT / tau);
    const gx = (this.goalX[p.id] += (tx - this.goalX[p.id]) * k);
    const gz = (this.goalZ[p.id] += (tz - this.goalZ[p.id]) * k);

    // Recovery: caught upfield after a turnover (or badly out of place), hard workers sprint back.
    const d = dist2D(p.pos.x, p.pos.z, gx, gz);
    const behindPlay = !attacking && (p.pos.x - m.ball.pos.x) * dir > 2;
    const turnover = m.time - this.possStart < 3;
    const urgent = d > 6 + (1 - tr.work) * 10 && (behindPlay || turnover);
    this.moveTo(p, gx, gz, urgent, !attacking || d < 6);
    if (!urgent) p.wantSpeed *= 0.88 + tr.work * 0.2;
  }

  /**
   * Choose a pocket of space near the slot: open from opponents, a clear lane from the
   * ball, some forward progress, not on top of a teammate, and not too far from where the
   * shape wants him (how far depends on his discipline and creativity). Re-read every
   * half second or so, staggered so the team never moves in lockstep.
   */
  private seekSpace(p: Player, ax: number, az: number): void {
    const m = this.m;
    const tr = this.traits[p.id];
    const dir = m.teams[p.team].dir;
    const ball = m.ball.pos;
    const line = this.offside[p.team];
    const roam = 3 + tr.creativity * 7;
    let best = -1e9;
    let bdx = 0;
    let bdz = 0;
    for (let i = 0; i <= 8; i++) {
      const ang = (i / 8) * Math.PI * 2 + p.id;
      const r = i === 8 ? 0 : roam * (0.55 + 0.45 * hash01(p.id + i, m.time | 0));
      // Candidate offsets in team frame, sticking near the previous choice.
      const ox = i === 8 ? this.seekDX[p.id] : Math.cos(ang) * r;
      const oz = i === 8 ? this.seekDZ[p.id] : Math.sin(ang) * r;
      const cx = ax + ox * dir;
      const cz = az + oz * dir;
      if (Math.abs(cz) > PITCH.halfW - 1.5 || Math.abs(cx) > PITCH.halfL - 3) continue;
      let open = 99;
      for (const q of m.teams[1 - p.team].players) open = Math.min(open, dist2D(q.pos.x, q.pos.z, cx, cz));
      let crowd = 0;
      for (const q of m.teams[p.team].players) {
        if (q === p) continue;
        const d = dist2D(q.pos.x, q.pos.z, cx, cz);
        if (d < 9) crowd += (9 - d) / 9;
      }
      const lane = clamp(this.laneClearance(ball.x, ball.z, cx, cz, p.team, true), -2, 3);
      const fromBall = dist2D(ball.x, ball.z, cx, cz);
      const range = fromBall < 7 ? (7 - fromBall) * 0.3 : fromBall > 30 ? (fromBall - 30) * 0.1 : 0;
      const prog = cx * dir;
      let s = Math.min(open, 9) * 0.35 + lane * 0.45 + ox * (0.04 + tr.creativity * 0.1) - crowd * 0.6 - range;
      s -= Math.hypot(ox, oz) * (0.04 + tr.discipline * 0.12);
      if (prog > line - 0.8) s -= (prog - line + 0.8) * 1.5;
      if (i === 8) s += 0.4; // hysteresis
      if (s > best) {
        best = s;
        bdx = ox;
        bdz = oz;
      }
    }
    this.seekDX[p.id] = bdx;
    this.seekDZ[p.id] = bdz;
    this.seekAt[p.id] = m.time + 0.45 + hash01(p.id, m.time * 3) * 0.5 + (1 - tr.react) * 0.3;
  }

  /**
   * Zonal marking: each free defender picks up the most dangerous opponent inside his
   * zone (around his slot), greedily by cost, each attacker taken once. The carrier is
   * the chasers' job, so he's left out.
   */
  private assignMarks(team: number): void {
    const m = this.m;
    const dir = m.teams[team].dir;
    const carrier = m.owner ?? m.heldBy;
    const mine = m.teams[team].players;
    const theirs = m.teams[1 - team].players;
    for (const p of mine) this.mark[p.id] = null;
    const taken = new Set<Player>();
    for (let round = 0; round < mine.length; round++) {
      let best = 1e9;
      let bp: Player | null = null;
      let bq: Player | null = null;
      for (const p of mine) {
        if (p.role === 'GK' || this.mark[p.id] || p === this.chaser[team]) continue;
        const a = this.slot(p, this.tmp2);
        const zone = 9 + (1 - this.traits[p.id].discipline) * 6 + (p.role === 'DEF' ? 2 : 0);
        for (const q of theirs) {
          if (q.role === 'GK' || q === carrier || taken.has(q)) continue;
          const d = dist2D(a.x, a.z, q.pos.x, q.pos.z);
          if (d > zone) continue;
          // Danger: near our goal and central.
          const toGoal = q.pos.x * -dir + PITCH.halfL;
          const danger = clamp(1 - toGoal / 60, 0, 1) * (1 - Math.abs(q.pos.z) / (PITCH.halfW * 1.6));
          const cost = d - danger * 8;
          if (cost < best) {
            best = cost;
            bp = p;
            bq = q;
          }
        }
      }
      if (!bp || !bq) break;
      this.mark[bp.id] = bq;
      taken.add(bq);
    }
    this.markAt[team] = m.time + 0.3;
  }

  /** Box positions while the ball is in a crossing area (null = keep normal shape). */
  private boxSpot(p: Player, carrier: Player, attacking: boolean): [number, number] | null {
    const m = this.m;
    const attDir = m.teams[carrier.team].dir;
    const gx = PITCH.halfL * attDir; // the goal being attacked
    const near = Math.sign(carrier.pos.z || 1);
    const jitter = Math.sin(p.id * 7.3 + m.time * 0.4) * 0.8;
    if (attacking) {
      switch (p.index) {
        case 9: return [gx - attDir * 8.5, near * 1.5 + jitter];
        case 8: case 10: return Math.sign(p.baseZ * attDir) === near ? [gx - attDir * 5.5, near * 3 + jitter] : [gx - attDir * 7, -near * 4 + jitter];
        case 6: case 7: return [gx - attDir * 15, (p.index === 6 ? -1 : 1) * 5 + jitter];
        default: return null;
      }
    }
    // Defending the cross: centre-backs on the six-yard line, full-backs tuck in.
    switch (p.index) {
      case 2: return [gx - attDir * 6, -2.2 + near * 0.8];
      case 3: return [gx - attDir * 6, 2.2 + near * 0.8];
      case 1: case 4: return Math.sign(p.baseZ * -attDir) === near ? null : [gx - attDir * 8, -near * 5];
      case 5: return [gx - attDir * 13, near * 1.5];
      default: return null;
    }
  }

  private isSecondPresser(p: Player): boolean {
    const m = this.m;
    const ch = this.chaser[p.team];
    let best: Player | null = null;
    let bd = 1e9;
    for (const q of m.teams[p.team].players) {
      if (q === ch || q.role === 'GK') continue;
      const d = m.ballDist(q);
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    return best === p && bd < 16;
  }

  /** Steering with arrival: sprint when far / urgent, ease in near the target. */
  moveTo(p: Player, x: number, z: number, urgent: boolean, faceBall: boolean): void {
    const dx = x - p.pos.x;
    const dz = z - p.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.25) {
      p.moveX = 0;
      p.moveZ = 0;
      p.wantSpeed = 0;
    } else {
      p.moveX = dx / d;
      p.moveZ = dz / d;
      const cruise = urgent ? p.topSpeed : d > 12 ? PLAYER.jogSpeed + 1.2 : PLAYER.jogSpeed * 0.85;
      p.wantSpeed = Math.min(cruise, d * (urgent ? 3 : 1.3) + 0.3);
      p.sprinting = p.wantSpeed > PLAYER.jogSpeed + 0.5;
    }
    if (faceBall || d < 4) {
      p.lookTarget.copy(this.m.ball.pos);
      p.lookAt = p.lookTarget;
    }
  }

  /** Where a player should stand given the team shape and the ball. */
  slot(p: Player, out: V3): V3 {
    const m = this.m;
    const team = m.teams[p.team];
    const dir = team.dir;
    const bx = m.ball.pos.x * dir;
    const bz = m.ball.pos.z * dir;
    const attacking = m.possTeam === p.team;
    let x: number;
    let z: number;
    if (attacking) {
      x = p.baseX * PITCH.halfL * 0.62 + bx * 0.45 + 10;
      z = p.baseZ * PITCH.halfW * 0.88 + bz * 0.2;
      if (p.role === 'FWD') x = Math.min(x + 4, this.offside[p.team] - 0.8);
      else x = Math.min(x, this.offside[p.team] - 0.8);
    } else {
      x = p.baseX * PITCH.halfL * 0.5 + bx * 0.5 - 4;
      z = p.baseZ * PITCH.halfW * 0.62 + bz * 0.35;
      // Don't defend higher than the ball.
      if (p.role === 'DEF') x = Math.min(x, bx - 4);
    }
    x = clamp(x, -PITCH.halfL + 4, PITCH.halfL - 6);
    z = clamp(z, -PITCH.halfW + 1.5, PITCH.halfW - 1.5);
    // Small personal offset keeps lines from looking robotic.
    x += Math.sin(p.id * 12.9 + m.time * 0.13) * 1.2;
    return out.set(x * dir, 0, z * dir);
  }

  /** Goal-side point from which to contain the ball carrier. */
  containTarget(p: Player, out: V3, keep = 1.3): V3 {
    const m = this.m;
    const b = m.ball.pos;
    const gx = -m.teams[p.team].dir * PITCH.halfL;
    const dx = gx - b.x;
    const dz = -b.z * 0.5;
    const d = Math.max(0.1, Math.hypot(dx, dz));
    return out.set(b.x + (dx / d) * keep, 0, b.z + (dz / d) * keep);
  }

  private press(p: Player, carrier: Player): void {
    const m = this.m;
    this.containTarget(p, this.tmp);
    const d = m.ballDist(p);
    this.moveTo(p, this.tmp.x, this.tmp.z, d > 4, true);
    // Closing in: square to him, ready to jockey.
    p.squareUp = d < 6;
    if (d < 5) {
      p.wantSpeed = Math.min(p.wantSpeed, carrier.speed + 1.5 + d);
    }
    // Tackle when close and the ball is exposed.
    if (d < 1.5 && !p.isBusy() && m.time > this.tackleReady[p.id]) {
      this.tackleReady[p.id] = m.time + 0.9 + m.rng.next() * 0.8;
      const exposed = m.ballDist(carrier) > 0.45 ? 0.25 : 0;
      if (m.rng.next() < 0.15 + p.attrs.defending * 0.2 + exposed) {
        const dx = m.ball.pos.x - p.pos.x;
        const dz = m.ball.pos.z - p.pos.z;
        const dd = Math.max(0.01, Math.hypot(dx, dz));
        m.startTackle(p, dx / dd, dz / dd, false);
      }
    }
  }

  // ------------------------------------------------------------------ ball carrier

  private carrierThink(p: Player): void {
    const m = this.m;
    const team = m.teams[p.team];
    const dir = team.dir;
    const gx = PITCH.halfL * dir;
    const b = m.ball.pos;
    if (m.time >= this.nextDecision[p.id] && p.sinceTouch > 0.05 && !p.plan) {
      this.nextDecision[p.id] = m.time + 0.22 + m.rng.next() * 0.15;
      const distGoal = dist2D(b.x, b.z, gx, 0);
      const pressure = m.nearestOpponentDist(p);
      const held = m.time - this.possStart;
      // Keepers with the ball at their feet: move it on quickly.
      if (p.role === 'GK') {
        const fwd = team.players[pressure < 6 ? 9 : 2 + Math.floor(m.rng.next() * 2)];
        const dx = fwd.pos.x - b.x;
        const dz = fwd.pos.z - b.z;
        const d = Math.hypot(dx, dz);
        p.plan = { type: pressure < 6 ? 'lob' : 'pass', dirX: dx / d, dirZ: dz / d, power: 0, targetId: fwd.id, expires: m.time + 1 };
        return this.dribble(p, true);
      }
      // Take a touch or two before deciding, unless someone is right on us.
      if (held < this.patience && pressure > 2.2 && distGoal > 20) {
        this.chooseDribble(p, pressure);
        return this.dribble(p, false);
      }
      const clear = this.laneClearance(b.x, b.z, gx, 0, p.team, true);

      // Shoot?
      let shootP = 0;
      if (distGoal < 16) shootP = 0.8;
      else if (distGoal < 25 && clear > 0.4) shootP = 0.5;
      else if (distGoal < 30 && clear > 1.5 && p.attrs.shooting > 0.75) shootP = 0.15;
      const angle = Math.abs(Math.atan2(b.z, Math.abs(gx - b.x)));
      if (angle > 1.1) shootP *= 0.2;
      if (m.rng.next() < shootP) {
        const pw = clamp(0.55 + distGoal / 40 + m.rng.gauss() * 0.12, 0.35, 1.0);
        p.plan = { type: 'shot', dirX: dir, dirZ: m.rng.next() < 0.5 ? -1 : 1, power: pw, targetId: -1, expires: m.time + 1 };
        return this.dribble(p, true);
      }

      // Cross? Wide near the byline with someone attacking the box.
      if (m.inCrossZone(p.team, b.x, b.z) && Math.abs(b.z) > 11 && distGoal > 10) {
        let inBox = 0;
        for (const q of team.players) {
          if (q === p || q.role === 'GK') continue;
          if ((gx - q.pos.x) * dir < 18 && Math.abs(q.pos.z) < 18) inBox++;
        }
        const crossP = inBox >= 2 ? 0.45 : inBox === 1 ? 0.25 : 0.04;
        if (m.rng.next() < crossP) {
          const dx = gx - b.x;
          const dz = -b.z;
          const d = Math.max(0.1, Math.hypot(dx, dz));
          p.plan = { type: 'cross', dirX: dx / d, dirZ: dz / d, aimed: false, power: 0, targetId: -1, expires: m.time + 1.2 };
          return this.dribble(p, true);
        }
      }

      // Pass?
      let best: Player | null = null;
      let bestScore = -1e9;
      let bestThrough = false;
      for (const q of team.players) {
        if (q === p) continue;
        for (let k = 0; k < 2; k++) {
          const through = k === 1;
          // Through balls only for runners near the last line.
          if (through && (q.role === 'GK' || q.role === 'DEF' || q.pos.x * dir < this.offside[p.team] - 10)) continue;
          const s = this.passScore(p, q, through);
          if (s > bestScore) {
            bestScore = s;
            best = q;
            bestThrough = through;
          }
        }
      }
      const dribbleValue = this.dribbleValue(p);
      const needPass = pressure < 2.2 ? 0.45 : pressure < 4 ? 0.15 : 0;
      if (best && bestScore + needPass > dribbleValue + 0.55 + 0.3 * m.rng.next()) {
        const dx = best.pos.x - b.x;
        const dz = best.pos.z - b.z;
        const d = Math.hypot(dx, dz);
        const lob = !bestThrough && d > 26 && this.laneClearance(b.x, b.z, best.pos.x, best.pos.z, p.team, false) < 1.5;
        p.plan = {
          type: bestThrough ? 'through' : lob ? 'lob' : 'pass',
          dirX: dx / d,
          dirZ: dz / d,
          power: 0,
          targetId: best.id,
          expires: m.time + 1,
        };
        p.lookTarget.set(best.pos.x, 0, best.pos.z);
        return this.dribble(p, true);
      }

      this.chooseDribble(p, pressure);
    }
    this.dribble(p, false);
  }

  private chooseDribble(p: Player, pressure: number): void {
    const m = this.m;
    const dir = m.teams[p.team].dir;
    const gx = PITCH.halfL * dir;
    const b = m.ball.pos;
    {
      // Dribble direction: toward goal, away from pressure, away from the touchline.
      let dx = (gx - b.x) / Math.max(1, Math.abs(gx - b.x));
      let dz = (-b.z / PITCH.halfW) * 0.5;
      for (const q of m.teams[1 - p.team].players) {
        const ox = p.pos.x - q.pos.x;
        const oz = p.pos.z - q.pos.z;
        const od = Math.hypot(ox, oz);
        if (od < 7 && od > 0.01) {
          const w = ((7 - od) / 7) ** 2 * 1.6;
          dx += (ox / od) * w;
          dz += (oz / od) * w;
        }
      }
      if (Math.abs(b.z) > PITCH.halfW - 4) dz -= Math.sign(b.z) * 0.8;
      // Never dribble backwards into our own goal area.
      if (dx * dir < -0.3) dx = -0.3 * dir;
      const n = Math.max(0.01, Math.hypot(dx, dz));
      this.dribX[p.id] = dx / n;
      this.dribZ[p.id] = dz / n;
      this.dribSprint[p.id] = pressure > 5 && this.dribbleValue(p) > 0.45;
    }
  }

  private dribble(p: Player, settle: boolean): void {
    const m = this.m;
    const b = m.ball.pos;
    let mx = this.dribX[p.id];
    let mz = this.dribZ[p.id];
    if (settle && p.plan) {
      // Shape up for the strike: slow down and turn toward the target.
      mx = p.plan.dirX;
      mz = p.plan.dirZ;
    }
    p.touchX = mx;
    p.touchZ = mz;
    // Stay with the ball: steer toward it when it's ahead of us.
    const tbx = b.x + m.ball.vel.x * 0.15 - p.pos.x;
    const tbz = b.z + m.ball.vel.z * 0.15 - p.pos.z;
    const td = Math.hypot(tbx, tbz);
    if (td > 0.45) {
      mx = mx * 0.3 + (tbx / td) * 0.7;
      mz = mz * 0.3 + (tbz / td) * 0.7;
      const n = Math.hypot(mx, mz);
      mx /= n;
      mz /= n;
    }
    p.moveX = mx;
    p.moveZ = mz;
    const sprint = this.dribSprint[p.id] && !settle;
    p.sprinting = sprint;
    p.wantSpeed = settle ? 3 : sprint ? p.topSpeed : PLAYER.jogSpeed * 0.95;
  }

  private dribbleValue(p: Player): number {
    const m = this.m;
    const dir = m.teams[p.team].dir;
    let space = 12;
    for (const q of m.teams[1 - p.team].players) {
      const dx = (q.pos.x - p.pos.x) * dir;
      const dz = q.pos.z - p.pos.z;
      if (dx < -1) continue;
      const d = Math.hypot(dx, dz);
      if (Math.abs(dz) < dx * 1.2 + 2) space = Math.min(space, d);
    }
    return clamp(space / 10, 0, 1) * 0.9;
  }

  /** Minimum clearance (m) of opponents from the lane, scaled by how much time they have. */
  laneClearance(ax: number, az: number, bx: number, bz: number, team: number, ignoreKeeper: boolean): number {
    const m = this.m;
    const lx = bx - ax;
    const lz = bz - az;
    const len = Math.max(0.1, Math.hypot(lx, lz));
    const ux = lx / len;
    const uz = lz / len;
    let minC = 99;
    for (const q of m.teams[1 - team].players) {
      if (ignoreKeeper && q.role === 'GK') continue;
      const qx = q.pos.x - ax;
      const qz = q.pos.z - az;
      const along = qx * ux + qz * uz;
      if (along < 0 || along > len + 1) continue;
      const perp = Math.abs(qx * uz - qz * ux);
      const reach = 0.9 + (along / 13) * 4;
      minC = Math.min(minC, perp - reach);
    }
    return minC;
  }

  private passScore(p: Player, q: Player, through: boolean): number {
    const m = this.m;
    const dir = m.teams[p.team].dir;
    let tx = q.pos.x;
    let tz = q.pos.z;
    if (through) {
      tx += dir * 8;
      if (tx * dir > this.offside[p.team] + 6) return -9;
      if (Math.abs(tx) > PITCH.halfL - 3) return -9;
    }
    const b = m.ball.pos;
    const d = dist2D(b.x, b.z, tx, tz);
    if (d < 5 || d > 45) return -9;
    if (q.role === 'GK' && d > 20) return -9;
    if (!through && q.pos.x * dir > this.offside[p.team] + 0.3) return -9; // offside
    const lane = this.laneClearance(b.x, b.z, tx, tz, p.team, false);
    if (lane < -0.3) return -9;
    let open = 99;
    for (const o of m.teams[1 - p.team].players) open = Math.min(open, dist2D(o.pos.x, o.pos.z, tx, tz));
    const progress = ((tx - b.x) * dir) / 25;
    const goalDist = dist2D(tx, tz, PITCH.halfL * dir, 0);
    const threat = clamp(1 - goalDist / 40, 0, 1);
    return progress * 0.8 + clamp(lane / 3, 0, 1) * 0.7 + clamp(open / 7, 0, 1) * 0.5 + threat * 0.6 - d / 70;
  }

  /** Best option overall (used when the stick is idle). */
  bestReceiver(p: Player, through: boolean): Player | null {
    let best: Player | null = null;
    let bs = -1e9;
    for (const q of this.m.teams[p.team].players) {
      if (q === p) continue;
      const s = this.passScore(p, q, through);
      if (s > bs) {
        bs = s;
        best = q;
      }
    }
    if (bs < -5) {
      // Everything looks risky: nearest teammate.
      let bd = 1e9;
      for (const q of this.m.teams[p.team].players) {
        if (q === p || q.role === 'GK') continue;
        const d = this.m.ballDist(q);
        if (d < bd) {
          bd = d;
          best = q;
        }
      }
    }
    return best;
  }

  /** Receiver for a human pass: the teammate best aligned with the stick. */
  pickReceiver(p: Player, dirX: number, dirZ: number, through: boolean): Player | null {
    const m = this.m;
    let best: Player | null = null;
    let bestS = -1e9;
    for (const q of m.teams[p.team].players) {
      if (q === p) continue;
      const dx = q.pos.x - p.pos.x;
      const dz = q.pos.z - p.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 2 || d > 50) continue;
      const align = (dx * dirX + dz * dirZ) / d;
      if (align < 0.35) continue;
      let open = 99;
      for (const o of m.teams[1 - p.team].players) open = Math.min(open, dist2D(o.pos.x, o.pos.z, q.pos.x, q.pos.z));
      let s = align * 3 + clamp(open / 6, 0, 1) * 0.6 - d / 35;
      if (through && q.role === 'FWD') s += 0.3;
      if (q.role === 'GK') s -= 0.8;
      if (s > bestS) {
        bestS = s;
        best = q;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ set pieces

  private setPieceThink(p: Player): void {
    const m = this.m;
    const sp = m.setPiece;
    if (!sp) {
      p.wantSpeed = 0;
      return;
    }
    const team = m.teams[p.team];
    const dir = team.dir;
    if (sp.taker === p) {
      // Stand behind the ball facing into play (a run-up for shots from a dead ball).
      const f = m.setPieceFacing(sp);
      const spot = m.setPieceSpot(sp);
      const runUp = spot.runUp;
      if (runUp && p.plan) {
        // The run-up: a couple of short, accelerating steps, then a long last stride that
        // plants the standing foot beside the ball (on the far side from the kicking
        // foot, a touch behind it) so the swing comes through the ball.
        const right = { x: -f.z, z: f.x };
        const lat = 0.3 * p.foot;
        const px = sp.x - f.x * 0.32 - right.x * lat;
        const pz = sp.z - f.z * 0.32 - right.z * lat;
        const d = dist2D(p.pos.x, p.pos.z, px, pz);
        this.moveTo(p, px, pz, false, false);
        const full = sp.kind === 'penalty' ? 4.6 : 5.4;
        // Building speed over the run, easing only in the last metre to set the plant foot.
        const gone = dist2D(p.pos.x, p.pos.z, spot.x, spot.z);
        p.wantSpeed = Math.min(full, 1.8 + gone * 1.5, 2.6 + d * 3);
        p.lookTarget.set(sp.x, 0, sp.z);
        p.lookAt = d > 0.8 ? null : p.lookTarget;
        return;
      }
      // Run-ups are taken from a little to the side, like real takers.
      const sx = spot.x;
      const sz = spot.z;
      const d = dist2D(p.pos.x, p.pos.z, sx, sz);
      if (d > 0.3) {
        this.moveTo(p, sx, sz, d > 3, false);
        sp.t = Math.min(sp.t, 0.3); // the clock starts once the taker is there
        return;
      }
      p.moveX = 0;
      p.moveZ = 0;
      p.wantSpeed = 0;
      // Lined up: body square to the ball, eyes on it (a penalty taker looks at the keeper).
      p.facing = runUp ? Math.atan2(sp.z - p.pos.z, sp.x - p.pos.x) : Math.atan2(f.z, f.x);
      p.lookTarget.set(sp.x + f.x * 20, 0, sp.z + f.z * 20);
      p.lookAt = runUp ? null : p.lookTarget;
      if (sp.kind === 'throw' && m.heldBy !== p) m.catchBall(p);
      const human = p.team === m.humanTeam && !m.autoPlay;
      const wait = human ? (runUp || sp.kind === 'corner' ? 20 : 7) : runUp ? 2.6 : sp.kind === 'freekick' ? 1.8 : 1.3;
      if (sp.t > wait && !p.plan) this.planSetPiece(p);
      return;
    }

    // Everyone else gets into position.
    let x: number;
    let z: number;
    if (sp.kind === 'kickoff') {
      x = p.pos.x;
      z = p.pos.z;
      p.wantSpeed = 0;
      p.lookTarget.copy(m.ball.pos);
      p.lookAt = p.lookTarget;
      return;
    }
    // Penalty: everyone was placed outside the box; just stand and watch.
    if (sp.kind === 'penalty') {
      p.moveX = 0;
      p.moveZ = 0;
      p.wantSpeed = 0;
      p.lookTarget.copy(m.ball.pos);
      p.lookAt = p.lookTarget;
      return;
    }
    // The wall holds its line, eyes on the ball.
    const wi = sp.wall ? sp.wall.players.indexOf(p) : -1;
    if (wi >= 0) {
      const [wx, wz] = sp.wall!.slots[wi];
      this.moveTo(p, wx, wz, false, true);
      p.squareUp = true;
      return;
    }
    const spGoal = PITCH.halfL * m.teams[sp.team].dir; // goal being attacked by the restart
    const boxBall = sp.kind === 'corner' || (sp.kind === 'freekick' && !sp.direct && Math.abs(sp.x - spGoal) < 40);
    if (boxBall && p.role !== 'GK') {
      // Ball into the box: attackers take their runs, defenders pick them up.
      const attackers = p.team === sp.team;
      const sideDir = -Math.sign(spGoal); // into the pitch
      const order = [2, 3, 9, 6, 7, 10, 8, 5, 1, 4];
      const idx = order.indexOf(p.index);
      if (attackers && idx >= 0 && idx < 5) {
        const s = BOX_SPOTS[idx];
        x = spGoal + sideDir * Math.abs(s[0]);
        z = s[1];
      } else if (!attackers && idx >= 0 && idx < 7) {
        const s = BOX_SPOTS[idx % BOX_SPOTS.length];
        x = spGoal + sideDir * (Math.abs(s[0]) - 0.8);
        z = s[1] * 0.9;
      } else {
        this.slot(p, this.tmp);
        x = this.tmp.x;
        z = this.tmp.z;
      }
    } else if (sp.direct && p.role !== 'GK') {
      // Shot on: a dummy runner beside the ball, two lurking for rebounds, defenders on the edge of the box.
      const sideDir = -Math.sign(spGoal);
      if (p.team === sp.team && p.index === 8) {
        x = sp.x - m.teams[sp.team].dir * 1.2;
        z = sp.z + (sp.z > 0 ? -1.4 : 1.4);
      } else if (p.team === sp.team && (p.index === 9 || p.index === 10)) {
        x = spGoal + sideDir * 13;
        z = (p.index === 9 ? -1 : 1) * 5;
      } else if (p.team !== sp.team && (p.role === 'DEF' || p.index === 5)) {
        x = spGoal + sideDir * 11.5;
        z = ((p.index % 4) - 1.5) * 4;
      } else {
        this.slot(p, this.tmp);
        x = this.tmp.x;
        z = this.tmp.z;
      }
    } else if (p.role === 'GK') {
      x = -dir * (PITCH.halfL - 1);
      z = 0;
      if (sp.kind === 'goalkick' && sp.team === p.team) {
        x = sp.x;
        z = sp.z;
      } else if (sp.direct && sp.team !== p.team) {
        // Free kick: the wall has the near post; the keeper covers the far side.
        x = -dir * (PITCH.halfL - 0.6);
        z = -(Math.sign(sp.z) || 1) * PITCH.goalHalfWidth * 0.3;
      }
    } else {
      this.slot(p, this.tmp);
      x = this.tmp.x;
      z = this.tmp.z;
    }
    // Opponents keep their distance.
    if (p.team !== sp.team) {
      const minD = sp.kind === 'throw' ? 3 : 9.3;
      const dx = x - sp.x;
      const dz = z - sp.z;
      const d = Math.hypot(dx, dz);
      if (d < minD) {
        const k = minD / Math.max(0.1, d);
        x = sp.x + dx * k;
        z = sp.z + dz * k;
      }
    }
    this.moveTo(p, x, z, false, true);
  }

  private planSetPiece(p: Player): void {
    const m = this.m;
    const sp = m.setPiece!;
    const team = m.teams[p.team];
    let target: Player | null = null;
    let type: 'pass' | 'lob' | 'cross' = 'pass';
    const goalX = PITCH.halfL * team.dir;
    if (sp.kind === 'penalty' || (sp.direct && m.rng.next() < 0.55 + p.attrs.shooting * 0.35)) {
      // Pick a side and a height; now and then straight down the middle.
      const r = m.rng.next();
      const side = sp.kind === 'penalty' && r < 0.08 ? 0 : m.rng.next() < 0.5 ? -1 : 1;
      const power = sp.kind === 'penalty' ? 0.35 + m.rng.next() * 0.6 : 0.6 + m.rng.next() * 0.35;
      // dirZ only carries the side (|dirZ| > 0.3 picks a post).
      const ax = Math.sign(goalX - p.pos.x) * 0.45;
      const az = side * 0.9;
      const n = Math.hypot(ax, az);
      p.plan = { type: 'shot', dirX: ax / n, dirZ: az / n, power, targetId: -1, expires: m.time + 3, aimed: true };
      return;
    }
    if (sp.kind === 'kickoff') {
      target = team.players[7];
    } else if (sp.kind === 'freekick') {
      // Into the box when it's close enough to deliver, otherwise keep the ball.
      if (Math.abs(sp.x - goalX) < 40) {
        type = 'cross';
        const cands = team.players.filter((q) => q.index === 2 || q.index === 3 || q.index === 9 || q.index === 10);
        target = cands[Math.floor(m.rng.next() * cands.length)];
      } else {
        target = this.bestReceiver(p, false);
      }
    } else if (sp.kind === 'corner') {
      type = 'cross';
      const cands = team.players.filter((q) => q.index === 2 || q.index === 3 || q.index === 9);
      target = cands[Math.floor(m.rng.next() * cands.length)];
    } else if (sp.kind === 'goalkick') {
      const short = m.rng.next() < 0.4;
      const opts = team.players.filter((q) => (short ? q.role === 'DEF' : q.role === 'MID' || q.role === 'FWD'));
      target = opts[Math.floor(m.rng.next() * opts.length)];
      type = short ? 'pass' : 'lob';
    } else {
      // Throw: nearest teammate with some space.
      let bd = 1e9;
      for (const q of team.players) {
        if (q === p || q.role === 'GK') continue;
        const d = m.ballDist(q);
        if (d < bd && d > 3) {
          bd = d;
          target = q;
        }
      }
      type = 'lob';
    }
    if (!target) return;
    const dx = target.pos.x - p.pos.x;
    const dz = target.pos.z - p.pos.z;
    const d = Math.max(0.1, Math.hypot(dx, dz));
    p.plan = { type, dirX: dx / d, dirZ: dz / d, power: 0, targetId: target.id, expires: m.time + 2 };
  }

  // ------------------------------------------------------------------ celebrations

  private celebrate(p: Player): void {
    const m = this.m;
    const s = m.scorer;
    if (!s) {
      p.wantSpeed = 0;
      return;
    }
    // After the cut: jog back into the kick-off shape.
    if (m.phaseT > GOAL_SEQ.cut) {
      m.kickoffSpot(p, 1 - s.team, this.tmp);
      this.moveTo(p, this.tmp.x, this.tmp.z, false, true);
      p.wantSpeed = Math.min(p.wantSpeed, PLAYER.jogSpeed * 0.8);
      return;
    }
    // The celebration is shot from in front of the scorer, between him and the centre spot:
    // he pulls up and turns to it, and his team-mates pile in from behind and the sides.
    const front = m.phaseT > GOAL_SEQ.front;
    const d = Math.hypot(s.pos.x, s.pos.z) || 1;
    const fx = -s.pos.x / d;
    const fz = -s.pos.z / d;
    const cel = m.celebration;
    if (p === s && cel && m.phaseT >= cel.at) {
      this.celebrationMove(p, m.phaseT - cel.at);
      return;
    }
    // Team-mates give a flip or a leap room before they pile in.
    const room = cel && (cel.kind === 'flip' || cel.kind === 'siu') && m.phaseT < cel.at + 2.2 ? 1.6 : 0;
    if (p === s) {
      if (front) {
        p.moveX = p.moveZ = 0;
        p.wantSpeed = 0;
        p.sprinting = false;
        p.lookTarget.set(0, 0, 0);
        p.lookAt = p.lookTarget;
        return;
      }
      const cx = Math.sign(p.pos.x || 1) * (PITCH.halfL - 6);
      const cz = Math.sign(p.pos.z || 1) * (PITCH.halfW - 2);
      this.moveTo(p, cx, cz, m.phaseT < 2.2, false);
      p.sprinting = true;
    } else if (p.team === s.team && p.role !== 'GK') {
      // Chase him down, then fan out behind him: alternate sides, staggered.
      const k = (p.index % 2 ? 1 : -1) * (1.3 + (p.index % 4) * 0.45);
      const ahead = front ? -1.1 - (p.index % 3) * 0.5 - room : 1.5 + room;
      this.moveTo(p, s.pos.x + fx * ahead - fz * k, s.pos.z + fz * ahead + fx * k, front, false);
      if (front && Math.hypot(p.pos.x - s.pos.x, p.pos.z - s.pos.z) < 3.5) {
        p.lookTarget.copy(s.pos);
        p.lookAt = p.lookTarget;
      }
    } else {
      p.wantSpeed = Math.max(0, p.wantSpeed - DT * 4);
    }
  }

  /**
   * The scorer's chosen celebration, `u` seconds in. The sim moves him; the renderer poses him
   * from the same clock (players.ts). All of them end facing the camera, which stands between
   * him and the centre spot.
   */
  private celebrationMove(p: Player, u: number): void {
    const cel = this.m.celebration!;
    const toCam = Math.atan2(cel.dz, cel.dx);
    const face = (a: number) => {
      p.lookTarget.set(p.pos.x + Math.cos(a) * 30, 0, p.pos.z + Math.sin(a) * 30);
      p.lookAt = p.lookTarget;
      p.squareUp = true;
    };
    const run = (a: number, speed: number) => {
      p.moveX = Math.cos(a);
      p.moveZ = Math.sin(a);
      p.wantSpeed = speed;
    };
    p.sprinting = false;
    p.lookAt = null;
    p.squareUp = false;
    switch (cel.kind) {
      case 'slide':
        // Charge at the camera, drop onto both knees and skid toward it.
        p.sprinting = u < 0.75;
        run(toCam, u < 0.75 ? 7.8 : Math.max(0, 7.4 - 4.6 * (u - 0.75)));
        if (u > 0.5) face(toCam);
        break;
      case 'plane': {
        // Arms out, banking round a wide loop; it comes out of the turn gliding at the camera.
        const w = 1.3;
        const left = 3.0 - Math.min(u, 3.0);
        run(toCam - cel.turn * w * left, u < 3.0 ? 6 : Math.max(0, 6 - 7 * (u - 3.0)));
        if (u > 3.0) face(toCam);
        break;
      }
      case 'siu':
        // Away from the camera a few strides, a leap with a half turn in the air, and the
        // landing, feet planted wide, facing it.
        if (u < 0.45) run(toCam + Math.PI, 4.5);
        else {
          run(toCam, 0);
          if (Math.abs(angleDiff(p.facing, toCam)) > 0.3) p.facing = p.prevFacing = toCam;
          face(toCam);
        }
        break;
      case 'flip':
        // Pull up, turn to the camera, a standing backflip.
        run(toCam, 0);
        face(toCam);
        break;
    }
  }

  // ------------------------------------------------------------------ goalkeepers

  private keeperThink(k: Player): void {
    const m = this.m;
    // A keeper sets himself square to the ball and shuffles across.
    k.squareUp = true;
    const team = m.teams[k.team];
    const own = -team.dir;
    const gx = own * PITCH.halfL;
    const b = m.ball.pos;

    if (m.heldBy === k) {
      k.wantSpeed = 0;
      k.facing += angleDiff(k.facing, team.dir > 0 ? 0 : Math.PI) * 0.1;
      const human = k.team === m.humanTeam;
      if (!k.plan && m.time - m.lastKickTime > (human ? 5 : 1.4) && m.time > this.nextDecision[k.id]) {
        this.nextDecision[k.id] = m.time + 0.5;
        // Throw to an open defender or punt long.
        let best: Player | null = null;
        let bs = -1e9;
        for (const q of team.players) {
          if (q === k) continue;
          const d = m.ballDist(q);
          if (d > 32) continue;
          let open = 99;
          for (const o of m.teams[1 - k.team].players) open = Math.min(open, dist2D(o.pos.x, o.pos.z, q.pos.x, q.pos.z));
          const s = open - d * 0.1;
          if (s > bs) {
            bs = s;
            best = q;
          }
        }
        if (best && bs > 6) {
          const dx = best.pos.x - k.pos.x;
          const dz = best.pos.z - k.pos.z;
          const d = Math.hypot(dx, dz);
          k.plan = { type: 'pass', dirX: dx / d, dirZ: dz / d, power: 0, targetId: best.id, expires: m.time + 1.5 };
        } else {
          const fwd = team.players[9];
          k.plan = { type: 'lob', dirX: team.dir, dirZ: 0, power: 0, targetId: fwd.id, expires: m.time + 1.5 };
        }
      }
      return;
    }

    // A team-mate's pass to him: meet it and play it with his feet, like an outfielder.
    if (m.passTarget === k && m.lastKicker && m.lastKicker.team === k.team && !m.owner) {
      const ip = this.intercept[k.id];
      this.moveTo(k, ip.x, ip.z, m.ballDist(k) > 6, true);
      return;
    }

    // Shot coming?
    const threat = this.shotThreat(k);
    if (threat) return;

    // Loose ball we can claim first?
    if (this.chaser[k.team] === k && !m.owner && m.ball.vel.lenXZ() < 20) {
      const ip = this.intercept[k.id];
      if (this.inOwnBox(k, ip.x, ip.z)) {
        this.moveTo(k, ip.x, ip.z, true, true);
        return;
      }
    }
    // Angle play: stand on the line between ball and goal centre.
    const dx = b.x - gx;
    const dz = b.z;
    const d = Math.max(0.1, Math.hypot(dx, dz));
    const out = clamp(d * 0.09, 0.6, 5.5);
    let tx = gx + (dx / d) * out;
    let tz = (dz / d) * out;
    tz = clamp(tz, -PITCH.goalHalfWidth - 0.6, PITCH.goalHalfWidth + 0.6);
    if ((tx - gx) * own > 0) tx = gx - own * 0.6;
    this.moveTo(k, tx, tz, false, true);
    k.wantSpeed = Math.min(k.wantSpeed, 5.5);
  }

  /** Detects shots on goal and commits to a save. Returns true if handling a threat. */
  private shotThreat(k: Player): boolean {
    const m = this.m;
    const team = m.teams[k.team];
    const own = -team.dir;
    const b = m.ball;
    if (k.action === 'dive') return true;
    // A back-pass to him is not a shot.
    if (m.passTarget === k) return false;
    const toward = b.vel.x * own;
    if (toward < 6 || m.owner || m.heldBy) return false;
    // Where does the ball cross the keeper's depth?
    const kx = k.pos.x;
    let cy = 0;
    let cz = 0;
    let ct = -1;
    for (let i = 1; i < this.sampleCount; i++) {
      const a = (this.sx[i - 1] - kx) * own;
      const c = (this.sx[i] - kx) * own;
      if (a < 0 && c >= 0) {
        const f = -a / (c - a);
        cy = this.sy[i - 1] + (this.sy[i] - this.sy[i - 1]) * f;
        cz = this.sz[i - 1] + (this.sz[i] - this.sz[i - 1]) * f;
        ct = (i - 1 + f) * SAMPLE_DT - (m.time - (this.nextIntercept - 0.1));
        break;
      }
    }
    if (ct < 0) return false;
    if (Math.abs(cz) > PITCH.goalHalfWidth + 1.2 || cy > PITCH.goalHeight + 0.6) return false;
    // Reaction time after the strike.
    const react = 0.16 + (1 - k.attrs.keeping) * 0.12;
    if (m.time - m.lastKickTime < react) {
      k.wantSpeed = 0;
      return true;
    }
    const dz = cz - k.pos.z;
    if (Math.abs(dz) < 0.7 && cy < 1.9) {
      // Body line: step across.
      this.moveTo(k, k.pos.x, cz, true, true);
      return true;
    }
    const dh = clamp(cy, 0.15, 2.4);
    // How far the body can reach to the side at this height (if he dived now).
    const reachNow = planDive(Math.abs(dz), dh, k.look.height).reach;
    // Don't commit early: shuffle across the line first, dive only in the last moment so
    // the full stretch arrives together with the ball.
    if (ct > 0.42 && !k.isBusy()) {
      this.moveTo(k, k.pos.x, cz - Math.sign(dz) * Math.min(Math.abs(dz), reachNow * 0.6), true, true);
      return true;
    }
    if (!k.isBusy() && m.time > this.keeperDiveT[k.team] + 0.8) this.commitDive(k, dz, dh, Math.max(0.2, ct));
    return true;
  }

  /** Throw the body at a point `dz` along the line, `dh` high, arriving in `tt` seconds. */
  private commitDive(k: Player, dz: number, dh: number, tt: number): void {
    const own = -this.m.teams[k.team].dir;
    this.keeperDiveT[k.team] = this.m.time;
    const s = Math.sign(dz) || 1;
    const reachNow = planDive(Math.abs(dz), dh, k.look.height).reach;
    // Lateral push so the body line reaches the ball, then aim the body line at it.
    const push = clamp((Math.abs(dz) - reachNow) / tt, 0, 6 + k.attrs.keeping * 2);
    const aAtContact = Math.max(0, Math.abs(dz) - push * tt);
    const plan = planDive(aAtContact, dh, k.look.height);
    k.startAction('dive', 1.5, 0, s);
    k.vel.set(-own * 0.6, 0, s * push);
    this.diveHeight[k.id] = dh;
    this.diveRoll[k.id] = plan.roll;
    this.diveLift[k.id] = plan.lift;
  }

  /**
   * Penalty: there's no time to react, so the keeper picks a side as the kick is struck.
   * A good keeper reads the taker more often; sometimes he stays big in the middle.
   */
  penaltyGuess(k: Player, tz: number, ty: number): void {
    const m = this.m;
    const r = m.rng.next();
    const read = 0.34 + k.attrs.keeping * 0.22;
    if (r < 0.14) return; // stays: reacts to whatever comes at him
    const side = r < 0.14 + read && Math.abs(tz) > 0.5 ? Math.sign(tz) : m.rng.next() < 0.5 ? -1 : 1;
    const dz = side * (1.6 + m.rng.next() * 1.6) - k.pos.z;
    const dh = clamp(r < 0.14 + read ? ty : 0.4 + m.rng.next() * 1.4, 0.2, 2.2);
    this.commitDive(k, dz, dh, 0.42);
  }

  /**
   * Is the ball (centre at x, y, z) touching the keeper, and where? `edge` 0..1 is how close
   * to the limit of his reach it is (saves get harder toward the fingertips).
   * - Diving: a capsule along the body from the hips to the outstretched hands.
   * - Set: a real body (torso, head, two legs with the gap between them) and two arms that
   *   can reach a ball within arm's length of either shoulder in front of him, plus the low
   *   scoop for a ball right at his feet. Not a box: what he can't reach, he doesn't catch.
   */
  private keeperHit(k: Player, diving: boolean, x: number, y: number, z: number): { region: 'hands' | 'body'; edge: number } | null {
    const h = k.look.height;
    const R = 0.11; // ball
    if (diving) {
      const pose = divePose(k, this.diveRoll[k.id], this.diveLift[k.id], this.pose);
      const s = k.actionDirZ;
      const sr = Math.sin(pose.roll);
      const cr = Math.cos(pose.roll);
      const l0 = DIVE_HIPS * h;
      const l1 = DIVE_HANDS * h;
      const ay = pose.lift + l0 * cr;
      const az = k.pos.z + s * l0 * sr;
      const ly = (l1 - l0) * cr;
      const lz = s * (l1 - l0) * sr;
      const len2 = ly * ly + lz * lz;
      const t = clamp(((y - ay) * ly + (z - az) * lz) / len2, 0, 1);
      const d = Math.hypot(x - k.pos.x, y - (ay + ly * t), z - (az + lz * t));
      return d < DIVE_RADIUS + R ? { region: t > 0.55 ? 'hands' : 'body', edge: t } : null;
    }
    // Keeper frame: depth toward the pitch, lateral to his left.
    const dx = x - k.pos.x;
    const dz = z - k.pos.z;
    const fx = Math.cos(k.facing);
    const fz = Math.sin(k.facing);
    const depth = dx * fx + dz * fz;
    const lat = -dx * fz + dz * fx;
    // Body: torso, head, legs (each leg a capsule from the boot to the hip; the gap between).
    const capsule = (la: number, ya: number, lb: number, yb: number, r: number) => {
      const vl = lb - la;
      const vy = yb - ya;
      const t = clamp(((lat - la) * vl + (y - ya) * vy) / (vl * vl + vy * vy), 0, 1);
      return Math.hypot(depth, lat - (la + vl * t), y - (ya + vy * t)) < r + R;
    };
    if (
      capsule(0, 0.98 * h, 0, 1.52 * h, 0.19) || // torso
      Math.hypot(depth, lat, y - 1.72 * h) < 0.12 + R || // head
      capsule(0.2, 0.06, 0.1, 0.9 * h, 0.085) || // left leg
      capsule(-0.2, 0.06, -0.1, 0.9 * h, 0.085) // right leg
    ) {
      return { region: 'body', edge: 0 };
    }
    // Hands: arm's length from either shoulder, in front of the body line.
    if (depth > -0.22) {
      const reach = 0.7 * h;
      const sy = 1.45 * h;
      const dl = Math.hypot(depth, lat - 0.2, y - sy);
      const dr = Math.hypot(depth, lat + 0.2, y - sy);
      const d = Math.min(dl, dr);
      if (d < reach + R) return { region: 'hands', edge: d / (reach + R) };
      // Low ball at his feet: he gets down and scoops it.
      if (y < 0.55 && Math.abs(lat) < 0.45 && depth < 0.6) return { region: 'hands', edge: Math.abs(lat) / 0.45 };
    }
    return null;
  }

  /** Hand contact for keepers. Returns true if the keeper dealt with the ball this step. */
  keeperContact(k: Player): boolean {
    const m = this.m;
    const b = m.ball;
    if (k.touchCooldown > 0 || m.heldBy) return false;
    if (k.action === 'stumble' || k.action === 'fall' || k.action === 'kick' || k.action === 'throw') return false;
    if (!this.inOwnBox(k, b.pos.x, b.pos.z)) return false;
    if (m.owner && m.owner.team === k.team && m.owner !== k) return false;
    // Ball at his feet: he's playing it as an outfielder (no picking it up mid-dribble).
    if (m.owner === k) return false;
    if (m.lastTouch === k && m.time - m.lastKickTime < 0.6) return false;
    // Back-pass rule: no hands from a teammate's deliberate kick.
    if (m.lastKicker && m.lastKicker.team === k.team && m.lastKicker !== k && m.lastTouch === m.lastKicker) return false;
    // Only a ball in front of the goal line can be handled.
    const own = -m.teams[k.team].dir;
    if (b.pos.x * own > PITCH.halfL) return false;

    // Check along the ball's path through this step, not just where it ended up: a hard
    // shot moves ~25 cm per step and would otherwise slip through the edge of a hand.
    const diving = k.action === 'dive';
    let region: 'hands' | 'body' | null = null;
    let edge = 0;
    const p0 = b.prevPos;
    for (let i = 1; i <= 4 && !region; i++) {
      const f = i / 4;
      const hit = this.keeperHit(k, diving, p0.x + (b.pos.x - p0.x) * f, p0.y + (b.pos.y - p0.y) * f, p0.z + (b.pos.z - p0.z) * f);
      if (hit) {
        region = hit.region;
        edge = hit.edge;
        if (i < 4) b.pos.set(p0.x + (b.pos.x - p0.x) * f, p0.y + (b.pos.y - p0.y) * f, p0.z + (b.pos.z - p0.z) * f);
      }
    }
    if (!region) return false;

    const speed = b.vel.len();
    k.touchCooldown = 0.4;
    if (speed < 7 && !diving) {
      m.catchBall(k);
      m.events.save = 0.3;
      return true;
    }
    const saveP = 0.55 + k.attrs.keeping * 0.4 - clamp((speed - 18) / 16, 0, 1) * 0.3 - (edge > 0.85 ? 0.25 : 0) + (region === 'body' ? 0.25 : 0);
    const team = m.teams[k.team];
    const out = team.dir; // away from his goal
    if (m.rng.next() < saveP) {
      if (speed < 17 && (!diving || m.rng.next() < 0.35)) {
        m.catchBall(k);
      } else if (diving) {
        // Tipped wide: the ball keeps going toward the dive side, pushed away from goal.
        const s = k.actionDirZ;
        b.vel.set(out * speed * (0.1 + m.rng.next() * 0.2), 0.8 + m.rng.next() * 2.5, s * (2 + m.rng.next() * 4) + b.vel.z * 0.3);
      } else {
        // Beaten away in front of him.
        b.vel.set(out * speed * (0.25 + m.rng.next() * 0.2), 1 + m.rng.next() * 2.5, b.vel.z * 0.3 + (m.rng.next() - 0.5) * 5);
      }
      if (m.heldBy !== k) {
        b.spin.set(0, 0, 0);
        b.onGround = false;
        m.owner = null;
        m.lastTouch = k;
        m.lastKicker = k;
        m.lastKickTime = m.time;
        m.passTarget = null;
      }
      m.events.save = clamp(speed / 30, 0.3, 1);
      return true;
    }
    if (region === 'body') {
      // Not held, but it still hits him: a real rebound off the body.
      const vx = b.vel.x;
      b.vel.x = -vx * 0.35;
      b.vel.z *= 0.6;
      b.vel.y = Math.abs(b.vel.y) * 0.3 + 0.5;
      b.onGround = false;
      b.pos.x = k.pos.x + Math.sign(vx || out) * -0.48;
      m.lastTouch = k;
      m.events.save = 0.3;
      return true;
    }
    // Fingertips: a slight touch that doesn't stop it (the body can still be hit after).
    k.touchCooldown = 0.08;
    b.vel.z += (m.rng.next() - 0.5) * 1.5;
    b.vel.y += m.rng.next() * 0.6;
    b.vel.scale(0.95);
    m.lastTouch = k;
    return true;
  }
}
