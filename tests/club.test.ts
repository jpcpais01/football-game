import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/vec';
import { Match, type TeamSetup } from '../src/sim/match';
import { makeInput } from '../src/sim/input';
import { TEAMS } from '../src/sim/teams';
import { generateCard, overall, toSim, roleOf, type Rarity } from '../src/meta/cards';
import { FORMATIONS } from '../src/meta/formations';
import { PACKS, openPack } from '../src/meta/packs';
import { Club, zonePosition } from '../src/meta/club';

function team(rarity: Rarity, seed: number, t: number): TeamSetup {
  const rng = new Rng(seed);
  return {
    info: TEAMS[t],
    players: FORMATIONS[0].slots.map((s) => ({ ...toSim(generateCard(rng, rarity, s.pos), s.pos), role: roleOf(s.pos), x: s.x, z: s.z })),
  };
}

describe('cards', () => {
  it('generates players at the requested overall', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 200; i++) {
      const c = generateCard(rng, 'epic', undefined, 70 + (i % 20));
      expect(Math.abs(overall(c) - (70 + (i % 20)))).toBeLessThanOrEqual(1);
      expect(c.height).toBeGreaterThanOrEqual(164);
      expect(c.weight).toBeGreaterThanOrEqual(60);
    }
  });

  it('packs honour their guarantee', () => {
    const gold = PACKS.find((p) => p.id === 'gold')!;
    for (let s = 0; s < 100; s++) {
      const cards = openPack(gold, s);
      expect(cards).toHaveLength(gold.cards);
      expect(cards.some((c) => ['epic', 'legendary', 'icon'].includes(c.rarity))).toBe(true);
    }
  });

  it('stats change the body in the simulation', () => {
    const rng = new Rng(3);
    const fast = generateCard(rng, 'epic', 'LW');
    fast.stats.pace = 95;
    fast.stats.accel = 95;
    const slow = { ...fast, stats: { ...fast.stats, pace: 45, accel: 45 } };
    const tall = { ...fast, height: 198, stats: { ...fast.stats, jumping: 90 } };
    const m = new Match(1, { teams: [team('common', 1, 0), team('common', 2, 1)] });
    const p = m.teams[0].players[8];
    const base = { ...p.attrs };
    Object.assign(p.attrs, toSim(fast, 'LW').attrs);
    const fastTop = p.topSpeed;
    const fastAcc = p.accelRate;
    const lowReach = p.headReach;
    Object.assign(p.attrs, toSim(slow, 'LW').attrs);
    expect(p.topSpeed).toBeLessThan(fastTop);
    expect(p.accelRate).toBeLessThan(fastAcc);
    Object.assign(p.attrs, toSim(tall, 'LW').attrs);
    expect(p.headReach).toBeGreaterThan(lowReach + 0.1);
    Object.assign(p.attrs, base);
  });

  it('out-of-position players lose technique, not their body', () => {
    const c = generateCard(new Rng(9), 'rare', 'ST');
    const home = toSim(c, 'ST').attrs;
    const away = toSim(c, 'CB').attrs;
    expect(away.shooting).toBeLessThan(home.shooting);
    expect(away.pace).toBe(home.pace);
  });
});

describe('club', () => {
  it('starts with a full eleven and keeps line-up edits consistent', () => {
    const club = new Club();
    expect(club.starters().every(Boolean)).toBe(true);
    expect(club.starters()[0]!.position).toBe('GK');
    const bench = club.bench()[0];
    club.assign(5, bench.id);
    expect(club.state.lineup.slots[5]).toBe(bench.id);
    club.setFormation('352');
    expect(new Set(club.state.lineup.slots).size).toBe(11);
    club.moveSlot(9, 0.3, -0.7);
    expect(club.slot(9).pos).toBe('LW');
    expect(zonePosition(-0.7, 0)).toBe('CB');
  });

  it('a club line-up plays a match', () => {
    const club = new Club();
    const m = new Match(5, club.matchSetup(5));
    m.autoPlay = true;
    const input = makeInput();
    for (let i = 0; i < 120 * 60; i++) m.step(input);
    expect(m.teams[0].players[0].name).not.toBe('');
    expect(m.phase).not.toBe('kickoff');
  });

  it('a much stronger squad wins more', () => {
    let strong = 0;
    let weak = 0;
    for (let s = 0; s < 3; s++) {
      const m = new Match(100 + s, { teams: [team('legendary', s, 0), team('common', 50 + s, 1)] });
      m.autoPlay = true;
      const input = makeInput();
      for (let i = 0; i < 120 * 500 && m.phase !== 'fulltime'; i++) m.step(input);
      strong += m.teams[0].score;
      weak += m.teams[1].score;
    }
    expect(strong).toBeGreaterThan(weak);
  }, 60000);
});
