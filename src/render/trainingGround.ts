import * as THREE from 'three';
import { PITCH } from '../sim/constants';
import { PYLONS, SHARED, litMaterial } from './look';
import { type Stadium, type StadiumClub, bakeStatic, drawCrest, groundPlanes, lampGlows, lampMaterial, pitchside, sky, updateShared } from './stadium';

/**
 * The club's training ground: modern, simple and clean. Open fields under the sky, the
 * training centre along the far side (white cladding, ribbon glazing, a flat roof slab, the
 * club's name over the doors the players walk out of), tall ball-stop nets behind the goals,
 * a low mesh fence round the grass, slim floodlight masts in the corners, two more practice
 * pitches beyond the ends, cones, mannequins and mini goals, and rows of trees. No crowd.
 */
export function createTrainingGround(homeColor: number, awayColor: number, club: StadiumClub = {}): Stadium {
  const group = new THREE.Group();
  group.add(sky());
  const [land, apron] = groundPlanes();
  // Mown fields all round rather than the grey land a stadium stands on.
  (land.material as THREE.MeshStandardMaterial).color.setHex(0x557a3c);
  group.add(land, apron);

  const site = new THREE.Group();
  site.add(pitchside(homeColor, awayColor, true));
  const white = litMaterial({ color: 0xe8eae6, roughness: 0.6 });
  const trim = litMaterial({ color: 0x2b3036, roughness: 0.5, metalness: 0.2 });
  const accent = litMaterial({ color: homeColor, roughness: 0.55 });
  // Dark ribbon glazing: slim pale mullions, a few rooms lit as the evening comes.
  const glazing = litMaterial({
    color: 0x1a232c,
    roughness: 0.3,
    diffuseHook: `{
      vec2 g = vec2(vUv2.x / 1.8, vUv2.y / 3.0);
      float mull = smoothstep(0.86, 0.94, abs(fract(g.x) - 0.5) * 2.0);
      float lit = step(0.7, fract(sin(dot(floor(g), vec2(12.9, 78.2))) * 43758.5));
      diffuseColor.rgb = mix(diffuseColor.rgb + vec3(1.0, 0.8, 0.55) * lit * uFlood * 0.6, vec3(0.78, 0.8, 0.82), mull);
    }`,
  });
  const mast = litMaterial({ color: 0xd9dcdf, roughness: 0.45, metalness: 0.3 });
  const netPole = litMaterial({ color: 0x23332a, roughness: 0.6 });
  const net = new THREE.MeshStandardMaterial({ color: 0x18241d, roughness: 0.9, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false });
  const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    site.add(m);
    return m;
  };
  /** An upright panel facing +z (the pitch), uv in metres (the glazing's mullions are metric). */
  const panel = (w: number, h: number, mat: THREE.Material, x: number, y: number, z: number, rotY = 0) => {
    const g = new THREE.PlaneGeometry(w, h);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * h);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    m.rotation.y = rotY;
    site.add(m);
    return m;
  };

  // ---- the training centre: two storeys along the far side, its doors facing the halfway line
  const front = -(PITCH.halfW + 13);
  const depth = 14;
  box(64, 8.4, depth, white, 0, 4.2, front - depth / 2);
  panel(60, 3, glazing, 0, 1.75, front + 0.15);
  panel(60, 2, glazing, 0, 6.05, front + 0.15);
  box(67, 0.5, depth + 2.6, trim, 0, 8.65, front - depth / 2 + 0.6); // the roof slab
  box(67, 0.12, 0.2, accent, 0, 8.3, front + 1.95); // a club-coloured line under its edge
  // The entrance: a canopy on two slim columns, and a fin in the club's colour beside it.
  box(10, 0.25, 4.2, trim, 0, 3.45, front + 2.1);
  for (const x of [-4.6, 4.6]) box(0.18, 3.4, 0.18, trim, x, 1.7, front + 4);
  box(1.4, 11, 1.4, accent, 7.4, 5.5, front + 0.6);
  // The gym wing: lower, glazed full height.
  box(22, 5.2, 12, white, 43, 2.6, front - 6.5);
  panel(20, 4, glazing, 43, 2.3, front - 0.35);
  box(23.5, 0.4, 13.6, trim, 43, 5.4, front - 6.2);
  // The name over the doors: the crest and "<club> training centre".
  const sign = signMaterial(club, homeColor);
  panel(22.4, 1.4, sign, -0.6, 4.15, front + 0.15);

  // ---- ball-stop nets behind both goals: dark poles, a top rail, mesh between
  const netX = PITCH.halfL + 7;
  const netH = 8;
  for (const s of [-1, 1]) {
    for (let z = -24; z <= 24; z += 6) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, netH, 6), netPole);
      p.position.set(s * netX, netH / 2, z);
      site.add(p);
    }
    box(0.1, 0.1, 48, netPole, s * netX, netH, 0);
    panel(48, netH, net, s * netX, netH / 2, 0, Math.PI / 2);
  }

  // ---- a low mesh fence round the grass (a gap at the far side for the path in)
  const fx = PITCH.halfL + 13;
  const fz = PITCH.halfW + 11;
  const fenceH = 1.2;
  const runs: [number, number, number, number][] = [
    [-fx, fz, fx, fz],
    [-fx, -fz, -fx, fz],
    [fx, -fz, fx, fz],
    [-fx, -fz, -5, -fz],
    [5, -fz, fx, -fz],
  ];
  for (const [x0, z0, x1, z1] of runs) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const rot = Math.atan2(-(z1 - z0), x1 - x0);
    const mx = (x0 + x1) / 2;
    const mz = (z0 + z1) / 2;
    const rail = box(len, 0.06, 0.06, netPole, mx, fenceH, mz);
    rail.rotation.y = rot;
    panel(len, fenceH, net, mx, fenceH / 2, mz, rot);
    const n = Math.round(len / 3);
    for (let i = 0; i <= n; i++) box(0.07, fenceH, 0.07, netPole, x0 + ((x1 - x0) * i) / n, fenceH / 2, z0 + ((z1 - z0) * i) / n);
  }

  // ---- practice pitches beyond both ends
  const practice = practiceMaterial();
  for (const s of [-1, 1]) {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(40, 60), practice);
    g.rotation.x = -Math.PI / 2;
    g.position.set(s * (fx + 30), -0.012, 0);
    site.add(g);
    for (const e of [-1, 1]) miniGoal(site, s * (fx + 30), e * 29.6, e > 0 ? Math.PI : 0, 5, 2, net);
  }

  // ---- on the touchline: cones, a mannequin wall, mini goals
  const cone = litMaterial({ color: 0xff7a1f, roughness: 0.6 });
  const cones = new THREE.InstancedMesh(new THREE.ConeGeometry(0.13, 0.32, 8), cone, 24);
  for (let i = 0; i < 24; i++) {
    const row = i < 12 ? 0 : 1;
    const k = i % 12;
    cones.setMatrixAt(i, new THREE.Matrix4().makeTranslation((row ? 20 : -42) + k * 1.8, 0.16, -(PITCH.halfW + 2.2) - (k % 2) * 1.2));
  }
  site.add(cones);
  const dummy = litMaterial({ color: 0xffd23a, roughness: 0.55 });
  for (let i = 0; i < 4; i++) {
    const x = -28 + i * 0.62;
    box(0.42, 1.55, 0.16, dummy, x, 1.0, -(PITCH.halfW + 4.2));
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), dummy);
    head.position.set(x, 1.92, -(PITCH.halfW + 4.2));
    site.add(head);
    box(0.05, 0.25, 0.05, trim, x, 0.12, -(PITCH.halfW + 4.2));
  }
  for (const x of [-46, 46]) miniGoal(site, x, -(PITCH.halfW + 4.6), 0, 3, 1, net);

  // ---- floodlight masts in the corners: slim tapering poles, a bank of lamps on top
  const HEAD = 24;
  const lamps = new THREE.InstancedMesh(new THREE.PlaneGeometry(5.2, 1.8), lampMaterial(), PYLONS.length);
  const spots: THREE.Vector3[] = [];
  const q = new THREE.Quaternion();
  PYLONS.forEach(([px, pz], k) => {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.45, HEAD, 8), mast);
    p.position.set(px, HEAD / 2, pz);
    site.add(p);
    const e = new THREE.Euler(0.45, Math.atan2(-px, -pz), 0, 'YXZ');
    const fwd = new THREE.Vector3(0, 0, 1).applyEuler(e);
    const c0 = new THREE.Vector3(px, HEAD + 1.2, pz);
    lamps.setMatrixAt(k, new THREE.Matrix4().compose(c0.clone().addScaledVector(fwd, 0.2), q.setFromEuler(e), new THREE.Vector3(1, 1, 1)));
    const back = box(5.6, 2.2, 0.3, trim, c0.x, c0.y, c0.z);
    back.quaternion.setFromEuler(e);
    spots.push(c0.clone().addScaledVector(fwd, 1.2));
  });
  lamps.instanceMatrix.needsUpdate = true;
  site.add(lamps);

  // ---- trees: rows round the site, a little irregular
  site.add(trees());

  group.add(bakeStatic(site));
  const glows = lampGlows(spots, 0.8);
  group.add(glows.mesh);
  return {
    group,
    setFanBanner: () => {},
    setNearStand: () => {},
    update(time, excitement, atmo) {
      const flood = updateShared(time, excitement, atmo);
      glows.update(flood);
      // No stand: no shadow across the pitch.
      SHARED.uShadowZ0.value = 1e4;
    },
  };
}

/** A small goal: a white frame (posts, bar, the base behind) and its net. Faces +z at rotY 0. */
function miniGoal(g: THREE.Group, x: number, z: number, rotY: number, w: number, h: number, net: THREE.Material): void {
  const frame = litMaterial({ color: 0xf4f4f0, roughness: 0.4 });
  const goal = new THREE.Group();
  const bar = (bw: number, bh: number, bd: number, px: number, py: number, pz: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), frame);
    m.position.set(px, py, pz);
    goal.add(m);
  };
  const d = h * 0.8;
  bar(0.08, h, 0.08, -w / 2, h / 2, 0);
  bar(0.08, h, 0.08, w / 2, h / 2, 0);
  bar(w + 0.08, 0.08, 0.08, 0, h, 0);
  bar(w + 0.08, 0.06, 0.06, 0, 0.03, -d);
  bar(0.06, 0.06, d, -w / 2, 0.03, -d / 2);
  bar(0.06, 0.06, d, w / 2, 0.03, -d / 2);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(w, Math.hypot(h, d)), net);
  back.position.set(0, h / 2, -d / 2);
  back.rotation.x = Math.atan2(d, h);
  goal.add(back);
  goal.position.set(x, 0, z);
  goal.rotation.y = rotY;
  g.add(goal);
}

/** Round trees in rows beyond the fences: one instanced draw for the crowns, one for the trunks. */
function trees(): THREE.Group {
  const spots: [number, number, number][] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let x = -150; x <= 150; x += 8) {
    spots.push([x + rnd() * 3, 66 + rnd() * 6, 0.8 + rnd() * 0.5]);
    spots.push([x + rnd() * 3, -84 - rnd() * 8, 0.9 + rnd() * 0.6]);
  }
  for (let z = -60; z <= 60; z += 8) {
    for (const s of [-1, 1]) spots.push([s * (140 + rnd() * 6), z + rnd() * 3, 0.8 + rnd() * 0.5]);
  }
  const crownMat = litMaterial({ roughness: 0.9 });
  const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(3.2, 1), crownMat, spots.length);
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.35, 3, 6), litMaterial({ color: 0x4a3a2c, roughness: 0.9 }), spots.length);
  const c = new THREE.Color();
  const greens = [0x2f5a2a, 0x3b6b30, 0x2a4f2c, 0x45763a];
  spots.forEach(([x, z, s], i) => {
    crowns.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(x, 3 + 3.6 * s, z), new THREE.Quaternion(), new THREE.Vector3(s, s * 1.15, s)));
    crowns.setColorAt(i, c.setHex(greens[i % greens.length]));
    trunks.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(x, 1.5 * s, z), new THREE.Quaternion(), new THREE.Vector3(s, s, s)));
  });
  const g = new THREE.Group();
  g.add(crowns, trunks);
  return g;
}

/** A practice pitch, 40 x 60 m: mown stripes and white lines (half-way, boxes, centre circle). */
function practiceMaterial(): THREE.MeshStandardMaterial {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 384;
  const g = cv.getContext('2d')!;
  const px = 256 / 40; // pixels per metre
  for (let i = 0; i < 10; i++) {
    g.fillStyle = i % 2 ? '#4f7f3a' : '#578a40';
    g.fillRect(0, (i * 384) / 10, 256, 384 / 10 + 1);
  }
  g.strokeStyle = '#eef2ea';
  g.lineWidth = 2;
  const m = 1.5 * px;
  g.strokeRect(m, m, 256 - 2 * m, 384 - 2 * m);
  g.beginPath();
  g.moveTo(m, 192);
  g.lineTo(256 - m, 192);
  g.stroke();
  g.beginPath();
  g.arc(128, 192, 6 * px, 0, Math.PI * 2);
  g.stroke();
  for (const y of [m, 384 - m]) g.strokeRect(128 - 8 * px, y === m ? m : y - 6 * px, 16 * px, 6 * px);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = litMaterial({ roughness: 0.95 });
  mat.map = tex;
  return mat;
}

/** The sign over the training centre's doors: the crest, then "<CLUB> TRAINING CENTRE". */
function signMaterial(club: StadiumClub, home: number): THREE.MeshStandardMaterial {
  const cv = document.createElement('canvas');
  cv.width = 1024;
  cv.height = 64;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  let crest: CanvasImageSource | null = null;
  const draw = () => {
    const g = cv.getContext('2d')!;
    g.fillStyle = '#e8eae6';
    g.fillRect(0, 0, 1024, 64);
    if (crest) drawCrest(g, crest, 360, 32, 58);
    g.fillStyle = '#' + new THREE.Color(home).getHexString();
    g.fillRect(392, 14, 5, 36);
    g.fillStyle = '#23282e';
    g.font = '800 40px "Barlow Condensed", "Arial Narrow", sans-serif';
    g.textBaseline = 'middle';
    g.fillText(`${(club.name ?? 'GameNight').toUpperCase()}  TRAINING CENTRE`, 410, 34, 600);
    tex.needsUpdate = true;
  };
  draw();
  void document.fonts?.ready.then(draw);
  void club.crest?.then((img) => ((crest = img), draw()));
  const m = litMaterial({ roughness: 0.6 });
  m.map = tex;
  return m;
}
