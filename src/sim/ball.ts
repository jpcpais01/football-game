import { AIR_DENSITY, BALL, GRAVITY, PITCH } from './constants';
import { V3, clamp, smoothstep } from './vec';

const R = BALL.radius;
const M = BALL.mass;
const I = BALL.inertiaFactor * M * R * R;
// Effective mass for changing the contact-point velocity with a tangential impulse
// on a sphere: 1/m + r^2/I.
const CONTACT_K = 1 / M + (R * R) / I;

export interface BallEvents {
  bounce: number; // impact speed of the latest ground bounce
  post: number; // impact speed of the latest woodwork hit
  net: number; // impact speed into the net
  netX: number;
  netY: number;
  netZ: number;
}

export class Ball {
  pos = new V3(0, R, 0);
  vel = new V3();
  spin = new V3(); // angular velocity, rad/s
  prevPos = new V3(0, R, 0);
  /** Accumulated visual rotation (quaternion-free: integrated by the renderer from spin). */
  onGround = true;
  /** True while the ball is inside a goal frame (behind the line). */
  inGoal = false;
  events: BallEvents = { bounce: 0, post: 0, net: 0, netX: 0, netY: 0, netZ: 0 };

  private tmp = new V3();
  /** Spin decay factors in the air and on the grass, for the last dt (it's only ever DT or 2 DT). */
  private eDt = -1;
  private eSpin = 0;
  private eGrass = 0;

  reset(x: number, z: number): void {
    this.pos.set(x, R, z);
    this.prevPos.copy(this.pos);
    this.vel.set(0, 0, 0);
    this.spin.set(0, 0, 0);
    this.onGround = true;
    this.inGoal = false;
  }

  /** Strike the ball. Velocity in m/s, spin in rad/s. */
  kick(vx: number, vy: number, vz: number, sx: number, sy: number, sz: number): void {
    this.vel.set(vx, vy, vz);
    this.spin.set(sx, sy, sz);
    if (vy > 0.05) this.onGround = false;
  }

  step(dt: number): void {
    this.prevPos.copy(this.pos);
    const v = this.vel;
    const w = this.spin;
    // On the grass means on it: a real lift takes it off; a sliver of upward speed (a ground
    // pass, a nudge off a shin) is nothing, or it would float, rolling with no grass to slow it.
    if (this.onGround && v.y !== 0) {
      if (v.y > 0.05) this.onGround = false;
      else v.y = 0;
    }
    const speed = v.len();

    // --- Aerodynamics -------------------------------------------------------
    if (speed > 0.01) {
      // Drag crisis: Cd drops sharply once the boundary layer turns turbulent.
      const t = smoothstep(BALL.crisisSpeed - BALL.crisisWidth, BALL.crisisSpeed + BALL.crisisWidth, speed);
      const cd = BALL.cdLow + (BALL.cdHigh - BALL.cdLow) * t;
      const kDrag = (0.5 * AIR_DENSITY * cd * BALL.area * speed) / M;
      v.x -= v.x * kDrag * dt;
      v.y -= v.y * kDrag * dt;
      v.z -= v.z * kDrag * dt;

      // Magnus: F = 1/2 rho A Cl v^2 (w x v)/(|w||v|)
      const wl = w.len();
      if (wl > 0.5) {
        const sRatio = (R * wl) / speed;
        const cl = clamp(1.25 * sRatio, 0, 0.33);
        const k = (0.5 * AIR_DENSITY * BALL.area * cl * speed) / (M * wl);
        // (w x v) * k
        const cx = w.y * v.z - w.z * v.y;
        const cy = w.z * v.x - w.x * v.z;
        const cz = w.x * v.y - w.y * v.x;
        v.x += cx * k * dt;
        // Magnus lift on a rolling ball would make it hop; only apply vertical part in the air.
        if (!this.onGround) v.y += cy * k * dt;
        v.z += cz * k * dt;
      }
    }

    if (!this.onGround) {
      v.y -= GRAVITY * dt;
      this.decayFor(dt);
      w.scale(this.eSpin);
    }

    // Near the goal frame, move in small sub-steps so a fast ball can't tunnel
    // through a 12 cm post or the net between two frames.
    const nearGoal = Math.abs(this.pos.x) > PITCH.halfL - 2 && Math.abs(this.pos.x) < PITCH.halfL + 3 && Math.abs(this.pos.z) < PITCH.goalHalfWidth + 2;
    if (nearGoal) {
      const n = Math.min(8, Math.max(1, Math.ceil((speed * dt) / 0.04)));
      for (let i = 0; i < n; i++) {
        this.pos.addScaled(v, dt / n);
        this.collideGoals();
      }
    } else {
      this.pos.addScaled(v, dt);
    }

    // --- Ground -------------------------------------------------------------
    if (this.pos.y <= R) {
      this.pos.y = R;
      const vy = v.y;
      if (vy < -0.45) {
        // Bounce. Restitution softens for gentle impacts (grass absorbs them).
        const impact = -vy;
        const e = BALL.restitution * smoothstep(0.45, 2.5, impact) * (1 - 0.12 * smoothstep(8, 20, impact));
        v.y = impact * e;
        this.events.bounce = impact;
        this.onGround = v.y < 0.45;
        if (this.onGround) v.y = 0;
        // Tangential friction impulse limited by Coulomb friction.
        const jn = M * (1 + e) * impact;
        this.applyContactFriction(BALL.groundFriction * jn);
      } else {
        v.y = 0;
        this.onGround = true;
      }
    }

    if (this.onGround && this.pos.y <= R + 1e-4) {
      // Sliding / rolling on grass.
      const cvx = v.x + R * w.z;
      const cvz = v.z - R * w.x;
      const slip = Math.sqrt(cvx * cvx + cvz * cvz);
      if (slip > 0.08) {
        this.applyContactFriction(BALL.groundFriction * 0.75 * M * GRAVITY * dt);
      } else {
        // Pure rolling: lock spin to velocity and apply rolling resistance.
        const hs = Math.sqrt(v.x * v.x + v.z * v.z);
        if (hs > 0) {
          const dec = BALL.rollDecel * dt;
          const ns = Math.max(0, hs - dec);
          const f = ns / hs;
          v.x *= f;
          v.z *= f;
        }
        w.z = -v.x / R;
        w.x = v.z / R;
      }
      // Grass kills vertical-axis spin quickly.
      this.decayFor(dt);
      w.y *= this.eGrass;
      if (Math.abs(v.x) + Math.abs(v.z) < 0.02) {
        v.x = 0;
        v.z = 0;
      }
    }

    this.collideGoals();
    this.collideSurrounds();
  }

  private decayFor(dt: number): void {
    if (dt === this.eDt) return;
    this.eDt = dt;
    this.eSpin = Math.exp(-dt / BALL.spinDecay);
    this.eGrass = Math.exp(-dt / 0.6);
  }

  /** One wall (along `axis` at ±limit, `height` tall): bounce the ball back off it with restitution e. */
  private hit(axis: 'x' | 'z', limit: number, height: number, e: number): void {
    const p = this.pos;
    const v = this.vel;
    const c = axis === 'x' ? p.x : p.z;
    const vc = axis === 'x' ? v.x : v.z;
    if (Math.abs(c) > limit - R && p.y < height + R && Math.sign(vc) === Math.sign(c)) {
      const back = Math.sign(c) * (limit - R);
      if (axis === 'x') {
        p.x = back;
        v.x = -v.x * e;
        v.z *= 0.75;
      } else {
        p.z = back;
        v.z = -v.z * e;
        v.x *= 0.75;
      }
      v.y *= 0.7;
      this.spin.scale(0.4);
      this.events.bounce = Math.max(this.events.bounce, Math.abs(vc) * 0.5);
    }
  }

  /**
   * Ad boards round the pitch and the front walls of the stands, so a ball that goes out
   * thuds into them and drops instead of flying away. (Matches the rendered stadium.)
   */
  private collideSurrounds(): void {
    const p = this.pos;
    // Boards along the touchlines and beside the goals (open behind the goal mouth).
    this.hit('z', PITCH.halfW + 3.8, 0.9, 0.35);
    if (Math.abs(p.z) > PITCH.goalHalfWidth + 3.5) this.hit('x', PITCH.halfL + 4.5, 0.9, 0.35);
    // Stand walls behind them.
    this.hit('z', PITCH.halfW + 7.5, 1.6, 0.3);
    this.hit('x', PITCH.halfL + 8.5, 1.4, 0.3);
  }

  /** Friction impulse at the contact point, capped by maxImpulse (N·s). */
  private applyContactFriction(maxImpulse: number): void {
    const v = this.vel;
    const w = this.spin;
    const cvx = v.x + R * w.z;
    const cvz = v.z - R * w.x;
    const slip = Math.sqrt(cvx * cvx + cvz * cvz);
    if (slip < 1e-6) return;
    const needed = slip / CONTACT_K;
    const j = Math.min(needed, maxImpulse);
    const jx = (-cvx / slip) * j;
    const jz = (-cvz / slip) * j;
    v.x += jx / M;
    v.z += jz / M;
    // torque = r x J with r = (0,-R,0): (-R*jz, 0, R*jx)
    w.x += (-R * jz) / I;
    w.z += (R * jx) / I;
  }

  private collideGoals(): void {
    const p = this.pos;
    const ax = Math.abs(p.x);
    if (ax < PITCH.halfL - 1.5) {
      this.inGoal = false;
      return;
    }
    const side = p.x > 0 ? 1 : -1;
    const lineX = side * PITCH.halfL;
    const hw = PITCH.goalHalfWidth;
    const H = PITCH.goalHeight;
    const pr = PITCH.postRadius;
    // Posts (vertical) and crossbar (horizontal), all sitting on the goal line.
    this.collideSegment(lineX, 0, -hw, lineX, H, -hw, pr);
    this.collideSegment(lineX, 0, hw, lineX, H, hw, pr);
    this.collideSegment(lineX, H, -hw, lineX, H, hw, pr);

    // The net, in goal-local coordinates: u = depth behind the line, z across, y up.
    // Same profile as the rendered net: flat roof to ROOF, then a slope down to DEPTH.
    const D = PITCH.goalDepth;
    const RF = PITCH.goalRoofDepth;
    const u = ax - PITCH.halfL;
    const prevU = Math.abs(this.prevPos.x) - PITCH.halfL;
    const az = Math.abs(p.z);
    const top = (uu: number) => (uu <= RF ? H : uu >= D ? 0 : H * (1 - (uu - RF) / (D - RF)));
    // Back slope plane through (RF, H) and (D, 0); outward normal in (u, y).
    const nl = Math.hypot(H, D - RF);
    const nu = H / nl;
    const ny = (D - RF) / nl;
    const backDist = ((u - RF) * H + (p.y - H) * (D - RF)) / nl; // >0 outside

    if (!this.inGoal) {
      if (u > 0 && prevU <= 0.05 && az < hw && p.y < H) {
        this.inGoal = true; // came in through the mouth
      } else if (u > -R && u < D + R && az < hw + R && p.y < H + R) {
        // Outside the frame touching the net: side netting, roof or back.
        const penSide = az > hw - R && Math.abs(this.prevPos.z) >= hw ? hw + R - az : 1e9;
        const penRoof = u > 0 && u <= RF && this.prevPos.y >= H ? H + R - p.y : 1e9;
        const penBack = u > RF && backDist > -R && backDist < R ? R - backDist : 1e9;
        const pen = Math.min(penSide, penRoof, penBack);
        if (pen < 1e8 && pen > 0) {
          if (pen === penSide) {
            p.z = Math.sign(p.z) * (hw + R);
            this.netHit(Math.abs(this.vel.z));
            this.vel.z *= -0.15;
            this.vel.x *= 0.5;
            this.vel.y *= 0.7;
          } else if (pen === penRoof) {
            p.y = H + R;
            this.netHit(Math.abs(this.vel.y));
            if (this.vel.y < 0) this.vel.y *= -0.2;
            this.vel.x *= 0.6;
            this.vel.z *= 0.6;
            this.onGround = false;
          } else {
            p.x += side * nu * pen;
            p.y += ny * pen;
            const vn = this.vel.x * side * nu + this.vel.y * ny;
            if (vn < 0) {
              this.netHit(-vn);
              this.vel.x -= side * nu * vn * 1.2;
              this.vel.y -= ny * vn * 1.2;
            }
            this.vel.x *= 0.6;
            this.vel.z *= 0.6;
          }
        }
      }
    }
    if (this.inGoal) {
      // Inside: the net catches the ball and soaks up its energy.
      if (u > RF && backDist > -R) {
        const pen = backDist + R;
        p.x -= side * nu * pen;
        p.y -= ny * pen;
        const vn = this.vel.x * side * nu + this.vel.y * ny;
        if (vn > 0) {
          this.netHit(vn);
          this.vel.x -= side * nu * vn * 1.12;
          this.vel.y -= ny * vn * 1.12;
        }
        this.vel.z *= 0.6;
      }
      if (u <= RF && p.y > H - R) {
        p.y = H - R;
        if (this.vel.y > 0) {
          this.netHit(this.vel.y);
          this.vel.y *= -0.1;
        }
        this.vel.x *= 0.7;
      }
      if (Math.abs(p.x) - PITCH.halfL > D - R) {
        p.x = side * (PITCH.halfL + D - R);
        if (this.vel.x * side > 0) {
          this.netHit(Math.abs(this.vel.x));
          this.vel.x *= -0.12;
        }
      }
      if (az > hw - R) {
        p.z = Math.sign(p.z) * (hw - R);
        if (this.vel.z * Math.sign(p.z) > 0) {
          this.netHit(Math.abs(this.vel.z));
          this.vel.z *= -0.15;
        }
        this.vel.x *= 0.7;
      }
      // Ball can't escape back through the front once it's in.
      if (Math.abs(p.x) < PITCH.halfL + R) {
        p.x = side * (PITCH.halfL + R);
        if (this.vel.x * side < 0) this.vel.x *= -0.2;
      }
      if (p.y > top(Math.abs(p.x) - PITCH.halfL) - R + 0.001 && Math.abs(p.x) - PITCH.halfL > RF) {
        // Numerical safety: never leave the volume through the slope.
        p.y = Math.max(R, top(Math.abs(p.x) - PITCH.halfL) - R);
      }
    }
  }

  private netHit(speed: number): void {
    if (speed < 0.5) return;
    this.events.net = Math.max(this.events.net, speed);
    this.events.netX = this.pos.x;
    this.events.netY = this.pos.y;
    this.events.netZ = this.pos.z;
  }

  /** Sphere vs capsule (goal frame). */
  private collideSegment(ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number): void {
    const p = this.pos;
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const t = clamp(((p.x - ax) * abx + (p.y - ay) * aby + (p.z - az) * abz) / (abx * abx + aby * aby + abz * abz), 0, 1);
    const cx = ax + abx * t;
    const cy = ay + aby * t;
    const cz = az + abz * t;
    const n = this.tmp.set(p.x - cx, p.y - cy, p.z - cz);
    const d = n.len();
    const minD = R + radius;
    if (d >= minD || d < 1e-6) return;
    n.scale(1 / d);
    p.set(cx + n.x * minD, cy + n.y * minD, cz + n.z * minD);
    const vn = this.vel.dot(n);
    if (vn < 0) {
      this.vel.addScaled(n, -(1 + BALL.postRestitution) * vn);
      // Woodwork scrubs a bit of spin and speed.
      this.vel.scale(0.92);
      this.spin.scale(0.6);
      this.events.post = Math.max(this.events.post, -vn);
      if (this.vel.y > 0.5) this.onGround = false;
    }
  }
}

/**
 * Predicts where the ball will be after `t` seconds by running the real integrator on a
 * scratch ball. Used by AI and the kick solver, so predictions always match physics.
 */
export class BallPredictor {
  private b = new Ball();

  load(src: Ball): Ball {
    const b = this.b;
    b.pos.copy(src.pos);
    b.prevPos.copy(src.pos);
    b.vel.copy(src.vel);
    b.spin.copy(src.spin);
    b.onGround = src.onGround;
    b.inGoal = src.inGoal;
    return b;
  }

  get scratch(): Ball {
    return this.b;
  }
}
