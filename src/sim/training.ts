import { BALL, DT, PITCH } from './constants';
import type { Match } from './match';
import type { Player } from './player';

/**
 * Training drills, run on a real match: the drill picks who takes part (Match.field), lays
 * out each attempt, and judges how it ended. Everything in between is the ordinary
 * simulation: the same kicks, keepers, walls and tackles as a match.
 *
 * The human is always team 0, attacking +x (the clock never runs, so ends never change).
 */
export type DrillKind = 'freekicks' | 'penalties' | 'oneonone' | 'twovtwo' | 'keeper';

export const DRILLS: { id: DrillKind; name: string; about: string }[] = [
  { id: 'freekicks', name: 'Free kicks', about: 'A new spot every time, a wall and a keeper' },
  { id: 'penalties', name: 'Penalties', about: 'Twelve yards, you against the keeper' },
  { id: 'oneonone', name: 'One on one', about: 'Through on goal: round him or slot it past' },
  { id: 'twovtwo', name: '2 v 2', about: 'Two on two with keepers: attack, then defend' },
  { id: 'keeper', name: 'Goalkeeper', about: 'You in goal: stick to move, any button to dive' },
];

export interface Verdict {
  title: string;
  sub: string;
  /** Good for you, bad, or neither (a foul, time up): neither isn't counted. */
  good: boolean | null;
}

export class Drill {
  /** Rounds that went your way and rounds that didn't (goals for and against in 2 v 2,
   * saves and goals let in for the keeper). */
  made = 0;
  against = 0;
  /** Good rounds in a row, and the best run (kept by the caller between sessions). */
  streak = 0;
  best: number;
  /** The last attempt's outcome; `verdicts` counts them, so the HUD sees a new one arrive. */
  verdict: Verdict | null = null;
  verdicts = 0;
  /** Which side attacks this round. */
  att = 0;
  private round = 0;
  /** Seconds into this attempt, and since its verdict (-1 while it's live). */
  private t = 0;
  private doneT = -1;
  private hold = 1.5;
  private keeperTouched = false;
  private blocked = false;
  private woodwork = false;
  private defOwnT = 0;
  private scores: [number, number] = [0, 0];
  /** The club's dead-ball specialist (shirt slot), who takes the free kicks and penalties. */
  private readonly specialist: number;

  constructor(
    readonly m: Match,
    readonly kind: DrillKind,
    best = 0,
  ) {
    this.best = best;
    m.training = true;
    m.keeperHuman = kind === 'keeper';
    let bs = -1;
    this.specialist = 9;
    for (const p of m.all) {
      if (p.team !== 0 || p.role === 'GK') continue;
      const s = p.attrs.shooting * 0.7 + p.attrs.passing * 0.3;
      if (s > bs) (bs = s), (this.specialist = p.index);
    }
    this.next();
  }

  /** Is this attempt over (its verdict on screen)? */
  get done(): boolean {
    return this.doneT >= 0;
  }

  /** The scoreboard line. */
  get line(): string {
    if (this.kind === 'twovtwo') return `You ${this.made} – ${this.against} Them`;
    if (this.kind === 'keeper') return `Saves ${this.made} · Let in ${this.against}`;
    return `${this.made} / ${this.made + this.against}`;
  }

  /** What this round asks of you (2 v 2 swaps ends of the task every round). */
  get task(): string {
    if (this.kind === 'twovtwo') return this.att === 0 ? 'Attack' : 'Defend';
    return '';
  }

  /** After every match step. */
  step(): void {
    const m = this.m;
    this.t += DT;
    if (this.doneT >= 0) {
      this.doneT += DT;
      if (this.doneT > this.hold) this.next();
      return;
    }
    const lt = m.lastTouch;
    if (lt && lt.team !== this.att) {
      if (lt.role === 'GK') this.keeperTouched = true;
      else this.blocked = true;
    }
    if (m.events.post > 0) this.woodwork = true;
    const v = this.judge();
    if (v) this.finish(v);
  }

  // ------------------------------------------------------------------ judging

  private judge(): Verdict | null {
    const m = this.m;
    const att = this.att;
    const def = 1 - att;
    const mine = att === m.humanTeam;
    const b = m.ball;
    const deadBall = this.kind === 'freekicks' || this.kind === 'penalties';
    // Goal (an own goal counts for whoever it went in for).
    if (m.phase === 'goal') {
      const forAtt = m.teams[att].score > this.scores[att];
      if (forAtt === mine) return { title: 'GOAL', sub: this.woodwork ? 'In off the woodwork' : this.keeperTouched ? 'Through his hands' : this.goalLine(), good: true };
      return { title: mine ? 'OWN GOAL' : 'GOAL', sub: mine ? 'Into your own net' : 'They scored', good: false };
    }
    const saved = (sub: string): Verdict => ({ title: 'SAVED', sub, good: !mine });
    if (m.heldBy && m.heldBy.team === def) return saved(mine ? 'The keeper holds it' : 'Held');
    if (m.phase === 'out') {
      const r = m.restartPending;
      if (r === 'freekick' || r === 'penalty') return { title: 'FOUL', sub: 'Run it again', good: null };
      if (this.keeperTouched) return saved(mine ? 'Tipped away' : 'Turned behind');
      if (this.blocked) return { title: 'BLOCKED', sub: deadBall ? 'Into the wall' : 'Charged down', good: !mine };
      return { title: this.woodwork ? 'POST' : Math.abs(b.pos.z) < PITCH.goalHalfWidth ? 'OVER' : 'WIDE', sub: this.woodwork ? 'Off the woodwork' : 'Off target', good: this.kept(mine) };
    }
    // The defending side has it under control (the keeper at his feet counts as a save).
    const own = m.owner && m.owner.team === def ? m.owner : null;
    this.defOwnT = own ? this.defOwnT + DT : 0;
    if (this.defOwnT > 0.6) {
      if (own!.role === 'GK') return saved(mine ? 'Smothered' : 'Gathered');
      if (deadBall) return { title: this.blocked ? 'BLOCKED' : 'CLEARED', sub: this.blocked ? 'Into the wall' : 'Cleared', good: false };
      return { title: mine ? 'LOST IT' : 'WON IT', sub: mine ? 'They took it off you' : 'Ball won back', good: !mine };
    }
    // Cleared well away from goal.
    const gx = PITCH.halfL * m.teams[att].dir;
    if (Math.abs(b.pos.x - gx) > 48) return { title: 'CLEARED', sub: mine ? 'Booted away' : 'Danger over', good: !mine };
    if (deadBall) {
      // The kick's been taken and the ball has died (or come back off the keeper or the wall).
      if (m.phase === 'play' && m.time - m.lastKickTime > 1.1 && Math.hypot(b.vel.x, b.vel.z) < 3) {
        if (this.keeperTouched) return saved('Parried');
        if (this.blocked) return { title: 'BLOCKED', sub: 'Into the wall', good: false };
        return { title: 'SHORT', sub: 'It never got there', good: false };
      }
      return null;
    }
    const limit = this.kind === 'twovtwo' ? 25 : this.kind === 'keeper' ? 10 : 14;
    if (this.t > limit) return { title: 'TIME', sub: mine ? 'Too slow' : 'Kept them out', good: this.kept(mine) };
    return null;
  }

  /** A round that ends without a goal or a save: a failure when you attack, a success when
   * you defend in 2 v 2, and nobody's doing in goal (it wasn't your save). */
  private kept(mine: boolean): boolean | null {
    return mine ? false : this.kind === 'keeper' ? null : true;
  }

  /** Where it went in, for the caption. */
  private goalLine(): string {
    const b = this.m.ball.pos;
    const corner = Math.abs(b.z) > PITCH.goalHalfWidth - 1;
    return b.y > 1.7 ? (corner ? 'Top corner' : 'Under the bar') : corner ? 'Bottom corner' : 'Past the keeper';
  }

  private finish(v: Verdict): void {
    this.verdict = v;
    this.verdicts++;
    this.doneT = 0;
    this.hold = v.title === 'GOAL' || v.title === 'OWN GOAL' ? 2.4 : 1.6;
    if (v.good === null) return;
    const scored = v.title === 'GOAL' || v.title === 'OWN GOAL';
    // 2 v 2 keeps the goals; the others count good rounds against bad ones.
    if (this.kind === 'twovtwo') {
      if (scored && v.good) this.made++;
      else if (scored) this.against++;
    } else if (v.good) this.made++;
    else this.against++;
    this.streak = v.good ? this.streak + 1 : 0;
    this.best = Math.max(this.best, this.streak);
  }

  // ------------------------------------------------------------------ laying out

  private next(): void {
    const m = this.m;
    const rng = m.rng;
    this.round++;
    this.t = 0;
    this.doneT = -1;
    this.keeperTouched = this.blocked = this.woodwork = false;
    this.defOwnT = 0;
    m.clearPlay();
    const gx = PITCH.halfL;
    switch (this.kind) {
      case 'freekicks': {
        this.att = 0;
        m.field([[this.specialist], [0, 1, 2, 3, 4, 5]]);
        // Somewhere a shot is on: 17 to 29 m out, never wider than 31 m from goal.
        const depth = 17 + rng.next() * 12;
        const zMax = Math.min(20, Math.sqrt(31 * 31 - depth * depth));
        const x = gx - depth;
        const z = (rng.next() * 2 - 1) * zMax;
        // The defenders gather where the wall will stand; the keeper is on his line.
        const d = Math.hypot(depth, z);
        const cx = x + (depth / d) * 9.5;
        const cz = z - (z / d) * 9.5;
        this.put(this.pick(1, 0), gx - 0.6, 0, x, z);
        [1, 2, 3, 4, 5].forEach((i, k) => this.put(this.pick(1, i), cx + 0.5, cz + (k - 2) * 0.9, x, z));
        m.startSetPiece('freekick', 0, x, z);
        break;
      }
      case 'penalties': {
        this.att = 0;
        m.field([[this.specialist], [0]]);
        m.startSetPiece('penalty', 0, gx - PITCH.penaltySpot, 0);
        break;
      }
      case 'oneonone': {
        this.att = 0;
        m.field([[9], [0]]);
        const x = gx - (28 + rng.next() * 8);
        const z = (rng.next() * 2 - 1) * 12;
        this.put(this.pick(1, 0), gx - 1.2, 0, x, z);
        this.attack(this.pick(0, 9), x, z, gx);
        break;
      }
      case 'twovtwo': {
        // Odd rounds you attack the far goal; even rounds they come at yours.
        this.att = this.round % 2 === 1 ? 0 : 1;
        const a = this.att;
        const d = 1 - a;
        m.field(a === 0 ? [[9, 10], [0, 2, 3]] : [[0, 2, 3], [9, 10]]);
        const goal = gx * m.teams[a].dir; // the goal being attacked
        const s = -Math.sign(goal); // toward the halfway line
        const z = (rng.next() * 2 - 1) * 10;
        const wide = z > 0 ? -1 : 1;
        this.put(this.pick(d, 0), goal + s * 1.2, 0, goal + s * 30, z);
        this.put(this.pick(d, 2), goal + s * 19, -5 + z * 0.3, goal + s * 30, z);
        this.put(this.pick(d, 3), goal + s * 19, 5 + z * 0.3, goal + s * 30, z);
        this.put(this.pick(a, 10), goal + s * 32, z + wide * 11, goal, 0);
        this.attack(this.pick(a, 9), goal + s * 34, z, goal);
        if (a !== 0) {
          // You take the defender nearer the ball.
          const [p2, p3] = [this.pick(0, 2), this.pick(0, 3)];
          m.setControlled(Math.abs(p2.pos.z - z) < Math.abs(p3.pos.z - z) ? p2 : p3);
        }
        break;
      }
      case 'keeper': {
        this.att = 1;
        m.field([[0], [9, 10]]);
        const goal = -gx;
        const k = this.pick(0, 0);
        this.put(k, goal + 0.8, 0, 0, 0);
        m.setControlled(k);
        const shooter = this.pick(1, 9);
        const mate = this.pick(1, 10);
        if (rng.next() < 0.6) {
          // A strike from outside the box, a team-mate lurking for the rebound.
          const depth = 17 + rng.next() * 11;
          const z = (rng.next() * 2 - 1) * 14;
          this.put(mate, goal + 12, -Math.sign(z || 1) * 7, goal, 0);
          this.attack(shooter, goal + depth, z, goal);
          shooter.plan = { type: 'shot', dirX: -1, dirZ: rng.next() < 0.5 ? -1 : 1, power: 0.7 + rng.next() * 0.3, targetId: -1, expires: m.time + 3 };
        } else {
          // A break: one or two of them running at you.
          const z = (rng.next() * 2 - 1) * 8;
          const pair = rng.next() < 0.5;
          this.put(mate, pair ? goal + 31 : goal + 60, pair ? z + (z > 0 ? -10 : 10) : 30, goal, 0);
          this.attack(shooter, goal + 33, z, goal);
        }
        break;
      }
    }
    this.scores = [m.teams[0].score, m.teams[1].score];
  }

  /** The player in shirt slot `index` of `team` (taking part or not). */
  private pick(team: number, index: number): Player {
    return this.m.all.find((p) => p.team === team && p.index === index)!;
  }

  private put(p: Player, x: number, z: number, lookX: number, lookZ: number): void {
    p.pos.set(x, 0, z);
    p.prevPos.copy(p.pos);
    p.vel.set(0, 0, 0);
    p.facing = Math.atan2(lookZ - z, lookX - x);
    p.prevFacing = p.facing;
  }

  /** Open play: `p` on the ball at (x, z), facing the goal at `goal`. */
  private attack(p: Player, x: number, z: number, goal: number): void {
    const m = this.m;
    this.put(p, x, z, goal, 0);
    const d = Math.hypot(goal - x, z) || 1;
    m.ball.reset(x + ((goal - x) / d) * 0.7, z - (z / d) * 0.7);
    m.ball.pos.y = BALL.radius;
    m.phase = 'play';
    m.phaseT = 0;
    m.possTeam = p.team;
    if (p.team === m.humanTeam) m.setControlled(p);
  }
}
