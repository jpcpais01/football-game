import { describe, expect, it } from 'vitest';
import { Match } from '../src/sim/match';
import { makeInput } from '../src/sim/input';

function play(seed: number) {
  const m = new Match(seed);
  m.autoPlay = true;
  const input = makeInput();
  const s = { goals: 0, shots: 0, passes: 0, through: 0, lob: 0, cross: 0, clear: 0, throw: 0, corner: 0, goalkick: 0, saves: 0, tackles: 0, posts: 0, possessions: 0 };
  m.log = (msg) => {
    const k = msg.split(' ')[3] as keyof typeof s;
    if (k === 'shot' as any) s.shots++;
    else if (k === 'pass' as any) s.passes++;
    else if (k in s) (s as any)[k]++;
  };
  let lastSP: unknown = null;
  let lastOwnerTeam = -1;
  let stuck = 0;
  let lbx = 0, lbz = 0;
  let steps = 0;
  const t0 = performance.now();
  while (m.phase !== 'fulltime' && steps < 120 * 400) {
    m.step(input);
    steps++;
    const e = m.takeEvents();
    if (e.goal >= 0) s.goals++;
    if (e.save > 0.31) s.saves++;
    if (e.tackle) s.tackles++;
    if (e.post) s.posts++;
    if (m.setPiece && m.setPiece !== lastSP && m.setPiece.kind !== 'kickoff') (s as any)[m.setPiece.kind]++;
    lastSP = m.setPiece;
    if (m.owner && m.owner.team !== lastOwnerTeam) { s.possessions++; lastOwnerTeam = m.owner.team; }
    for (const p of m.players) expect(Number.isFinite(p.pos.x + p.pos.z)).toBe(true);
    expect(Number.isFinite(m.ball.pos.x + m.ball.pos.y + m.ball.pos.z)).toBe(true);
    if (steps % 120 === 0) {
      const moved = Math.hypot(m.ball.pos.x - lbx, m.ball.pos.z - lbz);
      if (moved < 0.05 && m.phase === 'play' && !m.heldBy) stuck++; else stuck = 0;
      if (stuck > 8) throw new Error('ball stuck at ' + m.ball.pos.x.toFixed(1) + ',' + m.ball.pos.z.toFixed(1) + ' owner=' + m.owner?.id);
      lbx = m.ball.pos.x; lbz = m.ball.pos.z;
    }
  }
  return { m, s, steps, ms: performance.now() - t0 };
}

describe('full match (AI vs AI)', () => {
  it('runs full matches without breaking', () => {
    for (const seed of [1, 2, 3]) {
      const { m, s, steps, ms } = play(seed);
      console.log(`seed ${seed}: ${m.teams[0].score}-${m.teams[1].score}  ms/step ${(ms / steps).toFixed(3)}`, JSON.stringify(s));
      expect(m.phase).toBe('fulltime');
    }
  }, 120000);
});
