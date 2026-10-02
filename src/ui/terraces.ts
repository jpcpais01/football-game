import type { Match, MatchEvents } from '../sim/match';
import { PITCH } from '../sim/constants';

/**
 * The terraces on a big European night: who's singing what, when the pyro goes up. One
 * director, read by everything that makes the atmosphere — the choir and drums (audio),
 * the fans bouncing on the beat, scarves up and arms up for the Viking clap (the crowd
 * shader), the flares burning in the ends and their smoke (particles), and the red glow
 * they throw on the people around them.
 *
 * The home end (team 0's fans) is behind the left goal, the away end behind the right.
 * The director keeps its own clock (it stops when the game is paused) and is driven by
 * what happens on the pitch: goals, chances, fouls, kick-offs.
 */

export type Vowel = 'a' | 'e' | 'i' | 'o' | 'u';

export interface ChantNote {
  /** Start, in beats from the top of the loop. */
  b: number;
  /** Length in beats. */
  d: number;
  /** Pitch in semitones from the root. */
  p: number;
  v: Vowel;
}

export interface Chant {
  name: string;
  bpm: number;
  /** Loop length in beats. */
  beats: number;
  notes: ChantNote[];
  /** Crowd claps (beats in the loop). */
  claps: number[];
  /** The ultras' bass drum (beats in the loop). */
  drum: number[];
}

const n = (b: number, d: number, p: number, v: Vowel): ChantNote => ({ b, d, p, v });

export const CHANTS: Chant[] = [
  {
    // The riff every stadium in Europe sings: "oh, oh-oh-oh-oh, oh, oh".
    name: 'riff',
    bpm: 118,
    beats: 8,
    notes: [n(0, 1.5, 0, 'o'), n(1.5, 0.5, 0, 'o'), n(2, 0.75, 3, 'o'), n(2.75, 0.75, 0, 'o'), n(3.5, 0.5, -2, 'o'), n(4, 2, -4, 'o'), n(6, 2, -5, 'o')],
    claps: [],
    drum: [0, 2, 4, 6],
  },
  {
    // "Olé, olé olé olé — olé, olé!"
    name: 'ole',
    bpm: 132,
    beats: 8,
    notes: [
      n(0, 1, 4, 'o'), n(1, 1, 0, 'e'),
      n(2, 0.5, 4, 'o'), n(2.5, 0.5, 0, 'e'), n(3, 0.5, 4, 'o'), n(3.5, 0.5, 0, 'e'),
      n(4, 1, 2, 'o'), n(5, 2.5, -1, 'e'),
    ],
    claps: [],
    drum: [0, 1, 2, 3, 4, 5],
  },
  {
    // "Allez, allez, allez!" — rolling, the second line answers lower.
    name: 'allez',
    bpm: 128,
    beats: 8,
    notes: [
      n(0, 0.5, 0, 'a'), n(0.5, 1, 0, 'e'), n(1.5, 0.5, 0, 'a'), n(2, 1, 0, 'e'), n(3, 0.5, 0, 'a'), n(3.5, 0.5, 2, 'e'),
      n(4, 0.5, -2, 'a'), n(4.5, 1, -2, 'e'), n(5.5, 0.5, -2, 'a'), n(6, 1, -2, 'e'), n(7, 0.5, -3, 'a'), n(7.5, 0.5, 0, 'e'),
    ],
    claps: [],
    drum: [0, 2, 4, 6],
  },
  {
    // Clap, clap — clap-clap-clap — clap-clap-clap-clap — then the club's name.
    name: 'claps',
    bpm: 140,
    beats: 8,
    notes: [n(5, 0.5, 0, 'a'), n(5.5, 0.5, 0, 'e'), n(6, 1.5, 3, 'o')],
    claps: [0, 1, 2, 2.5, 3, 4, 4.5],
    drum: [0, 1, 2, 3, 4, 6],
  },
  {
    // A slow, swelling anthem: the whole end holding long notes.
    name: 'anthem',
    bpm: 84,
    beats: 8,
    notes: [n(0, 2, 0, 'o'), n(2, 1, 2, 'a'), n(3, 1, 4, 'o'), n(4, 3, 5, 'a'), n(7, 1, 4, 'o')],
    claps: [],
    drum: [0, 4],
  },
];

/** The Viking thunder-clap: a boom and a "HUH!", slow, then faster and faster. */
const VIKING_GAPS = [3.2, 3.0, 2.6, 2.2, 1.85, 1.5, 1.2, 0.95, 0.78, 0.64, 0.54, 0.47, 0.42, 0.39, 0.37, 0.36, 0.35, 0.35];

export interface Singing {
  id: number;
  /** 0 = home end, 1 = away end. */
  end: 0 | 1;
  /** A song, or null for the Viking clap. */
  chant: Chant | null;
  start: number;
  until: number;
  /** Loudness 0..1 (how many are joining in). */
  level: number;
  /** Viking: the booms (director time). */
  booms: number[];
}

export interface Pyro {
  x: number;
  y: number;
  z: number;
  end: 0 | 1;
  born: number;
  life: number;
  /** Coloured smoke bomb (club colour) instead of a flare. */
  smoke: boolean;
  seed: number;
}

/** Where things happen in each end: the lower tier behind each goal (world space). */
const BOWL_X = PITCH.halfL + 8.5;
function standSpot(end: 0 | 1, rnd: () => number): [number, number, number] {
  const o = 3 + rnd() * 13; // metres back from the front of the tier
  const z = (rnd() - 0.5) * 42;
  const y = 1.4 + ((o - 0.4) / 19.6) * 10.1 + 1.7; // held up overhead
  return [(end === 0 ? -1 : 1) * (BOWL_X + o), y, z];
}

export class Terraces {
  /** Director time (seconds); stops when the game does. */
  t = 0;
  singing: Singing | null = null;
  pyro: Pyro[] = [];
  /** Smoothed for the visuals: how hard each end is singing (0..1). */
  home = 0;
  away = 0;
  /** Beat phase (0..1) of the song in progress, and the Viking arms-up (0..1). */
  beat = 0;
  arms = 0;
  /** One-shot reactions for the audio (boos, an "ooh"), drained each frame. */
  boos: (0 | 1)[] = [];
  oohs: number[] = [];
  private next = 3;
  private quiet = [0, 0];
  private ids = 0;
  private lastPhase = '';
  private rnd = Math.random;

  update(dt: number, match: Match): void {
    if (dt <= 0) return;
    this.t += dt;
    const t = this.t;

    // Kick-off of each half: the curtain-raiser — pyro in both ends, the anthem from home.
    if (match.phase === 'kickoff' && this.lastPhase !== 'kickoff' && this.lastPhase !== 'goal') {
      for (let i = 0; i < 4; i++) this.light(0, false, 8 + this.rnd() * 6);
      for (let i = 0; i < 3; i++) this.light(1, false, 8 + this.rnd() * 6);
      this.light(0, true, 7);
      this.light(1, true, 7);
      this.sing(0, CHANTS[4], 1, 2);
    }
    this.lastPhase = match.phase;

    // Ambient pyro: an occasional flare as the night goes on, more when it's tense.
    const ex = match.excitement;
    const rate = (0.012 + 0.05 * ex) * (match.phase === 'play' ? 1 : 0.4);
    if (this.rnd() < rate * dt && this.pyro.length < 9) this.light(this.rnd() < 0.7 ? 0 : 1, this.rnd() < 0.08, 14 + this.rnd() * 18);
    this.pyro = this.pyro.filter((f) => t - f.born < f.life);

    // The songs: one end at a time, a pause between, the end whose team is pressing more
    // likely to start up; nobody sings for a while after conceding.
    const s = this.singing;
    if (s && t > s.until) this.singing = null;
    if (!this.singing && t >= this.next && match.phase !== 'halftime' && match.phase !== 'fulltime') {
      const att = match.attackingTeam();
      let end: 0 | 1 = this.rnd() < (att === 1 ? 0.45 : 0.75) ? 0 : 1;
      if (t < this.quiet[end]) end = end === 0 ? 1 : 0;
      if (t >= this.quiet[end]) {
        if (this.rnd() < 0.14 + 0.2 * ex) this.viking(end);
        else this.sing(end, CHANTS[Math.floor(this.rnd() * CHANTS.length)], 0.6 + 0.4 * ex);
      } else this.next = t + 2;
    }

    // Visual state: who's singing, the beat, arms up for the Viking clap.
    const cur = this.singing;
    const on = cur && t >= cur.start ? Math.min(1, (t - cur.start) / 1.2, (cur.until - t) / 1.5) * cur.level : 0;
    const k = 1 - Math.exp(-dt * 4);
    this.home += ((cur?.end === 0 ? on : 0) - this.home) * k;
    this.away += ((cur?.end === 1 ? on : 0) - this.away) * k;
    if (cur?.chant) {
      const beats = ((t - cur.start) * cur.chant.bpm) / 60;
      this.beat = beats - Math.floor(beats);
    } else if (cur) {
      // Viking: arms up and waiting, then the clap on each boom.
      let last = -1e9;
      for (const b of cur.booms) if (b <= t) last = b;
      this.beat = Math.min(1, (t - last) / 0.6);
    }
    this.arms += ((cur && !cur.chant && t < cur.until - 1 ? 1 : 0) - this.arms) * k;
  }

  /** React to what just happened on the pitch. */
  onEvents(e: MatchEvents, match: Match): void {
    const t = this.t;
    if (e.goal >= 0) {
      const end = e.goal as 0 | 1;
      const other = end === 0 ? 1 : 0;
      // The scoring end erupts: pyro all along it, a smoke bomb, then the victory song.
      for (let i = 0; i < 7; i++) this.light(end, false, 10 + this.rnd() * 14, t + this.rnd() * 2.5);
      this.light(end, true, 9, t + 0.5);
      this.quiet[other] = t + 20;
      this.sing(end, this.rnd() < 0.5 ? CHANTS[1] : CHANTS[0], 1, 1.5);
    }
    if (e.foul === 1 && match.lastFoul) {
      // The end whose team was pulled up lets the referee hear it.
      this.boos.push(match.lastFoul.offender.team as 0 | 1);
    }
    if (e.save > 0.5 || e.post > 0) this.oohs.push(1);
  }

  /** A shot that went close: the whole ground goes "ooooh". */
  nearMiss(): void {
    this.oohs.push(0.8);
  }

  private sing(end: 0 | 1, chant: Chant, level: number, delay = 0): void {
    const start = this.t + delay;
    const loop = (chant.beats * 60) / chant.bpm;
    const loops = Math.max(2, Math.round((10 + this.rnd() * 10) / loop));
    this.singing = { id: ++this.ids, end, chant, start, until: start + loops * loop, level, booms: [] };
    this.next = start + loops * loop + 4 + this.rnd() * 7;
  }

  private viking(end: 0 | 1): void {
    const start = this.t + 0.5;
    const booms: number[] = [];
    let b = start + 1.2;
    for (const g of VIKING_GAPS) {
      booms.push(b);
      b += g;
    }
    // The last burst: a roar after the final quick claps.
    this.singing = { id: ++this.ids, end, chant: null, start, until: b + 2.5, level: 1, booms };
    this.next = b + 8 + this.rnd() * 6;
  }

  private light(end: 0 | 1, smoke: boolean, life: number, at = this.t): void {
    const [x, y, z] = standSpot(end, this.rnd);
    this.pyro.push({ x, y, z, end, born: at, life, smoke, seed: this.rnd() });
  }
}
