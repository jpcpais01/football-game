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

it('defender can win the ball with press + tackle', () => {
  let wins = 0;
  for (let trial = 0; trial < 12; trial++) {
    const m = new Match(300 + trial);
    const input = makeInput();
    m.phase = 'play';
    m.setPiece = null;
    for (const p of m.players) { p.pos.x = p.team === 0 ? -48 : 48; p.pos.z = (p.index - 5) * 5; p.prevPos.copy(p.pos); }
    const att = m.teams[1].players[9];
    att.pos.set(0, 0, 0); att.prevPos.copy(att.pos); att.facing = Math.PI;
    m.ball.reset(-0.6, 0); m.owner = att;
    const def = m.teams[0].players[2];
    def.pos.set(-12, 0, 1); def.prevPos.copy(def.pos);
    m.setControlled(def);
    let tackled = false;
    for (let i = 0; i < 120 * 6; i++) {
      input.held[1] = true; // press
      if (!tackled && m.ballDist(def) < 1.3 && !def.isBusy() && i % 30 === 0) input.events.push({ btn: 2, kind: 'down', hold: 0 });
      m.step(input);
      m.takeEvents();
      if (m.owner && m.owner.team === 0) { tackled = true; break; }
      if (m.owner === null && m.lastTouch === def) { tackled = true; break; }
    }
    if (tackled) wins++;
  }
  console.log('defending: won the ball in', wins, '/ 12');
  expect(wins).toBeGreaterThan(3);
});

it('idle stick: active player goes and gets a loose ball', () => {
  const m = new Match(77);
  const input = makeInput();
  m.phase = 'play';
  m.setPiece = null;
  for (const p of m.players) { p.pos.x = p.team === 0 ? -48 : 48; p.pos.z = (p.index - 5) * 5; p.prevPos.copy(p.pos); }
  const c = m.teams[0].players[6];
  c.pos.set(-10, 0, 5); c.prevPos.copy(c.pos);
  m.setControlled(c);
  m.ball.reset(2, -6);
  m.ball.kick(-2, 0, 1, 0, 0, 0);
  let t = -1;
  for (let i = 0; i < 120 * 5; i++) {
    m.step(input);
    m.takeEvents();
    if (m.owner === c) { t = i / 120; break; }
  }
  console.log('loose ball collected after', t.toFixed(2), 's');
  expect(t).toBeGreaterThan(0);
  expect(t).toBeLessThan(3);
});

it('idle stick: active player closes down the carrier', () => {
  const m = new Match(78);
  const input = makeInput();
  m.phase = 'play';
  m.setPiece = null;
  for (const p of m.players) { p.pos.x = p.team === 0 ? -48 : 48; p.pos.z = (p.index - 5) * 5; p.prevPos.copy(p.pos); }
  const att = m.teams[1].players[9];
  att.pos.set(0, 0, 0); att.prevPos.copy(att.pos);
  m.ball.reset(-0.6, 0); m.owner = att;
  const def = m.teams[0].players[2];
  def.pos.set(-15, 0, 6); def.prevPos.copy(def.pos);
  m.setControlled(def);
  let minD = 99;
  for (let i = 0; i < 120 * 3; i++) {
    m.step(input);
    m.takeEvents();
    if (m.controlled === def) minD = Math.min(minD, m.ballDist(def));
  }
  console.log('closest approach to the ball', minD.toFixed(2), 'm');
  expect(minD).toBeLessThan(2.5);
});
