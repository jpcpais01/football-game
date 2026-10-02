import * as THREE from 'three';
import type { Match } from '../sim/match';
import type { Player } from '../sim/player';
import { clamp, lerp, smoothstep } from '../sim/vec';
import { STAND_SHADOW_GLSL, SUN_DIR, outlineMaterial, toonMaterial } from './look';

/**
 * Players are built from simple rounded parts and animated procedurally from the
 * simulation state (speed, stride phase, lean, actions), so motion always matches the
 * physics. Every part type is one InstancedMesh: all 22 players ≈ 20 draw calls.
 */

type PartName = 'torso' | 'pelvis' | 'head' | 'hair' | 'upperArm' | 'forearm' | 'shortsLeg' | 'thigh' | 'shin' | 'boot';

interface Part {
  mesh: THREE.InstancedMesh;
  outline: THREE.InstancedMesh | null;
  perPlayer: number;
}

const THIGH = 0.43;
const SHIN = 0.42;
const HIP_Y = 0.94;

function capsule(r: number, len: number, capSeg = 3, radial = 8): THREE.BufferGeometry {
  return new THREE.CapsuleGeometry(r, len, capSeg, radial);
}

function buildGeometries(): Record<PartName, THREE.BufferGeometry> {
  const torso = capsule(0.16, 0.3, 4, 10);
  torso.scale(1.18, 1, 0.66);
  torso.translate(0, 0.3, 0);

  const pelvis = capsule(0.15, 0.06, 3, 10);
  pelvis.scale(1.12, 1, 0.74);

  const head = new THREE.SphereGeometry(0.112, 12, 9);
  head.scale(0.94, 1.08, 1);
  head.translate(0, 0.13, 0.01);

  const hair = new THREE.SphereGeometry(0.124, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.5);
  hair.scale(0.97, 1.06, 1.06);
  hair.translate(0, 0.145, -0.005);

  const upperArm = capsule(0.054, 0.2);
  upperArm.translate(0, -0.15, 0);
  const forearm = capsule(0.043, 0.21);
  forearm.translate(0, -0.15, 0);
  const shortsLeg = capsule(0.088, 0.1);
  shortsLeg.translate(0, -0.1, 0);
  const thigh = capsule(0.068, 0.3);
  thigh.translate(0, -0.21, 0);
  const shin = capsule(0.058, 0.3);
  shin.translate(0, -0.21, 0);
  const boot = capsule(0.048, 0.13, 2, 8);
  boot.rotateX(Math.PI / 2);
  boot.scale(1, 0.85, 1);
  boot.translate(0, -0.035, 0.045);
  return { torso, pelvis, head, hair, upperArm, forearm, shortsLeg, thigh, shin, boot };
}

function shadowMaterial(opacity: number, sunShadow: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    uniforms: { uOpacity: { value: opacity } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorld;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorld;
      uniform float uOpacity;
      ${STAND_SHADOW_GLSL}
      void main() {
        vec2 q = (vUv - 0.5) * 2.0;
        ${sunShadow ? 'q.y = q.y < 0.0 ? q.y * 1.8 : q.y;' : ''}
        float r = length(q);
        float a = (1.0 - smoothstep(0.35, 1.0, r)) * uOpacity;
        ${sunShadow ? 'a *= 1.0 - standShadow(vec3(vWorld.x, 0.0, vWorld.z));' : ''}
        gl_FragColor = vec4(0.12, 0.15, 0.1, a);
      }
    `,
  });
}

export class PlayersView {
  readonly group = new THREE.Group();
  private parts = {} as Record<PartName, Part>;
  private contact: THREE.InstancedMesh;
  private sun: THREE.InstancedMesh;
  private ring: THREE.Mesh;
  private marker: THREE.Mesh;
  private n: number;

  // scratch
  private e = new THREE.Euler();
  private loc = new THREE.Matrix4();
  private root = new THREE.Matrix4();
  private pelvis = new THREE.Matrix4();
  private chest = new THREE.Matrix4();
  private j1 = new THREE.Matrix4();
  private j2 = new THREE.Matrix4();
  private j3 = new THREE.Matrix4();
  private sm = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();

  constructor(match: Match) {
    const players = match.players;
    this.n = players.length;
    const geos = buildGeometries();
    // The hair cap is open underneath, so an inverted hull would show its inside: no outline.
    const outlineParts: PartName[] = ['torso', 'pelvis', 'head', 'upperArm', 'forearm', 'shortsLeg', 'thigh', 'shin', 'boot'];
    const per: Record<PartName, number> = { torso: 1, pelvis: 1, head: 1, hair: 1, upperArm: 2, forearm: 2, shortsLeg: 2, thigh: 2, shin: 2, boot: 2 };
    const mat = toonMaterial();
    for (const name of Object.keys(geos) as PartName[]) {
      const count = this.n * per[name];
      const mesh = new THREE.InstancedMesh(geos[name], mat, count);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      let outline: THREE.InstancedMesh | null = null;
      if (outlineParts.includes(name)) {
        const t = name === 'torso' || name === 'pelvis' ? 0.022 : name === 'head' || name === 'hair' ? 0.018 : 0.015;
        outline = new THREE.InstancedMesh(geos[name], outlineMaterial(t), count);
        outline.instanceMatrix = mesh.instanceMatrix; // share the matrices
        outline.frustumCulled = false;
        this.group.add(outline);
      }
      this.group.add(mesh);
      this.parts[name] = { mesh, outline, perPlayer: per[name] };
    }
    this.applyColors(match);

    // Shadows: a contact blob and a long late-afternoon shadow per player.
    const sGeo = new THREE.PlaneGeometry(1, 1);
    sGeo.rotateX(-Math.PI / 2);
    this.contact = new THREE.InstancedMesh(sGeo, shadowMaterial(0.42, false), this.n);
    this.sun = new THREE.InstancedMesh(sGeo, shadowMaterial(0.3, true), this.n);
    for (const m of [this.contact, this.sun]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.renderOrder = 1;
      this.group.add(m);
    }

    // Controlled player indicator.
    const ringGeo = new THREE.RingGeometry(0.5, 0.64, 32);
    ringGeo.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffd447, transparent: true, opacity: 0.95, depthWrite: false }));
    this.ring.renderOrder = 2;
    this.group.add(this.ring);
    const mk = new THREE.ConeGeometry(0.16, 0.3, 3);
    mk.rotateX(Math.PI);
    this.marker = new THREE.Mesh(mk, new THREE.MeshBasicMaterial({ color: 0xffd447 }));
    this.group.add(this.marker);
  }

  applyColors(match: Match): void {
    const c = new THREE.Color();
    const set = (name: PartName, p: Player, hex: number) => {
      const part = this.parts[name];
      for (let k = 0; k < part.perPlayer; k++) part.mesh.setColorAt(p.id * part.perPlayer + k, c.setHex(hex));
    };
    const boots = [0x1a1a1a, 0xf2f2f2, 0x1a1a1a, 0x2c2c2c, 0xd94c2e, 0x1a1a1a];
    for (const p of match.players) {
      const kit = match.teams[p.team].info.kit;
      const gk = p.role === 'GK';
      set('torso', p, gk ? kit.gkShirt : kit.shirt);
      set('upperArm', p, gk ? kit.gkShirt : kit.shirt2);
      set('pelvis', p, gk ? kit.gkShorts : kit.shorts);
      set('shortsLeg', p, gk ? kit.gkShorts : kit.shorts);
      set('shin', p, gk ? kit.gkShirt : kit.socks);
      set('head', p, p.look.skin);
      set('forearm', p, gk ? 0xf0efe8 : p.look.skin);
      set('thigh', p, p.look.skin);
      set('hair', p, p.look.hair);
      set('boot', p, boots[p.id % boots.length]);
    }
    for (const name of Object.keys(this.parts) as PartName[]) {
      const m = this.parts[name].mesh;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  /** local = T(x,y,z) * Ry * Rx * Rz ; out = parent * local */
  private chain(out: THREE.Matrix4, parent: THREE.Matrix4, x: number, y: number, z: number, rx: number, ry: number, rz: number): THREE.Matrix4 {
    this.e.set(rx, ry, rz, 'YXZ');
    this.loc.makeRotationFromEuler(this.e);
    this.loc.setPosition(x, y, z);
    return out.multiplyMatrices(parent, this.loc);
  }

  private put(name: PartName, index: number, m: THREE.Matrix4, sx = 1, sy = 1, sz = 1): void {
    if (sx !== 1 || sy !== 1 || sz !== 1) {
      this.sm.makeScale(sx, sy, sz);
      this.sm.premultiply(m);
      this.parts[name].mesh.setMatrixAt(index, this.sm);
    } else {
      this.parts[name].mesh.setMatrixAt(index, m);
    }
  }

  update(match: Match, alpha: number, time: number): void {
    const held = match.heldBy;
    const throwIn = match.setPiece?.kind === 'throw';
    for (const p of match.players) {
      const x = lerp(p.prevPos.x, p.pos.x, alpha);
      const z = lerp(p.prevPos.z, p.pos.z, alpha);
      let df = p.facing - p.prevFacing;
      if (df > Math.PI) df -= Math.PI * 2;
      if (df < -Math.PI) df += Math.PI * 2;
      const facing = p.prevFacing + df * alpha;
      const speed = p.speed;
      const s = clamp(speed / 8.5, 0, 1);
      const phi = p.stridePhase;
      const h = p.look.height;

      // ---------------- base gait
      const sinP = Math.sin(phi);
      const cosP = Math.cos(phi);
      const moveAmt = smoothstep(0.15, 1.2, speed);
      const aHip = (0.12 + 0.62 * s) * moveAmt;
      let hipL = aHip * sinP;
      let hipR = -aHip * sinP;
      const kneeAmp = (0.25 + 1.35 * s) * moveAmt;
      let kneeL = 0.06 + kneeAmp * Math.pow(Math.max(0, cosP), 1.4) + 0.12 * s;
      let kneeR = 0.06 + kneeAmp * Math.pow(Math.max(0, -cosP), 1.4) + 0.12 * s;
      let legOutL = 0.04;
      let legOutR = 0.04;
      const aArm = (0.1 + 0.7 * s) * moveAmt;
      let armL = -aArm * sinP;
      let armR = aArm * sinP;
      let elbowL = 0.25 + 1.05 * s * moveAmt;
      let elbowR = elbowL;
      let armOutL = 0.1;
      let armOutR = 0.1;
      let hipY = HIP_Y - (0.012 + 0.05 * s) * Math.abs(cosP) * moveAmt;
      let twist = 0.14 * s * sinP * moveAmt;
      let leanF = p.leanFwd;
      let leanS = -p.leanSide;
      let roll = 0;
      let lift = 0;
      let headPitch = 0;
      let chestLean = 0;

      // Idle breathing.
      if (moveAmt < 1) {
        const br = Math.sin(time * 2.1 + p.id) * 0.015 * (1 - moveAmt);
        armOutL += br;
        armOutR += br;
      }

      // Keeper ready stance.
      if (p.role === 'GK' && speed < 2.5 && p.action === 'none' && held !== p && match.phase === 'play') {
        kneeL += 0.35;
        kneeR += 0.35;
        hipL += 0.18;
        hipR += 0.18;
        hipY -= 0.08;
        armOutL = 0.45;
        armOutR = 0.45;
        armL = -0.35;
        armR = -0.35;
        leanF += 0.18;
        legOutL = legOutR = 0.12;
      }

      // Dribble touch: quick flick of the leading leg.
      if (p.action === 'none' && p.sinceTouch < 0.2 && match.owner === p) {
        const k = Math.sin((p.sinceTouch / 0.2) * Math.PI);
        if (sinP > 0) {
          hipL += 0.35 * k;
          kneeL *= 1 - 0.5 * k;
        } else {
          hipR += 0.35 * k;
          kneeR *= 1 - 0.5 * k;
        }
      }

      // ---------------- actions
      const pr = p.actionDur > 0 ? clamp(p.actionT / p.actionDur, 0, 1) : 0;
      switch (p.action) {
        case 'kick': {
          let sw: number;
          let kn: number;
          if (pr < 0.4) {
            sw = lerp(0, -0.85, pr / 0.4);
            kn = lerp(0.2, 1.55, pr / 0.4);
          } else if (pr < 0.62) {
            const t = (pr - 0.4) / 0.22;
            sw = lerp(-0.85, 1.3, t);
            kn = lerp(1.55, 0.08, t);
          } else {
            const t = (pr - 0.62) / 0.38;
            sw = lerp(1.3, 0.25, t);
            kn = lerp(0.08, 0.3, t);
          }
          if (p.kickLeg > 0) {
            hipR = sw;
            kneeR = kn;
            hipL = 0.12;
            kneeL = 0.25;
            armOutL = 0.85;
            armL = -0.4;
            armOutR = 0.5;
            armR = 0.3;
          } else {
            hipL = sw;
            kneeL = kn;
            hipR = 0.12;
            kneeR = 0.25;
            armOutR = 0.85;
            armR = -0.4;
            armOutL = 0.5;
            armL = 0.3;
          }
          twist = -p.kickLeg * 0.25 * Math.sin(pr * Math.PI);
          chestLean = -0.12 * Math.sin(pr * Math.PI);
          hipY -= 0.04;
          break;
        }
        case 'tackle': {
          const k = Math.sin(Math.min(1, pr * 1.6) * Math.PI * 0.5) * (1 - smoothstep(0.7, 1, pr));
          hipR = lerp(hipR, 1.1, k);
          kneeR = lerp(kneeR, 0.12, k);
          hipL = lerp(hipL, -0.3, k);
          kneeL = lerp(kneeL, 0.9, k);
          hipY -= 0.2 * k;
          leanF += 0.3 * k;
          armOutL = armOutR = 0.6 * k + 0.1;
          break;
        }
        case 'slide': {
          const k = smoothstep(0, 0.18, pr) * (1 - smoothstep(0.75, 1, pr));
          roll = 0;
          leanF = lerp(leanF, -1.2, k);
          hipY = lerp(hipY, 0.34, k);
          hipR = lerp(hipR, 1.45, k);
          kneeR = lerp(kneeR, 0.05, k);
          hipL = lerp(hipL, 0.9, k);
          kneeL = lerp(kneeL, 1.7, k);
          armL = lerp(armL, -0.2, k);
          armR = lerp(armR, 0.5, k);
          armOutL = armOutR = lerp(0.1, 0.7, k);
          break;
        }
        case 'dive': {
          // Which side (in the keeper's local frame) is the dive going?
          const leftZ = -Math.cos(facing);
          const side = Math.sign(p.actionDirZ * leftZ) || 1;
          const k = smoothstep(0, 0.28, pr);
          const land = smoothstep(0.55, 0.8, pr);
          const dh = match.ai.diveHeight[p.id];
          roll = -side * 1.35 * k;
          hipY = lerp(HIP_Y, lerp(0.75 + dh * 0.35, 0.28, land), k);
          const up = -2.9;
          if (side > 0) {
            armL = lerp(armL, up, k);
            armR = lerp(armR, up + 0.3, k);
          } else {
            armR = lerp(armR, up, k);
            armL = lerp(armL, up + 0.3, k);
          }
          armOutL = armOutR = 0.25;
          elbowL = elbowR = 0.15;
          hipL = hipR = 0.2;
          kneeL = kneeR = 0.4;
          break;
        }
        case 'header': {
          const k = Math.sin(pr * Math.PI);
          lift = 0.38 * k;
          headPitch = 0.5 * Math.sin(Math.min(1, pr * 2) * Math.PI);
          armOutL = armOutR = 0.7 * k + 0.1;
          kneeL = kneeR = 0.4 * k + 0.1;
          break;
        }
        case 'throw': {
          const k = pr < 0.5 ? pr / 0.5 : 1 - (pr - 0.5) / 0.5;
          armL = armR = lerp(-2.8, -1.4, 1 - k);
          elbowL = elbowR = lerp(1.4, 0.2, 1 - k);
          chestLean = 0.15 * (1 - k);
          break;
        }
        case 'stumble': {
          const k = Math.sin(pr * Math.PI);
          leanF += 0.35 * k;
          armOutL = armOutR = 0.9 * k;
          armL = armR = -0.5 * k;
          break;
        }
      }

      // Holding the ball.
      if (held === p && p.action === 'none') {
        if (throwIn) {
          armL = armR = -2.8;
          elbowL = elbowR = 1.5;
          armOutL = armOutR = 0.2;
        } else {
          armL = armR = -1.0;
          elbowL = elbowR = 0.9;
          armOutL = armOutR = -0.05;
        }
      }
      // Goal celebration.
      if (match.phase === 'goal' && match.scorer === p && match.phaseT > 0.4) {
        armL = armR = -2.7;
        armOutL = armOutR = 0.5;
        elbowL = elbowR = 0.2;
      } else if (match.phase === 'goal' && match.scorer && match.scorer.team === p.team && match.phaseT > 1.2) {
        armOutL = armOutR = 0.3 + 0.2 * Math.sin(time * 9 + p.id);
      }

      // ---------------- skeleton
      const R = this.root;
      this.e.set(0, Math.PI / 2 - facing, 0, 'YXZ');
      R.makeRotationFromEuler(this.e);
      R.setPosition(x, 0, z);
      this.s.set(h, h, h);
      R.scale(this.s);
      // Whole-body tilt about the ground point: lean into turns / accelerations.
      this.chain(R, R, 0, lift, 0, leanF, 0, leanS + roll);

      const P = this.chain(this.pelvis, R, 0, hipY, 0, 0, twist * -0.4, 0);
      const C = this.chain(this.chest, P, 0, 0.04, 0, chestLean + 0.04, twist, 0);
      const id = p.id;
      const build = p.look.build;
      this.put('pelvis', id, P, build, 1, 1);
      this.put('torso', id, C, build, 1, 1);

      // Head.
      this.chain(this.j1, C, 0, 0.6, 0, headPitch - leanF * 0.4, -twist * 0.5, 0);
      this.put('head', id, this.j1);
      if (p.look.hairStyle === 3) this.put('hair', id, this.j1, 0.001, 0.001, 0.001);
      else if (p.look.hairStyle === 1) this.put('hair', id, this.j1, 1.02, 0.86, 1.02);
      else if (p.look.hairStyle === 2) this.put('hair', id, this.j1, 1.12, 1.12, 1.12);
      else this.put('hair', id, this.j1);

      // Arms (left = +x local).
      for (let sd = 0; sd < 2; sd++) {
        const side = sd === 0 ? 1 : -1;
        const swing = sd === 0 ? armL : armR;
        const out = sd === 0 ? armOutL : armOutR;
        const elbow = sd === 0 ? elbowL : elbowR;
        this.chain(this.j1, C, side * 0.205 * build, 0.5, 0, -swing, 0, side * out);
        this.put('upperArm', id * 2 + sd, this.j1);
        this.chain(this.j2, this.j1, 0, -0.29, 0, -elbow, 0, 0);
        this.put('forearm', id * 2 + sd, this.j2);
      }

      // Legs.
      for (let sd = 0; sd < 2; sd++) {
        const side = sd === 0 ? 1 : -1;
        const hip = sd === 0 ? hipL : hipR;
        const knee = sd === 0 ? kneeL : kneeR;
        const out = sd === 0 ? legOutL : legOutR;
        this.chain(this.j1, P, side * 0.095, -0.03, 0, -hip, 0, side * out);
        this.put('shortsLeg', id * 2 + sd, this.j1);
        this.put('thigh', id * 2 + sd, this.j1);
        this.chain(this.j2, this.j1, 0, -THIGH, 0, knee, 0, 0);
        this.put('shin', id * 2 + sd, this.j2);
        // Keep the foot roughly level with the ground.
        const ankle = clamp(hip - knee, -1.2, 0.6) + (knee > 0.8 ? -0.35 : 0);
        this.chain(this.j3, this.j2, 0, -SHIN, 0, ankle, 0, 0);
        this.put('boot', id * 2 + sd, this.j3);
      }

      // Shadows.
      this.q.identity();
      this.v.set(x, 0.015, z);
      this.s.set(0.85, 1, 0.85);
      this.sm.compose(this.v, this.q, this.s);
      this.contact.setMatrixAt(id, this.sm);
      const sx = SUN_DIR.x;
      const sz = SUN_DIR.z;
      const sl = Math.hypot(sx, sz);
      const len = 1.75 * h * (lift > 0 ? 1.1 : 1);
      this.q.setFromAxisAngle(this.v.set(0, 1, 0), Math.atan2(sx / sl, sz / sl));
      this.v.set(x + (sx / sl) * len * 0.5, 0.012, z + (sz / sl) * len * 0.5);
      const lying = p.action === 'slide' || p.action === 'dive' ? 1.6 : 1;
      this.s.set(0.55 * lying, 1, len);
      this.sm.compose(this.v, this.q, this.s);
      this.sun.setMatrixAt(id, this.sm);
    }

    for (const name of Object.keys(this.parts) as PartName[]) this.parts[name].mesh.instanceMatrix.needsUpdate = true;
    this.contact.instanceMatrix.needsUpdate = true;
    this.sun.instanceMatrix.needsUpdate = true;

    // Controlled player ring + marker.
    const c = match.controlled;
    const cx = lerp(c.prevPos.x, c.pos.x, alpha);
    const cz = lerp(c.prevPos.z, c.pos.z, alpha);
    this.ring.position.set(cx, 0.02, cz);
    const pulse = match.switchT < 0.3 ? 1 + (0.3 - match.switchT) * 2 : 1;
    this.ring.scale.setScalar(pulse);
    this.marker.position.set(cx, 2.35 * c.look.height + Math.sin(time * 4) * 0.05, cz);
    this.marker.rotation.y = time * 1.5;
    const show = match.phase !== 'fulltime' && !match.autoPlay;
    this.ring.visible = show;
    this.marker.visible = show;
  }
}
