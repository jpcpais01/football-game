import { DT, PITCH, PLAYER } from './constants';
import { predictBallAt } from './kick';
import type { Match } from './match';
import type { Player } from './player';
import { V3, angleDiff, clamp, dist2D } from './vec';

interface Intercept {
  t: number; // -1 = can't reach in the horizon
  x: number;
  z: number;
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
  private dribX: number[] = [];
  private dribZ: number[] = [];
  private dribSprint: boolean[] = [];
  /** Offside line per attacking team, in that team's frame. */
  private offside: number[] = [PITCH.halfL, PITCH.halfL];
  private keeperDiveT = [-10, -10];
  diveHeight: number[] = [];
  private lastOwner: Player | null = null;
  private possStart = 0;
  private patience = 0.6;
  private tmp = new V3();

  constructor(private m: Match) {
    for (let i = 0; i < 22; i++) {
      this.intercept.push({ t: -1, x: 0, z: 0 });
      this.nextDecision.push(0);
      this.tackleReady.push(0);
      this.run.push({ x: 0, z: 0, until: -1 });
      this.dribX.push(1);
      this.dribZ.push(0);
      this.dribSprint.push(false);
      this.diveHeight.push(0.5);
    }
  }

  setRun(p: Player, x: number, z: number): void {
    const r = this.run[p.id];
    r.x = clamp(x, -PITCH.halfL + 1, PITCH.halfL - 1);
    r.z = clamp(z, -PITCH.halfW + 1, PITCH.halfW - 1);
    r.until = this.m.time + 3;
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

    for (const p of m.players) {
      const ip = this.intercept[p.id];
      ip.t = -1;
      const top = p.topSpeed * 0.92;
      for (let i = 0; i < n; i++) {
        const t = i * SAMPLE_DT;
        const y = this.sy[i];
        const maxH = p.role === 'GK' && this.inOwnBox(p, this.sx[i], this.sz[i]) ? 2.5 : PLAYER.headMax;
        if (y > maxH) continue;
        const d = dist2D(p.pos.x, p.pos.z, this.sx[i], this.sz[i]) - PLAYER.reach * 0.8;
        if (d <= Math.max(0, t - 0.2) * top) {
          ip.t = t;
          ip.x = this.sx[i];
          ip.z = this.sz[i];
          break;
        }
      }
      if (ip.t < 0) {
        ip.x = this.sx[n - 1];
        ip.z = this.sz[n - 1];
      }
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
    if (m.controlled.role === 'GK' && m.heldBy !== m.controlled && m.phase === 'play' && !(m.setPiece && m.setPiece.taker === m.controlled)) {
      const ch = this.chaser[m.humanTeam];
      if (ch && ch.role !== 'GK') m.setControlled(ch);
    }
    // Auto-switch on defence when the controlled player is out of the play.
    const att = m.attackingTeam();
    if (m.phase === 'play' && att !== m.humanTeam) {
      const ch = this.chaser[m.humanTeam];
      const c = m.controlled;
      if (ch && ch !== c && ch.role !== 'GK') {
        const ci = this.intercept[c.id];
        const hi = this.intercept[ch.id];
        const ct = ci.t >= 0 ? ci.t : 9;
        const ht = hi.t >= 0 ? hi.t : 9;
        if (ct > ht + 0.9 && m.switchT > 0.8 && m.ballDist(c) > 7) m.setControlled(ch);
      }
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
    p.sprinting = false;
    switch (m.phase) {
      case 'goal':
        return this.celebrate(p);
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
      const ip = this.intercept[p.id];
      this.moveTo(p, ip.x, ip.z, true, true);
      p.lookTarget.copy(m.ball.pos);
      p.lookAt = p.lookTarget;
      return;
    }
    if (att === p.team) {
      if (run.until > m.time) {
        this.moveTo(p, run.x, run.z, true, false);
        return;
      }
      this.slot(p, this.tmp);
      this.moveTo(p, this.tmp.x, this.tmp.z, false, false);
      return;
    }
    // Defending or loose ball.
    if (this.chaser[p.team] === p) {
      if (m.owner && m.owner.team !== p.team) return this.press(p, m.owner);
      const ip = this.intercept[p.id];
      this.moveTo(p, ip.x, ip.z, true, true);
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
    this.slot(p, this.tmp);
    this.moveTo(p, this.tmp.x, this.tmp.z, false, false);
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
  containTarget(p: Player, out: V3): V3 {
    const m = this.m;
    const b = m.ball.pos;
    const gx = -m.teams[p.team].dir * PITCH.halfL;
    const dx = gx - b.x;
    const dz = -b.z * 0.5;
    const d = Math.max(0.1, Math.hypot(dx, dz));
    const keep = 1.3;
    return out.set(b.x + (dx / d) * keep, 0, b.z + (dz / d) * keep);
  }

  private press(p: Player, carrier: Player): void {
    const m = this.m;
    this.containTarget(p, this.tmp);
    const d = m.ballDist(p);
    this.moveTo(p, this.tmp.x, this.tmp.z, d > 4, true);
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
      // Stand just behind the ball, facing into play.
      let fx = dir;
      let fz = 0;
      if (sp.kind === 'throw') {
        fx = 0;
        fz = -Math.sign(sp.z);
      } else if (sp.kind === 'corner') {
        fx = -Math.sign(sp.x) * 0.6;
        fz = -Math.sign(sp.z);
      }
      const n = Math.hypot(fx, fz);
      fx /= n;
      fz /= n;
      const back = sp.kind === 'throw' ? 0.05 : 0.45;
      const sx = sp.x - fx * back;
      const sz = sp.z - fz * back;
      const d = dist2D(p.pos.x, p.pos.z, sx, sz);
      if (d > 0.3) {
        this.moveTo(p, sx, sz, d > 3, false);
        sp.t = Math.min(sp.t, 0.3); // the clock starts once the taker is there
        return;
      }
      p.moveX = 0;
      p.moveZ = 0;
      p.wantSpeed = 0;
      p.facing = Math.atan2(fz, fx);
      p.lookTarget.set(p.pos.x + fx, 0, p.pos.z + fz);
      p.lookAt = p.lookTarget;
      if (sp.kind === 'throw' && m.heldBy !== p) m.catchBall(p);
      const human = p.team === m.humanTeam;
      const wait = human ? 7 : 1.3;
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
    if (sp.kind === 'corner' && p.role !== 'GK') {
      const attackers = p.team === sp.team;
      const goal = Math.sign(sp.x) * PITCH.halfL;
      const sideDir = -Math.sign(sp.x); // into the pitch
      const order = [2, 3, 9, 6, 7, 10, 8, 5, 1, 4];
      const idx = order.indexOf(p.index);
      if (attackers && idx >= 0 && idx < 5) {
        const s = BOX_SPOTS[idx];
        x = goal + sideDir * Math.abs(s[0]);
        z = s[1];
      } else if (!attackers && idx >= 0 && idx < 7) {
        const s = BOX_SPOTS[idx % BOX_SPOTS.length];
        x = goal + sideDir * (Math.abs(s[0]) - 0.8);
        z = s[1] * 0.9;
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
    if (sp.kind === 'kickoff') {
      target = team.players[7];
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
    if (p === s) {
      const cx = Math.sign(p.pos.x || 1) * (PITCH.halfL - 6);
      const cz = Math.sign(p.pos.z || 1) * (PITCH.halfW - 2);
      this.moveTo(p, cx, cz, m.phaseT < 2.2, false);
      p.sprinting = true;
    } else if (p.team === s.team && p.role !== 'GK') {
      this.moveTo(p, s.pos.x - Math.sign(s.pos.x) * 1.5, s.pos.z + ((p.index % 3) - 1) * 1.2, false, false);
    } else {
      p.wantSpeed = Math.max(0, p.wantSpeed - DT * 4);
    }
  }

  // ------------------------------------------------------------------ goalkeepers

  private keeperThink(k: Player): void {
    const m = this.m;
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
    if (!k.isBusy() && m.time > this.keeperDiveT[k.team] + 0.8) {
      this.keeperDiveT[k.team] = m.time;
      const s = Math.sign(dz);
      k.startAction('dive', 1.25, 0, s);
      const need = Math.abs(dz) - 0.4;
      const tt = Math.max(0.18, ct);
      const lat = clamp(need / tt, 2, 6.5 + k.attrs.keeping * 1.5);
      k.vel.set(-own * 0.6, 0, s * lat);
      this.diveHeight[k.id] = clamp(cy, 0.2, 2.3);
    }
    return true;
  }

  /** Hand contact for keepers. Returns true if the keeper dealt with the ball this step. */
  keeperContact(k: Player): boolean {
    const m = this.m;
    const b = m.ball;
    if (k.touchCooldown > 0 || m.heldBy) return false;
    if (!this.inOwnBox(k, b.pos.x, b.pos.z)) return false;
    if (m.owner && m.owner.team === k.team && m.owner !== k) return false;
    if (m.lastTouch === k && m.time - m.lastKickTime < 0.6) return false;
    // Back-pass rule: no hands from a teammate's deliberate kick.
    if (m.lastKicker && m.lastKicker.team === k.team && m.lastKicker !== k && m.lastTouch === m.lastKicker) return false;
    const diving = k.action === 'dive';
    let hit = false;
    let edge = 0;
    if (diving) {
      // Capsule from hips toward the hands along the dive.
      const s = k.actionDirZ;
      const p = clamp(k.actionT / 0.35, 0, 1);
      const hipY = 0.35 + (this.diveHeight[k.id] - 0.35) * 0.5 * p;
      const handY = this.diveHeight[k.id] * p + 1.2 * (1 - p);
      const ax = k.pos.x;
      const az = k.pos.z;
      const bx = k.pos.x;
      const bz = k.pos.z + s * (0.5 + 1.25 * p);
      const lx = bx - ax;
      const ly = handY - hipY;
      const lz = bz - az;
      const len2 = lx * lx + ly * ly + lz * lz;
      const t = clamp(((b.pos.x - ax) * lx + (b.pos.y - hipY) * ly + (b.pos.z - az) * lz) / len2, 0, 1);
      const cx = ax + lx * t;
      const cy = hipY + ly * t;
      const cz = az + lz * t;
      const d = Math.hypot(b.pos.x - cx, b.pos.y - cy, b.pos.z - cz);
      hit = d < 0.42;
      edge = t;
    } else {
      const d = dist2D(k.pos.x, k.pos.z, b.pos.x, b.pos.z);
      hit = d < 0.7 && b.pos.y < 2.35;
      edge = d / 0.7;
    }
    if (!hit) return false;
    const speed = b.vel.len();
    k.touchCooldown = 0.5;
    if (speed < 7 && !diving) {
      m.catchBall(k);
      m.events.save = 0.3;
      return true;
    }
    const saveP = 0.5 + k.attrs.keeping * 0.45 - clamp((speed - 18) / 16, 0, 1) * 0.3 - (edge > 0.8 ? 0.25 : 0);
    if (m.rng.next() < saveP) {
      const team = m.teams[k.team];
      if (speed < 17 && (!diving || m.rng.next() < 0.35)) {
        m.catchBall(k);
      } else {
        // Parry away from goal.
        const out = team.dir;
        b.vel.set(out * speed * (0.15 + m.rng.next() * 0.2), 1.5 + m.rng.next() * 3, b.vel.z * 0.3 + (m.rng.next() - 0.5) * speed * 0.5);
        b.spin.set(0, 0, 0);
        b.onGround = false;
        m.owner = null;
        m.lastTouch = k;
        m.lastKicker = k;
        m.passTarget = null;
      }
      m.events.save = clamp(speed / 30, 0.3, 1);
      return true;
    }
    // Fingertips: slight deflection.
    b.vel.z += (m.rng.next() - 0.5) * 2;
    b.vel.scale(0.92);
    m.lastTouch = k;
    return true;
  }
}
