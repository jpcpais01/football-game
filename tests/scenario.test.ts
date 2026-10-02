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
      input.held[2] = true; // press (middle button)
      if (!tackled && m.ballDist(def) < 1.3 && !def.isBusy() && i % 30 === 0) input.events.push({ btn: 0, kind: 'down', hold: 0 }); // tackle (bottom button)
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

it('seeking wins over a stick pushed the other way', () => {
  const m = new Match(79);
  const input = makeInput();
  m.phase = 'play';
  m.setPiece = null;
  for (const p of m.players) { p.pos.x = p.team === 0 ? -48 : 48; p.pos.z = (p.index - 5) * 5; p.prevPos.copy(p.pos); }
  const c = m.teams[0].players[6];
  c.pos.set(-10, 0, 0); c.prevPos.copy(c.pos);
  m.setControlled(c);
  m.ball.reset(0, 0);
  input.moveX = -1; // pushing away from the ball
  let t = -1;
  for (let i = 0; i < 120 * 4; i++) {
    m.step(input);
    m.takeEvents();
    if (m.owner === c) { t = i / 120; break; }
  }
  console.log('reached ball against the stick after', t.toFixed(2), 's');
  expect(t).toBeGreaterThan(0);
});

function emptyPitch(seed: number) {
  const m = new Match(seed);
  const input = makeInput();
  m.phase = 'play';
  m.setPiece = null;
  for (const p of m.players) { p.pos.x = p.team === 0 ? -30 + p.index : 45; p.pos.z = (p.index - 5) * 6; p.prevPos.copy(p.pos); }
  return { m, input };
}

it('Pass pressed early on an incoming ball fires when it arrives', () => {
  let ok = 0;
  for (let trial = 0; trial < 10; trial++) {
    const { m, input } = emptyPitch(400 + trial);
    const c = m.teams[0].players[6];
    c.pos.set(0, 0, 0); c.prevPos.copy(c.pos);
    m.setControlled(c);
    m.ball.reset(14, 3 - trial * 0.6);
    m.ball.kick(-9, 0, -0.2 + trial * 0.04, 0, 0, 0);
    // Press and release Pass straight away; the ball needs ~1.5 s to arrive.
    m.step(input);
    input.events.push({ btn: 0, kind: 'down', hold: 0 }, { btn: 0, kind: 'up', hold: 0.1 });
    let passed = false;
    for (let i = 0; i < 120 * 3; i++) {
      m.step(input);
      m.takeEvents();
      if (m.lastKicker === c && m.passTarget && m.passTarget.team === 0) { passed = true; break; }
    }
    if (passed) ok++;
  }
  console.log('early pass executed', ok, '/ 10');
  expect(ok).toBe(10);
});

it('Pass and Shoot fire reliably while dribbling at a sprint', () => {
  for (const btn of [0, 2] as const) {
    let ok = 0;
    let totalT = 0;
    for (let trial = 0; trial < 10; trial++) {
      const { m, input } = emptyPitch(500 + trial);
      const c = m.teams[0].players[9];
      c.pos.set(5, 0, 0); c.prevPos.copy(c.pos);
      m.setControlled(c);
      m.ball.reset(5.6, 0); m.owner = c;
      input.moveX = 1; input.sprint = true;
      for (let i = 0; i < 120 + trial * 13; i++) { m.step(input); m.takeEvents(); }
      input.events.push({ btn, kind: 'down', hold: 0 }, { btn, kind: 'up', hold: btn === 2 ? 0.5 : 0.1 });
      for (let i = 0; i < 120 * 2; i++) {
        m.step(input);
        m.takeEvents();
        if (m.lastKicker === c && m.time - m.lastKickTime < 0.01) { ok++; totalT += i / 120; break; }
      }
    }
    console.log(btn === 0 ? 'pass' : 'shot', 'while sprinting:', ok, '/ 10, avg delay', (totalT / Math.max(1, ok)).toFixed(2), 's');
    expect(ok).toBe(10);
  }
});

it('a lofted pass from the wing becomes a cross into the box', () => {
  let crosses = 0;
  let reachedBox = 0;
  for (let trial = 0; trial < 8; trial++) {
    const m = new Match(600 + trial);
    const input = makeInput();
    m.phase = 'play';
    m.setPiece = null;
    for (const p of m.players) { p.pos.x = p.team === 0 ? 10 : 30; p.pos.z = (p.index - 5) * 5; p.prevPos.copy(p.pos); }
    const c = m.teams[0].players[10];
    c.pos.set(40, 0, 28 - trial); c.prevPos.copy(c.pos);
    m.setControlled(c);
    m.ball.reset(40.6, 28 - trial);
    m.owner = c;
    // Two attackers arriving in the box.
    const st = m.teams[0].players[9];
    st.pos.set(42, 0, 2); st.prevPos.copy(st.pos);
    const lw = m.teams[0].players[8];
    lw.pos.set(40, 0, -5); lw.prevPos.copy(lw.pos);
    let kicked = false;
    const lines: string[] = [];
    m.log = (s) => lines.push(s);
    m.step(input);
    input.events.push({ btn: 0, kind: 'down', hold: 0 }, { btn: 0, kind: 'up', hold: 0.4, swipeUp: true });
    let maxH = 0;
    for (let i = 0; i < 120 * 3; i++) {
      m.step(input);
      m.takeEvents();
      if (m.lastKicker === c) kicked = true;
      if (kicked) maxH = Math.max(maxH, m.ball.pos.y);
      if (kicked && Math.abs(m.ball.pos.z) < 12 && m.ball.pos.x > 36 && m.ball.pos.y < 2.6) { reachedBox++; break; }
    }
    if (lines.some((l) => l.includes(' lob ') || l.includes(' cross '))) crosses++;
  }
  console.log('crosses', crosses, '/ 8, reached the box', reachedBox, '/ 8');
  expect(reachedBox).toBeGreaterThan(5);
});

it('switches to a much closer teammate even while steering', () => {
  const m = new Match(81);
  const input = makeInput();
  m.phase = 'play';
  m.setPiece = null;
  for (const p of m.players) { p.pos.x = p.team === 0 ? -45 : 45; p.pos.z = (p.index - 5) * 6; p.prevPos.copy(p.pos); }
  const att = m.teams[1].players[9];
  att.pos.set(0, 0, 0); att.prevPos.copy(att.pos);
  m.ball.reset(-0.6, 0); m.owner = att;
  const far = m.teams[0].players[6];
  far.pos.set(-20, 0, 15); far.prevPos.copy(far.pos);
  const near = m.teams[0].players[2];
  near.pos.set(-4, 0, 1); near.prevPos.copy(near.pos);
  m.setControlled(far);
  input.moveX = 0; input.moveY = -1; // steering sideways, not at the ball
  let switchedAt = -1;
  for (let i = 0; i < 120 * 2; i++) {
    m.step(input);
    m.takeEvents();
    if (m.controlled === near) { switchedAt = i / 120; break; }
  }
  console.log('switched to the closer defender after', switchedAt.toFixed(2), 's');
  expect(switchedAt).toBeGreaterThanOrEqual(0);
  expect(switchedAt).toBeLessThan(1);
});
