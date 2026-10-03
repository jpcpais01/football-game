import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GOAL_SEQ, PLAYER } from '../sim/constants';
import type { Match } from '../sim/match';
import { Player } from '../sim/player';
import { bodyShape, type BodyShape } from '../sim/body';
import type { Kit } from '../sim/teams';
import { clamp, lerp, smoothstep } from '../sim/vec';
import { PYLONS, SHARED, blobMaterial, litMaterial } from './look';
import { divePose, type DivePose } from '../sim/keeperPose';
import type { Officials } from './officials';
import type { Benches } from './bench';

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
  name: PartName;
  mesh: THREE.InstancedMesh;
  perPlayer: number;
  /** Player id drawn in each packed slot this frame (see cull). */
  order: number[];
}

const THIGH = 0.43;
const SHIN = 0.42;
const HIP_Y = 0.94;
/** Base standing height in skeleton units: hips, waist, torso to the head joint, head. */
const HEAD_TOP = 0.24;
const BASE_HEIGHT = HIP_Y + 0.04 + 0.6 + HEAD_TOP;
const HAIR_PARTS: PartName[] = ['hairShort', 'hairCurly', 'hairBun'];
/** Which hair mesh each look.hairStyle wears (0 and 1 share the short cut). */
const HAIR_OF_STYLE: PartName[] = ['hairShort', 'hairShort', 'hairCurly', 'hairBun'];
/** Too small to show in the sun's shadow map (~16 cm per texel), or inside another part's
 * shadow (the shorts round the thigh). */
const NO_SHADOW = new Set<PartName>(['hand', 'neck', 'boot', 'flag', 'forearm', 'shortsLeg', ...HAIR_PARTS]);
/**
 * Secondary-motion channels. Arms, forearms, head and shoulders carry inertia: they lag
 * and overshoot as the body speeds up, brakes, turns and lands, and swing into sudden
 * poses instead of snapping. Each channel: spring frequency (rad/s) and damping ratio.
 */
const SEC = {
  armL: 0,
  armR: 1,
  outL: 2,
  outR: 3,
  elbowL: 4,
  elbowR: 5,
  headPitch: 6,
  headRoll: 7,
  twist: 8,
  count: 9,
} as const;
const SEC_W = [10, 10, 9, 9, 13, 13, 14, 14, 11];
const SEC_Z = [0.45, 0.45, 0.4, 0.4, 0.42, 0.42, 0.5, 0.5, 0.5];
/** Channels that soak up a jump in the pose (the arms) rather than following it at once. */
const SEC_SOAK = 6;

/** Per-instance attributes written every frame by the pose (the rest only change with kits). */
const POSE_ATTRS = ['aBend', 'aToe'];

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
    return mergeGeometries([palm, fingers, thumb])!;
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
  // Enough rings along the boot for the toe to bend at the ball of the foot (see TOE_GLSL).
  const boot = new THREE.CapsuleGeometry(0.046, 0.16, 3, 10, 8);
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
    const a = stick;
    const b = cloth;
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

/** The bend rotation is built once per vertex and shared by the normal and the position
 * (depth materials have no normal chunk, so there it's built with the position). */
function injectBend(shader: { vertexShader: string }, kind: 'torso' | 'thigh', normals = true): void {
  shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${BEND_GLSL(kind)}`);
  shader.vertexShader = normals
    ? shader.vertexShader
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nmat3 bendR = bendRot(aBend * bendT(position));\nobjectNormal = bendR * objectNormal;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = bendR * transformed;')
    : shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = bendRot(aBend * bendT(position)) * transformed;');
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

/**
 * Toe break: each boot instance carries aToe (radians, + = toes bent up); the front of the
 * boot rotates about the ball of the foot, so the heel can lift off a planted toe and the
 * foot rolls through a step.
 */
const TOE_PIVOT = { y: -0.068, z: 0.105 };
const TOE_GLSL = /* glsl */ `
attribute float aToe;
vec3 toeRot(vec3 v, float w) {
  float a = -aToe * w;
  float c = cos(a), s = sin(a);
  return vec3(v.x, v.y * c - v.z * s, v.y * s + v.z * c);
}
float toeW(vec3 p) { return smoothstep(${TOE_PIVOT.z - 0.02}, ${TOE_PIVOT.z + 0.025}, p.z); }
`;

function withToe<T extends THREE.Material>(mat: T): T {
  const orig = mat.onBeforeCompile.bind(mat);
  mat.onBeforeCompile = (shader, r) => {
    orig(shader, r);
    const pv = `vec3(0.0, ${TOE_PIVOT.y}, ${TOE_PIVOT.z})`;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${TOE_GLSL}`)
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = toeRot(objectNormal, toeW(position));')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\ntransformed = ${pv} + toeRot(transformed - ${pv}, toeW(position));`);
  };
  mat.customProgramCacheKey = () => `toe-${mat.uuid}`;
  return mat;
}

/** Shadow-map material that bends the same way, so shadows match the body. */
function bendDepth(kind: 'torso' | 'thigh'): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (shader) => injectBend(shader, kind, false);
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
    vertDecl: 'attribute vec3 aTrim; attribute vec3 aNumCol; attribute float aNum; attribute float aPat; varying vec3 vTrim; varying vec3 vNumCol; varying float vNum; varying float vPat;',
    vertBody: 'vTrim = aTrim; vNumCol = aNumCol; vNum = aNum; vPat = aPat;',
    fragDecl: `${KIT_DECL}
      varying vec3 vNumCol; varying float vNum; varying float vPat;
      // Shirt designs (see KIT_PATTERNS): how much of the secondary colour shows at (u, v).
      // u runs round the body (0 = front centre, 0.5 = back), v up from the hem.
      float kitPattern(float pat, float u, float v) {
        float uc = fract(u + 0.5) - 0.5; // signed, 0 at the front centre
        float aa = 0.006;
        if (pat < 0.5) return 0.0;                                                        // plain
        if (pat < 1.5) return smoothstep(0.5 - aa * 8.0, 0.5 + aa * 8.0, fract(u * 9.0));   // stripes
        if (pat < 2.5) return smoothstep(0.5 - aa * 5.0, 0.5 + aa * 5.0, fract(v * 5.0 + 0.25)); // hoops
        if (pat < 3.5) return 1.0 - smoothstep(0.1, 0.16, abs(fract(u * 22.0) - 0.5) * 2.0);        // pinstripes
        if (pat < 4.5) return smoothstep(-aa, aa, uc);                                     // halves
        if (pat < 5.5) return 1.0 - smoothstep(0.075, 0.085, abs(uc * 1.25 + (v - 0.5) * 0.9)); // sash
        if (pat < 6.5) return 1.0 - smoothstep(0.045, 0.055, abs(v - 0.66 + abs(uc) * 1.1)); // chevron
        if (pat < 7.5) return abs(smoothstep(-aa, aa, uc) - smoothstep(0.5 - aa, 0.5 + aa, v)); // quarters
        if (pat < 8.5) return 1.0 - smoothstep(0.1, 0.11, abs(uc));                         // centre band
        return smoothstep(0.75, 0.05, v);                                                  // fade
      }
      uniform sampler2D uNumbers;
      float digit(vec2 p, float d) {
        if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return 0.0;
        return texture2D(uNumbers, vec2((d + p.x) / 10.0, p.y)).a;
      }`,
    diffuseHook: /* glsl */ `{
      float u = vUv2.x;
      float v = vUv2.y;
      vec3 base = mix(diffuseColor.rgb, vTrim, clamp(kitPattern(vPat, u, v), 0.0, 1.0));
      // Collar and side panels.
      float collar = smoothstep(0.86, 0.875, v);
      float side = (1.0 - smoothstep(0.012, 0.02, abs(u - 0.25))) + (1.0 - smoothstep(0.012, 0.02, abs(u - 0.75)));
      side *= smoothstep(0.1, 0.2, v) * (1.0 - smoothstep(0.7, 0.8, v)) * step(vPat, 0.5);
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
    vertDecl: 'attribute vec3 aTrim; attribute vec3 aSkin; attribute float aBand; varying vec3 vTrim; varying vec3 vSkin; varying float vBand;',
    vertBody: 'vTrim = aTrim; vSkin = aSkin; vBand = aBand;',
    fragDecl: `${KIT_DECL} varying vec3 vSkin; varying float vBand;`,
    diffuseHook: /* glsl */ `{
      float v = vUv2.y;
      vec3 c = diffuseColor.rgb;
      c = mix(c, vTrim, band(v, 0.43, 0.5));
      // The captain's armband (left arm).
      c = mix(c, vec3(1.0, 0.72, 0.05), vBand * band(v, 0.26, 0.4));
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
  private partList: Part[] = [];
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
  /** Per player id: its packed slot this frame (-1 = culled), and its slot in its own hair
   * mesh and in the flag mesh (only the hair style he wears and the linesmen's flags draw). */
  private slot: Int16Array;
  private hairSlot: Int16Array;
  private flagSlot: Int16Array;
  /** Visible set the kit attributes are currently packed for (null = needs packing). */
  private packedFor: number[] | null = null;
  /** Per-player attributes that only change with the kits: master copies for culling. */
  private statics: { attr: THREE.BufferAttribute; master: Float32Array; part: Part }[] = [];

  // scratch
  private e = new THREE.Euler();
  private loc = new THREE.Matrix4();
  private root = new THREE.Matrix4();
  private pelvis = new THREE.Matrix4();
  private chest = new THREE.Matrix4();
  private neck = new THREE.Matrix4();
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
  /** Secondary motion: per player and channel (see SEC), a damped spring offset on top of
   * the pose, its velocity, and the last pose value (to soak up sudden pose changes). */
  private sec: Float32Array;
  private secV: Float32Array;
  private secPose: Float32Array;
  private secReady: Uint8Array;
  /** Vertical motion of the hips (height, velocity, smoothed acceleration) and the last
   * facing seen, which drive the springs. */
  private bodyY: Float32Array;
  private bodyVy: Float32Array;
  private bodyAy: Float32Array;
  private lastFacing: Float32Array;
  /** Feet, per leg: where the planted foot's ball is on the grass, how much the leg is
   * held to it (0 = free, 1 = planted), and whether it's in its stance. Per player: how
   * much foot planting applies at all (off during actions that pose the legs). */
  private plantX: Float32Array;
  private plantZ: Float32Array;
  private footW: Float32Array;
  private inStance: Uint8Array;
  private ikOn: Float32Array;
  /** Smoothed turning rate (rad/s, + = turning right), from the facing the renderer sees. */
  private turnS: Float32Array;
  /** Keepers: how far into the ready stance (eased, so he never pops into or out of it). */
  private gkReady: Float32Array;
  private secPoseNow = new Float32Array(SEC.count);
  private secWant = new Float32Array(SEC.count);
  private pinv = new THREE.Matrix4();
  private ikH = 0;
  private ikK = 0;
  private ikOut = 0;
  private tv = new THREE.Vector3();
  /** Per player: body shape (see sim/body), hip height in the skeleton, and the overall
   * scale that keeps him at his real height whatever his proportions. */
  private body: BodyShape[] = [];
  private hipBase: Float32Array;
  private bodyScale: Float32Array;
  /** Everyone drawn: the 22 players plus the match officials. */
  private list: Player[];
  private extra: Player[];
  officials: Officials | null = null;
  /** The substitutes' benches (their sitting, squatting and reactions). */
  bench: Benches | null = null;
  /** No dugouts at this ground: the substitutes aren't drawn. */
  hideBench = false;
  private lastTime = 0;

  constructor(match: Match, extra: Player[] = []) {
    this.extra = extra;
    this.list = [...match.players, ...extra];
    this.n = this.list.length;
    this.slot = new Int16Array(this.n).fill(-1);
    this.hairSlot = new Int16Array(this.n).fill(-1);
    this.flagSlot = new Int16Array(this.n).fill(-1);
    this.sF = new Float32Array(this.n);
    this.spF = new Float32Array(this.n);
    this.sS = new Float32Array(this.n);
    this.spS = new Float32Array(this.n);
    this.headYaw = new Float32Array(this.n);
    this.sec = new Float32Array(this.n * SEC.count);
    this.secV = new Float32Array(this.n * SEC.count);
    this.secPose = new Float32Array(this.n * SEC.count);
    this.secReady = new Uint8Array(this.n);
    this.bodyY = new Float32Array(this.n);
    this.bodyVy = new Float32Array(this.n);
    this.bodyAy = new Float32Array(this.n);
    this.lastFacing = new Float32Array(this.n);
    this.plantX = new Float32Array(this.n * 2);
    this.plantZ = new Float32Array(this.n * 2);
    this.footW = new Float32Array(this.n * 2);
    this.inStance = new Uint8Array(this.n * 2);
    this.ikOn = new Float32Array(this.n);
    this.turnS = new Float32Array(this.n);
    this.gkReady = new Float32Array(this.n);
    this.hipBase = new Float32Array(this.n).fill(HIP_Y);
    this.bodyScale = new Float32Array(this.n).fill(1);
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
      boot: withToe(trimmedMaterial('diffuseColor.rgb = mix(diffuseColor.rgb, vTrim, 1.0 - smoothstep(0.018, 0.03, vWorldPos.y));', 0.5)),
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
      if (name === 'boot') add('aToe', 1);
      if (name === 'torso') {
        add('aTrim', 3);
        add('aNumCol', 3);
        add('aNum', 1);
        add('aPat', 1);
      } else if (name === 'upperArm') {
        add('aTrim', 3);
        add('aSkin', 3);
        add('aBand', 1);
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
      this.parts[name] = { name, mesh, perPlayer: per[name], order: [] };
      this.partList.push(this.parts[name]);
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

  /** The players were moved by hand (a cut): settle feet and secondary motion afresh. */
  snap(): void {
    this.secReady.fill(0);
    this.footW.fill(0);
    this.inStance.fill(0);
    this.ikOn.fill(0);
  }

  applyColors(match: Match): void {
    // A new match has new Player objects: always draw the current ones, from rest.
    this.list = [...match.players, ...this.extra];
    this.secReady.fill(0);
    this.footW.fill(0);
    this.inStance.fill(0);
    this.ikOn.fill(0);
    for (const p of this.list) {
      const b = bodyShape(p.attrs.height, p.attrs.weight, p.attrs.strength, p.id * 7 + p.index + (p.name ? p.name.length * 13 : 0));
      this.body[p.id] = b;
      const hip = (THIGH + SHIN) * b.leg + (HIP_Y - THIGH - SHIN);
      this.hipBase[p.id] = hip;
      this.bodyScale[p.id] = BASE_HEIGHT / (hip + 0.04 + 0.6 * b.torsoL + (b.neckLen - 1) * 0.08 + HEAD_TOP);
    }
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
    const pat = this.parts.torso.mesh.geometry.getAttribute('aPat') as THREE.InstancedBufferAttribute;
    const band = this.parts.upperArm.mesh.geometry.getAttribute('aBand') as THREE.InstancedBufferAttribute;
    const REF_KIT: Kit = { shirt: 0x17181b, shirt2: 0xf2c94c, shorts: 0x17181b, socks: 0x17181b, gkShirt: 0x17181b, gkShorts: 0x17181b };
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
      pat.setX(p.id, p.team === 2 || gk ? 0 : (kit.pattern ?? 0));
      num.setX(p.id, p.team === 2 ? -1 : p.number > 0 ? p.number : gk ? 1 : p.index + 1);
      set('upperArm', p, shirt);
      attr('upperArm', 'aTrim', p, trim);
      attr('upperArm', 'aSkin', p, gk ? shirt : p.look.skin);
      band.setX(p.id * 2, p.team < 2 && match.teams[p.team].captain === p.index && match.teams[p.team].players[p.index] === p ? 1 : 0);
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
    pat.needsUpdate = true;
    band.needsUpdate = true;
    for (const { mesh: m } of this.partList) {
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    // Snapshot the kit attributes: culling packs visible players to the front.
    this.statics = [];
    this.packedFor = null;
    for (const part of this.partList) {
      const { mesh } = part;
      const keep = (attr: THREE.BufferAttribute | null) => attr && this.statics.push({ attr, master: (attr.array as Float32Array).slice(), part });
      keep(mesh.instanceColor);
      for (const [k, a] of Object.entries(mesh.geometry.attributes)) {
        if (!POSE_ATTRS.includes(k) && (a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute) keep(a as THREE.BufferAttribute);
      }
    }
  }

  /**
   * Draw only players the camera can see (with a margin for the long evening shadows they
   * throw into view). Runs before posing: each visible player gets a packed slot at the
   * front of every part's buffers and is written straight there; off-screen players are not
   * posed at all and cost nothing in either the shadow or the main pass. Hair and the flag
   * pack separately, so only the hair style each player wears is drawn.
   */
  private cull(): void {
    const vis = this.visible;
    vis.length = 0;
    const cam = this.camera;
    if (cam) {
      cam.updateMatrixWorld();
      this.projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.projView);
    }
    this.slot.fill(-1);
    this.hairSlot.fill(-1);
    this.flagSlot.fill(-1);
    for (const part of this.partList) part.order.length = 0;
    const lines = this.officials?.lines;
    const benchFrom = this.hideBench && this.bench ? this.bench.all[0].id : Infinity;
    for (let i = 0; i < this.list.length; i++) {
      const p = this.list[i];
      this.sphere.center.set(p.pos.x, 1, p.pos.z);
      this.sphere.radius = 7; // a margin for long evening shadows thrown into view
      if (cam && !this.frustum.intersectsSphere(this.sphere)) continue;
      if (p.id >= benchFrom) continue;
      this.slot[p.id] = vis.length;
      vis.push(p.id);
      const hair = this.parts[HAIR_OF_STYLE[p.look.hairStyle] ?? 'hairBun'];
      this.hairSlot[p.id] = hair.order.length;
      hair.order.push(p.id);
      if (lines && lines.includes(p)) {
        this.flagSlot[p.id] = this.parts.flag.order.length;
        this.parts.flag.order.push(p.id);
      }
    }
    for (const part of this.partList) {
      if (part.name === 'flag' || HAIR_PARTS.includes(part.name)) continue;
      for (const id of vis) part.order.push(id);
    }
    const n = vis.length;
    for (const part of this.partList) {
      const { mesh, perPlayer: per } = part;
      const count = part.order.length * per;
      mesh.count = count;
      // three still issues a draw for an instanced mesh with nothing in it.
      mesh.visible = count > 0;
      // Per-frame data: upload only the part that's drawn.
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, count * 16);
      mesh.instanceMatrix.needsUpdate = true;
      for (const k of POSE_ATTRS) {
        const b = mesh.geometry.getAttribute(k) as THREE.BufferAttribute | undefined;
        if (!b) continue;
        b.clearUpdateRanges();
        b.addUpdateRange(0, count * b.itemSize);
        b.needsUpdate = true;
      }
    }
    // Kit attributes: copied from the master in the same order — only when the visible set
    // changes (they don't change otherwise, so there's nothing to upload).
    const prev = this.packedFor;
    let same = prev !== null && prev.length === n;
    for (let j = 0; same && j < n; j++) same = prev![j] === vis[j];
    if (!same) {
      this.packedFor = vis.slice();
      for (const { attr, master, part } of this.statics) {
        const a = attr.array as Float32Array;
        const w = part.perPlayer * attr.itemSize;
        const order = part.order;
        for (let j = 0; j < order.length; j++) a.set(master.subarray(order[j] * w, (order[j] + 1) * w), j * w);
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, order.length * w);
        attr.needsUpdate = true;
      }
    }
    // Ground shadows: one contact blob per visible player, and the floodlight fans only
    // once the floodlights are bright enough to throw them.
    const flood = SHARED.uFlood.value > 0.01;
    this.flood.visible = flood && n > 0;
    this.contact.visible = n > 0;
    this.contact.count = n;
    this.flood.count = flood ? n * PYLONS.length : 0;
    for (const m of [this.contact, this.flood]) {
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, m.count * 16);
      m.instanceMatrix.needsUpdate = true;
    }
  }

  /** out = parent * T(x,y,z) (no rotation). Safe with out === parent. */
  private chainT(out: THREE.Matrix4, parent: THREE.Matrix4, x: number, y: number, z: number): THREE.Matrix4 {
    const p = parent.elements;
    const o = out.elements;
    for (let i = 0; i < 4; i++) {
      const t = p[i] * x + p[4 + i] * y + p[8 + i] * z + p[12 + i];
      o[i] = p[i];
      o[4 + i] = p[4 + i];
      o[8 + i] = p[8 + i];
      o[12 + i] = t;
    }
    return out;
  }

  /** out = parent * T(x,y,z) * Rx(rx): a hinge (knees, ankles). Safe with out === parent. */
  private chainX(out: THREE.Matrix4, parent: THREE.Matrix4, x: number, y: number, z: number, rx: number): THREE.Matrix4 {
    const p = parent.elements;
    const o = out.elements;
    const c = Math.cos(rx);
    const sn = Math.sin(rx);
    for (let i = 0; i < 4; i++) {
      const a = p[i];
      const b = p[4 + i];
      const d = p[8 + i];
      const t = a * x + b * y + d * z + p[12 + i];
      o[i] = a;
      o[4 + i] = b * c + d * sn;
      o[8 + i] = d * c - b * sn;
      o[12 + i] = t;
    }
    return out;
  }

  /** Thigh (this.j1) and shin (this.j2) of a leg: the thigh's soft curve takes 0.22 of the knee. */
  private legChain(P: THREE.Matrix4, hipX: number, hip: number, yaw: number, out: number, knee: number, leg: number): void {
    this.chain(this.j1, P, hipX, -0.03, 0, -hip, yaw, out);
    const soft = knee * 0.22;
    this.chainX(this.j2, this.j1, 0, 0, 0, soft);
    this.chainX(this.j2, this.j2, 0, -THIGH * leg, 0, knee - soft);
  }

  /** local = T(x,y,z) * Ry * Rx * Rz ; out = parent * local */
  private chain(out: THREE.Matrix4, parent: THREE.Matrix4, x: number, y: number, z: number, rx: number, ry: number, rz: number): THREE.Matrix4 {
    this.e.set(rx, ry, rz, 'YXZ');
    this.loc.makeRotationFromEuler(this.e);
    this.loc.setPosition(x, y, z);
    return out.multiplyMatrices(parent, this.loc);
  }

  /** Instance `index` of a part = m * scale(sx, sy, sz), written straight into the buffer. */
  private put(name: PartName, index: number, m: THREE.Matrix4, sx = 1, sy = 1, sz = 1): void {
    const a = this.parts[name].mesh.instanceMatrix.array as Float32Array;
    const e = m.elements;
    const o = index * 16;
    for (let i = 0; i < 4; i++) {
      a[o + i] = e[i] * sx;
      a[o + 4 + i] = e[4 + i] * sy;
      a[o + 8 + i] = e[8 + i] * sz;
      a[o + 12 + i] = e[12 + i];
    }
  }

  /**
   * Two-bone leg IK: hip swing, knee and hip roll (this.ikH/ikK/ikOut) that put the ankle
   * on the world point in this.tv, for the leg at hipX on the pelvis (this.pinv is its
   * inverse) with the given yaw. False when the point is out of reach.
   */
  private legIK(hipX: number, yaw: number, sideSign: number, l1: number, l2: number): boolean {
    this.tv.applyMatrix4(this.pinv);
    const dx0 = this.tv.x - hipX;
    const dy = this.tv.y + 0.03;
    const dz0 = this.tv.z;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const dx = dx0 * cy - dz0 * sy;
    const dz = dx0 * sy + dz0 * cy;
    const D = Math.hypot(dx, dy, dz);
    if (D > (l1 + l2) * 1.12 || D < 0.25) return false;
    // The knee from the distance (its bend is shared with the thigh's soft curve: the
    // thigh turns by 0.22 of it at the hip, the shin by the rest at the knee) ...
    const kr = Math.acos(clamp((D * D - l1 * l1 - l2 * l2) / (2 * l1 * l2), -1, 1));
    const k = Math.min(2.4, kr / 0.78);
    const sk = 0.22 * k;
    const ay = -l1 - l2 * Math.cos(k - sk);
    const az = -l2 * Math.sin(k - sk);
    const vy = ay * Math.cos(sk) - az * Math.sin(sk);
    const vz = ay * Math.sin(sk) + az * Math.cos(sk);
    // ... then the hip roll that puts the leg over the point, then the swing onto it.
    const th = Math.asin(clamp(dx / Math.max(0.05, -vy), -0.6, 0.6));
    let h = Math.atan2(vz, vy * Math.cos(th)) - Math.atan2(dz, dy);
    h -= Math.PI * 2 * Math.floor((h + Math.PI) / (Math.PI * 2));
    this.ikH = h;
    this.ikK = k;
    this.ikOut = th * sideSign;
    return true;
  }

  update(match: Match, alpha: number, time: number): void {
    const dt = clamp(time - this.lastTime, 0, 0.05);
    this.lastTime = time;
    const held = match.heldBy;
    const throwIn = match.setPiece?.kind === 'throw';
    const ball = match.ball;
    const bend = this.parts.torso.mesh.geometry.getAttribute('aBend') as THREE.InstancedBufferAttribute;
    const kneeBend = this.parts.thigh.mesh.geometry.getAttribute('aBend') as THREE.InstancedBufferAttribute;
    const toe = this.parts.boot.mesh.geometry.getAttribute('aToe') as THREE.InstancedBufferAttribute;
    const off = this.officials;
    if (this.list[0] !== match.players[0]) this.applyColors(match);
    this.cull();
    const floodOn = this.flood.visible;
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
      // Extra ankle angle on top of the auto-levelled foot (- = toes pointed, instep strikes;
      // the final ankle angle itself is + = toes down).
      let ankleL = 0;
      let ankleR = 0;
      // Arms: they swing a beat behind the legs, further forward than back. Through the
      // forward swing the elbow closes and the hand comes in toward the middle of the
      // chest; going back the elbow opens and the arm tucks by the side. Walking, the arms
      // hang nearly straight; running, the elbows hold near a right angle.
      const aArm = (0.12 + 0.68 * s) * moveAmt;
      const swA = Math.sin(phi - 0.18);
      const fwdL = Math.max(0, -swA);
      const fwdR = Math.max(0, swA);
      // (Relative to the trunk, which leans forward at speed: the swing is set forward a
      // little to make up for it.)
      const reachF = 1 + 0.45 * s;
      const reachB = 1 - 0.3 * s;
      const bias = 0.15 * s * moveAmt;
      let armL = bias - aArm * swA * (fwdL > 0 ? reachF : reachB);
      let armR = bias + aArm * swA * (fwdR > 0 ? reachF : reachB);
      const elbow0 = 0.22 + 1.1 * s * moveAmt;
      const elbowSw = 0.5 * s * moveAmt;
      let elbowL = elbow0 + elbowSw * (fwdL - 0.6 * Math.max(0, swA));
      let elbowR = elbow0 + elbowSw * (fwdR - 0.6 * Math.max(0, -swA));
      let armOutL = 0.1 + 0.05 * s * moveAmt * (1 - fwdL);
      let armOutR = 0.1 + 0.05 * s * moveAmt * (1 - fwdR);
      // Upper-arm rotation about its own length (+ = forearm swings outward): inward on
      // the forward swing, so the hand crosses toward the chest.
      let armRotL = -0.3 * s * moveAmt * fwdL;
      let armRotR = -0.3 * s * moveAmt * fwdR;
      const hip0 = this.hipBase[id];
      // (Less drop with planted feet: the knees then bend to take it instead.)
      let hipY = hip0 - (0.012 + 0.05 * s) * Math.abs(cosP) * moveAmt * (1 - 0.45 * this.ikOn[id]);
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
      // Celebrations: an extra spin about the vertical, and a shift along the facing that
      // keeps a flip turning about the body's middle rather than the feet.
      let yawExtra = 0;
      let fwdShift = 0;

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

      // Changing direction: the body turns from the ground up. The head looks into the new
      // direction first and the hips lead the shoulders round (the spring on the shoulder
      // twist makes them lag); the feet point into the turn. In a cut at speed, he sinks
      // through the knees, the inside knee folds deeper and the outside leg pushes out
      // wide; pivoting on the spot, he drops a little onto bent knees.
      const turn = clamp(this.turnS[id], -10, 10);
      let headLead = 0;
      if (p.action === 'none') {
        const lean = clamp(Math.abs(leanS) / 0.3, 0, 1) * moveAmt;
        const pivot = Math.min(1, Math.abs(turn) / 9) * (1 - 0.5 * moveAmt);
        headLead = clamp(-0.045 * turn, -0.4, 0.4);
        pelvisYaw += clamp(-0.03 * turn, -0.3, 0.3);
        legYawL += clamp(-0.035 * turn, -0.3, 0.3);
        legYawR += clamp(-0.035 * turn, -0.3, 0.3);
        const inR = leanS > 0 ? 1 : 0; // turning right: the right leg is the inside one
        kneeL += lean * 0.28 * (1 - inR) + 0.1 * lean;
        kneeR += lean * 0.28 * inR + 0.1 * lean;
        legOutL += lean * 0.12 * inR;
        legOutR += lean * 0.12 * (1 - inR);
        hipY -= 0.05 * lean + 0.04 * pivot;
        kneeL += 0.2 * pivot;
        kneeR += 0.2 * pivot;
        flexExtra += 0.06 * lean + 0.08 * pivot;
      }

      // Idle breathing.
      if (moveAmt < 1) {
        const br = Math.sin(time * 2.1 + p.id) * 0.015 * (1 - moveAmt);
        armOutL += br;
        armOutR += br;
        flexExtra += br * 0.6;
      }

      // Keeper ready stance: athletic crouch, hands out in front at the waist, palms to
      // the ball. When danger is close (an opponent on the ball near goal, or a shot
      // coming) he gets set: lower, hands higher, weight on the toes with a small bounce.
      // Never still: the weight shifts foot to foot and the hands keep moving.
      if (p.role === 'GK') {
        const want = speed < 4.5 && p.action === 'none' && held !== p && match.phase === 'play' ? 1 : 0;
        const gr = (this.gkReady[id] += (want - this.gkReady[id]) * (1 - Math.exp(-dt * 6)));
        if (gr > 0.001) {
          const own = -match.teams[p.team].dir * 52.5;
          const carrier = match.owner;
          const ballD = Math.hypot(ball.pos.x - own, ball.pos.z);
          const threat = (carrier && carrier.team !== p.team && ballD < 30) || (ball.vel.x * Math.sign(own) > 8 && ballD < 35);
          const set = threat ? 1 : smoothstep(45, 25, ballD) * 0.5;
          const calm = (1 - smoothstep(0.3, 2.5, speed) * 0.5) * gr;
          const still = 1 - moveAmt;
          kneeL += (0.3 + 0.25 * set) * calm;
          kneeR += (0.3 + 0.25 * set) * calm;
          hipL += (0.18 + 0.12 * set) * calm;
          hipR += (0.18 + 0.12 * set) * calm;
          hipY -= (0.07 + 0.07 * set) * calm;
          if (speed < 1) hipY += Math.max(0, Math.sin(time * 9 + p.id)) * 0.018 * set * gr;
          roll += 0.035 * Math.sin(time * 1.6 + p.id * 1.3) * still * (1 - 0.6 * set) * gr;
          const hand = (k: number) => 0.06 * Math.sin(time * 2.3 + p.id + k) * (1 - 0.5 * set);
          armOutL = lerp(armOutL, 0.36 + 0.12 * set, gr);
          armOutR = lerp(armOutR, 0.36 + 0.12 * set, gr);
          armL = lerp(armL, 0.45 + 0.35 * set + hand(0), gr);
          armR = lerp(armR, 0.45 + 0.35 * set + hand(1.9), gr);
          elbowL = lerp(elbowL, 0.7 + 0.2 * set, gr);
          elbowR = lerp(elbowR, 0.7 + 0.2 * set, gr);
          armRotL = lerp(armRotL, 0.25, gr);
          armRotR = lerp(armRotR, 0.25, gr);
          flexExtra += (0.2 + 0.1 * set) * gr;
          legOutL = lerp(legOutL, Math.max(legOutL, 0.12), gr);
          legOutR = lerp(legOutR, Math.max(legOutR, 0.12), gr);
        }
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
          // A real strike, timed to the moment the sim sends the ball away (kickContact):
          //  1. the last stride is long: the standing leg reaches and plants beside the ball;
          //  2. back-lift: the kicking thigh goes back with the knee folded tight (heel up),
          //     hips turn back, the opposite arm swings out wide for balance;
          //  3. the thigh drives forward with the knee still folded, then the shin whips
          //     through as the thigh brakes (the knee snaps straight at contact), ankle locked;
          //  4. follow-through along the line of the ball and across the body; big shots
          //     carry the player off the ground in a little hop and he lands on the kicking
          //     foot. Side-foot passes are compact, hip turned out, body over the ball.
          const type = p.kickType;
          const power = Math.min(1.15, p.kickPower);
          const shot = type === 'shot';
          const lofted = p.kickLofted && !shot;
          const ground = !shot && !lofted;
          const finesse = shot && power < 0.55;
          // First-time strikes take the ball where it arrives: on the bounce he's over it, in
          // the air the leg rises to it and the body leans back and away (a side volley),
          // and a high one takes him off the ground.
          const vol = shot ? smoothstep(0.45, 0.95, p.kickHeight) : 0;
          const halfV = shot ? smoothstep(0.18, 0.4, p.kickHeight) * (1 - vol) : 0;
          // Reaching for it: how far, and how much of that is out to the side.
          const st = p.kickStretch;
          const sideFrac = clamp(Math.abs(p.kickBallL) / Math.max(0.3, Math.hypot(p.kickBallF, p.kickBallL)), 0, 1);
          const tc = Math.max(0.05, p.kickContact);
          const tf = Math.max(tc + 0.05, p.actionDur);
          const t = p.actionT;
          const u = clamp(t / tc, 0, 1); // wind-up and swing
          const v = clamp((t - tc) / (tf - tc), 0, 1); // follow-through
          const big = shot ? 0.55 + 0.45 * Math.min(1, power) : lofted ? 0.75 : 0.4;
          const easeOut = (a: number) => 1 - (1 - a) * (1 - a);
          const ease = (a: number) => a * a * (3 - 2 * a);
          // Blend in from the running pose, and back out to it at the end.
          const inK = smoothstep(0, 0.22, u);
          const outK = smoothstep(0.7, 1, v);
          const right = p.kickLeg > 0;

          // ---- kicking leg
          // A side-foot pass is a pendulum from the hip (short back-lift, knee only half
          // bent); an instep strike folds the knee right up.
          const backLift = ground ? -(0.12 + 0.4 * big) : -(0.2 + 0.65 * big) * (1 - 0.4 * vol);
          const heel = (ground ? 0.55 + 0.35 * big : 1.55 + 0.6 * big) * (1 - 0.35 * vol);
          const contactHip = (ground ? 0.4 : 0.32) + 1.05 * vol + 0.08 * halfV + 0.3 * st * (1 - sideFrac);
          const followHip = (ground ? 0.7 : lofted ? 1.55 : finesse ? 0.95 : 0.95 + 0.75 * big) + 0.4 * vol;
          let kHip: number;
          let kKnee: number;
          if (u < 0.5) {
            // The heel comes up first, the thigh follows it back.
            kHip = lerp(0.12, backLift, ease(u / 0.5));
            kKnee = lerp(0.35, heel, easeOut(Math.min(1, u / 0.32)));
          } else if (t < tc) {
            const a = (u - 0.5) / 0.5;
            kHip = lerp(backLift, contactHip, ease(a));
            // Knee folds a touch more as the thigh drives, then whips straight.
            const fold = heel * (1 + 0.08 * smoothstep(0, 0.4, a));
            kKnee = lerp(fold, 0.1, Math.pow(smoothstep(0.38, 1, a), 1.3));
          } else {
            const rise = easeOut(smoothstep(0, 0.42, v));
            const fall = smoothstep(0.42, 1, v);
            kHip = lerp(lerp(contactHip, followHip, rise), 0.18, fall);
            kKnee = lerp(lerp(0.1, 0.22, rise), 0.42, fall);
          }
          // Toes: pointed for the instep (locked through contact), set for a side-foot.
          const lock = smoothstep(0.35, 0.6, u) * (1 - smoothstep(0.3, 0.7, v));
          const kAnkle = (ground ? -0.12 : lofted ? -0.55 : -0.85) * lock;
          // The leg loops slightly out on the back-lift and finishes across the body.
          const kOut = 0.04 + 0.14 * big * Math.sin(Math.PI * Math.min(1, u / 0.85)) * (u < 1 ? 1 : 0) - (shot ? 0.24 : 0.1) * big * smoothstep(0, 0.6, v) * (1 - smoothstep(0.6, 1, v));
          // Side-foot: hip turned out so the inside of the foot faces the target.
          const open = ground ? (right ? -0.65 : 0.65) * (1 - smoothstep(0.4, 1, v)) : 0;
          const tgt = clamp(-p.kickRel, -1.2, 1.2);
          const swingPhase = smoothstep(0.5, 1, u);
          const across = tgt * 0.45 * swingPhase * (1 - v * 0.5);
          // A volley swings round from the side rather than straight through.
          const kOutVol = (0.35 * vol + 0.45 * st * sideFrac) * swingPhase * (1 - smoothstep(0.5, 1, v));

          // ---- standing leg: reaches on the last stride, plants, takes the load, the body
          // passes over it; a big strike lifts it off the ground for a moment.
          let pHip: number;
          let pKnee: number;
          if (u < 0.55) {
            const a = ease(u / 0.55);
            pHip = lerp(0.2, 0.48, a);
            pKnee = lerp(0.55, 0.2, a);
          } else if (t < tc) {
            const a = (u - 0.55) / 0.45;
            pHip = lerp(0.48, 0.14, ease(a));
            pKnee = lerp(0.2, shot ? 0.48 : 0.36, ease(a));
          } else {
            pHip = lerp(0.14, -0.38, ease(smoothstep(0, 0.85, v)));
            pKnee = lerp(shot ? 0.48 : 0.36, 0.3, v);
          }
          // Stretching: the standing leg sinks and takes the load.
          pKnee += 0.5 * st * smoothstep(0.4, 1, u) * (1 - smoothstep(0.4, 1, v));
          const hop =
            (shot && power > 0.55 ? Math.sin(Math.PI * smoothstep(0.08, 0.62, v)) * (0.05 + 0.05 * big) : 0) +
            // A high volley: both feet off as he swings through.
            smoothstep(0.75, 1, vol) * Math.sin(Math.PI * smoothstep(0.7, 1, u) * (1 - v * 0.6)) * 0.14;
          if (hop > 0) pKnee += hop * 2.5; // tucks as he leaves the ground

          const kk = inK * (1 - outK);
          if (right) {
            hipR = lerp(hipR, kHip, kk);
            kneeR = lerp(kneeR, kKnee, kk);
            hipL = lerp(hipL, pHip, kk);
            kneeL = lerp(kneeL, pKnee, kk);
            ankleR = kAnkle;
            legYawR = (open + across) * inK;
            legOutR = lerp(legOutR, kOut + kOutVol, inK * (1 - outK));
          } else {
            hipL = lerp(hipL, kHip, kk);
            kneeL = lerp(kneeL, kKnee, kk);
            hipR = lerp(hipR, pHip, kk);
            kneeR = lerp(kneeR, pKnee, kk);
            ankleL = kAnkle;
            legYawL = (open + across) * inK;
            legOutL = lerp(legOutL, kOut + kOutVol, inK * (1 - outK));
          }

          // ---- arms: the opposite arm rises out wide on the back-lift and sweeps down
          // and back through the strike; the kicking-side arm counters the leg.
          const wind = smoothstep(0, 0.55, u) * (1 - smoothstep(0.1, 0.9, v));
          const thru = smoothstep(0.6, 1, u) * (1 - outK);
          const oppOut = lerp(0.15, (ground ? 0.75 : 1.2) * (0.7 + 0.3 * big) + 0.45 * st, Math.max(wind, st * swingPhase));
          const oppSwing = lerp(0.35 * wind, -0.35, thru);
          const sameSwing = lerp(-0.55 * wind * big, 0.55 * big, thru);
          const keep = 1 - inK * (1 - outK);
          if (right) {
            armOutL = lerp(oppOut, armOutL, keep);
            armL = lerp(oppSwing, armL, keep);
            armOutR = lerp(0.35, armOutR, keep);
            armR = lerp(sameSwing, armR, keep);
            elbowL = lerp(0.45, elbowL, keep);
          } else {
            armOutR = lerp(oppOut, armOutR, keep);
            armR = lerp(oppSwing, armR, keep);
            armOutL = lerp(0.35, armOutL, keep);
            armL = lerp(sameSwing, armL, keep);
            elbowR = lerp(0.45, elbowR, keep);
          }
          // A punt: the keeper holds the ball out in front in both hands, lets it go and
          // the arms open out as the leg comes through.
          if (held === p) {
            const hold = inK * (1 - smoothstep(0.75, 1, u));
            armL = lerp(armL, 0.95, hold);
            armR = lerp(armR, 0.95, hold);
            elbowL = lerp(elbowL, 0.55, hold);
            elbowR = lerp(elbowR, 0.55, hold);
            armOutL = lerp(armOutL, 0.14, hold);
            armOutR = lerp(armOutR, 0.14, hold);
          }

          // ---- trunk: a slight arch on the back-lift, then over the ball for a driven
          // strike (back for a chip or a lofted ball), leaning away from the kicking leg.
          const atContact = Math.exp(-Math.pow((u - 1 + v * 2) * 2.2, 2));
          const overBall = ground ? 0.12 : lofted ? -0.26 : finesse ? 0.06 : power > 1 ? -0.2 : 0.22;
          flexExtra += (-0.08 * big * smoothstep(0.1, 0.5, u) * (1 - swingPhase) + overBall * swingPhase * (1 - outK) + (shot && !finesse ? 0.12 * Math.sin(Math.PI * v) : 0)) * inK;
          sideExtra += -p.kickLeg * (0.08 + 0.16 * big + 0.4 * vol) * Math.max(atContact, wind * 0.6) * inK;
          // Stretch: hips drop, the trunk counter-leans for balance as the leg reaches.
          const reachK = st * swingPhase * (1 - outK);
          hipY -= 0.13 * reachK;
          sideExtra += -p.kickLeg * 0.22 * sideFrac * reachK;
          leanF -= 0.1 * (1 - sideFrac) * reachK;
          // Volley: lean back and let the kicking hip come up; half-volley: head over it.
          leanF -= 0.2 * vol * swingPhase * (1 - outK);
          flexExtra += 0.14 * halfV * swingPhase * (1 - outK);
          pelvisRoll += -p.kickLeg * 0.2 * vol * swingPhase * (1 - outK);
          // Hips turn back with the leg, then through; shoulders do the opposite (the
          // "tension arc" from the kicking hip to the opposite shoulder).
          const turnBack = wind * (1 - swingPhase);
          const turnThru = swingPhase * (1 - outK);
          pelvisYaw = lerp(pelvisYaw, p.kickLeg * 0.32 * big * turnBack - p.kickLeg * 0.22 * big * turnThru + tgt * 0.3 * turnThru, inK);
          twist = lerp(twist, -p.kickLeg * 0.32 * big * turnBack + p.kickLeg * 0.18 * big * turnThru + tgt * 0.4 * turnThru, inK);
          pelvisRoll += -p.kickLeg * 0.06 * big * wind; // kicking hip rises with the back-lift
          hipY -= ((shot ? 0.05 : 0.035) + 0.03 * big) * smoothstep(0.45, 0.85, u) * (1 - outK);
          lift = hop;
          if (lofted) leanF -= 0.06 * swingPhase * (1 - outK);
          headLook = false;
          // Eyes on the ball through contact, then up after it.
          headPitch = 0.38 * (1 - smoothstep(0.15, 0.6, v)) + 0.05;
          break;
        }
        case 'stretch': {
          // Reaching a leg out for a ball just beyond him: the leg on its side shoots out
          // toward it nearly straight, toe first, skimming the grass; the standing knee sinks
          // to give the reach and the hips drop; the trunk leans in behind a forward poke or
          // away from a sideways one, and the arms go out for balance. Same extension curve
          // as the sim's reach (Player.stretchExt), so the touch happens where the foot is.
          const ext = Player.stretchExt(p.actionT, p.actionDur);
          const fwd = Math.max(0, p.kickBallF);
          const lat = p.kickBallL * p.kickLeg; // + = out on the leg's own side
          const r = Math.max(0.3, Math.hypot(fwd, lat));
          const ca = fwd / r;
          const sa = lat / r;
          const reachA = 0.62 + 0.25 * clamp((r - PLAYER.reach) / 0.4, 0, 1);
          const sHip = reachA * ca;
          const sOut = reachA * sa;
          const right = p.kickLeg > 0;
          if (right) {
            hipR = lerp(hipR, sHip, ext);
            kneeR = lerp(kneeR, 0.08, ext);
            legOutR = lerp(legOutR, sOut, ext);
            ankleR = -0.45 * ext;
            hipL = lerp(hipL, 0.32, ext);
            kneeL = lerp(kneeL, 0.75, ext);
          } else {
            hipL = lerp(hipL, sHip, ext);
            kneeL = lerp(kneeL, 0.08, ext);
            legOutL = lerp(legOutL, sOut, ext);
            ankleL = -0.45 * ext;
            hipR = lerp(hipR, 0.32, ext);
            kneeR = lerp(kneeR, 0.75, ext);
          }
          hipY -= 0.17 * ext;
          flexExtra += 0.18 * ca * ext;
          sideExtra += -p.kickLeg * 0.3 * Math.abs(sa) * ext;
          pelvisRoll += -p.kickLeg * 0.12 * ext;
          // Arms out: the far arm wide for balance, the near one a little.
          const farOut = 0.95 * ext;
          const nearOut = 0.4 * ext;
          if (right) {
            armOutL = Math.max(armOutL, farOut);
            armOutR = Math.max(armOutR, nearOut);
            armL = lerp(armL, -0.25, ext);
          } else {
            armOutR = Math.max(armOutR, farOut);
            armOutL = Math.max(armOutL, nearOut);
            armR = lerp(armR, -0.25, ext);
          }
          headLook = false;
          headPitch = 0.3 * ext;
          break;
        }
        case 'tackle': {
          // Block tackle: plant and sink on the standing leg, swing the tackling leg low and
          // almost straight with the foot turned out (inside of the boot to the ball), hips
          // opening toward it, the opposite arm forward for balance. The reach follows the
          // same curve as the sim's tackling leg, so contact happens where you see it.
          const load = smoothstep(0, 0.2, pr) * (1 - smoothstep(0.75, 1, pr));
          const reach = smoothstep(0.12, 0.42, pr) * (1 - smoothstep(0.62, 0.9, pr));
          const right = p.kickLeg > 0; // the leg on the ball's side
          const side = right ? -1 : 1; // tackling leg's side (left = +)
          const tHip = 1.05;
          const tKnee = 0.18;
          // The leg goes out on the line he committed it to (the sim's tackling leg).
          const tcf = Math.cos(facing);
          const tsf = Math.sin(facing);
          const aim = clamp(Math.atan2(-p.legX * tsf + p.legZ * tcf, p.legX * tcf + p.legZ * tsf), -0.6, 0.6) * reach;
          if (right) {
            hipR = lerp(hipR, tHip, reach);
            kneeR = lerp(kneeR, tKnee, reach);
            legYawR = lerp(legYawR, -0.5, reach) - aim;
            legOutR = lerp(legOutR, 0.12, reach);
            hipL = lerp(hipL, -0.15, load);
            kneeL = lerp(kneeL, 0.75, load);
            armL = lerp(armL, 0.65, reach);
            armR = lerp(armR, -0.45, reach);
          } else {
            hipL = lerp(hipL, tHip, reach);
            kneeL = lerp(kneeL, tKnee, reach);
            legYawL = lerp(legYawL, 0.5, reach) + aim;
            legOutL = lerp(legOutL, 0.12, reach);
            hipR = lerp(hipR, -0.15, load);
            kneeR = lerp(kneeR, 0.75, load);
            armR = lerp(armR, 0.65, reach);
            armL = lerp(armL, -0.45, reach);
          }
          hipY -= 0.17 * load;
          leanF += 0.12 * load - 0.22 * reach;
          pelvisYaw += side * 0.22 * reach;
          twist += side * 0.18 * reach;
          armOutL = armOutR = 0.1 + 0.5 * load;
          elbowL = elbowR = 0.5;
          break;
        }
        case 'slide': {
          // Shaped by the slide itself: he drops as he commits, lower and further back the
          // faster he went in; the lead leg (the ball side) reaches along the grass on the
          // line it was committed to (the sim's tackling leg: contact happens where you see
          // it); the hip meets the turf with a small damped bounce; the support hand goes down
          // a beat after; and he gets up as the slide dies, not on a timer. Timed in seconds
          // from the moment he went down, against when the grass stops him.
          const speedNow = Math.hypot(p.vel.x, p.vel.z);
          const entry = clamp((p.slideV0 - 6) / 2.5, 0, 1);
          const vary = Math.sin(p.id * 12.9898) * 0.5; // a little of each player's own style
          const t = p.actionT;
          const stop = p.slideStop;
          const down = smoothstep(0, 0.13, t);
          const landT = Math.max(0, t - 0.12);
          const bounce = landT > 0 ? Math.exp(-landT * 9) * Math.sin(landT * 26) : 0;
          const rise = smoothstep(stop - 0.1, p.actionDur - 0.1, t) * (1 - smoothstep(0.7, 2.4, speedNow));
          const lying = down * (1 - rise);
          const kneel = rise * (1 - smoothstep(p.actionDur - 0.12, p.actionDur, t));
          const reach = smoothstep(0.03, 0.12, t) * (1 - smoothstep(stop - 0.05, stop + 0.15, t));
          // The committed leg line in his frame.
          const cf = Math.cos(facing);
          const sf = Math.sin(facing);
          const aim = clamp(Math.atan2(-p.legX * sf + p.legZ * cf, p.legX * cf + p.legZ * sf), -0.6, 0.6) * reach;
          const right = p.kickLeg > 0;
          const tuck = right ? 1 : -1; // the folded leg's side (left = +)
          hipY = lerp(hipY, 0.27 - 0.05 * entry + 0.04 * bounce, lying) + 0.3 * kneel;
          leanF = lerp(leanF, -(0.78 + 0.25 * entry + 0.08 * vary), lying) + 0.06 * bounce * lying + 0.45 * kneel;
          roll += tuck * (0.22 + 0.12 * entry + 0.05 * vary) * lying;
          flexExtra += (0.18 + 0.06 * vary) * lying;
          // (Hip angles are relative to the pelvis, which leans back with the torso: the lead
          // leg ends up level along the grass, the tucked thigh pointing forward.)
          const lead = { hip: lerp(0.3, 0.6 + 0.05 * entry, reach), knee: lerp(0.55, 0.06, reach) };
          const fold = { hip: 0.48 + 0.06 * vary, knee: 1.95 };
          const up = { hip: 1.15, knee: 1.9 };
          const supp = smoothstep(0.08, 0.26, t) * (1 - rise); // the support hand lands a beat later
          const freeArm = -1.0 - 0.25 * entry - 0.3 * bounce;
          if (right) {
            hipR = lerp(lerp(hipR, lead.hip, lying), up.hip * 0.6, kneel);
            kneeR = lerp(lerp(kneeR, lead.knee, lying), 0.9, kneel);
            legYawR -= aim;
            hipL = lerp(lerp(hipL, fold.hip, lying), up.hip, kneel);
            kneeL = lerp(lerp(kneeL, fold.knee, lying), up.knee, kneel);
            legOutL = lerp(legOutL, 0.28, lying);
            armL = lerp(armL, 0.75, supp);
            armOutL = lerp(armOutL, 0.45, supp);
            elbowL = lerp(elbowL, 0.15, supp);
            armR = lerp(armR, freeArm, lying);
            armOutR = lerp(armOutR, 0.8 + 0.1 * vary, lying);
            elbowR = lerp(elbowR, 0.5, lying);
          } else {
            hipL = lerp(lerp(hipL, lead.hip, lying), up.hip * 0.6, kneel);
            kneeL = lerp(lerp(kneeL, lead.knee, lying), 0.9, kneel);
            legYawL += aim;
            hipR = lerp(lerp(hipR, fold.hip, lying), up.hip, kneel);
            kneeR = lerp(lerp(kneeR, fold.knee, lying), up.knee, kneel);
            legOutR = lerp(legOutR, 0.28, lying);
            armR = lerp(armR, 0.75, supp);
            armOutR = lerp(armOutR, 0.45, supp);
            elbowR = lerp(elbowR, 0.15, supp);
            armL = lerp(armL, freeArm, lying);
            armOutL = lerp(armOutL, 0.8 + 0.1 * vary, lying);
            elbowL = lerp(elbowL, 0.5, lying);
          }
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
          hipY = hip0 - dip * 0.14 - rise * 0.38;
          // Near (push) leg drives straight; the far, top leg tucks up. On the grass he curls,
          // knees up; getting up, one knee under him and the bottom hand pushing off.
          const nearL = side > 0;
          const curl = lie;
          const push = { hip: 0.1 * fly + 0.5 * curl, knee: lerp(0.9 * dip + 0.15, 0.08, fly) + 0.8 * curl };
          const trail = { hip: 0.75 * fly + 0.85 * curl, knee: 1.3 * fly + 1.3 * curl };
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
          // Arms stretch along the body line to the ball, elbows soft, hands together (the
          // top one a touch higher). Landing, a held ball comes into the chest; a parried
          // one, the arms just come down. Rising, the bottom hand pushes off the grass.
          const gather = smoothstep(0.45, 0.62, pr) * (1 - smoothstep(0.72, 0.84, pr));
          const up = lerp(0.6, 3.0, reach);
          const down = held === p ? 1.25 : 2.2;
          const nearArm = lerp(lerp(lerp(nearL ? armL : armR, up - 0.15, Math.max(reach, 0.2)), down, gather), 0.3, rise);
          const farArm = lerp(lerp(lerp(nearL ? armR : armL, up + 0.08, Math.max(reach, 0.2)), down, gather), 0.8, rise);
          const nearOut = lerp(0.05, 0.6, rise);
          const farOut = lerp(0.1, 0.25, rise);
          const elb = lerp(lerp(lerp(0.6, 0.18, reach), held === p ? 1.5 : 0.5, gather), 0.25, rise);
          if (nearL) {
            armL = nearArm;
            armR = farArm;
            armOutL = nearOut;
            armOutR = farOut;
          } else {
            armR = nearArm;
            armL = farArm;
            armOutR = nearOut;
            armOutL = farOut;
          }
          elbowL = elbowR = elb;
          sideExtra += -side * 0.18 * fly; // arch toward the ball
          flexExtra += 0.35 * lie + 0.45 * rise; // curl on landing, over the knees to rise
          headLook = false;
          headPitch = -0.15 * fly + 0.2 * lie;
          break;
        }
        case 'catch': {
          // Hands meet the ball at its height, then gather it into the chest.
          const yH = clamp(p.catchY, 0.1, 2.4);
          const meet = 1 - smoothstep(0.25, 0.6, pr);
          const reachSwing = yH > 1.6 ? 2.5 : yH > 0.9 ? 1.5 : 0.75;
          armL = armR = lerp(1.0, reachSwing, meet);
          elbowL = elbowR = lerp(1.35, 0.4, meet);
          armOutL = armOutR = lerp(0.0, 0.16, meet);
          // High ball: up off one foot, the other knee raised to protect himself. Low ball:
          // down on one knee behind it (the long barrier), the knee turned across.
          const hk = smoothstep(1.6, 2.0, yH) * Math.sin(Math.min(1, pr * 1.6) * Math.PI);
          hipL += 0.9 * hk;
          kneeL += 1.4 * hk;
          const kneel = smoothstep(0.5, 0.3, yH) * smoothstep(0, 0.2, pr) * (1 - smoothstep(0.75, 1, pr));
          const low = 1 - smoothstep(0.3, 0.8, yH);
          kneeL += 0.7 * low + 0.25;
          kneeR += 0.7 * low + 0.25;
          hipL += 0.35 * low;
          hipR += 0.35 * low;
          hipY -= 0.25 * low + 0.04;
          flexExtra += 0.45 * low + 0.18 * (1 - meet); // smother low balls, cushion the rest
          if (yH > 1.8) lift = 0.18 * Math.sin(Math.min(1, pr * 1.6) * Math.PI);
          hipR = lerp(hipR, 0.12, kneel);
          kneeR = lerp(kneeR, 1.6, kneel);
          legYawR = lerp(legYawR, -0.55, kneel);
          hipL = lerp(hipL, 0.95, kneel);
          kneeL = lerp(kneeL, 1.35, kneel);
          hipY = lerp(hipY, 0.5, kneel);
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
          armL = armR = 0.3 * k;
          kneeL = kneeR = 0.45 * k + 0.1;
          headLook = false;
          break;
        }
        case 'throw': {
          if (p.throwIn) {
            // From above the head, back behind it with the elbows bent, then over and
            // through with the arms straight.
            const back = smoothstep(0, 0.4, pr);
            const over = smoothstep(0.4, 0.75, pr);
            armL = armR = lerp(lerp(2.6, 3.45, back), 2.0, over);
            elbowL = elbowR = lerp(lerp(0.5, 1.5, back), 0.15, over);
            flexExtra += lerp(-0.25, 0.25, smoothstep(0.3, 0.7, pr));
          } else {
            // Keeper's one-arm throw: wind back, whip over the top, step into it.
            const wind = 1 - smoothstep(0.15, 0.5, pr);
            const whip = smoothstep(0.35, 0.65, pr);
            // (back, up over the head through -pi, and down in front)
            armR = lerp(lerp(0, -1.3, smoothstep(0, 0.3, pr)), -5.0, whip);
            elbowR = lerp(0.9, 0.15, whip);
            armOutR = 0.25;
            armL = 1.2 * wind - 0.3;
            armOutL = 0.2;
            twist = lerp(-0.45, 0.45, whip);
            pelvisYaw = lerp(-0.2, 0.25, whip);
            hipL = 0.45 * smoothstep(0.2, 0.5, pr);
            kneeL = 0.35;
            flexExtra += lerp(-0.15, 0.25, whip);
          }
          break;
        }
        case 'fall': {
          // Knocked down: he topples the way the hit sends him (actionDir, in his own frame:
          // forward over the tackler, back onto his backside, or over sideways), arms out to
          // break the fall, a moment on the grass, then up onto a knee and back to his feet.
          const down = smoothstep(0, 0.2, pr);
          const rise = smoothstep(0.62, 0.9, pr);
          const lying = down * (1 - rise);
          const kneel = rise * (1 - smoothstep(0.9, 1, pr));
          const cf = Math.cos(facing);
          const sf = Math.sin(facing);
          const fwd = p.actionDirX * cf + p.actionDirZ * sf;
          const lft = -p.actionDirX * sf + p.actionDirZ * cf;
          leanF = lerp(leanF, fwd * 1.3, lying) + 0.45 * kneel;
          roll += lft * 1.1 * lying;
          hipY = lerp(hipY, 0.28, lying) + 0.3 * kneel;
          flexExtra += 0.25 * lying;
          // Arms reach toward the ground he's falling onto.
          const reachArm = fwd >= 0 ? 0.6 + 0.8 * fwd : 0.6 + 1.5 * fwd;
          armL = lerp(armL, reachArm, lying);
          armR = lerp(armR, reachArm, lying);
          armOutL = lerp(armOutL, 0.55 + Math.max(0, lft) * 0.5, lying);
          armOutR = lerp(armOutR, 0.55 + Math.max(0, -lft) * 0.5, lying);
          elbowL = elbowR = lerp(elbowL, 0.3, lying);
          // Legs: bent and splayed on the ground; one knee under him to get up.
          hipL = lerp(lerp(hipL, 0.55 - fwd * 0.4, lying), 1.15, kneel);
          kneeL = lerp(lerp(kneeL, 0.9, lying), 1.9, kneel);
          hipR = lerp(lerp(hipR, 0.35 - fwd * 0.4, lying), 0.7, kneel);
          kneeR = lerp(lerp(kneeR, 0.5, lying), 0.9, kneel);
          legOutL = lerp(legOutL, 0.2, lying);
          legOutR = lerp(legOutR, 0.2, lying);
          headLook = false;
          headPitch = -0.2 * lying * fwd;
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
          // Ball above the head, hands either side of it.
          armL = armR = 2.6;
          elbowL = elbowR = 0.5;
          armOutL = armOutR = 0.2;
          flexExtra -= 0.12;
        } else {
          // Carried at the chest.
          armL = armR = 0.45;
          elbowL = elbowR = 1.25;
          armOutL = armOutR = 0.12;
        }
      }
      // Goal celebration: the one picked with the buttons, or the classic.
      const cel = match.phase === 'goal' && match.scorer === p && match.celebration && match.phaseT >= match.celebration.at && match.phaseT < GOAL_SEQ.cut ? match.celebration : null;
      if (cel) {
        const u = match.phaseT - cel.at;
        headLook = false;
        switch (cel.kind) {
          case 'slide': {
            // Down onto both knees at full tilt and skidding at the camera: leaning back, arms
            // flung wide, head back. Stopped, a roar with pumped fists; then up, soaking it in.
            const knees = smoothstep(0.7, 0.88, u) * (1 - smoothstep(3.7, 4.2, u));
            const skid = smoothstep(0.82, 1.15, u) * (1 - smoothstep(2.4, 2.8, u));
            const roar = smoothstep(2.4, 2.75, u) * (1 - smoothstep(3.6, 4.0, u));
            const pump = Math.max(0, Math.sin((u - 2.5) * 10)) * roar;
            const fin = smoothstep(3.9, 4.4, u);
            hipY = lerp(hipY, 0.5, knees);
            hipL = lerp(hipL, 0.14, knees);
            hipR = lerp(hipR, 0.06, knees);
            kneeL = lerp(kneeL, 1.62, knees);
            kneeR = lerp(kneeR, 1.56, knees);
            legOutL = lerp(legOutL, 0.15, knees);
            legOutR = lerp(legOutR, 0.15, knees);
            leanF = lerp(leanF, -0.1, knees);
            leanS *= 1 - knees;
            flexExtra += -0.5 * skid + 0.3 * roar + 0.06 * pump - 0.18 * fin;
            headPitch += -0.5 * skid - 0.25 * roar - 0.2 * fin;
            const armUp = (a: number) => lerp(lerp(lerp(a, -0.55, skid), 0.3 + 0.4 * pump, roar), 0.15, fin);
            armL = armUp(armL);
            armR = armUp(armR);
            armOutL = armOutR = lerp(lerp(lerp(armOutL, 1.3, skid), 0.38, roar), 1.35, fin);
            elbowL = elbowR = lerp(lerp(lerp(elbowL, 0.55, skid), 2.05 - 0.55 * pump, roar), 0.15, fin);
            break;
          }
          case 'plane': {
            // The aeroplane: arms out like wings (a little wobble in them), banked into the turn.
            const k = smoothstep(0, 0.35, u);
            const bank = cel.turn * 0.36 * k * (1 - smoothstep(2.8, 3.3, u));
            const fin = smoothstep(3.6, 4.1, u);
            const wob = Math.sin(time * 6.5) * 0.07 * k * (1 - fin);
            roll += bank;
            armOutL = lerp(lerp(armOutL, 1.5 + wob, k), 0.5, fin);
            armOutR = lerp(lerp(armOutR, 1.5 - wob, k), 0.5, fin);
            armL = lerp(lerp(armL, 0.05, k), -2.75, fin);
            armR = lerp(lerp(armR, 0.05, k), -2.75, fin);
            elbowL = elbowR = lerp(lerp(elbowL, 0.05, k), 0.15, fin);
            flexExtra -= 0.12 * k + 0.12 * fin;
            headPitch -= 0.12 * k + 0.25 * fin;
            break;
          }
          case 'siu': {
            // A crouch, a leap with a half turn, and the landing: feet wide, arms flung down
            // and back, chest out, head back.
            const load = smoothstep(0.28, 0.45, u) * (1 - smoothstep(0.45, 0.52, u));
            const a = clamp((u - 0.45) / 0.6, 0, 1);
            const air = a > 0 && a < 1 ? Math.sin(Math.PI * a) : 0;
            const land = smoothstep(1.0, 1.06, u) * (1 - smoothstep(1.06, 1.35, u));
            const pose = smoothstep(1.02, 1.22, u);
            if (u >= 0.45) yawExtra = Math.PI * cel.turn * (1 - smoothstep(0.47, 0.98, u));
            lift += 0.6 * air;
            kneeL += 0.8 * load + 0.7 * air + 0.5 * land;
            kneeR += 0.8 * load + 0.7 * air + 0.5 * land;
            hipL += 0.45 * load + 0.4 * air;
            hipR += 0.45 * load + 0.25 * air;
            hipY -= 0.18 * load + 0.12 * land + 0.11 * pose;
            armL = lerp(lerp(armL, 0.9, load), -2.4, air);
            armR = lerp(lerp(armR, 0.9, load), -2.4, air);
            armOutL = armOutR = lerp(armOutL, 0.35, air);
            legOutL = lerp(legOutL, 0.3, pose);
            legOutR = lerp(legOutR, 0.3, pose);
            hipL = lerp(hipL, 0.3, pose);
            hipR = lerp(hipR, 0.3, pose);
            kneeL = lerp(kneeL, 0.5, pose) + 0.4 * land;
            kneeR = lerp(kneeR, 0.5, pose) + 0.4 * land;
            armL = lerp(armL, 0.5, pose);
            armR = lerp(armR, 0.5, pose);
            armOutL = lerp(armOutL, 0.8, pose);
            armOutR = lerp(armOutR, 0.8, pose);
            elbowL = elbowR = lerp(elbowL, 0.08, pose);
            flexExtra += 0.3 * load - 0.38 * pose;
            headPitch -= 0.42 * pose;
            break;
          }
          case 'flip': {
            // A standing backflip: load, arms swung up, tucked over, landed, arms to the sky.
            const load = smoothstep(0.55, 0.85, u) * (1 - smoothstep(0.85, 0.92, u));
            const k = clamp((u - 0.85) / 0.75, 0, 1);
            const flying = k > 0 && k < 1;
            const tuck = smoothstep(0.1, 0.32, k) * (1 - smoothstep(0.68, 0.9, k));
            const land = smoothstep(1.56, 1.62, u) * (1 - smoothstep(1.62, 1.95, u));
            const sky = smoothstep(1.8, 2.25, u);
            if (flying) {
              const th = -Math.PI * 2 * k * k * (3 - 2 * k);
              const c = 0.95;
              lift = c + 0.8 * Math.sin(Math.PI * k) - c * Math.cos(th);
              fwdShift = -c * Math.sin(th) * h;
              leanF = th;
              leanS = 0;
              roll = 0;
            }
            hipL = lerp(hipL + 0.65 * load + 0.5 * land, 1.85, tuck);
            hipR = lerp(hipR + 0.65 * load + 0.5 * land, 1.85, tuck);
            kneeL = lerp(kneeL + 1.0 * load + 0.9 * land, 2.15, tuck);
            kneeR = lerp(kneeR + 1.0 * load + 0.9 * land, 2.15, tuck);
            hipY -= 0.28 * load + 0.25 * land;
            const swing = flying ? 1 - tuck : 0;
            const arm = (a: number) => lerp(lerp(lerp(lerp(a, 1.0, load), -2.8, swing), -1.0, tuck), -1.2, land);
            armL = lerp(arm(armL), -2.75 + 0.12 * Math.sin(time * 11), sky);
            armR = lerp(arm(armR), -2.75 + 0.12 * Math.sin(time * 11 + 1.3), sky);
            armOutL = armOutR = lerp(lerp(armOutL, 0.12, tuck), 0.45, sky);
            elbowL = elbowR = lerp(lerp(elbowL, 1.3, tuck), 0.12, sky);
            flexExtra += 0.35 * load + 0.4 * tuck + 0.2 * land - 0.2 * sky;
            headPitch += 0.25 * tuck - 0.35 * sky;
            break;
          }
        }
      } else if (match.phase === 'goal' && match.scorer === p && match.phaseT > 0.4 && match.phaseT < GOAL_SEQ.cut) {
        const u = match.phaseT - GOAL_SEQ.front;
        if (u < 0.3) {
          // The run: arms flung up.
          armL = armR = -2.7;
          armOutL = armOutR = 0.5;
          elbowL = elbowR = 0.2;
          flexExtra -= 0.25;
        } else {
          // Pulled up in front of the camera: a roar with pumped fists, sunk into a wide
          // stance, then his signature pose, held, chin up.
          const set = 1 - smoothstep(0.5, 2.5, speed);
          const roar = smoothstep(0.3, 0.7, u) * (1 - smoothstep(1.7, 2.2, u));
          const sig = smoothstep(1.9, 2.5, u);
          const pump = Math.max(0, Math.sin((u - 0.3) * 11)) * (1 - smoothstep(1.3, 1.7, u));
          const st = set * (roar + sig * 0.6);
          legOutL = lerp(legOutL, 0.17, st);
          legOutR = lerp(legOutR, 0.17, st);
          hipL += 0.22 * set * roar;
          hipR += 0.22 * set * roar;
          kneeL += 0.4 * set * roar;
          kneeR += 0.4 * set * roar;
          hipY -= (0.07 + 0.02 * pump) * set * roar;
          flexExtra += (0.28 + 0.1 * pump) * roar;
          headPitch -= 0.25 * roar + 0.12 * sig;
          headLook = false;
          // Roar: fists clenched up in front of the chest, pumped down.
          const ra = 0.35 + 0.35 * pump;
          armL = lerp(-2.7, ra, roar);
          armR = lerp(-2.7, ra, roar);
          armOutL = armOutR = lerp(0.5, 0.35, roar);
          elbowL = elbowR = lerp(0.2, 2.1 - 0.5 * pump, roar);
          const v = p.id % 3;
          if (v === 0) {
            // Arms folded: arms across the chest, one over the other, shoulders back.
            armL = lerp(armL, 0.5, sig);
            armR = lerp(armR, 0.45, sig);
            armOutL = lerp(armOutL, 0.06, sig);
            armOutR = lerp(armOutR, 0.04, sig);
            elbowL = lerp(elbowL, 1.95, sig);
            elbowR = lerp(elbowR, 1.8, sig);
            armRotL = -1.45 * sig;
            armRotR = -1.4 * sig;
            flexExtra -= 0.12 * sig;
            headPitch += 0.04 * Math.sin(time * 2.2) * sig;
          } else if (v === 1) {
            // Arms spread wide, chest out, soaking it in.
            armL = lerp(armL, 0.15, sig);
            armR = lerp(armR, 0.15, sig);
            armOutL = lerp(armOutL, 1.35, sig);
            armOutR = lerp(armOutR, 1.35, sig);
            elbowL = lerp(elbowL, 0.15, sig);
            elbowR = lerp(elbowR, 0.15, sig);
            flexExtra -= 0.2 * sig;
          } else {
            // "Calm down": palms pressed slowly toward the ground.
            const press = 0.5 + 0.5 * Math.sin(time * 3.2);
            armL = lerp(armL, 0.55 + 0.15 * press, sig);
            armR = lerp(armR, 0.55 + 0.15 * press, sig);
            armOutL = lerp(armOutL, 0.4, sig);
            armOutR = lerp(armOutR, 0.4, sig);
            elbowL = lerp(elbowL, 0.45 - 0.15 * press, sig);
            elbowR = lerp(elbowR, 0.45 - 0.15 * press, sig);
            hipY -= 0.025 * press * sig * set;
            kneeL += 0.12 * press * sig * set;
            kneeR += 0.12 * press * sig * set;
          }
        }
      } else if (match.phase === 'goal' && match.scorer && match.scorer.team === p.team && match.phaseT > 1.2) {
        armOutL = armOutR = 0.3 + 0.2 * Math.sin(time * 9 + p.id);
      }

      // Substitutes: sat on the bench, squatting at the line, reacting (see render/bench).
      const bp = this.bench?.pose(p, this.body[id].leg, h * this.bodyScale[id]);
      if (bp) {
        const k = bp.legs;
        hipY = lerp(hipY, bp.hipY, k);
        hipL = lerp(hipL, bp.hipL, k);
        hipR = lerp(hipR, bp.hipR, k);
        kneeL = lerp(kneeL, bp.kneeL, k);
        kneeR = lerp(kneeR, bp.kneeR, k);
        legOutL = lerp(legOutL, bp.legOutL, k);
        legOutR = lerp(legOutR, bp.legOutR, k);
        legYawL = lerp(legYawL, bp.legYawL, k);
        legYawR = lerp(legYawR, bp.legYawR, k);
        ankleL += bp.ankleL;
        ankleR += bp.ankleR;
        leanF *= 1 - k;
        leanS *= 1 - k;
        const a = bp.arms;
        armL = lerp(armL, bp.armL, a);
        armR = lerp(armR, bp.armR, a);
        elbowL = lerp(elbowL, bp.elbowL, a);
        elbowR = lerp(elbowR, bp.elbowR, a);
        armOutL = lerp(armOutL, bp.armOutL, a);
        armOutR = lerp(armOutR, bp.armOutR, a);
        armRotL = lerp(armRotL, bp.armRotL, a);
        armRotR = lerp(armRotR, bp.armRotR, a);
        flexExtra += bp.flex;
        sideExtra += bp.side;
        twist += bp.twist;
        headPitch += bp.headPitch;
        lift += bp.lift;
        if (!bp.look) headLook = false;
      }

      // Officials' signals: the referee points for a restart, linesmen raise the flag.
      if (p.team === 2 && off) {
        if (p === off.ref && off.refPoint > 0) {
          // Arm straight out, level, toward the way play goes: the arm on that side, swung
          // up to horizontal and round from the front by the angle to it.
          const k = smoothstep(0, 0.25, off.refPoint) * smoothstep(2.2, 1.9, off.refPoint);
          const fw = off.refPointSide * Math.cos(facing);
          const lf = off.refPointSide * Math.sin(facing);
          const ang = Math.atan2(Math.abs(lf), fw);
          if (lf > 0) {
            armL = lerp(armL, Math.PI / 2, k);
            armOutL = lerp(armOutL, ang, k);
            elbowL = lerp(elbowL, 0.05, k);
          } else {
            armR = lerp(armR, Math.PI / 2, k);
            armOutR = lerp(armOutR, ang, k);
            elbowR = lerp(elbowR, 0.05, k);
          }
        }
        const li = off.lines.indexOf(p);
        if (li >= 0) {
          const up = smoothstep(0, 0.2, off.flagUp[li]) * smoothstep(2.0, 1.8, off.flagUp[li]);
          armR = lerp(armR * 0.5, -2.95, up);
          armOutR = lerp(0.12, 0.08, up);
          elbowR = lerp(0.35, 0.05, up);
        }
      }

      // ---------------- secondary motion: limbs and head carry inertia
      // Body forces, in his own frame: forward acceleration, the lean into a turn (it
      // follows the sideways acceleration), the hips' vertical acceleration (each footfall,
      // a landing) and how fast he's turning.
      const sc0 = this.secReady[id] === 0;
      const yNow = hipY + lift;
      if (sc0 || dt <= 0) {
        this.bodyY[id] = yNow;
        this.bodyVy[id] = 0;
        this.bodyAy[id] = 0;
        this.lastFacing[id] = facing;
      } else {
        const vy = (yNow - this.bodyY[id]) / dt;
        const ay = clamp((vy - this.bodyVy[id]) / dt, -40, 40);
        this.bodyAy[id] += (ay - this.bodyAy[id]) * (1 - Math.exp(-dt * 25));
        this.bodyVy[id] = vy;
        this.bodyY[id] = yNow;
      }
      let turnRate = 0;
      if (dt > 0) {
        let dF = facing - this.lastFacing[id];
        if (dF > Math.PI) dF -= Math.PI * 2;
        if (dF < -Math.PI) dF += Math.PI * 2;
        turnRate = clamp(dF / dt, -14, 14);
        this.lastFacing[id] = facing;
      }
      this.turnS[id] = sc0 ? 0 : this.turnS[id] + (turnRate - this.turnS[id]) * (1 - Math.exp(-dt * 12));
      {
        // Free to swing, or held to a pose the physics depends on (hands on the ball).
        const free = p.action === 'dive' || p.action === 'catch' || p.action === 'throw' ? 0.25 : held === p ? 0.5 : 1;
        const aF = clamp(p.accelFwd, -12, 12) * free;
        const aY = this.bodyAy[id] * free;
        const lat = leanS;
        const base = id * SEC.count;
        const pose = this.secPoseNow;
        pose[0] = armL;
        pose[1] = armR;
        pose[2] = armOutL;
        pose[3] = armOutR;
        pose[4] = elbowL;
        pose[5] = elbowR;
        // Where each channel wants to sit for these forces: the arms trail a burst of
        // speed and swing on through a stop, fling out of a turn (the outside one wider),
        // forearms drop on a landing; the head nods into braking and footfalls; the
        // shoulders lag a quick turn.
        const want = this.secWant;
        // (Turning, the hands lag the spin: the leading arm drifts back, the trailing one
        // forward, and both flare out a little.)
        const spin = this.turnS[id] * free;
        const flare = Math.min(0.25, Math.abs(spin) * 0.02);
        want[SEC.armL] = -0.03 * aF - 0.025 * spin;
        want[SEC.armR] = -0.03 * aF + 0.025 * spin;
        want[SEC.outL] = Math.max(0, -lat) * 0.5 - 0.15 * lat + flare;
        want[SEC.outR] = Math.max(0, lat) * 0.5 + 0.15 * lat + flare;
        want[SEC.elbowL] = want[SEC.elbowR] = -0.02 * aF - 0.006 * aY;
        want[SEC.headPitch] = -0.012 * aF + 0.004 * aY;
        want[SEC.headRoll] = -0.2 * lat;
        want[SEC.twist] = clamp(0.03 * turnRate, -0.3, 0.3) * free;
        for (let c = 0; c < SEC.count; c++) {
          const i = base + c;
          if (sc0) {
            this.sec[i] = want[c];
            this.secV[i] = 0;
          } else {
            // A pose that jumps (more than a fast swing could cover in a frame) is reached
            // by swinging there: the jump goes into the spring, which carries the limb over.
            if (c < SEC_SOAK) {
              const jump = pose[c] - this.secPose[i];
              if (Math.abs(jump) > 0.2 + 14 * dt) this.sec[i] = clamp(this.sec[i] - jump, -3, 3);
            }
            const w = SEC_W[c];
            this.secV[i] += (w * w * (want[c] - this.sec[i]) - 2 * SEC_Z[c] * w * this.secV[i]) * dt;
            this.sec[i] += this.secV[i] * dt;
          }
          this.secPose[i] = pose[c];
        }
        this.secReady[id] = 1;
        armL += this.sec[base + SEC.armL];
        armR += this.sec[base + SEC.armR];
        armOutL += this.sec[base + SEC.outL];
        armOutR += this.sec[base + SEC.outR];
        elbowL = Math.max(0, elbowL + this.sec[base + SEC.elbowL]);
        elbowR = Math.max(0, elbowR + this.sec[base + SEC.elbowR]);
        headPitch += this.sec[base + SEC.headPitch];
        twist += this.sec[base + SEC.twist];
      }
      const headLag = this.sec[id * SEC.count + SEC.headRoll];

      // Feet plant during the stance of a stride (not while an action poses the legs).
      const legsFree = p.action === 'none' && lift < 0.01 && !cel && !(match.phase === 'goal' && match.scorer === p) && !(bp && bp.legs > 0.01);
      this.ikOn[id] += ((legsFree ? 1 : 0) - this.ikOn[id]) * (1 - Math.exp(-dt * 10));

      // ---------------- body physics: a springy spine driven by the movement
      // The upper body carries inertia: it pitches with acceleration and braking, swings
      // past and settles (underdamped spring), and bends a little out of turns. The head
      // stays level and tracks the ball.
      const flexTarget = clamp(p.leanFwd * 0.8 - p.accelFwd * 0.012 + s * 0.06 + flexExtra, -0.6, 0.7);
      // (Only a little counter-bend: the trunk goes into a turn with the legs.)
      const sideTarget = clamp(-leanS * 0.15 + sideExtra, -0.45, 0.45);
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

      // ---------------- skeleton (only for players in view)
      const j = this.slot[id];
      if (j < 0) {
        // Off screen: the feet re-plant cleanly when he comes back into view.
        this.inStance[id * 2] = this.inStance[id * 2 + 1] = 0;
        this.footW[id * 2] = this.footW[id * 2 + 1] = 0;
        continue;
      }
      const R = this.root;
      this.e.set(0, Math.PI / 2 - facing - yawExtra, 0, 'YXZ');
      R.makeRotationFromEuler(this.e);
      R.setPosition(x + Math.cos(facing) * fwdShift, 0, z + Math.sin(facing) * fwdShift);
      const bs = this.body[id];
      const sc = h * this.bodyScale[id];
      this.s.set(sc, sc, sc);
      R.scale(this.s);
      // Whole-body tilt about the ground point: lean into turns / accelerations.
      this.chain(R, R, 0, lift, 0, leanF, 0, leanS + roll);

      const P = this.chain(this.pelvis, R, 0, hipY, 0, 0, pelvisYaw, pelvisRoll);
      this.put('pelvis', j, P, bs.torsoW, 1, bs.torsoD);
      // Torso mesh sits at the waist unrotated; the shader bends it through the spine.
      const T = this.chainT(this.j3, P, 0, 0.04, 0);
      this.put('torso', j, T, bs.torsoW, bs.torsoL, bs.torsoD);
      const flex = spineFlex + 0.04;
      const tw = twist - pelvisYaw;
      const side = spineSide - pelvisRoll;
      bend.setXYZ(j, flex, tw, side);
      const C = this.chain(this.chest, T, 0, 0, 0, flex, tw, side);
      // Neck and head: level gaze (counter the body's pitch and roll), turned toward the
      // ball, lagging the body a touch. The neck takes part of every turn and nod, so the
      // head tips on the end of it rather than pivoting on a post.
      const headLevel = -(leanF + flex) * 0.75;
      const headRoll = -(leanS + roll * 0.2 + side) * 0.6 + headLag;
      const hP = headPitch + headLevel;
      const hY = this.headYaw[id] + headLead;
      const N = this.chain(this.neck, C, 0, 0.58 * bs.torsoL, 0, hP * 0.4, hY * 0.3, headRoll * 0.4);
      this.put('neck', j, N, bs.neck, bs.neckLen, bs.neck);
      const top = 0.075 * bs.neckLen;
      this.chain(this.j1, N, 0, top, 0, hP * 0.6, hY * 0.7, headRoll * 0.6);
      this.chainT(this.j1, this.j1, 0, 0.02 * bs.torsoL + (bs.neckLen - 1) * 0.08 - top, 0);
      this.put('head', j, this.j1);
      const style = p.look.hairStyle;
      const hs = this.hairSlot[id];
      if (style === 1) this.put('hairShort', hs, this.j1, 0.985, 0.95, 0.985);
      else this.put(HAIR_OF_STYLE[style] ?? 'hairBun', hs, this.j1);

      // Arms (left = +x local; swing + = forward). The shoulder itself moves: forward and
      // back with the arm, up and a little in as the arm rises above the shoulder.
      for (let sd = 0; sd < 2; sd++) {
        const sideSign = sd === 0 ? 1 : -1;
        const swing = sd === 0 ? armL : armR;
        const out = sd === 0 ? armOutL : armOutR;
        const elbow = sd === 0 ? elbowL : elbowR;
        const raise = Math.acos(clamp(Math.cos(swing) * Math.cos(out), -1, 1));
        const elev = smoothstep(1.1, 2.9, raise);
        const protract = 0.028 * Math.sin(clamp(swing, -1.5, 1.5)) * (1 - 0.5 * elev);
        this.chain(this.j1, C, sideSign * (0.198 * bs.shoulder - 0.014 * elev), 0.5 * bs.torsoL + 0.045 * elev, protract, -swing, 0, sideSign * out);
        this.put('upperArm', j * 2 + sd, this.j1, bs.arm, bs.armLen, bs.arm);
        this.chain(this.j2, this.j1, 0, -0.29 * bs.armLen, 0, -elbow, sideSign * (sd === 0 ? armRotL : armRotR), 0);
        this.put('forearm', j * 2 + sd, this.j2, 0.5 + 0.5 * bs.arm, bs.armLen, 0.5 + 0.5 * bs.arm);
        // Hand at the wrist, relaxed with the palm toward the body; keeper gloves are bigger.
        this.chain(this.j3, this.j2, 0, -0.245 * bs.armLen, 0, 0.1, 0, sideSign * -0.08);
        const g = p.role === 'GK' ? 1.25 : 1;
        this.put('hand', j * 2 + sd, this.j3, g, g, g);
        if (sd === 1 && this.flagSlot[id] >= 0) this.put('flag', this.flagSlot[id], this.chainT(this.sm, this.j3, 0, -0.08, 0.02));
      }

      // Legs: the thigh curves into a soft knee (shader bend), the shin takes the rest.
      // Through the stance of each stride the foot is planted: the ball of the foot stays
      // where it landed on the grass and the leg is solved to reach it (two-bone IK), so
      // feet don't skate. The foot lands heel first, rolls flat, and the heel lifts off
      // the bent toe as the body passes over it; in the air it trails, then cocks up to land.
      const ik = this.ikOn[id];
      const cf = Math.cos(facing);
      const sf = Math.sin(facing);
      const duty = lerp(0.62, 0.32, s);
      const dutyA = duty * Math.PI;
      const standing = 1 - smoothstep(0.03, 0.3, stepAmt);
      const stepLen = 0.7 + 0.12 * speed;
      const l1 = THIGH * bs.leg;
      const l2 = SHIN * bs.leg;
      const upright = hipY > 0.55 && p.action !== 'slide' && p.action !== 'dive' && p.action !== 'fall';
      this.pinv.copy(P).invert();
      for (let sd = 0; sd < 2; sd++) {
        const sideSign = sd === 0 ? 1 : -1;
        const fi = id * 2 + sd;
        const fj = j * 2 + sd;
        let hip = sd === 0 ? hipL : hipR;
        let knee = sd === 0 ? kneeL : kneeR;
        let out = sd === 0 ? legOutL : legOutR;
        const yaw = sd === 0 ? legYawL : legYawR;
        const hipX = sideSign * 0.092 * (1 + (bs.torsoW - 1) * 0.6);

        // Where this leg is in its stride: sg = 0 mid-stance (the foot under him), |q| < 1
        // through the stance, sg < -dutyA coming in to land, sg > dutyA just pushed off.
        let sg = phi + (sd === 0 ? 0 : Math.PI) - Math.PI;
        sg -= Math.PI * 2 * Math.floor((sg + Math.PI) / (Math.PI * 2));
        const q = standing > 0.5 ? 0 : sg / dutyA;
        const stance = Math.abs(q) < 1;
        const go = 1 - standing;
        const heelUp = stance ? (0.35 + 0.25 * s) * smoothstep(0.15, 1, q) * go : 0;
        const toesUp = (0.24 * (1 - 0.5 * s) * (stance ? 1 - smoothstep(-1, -0.55, q) : sg < 0 ? smoothstep(-dutyA - 0.9, -dutyA, sg) : 0)) * go;
        const trail = !stance && sg > 0 ? 0.35 * (0.4 + s) * (1 - smoothstep(dutyA, dutyA + 1.0, sg)) * go : 0;

        if (ik > 0.001 && stance) {
          if (this.inStance[fi] === 0) {
            // Touch-down: put the foot where the stance will be centred under him.
            const ahead = -q * 0.85 * duty * stepLen * (1 - standing) + 0.11 * sc;
            const lat = (hipX + sideSign * Math.sin(out) * (l1 + l2)) * sc;
            this.plantX[fi] = x + cf * ahead + sf * lat;
            this.plantZ[fi] = z + sf * ahead - cf * lat;
            this.inStance[fi] = 1;
          }
          // Held through the stance, eased in and out at its ends; once let go, it fades.
          this.footW[fi] = this.inStance[fi] === 1 ? (1 - smoothstep(0.6, 1, Math.abs(q))) * ik : this.footW[fi] * Math.exp(-dt * 30);
        } else {
          this.inStance[fi] = 0;
          this.footW[fi] = 0;
        }
        const w = this.footW[fi];

        if (w > 0.001) {
          // Ankle target: behind the planted ball of the foot, raised as the heel lifts.
          const rbY = (-0.068 * Math.cos(heelUp) - 0.11 * Math.sin(heelUp)) * sc;
          const rbZ = (-0.068 * Math.sin(heelUp) + 0.11 * Math.cos(heelUp)) * sc;
          this.tv.set(this.plantX[fi] - cf * rbZ, 0.003 - rbY, this.plantZ[fi] - sf * rbZ);
          if (this.legIK(hipX, yaw, sideSign, l1, l2)) {
            hip = lerp(hip, this.ikH, w);
            knee = lerp(knee, this.ikK, w);
            out = lerp(out, this.ikOut, w);
          } else if (stance) this.inStance[fi] = 2; // out of reach (pushed off it): pick the foot up
        }
        // j1/j2 already hold this leg (the floor check posed it and it stands).
        let posed = false;
        if (upright && w < 0.999) {
          // Never through the grass: an action's foot that would go below it stands on it.
          this.legChain(P, hipX, hip, yaw, sideSign * out, knee, bs.leg);
          posed = true;
          this.tv.set(0, -SHIN * bs.leg, 0).applyMatrix4(this.j2);
          const floor = 0.07 * sc;
          if (this.tv.y < floor) {
            this.tv.y = floor;
            if (this.legIK(hipX, yaw, sideSign, l1, l2)) {
              hip = this.ikH;
              knee = this.ikK;
              out = this.ikOut;
              posed = false;
            }
          }
        }
        if (!posed) this.legChain(P, hipX, hip, yaw, sideSign * out, knee, bs.leg);
        this.put('shortsLeg', fj, this.j1, bs.thigh, 1, bs.thigh);
        this.put('thigh', fj, this.j1, bs.thigh, bs.leg, bs.thigh);
        kneeBend.setXYZ(fj, knee * 0.22, 0, 0);
        this.put('shin', fj, this.j2, bs.calf, bs.leg, bs.calf);
        // Ankle (+ = toes down). Free: roughly level with the ground, with the stride's
        // trail and cock-up; planted: flat on the grass (or rolled up onto the toe).
        const extra = sd === 0 ? ankleL : ankleR;
        const freeA = clamp(hip - knee, -1.2, 0.6) - 0.35 * smoothstep(0.6, 1.0, knee) + (trail - toesUp) * ik - extra;
        const flatA = hip - knee - leanF + heelUp - toesUp;
        const ankle = lerp(freeA, flatA, w);
        this.chainX(this.j3, this.j2, 0, -SHIN * bs.leg, 0, ankle);
        this.put('boot', fj, this.j3);
        toe.setX(fj, heelUp * w + 0.25 * trail * ik);
      }

      // Contact shadow.
      this.q.identity();
      this.v.set(x, 0.015, z);
      const lying = p.action === 'slide' || p.action === 'dive' ? 1.5 : 1;
      this.s.set(0.8 * lying, 1, 0.8 * lying);
      this.sm.compose(this.v, this.q, this.s);
      this.contact.setMatrixAt(j, this.sm);

      // Floodlight shadows: one faint, long shadow away from each pylon.
      for (let k = 0; floodOn && k < PYLONS.length; k++) {
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
        this.flood.setMatrixAt(j * PYLONS.length + k, this.sm);
      }
    }

    // Controlled player ring + marker.
    const c = match.controlled;
    const cx = lerp(c.prevPos.x, c.pos.x, alpha);
    const cz = lerp(c.prevPos.z, c.pos.z, alpha);
    this.ring.position.set(cx, 0.02, cz);
    const pulse = match.switchT < 0.3 ? 1 + (0.3 - match.switchT) * 2 : 1;
    this.ring.scale.setScalar(pulse);
    this.marker.position.set(cx, 2.3 * c.look.height + Math.sin(time * 4) * 0.05, cz);
    this.marker.rotation.y = time * 1.5;
    const show = match.phase !== 'fulltime' && !match.autoPlay && !match.deadBallView;
    this.ring.visible = show;
    this.marker.visible = show;
  }
}
