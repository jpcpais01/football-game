import { describe, expect, it } from 'vitest';
import { Match } from '../src/sim/match';
import { makeInput } from '../src/sim/input';
import { PITCH } from '../src/sim/constants';

/** Run until `done` or the step budget runs out; returns steps taken. */
function run(m: Match, done: () => boolean, max = 120 * 60): number {
  const input = makeInput();
  let n = 0;
  while (!done() && n < max) {
    m.step(input);
    m.takeEvents();
    n++;
  }
  return n;
}

describe('fouls and free kicks', () => {
  it('fouls happen, but not all the time', () => {
    let fouls = 0;
    let freekicks = 0;
    let offsides = 0;
    for (const seed of [3, 11, 29]) {
      const m = new Match(seed);
      m.autoPlay = true;
      const input = makeInput();
      let lastSP: unknown = null;
      while (m.phase !== 'fulltime') {
        m.step(input);
        const e = m.takeEvents();
        if (e.foul) fouls++;
        if (e.offside) offsides++;
        if (m.setPiece && m.setPiece !== lastSP && (m.setPiece.kind === 'freekick' || m.setPiece.kind === 'penalty')) freekicks++;
        lastSP = m.setPiece;
      }
    }
    // Three short matches (2 × 150 s each): a handful of fouls, not dozens.
    expect(fouls).toBeGreaterThan(0);
    expect(fouls).toBeLessThan(45);
    // (Offsides restart with an indirect free kick too.)
    expect(freekicks).toBeLessThanOrEqual(fouls + offsides);
  }, 120000);

  it('a foul becomes a free kick that is taken and play resumes', () => {
    const m = new Match(7);
    m.autoPlay = true;
    run(m, () => m.phase === 'play' && m.time > 4);
    // Move the ball to a direct free-kick spot in the human team's attacking half.
    const dir = m.teams[m.humanTeam].dir;
    m.ball.reset(dir * (PITCH.halfL - 24), 6);
    m.debugFoul();
    expect(m.phase).toBe('out');
    run(m, () => m.phase === 'setpiece');
    expect(m.setPiece?.kind).toBe('freekick');
    expect(m.setPiece?.team).toBe(m.humanTeam);
    expect(m.setPiece?.direct).toBe(true);
    const wall = m.setPiece!.wall!;
    expect(wall.players.length).toBeGreaterThan(0);
    for (const [i, p] of wall.players.entries()) {
      expect(p.team).not.toBe(m.humanTeam);
      expect(Math.hypot(wall.slots[i][0] - m.setPiece!.x, wall.slots[i][1] - m.setPiece!.z)).toBeGreaterThan(8.5);
    }
    run(m, () => m.phase === 'play', 120 * 20);
    expect(m.phase).toBe('play');
  });

  it('a foul in the box is a penalty from the spot', () => {
    const m = new Match(5);
    m.autoPlay = true;
    run(m, () => m.phase === 'play' && m.time > 4);
    const dir = m.teams[m.humanTeam].dir;
    m.ball.reset(dir * (PITCH.halfL - 8), 3);
    m.debugFoul();
    run(m, () => m.phase === 'setpiece');
    expect(m.setPiece?.kind).toBe('penalty');
    expect(m.setPiece!.x).toBeCloseTo(dir * (PITCH.halfL - PITCH.penaltySpot), 5);
    // Nobody but the taker and the keeper inside the box.
    for (const p of m.players) {
      if (p === m.setPiece!.taker || p.role === 'GK') continue;
      expect(m.inPenaltyArea(1 - m.humanTeam, p.pos.x, p.pos.z)).toBe(false);
    }
    run(m, () => m.phase !== 'setpiece', 120 * 20);
    expect(['play', 'goal', 'out']).toContain(m.phase);
  });
});
