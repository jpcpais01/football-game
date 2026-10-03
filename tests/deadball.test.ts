import { Ball } from '../src/sim/ball';
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
    m.switchT = 99; // he's been lining it up a while: the press doesn't predate a switch
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

describe('aimed corners', () => {
  for (const float of [false, true]) {
    it(`the ${float ? 'floated' : 'whipped'} delivery comes down on the ring`, () => {
      const m = new Match(11);
      m.autoPlay = true;
      run(m, () => m.phase === 'play' && m.time > 4);
      const dir = m.teams[m.humanTeam].dir;
      (m as unknown as { startSetPiece: (k: string, t: number, x: number, z: number) => void }).startSetPiece('corner', m.humanTeam, dir * PITCH.halfL, PITCH.halfW);
      m.autoPlay = false;
      run(m, () => m.aimingCorner, makeInput(), 120 * 5);
      expect(m.aimingCorner).toBe(true);
      const t = { x: dir * (PITCH.halfL - 7), z: -2 };
      m.setPiece!.target = { ...t };
      const input = makeInput();
      m.switchT = 99;
      input.events.push({ btn: float ? Btn.C : Btn.A, kind: 'up', hold: 0.3, swipeUp: false });
      m.step(input);
      expect(m.setPiece!.taker.plan?.landX).toBeCloseTo(t.x, 5);
      // Wait for the strike, then fly the struck ball on its own (nobody gets to head it).
      run(m, () => m.ball.vel.y > 2, makeInput(), 120 * 6);
      const b = new Ball();
      b.pos.copy(m.ball.pos);
      b.prevPos.copy(b.pos);
      b.vel.copy(m.ball.vel);
      b.spin.copy(m.ball.spin);
      b.onGround = false;
      let land: { x: number; z: number } | null = null;
      for (let i = 0; i < 120 * 6 && !land; i++) {
        const falling = b.vel.y <= 0;
        b.step(1 / 120);
        if (falling && b.pos.y < 0.115) land = { x: b.pos.x, z: b.pos.z };
      }
      expect(land).not.toBeNull();
      expect(Math.hypot(land!.x - t.x, land!.z - t.z)).toBeLessThan(4);
    });
  }
});

describe('aimed goal kicks', () => {
  /** A human goal kick, lined up with the ring out. */
  function goalKick(): Match {
    const m = new Match(5);
    m.autoPlay = true;
    run(m, () => m.phase === 'play' && m.time > 4);
    const dir = m.teams[m.humanTeam].dir;
    (m as unknown as { startSetPiece: (k: string, t: number, x: number, z: number) => void }).startSetPiece('goalkick', m.humanTeam, -dir * (PITCH.halfL - 5.5), 5);
    m.autoPlay = false;
    run(m, () => m.aimingGoalKick, makeInput(), 120 * 5);
    expect(m.aimingGoalKick).toBe(true);
    m.switchT = 99;
    return m;
  }

  for (const [float, out] of [[false, 30], [true, 30], [false, 58], [true, 58]] as const) {
    it(`the ${float ? 'floated' : 'driven'} kick comes down on the ring ${out} m out`, () => {
      const m = goalKick();
      const sp = m.setPiece!;
      const dir = m.teams[m.humanTeam].dir;
      const t = { x: sp.x + dir * out, z: -10 };
      sp.target = { ...t };
      const input = makeInput();
      input.events.push({ btn: float ? Btn.C : Btn.A, kind: 'up', hold: 0.3, swipeUp: false });
      m.step(input);
      run(m, () => m.ball.vel.y > 2, makeInput(), 120 * 6);
      const b = new Ball();
      b.pos.copy(m.ball.pos);
      b.prevPos.copy(b.pos);
      b.vel.copy(m.ball.vel);
      b.spin.copy(m.ball.spin);
      b.onGround = false;
      let land: { x: number; z: number } | null = null;
      for (let i = 0; i < 120 * 8 && !land; i++) {
        const falling = b.vel.y <= 0;
        b.step(1 / 120);
        if (falling && b.pos.y < 0.115) land = { x: b.pos.x, z: b.pos.z };
      }
      expect(land).not.toBeNull();
      expect(Math.hypot(land!.x - t.x, land!.z - t.z)).toBeLessThan(out / 8);
    });
  }

  it('Through plays it short along the ground', () => {
    const m = goalKick();
    const input = makeInput();
    input.events.push({ btn: Btn.B, kind: 'up', hold: 0.2, swipeUp: false });
    m.step(input);
    const plan = m.setPiece!.taker.plan!;
    expect(plan.type).toBe('pass');
    expect(plan.targetId).toBeGreaterThanOrEqual(0);
    let maxY = 0;
    // Over the next three seconds the ball is struck and stays on the grass.
    run(m, () => ((maxY = Math.max(maxY, m.ball.pos.y)), false), makeInput(), 120 * 3);
    expect(m.phase).toBe('play');
    expect(maxY).toBeLessThan(0.6);
  });
});
