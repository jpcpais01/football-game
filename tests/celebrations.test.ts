import { describe, expect, it } from 'vitest';
import { CELEBRATIONS, Match } from '../src/sim/match';
import { Btn, makeInput } from '../src/sim/input';
import { GOAL_SEQ } from '../src/sim/constants';
import { angleDiff } from '../src/sim/vec';

/** Puts the ball in the opponents' net for the human team and returns the scorer. */
function score(m: Match) {
  m.autoPlay = true;
  while (!(m.phase === 'play' && m.time > 3)) m.step(makeInput());
  m.autoPlay = false;
  const team = m.teams[m.humanTeam];
  const s = team.players[9];
  s.pos.set(team.dir * 40, 0, 12);
  m.lastTouch = s;
  m.owner = null;
  m.ball.pos.set(team.dir * 50, 0.5, 0);
  m.ball.vel.set(team.dir * 25, 0, 0);
  m.ball.onGround = false;
  for (let i = 0; i < 60 && m.phase !== 'goal'; i++) {
    m.lastTouch = s;
    m.step(makeInput());
  }
  return s;
}

describe('goal celebrations', () => {
  CELEBRATIONS.forEach((kind, i) => {
    it(`${kind}: picked by its button, ends facing the camera`, () => {
      const m = new Match(5);
      const s = score(m);
      expect(m.phase).toBe('goal');
      expect(m.scorer).toBe(s);
      for (let k = 0; k < 60; k++) m.step(makeInput());
      expect(m.celebrationOpen).toBe(true);
      const input = makeInput();
      if (i === 3) input.sprint = true;
      else input.events.push({ btn: i as Btn, kind: 'down', hold: 0 });
      m.step(input);
      expect(m.celebration?.kind).toBe(kind);
      while (m.phaseT < GOAL_SEQ.crowd) m.step(makeInput());
      const cel = m.celebration!;
      expect(Math.abs(angleDiff(s.facing, Math.atan2(cel.dz, cel.dx)))).toBeLessThan(0.5);
      expect(s.speed).toBeLessThan(1);
    });
  });
});
