import { describe, expect, it } from 'vitest';
import { Ball } from '../src/sim/ball';
import { DT } from '../src/sim/constants';
import { solveGroundPass, solveLofted, solveShot } from '../src/sim/kick';
import { V3 } from '../src/sim/vec';

function run(b: Ball, t: number) {
  for (let i = 0; i < t / DT; i++) b.step(DT);
}

describe('ball physics', () => {
  it('a firm unspun ground strike skids, rolls and stops at a realistic distance', () => {
    const b = new Ball();
    b.reset(0, 0);
    b.kick(12, 0, 0, 0, 0, 0);
    run(b, 20);
    console.log('12 m/s ground ball stops at', b.pos.x.toFixed(1));
    expect(b.pos.x).toBeGreaterThan(20);
    expect(b.pos.x).toBeLessThan(55);
  });

  it('a 30 m/s shot loses speed through drag', () => {
    const b = new Ball();
    b.reset(0, 0);
    b.pos.y = 0.3;
    b.pos.y = 1; b.kick(30, 4.5, 0, 0, 0, 0);
    let t = 0;
    while (b.pos.x < 25) { b.step(DT); t += DT; }
    console.log('shot over 25m: t', t.toFixed(2), 'speed', b.vel.len().toFixed(1));
    expect(b.vel.len()).toBeLessThan(29);
    expect(b.vel.len()).toBeGreaterThan(20);
  });

  it('sidespin curls the ball', () => {
    const b = new Ball();
    b.reset(0, 0);
    b.kick(25, 4, 0, 0, -50, 0); // curl right (toward +z)
    while (b.pos.x < 25) b.step(DT);
    console.log('curl over 25m:', b.pos.z.toFixed(2));
    expect(b.pos.z).toBeGreaterThan(2);
  });

  it('ground pass solver arrives at the target', () => {
    const from = new V3(0, 0.11, 0);
    const r = solveGroundPass(from, 20, 10, 5);
    const b = new Ball();
    b.reset(0, 0);
    b.kick(r.vel.x, r.vel.y, r.vel.z, r.spin.x, r.spin.y, r.spin.z);
    run(b, r.time);
    console.log('pass v0', r.vel.len().toFixed(1), 't', r.time.toFixed(2), 'at', b.pos.x.toFixed(1), b.pos.z.toFixed(1), 'speed', b.vel.len().toFixed(1));
    expect(Math.hypot(b.pos.x - 20, b.pos.z - 10)).toBeLessThan(0.6);
  });

  it('lofted solver lands near the target', () => {
    const from = new V3(0, 0.11, 0);
    const r = solveLofted(from, 35, -5, 30, 30, 0);
    const b = new Ball();
    b.reset(0, 0);
    b.kick(r.vel.x, r.vel.y, r.vel.z, r.spin.x, r.spin.y, r.spin.z);
    b.onGround = false;
    let t = 0;
    while (t < r.time) { b.step(DT); t += DT; }
    console.log('loft speed', r.vel.len().toFixed(1), 'lands', b.pos.x.toFixed(1), b.pos.z.toFixed(1));
    expect(Math.hypot(b.pos.x - 35, b.pos.z + 5)).toBeLessThan(1);
  });

  it('shot solver hits the target point with curl', () => {
    const from = new V3(30, 0.11, 10);
    const r = solveShot(from, 52.5, 1.8, -3, 26, 5, 35);
    const b = new Ball();
    b.reset(30, 10);
    b.kick(r.vel.x, r.vel.y, r.vel.z, r.spin.x, r.spin.y, r.spin.z);
    b.onGround = false;
    let px = 0, py = 0, pz = 0;
    while (b.pos.x < 52.5) { px = b.pos.x; py = b.pos.y; pz = b.pos.z; b.step(DT); }
    console.log('shot crosses at', py.toFixed(2), pz.toFixed(2), px.toFixed(1));
    expect(Math.abs(py - 1.8)).toBeLessThan(0.3);
    expect(Math.abs(pz + 3)).toBeLessThan(0.3);
  });
});
