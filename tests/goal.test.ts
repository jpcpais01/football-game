import { describe, expect, it } from 'vitest';
import { Ball } from '../src/sim/ball';
import { DT, PITCH } from '../src/sim/constants';

const H = PITCH.goalHeight;
const D = PITCH.goalDepth;
const RF = PITCH.goalRoofDepth;
const netTop = (u: number) => (u <= RF ? H : u >= D ? 0 : H * (1 - (u - RF) / (D - RF)));

function fly(b: Ball, seconds: number, each?: (b: Ball) => void) {
  for (let i = 0; i < seconds / DT; i++) {
    b.step(DT);
    each?.(b);
  }
}

describe('goal frame and net', () => {
  it('a shot into the top corner stays inside the visible net', () => {
    const b = new Ball();
    b.reset(40, 0);
    b.pos.y = 0.3;
    b.kick(26, 3.2, 2.2, 0, 0, 0);
    let maxOut = 0;
    fly(b, 3, (bb) => {
      if (bb.inGoal) {
        const u = Math.abs(bb.pos.x) - PITCH.halfL;
        maxOut = Math.max(maxOut, bb.pos.y - (netTop(u) - 0.11), u - D);
      }
    });
    expect(b.inGoal).toBe(true);
    expect(maxOut).toBeLessThan(0.03);
    expect(b.pos.y).toBeLessThan(0.2); // drops to the floor of the net
  });

  it('a ball over the bar is not stopped by an invisible roof', () => {
    const b = new Ball();
    b.reset(30, 0);
    b.kick(22, 8.5, 0, 0, 0, 0);
    let crossedHigh = false;
    fly(b, 4, (bb) => {
      if (Math.abs(bb.pos.x) > PITCH.halfL && Math.abs(bb.pos.x) < PITCH.halfL + 0.3 && bb.pos.y > H) crossedHigh = true;
    });
    expect(crossedHigh).toBe(true);
    expect(b.inGoal).toBe(false);
    // It came down behind the goal (or ran off the sloped back), never hanging in the air.
    expect(b.pos.y).toBeLessThan(0.3);
    expect(b.pos.x).toBeGreaterThan(PITCH.halfL);
  });

  it('side netting stops a ball from outside', () => {
    const b = new Ball();
    b.reset(51, 8);
    b.kick(3, 0, -9, 0, 0, 0);
    fly(b, 2);
    expect(b.inGoal).toBe(false);
    expect(Math.abs(b.pos.z)).toBeGreaterThanOrEqual(PITCH.goalHalfWidth);
  });

  it('a shot off the post rebounds', () => {
    const b = new Ball();
    b.reset(40, PITCH.goalHalfWidth + 0.12);
    b.pos.y = 1;
    b.kick(25, 1.2, 0, 0, 0, 0);
    let post = 0;
    fly(b, 1, (bb) => { post = Math.max(post, bb.events.post); });
    expect(post).toBeGreaterThan(5);
  });
});
