import { expect, it } from 'vitest';
import { Match } from '../src/sim/match';
import { makeInput } from '../src/sim/input';

function setup() {
  const m = new Match(5);
  const input = makeInput();
  // Skip kickoff: put our #9 on the ball in space.
  m.phase = 'play';
  m.setPiece = null;
  const c = m.teams[0].players[9];
  m.setControlled(c);
  // Move everyone else away.
  for (const p of m.players) if (p !== c) { p.pos.x = p.team === 0 ? -40 : 40 + p.index; p.pos.z = (p.index - 5) * 5; p.prevPos.copy(p.pos); }
  c.pos.set(-20, 0, 0); c.prevPos.copy(c.pos); c.facing = 0;
  m.ball.reset(-19.5, 0);
  m.owner = c;
  return { m, input, c };
}

it('dribbling at a sprint keeps the ball', () => {
  const { m, input, c } = setup();
  input.moveX = 1; input.sprint = true;
  let maxGap = 0, touches = 0, lost = 0;
  for (let i = 0; i < 120 * 4; i++) {
    m.step(input);
    const e = m.takeEvents(); touches += e.kicks.length;
    const gap = Math.hypot(m.ball.pos.x - c.pos.x, m.ball.pos.z - c.pos.z);
    maxGap = Math.max(maxGap, gap);
    if (!m.owner) lost++;
  }
  console.log('sprint: x', c.pos.x.toFixed(1), 'speed', c.speed.toFixed(1), 'touches', touches, 'maxGap', maxGap.toFixed(2), 'steps w/o owner', lost);
  expect(lost).toBe(0);
  expect(maxGap).toBeLessThan(3);
  expect(c.speed).toBeGreaterThan(7);
});

it('jog dribble with a sharp turn', () => {
  const { m, input, c } = setup();
  input.moveX = 1;
  for (let i = 0; i < 120 * 2; i++) { m.step(input); m.takeEvents(); }
  input.moveX = 0; input.moveY = 1; // turn 90° (up = -z)
  let maxGap = 0;
  for (let i = 0; i < 120 * 2; i++) { m.step(input); m.takeEvents(); maxGap = Math.max(maxGap, Math.hypot(m.ball.pos.x - c.pos.x, m.ball.pos.z - c.pos.z)); }
  expect(m.owner).toBe(c);
  expect(c.pos.z).toBeLessThan(-2);
  console.log('turn: pos', c.pos.x.toFixed(1), c.pos.z.toFixed(1), 'ball', m.ball.pos.x.toFixed(1), m.ball.pos.z.toFixed(1), 'owner', m.owner?.index, 'maxGap', maxGap.toFixed(2));
});

it('shot with full power from 18m', () => {
  const { m, input, c } = setup();
  c.pos.set(34, 0, 3); c.prevPos.copy(c.pos); m.ball.reset(34.6, 3); m.owner = c;
  input.moveX = 1;
  m.step(input);
  input.events.push({ btn: 2, kind: 'up', hold: 0.8 });
  let maxH = 0, crossed: string | null = null;
  for (let i = 0; i < 120 * 3; i++) {
    m.step(input); m.takeEvents();
    maxH = Math.max(maxH, m.ball.pos.y);
    if (!crossed && m.ball.pos.x > 52.5) crossed = `z=${m.ball.pos.z.toFixed(2)} y=${m.ball.pos.y.toFixed(2)}`;
  }
  console.log('shot: crossed', crossed, 'maxH', maxH.toFixed(2), 'score', m.teams[0].score, 'phase', m.phase);
  expect(maxH).toBeGreaterThan(0.5);
});
