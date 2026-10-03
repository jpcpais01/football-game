import * as THREE from 'three';
import { PITCH } from '../sim/constants';
import type { Match, MatchEvents } from '../sim/match';
import type { Player } from '../sim/player';
import { clamp, lerp, smoothstep } from '../sim/vec';
import type { CameraRig } from '../render/cameraRig';

/** Recorded frames per second (every other sim step), and how many seconds are kept. */
const HZ = 60;
const CAP = HZ * 8;
/** The replay: this long before the ball crosses the line, and this long after it. */
const BEFORE = 4;
const AFTER = 1;
/** The finish, from this long before the goal, in slow motion at this speed. */
const SLOW_LEAD = 0.9;
const SLOW = 0.45;
/** A ball that moves further than this between frames was placed (a restart): the tape starts after. */
const JUMP = 2;

type Keys<T> = { [K in keyof Player]: Player[K] extends T ? K : never }[keyof Player];
/** Player state the renderer reads, blended between frames. */
const LERPED = [
  'actionT', 'actionDur', 'actionDirX', 'actionDirZ', 'kickPower', 'kickRel', 'kickContact', 'kickHeight',
  'kickStretch', 'kickBallF', 'kickBallL', 'catchY', 'accelFwd', 'sinceTouch', 'stridePhase', 'leanFwd',
  'leanSide', 'slideV0', 'slideStop', 'legX', 'legZ',
] as const satisfies readonly Keys<number>[];
/** ...and taken from the nearer frame. */
const STEPPED = ['kickLeg'] as const satisfies readonly Keys<number>[];
const FLAGS = ['kickLofted', 'throwIn'] as const satisfies readonly Keys<boolean>[];

// Frame layout. A body: pos, prevPos, vel, facing, prevFacing, action, kickType, the keeper's
// dive (roll, lift), then the lists above.
const B_ACTION = 11;
const B_KICK = 12;
const B_DIVE = 13;
const B_LIST = 15;
const BODY = B_LIST + LERPED.length + STEPPED.length + FLAGS.length;
// The ball (pos, prevPos, spin), then the match (time, owner, holder), then what happened (kick,
// net strength and where, post).
const BALL = 9;
const M_TIME = BALL;
const M_OWNER = BALL + 1;
const M_HELD = BALL + 2;
const E_KICK = BALL + 3;
const E_NET = BALL + 4;
const E_POST = BALL + 8;
const TAIL = BALL + 9;

type Buf = Float32Array | Float64Array;

/**
 * Goal replays. A small tape records what the renderer draws — the ball, the players and the
 * officials — 60 times a second, keeping the last 8 seconds. At the cut after a goal (camera
 * on the crowd) the match stops and the tape plays the goal back: the build-up on a reverse
 * angle from the far touchline, then the finish from behind the net, slowed down. The
 * renderer draws it exactly as it draws the match. Tap to skip. Purely presentational: the
 * match isn't stepped meanwhile, and every body is handed back exactly as the match left it.
 */
export class Replay {
  readonly el = document.createElement('div');
  /** Kicks, net and post along the tape, for the sound and the net's ripple. */
  onEvents: (kick: number, net: number, x: number, y: number, z: number, post: number, time: number) => void = () => {};
  private m!: Match;
  private bodies: Player[] = [];
  private frame = 0;
  private tape = new Float32Array(0);
  /** The live state while the tape plays (exact, to hand it back). */
  private live = new Float64Array(0);
  private codes: string[] = [];
  /** Frames recorded (the newest is n - 1); the first after a restart; the goal's. */
  private n = 0;
  private first = 0;
  private goal = -1;
  private played = -1;
  private tick = 0;
  // Playback.
  private match: Match | null = null;
  private u = -1;
  private from = 0;
  private to = 0;
  private fired = 0;
  private autoPlay = false;
  private side = 1;
  private goalZ = 0;
  private shot = -1;
  private focus = new THREE.Vector3();
  private cam = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 30 };
  private onDone: () => void = () => {};
  /** Interpolation between the two frames on show (the renderer's alpha). */
  alpha = 0;
  /** Playback speed (1, or slow motion at the finish). */
  speed = 1;

  constructor(
    parent: HTMLElement,
    private readonly officials: Player[],
  ) {
    this.el.className = 'cutscene replay hidden';
    this.el.innerHTML = '<i class="cs-bar top"></i><i class="cs-bar bot"></i><div class="rp-tag">Replay</div><div class="cs-skip">Tap to skip ›</div>';
    this.el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.finish();
    });
    parent.appendChild(this.el);
  }

  get active(): boolean {
    return this.match !== null;
  }

  /** The match time on the tape. */
  get time(): number {
    const a = this.slot(Math.floor(this.u)) + this.bodies.length * BODY;
    return this.tape[a + M_TIME] + this.alpha / HZ;
  }

  /** A new match: forget the tape. */
  reset(): void {
    this.cancel();
    this.n = this.first = 0;
    this.goal = this.played = -1;
  }

  /** After each sim step: tape the open play, and the second after a goal. */
  record(m: Match): void {
    if (m.phase !== 'goal') this.goal = -1;
    else if (m.phaseT > AFTER + 0.1) return;
    if ((this.tick++ & 1) === 1) return;
    this.fit(m);
    const off = this.slot(this.n);
    this.capture(this.tape, off);
    this.tape.fill(0, off + this.bodies.length * BODY + E_KICK, off + this.frame);
    if (this.n > this.first) {
      const prev = this.slot(this.n - 1) + this.bodies.length * BODY;
      const b = off + this.bodies.length * BODY;
      const t = this.tape;
      if (Math.hypot(t[b] - t[prev], t[b + 2] - t[prev + 2]) > JUMP) this.first = this.n;
    }
    if (m.phase === 'goal' && this.goal < 0) this.goal = this.n;
    this.n++;
    this.first = Math.max(this.first, this.n - CAP);
  }

  /** What happened since the last frame (kick, net, post) goes on the newest one. */
  note(e: MatchEvents): void {
    if (this.n === 0 || this.active) return;
    const o = this.slot(this.n - 1) + this.bodies.length * BODY;
    const t = this.tape;
    for (const k of e.kicks) t[o + E_KICK] = Math.max(t[o + E_KICK], k);
    if (e.net > t[o + E_NET]) {
      t[o + E_NET] = e.net;
      t[o + E_NET + 1] = e.netX;
      t[o + E_NET + 2] = e.netY;
      t[o + E_NET + 3] = e.netZ;
    }
    t[o + E_POST] = Math.max(t[o + E_POST], e.post);
  }

  /** The cut after a goal: play it back (true), if there's enough of it on the tape. */
  start(m: Match, cutT: number, onDone: () => void): boolean {
    if (m.phase !== 'goal' || m.phaseT < cutT || this.goal < 0 || this.played === this.goal) return false;
    this.played = this.goal;
    this.from = Math.max(this.first, this.goal - BEFORE * HZ);
    this.to = Math.min(this.n - 1, this.goal + AFTER * HZ);
    if (this.to - this.from < HZ * 1.5) return false;
    this.fit(m);
    this.capture(this.live, 0);
    this.match = m;
    this.autoPlay = m.autoPlay;
    m.autoPlay = true;
    this.onDone = onDone;
    const g = this.slot(this.goal) + this.bodies.length * BODY;
    this.side = Math.sign(this.tape[g]) || 1;
    this.goalZ = this.tape[g + 2];
    this.u = this.from;
    this.fired = this.from;
    this.shot = -1;
    this.alpha = 0;
    this.show(this.from, this.from + 1, 0);
    this.el.classList.remove('hidden');
    return true;
  }

  update(dt: number, rig: CameraRig): void {
    if (!this.active) return;
    const slowAt = this.goal - SLOW_LEAD * HZ;
    this.speed = lerp(1, SLOW, smoothstep(slowAt, slowAt + 0.2 * HZ, this.u));
    this.u += dt * HZ * this.speed;
    if (this.u >= this.to) return this.finish();
    const f = Math.floor(this.u);
    this.alpha = this.u - f;
    this.show(f, Math.min(f + 1, this.to), this.alpha);
    // Sound and net for what the tape just passed.
    for (; this.fired < f; this.fired++) {
      const o = this.slot(this.fired + 1) + this.bodies.length * BODY;
      const t = this.tape;
      if (t[o + E_KICK] > 0 || t[o + E_NET] > 0 || t[o + E_POST] > 0) {
        this.onEvents(t[o + E_KICK], t[o + E_NET], t[o + E_NET + 1], t[o + E_NET + 2], t[o + E_NET + 3], t[o + E_POST], t[o + M_TIME]);
      }
    }
    this.direct(f < slowAt ? 0 : 1, dt, rig);
  }

  /** Skip, or the end of the tape: the match comes back exactly as it was. */
  finish(): void {
    if (!this.active) return;
    this.put(this.live, 0);
    this.match!.autoPlay = this.autoPlay;
    this.cancel();
    this.onDone();
  }

  /** Abandon it (a new match replaced this one): no hand-back, no callback. */
  cancel(): void {
    if (!this.active) return;
    this.match = null;
    this.u = -1;
    this.el.classList.add('hidden');
  }

  // ------------------------------------------------------------------ the camera

  /** Shot 0: the reverse angle, high on the far touchline. Shot 1: low behind the net. */
  private direct(shot: number, dt: number, rig: CameraRig): void {
    const b = this.match!.ball;
    const bx = lerp(b.prevPos.x, b.pos.x, this.alpha);
    const by = lerp(b.prevPos.y, b.pos.y, this.alpha);
    const bz = lerp(b.prevPos.z, b.pos.z, this.alpha);
    if (shot !== this.shot) {
      this.shot = shot;
      this.focus.set(bx, by, bz);
    }
    const k = 1 - Math.exp(-dt * (shot ? 3 : 2.5));
    this.focus.x += (bx - this.focus.x) * k;
    this.focus.y += (by - this.focus.y) * k;
    this.focus.z += (bz - this.focus.z) * k;
    const c = this.cam;
    if (shot === 0) {
      const x = clamp(this.focus.x, -PITCH.halfL + 10, PITCH.halfL - 10);
      c.pos.set(x, 8, -(PITCH.halfW + 3));
      c.look.set(x, 0.6, this.focus.z * 0.8);
      c.fov = 28;
    } else {
      const s = this.side;
      c.pos.set(s * (PITCH.halfL + 4.2), 1.5, clamp(this.goalZ * 0.5, -2.5, 2.5));
      // Never looking down into the net: the frame stays on the box in front of it.
      c.look.set(s * Math.min(s * this.focus.x, PITCH.halfL - 5), Math.max(0.5, this.focus.y * 0.7), this.focus.z);
      c.fov = 36;
    }
    rig.cut = c;
  }

  // ------------------------------------------------------------------ the tape

  private slot(i: number): number {
    return (i % CAP) * this.frame;
  }

  private code(s: string): number {
    const i = this.codes.indexOf(s);
    return i >= 0 ? i : this.codes.push(s) - 1;
  }

  /** The bodies on the tape (a new match has new players). */
  private fit(m: Match): void {
    this.m = m;
    if (this.bodies[0] === m.players[0]) return;
    this.bodies = [...m.players, ...this.officials];
    this.frame = this.bodies.length * BODY + TAIL;
    if (this.tape.length !== CAP * this.frame) {
      this.tape = new Float32Array(CAP * this.frame);
      this.live = new Float64Array(this.frame);
    }
    this.n = this.first = 0;
    this.goal = this.played = -1;
  }

  private capture(t: Buf, off: number): void {
    const m = this.m;
    const { diveRoll, diveLift } = m.ai;
    let o = off;
    for (const p of this.bodies) {
      const r = p as unknown as Record<string, number | boolean>;
      t[o] = p.pos.x;
      t[o + 1] = p.pos.y;
      t[o + 2] = p.pos.z;
      t[o + 3] = p.prevPos.x;
      t[o + 4] = p.prevPos.y;
      t[o + 5] = p.prevPos.z;
      t[o + 6] = p.vel.x;
      t[o + 7] = p.vel.y;
      t[o + 8] = p.vel.z;
      t[o + 9] = p.facing;
      t[o + 10] = p.prevFacing;
      t[o + B_ACTION] = this.code(p.action);
      t[o + B_KICK] = this.code(p.kickType);
      t[o + B_DIVE] = diveRoll[p.id] ?? 0;
      t[o + B_DIVE + 1] = diveLift[p.id] ?? 0;
      let i = o + B_LIST;
      for (const k of LERPED) t[i++] = r[k] as number;
      for (const k of STEPPED) t[i++] = r[k] as number;
      for (const k of FLAGS) t[i++] = r[k] ? 1 : 0;
      o += BODY;
    }
    const b = m.ball;
    t[o] = b.pos.x;
    t[o + 1] = b.pos.y;
    t[o + 2] = b.pos.z;
    t[o + 3] = b.prevPos.x;
    t[o + 4] = b.prevPos.y;
    t[o + 5] = b.prevPos.z;
    t[o + 6] = b.spin.x;
    t[o + 7] = b.spin.y;
    t[o + 8] = b.spin.z;
    t[o + M_TIME] = m.time;
    t[o + M_OWNER] = m.owner ? m.owner.id : -1;
    t[o + M_HELD] = m.heldBy ? m.heldBy.id : -1;
  }

  /** Hand the live state back, exactly. */
  private put(t: Buf, off: number): void {
    const m = this.m;
    let o = off;
    for (const p of this.bodies) {
      p.pos.set(t[o], t[o + 1], t[o + 2]);
      p.prevPos.set(t[o + 3], t[o + 4], t[o + 5]);
      p.vel.set(t[o + 6], t[o + 7], t[o + 8]);
      p.facing = t[o + 9];
      p.prevFacing = t[o + 10];
      this.putState(p, t, o, t, o, 0);
      o += BODY;
    }
    const b = m.ball;
    b.pos.set(t[o], t[o + 1], t[o + 2]);
    b.prevPos.set(t[o + 3], t[o + 4], t[o + 5]);
    b.spin.set(t[o + 6], t[o + 7], t[o + 8]);
    this.putHolders(t[o + M_OWNER], t[o + M_HELD]);
  }

  /** Frames a and b of the tape, t of the way between: positions go to prevPos and pos (the
   * renderer blends them by `alpha`), the rest is blended here. */
  private show(a: number, b: number, u: number): void {
    const t = this.tape;
    let A = this.slot(a);
    let B = this.slot(b);
    for (const p of this.bodies) {
      p.prevPos.set(t[A], t[A + 1], t[A + 2]);
      p.pos.set(t[B], t[B + 1], t[B + 2]);
      p.vel.set(lerp(t[A + 6], t[B + 6], u), lerp(t[A + 7], t[B + 7], u), lerp(t[A + 8], t[B + 8], u));
      p.prevFacing = t[A + 9];
      p.facing = t[B + 9];
      this.putState(p, t, A, t, B, u);
      A += BODY;
      B += BODY;
    }
    const ball = this.m.ball;
    ball.prevPos.set(t[A], t[A + 1], t[A + 2]);
    ball.pos.set(t[B], t[B + 1], t[B + 2]);
    ball.spin.set(t[A + 6], t[A + 7], t[A + 8]);
    const N = u < 0.5 ? A : B;
    this.putHolders(t[N + M_OWNER], t[N + M_HELD]);
  }

  /** A body's action and pose state, u of the way from frame A to frame B (blended only
   * within one action: across a change, all from the nearer frame). */
  private putState(p: Player, ta: Buf, A: number, tb: Buf, B: number, u: number): void {
    const r = p as unknown as Record<string, number | boolean | string>;
    const same = ta[A + B_ACTION] === tb[B + B_ACTION];
    const N = u < 0.5 ? A : B;
    const tn = u < 0.5 ? ta : tb;
    r.action = this.codes[tn[N + B_ACTION]];
    r.kickType = this.codes[tn[N + B_KICK]];
    const { diveRoll, diveLift } = this.m.ai;
    if (p.id < diveRoll.length) {
      diveRoll[p.id] = same ? lerp(ta[A + B_DIVE], tb[B + B_DIVE], u) : tn[N + B_DIVE];
      diveLift[p.id] = same ? lerp(ta[A + B_DIVE + 1], tb[B + B_DIVE + 1], u) : tn[N + B_DIVE + 1];
    }
    let i = B_LIST;
    for (const k of LERPED) {
      r[k] = same ? lerp(ta[A + i], tb[B + i], u) : tn[N + i];
      i++;
    }
    for (const k of STEPPED) r[k] = tn[N + i++];
    for (const k of FLAGS) r[k] = tn[N + i++] === 1;
  }

  private putHolders(owner: number, held: number): void {
    const ps = this.m.players;
    this.m.owner = owner >= 0 ? ps[owner] : null;
    this.m.heldBy = held >= 0 ? ps[held] : null;
  }
}
