import { Ball } from './ball';
import { DT } from './constants';
import { V3 } from './vec';

/**
 * Kick solver. Every pass and shot is solved against the real ball integrator
 * (drag crisis, Magnus, skid-to-roll), so what the AI/assist "intends" is exactly what
 * the physics produces. Errors are added afterwards to model the striker's skill.
 */

const scratch = new Ball();

export interface KickResult {
  vel: V3;
  spin: V3;
  time: number; // seconds until the ball reaches the target
}

function makeSpin(fx: number, fz: number, top: number, side: number, out: V3): V3 {
  // right = forward x up = (-fz, 0, fx); topspin rotates about -right; curl-right is -y.
  return out.set(fz * top, -side, -fx * top);
}

function loadScratch(from: V3, vx: number, vy: number, vz: number, spin: V3): Ball {
  const b = scratch;
  b.pos.copy(from);
  b.prevPos.copy(from);
  b.vel.set(vx, vy, vz);
  b.spin.copy(spin);
  b.onGround = vy <= 0.05 && from.y <= 0.12;
  b.inGoal = false;
  b.events.bounce = 0;
  return b;
}

/** Speed the ball has when it has travelled `dist` metres along the ground (or -1 if it stops short). */
function groundArrival(from: V3, fx: number, fz: number, v0: number, rollFrac: number, dist: number, out: { t: number }): number {
  const spin = makeSpin(fx, fz, (v0 / 0.11) * rollFrac, 0, new V3());
  const b = loadScratch(from, fx * v0, 0, fz * v0, spin);
  let t = 0;
  const sx = from.x;
  const sz = from.z;
  while (t < 8) {
    b.step(DT);
    t += DT;
    const dx = b.pos.x - sx;
    const dz = b.pos.z - sz;
    if (dx * fx + dz * fz >= dist) {
      out.t = t;
      return Math.sqrt(b.vel.x * b.vel.x + b.vel.z * b.vel.z);
    }
    if (b.vel.x === 0 && b.vel.z === 0) break;
  }
  out.t = t;
  return -1;
}

const tOut = { t: 0 };

/** Ground pass that arrives at `target` with roughly `arriveSpeed` m/s. */
export function solveGroundPass(from: V3, tx: number, tz: number, arriveSpeed: number, maxSpeed = 30): KickResult {
  let dx = tx - from.x;
  let dz = tz - from.z;
  const dist = Math.max(0.5, Math.sqrt(dx * dx + dz * dz));
  dx /= dist;
  dz /= dist;
  const rollFrac = 0.55; // side-foot pass: ball starts partly rolling
  let lo = 1;
  let hi = maxSpeed;
  let best = hi;
  let bestT = 0;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) * 0.5;
    const s = groundArrival(from, dx, dz, mid, rollFrac, dist, tOut);
    if (s < arriveSpeed) {
      lo = mid;
    } else {
      hi = mid;
      best = mid;
      bestT = tOut.t;
    }
  }
  if (bestT === 0) {
    groundArrival(from, dx, dz, best, rollFrac, dist, tOut);
    bestT = tOut.t;
  }
  const spin = makeSpin(dx, dz, (best / 0.11) * rollFrac, 0, new V3());
  return { vel: new V3(dx * best, 0, dz * best), spin, time: bestT };
}

/** Simulates a lofted ball and returns horizontal distance at first landing (y back at ground). */
function loftLanding(from: V3, fx: number, fz: number, speed: number, angle: number, backspin: number, side: number, out: { t: number; x: number; z: number }): number {
  const c = Math.cos(angle);
  const spin = makeSpin(fx, fz, -backspin, side, new V3());
  const b = loadScratch(from, fx * speed * c, speed * Math.sin(angle), fz * speed * c, spin);
  b.onGround = false;
  let t = 0;
  while (t < 6) {
    b.step(DT);
    t += DT;
    if (b.vel.y <= 0 && b.pos.y <= 0.115) break;
  }
  out.t = t;
  out.x = b.pos.x;
  out.z = b.pos.z;
  const dx = b.pos.x - from.x;
  const dz = b.pos.z - from.z;
  return Math.sqrt(dx * dx + dz * dz);
}

const lOut = { t: 0, x: 0, z: 0 };

/** Lofted ball (cross, long ball, lob) landing at the target. */
export function solveLofted(from: V3, tx: number, tz: number, angleDeg: number, backspin = 30, curl = 0): KickResult {
  let ax = tx;
  let az = tz;
  const angle = (angleDeg * Math.PI) / 180;
  let speed = 15;
  let fx = 1;
  let fz = 0;
  // Outer loop corrects direction for curl, inner bisection finds the speed.
  for (let pass = 0; pass < 3; pass++) {
    let dx = ax - from.x;
    let dz = az - from.z;
    const d = Math.max(0.5, Math.sqrt(dx * dx + dz * dz));
    fx = dx / d;
    fz = dz / d;
    const want = Math.sqrt((tx - from.x) ** 2 + (tz - from.z) ** 2);
    let lo = 2;
    let hi = 38;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) * 0.5;
      if (loftLanding(from, fx, fz, mid, angle, backspin, curl, lOut) < want) lo = mid;
      else hi = mid;
    }
    speed = (lo + hi) * 0.5;
    if (curl === 0) break;
    loftLanding(from, fx, fz, speed, angle, backspin, curl, lOut);
    ax += tx - lOut.x;
    az += tz - lOut.z;
  }
  loftLanding(from, fx, fz, speed, angle, backspin, curl, lOut);
  const c = Math.cos(angle);
  return {
    vel: new V3(fx * speed * c, speed * Math.sin(angle), fz * speed * c),
    spin: makeSpin(fx, fz, -backspin, curl, new V3()),
    time: lOut.t,
  };
}

/**
 * Struck shot: finds the launch direction that sends the ball through (tx, ty, tz) at the
 * given speed with the given top/side spin. Iterates on the real flight.
 */
export function solveShot(from: V3, tx: number, ty: number, tz: number, speed: number, topspin: number, curl: number): KickResult {
  let ax = tx;
  let az = tz;
  // Initial guess: compensate for gravity drop over the estimated flight time.
  const estT = Math.hypot(tx - from.x, tz - from.z) / (speed * 0.85);
  let ay = ty + 0.5 * 9.81 * estT * estT;
  let vel = new V3();
  const spin = new V3();
  let time = 0;
  for (let it = 0; it < 8; it++) {
    const dx = ax - from.x;
    const dy = ay - from.y;
    const dz = az - from.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    vel = new V3((dx / d) * speed, (dy / d) * speed, (dz / d) * speed);
    const h = Math.sqrt(dx * dx + dz * dz);
    makeSpin(dx / h, dz / h, topspin, curl, spin);
    const b = loadScratch(from, vel.x, vel.y, vel.z, spin);
    b.onGround = false;
    // Fly until we pass the target's plane (perpendicular to the horizontal direction).
    const fx = (tx - from.x) / Math.max(0.01, Math.hypot(tx - from.x, tz - from.z));
    const fz = (tz - from.z) / Math.max(0.01, Math.hypot(tx - from.x, tz - from.z));
    const targetAlong = (tx - from.x) * fx + (tz - from.z) * fz;
    let t = 0;
    let px = from.x;
    let py = from.y;
    let pz = from.z;
    while (t < 4) {
      px = b.pos.x;
      py = b.pos.y;
      pz = b.pos.z;
      b.step(DT);
      t += DT;
      const along = (b.pos.x - from.x) * fx + (b.pos.z - from.z) * fz;
      if (along >= targetAlong) {
        const prevAlong = (px - from.x) * fx + (pz - from.z) * fz;
        const k = (targetAlong - prevAlong) / Math.max(1e-6, along - prevAlong);
        px += (b.pos.x - px) * k;
        py += (b.pos.y - py) * k;
        pz += (b.pos.z - pz) * k;
        break;
      }
    }
    time = t;
    ax += tx - px;
    ay += ty - py;
    az += tz - pz;
  }
  return { vel, spin: spin.clone(), time };
}

/** Time for a ball with given state to come within `radius` of (x, z) horizontally, or -1. */
export function predictBallAt(src: Ball, maxT: number, cb: (b: Ball, t: number) => boolean): number {
  const b = scratch;
  b.pos.copy(src.pos);
  b.prevPos.copy(src.pos);
  b.vel.copy(src.vel);
  b.spin.copy(src.spin);
  b.onGround = src.onGround;
  b.inGoal = src.inGoal;
  let t = 0;
  while (t < maxT) {
    if (cb(b, t)) return t;
    b.step(DT * 2);
    t += DT * 2;
  }
  return -1;
}
