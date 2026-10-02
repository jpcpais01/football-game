import { PLAYER } from './constants';
import { V3, angleDiff, clamp } from './vec';

export type Role = 'GK' | 'DEF' | 'MID' | 'FWD';

export interface Attributes {
  pace: number; // 0..1
  accel: number;
  control: number;
  passing: number;
  shooting: number;
  strength: number;
  defending: number;
  keeping: number;
}

export type ActionKind = 'none' | 'kick' | 'tackle' | 'slide' | 'dive' | 'stumble' | 'header' | 'throw' | 'celebrate';

export interface KickPlan {
  type: 'pass' | 'lob' | 'through' | 'shot' | 'clear' | 'cross';
  /** For human kicks, aim direction in world XZ (unit). */
  dirX: number;
  dirZ: number;
  /** False when the stick was idle: the game picks the best option instead of a direction. */
  aimed?: boolean;
  power: number; // 0..1 for shots
  targetId: number; // receiver, -1 for none
  expires: number; // sim time
}

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

  get topSpeed(): number {
    return PLAYER.topSpeed * (0.86 + 0.14 * this.attrs.pace) * (0.88 + 0.12 * this.stamina);
  }

  isBusy(): boolean {
    return this.action !== 'none';
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
      if (a === 'kick' || a === 'header' || a === 'throw') {
        // Strike on the run: plant foot costs some momentum.
        const keep = a === 'throw' ? 0.4 : 0.8;
        tx = this.vel.x * keep;
        tz = this.vel.z * keep;
      } else if (a === 'tackle') {
        const p = this.actionT / this.actionDur;
        const lunge = p < 0.45 ? 4.5 : 0.5;
        tx = this.actionDirX * lunge;
        tz = this.actionDirZ * lunge;
      } else if (a === 'slide') {
        // Slide: ground friction decelerates a fast initial burst.
        const p = this.actionT / this.actionDur;
        const s = Math.max(0, 7.5 * (1 - p * 1.6));
        this.vel.x = this.actionDirX * s;
        this.vel.z = this.actionDirZ * s;
        tx = this.vel.x;
        tz = this.vel.z;
      } else if (a === 'dive') {
        const p = this.actionT / this.actionDur;
        if (p > 0.55) {
          this.vel.scale(Math.max(0, 1 - dt * 10));
        }
        tx = this.vel.x;
        tz = this.vel.z;
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
    const passive = this.action === 'slide' || this.action === 'dive';
    if (!passive) {
      const tsp = Math.sqrt(tx * tx + tz * tz);
      if (tsp > 0.1 && this.lookAt) {
        const off = Math.abs(angleDiff(this.facing, Math.atan2(tz, tx)));
        const cap = off < 1.2 ? top : off < 2.2 ? 5.6 : 4.0;
        if (tsp > cap) {
          tx *= cap / tsp;
          tz *= cap / tsp;
        }
      }
      const accel = PLAYER.accel * (0.8 + 0.35 * this.attrs.accel);
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
        // Turning harder at speed: lateral grip limit (centripetal accel).
        const latMax = (PLAYER.lateral * (0.85 + 0.2 * this.attrs.accel)) * dt;
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
    const k = 1 - Math.exp(-dt * 8);
    this.leanFwd += (clamp(accelFwd * 0.03 + nsp * 0.018, -0.25, 0.35) - this.leanFwd) * k;
    this.leanSide += (clamp(-latAcc * 0.035, -0.35, 0.35) - this.leanSide) * k;

    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    // Facing.
    if (!passive && this.action !== 'tackle') {
      let want = this.facing;
      if (this.lookAt) {
        want = Math.atan2(this.lookAt.z - this.pos.z, this.lookAt.x - this.pos.x);
      } else if (nsp > 0.6) {
        want = Math.atan2(this.vel.z, this.vel.x);
      }
      const turnRate = 11 - nsp * 0.75;
      const d = angleDiff(this.facing, want);
      const step = turnRate * dt;
      this.facing += clamp(d, -step, step);
    }

    // Gait: one step = half a stride cycle.
    const stepLen = 0.7 + 0.12 * nsp;
    this.stridePhase += (nsp / stepLen) * Math.PI * dt;

    // Stamina: sprinting drains, everything else recovers.
    if (this.sprinting && nsp > PLAYER.jogSpeed) this.stamina = Math.max(0, this.stamina - dt * 0.035);
    else this.stamina = Math.min(1, this.stamina + dt * (nsp < 3 ? 0.03 : 0.012));
  }
}
