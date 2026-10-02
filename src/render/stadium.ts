import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PITCH } from '../sim/constants';
import type { Atmosphere } from './atmosphere';
import { SHARED, litMaterial } from './look';

/**
 * An old English ground on a big night: four separate stands tight to the touchlines, the
 * corners filled in with quadrants, no running track, no bowl.
 * - The far side is the great main stand: three tiers, two rows of executive boxes, the
 *   club's name picked out in white seats in the top tier, and a tall cantilever roof with
 *   the TV gantry slung under it.
 * - The ends and the corners are two tiers under a lower roof. Where the main stand rises
 *   above them its side is a glazed curtain wall, the way grounds grow one stand at a time.
 * - Cantilever roofs, no pillars: steel girders ride on top of the roof sheet, a band of
 *   translucent panels at the front lets the light in, rafters run underneath, and the
 *   floodlights are a line of lamps along the roof front with the club name on the fascia.
 * - Club-coloured seats, aisle steps and vomitory tunnels in the tiers; LED boards on the
 *   tier fronts; big screens hung in the corners; a low open paddock on the camera side.
 * The home fans pack the end behind the left goal (standing, bouncing, flags, scarves, a
 * card tifo at kick-off); banners hang off the railings, all moving in the shared wind.
 *
 * The crowd is drawn procedurally in the tier shader (tens of thousands of fans for one
 * draw call per tier) and lit by the same evening light as everything else.
 */

export interface Stadium {
  group: THREE.Group;
  /** `tifo` 0..1: the ultras' card display (kick-off of each half). */
  update(time: number, excitement: number, atmo: Atmosphere, tifo?: number): void;
  /** The player's own photo, held up by fans in the stands (null = take it down). */
  setFanBanner(photo: CanvasImageSource | null): void;
}

const U = {
  uTime: { value: 0 },
  uExcite: { value: 0.2 },
  uFog: { value: new THREE.Color() },
  uFogNear: { value: 80 },
  uFogFar: { value: 300 },
  /** Light on the crowd (sun + sky + floodlights), updated per frame. */
  uLight: { value: new THREE.Color(1, 1, 1) },
  uSkyTop: { value: new THREE.Color() },
  uSkyHorizon: { value: new THREE.Color() },
  uSunDir: { value: new THREE.Vector3() },
  uSunColor: { value: new THREE.Color() },
  uFlood: SHARED.uFlood,
  /** Background haze strength (1 = evening haze, low on a clear sunny day). */
  uHaze: { value: 1 },
  uTifoOn: { value: 0 },
};

// ------------------------------------------------------------------ the ground

/** Front of the stands: a rectangle round the pitch with tight quadrant corners. */
const BOWL_X = PITCH.halfL + 8.5;
const BOWL_Z = PITCH.halfW + 7.5;
const BOWL_R = 10;

/** Cross-sections, as (offset back from the front edge, height). */
const LOWER: [number, number][] = [[0.4, 1.4], [20, 11.5]];
/** Second tier (ends, corners; the main stand's middle tier). */
const UPPER: [number, number][] = [[21.5, 15.8], [38, 28.5]];
/** Ends / corners roof: back top and front edge (the front rises a little, cantilevered). */
const ROOF_BACK: [number, number] = [40, 33.2];
const ROOF_EDGE = 8;
const ROOF_H = 34.4;
/** Main stand: third tier and its higher roof. */
const TOP: [number, number][] = [[39.6, 32.4], [58, 46]];
const MAIN_BACK: [number, number] = [60, 50.8];
const MAIN_EDGE = 11;
const MAIN_H = 52.5;
/** Roof height at offset o on a roof running from `back` to (edge, h). */
const roofAt = (back: [number, number], edge: number, h: number, o: number) => back[1] + ((o - back[0]) / (edge - back[0])) * (h - back[1]);

/** A point on the stands' front edge with its outward normal and the section it's in. */
interface PathPt {
  x: number;
  z: number;
  nx: number;
  nz: number;
  /** 0 = main stand side, 1 = home end (ultras), 2 = away end. */
  zone: number;
}

/**
 * The stands' front edge, from part-way round the near-left corner, behind the home goal,
 * along the far side and behind the away goal to part-way round the near-right corner.
 */
function bowlPath(): PathPt[] {
  const pts: PathPt[] = [];
  const cx = BOWL_X - BOWL_R;
  const cz = BOWL_Z - BOWL_R;
  const arc = (ox: number, oz: number, a0: number, a1: number, zone: (a: number) => number) => {
    const n = Math.ceil(Math.abs(a1 - a0) / 0.12);
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      pts.push({ x: ox + nx * BOWL_R, z: oz + nz * BOWL_R, nx, nz, zone: zone(a) });
    }
  };
  const line = (x0: number, z0: number, x1: number, z1: number, nx: number, nz: number, zone: number) => {
    const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 4);
    for (let i = 1; i < n; i++) pts.push({ x: x0 + ((x1 - x0) * i) / n, z: z0 + ((z1 - z0) * i) / n, nx, nz, zone });
  };
  const P = Math.PI;
  arc(-cx, cz, 0.7 * P, P, () => 1);
  line(-BOWL_X, cz, -BOWL_X, -cz, -1, 0, 1);
  arc(-cx, -cz, P, 1.5 * P, (a) => (a < 1.22 * P ? 1 : 0));
  line(-cx, -BOWL_Z, cx, -BOWL_Z, 0, -1, 0);
  arc(cx, -cz, 1.5 * P, 2 * P, (a) => (a > 1.78 * P ? 2 : 0));
  line(BOWL_X, -cz, BOWL_X, cz, 1, 0, 2);
  arc(cx, cz, 2 * P, 2.3 * P, () => 2);
  return pts;
}

/** Splits the path into the part before the main stand, the main stand straight, and after. */
function splitPath(path: PathPt[]): { left: PathPt[]; main: PathPt[]; right: PathPt[] } {
  const i0 = path.findIndex((p) => p.nz < -0.999);
  let i1 = i0;
  while (i1 + 1 < path.length && path[i1 + 1].nz < -0.999) i1++;
  return { left: path.slice(0, i0 + 1), main: path.slice(i0, i1 + 1), right: path.slice(i1) };
}

/** Point at (offset, height) behind path point p. */
const at = (p: PathPt, o: number, h: number, out = new THREE.Vector3()) => out.set(p.x + p.nx * o, h, p.z + p.nz * o);

/**
 * A surface swept around the bowl between two points of the cross-section. uv is in
 * metres: x along the front edge of the strip, y up the slope. aHome/aAway mark the ends.
 */
function ringStrip(path: PathPt[], a: [number, number], b: [number, number]): THREE.BufferGeometry {
  const n = path.length;
  const pos = new Float32Array(n * 6);
  const uv = new Float32Array(n * 4);
  const home = new Float32Array(n * 2);
  const away = new Float32Array(n * 2);
  const slope = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const prev = new THREE.Vector3();
  let u = 0;
  for (let i = 0; i < n; i++) {
    const p = path[i];
    at(p, a[0], a[1], va);
    at(p, b[0], b[1], vb);
    if (i > 0) u += va.distanceTo(prev);
    prev.copy(va);
    pos.set([va.x, va.y, va.z, vb.x, vb.y, vb.z], i * 6);
    uv.set([u, 0, u, slope], i * 4);
    home[i * 2] = home[i * 2 + 1] = p.zone === 1 ? 1 : 0;
    away[i * 2] = away[i * 2 + 1] = p.zone === 2 ? 1 : 0;
  }
  const idx: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a0 = i * 2;
    idx.push(a0, a0 + 2, a0 + 3, a0, a0 + 3, a0 + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aHome', new THREE.BufferAttribute(home, 1));
  geo.setAttribute('aAway', new THREE.BufferAttribute(away, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** u-range (metres along the strip front at offset o) covered by a zone. */
function zoneRange(path: PathPt[], o: number, zone: number): [number, number] {
  let u = 0;
  let u0 = -1;
  let u1 = 0;
  const va = new THREE.Vector3();
  const prev = new THREE.Vector3();
  path.forEach((p, i) => {
    at(p, o, 0, va);
    if (i > 0) u += va.distanceTo(prev);
    prev.copy(va);
    if (p.zone === zone) {
      if (u0 < 0) u0 = u;
      u1 = u;
    }
  });
  return [u0, u1];
}

/** A flat wall in the section plane at each of `pts` with the given (offset, height) outline. */
function caps(pts: PathPt[], outlinePts: [number, number][]): THREE.BufferGeometry {
  const outline = outlinePts.map(([o, h]) => new THREE.Vector2(o, h));
  const tris = THREE.ShapeUtils.triangulateShape(outline, []);
  const pos: number[] = [];
  const uv: number[] = [];
  const v = new THREE.Vector3();
  for (const p of pts) {
    for (const t of tris) for (const k of t) pos.push(...at(p, outline[k].x, outline[k].y, v).toArray()), uv.push(outline[k].x, outline[k].y);
  }
  const geo = new THREE.BufferGeometry();
  const n = pos.length / 3;
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aHome', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
  geo.setAttribute('aAway', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
  geo.setIndex([...Array(n).keys()]);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Bake a group of static meshes into one mesh per material (world transforms applied), so
 * dozens of small props cost a handful of draws. Meshes flagged `userData.live` (cloth,
 * anything animated in its own space) are kept as they are.
 */
function bakeStatic(src: THREE.Group): THREE.Group {
  src.updateMatrixWorld(true);
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const out = new THREE.Group();
  const live: THREE.Object3D[] = [];
  src.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (o.userData.live || o instanceof THREE.InstancedMesh) return void live.push(o);
    const g = (o.geometry as THREE.BufferGeometry).clone().applyMatrix4(o.matrixWorld);
    const flat = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(flat.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') flat.deleteAttribute(k);
    const list = byMat.get(o.material as THREE.Material) ?? [];
    list.push(flat);
    byMat.set(o.material as THREE.Material, list);
  });
  for (const [mat, geos] of byMat) {
    const m = new THREE.Mesh(mergeGeometries(geos)!, mat);
    m.receiveShadow = true;
    out.add(m);
  }
  for (const o of live) {
    o.removeFromParent();
    out.add(o);
  }
  return out;
}

// ------------------------------------------------------------------ crowd

interface CrowdOpts {
  home: number;
  away: number;
  /** Slope distance where the roof's shadow starts / is full. */
  shade: [number, number];
  /** Card mosaic over the home end: texture and its rect in uv metres (u0, u1, v0, v1). */
  tifo?: { tex: THREE.Texture; rect: THREE.Vector4 };
  /** Upper-tier card stunt: alternating colour bands all around. */
  stripes?: boolean;
  /** Seat colour (empty seats, the gaps between fans). */
  seat?: number;
  /** Aisle steps: every `spacing` metres along the tier, `width` wide. */
  aisles?: [number, number];
  /** Vomitories (the tunnels up into the tier): spacing along it, and their v range. */
  voms?: [number, number, number];
  /** Words spelled out in white seats: texture (alpha = letters) and its rect in uv metres. */
  letters?: { tex: THREE.Texture; rect: THREE.Vector4 };
  /** Share of seats taken (the ends and the main stand are always full). */
  fill?: number;
}

function crowdMaterial(o: CrowdOpts): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      ...U,
      uA: { value: new THREE.Color(o.home) },
      uB: { value: new THREE.Color(o.away) },
      uShade: { value: new THREE.Vector2(...o.shade) },
      uTifo: { value: o.tifo?.tex ?? null },
      uTifoRect: { value: o.tifo?.rect ?? new THREE.Vector4(0, 1, 0, 1) },
      uHasTifo: { value: o.tifo ? 1 : 0 },
      uStripes: { value: o.stripes ? 1 : 0 },
      uSeat: { value: new THREE.Color(o.seat ?? 0x2a3044) },
      uAisle: { value: new THREE.Vector2(...(o.aisles ?? [0, 0])) },
      uVom: { value: new THREE.Vector3(...(o.voms ?? [0, 0, 0])) },
      uLetters: { value: o.letters?.tex ?? null },
      uLetterRect: { value: o.letters?.rect ?? new THREE.Vector4(0, 1, 0, 1) },
      uHasLetters: { value: o.letters ? 1 : 0 },
      uFill: { value: o.fill ?? 1 },
    },
    vertexShader: /* glsl */ `
      attribute float aHome;
      attribute float aAway;
      varying vec2 vUv;
      varying float vDist;
      varying float vHome;
      varying float vAway;
      void main() {
        vUv = uv;
        vHome = aHome;
        vAway = aAway;
        vec4 mv = viewMatrix * modelMatrix * vec4(position, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      varying float vDist;
      varying float vHome;
      varying float vAway;
      uniform float uTime, uExcite, uFogNear, uFogFar, uFlood, uHaze, uTifoOn, uHasTifo, uStripes, uHasLetters, uFill;
      uniform vec2 uShade, uAisle;
      uniform vec3 uA, uB, uFog, uLight, uSeat, uVom;
      uniform sampler2D uTifo, uLetters;
      uniform vec4 uTifoRect, uLetterRect;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 15731.743); }

      void main() {
        float ultra = step(0.5, vHome);
        float awayEnd = step(0.5, vAway);
        // Ultras stand shoulder to shoulder; the main stands sit in rows of seats.
        vec2 seat = mix(vec2(0.62, 0.82), vec2(0.5, 0.78), ultra);
        vec2 g = vUv / seat;
        vec2 cell = floor(g);
        vec2 f = fract(g);
        float occ = step(hash(cell), mix(mix(0.92, 0.86, awayEnd), 1.0, ultra) * uFill);
        // The tier's fixtures: aisle steps, vomitory tunnels, seats spelling the club's name.
        float aisle = uAisle.x > 0.0 ? step(abs(fract(vUv.x / uAisle.x) - 0.5) * uAisle.x, uAisle.y * 0.5) : 0.0;
        float vom = uVom.x > 0.0
          ? step(abs(fract(vUv.x / uVom.x + 0.25) - 0.5) * uVom.x, 1.5) * step(uVom.y, vUv.y) * step(vUv.y, uVom.z) : 0.0;
        float letter = 0.0;
        if (uHasLetters > 0.5) {
          vec2 lt = (vUv - uLetterRect.xz) / (uLetterRect.yw - uLetterRect.xz);
          if (lt.x > 0.0 && lt.x < 1.0 && lt.y > 0.0 && lt.y < 1.0) letter = texture2D(uLetters, lt).a;
        }
        occ *= 1.0 - max(aisle, max(vom, step(0.5, letter)));
        float awayShare = mix(mix(0.22, 0.95, awayEnd), 0.02, ultra);

        // Far away a fan is smaller than a pixel: only the stand's average colour shows, so
        // skip drawing individual fans there (most of the bowl, most of the time).
        float px = max(fwidth(g.x), fwidth(g.y));
        float detail = 1.0 - smoothstep(0.2, 0.7, px);
        vec3 seatAvg = uSeat;
        vec3 avg = mix(seatAvg, mix(uA, uB, awayShare) * 0.75 + 0.06, mix(0.55, 0.8, max(ultra, awayEnd)));
        vec3 c = avg;
        vec3 club = mix(uA, uB, awayShare);
        if (detail > 0.0) {
          // Colours: the ends are a sea of their club, the main stands a mix.
          float h = hash(cell + 7.1);
          club = mix(uA, uB, step(hash(cell * 0.37 + floor(cell.x / 14.0)), awayShare));
          float clubShare = mix(0.55, 0.85, max(ultra, awayEnd));
          vec3 shirt = h < clubShare ? club * (0.78 + 0.22 * hash(cell + 2.0))
            : h < clubShare + 0.12 ? vec3(0.86, 0.84, 0.79)
            : h < clubShare + 0.22 ? vec3(0.17, 0.18, 0.21)
            : vec3(0.34, 0.38, 0.47);

          // Movement: ultras bounce together in a rolling wave; others now and then.
          float ph = hash(cell + 3.3) * 6.283;
          float beat = sin(uTime * 7.5 - cell.y * 0.5 + hash(vec2(cell.y, 1.0)) * 0.6);
          float jump = ultra * max(0.0, beat) * (0.1 + 0.12 * uExcite)
            + (1.0 - ultra) * max(0.0, sin(uTime * (7.0 + hash(cell + 1.1) * 3.0) + ph)) * uExcite * uExcite * 0.22;
          float sway = sin(uTime * 1.3 + ph) * 0.03;
          vec2 q = f - vec2(0.5 + sway, 0.0) - vec2(0.0, jump);
          float body = step(abs(q.x), 0.3) * step(0.08, q.y) * step(q.y, 0.62);
          float head = step(length((q - vec2(0.0, 0.74)) * vec2(1.0, 1.25)), 0.16);
          // Scarves held up overhead: always in the ends, everywhere when it's loud.
          float scarfUp = step(hash(cell + 5.5), max(max(ultra, awayEnd) * 0.75, uExcite * uExcite * 0.8));
          float scarf = scarfUp * step(abs(q.x), 0.46) * step(0.86, q.y) * step(q.y, 0.97);
          vec3 scarfCol = mix(club, vec3(0.95, 0.93, 0.88), step(0.5, fract(q.x * 3.0 + 0.25)));

          vec3 seatCol = seatAvg * (0.9 + 0.2 * step(0.5, fract(cell.y * 0.5)));
          vec3 skin = mix(vec3(0.93, 0.76, 0.6), vec3(0.42, 0.28, 0.18), hash(cell + 9.2));
          vec3 fan = seatCol;
          fan = mix(fan, shirt, body * occ);
          fan = mix(fan, skin, head * occ);
          fan = mix(fan, scarfCol, scarf * occ);
          c = mix(avg, fan, detail);
        }
        c = mix(c, avg, 0.05 + 0.1 * uHaze);
        // Fixtures over the fans: white letter seats, concrete steps, dark tunnel mouths.
        vec3 stepsCol = vec3(0.4, 0.41, 0.43) * (0.82 + 0.18 * step(0.5, fract(vUv.y / 0.82)));
        c = mix(c, vec3(0.86, 0.85, 0.82) * (0.9 + 0.1 * step(0.5, fract(vUv.y / 0.82))), letter);
        c = mix(c, stepsCol, aisle * (1.0 - letter));
        c = mix(c, vec3(0.02, 0.022, 0.03), vom);

        // Card display: every fan holds one card, together they make the picture.
        if (uTifoOn > 0.001) {
          vec2 cardUv = mix((cell + 0.5) * seat, vUv, smoothstep(0.3, 0.9, px));
          vec3 card = vec3(0.0);
          float on = 0.0;
          if (uHasTifo > 0.5) {
            vec2 t = (cardUv - uTifoRect.xz) / (uTifoRect.yw - uTifoRect.xz);
            on = step(0.0, t.x) * step(t.x, 1.0) * step(0.0, t.y) * step(t.y, 1.0) * ultra;
            card = texture2D(uTifo, clamp(t, 0.0, 1.0)).rgb;
          }
          if (uStripes > 0.5) {
            float band = step(0.5, fract(cardUv.x / 9.0));
            vec3 sc = mix(mix(uA, uB, awayEnd), vec3(0.95, 0.93, 0.88), band);
            card = mix(sc, card, on);
            on = 1.0;
          }
          float gap = step(0.08, f.x) * step(f.x, 0.94) * step(0.06, f.y) * step(f.y, 0.94);
          card *= mix(1.0, 0.86 + 0.14 * hash(cell + 4.4), 1.0 - smoothstep(0.3, 0.9, px));
          card = mix(card * 0.55, card, max(gap, smoothstep(0.3, 0.9, px)));
          c = mix(c, card, on * uTifoOn * step(hash(cell + 8.8), 0.985));
        }

        // Rows under the roof sit in its shadow.
        c *= 1.0 - 0.38 * smoothstep(uShade.x, uShade.y, vUv.y);

        c = pow(c, vec3(2.2)) * uLight;
        // Phone torches once it's dark.
        float tw = step(0.9965, hash(cell + floor(uTime * 3.0 + hash(cell) * 10.0)));
        c += vec3(1.0, 0.97, 0.9) * tw * occ * uFlood * 1.6 * (1.0 - smoothstep(0.5, 1.2, px));

        // Atmospheric haze: the background sits back behind the play.
        float fog = smoothstep(uFogNear, uFogFar, vDist);
        c = mix(c, uFog, (0.12 + fog * 0.7) * uHaze);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

/** The ultras' card mosaic: their colours, the name in huge letters, stars. */
/** The home club's identity for the stands: its crest (drawn async) and name. */
export interface StadiumClub {
  crest?: Promise<CanvasImageSource>;
  name?: string;
  /** The big drop banner over the home end: its words and colours. */
  motto?: { text: string; bg: number; fg: number };
}

/** Draws `img` (a 100 x 124 crest) centred at (x, y), `h` tall. */
function drawCrest(c: CanvasRenderingContext2D, img: CanvasImageSource, x: number, y: number, h: number): void {
  const w = h * (100 / 124);
  c.drawImage(img, x - w / 2, y - h / 2, w, h);
}

function tifoTexture(home: number, club: StadiumClub): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 160;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = true;
  const hex = '#' + home.toString(16).padStart(6, '0');
  const draw = () => {
    const g = cv.getContext('2d')!;
    g.fillStyle = hex;
    g.fillRect(0, 0, 512, 160);
    // Chevron bands top and bottom.
    g.fillStyle = '#f4efe2';
    for (let x = -40; x < 560; x += 40) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x + 20, 18);
      g.lineTo(x + 40, 0);
      g.fill();
      g.beginPath();
      g.moveTo(x, 160);
      g.lineTo(x + 20, 142);
      g.lineTo(x + 40, 160);
      g.fill();
    }
    g.fillStyle = '#14123a';
    g.fillRect(0, 26, 512, 8);
    g.fillRect(0, 126, 512, 8);
    g.font = '800 92px "Barlow Condensed", "Arial Narrow", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 10;
    g.strokeStyle = '#14123a';
    const word = crest ? (club.name ?? 'GAMENIGHT').toUpperCase() : 'GAMENIGHT';
    g.strokeText(word, 256, 84, crest ? 300 : 480);
    g.fillStyle = '#ffd447';
    g.fillText(word, 256, 84, crest ? 300 : 480);
    if (crest) {
      drawCrest(g, crest, 62, 82, 112);
      drawCrest(g, crest, 450, 82, 112);
    }
    tex.needsUpdate = true;
  };
  let crest: CanvasImageSource | null = null;
  draw();
  void document.fonts?.ready.then(draw);
  void club.crest?.then((img) => ((crest = img), draw()));
  return tex;
}

// ------------------------------------------------------------------ surfaces

/** LED ribbon boards on the tier fronts: scrolling messages that glow in the dark. */
function ribbonMaterial(home: number): THREE.ShaderMaterial {
  const cv = document.createElement('canvas');
  cv.width = 1024;
  cv.height = 32;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  const hex = '#' + home.toString(16).padStart(6, '0');
  const draw = () => {
    const g = cv.getContext('2d')!;
    const segs: [string, string, string][] = [
      ['GAMENIGHT', '#0d1030', '#ffd447'],
      ['SEASON 01', hex, '#ffffff'],
      ['BIG NIGHT', '#0d1030', '#9fd0ff'],
      ['MATCHDAY', '#f2ede1', '#14123a'],
    ];
    segs.forEach(([t, bg, fg], i) => {
      g.fillStyle = bg;
      g.fillRect(i * 256, 0, 256, 32);
      g.fillStyle = fg;
      g.font = '800 26px "Barlow Condensed", "Arial Narrow", sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(`★  ${t}  ★`, i * 256 + 128, 17);
    });
    tex.needsUpdate = true;
  };
  draw();
  void document.fonts?.ready.then(draw);
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { ...U, uMap: { value: tex }, uHome: { value: new THREE.Color(home) } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying float vDist;
      void main() {
        vUv = uv;
        vec4 mv = viewMatrix * modelMatrix * vec4(position, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uHome, uFog;
      uniform float uTime, uFlood, uExcite, uFogNear, uFogFar, uHaze;
      varying vec2 vUv;
      varying float vDist;
      void main() {
        float h = 1.3;
        vec2 t = vec2((vUv.x - uTime * 2.5) / 40.0, clamp(vUv.y / h, 0.0, 1.0));
        vec3 c = texture2D(uMap, t).rgb;
        // A goal sets the whole ribbon pulsing in the club colour.
        float goal = smoothstep(0.85, 1.0, uExcite) * (0.5 + 0.5 * sin(uTime * 14.0 - vUv.x * 0.15));
        c = mix(c, uHome * 1.4, goal * 0.8);
        // LED rows.
        c *= 0.75 + 0.25 * step(0.35, fract(vUv.y * 16.0));
        c *= 0.55 + uFlood * 0.9;
        c = mix(c, uFog, smoothstep(uFogNear, uFogFar, vDist) * 0.6 * uHaze);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }
    `,
    toneMapped: false,
  });
}

/** Hospitality boxes between the tiers: dark glass by day, warm interiors at night. */
function glassMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { ...U },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying float vDist;
      void main() {
        vUv = uv;
        vec4 mv = viewMatrix * modelMatrix * vec4(position, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSkyHorizon, uFog;
      uniform float uFlood, uFogNear, uFogFar, uHaze;
      varying vec2 vUv;
      varying float vDist;
      float hash(float n) { return fract(sin(n * 91.7) * 4375.5); }
      void main() {
        float bay = floor(vUv.x / 3.2);
        float mull = step(0.08, fract(vUv.x / 3.2)) * step(0.12, vUv.y) * step(vUv.y, 2.75);
        vec3 glass = uSkyHorizon * 0.35 + vec3(0.03, 0.04, 0.06);
        vec3 room = vec3(1.0, 0.78, 0.5) * (0.35 + 0.65 * hash(bay)) * (0.25 + uFlood * 1.1);
        vec3 c = mix(vec3(0.05, 0.055, 0.06), glass + room, mull);
        c = mix(c, uFog, smoothstep(uFogNear, uFogFar, vDist) * 0.7 * uHaze);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }
    `,
    toneMapped: false,
  });
}

function lampMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uFlood: SHARED.uFlood },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec2 vUv; uniform float uFlood; void main(){
      vec2 g = fract(vUv * vec2(5.0, 2.0)) - 0.5;
      float l = 1.0 - smoothstep(0.22, 0.42, length(g));
      vec3 c = mix(vec3(0.05, 0.05, 0.06), vec3(1.0, 0.96, 0.86) * (0.6 + 2.6 * uFlood), l);
      gl_FragColor = vec4(c, 1.0);
      #include <colorspace_fragment>
    }`,
    toneMapped: false,
  });
}

/** Instanced boxes along the bowl: roof trusses and floodlight banks. */
function alongRoof(path: PathPt[], every: number, geo: THREE.BufferGeometry, mat: THREE.Material, place: (p: PathPt, m: THREE.Matrix4) => void): THREE.InstancedMesh {
  const picks = path.filter((_, i) => i % every === 0);
  const mesh = new THREE.InstancedMesh(geo, mat, picks.length);
  const m = new THREE.Matrix4();
  picks.forEach((p, i) => {
    place(p, m);
    mesh.setMatrixAt(i, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

/** Floodlight banks along the roof fronts (ends, corners, main stand): beams and glows. */
function lampSpots(): THREE.Vector3[] {
  const cx = BOWL_X - BOWL_R;
  const cz = BOWL_Z - BOWL_R;
  const r = (BOWL_R + ROOF_EDGE + 1) * Math.SQRT1_2;
  const ex = BOWL_X + ROOF_EDGE + 1;
  const mz = -(BOWL_Z + MAIN_EDGE + 1);
  return [
    new THREE.Vector3(-cx - r, ROOF_H - 2, -cz - r),
    new THREE.Vector3(cx + r, ROOF_H - 2, -cz - r),
    new THREE.Vector3(-ex, ROOF_H - 2, -14),
    new THREE.Vector3(-ex, ROOF_H - 2, 18),
    new THREE.Vector3(ex, ROOF_H - 2, -14),
    new THREE.Vector3(ex, ROOF_H - 2, 18),
    new THREE.Vector3(-30, MAIN_H - 2, mz),
    new THREE.Vector3(0, MAIN_H - 2, mz),
    new THREE.Vector3(30, MAIN_H - 2, mz),
  ];
}

/** Roof sheeting seen from below: rafters across, purlins along, a little weathering. */
function roofMaterial(color: number): THREE.MeshStandardMaterial {
  const m = litMaterial({
    color,
    roughness: 0.75,
    diffuseHook: `{
      float rafter = 1.0 - smoothstep(0.0, 0.18, abs(fract(vUv2.x / 7.5) - 0.5) * 7.5);
      float purlin = 1.0 - smoothstep(0.0, 0.08, abs(fract(vUv2.y / 2.6) - 0.5) * 2.6);
      float sheet = 0.93 + 0.07 * step(0.5, fract(vUv2.x / 0.9));
      diffuseColor.rgb *= sheet * (1.0 - 0.35 * rafter) * (1.0 - 0.18 * purlin);
    }`,
  });
  m.side = THREE.DoubleSide;
  return m;
}

/** The roof front fascia: the club's name repeated along it, painted on the club colour. */
function fasciaMaterial(home: number, name: string): THREE.MeshStandardMaterial {
  const cv = document.createElement('canvas');
  cv.width = 1024;
  cv.height = 64;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  // uv is in metres: one sign every 48 m along, 2.2 m tall.
  tex.repeat.set(1 / 48, 1 / 2.2);
  const c = new THREE.Color(home).multiplyScalar(0.55);
  const bg = '#' + c.getHexString();
  const draw = () => {
    const g = cv.getContext('2d')!;
    g.fillStyle = bg;
    g.fillRect(0, 0, 1024, 64);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(0, 0, 1024, 5);
    g.fillRect(0, 59, 1024, 5);
    g.fillStyle = '#f4f0e6';
    g.font = '800 40px "Barlow Condensed", "Arial Narrow", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(name.toUpperCase().split('').join(' '), 512, 34, 900);
    tex.needsUpdate = true;
  };
  draw();
  void document.fonts?.ready.then(draw);
  const m = litMaterial({ roughness: 0.55 });
  m.map = tex;
  m.side = THREE.DoubleSide;
  return m;
}

/** Glazed curtain wall (the main stand's flanks): mullions, warm stairwell lights at night. */
function curtainMaterial(): THREE.MeshStandardMaterial {
  const m = litMaterial({
    color: 0x2c333d,
    roughness: 0.35,
    metalness: 0.2,
    diffuseHook: `{
      vec2 g = vec2(vUv2.x / 2.4, vUv2.y / 3.2);
      float mull = max(1.0 - smoothstep(0.0, 0.06, abs(fract(g.x) - 0.5) * 2.0 - 0.9), 1.0 - smoothstep(0.0, 0.08, abs(fract(g.y) - 0.5) * 2.0 - 0.86));
      float lit = step(0.72, fract(sin(dot(floor(g), vec2(12.9, 78.2))) * 43758.5));
      diffuseColor.rgb = mix(diffuseColor.rgb + vec3(1.0, 0.78, 0.5) * lit * uFlood * 0.5, vec3(0.62, 0.64, 0.66), mull);
    }`,
  });
  m.side = THREE.DoubleSide;
  return m;
}

/** The ground's big screens, hung under the corner roofs: crest and name, glowing at night. */
function screenMaterial(club: StadiumClub, home: number): THREE.MeshBasicMaterial {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 288;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  let crest: CanvasImageSource | null = null;
  const hex = '#' + home.toString(16).padStart(6, '0');
  const draw = () => {
    const g = cv.getContext('2d')!;
    const grd = g.createLinearGradient(0, 0, 0, 288);
    grd.addColorStop(0, '#0b1024');
    grd.addColorStop(1, '#1a1640');
    g.fillStyle = grd;
    g.fillRect(0, 0, 512, 288);
    g.fillStyle = hex;
    g.fillRect(0, 244, 512, 44);
    if (crest) drawCrest(g, crest, 256, 112, 170);
    g.fillStyle = '#ffffff';
    g.font = '800 34px "Barlow Condensed", "Arial Narrow", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText((club.name ?? 'GAMENIGHT').toUpperCase(), 256, 268, 480);
    // LED pixel grid.
    g.fillStyle = 'rgba(0,0,0,0.22)';
    for (let x = 0; x < 512; x += 4) g.fillRect(x, 0, 1, 288);
    for (let y = 0; y < 288; y += 4) g.fillRect(0, y, 512, 1);
    tex.needsUpdate = true;
  };
  draw();
  void document.fonts?.ready.then(draw);
  void club.crest?.then((img) => ((crest = img), draw()));
  return new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, side: THREE.DoubleSide });
}

/** Club name in big letters, for spelling out in the seats (alpha = letters). */
function lettersTexture(name: string): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 1024;
  cv.height = 128;
  const tex = new THREE.CanvasTexture(cv);
  const draw = () => {
    const g = cv.getContext('2d')!;
    g.clearRect(0, 0, 1024, 128);
    g.fillStyle = '#fff';
    g.font = '800 118px "Barlow Condensed", "Arial Narrow", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(name.toUpperCase().split('').join(' '), 512, 68, 1000);
    tex.needsUpdate = true;
  };
  draw();
  void document.fonts?.ready.then(draw);
  return tex;
}

let glowTex: THREE.Texture | null = null;
function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,250,235,1)');
  grad.addColorStop(0.18, 'rgba(255,240,215,0.55)');
  grad.addColorStop(0.5, 'rgba(255,225,190,0.12)');
  grad.addColorStop(1, 'rgba(255,220,180,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(cv);
  return glowTex;
}

const BOARDS: { bg: string; fg: string; text: string }[] = [
  { bg: '#1f3b5c', fg: '#f2ede1', text: 'GAMENIGHT' },
  { bg: '#c8393b', fg: '#ffffff', text: 'ROSSONERI' },
  { bg: '#f1ebdc', fg: '#23345e', text: 'ATLANTIC' },
  { bg: '#2f6b4f', fg: '#f2ede1', text: 'KESTREL' },
  { bg: '#d9a93f', fg: '#1d1d1d', text: 'NORTHWIND' },
  { bg: '#26282c', fg: '#ffd447', text: 'SEASON 01' },
  { bg: '#e9e1cc', fg: '#c4472f', text: 'FIELD & CO' },
  { bg: '#23345e', fg: '#9fd0ff', text: 'HALCYON' },
];

/** All board designs in one atlas (8 rows), drawn once at start-up. */
function boardTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 512;
  const tex = new THREE.CanvasTexture(cv);
  const draw = () => {
    const g = cv.getContext('2d')!;
    BOARDS.forEach((b, i) => {
      const y = i * 64;
      g.fillStyle = b.bg;
      g.fillRect(0, y, 512, 64);
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.fillRect(0, y, 512, 22);
      g.fillStyle = b.fg;
      g.font = '800 44px "Barlow Condensed", "Arial Narrow", sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(b.text, 256, y + 34);
    });
    tex.needsUpdate = true;
  };
  draw();
  void document.fonts?.ready.then(draw);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function adBoards(): THREE.InstancedMesh {
  const panelW = 6;
  const geo = new THREE.BoxGeometry(panelW - 0.08, 0.9, 0.12);
  geo.translate(0, 0.45, 0);
  const placements: { x: number; z: number; ry: number }[] = [];
  const zSide = PITCH.halfW + 3.8;
  for (let x = -PITCH.halfL + panelW / 2; x <= PITCH.halfL - panelW / 2 + 0.01; x += panelW) {
    placements.push({ x, z: -zSide, ry: 0 });
    placements.push({ x, z: zSide, ry: Math.PI });
  }
  const xEnd = PITCH.halfL + 4.5;
  for (let z = -PITCH.halfW + panelW / 2; z <= PITCH.halfW - panelW / 2 + 0.01; z += panelW) {
    if (Math.abs(z) < PITCH.goalHalfWidth + 3.5) continue;
    placements.push({ x: -xEnd, z, ry: Math.PI / 2 });
    placements.push({ x: xEnd, z, ry: -Math.PI / 2 });
  }
  const n = placements.length;
  const design = new Float32Array(n);
  // LED boards: the front face shows a design from the atlas and glows more as it gets dark.
  const mat = litMaterial({
    roughness: 0.45,
    uniforms: { uBoards: { value: boardTexture() } },
    vertDecl: 'attribute float aDesign; varying float vDesign; varying float vFront;',
    vertBody: 'vDesign = aDesign; vFront = step(0.5, normal.z);',
    fragDecl: 'uniform sampler2D uBoards; varying float vDesign; varying float vFront;',
    diffuseHook: `{
      vec2 buv = vec2(vUv2.x, (7.0 - vDesign + vUv2.y) / 8.0);
      vec3 board = texture2D(uBoards, buv).rgb;
      diffuseColor.rgb = mix(vec3(0.12, 0.13, 0.15), board, vFront);
    }`,
  });
  mat.onBeforeCompile = ((orig) => (shader: Parameters<typeof orig>[0], r: Parameters<typeof orig>[1]) => {
    orig(shader, r);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vFront * (0.15 + uFlood * 0.6);',
    );
  })(mat.onBeforeCompile.bind(mat));
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  placements.forEach((p, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.ry);
    m.compose(new THREE.Vector3(p.x, 0, p.z), q, new THREE.Vector3(1, 1, 1));
    mesh.setMatrixAt(i, m);
    design[i] = (i * 5 + (i >> 2)) % BOARDS.length;
  });
  geo.setAttribute('aDesign', new THREE.InstancedBufferAttribute(design, 1));
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

// ------------------------------------------------------------------ dressing

/**
 * Flags on poles, waved by fans in the stands: each swings side to side around the pole's
 * foot while the cloth ripples. Most are in the ultras' end.
 */
function crowdFlags(path: PathPt[], home: number, away: number, club: StadiumClub): THREE.InstancedMesh {
  const cloth = new THREE.PlaneGeometry(2.4, 1.5, 8, 3);
  cloth.translate(1.2, 2.45, 0);
  cloth.setAttribute('aCloth', new THREE.Float32BufferAttribute(new Array(cloth.attributes.position.count).fill(1), 1));
  const pole = new THREE.BoxGeometry(0.06, 3.3, 0.06);
  pole.translate(0, 1.65, 0);
  pole.setAttribute('aCloth', new THREE.Float32BufferAttribute(new Array(pole.attributes.position.count).fill(0), 1));
  const geo = mergeGeometries([cloth, pole])!;

  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const byZone = (z: number) => path.filter((p) => p.zone === z);
  const spots: { p: PathPt; o: number; c: number; c2: number; pat: number; size: number }[] = [];
  const add = (pts: PathPt[], n: number, cols: number[][], big: number, crestShare = 0) => {
    for (let i = 0; i < n; i++) {
      const c = cols[Math.floor(rnd() * cols.length)];
      // Pattern 4 is the club crest (when there is one), on the club colour.
      const crest = rnd() < crestShare;
      spots.push({ p: pts[Math.floor(rnd() * pts.length)], o: 1.5 + rnd() * 15, c: crest ? home : c[0], c2: crest ? W : c[1], pat: crest ? 4 : Math.floor(rnd() * 7), size: 0.8 + rnd() * big });
    }
  };
  const W = 0xf3eee2;
  const N = 0x14123a;
  const crestShare = club.crest ? 0.35 : 0;
  add(byZone(1), 34, [[home, W], [home, N], [W, home], [0xffd447, home]], 0.7, crestShare);
  add(byZone(2), 12, [[away, W], [W, away], [away, N]], 0.4);
  add(byZone(0), 18, [[home, W], [W, home], [away, W]], 0.35, crestShare * 0.6);

  const crestCv = document.createElement('canvas');
  crestCv.width = 128;
  crestCv.height = 160;
  const crestTex = new THREE.CanvasTexture(crestCv);
  crestTex.colorSpace = THREE.SRGBColorSpace;
  const hasCrest = { value: 0 };
  void club.crest?.then((img) => {
    const g = crestCv.getContext('2d')!;
    g.clearRect(0, 0, 128, 160);
    g.drawImage(img, 0, 0, 128, 160);
    crestTex.needsUpdate = true;
    hasCrest.value = 1;
  });

  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { ...U, uWind: SHARED.uWind, uCrest: { value: crestTex }, uHasCrest: hasCrest },
    vertexShader: /* glsl */ `
      uniform float uTime, uExcite;
      uniform vec2 uWind;
      attribute float aCloth;
      attribute vec3 aCol;
      attribute vec3 aCol2;
      attribute float aPhase;
      attribute float aPat;
      varying vec2 vUv;
      varying vec3 vCol;
      varying vec3 vCol2;
      varying float vPat;
      varying float vShade;
      varying float vDist;
      void main() {
        vUv = uv;
        vCol = aCol;
        vCol2 = aCol2;
        vPat = aPat + (1.0 - aCloth) * 10.0;
        vec3 p = position;
        // 0 at the pole, 1 at the fly end.
        float k = clamp(p.x / 2.4, 0.0, 1.0) * aCloth;
        float wind = length(uWind);
        // The fan swings the flag back and forth around the foot of the pole.
        float sp = 1.7 + fract(aPhase) * 0.8;
        float A = 0.5 + uExcite * 0.35;
        float sway = sin(uTime * sp + aPhase) * A;
        float swayVel = cos(uTime * sp + aPhase) * A * sp;
        // Waves run from the pole to the fly end, faster and bigger when the flag moves.
        float t = uTime * (4.0 + wind * 1.5 + abs(swayVel) * 1.2);
        float ph1 = p.x * 2.6 - t + aPhase;
        float ph2 = p.x * 5.6 - t * 1.7 + p.y * 2.2 + aPhase * 1.3;
        float ph3 = p.x * 11.0 - t * 3.1 + p.y * 5.0;
        float amp = (0.16 + 0.1 * wind + 0.1 * abs(swayVel)) * pow(k, 1.3);
        p.z += (sin(ph1) * 0.6 + sin(ph2) * 0.26 + sin(ph3) * 0.1 * k) * amp;
        float slope = (cos(ph1) * 1.56 + cos(ph2) * 1.46 + cos(ph3) * 1.1 * k) * amp;
        // Gravity: the cloth droops at the turn of each swing, flies out mid-swing.
        p.y -= k * k * 0.38 * (1.0 - min(1.0, abs(swayVel) * 0.45 + wind * 0.25));
        // Drag: the cloth trails behind the pole's movement.
        float ang = sway - swayVel * 0.17 * k;
        float cs = cos(ang);
        float sn = sin(ang);
        p.xy = vec2(p.x * cs - p.y * sn, p.x * sn + p.y * cs);
        // Folds facing the light are brighter, the ones turned away darker.
        vShade = aCloth > 0.5 ? clamp(0.86 - slope * 0.32, 0.5, 1.2) : 1.0;
        vec4 mv = viewMatrix * modelMatrix * instanceMatrix * vec4(p, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uLight, uFog;
      uniform float uFogNear, uFogFar, uHaze;
      uniform sampler2D uCrest;
      uniform float uHasCrest;
      varying vec2 vUv;
      varying vec3 vCol;
      varying vec3 vCol2;
      varying float vPat;
      varying float vShade;
      varying float vDist;
      void main() {
        vec2 u = vUv;
        float b = 0.0;
        if (vPat < 0.5) b = step(0.36, u.y) * step(u.y, 0.64);                          // band
        else if (vPat < 1.5) b = step(0.5, u.x);                                        // halves
        else if (vPat < 2.5) b = step(abs(u.y - (u.x * 0.62 + 0.19)), 0.16);           // sash
        else if (vPat < 3.5) b = step(0.333, u.x) * step(u.x, 0.667);                  // tricolour
        else if (vPat < 4.5) {                                                           // crest
          float r = length((u - 0.5) * vec2(1.6, 1.0));
          b = step(r, 0.3) * (1.0 - step(0.2, r) * step(r, 0.24));
        }
        else if (vPat < 5.5) b = mod(floor(u.x * 4.0) + floor(u.y * 3.0), 2.0);         // chequers
        else b = step(0.5, fract(u.y * 2.5));                                            // hoops
        vec3 c = vPat > 9.5 ? vec3(0.22) : mix(vCol, vCol2, b);
        if (uHasCrest > 0.5 && vPat > 3.5 && vPat < 4.5) {
          // The club crest in the middle of the cloth (cloth 2.4 x 1.5 m, crest 100 x 124).
          vec2 cu = vec2((u.x - 0.3) / 0.4, (u.y - 0.1) / 0.8);
          vec4 cr = (cu.x > 0.0 && cu.x < 1.0 && cu.y > 0.0 && cu.y < 1.0) ? texture2D(uCrest, cu) : vec4(0.0);
          c = mix(vCol, cr.rgb, cr.a);
        }
        // Stitched hem round the fly edges.
        float hem = max(step(0.96, u.x), max(step(u.y, 0.04), step(0.96, u.y)));
        c *= vPat > 9.5 ? 1.0 : 1.0 - hem * 0.18;
        c *= vShade * (gl_FrontFacing ? 1.0 : 0.9) * uLight;
        c = mix(c, uFog, (0.1 + smoothstep(uFogNear, uFogFar, vDist) * 0.7) * uHaze);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const n = spots.length;
  const col = new Float32Array(n * 3);
  const col2 = new Float32Array(n * 3);
  const phase = new Float32Array(n);
  const pat = new Float32Array(n);
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const c = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  spots.forEach((s, i) => {
    const h = LOWER[0][1] + ((s.o - LOWER[0][0]) / (LOWER[1][0] - LOWER[0][0])) * (LOWER[1][1] - LOWER[0][1]);
    at(s.p, s.o, h + 1.1, v);
    q.setFromAxisAngle(up, Math.atan2(-s.p.nx, -s.p.nz));
    m.compose(v, q, one.setScalar(s.size));
    mesh.setMatrixAt(i, m);
    col.set(c.setHex(s.c).toArray(), i * 3);
    col2.set(c.setHex(s.c2).toArray(), i * 3);
    phase[i] = i * 2.39;
    pat[i] = s.pat;
  });
  geo.setAttribute('aCol', new THREE.InstancedBufferAttribute(col, 3));
  geo.setAttribute('aCol2', new THREE.InstancedBufferAttribute(col2, 3));
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
  geo.setAttribute('aPat', new THREE.InstancedBufferAttribute(pat, 1));
  mesh.frustumCulled = false;
  return mesh;
}

/** Soft volumetric beams from the roof's floodlight banks, visible as dusk falls. */
function lightShafts(spots: THREE.Vector3[]): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: { uFlood: SHARED.uFlood },
    vertexShader: /* glsl */ `
      varying float vAlong;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vAlong = uv.y;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uFlood;
      varying float vAlong;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        // Bright at the lamp, fading toward the pitch; soft edges (no hard cone outline).
        float soft = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);
        float a = pow(vAlong, 2.2) * soft * uFlood * uFlood * 0.065;
        gl_FragColor = vec4(vec3(1.0, 0.96, 0.86) * a, 1.0);
      }
    `,
  });
  // All beams in one static mesh (one draw).
  const geos = spots.map((from) => {
    const target = new THREE.Vector3(from.x * 0.3, 0, from.z * 0.3);
    const len = from.distanceTo(target);
    const geo = new THREE.ConeGeometry(16, len, 24, 1, true);
    geo.translate(0, -len / 2, 0); // apex at the origin
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), target.clone().sub(from).normalize());
    return geo.applyMatrix4(new THREE.Matrix4().compose(from, q, new THREE.Vector3(1, 1, 1)));
  });
  const m = new THREE.Mesh(mergeGeometries(geos)!, mat);
  m.frustumCulled = false;
  m.renderOrder = 6;
  g.add(m);
  return g;
}

type ClothPin = 'left' | 'top' | 'sides';

/**
 * Cloth in the shared wind, for plane geometry of size w×h (local xy, facing +z).
 * Waves travel along the cloth away from where it's tied and grow toward the free edge;
 * gusts come and go; a fast flutter rides on top; the cloth bellies out a little; and the
 * normal follows the folds, so they catch the light and shade like real fabric.
 * - left: tied to a pole on its left edge (flags),
 * - top: hung from its top edge (banners over a railing),
 * - sides: stretched between two poles (held-up banners).
 */
function windCloth<T extends THREE.Material>(mat: T, amp: number, pin: ClothPin, w: number, h: number): T {
  const hw = (w / 2).toFixed(3);
  const hh = (h / 2).toFixed(3);
  const free =
    pin === 'left' ? `clamp((p.x + ${hw}) / ${w.toFixed(3)}, 0.0, 1.0)`
    : pin === 'top' ? `clamp((${hh} - p.y) / ${h.toFixed(3)}, 0.0, 1.0)`
    : `clamp(1.0 - pow(abs(p.x) / ${hw}, 2.0), 0.0, 1.0)`;
  // Waves along x: measured from the pole for flags; wavelength ~ a third of a flag, ~4 m on banners.
  const along = pin === 'left' ? `(p.x + ${hw})` : 'p.x';
  const k = (pin === 'left' ? 6.0 / w : 1.6).toFixed(3);
  const billow = pin === 'sides' ? '0.55' : '0.22';
  const eps = (Math.min(w, h) * 0.02).toFixed(4);
  const orig = mat.onBeforeCompile.bind(mat);
  mat.onBeforeCompile = (shader, r) => {
    orig(shader, r);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform vec2 uWind;
        float clothZ(vec2 p) {
          float f = ${free};
          float wind = length(uWind);
          float seed = modelMatrix[3].x * 0.37 + modelMatrix[3].z * 0.61;
          #ifdef USE_INSTANCING
            seed += instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.61;
          #endif
          float gust = 0.55 + 0.45 * sin(uTime * 0.53 + seed) * sin(uTime * 1.31 + seed * 1.7);
          float t = uTime * (2.0 + wind * 1.6);
          float s = ${along} * ${k};
          float wave = sin(s - t + seed) * 0.62
            + sin(s * 2.3 - t * 1.8 + p.y * ${k} * 1.4 + seed * 2.0) * 0.26
            + sin(s * 5.6 - t * 4.1 + p.y * ${k} * 3.0) * 0.12 * f;
          float belly = ${billow} * f * (0.65 + 0.35 * sin(uTime * 0.9 + seed));
          return ${amp.toFixed(3)} * wind * gust * (pow(f, 1.4) * wave + belly);
        }`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        {
          float cz0 = clothZ(position.xy);
          float czx = clothZ(position.xy + vec2(${eps}, 0.0));
          float czy = clothZ(position.xy + vec2(0.0, ${eps}));
          objectNormal = normalize(vec3(-(czx - cz0) / ${eps}, -(czy - cz0) / ${eps}, 1.0));
        }`,
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.z += clothZ(position.xy);');
  };
  // Each cloth variant compiles to different code: give it its own program cache key.
  const key = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `${key()}|cloth:${pin}:${amp}:${w}:${h}`;
  return mat;
}

/** Corner flags and the two dugouts on the far touchline. */
function pitchside(home: number, away: number): THREE.Group {
  const g = new THREE.Group();
  const pole = litMaterial({ color: 0xf2f0e8, roughness: 0.5 });
  const flagMat = windCloth(litMaterial({ color: 0xffd447, roughness: 0.8 }), 0.1, 'left', 0.4, 0.3);
  flagMat.side = THREE.DoubleSide;
  // The four flags are one instanced cloth (each gets its own wind phase from its position).
  const flags = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.4, 0.3, 6, 2), flagMat, 4);
  let fi = 0;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.6, 6), pole);
      p.position.set(sx * PITCH.halfL, 0.8, sz * PITCH.halfW);
      g.add(p);
      flags.setMatrixAt(fi++, new THREE.Matrix4().makeTranslation(sx * PITCH.halfL + 0.2, 1.45, sz * PITCH.halfW));
    }
  }
  g.add(flags);
  const shell = litMaterial({ color: 0x2b3038, roughness: 0.6 });
  const roofGlass = new THREE.MeshStandardMaterial({ color: 0x9fb4c8, roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.35 });
  const bench = litMaterial({ color: 0x46505c, roughness: 0.7 });
  const zLine = -(PITCH.halfW + 2.6);
  [-1, 1].forEach((side, ti) => {
    const dg = new THREE.Group();
    const back = new THREE.Mesh(new THREE.BoxGeometry(7, 1.9, 0.12), shell);
    back.position.set(0, 0.95, -0.9);
    dg.add(back);
    for (const ex of [-3.5, 3.5]) {
      const end = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.9, 1.8), roofGlass);
      end.position.set(ex, 0.95, 0);
      dg.add(end);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(7.1, 0.08, 1.9), roofGlass);
    roof.position.set(0, 1.95, 0);
    dg.add(roof);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(6.6, 0.45, 0.5), bench);
    seat.position.set(0, 0.22, -0.55);
    dg.add(seat);
    // Substitutes in tracksuits.
    const suit = litMaterial({ color: ti === 0 ? home : 0x23345e, roughness: 0.8 });
    const skin = litMaterial({ color: 0xc68a5c, roughness: 0.6 });
    for (let i = 0; i < 6; i++) {
      const x = -2.7 + i * 1.08;
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.45, 3, 8), suit);
      body.position.set(x, 0.75, -0.55);
      dg.add(body);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), skin);
      head.position.set(x, 1.2, -0.5);
      dg.add(head);
    }
    dg.position.set(side * 9, 0, zLine);
    g.add(dg);
  });
  void away;
  return g;
}

function sky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(700, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: U,
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSkyTop, uSkyHorizon, uSunDir, uSunColor;
      uniform float uTime, uFlood;
      varying vec3 vDir;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y, 0.0, 1.0);
        vec3 c = mix(uSkyHorizon, uSkyTop, pow(h, 0.5));
        vec3 toSun = -uSunDir;
        float s = max(dot(d, normalize(toSun)), 0.0);
        c += uSunColor * (pow(s, 6.0) * 0.25 + pow(s, 80.0) * 0.6);
        // Soft streaky clouds low in the sky, lit by the sun from one side.
        vec2 cp = d.xz / max(0.08, d.y + 0.12) * 1.4 + vec2(uTime * 0.004, 0.0);
        float cl = smoothstep(0.55, 0.85, noise(cp * vec2(0.6, 2.2)) * 0.7 + noise(cp * 2.3) * 0.3);
        cl *= smoothstep(0.02, 0.12, d.y) * (1.0 - smoothstep(0.25, 0.6, d.y));
        vec3 cloudCol = mix(uSkyHorizon * 1.05, uSunColor, pow(s, 3.0) * 0.6);
        c = mix(c, cloudCol, cl * 0.55);
        // Stars come out as it gets dark.
        vec2 sg = floor(vec2(atan(d.z, d.x) * 95.0, d.y * 130.0));
        float star = step(0.9965, hash(sg)) * smoothstep(0.1, 0.35, d.y) * (1.0 - cl);
        float tw = 0.55 + 0.45 * sin(uTime * 2.3 + hash(sg + 1.7) * 30.0);
        c += vec3(0.92, 0.94, 1.0) * star * tw * uFlood * uFlood * 1.2;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const m = new THREE.Mesh(geo, mat);
  // Drawn after the other opaque objects: it's far behind everything, so the depth test
  // skips every pixel the stadium and pitch already cover (nearly all of them in play).
  m.renderOrder = 3;
  m.frustumCulled = false;
  return m;
}


/**
 * Many top-hung banners merged into one mesh (world space). Same cloth as `windCloth`
 * ('top'), but each vertex carries its banner's local coordinates and size (aCloth) and a
 * wind phase (aSeed); the cloth moves along the banner's own facing (its normal).
 */
function batchedCloth<T extends THREE.Material>(mat: T, amp: number): T {
  const orig = mat.onBeforeCompile.bind(mat);
  mat.onBeforeCompile = (shader, r) => {
    orig(shader, r);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform vec2 uWind;
        attribute vec4 aCloth;
        attribute float aSeed;
        float clothZ(vec2 p) {
          vec2 size = aCloth.zw;
          float f = clamp((size.y * 0.5 - p.y) / size.y, 0.0, 1.0);
          float wind = length(uWind);
          float seed = aSeed;
          float gust = 0.55 + 0.45 * sin(uTime * 0.53 + seed) * sin(uTime * 1.31 + seed * 1.7);
          float t = uTime * (2.0 + wind * 1.6);
          float s = p.x * 1.6;
          float wave = sin(s - t + seed) * 0.62
            + sin(s * 2.3 - t * 1.8 + p.y * 2.24 + seed * 2.0) * 0.26
            + sin(s * 5.6 - t * 4.1 + p.y * 4.8) * 0.12 * f;
          float belly = 0.22 * f * (0.65 + 0.35 * sin(uTime * 0.9 + seed));
          return ${amp.toFixed(3)} * wind * gust * (pow(f, 1.4) * wave + belly);
        }`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        vec3 clothN = normalize(normal);
        {
          vec3 tng = normalize(cross(vec3(0.0, 1.0, 0.0), clothN));
          float e = 0.03;
          float cz0 = clothZ(aCloth.xy);
          float dzx = (clothZ(aCloth.xy + vec2(e, 0.0)) - cz0) / e;
          float dzy = (clothZ(aCloth.xy + vec2(0.0, e)) - cz0) / e;
          objectNormal = normalize(clothN - dzx * tng - dzy * vec3(0.0, 1.0, 0.0));
        }`,
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += clothN * clothZ(aCloth.xy);');
  };
  const key = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `${key()}|batched-cloth:${amp}`;
  return mat;
}

/**
 * Supporters' banners hung over the railings at the front of the lower tier, plus the
 * ultras' giant drop banner over the hospitality band behind the home goal.
 */
function banners(path: PathPt[], home: number, away: number, club: StadiumClub): THREE.Mesh {
  const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
  let crest: CanvasImageSource | null = null;
  const W = '#f3eee2';
  const N = '#14123a';
  const straights = [0, 1, 2].map((z) => path.filter((p) => p.zone === z && (z === 0 ? p.nz === -1 : Math.abs(p.nx) === 1)));
  // [text, bg, fg, width, height, style, where]
  // `crests`: the club crest painted at both ends.
  type Spec = { text: string; bg: string; fg: string; w: number; h: number; style: number; p: PathPt; o: number; y: number; crests?: boolean };
  const specs: Spec[] = [];
  const rail = (text: string, bg: string, fg: string, w: number, style: number, zone: number, f: number, crests = false) => {
    const pts = straights[zone];
    specs.push({ text, bg, fg, w, h: 1.35, style, p: pts[Math.min(pts.length - 1, Math.floor(f * pts.length))], o: -0.08, y: 0.72, crests });
  };
  rail('CURVA ROSSA', hex(home), W, 15, 1, 1, 0.22);
  rail('ULTRAS 1903', N, hex(home), 11, 0, 1, 0.5, true);
  rail('SEMPRE CON VOI', W, hex(home), 14, 2, 1, 0.8, true);
  rail((club.name ?? 'ROSSONERI').toUpperCase(), hex(home), W, 13, 0, 0, 0.12, true);
  rail('GAMENIGHT', N, '#ffd447', 11, 2, 0, 0.36);
  rail('BIG NIGHT', W, N, 9, 1, 0, 0.6);
  rail('ATLANTIC 1903', hex(away), N, 13, 0, 0, 0.86);
  rail('ROVERS TILL I DIE', N, hex(away), 15, 1, 2, 0.3);
  rail('AWAY DAYS', hex(away), W, 10, 2, 2, 0.72);
  // The drop banner over the boxes in the home end.
  const end = straights[1][Math.floor(straights[1].length / 2)];
  const motto = club.motto;
  specs.push({ text: (motto?.text || 'ONE CLUB · ONE NIGHT').toUpperCase(), bg: motto ? hex(motto.bg) : hex(home), fg: motto ? hex(motto.fg) : W, w: 34, h: 4.2, style: 2, p: end, o: 20.9, y: 15.8 - 2.1, crests: true });

  // All artwork in one atlas (rows of 512 px), so every banner is one draw together.
  const rows = specs.map((sp) => Math.max(32, Math.round((512 * sp.h) / sp.w / 4) * 4));
  const AH = 1024;
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = AH;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const tops: number[] = [];
  rows.reduce((y, h) => (tops.push(y), y + h), 0);
  const paint = (c: CanvasRenderingContext2D, sp: Spec, H: number) => {
    c.fillStyle = sp.bg;
    c.fillRect(0, 0, 512, H);
    c.fillStyle = sp.fg;
    if (sp.style === 0) {
      c.fillRect(0, H * 0.07, 512, H * 0.06);
      c.fillRect(0, H * 0.87, 512, H * 0.06);
    } else if (sp.style === 1) {
      // Diagonal stripes at the ends.
      for (let x = 0; x < 70; x += 18) {
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x + 9, 0);
        c.lineTo(x + 9 - H * 0.4, H);
        c.lineTo(x - H * 0.4, H);
        c.fill();
        c.beginPath();
        c.moveTo(512 - x, 0);
        c.lineTo(503 - x, 0);
        c.lineTo(503 - x + H * 0.4, H);
        c.lineTo(512 - x + H * 0.4, H);
        c.fill();
      }
    } else {
      c.strokeStyle = sp.fg;
      c.lineWidth = H * 0.06;
      c.strokeRect(H * 0.08, H * 0.08, 512 - H * 0.16, H * 0.84);
    }
    c.font = `800 ${Math.round(H * 0.62)}px "Barlow Condensed", "Arial Narrow", sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const withCrest = sp.crests && crest;
    const maxW = 512 - (sp.style === 1 ? 150 : 40) - (withCrest ? H * 1.6 : 0);
    if (withCrest) {
      drawCrest(c, crest!, H * 0.62, H * 0.53, H * 0.8);
      drawCrest(c, crest!, 512 - H * 0.62, H * 0.53, H * 0.8);
    }
    // Hand-painted lettering: a dark outline under the paint so it reads from afar.
    c.lineJoin = 'round';
    c.lineWidth = H * 0.07;
    c.strokeStyle = 'rgba(10, 10, 20, 0.55)';
    c.strokeText(sp.text, 256, H * 0.56, maxW);
    c.fillText(sp.text, 256, H * 0.56, maxW);
    // Fabric: a fine weave and a little uneven dye.
    let seed = sp.text.length * 97 + H;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 900; i++) {
      c.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)';
      c.fillRect(rnd() * 512, rnd() * H, 1 + rnd() * 3, 1);
    }
    const shade = c.createLinearGradient(0, 0, 512, 0);
    shade.addColorStop(0, 'rgba(0,0,0,0.08)');
    shade.addColorStop(0.5, 'rgba(255,255,255,0.04)');
    shade.addColorStop(1, 'rgba(0,0,0,0.1)');
    c.fillStyle = shade;
    c.fillRect(0, 0, 512, H);
    // Top hem with eyelets where it's tied to the railing.
    c.fillStyle = 'rgba(0,0,0,0.22)';
    c.fillRect(0, 0, 512, Math.max(3, H * 0.05));
    for (let x = 14; x < 512; x += 62) {
      c.beginPath();
      c.arc(x, Math.max(3, H * 0.05) * 0.55, Math.max(1.5, H * 0.018), 0, Math.PI * 2);
      c.fillStyle = '#c9c4b8';
      c.fill();
    }
  };
  const draw = () => {
    const c = cv.getContext('2d')!;
    specs.forEach((sp, i) => {
      c.save();
      c.translate(0, tops[i]);
      c.beginPath();
      c.rect(0, 0, 512, rows[i]);
      c.clip();
      paint(c, sp, rows[i]);
      c.restore();
    });
    tex.needsUpdate = true;
  };
  draw();
  void document.fonts?.ready.then(draw);
  void club.crest?.then((img) => ((crest = img), draw()));

  // One merged mesh: each banner placed in the world, uvs into its atlas row, and its own
  // cloth coordinates (local x/y, size) and wind phase for the shader.
  const geos = specs.map((sp, i) => {
    const g = new THREE.PlaneGeometry(sp.w, sp.h, 24, 3);
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    const cloth = new Float32Array(pos.count * 4);
    const seed = new Float32Array(pos.count).fill(i * 1.71);
    const v0 = 1 - (tops[i] + rows[i]) / AH;
    const v1 = 1 - tops[i] / AH;
    for (let k = 0; k < pos.count; k++) {
      cloth.set([pos.getX(k), pos.getY(k), sp.w, sp.h], k * 4);
      uv.setY(k, v0 + uv.getY(k) * (v1 - v0));
    }
    g.setAttribute('aCloth', new THREE.BufferAttribute(cloth, 4));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-sp.p.nx, -sp.p.nz));
    return g.applyMatrix4(new THREE.Matrix4().compose(at(sp.p, sp.o, sp.y), q, new THREE.Vector3(1, 1, 1)));
  });
  const mat = batchedCloth(litMaterial({ roughness: 0.9 }), 0.22);
  mat.map = tex;
  mat.side = THREE.DoubleSide;
  return new THREE.Mesh(mergeGeometries(geos)!, mat);
}

/**
 * The player's photo as a fan-made banner held up on two poles: a big one in the middle of
 * the ultras' end (right in the goal crowd shot) and a smaller one in the far stand.
 */
function fanBanners(path: PathPt[], home: number): { group: THREE.Group; set(photo: CanvasImageSource | null): void } {
  const group = new THREE.Group();
  group.visible = false;
  const cv = document.createElement('canvas');
  cv.width = 680;
  cv.height = 360;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const poleMat = litMaterial({ color: 0x2a2a2e, roughness: 0.6 });
  const hold = (p: PathPt, o: number, w: number) => {
    const h = w / 2;
    const tierH = LOWER[0][1] + ((o - LOWER[0][0]) / (LOWER[1][0] - LOWER[0][0])) * (LOWER[1][1] - LOWER[0][1]);
    const g = new THREE.Group();
    const mat = windCloth(litMaterial({ roughness: 0.85 }), 0.16, 'sides', w, h);
    mat.map = tex;
    mat.side = THREE.DoubleSide;
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(w, h, 24, 12), mat);
    cloth.position.y = 1.6 + h / 2;
    g.add(cloth);
    for (const sx of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.08, h + 1.9, 0.08), poleMat);
      pole.position.set((sx * w) / 2, (h + 1.9) / 2, 0.02);
      g.add(pole);
    }
    g.position.copy(at(p, o, tierH));
    // Facing the pitch, leaning back a little with the rake.
    g.rotation.set(-0.12, Math.atan2(-p.nx, -p.nz), 0, 'YXZ');
    group.add(g);
  };
  const end = path.filter((p) => p.zone === 1 && p.nx === -1);
  hold(end[Math.floor(end.length / 2)], 6.5, 10);
  const far = path.filter((p) => p.zone === 0 && p.nz === -1);
  hold(far[Math.floor(far.length * 0.38)], 4, 8);
  const hex = '#' + home.toString(16).padStart(6, '0');
  return {
    group,
    set(photo) {
      group.visible = photo !== null;
      if (!photo) return;
      const g = cv.getContext('2d')!;
      // Painted cloth border in the club colour with white stitching, photo inside.
      g.fillStyle = hex;
      g.fillRect(0, 0, 680, 360);
      g.drawImage(photo, 20, 20, 640, 320);
      g.strokeStyle = '#f3eee2';
      g.lineWidth = 4;
      g.setLineDash([14, 8]);
      g.strokeRect(9, 9, 662, 342);
      tex.needsUpdate = true;
    },
  };
}

export function createStadium(homeColor: number, awayColor: number, club: StadiumClub = {}): Stadium {
  const group = new THREE.Group();
  group.add(sky());

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), litMaterial({ color: 0x6f7262, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  // Under/behind everything: draw after the stands and players so covered pixels are skipped.
  ground.renderOrder = 2;
  group.add(ground);
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(PITCH.length + 30, PITCH.width + 26), litMaterial({ color: 0x4f6a3c, roughness: 0.95 }));
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.02;
  apron.receiveShadow = true;
  apron.renderOrder = 2;
  group.add(apron);

  // ---- the stands
  const path = bowlPath();
  const { left, main, right } = splitPath(path);
  const ends = [left, right];
  const concrete = litMaterial({ color: 0x8b8f96, roughness: 0.9 });
  concrete.side = THREE.DoubleSide;
  const darkConcrete = litMaterial({ color: 0x5c6068, roughness: 0.9 });
  darkConcrete.side = THREE.DoubleSide;
  const roofMat = roofMaterial(0x30353d);
  const panels = litMaterial({ color: 0xaab6c0, roughness: 0.3, metalness: 0.1, emissive: 0x151a20 });
  panels.side = THREE.DoubleSide;
  const fascia = fasciaMaterial(homeColor, club.name ?? 'GAMENIGHT');
  const roofLight = new THREE.MeshBasicMaterial({ color: 0xfff1d6, toneMapped: false, side: THREE.DoubleSide });
  const ribbon = ribbonMaterial(homeColor);
  const glass = glassMaterial();
  const curtain = curtainMaterial();
  const seat = new THREE.Color(homeColor).multiplyScalar(0.62).getHex();

  const homeU = zoneRange(path, LOWER[0][0], 1);
  const lowerSlope = Math.hypot(LOWER[1][0] - LOWER[0][0], LOWER[1][1] - LOWER[0][1]);
  const lowerCrowd = crowdMaterial({
    home: homeColor,
    away: awayColor,
    shade: [9, 17],
    seat,
    aisles: [15, 1.1],
    voms: [30, 7.2, 10.2],
    tifo: { tex: tifoTexture(homeColor, club), rect: new THREE.Vector4(homeU[0] + 1, homeU[1] - 1, 0.6, lowerSlope - 0.4) },
  });
  const upperCrowd = crowdMaterial({ home: homeColor, away: awayColor, shade: [-2, 10], stripes: true, seat, aisles: [15, 1.1] });
  // The main stand's top tier: the club name spelled out in white seats along the back rows.
  const mainLen = Math.hypot(main[main.length - 1].x - main[0].x, main[main.length - 1].z - main[0].z);
  const topSlope = Math.hypot(TOP[1][0] - TOP[0][0], TOP[1][1] - TOP[0][1]);
  const topCrowd = crowdMaterial({
    home: homeColor,
    away: awayColor,
    shade: [-2, 6],
    seat,
    aisles: [15, 1.1],
    fill: 0.9,
    letters: { tex: lettersTexture(club.name ?? 'GAMENIGHT'), rect: new THREE.Vector4(mainLen * 0.08, mainLen * 0.92, topSlope * 0.5, topSlope * 0.92) },
  });

  // Strips sharing a material are merged: one draw per material for the whole ground.
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const add = (mat: THREE.Material, g: THREE.BufferGeometry) => {
    const list = byMat.get(mat) ?? [];
    list.push(g);
    byMat.set(mat, list);
  };
  const strip = (pts: PathPt[], a: [number, number], b: [number, number], mat: THREE.Material) => add(mat, ringStrip(pts, a, b));

  // Lower and middle tiers all the way round (ends, corners and the main stand alike).
  strip(path, [0, 0], [0, 1.4], ribbon); // LED boards on the stand front
  strip(path, [0, 1.4], LOWER[0], concrete);
  strip(path, LOWER[0], LOWER[1], lowerCrowd);
  strip(path, LOWER[1], [22, 11.5], concrete);
  strip(path, [22, 11.5], [22, 14.5], glass); // executive boxes
  strip(path, [22, 14.5], [21, 14.5], concrete);
  strip(path, [21, 14.5], [21, 15.8], ribbon); // balcony LED
  strip(path, [21, 15.8], UPPER[0], concrete);
  strip(path, UPPER[0], UPPER[1], upperCrowd);

  // Ends and corners: back wall and the lower roof.
  const roofPanelO = ROOF_EDGE + 5;
  for (const pts of ends) {
    strip(pts, UPPER[1], [38, 32.5], darkConcrete);
    strip(pts, [38, 32.5], ROOF_BACK, darkConcrete);
    strip(pts, ROOF_BACK, [roofPanelO, roofAt(ROOF_BACK, ROOF_EDGE, ROOF_H, roofPanelO)], roofMat);
    strip(pts, [roofPanelO, roofAt(ROOF_BACK, ROOF_EDGE, ROOF_H, roofPanelO)], [ROOF_EDGE, ROOF_H], panels);
    strip(pts, [ROOF_EDGE, ROOF_H - 2.2], [ROOF_EDGE, ROOF_H], fascia); // bottom up, so the lettering stands upright
    strip(pts, [ROOF_EDGE + 0.3, ROOF_H - 2.25], [ROOF_EDGE + 3, ROOF_H - 2.05], roofLight);
  }

  // The main stand rises on: second boxes, the top tier, the high roof.
  const mainPanelO = MAIN_EDGE + 6;
  strip(main, UPPER[1], [40, 28.5], concrete);
  strip(main, [40, 28.5], [40, 31.3], glass);
  strip(main, [40, 31.3], [39.2, 31.3], concrete);
  strip(main, [39.2, 31.3], [39.2, 32.4], ribbon);
  strip(main, [39.2, 32.4], TOP[0], concrete);
  strip(main, TOP[0], TOP[1], topCrowd);
  strip(main, TOP[1], [58, 50], darkConcrete);
  strip(main, [58, 50], MAIN_BACK, darkConcrete);
  strip(main, MAIN_BACK, [mainPanelO, roofAt(MAIN_BACK, MAIN_EDGE, MAIN_H, mainPanelO)], roofMat);
  strip(main, [mainPanelO, roofAt(MAIN_BACK, MAIN_EDGE, MAIN_H, mainPanelO)], [MAIN_EDGE, MAIN_H], panels);
  strip(main, [MAIN_EDGE, MAIN_H - 2.4], [MAIN_EDGE, MAIN_H], fascia);
  strip(main, [MAIN_EDGE + 0.3, MAIN_H - 2.45], [MAIN_EDGE + 3.4, MAIN_H - 2.2], roofLight);

  // Open near ends of the corners: the section in concrete.
  add(darkConcrete, caps([path[0], path[path.length - 1]], [
    [0, 0], [0, 1.4], [0.4, 1.4], [20, 11.5], [22, 11.5], [22, 14.5], [21, 14.5], [21, 15.8], [21.5, 15.8], [38, 28.5], [38, 32.5], [40, 33.2], [42, 33.2], [42, 0],
  ]));
  // The main stand's flanks above the corner roofs: glazed curtain walls.
  add(curtain, caps([main[0], main[main.length - 1]], [
    [38, 0], [60, 0], [60, MAIN_BACK[1]], [MAIN_EDGE, MAIN_H], [MAIN_EDGE, roofAt(ROOF_BACK, ROOF_EDGE, ROOF_H, MAIN_EDGE) + 0.2], [38, 33.2],
  ]));
  for (const [mat, geos] of byMat) group.add(new THREE.Mesh(geos.length > 1 ? mergeGeometries(geos)! : geos[0], mat));

  // ---- steel: girders riding on top of the roofs, posts down to the sheeting. Beams and
  // posts only (a Vierendeel frame), one instanced draw for the whole ground.
  const steel = litMaterial({ color: 0x4a5058, roughness: 0.55, metalness: 0.3 });
  const beams: THREE.Matrix4[] = [];
  const zAxis = new THREE.Vector3(0, 0, 1);
  const q = new THREE.Quaternion();
  const beam = (a: THREE.Vector3, b: THREE.Vector3, w: number, h: number) => {
    const len = a.distanceTo(b);
    if (len < 0.05) return;
    q.setFromUnitVectors(zAxis, b.clone().sub(a).normalize());
    beams.push(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(w, h, len)));
  };
  const girders = (pts: PathPt[], back: [number, number], edge: number, h: number, every: number, lift: number) => {
    const offs = [back[0] - 1, (back[0] + edge) * 0.5, edge + 2];
    const tops: THREE.Vector3[][] = [];
    pts.forEach((p, i) => {
      if (i % every !== 0 && i !== pts.length - 1) return;
      const row = offs.map((o) => at(p, o, roofAt(back, edge, h, o) + lift));
      // Transverse girder above the roof, and its posts down to the sheet.
      beam(row[0], row[2], 0.45, 0.9);
      for (let k = 0; k < offs.length; k++) beam(row[k], at(p, offs[k], roofAt(back, edge, h, offs[k])), 0.3, 0.3);
      tops.push(row);
    });
    // Longitudinal chords tying the girders together.
    for (let i = 1; i < tops.length; i++) for (let k = 0; k < 3; k++) beam(tops[i - 1][k], tops[i][k], 0.35, 0.6);
  };
  for (const pts of ends) girders(pts, ROOF_BACK, ROOF_EDGE, ROOF_H, 3, 2.6);
  girders(main, MAIN_BACK, MAIN_EDGE, MAIN_H, 3, 3.4);
  const steelMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), steel, beams.length);
  beams.forEach((m, i) => steelMesh.setMatrixAt(i, m));
  steelMesh.instanceMatrix.needsUpdate = true;
  group.add(steelMesh);

  // Floodlight lamps along the roof fronts.
  const tmpA = new THREE.Vector3();
  const lampGeo = new THREE.PlaneGeometry(3.4, 1.1);
  const lampMat = lampMaterial();
  for (const [pts, edge, h] of [[left, ROOF_EDGE, ROOF_H], [right, ROOF_EDGE, ROOF_H], [main, MAIN_EDGE, MAIN_H]] as [PathPt[], number, number][]) {
    group.add(
      alongRoof(pts, 2, lampGeo, lampMat, (p, m) => {
        at(p, edge + 1.2, h - 2.7, tmpA);
        // Face the centre of the pitch, tilted down.
        const e = new THREE.Euler(-0.75, Math.atan2(-p.nx, -p.nz), 0, 'YXZ');
        m.compose(tmpA, q.setFromEuler(e), new THREE.Vector3(1, 1, 1));
      }),
    );
  }

  // ---- fixtures: TV gantry under the main roof, big screens in the corners, the paddock.
  const fixtures = new THREE.Group();
  const gantryMat = litMaterial({ color: 0x23272e, roughness: 0.6 });
  const mid = main[Math.floor(main.length / 2)];
  const gantry = new THREE.Mesh(new THREE.BoxGeometry(34, 1.6, 2.2), gantryMat);
  gantry.position.copy(at(mid, MAIN_EDGE + 9, roofAt(MAIN_BACK, MAIN_EDGE, MAIN_H, MAIN_EDGE + 9) - 2.6));
  fixtures.add(gantry);
  for (let k = -3; k <= 3; k++) {
    const cam = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.6, 1.1), gantryMat);
    cam.position.copy(gantry.position).add(new THREE.Vector3(k * 4.6, 1.1, 0.6));
    fixtures.add(cam);
  }
  const screenMat = screenMaterial(club, homeColor);
  const corners = [left, right].map((pts) => {
    // The corner quadrant's middle: where the path normal is diagonal.
    return pts.reduce((b, p) => (Math.abs(Math.abs(p.nx) - Math.abs(p.nz)) < Math.abs(Math.abs(b.nx) - Math.abs(b.nz)) && p.nz < 0 ? p : b), pts[Math.floor(pts.length / 2)]);
  });
  for (const p of corners) {
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(10.5, 5.9), screenMat);
    scr.position.copy(at(p, ROOF_EDGE + 2.5, ROOF_H - 6.2));
    scr.rotation.set(-0.2, Math.atan2(-p.nx, -p.nz), 0, 'YXZ');
    scr.userData.live = true;
    fixtures.add(scr);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(11.2, 6.5, 0.5), gantryMat);
    frame.position.copy(scr.position).addScaledVector(new THREE.Vector3(p.nx, 0, p.nz), 0.3);
    frame.rotation.copy(scr.rotation);
    fixtures.add(frame);
  }
  group.add(bakeStatic(fixtures));

  // The paddock on the near side, under the camera: a low open terrace and its wall.
  const near: PathPt[] = [];
  const cxN = BOWL_X - BOWL_R - 8;
  for (let x = -cxN; x <= cxN + 0.01; x += 4) near.push({ x, z: BOWL_Z, nx: 0, nz: 1, zone: 0 });
  const paddockCrowd = crowdMaterial({ home: homeColor, away: awayColor, shade: [99, 100], seat, aisles: [15, 1.1], fill: 0.85 });
  const paddock = new Map<THREE.Material, THREE.BufferGeometry[]>([
    [ribbon, [ringStrip(near, [0, 0], [0, 1.2])]],
    [concrete, [ringStrip(near, [0, 1.2], [0.4, 1.2]), ringStrip(near, [11, 5.6], [11, 7.4]), caps([near[0], near[near.length - 1]], [[0, 0], [0, 1.2], [0.4, 1.2], [11, 5.6], [11, 7.4], [12, 7.4], [12, 0]])]],
    [paddockCrowd, [ringStrip(near, [0.4, 1.2], [11, 5.6])]],
  ]);
  for (const [mat, geos] of paddock) group.add(new THREE.Mesh(mergeGeometries(geos)!, mat));

  const spots = lampSpots();
  // Lamp glows: one instanced, camera-facing quad per bank (one draw for all of them).
  const glowMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    uniforms: { uMap: { value: glowTexture() }, uScale: { value: 16 }, uOpacity: { value: 1 } },
    vertexShader: /* glsl */ `
      uniform float uScale;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mv = viewMatrix * modelMatrix * vec4(instanceMatrix[3].xyz, 1.0);
        mv.xy += position.xy * uScale;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        vec4 t = texture2D(uMap, vUv);
        gl_FragColor = vec4(t.rgb * t.a * uOpacity, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  const glows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), glowMat, spots.length);
  spots.forEach((sp, i) => glows.setMatrixAt(i, new THREE.Matrix4().makeTranslation(sp.x, sp.y, sp.z)));
  glows.frustumCulled = false;
  group.add(glows);

  group.add(adBoards());
  group.add(crowdFlags(path, homeColor, awayColor, club));
  group.add(banners(path, homeColor, awayColor, club));
  group.add(bakeStatic(pitchside(homeColor, awayColor)));
  const shafts = lightShafts(spots);
  group.add(shafts);
  const fan = fanBanners(path, homeColor);
  group.add(fan.group);

  const c = new THREE.Color();
  const c2 = new THREE.Color();
  return {
    group,
    setFanBanner: (photo) => fan.set(photo),
    update(time, excitement, atmo, tifo = 0) {
      U.uTime.value = time;
      U.uExcite.value = excitement;
      U.uTifoOn.value += (tifo - U.uTifoOn.value) * 0.04;
      U.uSkyTop.value.copy(atmo.skyTop);
      U.uSkyHorizon.value.copy(atmo.skyHorizon);
      U.uSunDir.value.copy(atmo.sun.position).negate().normalize();
      U.uSunColor.value.copy(atmo.sun.color);
      const fog = atmo.sun.parent instanceof THREE.Scene ? (atmo.sun.parent.fog as THREE.Fog | null) : null;
      if (fog) U.uFog.value.copy(fog.color);
      U.uHaze.value = atmo.haze;
      // Crowd light: sky + a share of the sun + floodlights.
      const flood = SHARED.uFlood.value;
      c.copy(atmo.hemi.color).multiplyScalar(atmo.hemi.intensity * 0.55);
      c2.copy(atmo.sun.color).multiplyScalar(atmo.sun.intensity * 0.22);
      c.add(c2);
      c2.copy(SHARED.uFloodColor.value).multiplyScalar(flood * 0.6);
      c.add(c2);
      U.uLight.value.copy(c);
      roofLight.color.setRGB(0.25 + flood * 1.4, 0.24 + flood * 1.35, 0.22 + flood * 1.2);
      // The beams are invisible until dusk: don't spend fill on them.
      shafts.visible = flood > 0.02;
      glowMat.uniforms.uOpacity.value = 0.12 + flood * 0.88;
      glowMat.uniforms.uScale.value = 16 + flood * 18;
    },
  };
}
