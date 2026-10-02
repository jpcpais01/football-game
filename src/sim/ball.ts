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
      const decay = Math.exp(-dt / BALL.spinDecay);
      w.scale(decay);
    }

    this.pos.addScaled(v, dt);

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
      w.y *= Math.exp(-dt / 0.6);
      if (Math.abs(v.x) + Math.abs(v.z) < 0.02) {
        v.x = 0;
        v.z = 0;
      }
    }

    this.collideGoals();
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
    const pr = PITCH.postRadius;
    // Posts (vertical) and crossbar (horizontal), all sitting on the goal line.
    this.collideSegment(lineX, 0, -hw, lineX, PITCH.goalHeight, -hw, pr);
    this.collideSegment(lineX, 0, hw, lineX, PITCH.goalHeight, hw, pr);
    this.collideSegment(lineX, PITCH.goalHeight, -hw, lineX, PITCH.goalHeight, hw, pr);

    // Net volume behind the line.
    const backX = side * (PITCH.halfL + PITCH.goalDepth);
    const prevAx = Math.abs(this.prevPos.x);
    const insideNow = ax > PITCH.halfL && ax < PITCH.halfL + PITCH.goalDepth + 0.5 && Math.abs(p.z) < hw && p.y < PITCH.goalHeight;
    if (!this.inGoal) {
      if (insideNow && prevAx <= PITCH.halfL + 0.02) {
        this.inGoal = true; // came in through the mouth
      } else if (ax > PITCH.halfL && ax < PITCH.halfL + PITCH.goalDepth) {
        // Outside the frame: side netting and roof stop the ball.
        const nearSide = Math.abs(Math.abs(p.z) - hw) < R && p.y < PITCH.goalHeight;
        const nearRoof = Math.abs(p.y - PITCH.goalHeight) < R && Math.abs(p.z) < hw;
        if (nearSide && Math.abs(this.prevPos.z) > hw) {
          p.z = Math.sign(p.z) * (hw + R);
          this.netHit(Math.abs(this.vel.z));
          this.vel.z *= -0.15;
          this.vel.x *= 0.5;
        } else if (nearRoof && this.prevPos.y > PITCH.goalHeight) {
          p.y = PITCH.goalHeight + R;
          this.netHit(Math.abs(this.vel.y));
          this.vel.y *= -0.2;
          this.vel.x *= 0.6;
          this.vel.z *= 0.6;
        }
      }
    }
    if (this.inGoal) {
      // Keep the ball inside the net and soak up its energy.
      if (side * (p.x - backX) > -R) {
        p.x = backX - side * R;
        this.netHit(Math.abs(this.vel.x));
        this.vel.x *= -0.12;
        this.vel.y *= 0.5;
        this.vel.z *= 0.5;
      }
      if (Math.abs(p.z) > hw - R) {
        p.z = Math.sign(p.z) * (hw - R);
        this.netHit(Math.abs(this.vel.z));
        this.vel.z *= -0.15;
        this.vel.x *= 0.6;
      }
      if (p.y > PITCH.goalHeight - R) {
        p.y = PITCH.goalHeight - R;
        this.netHit(Math.abs(this.vel.y));
        this.vel.y *= -0.1;
      }
      // Ball can't escape back through the front once it's in.
      if (Math.abs(p.x) < PITCH.halfL + R) {
        p.x = side * (PITCH.halfL + R);
        this.vel.x *= -0.2;
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
