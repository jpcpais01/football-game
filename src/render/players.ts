import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Match } from '../sim/match';
import type { Player } from '../sim/player';
import { clamp, lerp, smoothstep } from '../sim/vec';
import { PYLONS, blobMaterial, litMaterial } from './look';
import { divePose, type DivePose } from '../sim/keeperPose';
import type { Officials } from './officials';

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
  | 'hand'
  | 'shortsLeg'
  | 'thigh'
  | 'shin'
  | 'boot'
  | 'flag';

interface Part {
  mesh: THREE.InstancedMesh;
  perPlayer: number;
}

const THIGH = 0.43;
const SHIN = 0.42;
const HIP_Y = 0.94;
const HAIR_PARTS: PartName[] = ['hairShort', 'hairCurly', 'hairBun'];
/** Too small to show in the sun's shadow map (~4-8 cm per texel). */
const NO_SHADOW = new Set<PartName>(['hand', 'neck', 'boot', 'flag', ...HAIR_PARTS]);

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

  const head = new THREE.SphereGeometry(0.104, 16, 12);
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
  // Forearm down to the wrist; uv.y > ~0.85 is the wrist (glove cuff for keepers).
  const forearm = lathe(
    [
      [0.0, 0.02],
      [0.044, 0.0],
      [0.046, -0.06],
      [0.037, -0.2],
      [0.03, -0.24],
      [0.0, -0.255],
    ],
    10,
  );
  forearm.scale(1, 1, 0.85);
  // Hand: a relaxed, slightly cupped palm with the fingers together and a thumb.
  // Origin at the wrist; thin across x so the palm faces the body, thumb forward (+z).
  const hand = (() => {
    const palm = new THREE.SphereGeometry(0.042, 8, 6);
    palm.scale(0.62, 1.05, 1);
    palm.translate(0, -0.045, 0.004);
    const fingers = new THREE.CapsuleGeometry(0.024, 0.045, 2, 6);
    fingers.scale(0.95, 1, 1.45);
    fingers.rotateX(0.25);
    fingers.translate(0, -0.1, 0.012);
    const thumb = new THREE.CapsuleGeometry(0.012, 0.035, 1, 5);
    thumb.rotateX(0.5);
    thumb.translate(0, -0.05, 0.04);
    return mergeGeometries([palm.toNonIndexed(), fingers.toNonIndexed(), thumb.toNonIndexed()])!;
  })();
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
  // Assistant referee's flag: a short stick held in the fist, with a checked cloth.
  const flag = (() => {
    const stick = new THREE.CylinderGeometry(0.008, 0.008, 0.55, 5);
    stick.translate(0, -0.2, 0.0);
    const cloth = new THREE.PlaneGeometry(0.3, 0.22, 1, 1);
    cloth.translate(0, -0.35, 0.15);
    cloth.rotateY(Math.PI / 2);
    const a = stick.toNonIndexed();
    const b = cloth.toNonIndexed();
    a.setAttribute('aCloth', new THREE.Float32BufferAttribute(new Float32Array(a.getAttribute('position').count), 1));
    b.setAttribute('aCloth', new THREE.Float32BufferAttribute(new Float32Array(b.getAttribute('position').count).fill(1), 1));
    return mergeGeometries([a, b])!;
  })();
  return { torso, pelvis, neck, head, hairShort, hairCurly, hairBun, upperArm, forearm, hand, shortsLeg, thigh, shin, boot, flag };
}

/**
 * Soft-body bending on the GPU. Each instance carries aBend = (flex, twist, side) in radians;
 * vertices rotate progressively about the part's origin, so the torso curves through the
 * waist (spine) and thighs curve into the knee instead of hinging like a doll. The CPU side
 * attaches child parts with the full rotation, which is exactly what the top/end vertices get.
 */
const BEND_GLSL = (kind: 'torso' | 'thigh') => /* glsl */ `
attribute vec3 aBend;
mat3 bendRot(vec3 a) {
  float cx = cos(a.x), sx = sin(a.x), cy = cos(a.y), sy = sin(a.y), cz = cos(a.z), sz = sin(a.z);
  mat3 rx = mat3(1.0, 0.0, 0.0, 0.0, cx, sx, 0.0, -sx, cx);
  mat3 ry = mat3(cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy);
  mat3 rz = mat3(cz, sz, 0.0, -sz, cz, 0.0, 0.0, 0.0, 1.0);
  return ry * rx * rz;
}
float bendT(vec3 p) {
  ${kind === 'torso' ? 'float t = clamp(p.y / 0.5, 0.0, 1.0); return t * t * (3.0 - 2.0 * t);' : 'float t = clamp(-p.y / 0.43, 0.0, 1.0); return t * t;'}
}
`;

function injectBend(shader: { vertexShader: string }, kind: 'torso' | 'thigh'): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${BEND_GLSL(kind)}`)
    .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = bendRot(aBend * bendT(position)) * objectNormal;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = bendRot(aBend * bendT(position)) * transformed;');
}

function withBend<T extends THREE.Material>(mat: T, kind: 'torso' | 'thigh'): T {
  const orig = mat.onBeforeCompile.bind(mat);
  mat.onBeforeCompile = (shader, r) => {
    orig(shader, r);
    injectBend(shader, kind);
  };
  mat.customProgramCacheKey = () => `bend-${kind}-${mat.uuid}`;
  return mat;
}

/** Shadow-map material that bends the same way, so shadows match the body. */
function bendDepth(kind: 'torso' | 'thigh'): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (shader) => injectBend(shader, kind);
  m.customProgramCacheKey = () => `bend-depth-${kind}`;
  return m;
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
      float tens = floor(max(vNum, 0.0) / 10.0);
      float ones = vNum - tens * 10.0;
      float num = tens > 0.0
        ? max(digit(vec2(nb.x * 1.6 + 1.0, nb.y), tens), digit(vec2(nb.x * 1.6, nb.y), ones))
        : digit(vec2(nb.x * 1.6 + 0.5, nb.y), ones);
      c = mix(c, vNumCol, num * step(0.0, vNum));
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
    diffuseHook: 'diffuseColor.rgb = mix(diffuseColor.rgb, vAlt, smoothstep(0.84, 0.86, vUv2.y));',
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
  /** Camera used to cull players out of view (set by the app each frame). */
  camera: THREE.Camera | null = null;
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  private visible: number[] = [];
  /** Visible set the kit attributes are currently packed for (null = needs packing). */
  private packedFor: number[] | null = null;
  /** Per-player attributes that only change with the kits: master copies for culling. */
  private statics: { attr: THREE.BufferAttribute; master: Float32Array; per: number }[] = [];
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
  // Body-physics springs per player (spine flex / side bend) and head yaw.
  private sF: Float32Array;
  private spF: Float32Array;
  private sS: Float32Array;
  private spS: Float32Array;
  private headYaw: Float32Array;
  /** Everyone drawn: the 22 players plus the match officials. */
  private list: Player[];
  private extra: Player[];
  officials: Officials | null = null;
  private lastTime = 0;

  constructor(match: Match, extra: Player[] = []) {
    this.extra = extra;
    this.list = [...match.players, ...extra];
    this.n = this.list.length;
    this.sF = new Float32Array(this.n);
    this.spF = new Float32Array(this.n);
    this.sS = new Float32Array(this.n);
    this.spS = new Float32Array(this.n);
    this.headYaw = new Float32Array(this.n);
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
      hand: 2,
      shortsLeg: 2,
      thigh: 2,
      shin: 2,
      boot: 2,
      flag: 1,
    };
    const skin = litMaterial({ groundAO: true, roughness: 0.62 });
    const hair = litMaterial({ groundAO: true, roughness: 0.9 });
    const cloth = litMaterial({ groundAO: true, roughness: 0.8 });
    const mats: Record<PartName, THREE.Material> = {
      torso: withBend(torsoMaterial(numberTexture()), 'torso'),
      pelvis: cloth,
      neck: skin,
      head: headMaterial(),
      hairShort: hair,
      hairCurly: hair,
      hairBun: hair,
      upperArm: sleeveMaterial(),
      forearm: forearmMaterial(),
      hand: litMaterial({ groundAO: true, roughness: 0.6 }),
      shortsLeg: trimmedMaterial('diffuseColor.rgb = mix(diffuseColor.rgb, vTrim, (1.0 - smoothstep(0.015, 0.025, abs(vUv2.x - 0.25))) * 0.9 + band(vUv2.y, 0.9, 1.0) * 0.6);'),
      thigh: withBend(litMaterial({ groundAO: true, roughness: 0.62 }), 'thigh'),
      shin: trimmedMaterial('diffuseColor.rgb = mix(diffuseColor.rgb, vTrim, band(vUv2.y, 0.07, 0.11) + band(vUv2.y, 0.14, 0.17));'),
      boot: trimmedMaterial('diffuseColor.rgb = mix(diffuseColor.rgb, vTrim, 1.0 - smoothstep(0.018, 0.03, vWorldPos.y));', 0.5),
      flag: litMaterial({
        roughness: 0.8,
        vertDecl: 'attribute float aCloth; varying float vCloth;',
        vertBody: 'vCloth = aCloth;',
        fragDecl: 'varying float vCloth;',
        diffuseHook: `{
          vec2 g = floor(vUv2 * vec2(4.0, 3.0));
          vec3 cloth = mod(g.x + g.y, 2.0) < 1.0 ? vec3(1.0, 0.75, 0.05) : vec3(0.85, 0.08, 0.06);
          diffuseColor.rgb = mix(vec3(0.08), cloth, vCloth);
        }`,
      }),
    };
    mats.flag.side = THREE.DoubleSide;
    // Open tubes (shorts legs) are seen from inside at some angles.
    mats.shortsLeg.side = THREE.DoubleSide;
    for (const name of Object.keys(geos) as PartName[]) {
      const count = this.n * per[name];
      const geo = geos[name];
      const add = (attr: string, size: number) => geo.setAttribute(attr, new THREE.InstancedBufferAttribute(new Float32Array(count * size), size));
      if (name === 'torso' || name === 'thigh') add('aBend', 3);
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
      // Parts smaller than a few shadow-map texels add nothing to the shadow but a draw.
      mesh.castShadow = !NO_SHADOW.has(name);
      mesh.receiveShadow = true;
      if (name === 'torso' || name === 'thigh') mesh.customDepthMaterial = bendDepth(name);
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
    // A new match has new Player objects: always draw the current ones.
    this.list = [...match.players, ...this.extra];
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
    // Boots: a random pick per player each match, classic and modern colourways.
    const BOOTS: [number, number][] = [
      [0x1b1b1d, 0xe8e6df], // black / white sole
      [0xf0efe9, 0x1b1b1d], // white / black
      [0xe9f23a, 0x1b1b1d], // volt
      [0xff6a2b, 0xf0efe9], // orange
      [0xff4f9a, 0x1b1b1d], // pink
      [0x2fd3e8, 0xf0efe9], // cyan
      [0xd8262f, 0x1b1b1d], // red
      [0x2457d6, 0xf0efe9], // royal blue
      [0x29b36a, 0x1b1b1d], // green
      [0xd9b04a, 0x1b1b1d], // gold
      [0xb9bdc4, 0x2a2a2a], // silver
      [0x6a3fd1, 0xe9f23a], // purple / volt
    ];
    const num = this.parts.torso.mesh.geometry.getAttribute('aNum') as THREE.InstancedBufferAttribute;
    const REF_KIT = { shirt: 0x17181b, shirt2: 0xf2c94c, shorts: 0x17181b, socks: 0x17181b, gkShirt: 0x17181b, gkShorts: 0x17181b };
    for (const p of this.list) {
      const kit = p.team === 2 ? REF_KIT : match.teams[p.team].info.kit;
      const gk = p.role === 'GK';
      const shirt = gk ? kit.gkShirt : kit.shirt;
      const trim = gk ? kit.gkShorts : kit.shirt2;
      const shorts = gk ? kit.gkShorts : kit.shorts;
      set('torso', p, shirt);
      attr('torso', 'aTrim', p, trim);
      // Numbers in the trim colour unless that's too close to the shirt.
      attr('torso', 'aNumCol', p, gk ? 0x1d1d1d : kit.shirt2 === kit.shirt ? 0xffffff : kit.shirt2);
      num.setX(p.id, p.team === 2 ? -1 : p.number > 0 ? p.number : gk ? 1 : p.index + 1);
      set('upperArm', p, shirt);
      attr('upperArm', 'aTrim', p, trim);
      attr('upperArm', 'aSkin', p, gk ? shirt : p.look.skin);
      set('forearm', p, gk ? shirt : p.look.skin);
      attr('forearm', 'aAlt', p, gk ? 0xf2f0ea : p.look.skin);
      set('hand', p, gk ? 0xf2f0ea : p.look.skin);
      set('pelvis', p, shorts);
      set('shortsLeg', p, shorts);
      attr('shortsLeg', 'aTrim', p, gk ? shirt : kit.shirt2 === kit.shorts ? kit.shirt : kit.shirt2);
      set('shin', p, gk ? kit.gkShorts : kit.socks);
      attr('shin', 'aTrim', p, gk ? kit.gkShirt : kit.shirt2);
      set('neck', p, p.look.skin);
      set('head', p, p.look.skin);
      set('thigh', p, p.look.skin);
      for (const hp of HAIR_PARTS) set(hp, p, p.look.hair);
      const [boot, sole] = BOOTS[Math.floor(Math.random() * BOOTS.length)];
      set('boot', p, boot);
      attr('boot', 'aTrim', p, sole);
    }
    num.needsUpdate = true;
    for (const name of Object.keys(this.parts) as PartName[]) {
      const m = this.parts[name].mesh;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    // Snapshot the kit attributes: culling packs visible players to the front.
    this.statics = [];
    this.packedFor = null;
    for (const name of Object.keys(this.parts) as PartName[]) {
      const { mesh, perPlayer } = this.parts[name];
      const keep = (attr: THREE.BufferAttribute | null) => attr && this.statics.push({ attr, master: (attr.array as Float32Array).slice(), per: perPlayer });
      keep(mesh.instanceColor);
      for (const [k, a] of Object.entries(mesh.geometry.attributes)) {
        if (k !== 'aBend' && (a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute) keep(a as THREE.BufferAttribute);
      }
    }
  }

  /**
   * Draw only players the camera can see (with a margin for the long evening shadows they
   * throw into view): pack their instances to the front of every part's buffers and draw
   * that many. Off-screen players then cost nothing in either the shadow or the main pass.
   */
  private cull(): void {
    const vis = this.visible;
    vis.length = 0;
    const cam = this.camera;
    if (cam) {
      cam.updateMatrixWorld();
      this.projView.copy(cam.matrixWorld).invert().premultiply(cam.projectionMatrix);
      this.frustum.setFromProjectionMatrix(this.projView);
    }
    for (let i = 0; i < this.list.length; i++) {
      const p = this.list[i];
      this.sphere.center.set(p.pos.x, 1, p.pos.z);
      this.sphere.radius = 7; // a margin for long evening shadows thrown into view
      if (!cam || this.frustum.intersectsSphere(this.sphere)) vis.push(p.id);
    }
    const n = vis.length;
    for (const name of Object.keys(this.parts) as PartName[]) {
      const { mesh, perPlayer: per } = this.parts[name];
      // Rewritten every frame: pack in place (slots only move toward the front).
      const pack = (attr: THREE.BufferAttribute, size: number) => {
        const a = attr.array as Float32Array;
        for (let j = 0; j < n; j++) {
          if (vis[j] === j) continue;
          a.copyWithin(j * per * size, vis[j] * per * size, (vis[j] + 1) * per * size);
        }
      };
      pack(mesh.instanceMatrix, 16);
      const b = mesh.geometry.getAttribute('aBend') as THREE.BufferAttribute | undefined;
      if (b) pack(b, 3);
      mesh.count = n * per;
    }
    // Kit attributes: copied from the master in the same order — only when the visible set
    // changes (they don't change otherwise, so there's nothing to upload).
    const prev = this.packedFor;
    let same = prev !== null && prev.length === n;
    for (let j = 0; same && j < n; j++) same = prev![j] === vis[j];
    if (!same) {
      this.packedFor = vis.slice();
      for (const { attr, master, per } of this.statics) {
        const a = attr.array as Float32Array;
        const size = attr.itemSize;
        for (let j = 0; j < n; j++) a.set(master.subarray(vis[j] * per * size, (vis[j] + 1) * per * size), j * per * size);
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, n * per * size);
        attr.needsUpdate = true;
      }
    }
    // Per-frame data: upload only the part that's drawn.
    for (const name of Object.keys(this.parts) as PartName[]) {
      const { mesh, perPlayer: per } = this.parts[name];
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, n * per * 16);
      const b = mesh.geometry.getAttribute('aBend') as THREE.BufferAttribute | undefined;
      if (b) {
        b.clearUpdateRanges();
        b.addUpdateRange(0, n * per * 3);
      }
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
    const dt = clamp(time - this.lastTime, 0, 0.05);
    this.lastTime = time;
    const held = match.heldBy;
    const throwIn = match.setPiece?.kind === 'throw';
    const ball = match.ball;
    const bend = this.parts.torso.mesh.geometry.getAttribute('aBend') as THREE.InstancedBufferAttribute;
    const kneeBend = this.parts.thigh.mesh.geometry.getAttribute('aBend') as THREE.InstancedBufferAttribute;
    const off = this.officials;
    if (this.list[0] !== match.players[0]) this.applyColors(match);
    for (const p of this.list) {
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
      const id = p.id;

      // ---------------- base gait
      const sinP = Math.sin(phi);
      const cosP = Math.cos(phi);
      const moveAmt = smoothstep(0.15, 1.2, speed);
      // Feet shuffle when turning on the spot (the sim advances the stride for it).
      const stepAmt = Math.max(moveAmt, Math.min(1, Math.abs(df) * 18));
      const aHip = (0.12 + 0.62 * s) * stepAmt;
      let hipL = aHip * sinP;
      let hipR = -aHip * sinP;
      const kneeAmp = (0.25 + 1.35 * s) * stepAmt;
      let kneeL = 0.06 + kneeAmp * Math.pow(Math.max(0, cosP), 1.4) + 0.12 * s;
      let kneeR = 0.06 + kneeAmp * Math.pow(Math.max(0, -cosP), 1.4) + 0.12 * s;
      let legOutL = 0.04;
      let legOutR = 0.04;
      let legYawL = 0;
      let legYawR = 0;
      const aArm = (0.1 + 0.7 * s) * moveAmt;
      let armL = -aArm * sinP;
      let armR = aArm * sinP;
      let elbowL = 0.25 + 1.05 * s * moveAmt;
      let elbowR = elbowL;
      let armOutL = 0.1;
      let armOutR = 0.1;
      let hipY = HIP_Y - (0.012 + 0.05 * s) * Math.abs(cosP) * moveAmt;
      // Hips rotate and drop with each stride; the shoulders counter-rotate.
      let pelvisYaw = -0.1 * s * sinP * moveAmt;
      let pelvisRoll = 0.05 * (0.3 + s) * sinP * moveAmt;
      let twist = 0.16 * s * sinP * moveAmt;
      let flexExtra = 0;
      let sideExtra = 0;
      let leanF = p.leanFwd * 0.5;
      let leanS = -p.leanSide;
      let roll = 0;
      let lift = 0;
      let headPitch = 0;
      let headLook = true;

      // Side-steps and backpedalling: when moving across or against the way the body faces
      // (keepers on their line, defenders jockeying) the legs shuffle instead of striding.
      {
        const cf = Math.cos(facing);
        const sf = Math.sin(facing);
        const vf = p.vel.x * cf + p.vel.z * sf;
        const vl = -p.vel.x * sf + p.vel.z * cf;
        const slowEnough = 1 - smoothstep(4.5, 6.5, speed);
        const sideAmt = speed > 0.25 ? clamp(Math.abs(vl) / speed, 0, 1) * moveAmt * slowEnough : 0;
        const backAmt = vf < -0.3 ? clamp(-vf / Math.max(speed, 0.01), 0, 1) * slowEnough : 0;
        if (backAmt > 0.5) {
          // Backpedal: same stride, legs swing the other way, short quick steps.
          hipL = -hipL * 0.7;
          hipR = -hipR * 0.7;
          flexExtra += 0.12;
        }
        if (sideAmt > 0) {
          const k = sideAmt * sideAmt;
          hipL *= 1 - k * 0.85;
          hipR *= 1 - k * 0.85;
          // Step out with one leg, bring the other to it.
          legOutL += k * (0.06 + 0.22 * Math.max(0, sinP));
          legOutR += k * (0.06 + 0.22 * Math.max(0, -sinP));
          kneeL += k * 0.3;
          kneeR += k * 0.3;
          hipL += k * 0.15;
          hipR += k * 0.15;
          hipY -= k * 0.07;
          armL *= 1 - k;
          armR *= 1 - k;
          armOutL += k * 0.25;
          armOutR += k * 0.25;
          pelvisYaw *= 1 - k;
          twist *= 1 - k;
          flexExtra += k * 0.12;
        }
      }

      // Idle breathing.
      if (moveAmt < 1) {
        const br = Math.sin(time * 2.1 + p.id) * 0.015 * (1 - moveAmt);
        armOutL += br;
        armOutR += br;
        flexExtra += br * 0.6;
      }

      // Into a turn: the outside arm swings wider for balance.
      armOutL += Math.max(0, -leanS) * 0.5;
      armOutR += Math.max(0, leanS) * 0.5;

      // Keeper ready stance: athletic crouch, hands out in front. When danger is close (an
      // opponent on the ball near goal, or a shot coming) he gets set: lower, weight on the
      // toes with a small bounce, hands up and forward.
      if (p.role === 'GK' && speed < 4.5 && p.action === 'none' && held !== p && match.phase === 'play') {
        const own = -match.teams[p.team].dir * 52.5;
        const carrier = match.owner;
        const ballD = Math.hypot(ball.pos.x - own, ball.pos.z);
        const threat = (carrier && carrier.team !== p.team && ballD < 30) || (ball.vel.x * Math.sign(own) > 8 && ballD < 35);
        const set = threat ? 1 : smoothstep(45, 25, ballD) * 0.5;
        const calm = 1 - smoothstep(0.3, 2.5, speed) * 0.5;
        kneeL += (0.3 + 0.25 * set) * calm;
        kneeR += (0.3 + 0.25 * set) * calm;
        hipL += (0.18 + 0.12 * set) * calm;
        hipR += (0.18 + 0.12 * set) * calm;
        hipY -= (0.07 + 0.07 * set) * calm;
        if (speed < 1) hipY += Math.max(0, Math.sin(time * 9 + p.id)) * 0.018 * set;
        armOutL = armOutR = 0.38 + 0.12 * set;
        armL = armR = -0.45 - 0.35 * set;
        elbowL = elbowR = 0.7;
        flexExtra += 0.2 + 0.1 * set;
        legOutL = legOutR = Math.max(legOutL, 0.12);
      }

      // Dribble touch: quick flick of the leading leg, body over the ball.
      if (p.action === 'none' && p.sinceTouch < 0.2 && match.owner === p) {
        const k = Math.sin((p.sinceTouch / 0.2) * Math.PI);
        if (sinP > 0) {
          hipL += 0.35 * k;
          kneeL *= 1 - 0.5 * k;
        } else {
          hipR += 0.35 * k;
          kneeR *= 1 - 0.5 * k;
        }
        flexExtra += 0.08 * k;
      }

      // ---------------- actions
      const pr = p.actionDur > 0 ? clamp(p.actionT / p.actionDur, 0, 1) : 0;
      switch (p.action) {
        case 'kick': {
          // Body mechanics depend on the strike: side-foot passes open the hip toward the
          // target; driven shots lean over the ball; lofted balls and over-hit shots lean
          // back; the follow-through goes where the ball goes.
          const type = p.kickType;
          const power = Math.min(1.15, p.kickPower);
          const shot = type === 'shot';
          const lofted = p.kickLofted && !shot;
          const ground = !shot && !lofted;
          const back = ground ? -0.5 : shot ? -(0.7 + 0.35 * Math.min(1, power)) : -1.0;
          const fwd = ground ? 0.75 : shot ? 1.15 + 0.35 * power : 1.45;
          const kneeTop = ground ? 1.15 : 1.6;
          let sw: number;
          let kn: number;
          if (pr < 0.4) {
            sw = lerp(0, back, pr / 0.4);
            kn = lerp(0.2, kneeTop, pr / 0.4);
          } else if (pr < 0.62) {
            const t = (pr - 0.4) / 0.22;
            sw = lerp(back, fwd, t);
            kn = lerp(kneeTop, 0.08, t);
          } else {
            const t = (pr - 0.62) / 0.38;
            sw = lerp(fwd, 0.25, t);
            kn = lerp(0.08, 0.3, t);
          }
          // Target direction in the body's frame (+ = to the player's left).
          const tgt = clamp(-p.kickRel, -1.2, 1.2);
          const swingPhase = smoothstep(0.35, 0.65, pr);
          const right = p.kickLeg > 0;
          // Side-foot: hip turns out so the inside of the foot faces the target.
          const open = ground ? (right ? -0.6 : 0.6) : 0;
          const across = tgt * 0.55 * swingPhase;
          const plantKnee = shot ? 0.42 : 0.28;
          const counterArm = shot || lofted ? 1.05 : 0.8;
          if (right) {
            hipR = sw;
            kneeR = kn;
            legYawR = open + across;
            hipL = 0.12;
            kneeL = plantKnee;
            armOutL = counterArm;
            armL = -0.45;
            armOutR = 0.45;
            armR = 0.35;
          } else {
            hipL = sw;
            kneeL = kn;
            legYawL = open + across;
            hipR = 0.12;
            kneeR = plantKnee;
            armOutR = counterArm;
            armR = -0.45;
            armOutL = 0.45;
            armL = 0.35;
          }
          const wind = Math.sin(pr * Math.PI);
          // Shoulders wind up away from the kicking leg, then unwind toward the target.
          twist = -p.kickLeg * 0.28 * wind * (1 - swingPhase) + tgt * 0.4 * swingPhase;
          pelvisYaw = p.kickLeg * 0.2 * wind * (1 - swingPhase) + tgt * 0.3 * swingPhase;
          const lean = ground ? 0.08 : lofted ? -0.22 : power > 0.95 ? -0.24 : 0.16 - power * 0.06;
          flexExtra += lean * smoothstep(0.25, 0.6, pr) * (1 - smoothstep(0.8, 1, pr));
          sideExtra += -p.kickLeg * 0.12 * wind; // lean away from the kicking leg
          hipY -= shot ? 0.06 : 0.04;
          if (shot) lift = 0.05 * power * Math.max(0, Math.sin((pr - 0.6) * Math.PI * 2.5)) * (pr > 0.6 ? 1 : 0);
          headLook = false;
          headPitch = 0.25; // eyes on the ball at contact
          break;
        }
        case 'tackle': {
          const k = Math.sin(Math.min(1, pr * 1.6) * Math.PI * 0.5) * (1 - smoothstep(0.7, 1, pr));
          hipR = lerp(hipR, 1.1, k);
          kneeR = lerp(kneeR, 0.12, k);
          hipL = lerp(hipL, -0.3, k);
          kneeL = lerp(kneeL, 0.9, k);
          hipY -= 0.2 * k;
          leanF += 0.15 * k;
          flexExtra += 0.3 * k;
          armOutL = armOutR = 0.6 * k + 0.1;
          break;
        }
        case 'slide': {
          const k = smoothstep(0, 0.18, pr) * (1 - smoothstep(0.75, 1, pr));
          leanF = lerp(leanF, -1.0, k);
          flexExtra += 0.25 * k; // curl up over the legs
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
          roll = -side * this.pose.roll;
          lift = this.pose.lift;
          leanF = 0;
          leanS = 0;
          const dip = 1 - smoothstep(0.0, 0.07, pr); // load the near leg before take-off
          const fly = smoothstep(0.02, 0.17, pr) * (1 - smoothstep(0.42, 0.56, pr));
          const lie = smoothstep(0.42, 0.56, pr) * (1 - smoothstep(0.74, 0.86, pr));
          const rise = smoothstep(0.72, 0.86, pr) * (1 - smoothstep(0.9, 1.0, pr));
          const reach = smoothstep(0.015, 0.19, pr) * (1 - smoothstep(0.74, 0.9, pr));
          hipY = HIP_Y - dip * 0.14 - rise * 0.38;
          // Near (push) leg drives straight; the far leg trails, bent.
          const nearL = side > 0;
          const push = { hip: 0.1 * fly, knee: lerp(0.9 * dip + 0.15, 0.08, fly) };
          const trail = { hip: 0.55 * fly + 0.2 * lie, knee: 1.1 * fly + 0.5 * lie };
          const kneelHip = 0.9 * rise;
          const kneelKnee = 1.6 * rise;
          if (nearL) {
            hipL = push.hip + kneelHip;
            kneeL = push.knee + kneelKnee;
            hipR = trail.hip + kneelHip * 0.4;
            kneeR = trail.knee + kneelKnee * 0.6;
          } else {
            hipR = push.hip + kneelHip;
            kneeR = push.knee + kneelKnee;
            hipL = trail.hip + kneelHip * 0.4;
            kneeL = trail.knee + kneelKnee * 0.6;
          }
          // Arms stretch along the body toward the ball; the top hand comes over.
          const up = lerp(-0.6, -3.05, reach);
          armL = lerp(armL, up, Math.max(reach, 0.2));
          armR = lerp(armR, up, Math.max(reach, 0.2));
          armOutL = nearL ? 0.06 : 0.22 * reach + 0.08;
          armOutR = nearL ? 0.22 * reach + 0.08 : 0.06;
          elbowL = elbowR = lerp(0.6, 0.06, reach);
          sideExtra += -side * 0.14 * fly; // arch toward the ball
          flexExtra += 0.25 * lie + 0.3 * rise; // curl on landing, lean forward to rise
          headLook = false;
          headPitch = 0.15 * fly;
          break;
        }
        case 'catch': {
          // Hands meet the ball at its height, then gather it into the chest.
          const yH = clamp(p.catchY, 0.1, 2.4);
          const meet = 1 - smoothstep(0.25, 0.6, pr);
          const reachSwing = yH > 1.6 ? -2.5 : yH > 0.9 ? -1.5 : -0.75;
          armL = armR = lerp(-1.0, reachSwing, meet);
          elbowL = elbowR = lerp(1.35, 0.25, meet);
          armOutL = armOutR = lerp(0.0, 0.12, meet);
          const low = 1 - smoothstep(0.3, 0.8, yH);
          kneeL += 0.7 * low + 0.25;
          kneeR += 0.7 * low + 0.25;
          hipL += 0.35 * low;
          hipR += 0.35 * low;
          hipY -= 0.25 * low + 0.04;
          flexExtra += 0.45 * low + 0.18 * (1 - meet); // smother low balls, cushion the rest
          if (yH > 1.8) lift = 0.18 * Math.sin(Math.min(1, pr * 1.6) * Math.PI);
          headLook = false;
          headPitch = 0.2;
          break;
        }
        case 'header': {
          const k = Math.sin(pr * Math.PI);
          lift = 0.38 * k;
          // Arch back, then snap the upper body through the ball.
          flexExtra += pr < 0.45 ? -0.3 * (pr / 0.45) : lerp(-0.3, 0.35, smoothstep(0.45, 0.7, pr)) * (1 - smoothstep(0.75, 1, pr));
          headPitch = 0.35 * Math.sin(Math.min(1, pr * 2) * Math.PI);
          armOutL = armOutR = 0.7 * k + 0.1;
          armL = armR = -0.4 * k;
          kneeL = kneeR = 0.45 * k + 0.1;
          headLook = false;
          break;
        }
        case 'throw': {
          if (p.throwIn) {
            const k = pr < 0.5 ? pr / 0.5 : 1 - (pr - 0.5) / 0.5;
            armL = armR = lerp(-2.8, -1.4, 1 - k);
            elbowL = elbowR = lerp(1.4, 0.2, 1 - k);
            flexExtra += lerp(-0.25, 0.25, smoothstep(0.3, 0.7, pr));
          } else {
            // Keeper's one-arm throw: wind back, whip over the top, step into it.
            const wind = 1 - smoothstep(0.15, 0.5, pr);
            const whip = smoothstep(0.35, 0.65, pr);
            armR = lerp(lerp(0, 1.3, smoothstep(0, 0.3, pr)), -1.0, whip) + (whip > 0 && whip < 1 ? -1.6 * Math.sin(whip * Math.PI) : 0);
            elbowR = lerp(0.9, 0.15, whip);
            armOutR = 0.25;
            armL = -1.2 * wind - 0.4;
            armOutL = 0.2;
            twist = lerp(-0.45, 0.45, whip);
            pelvisYaw = lerp(-0.2, 0.25, whip);
            hipL = 0.45 * smoothstep(0.2, 0.5, pr);
            kneeL = 0.35;
            flexExtra += lerp(-0.15, 0.25, whip);
          }
          break;
        }
        case 'stumble': {
          const k = Math.sin(pr * Math.PI);
          leanF += 0.2 * k;
          flexExtra += 0.35 * k;
          sideExtra += Math.sin(p.id * 3.1) * 0.25 * k;
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
          flexExtra -= 0.12;
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
        flexExtra -= 0.25;
      } else if (match.phase === 'goal' && match.scorer && match.scorer.team === p.team && match.phaseT > 1.2) {
        armOutL = armOutR = 0.3 + 0.2 * Math.sin(time * 9 + p.id);
      }

      // Officials' signals: the referee points for a restart, linesmen raise the flag.
      if (p.team === 2 && off) {
        if (p === off.ref && off.refPoint > 0) {
          const k = smoothstep(0, 0.25, off.refPoint) * smoothstep(2.2, 1.9, off.refPoint);
          armR = lerp(armR, -1.45, k);
          armOutR = lerp(armOutR, 0.15, k);
          elbowR = lerp(elbowR, 0.05, k);
        }
        const li = off.lines.indexOf(p);
        if (li >= 0) {
          const up = smoothstep(0, 0.2, off.flagUp[li]) * smoothstep(2.0, 1.8, off.flagUp[li]);
          armR = lerp(armR * 0.5, -2.95, up);
          armOutR = lerp(0.12, 0.08, up);
          elbowR = lerp(0.35, 0.05, up);
        }
      }

      // ---------------- body physics: a springy spine driven by the movement
      // The upper body carries inertia: it pitches with acceleration and braking, swings
      // past and settles (underdamped spring), and bends a little out of turns. The head
      // stays level and tracks the ball.
      const flexTarget = clamp(p.leanFwd * 0.8 - p.accelFwd * 0.012 + s * 0.06 + flexExtra, -0.6, 0.7);
      const sideTarget = clamp(-leanS * 0.4 + sideExtra, -0.45, 0.45);
      const w = 13;
      const zeta = 0.42;
      this.spF[id] += (w * w * (flexTarget - this.sF[id]) - 2 * zeta * w * this.spF[id]) * dt;
      this.sF[id] += this.spF[id] * dt;
      this.spS[id] += (w * w * (sideTarget - this.sS[id]) - 2 * zeta * w * this.spS[id]) * dt;
      this.sS[id] += this.spS[id] * dt;
      const spineFlex = this.sF[id];
      const spineSide = this.sS[id];

      if (headLook) {
        const rel = Math.atan2(ball.pos.z - z, ball.pos.x - x) - facing;
        const r = Math.atan2(Math.sin(rel), Math.cos(rel));
        const limit = 1.1 - 0.6 * s;
        const want = Math.abs(r) < 2.4 ? clamp(-r, -limit, limit) : 0;
        this.headYaw[id] += (want - this.headYaw[id]) * (1 - Math.exp(-dt * 6));
      } else {
        this.headYaw[id] *= Math.exp(-dt * 8);
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

      const P = this.chain(this.pelvis, R, 0, hipY, 0, 0, pelvisYaw, pelvisRoll);
      const build = p.look.build;
      this.put('pelvis', id, P, build, 1, 1);
      // Torso mesh sits at the waist unrotated; the shader bends it through the spine.
      const T = this.chain(this.j3, P, 0, 0.04, 0, 0, 0, 0);
      this.put('torso', id, T, build, 1, 1);
      const flex = spineFlex + 0.04;
      const tw = twist - pelvisYaw;
      const side = spineSide - pelvisRoll;
      bend.setXYZ(id, flex, tw, side);
      const C = this.chain(this.chest, T, 0, 0, 0, flex, tw, side);
      this.chain(this.j1, C, 0, 0.58, 0, 0, 0, 0);
      this.put('neck', id, this.j1);

      // Head: level gaze (counter the body's pitch and roll), turned toward the ball.
      const headLevel = -(leanF + flex) * 0.75;
      const headRoll = -(leanS + roll * 0.2 + side) * 0.6;
      this.chain(this.j1, C, 0, 0.6, 0, headPitch + headLevel, this.headYaw[id], headRoll);
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
        const sideSign = sd === 0 ? 1 : -1;
        const swing = sd === 0 ? armL : armR;
        const out = sd === 0 ? armOutL : armOutR;
        const elbow = sd === 0 ? elbowL : elbowR;
        this.chain(this.j1, C, sideSign * 0.198 * build, 0.5, 0, -swing, 0, sideSign * out);
        this.put('upperArm', id * 2 + sd, this.j1);
        this.chain(this.j2, this.j1, 0, -0.29, 0, -elbow, 0, 0);
        this.put('forearm', id * 2 + sd, this.j2);
        // Hand at the wrist, relaxed with the palm toward the body; keeper gloves are bigger.
        this.chain(this.j3, this.j2, 0, -0.245, 0, 0.1, 0, sideSign * -0.08);
        const g = p.role === 'GK' ? 1.25 : 1;
        this.put('hand', id * 2 + sd, this.j3, g, g, g);
        if (sd === 1) {
          if (off && off.lines.includes(p)) this.chain(this.sm, this.j3, 0, -0.08, 0.02, 0, 0, 0), this.parts.flag.mesh.setMatrixAt(id, this.sm);
          else this.parts.flag.mesh.setMatrixAt(id, this.hidden);
        }
      }

      // Legs: the thigh curves into a soft knee (shader bend), the shin takes the rest.
      for (let sd = 0; sd < 2; sd++) {
        const sideSign = sd === 0 ? 1 : -1;
        const hip = sd === 0 ? hipL : hipR;
        const knee = sd === 0 ? kneeL : kneeR;
        const out = sd === 0 ? legOutL : legOutR;
        const yaw = sd === 0 ? legYawL : legYawR;
        this.chain(this.j1, P, sideSign * 0.092, -0.03, 0, -hip, yaw, sideSign * out);
        this.put('shortsLeg', id * 2 + sd, this.j1);
        this.put('thigh', id * 2 + sd, this.j1);
        const soft = knee * 0.22;
        kneeBend.setXYZ(id * 2 + sd, soft, 0, 0);
        this.chain(this.j2, this.j1, 0, 0, 0, soft, 0, 0);
        this.chain(this.j2, this.j2, 0, -THIGH, 0, knee - soft, 0, 0);
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
    bend.needsUpdate = true;
    kneeBend.needsUpdate = true;

    this.cull();
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
