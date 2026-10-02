import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Match } from '../sim/match';
import type { Player } from '../sim/player';
import { clamp, lerp, smoothstep } from '../sim/vec';
import { PYLONS, blobMaterial, litMaterial } from './look';
import { divePose, type DivePose } from '../sim/keeperPose';

/**
 * Players: shaped, kitted figures (collars, trim, numbers, faces, hair) built from a few
 * smooth parts and animated procedurally from the simulation state, so motion always
 * matches the physics. Every part type is one InstancedMesh: all 22 players are ~17 draw
 * calls, plus the same again for the sun's shadow map.
 */

type PartName =
  | 'torso'
  | 'pelvis'
  | 'neck'
  | 'head'
  | 'hairShort'
  | 'hairCurly'
  | 'hairBun'
  | 'upperArm'
  | 'forearm'
  | 'shortsLeg'
  | 'thigh'
  | 'shin'
  | 'boot';

interface Part {
  mesh: THREE.InstancedMesh;
  perPlayer: number;
}

const THIGH = 0.43;
const SHIN = 0.42;
const HIP_Y = 0.94;
const HAIR_PARTS: PartName[] = ['hairShort', 'hairCurly', 'hairBun'];

function lathe(points: [number, number][], segments = 14): THREE.BufferGeometry {
  return new THREE.LatheGeometry(
    points.map(([r, y]) => new THREE.Vector2(r, y)),
    segments,
  );
}

function buildGeometries(): Record<PartName, THREE.BufferGeometry> {
  // Torso from the waist up: chest, shoulders, neckline. uv.y = 0 at the hem, 1 at the neck.
  const torso = lathe(
    [
      [0.0, -0.01],
      [0.138, 0.0],
      [0.15, 0.07],
      [0.157, 0.17],
      [0.17, 0.3],
      [0.186, 0.42],
      [0.19, 0.5],
      [0.172, 0.565],
      [0.12, 0.605],
      [0.066, 0.625],
      [0.0, 0.63],
    ],
    18,
  );
  torso.scale(1.2, 1, 0.68);

  const pelvis = lathe(
    [
      [0.0, 0.08],
      [0.148, 0.07],
      [0.158, 0.0],
      [0.165, -0.08],
      [0.168, -0.13],
      [0.0, -0.14],
    ],
    16,
  );
  pelvis.scale(1.1, 1, 0.8);

  const neck = new THREE.CylinderGeometry(0.052, 0.058, 0.11, 10);
  neck.translate(0, 0.04, 0);

  const head = new THREE.SphereGeometry(0.104, 20, 14);
  {
    // Shape a jaw and a slightly longer face.
    const pos = head.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i);
      let y = pos.getY(i);
      let z = pos.getZ(i);
      if (y < 0) {
        const k = -y / 0.104;
        x *= 1 - 0.18 * k;
        z *= 1 - 0.08 * k;
        y *= 1.12;
      }
      if (z > 0) z *= 1.04;
      pos.setXYZ(i, x * 0.9, y * 1.06, z);
    }
    head.computeVertexNormals();
    head.translate(0, 0.13, 0.008);
  }

  const cap = (r: number, theta: number, tilt: number) => {
    const g = new THREE.SphereGeometry(r, 18, 9, 0, Math.PI * 2, 0, theta);
    g.rotateX(-tilt);
    return g;
  };
  const hairShort = cap(0.112, Math.PI * 0.56, 0.32);
  hairShort.scale(0.93, 1.07, 1.06);
  hairShort.translate(0, 0.142, -0.006);

  const hairCurly = new THREE.IcosahedronGeometry(0.128, 2);
  {
    const pos = hairCurly.getAttribute('position') as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = 1 + 0.06 * Math.sin(v.x * 90) * Math.sin(v.y * 80) * Math.sin(v.z * 85);
      v.multiplyScalar(n);
      pos.setXYZ(i, v.x * 0.95, v.y * 0.95, v.z);
    }
    hairCurly.computeVertexNormals();
    hairCurly.translate(0, 0.165, -0.015);
  }
  const hairBun = (() => {
    const c = cap(0.112, Math.PI * 0.55, 0.38);
    c.scale(0.93, 1.06, 1.06);
    c.translate(0, 0.142, -0.006);
    const bun = new THREE.SphereGeometry(0.048, 10, 8);
    bun.translate(0, 0.235, -0.07);
    return mergeGeometries([c, bun])!;
  })();

  // Arm: sleeve on top (uv.y < ~0.5), skin below. uv.y = 0 at the shoulder.
  const upperArm = lathe(
    [
      [0.0, 0.03],
      [0.06, 0.02],
      [0.068, -0.04],
      [0.066, -0.12],
      [0.067, -0.155],
      [0.05, -0.17],
      [0.05, -0.22],
      [0.044, -0.29],
      [0.0, -0.31],
    ],
    12,
  );
  // Forearm and hand: uv.y > ~0.68 is the hand (gloves for keepers).
  const forearm = lathe(
    [
      [0.0, 0.02],
      [0.044, 0.0],
      [0.046, -0.06],
      [0.037, -0.2],
      [0.03, -0.235],
      [0.038, -0.27],
      [0.036, -0.32],
      [0.0, -0.345],
    ],
    10,
  );
  forearm.scale(1, 1, 0.85);
  const shortsLeg = lathe(
    [
      [0.092, 0.05],
      [0.098, -0.06],
      [0.104, -0.16],
      [0.107, -0.215],
    ],
    14,
  );
  const thigh = lathe(
    [
      [0.0, 0.02],
      [0.074, 0.0],
      [0.078, -0.1],
      [0.07, -0.25],
      [0.056, -0.39],
      [0.05, -0.44],
      [0.0, -0.46],
    ],
    12,
  );
  // Shin in a sock: calf bulge, uv.y < ~0.16 is the sock band.
  const shin = lathe(
    [
      [0.0, 0.02],
      [0.052, 0.0],
      [0.056, -0.05],
      [0.063, -0.15],
      [0.052, -0.29],
      [0.04, -0.39],
      [0.038, -0.43],
      [0.0, -0.45],
    ],
    12,
  );
  shin.scale(1, 1, 1.08);
  const boot = new THREE.CapsuleGeometry(0.046, 0.16, 3, 10);
  boot.rotateX(Math.PI / 2);
  boot.scale(0.92, 0.72, 1);
  boot.translate(0, -0.035, 0.05);
  return { torso, pelvis, neck, head, hairShort, hairCurly, hairBun, upperArm, forearm, shortsLeg, thigh, shin, boot };
}

/** Digits 0-9 in a strip, white on transparent, for shirt numbers. */
function numberTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 640;
  cv.height = 96;
  const tex = new THREE.CanvasTexture(cv);
  const draw = () => {
    const g = cv.getContext('2d')!;
    g.clearRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '800 92px "Barlow Condensed", "Arial Narrow", sans-serif';
    for (let i = 0; i < 10; i++) g.fillText(String(i), i * 64 + 32, 52);
    tex.needsUpdate = true;
  };
  draw();
  void document.fonts?.ready.then(draw);
  tex.anisotropy = 4;
  return tex;
}

// Per-part shader details. vUv2 = geometry uv, vColor/diffuseColor = instance colour.
const KIT_DECL = /* glsl */ `
varying vec3 vTrim;
float band(float x, float a, float b) { return step(a, x) * step(x, b); }
`;
const TRIM_VERT = { vertDecl: 'attribute vec3 aTrim; varying vec3 vTrim;', vertBody: 'vTrim = aTrim;' };

function torsoMaterial(numbers: THREE.Texture): THREE.MeshStandardMaterial {
  return litMaterial({
    groundAO: true,
    roughness: 0.78,
    uniforms: { uNumbers: { value: numbers } },
    vertDecl: 'attribute vec3 aTrim; attribute vec3 aNumCol; attribute float aNum; varying vec3 vTrim; varying vec3 vNumCol; varying float vNum;',
    vertBody: 'vTrim = aTrim; vNumCol = aNumCol; vNum = aNum;',
    fragDecl: `${KIT_DECL}
      varying vec3 vNumCol; varying float vNum;
      uniform sampler2D uNumbers;
      float digit(vec2 p, float d) {
        if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return 0.0;
        return texture2D(uNumbers, vec2((d + p.x) / 10.0, p.y)).a;
      }`,
    diffuseHook: /* glsl */ `{
      float u = vUv2.x;
      float v = vUv2.y;
      vec3 base = diffuseColor.rgb;
      // Collar and side panels.
      float collar = smoothstep(0.86, 0.875, v);
      float side = (1.0 - smoothstep(0.012, 0.02, abs(u - 0.25))) + (1.0 - smoothstep(0.012, 0.02, abs(u - 0.75)));
      side *= smoothstep(0.1, 0.2, v) * (1.0 - smoothstep(0.7, 0.8, v));
      vec3 c = mix(base, vTrim, clamp(collar + side * 0.85, 0.0, 1.0));
      // Crest on the left chest.
      float crest = 1.0 - smoothstep(0.018, 0.024, length(vec2((u - 0.085) * 3.0, v - 0.72)));
      c = mix(c, vTrim, crest);
      // Number on the back (u = 0.5).
      vec2 nb = vec2((u - 0.5) * 6.2, (v - 0.33) / 0.24);
      float tens = floor(vNum / 10.0);
      float ones = vNum - tens * 10.0;
      float num = tens > 0.0
        ? max(digit(vec2(nb.x * 1.6 + 1.0, nb.y), tens), digit(vec2(nb.x * 1.6, nb.y), ones))
        : digit(vec2(nb.x * 1.6 + 0.5, nb.y), ones);
      c = mix(c, vNumCol, num);
      // Soft fabric folds near the waist and under the arms.
      float fold = 0.04 * sin(u * 60.0 + v * 9.0) * (1.0 - smoothstep(0.0, 0.25, v));
      c *= 1.0 - fold - 0.06 * (1.0 - smoothstep(0.0, 0.08, v));
      diffuseColor.rgb = c;
    }`,
  });
}

function headMaterial(): THREE.MeshStandardMaterial {
  return litMaterial({
    groundAO: true,
    roughness: 0.62,
    fragDecl: 'float blob(vec2 p, vec2 c, vec2 r) { vec2 d = (p - c) / r; return 1.0 - smoothstep(0.7, 1.0, dot(d, d)); }',
    diffuseHook: /* glsl */ `{
      // Simple, calm face: brows, eyes, a hint of nose and mouth. Front of the head is u = 0.25.
      vec2 f = vec2((vUv2.x - 0.25) * 4.0, vUv2.y);
      vec3 skin = diffuseColor.rgb;
      vec3 c = skin;
      float eyes = blob(vec2(abs(f.x), f.y), vec2(0.17, 0.535), vec2(0.045, 0.022));
      float brows = blob(vec2(abs(f.x), f.y), vec2(0.18, 0.6), vec2(0.07, 0.012));
      float mouth = blob(f, vec2(0.0, 0.395), vec2(0.08, 0.008));
      float nose = blob(f, vec2(0.0, 0.47), vec2(0.03, 0.05));
      float cheek = blob(vec2(abs(f.x), f.y), vec2(0.27, 0.45), vec2(0.08, 0.06));
      c *= 1.0 - nose * 0.12;
      c = mix(c, skin * vec3(1.05, 0.92, 0.9), cheek * 0.25);
      c = mix(c, skin * 0.45, brows * 0.85);
      c = mix(c, vec3(0.08, 0.06, 0.05), eyes * 0.9);
      c = mix(c, skin * vec3(0.7, 0.5, 0.48), mouth * 0.7);
      // Ears: a touch darker at the sides.
      float ear = blob(vec2(abs(vUv2.x - 0.5) , vUv2.y), vec2(0.25, 0.5), vec2(0.04, 0.06));
      c *= 1.0 - ear * 0.15;
      diffuseColor.rgb = c;
    }`,
  });
}

function sleeveMaterial(): THREE.MeshStandardMaterial {
  return litMaterial({
    groundAO: true,
    roughness: 0.78,
    vertDecl: 'attribute vec3 aTrim; attribute vec3 aSkin; varying vec3 vTrim; varying vec3 vSkin;',
    vertBody: 'vTrim = aTrim; vSkin = aSkin;',
    fragDecl: `${KIT_DECL} varying vec3 vSkin;`,
    diffuseHook: /* glsl */ `{
      float v = vUv2.y;
      vec3 c = diffuseColor.rgb;
      c = mix(c, vTrim, band(v, 0.43, 0.5));
      c = mix(c, vSkin, step(0.5, v));
      diffuseColor.rgb = c;
    }`,
  });
}

function forearmMaterial(): THREE.MeshStandardMaterial {
  return litMaterial({
    groundAO: true,
    roughness: 0.66,
    vertDecl: 'attribute vec3 aAlt; varying vec3 vAlt;',
    vertBody: 'vAlt = aAlt;',
    fragDecl: 'varying vec3 vAlt;',
    diffuseHook: 'diffuseColor.rgb = mix(diffuseColor.rgb, vAlt, smoothstep(0.66, 0.7, vUv2.y));',
  });
}

function trimmedMaterial(hook: string, roughness = 0.8): THREE.MeshStandardMaterial {
  return litMaterial({ groundAO: true, roughness, ...TRIM_VERT, fragDecl: KIT_DECL, diffuseHook: hook });
}

export class PlayersView {
  readonly group = new THREE.Group();
  private parts = {} as Record<PartName, Part>;
  private contact: THREE.InstancedMesh;
  private flood: THREE.InstancedMesh;
  private ring: THREE.Mesh;
  private marker: THREE.Mesh;
  private n: number;
  private hidden = new THREE.Matrix4().makeScale(0, 0, 0);

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
  private yAxis = new THREE.Vector3(0, 1, 0);
  private pose: DivePose = { roll: 0, lift: 0 };

  constructor(match: Match) {
    this.n = match.players.length;
    const geos = buildGeometries();
    const per: Record<PartName, number> = {
      torso: 1,
      pelvis: 1,
      neck: 1,
      head: 1,
      hairShort: 1,
      hairCurly: 1,
      hairBun: 1,
      upperArm: 2,
      forearm: 2,
      shortsLeg: 2,
      thigh: 2,
      shin: 2,
      boot: 2,
    };
    const skin = litMaterial({ groundAO: true, roughness: 0.62 });
    const hair = litMaterial({ groundAO: true, roughness: 0.9 });
    const cloth = litMaterial({ groundAO: true, roughness: 0.8 });
    const mats: Record<PartName, THREE.Material> = {
      torso: torsoMaterial(numberTexture()),
      pelvis: cloth,
      neck: skin,
      head: headMaterial(),
      hairShort: hair,
      hairCurly: hair,
      hairBun: hair,
      upperArm: sleeveMaterial(),
      forearm: forearmMaterial(),
      shortsLeg: trimmedMaterial('diffuseColor.rgb = mix(diffuseColor.rgb, vTrim, (1.0 - smoothstep(0.015, 0.025, abs(vUv2.x - 0.25))) * 0.9 + band(vUv2.y, 0.9, 1.0) * 0.6);'),
      thigh: skin,
      shin: trimmedMaterial('diffuseColor.rgb = mix(diffuseColor.rgb, vTrim, band(vUv2.y, 0.07, 0.11) + band(vUv2.y, 0.14, 0.17));'),
      boot: trimmedMaterial('diffuseColor.rgb = mix(diffuseColor.rgb, vTrim, 1.0 - smoothstep(0.018, 0.03, vWorldPos.y));', 0.5),
    };
    // Open tubes (shorts legs) are seen from inside at some angles.
    mats.shortsLeg.side = THREE.DoubleSide;
    for (const name of Object.keys(geos) as PartName[]) {
      const count = this.n * per[name];
      const geo = geos[name];
      const add = (attr: string, size: number) => geo.setAttribute(attr, new THREE.InstancedBufferAttribute(new Float32Array(count * size), size));
      if (name === 'torso') {
        add('aTrim', 3);
        add('aNumCol', 3);
        add('aNum', 1);
      } else if (name === 'upperArm') {
        add('aTrim', 3);
        add('aSkin', 3);
      } else if (name === 'forearm') add('aAlt', 3);
      else if (name === 'shortsLeg' || name === 'shin' || name === 'boot') add('aTrim', 3);
      const mesh = new THREE.InstancedMesh(geo, mats[name], count);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.parts[name] = { mesh, perPlayer: per[name] };
    }
    this.applyColors(match);

    // Contact shadows (soft ambient occlusion under the feet) and the faint fan of
    // floodlight shadows that grows as the evening comes on.
    const sGeo = new THREE.PlaneGeometry(1, 1);
    sGeo.rotateX(-Math.PI / 2);
    this.contact = new THREE.InstancedMesh(sGeo, blobMaterial(0.5), this.n);
    this.flood = new THREE.InstancedMesh(sGeo, blobMaterial(0.2, { elongated: true, floodScaled: true }), this.n * PYLONS.length);
    for (const m of [this.contact, this.flood]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.renderOrder = 1;
      this.group.add(m);
    }

    // Controlled player indicator.
    const ringGeo = new THREE.RingGeometry(0.52, 0.64, 40);
    ringGeo.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffd447, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false }));
    this.ring.renderOrder = 2;
    this.group.add(this.ring);
    const mk = new THREE.ConeGeometry(0.15, 0.28, 3);
    mk.rotateX(Math.PI);
    this.marker = new THREE.Mesh(mk, new THREE.MeshBasicMaterial({ color: 0xffd447, toneMapped: false }));
    this.group.add(this.marker);
  }

  applyColors(match: Match): void {
    const c = new THREE.Color();
    const set = (name: PartName, p: Player, hex: number) => {
      const part = this.parts[name];
      for (let k = 0; k < part.perPlayer; k++) part.mesh.setColorAt(p.id * part.perPlayer + k, c.setHex(hex));
    };
    const attr = (name: PartName, a: string, p: Player, hex: number) => {
      const part = this.parts[name];
      const ba = part.mesh.geometry.getAttribute(a) as THREE.InstancedBufferAttribute;
      c.setHex(hex);
      for (let k = 0; k < part.perPlayer; k++) ba.setXYZ(p.id * part.perPlayer + k, c.r, c.g, c.b);
      ba.needsUpdate = true;
    };
    const boots = [0x1b1b1d, 0xf0efe9, 0x1b1b1d, 0x2a3346, 0xc8452e, 0x1b1b1d, 0x2f6b4f];
    const soles = [0xd9d6cc, 0x2a2a2a, 0xe0b23c, 0xe8e6df, 0xf2f0ea, 0xc8452e, 0xe8e6df];
    const num = this.parts.torso.mesh.geometry.getAttribute('aNum') as THREE.InstancedBufferAttribute;
    for (const p of match.players) {
      const kit = match.teams[p.team].info.kit;
      const gk = p.role === 'GK';
      const shirt = gk ? kit.gkShirt : kit.shirt;
      const trim = gk ? kit.gkShorts : kit.shirt2;
      const shorts = gk ? kit.gkShorts : kit.shorts;
      set('torso', p, shirt);
      attr('torso', 'aTrim', p, trim);
      // Numbers in the trim colour unless that's too close to the shirt.
      attr('torso', 'aNumCol', p, gk ? 0x1d1d1d : kit.shirt2 === kit.shirt ? 0xffffff : kit.shirt2);
      num.setX(p.id, gk ? 1 : p.index + 1);
      set('upperArm', p, shirt);
      attr('upperArm', 'aTrim', p, trim);
      attr('upperArm', 'aSkin', p, gk ? shirt : p.look.skin);
      set('forearm', p, gk ? shirt : p.look.skin);
      attr('forearm', 'aAlt', p, gk ? 0xf2f0ea : p.look.skin);
      set('pelvis', p, shorts);
      set('shortsLeg', p, shorts);
      attr('shortsLeg', 'aTrim', p, gk ? shirt : kit.shirt2 === kit.shorts ? kit.shirt : kit.shirt2);
      set('shin', p, gk ? kit.gkShorts : kit.socks);
      attr('shin', 'aTrim', p, gk ? kit.gkShirt : kit.shirt2);
      set('neck', p, p.look.skin);
      set('head', p, p.look.skin);
      set('thigh', p, p.look.skin);
      for (const hp of HAIR_PARTS) set(hp, p, p.look.hair);
      set('boot', p, boots[p.id % boots.length]);
      attr('boot', 'aTrim', p, soles[p.id % soles.length]);
    }
    num.needsUpdate = true;
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
          // Same pose the physics uses for the hands, so saves happen where you see them.
          const leftZ = -Math.cos(facing);
          const side = Math.sign(p.actionDirZ * leftZ) || 1;
          divePose(p, match.ai.diveRoll[p.id], match.ai.diveLift[p.id], this.pose);
          const k = smoothstep(0, 0.22, pr);
          roll = -side * this.pose.roll;
          lift = this.pose.lift;
          hipY = HIP_Y;
          leanF = 0;
          leanS = 0;
          // Both arms stretched along the body axis, past the head.
          armL = lerp(armL, -3.05, k);
          armR = lerp(armR, -3.05, k);
          armOutL = armOutR = lerp(0.1, 0.12, k);
          elbowL = elbowR = 0.05;
          hipL = hipR = lerp(hipL, 0.15, k);
          kneeL = lerp(kneeL, 0.5, k);
          kneeR = lerp(kneeR, 0.15, k);
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
      this.chain(this.j1, C, 0, 0.58, 0, 0, 0, 0);
      this.put('neck', id, this.j1);

      // Head and hair.
      this.chain(this.j1, C, 0, 0.6, 0, headPitch - leanF * 0.4, -twist * 0.5, 0);
      this.put('head', id, this.j1);
      const style = p.look.hairStyle;
      const parts = this.parts;
      parts.hairShort.mesh.setMatrixAt(id, this.hidden);
      parts.hairCurly.mesh.setMatrixAt(id, this.hidden);
      parts.hairBun.mesh.setMatrixAt(id, this.hidden);
      if (style === 0) this.put('hairShort', id, this.j1);
      else if (style === 1) this.put('hairShort', id, this.j1, 0.985, 0.95, 0.985);
      else if (style === 2) this.put('hairCurly', id, this.j1);
      else this.put('hairBun', id, this.j1);

      // Arms (left = +x local).
      for (let sd = 0; sd < 2; sd++) {
        const side = sd === 0 ? 1 : -1;
        const swing = sd === 0 ? armL : armR;
        const out = sd === 0 ? armOutL : armOutR;
        const elbow = sd === 0 ? elbowL : elbowR;
        this.chain(this.j1, C, side * 0.198 * build, 0.5, 0, -swing, 0, side * out);
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
        this.chain(this.j1, P, side * 0.092, -0.03, 0, -hip, 0, side * out);
        this.put('shortsLeg', id * 2 + sd, this.j1);
        this.put('thigh', id * 2 + sd, this.j1);
        this.chain(this.j2, this.j1, 0, -THIGH, 0, knee, 0, 0);
        this.put('shin', id * 2 + sd, this.j2);
        // Keep the foot roughly level with the ground.
        const ankle = clamp(hip - knee, -1.2, 0.6) + (knee > 0.8 ? -0.35 : 0);
        this.chain(this.j3, this.j2, 0, -SHIN, 0, ankle, 0, 0);
        this.put('boot', id * 2 + sd, this.j3);
      }

      // Contact shadow.
      this.q.identity();
      this.v.set(x, 0.015, z);
      const lying = p.action === 'slide' || p.action === 'dive' ? 1.5 : 1;
      this.s.set(0.8 * lying, 1, 0.8 * lying);
      this.sm.compose(this.v, this.q, this.s);
      this.contact.setMatrixAt(id, this.sm);

      // Floodlight shadows: one faint, long shadow away from each pylon.
      for (let k = 0; k < PYLONS.length; k++) {
        let dx = x - PYLONS[k][0];
        let dz = z - PYLONS[k][1];
        const d = Math.hypot(dx, dz);
        dx /= d;
        dz /= d;
        const len = clamp((1.8 * h * d) / 43, 1.2, 3.0);
        this.q.setFromAxisAngle(this.yAxis, Math.atan2(dx, dz));
        this.v.set(x + dx * len * 0.5, 0.011 + k * 0.0005, z + dz * len * 0.5);
        this.s.set(0.75 * lying, 1, len);
        this.sm.compose(this.v, this.q, this.s);
        this.flood.setMatrixAt(id * PYLONS.length + k, this.sm);
      }
    }

    for (const name of Object.keys(this.parts) as PartName[]) this.parts[name].mesh.instanceMatrix.needsUpdate = true;
    this.contact.instanceMatrix.needsUpdate = true;
    this.flood.instanceMatrix.needsUpdate = true;

    // Controlled player ring + marker.
    const c = match.controlled;
    const cx = lerp(c.prevPos.x, c.pos.x, alpha);
    const cz = lerp(c.prevPos.z, c.pos.z, alpha);
    this.ring.position.set(cx, 0.02, cz);
    const pulse = match.switchT < 0.3 ? 1 + (0.3 - match.switchT) * 2 : 1;
    this.ring.scale.setScalar(pulse);
    this.marker.position.set(cx, 2.3 * c.look.height + Math.sin(time * 4) * 0.05, cz);
    this.marker.rotation.y = time * 1.5;
    const show = match.phase !== 'fulltime' && !match.autoPlay;
    this.ring.visible = show;
    this.marker.visible = show;
  }
}
