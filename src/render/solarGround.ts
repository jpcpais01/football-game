import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PITCH } from '../sim/constants';
import { PYLONS, floodLamps, litMaterial } from './look';
import { standPath } from './oldGround';
import {
  type Board,
  type PathPt,
  type Stadium,
  type StadiumClub,
  adBoards,
  at,
  awayTifoTexture,
  bakeStatic,
  banners,
  caps,
  crowdFlags,
  crowdMaterial,
  drawCrest,
  fanBanners,
  fasciaMaterial,
  glassMaterial,
  groundPlanes,
  lampGlows,
  lampMaterial,
  lightShafts,
  pitchside,
  playersTunnel,
  ringStrip,
  sky,
  tifoTexture,
  updateShared,
  zoneRange,
} from './stadium';

/**
 * Solar Gardens: a solarpunk ground, built chunky so it sits well in the pixel art. Rammed
 * earth in warm bands, slatted timber, hedges and hanging gardens, solar glass on every roof.
 * - The far side is the main stand: two tiers under a sawtooth canopy of solar panels held
 *   up by white tree columns, vines hanging from the fascia, a greenhouse café at the back
 *   and the club's sun crest standing on the roof.
 * - Behind the home goal, the Grove: a steep terrace under a green roof with a little wood
 *   growing on top of it.
 * - The away end is open to the sky under a timber pergola of solar louvres.
 * - In the corners, floodlight "light trees" (voxel trunks, branches, a solar canopy over
 *   the lamps) rise out of planted mounds; beyond the stands, terraced garden towers, avenues
 *   of trees and wind turbines turning on the hills.
 * The front walls stand where the big stadium's do, so the ball, the flares and the
 * camera's crowd shots all work the same here.
 */

const FX = PITCH.halfL + 8.5;
const FZ = PITCH.halfW + 7.5;
/** Rake of the lower steps: the same as the other grounds' (flares and flags sit on it). */
const RAKE = 10.1 / 19.6;
const tier = (o: number) => 1.4 + (o - 0.4) * RAKE;

/** A colour given in sRGB hex as a GLSL vec3 (linear, like everything in the shaders). */
const v3 = (hex: number) => {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};
const HASH = 'float vhash(vec3 q) { return fract(sin(dot(q, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }';
/** World normals (all this ground's geometry is baked into world space). */
const WN = { vertDecl: 'varying vec3 vWN;', vertBody: 'vWN = normal;' };

const LEAVES = [0x2f6a35, 0x4b8a3c, 0x6fa846, 0x3a7a46];

/** Rammed earth: tamped layers of ochre, sand and terracotta, gently waving. */
function earthMaterial(): THREE.MeshStandardMaterial {
  const m = litMaterial({
    roughness: 0.95,
    fragDecl: HASH,
    diffuseHook: `{
      float y = vWorldPos.y + 0.2 * sin((vWorldPos.x + vWorldPos.z) * 0.19);
      float k = vhash(vec3(floor(y / 0.4), 0.0, 0.0));
      diffuseColor.rgb = k < 0.4 ? ${v3(0xd09468)} : k < 0.75 ? ${v3(0xe2bf92)} : ${v3(0xb56f4b)};
    }`,
  });
  m.side = THREE.DoubleSide;
  return m;
}

/** Slatted timber: boards 30 cm wide along u, each its own shade, dark gaps between. */
function timberMaterial(): THREE.MeshStandardMaterial {
  const m = litMaterial({
    roughness: 0.8,
    fragDecl: HASH,
    diffuseHook: `{
      float s = vUv2.x / 0.3;
      vec3 wood = mix(${v3(0x9c643a)}, ${v3(0xc68c55)}, vhash(vec3(floor(s), 3.0, 0.0)));
      diffuseColor.rgb = wood * (1.0 - 0.5 * step(0.84, fract(s)));
    }`,
  });
  m.side = THREE.DoubleSide;
  return m;
}

/**
 * Foliage in chunky 60 cm voxels of four greens, a share of them in flower. The cells are
 * taken a little inside the surface so a face never straddles two of them.
 */
function leafMaterial(flowers: number): THREE.MeshStandardMaterial {
  const m = litMaterial({
    roughness: 1,
    ...WN,
    fragDecl: HASH + 'varying vec3 vWN;',
    diffuseHook: `{
      vec3 q = floor((vWorldPos - vWN * 0.08) * 1.7);
      float k = vhash(q);
      vec3 leaf = k < 0.3 ? ${v3(LEAVES[0])} : k < 0.6 ? ${v3(LEAVES[1])} : k < 0.85 ? ${v3(LEAVES[2])} : ${v3(LEAVES[3])};
      if (vhash(q + 17.0) < ${flowers.toFixed(3)}) leaf = k < 0.45 ? ${v3(0xe0558e)} : k < 0.8 ? ${v3(0xf4cf48)} : ${v3(0xf3eee2)};
      diffuseColor.rgb = leaf;
    }`,
  });
  m.side = THREE.DoubleSide;
  return m;
}

/** Solar glass: deep blue cells in silver frames, each cell a slightly different blue. */
function solarMaterial(): THREE.MeshStandardMaterial {
  const m = litMaterial({
    roughness: 0.3,
    metalness: 0.25,
    fragDecl: HASH,
    diffuseHook: `{
      vec2 c = vec2(vUv2.x / 1.1, vUv2.y / 1.75);
      vec2 f = fract(c);
      float frame = max(step(0.9, f.x), step(0.92, f.y));
      vec3 cell = mix(${v3(0x1c3466)}, ${v3(0x2d5296)}, vhash(vec3(floor(c), 5.0)) * 0.8);
      diffuseColor.rgb = mix(cell, ${v3(0xc4ccd6)}, frame);
    }`,
  });
  m.side = THREE.DoubleSide;
  return m;
}

/**
 * Hanging gardens: on a 3.2 m strip (uv y from its bottom), strands of leaves 40 cm wide
 * hang from the top edge, each to its own length, with holes and flowers along them.
 */
const VINE_H = 3.2;
function vineMaterial(): THREE.MeshStandardMaterial {
  const m = litMaterial({
    roughness: 1,
    fragDecl: HASH,
    diffuseHook: `{
      float col = floor(vUv2.x / 0.4);
      vec3 q = vec3(col, floor(vUv2.y / 0.4), 2.0);
      float k = vhash(q);
      float len = 0.4 + ${(VINE_H - 0.5).toFixed(2)} * pow(vhash(vec3(col, 1.0, 0.0)), 1.8);
      if (${VINE_H.toFixed(2)} - vUv2.y > len || k < 0.14) discard;
      vec3 leaf = k < 0.45 ? ${v3(LEAVES[0])} : k < 0.8 ? ${v3(LEAVES[1])} : ${v3(LEAVES[2])};
      if (vhash(q + 9.0) < 0.07) leaf = ${v3(0xe0558e)};
      diffuseColor.rgb = leaf;
    }`,
  });
  m.side = THREE.DoubleSide;
  return m;
}

/**
 * The garden towers round the ground: walls in their own colour (vertex colour), a grid of
 * windows that warm up at dusk, and planted balconies on some floors.
 */
function towerMaterial(): THREE.MeshStandardMaterial {
  const m = litMaterial({
    vertexColors: true,
    roughness: 0.9,
    ...WN,
    fragDecl: HASH + 'varying vec3 vWN; float gWin;',
    diffuseHook: `{
      bool xf = abs(vWN.x) > 0.5;
      float s = xf ? vWorldPos.z : vWorldPos.x;
      float face = xf ? floor(vWorldPos.x) : floor(vWorldPos.z);
      float y = vWorldPos.y;
      vec2 cell = vec2(floor(s / 3.0), floor(y / 3.4));
      vec2 w = vec2(fract(s / 3.0), fract(y / 3.4));
      float side = step(abs(vWN.y), 0.5);
      float win = step(abs(w.x - 0.5), 0.26) * step(0.32, w.y) * step(w.y, 0.84) * side;
      float on = step(0.5, vhash(vec3(cell, face)));
      gWin = win * on;
      vec3 c = mix(diffuseColor.rgb, mix(${v3(0x26343f)}, ${v3(0xffcf88)}, on * uFlood), win);
      float planted = step(w.y, 0.16) * side * step(0.45, vhash(vec3(cell.y, face, 7.0)));
      diffuseColor.rgb = mix(c, vhash(vec3(cell, 3.0)) < 0.5 ? ${v3(LEAVES[1])} : ${v3(LEAVES[0])}, planted);
    }`,
  });
  m.onBeforeCompile = ((orig) => (shader: Parameters<typeof orig>[0], r: Parameters<typeof orig>[1]) => {
    orig(shader, r);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.74, 0.42) * gWin * uFlood * 0.9;',
    );
  })(m.onBeforeCompile.bind(m));
  return m;
}

const LOCAL_BOARDS: Board[] = [
  { bg: '#f2c641', fg: '#1d3a2a', text: 'SUNCOOP' },
  { bg: '#2f6a35', fg: '#f3eee2', text: 'SEED BANK' },
  { bg: '#e2bf92', fg: '#7a3b22', text: 'BIKE KITCHEN' },
  { bg: '#1c3466', fg: '#f2c641', text: 'GAMENIGHT' },
  { bg: '#b56f4b', fg: '#f3eee2', text: 'TRAMLINE 9' },
  { bg: '#f3eee2', fg: '#2f6a35', text: 'RAIN GARDEN' },
  { bg: '#e0558e', fg: '#f3eee2', text: 'HONEY & HIVE' },
  { bg: '#3a7a46', fg: '#f2c641', text: 'OPEN SKY CO-OP' },
];

/** The sun crest standing on the main stand's roof: rays round a disc with the club crest. */
function sunCrestTexture(home: number, club: StadiumClub): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const hex = '#' + home.toString(16).padStart(6, '0');
  let crest: CanvasImageSource | null = null;
  const draw = () => {
    const g = cv.getContext('2d')!;
    g.clearRect(0, 0, 256, 256);
    g.fillStyle = '#f2c641';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      g.beginPath();
      g.moveTo(128 + Math.cos(a - 0.13) * 84, 128 + Math.sin(a - 0.13) * 84);
      g.lineTo(128 + Math.cos(a) * 126, 128 + Math.sin(a) * 126);
      g.lineTo(128 + Math.cos(a + 0.13) * 84, 128 + Math.sin(a + 0.13) * 84);
      g.fill();
    }
    g.fillStyle = hex;
    g.beginPath();
    g.arc(128, 128, 90, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#f3eee2';
    g.beginPath();
    g.arc(128, 128, 76, 0, Math.PI * 2);
    g.fill();
    if (crest) drawCrest(g, crest, 128, 128, 120);
    tex.needsUpdate = true;
  };
  draw();
  void club.crest?.then((img) => ((crest = img), draw()));
  return tex;
}

/** The board at the back of the away end: a rising sun and a welcome. */
function welcomeTexture(club: StadiumClub): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 160;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const draw = () => {
    const g = cv.getContext('2d')!;
    g.fillStyle = '#1d3a2a';
    g.fillRect(0, 0, 512, 160);
    g.fillStyle = '#f2c641';
    g.beginPath();
    g.arc(86, 120, 52, Math.PI, 0);
    g.fill();
    for (let i = 0; i <= 6; i++) {
      const a = Math.PI + (i / 6) * Math.PI;
      g.fillRect(86 + Math.cos(a) * 62 - 4, 120 + Math.sin(a) * 62 - 4, 8, 8);
    }
    g.fillStyle = '#f3eee2';
    g.font = '800 46px "Barlow Condensed", "Arial Narrow", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText((club.name ?? 'GAMENIGHT').toUpperCase(), 320, 60, 330);
    g.fillStyle = '#9fd38a';
    g.font = '700 28px "Barlow Condensed", "Arial Narrow", sans-serif';
    g.fillText('WELCOME TO SOLAR GARDENS', 320, 116, 330);
    tex.needsUpdate = true;
  };
  draw();
  void document.fonts?.ready.then(draw);
  return tex;
}

type Parts = Map<THREE.Material, THREE.BufferGeometry[]>;

/** Into a merge list: non-indexed, with only the attributes every part of its material has
 * (the crowd keeps its home / away end marks). */
function put(parts: Parts, mat: THREE.Material, g: THREE.BufferGeometry): void {
  const n = g.index ? g.toNonIndexed() : g;
  const keep = mat.userData.crowd ? ['position', 'normal', 'uv', 'aHome', 'aAway'] : ['position', 'normal', 'uv', 'color'];
  for (const k of Object.keys(n.attributes)) if (!keep.includes(k)) n.deleteAttribute(k);
  const list = parts.get(mat) ?? [];
  list.push(n);
  parts.set(mat, list);
}

/** One mesh per material. */
function meshes(parts: Parts, into: THREE.Group = new THREE.Group()): THREE.Group {
  for (const [mat, geos] of parts) into.add(new THREE.Mesh(geos.length > 1 ? mergeGeometries(geos)! : geos[0], mat));
  return into;
}

/** A w x h x d box standing on y at (x, z), turned ry, with uv in metres on every face. */
function box(w: number, h: number, d: number, x: number, y: number, z: number, ry = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let k = 0; k < 24; k++) uv.setXY(k, uv.getX(k) * dims[k >> 2][0], uv.getY(k) * dims[k >> 2][1]);
  return g.applyMatrix4(new THREE.Matrix4().makeRotationY(ry).setPosition(x, y + h / 2, z));
}

/** A voxel tree: a trunk and a blocky crown of leaf cubes, `s` sets its size. */
function tree(parts: Parts, trunk: THREE.Material, leaves: THREE.Material, x: number, y: number, z: number, s: number, rnd: () => number): void {
  const snap = (v: number) => Math.round(v / 0.6) * 0.6;
  put(parts, trunk, box(0.6 * s, 2.4 * s, 0.6 * s, x, y, z));
  const top = y + 2.1 * s;
  put(parts, leaves, box(snap(3 * s), snap(2.1 * s), snap(3 * s), x, top, z));
  for (let i = 0; i < 3; i++) {
    const a = rnd() * Math.PI * 2;
    put(parts, leaves, box(snap(1.8 * s), snap(1.5 * s), snap(1.8 * s), x + snap(Math.cos(a) * 1.5 * s), top + snap((0.3 + rnd()) * s), z + snap(Math.sin(a) * 1.5 * s)));
  }
  put(parts, leaves, box(snap(1.8 * s), snap(1.2 * s), snap(1.8 * s), x, top + snap(2 * s), z));
}

/** The point `t` metres along a straight stand's front. */
function along(pts: PathPt[], t: number): PathPt {
  const a = pts[0];
  const b = pts[pts.length - 1];
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  return { ...a, x: a.x + ((b.x - a.x) * t) / len, z: a.z + ((b.z - a.z) * t) / len };
}
const lengthOf = (pts: PathPt[]) => Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].z - pts[0].z);

export function createSolarGround(homeColor: number, awayColor: number, club: StadiumClub = {}): Stadium {
  const group = new THREE.Group();
  group.add(sky());
  const [land, apron] = groundPlanes();
  (land.material as THREE.MeshStandardMaterial).color.setHex(0x5f7646);
  group.add(land, apron);

  const main = standPath(0, -FZ, 0, -1, 44, 0);
  const grove = standPath(-FX, 0, -1, 0, 30, 1);
  const away = standPath(FX, 0, 1, 0, 26, 2);
  const near = standPath(0, FZ, 0, 1, 36, 0);
  const all = [...main, ...grove, ...away];

  const earth = earthMaterial();
  const timber = timberMaterial();
  const hedge = leafMaterial(0.06);
  const crown = leafMaterial(0.02);
  const bloom = leafMaterial(0.3);
  const solar = solarMaterial();
  const vines = vineMaterial();
  const paving = litMaterial({ color: 0xe9e1cf, roughness: 0.9 });
  paving.side = THREE.DoubleSide;
  const bone = litMaterial({ color: 0xece6d6, roughness: 0.6 });
  const bark = litMaterial({ color: 0x6b4a2e, roughness: 0.95 });
  const fascia = fasciaMaterial(homeColor, club.name ?? 'GAMENIGHT');
  const glass = glassMaterial();
  const seat = new THREE.Color(homeColor).multiplyScalar(0.62).getHex();

  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  const byMat: Parts = new Map();
  const strip = (pts: PathPt[], a: [number, number], b: [number, number], mat: THREE.Material) => put(byMat, mat, ringStrip(pts, a, b));
  /** Vines hang in their own mesh: they're lace, so they mustn't cast a solid stand shadow. */
  const vineParts: Parts = new Map();
  const hang = (pts: PathPt[], o: number, top: number) => put(vineParts, vines, ringStrip(pts, [o, top - VINE_H], [o, top]));
  const scenery: Parts = new Map();

  // Timber (the pergola) and bone-white (tree columns, the light trees): instanced beams.
  const timberBeams: THREE.Matrix4[] = [];
  const boneBeams: THREE.Matrix4[] = [];
  const zAxis = new THREE.Vector3(0, 0, 1);
  const q = new THREE.Quaternion();
  const beam = (list: THREE.Matrix4[], a: THREE.Vector3, b: THREE.Vector3, w: number, h = w) => {
    const len = a.distanceTo(b);
    if (len < 0.05) return;
    q.setFromUnitVectors(zAxis, b.clone().sub(a).normalize());
    list.push(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(w, h, len)));
  };
  /** Tree columns: a white trunk that branches into three struts under a roof. */
  const treeColumns = (pts: PathPt[], o: number, fork: number, roofH: (o: number) => number, every: number, reach: number) => {
    const len = lengthOf(pts);
    for (let t = every / 2; t < len - 2; t += every) {
      const p = along(pts, t);
      if (Math.abs(p.x) < 5 && p.nz < 0) continue; // the tunnel
      const knot = at(p, o, fork);
      beam(boneBeams, at(p, o, tier(o)), knot, 0.55);
      for (const [dt, oo] of [[-reach, o - 0.4], [reach, o - 0.4], [0, o + reach * 2]]) {
        const pp = along(pts, Math.min(len, Math.max(0, t + dt)));
        beam(boneBeams, knot, at(pp, oo, roofH(oo) - 0.1), 0.32);
      }
    }
  };

  // ---- the main stand: two tiers under a sawtooth solar canopy
  const t1 = tier(14);
  const U0: [number, number] = [16, t1 + 1];
  const U1: [number, number] = [29, U0[1] + 13 * 0.56];
  /** Underside of the canopy, and the base its sawtooth sits on. */
  const R = (o: number) => 19.4 + ((o - 2) / 30) * 1.0;
  const B = (o: number) => R(o) + 0.35;
  const TOOTH = 1.8;
  const mainLower = crowdMaterial({ home: homeColor, away: awayColor, shade: [6, 14], seat, aisles: [12, 1], fill: 0.8 });
  const mainUpper = crowdMaterial({ home: homeColor, away: awayColor, shade: [-2, 8], seat, aisles: [12, 1], fill: 0.7 });
  strip(main, [0, 0], [0, 1.4], earth);
  strip(main, [0, 1.4], [0.4, 1.4], hedge);
  strip(main, [0.4, 1.4], [14, t1], mainLower);
  strip(main, [14, t1], [15.6, t1], paving);
  strip(main, [15.6, t1], [15.6, U0[1]], timber);
  strip(main, [15.6, U0[1]], U0, bloom); // a planter along the upper tier's front
  strip(main, U0, U1, mainUpper);
  strip(main, U1, [30, U1[1]], paving);
  strip(main, [30, U1[1]], [30, R(30)], glass); // the greenhouse café
  strip(main, [32, R(32)], [2, R(2)], timber); // slatted soffit
  strip(main, [2, R(2)], [2, B(2)], timber);
  for (let s = 2; s < 32; s += 6) {
    strip(main, [s, B(s)], [s + 6, B(s + 6) + TOOTH], solar);
    strip(main, [s + 6, B(s + 6)], [s + 6, B(s + 6) + TOOTH], glass); // north lights
  }
  strip(main, [1.6, 17.6], [1.6, 19.8], fascia);
  hang(main, 1.7, 17.6);
  strip(main, [32, 0], [32, 10], earth);
  strip(main, [32, 10], [32, B(32)], timber);
  const mainEnds = [main[0], main[main.length - 1]];
  put(byMat, earth, caps(mainEnds, [[0, 0], [0, 1.4], [0.4, 1.4], [14, t1], [15.6, t1], [15.6, U0[1]], U0, U1, [30, U1[1]], [30, R(30)], [32, R(32)], [32, 0]]));
  // The canopy's ends: the slab and its teeth (a sawtooth outline, back to front).
  const saw: [number, number][] = [[2, R(2)], [32, R(32)]];
  for (let e = 32; e > 2; e -= 6) saw.push([e, B(e) + TOOTH], [e - 6, B(e - 6)]);
  put(byMat, timber, caps(mainEnds, saw));
  treeColumns(main, 2.6, 12, R, 12, 3);

  // ---- the Grove: the home end's terrace under a green roof with a wood on top
  const t19 = tier(19);
  const under = (o: number) => 12 + ((o - 3) / 18.5) * 2.2;
  const roofTop = (o: number) => 13.4 + ((o - 3) / 18.5) * 2.2;
  const groveSlope = Math.hypot(19 - 0.4, t19 - 1.4);
  const homeU = zoneRange(grove, 0.4, 1);
  const groveCrowd = crowdMaterial({
    home: homeColor,
    away: awayColor,
    shade: [-1, 9],
    seat,
    tifo: { tex: tifoTexture(homeColor, club), rect: new THREE.Vector4(homeU[0] + 1, homeU[1] - 1, 0.6, groveSlope - 0.4) },
  });
  strip(grove, [0, 0], [0, 1.4], earth);
  strip(grove, [0, 1.4], [0.4, 1.4], hedge);
  strip(grove, [0.4, 1.4], [19, t19], groveCrowd);
  strip(grove, [19, t19], [20, t19], paving);
  strip(grove, [20, t19], [20, under(20)], timber);
  strip(grove, [21.5, under(21.5)], [3, under(3)], timber);
  strip(grove, [3, 11.2], [3, 13.4], fascia);
  strip(grove, [3, roofTop(3)], [21.5, roofTop(21.5)], hedge);
  strip(grove, [21.5, 0], [21.5, roofTop(21.5)], earth);
  hang(grove, 3.1, 11.2);
  put(byMat, earth, caps([grove[0], grove[grove.length - 1]], [[0, 0], [0, 1.4], [0.4, 1.4], [19, t19], [20, t19], [20, under(20)], [3, under(3)], [3, 13.4], [21.5, roofTop(21.5)], [21.5, 0]]));
  treeColumns(grove, 3.4, 8.2, under, 10, 2.5);
  // The wood on the roof: three staggered rows of trees, hedges round the edge.
  const groveLen = lengthOf(grove);
  [7, 12, 17].forEach((o, r) => {
    for (let t = 3 + r * 2; t < groveLen - 2; t += 6) {
      const p = along(grove, t + (rnd() - 0.5) * 2);
      const v = at(p, o + (rnd() - 0.5) * 1.5, 0);
      tree(scenery, bark, crown, v.x, roofTop(o) - 0.1, v.z, 0.8 + rnd() * 0.45, rnd);
    }
  });
  {
    const a = at(grove[0], 4, 0);
    const b = at(grove[grove.length - 1], 4, 0);
    put(scenery, bloom, box(1, 0.9, Math.abs(b.z - a.z), a.x, roofTop(4) - 0.1, 0));
  }

  // ---- the away end: an open terrace under a timber pergola of solar louvres
  const t17 = tier(17);
  const awaySlope = Math.hypot(17 - 0.4, t17 - 1.4);
  const awayU = zoneRange(away, 0.4, 2);
  const awayCrowd = crowdMaterial({
    home: homeColor,
    away: awayColor,
    shade: [99, 100],
    seat,
    fill: 0.35,
    tifoB: { tex: awayTifoTexture(awayColor), rect: new THREE.Vector4(awayU[0] + 6, awayU[1] - 6, 0.6, awaySlope * 0.55) },
  });
  strip(away, [0, 0], [0, 1.4], earth);
  strip(away, [0, 1.4], [0.4, 1.4], hedge);
  strip(away, [0.4, 1.4], [17, t17], awayCrowd);
  strip(away, [17, t17], [18, t17], paving);
  strip(away, [18, t17], [18, t17 + 1.3], timber);
  strip(away, [18, t17 + 1.3], [18.6, t17 + 1.3], bloom);
  strip(away, [18.6, 0], [18.6, t17 + 1.3], earth);
  put(byMat, earth, caps([away[0], away[away.length - 1]], [[0, 0], [0, 1.4], [0.4, 1.4], [17, t17], [18, t17], [18, t17 + 1.3], [18.6, t17 + 1.3], [18.6, 0]]));
  const P = (o: number) => 12.6 + (o - 1.6) * 0.12;
  {
    const len = lengthOf(away);
    const a = away[0];
    const b = away[away.length - 1];
    for (const o of [1.6, 17.6]) beam(timberBeams, at(a, o, P(o)), at(b, o, P(o)), 0.45, 0.6);
    for (let t = 0; t <= len + 0.01; t += len / 6) {
      const p = along(away, t);
      beam(timberBeams, at(p, 1.6, tier(1.6)), at(p, 1.6, P(1.6)), 0.45);
      beam(timberBeams, at(p, 17.6, t17), at(p, 17.6, P(17.6)), 0.45);
      beam(timberBeams, at(p, 1.6, P(1.6)), at(p, 17.6, P(17.6)), 0.3, 0.5);
    }
    for (let o = 2.2; o + 1.4 < 17.6; o += 1.95) strip(away, [o, P(o) + 0.3], [o + 1.4, P(o) + 0.85], solar);
  }

  for (const [mat, geos] of byMat) group.add(new THREE.Mesh(geos.length > 1 ? mergeGeometries(geos)! : geos[0], mat));
  const vineMesh = meshes(vineParts);
  vineMesh.userData.noStandShadow = true;
  group.add(vineMesh);

  // ---- fixtures: the sun crest on the main roof, the welcome board, the tunnel
  const fixtures = new THREE.Group();
  const mid = main[Math.floor(main.length / 2)];
  const crestMat = litMaterial({ roughness: 0.7 });
  crestMat.map = sunCrestTexture(homeColor, club);
  crestMat.alphaTest = 0.5;
  crestMat.side = THREE.DoubleSide;
  const crest = new THREE.Mesh(new THREE.PlaneGeometry(7, 7), crestMat);
  crest.position.copy(at(mid, 2.2, B(2.2) + 3.3));
  crest.rotation.y = Math.atan2(-mid.nx, -mid.nz);
  crest.userData.live = true;
  fixtures.add(crest);
  const awayMid = away[Math.floor(away.length / 2)];
  const welcome = new THREE.Mesh(new THREE.PlaneGeometry(11, 3.4), new THREE.MeshBasicMaterial({ map: welcomeTexture(club), side: THREE.DoubleSide }));
  welcome.position.copy(at(awayMid, 18.7, t17 + 3.6));
  welcome.rotation.y = Math.atan2(-awayMid.nx, -awayMid.nz);
  welcome.userData.live = true;
  fixtures.add(welcome);
  for (const s of [-4.2, 4.2]) beam(timberBeams, at({ ...awayMid, z: awayMid.z + s }, 18.9, t17 + 1.3), at({ ...awayMid, z: awayMid.z + s }, 18.9, t17 + 2.1), 0.3);
  fixtures.add(playersTunnel(timber));
  group.add(bakeStatic(fixtures));

  // ---- light trees in the corners: voxel trunks branching up to a solar canopy over the lamps
  const HEAD = 34;
  const lamps = new THREE.InstancedMesh(new THREE.PlaneGeometry(5.6, 1.8), lampMaterial(), PYLONS.length * 2);
  const spots: THREE.Vector3[] = [];
  PYLONS.forEach(([px, pz], k) => {
    for (let y = 0; y < HEAD - 4; y += 4) {
      const w = 2.6 - (y / HEAD) * 1.6;
      put(scenery, bone, box(w, 4, w, px, y, pz));
      if (rnd() < 0.6) put(scenery, hedge, box(w * 0.7, 1.2, 0.6, px + (rnd() < 0.5 ? -1 : 1) * w * 0.5, y + 1 + rnd() * 2, pz)); // moss
    }
    const yaw = Math.atan2(-px, -pz);
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const side = new THREE.Vector3(fwd.z, 0, -fwd.x);
    const knot = new THREE.Vector3(px, HEAD - 6, pz);
    const top = new THREE.Vector3(px, HEAD, pz).addScaledVector(fwd, 1.5);
    for (const [f, s] of [[3.5, 4.5], [3.5, -4.5], [-3, 4], [-3, -4]]) beam(boneBeams, knot, top.clone().addScaledVector(fwd, f).addScaledVector(side, s).setY(HEAD - 0.6 - f * 0.12), 0.45);
    const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.12, yaw, 0, 'YXZ'));
    const slab = (w: number, h: number, d: number, dy: number, mat: THREE.Material) => {
      const g = box(w, h, d, 0, -h / 2, 0);
      put(scenery, mat, g.applyMatrix4(new THREE.Matrix4().compose(top.clone().setY(HEAD + dy), tilt, new THREE.Vector3(1, 1, 1))));
    };
    slab(15, 0.35, 11, 0.35, solar);
    slab(14, 0.6, 10, -0.05, bone);
    // The lamps under the canopy's front edge, facing the centre spot and tilted down.
    const e = new THREE.Euler(0.42, yaw, 0, 'YXZ');
    const c0 = top.clone().addScaledVector(fwd, 4.6).setY(HEAD - 2.2);
    for (let r = 0; r < 2; r++) {
      const pos = c0.clone().addScaledVector(side, (r - 0.5) * 5.8);
      lamps.setMatrixAt(k * 2 + r, new THREE.Matrix4().compose(pos, q.setFromEuler(e), new THREE.Vector3(1, 1, 1)));
    }
    spots.push(c0.clone().addScaledVector(fwd, 1.2));
    // The planted mound the tree grows out of, stepped like a voxel hill.
    const out = new THREE.Vector2(px, pz).normalize();
    [[16, 13], [11, 9], [6, 5]].forEach(([w, d], i) => put(scenery, i === 2 ? bloom : hedge, box(w, 1.1, d, px + out.x * 4, i * 1.1 - 0.05, pz + out.y * 4)));
    for (let i = 0; i < 5; i++) {
      const a = Math.atan2(out.y, out.x) + (rnd() - 0.5) * 1.8;
      const r = 11 + rnd() * 7;
      tree(scenery, bark, crown, px + Math.cos(a) * r, 0, pz + Math.sin(a) * r, 1.1 + rnd() * 0.6, rnd);
    }
  });
  lamps.instanceMatrix.needsUpdate = true;
  group.add(lamps);
  const glows = lampGlows(spots, 1.1);
  const banks = floodLamps(spots);
  group.add(glows.mesh);
  const shafts = lightShafts(spots.filter((s) => s.z < 0));
  group.add(shafts);

  // ---- the near side: a low paddock in play, a little green-roofed stand for the low shots
  const paddockCrowd = crowdMaterial({ home: homeColor, away: awayColor, shade: [99, 100], seat, aisles: [12, 1], fill: 0.6 });
  const paddockGroup = new THREE.Group();
  const nearEnds = [near[0], near[near.length - 1]];
  {
    const pp: Parts = new Map();
    put(pp, earth, ringStrip(near, [0, 0], [0, 1.4]));
    put(pp, hedge, ringStrip(near, [0, 1.4], [0.4, 1.4]));
    put(pp, paddockCrowd, ringStrip(near, [0.4, 1.4], [8, tier(8)]));
    put(pp, bloom, ringStrip(near, [8, tier(8)], [9, tier(8)]));
    put(pp, earth, caps(nearEnds, [[0, 0], [0, 1.4], [0.4, 1.4], [8, tier(8)], [9, tier(8)], [9, 0]]));
    meshes(pp, paddockGroup);
  }
  group.add(paddockGroup);

  const nearStand = new THREE.Group();
  nearStand.visible = false;
  nearStand.userData.castsHidden = true; // its shadow falls on the pitch either way
  {
    const nearCrowd = crowdMaterial({ home: homeColor, away: awayColor, shade: [-2, 6], seat, aisles: [12, 1], fill: 0.8 });
    const t11 = tier(11);
    const nu = (o: number) => 9 + ((o - 1.5) / 11) * 1.2;
    const nt = (o: number) => 9.9 + ((o - 1.5) / 11) * 1.2;
    const np: Parts = new Map();
    const ns = (a: [number, number], b: [number, number], mat: THREE.Material) => put(np, mat, ringStrip(near, a, b));
    ns([0, 0], [0, 1.4], earth);
    ns([0, 1.4], [0.4, 1.4], hedge);
    ns([0.4, 1.4], [11, t11], nearCrowd);
    ns([11, t11], [12, t11], paving);
    ns([12, t11], [12, nu(12)], timber);
    ns([12.5, nu(12.5)], [1.5, nu(1.5)], timber);
    ns([1.5, 7.7], [1.5, 9.9], fascia);
    ns([1.5, nt(1.5)], [12.5, nt(12.5)], hedge);
    ns([12.5, 0], [12.5, nt(12.5)], earth);
    put(np, earth, caps(nearEnds, [[0, 0], [0, 1.4], [0.4, 1.4], [11, t11], [12, t11], [12, nu(12)], [1.5, nu(1.5)], [1.5, nt(1.5)], [12.5, nt(12.5)], [12.5, 0]]));
    for (let i = 1; i < 6; i++) {
      const p = along(near, (lengthOf(near) * i) / 6);
      const a = at(p, 1.8, tier(1.8));
      put(np, timber, box(0.45, nu(1.8) - a.y, 0.45, a.x, a.y, a.z));
    }
    meshes(np, nearStand);
  }
  group.add(nearStand);

  // ---- beyond the stands: avenues of trees, the garden towers, wind turbines on the hills
  for (let x = -66; x <= 66; x += 8.25) tree(scenery, bark, crown, x + (rnd() - 0.5) * 2, 0, -FZ - 38 - rnd() * 4, 1.2 + rnd() * 0.5, rnd);
  for (const sx of [-1, 1]) for (let z = -48; z <= 48; z += 8) tree(scenery, bark, crown, sx * (FX + (sx < 0 ? 28 : 25)) + (rnd() - 0.5) * 2, 0, z + (rnd() - 0.5) * 2, 1.1 + rnd() * 0.5, rnd);
  for (let x = -60; x <= 60; x += 10) tree(scenery, bark, crown, x + (rnd() - 0.5) * 3, 0, FZ + 20 + rnd() * 4, 1.1 + rnd() * 0.5, rnd);

  const towerParts: Parts = new Map();
  const tower = towerMaterial();
  const TONES = [0xf0e8d6, 0xe8d2b0, 0xdfe6dc, 0xe9c9a6, 0xf3eee2];
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + (rnd() - 0.5) * 0.12;
    const r = 1 + rnd() * 0.25;
    const x = Math.cos(a) * 150 * r;
    const z = Math.sin(a) * 118 * r;
    const ry = Math.floor(rnd() * 4) * (Math.PI / 2);
    const tone = new THREE.Color(TONES[Math.floor(rnd() * TONES.length)]);
    let w = 14 + rnd() * 10;
    let d = 14 + rnd() * 8;
    let y = 0;
    const levels = 3 + Math.floor(rnd() * 4);
    for (let l = 0; l < levels; l++) {
      const h = 6.8 * (1 + Math.floor(rnd() * 2));
      const g = box(w, h, d, x, y, z, ry);
      const n = g.attributes.position.count;
      const col = new Float32Array(n * 3);
      for (let v = 0; v < n; v++) col.set([tone.r, tone.g, tone.b], v * 3);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      put(towerParts, tower, g);
      y += h;
      // The terrace on the step: a planted slab, the next level set back.
      put(scenery, l === levels - 1 ? bloom : hedge, box(w - 0.6, 0.9, d - 0.6, x, y - 0.05, z, ry));
      w -= 3.6 + rnd() * 2;
      d -= 3.6 + rnd() * 2;
      if (w < 6 || d < 6) break;
    }
    // Most towers wear a solar crown; the rest grow a tree on top.
    if (rnd() < 0.65) {
      const g = box(Math.max(5, w + 2), 0.35, Math.max(5, d + 2), 0, 0, 0);
      put(scenery, solar, g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y + 2.2, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, ry, 0)), new THREE.Vector3(1, 1, 1))));
      put(scenery, bone, box(0.5, 2.2, 0.5, x, y, z));
    } else tree(scenery, bark, crown, x, y + 0.8, z, 1.6, rnd);
  }
  group.add(meshes(towerParts));

  // Wind turbines on the hills behind the main stand: white towers, rotors turning in the wind.
  const TURBINES: [number, number, number][] = [[-150, -172, 0.2], [-78, -190, 1.1], [8, -182, 2.3], [92, -194, 0.7], [165, -168, 1.7]];
  const HUB = 50;
  const blade = new THREE.BoxGeometry(1.4, 22, 0.4).translate(0, 11, 0);
  const rotors = new THREE.InstancedMesh(blade, bone, TURBINES.length * 3);
  rotors.userData.noStandShadow = true;
  rotors.frustumCulled = false;
  for (const [x, z] of TURBINES) {
    put(scenery, hedge, box(70, 6, 40, x, -2, z - 6)); // the hill
    for (let y = 4; y < HUB; y += 6.5) {
      const w = 3 - ((y - 4) / HUB) * 1.6;
      put(scenery, bone, box(w, 6.5, w, x, y, z));
    }
    put(scenery, bone, box(2.4, 2.6, 5.4, x, HUB - 1.3, z - 1));
  }
  const blades = (time: number) => {
    const m = new THREE.Matrix4();
    const rq = new THREE.Quaternion();
    const zq = new THREE.Vector3(0, 0, 1);
    TURBINES.forEach(([x, z, phase], i) => {
      for (let k = 0; k < 3; k++) {
        rq.setFromAxisAngle(zq, time * 0.9 + phase + (k * Math.PI * 2) / 3);
        rotors.setMatrixAt(i * 3 + k, m.compose(new THREE.Vector3(x, HUB, z + 1.8), rq, new THREE.Vector3(1, 1, 1)));
      }
    });
    rotors.instanceMatrix.needsUpdate = true;
  };
  blades(0);
  group.add(rotors);
  group.add(meshes(scenery));

  const timberMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), timber, timberBeams.length);
  timberBeams.forEach((m, i) => timberMesh.setMatrixAt(i, m));
  timberMesh.instanceMatrix.needsUpdate = true;
  group.add(timberMesh);
  const boneMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), bone, boneBeams.length);
  boneBeams.forEach((m, i) => boneMesh.setMatrixAt(i, m));
  boneMesh.instanceMatrix.needsUpdate = true;
  group.add(boneMesh);

  group.add(adBoards(LOCAL_BOARDS));
  group.add(crowdFlags(all, homeColor, awayColor, club));
  group.add(banners(all, homeColor, awayColor, club, { o: 19.9, y: 12.4, w: 30, h: 2.6 }));
  group.add(bakeStatic(pitchside(homeColor, awayColor)));
  const fan = fanBanners(all, homeColor);
  group.add(fan.group);

  return {
    group,
    setFanBanner: (photo) => fan.set(photo),
    setNearStand: (show) => {
      nearStand.visible = show;
      paddockGroup.visible = !show;
    },
    update(time, excitement, atmo, tifo = 0, terraces) {
      const flood = updateShared(time, excitement, atmo, tifo, terraces, banks);
      shafts.visible = flood > 0.2; // below this a beam adds well under one colour step
      glows.update(flood);
      blades(time);
    },
  };
}
