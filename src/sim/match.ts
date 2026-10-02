import { Ball } from './ball';
import { BALL, DT, MATCH, PITCH, PLAYER } from './constants';
import { Btn, type InputState } from './input';
import { solveGroundPass, solveLofted, solveShot } from './kick';
import { Player, type KickPlan } from './player';
import { FORMATION_433, HAIR_COLORS, SKIN_TONES, TEAMS, makeAttributes, type TeamInfo } from './teams';
import { V3, Rng, angleDiff, clamp, dist2D, smoothstep } from './vec';
import { AI } from './ai';

export type Phase = 'kickoff' | 'play' | 'setpiece' | 'goal' | 'halftime' | 'fulltime';
export type SetPieceKind = 'kickoff' | 'throw' | 'corner' | 'goalkick';

export interface SetPiece {
  kind: SetPieceKind;
  team: number;
  x: number;
  z: number;
  taker: Player;
  t: number;
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
}

const tmpV = new V3();
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
  kickoffTeam = 0;
  scorer: Player | null = null;

  readonly humanTeam = 0;
  /** When true the AI also drives the "controlled" player (attract mode / tests). */
  autoPlay = false;
  controlled!: Player;
  pressHeld = false;
  private lastTackleTap = -10;
  /** Seconds the stick has been idle (read by the AI for auto-switching). */
  noInputT = 0;
  /** Seconds since the controlled player changed (UI flash). */
  switchT = 0;

  events: MatchEvents = this.freshEvents();
  /** Optional debug logger (tests / dev console). */
  log: ((msg: string) => void) | null = null;
  /** 0..1 crowd excitement, rises with danger near goals */
  excitement = 0;

  constructor(seed = 20261002) {
    this.rng = new Rng(seed);
    for (let t = 0; t < 2; t++) {
      const team: TeamState = { info: TEAMS[t], dir: t === 0 ? 1 : -1, score: 0, players: [] };
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
    return { kicks: [], whistle: 0, goal: -1, post: 0, net: 0, netX: 0, netY: 0, netZ: 0, bounce: 0, save: 0, tackle: 0 };
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

  private placeForKickoff(kickTeam: number): void {
    for (const team of this.teams) {
      const d = team.dir;
      for (const p of team.players) {
        let x = p.baseX * PITCH.halfL * 0.85;
        let z = p.baseZ * PITCH.halfW * 0.8;
        x = Math.min(x, -1.5);
        if (team.players.indexOf(p) === 9 && this.teams.indexOf(team) === kickTeam) {
          x = -0.3;
          z = 0.2;
        } else if (team.players.indexOf(p) === 7 && this.teams.indexOf(team) === kickTeam) {
          x = -1.2;
          z = 6;
        } else if (Math.hypot(x, z) < PITCH.circleRadius + 0.5) {
          const s = (PITCH.circleRadius + 0.8) / Math.max(0.1, Math.hypot(x, z));
          x *= s;
          z *= s;
        }
        p.pos.set(x * d, 0, z * d);
        p.prevPos.copy(p.pos);
        p.vel.set(0, 0, 0);
        p.facing = d > 0 ? 0 : Math.PI;
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

  private startSetPiece(kind: SetPieceKind, team: number, x: number, z: number): void {
    this.phase = 'setpiece';
    this.phaseT = 0;
    this.owner = null;
    this.passTarget = null;
    this.ball.vel.set(0, 0, 0);
    this.ball.spin.set(0, 0, 0);
    let taker: Player;
    if (kind === 'goalkick') {
      taker = this.teams[team].players[0];
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
    this.setPiece = { kind, team, x, z, taker, t: 0 };
    this.possTeam = team;
    // Cut straight to the taker standing over the ball (like a broadcast replay cut).
    const inX = kind === 'throw' ? 0 : kind === 'corner' ? -Math.sign(x) * 0.6 : this.teams[team].dir;
    const inZ = kind === 'throw' || kind === 'corner' ? -Math.sign(z) : 0;
    const n = Math.hypot(inX, inZ) || 1;
    const back = kind === 'throw' ? 0.05 : 0.45;
    taker.pos.set(x - (inX / n) * back, 0, z - (inZ / n) * back);
    taker.prevPos.copy(taker.pos);
    taker.vel.set(0, 0, 0);
    taker.facing = Math.atan2(inZ, inX);
    taker.prevFacing = taker.facing;
    taker.action = 'none';
    taker.plan = null;
    this.ball.reset(x, z);
    this.ball.pos.y = BALL.radius;
    this.heldBy = null;
    if (team === this.humanTeam) this.setControlled(taker);
    this.events.whistle = 1;
  }

  setControlled(p: Player): void {
    if (this.controlled === p) return;
    if (this.controlled) {
      const old = this.controlled;
      old.sprinting = false;
      // A queued command follows control (e.g. pressed Pass just before the auto-switch).
      if (old.plan && old.team === p.team && old.action !== 'kick' && old.action !== 'throw' && !p.plan && !this.autoPlay) {
        p.plan = old.plan;
        old.plan = null;
      }
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

    if (this.phase === 'play' || this.phase === 'setpiece' || this.phase === 'kickoff') {
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
    if (this.phase === 'goal' && this.phaseT > 3.6) {
      this.startKickoff(this.scorer ? 1 - this.scorer.team : 0);
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
        const ax = m > 0.12 ? input.moveX / m : Math.cos(c.facing);
        const az = m > 0.12 ? -input.moveY / m : Math.sin(c.facing);
        let plan: KickPlan | null = null;
        // Commands stay queued until the ball arrives (e.g. press Pass while it's coming).
        const exp = this.time + HUMAN_BUFFER;
        if (ev.btn === Btn.A) plan = { type: ev.hold > 0.22 ? 'lob' : 'pass', dirX: ax, dirZ: az, power: 0, targetId: -1, expires: exp };
        else if (ev.btn === Btn.B) plan = { type: 'through', dirX: ax, dirZ: az, power: ev.hold > 0.22 ? 1 : 0, targetId: -1, expires: exp };
        else if (ev.btn === Btn.C) plan = { type: 'shot', dirX: ax, dirZ: az, power: clamp(ev.hold / 0.85, 0.08, 1.15), targetId: -1, expires: exp };
        if (plan) {
          plan.aimed = m > 0.12;
          // On a set piece the button means "deliver it", not shoot at goal.
          if (this.setPiece && plan.type === 'shot') plan.type = this.setPiece.kind === 'corner' ? 'cross' : 'lob';
          if (this.heldBy === c && plan.type === 'shot') plan.type = 'clear';
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

    if (this.phase === 'goal' || this.phase === 'halftime' || this.phase === 'fulltime') {
      c.sprinting = false;
      return;
    }

    // Set piece taker stays on the ball.
    if (this.setPiece && this.setPiece.taker === c) return;

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
            const ip = this.ai.intercept[c.id];
            const t = ip.t >= 0 ? ip.t : d / c.topSpeed;
            // Attack loose balls: near-sprint when far, arrive under control when close.
            const floor = d > 3 ? PLAYER.jogSpeed + 2.2 : d > 1 ? PLAYER.jogSpeed : 0;
            speed = Math.max(floor, d / Math.max(0.2, t) + 2);
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
    const own = this.owner;
    if (own && own.team === c.team) return null;
    if (own) {
      this.ai.containTarget(c, out, 0.85);
      return 'press';
    }
    // Loose ball or a pass in flight: ours to meet, or theirs to intercept.
    if (this.passTarget && this.passTarget.team === c.team && this.passTarget !== c) return null;
    const ip = this.ai.intercept[c.id];
    if (ip.t >= 0) out.set(ip.x, 0, ip.z);
    else out.set(this.ball.pos.x + this.ball.vel.x * 0.5, 0, this.ball.pos.z + this.ball.vel.z * 0.5);
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
    const k = 1 - Math.exp(-DT * 2.5);
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
        const wa = 1 - a.attrs.strength * 0.5;
        const wb = 1 - b.attrs.strength * 0.5;
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
        }
      }
    }
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

    // Start a kick when the ball arrives in range.
    const planDur = p.plan ? (p.plan.type === 'shot' ? 0.3 : p.plan.type === 'lob' || p.plan.type === 'cross' || p.plan.type === 'clear' ? 0.27 : 0.2) : 0;
    const reach = human ? HUMAN_STRIKE_REACH : PLAYER.reach;
    if (p.plan && !p.isBusy() && (p.touchCooldown <= 0 || p.sinceTouch > 0.12) && this.kickable(p, planDur * 0.55, reach)) {
      if (this.setPiece && (this.setPiece.taker !== p || this.setPiece.t < 0.7)) return;
      const plan = p.plan;
      const dur = planDur;
      const kind = this.heldBy === p ? 'throw' : 'kick';
      // Strike with the foot on the side of the ball.
      const side = -Math.sin(p.facing) * (this.ball.pos.x - p.pos.x) + Math.cos(p.facing) * (this.ball.pos.z - p.pos.z);
      p.kickLeg = side >= 0 ? 1 : -1;
      p.startAction(kind, dur, plan.dirX, plan.dirZ);
    }

    if ((p.action === 'kick' || p.action === 'throw') && !p.actionDone && p.actionT >= p.actionDur * 0.55) {
      p.actionDone = true;
      const plan = p.plan;
      p.plan = null;
      const contact = human ? HUMAN_CONTACT_REACH : PLAYER.reach + 0.35;
      if (plan && (this.heldBy === p || (this.ballDist(p) < contact && this.ball.pos.y < 1.3))) this.performKick(p, plan);
      else if (plan && this.time < plan.expires) p.plan = plan; // missed it: stay queued and try again
    }

    if ((p.action === 'tackle' || p.action === 'slide') && !p.actionDone) {
      const slide = p.action === 'slide';
      const t0 = slide ? 0.08 : 0.1;
      const t1 = slide ? 0.55 : 0.3;
      if (p.actionT >= t0 && p.actionT <= t1) {
        const reachFwd = slide ? 0.9 : 0.55;
        const fx = p.pos.x + p.actionDirX * reachFwd;
        const fz = p.pos.z + p.actionDirZ * reachFwd;
        const b = this.ball;
        const d = dist2D(fx, fz, b.pos.x, b.pos.z);
        if (d < (slide ? 1.05 : 0.8) && b.pos.y < 0.7 && !this.heldBy) {
          p.actionDone = true;
          this.resolveTackle(p, slide);
        }
      }
    }
  }

  private resolveTackle(p: Player, slide: boolean): void {
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
      win = 0.32 + p.attrs.defending * 0.35 - carrier.attrs.control * 0.18 - carrier.attrs.strength * 0.08 - shield - close + (slide ? 0.12 : 0);
    }
    this.events.tackle = 1;
    if (this.rng.next() < win) {
      const keep = !slide && this.rng.next() < 0.45;
      const a = Math.atan2(p.actionDirZ, p.actionDirX) + this.rng.gauss() * 0.6;
      const s = keep ? 1.2 : slide ? this.rng.range(5, 9) : this.rng.range(3, 6);
      b.kick(Math.cos(a) * s + p.vel.x * 0.4, 0, Math.sin(a) * s + p.vel.z * 0.4, 0, 0, 0);
      if (carrier) {
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

    if (plan.type === 'shot') {
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
      const speed = 15 + Math.min(pw, 1.1) * 16;
      // Finesse shots curl back toward goal; driven shots get topspin.
      const curlDir = -Math.sign(tz) * team.dir;
      const curl = finesse ? curlDir * 28 * (1 - pw) : 0;
      const top = finesse ? 4 : 6 + pw * 8;
      const r = solveShot(b.pos, opp, ty, tz, speed, top, curl);
      vel = r.vel;
      spin = r.spin;
      strength = 0.5 + pw * 0.5;
    } else if (plan.type === 'clear') {
      const tx = b.pos.x + plan.dirX * 38;
      const tz = clamp(b.pos.z + plan.dirZ * 38, -PITCH.halfW + 3, PITCH.halfW - 3);
      const r = solveLofted(b.pos, tx, tz, 34, 20, 0);
      vel = r.vel;
      spin = r.spin;
      base = 0.09;
      strength = 0.9;
    } else {
      receiver =
        plan.targetId >= 0
          ? this.players[plan.targetId]
          : plan.aimed === false
            ? this.ai.bestReceiver(p, plan.type === 'through')
            : this.ai.pickReceiver(p, plan.dirX, plan.dirZ, plan.type === 'through');
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
        const through = plan.type === 'through';
        const lofted = plan.type === 'lob' || plan.type === 'cross' || (through && plan.power > 0) || fromHands || setPieceKind === 'goalkick';
        if (through) {
          // Into space ahead of the receiver, toward goal.
          const lead = 7 + this.rng.next() * 3;
          const runX = team.dir * 0.85 + receiver.vel.x * 0.05;
          const runZ = (plan.dirZ * 0.4 + receiver.vel.z * 0.05) * 0.6;
          const n = Math.hypot(runX, runZ);
          tx += (runX / n) * lead;
          tz += (runZ / n) * lead;
          this.ai.setRun(receiver, tx, tz);
        }
        if (plan.type === 'cross' || setPieceKind === 'corner') {
          // Into the box toward the receiver, a bit in front of goal.
          tx = clamp(tx, opp - team.dir * 14, opp - team.dir * 5);
          tz = clamp(tz, -8, 8);
        }
        let r = lofted ? solveLofted(b.pos, tx, tz, 30, 25, 0) : solveGroundPass(b.pos, tx, tz, 7);
        if (!through) {
          for (let i = 0; i < 2; i++) {
            const lt = Math.min(r.time, 2.5) * 0.85;
            const ax = receiver.pos.x + receiver.vel.x * lt;
            const az = receiver.pos.z + receiver.vel.z * lt;
            const dd = dist2D(b.pos.x, b.pos.z, ax, az);
            if (lofted) {
              const angle = setPieceKind === 'goalkick' ? 34 : fromHands && this.setPiece?.kind === 'throw' ? 18 : clamp(16 + dd * 0.45, 20, 38);
              r = solveLofted(b.pos, ax, az, angle, 25, 0);
            } else {
              r = solveGroundPass(b.pos, ax, az, clamp(5.5 + dd * 0.14, 6, 11));
            }
          }
        } else if (!lofted) {
          r = solveGroundPass(b.pos, tx, tz, 3.2);
        } else {
          r = solveLofted(b.pos, tx, tz, 32, 25, 0);
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
    const sd = base * (1.3 - skill) * (1 + bodyPen * 2.2 + runPen * 0.7 + press * 0.9 + ballPen * 0.9);
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
    p.touchCooldown = 0.35;
    p.sinceTouch = 0;
    if (this.setPiece) {
      this.setPiece = null;
      this.phase = 'play';
    }
    if (receiver && receiver.team === this.humanTeam) this.setControlled(receiver);
  }

  // ------------------------------------------------------------------ ball contact

  private wantsBall(p: Player): boolean {
    if (p === this.owner) return true;
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
      if (p.action === 'stumble' || p.action === 'slide' || p.action === 'dive' || p.action === 'kick' || p.action === 'throw') continue;
      const d = this.ballDist(p);
      const headZone = h > PLAYER.controlHeight && h < PLAYER.headMax;
      const reach = headZone ? 0.6 : PLAYER.reach;
      if (d > reach || h > PLAYER.headMax) continue;
      if (!this.wantsBall(p)) {
        // Body deflection for anyone in the way.
        if (d < PLAYER.radius + BALL.radius && h < 1.85 && p !== this.lastKicker) this.deflect(p);
        continue;
      }
      // Close control by the owner: opponents must tackle, not just touch.
      if (this.owner && this.owner !== p && this.owner.team !== p.team && this.ballDist(this.owner) < PLAYER.reach) continue;
      if (p.plan && h < 1.0) continue; // the plan will strike it
      if (d < bestD) {
        bestD = d;
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
    const wantShot = (p.plan?.type === 'shot' || (p !== this.controlled && distGoal < 16)) && distGoal < 20;
    if (wantShot) {
      const tz = (this.rng.next() < 0.5 ? -1 : 1) * (PITCH.goalHalfWidth - 0.8);
      dirX = gx - b.pos.x;
      dirZ = tz - b.pos.z;
      speed = 11 + p.attrs.shooting * 6;
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
    const sd = 0.08 + (1 - p.attrs.control) * 0.12;
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
    this.events.kicks.push(0.35);
  }

  /** Keeper secures the ball in his hands. */
  catchBall(k: Player): void {
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
      this.startSetPiece('throw', team, clamp(p.x, -PITCH.halfL + 1, PITCH.halfL - 1), Math.sign(p.z) * (PITCH.halfW + 0.3));
      const taker = this.setPiece!.taker;
      void taker;
      return;
    }
    if (Math.abs(p.x) > PITCH.halfL + BALL.radius && !b.inGoal) {
      const side = p.x > 0 ? 1 : -1;
      const defending = this.teams[0].dir === side ? 1 : 0;
      const attacking = 1 - defending;
      if (this.lastTouch && this.lastTouch.team === defending) {
        this.startSetPiece('corner', attacking, side * (PITCH.halfL - 0.4), Math.sign(p.z || 1) * (PITCH.halfW - 0.4));
      } else {
        this.startSetPiece('goalkick', defending, side * (PITCH.halfL - 5.5), Math.sign(p.z || 1) * 5);
      }
    }
  }

  get displayMinute(): number {
    const m = (this.clock / MATCH.halfSeconds) * 45;
    return Math.floor(m) + (this.half === 2 ? 45 : 0);
  }
}
