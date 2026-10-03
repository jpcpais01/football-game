import * as THREE from 'three';
import { GOAL_SEQ, PITCH } from '../sim/constants';
import type { Match } from '../sim/match';
import { clamp, lerp, smoothstep } from '../sim/vec';

const CAM_PITCH_DEG = 21;
/** Pixel art looks down more steeply: a cleaner, more readable top-down-ish framing. */
const PIXEL_PITCH_DEG = 27;

export const CAMERA_PRESETS = { close: 33, normal: 40, far: 48 } as const;
export type CameraPreset = keyof typeof CAMERA_PRESETS;

/** Broadcast-style camera: high on the side, eases after the play, leans into the attack. */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private tx = 0;
  private tz = 0;
  private vx = 0;
  private vz = 0;
  /** Framing aim after the dead zone and safe frame (the spring chases it). */
  private aimX = 0;
  private aimZ = 0;
  private leadX = 0;
  private leadZ = 0;
  private dist = 40;
  /** Set-piece zoom (1 = the normal distance; a corner pulls back to take in the box). */
  private zoom = 1;
  private shake = 0;
  private look = new THREE.Vector3();
  /** Debug: fixed camera distance (e.g. ?zoom=10 for a close-up). */
  distOverride = 0;
  /** Low-res pixel height when the pixel-art look is on (0 = off): the camera then moves in
   * whole-pixel steps so the picture doesn't shimmer as it pans. */
  pixelHeight = 0;
  /** Sub-pixel remainder of the snap (in low-res pixels): the pixel pass scrolls the
   * upscaled image by this much, so motion is smooth while the pixel grid stays stable. */
  subPixelX = 0;
  subPixelY = 0;
  /** Wide establishing shot of the stadium (home screen, half time, full time). */
  cinematic = false;
  /** Goal crowd shot: which end's fans to show (-1 left/home, 1 right/away, 0 none). */
  crowdShot = 0;
  /** A directed shot (the pre-match cutscene) that takes over the camera outright. */
  cut: { pos: THREE.Vector3; look: THREE.Vector3; fov: number } | null = null;
  private cine = 0;
  private lastShot = 0;
  private cinePos = new THREE.Vector3();
  private cineLook = new THREE.Vector3();
  /** Third-person shot behind a dead-ball taker (0 = broadcast view, 1 = behind him). */
  private pov = 0;
  /** The over-the-shoulder dead-ball view is (partly) on: the camera looks along the pitch. */
  get povActive(): boolean {
    return this.pov > 0;
  }
  /** A ground-level shot is (partly) on — dead-ball view or goal celebration — so the camera
   * can see the side of the ground behind the broadcast position. */
  get groundLevel(): boolean {
    return this.pov > 0 || this.front > 0;
  }
  private povPos = new THREE.Vector3();
  private povLook = new THREE.Vector3();
  /** Goal celebration shot from in front of the scorer (0 = off, 1 = on). */
  private front = 0;
  private frontPos = new THREE.Vector3();
  private frontLook = new THREE.Vector3();
  private baseFov = 30;
  /** Base distance from the play; set by the camera setting. */
  baseDist: number = CAMERA_PRESETS.normal;

  /** Point on the pitch the camera is framing (the shadow map follows it). */
  get focusX(): number {
    return this.tx;
  }
  get focusZ(): number {
    return this.tz;
  }

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(30, aspect, 1, 1500);
    this.place(0);
  }

  bump(amount: number): void {
    this.shake = Math.max(this.shake, amount);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    // Narrow screens see less of the pitch side to side; pull back a little.
    this.baseFov = aspect < 1.6 ? 36 : 30;
    this.camera.fov = this.baseFov;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Framing, the way a broadcast operator does it:
   * - The subject is the ball, led into the direction of play (more picture ahead of the
   *   attack than behind it), pulled partway toward the player you control.
   * - A dead zone: small touches and jinks don't move the camera; it only follows once the
   *   subject drifts out of a box around the centre.
   * - Composition: the subject sits a little above centre, because the joystick and buttons
   *   cover the bottom of the screen.
   * - Safe frame: whatever the composition says, the ball and the active player are both
   *   kept inside the picture (the ball wins if they can't both fit).
   * - A critically damped spring that stiffens with the ball's speed, so long balls are
   *   followed without lag but the camera stays calm in slow build-up.
   * The pixel look keeps a fixed distance (no dolly or zoom) so its pixel grid stays stable.
   */
  update(match: Match, alpha: number, dt: number, time: number): void {
    if (dt <= 0) return this.place(time);
    const pixel = this.pixelHeight > 0;
    const cam = this.camera;
    const b = match.ball;
    const bx = lerp(b.prevPos.x, b.pos.x, alpha);
    const bz = lerp(b.prevPos.z, b.pos.z, alpha);
    // After a goal: follow the scorer's celebration (then the crowd shot, then back to the field).
    const goal = match.phase === 'goal' && match.scorer && match.phaseT < GOAL_SEQ.back;
    const c = goal ? match.scorer! : match.controlled;
    let cx = lerp(c.prevPos.x, c.pos.x, alpha);
    let cz = lerp(c.prevPos.z, c.pos.z, alpha);
    // Aiming a corner: frame the ring in the box along with the taker at the flag.
    const aimT = match.aimingCorner ? match.setPiece?.target : undefined;
    if (aimT) {
      cx = aimT.x;
      cz = aimT.z;
    }

    // Visible ground half-extents around the look point.
    const pitch = this.pitch();
    const tanV = Math.tan((cam.fov * Math.PI) / 360);
    const halfX = this.dist * tanV * cam.aspect;
    const halfZ = (this.dist * tanV) / Math.sin(pitch + 0.15);

    // Lead: where play is going, smoothed so it doesn't flick on every touch.
    const att = match.attackingTeam();
    const live = match.phase === 'play';
    const wantLX = live ? clamp(b.vel.x * 0.4, -9, 9) + (att >= 0 ? match.teams[att].dir * 3.5 : 0) : 0;
    const wantLZ = live ? clamp(b.vel.z * 0.25, -4, 4) : 0;
    const kl = 1 - Math.exp(-dt * 1.8);
    this.leadX += (wantLX - this.leadX) * kl;
    this.leadZ += (wantLZ - this.leadZ) * kl;

    // Subject: the led ball, pulled toward the active player (less when he's far from it).
    const cd = Math.hypot(cx - bx, cz - bz);
    const wc = goal ? 1 : aimT ? 0.55 : 0.4 * (1 - clamp((cd - 8) / 22, 0, 1));
    let sx = bx + this.leadX + (cx - bx - this.leadX) * wc;
    let sz = bz + this.leadZ + (cz - bz - this.leadZ) * wc;
    const sp = match.setPiece;
    const corner = match.phase === 'setpiece' && sp?.kind === 'corner' ? sp : null;
    if (corner) {
      // A corner: the penalty box is the picture. Aim at the middle of the box (or between
      // it and the delivery ring while it's being aimed); the safe frame below then slides
      // just far enough toward the flag to keep the taker in shot.
      const gx = PITCH.halfL * match.teams[corner.team].dir;
      const boxX = gx - match.teams[corner.team].dir * 10;
      sx = aimT ? (boxX + aimT.x) / 2 : boxX;
      sz = aimT ? aimT.z * 0.5 : 0;
    } else if (!goal) {
      // Closing on a goal (or a set piece near one): lean the frame toward it, so the goal
      // and what's in front of it come into the picture with the ball.
      const team = match.phase === 'setpiece' && sp ? sp.team : att;
      if (team >= 0 && (live || match.phase === 'setpiece')) {
        const gx = PITCH.halfL * match.teams[team].dir;
        const wg = 0.42 * (1 - smoothstep(14, 44, Math.abs(gx - bx)));
        sx += (gx - sx) * wg;
        sz += (0 - sz) * wg * 0.6;
      }
    }
    // Composition: subject above centre (controls cover the bottom).
    sz += halfZ * 0.12;

    // Dead zone around the current aim.
    const dzx = halfX * 0.12;
    const dzz = halfZ * 0.1;
    const ex = sx - this.aimX;
    const ez = sz - this.aimZ;
    if (Math.abs(ex) > dzx) this.aimX += ex - Math.sign(ex) * dzx;
    if (Math.abs(ez) > dzz) this.aimZ += ez - Math.sign(ez) * dzz;

    // Safe frame: the active player, then the ball (applied last so it wins).
    this.aimX = this.keepIn(this.aimX, cx, halfX * 0.78, halfX * 0.78);
    // At a corner the framing is tight, so it uses what the camera really sees up and down
    // the pitch (a tilted camera sees much further to the far side than to the near).
    const fv = (cam.fov * Math.PI) / 360;
    const camH = Math.sin(pitch) * this.dist;
    const camD = Math.cos(pitch) * this.dist;
    const farExt = camH / Math.tan(Math.max(0.05, pitch - fv)) - camD;
    const nearExt = camD - camH / Math.tan(pitch + fv);
    // (The aiming ring at a corner is kept well up, clear of the controls.)
    if (corner) this.aimZ = this.keepIn(this.aimZ, cz, farExt * 0.6, nearExt * 0.45);
    else this.aimZ = this.keepIn(this.aimZ, cz, halfZ * 0.72, halfZ * 0.5);
    // (At a corner the box gets the picture: a taker at the far flag may sit right at the
    // top edge; at the near flag he's kept just clear of the controls at the bottom.)
    const bm = corner ? 0.9 : 1;
    this.aimX = this.keepIn(this.aimX, bx, halfX * 0.82 * bm, halfX * 0.82 * bm);
    this.aimZ = corner ? this.keepIn(this.aimZ, bz, farExt * 0.8, nearExt * 0.86) : this.keepIn(this.aimZ, bz, halfZ * 0.78, halfZ * 0.55);

    // Don't show more than a little beyond the pitch.
    // (At a corner the stand behind the goal may come in, so the goal sits inside the frame.)
    const mx = Math.max(0, PITCH.halfL + 8 - halfX * (corner ? 0.55 : 1));
    this.aimX = clamp(this.aimX, -mx, mx);
    if (!corner) this.aimZ = clamp(this.aimZ, -PITCH.halfW + halfZ * 0.55 - 6, PITCH.halfW - halfZ * 0.45 + 4);
    sx = this.aimX;
    sz = this.aimZ;

    // Critically damped follow, stiffer when the ball is travelling.
    // Slow, smooth pans while the goal is celebrated.
    const w = match.phase === 'goal' ? 1.3 : 2.3 + Math.min(2.2, b.vel.len() * 0.1);
    this.vx += ((sx - this.tx) * w * w - 2 * w * this.vx) * dt;
    this.vz += ((sz - this.tz) * w * w - 2 * w * this.vz) * dt;
    this.tx += this.vx * dt;
    this.tz += this.vz * dt;
    // Never lose the ball, whatever the spring is doing.
    this.tx = this.keepIn(this.tx, bx, halfX * 0.92, halfX * 0.92);
    this.tz = corner ? this.keepIn(this.tz, bz, farExt * 0.9, nearExt * 0.92) : this.keepIn(this.tz, bz, halfZ * 0.9, halfZ * 0.75);

    const k = 1 - Math.exp(-dt * 6);
    const air = Math.max(0, b.pos.y - 2) * 0.6;
    // A corner pulls back a little, to take in the taker and the whole box.
    this.zoom += ((corner ? 1.3 : 1) - this.zoom) * (1 - Math.exp(-dt * 1.6));
    const wantDist = (goal ? this.baseDist * 0.78 : this.baseDist * this.zoom) + Math.min(5, b.vel.len() * 0.12 + air);
    if (!pixel) this.dist += ((this.distOverride || wantDist) - this.dist) * k * 0.3;
    else this.dist = this.distOverride || this.baseDist * this.zoom;
    this.shake *= Math.exp(-dt * 6);
    this.updatePov(match, alpha, dt);
    this.updateFront(match, alpha, dt);
    this.cine += ((this.cinematic || this.crowdShot ? 1 : 0) - this.cine) * (1 - Math.exp(-dt * (this.crowdShot ? 1.9 : 1.5)));
    if (this.cine < 0.002) this.cine = this.lastShot = 0;
    this.place(time);
  }

  /**
   * Lining up a free kick or penalty: the camera drops in behind the taker, over the
   * shoulder away from the ball, looking down the line of the shot at the goal (or up the
   * pitch, for a goal kick). The same for the other side's dead balls once their taker is
   * lined up (Match.deadBallView). The moment he sets off on his run-up it eases back up
   * to the broadcast view.
   */
  private updatePov(match: Match, alpha: number, dt: number): void {
    const view = match.deadBallView;
    const want = view ? 1 : 0;
    const sp = match.setPiece;
    if (view && sp) {
      const t = view.taker;
      const tx = lerp(t.prevPos.x, t.pos.x, alpha);
      const tz = lerp(t.prevPos.z, t.pos.z, alpha);
      // Down the line from the taker to what he's looking at.
      const gx = view.x;
      const gz = view.z;
      let ux = gx - tx;
      let uz = gz - tz;
      const n = Math.hypot(ux, uz) || 1;
      ux /= n;
      uz /= n;
      const rx = -uz;
      const rz = ux;
      // Over the shoulder on the ball's side (a right-footer stands left of the ball, so his
      // right shoulder): the taker sits to one side of the frame, ball and goal stay clear.
      const side = t.foot;
      const h = t.look.height;
      // (A goal kick: a little higher, to see the pitch opening out ahead.)
      const gk = view.kind === 'goalkick';
      this.povPos.set(tx - ux * 2.7 + rx * side * 1.05, (gk ? 2.25 : 1.95) * h, tz - uz * 2.7 + rz * side * 1.05);
      // Look between the ball and the goal mouth: ball low in the frame, goal and wall above it.
      const k = sp.kind === 'penalty' ? 0.75 : gk ? 0.3 : 0.62;
      this.povLook.set(lerp(sp.x, gx, k), 1.05, lerp(sp.z, gz, k));
    }
    // Quick cut in, a smooth crane back out as he runs up.
    const rate = want ? 3.2 : 2.0;
    this.pov += (want - this.pov) * (1 - Math.exp(-dt * rate));
    if (this.pov < 0.002) this.pov = 0;
  }

  /**
   * The scorer's celebration: once his run is over the camera swings down and round to stand
   * between him and the centre spot, at chest height, the celebrating end's stands behind him,
   * and drifts slowly across him. It holds there while the crowd shot takes over (the crowd
   * shot blends from wherever the camera is), then lets go.
   */
  private updateFront(match: Match, alpha: number, dt: number): void {
    const s = match.scorer;
    const t = match.phase === 'goal' && s ? match.phaseT : -1;
    const want = t >= GOAL_SEQ.front && t < GOAL_SEQ.crowd + 1 ? 1 : 0;
    if (s && t >= 0 && t < GOAL_SEQ.crowd) {
      const x = lerp(s.prevPos.x, s.pos.x, alpha);
      const z = lerp(s.prevPos.z, s.pos.z, alpha);
      const d = Math.hypot(x, z) || 1;
      // Toward the centre spot, swung a little off-axis and drifting across as he celebrates.
      const u = clamp((t - GOAL_SEQ.front) / (GOAL_SEQ.crowd - GOAL_SEQ.front), 0, 1);
      const a = Math.atan2(-z / d, -x / d) + (0.55 - 0.7 * u) * (z >= 0 ? 1 : -1);
      const h = s.look.height;
      const r = 4.4 - 0.6 * u;
      this.frontPos.set(x + Math.cos(a) * r, 1.25 * h, z + Math.sin(a) * r);
      this.frontLook.set(x, 1.08 * h, z);
    }
    // A slow, swooping pan in; held through the cut to the crowd.
    this.front += (want - this.front) * (1 - Math.exp(-dt * (want ? 1.6 : 3)));
    if (this.front < 0.002) this.front = 0;
  }

  /** Move `aim` the least so that point p lies within [aim - far, aim + near] (z: + is nearer the camera). */
  private keepIn(aim: number, p: number, far: number, near: number): number {
    if (p < aim - far) return p + far;
    if (p > aim + near) return p - near;
    return aim;
  }

  private pitch(): number {
    return ((this.pixelHeight > 0 ? PIXEL_PITCH_DEG : CAM_PITCH_DEG) * Math.PI) / 180;
  }

  private place(time: number): void {
    // A little lower than a tactical cam so the stands and sky are part of the picture.
    const pitch = this.pitch();
    const cam = this.camera;
    const sx = Math.sin(time * 41) * this.shake * 0.25;
    const sy = Math.cos(time * 37) * this.shake * 0.2;
    let tx = this.tx;
    let tz = this.tz;
    this.subPixelX = 0;
    this.subPixelY = 0;
    if (this.pixelHeight > 0) {
      const unit = (2 * this.dist * Math.tan((cam.fov * Math.PI) / 360)) / this.pixelHeight;
      const unitZ = unit / Math.sin(pitch);
      const sxp = Math.round(tx / unit) * unit;
      const szp = Math.round(tz / unitZ) * unitZ;
      this.subPixelX = (tx - sxp) / unit;
      this.subPixelY = (szp - tz) / unitZ;
      tx = sxp;
      tz = szp;
    }
    cam.position.set(tx + sx, Math.sin(pitch) * this.dist + sy, tz + Math.cos(pitch) * this.dist);
    this.look.set(tx, 0, tz);
    if (this.pov > 0) {
      const k = this.pov * this.pov * (3 - 2 * this.pov);
      cam.position.lerp(this.povPos, k);
      this.look.lerp(this.povLook, k);
      this.subPixelX *= 1 - k;
      this.subPixelY *= 1 - k;
      const fov = lerp(this.baseFov, 46, k);
      if (Math.abs(cam.fov - fov) > 0.01) {
        cam.fov = fov;
        cam.updateProjectionMatrix();
      }
    } else if (cam.fov !== this.baseFov) {
      cam.fov = this.baseFov;
      cam.updateProjectionMatrix();
    }
    if (this.front > 0) {
      const k = this.front * this.front * (3 - 2 * this.front);
      cam.position.lerp(this.frontPos, k);
      this.look.lerp(this.frontLook, k);
      this.subPixelX *= 1 - k;
      this.subPixelY *= 1 - k;
      const fov = lerp(cam.fov, 38, k);
      if (Math.abs(cam.fov - fov) > 0.01) {
        cam.fov = fov;
        cam.updateProjectionMatrix();
      }
    }
    if (this.cine > 0) {
      // A slow crane sweep from the open near side across the bowl: the far stands, the
      // ultras' end, the roof lights.
      // Keep the crowd framing while easing back out of it.
      if (this.crowdShot) this.lastShot = this.crowdShot;
      const e = this.crowdShot || (this.cinematic ? 0 : this.lastShot);
      if (e) {
        // After a goal: from the edge of the box up at the celebrating end, drifting across it.
        const drift = Math.sin(time * 0.35) * 10;
        this.cinePos.set(e * (PITCH.halfL - 20), 5, 14 + drift * 0.4);
        this.cineLook.set(e * (PITCH.halfL + 22), 10, drift);
      } else {
        const a = Math.sin(time * 0.05) * 0.55;
        this.cinePos.set(Math.sin(a) * 78, 17 + Math.sin(time * 0.07) * 3, 22 + Math.cos(a) * 52);
        this.cineLook.set(-Math.sin(a) * 30, 9, -30);
      }
      const k = this.cine * this.cine * (3 - 2 * this.cine);
      cam.position.lerp(this.cinePos, k);
      this.look.lerp(this.cineLook, k);
      this.subPixelX *= 1 - k;
      this.subPixelY *= 1 - k;
    }
    const cut = this.cut;
    if (cut) {
      cam.position.copy(cut.pos);
      this.look.copy(cut.look);
      this.subPixelX = this.subPixelY = 0;
      if (cam.fov !== cut.fov) {
        cam.fov = cut.fov;
        cam.updateProjectionMatrix();
      }
    }
    cam.lookAt(this.look);
  }
}
