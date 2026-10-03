import * as THREE from 'three';
import { Ball } from '../sim/ball';
import { DT } from '../sim/constants';
import type { Match } from '../sim/match';
import type { V3 } from '../sim/vec';

const DOTS = 34;

/**
 * Corner, goal-kick and cross aiming, FIFA-style: a gold ring on the grass where the delivery will come down,
 * and a dotted arc of its flight. The arc is the real flight (the match's own corner solver
 * and ball physics), whipped or floated depending on the button being held.
 */
export class CornerAim {
  readonly group = new THREE.Group();
  private ring: THREE.Mesh;
  private disc: THREE.Mesh;
  private dots: THREE.Points;
  private pos = new Float32Array(DOTS * 3);
  private alpha = new Float32Array(DOTS);
  private ball = new Ball();
  private solvedAt = -1;
  private lastKey = '';
  private cross: ReturnType<Match['crossAim']> = null;

  constructor() {
    const gold = new THREE.Color(0xffd447);
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(1.0, 1.35, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: gold, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false }),
    );
    this.disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.42, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false }),
    );
    for (const m of [this.ring, this.disc]) {
      m.position.y = 0.04;
      m.renderOrder = 4;
      this.group.add(m);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.dots = new THREE.Points(
      geo,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        vertexShader: /* glsl */ `
          attribute float aAlpha;
          varying float vA;
          void main() {
            vA = aAlpha;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = clamp(260.0 / -mv.z, 2.0, 7.0);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          varying float vA;
          void main() {
            vec2 q = gl_PointCoord - 0.5;
            if (dot(q, q) > 0.25) discard;
            gl_FragColor = vec4(1.0, 0.92, 0.6, vA);
          }
        `,
      }),
    );
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 5;
    this.group.add(this.dots);
    this.group.visible = false;
  }

  /**
   * Per frame. `cross` is the stick while the human holds a lofted Pass (null otherwise): on
   * the ball in the crossing zone, that previews the open-play cross the same way.
   */
  update(match: Match, float: boolean, time: number, cross: { moveX: number; moveY: number } | null): void {
    const sp = match.setPiece;
    if (match.aimingDelivery && sp?.target) {
      const t = sp.target;
      this.place(t.x, t.z, time);
      // Re-solve the flight only when the aim or the style changes (at most 20 a second).
      const key = `${t.x.toFixed(2)}|${t.z.toFixed(2)}|${float}`;
      if (key === this.lastKey || time - this.solvedAt < 0.05) return;
      this.lastKey = key;
      this.solvedAt = time;
      const r = match.solveDelivery(t.x, t.z, float);
      this.fly(match, r.vel, r.spin, r.time);
      this.group.visible = true;
      return;
    }
    if (cross) {
      // The cross follows the stick and the runners: re-solved up to 20 times a second.
      if (time - this.solvedAt >= 0.05 || this.lastKey !== 'cross') {
        this.solvedAt = time;
        this.lastKey = 'cross';
        this.cross = match.crossAim(cross.moveX, cross.moveY);
        if (this.cross) this.fly(match, this.cross.vel, this.cross.spin, this.cross.time);
      }
      if (this.cross) {
        this.place(this.cross.x, this.cross.z, time);
        this.group.visible = true;
        return;
      }
    }
    this.lastKey = '';
    this.cross = null;
    this.group.visible = false;
  }

  /** The ring on the grass: it breathes, like a mark on the pitch. */
  private place(x: number, z: number, time: number): void {
    const s = 1 + 0.08 * Math.sin(time * 5);
    this.ring.position.set(x, 0.04, z);
    this.ring.scale.setScalar(s);
    this.disc.position.set(x, 0.045, z);
    (this.disc.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.3 * Math.sin(time * 5);
  }

  /** The dotted flight from the ball, sampled evenly in time until it comes down. */
  private fly(match: Match, vel: V3, spin: V3, time: number): void {
    const b = this.ball;
    b.pos.copy(match.ball.pos);
    b.prevPos.copy(b.pos);
    b.vel.copy(vel);
    b.spin.copy(spin);
    b.onGround = false;
    b.inGoal = false;
    const total = Math.max(0.2, time);
    const every = total / (DOTS - 1);
    let next = 0;
    let n = 0;
    let tt = 0;
    while (n < DOTS && tt <= total + DT) {
      if (tt >= next) {
        this.pos[n * 3] = b.pos.x;
        this.pos[n * 3 + 1] = Math.max(0.12, b.pos.y);
        this.pos[n * 3 + 2] = b.pos.z;
        // Faint at the foot, strong where it comes down.
        this.alpha[n] = 0.25 + 0.7 * (n / (DOTS - 1));
        n++;
        next += every;
      }
      b.step(DT);
      tt += DT;
    }
    for (; n < DOTS; n++) this.alpha[n] = 0;
    const g = this.dots.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
  }
}
