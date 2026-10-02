import { PITCH, PLAYER } from '../sim/constants';
import type { Match } from '../sim/match';
import { Player } from '../sim/player';
import { V3, clamp } from '../sim/vec';

/**
 * Referee and assistant referees. Purely presentational: they use the same movement
 * physics as players (so they run, turn and side-step naturally) but they're not part of
 * the simulation — the ball and players pass straight through them and nobody reacts.
 *
 * - Referee: the classic diagonal system — stays 12–18 m from the ball, on the diagonal
 *   between the left wing of one half and the right wing of the other, never in the
 *   passing lanes; jogs, sprints when the play breaks away, faces the ball.
 * - Assistants: one per touchline, each covering a half, side-stepping along the line to
 *   stay level with the second-last defender (or the ball when it's beyond him).
 */
export class Officials {
  readonly ref: Player;
  readonly lines: Player[];
  readonly all: Player[];
  /** Arm signals: referee pointing for a restart, linesman's flag up. */
  refPoint = 0;
  refPointSide = 1;
  flagUp = [0, 0];
  private target = new V3();
  private adv = false;
  private lastPhase = '';

  constructor() {
    const attrs = { pace: 0.55, accel: 0.55, control: 0.5, passing: 0.5, shooting: 0.3, strength: 0.6, defending: 0.3, keeping: 0.2 };
    const look = (skin: number, hair: number, style: number) => ({ skin, hair, hairStyle: style, height: 1.0, build: 1.0 });
    this.ref = new Player(22, 2, 0, 'MID', 0, 0, attrs, look(0xe0ac7e, 0x2e1f15, 1));
    this.lines = [
      new Player(23, 2, 1, 'MID', 0, 0, attrs, look(0xc68a5c, 0x1b1410, 0)),
      new Player(24, 2, 2, 'MID', 0, 0, attrs, look(0xf1c9a5, 0x7a5532, 1)),
    ];
    this.all = [this.ref, ...this.lines];
    this.reset();
  }

  reset(): void {
    this.ref.pos.set(-4, 0, -9);
    this.lines[0].pos.set(0, 0, -(PITCH.halfW + 1.2)); // far touchline (in view)
    this.lines[1].pos.set(0, 0, PITCH.halfW + 1.2); // near touchline
    for (const o of this.all) {
      o.prevPos.copy(o.pos);
      o.vel.set(0, 0, 0);
    }
  }

  /** The foul behind the current stoppage, if any. */
  private recentFoul(m: Match) {
    const f = m.lastFoul;
    return f && m.time - f.time < 12 && (m.phase === 'out' || m.setPiece?.kind === 'freekick' || m.setPiece?.kind === 'penalty') ? f : null;
  }

  /** Second-last defender line (x) of the team defending the goal at side `s` (±1). */
  private offsideLine(m: Match, s: number): number {
    const team = m.teams[0].dir === s ? 1 : 0; // the team whose goal is at side s
    let a = -1e9;
    let b = -1e9;
    for (const p of m.teams[team].players) {
      const v = p.pos.x * s;
      if (v > a) {
        b = a;
        a = v;
      } else if (v > b) b = v;
    }
    return b * s;
  }

  update(m: Match, dt: number): void {
    if (dt <= 0) return;
    dt = Math.min(dt, 1 / 30);
    const ball = m.ball.pos;

    // Whistled restart: the referee points the way it goes; the linesman on that side
    // raises his flag for a throw / goal kick / corner on his half.
    if (m.phase !== this.lastPhase) {
      if (m.phase === 'out' || (m.phase === 'setpiece' && this.lastPhase !== 'out')) {
        this.refPoint = 2.2;
        const foul = this.recentFoul(m);
        const att = foul ? foul.victim.team : m.setPiece ? m.setPiece.team : m.possTeam;
        this.refPointSide = m.teams[att]?.dir ?? 1;
        const li = ball.z < 0 ? 0 : 1;
        if (!foul && (Math.abs(ball.z) > PITCH.halfW - 1 || Math.abs(ball.x) > PITCH.halfL - 1)) this.flagUp[li] = 2.0;
      }
      this.lastPhase = m.phase;
    }
    // Advantage: arm out toward the fouled side's attack, play on.
    if (m.advantage && !this.adv) {
      this.refPoint = 1.6;
      this.refPointSide = m.teams[m.advantage.team].dir;
    }
    this.adv = m.advantage !== null;
    this.refPoint = Math.max(0, this.refPoint - dt);
    this.flagUp[0] = Math.max(0, this.flagUp[0] - dt);
    this.flagUp[1] = Math.max(0, this.flagUp[1] - dt);

    // ---- referee
    const r = this.ref;
    if (m.phase === 'kickoff' || m.phase === 'halftime') {
      this.target.set(-3, 0, -10);
    } else if (m.phase === 'goal') {
      this.target.set(ball.x * 0.3, 0, -6);
    } else if (m.phase === 'fulltime') {
      this.target.copy(r.pos);
    } else {
      // Diagonal system: from the far-left corner region to the near-right one.
      const t = clamp(ball.x / PITCH.halfL, -1, 1);
      const diagZ = -t * 14;
      let tx = ball.x - Math.sign(ball.x || 1) * 6;
      let tz = diagZ;
      // Keep 12-18 m from the ball and out of the play.
      const dx = tx - ball.x;
      const dz = tz - ball.z;
      const d = Math.max(0.1, Math.hypot(dx, dz));
      const want = clamp(d, 12, 18);
      tx = ball.x + (dx / d) * want;
      tz = ball.z + (dz / d) * want;
      // After a foul he goes to the spot to manage the free kick (or to the box for a penalty).
      const foul = this.recentFoul(m);
      if (foul && (m.phase === 'out' || m.phase === 'setpiece')) {
        const fx = foul.penalty ? Math.sign(foul.x) * (PITCH.halfL - 14) : foul.x;
        const fz = foul.penalty ? -6 : foul.z;
        tx = fx + (fx > 0 ? -5 : 5);
        tz = fz + (fz > 0 ? -4 : 4);
      }
      if (m.setPiece?.kind === 'corner') {
        tx = Math.sign(m.setPiece.x) * (PITCH.halfL - 14);
        tz = -Math.sign(m.setPiece.z) * 6;
      }
      this.target.set(clamp(tx, -PITCH.halfL + 4, PITCH.halfL - 4), 0, clamp(tz, -PITCH.halfW + 3, PITCH.halfW - 3));
    }
    this.steer(r, this.target.x, this.target.z, 18);
    r.lookTarget.copy(ball);
    r.lookAt = r.lookTarget;

    // ---- assistant referees
    for (let i = 0; i < 2; i++) {
      const o = this.lines[i];
      // Line 0 covers the half at +x on the far touchline, line 1 the half at -x (near).
      const s = i === 0 ? 1 : -1;
      const off = this.offsideLine(m, s);
      let x = s > 0 ? Math.max(off, ball.x, 0) : Math.min(off, ball.x, 0);
      if (m.phase === 'kickoff') x = s * 12;
      x = clamp(x, -PITCH.halfL, PITCH.halfL);
      const z = (i === 0 ? -1 : 1) * (PITCH.halfW + 1.2);
      this.steer(o, x, z, 10);
      // Face across the pitch so moving along the line is a side-step.
      o.lookTarget.set(o.pos.x, 0, 0);
      o.lookAt = o.lookTarget;
    }

    for (const o of this.all) {
      o.move(dt);
      // Officials are rendered at their current position (no sim interpolation).
      o.prevPos.copy(o.pos);
      o.prevFacing = o.facing;
    }
  }

  private steer(o: Player, x: number, z: number, sprintAt: number): void {
    const dx = x - o.pos.x;
    const dz = z - o.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.4) {
      o.moveX = 0;
      o.moveZ = 0;
      o.wantSpeed = 0;
      return;
    }
    o.moveX = dx / d;
    o.moveZ = dz / d;
    o.wantSpeed = Math.min(d > sprintAt ? o.topSpeed : PLAYER.jogSpeed * 0.9, d * 1.4 + 0.4);
    o.sprinting = d > sprintAt;
  }
}
