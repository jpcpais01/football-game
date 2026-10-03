import { describe, expect, it } from 'vitest';
import { Match } from '../src/sim/match';
import { makeInput } from '../src/sim/input';
import { DRILLS, Drill } from '../src/sim/training';

describe('training', () => {
  for (const d of DRILLS) {
    it(`${d.name}: attempts play out and get judged`, () => {
      const m = new Match(4242);
      m.autoPlay = true;
      const drill = new Drill(m, d.id);
      const input = makeInput();
      const seen: string[] = [];
      for (let i = 0; i < 120 * 90; i++) {
        m.step(input);
        drill.step();
        m.takeEvents();
        if (drill.verdict && seen.length < drill.verdicts) seen.push(drill.verdict.title);
      }
      expect(m.phase).not.toBe('fulltime');
      expect(drill.verdicts).toBeGreaterThan(4);
    });
  }
});
