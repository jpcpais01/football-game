import { PLAYER } from './constants';
import { V3, angleDiff, clamp, smoothstep } from './vec';

export type Role = 'GK' | 'DEF' | 'MID' | 'FWD';

export interface Attributes {
  pace: number; // 0..1: top speed
  accel: number; // first steps
  agility: number; // turning / cutting grip
  stamina: number; // sprint endurance
  strength: number; // duels, shielding
  jumping: number; // aerial reach
  power: number; // kick power
  control: number;
  passing: number;
  shooting: number;
  defending: number;
  keeping: number;
  /** Body: metres. */
  height: number;
  /** Body: kilograms. */
  weight: number;
}

/** How hard the grass brakes a slide (m/s²): from a sprint, about 4 m on the floor. */
export const SLIDE_DECEL = 8.5;

export type ActionKind = 'none' | 'kick' | 'tackle' | 'slide' | 'dive' | 'stumble' | 'fall' | 'header' | 'throw' | 'catch' | 'celebrate' | 'stretch';

export interface KickPlan {
  type: 'pass' | 'lob' | 'through' | 'shot' | 'clear' | 'cross';
  /** For human kicks, aim direction in world XZ (unit). */
  dirX: number;
  dirZ: number;
  /** False when the stick was idle: the game picks the best option instead of a direction. */
  aimed?: boolean;
  power: number; // 0..1: shot power, or pass weight
  /** Lofted (chipped / clipped) instead of along the ground. */
  lofted?: boolean;
  /** Dead-ball shots aimed on the goal mouth: across (world z) and height (m). */
  aimZ?: number;
  aimY?: number;
  /** Corner delivery aimed at a landing spot on the pitch; floated (high) or whipped. */
  landX?: number;
  landZ?: number;
  float?: boolean;
  targetId: number; // receiver, -1 for none
  expires: number; // sim time
}

/** Smoothing factors for the last dt (always DT in a match). */
let expDt = -1;
let exp8 = 0;
let exp10 = 0;

export class Player {
  readonly pos = new V3();
  readonly vel = new V3();
  readonly prevPos = new V3();
  facing = 0; // yaw; 0 = +x
  prevFacing = 0;

  // ---- intent, written by AI / human each tick
  moveX = 0;
  moveZ = 0;
  wantSpeed = 0;
  /** Where the carrier wants his next touch to go (stick / AI intent), separate from the run line. */
  touchX = 1;
  touchZ = 0;
  /** If set, the body turns toward this point instead of the run direction (jockey, receive). */
  lookAt: V3 | null = null;
  /** Keep the body square to `lookAt` even on the move (jockeying, keepers, the wall).
   * Otherwise `lookAt` is where he's watching: the body follows his run and only opens
   * toward it as he slows (the head, in the renderer, turns to the ball either way). */
  squareUp = false;
  /** Going for a loose ball that's right there: the last couple of strides are explosive. */
  burst = false;
  readonly lookTarget = new V3();

  // ---- state
  action: ActionKind = 'none';
  actionT = 0;
  actionDur = 0;
  actionDirX = 1;
  actionDirZ = 0;
  actionDone = false;
  kickLeg = 1; // 1 = right, -1 = left
  plan: KickPlan | null = null;
  /** The strike in progress (for body mechanics): type, power, target angle relative to the body. */
  kickType: KickPlan['type'] = 'pass';
  kickPower = 0;
  kickLofted = false;
  kickRel = 0;
  /** Seconds from the start of the strike to the ball leaving the foot (wind-up + swing). */
  kickContact = 0.15;
  /** The strike is with the weaker foot. */
  kickWeak = false;
  /** Height of the ball at the moment of the strike (first-time volleys and half-volleys). */
  kickHeight = 0;
  /** Reaching for the ball: 0 = it's at his foot, 1 = a full stretch. */
  kickStretch = 0;
  /** Where the ball will be at contact, in his frame (m): forward, and to his left. */
  kickBallF = 0;
  kickBallL = 0;
  /** Running velocity when the strike started, and the lunge toward the ball (m/s). */
  kickVX = 0;
  kickVZ = 0;
  lungeX = 0;
  lungeZ = 0;
  /** Preferred foot: 1 = right, -1 = left. */
  foot = 1;
  /** Throw-in (two hands) rather than a keeper's one-arm throw. */
  throwIn = false;
  /** Height the keeper caught the ball at (for the catch animation). */
  catchY = 1;
  /** Smoothed forward acceleration (m/s²), used for body inertia. */
  accelFwd = 0;
  /** Seconds before this player can be knocked off balance again. */
  balanceCD = 0;
  touchCooldown = 0;
  stamina = 1;
  sprinting = false;
  /** Seconds since this player last touched the ball. */
  sinceTouch = 99;

  // ---- animation (read by renderer)
  stridePhase = 0;
  leanFwd = 0;
  leanSide = 0;
  prevSpeed = 0;
  // Interpolated copies for rendering
  animStride = 0;

  constructor(
    public readonly id: number,
    public readonly team: number,
    public readonly index: number,
    public readonly role: Role,
    /** Formation slot in team frame (attacking +x): x,z in -1..1 */
    public readonly baseX: number,
    public readonly baseZ: number,
    public readonly attrs: Attributes,
    public readonly look: { skin: number; hair: number; hairStyle: number; height: number; build: number },
  ) {}

  get speed(): number {
    return Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z);
  }

  /** Shirt name / number (club line-ups). */
  name = '';
  number = 0;

  get topSpeed(): number {
    // Heavier bodies carry a little less top speed.
    const mass = clamp(1 - (this.attrs.weight - 78) * 0.0015, 0.96, 1.03);
    return PLAYER.topSpeed * (0.86 + 0.14 * this.attrs.pace) * (0.75 + 0.25 * this.stamina) * mass;
  }

  /** Acceleration (m/s²): the accel stat, scaled by body mass; tired legs lose their burst. */
  get accelRate(): number {
    return this.accelBase * (0.7 + 0.3 * this.stamina);
  }

  private get accelBase(): number {
    // (Math.pow is costly and this is asked thousands of times a second: remembered for
    // the stats it was worked out from.)
    const { accel, weight } = this.attrs;
    if (accel !== this.accelFor || weight !== this.weightFor) {
      this.accelFor = accel;
      this.weightFor = weight;
      this.accelMemo = PLAYER.accel * (0.8 + 0.35 * accel) * clamp(Math.pow(78 / weight, 0.3), 0.92, 1.08);
    }
    return this.accelMemo;
  }
  private accelFor = NaN;
  private weightFor = NaN;
  private accelMemo = 0;
  /** How sharply his build lets him cut, for the height it was worked out from. */
  private agileFor = NaN;
  private agileMemo = 1;

  /** Effective strength in duels: the stat plus body weight. */
  get duelStrength(): number {
    return this.attrs.strength * 0.75 + clamp((this.attrs.weight - 60) / 40, 0, 1) * 0.25;
  }

  /** Aerial ability 0..1: jumping and height. */
  get aerial(): number {
    return this.attrs.jumping * 0.6 + clamp((this.attrs.height - 1.65) / 0.35, 0, 1) * 0.4;
  }

  /** Highest ball (m) this player can head: taller players and better jumpers reach higher. */
  get headReach(): number {
    return PLAYER.headMax + (this.attrs.height - 1.8) * 0.9 + (this.attrs.jumping - 0.5) * 0.5;
  }

  isBusy(): boolean {
    return this.action !== 'none';
  }

  /** Speed a slide tackle starts with, and when the grass has stopped it (set as he goes down). */
  slideV0 = 7.5;
  slideStop = 0.8;
  /** Where a tackling leg reaches (unit, on the ground), fixed when he commits. */
  legX = 1;
  legZ = 0;

  /** A leg stretched out for the ball, 0..1: shoots out (~0.14 s), holds, draws back. */
  static stretchExt(t: number, dur: number): number {
    return smoothstep(0.03, 0.14, t) * (1 - smoothstep(dur * 0.66, dur, t));
  }

  startAction(kind: ActionKind, dur: number, dirX: number, dirZ: number): void {
    this.action = kind;
    this.actionT = 0;
    this.actionDur = dur;
    this.actionDirX = dirX;
    this.actionDirZ = dirZ;
    this.actionDone = false;
  }

  /** Physical movement with momentum: separate limits for speeding up, braking and turning. */
  move(dt: number): void {
    this.prevPos.copy(this.pos);
    this.prevFacing = this.facing;
    this.touchCooldown = Math.max(0, this.touchCooldown - dt);
    this.sinceTouch += dt;

    let tx = this.moveX * this.wantSpeed;
    let tz = this.moveZ * this.wantSpeed;

    // Actions override locomotion.
    if (this.action !== 'none') {
      this.actionT += dt;
      const a = this.action;
      if (a === 'kick' && this.actionT >= this.kickContact) {
        // Follow-through: the body is carried on through the ball, then the player
        // gathers himself and runs on the way he wants to go.
        const k = clamp((this.actionT - this.kickContact) / Math.max(0.01, this.actionDur - this.kickContact), 0, 1);
        const blend = k * k;
        tx = this.vel.x * 0.97 * (1 - blend) + this.moveX * this.wantSpeed * blend;
        tz = this.vel.z * 0.97 * (1 - blend) + this.moveZ * this.wantSpeed * blend;
      } else if (a === 'kick') {
        // Strike on the run: the plant foot brakes the body; reaching for a ball that's
        // beyond the foot, he lunges toward it through the wind-up.
        tx = this.kickVX * 0.8 + this.lungeX;
        tz = this.kickVZ * 0.8 + this.lungeZ;
      } else if (a === 'header' || a === 'throw') {
        const keep = a === 'throw' ? 0.4 : 0.8;
        tx = this.vel.x * keep;
        tz = this.vel.z * keep;
      } else if (a === 'tackle') {
        const p = this.actionT / this.actionDur;
        const lunge = p < 0.45 ? 4.5 : 0.5;
        tx = this.actionDirX * lunge;
        tz = this.actionDirZ * lunge;
      } else if (a === 'slide') {
        // Committed: he goes where his momentum takes him (set as he went down, in
        // Match.startTackle) and the grass brakes him to a stop.
        const sp = Math.hypot(this.vel.x, this.vel.z);
        const k = sp > 1e-3 ? Math.max(0, sp - SLIDE_DECEL * dt) / sp : 0;
        this.vel.x *= k;
        this.vel.z *= k;
        tx = this.vel.x;
        tz = this.vel.z;
      } else if (a === 'dive') {
        const p = this.actionT / this.actionDur;
        if (p > 0.55) {
          this.vel.scale(Math.max(0, 1 - dt * 10));
        }
        tx = this.vel.x;
        tz = this.vel.z;
      } else if (a === 'catch') {
        tx = this.vel.x * 0.4;
        tz = this.vel.z * 0.4;
      } else if (a === 'fall') {
        // Knocked down: carried on by the hit, the grass brings him to a stop.
        const sp = Math.hypot(this.vel.x, this.vel.z);
        const k = sp > 1e-3 ? Math.max(0, sp - 7 * dt) / sp : 0;
        this.vel.x *= k;
        this.vel.z *= k;
        tx = this.vel.x;
        tz = this.vel.z;
      } else if (a === 'stretch') {
        // Reaching a leg out for it: the body carries on and leans in behind the leg; the
        // stride breaks for a moment.
        const lunge = this.actionT < this.actionDur * 0.45 ? 1.8 : 0;
        tx = this.vel.x * 0.92 + this.actionDirX * lunge;
        tz = this.vel.z * 0.92 + this.actionDirZ * lunge;
      } else if (a === 'stumble') {
        tx = this.vel.x * 0.3;
        tz = this.vel.z * 0.3;
      } else if (a === 'celebrate') {
        // celebration run handled by intent
        tx = this.moveX * this.wantSpeed;
        tz = this.moveZ * this.wantSpeed;
      }
      if (this.actionT >= this.actionDur) this.action = 'none';
    }

    const vx = this.vel.x;
    const vz = this.vel.z;
    const sp = Math.sqrt(vx * vx + vz * vz);
    const top = this.topSpeed;

    // Body orientation constrains speed: backpedalling and side-stepping are slower.
    const passive = this.action === 'slide' || this.action === 'dive' || this.action === 'fall';
    if (!passive) {
      const tsp = Math.sqrt(tx * tx + tz * tz);
      if (tsp > 0.1 && this.lookAt && this.squareUp) {
        const off = Math.abs(angleDiff(this.facing, Math.atan2(tz, tx)));
        const cap = off < 1.2 ? top : off < 2.2 ? 5.6 : 4.0;
        if (tsp > cap) {
          tx *= cap / tsp;
          tz *= cap / tsp;
        }
      }
      const accel = this.accelRate * (this.burst ? 1.7 : 1);
      let dvx = tx - vx;
      let dvz = tz - vz;
      if (sp < 0.6) {
        const m = Math.sqrt(dvx * dvx + dvz * dvz);
        const lim = (accel + 2) * dt;
        if (m > lim) {
          dvx *= lim / m;
          dvz *= lim / m;
        }
      } else {
        const fx = vx / sp;
        const fz = vz / sp;
        let along = dvx * fx + dvz * fz;
        let lx = dvx - along * fx;
        let lz = dvz - along * fz;
        // Acceleration fades out near top speed; braking needs steps.
        // Explosive first steps, fading near top speed (sprint-start curve).
        const aMax = along > 0 ? (accel * Math.max(0.1, 1 - Math.pow(sp / (top + 0.4), 1.6)) + 0.6) * dt : PLAYER.brake * dt;
        along = clamp(along, -aMax, aMax);
        const lat = Math.sqrt(lx * lx + lz * lz);
        // Turning harder at speed: lateral grip limit (centripetal accel). Direction changes
        // happen through the planted foot, so grip pulses with the stride (strongest with a
        // foot under the body), which gives cuts a natural rhythm.
        const plant = Math.cos(this.stridePhase);
        // Agile, compact players cut sharper than tall, heavy ones.
        if (this.attrs.height !== this.agileFor) {
          this.agileFor = this.attrs.height;
          this.agileMemo = clamp(Math.pow(1.8 / this.agileFor, 0.6), 0.92, 1.08);
        }
        const body = this.agileMemo;
        const latMax = PLAYER.lateral * (0.8 + 0.3 * this.attrs.agility) * body * (0.78 + 0.44 * plant * plant) * dt;
        if (lat > latMax) {
          lx *= latMax / lat;
          lz *= latMax / lat;
        }
        dvx = along * fx + lx;
        dvz = along * fz + lz;
      }
      this.vel.x += dvx;
      this.vel.z += dvz;
    }

    // Lean (for animation): forward with acceleration, sideways into turns.
    const nsp = this.speed;
    const accelFwd = (nsp - this.prevSpeed) / dt;
    this.prevSpeed = nsp;
    let latAcc = 0;
    if (nsp > 0.5) {
      // cross product of velocity change and direction
      latAcc = ((this.vel.z - vz) * (vx / Math.max(sp, 0.01)) - (this.vel.x - vx) * (vz / Math.max(sp, 0.01))) / dt;
    }
    if (dt !== expDt) {
      expDt = dt;
      exp8 = 1 - Math.exp(-dt * 8);
      exp10 = 1 - Math.exp(-dt * 10);
    }
    const k = exp8;
    this.accelFwd += (clamp(accelFwd, -12, 12) - this.accelFwd) * exp10;
    this.balanceCD = Math.max(0, this.balanceCD - dt);
    this.leanFwd += (clamp(accelFwd * 0.03 + nsp * 0.018, -0.25, 0.35) - this.leanFwd) * k;
    this.leanSide += (clamp(-latAcc * 0.035, -0.35, 0.35) - this.leanSide) * k;

    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    // Facing. Committed to a tackle, the body turns (quickly) to the line it went in on.
    if (this.action === 'tackle' || this.action === 'slide') {
      const step = 14 * dt;
      this.facing += clamp(angleDiff(this.facing, Math.atan2(this.actionDirZ, this.actionDirX)), -step, step);
    } else if (!passive) {
      let want = this.facing;
      const run = nsp > 0.6 ? Math.atan2(this.vel.z, this.vel.x) : null;
      if (this.lookAt) {
        const look = Math.atan2(this.lookAt.z - this.pos.z, this.lookAt.x - this.pos.x);
        if (this.squareUp || run === null) want = look;
        else {
          // The body goes where he's running; slowing down, it opens up toward what he's
          // watching (all the way when he's barely moving, ~30° at a sprint).
          const open = 0.5 + 2.6 * (1 - smoothstep(1.5, 4.5, nsp));
          want = run + clamp(angleDiff(run, look), -open, open);
        }
      } else if (run !== null) {
        want = run;
      }
      const turnRate = (12.5 - nsp * 0.65) * (0.85 + 0.3 * this.attrs.agility);
      const d = angleDiff(this.facing, want);
      const step = turnRate * dt;
      const turn = clamp(d, -step, step);
      this.facing += turn;
      // Turning on the spot still takes steps: the feet shuffle round with the body.
      if (nsp < 2.5) this.stridePhase += Math.abs(turn) * 1.6 * (1 - nsp / 2.5);
    }

    // Gait: one step = half a stride cycle.
    const stepLen = 0.7 + 0.12 * nsp;
    this.stridePhase += (nsp / stepLen) * Math.PI * dt;

    // Stamina: sprinting drains, everything else recovers.
    // The stamina stat sets both how fast sprinting drains and how fast it comes back.
    const st = this.attrs.stamina;
    if (this.sprinting && nsp > PLAYER.jogSpeed) this.stamina = Math.max(0, this.stamina - dt * 0.035 * (1.45 - 0.9 * st));
    else this.stamina = Math.min(1, this.stamina + dt * (nsp < 3 ? 0.03 : 0.012) * (0.7 + 0.6 * st));
  }
}
