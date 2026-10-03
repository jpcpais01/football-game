import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PITCH } from '../sim/constants';
import { PYLONS, floodLamps, litMaterial } from './look';
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
  roofMaterial,
  sky,
  tifoTexture,
  updateShared,
  zoneRange,
} from './stadium';

/**
 * The old ground: a second-division club's home, squeezed in between the terraced streets.
 * Four separate stands with the corners left open, and in each corner a lattice floodlight
 * pylon with its bank of lamps - the lights you can see from across town.
 * - The far side is the old main stand: one tier of seats under a roof on pillars, the
 *   directors' lounge windows along the back, and a painted gable in the middle with the
 *   crest and the year the club was founded.
 * - Behind the home goal, the Shed: a covered standing terrace under a barrel roof, clad
 *   in the club's colours, crush barriers down the steps, packed and bouncing.
 * - The away end is an open terrace behind a cage, a few hundred who made the trip, and the
 *   old clock on its posts at the back.
 * - Over the roofs: rows of terraced houses with their windows lighting up as it gets
 *   dark, chimneys, trees, and a church spire.
 * The front walls stand where the big stadium's do, so the ball, the flares and the
 * camera's crowd shots all work the same here.
 */

/** Front of the stands (the same lines as the big stadium's, which the ball bounces off). */
const FX = PITCH.halfL + 8.5;
const FZ = PITCH.halfW + 7.5;
/** Rake of the steps: the same as the big stadium's lower tier (flares and flags sit on it). */
const RAKE = 10.1 / 19.6;
/** Height of the steps at offset o back from the front wall. */
const tier = (o: number) => 1.4 + (o - 0.4) * RAKE;

/** One straight stand's front edge, centred on (cx, cz), facing the pitch, `half` m each way. */
function standPath(cx: number, cz: number, nx: number, nz: number, half: number, zone: number): PathPt[] {
  // Running the way the crowd shader expects (its "along" axis).
  const dx = -nz;
  const dz = nx;
  const n = Math.ceil((2 * half) / 4);
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = -half + (2 * half * i) / n;
    return { x: cx + dx * t, z: cz + dz * t, nx, nz, zone };
  });
}

const LOCAL_BOARDS: Board[] = [
  { bg: '#f1ebdc', fg: '#b3262c', text: "DAVE'S MOTORS" },
  { bg: '#1d5c3a', fg: '#ffd447', text: 'THE RED LION' },
  { bg: '#c8393b', fg: '#ffffff', text: 'KEBAB KING' },
  { bg: '#26282c', fg: '#f2ede1', text: 'GAMENIGHT' },
  { bg: '#ffd447', fg: '#1d1d1d', text: 'CITY TAXIS' },
  { bg: '#23345e', fg: '#f2ede1', text: 'PLUMB-RITE' },
  { bg: '#e9e1cc', fg: '#23345e', text: 'FISH & CHIPS' },
  { bg: '#6b2737', fg: '#f2ede1', text: 'W. HOLT & SON' },
];

/** Front walls: painted in the club colour with a white top band, panel joints every 2 m. */
function wallMaterial(home: number): THREE.MeshStandardMaterial {
  return litMaterial({
    roughness: 0.8,
    uniforms: { uClub: { value: new THREE.Color(home) } },
    fragDecl: 'uniform vec3 uClub;',
    diffuseHook: `{
      vec3 paint = mix(uClub * 0.8, vec3(0.92, 0.91, 0.87), step(1.05, vUv2.y));
      diffuseColor.rgb = paint * (1.0 - 0.18 * step(0.96, fract(vUv2.x / 2.0)));
    }`,
  });
}

/** Old brick (the stands' backs and ends): courses, a little soot, uneven firing. */
function brickMaterial(): THREE.MeshStandardMaterial {
  const m = litMaterial({
    color: 0x8c4f3c,
    roughness: 0.92,
    diffuseHook: `{
      vec2 b = vec2(vUv2.x / 0.9, vUv2.y / 0.32);
      b.x += 0.5 * step(0.5, fract(b.y * 0.5));
      float mortar = max(step(0.9, fract(b.y)), step(0.94, fract(b.x)));
      float fire = fract(sin(dot(floor(b), vec2(12.9, 78.2))) * 43758.5);
      diffuseColor.rgb *= mix(0.86 + 0.2 * fire, 1.35, mortar) * (1.0 - 0.25 * smoothstep(3.0, 0.0, vUv2.y));
    }`,
  });
  m.side = THREE.DoubleSide;
  return m;
}

/**
 * Terraced houses: brick fronts by day, a scatter of warm windows by night. Geometry is in
 * world space with world normals, so the windows are laid out along whichever way a wall faces.
 */
function houseMaterial(): THREE.MeshStandardMaterial {
  const m = litMaterial({
    color: 0xffffff,
    roughness: 0.9,
    vertDecl: 'varying vec3 vWN;',
    vertBody: 'vWN = normal;',
    fragDecl: 'varying vec3 vWN; float gWin;',
    diffuseHook: `{
      float s = abs(vWN.x) > 0.5 ? vWorldPos.z : vWorldPos.x;
      float y = vWorldPos.y;
      float house = floor(s / 5.0);
      float hh = fract(sin(house * 91.7 + floor(vWorldPos.x * 0.01 + vWorldPos.z * 0.013) * 7.3) * 4375.5);
      // Most fronts are brick; a few are painted or pebble-dashed.
      vec3 wall = hh < 0.62 ? mix(vec3(0.55, 0.3, 0.22), vec3(0.42, 0.24, 0.2), fract(hh * 7.0))
        : hh < 0.82 ? vec3(0.82, 0.78, 0.68) : vec3(0.62, 0.6, 0.55);
      vec2 w = vec2(fract(s / 2.5), fract(y / 3.0));
      float win = step(abs(w.x - 0.5), 0.2) * step(0.32, w.y) * step(w.y, 0.8) * step(y, 6.0) * step(abs(vWN.y), 0.5);
      float on = step(0.55, fract(sin(dot(vec2(floor(s / 2.5), floor(y / 3.0)), vec2(12.9, 78.2))) * 43758.5));
      gWin = win * on;
      diffuseColor.rgb = mix(wall, mix(vec3(0.1, 0.11, 0.13), vec3(1.0, 0.8, 0.5), on * uFlood), win);
    }`,
  });
  m.onBeforeCompile = ((orig) => (shader: Parameters<typeof orig>[0], r: Parameters<typeof orig>[1]) => {
    orig(shader, r);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.72, 0.4) * gWin * uFlood * 0.9;',
    );
  })(m.onBeforeCompile.bind(m));
  return m;
}

/** The Shed's gable end and the main stand's gable: crest, and the year the club began. */
function gableTexture(home: number, club: StadiumClub): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 160;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const hex = '#' + home.toString(16).padStart(6, '0');
  let crest: CanvasImageSource | null = null;
  const draw = () => {
    const g = cv.getContext('2d')!;
    g.fillStyle = '#efe8d6';
    g.fillRect(0, 0, 512, 160);
    // Trim along the two sloping edges and the base, in the club colour.
    g.strokeStyle = hex;
    g.lineWidth = 14;
    g.beginPath();
    g.moveTo(0, 160);
    g.lineTo(256, 0);
    g.lineTo(512, 160);
    g.closePath();
    g.stroke();
    g.lineWidth = 3;
    g.strokeStyle = '#14123a';
    g.beginPath();
    g.moveTo(40, 146);
    g.lineTo(256, 16);
    g.lineTo(472, 146);
    g.stroke();
    if (crest) drawCrest(g, crest, 256, 82, 74);
    g.fillStyle = '#14123a';
    g.font = '800 26px "Barlow Condensed", "Arial Narrow", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const year = club.founded?.trim();
    g.fillText(year ? `EST. ${year}` : 'FOOTBALL CLUB', 256, 136, 220);
    tex.needsUpdate = true;
  };
  draw();
  void document.fonts?.ready.then(draw);
  void club.crest?.then((img) => ((crest = img), draw()));
  return tex;
}

/** The old clock at the back of the away end, with the club's name under it. */
function clockTexture(club: StadiumClub): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 192;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const draw = () => {
    const g = cv.getContext('2d')!;
    g.fillStyle = '#0f1a14';
    g.fillRect(0, 0, 512, 192);
    g.strokeStyle = '#e9e2cf';
    g.lineWidth = 6;
    g.strokeRect(6, 6, 500, 180);
    // Clock face, quarter to eight: kick-off time.
    g.fillStyle = '#f3eee2';
    g.beginPath();
    g.arc(96, 96, 70, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#14123a';
    g.lineWidth = 4;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      g.beginPath();
      g.moveTo(96 + Math.sin(a) * 56, 96 - Math.cos(a) * 56);
      g.lineTo(96 + Math.sin(a) * 64, 96 - Math.cos(a) * 64);
      g.stroke();
    }
    const hand = (a: number, r: number, w: number) => {
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(96, 96);
      g.lineTo(96 + Math.sin(a) * r, 96 - Math.cos(a) * r);
      g.stroke();
    };
    hand(((7.75 / 12) * Math.PI * 2), 36, 7);
    hand(((45 / 60) * Math.PI * 2), 54, 5);
    g.fillStyle = '#ffd447';
    g.font = '800 54px "Barlow Condensed", "Arial Narrow", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText((club.name ?? 'GAMENIGHT').toUpperCase(), 340, 78, 300);
    g.fillStyle = '#e9e2cf';
    g.font = '700 30px "Barlow Condensed", "Arial Narrow", sans-serif';
    g.fillText('WELCOME TO THE OLD GROUND', 340, 136, 300);
    tex.needsUpdate = true;
  };
  draw();
  void document.fonts?.ready.then(draw);
  return tex;
}

/** Rows of terraced houses, the trees between them and the church: the town round the ground. */
function town(): THREE.Group {
  const g = new THREE.Group();
  const walls: THREE.BufferGeometry[] = [];
  const roofs: THREE.BufferGeometry[] = [];
  const stone: THREE.BufferGeometry[] = [];
  const leaves: THREE.BufferGeometry[] = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, ry = 0) =>
    new THREE.BoxGeometry(w, h, d).applyMatrix4(new THREE.Matrix4().makeRotationY(ry).setPosition(x, y + h / 2, z));
  // A pitched roof over a w x d block (ridge along w).
  const roof = (w: number, d: number, rise: number, x: number, y: number, z: number, ry: number) => {
    const sh = new THREE.Shape([new THREE.Vector2(-d / 2 - 0.3, 0), new THREE.Vector2(d / 2 + 0.3, 0), new THREE.Vector2(0, rise)]);
    const geo = new THREE.ExtrudeGeometry(sh, { depth: w, bevelEnabled: false });
    geo.translate(0, 0, -w / 2);
    geo.rotateY(Math.PI / 2);
    return geo.applyMatrix4(new THREE.Matrix4().makeRotationY(ry).setPosition(x, y, z));
  };
  /** A street of houses along a line, broken by side roads; `ry` turns it to face the ground. */
  const street = (len: number, along: (t: number) => [number, number], ry: number) => {
    let t = -len / 2;
    while (t < len / 2) {
      const blockLen = Math.min(len / 2 - t, 18 + Math.floor(rnd() * 5) * 5);
      if (blockLen < 8) break;
      const [x, z] = along(t + blockLen / 2);
      const tall = rnd() < 0.2 ? 8.6 : 6.2;
      walls.push(box(blockLen, tall, 8, x, 0, z, ry));
      roofs.push(roof(blockLen, 8, 3, x, tall, z, ry));
      // Chimney stacks along the ridge, one per pair of houses.
      for (let c = -blockLen / 2 + 5; c < blockLen / 2 - 1; c += 10) {
        const dx = Math.cos(ry) * c;
        const dz = -Math.sin(ry) * c;
        walls.push(box(0.9, 2.2, 1.6, x + dx, tall + 1.6, z + dz, ry));
      }
      t += blockLen + 7 + rnd() * 5;
    }
  };
  street(170, (t) => [FX + 32, t], Math.PI / 2);
  street(190, (t) => [t, -FZ - 34], 0);
  street(170, (t) => [-FX - 36, t], Math.PI / 2);
  // Trees in the open corners and between the streets.
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    for (let i = 0; i < 5; i++) {
      const x = sx * (72 + rnd() * 12);
      const z = sz * (50 + rnd() * 14);
      const r = 2.6 + rnd() * 2;
      stone.push(box(0.5, 3, 0.5, x, 0, z));
      leaves.push(new THREE.IcosahedronGeometry(r, 1).applyMatrix4(new THREE.Matrix4().makeTranslation(x, 3 + r * 0.8, z)));
    }
  }
  // The church: a stone tower and its spire, over the roofs behind the main stand.
  stone.push(box(7, 22, 7, -38, 0, -112));
  stone.push(box(14, 9, 24, -38, 0, -96));
  roofs.push(roof(24, 14, 5, -38, 9, -96, Math.PI / 2));
  const spire = new THREE.ConeGeometry(5, 18, 4).applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 4).setPosition(-38, 31, -112));
  roofs.push(spire);

  const flat = (list: THREE.BufferGeometry[]) =>
    mergeGeometries(
      list.map((x) => {
        const n = x.index ? x.toNonIndexed() : x;
        for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') n.deleteAttribute(k);
        return n;
      }),
    )!;
  g.add(new THREE.Mesh(flat(walls), houseMaterial()));
  g.add(new THREE.Mesh(flat(roofs), litMaterial({ color: 0x3a3e47, roughness: 0.7 })));
  g.add(new THREE.Mesh(flat(stone), litMaterial({ color: 0x8f897a, roughness: 0.95 })));
  g.add(new THREE.Mesh(flat(leaves), litMaterial({ color: 0x3b5230, roughness: 1 })));
  return g;
}

export function createOldGround(homeColor: number, awayColor: number, club: StadiumClub = {}): Stadium {
  const group = new THREE.Group();
  group.add(sky());
  group.add(...groundPlanes());

  const main = standPath(0, -FZ, 0, -1, 42, 0);
  const shed = standPath(-FX, 0, -1, 0, 30, 1);
  const away = standPath(FX, 0, 1, 0, 26, 2);
  const near = standPath(0, FZ, 0, 1, 36, 0);
  const all = [...main, ...shed, ...away];

  const concrete = litMaterial({ color: 0x8b8f96, roughness: 0.9 });
  concrete.side = THREE.DoubleSide;
  const darkConcrete = litMaterial({ color: 0x5c6068, roughness: 0.9 });
  darkConcrete.side = THREE.DoubleSide;
  const wall = wallMaterial(homeColor);
  wall.side = THREE.DoubleSide;
  const brick = brickMaterial();
  const roofMat = roofMaterial(0x3a4048);
  // The Shed is clad in the club's colours.
  const cladding = roofMaterial(new THREE.Color(homeColor).multiplyScalar(0.7).getHex());
  const fascia = fasciaMaterial(homeColor, club.name ?? 'GAMENIGHT');
  const glass = glassMaterial();
  const seat = new THREE.Color(homeColor).multiplyScalar(0.62).getHex();
  const steel = litMaterial({ color: 0x4a5058, roughness: 0.55, metalness: 0.3 });

  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const add = (mat: THREE.Material, g: THREE.BufferGeometry) => byMat.set(mat, [...(byMat.get(mat) ?? []), g]);
  const strip = (pts: PathPt[], a: [number, number], b: [number, number], mat: THREE.Material) => add(mat, ringStrip(pts, a, b));

  // Steel: pillars, crush barriers, the away cage, the floodlight pylons (one instanced draw).
  const beams: THREE.Matrix4[] = [];
  const zAxis = new THREE.Vector3(0, 0, 1);
  const q = new THREE.Quaternion();
  const beam = (a: THREE.Vector3, b: THREE.Vector3, w: number, h = w) => {
    const len = a.distanceTo(b);
    if (len < 0.05) return;
    q.setFromUnitVectors(zAxis, b.clone().sub(a).normalize());
    beams.push(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(w, h, len)));
  };
  const pillars = (pts: PathPt[], o: number, top: number, every: number) => {
    const ends = [pts[0], pts[pts.length - 1]];
    const len = Math.hypot(ends[1].x - ends[0].x, ends[1].z - ends[0].z);
    const n = Math.round(len / every);
    for (let i = 1; i < n; i++) {
      const f = i / n;
      const p = { ...ends[0], x: ends[0].x + (ends[1].x - ends[0].x) * f, z: ends[0].z + (ends[1].z - ends[0].z) * f };
      beam(at(p, o, tier(o)), at(p, o, top), 0.32);
    }
  };
  /** Crush barriers: waist-high rails in short runs down the terrace, each on two posts. */
  const barriers = (pts: PathPt[], rows: number[]) => {
    const a = pts[0];
    const b = pts[pts.length - 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    rows.forEach((o, r) => {
      for (let s = 1.5 + (r % 2) * 2.5; s + 3.5 < len - 1; s += 5) {
        const p0 = { ...a, x: a.x + ((b.x - a.x) * s) / len, z: a.z + ((b.z - a.z) * s) / len };
        const p1 = { ...a, x: a.x + ((b.x - a.x) * (s + 3.5)) / len, z: a.z + ((b.z - a.z) * (s + 3.5)) / len };
        const h = tier(o);
        beam(at(p0, o, h + 1.05), at(p1, o, h + 1.05), 0.09);
        beam(at(p0, o, h), at(p0, o, h + 1.05), 0.08);
        beam(at(p1, o, h), at(p1, o, h + 1.05), 0.08);
      }
    });
  };

  // ---- the main stand: one tier of seats under a roof on pillars
  const mainCrowd = crowdMaterial({ home: homeColor, away: awayColor, shade: [-2, 6], seat, aisles: [12, 1], fill: 0.72 });
  strip(main, [0, 0], [0, 1.4], wall);
  strip(main, [0, 1.4], [0.4, 1.4], concrete);
  strip(main, [0.4, 1.4], [15, tier(15)], mainCrowd);
  strip(main, [15, tier(15)], [16.5, tier(15)], concrete);
  strip(main, [16.5, tier(15)], [16.5, 10.2], darkConcrete);
  strip(main, [16.5, 10.2], [16.5, 12.6], glass); // the directors' lounge
  strip(main, [16.5, 12.6], [16.5, 15.8], darkConcrete);
  strip(main, [16.5, 15.8], [17, 15.8], concrete);
  strip(main, [17, 15.8], [1.2, 13.2], roofMat);
  strip(main, [1.2, 11], [1.2, 13.2], fascia);
  strip(main, [17, 0], [17, 15.8], brick);
  add(brick, caps([main[0], main[main.length - 1]], [[0, 0], [0, 1.4], [0.4, 1.4], [1.2, tier(1.2)], [1.2, 13.2], [17, 15.8], [17, 0]]));
  pillars(main, 1.2, 11, 12);

  // ---- the Shed: covered standing terrace behind the home goal, under a barrel roof
  const shedSlope = Math.hypot(18 - 0.4, tier(18) - 1.4);
  const homeU = zoneRange(shed, 0.4, 1);
  const shedCrowd = crowdMaterial({
    home: homeColor,
    away: awayColor,
    shade: [-1, 9],
    seat,
    tifo: { tex: tifoTexture(homeColor, club), rect: new THREE.Vector4(homeU[0] + 1, homeU[1] - 1, 0.6, shedSlope - 0.4) },
  });
  strip(shed, [0, 0], [0, 1.4], wall);
  strip(shed, [0, 1.4], [0.4, 1.4], concrete);
  strip(shed, [0.4, 1.4], [18, tier(18)], shedCrowd);
  strip(shed, [18, tier(18)], [19, tier(18)], concrete);
  strip(shed, [19, tier(18)], [19, 14.8], darkConcrete);
  // The barrel roof, from the back wall arching over to the front.
  const arc: [number, number][] = Array.from({ length: 9 }, (_, i) => {
    const t = i / 8;
    return [19.5 + (3 - 19.5) * t, 14.8 + (12.6 - 14.8) * t + 2.6 * Math.sin(Math.PI * t)];
  });
  for (let i = 0; i < arc.length - 1; i++) strip(shed, arc[i], arc[i + 1], roofMat);
  strip(shed, [19, 14.8], [19.5, 14.8], concrete);
  strip(shed, [3, 10.4], [3, 12.6], fascia);
  strip(shed, [19.5, 0], [19.5, 14.8], cladding);
  add(cladding, caps([shed[0], shed[shed.length - 1]], [[0, 0], [0, 1.4], [0.4, 1.4], [3, tier(3)], ...arc.slice().reverse(), [19.5, 0]]));
  pillars(shed, 3, 10.4, 10);
  barriers(shed, [3.6, 7.2, 10.8, 14.4]);

  // ---- the away end: an open terrace behind a cage, the clock at the back
  const awaySlope = Math.hypot(17 - 0.4, tier(17) - 1.4);
  const awayU = zoneRange(away, 0.4, 2);
  const awayCrowd = crowdMaterial({
    home: homeColor,
    away: awayColor,
    shade: [99, 100],
    seat,
    fill: 0.35,
    tifoB: { tex: awayTifoTexture(awayColor), rect: new THREE.Vector4(awayU[0] + 6, awayU[1] - 6, 0.6, awaySlope * 0.55) },
  });
  strip(away, [0, 0], [0, 1.4], wall);
  strip(away, [0, 1.4], [0.4, 1.4], concrete);
  strip(away, [0.4, 1.4], [17, tier(17)], awayCrowd);
  strip(away, [17, tier(17)], [17.8, tier(17)], concrete);
  strip(away, [17.8, tier(17)], [17.8, tier(17) + 1.2], concrete);
  strip(away, [17.8, tier(17) + 1.2], [18.2, tier(17) + 1.2], concrete);
  strip(away, [18.2, 0], [18.2, tier(17) + 1.2], brick);
  add(concrete, caps([away[0], away[away.length - 1]], [[0, 0], [0, 1.4], [0.4, 1.4], [17, tier(17)], [17.8, tier(17)], [17.8, tier(17) + 1.2], [18.2, tier(17) + 1.2], [18.2, 0]]));
  barriers(away, [4, 8, 12]);
  // The cage: posts and a top rail along the front wall, mesh between them.
  {
    const a = away[0];
    const b = away[away.length - 1];
    for (let i = 0; i <= 17; i++) {
      const f = i / 17;
      const p = { ...a, x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
      beam(at(p, 0.15, 1.4), at(p, 0.15, 4.4), 0.1);
    }
    beam(at(a, 0.15, 4.4), at(b, 0.15, 4.4), 0.1);
  }
  const mesh = new THREE.MeshStandardMaterial({ color: 0xa4aab2, roughness: 0.6, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false });
  const cage = new THREE.Mesh(ringStrip(away, [0.15, 1.4], [0.15, 4.4]), mesh);
  group.add(cage);

  for (const [mat, geos] of byMat) group.add(new THREE.Mesh(geos.length > 1 ? mergeGeometries(geos)! : geos[0], mat));

  // ---- fixtures: the main stand's gable, the clock
  const fixtures = new THREE.Group();
  const mid = main[Math.floor(main.length / 2)];
  const gableGeo = new THREE.BufferGeometry();
  gableGeo.setAttribute('position', new THREE.Float32BufferAttribute([-8, 0, 0, 8, 0, 0, 0, 5, 0], 3));
  gableGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
  gableGeo.computeVertexNormals();
  const gableMat = litMaterial({ roughness: 0.7 });
  gableMat.map = gableTexture(homeColor, club);
  gableMat.side = THREE.DoubleSide;
  const gable = new THREE.Mesh(gableGeo, gableMat);
  gable.position.copy(at(mid, 1.1, 13.2));
  gable.rotation.y = Math.atan2(-mid.nx, -mid.nz);
  gable.userData.live = true;
  fixtures.add(gable);
  // The gable's roof behind it: a short pitched ridge back to the main roof.
  const ridge = new THREE.Mesh(
    new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(-8, 0), new THREE.Vector2(8, 0), new THREE.Vector2(0, 5)]), { depth: 6, bevelEnabled: false }),
    roofMat,
  );
  ridge.position.copy(at(mid, 7.2, 13.2));
  ridge.rotation.y = Math.atan2(-mid.nx, -mid.nz);
  fixtures.add(ridge);
  const awayMid = away[Math.floor(away.length / 2)];
  const clock = new THREE.Mesh(new THREE.PlaneGeometry(12, 4.5), new THREE.MeshBasicMaterial({ map: clockTexture(club), side: THREE.DoubleSide }));
  clock.position.copy(at(awayMid, 18, tier(17) + 4.4));
  clock.rotation.y = Math.atan2(-awayMid.nx, -awayMid.nz);
  clock.userData.live = true;
  fixtures.add(clock);
  for (const s of [-4.5, 4.5]) beam(at({ ...awayMid, z: awayMid.z + s }, 18, tier(17) + 1.2), at({ ...awayMid, z: awayMid.z + s }, 18, tier(17) + 2.2), 0.3);
  fixtures.add(playersTunnel(darkConcrete));
  group.add(bakeStatic(fixtures));

  // ---- floodlight pylons in the open corners: tapering lattice towers, a bank of lamps on top
  const HEAD = 40;
  const lampGeo = new THREE.PlaneGeometry(8.4, 2.6);
  const lamps = new THREE.InstancedMesh(lampGeo, lampMaterial(), PYLONS.length * 2);
  const spots: THREE.Vector3[] = [];
  PYLONS.forEach(([px, pz], k) => {
    const out = new THREE.Vector2(px, pz).normalize();
    const side = new THREE.Vector2(-out.y, out.x);
    const leg = (i: number, y: number) => {
      const r = 1.6 - (y / HEAD) * 0.9;
      const sx = i & 1 ? 1 : -1;
      const sz = i & 2 ? 1 : -1;
      return new THREE.Vector3(px + (out.x * sx + side.x * sz) * r, y, pz + (out.y * sx + side.y * sz) * r);
    };
    const corners = [0, 1, 3, 2];
    for (let y = 0; y < HEAD; y += 4) {
      const y1 = Math.min(HEAD, y + 4);
      for (let c = 0; c < 4; c++) {
        const i = corners[c];
        const j = corners[(c + 1) % 4];
        beam(leg(i, y), leg(i, y1), 0.22);
        beam(leg(i, y1), leg(j, y1), 0.1);
        // One diagonal per face, alternating: the lattice.
        beam(y % 8 === 0 ? leg(i, y) : leg(j, y), y % 8 === 0 ? leg(j, y1) : leg(i, y1), 0.08);
      }
    }
    // The headframe: two rows of lamps facing the centre spot, tilted down at the pitch.
    const yaw = Math.atan2(-px, -pz);
    const e = new THREE.Euler(0.42, yaw, 0, 'YXZ');
    const fwd = new THREE.Vector3(0, 0, 1).applyEuler(e);
    const up = new THREE.Vector3(0, 1, 0).applyEuler(e);
    const c0 = new THREE.Vector3(px, HEAD + 2.8, pz);
    for (let r = 0; r < 2; r++) {
      const pos = c0.clone().addScaledVector(up, (r - 0.5) * 2.7).addScaledVector(fwd, 0.25);
      lamps.setMatrixAt(k * 2 + r, new THREE.Matrix4().compose(pos, q.setFromEuler(e), new THREE.Vector3(1, 1, 1)));
    }
    const back = c0.clone().addScaledVector(fwd, -0.2);
    beams.push(new THREE.Matrix4().compose(back, new THREE.Quaternion().setFromEuler(e), new THREE.Vector3(9, 5.8, 0.35)));
    spots.push(c0.clone().addScaledVector(fwd, 1.5));
  });
  lamps.instanceMatrix.needsUpdate = true;
  group.add(lamps);
  const glows = lampGlows(spots, 1.25);
  const banks = floodLamps(spots);
  group.add(glows.mesh);
  // Beams from the far pylons only: the near ones would wash over the broadcast picture.
  const shafts = lightShafts(spots.filter((s) => s.z < 0));
  group.add(shafts);

  // ---- the near side: a low paddock in play, a little covered stand for the ground-level shots
  const paddockCrowd = crowdMaterial({ home: homeColor, away: awayColor, shade: [99, 100], seat, aisles: [12, 1], fill: 0.6 });
  const paddockGroup = new THREE.Group();
  for (const [mat, geos] of new Map<THREE.Material, THREE.BufferGeometry[]>([
    [wall, [ringStrip(near, [0, 0], [0, 1.4])]],
    [concrete, [ringStrip(near, [0, 1.4], [0.4, 1.4]), ringStrip(near, [8, tier(8)], [9, tier(8)]), caps([near[0], near[near.length - 1]], [[0, 0], [0, 1.4], [0.4, 1.4], [8, tier(8)], [9, tier(8)], [9, 0]])]],
    [paddockCrowd, [ringStrip(near, [0.4, 1.4], [8, tier(8)])]],
  ])) paddockGroup.add(new THREE.Mesh(mergeGeometries(geos)!, mat));
  group.add(paddockGroup);

  const nearStand = new THREE.Group();
  nearStand.visible = false;
  nearStand.userData.castsHidden = true; // its shadow falls on the pitch either way
  {
    const nearCrowd = crowdMaterial({ home: homeColor, away: awayColor, shade: [-2, 6], seat, aisles: [12, 1], fill: 0.8 });
    const nb = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const ns = (a: [number, number], b: [number, number], mat: THREE.Material) => nb.set(mat, [...(nb.get(mat) ?? []), ringStrip(near, a, b)]);
    ns([0, 0], [0, 1.4], wall);
    ns([0, 1.4], [0.4, 1.4], concrete);
    ns([0.4, 1.4], [11, tier(11)], nearCrowd);
    ns([11, tier(11)], [12, tier(11)], concrete);
    ns([12, tier(11)], [12, 10.6], darkConcrete);
    ns([12, 10.6], [12.5, 10.8], concrete);
    ns([12.5, 10.8], [1.2, 9.9], roofMat);
    ns([1.2, 7.7], [1.2, 9.9], fascia);
    ns([12.5, 0], [12.5, 10.8], brick);
    nb.set(brick, [...(nb.get(brick) ?? []), caps([near[0], near[near.length - 1]], [[0, 0], [0, 1.4], [0.4, 1.4], [1.2, tier(1.2)], [1.2, 9.9], [12.5, 10.8], [12.5, 0]])]);
    for (const [mat, geos] of nb) nearStand.add(new THREE.Mesh(mergeGeometries(geos)!, mat));
    const posts: THREE.Matrix4[] = [];
    const ends = [near[0], near[near.length - 1]];
    for (let i = 1; i < 6; i++) {
      const p = { ...ends[0], x: ends[0].x + ((ends[1].x - ends[0].x) * i) / 6 };
      const a = at(p, 1.2, tier(1.2));
      const b = at(p, 1.2, 7.7);
      posts.push(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), new THREE.Quaternion(), new THREE.Vector3(0.32, b.y - a.y, 0.32)));
    }
    const postMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), steel, posts.length);
    posts.forEach((m, i) => postMesh.setMatrixAt(i, m));
    nearStand.add(postMesh);
  }
  group.add(nearStand);

  const steelMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), steel, beams.length);
  beams.forEach((m, i) => steelMesh.setMatrixAt(i, m));
  steelMesh.instanceMatrix.needsUpdate = true;
  group.add(steelMesh);

  group.add(town());
  group.add(adBoards(LOCAL_BOARDS));
  group.add(crowdFlags(all, homeColor, awayColor, club));
  group.add(banners(all, homeColor, awayColor, club, { o: 18.9, y: 12.4, w: 30, h: 2.8 }));
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
    },
  };
}
