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
function groundArrival(from: V3, fx: number, fz: number, v0: number, rollFrac: number, dist: number, out: { t: number }, floor = -1): number {
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
    // Already slower than `floor`: it can only slow further, so it won't arrive at that pace.
    if (floor > 0 && b.vel.x * b.vel.x + b.vel.z * b.vel.z < floor * floor * 0.98) break;
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
    const s = groundArrival(from, dx, dz, mid, rollFrac, dist, tOut, arriveSpeed);
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
    // Coming down onto the grass: the step that bounces it has already flipped vel.y.
    const falling = b.vel.y <= 0;
    b.step(DT);
    t += DT;
    if (falling && b.pos.y <= 0.115) break;
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

/** Height of a struck ball when it has travelled `dist` metres horizontally (-1 if it lands first). */
export function heightAlong(from: V3, vel: V3, spin: V3, dist: number): number {
  const b = loadScratch(from, vel.x, vel.y, vel.z, spin);
  b.onGround = false;
  const h = Math.hypot(vel.x, vel.z) || 1;
  const fx = vel.x / h;
  const fz = vel.z / h;
  for (let t = 0; t < 3; t += DT) {
    b.step(DT);
    if ((b.pos.x - from.x) * fx + (b.pos.z - from.z) * fz >= dist) return b.pos.y;
    if (b.vel.y < 0 && b.pos.y <= 0.12) return -1;
  }
  return -1;
}

/**
 * Direct free kick: the lowest shot at (tx, tz) that still clears the wall (`wallTop` high,
 * `wallDist` away) and dips under the bar, with the given pace, curl and topspin. A low,
 * fast shot is the hardest for the keeper, so we take the lowest that gets over.
 */
/**
 * Dead-ball shot: the lowest target height (from `minY`, the aimed height, up) that still
 * clears the wall at `wallDist`. Aimed high, it simply goes where it was aimed.
 */
export function solveFreeKick(from: V3, tx: number, tz: number, wallDist: number, wallTop: number, speed: number, curl: number, topspin: number, minY = 1.15): KickResult {
  const y0 = Math.min(2.9, Math.max(0.3, minY));
  let r = solveShot(from, tx, Math.max(2.2, y0), tz, speed, topspin, curl);
  for (let ty = y0; ty <= 2.26; ty += 0.1) {
    const c = solveShot(from, tx, ty, tz, speed, topspin, curl);
    if (heightAlong(from, c.vel, c.spin, wallDist) >= wallTop) {
      r = c;
      break;
    }
  }
  return r;
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

// ---------------------------------------------------------------------------------------
// Rolling-pass timing table, built once from the real integrator: for strike speeds
// 4..20 m/s, how far the ball has rolled and how fast it is going at each moment. Lets the
// AI plan through balls with exactly the timing the physics will produce.

const TABLE_DT = 1 / 30;
const TABLE_T = 6;
let rollTable: { v0: number; d: Float32Array; v: Float32Array }[] | null = null;

function buildRollTable(): { v0: number; d: Float32Array; v: Float32Array }[] {
  const out: { v0: number; d: Float32Array; v: Float32Array }[] = [];
  const n = Math.round(TABLE_T / TABLE_DT);
  const steps = Math.round(TABLE_DT / DT);
  for (let v0 = 4; v0 <= 20; v0++) {
    const spin = makeSpin(1, 0, (v0 / 0.11) * 0.55, 0, new V3());
    const b = loadScratch(new V3(0, 0.11, 0), v0, 0, 0, spin);
    const d = new Float32Array(n);
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < steps; k++) b.step(DT);
      d[i] = b.pos.x;
      v[i] = Math.hypot(b.vel.x, b.vel.z);
    }
    out.push({ v0, d, v });
  }
  return out;
}

/** First index where the distance rolled reaches x (a row only ever grows: binary search). */
function firstAtLeast(d: Float32Array, x: number): number {
  let lo = 0;
  let hi = d.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (d[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Ground pass that covers `dist` metres in about `wantT` seconds (strike speed 4..maxV).
 * Returns the time it really takes and the speed it arrives with, or null if it can't
 * get there (too far to roll) at any allowed strike speed.
 */
export function rollingPass(dist: number, wantT: number, maxV = 19): { v0: number; t: number; arrive: number } | null {
  if (!rollTable) rollTable = buildRollTable();
  let best: { v0: number; t: number; arrive: number } | null = null;
  let bestErr = 1e9;
  for (const row of rollTable) {
    if (row.v0 > maxV) break;
    // First moment it has rolled `dist`.
    const i = firstAtLeast(row.d, dist);
    if (i >= row.d.length || row.v[i] < 0.8) continue;
    const t = (i + 1) * TABLE_DT;
    const err = Math.abs(t - wantT);
    if (err < bestErr) {
      bestErr = err;
      best = { v0: row.v0, t, arrive: row.v[i] };
    }
  }
  return best;
}

/** Time for a ground pass struck at v0 (from the table) to roll `dist` metres, or -1. */
export function rollTimeAt(v0: number, dist: number): number {
  if (!rollTable) rollTable = buildRollTable();
  const row = rollTable[Math.max(0, Math.min(rollTable.length - 1, Math.round(v0) - 4))];
  const i = firstAtLeast(row.d, dist);
  return i < row.d.length ? (i + 1) * TABLE_DT : -1;
}

/** A ground pass struck at `v0` m/s along the unit direction (dx, dz): side-foot, partly rolling (as in the table). */
export function groundKick(dx: number, dz: number, v0: number): { vel: V3; spin: V3 } {
  return { vel: new V3(dx * v0, 0, dz * v0), spin: makeSpin(dx, dz, (v0 / 0.11) * 0.55, 0, new V3()) };
}

/**
 * Where a ground pass struck at `v0` (whole m/s, 4..20: a table row) is `t` seconds later:
 * metres rolled and its speed then (it stays put once it has stopped).
 */
export function rollAt(v0: number, t: number, out: { d: number; v: number }): { d: number; v: number } {
  if (!rollTable) rollTable = buildRollTable();
  const row = rollTable[Math.max(0, Math.min(rollTable.length - 1, Math.round(v0) - 4))];
  const f = t / TABLE_DT - 1;
  if (f <= 0) {
    const k = Math.max(0, t / TABLE_DT);
    out.d = row.d[0] * k;
    out.v = row.v0 + (row.v[0] - row.v0) * k;
    return out;
  }
  const i = Math.min(row.d.length - 2, Math.floor(f));
  const k = Math.min(1, f - i);
  out.d = row.d[i] + (row.d[i + 1] - row.d[i]) * k;
  out.v = row.v[i] + (row.v[i + 1] - row.v[i]) * k;
  return out;
}

/** The softest ground pass (table row, m/s) still going at `arrive` m/s when it has rolled `dist` metres (20 if none). */
export function rollPaceFor(dist: number, arrive: number): number {
  if (!rollTable) rollTable = buildRollTable();
  for (const row of rollTable) {
    const i = firstAtLeast(row.d, dist);
    if (i < row.d.length && row.v[i] >= arrive) return row.v0;
  }
  return 20;
}
