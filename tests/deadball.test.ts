import { describe, expect, it } from 'vitest';
import { Match } from '../src/sim/match';
import { Btn, makeInput, type InputState } from '../src/sim/input';
import { PITCH } from '../src/sim/constants';

function run(m: Match, done: () => boolean, input: InputState = makeInput(), max = 120 * 60): number {
  let n = 0;
  while (!done() && n < max) {
    m.step(input);
    m.takeEvents();
    n++;
  }
  return n;
}

/** A human penalty or direct free kick, lined up and waiting for the aim. */
function lineUp(seed: number, penalty: boolean): Match {
  const m = new Match(seed);
  m.autoPlay = true;
  run(m, () => m.phase === 'play' && m.time > 4);
  const dir = m.teams[m.humanTeam].dir;
  m.ball.reset(dir * (PITCH.halfL - (penalty ? 8 : 23)), penalty ? 3 : 6);
  m.debugFoul();
  m.autoPlay = false;
  run(m, () => m.aimingShot);
  return m;
}

describe('dead-ball shots', () => {
  it('the human lines up a free kick from a run-up spot off to the side, aims with the stick', () => {
    const m = lineUp(7, false);
    expect(m.aimingShot).toBe(true);
    const sp = m.setPiece!;
    const t = sp.taker;
    // Standing back and to the side of the kicking foot.
    const d = Math.hypot(t.pos.x - sp.x, t.pos.z - sp.z);
    expect(d).toBeGreaterThan(3.5);
    const z0 = sp.aimZ!;
    const input = makeInput();
    input.moveX = 1;
    run(m, () => false, input, 60);
    // Stick right = the taker's right on the goal mouth.
    expect((sp.aimZ! - z0) * m.teams[sp.team].dir).toBeGreaterThan(0.5);
  });

  it('Shoot ends the aim (the camera goes back) and the run-up strikes the ball', () => {
    const m = lineUp(5, true);
    const sp = m.setPiece!;
    sp.aimZ = 2.4;
    sp.aimY = 0.8;
    const input = makeInput();
    input.events.push({ btn: Btn.C, kind: 'up', hold: 0.5, swipeUp: false });
    m.step(input);
    expect(m.aimingShot).toBe(false);
    expect(sp.taker.plan?.aimZ).toBe(2.4);
    const taker = sp.taker;
    let maxSpeed = 0;
    run(m, () => {
      maxSpeed = Math.max(maxSpeed, taker.speed);
      return m.phase !== 'setpiece';
    }, makeInput(), 120 * 5);
    expect(m.phase).not.toBe('setpiece');
    // A real run-up: he got going before the strike.
    expect(maxSpeed).toBeGreaterThan(3);
    // Struck with the preferred foot.
    expect(taker.kickLeg).toBe(taker.foot);
    // It went toward the aimed side of the goal.
    run(m, () => Math.abs(m.ball.pos.x) > PITCH.halfL - 0.5 || m.phase === 'goal', makeInput(), 120 * 3);
    expect(Math.sign(m.ball.pos.z)).toBe(1);
  });
});
