import * as THREE from 'three';
import { GOAL_SEQ, PITCH } from '../sim/constants';
import type { Match } from '../sim/match';
import { clamp, lerp } from '../sim/vec';

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
  private cine = 0;
  private lastShot = 0;
  private cinePos = new THREE.Vector3();
  private cineLook = new THREE.Vector3();
  /** Third-person shot behind a dead-ball taker (0 = broadcast view, 1 = behind him). */
  private pov = 0;
  private povPos = new THREE.Vector3();
  private povLook = new THREE.Vector3();
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
    const goal = match.phase === 'goal' && match.scorer && match.phaseT < GOAL_SEQ.crowd;
    const c = goal ? match.scorer! : match.controlled;
    const cx = lerp(c.prevPos.x, c.pos.x, alpha);
    const cz = lerp(c.prevPos.z, c.pos.z, alpha);

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
    const wc = goal ? 1 : 0.4 * (1 - clamp((cd - 8) / 22, 0, 1));
    let sx = bx + this.leadX + (cx - bx - this.leadX) * wc;
    let sz = bz + this.leadZ + (cz - bz - this.leadZ) * wc;
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
    this.aimZ = this.keepIn(this.aimZ, cz, halfZ * 0.72, halfZ * 0.5);
    this.aimX = this.keepIn(this.aimX, bx, halfX * 0.82, halfX * 0.82);
    this.aimZ = this.keepIn(this.aimZ, bz, halfZ * 0.78, halfZ * 0.55);

    // Don't show more than a little beyond the pitch.
    const mx = Math.max(0, PITCH.halfL + 8 - halfX);
    this.aimX = clamp(this.aimX, -mx, mx);
    this.aimZ = clamp(this.aimZ, -PITCH.halfW + halfZ * 0.55 - 6, PITCH.halfW - halfZ * 0.45 + 4);
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
    this.tz = this.keepIn(this.tz, bz, halfZ * 0.9, halfZ * 0.75);

    const k = 1 - Math.exp(-dt * 6);
    const air = Math.max(0, b.pos.y - 2) * 0.6;
    const wantDist = (goal ? this.baseDist * 0.78 : this.baseDist) + Math.min(5, b.vel.len() * 0.12 + air);
    if (!pixel) this.dist += ((this.distOverride || wantDist) - this.dist) * k * 0.3;
    else this.dist = this.distOverride || this.baseDist;
    this.shake *= Math.exp(-dt * 6);
    this.updatePov(match, alpha, dt);
    this.cine += ((this.cinematic || this.crowdShot ? 1 : 0) - this.cine) * (1 - Math.exp(-dt * (this.crowdShot ? 1.9 : 1.5)));
    if (this.cine < 0.002) this.cine = this.lastShot = 0;
    this.place(time);
  }

  /**
   * Lining up a free kick or penalty: the camera drops in behind the taker, over the
   * shoulder away from the ball, looking down the line of the shot at the goal. The
   * moment he sets off on his run-up it eases back up to the broadcast view.
   */
  private updatePov(match: Match, alpha: number, dt: number): void {
    const want = match.aimingShot ? 1 : 0;
    const sp = match.setPiece;
    if (want && sp) {
      const t = sp.taker;
      const tx = lerp(t.prevPos.x, t.pos.x, alpha);
      const tz = lerp(t.prevPos.z, t.pos.z, alpha);
      const aim = match.aimPoint()!;
      // Down the line from the taker to the goal (biased a little toward the aim).
      const gx = aim.x;
      const gz = aim.z * 0.35;
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
      this.povPos.set(tx - ux * 2.7 + rx * side * 1.05, 1.95 * h, tz - uz * 2.7 + rz * side * 1.05);
      // Look between the ball and the goal mouth: ball low in the frame, goal and wall above it.
      const k = sp.kind === 'penalty' ? 0.75 : 0.62;
      this.povLook.set(lerp(sp.x, gx, k), 1.05, lerp(sp.z, gz, k));
    }
    // Quick cut in, a smooth crane back out as he runs up.
    const rate = want ? 3.2 : 2.0;
    this.pov += (want - this.pov) * (1 - Math.exp(-dt * rate));
    if (this.pov < 0.002) this.pov = 0;
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
    cam.lookAt(this.look);
  }
}
