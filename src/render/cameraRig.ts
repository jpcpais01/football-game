import * as THREE from 'three';
import { PITCH } from '../sim/constants';
import type { Match } from '../sim/match';
import { clamp, lerp } from '../sim/vec';

/** Broadcast-style camera: high on the side, eases after the play, leans into the attack. */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private tx = 0;
  private tz = 0;
  private vx = 0;
  private vz = 0;
  private dist = 34;
  private shake = 0;
  private look = new THREE.Vector3();
  /** Debug: fixed camera distance (e.g. ?zoom=10 for a close-up). */
  distOverride = 0;

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
    this.camera.fov = aspect < 1.6 ? 36 : 30;
    this.camera.updateProjectionMatrix();
  }

  update(match: Match, alpha: number, dt: number, time: number): void {
    const b = match.ball;
    const bx = lerp(b.prevPos.x, b.pos.x, alpha);
    const bz = lerp(b.prevPos.z, b.pos.z, alpha);
    let goalX = bx + clamp(b.vel.x * 0.35, -9, 9);
    let goalZ = bz * 0.6 + clamp(b.vel.z * 0.15, -4, 4);
    const att = match.attackingTeam();
    if (att >= 0) goalX += match.teams[att].dir * 4;
    if (match.phase === 'goal' && match.scorer) {
      goalX = match.scorer.pos.x * 0.8;
      goalZ = match.scorer.pos.z * 0.7;
    }
    goalX = clamp(goalX, -PITCH.halfL + 10, PITCH.halfL - 10);
    goalZ = clamp(goalZ, -PITCH.halfW + 6, PITCH.halfW - 6);

    // Critically damped follow.
    const w = 2.6;
    const k = 1 - Math.exp(-dt * 6);
    this.vx += ((goalX - this.tx) * w * w - 2 * w * this.vx) * dt;
    this.vz += ((goalZ - this.tz) * w * w - 2 * w * this.vz) * dt;
    this.tx += this.vx * dt;
    this.tz += this.vz * dt;

    const speed = b.vel.len();
    const air = Math.max(0, b.pos.y - 2) * 0.6;
    const wantDist = (match.phase === 'goal' ? 26 : 33) + Math.min(5, speed * 0.12 + air);
    this.dist += ((this.distOverride || wantDist) - this.dist) * k * 0.3;
    this.shake *= Math.exp(-dt * 6);
    this.place(time);
  }

  private place(time: number): void {
    const pitch = (25 * Math.PI) / 180;
    const cam = this.camera;
    const sx = Math.sin(time * 41) * this.shake * 0.25;
    const sy = Math.cos(time * 37) * this.shake * 0.2;
    cam.position.set(this.tx + sx, Math.sin(pitch) * this.dist + sy, this.tz + Math.cos(pitch) * this.dist);
    this.look.set(this.tx, 0, this.tz - 1.5);
    cam.lookAt(this.look);
  }
}
