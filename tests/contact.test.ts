import { describe, expect, it } from 'vitest';
import { Match } from '../src/sim/match';
import { makeInput } from '../src/sim/input';
import type { Player } from '../src/sim/player';

/** A quiet match frozen in open play, everyone parked far from the action. */
function stage(seed: number): Match {
  const m = new Match(seed);
  m.autoPlay = true;
  const input = makeInput();
  for (let i = 0; i < 120 * 5 && m.phase !== 'play'; i++) m.step(input);
  for (let i = 0; i < 120; i++) m.step(input);
  for (const p of m.players) {
    p.pos.set(p.team === 0 ? -40 : 40, 0, (p.index - 5) * 5);
    p.prevPos.copy(p.pos);
    p.vel.set(0, 0, 0);
    p.action = 'none';
    p.plan = null;
  }
  return m;
}

describe('contact', () => {
  it('a tackle that only reaches the ball (not the man) is never a foul', () => {
    let fouls = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const m = stage(seed);
      const carrier: Player = m.teams[1].players[9];
      const tackler: Player = m.teams[0].players[3];
      // The carrier has let the ball run 1.4 m ahead; the tackler comes from the side onto it.
      carrier.pos.set(0, 0, 0);
      m.ball.reset(1.4, 0);
      m.owner = carrier;
      tackler.pos.set(1.4, 0, -1.2);
      tackler.prevPos.copy(tackler.pos);
      m.startTackle(tackler, 0, 1, seed % 2 === 0);
      for (let i = 0; i < 120; i++) {
        m.step(makeInput());
        if (m.takeEvents().foul) fouls++;
      }
    }
    expect(fouls).toBe(0);
  });

  it("a shot goes past a team-mate in its path instead of being taken by him", () => {
    let controlled = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const m = stage(seed);
      const dir = m.teams[0].dir;
      const shooter = m.teams[0].players[9];
      const mate = m.teams[0].players[10];
      shooter.pos.set(dir * 25, 0, 0);
      shooter.prevPos.copy(shooter.pos);
      m.ball.reset(dir * 25.6, 0);
      m.owner = shooter;
      m.performKick(shooter, { type: 'shot', dirX: dir, dirZ: 0, power: 0.7, targetId: -1, expires: m.time + 1, aimed: true });
      // Just off the shot's actual line, 3 m out where it's still low: inside his reach (the
      // old "attraction"), clear of his body.
      const v = m.ball.vel;
      const n = Math.hypot(v.x, v.z);
      const ux = v.x / n;
      const uz = v.z / n;
      mate.pos.set(m.ball.pos.x + ux * 3 - uz * 0.6, 0, m.ball.pos.z + uz * 3 + ux * 0.6);
      mate.prevPos.copy(mate.pos);
      for (let i = 0; i < 90; i++) {
        m.step(makeInput());
        m.takeEvents();
        if (m.owner === mate) controlled++;
      }
    }
    expect(controlled).toBe(0);
  });

  it("the keeper's hands reach where his arms can, not further", () => {
    const m = stage(3);
    const ai = m.ai as unknown as { keeperHit(k: Player, diving: boolean, x: number, y: number, z: number): { region: string } | null };
    const k = m.teams[0].players[0];
    k.pos.set(-50, 0, 0);
    k.facing = 0; // facing +x (the pitch)
    const h = k.look.height;
    // Chest height straight at him: body.
    expect(ai.keeperHit(k, false, -49.9, 1.2 * h, 0)?.region).toBe('body');
    // Head height, half a metre to the side: in reach of a hand.
    expect(ai.keeperHit(k, false, -49.8, 1.6 * h, 0.75)?.region).toBe('hands');
    // Waist height 1.4 m to the side: beyond his arms (he'd have to dive).
    expect(ai.keeperHit(k, false, -49.8, 1.0, 1.4)).toBeNull();
    // Behind his body line: no.
    expect(ai.keeperHit(k, false, -50.5, 1.4, 0.6)).toBeNull();
  });
});
