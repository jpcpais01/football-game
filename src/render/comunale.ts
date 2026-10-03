import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PITCH } from '../sim/constants';
import { floodLamps, litMaterial } from './look';
import { wallMaterial } from './oldGround';
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
  bowlPath,
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
  nearPath,
  pitchside,
  playersTunnel,
  ringStrip,
  sky,
  splitPath,
  tifoTexture,
  updateShared,
  windCloth,
  zoneRange,
} from './stadium';

/**
 * Stadio Comunale: an Italian city's municipal ground, built in concrete and travertine
 * in the thirties and grown since. One continuous two-tier bowl round the pitch, open to
 * the sky everywhere but the main stand.
 * - Behind the home goal, the Curva: two steep open tiers of ultras, the card display at
 *   kick-off, banners over the balcony. The away fans have the other curva.
 * - The far side is the Tribuna under a thin concrete canopy, cantilevered thirty metres
 *   off a row of raking fins that come down the back of the stand like buttresses; the
 *   underside is coffered, the club's name runs along its edge, the press box at the back.
 * - Behind the Tribuna rises the Torre: a slim tower with the crest high on its face and
 *   the club's flag on top, the landmark you see from across the city.
 * - Between the tiers, the concourse shows through a band of arches; outside, the bowl is
 *   an ochre arcade four storeys high, lit up at night.
 * - In the four corners, spiral ramp towers wind up to the top of the bowl, each carrying
 *   a floodlight mast; umbrella pines and cypresses all round, and a hill town on the
 *   horizon with its bell tower and dome.
 * The front walls and the lower tier match the big stadium's (the ball, the flares and the
 * crowd shots all work the same), and everything static bakes into a handful of draws.
 */

/** Cross-sections, as (offset back from the front edge, height). The lower tier is the big
 * stadium's (the flares stand on it). */
const LOWER: [number, number][] = [[0.4, 1.4], [20, 11.5]];
const UPPER: [number, number][] = [[21.5, 15.8], [38, 28.5]];
/** The bowl's outer wall (the arcade) and its top. */
const BACK = 40.5;
const RIM = 30;
/** The Tribuna's canopy: from the back of the stand out to its front edge. */
const EDGE = 10;
const canUnder = (o: number) => 31.8 + ((BACK - o) / (BACK - EDGE)) * 1.2;
const canTop = (o: number) => 33.4 + ((BACK - o) / (BACK - EDGE)) * 1.4;
/** Front of the stands (the big stadium's lines, which the ball bounces off). */
const BOWL_X = PITCH.halfL + 8.5;
const BOWL_Z = PITCH.halfW + 7.5;
/** Floodlight heads, on masts rising out of the spiral towers. */
const HEAD = 57;

const LOCAL_BOARDS: Board[] = [
  { bg: '#f3ecd8', fg: '#1f4e8c', text: 'CAFFÈ CENTRALE' },
  { bg: '#1f6b3a', fg: '#ffffff', text: 'PASTIFICIO ROSSI' },
  { bg: '#b8262c', fg: '#ffd447', text: 'BANCA DEL PORTO' },
  { bg: '#26282c', fg: '#f2ede1', text: 'GAMENIGHT' },
  { bg: '#ffd447', fg: '#1d1d1d', text: 'GELATERIA LUNA' },
  { bg: '#23345e', fg: '#f2ede1', text: 'MOTO VELOCE' },
  { bg: '#e9e1cc', fg: '#8a2f1d', text: 'VINI DEL COLLE' },
  { bg: '#0e7c86', fg: '#ffffff', text: 'ACQUA FONTE' },
];

/**
 * Arches: piers and round-headed openings `bay` m apart, in storeys `storey` m high, on a
 * strip's uv metres. Dark inside by day; at night the concourse lights show through most.
 */
function arcadeMaterial(color: number, bay: number, storey: number): THREE.MeshStandardMaterial {
  const f = (v: number) => v.toFixed(3);
  const r = bay * 0.3;
  const m = litMaterial({
    color,
    roughness: 0.92,
    fragDecl: 'float gArch;',
    diffuseHook: `{
      vec2 cell = floor(vUv2 / vec2(${f(bay)}, ${f(storey)}));
      vec2 c = (fract(vUv2 / vec2(${f(bay)}, ${f(storey)})) - vec2(0.5, 0.0)) * vec2(${f(bay)}, ${f(storey)});
      float spring = ${f(storey * 0.8 - r)};
      float open = step(${f(storey * 0.12)}, c.y) * max(step(abs(c.x), ${f(r)}) * step(c.y, spring), step(length(vec2(c.x, c.y - spring)), ${f(r)}));
      float lit = step(0.3, fract(sin(dot(cell, vec2(12.9, 78.2))) * 43758.5));
      float cornice = step(c.y, 0.3);
      float stone = 0.94 + 0.08 * fract(sin(dot(cell, vec2(3.1, 9.7))) * 917.3);
      gArch = open * lit;
      diffuseColor.rgb *= mix(stone * (1.0 + 0.14 * cornice), 0.14, open);
    }`,
  });
  m.side = THREE.DoubleSide;
  m.onBeforeCompile = ((orig) => (shader: Parameters<typeof orig>[0], rr: Parameters<typeof orig>[1]) => {
    orig(shader, rr);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.74, 0.45) * gArch * uFlood * 0.75;',
    );
  })(m.onBeforeCompile.bind(m));
  return m;
}

/** The canopy's underside: cast concrete coffers between the ribs, darker toward the back. */
function cofferMaterial(): THREE.MeshStandardMaterial {
  const m = litMaterial({
    color: 0xe6b98c,
    roughness: 0.9,
    emissive: 0x4a3524,
    diffuseHook: `{
      vec2 k = fract(vUv2 / vec2(3.2, 2.6));
      float rib = max(step(0.86, k.x), step(0.84, k.y));
      diffuseColor.rgb *= mix(0.84, 1.0, rib) * mix(0.88, 1.0, smoothstep(0.0, 14.0, vUv2.y));
    }`,
  });
  m.side = THREE.DoubleSide;
  return m;
}

/** A disc of travertine with the crest on it, for the Torre's face. */
function crestTexture(home: number, club: StadiumClub): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 256;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const hex = '#' + home.toString(16).padStart(6, '0');
  let crest: CanvasImageSource | null = null;
  const draw = () => {
    const g = cv.getContext('2d')!;
    g.fillStyle = '#e4dac4';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = hex;
    g.beginPath();
    g.arc(128, 128, 118, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#f3eee2';
    g.beginPath();
    g.arc(128, 128, 100, 0, Math.PI * 2);
    g.fill();
    if (crest) drawCrest(g, crest, 128, 128, 150);
    tex.needsUpdate = true;
  };
  draw();
  void club.crest?.then((img) => ((crest = img), draw()));
  return tex;
}

/** The club's flag on the Torre: its colour, a white band, the crest. */
function flagTexture(home: number, club: StadiumClub): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 160;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const hex = '#' + home.toString(16).padStart(6, '0');
  let crest: CanvasImageSource | null = null;
  const draw = () => {
    const g = cv.getContext('2d')!;
    g.fillStyle = hex;
    g.fillRect(0, 0, 256, 160);
    g.fillStyle = '#f3eee2';
    g.fillRect(0, 62, 256, 36);
    if (crest) drawCrest(g, crest, 128, 80, 120);
    tex.needsUpdate = true;
  };
  draw();
  void club.crest?.then((img) => ((crest = img), draw()));
  return tex;
}

export function createComunale(homeColor: number, awayColor: number, club: StadiumClub = {}): Stadium {
  const group = new THREE.Group();
  group.add(sky());
  group.add(...groundPlanes());

  const path = bowlPath();
  const { left, main, right } = splitPath(path);
  const ends = [left, right];

  const concrete = litMaterial({ color: 0xa9a294, roughness: 0.9 });
  concrete.side = THREE.DoubleSide;
  const section = litMaterial({ color: 0x77716a, roughness: 0.9 });
  section.side = THREE.DoubleSide;
  const travertine = litMaterial({ color: 0xd8ccb2, roughness: 0.85 });
  travertine.side = THREE.DoubleSide;
  const wall = wallMaterial(homeColor);
  wall.side = THREE.DoubleSide;
  const concourse = arcadeMaterial(0xd8ccb2, 3.6, 3);
  const facade = arcadeMaterial(0xc99362, 4.5, 7.5);
  const coffer = cofferMaterial();
  const fascia = fasciaMaterial(homeColor, club.name ?? 'GAMENIGHT');
  const glass = glassMaterial();
  const seat = new THREE.Color(homeColor).multiplyScalar(0.62).getHex();

  const homeU = zoneRange(path, LOWER[0][0], 1);
  const awayU = zoneRange(path, LOWER[0][0], 2);
  const lowerSlope = Math.hypot(LOWER[1][0] - LOWER[0][0], LOWER[1][1] - LOWER[0][1]);
  const lowerCrowd = crowdMaterial({
    home: homeColor,
    away: awayColor,
    shade: [99, 100],
    seat,
    aisles: [14, 1.1],
    voms: [28, 7.2, 10.2],
    tifo: { tex: tifoTexture(homeColor, club), rect: new THREE.Vector4(homeU[0] + 1, homeU[1] - 1, 0.6, lowerSlope - 0.4) },
    tifoB: { tex: awayTifoTexture(awayColor), rect: new THREE.Vector4(awayU[0] + 1, awayU[1] - 1, 0.6, lowerSlope - 0.4) },
  });
  // The curve's top tiers join in the card display with bands of colour all round.
  const curvaCrowd = crowdMaterial({ home: homeColor, away: awayColor, shade: [99, 100], stripes: true, seat, aisles: [14, 1.1] });
  const tribunaCrowd = crowdMaterial({ home: homeColor, away: awayColor, shade: [4, 16], seat, aisles: [14, 1.1], fill: 0.92 });

  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const add = (mat: THREE.Material, g: THREE.BufferGeometry) => byMat.set(mat, [...(byMat.get(mat) ?? []), g]);

  /** The bowl's section, front wall to arcade, along `pts`. */
  const bowl = (pts: PathPt[], upper: THREE.Material, emit: (mat: THREE.Material, g: THREE.BufferGeometry) => void) => {
    const s = (a: [number, number], b: [number, number], mat: THREE.Material) => emit(mat, ringStrip(pts, a, b));
    s([0, 0], [0, 1.4], wall);
    s([0, 1.4], LOWER[0], concrete);
    s(LOWER[0], LOWER[1], lowerCrowd);
    s(LOWER[1], [22, 11.5], concrete);
    s([22, 11.5], [22, 14.5], concourse);
    s([22, 14.5], [21, 14.5], travertine);
    s([21, 14.5], [21, 15.8], travertine); // the balcony, where the banners hang
    s([21, 15.8], UPPER[0], concrete);
    s(UPPER[0], UPPER[1], upper);
    s(UPPER[1], [38, RIM], travertine);
    s([38, RIM], [BACK, RIM], concrete);
    s([BACK, 0], [BACK, RIM], facade); // bottom up: the storeys start at the ground
  };
  for (const pts of ends) bowl(pts, curvaCrowd, add);
  bowl(main, tribunaCrowd, add);
  add(section, caps([path[0], path[path.length - 1]], [
    [0, 0], [0, 1.4], [0.4, 1.4], [20, 11.5], [22, 11.5], [22, 14.5], [21, 14.5], [21, 15.8], [21.5, 15.8], [38, 28.5], [38, RIM], [BACK, RIM], [BACK, 0],
  ]));

  // ---- the Tribuna's canopy: the press box at the back, a thin coffered slab out to the edge
  const strip = (pts: PathPt[], a: [number, number], b: [number, number], mat: THREE.Material) => add(mat, ringStrip(pts, a, b));
  strip(main, [BACK, RIM], [BACK, canUnder(BACK)], glass);
  strip(main, [BACK, canUnder(BACK)], [EDGE, canUnder(EDGE)], coffer);
  strip(main, [EDGE, canUnder(EDGE)], [EDGE, canTop(EDGE)], fascia); // bottom up, so the lettering stands upright
  strip(main, [EDGE, canTop(EDGE)], [BACK, canTop(BACK)], travertine);
  strip(main, [BACK, canTop(BACK)], [BACK, canUnder(BACK)], travertine);
  add(travertine, caps([main[0], main[main.length - 1]], [[BACK, canUnder(BACK)], [BACK, canTop(BACK)], [EDGE, canTop(EDGE)], [EDGE, canUnder(EDGE)]]));
  for (const [mat, geos] of byMat) group.add(new THREE.Mesh(geos.length > 1 ? mergeGeometries(geos)! : geos[0], mat));

  // ---- everything else static: one scene baked into a few batched draws
  const scenery = new THREE.Group();
  const put = (mat: THREE.Material, geo: THREE.BufferGeometry) => scenery.add(new THREE.Mesh(geo, mat));
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, ry = 0) =>
    new THREE.BoxGeometry(w, h, d).applyMatrix4(new THREE.Matrix4().makeRotationY(ry).setPosition(x, y + h / 2, z));
  const ochre = litMaterial({ color: 0xc99362, roughness: 0.92 });
  const stone = litMaterial({ color: 0xd8ccb2, roughness: 0.85 });
  const stoneTwo = litMaterial({ color: 0xd8ccb2, roughness: 0.85 });
  stoneTwo.side = THREE.DoubleSide;
  const steel = litMaterial({ color: 0x3e444c, roughness: 0.55, metalness: 0.3 });
  const terracotta = litMaterial({ color: 0xa4532f, roughness: 0.8 });
  // The canopy's fins: warmer, so they don't go cold in their own shade.
  const finStone = litMaterial({ color: 0xe8c29a, roughness: 0.85, emissive: 0x2e2216 });

  // The canopy's fins: a rib under the slab, deep at the back and thinning to nothing at
  // the edge, that carries on down the back of the stand to the ground like a buttress.
  // One profile, extruded across, every few metres.
  {
    const fin = new THREE.Shape([
      new THREE.Vector2(BACK, 0),
      new THREE.Vector2(BACK + 4.8, 0),
      new THREE.Vector2(BACK + 0.8, canTop(BACK)),
      new THREE.Vector2(EDGE + 0.6, canTop(EDGE) - 0.1),
      new THREE.Vector2(EDGE + 0.6, canUnder(EDGE) - 0.3),
      new THREE.Vector2(BACK - 2, canUnder(BACK - 2) - 2.1),
      new THREE.Vector2(BACK, canUnder(BACK) - 2.1),
    ]);
    const finGeo = new THREE.ExtrudeGeometry(fin, { depth: 0.7, bevelEnabled: false }).translate(0, 0, -0.35);
    const a = main[0];
    const b = main[main.length - 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.round(len / 6.4);
    // Section (offset, height, across) to world: offset along the outward normal.
    const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(a.nx, 0, a.nz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-a.nz, 0, a.nx));
    for (let i = 0; i <= n; i++) {
      const f = 0.01 + (0.98 * i) / n;
      put(finStone, finGeo.clone().applyMatrix4(basis.clone().setPosition(a.x + (b.x - a.x) * f, 0, a.z + (b.z - a.z) * f)));
    }
  }

  // The Torre behind the Tribuna: a slim shaft with pilasters and string courses, an open
  // belvedere at the top, the crest on its face and the flag above.
  const mid = main[Math.floor(main.length / 2)];
  const tower = at(mid, 54, 0);
  const TOWER_H = 64;
  const corners4 = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  put(ochre, box(6, TOWER_H, 6, tower.x, 0, tower.z));
  for (const [sx, sz] of corners4) put(stone, box(0.9, TOWER_H, 0.9, tower.x + sx * 3, 0, tower.z + sz * 3));
  for (let y = 10; y < TOWER_H; y += 10) put(stone, box(6.8, 0.6, 6.8, tower.x, y, tower.z));
  for (const [sx, sz] of corners4) put(stone, box(0.8, 5, 0.8, tower.x + sx * 3.1, TOWER_H, tower.z + sz * 3.1));
  put(stone, box(7.6, 0.9, 7.6, tower.x, TOWER_H + 5, tower.z));
  put(terracotta, new THREE.ConeGeometry(5.2, 3.6, 4).applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 4).setPosition(tower.x, TOWER_H + 7.5, tower.z)));
  put(steel, box(0.25, 11, 0.25, tower.x, TOWER_H + 9, tower.z));
  const crestMat = litMaterial({ roughness: 0.7 });
  crestMat.map = crestTexture(homeColor, club);
  const crestDisc = new THREE.Mesh(new THREE.CircleGeometry(2.4, 20), crestMat);
  crestDisc.position.set(tower.x - mid.nx * 3.06, 55, tower.z - mid.nz * 3.06);
  crestDisc.rotation.y = Math.atan2(-mid.nx, -mid.nz);
  crestDisc.userData.live = true;
  scenery.add(crestDisc);
  const flagMat = windCloth(litMaterial({ roughness: 0.8 }), 0.5, 'left', 7, 4.4);
  flagMat.map = flagTexture(homeColor, club);
  flagMat.side = THREE.DoubleSide;
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(7, 4.4, 10, 4), flagMat);
  flag.position.set(tower.x + 3.6, TOWER_H + 17.6, tower.z);
  flag.userData.live = true;
  scenery.add(flag);

  // ---- spiral ramp towers in the corners, the floodlight masts rising out of them
  const lamps = new THREE.InstancedMesh(new THREE.PlaneGeometry(9.6, 2.4), lampMaterial(), 4 * 2);
  const spots: THREE.Vector3[] = [];
  const q = new THREE.Quaternion();
  const corner = towerSpots();
  corner.forEach((c, k) => {
    const cx = c.x;
    const cz = c.z;
    put(ochre, new THREE.CylinderGeometry(3.2, 3.2, RIM + 1, 10).translate(cx, (RIM + 1) / 2, cz));
    put(stone, new THREE.CylinderGeometry(3.8, 3.8, 0.7, 10).translate(cx, RIM + 1.35, cz));
    put(stoneTwo, helix(cx, cz, 3.2, 7, RIM, 3.5, Math.atan2(-cz, -cx)));
    // The mast: a tapering concrete shaft from the tower's top to the lamp head.
    for (let y = RIM + 1.7, i = 0; y < HEAD - 2; y += 6, i++) {
      const w = 2.4 - i * 0.22;
      put(stone, box(w, Math.min(6, HEAD - 2 - y), w, cx, y, cz));
    }
    const yaw = Math.atan2(-cx, -cz);
    const e = new THREE.Euler(0.45, yaw, 0, 'YXZ');
    const fwd = new THREE.Vector3(0, 0, 1).applyEuler(e);
    const up = new THREE.Vector3(0, 1, 0).applyEuler(e);
    const c0 = new THREE.Vector3(cx, HEAD + 1.5, cz);
    for (let r = 0; r < 2; r++) {
      const pos = c0.clone().addScaledVector(up, (r - 0.5) * 2.6).addScaledVector(fwd, 0.25);
      lamps.setMatrixAt(k * 2 + r, new THREE.Matrix4().compose(pos, q.setFromEuler(e), new THREE.Vector3(1, 1, 1)));
    }
    const frame = new THREE.BoxGeometry(10.4, 5.8, 0.35).applyMatrix4(new THREE.Matrix4().compose(c0.clone().addScaledVector(fwd, -0.2), q.setFromEuler(e), new THREE.Vector3(1, 1, 1)));
    put(steel, frame);
    spots.push(c0.clone().addScaledVector(fwd, 1.5));
  });
  lamps.instanceMatrix.needsUpdate = true;
  group.add(lamps);

  // ---- umbrella pines and cypresses round the ground, hills and a town on the horizon
  {
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const bark = litMaterial({ color: 0x5a4636, roughness: 1 });
    const pineLeaf = litMaterial({ color: 0x3f5a32, roughness: 1 });
    const cypressLeaf = litMaterial({ color: 0x2c4429, roughness: 1 });
    const clear = (x: number, z: number) => corner.every((c) => Math.hypot(x - c.x, z - c.z) > 13) && Math.hypot(x - tower.x, z - tower.z) > 10;
    const pine = (x: number, z: number, s: number) => {
      const lean = (rnd() - 0.5) * 0.25;
      put(bark, new THREE.CylinderGeometry(0.28 * s, 0.4 * s, 8 * s, 5).applyMatrix4(new THREE.Matrix4().makeRotationZ(lean).setPosition(x - lean * 4 * s, 4 * s, z)));
      const top = new THREE.Vector3(x - lean * 8 * s, 8 * s, z);
      put(pineLeaf, new THREE.IcosahedronGeometry(4.6 * s, 1).scale(1, 0.34, 1).translate(top.x, top.y + 0.6 * s, top.z));
      put(pineLeaf, new THREE.IcosahedronGeometry(3 * s, 1).scale(1, 0.4, 1).translate(top.x + 2 * s * (rnd() - 0.5), top.y + 1.6 * s, top.z + 2 * s * (rnd() - 0.5)));
    };
    const cypress = (x: number, z: number, s: number) =>
      put(cypressLeaf, new THREE.IcosahedronGeometry(1, 1).scale(1.5 * s, 6.5 * s, 1.5 * s).translate(x, 6 * s, z));
    // A ring round the outside of the bowl: pines in loose groups, cypresses in short rows.
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2 + rnd() * 0.05;
      const rr = 1 + rnd() * 0.25;
      const x = Math.cos(a) * 126 * rr;
      const z = Math.sin(a) * 108 * rr;
      if (!clear(x, z)) continue;
      if (i % 4 === 3) {
        const tx = -Math.sin(a);
        const tz = Math.cos(a);
        for (let j = -1; j <= 1; j++) cypress(x + tx * j * 4, z + tz * j * 4, 0.9 + rnd() * 0.3);
      } else {
        pine(x, z, 0.9 + rnd() * 0.45);
        if (rnd() < 0.5) pine(x + (rnd() - 0.5) * 14, z + (rnd() - 0.5) * 14, 0.75 + rnd() * 0.3);
      }
    }
    // Low hills on the horizon.
    const hill = litMaterial({ color: 0x6b7448, roughness: 1 });
    const hillDark = litMaterial({ color: 0x58633d, roughness: 1 });
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + 0.4;
      const r = 70 + rnd() * 50;
      const d = 300 + rnd() * 60;
      put(i % 2 ? hill : hillDark, new THREE.SphereGeometry(r, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.32 + rnd() * 0.12, 1).translate(Math.cos(a) * d, -1, Math.sin(a) * d));
    }
    // The town on its hill: houses round the crown, the bell tower and the dome.
    const [hx, hz, hr, hh] = [215, -205, 85, 26];
    put(hill, new THREE.SphereGeometry(hr, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, hh / hr, 1).translate(hx, -1, hz));
    const walls = [litMaterial({ color: 0xe2cfa6, roughness: 0.9 }), litMaterial({ color: 0xd29a5a, roughness: 0.9 }), litMaterial({ color: 0xc98a72, roughness: 0.9 })];
    const groundAt = (x: number, z: number) => hh * Math.sqrt(Math.max(0, 1 - ((x - hx) ** 2 + (z - hz) ** 2) / (hr * hr))) - 2;
    for (let i = 0; i < 34; i++) {
      const a = rnd() * Math.PI * 2;
      const d = 6 + Math.sqrt(rnd()) * 40;
      const x = hx + Math.cos(a) * d;
      const z = hz + Math.sin(a) * d;
      const w = 6 + rnd() * 6;
      const dp = 6 + rnd() * 4;
      const h = 6 + rnd() * 8;
      const ry = Math.round(rnd() * 2) * (Math.PI / 4);
      const y = groundAt(x, z);
      put(walls[i % 3], box(w, h + 2, dp, x, y, z, ry));
      put(terracotta, new THREE.ConeGeometry(Math.hypot(w, dp) / 2, 2.4, 4).applyMatrix4(new THREE.Matrix4().makeRotationY(ry + Math.PI / 4).setPosition(x, y + h + 3.2, z)));
    }
    const ty = groundAt(hx, hz);
    put(walls[0], box(5, 34, 5, hx + 8, ty, hz - 4));
    put(terracotta, new THREE.ConeGeometry(3.8, 6, 4).applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 4).setPosition(hx + 8, ty + 37, hz - 4)));
    put(walls[0], new THREE.CylinderGeometry(7, 7, 6, 12).translate(hx - 8, ty + 12, hz + 2));
    put(walls[2], box(14, 9, 22, hx - 8, ty, hz + 2));
    put(terracotta, new THREE.SphereGeometry(7, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(hx - 8, ty + 15, hz + 2));
  }

  scenery.add(playersTunnel(section));
  group.add(bakeStatic(scenery));

  const glows = lampGlows(spots, 1.3);
  const banks = floodLamps(spots);
  group.add(glows.mesh);
  // Beams from the far masts only: the near ones would wash over the broadcast picture.
  const shafts = lightShafts(spots.filter((s) => s.z < 0));
  group.add(shafts);

  // ---- the near side: a low paddock in play, the bowl closed for the over-the-shoulder shots
  const near: PathPt[] = [];
  const nearX = BOWL_X - 10 - 8;
  for (let x = -nearX; x <= nearX + 0.01; x += 4) near.push({ x, z: BOWL_Z, nx: 0, nz: 1, zone: 0 });
  const paddockCrowd = crowdMaterial({ home: homeColor, away: awayColor, shade: [99, 100], seat, aisles: [14, 1.1], fill: 0.85 });
  const paddockGroup = new THREE.Group();
  for (const [mat, geos] of new Map<THREE.Material, THREE.BufferGeometry[]>([
    [wall, [ringStrip(near, [0, 0], [0, 1.4])]],
    [concrete, [ringStrip(near, [0, 1.4], [0.4, 1.4]), ringStrip(near, [11, 6.9], [12, 6.9]), caps([near[0], near[near.length - 1]], [[0, 0], [0, 1.4], [0.4, 1.4], [11, 6.9], [12, 6.9], [12, 0]])]],
    [paddockCrowd, [ringStrip(near, [0.4, 1.4], [11, 6.9])]],
  ])) paddockGroup.add(new THREE.Mesh(mergeGeometries(geos)!, mat));
  group.add(paddockGroup);

  const nearStand = new THREE.Group();
  nearStand.visible = false;
  nearStand.userData.castsHidden = true; // its shadow falls on the pitch either way
  {
    const nb = new Map<THREE.Material, THREE.BufferGeometry[]>();
    bowl(nearPath(), curvaCrowd, (mat, g) => nb.set(mat, [...(nb.get(mat) ?? []), g]));
    for (const [mat, geos] of nb) nearStand.add(new THREE.Mesh(mergeGeometries(geos)!, mat));
  }
  group.add(nearStand);

  group.add(adBoards(LOCAL_BOARDS));
  group.add(crowdFlags(path, homeColor, awayColor, club));
  group.add(banners(path, homeColor, awayColor, club));
  group.add(bakeStatic(pitchside(homeColor, awayColor)));
  const fan = fanBanners(path, homeColor);
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
    },
  };
}

/**
 * Where the four spiral towers stand: out past each corner of the bowl, on the diagonal
 * through the corner's quadrant, just clear of the arcade.
 */
function towerSpots(): THREE.Vector3[] {
  // The centre of the bowl's corner quadrants (radius 10), mirrored to all four.
  const cx = BOWL_X - 10;
  const cz = BOWL_Z - 10;
  const d = 10 + BACK + 7.5; // the quadrant, out to the arcade, plus the ramp
  return [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => new THREE.Vector3(sx * (cx + d * Math.SQRT1_2), 0, sz * (cz + d * Math.SQRT1_2)));
}

/** A spiral ramp: the deck winding up between radii r0 and r1, and its outer parapet. */
function helix(cx: number, cz: number, r0: number, r1: number, h: number, turns: number, phase: number): THREE.BufferGeometry {
  const n = Math.ceil(turns * 20);
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = phase + t * turns * Math.PI * 2;
    const y = t * h;
    const c = Math.cos(a);
    const s = Math.sin(a);
    // Deck inner, deck outer, parapet top.
    pos.push(cx + c * r0, y, cz + s * r0, cx + c * r1, y, cz + s * r1, cx + c * r1, y + 1.2, cz + s * r1);
    if (i < n) {
      const k = i * 3;
      idx.push(k, k + 3, k + 4, k, k + 4, k + 1, k + 1, k + 4, k + 5, k + 1, k + 5, k + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  const flat = geo.toNonIndexed();
  flat.computeVertexNormals();
  return flat;
}
