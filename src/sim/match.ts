import { Ball } from './ball';
import { BALL, DT, GOAL_SEQ, MATCH, PITCH, PLAYER } from './constants';
import { Btn, type InputState } from './input';
import { solveFreeKick, solveGroundPass, solveLofted, solveShot } from './kick';
import { Player, type Attributes, type KickPlan, type Role } from './player';
import { FORMATION_433, HAIR_COLORS, SKIN_TONES, TEAMS, makeAttributes, type TeamInfo } from './teams';
import { V3, Rng, angleDiff, clamp, dist2D, smoothstep } from './vec';
import { AI } from './ai';

export type Phase = 'kickoff' | 'play' | 'out' | 'setpiece' | 'goal' | 'halftime' | 'fulltime';
export type SetPieceKind = 'kickoff' | 'throw' | 'corner' | 'goalkick' | 'freekick' | 'penalty';

export interface SetPiece {
  kind: SetPieceKind;
  team: number;
  x: number;
  z: number;
  taker: Player;
  t: number;
  /** Free kick in shooting range: the defending wall (players and their spots). */
  wall?: { players: Player[]; slots: [number, number][] };
  /** Free kick close enough to shoot at goal. */
  direct?: boolean;
  /** Human dead-ball shot: the aim point on the goal mouth (world z, height). */
  aimZ?: number;
  aimY?: number;
}

/** The last foul given (for the HUD, the referee and the commentary of the moment). */
export interface Foul {
  offender: Player;
  victim: Player;
  x: number;
  z: number;
  yellow: boolean;
  penalty: boolean;
  time: number;
}

/** One player of a prepared line-up (club squads): who he is and where he plays. */
export interface SetupPlayer {
  name: string;
  number: number;
  attrs: Attributes;
  look: { skin: number; hair: number; hairStyle: number; height: number; build: number };
  role: Role;
  /** Preferred foot: 1 right, -1 left. */
  foot?: number;
  /** Formation slot, team frame. */
  x: number;
  z: number;
}

export interface TeamSetup {
  info: TeamInfo;
  /** Eleven players in shirt-index order (0 keeper ... 9 striker; see meta/formations). */
  players: SetupPlayer[];
}

export interface MatchSetup {
  teams: [TeamSetup, TeamSetup];
}

export interface TeamState {
  info: TeamInfo;
  /** +1 attacks toward +x, -1 toward -x */
  dir: number;
  score: number;
  players: Player[];
}

export interface MatchEvents {
  kicks: number[]; // strengths 0..1
  whistle: number; // 0 none, 1 short, 2 long, 3 final
  goal: number; // team index or -1
  post: number;
  net: number;
  netX: number;
  netY: number;
  netZ: number;
  bounce: number;
  save: number;
  tackle: number;
  /** A foul was given (1) or the referee played advantage (2). */
  foul: number;
  /** A yellow card was shown. */
  card: number;
}

const tmpV = new V3();
/** Tackling leg (boot and shin) radius, and the radius of a standing player's legs. */
const TACKLE_LEG_R = 0.12;
const VICTIM_LEG_R = 0.2;

/** Ground distance from (x, z) to a segment. */
function segDist(x: number, z: number, s: { ax: number; az: number; bx: number; bz: number }): number {
  const vx = s.bx - s.ax;
  const vz = s.bz - s.az;
  const l2 = vx * vx + vz * vz;
  const t = l2 > 1e-9 ? clamp(((x - s.ax) * vx + (z - s.az) * vz) / l2, 0, 1) : 0;
  return Math.hypot(x - (s.ax + vx * t), z - (s.az + vz * t));
}

/** How long a human Pass/Shoot/Through stays queued waiting for the ball (s). */
const HUMAN_BUFFER = 2.5;
/** Extra reach given to the human's strikes so a queued command doesn't miss by inches. */
const HUMAN_STRIKE_REACH = 1.15;
const HUMAN_CONTACT_REACH = 1.6;

export class Match {
  readonly ball = new Ball();
  readonly players: Player[] = [];
  readonly teams: TeamState[] = [];
  readonly rng: Rng;
  readonly ai: AI;

  time = 0;
  clock = 0; // seconds into current half (real)
  half = 1;
  phase: Phase = 'kickoff';
  phaseT = 0;

  owner: Player | null = null;
  heldBy: Player | null = null;
  lastTouch: Player | null = null;
  lastKicker: Player | null = null;
  lastKickTime = -10;
  passTarget: Player | null = null;
  /** Team that last had controlled possession (for team shape). */
  possTeam = 0;
  setPiece: SetPiece | null = null;
  /** Restart waiting while the ball runs on after going out of play. */
  private pendingRestart: { kind: SetPieceKind; team: number; x: number; z: number } | null = null;
  kickoffTeam = 0;
  scorer: Player | null = null;
  /** Yellow cards per player id. */
  readonly cards: number[] = new Array(22).fill(0);
  lastFoul: Foul | null = null;
  /** Advantage being played after a foul: brought back if the fouled team loses the ball. */
  advantage: { team: number; x: number; z: number; penalty: boolean; until: number } | null = null;
  /** Who struck the last shot (headers included); see `shotTeam`. */
  private shotBy: Player | null = null;
  /** Wall players block (don't play) the ball until this time. */
  private wallUntil = -1;

  readonly humanTeam = 0;
  /** When true the AI also drives the "controlled" player (attract mode / tests). */
  autoPlay = false;
  controlled!: Player;
  pressHeld = false;
  private lastTackleTap = -10;
  /** Sprint-swipe tackle: committed, waiting for the moment to strike. */
  private lunge: { slide: boolean; until: number } | null = null;
  /** Seconds the stick has been idle (read by the AI for auto-switching). */
  noInputT = 0;
  /** Seconds since the controlled player changed (UI flash). */
  switchT = 0;

  events: MatchEvents = this.freshEvents();
  /** Optional debug logger (tests / dev console). */
  log: ((msg: string) => void) | null = null;
  /** 0..1 crowd excitement, rises with danger near goals */
  excitement = 0;

  constructor(seed = 20261002, setup?: MatchSetup) {
    this.rng = new Rng(seed);
    for (let t = 0; t < 2; t++) {
      const ts = setup?.teams[t];
      const team: TeamState = { info: ts ? ts.info : TEAMS[t], dir: t === 0 ? 1 : -1, score: 0, players: [] };
      if (ts) {
        ts.players.forEach((sp, i) => {
          const p = new Player(this.players.length, t, i, sp.role, sp.x, sp.z, sp.attrs, sp.look);
          p.name = sp.name;
          p.number = sp.number;
          p.foot = sp.foot === -1 ? -1 : 1;
          team.players.push(p);
          this.players.push(p);
        });
        this.teams.push(team);
        continue;
      }
      FORMATION_433.forEach((slot, i) => {
        const p = new Player(
          this.players.length,
          t,
          i,
          slot.role,
          slot.x,
          slot.z,
          makeAttributes(slot.role, this.rng),
          {
            skin: SKIN_TONES[Math.floor(this.rng.next() * SKIN_TONES.length)],
            hair: HAIR_COLORS[Math.floor(this.rng.next() * HAIR_COLORS.length)],
            hairStyle: Math.floor(this.rng.next() * 4),
            height: this.rng.range(0.95, 1.06) * (slot.role === 'GK' ? 1.04 : 1),
            build: this.rng.range(0.92, 1.1),
          },
        );
        p.attrs.height = 1.8 * p.look.height;
        p.attrs.weight = 76 * p.look.build * p.look.height * p.look.height;
        team.players.push(p);
        this.players.push(p);
      });
      this.teams.push(team);
    }
    this.ai = new AI(this);
    this.controlled = this.teams[this.humanTeam].players[9];
    this.startKickoff(0);
  }

  freshEvents(): MatchEvents {
    return { kicks: [], whistle: 0, goal: -1, post: 0, net: 0, netX: 0, netY: 0, netZ: 0, bounce: 0, save: 0, tackle: 0, foul: 0, card: 0 };
  }

  takeEvents(): MatchEvents {
    const e = this.events;
    this.events = this.freshEvents();
    return e;
  }

  // ------------------------------------------------------------------ helpers

  goalX(team: number): number {
    // The goal this team attacks.
    return this.teams[team].dir * PITCH.halfL;
  }

  /** Team that is currently in control or about to be (pass in flight). */
  attackingTeam(): number {
    if (this.heldBy) return this.heldBy.team;
    if (this.owner) return this.owner.team;
    if (this.setPiece) return this.setPiece.team;
    if (this.passTarget && this.time - this.lastKickTime < 3) return this.passTarget.team;
    return -1;
  }

  /**
   * Whether the human's buttons mean attack. Includes loose balls / passes in flight that
   * our side will reach first, so pressing Pass on an incoming ball queues a pass.
   */
  humanAttacking(): boolean {
    if (this.phase === 'kickoff') return true;
    const att = this.attackingTeam();
    if (att === this.humanTeam) return true;
    if (att >= 0) return false;
    const mine = this.ai.intercept[this.controlled.id];
    let theirs = 99;
    for (const q of this.teams[1 - this.humanTeam].players) {
      const ip = this.ai.intercept[q.id];
      if (ip.t >= 0 && ip.t < theirs) theirs = ip.t;
    }
    const mt = mine.t >= 0 ? mine.t : 99;
    return mt <= theirs + 0.25 || this.ballDist(this.controlled) < 1.5;
  }

  nearestOpponentDist(p: Player): number {
    let best = 99;
    for (const q of this.teams[1 - p.team].players) {
      const d = dist2D(p.pos.x, p.pos.z, q.pos.x, q.pos.z);
      if (d < best) best = d;
    }
    return best;
  }

  ballDist(p: Player): number {
    return dist2D(p.pos.x, p.pos.z, this.ball.pos.x, this.ball.pos.z);
  }

  // ------------------------------------------------------------------ restarts

  /** Where a player lines up for a kick-off taken by `kickTeam` (world). */
  kickoffSpot(p: Player, kickTeam: number, out: V3): V3 {
    const d = this.teams[p.team].dir;
    let x = Math.min(p.baseX * PITCH.halfL * 0.85, -1.5);
    let z = p.baseZ * PITCH.halfW * 0.8;
    if (p.index === 9 && p.team === kickTeam) {
      x = -0.3;
      z = 0.2;
    } else if (p.index === 7 && p.team === kickTeam) {
      x = -1.2;
      z = 6;
    } else if (Math.hypot(x, z) < PITCH.circleRadius + 0.5) {
      const s = (PITCH.circleRadius + 0.8) / Math.max(0.1, Math.hypot(x, z));
      x *= s;
      z *= s;
    }
    return out.set(x * d, 0, z * d);
  }

  private placeForKickoff(kickTeam: number): void {
    for (const team of this.teams) {
      for (const p of team.players) {
        this.kickoffSpot(p, kickTeam, p.pos);
        p.prevPos.copy(p.pos);
        p.vel.set(0, 0, 0);
        p.facing = team.dir > 0 ? 0 : Math.PI;
        p.prevFacing = p.facing;
        p.action = 'none';
        p.plan = null;
        p.lookAt = null;
      }
    }
  }

  startKickoff(team: number): void {
    this.phase = 'kickoff';
    this.phaseT = 0;
    this.kickoffTeam = team;
    this.placeForKickoff(team);
    this.ball.reset(0, 0);
    this.owner = null;
    this.heldBy = null;
    this.passTarget = null;
    this.lastTouch = null;
    this.possTeam = team;
    const taker = this.teams[team].players[9];
    this.setPiece = { kind: 'kickoff', team, x: 0, z: 0, taker, t: 0 };
    if (team === this.humanTeam) this.setControlled(taker);
    else this.setControlled(this.teams[this.humanTeam].players[9]);
    this.events.whistle = 1;
  }

  /** Ball out: let it run on into the boards / stands for a moment, then restart. */
  private ballOut(kind: SetPieceKind, team: number, x: number, z: number): void {
    this.pendingRestart = { kind, team, x, z };
    this.advantage = null;
    this.phase = 'out';
    this.phaseT = 0;
    this.owner = null;
    this.passTarget = null;
    this.events.whistle = 1;
    for (const p of this.players) p.plan = null;
  }

  private startSetPiece(kind: SetPieceKind, team: number, x: number, z: number): void {
    this.phase = 'setpiece';
    this.phaseT = 0;
    this.owner = null;
    this.passTarget = null;
    this.ball.vel.set(0, 0, 0);
    this.ball.spin.set(0, 0, 0);
    const dir = this.teams[team].dir;
    const goalX = PITCH.halfL * dir;
    const toGoal = dist2D(x, z, goalX, 0);
    // A free kick is "direct" when it's worth a shot: close enough and not too wide.
    const direct = kind === 'freekick' && toGoal < 32 && Math.abs(z) < 24 && (goalX - x) * dir > 9;
    let taker: Player;
    if (kind === 'goalkick') {
      taker = this.teams[team].players[0];
    } else if (kind === 'penalty' || direct) {
      // The specialist steps up: the best striker of a dead ball among those close enough.
      taker = this.teams[team].players[9];
      let best = -1e9;
      for (const p of this.teams[team].players) {
        if (p.role === 'GK') continue;
        const score = p.attrs.shooting * 0.7 + p.attrs.passing * 0.3 - dist2D(p.pos.x, p.pos.z, x, z) * 0.004;
        if (score > best) {
          best = score;
          taker = p;
        }
      }
    } else {
      // Nearest outfield player of the restarting team.
      taker = this.teams[team].players[1];
      let best = 1e9;
      for (const p of this.teams[team].players) {
        if (p.role === 'GK') continue;
        const d = dist2D(p.pos.x, p.pos.z, x, z);
        if (d < best) {
          best = d;
          taker = p;
        }
      }
    }
    this.setPiece = { kind, team, x, z, taker, t: 0, direct };
    this.possTeam = team;
    // Cut straight to the taker standing over the ball (like a broadcast replay cut).
    const f = this.setPieceFacing(this.setPiece);
    const spot = this.setPieceSpot(this.setPiece);
    taker.pos.set(spot.x, 0, spot.z);
    taker.prevPos.copy(taker.pos);
    taker.vel.set(0, 0, 0);
    taker.facing = spot.runUp ? Math.atan2(z - spot.z, x - spot.x) : Math.atan2(f.z, f.x);
    taker.prevFacing = taker.facing;
    taker.action = 'none';
    taker.plan = null;
    this.ball.reset(x, z);
    this.ball.pos.y = BALL.radius;
    this.heldBy = null;
    if (kind === 'penalty' || direct) {
      // Where the human starts aiming: free kicks over the wall to the far post, penalties
      // low to the keeper's right... well, the middle; the stick moves it.
      const near = Math.sign(z) || 1;
      this.setPiece.aimZ = kind === 'penalty' ? 0 : -near * (PITCH.goalHalfWidth - 0.7);
      this.setPiece.aimY = kind === 'penalty' ? 0.9 : 1.9;
    }
    if (kind === 'penalty') this.setupPenalty(this.setPiece);
    else if (direct) this.setupWall(this.setPiece);
    if (team === this.humanTeam) this.setControlled(taker);
    else if (this.setPiece.wall?.players.includes(this.controlled)) {
      // Defending a free kick: the wall is the AI's job; take the nearest free defender.
      const free = this.teams[this.humanTeam].players.filter((p) => p.role !== 'GK' && !this.setPiece!.wall!.players.includes(p));
      free.sort((a, b) => dist2D(a.pos.x, a.pos.z, x, z) - dist2D(b.pos.x, b.pos.z, x, z));
      if (free[0]) this.setControlled(free[0]);
    }
    this.events.whistle = 1;
  }

  /** Direction the taker faces over the ball. */
  setPieceFacing(sp: SetPiece): { x: number; z: number } {
    const dir = this.teams[sp.team].dir;
    let fx = dir;
    let fz = 0;
    if (sp.kind === 'throw') {
      fx = 0;
      fz = -Math.sign(sp.z);
    } else if (sp.kind === 'corner') {
      fx = -Math.sign(sp.x) * 0.6;
      fz = -Math.sign(sp.z);
    } else if (sp.kind === 'penalty' || sp.direct) {
      fx = PITCH.halfL * dir - sp.x;
      fz = -sp.z;
    }
    const n = Math.hypot(fx, fz) || 1;
    return { x: fx / n, z: fz / n };
  }

  /** How far behind the ball the taker waits (a run-up for shots from a dead ball). */
  setPieceBack(sp: SetPiece): number {
    return sp.kind === 'throw' ? 0.05 : sp.kind === 'penalty' ? 3.4 : sp.direct ? 4.4 : 0.45;
  }

  /**
   * Where the taker stands before a set piece. Shots from a dead ball get a real run-up:
   * a few strides back and off to the side of his kicking foot (a right-footer stands to
   * the left of the ball, around 35 degrees off the line), so he can swing through it.
   */
  setPieceSpot(sp: SetPiece): { x: number; z: number; runUp: boolean } {
    const f = this.setPieceFacing(sp);
    const back = this.setPieceBack(sp);
    const runUp = sp.kind === 'penalty' || !!sp.direct;
    // Right of the facing direction is (-f.z, f.x); the taker stands on his kicking foot's far side.
    const lat = runUp ? (sp.kind === 'penalty' ? 0.45 : 0.7) * back * sp.taker.foot : 0;
    return { x: sp.x - f.x * back + f.z * lat, z: sp.z - f.z * back - f.x * lat, runUp };
  }

  /** The human is lining up a dead-ball shot (third-person camera, aim reticle). */
  get aimingShot(): boolean {
    const sp = this.setPiece;
    return (
      !!sp && !this.autoPlay && this.phase === 'setpiece' && sp.team === this.humanTeam && sp.taker === this.controlled &&
      !sp.taker.plan && sp.taker.action === 'none' && (sp.kind === 'penalty' || !!sp.direct) && sp.aimZ !== undefined
    );
  }

  /** Aim point of a dead-ball shot in world coordinates. */
  aimPoint(): { x: number; y: number; z: number } | null {
    const sp = this.setPiece;
    if (!sp || sp.aimZ === undefined) return null;
    return { x: PITCH.halfL * this.teams[sp.team].dir, y: sp.aimY ?? 1, z: sp.aimZ };
  }

  /**
   * The wall: 9.15 m from the ball on the line to the goal, covering the near-post side
   * (the keeper takes the far side). Bigger the closer and more central the kick.
   */
  private setupWall(sp: SetPiece): void {
    const def = 1 - sp.team;
    const dir = this.teams[sp.team].dir;
    const gx = PITCH.halfL * dir;
    const d = dist2D(sp.x, sp.z, gx, 0);
    const central = 1 - Math.min(1, Math.abs(sp.z) / 22);
    const n = clamp(Math.round(1 + central * 3.2 - (d - 18) / 7), 1, 5);
    // Aim the wall at a point just inside the near post.
    const near = Math.sign(sp.z) || 1;
    const ax = gx;
    const az = near * (PITCH.goalHalfWidth * 0.45);
    const lx = ax - sp.x;
    const lz = az - sp.z;
    const ld = Math.hypot(lx, lz);
    const ux = lx / ld;
    const uz = lz / ld;
    const cx = sp.x + ux * 9.15;
    const cz = sp.z + uz * 9.15;
    // Perpendicular, ordered from the near-post side outward.
    let px = -uz;
    let pz = ux;
    if (Math.sign(pz) !== near) {
      px = -px;
      pz = -pz;
    }
    const slots: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const o = (i - (n - 1) / 2) * 0.62 + near * 0.3;
      slots.push([cx + px * o, cz + pz * o]);
    }
    const free = this.teams[def].players.filter((p) => p.role !== 'GK');
    free.sort((a, b) => dist2D(a.pos.x, a.pos.z, cx, cz) - dist2D(b.pos.x, b.pos.z, cx, cz));
    const players = free.slice(0, n);
    // Cut: the wall lines up while the taker places the ball.
    players.forEach((p, i) => {
      p.pos.set(slots[i][0], 0, slots[i][1]);
      p.prevPos.copy(p.pos);
      p.vel.set(0, 0, 0);
      p.facing = Math.atan2(sp.z - p.pos.z, sp.x - p.pos.x);
      p.prevFacing = p.facing;
      p.action = 'none';
    });
    sp.wall = { players, slots };
  }

  /** Penalty: everyone else outside the box and the arc; the keeper on his line. */
  private setupPenalty(sp: SetPiece): void {
    const dir = this.teams[sp.team].dir;
    const edge = (PITCH.halfL - PITCH.boxDepth - 1.5) * dir;
    let i = 0;
    for (const p of this.players) {
      if (p === sp.taker) continue;
      let x: number;
      let z: number;
      if (p.role === 'GK') {
        x = p.team === sp.team ? -dir * (PITCH.halfL - 12) : dir * (PITCH.halfL - 0.15);
        z = 0;
      } else {
        // Along the edge of the box, attackers and defenders shoulder to shoulder, leaving the arc clear.
        const k = i++;
        const side = k % 2 === 0 ? 1 : -1;
        const slot = Math.floor(k / 2);
        z = side * (10 + slot * 1.6);
        x = edge - dir * (Math.abs(z) > PITCH.boxHalfWidth ? 0 : 0.5 + (slot % 2) * 1.2);
      }
      p.pos.set(x, 0, clamp(z, -PITCH.halfW + 1, PITCH.halfW - 1));
      p.prevPos.copy(p.pos);
      p.vel.set(0, 0, 0);
      p.facing = Math.atan2(sp.z - p.pos.z, sp.x - p.pos.x);
      p.prevFacing = p.facing;
      p.action = 'none';
    }
  }

  setControlled(p: Player): void {
    if (this.controlled === p) return;
    if (this.controlled) {
      const old = this.controlled;
      old.sprinting = false;
      // A switch (manual or automatic) cancels whatever the human had loaded: a queued
      // pass or shot is dropped (unless the strike is already under way), and a button
      // still held from before the switch does nothing when it's released.
      if (!this.autoPlay && old.team === this.humanTeam && old.action !== 'kick' && old.action !== 'throw') old.plan = null;
    }
    this.controlled = p;
    this.switchT = 0;
  }

  // ------------------------------------------------------------------ main step

  step(input: InputState): void {
    this.time += DT;
    this.phaseT += DT;
    this.switchT += DT;
    const ball = this.ball;

    if (this.phase === 'play' || this.phase === 'out' || this.phase === 'setpiece' || this.phase === 'kickoff') {
      this.clock += DT;
    }

    // Half / full time.
    if (this.phase === 'play' && this.clock >= MATCH.halfSeconds) {
      if (this.half === 1) {
        this.phase = 'halftime';
        this.phaseT = 0;
        this.events.whistle = 2;
      } else {
        this.phase = 'fulltime';
        this.phaseT = 0;
        this.events.whistle = 3;
      }
    }
    if (this.phase === 'halftime' && this.phaseT > 3) {
      this.half = 2;
      this.clock = 0;
      for (const t of this.teams) t.dir = -t.dir;
      for (const p of this.players) p.stamina = Math.min(1, p.stamina + 0.4);
      this.startKickoff(1);
    }
    if (this.phase === 'out' && this.phaseT > 1.5 && this.pendingRestart) {
      const r = this.pendingRestart;
      this.pendingRestart = null;
      this.startSetPiece(r.kind, r.team, r.x, r.z);
    }
    if (this.phase === 'goal') {
      const kickTeam = this.scorer ? 1 - this.scorer.team : 0;
      // The cut (camera's on the crowd): ball back on the spot, players most of the way home.
      if (this.phaseT >= GOAL_SEQ.cut && this.phaseT - DT < GOAL_SEQ.cut) {
        this.ball.reset(0, 0);
        this.ball.pos.y = BALL.radius;
        for (const p of this.players) {
          this.kickoffSpot(p, kickTeam, tmpV);
          p.pos.set(tmpV.x + (p.pos.x - tmpV.x) * 0.3, 0, tmpV.z + (p.pos.z - tmpV.z) * 0.3);
          p.prevPos.copy(p.pos);
          p.vel.scale(0.3);
          p.action = 'none';
        }
      }
      if (this.phaseT > GOAL_SEQ.end) this.startKickoff(kickTeam);
    }

    // Set piece timer.
    if (this.setPiece) this.setPiece.t += DT;

    // Intents.
    this.applyHumanInput(input);
    this.ai.update();

    // Locomotion.
    for (const p of this.players) p.move(DT);
    this.collidePlayers();
    this.confineToPitch();

    // Action resolution (kicks, tackles).
    for (const p of this.players) this.resolveActions(p);

    // Ball.
    if (this.heldBy) {
      const h = this.heldBy;
      const hx = Math.cos(h.facing);
      const hz = Math.sin(h.facing);
      const throwIn = this.setPiece?.kind === 'throw';
      ball.prevPos.copy(ball.pos);
      ball.pos.set(h.pos.x + hx * 0.32, throwIn ? 2.05 : 1.15, h.pos.z + hz * 0.32);
      ball.vel.copy(h.vel);
      ball.spin.set(0, 0, 0);
      ball.onGround = false;
    } else if (this.phase === 'setpiece' || this.phase === 'kickoff') {
      ball.prevPos.copy(ball.pos);
    } else {
      ball.step(DT);
      this.consumeBallEvents();
      this.closeControl();
      if (this.phase === 'play' || this.phase === 'goal' || this.phase === 'fulltime' || this.phase === 'halftime') this.ballTouches();
    }

    if (this.phase === 'play') this.checkOutOfPlay();
    if (this.advantage) this.watchAdvantage();

    // A pass that has died short is just a loose ball: whoever's nearest goes for it.
    if (this.passTarget && !this.owner && this.ball.onGround && Math.hypot(this.ball.vel.x, this.ball.vel.z) < 1.8 && this.ballDist(this.passTarget) > 2.5) this.passTarget = null;

    // Ownership persistence.
    if (this.owner && this.ballDist(this.owner) > 3) this.owner = null;
    if (this.owner) this.possTeam = this.owner.team;
    if (this.heldBy) this.possTeam = this.heldBy.team;

    this.updateExcitement();
  }

  private consumeBallEvents(): void {
    const be = this.ball.events;
    if (be.bounce > 0) this.events.bounce = Math.max(this.events.bounce, be.bounce);
    if (be.post > 0) this.events.post = Math.max(this.events.post, be.post);
    if (be.net > 0) {
      this.events.net = Math.max(this.events.net, be.net);
      this.events.netX = be.netX;
      this.events.netY = be.netY;
      this.events.netZ = be.netZ;
    }
    be.bounce = 0;
    be.post = 0;
    be.net = 0;
  }

  private updateExcitement(): void {
    const b = this.ball;
    const att = this.attackingTeam();
    let target = 0.15;
    if (att >= 0 && this.phase === 'play') {
      const gx = this.goalX(att);
      const d = dist2D(b.pos.x, b.pos.z, gx, 0);
      target = 0.15 + 0.75 * (1 - smoothstep(10, 40, d));
    }
    if (this.phase === 'goal') target = 1;
    this.excitement += (target - this.excitement) * (1 - Math.exp(-DT * 1.5));
  }

  // ------------------------------------------------------------------ human control

  private applyHumanInput(input: InputState): void {
    const c = this.controlled;
    if (this.autoPlay) {
      input.events.length = 0;
      return;
    }
    const attacking = this.humanAttacking();
    const m = Math.hypot(input.moveX, input.moveY);
    if (m > 0.12) this.noInputT = 0;
    else this.noInputT += DT;

    // Buttons.
    for (const ev of input.events) {
      if (attacking) {
        if (ev.kind !== 'up') continue;
        // Pressed before the last player switch: cancelled by it.
        if (ev.hold > this.switchT + 0.05) continue;
        const ax = m > 0.12 ? input.moveX / m : Math.cos(c.facing);
        const az = m > 0.12 ? -input.moveY / m : Math.sin(c.facing);
        let plan: KickPlan | null = null;
        // Commands stay queued until the ball arrives (e.g. press Pass while it's coming).
        const exp = this.time + HUMAN_BUFFER;
        // Hold = pass weight; slide the finger up while holding = lofted.
        const weight = clamp(ev.hold / 0.6, 0, 1);
        if (ev.btn === Btn.A) plan = { type: ev.swipeUp ? 'lob' : 'pass', dirX: ax, dirZ: az, power: weight, targetId: -1, expires: exp };
        else if (ev.btn === Btn.B) plan = { type: 'through', dirX: ax, dirZ: az, power: weight, lofted: !!ev.swipeUp, targetId: -1, expires: exp };
        else if (ev.btn === Btn.C) plan = { type: 'shot', dirX: ax, dirZ: az, power: clamp(ev.hold / 0.85, 0.08, 1.15), targetId: -1, expires: exp };
        if (plan) {
          plan.aimed = m > 0.12;
          // On a set piece the button means "deliver it", not shoot at goal.
          // (Free kicks and penalties: Shoot is a shot.)
          const spk = this.setPiece?.kind;
          if (spk && spk !== 'freekick' && spk !== 'penalty' && plan.type === 'shot') plan.type = spk === 'corner' ? 'cross' : 'lob';
          if (this.heldBy === c && plan.type === 'shot') plan.type = 'clear';
          if (plan.type === 'shot' && this.aimingShot) {
            plan.aimZ = this.setPiece!.aimZ;
            plan.aimY = this.setPiece!.aimY;
            plan.aimed = true;
            plan.expires = this.time + 6;
          }
          c.plan = plan;
        }
      } else {
        if (ev.btn === Btn.B && ev.kind === 'down') this.manualSwitch();
        if (ev.btn === Btn.A && ev.kind === 'down') {
          const dbl = this.time - this.lastTackleTap < 0.32;
          this.lastTackleTap = this.time;
          this.humanTackle(dbl);
        }
      }
    }
    // Defence: the middle button presses; the big Sprint button sprints *and* presses.
    this.pressHeld = !attacking && (input.held[Btn.C] || input.sprint);
    input.events.length = 0;
    // Sliding down on Sprint commits to a tackle; sliding left commits to a slide tackle.
    if (input.tackleSwipe) {
      if (!attacking) {
        if (this.lunge && input.tackleSwipe === 'slide') this.lunge.slide = true;
        else this.lunge = { slide: input.tackleSwipe === 'slide', until: this.time + 0.75 };
      }
      input.tackleSwipe = null;
    }
    this.updateLunge(attacking);

    if (this.phase === 'goal' || this.phase === 'halftime' || this.phase === 'fulltime' || this.phase === 'out') {
      c.sprinting = false;
      if (this.phase === 'out') c.wantSpeed = Math.max(0, c.wantSpeed - DT * 6);
      return;
    }

    // Set piece taker stays on the ball. Lining up a shot: the stick moves the aim
    // (screen-relative in the third-person view: right is the taker's right, up is higher).
    if (this.setPiece && this.setPiece.taker === c) {
      const sp = this.setPiece;
      if (this.aimingShot && m > 0.12) {
        const dir = this.teams[sp.team].dir;
        const lim = PITCH.goalHalfWidth + 0.9;
        sp.aimZ = clamp((sp.aimZ ?? 0) + input.moveX * 3.4 * DT * dir, -lim, lim);
        sp.aimY = clamp((sp.aimY ?? 1) + input.moveY * 1.5 * DT, 0.2, PITCH.goalHeight + 0.5);
      }
      return;
    }

    // Movement.
    c.sprinting = input.sprint;
    c.lookAt = null;
    if (m > 0.12) {
      const mx = input.moveX / m;
      const mz = -input.moveY / m;
      c.moveX = mx;
      c.moveZ = mz;
      c.touchX = mx;
      c.touchZ = mz;
      const walk = Math.min(1, m / 0.85);
      c.wantSpeed = input.sprint ? c.topSpeed : PLAYER.jogSpeed * (0.35 + 0.65 * walk);
      if (this.owner === c && !input.sprint) c.wantSpeed *= PLAYER.dribbleSpeedFactor;
      // Dribbling: the stick sets where the next touch goes; between touches the player
      // runs onto the ball so turns become real cuts instead of running off without it.
      if (this.owner === c || (c.plan && this.owner === null && this.ballDist(c) < 3)) this.trackBall(c, mx, mz);
    } else {
      c.moveX = 0;
      c.moveZ = 0;
      c.wantSpeed = 0;
      if (this.owner === c || (c.plan && this.owner === null && this.ballDist(c) < 3)) {
        this.trackBall(c, Math.cos(c.facing), Math.sin(c.facing));
        if (this.ballDist(c) >= 0.55) c.wantSpeed = Math.max(c.wantSpeed, Math.min(PLAYER.jogSpeed, this.ballDist(c) * 3));
      }
    }

    if (!attacking && this.pressHeld) {
      // Contain: close down the ball, face it, hold a goal-side distance.
      this.ai.containTarget(c, tmpV);
      const dx = tmpV.x - c.pos.x;
      const dz = tmpV.z - c.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.3) {
        c.moveX = dx / d;
        c.moveZ = dz / d;
        c.wantSpeed = input.sprint ? c.topSpeed : Math.min(PLAYER.jogSpeed + 1, d * 2.5 + 1);
      }
      c.lookTarget.copy(this.ball.pos);
      c.lookAt = c.lookTarget;
    }

    // Ball seeking: the active player always hunts the ball (meets loose balls and
    // passes, closes down the carrier). The direction is 80% the seek and 20% the stick;
    // the stick mostly just nudges the pace (toward the ball = a bit faster).
    if (this.owner !== c && !this.pressHeld) {
      const mode = this.seekTarget(c, tmpV);
      if (mode) {
        const dx = tmpV.x - c.pos.x;
        const dz = tmpV.z - c.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.25) {
          const tx = dx / d;
          const tz = dz / d;
          let speed: number;
          if (mode === 'loose') {
            // Pace from what the intercept demands: reach the meeting point in time, plus a
            // margin so we attack the ball rather than wait for it.
            const ip = this.ai.intercept[c.id];
            const dI = dist2D(c.pos.x, c.pos.z, ip.x, ip.z);
            const need = ip.t >= 0 ? dI / Math.max(0.15, ip.t - 0.1) : c.topSpeed;
            // A slow or dying ball won't come to us: go and get it.
            const bs = Math.hypot(this.ball.vel.x, this.ball.vel.z);
            const gap = this.ballDist(c);
            const floor = gap > 3 ? PLAYER.jogSpeed + 2.2 : gap > 1 ? PLAYER.jogSpeed + (bs < 3 ? 1 : 0) : bs < 1.5 ? 2.5 : 1.2;
            speed = Math.max(floor, need + 1.5);
          } else {
            // Close down hard, then ease in tight on the carrier.
            speed = d > 5 ? PLAYER.jogSpeed + 2.2 : Math.min(PLAYER.jogSpeed + 1, d * 3 + 0.8);
          }
          let dirX = tx;
          let dirZ = tz;
          if (m > 0.12) {
            const sx = input.moveX / m;
            const sz = -input.moveY / m;
            const nx = tx * 0.8 + sx * 0.2;
            const nz = tz * 0.8 + sz * 0.2;
            const n = Math.hypot(nx, nz);
            if (n > 0.05) {
              dirX = nx / n;
              dirZ = nz / n;
            }
            speed *= 1 + 0.15 * (sx * tx + sz * tz);
          }
          c.moveX = dirX;
          c.moveZ = dirZ;
          c.wantSpeed = input.sprint ? c.topSpeed : Math.min(c.topSpeed, speed);
          if (mode === 'press' && d < 6) {
            c.lookTarget.copy(this.ball.pos);
            c.lookAt = c.lookTarget;
          }
        }
      }
    }
  }

  /** Where the active player should go to win the ball, if anywhere. */
  private seekTarget(c: Player, out: V3): 'loose' | 'press' | null {
    if (this.heldBy || this.phase !== 'play') return null;
    if (this.shotTeam() === c.team) return null; // our shot: don't run into its path
    const own = this.owner;
    if (own && own.team === c.team) return null;
    if (own) {
      this.ai.containTarget(c, out, 0.85);
      return 'press';
    }
    // Loose ball or a pass in flight: ours to meet, or theirs to intercept. A pass meant for a
    // teammate is his — unless we'd clearly get there first (it's under-hit, or coming our way).
    const pt = this.passTarget;
    if (pt && pt.team === c.team && pt !== c) {
      const mine = this.ai.intercept[c.id].t;
      const his = this.ai.intercept[pt.id].t;
      if (mine < 0 || (his >= 0 && mine > his - 0.3)) return null;
    }
    // Go and get it (see AI.meetPoint: the ball itself, led by how it's moving).
    this.ai.meetPoint(c, out);
    return 'loose';
  }

  /**
   * Close control for the human's dribbler: between touches the ball is gently drawn
   * toward a point just ahead of his feet, so it feels attached without being glued
   * (tackles, heavy first touches and big sprint pushes still separate it).
   */
  private closeControl(): void {
    const c = this.controlled;
    const b = this.ball;
    if (this.autoPlay || this.owner !== c || this.heldBy || c.isBusy() || !b.onGround) return;
    const gap = this.ballDist(c);
    if (gap > 1.8) return;
    const moving = c.wantSpeed > 0.3;
    const dx = moving ? c.touchX : Math.cos(c.facing);
    const dz = moving ? c.touchZ : Math.sin(c.facing);
    const lead = 0.45 + c.speed * 0.07;
    const px = c.pos.x + dx * lead;
    const pz = c.pos.z + dz * lead;
    const wantVx = c.vel.x + (px - b.pos.x) * 3.5;
    const wantVz = c.vel.z + (pz - b.pos.z) * 3.5;
    const k = 1 - Math.exp(-DT * 1.25);
    b.vel.x += (wantVx - b.vel.x) * k;
    b.vel.z += (wantVz - b.vel.z) * k;
    // Keep the spin consistent with rolling so the ball doesn't skid oddly.
    b.spin.z = -b.vel.x / BALL.radius;
    b.spin.x = b.vel.z / BALL.radius;
  }

  /** Steer a ball-carrier onto the ball when it isn't at his feet. */
  private trackBall(c: Player, mx: number, mz: number): void {
    const b = this.ball;
    c.touchX = mx;
    c.touchZ = mz;
    const gap = this.ballDist(c);
    if (gap < 0.55) return;
    const look = clamp(gap / Math.max(1, c.speed + 1), 0.05, 0.4);
    const bx = b.pos.x + b.vel.x * look - c.pos.x;
    const bz = b.pos.z + b.vel.z * look - c.pos.z;
    const bd = Math.hypot(bx, bz);
    if (bd < 0.01) return;
    // Mostly toward the ball, a little toward the stick so the body is set for the next touch.
    const w = gap > 1.2 ? 0.85 : 0.65;
    const nx = mx * (1 - w) + (bx / bd) * w;
    const nz = mz * (1 - w) + (bz / bd) * w;
    const n = Math.hypot(nx, nz) || 1;
    c.moveX = nx / n;
    c.moveZ = nz / n;
    // If the ball is running away, chase it at least at its pace.
    const bs = Math.hypot(b.vel.x, b.vel.z);
    if (gap > 1.0) c.wantSpeed = Math.max(c.wantSpeed, Math.min(c.topSpeed, bs + 1.2));
  }

  private manualSwitch(): void {
    const team = this.teams[this.humanTeam].players;
    let best: Player | null = null;
    let bestScore = 1e9;
    for (const p of team) {
      if (p === this.controlled || p.role === 'GK') continue;
      const ip = this.ai.intercept[p.id];
      const score = ip.t >= 0 ? ip.t : 5 + this.ballDist(p) / 8;
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (best) this.setControlled(best);
  }

  private humanTackle(slide: boolean): void {
    const c = this.controlled;
    if (c.isBusy()) return;
    const tx = this.ball.pos.x - c.pos.x;
    const tz = this.ball.pos.z - c.pos.z;
    const d = Math.max(0.01, Math.hypot(tx, tz));
    this.startTackle(c, tx / d, tz / d, slide);
  }

  /**
   * The sprint-swipe tackle is a commitment, not a button-mash: the defender keeps pressing
   * and strikes at the right moment — the ball within reach and not tucked away behind the
   * carrier's body (or he's simply right on it). If the moment doesn't come within the
   * window he makes a last stretch when it's close, otherwise he holds his feet.
   */
  private updateLunge(attacking: boolean): void {
    const L = this.lunge;
    if (!L) return;
    const c = this.controlled;
    if (attacking || this.phase !== 'play') {
      this.lunge = null;
      return;
    }
    if (c.isBusy()) return;
    const d = this.ballDist(c);
    const b = this.ball.pos;
    if (this.time > L.until) {
      if (d < (L.slide ? 3.2 : 2.3) && b.y < 0.7) this.lungeAt(c, L.slide);
      this.lunge = null;
      return;
    }
    const reach = L.slide ? 2.8 : 1.5;
    if (d > reach || b.y > 0.7) return;
    const carrier = this.owner;
    let open = true;
    if (carrier && carrier.team !== c.team) {
      // Shielded: the carrier's body is between us and the ball.
      const cx = carrier.pos.x - c.pos.x;
      const cz = carrier.pos.z - c.pos.z;
      const cd = Math.hypot(cx, cz);
      const behind = cd < d && ((cx * (b.x - c.pos.x) + cz * (b.z - c.pos.z)) / (cd * d + 1e-6)) > 0.85;
      open = !behind || this.ballDist(carrier) > 0.5;
    }
    if (open || d < reach * 0.6) {
      this.lungeAt(c, L.slide);
      this.lunge = null;
    }
  }

  /** Strike toward where the ball will be as the foot arrives. */
  private lungeAt(c: Player, slide: boolean): void {
    const lead = slide ? 0.28 : 0.15;
    const tx = this.ball.pos.x + this.ball.vel.x * lead - c.pos.x;
    const tz = this.ball.pos.z + this.ball.vel.z * lead - c.pos.z;
    const d = Math.max(0.01, Math.hypot(tx, tz));
    this.startTackle(c, tx / d, tz / d, slide);
  }

  startTackle(p: Player, dx: number, dz: number, slide: boolean): void {
    p.facing = Math.atan2(dz, dx);
    if (slide) p.startAction('slide', 1.0, dx, dz);
    else p.startAction('tackle', 0.42, dx, dz);
  }

  // ------------------------------------------------------------------ physics between players

  private collidePlayers(): void {
    const ps = this.players;
    const minD = PLAYER.radius * 2;
    for (let i = 0; i < ps.length; i++) {
      const a = ps[i];
      for (let j = i + 1; j < ps.length; j++) {
        const b = ps[j];
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= minD * minD || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d;
        const nz = dz / d;
        const overlap = minD - d;
        // Stronger players move less.
        const wa = 1 - a.duelStrength * 0.5;
        const wb = 1 - b.duelStrength * 0.5;
        const sa = wa / (wa + wb);
        a.pos.x -= nx * overlap * sa;
        a.pos.z -= nz * overlap * sa;
        b.pos.x += nx * overlap * (1 - sa);
        b.pos.z += nz * overlap * (1 - sa);
        // Remove closing velocity.
        const rv = (b.vel.x - a.vel.x) * nx + (b.vel.z - a.vel.z) * nz;
        if (rv < 0) {
          a.vel.x += nx * rv * sa;
          a.vel.z += nz * rv * sa;
          b.vel.x -= nx * rv * (1 - sa);
          b.vel.z -= nz * rv * (1 - sa);
          // A real shoulder-to-shoulder impact can knock the weaker / slower-braced player
          // off balance (and off the ball).
          if (rv < -3.2) this.bump(a, b, -rv);
        }
      }
    }
  }

  private bump(a: Player, b: Player, impact: number): void {
    if (a.team === b.team || a.balanceCD > 0 || b.balanceCD > 0) return;
    // Who gives way: strength, body weight, momentum into the contact and a little luck.
    const sa = a.duelStrength + (a.speed * a.attrs.weight) / 1500 + this.rng.next() * 0.35;
    const sb = b.duelStrength + (b.speed * b.attrs.weight) / 1500 + this.rng.next() * 0.35;
    const loser = sa < sb ? a : b;
    a.balanceCD = b.balanceCD = 1.2;
    if (this.rng.next() > clamp((impact - 3.2) / 3, 0.15, 0.75)) return;
    if (loser.action === 'none') loser.startAction('stumble', 0.4 + impact * 0.04, 0, 0);
    if (this.owner === loser) {
      this.owner = null;
      const b2 = this.ball;
      b2.vel.x += (this.rng.next() - 0.5) * 3;
      b2.vel.z += (this.rng.next() - 0.5) * 3;
    }
    this.events.tackle = Math.max(this.events.tackle, 0.5);
  }

  private confineToPitch(): void {
    const lx = PITCH.halfL + 4;
    const lz = PITCH.halfW + 3;
    for (const p of this.players) {
      if (p.pos.x > lx) p.pos.x = lx;
      if (p.pos.x < -lx) p.pos.x = -lx;
      if (p.pos.z > lz) p.pos.z = lz;
      if (p.pos.z < -lz) p.pos.z = -lz;
    }
  }

  // ------------------------------------------------------------------ actions

  /**
   * How long a strike takes: wind-up + swing to contact, then the follow-through. A pass is
   * a short, compact swing; a driven shot a full back-lift with the knee whipping through;
   * a dead-ball shot the fullest of all. Throws keep their old quick timing.
   */
  kickTiming(plan: KickPlan): { contact: number; follow: number } {
    const dead = this.setPiece && (this.setPiece.kind === 'penalty' || this.setPiece.direct) && plan.type === 'shot';
    if (this.heldBy && this.heldBy.plan === plan && !(plan.type === 'lob' || plan.type === 'clear')) return { contact: 0.15, follow: 0.12 };
    switch (plan.type) {
      case 'shot':
        return dead ? { contact: 0.24, follow: 0.42 } : { contact: 0.18 + 0.03 * Math.min(1, plan.power), follow: 0.34 };
      case 'lob':
      case 'cross':
      case 'clear':
        return { contact: 0.16, follow: 0.3 };
      case 'through':
        return plan.lofted ? { contact: 0.16, follow: 0.28 } : { contact: 0.13, follow: 0.2 };
      default:
        return { contact: 0.12, follow: 0.2 };
    }
  }

  /** Can the strike start now, i.e. will the ball be at the foot when the swing lands? */
  private kickable(p: Player, contactIn = 0.12, reach: number = PLAYER.reach): boolean {
    const b = this.ball;
    if (this.heldBy === p) return true;
    if (this.heldBy) return false;
    if (b.pos.y > 1.0) return false;
    const fx = b.pos.x + b.vel.x * contactIn - (p.pos.x + p.vel.x * 0.8 * contactIn);
    const fz = b.pos.z + b.vel.z * contactIn - (p.pos.z + p.vel.z * 0.8 * contactIn);
    const d = Math.hypot(fx, fz);
    if (d > reach) return false;
    if (this.setPiece && this.setPiece.taker !== p) return false;
    return true;
  }

  private resolveActions(p: Player): void {
    const human = p === this.controlled && !this.autoPlay;
    // Expire stale plans, and drop them if the other side has won the ball.
    if (p.plan && this.time > p.plan.expires) p.plan = null;
    if (p.plan && ((this.owner && this.owner.team !== p.team) || (this.heldBy && this.heldBy.team !== p.team))) p.plan = null;

    // Start a kick when the ball arrives in range: the wind-up and swing take `contactT`,
    // the follow-through the rest.
    const timing = p.plan ? this.kickTiming(p.plan) : null;
    const reach = human ? HUMAN_STRIKE_REACH : PLAYER.reach;
    if (p.plan && timing && !p.isBusy() && (p.touchCooldown <= 0 || p.sinceTouch > 0.12) && this.kickable(p, timing.contact, reach)) {
      if (this.setPiece && (this.setPiece.taker !== p || this.setPiece.t < 0.7)) return;
      const plan = p.plan;
      const dur = timing.contact + timing.follow;
      // From the hands: a throw (or a throw-in), except keepers punt long balls.
      const fromHands = this.heldBy === p;
      const punt = fromHands && !this.setPiece && (plan.type === 'lob' || plan.type === 'clear');
      const kind = fromHands && !punt ? 'throw' : 'kick';
      p.throwIn = this.setPiece?.kind === 'throw';
      // Strike with the preferred foot, unless the ball is well over on the other side
      // (then it's the weaker one). Dead balls: always the good foot.
      const side = -Math.sin(p.facing) * (this.ball.pos.x - p.pos.x) + Math.cos(p.facing) * (this.ball.pos.z - p.pos.z);
      const ballSide = side >= 0 ? 1 : -1;
      p.kickLeg = this.setPiece || Math.abs(side) < 0.32 || ballSide === p.foot ? p.foot : ballSide;
      p.kickWeak = p.kickLeg !== p.foot;
      p.startAction(kind, dur, plan.dirX, plan.dirZ);
      p.kickContact = kind === 'throw' ? dur * 0.55 : timing.contact;
      p.kickType = plan.type;
      p.kickPower = plan.power;
      p.kickLofted = plan.type === 'lob' || plan.type === 'cross' || plan.type === 'clear' || !!plan.lofted;
      p.kickRel = angleDiff(p.facing, Math.atan2(plan.dirZ, plan.dirX));
    }

    if ((p.action === 'kick' || p.action === 'throw') && !p.actionDone && p.actionT >= p.kickContact) {
      p.actionDone = true;
      const plan = p.plan;
      p.plan = null;
      const contact = human ? HUMAN_CONTACT_REACH : PLAYER.reach + 0.35;
      if (plan && (this.heldBy === p || (this.ballDist(p) < contact && this.ball.pos.y < 1.3))) this.performKick(p, plan);
      else if (plan && this.time < plan.expires) p.plan = plan; // missed it: stay queued and try again
    }

    if ((p.action === 'tackle' || p.action === 'slide') && !p.actionDone) {
      const slide = p.action === 'slide';
      const leg = this.tackleLeg(p);
      if (leg) {
        const b = this.ball;
        // The opponent it can catch: the carrier, or someone who's just got rid of it.
        const victim = this.owner && this.owner.team !== p.team ? this.owner
          : this.lastKicker && this.lastKicker.team !== p.team && this.time - this.lastKickTime < 0.6 ? this.lastKicker : null;
        // Contact means real contact: the leg capsule against his legs (not a radius round him).
        const bodyHit = !!victim && victim.action !== 'stumble' && victim.action !== 'fall' && segDist(victim.pos.x, victim.pos.z, leg) < TACKLE_LEG_R + VICTIM_LEG_R;
        const ballHit = !this.heldBy && b.pos.y < (slide ? 0.45 : 0.6) && segDist(b.pos.x, b.pos.z, leg) < TACKLE_LEG_R + BALL.radius + 0.04;
        if (ballHit || bodyHit) {
          p.actionDone = true;
          // The leg meets his legs: what that does to him is physics (see legImpact).
          const knock = bodyHit ? this.legImpact(p, victim!, slide) : 0;
          if (ballHit) this.resolveTackle(p, slide, bodyHit, knock);
          else {
            // Missed the ball but caught the man.
            const late = victim !== this.owner;
            if (this.phase === 'play' && this.rng.next() < this.foulChance(p, victim!, slide, false) + (late ? 0.2 : 0) + knock * 0.12) this.commitFoul(p, victim!, slide, late);
          }
        }
      }
    }
  }

  /**
   * The tackling leg as a capsule on the ground (hip to boot), extending and withdrawing
   * on the same timeline as the animation: a standing tackle reaches ~0.85 m in front of
   * the body (plus the lunge), a slide's straight leg ~1.05 m. Null while the leg isn't out.
   */
  private tackleLeg(p: Player): { ax: number; az: number; bx: number; bz: number } | null {
    const slide = p.action === 'slide';
    const pr = p.actionT / p.actionDur;
    const ext = slide ? smoothstep(0.04, 0.14, pr) * (1 - smoothstep(0.6, 0.76, pr)) : smoothstep(0.12, 0.42, pr) * (1 - smoothstep(0.62, 0.9, pr));
    if (ext < 0.35) return null;
    const dx = p.actionDirX;
    const dz = p.actionDirZ;
    const from = slide ? -0.15 : 0.15;
    const to = slide ? 0.2 + 0.85 * ext : 0.25 + 0.6 * ext;
    return { ax: p.pos.x + dx * from, az: p.pos.z + dz * from, bx: p.pos.x + dx * to, bz: p.pos.z + dz * to };
  }

  /**
   * The tackling leg meets the victim's legs. An inelastic hit: the closing speed of the
   * leg into him, shared by the two bodies' masses, is the shove his feet get. Taken at the
   * ankles (a slide) that shove has the most leverage to tip him; a block tackle meets him
   * higher and less squarely. He resists with strength and footing — braced on two feet
   * he takes a lot, mid-stride on one foot very little. Past his balance he goes down,
   * toppling toward where the tackle came from (his feet are swept from under him) and
   * carried a little by the hit; half of it is a stumble; less, he rides it.
   * Returns 0 (nothing), 1 (stumble) or 2 (down).
   */
  private legImpact(p: Player, victim: Player, slide: boolean): number {
    const dx = p.actionDirX;
    const dz = p.actionDirZ;
    const closing = Math.max(0, (p.vel.x - victim.vel.x) * dx + (p.vel.z - victim.vel.z) * dz);
    const mp = p.attrs.weight;
    const mv = victim.attrs.weight;
    const shove = (closing * mp) / (mp + mv); // m/s given to his feet
    const leverage = slide ? 1.0 : 0.55;
    const footing = 1 - clamp(victim.speed / 7, 0, 1); // 1 = planted, 0 = sprinting on one foot
    const balance = 1.1 + victim.duelStrength * 1.6 + footing * 0.9;
    const e = shove * leverage;
    if (e > balance) {
      const hard = clamp(e - balance, 0, 3);
      victim.startAction('fall', 1.15 + hard * 0.3, -dx, -dz);
      victim.vel.x = victim.vel.x * 0.6 + dx * shove * 0.5;
      victim.vel.z = victim.vel.z * 0.6 + dz * shove * 0.5;
      victim.touchCooldown = victim.actionDur;
      victim.plan = null;
      if (this.owner === victim) this.owner = null;
      return 2;
    }
    if (e > balance * 0.5) {
      victim.startAction('stumble', 0.35 + (e / balance) * 0.3, 0, 0);
      victim.vel.x += dx * shove * 0.3;
      victim.vel.z += dz * shove * 0.3;
      return 1;
    }
    return 0;
  }

  /** How the challenge comes in, relative to the victim's run: 1 = straight from behind. */
  private fromBehind(p: Player, victim: Player): number {
    const vf = victim.speed > 1 ? Math.atan2(victim.vel.z, victim.vel.x) : victim.facing;
    return Math.max(0, Math.cos(Math.atan2(p.actionDirZ, p.actionDirX) - vf));
  }

  /**
   * Chance that a challenge is a foul. Losing the duel and still going through means
   * contact; from behind, at speed and on the floor it's much likelier; good defenders time
   * it better. Winning the ball cleanly is fine — unless it's a slide through the back of him.
   */
  private foulChance(p: Player, victim: Player, slide: boolean, wonBall: boolean): number {
    const behind = this.fromBehind(p, victim);
    if (wonBall) return slide && behind > 0.6 ? 0.22 * behind : 0;
    let f = slide ? 0.5 : 0.26;
    f += behind * (slide ? 0.4 : 0.28);
    f += clamp((p.speed - 5) / 4, 0, 1) * 0.14;
    f -= p.attrs.defending * 0.16;
    return clamp(f, 0.02, 0.92);
  }

  /**
   * The team whose shot is in flight, or -1. A shot belongs to the goal: until somebody
   * else touches it (a block, a deflection, the keeper), the shooter's teammates neither
   * play it nor run onto it — it can still hit them on the way through.
   */
  shotTeam(): number {
    const s = this.shotBy;
    if (!s || this.lastTouch !== s || this.owner || this.heldBy || this.phase !== 'play') return -1;
    if (this.time - this.lastKickTime > 2.5 || Math.hypot(this.ball.vel.x, this.ball.vel.z) < 5) return -1;
    return s.team;
  }

  /** Penalty area of the goal `team` defends. */
  inPenaltyArea(team: number, x: number, z: number): boolean {
    const gx = -this.teams[team].dir * PITCH.halfL;
    return Math.abs(x - gx) < PITCH.boxDepth && Math.abs(z) < PITCH.boxHalfWidth;
  }

  /**
   * The referee's call. The victim goes down; a reckless one (from behind, on the floor, at
   * speed, late) is a yellow card; in the box it's a penalty. If the fouled side still has a
   * promising attack he waves play on — and comes back for the free kick if it breaks down.
   */
  private commitFoul(off: Player, victim: Player, slide: boolean, late: boolean): void {
    const x = clamp(victim.pos.x, -PITCH.halfL + 0.5, PITCH.halfL - 0.5);
    const z = clamp(victim.pos.z, -PITCH.halfW + 0.5, PITCH.halfW - 0.5);
    if (victim.action !== 'fall') victim.startAction('stumble', 1.1, 0, 0);
    victim.touchCooldown = Math.max(victim.touchCooldown, 1.1);
    victim.plan = null;
    const severity = (slide ? 0.35 : 0.1) + this.fromBehind(off, victim) * 0.4 + clamp((off.speed - 5) / 4, 0, 1) * 0.25 + (late ? 0.2 : 0);
    const yellow = this.rng.next() < clamp((severity - 0.5) * 1.5, 0, 0.85);
    if (yellow) {
      this.cards[off.id]++;
      this.events.card = 1;
    }
    const penalty = this.inPenaltyArea(off.team, x, z);
    this.lastFoul = { offender: off, victim, x, z, yellow, penalty, time: this.time };
    this.log?.(`${this.time.toFixed(1)} FOUL by T${off.team} #${off.index} on #${victim.index}${yellow ? ' (yellow)' : ''}${penalty ? ' PENALTY' : ''}`);
    if (!penalty && this.advantageOn(victim.team, victim)) {
      this.advantage = { team: victim.team, x, z, penalty, until: this.time + 3 };
      this.events.foul = 2;
      return;
    }
    this.events.foul = 1;
    this.whistleFoul(victim.team, x, z, penalty);
  }

  /** Would stopping play hurt the fouled team? (They're attacking and will get to the ball first.) */
  private advantageOn(team: number, victim: Player): boolean {
    const dir = this.teams[team].dir;
    if (this.ball.pos.x * dir < -12) return false;
    let mine = 9;
    let theirs = 9;
    for (const p of this.players) {
      if (p === victim || p.action === 'stumble' || p.action === 'fall' || p.action === 'slide') continue;
      const it = this.ai.intercept[p.id];
      const t = it.t >= 0 ? it.t : 9;
      if (p.team === team) mine = Math.min(mine, t);
      else theirs = Math.min(theirs, t);
    }
    return mine < theirs - 0.35;
  }

  /** Advantage: if the fouled team loses the ball soon after, go back for the free kick. */
  private watchAdvantage(): void {
    const a = this.advantage!;
    if (this.phase !== 'play' || this.time > a.until) {
      this.advantage = null;
      return;
    }
    const o = this.owner ?? this.heldBy;
    if (o && o.team !== a.team) {
      this.events.foul = 1;
      this.whistleFoul(a.team, a.x, a.z, a.penalty);
    }
  }

  private whistleFoul(team: number, x: number, z: number, penalty: boolean): void {
    if (penalty) this.ballOut('penalty', team, this.teams[team].dir * (PITCH.halfL - PITCH.penaltySpot), 0);
    else this.ballOut('freekick', team, x, z);
    // The referee stops it: the ball's taken out of play rather than left to roll on.
    this.ball.vel.scale(0.3);
  }

  /** Debug: a foul for the human team where the ball is right now. */
  debugFoul(): void {
    if (this.phase !== 'play') return;
    const b = this.ball.pos;
    const near = (team: number) => {
      let best = this.teams[team].players[1];
      let bd = 1e9;
      for (const p of this.teams[team].players) {
        if (p.role === 'GK') continue;
        const d = dist2D(p.pos.x, p.pos.z, b.x, b.z);
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      return best;
    };
    const victim = near(this.humanTeam);
    const off = near(1 - this.humanTeam);
    const x = clamp(b.x, -PITCH.halfL + 0.5, PITCH.halfL - 0.5);
    const z = clamp(b.z, -PITCH.halfW + 0.5, PITCH.halfW - 0.5);
    const penalty = this.inPenaltyArea(off.team, x, z);
    victim.startAction('stumble', 1.1, 0, 0);
    this.lastFoul = { offender: off, victim, x, z, yellow: false, penalty, time: this.time };
    this.events.foul = 1;
    this.whistleFoul(victim.team, x, z, penalty);
  }

  private resolveTackle(p: Player, slide: boolean, bodyHit: boolean, knock = 0): void {
    const b = this.ball;
    const carrier = this.owner && this.owner.team !== p.team ? this.owner : null;
    let win = 1;
    if (carrier) {
      // Shielding: is the carrier's body between the tackler and the ball?
      const toBallX = b.pos.x - p.pos.x;
      const toBallZ = b.pos.z - p.pos.z;
      const toCarrX = carrier.pos.x - p.pos.x;
      const toCarrZ = carrier.pos.z - p.pos.z;
      const dB = Math.hypot(toBallX, toBallZ);
      const dC = Math.hypot(toCarrX, toCarrZ);
      const shield = dC < dB && (toBallX * toCarrX + toBallZ * toCarrZ) / Math.max(0.01, dB * dC) > 0.8 ? 0.3 : 0;
      const close = this.ballDist(carrier) < 0.55 ? 0.12 : 0;
      win = 0.3 + p.attrs.defending * 0.35 + p.duelStrength * 0.06 - carrier.attrs.control * 0.18 - carrier.duelStrength * 0.1 - shield - close + (slide ? 0.12 : 0);
    }
    this.events.tackle = 1;
    const won = this.rng.next() < win;
    if (carrier && bodyHit && this.phase === 'play' && this.rng.next() < this.foulChance(p, carrier, slide, won) + knock * 0.12) {
      // Through the man (the leg caught him too): the ball doesn't matter, it's a foul.
      this.commitFoul(p, carrier, slide, false);
      if (!this.advantage) {
        p.action = slide ? 'slide' : 'stumble';
        p.actionDur = slide ? p.actionDur : 0.4;
        return;
      }
    }
    if (won) {
      const keep = !slide && this.rng.next() < 0.45;
      const a = Math.atan2(p.actionDirZ, p.actionDirX) + this.rng.gauss() * 0.6;
      const s = keep ? 1.2 : slide ? this.rng.range(5, 9) : this.rng.range(3, 6);
      b.kick(Math.cos(a) * s + p.vel.x * 0.4, 0, Math.sin(a) * s + p.vel.z * 0.4, 0, 0, 0);
      if (carrier && carrier.action === 'none') {
        carrier.startAction('stumble', 0.45, 0, 0);
        carrier.touchCooldown = 0.6;
      }
      this.owner = keep ? p : null;
      this.lastTouch = p;
      this.passTarget = null;
      p.touchCooldown = keep ? 0 : 0.2;
      if (keep && p.team === this.humanTeam) this.setControlled(p);
    } else {
      // Missed: committed and off balance.
      p.action = slide ? 'slide' : 'stumble';
      p.actionT = slide ? p.actionT : 0;
      p.actionDur = slide ? p.actionDur + 0.3 : 0.4;
    }
  }

  /** Executes the strike: solve the ideal ball, then add the striker's error. */
  performKick(p: Player, plan: KickPlan): void {
    const b = this.ball;
    const team = this.teams[p.team];
    const fromHands = this.heldBy === p;
    if (fromHands) {
      this.heldBy = null;
      b.onGround = false;
    }
    let vel: V3;
    let spin: V3;
    let receiver: Player | null = null;
    let base = 0.05;
    let skill = p.attrs.passing;
    let strength = 0.4;

    const opp = PITCH.halfL * team.dir;
    const setPieceKind = this.setPiece?.kind;

    if (plan.type === 'shot' && setPieceKind === 'penalty') {
      // Penalty: the stick picks the side (centre if it's idle), the hold picks the height and pace.
      skill = p.attrs.shooting;
      base = 0.035;
      const pw = plan.power;
      const side = Math.abs(plan.dirZ) > 0.3 ? Math.sign(plan.dirZ) : 0;
      // Aimed with the reticle: exactly there (plus the error model); otherwise stick side + hold.
      const tz = plan.aimZ ?? side * (PITCH.goalHalfWidth - 0.45 - (1 - Math.min(1, pw)) * 0.35);
      const ty = (plan.aimY ?? 0.25 + Math.min(pw, 1) * 1.7) + Math.max(0, pw - 1) * 7;
      const r = solveShot(b.pos, opp, ty, tz, 17 + Math.min(pw, 1.1) * 10, 4, 0);
      vel = r.vel;
      spin = r.spin;
      strength = 0.6 + pw * 0.4;
      this.ai.penaltyGuess(this.teams[1 - p.team].players[0], tz, ty);
    } else if (plan.type === 'shot' && setPieceKind === 'freekick' && this.setPiece?.direct) {
      // Direct free kick: over (or round) the wall, dipping under the bar, curling away from the keeper.
      skill = p.attrs.shooting * 0.6 + p.attrs.passing * 0.4;
      base = 0.045;
      const pw = plan.power;
      const near = Math.sign(b.pos.z) || 1;
      const side = plan.aimZ !== undefined ? Math.sign(plan.aimZ - b.pos.z * 0.15) || -near : Math.abs(plan.dirZ) > 0.3 ? Math.sign(plan.dirZ) : -near; // default: over the wall, far post
      const tz = plan.aimZ ?? side * (PITCH.goalHalfWidth - 0.55);
      // Curl: whipped away from the keeper toward the aimed side; the foot decides how it
      // bends naturally (a right foot's instep curls it right to left, a left foot the other way).
      const curl = -side * team.dir * (18 + 10 * (1 - Math.min(1, pw)));
      const speed = (19 + Math.min(pw, 1.1) * 8) * (0.9 + 0.2 * p.attrs.power);
      const r = solveFreeKick(b.pos, opp, tz, 9.15, 2.4, speed, curl, 9 + pw * 4, plan.aimY);
      vel = r.vel;
      // Leathered it: the extra power sends it over.
      if (pw > 1) vel.y += (pw - 1) * 9;
      spin = r.spin;
      strength = 0.6 + pw * 0.4;
    } else if (plan.type === 'shot') {
      skill = p.attrs.shooting;
      base = 0.055;
      const pw = plan.power;
      // Aim: stick sideways picks a post, otherwise the far post.
      let sideSign: number;
      if (Math.abs(plan.dirZ) > 0.35) sideSign = Math.sign(plan.dirZ);
      else sideSign = b.pos.z > 0.5 ? -1 : b.pos.z < -0.5 ? 1 : this.rng.next() < 0.5 ? -1 : 1;
      const tz = sideSign * (PITCH.goalHalfWidth - 0.55 - (1 - Math.min(1, pw)) * 0.4);
      const finesse = pw < 0.55;
      const ty = 0.35 + Math.min(pw, 1) * 1.45 + Math.max(0, pw - 1) * 6;
      // Shot power stat: the same swing sends the ball harder.
      const speed = (15 + Math.min(pw, 1.1) * 16) * (0.88 + 0.24 * p.attrs.power);
      // Finesse shots curl back toward goal; driven shots get topspin.
      const curlDir = -Math.sign(tz) * team.dir;
      const curl = finesse ? curlDir * 28 * (1 - pw) : 0;
      const top = finesse ? 4 : 6 + pw * 8;
      const r = solveShot(b.pos, opp, ty, tz, speed, top, curl);
      vel = r.vel;
      spin = r.spin;
      strength = 0.5 + pw * 0.5;
    } else if ((plan.type === 'lob' || plan.type === 'cross') && !fromHands && this.inCrossZone(p.team, b.pos.x, b.pos.z)) {
      // Cross: a lofted ball from the wide areas near the byline is whipped into the box.
      const c = this.planCross(p, plan);
      receiver = c.receiver;
      const r = solveLofted(b.pos, c.x, c.z, c.angle, 14, c.curl);
      vel = r.vel;
      spin = r.spin;
      base = 0.04;
      strength = 0.7;
    } else if (plan.type === 'clear') {
      const len = 38 * (0.8 + 0.4 * p.attrs.power);
      const tx = b.pos.x + plan.dirX * len;
      const tz = clamp(b.pos.z + plan.dirZ * len, -PITCH.halfW + 3, PITCH.halfW - 3);
      const r = solveLofted(b.pos, tx, tz, 34, 20, 0);
      vel = r.vel;
      spin = r.spin;
      base = 0.09;
      strength = 0.9;
    } else if (plan.type === 'through') {
      // Planned through ball: into space so the runner and the ball arrive together.
      const lofted = !!plan.lofted;
      const tp = this.ai.planThrough(
        p,
        plan.dirX,
        plan.dirZ,
        plan.aimed === true,
        plan.aimed === undefined ? 0.5 : plan.power,
        lofted,
        plan.targetId >= 0 ? this.players[plan.targetId] : null,
      );
      let r;
      if (tp) {
        receiver = tp.receiver;
        r = lofted ? solveLofted(b.pos, tp.x, tp.z, clamp(22 + dist2D(b.pos.x, b.pos.z, tp.x, tp.z) * 0.3, 26, 40), 45, 0) : solveGroundPass(b.pos, tp.x, tp.z, tp.arrive);
        this.ai.setRun(receiver, tp.x, tp.z, tp.time + 1.2);
      } else {
        // No runner: weighted into space along the stick.
        const len = 10 + 12 * plan.power;
        const tx = clamp(b.pos.x + plan.dirX * len, -PITCH.halfL + 2, PITCH.halfL - 2);
        const tz = clamp(b.pos.z + plan.dirZ * len, -PITCH.halfW + 2, PITCH.halfW - 2);
        r = lofted ? solveLofted(b.pos, tx, tz, 30, 40, 0) : solveGroundPass(b.pos, tx, tz, 2);
      }
      vel = r.vel;
      spin = r.spin;
      base = lofted ? 0.04 : 0.028;
      strength = lofted ? 0.6 : 0.4;
    } else {
      receiver =
        plan.targetId >= 0
          ? this.players[plan.targetId]
          : plan.aimed === false
            ? this.ai.bestReceiver(p, false)
            : this.ai.pickReceiver(p, plan.dirX, plan.dirZ, false);
      if (!receiver) {
        // Nobody there: play it into space.
        const tx = clamp(b.pos.x + plan.dirX * 15, -PITCH.halfL, PITCH.halfL);
        const tz = clamp(b.pos.z + plan.dirZ * 15, -PITCH.halfW, PITCH.halfW);
        const r = solveGroundPass(b.pos, tx, tz, 4);
        vel = r.vel;
        spin = r.spin;
      } else {
        // Lead the receiver: iterate target with predicted travel time.
        let tx = receiver.pos.x;
        let tz = receiver.pos.z;
        const lofted = plan.type === 'lob' || plan.type === 'cross' || fromHands || setPieceKind === 'goalkick';
        // Pass weight: AI plays a normal weight; a human tap is soft, a full hold is firm.
        const weightK = 0.8 + 0.4 * (plan.aimed === undefined ? 0.5 : plan.power);
        if (plan.type === 'cross' || setPieceKind === 'corner') {
          // Into the box toward the receiver, a bit in front of goal.
          tx = clamp(tx, opp - team.dir * 14, opp - team.dir * 5);
          tz = clamp(tz, -8, 8);
        }
        let r = lofted ? solveLofted(b.pos, tx, tz, 30, 25, 0) : solveGroundPass(b.pos, tx, tz, 7);
        for (let i = 0; i < 2; i++) {
          const lt = Math.min(r.time, 2.5) * 0.85;
          const ax = receiver.pos.x + receiver.vel.x * lt;
          const az = receiver.pos.z + receiver.vel.z * lt;
          const dd = dist2D(b.pos.x, b.pos.z, ax, az);
          if (lofted) {
            const angle = setPieceKind === 'goalkick' ? 34 : fromHands && this.setPiece?.kind === 'throw' ? 18 : clamp(16 + dd * 0.45, 20, 38);
            r = solveLofted(b.pos, ax, az, angle, 25, 0);
          } else {
            r = solveGroundPass(b.pos, ax, az, clamp(5.5 + dd * 0.14, 6, 11) * weightK);
          }
        }
        vel = r.vel;
        spin = r.spin;
        base = lofted ? 0.045 : 0.03;
        strength = lofted ? 0.65 : 0.35;
      }
    }

    // ---- Error model: skill, body shape, running speed, pressure, first time.
    const kickYaw = Math.atan2(vel.z, vel.x);
    const bodyPen = smoothstep(0.8, 2.6, Math.abs(angleDiff(p.facing, kickYaw)));
    const runPen = p.speed / 9;
    const press = Math.max(0, 1.8 - this.nearestOpponentDist(p)) / 1.8;
    const relBall = Math.hypot(b.vel.x - p.vel.x, b.vel.z - p.vel.z);
    const ballPen = clamp(relBall / 12, 0, 1);
    const weak = p.kickWeak ? 1.35 : 1; // the weaker foot is less precise
    const sd = base * (1.3 - skill) * weak * (1 + bodyPen * 2.2 + runPen * 0.7 + press * 0.9 + ballPen * 0.9);
    const yawErr = this.rng.gauss() * sd;
    const pitchErr = this.rng.gauss() * sd * (plan.type === 'shot' ? 0.6 : 0.35);
    const speedErr = 1 + this.rng.gauss() * sd * 0.8;
    const hs = Math.hypot(vel.x, vel.z);
    const yaw = kickYaw + yawErr;
    const pitch = Math.atan2(vel.y, hs) + pitchErr;
    const sp = vel.len() * speedErr;
    const vx = Math.cos(yaw) * Math.cos(pitch) * sp;
    const vz = Math.sin(yaw) * Math.cos(pitch) * sp;
    const vy = vel.y === 0 && pitchErr < 0 ? 0 : Math.sin(pitch) * sp;
    b.kick(vx, Math.max(0, vy), vz, spin.x, spin.y, spin.z);

    this.events.kicks.push(strength);
    this.log?.(`${this.time.toFixed(1)} T${p.team} #${p.index} ${plan.type}${receiver ? ' -> #' + receiver.index : ''} from ${b.pos.x.toFixed(0)},${b.pos.z.toFixed(0)} v=${b.vel.len().toFixed(1)}`);
    this.owner = null;
    this.lastTouch = p;
    this.lastKicker = p;
    this.lastKickTime = this.time;
    this.passTarget = receiver;
    this.shotBy = plan.type === 'shot' ? p : null;
    p.touchCooldown = 0.35;
    p.sinceTouch = 0;
    if (this.setPiece) {
      // The wall jumps as the ball's struck (most of them) and holds its shape for a moment.
      for (const w of this.setPiece.wall?.players ?? []) {
        if (this.rng.next() < 0.8) w.startAction('header', 0.62, 0, 0);
        w.touchCooldown = 0;
      }
      if (this.setPiece.wall) this.wallUntil = this.time + 0.7;
      this.setPiece = null;
      this.phase = 'play';
    }
    if (receiver && receiver.team === this.humanTeam) this.setControlled(receiver);
  }

  // ------------------------------------------------------------------ ball contact

  private wantsBall(p: Player): boolean {
    if (p === this.owner) return true;
    // Our own shot on its way to goal: let it through (the body can still block it).
    if (p.team === this.shotTeam()) return false;
    // The wall blocks with its body; it doesn't try to play the ball.
    if (this.time < this.wallUntil && p.action === 'header') return false;
    if (p.plan) return true;
    if (this.owner && this.owner.team === p.team) return false;
    if (this.passTarget === p) return true;
    if (p === this.controlled) return true;
    if (this.ai.chaser[p.team] === p) return true;
    if (p.role === 'GK') return true;
    // Opponents of the pass target will happily intercept.
    if (this.passTarget && this.passTarget.team !== p.team) return true;
    return this.owner === null && this.ballDist(p) < 1.2;
  }

  private ballTouches(): void {
    const b = this.ball;
    const h = b.pos.y;
    if (this.heldBy) return;

    // Keepers first: saves and catches.
    for (const t of this.teams) {
      const k = t.players[0];
      if (this.ai.keeperContact(k)) return;
    }

    // Closest eligible player gets the touch.
    let best: Player | null = null;
    let bestD = 1e9;
    for (const p of this.players) {
      if (p.touchCooldown > 0) continue;
      if (p.action === 'stumble' || p.action === 'fall' || p.action === 'slide' || p.action === 'dive' || p.action === 'kick' || p.action === 'throw') continue;
      const d = this.ballDist(p);
      const headMax = p.headReach;
      const headZone = h > PLAYER.controlHeight && h < headMax;
      const reach = headZone ? 0.6 : PLAYER.reach;
      if (d > reach || h > headMax) continue;
      if (!this.wantsBall(p)) {
        // Body deflection for anyone in the way.
        // Jumping (a wall, a block) reaches higher.
        const top = p.action === 'header' ? 2.3 : 1.85;
        if (d < PLAYER.radius + BALL.radius && h < top && p !== this.lastKicker) this.deflect(p);
        continue;
      }
      // Close control by the owner: opponents must tackle, not just touch.
      if (this.owner && this.owner !== p && this.owner.team !== p.team && this.ballDist(this.owner) < PLAYER.reach) continue;
      if (p.plan && h < 1.0) continue; // the plan will strike it
      // In the air the better jumper / taller player wins a close contest.
      const score = headZone ? d - (p.aerial - 0.5) * 0.35 : d;
      if (score < bestD) {
        bestD = score;
        best = p;
      }
    }
    if (!best) return;
    const p = best;
    if (h > PLAYER.controlHeight) {
      // Head it only when it makes sense; otherwise take it down on the chest.
      if (this.shouldHead(p)) this.header(p);
      else this.controlTouch(p);
      return;
    }
    if (p === this.owner) this.dribbleTouch(p);
    else this.controlTouch(p);
  }

  private deflect(p: Player): void {
    const b = this.ball;
    const dx = b.pos.x - p.pos.x;
    const dz = b.pos.z - p.pos.z;
    const d = Math.max(0.01, Math.hypot(dx, dz));
    const nx = dx / d;
    const nz = dz / d;
    const rv = (b.vel.x - p.vel.x) * nx + (b.vel.z - p.vel.z) * nz;
    if (rv >= 0) return;
    b.vel.x -= 1.45 * rv * nx;
    b.vel.z -= 1.45 * rv * nz;
    b.vel.x *= 0.55;
    b.vel.z *= 0.55;
    b.vel.y = Math.abs(b.vel.y) * 0.4 + Math.abs(rv) * 0.1;
    if (b.vel.y > 0.5) b.onGround = false;
    b.spin.scale(0.3);
    b.pos.x = p.pos.x + nx * (PLAYER.radius + BALL.radius + 0.01);
    b.pos.z = p.pos.z + nz * (PLAYER.radius + BALL.radius + 0.01);
    this.lastTouch = p;
    this.lastKicker = p;
    this.passTarget = null;
    if (this.owner && this.owner !== p) this.owner = null;
    this.events.kicks.push(clamp(-rv / 25, 0.1, 0.6));
  }

  /** Direction the player wants to take the ball (from stick or AI). */
  private dribbleDir(p: Player, out: V3): boolean {
    if (p.wantSpeed > 0.3 && (p.moveX !== 0 || p.moveZ !== 0)) {
      out.set(p.touchX, 0, p.touchZ);
      return true;
    }
    out.set(Math.cos(p.facing), 0, Math.sin(p.facing));
    return false;
  }

  private dribbleTouch(p: Player): void {
    const b = this.ball;
    const moving = this.dribbleDir(p, tmpV);
    const dx = tmpV.x;
    const dz = tmpV.z;
    const ps = p.speed;
    // Only touch when the ball is not already running away ahead of us.
    const relAlong = (b.vel.x - p.vel.x) * dx + (b.vel.z - p.vel.z) * dz;
    const toBallX = b.pos.x - p.pos.x;
    const toBallZ = b.pos.z - p.pos.z;
    const ahead = toBallX * dx + toBallZ * dz;
    if (moving && relAlong > 0.6 && ahead > 0.15) return;

    const ctrl = p.attrs.control;
    if (moving) {
      const sprint = p.sprinting && ps > PLAYER.jogSpeed;
      // Push the ball so the player meets it again on a later stride: the ball must cover
      // what the player covers in T seconds while grass and air slow it down.
      const target = Math.max(ps, Math.min(p.wantSpeed, ps + 2.5) * 0.85);
      // The human's player keeps it closer: shorter touches, more of them.
      const human = p === this.controlled && !this.autoPlay;
      const T = human ? (sprint ? 0.75 : target > 4 ? 0.5 : 0.4) : sprint ? 1.15 : target > 4 ? 0.8 : 0.6;
      const vEst = target + 1;
      const decel = BALL.rollDecel + 0.025 * vEst * vEst;
      const touchSpeed = target + (decel * T) / 2 + 0.35;
      // Changing direction at speed makes touches less precise.
      const ballYaw = ps > 0.5 ? Math.atan2(p.vel.z, p.vel.x) : Math.atan2(dz, dx);
      const turn = Math.abs(angleDiff(ballYaw, Math.atan2(dz, dx)));
      const sd = (0.035 + (1 - ctrl) * 0.09) * (1 + turn * (ps / 6) * 1.5) * (sprint ? 1.4 : 1) * (human ? 0.5 : 1);
      const a = Math.atan2(dz, dx) + this.rng.gauss() * sd;
      const s = touchSpeed * (1 + this.rng.gauss() * sd * 0.6);
      b.kick(Math.cos(a) * s, 0, Math.sin(a) * s, 0, 0, 0);
      b.spin.set(Math.sin(a) * s / BALL.radius, 0, (-Math.cos(a) * s) / BALL.radius);
      p.touchCooldown = sprint ? 0.32 : 0.2;
    } else {
      // Settle the ball under the body.
      b.kick(p.vel.x * 0.75, 0, p.vel.z * 0.75, 0, 0, 0);
      p.touchCooldown = 0.25;
    }
    p.sinceTouch = 0;
    this.lastTouch = p;
    this.events.kicks.push(0.08);
  }

  private controlTouch(p: Player): void {
    const b = this.ball;
    const h = b.pos.y;
    const relX = b.vel.x - p.vel.x;
    const relY = b.vel.y;
    const relZ = b.vel.z - p.vel.z;
    const rel = Math.sqrt(relX * relX + relY * relY + relZ * relZ);
    const q = p.attrs.control;
    const heightPen = h > 0.55 ? 0.6 : 0;
    const err = rel * (0.045 + (1 - q) * 0.08 + heightPen * 0.05) * Math.abs(1 + this.rng.gauss() * 0.5);
    this.dribbleDir(p, tmpV);
    const moving = p.wantSpeed > 0.3;
    const push = moving ? 1.0 + p.speed * 0.15 : 0.3;
    const ea = this.rng.next() * Math.PI * 2;
    b.kick(p.vel.x * 0.95 + tmpV.x * push + Math.cos(ea) * err, 0, p.vel.z * 0.95 + tmpV.z * push + Math.sin(ea) * err, 0, 0, 0);
    if (h > 0.3) {
      b.vel.y = -0.3;
      b.onGround = false;
    }
    p.touchCooldown = 0.18;
    p.sinceTouch = 0;
    this.owner = p;
    this.lastTouch = p;
    this.passTarget = null;
    this.possTeam = p.team;
    this.events.kicks.push(clamp(rel / 30, 0.05, 0.4));
    if (p.team === this.humanTeam) this.setControlled(p);
  }

  /**
   * Automatic headers are for real heading situations: a queued Pass/Shoot, a chance in
   * front of goal, a clearance under pressure, or a contested ball. A free high ball is
   * chested down instead, which stops endless heading rallies.
   */
  private shouldHead(p: Player): boolean {
    const b = this.ball;
    if (b.pos.y > 1.95) return true; // too high to chest
    if (p.plan) return true;
    const team = this.teams[p.team];
    const distGoal = dist2D(b.pos.x, b.pos.z, PITCH.halfL * team.dir, 0);
    if (distGoal < 18) return true;
    const press = this.nearestOpponentDist(p);
    const ownThird = b.pos.x * team.dir < -PITCH.halfL / 3;
    if (ownThird && press < 4) return true;
    return press < 1.8;
  }

  private header(p: Player): void {
    const b = this.ball;
    const team = this.teams[p.team];
    const gx = PITCH.halfL * team.dir;
    const distGoal = dist2D(b.pos.x, b.pos.z, gx, 0);
    let dirX: number;
    let dirZ: number;
    let speed: number;
    let up: number;
    const wantShot = (p.plan?.type === 'shot' || distGoal < (p === this.controlled ? 13 : 16)) && distGoal < 20;
    if (wantShot) {
      const tz = (this.rng.next() < 0.5 ? -1 : 1) * (PITCH.goalHalfWidth - 0.8);
      dirX = gx - b.pos.x;
      dirZ = tz - b.pos.z;
      speed = 10 + p.attrs.shooting * 5 + p.attrs.power * 3;
      up = -0.08;
    } else {
      const recv = this.ai.pickReceiver(p, p.plan ? p.plan.dirX : team.dir, p.plan ? p.plan.dirZ : 0, false);
      if (recv && dist2D(recv.pos.x, recv.pos.z, b.pos.x, b.pos.z) < 22) {
        dirX = recv.pos.x - b.pos.x;
        dirZ = recv.pos.z - b.pos.z;
      } else {
        dirX = team.dir;
        dirZ = -b.pos.z * 0.02;
      }
      speed = 9 + Math.min(1, Math.hypot(dirX, dirZ) / 25) * 5;
      // Nod it down to a teammate's feet; only clearances go high.
      const clearing = b.pos.x * team.dir < -PITCH.halfL / 3 && this.nearestOpponentDist(p) < 4;
      up = clearing ? 0.35 : 0.05;
    }
    const d = Math.max(0.01, Math.hypot(dirX, dirZ));
    const sd = 0.08 + (1 - (p.attrs.control * 0.4 + p.aerial * 0.6)) * 0.12;
    const a = Math.atan2(dirZ / d, dirX / d) + this.rng.gauss() * sd;
    b.kick(Math.cos(a) * speed, speed * up + this.rng.gauss() * 0.6, Math.sin(a) * speed, 0, 0, 0);
    b.onGround = false;
    p.startAction('header', 0.4, Math.cos(a), Math.sin(a));
    p.plan = null;
    p.touchCooldown = 0.4;
    p.sinceTouch = 0;
    this.owner = null;
    this.lastTouch = p;
    this.lastKicker = p;
    this.lastKickTime = this.time;
    this.passTarget = null;
    this.shotBy = wantShot ? p : null;
    this.events.kicks.push(0.35);
  }

  /** Within 40 m of one of the corner flags this team attacks (and in their half). */
  inCrossZone(team: number, x: number, z: number): boolean {
    const dir = this.teams[team].dir;
    if (x * dir < 12) return false;
    const gx = PITCH.halfL * dir;
    return Math.min(dist2D(x, z, gx, PITCH.halfW), dist2D(x, z, gx, -PITCH.halfW)) < 40;
  }

  /**
   * Picks who the cross is for and where to put it: aimed so the ball arrives around head
   * height as the receiver attacks it, driven for short crosses, floated for long ones, and
   * curling away from the keeper. The stick (if pushed) steers which runner it's for.
   */
  planCross(p: Player, plan: KickPlan): { receiver: Player | null; x: number; z: number; angle: number; curl: number } {
    const b = this.ball;
    const team = this.teams[p.team];
    const dir = team.dir;
    const gx = PITCH.halfL * dir;
    let best: Player | null = null;
    let bestS = -1e9;
    for (const q of team.players) {
      if (q === p || q.role === 'GK') continue;
      // Where he'll be when the ball gets there.
      const qx = q.pos.x + q.vel.x * 0.9;
      const qz = q.pos.z + q.vel.z * 0.9;
      const depth = (gx - qx) * dir; // metres from the goal line
      if (depth > 24 || depth < 1 || Math.abs(qz) > 22) continue;
      let open = 99;
      for (const o of this.teams[1 - p.team].players) open = Math.min(open, dist2D(o.pos.x, o.pos.z, qx, qz));
      const toGoal = dist2D(qx, qz, gx, 0);
      let sc = -toGoal * 0.12 + clamp(open / 3, 0, 1.2) + q.attrs.strength * 0.3 + (q.role === 'FWD' ? 0.4 : 0);
      if (plan.aimed) {
        const dx = qx - b.pos.x;
        const dz = qz - b.pos.z;
        const d = Math.max(0.1, Math.hypot(dx, dz));
        sc += ((dx * plan.dirX + dz * plan.dirZ) / d) * 1.5;
      }
      if (sc > bestS) {
        bestS = sc;
        best = q;
      }
    }
    // Aim point: the receiver's run, kept to the dangerous zone (between the six-yard line
    // and the penalty spot, inside the posts' width plus a bit). No one there: the spot.
    let tx: number;
    let tz: number;
    if (best) {
      const flight = 1.0 + dist2D(b.pos.x, b.pos.z, best.pos.x, best.pos.z) / 30;
      tx = best.pos.x + best.vel.x * flight * 0.8;
      tz = best.pos.z + best.vel.z * flight * 0.8;
    } else {
      tx = gx - dir * 10;
      tz = -Math.sign(b.pos.z || 1) * 2;
    }
    const depth = clamp((gx - tx) * dir, 4.5, 15);
    tx = gx - dir * depth;
    tz = clamp(tz, -10, 10);
    // Land a couple of metres beyond him so it reaches him at head height.
    let fx = tx - b.pos.x;
    let fz = tz - b.pos.z;
    const d = Math.max(1, Math.hypot(fx, fz));
    fx /= d;
    fz /= d;
    const beyond = d > 22 ? 2.6 : 1.8;
    const lx = tx + fx * beyond;
    const lz = tz + fz * beyond;
    const angle = clamp(12 + d * 0.45, 17, 31);
    // Curl away from the goal (and the keeper): right of travel is (-fz, fx).
    const curlSign = Math.sign(-fz * -dir) || 1;
    const curl = curlSign * (10 + Math.min(10, d * 0.3));
    if (best) {
      // Others attack the near post, far post and the edge of the area.
      const near = Math.sign(b.pos.z || 1);
      const spots: [number, number][] = [
        [gx - dir * 5.5, near * 2.5],
        [gx - dir * 7, -near * 3.5],
        [gx - dir * 13, 0],
      ];
      let k = 0;
      for (const q of team.players) {
        if (q === p || q === best || q.role === 'GK' || q.role === 'DEF' || k >= spots.length) continue;
        if (dist2D(q.pos.x, q.pos.z, gx, 0) > 34) continue;
        this.ai.setRun(q, spots[k][0], spots[k][1]);
        k++;
      }
    }
    return { receiver: best, x: lx, z: lz, angle, curl };
  }

  /** Keeper secures the ball in his hands. */
  catchBall(k: Player): void {
    if (k.role === 'GK' && k.action === 'none' && this.phase === 'play') {
      k.catchY = this.ball.pos.y;
      k.startAction('catch', 0.45, 0, 0);
    }
    this.heldBy = k;
    this.owner = null;
    this.passTarget = null;
    this.lastTouch = k;
    this.possTeam = k.team;
    this.ball.vel.set(0, 0, 0);
    this.ball.spin.set(0, 0, 0);
    if (k.team === this.humanTeam) this.setControlled(k);
  }

  // ------------------------------------------------------------------ rules

  private checkOutOfPlay(): void {
    const b = this.ball;
    const p = b.pos;
    // Goal.
    if (b.inGoal && Math.abs(p.x) > PITCH.halfL + BALL.radius) {
      const side = p.x > 0 ? 1 : -1;
      const scoringTeam = this.teams[0].dir === side ? 0 : 1;
      this.teams[scoringTeam].score++;
      this.scorer = this.lastTouch && this.lastTouch.team === scoringTeam ? this.lastTouch : this.teams[scoringTeam].players[9];
      this.phase = 'goal';
      this.phaseT = 0;
      this.owner = null;
      this.passTarget = null;
      this.events.goal = scoringTeam;
      this.events.whistle = 1;
      return;
    }
    if (Math.abs(p.z) > PITCH.halfW + BALL.radius) {
      const team = this.lastTouch ? 1 - this.lastTouch.team : 0;
      this.ballOut('throw', team, clamp(p.x, -PITCH.halfL + 1, PITCH.halfL - 1), Math.sign(p.z) * (PITCH.halfW + 0.3));
      return;
    }
    if (Math.abs(p.x) > PITCH.halfL + BALL.radius && !b.inGoal) {
      const side = p.x > 0 ? 1 : -1;
      const defending = this.teams[0].dir === side ? 1 : 0;
      const attacking = 1 - defending;
      if (this.lastTouch && this.lastTouch.team === defending) {
        this.ballOut('corner', attacking, side * (PITCH.halfL - 0.4), Math.sign(p.z || 1) * (PITCH.halfW - 0.4));
      } else {
        this.ballOut('goalkick', defending, side * (PITCH.halfL - 5.5), Math.sign(p.z || 1) * 5);
      }
    }
  }

  get displayMinute(): number {
    const m = (this.clock / MATCH.halfSeconds) * 45;
    return Math.floor(m) + (this.half === 2 ? 45 : 0);
  }
}
