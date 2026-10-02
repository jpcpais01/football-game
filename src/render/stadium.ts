import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PITCH } from '../sim/constants';
import type { Atmosphere } from './atmosphere';
import { PYLONS, SHARED, litMaterial } from './look';

/**
 * Old-ground-meets-modern stadium: four separate stands with open corners, floodlight
 * pylons, flags, LED boards and a distant skyline. The crowd is drawn procedurally in the
 * stand shader (thousands of fans for one draw call per stand) and is lit by the same
 * evening light as everything else.
 */

export interface Stadium {
  group: THREE.Group;
  update(time: number, excitement: number, atmo: Atmosphere): void;
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
};

function crowdMaterial(sectionA: number, sectionB: number, mixAB: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...U,
      uA: { value: new THREE.Color(sectionA) },
      uB: { value: new THREE.Color(sectionB) },
      uMix: { value: mixAB },
    },
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
      precision highp float;
      varying vec2 vUv;
      varying float vDist;
      uniform float uTime, uExcite, uMix, uFogNear, uFogFar, uFlood;
      uniform vec3 uA, uB, uFog, uLight;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 15731.743); }

      vec3 shirt(vec2 cell) {
        float h = hash(cell + 7.1);
        float team = step(hash(cell * 0.37 + floor(cell.x / 14.0)), uMix);
        vec3 tc = mix(uA, uB, team);
        if (h < 0.55) return tc * (0.75 + 0.25 * hash(cell + 2.0));
        if (h < 0.68) return vec3(0.78, 0.76, 0.71);
        if (h < 0.8) return vec3(0.2, 0.21, 0.24);
        if (h < 0.9) return vec3(0.32, 0.37, 0.45);
        return vec3(0.48, 0.43, 0.36);
      }

      void main() {
        vec2 seat = vec2(0.62, 0.82);
        vec2 g = vUv / seat;
        vec2 cell = floor(g);
        vec2 f = fract(g);
        float occ = step(hash(cell), 0.9);
        float ph = hash(cell + 3.3) * 6.283;
        float jump = max(0.0, sin(uTime * (7.0 + hash(cell + 1.1) * 3.0) + ph)) * uExcite * uExcite * 0.22;
        float sway = sin(uTime * 1.3 + ph) * 0.03;
        vec2 q = f - vec2(0.5 + sway, 0.0) - vec2(0.0, jump);
        float body = step(abs(q.x), 0.3) * step(0.08, q.y) * step(q.y, 0.62);
        float head = step(length((q - vec2(0.0, 0.74)) * vec2(1.0, 1.25)), 0.16);
        vec3 seatCol = vec3(0.2, 0.23, 0.29) * (0.9 + 0.2 * step(0.5, fract(cell.y * 0.5)));
        vec3 skin = mix(vec3(0.93, 0.76, 0.6), vec3(0.42, 0.28, 0.18), hash(cell + 9.2));
        vec3 c = seatCol;
        c = mix(c, shirt(cell), body * occ);
        c = mix(c, skin, head * occ);
        // Upper rows sit under the roof.
        c *= 0.95 - 0.35 * smoothstep(12.0, 30.0, vUv.y);

        float px = max(fwidth(g.x), fwidth(g.y));
        vec3 avg = mix(seatCol, mix(uA, uB, uMix) * 0.6 + 0.1, 0.55);
        c = mix(c, avg, smoothstep(0.2, 0.7, px));
        // Keep the stands calm: soften contrast toward their average colour.
        c = mix(c, avg, 0.3);

        c = pow(c, vec3(2.2)) * uLight;
        // Phone cameras flashing once it's dark.
        float tw = step(0.9965, hash(cell + floor(uTime * 3.0 + hash(cell) * 10.0)));
        c += vec3(1.0, 0.97, 0.9) * tw * occ * uFlood * 1.6 * (1.0 - smoothstep(0.5, 1.2, px));

        // Atmospheric haze: the background sits back behind the play.
        float fog = smoothstep(uFogNear, uFogFar, vDist);
        c = mix(c, uFog, 0.18 + fog * 0.7);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

/** Raked seating deck: a ramp from (0, h0) at the front to (depth, h1) at the back. */
function deck(length: number, depth: number, h0: number, h1: number, mat: THREE.Material): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  const slope = Math.hypot(depth, h1 - h0);
  const hl = length / 2;
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-hl, h0, 0, hl, h0, 0, hl, h1, -depth, -hl, h1, -depth]), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, length, 0, length, slope, 0, slope]), 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat);
}

interface StandMats {
  struct: THREE.Material;
  roof: THREE.Material;
  roofLight: THREE.Material;
}

function stand(length: number, depth: number, h0: number, h1: number, roofH: number, crowd: THREE.ShaderMaterial, mats: StandMats, fasciaColor: number): THREE.Group {
  const g = new THREE.Group();
  g.add(deck(length, depth, h0, h1, crowd));
  const wall = new THREE.Mesh(new THREE.BoxGeometry(length, h0, 0.4), mats.struct);
  wall.position.set(0, h0 / 2, 0.2);
  g.add(wall);
  const back = new THREE.Mesh(new THREE.BoxGeometry(length + 0.5, roofH + 1, 0.8), mats.struct);
  back.position.set(0, (roofH + 1) / 2, -depth - 0.4);
  g.add(back);
  for (const s of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.6, roofH, depth), mats.struct);
    side.position.set((s * (length + 0.6)) / 2, roofH / 2, -depth / 2);
    g.add(side);
  }
  const roofDepth = depth * 0.92;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(length + 1, 0.7, roofDepth), mats.roof);
  roof.position.set(0, roofH, -depth + roofDepth / 2);
  g.add(roof);
  const fascia = new THREE.Mesh(new THREE.BoxGeometry(length + 1.2, 1.6, 0.3), litMaterial({ color: fasciaColor, roughness: 0.6 }));
  fascia.position.set(0, roofH - 0.2, -depth + roofDepth + 0.1);
  g.add(fascia);
  // A strip of roof lights under the fascia that glows in the evening.
  const strip = new THREE.Mesh(new THREE.BoxGeometry(length - 2, 0.12, 0.5), mats.roofLight);
  strip.position.set(0, roofH - 1.05, -depth + roofDepth - 0.4);
  g.add(strip);
  const nPost = Math.max(2, Math.round(length / 22));
  for (let i = 0; i <= nPost; i++) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, roofH, 0.35), mats.struct);
    post.position.set(-length / 2 + (i * length) / nPost, roofH / 2, -depth * 0.25);
    g.add(post);
  }
  return g;
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

function pylon(lampMat: THREE.ShaderMaterial, glows: THREE.Sprite[]): THREE.Group {
  const g = new THREE.Group();
  const mat = litMaterial({ color: 0x5a5f66, roughness: 0.6 });
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.9, 42, 8), mat);
  mast.position.y = 21;
  g.add(mast);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(7, 4.5, 0.6), mat);
  frame.position.set(0, 43, 0);
  g.add(frame);
  const lamps = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 3.9), lampMat);
  lamps.position.set(0, 43, 0.31);
  g.add(lamps);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, fog: false }));
  glow.position.set(0, 43, 1.5);
  glow.scale.setScalar(26);
  g.add(glow);
  glows.push(glow);
  return g;
}

function lampMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uFlood: SHARED.uFlood },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec2 vUv; uniform float uFlood; void main(){
      vec2 g = fract(vUv * vec2(6.0, 4.0)) - 0.5;
      float l = 1.0 - smoothstep(0.22, 0.42, length(g));
      vec3 c = mix(vec3(0.05, 0.05, 0.06), vec3(1.0, 0.96, 0.86) * (0.6 + 2.6 * uFlood), l);
      gl_FragColor = vec4(c, 1.0);
      #include <colorspace_fragment>
    }`,
    toneMapped: false,
  });
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

/** Waving flags held up along the front of the stands. */
function flags(home: number, away: number): THREE.InstancedMesh {
  const geo = new THREE.PlaneGeometry(1.6, 1.0, 8, 4);
  geo.translate(0.8, 0, 0);
  const spots: { x: number; y: number; z: number; ry: number; c: number; c2: number }[] = [];
  for (let i = 0; i < 16; i++) {
    const x = -55 + i * 7.3 + Math.sin(i * 7.7) * 2;
    spots.push({ x, y: 3.6 + (i % 3) * 2.1, z: -(PITCH.halfW + 9.5 + (i % 3) * 3), ry: 0, c: i % 4 === 3 ? away : home, c2: 0xf3eee2 });
  }
  for (let i = 0; i < 6; i++) {
    spots.push({ x: -(PITCH.halfL + 11 + (i % 2) * 3), y: 3.2 + (i % 2) * 2, z: -25 + i * 10, ry: Math.PI / 2, c: home, c2: 0xf3eee2 });
    spots.push({ x: PITCH.halfL + 11 + (i % 2) * 3, y: 3.2 + (i % 2) * 2, z: -25 + i * 10, ry: -Math.PI / 2, c: away, c2: 0xf3eee2 });
  }
  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { ...U },
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute vec3 aCol;
      attribute vec3 aCol2;
      attribute float aPhase;
      varying vec2 vUv;
      varying vec3 vCol;
      varying vec3 vCol2;
      varying float vShade;
      varying float vDist;
      void main() {
        vUv = uv;
        vCol = aCol;
        vCol2 = aCol2;
        vec3 p = position;
        float k = p.x / 1.6;
        float w = sin(uTime * 4.0 + aPhase + p.x * 3.5) * 0.18 * k + sin(uTime * 6.3 + aPhase * 2.0 + p.x * 6.0) * 0.05 * k;
        p.z += w;
        p.y -= k * k * 0.15;
        vShade = 0.8 + w * 1.5;
        vec4 mv = viewMatrix * modelMatrix * instanceMatrix * vec4(p, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uLight, uFog;
      uniform float uFogNear, uFogFar;
      varying vec2 vUv;
      varying vec3 vCol;
      varying vec3 vCol2;
      varying float vShade;
      varying float vDist;
      void main() {
        float stripe = step(0.4, vUv.y) * step(vUv.y, 0.6);
        vec3 c = mix(vCol, vCol2, stripe) * vShade * uLight;
        c = mix(c, uFog, smoothstep(uFogNear, uFogFar, vDist) * 0.8);
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
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const c = new THREE.Color();
  spots.forEach((s, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.ry);
    m.compose(new THREE.Vector3(s.x, s.y, s.z), q, new THREE.Vector3(1, 1, 1));
    mesh.setMatrixAt(i, m);
    c.setHex(s.c);
    col.set([c.r, c.g, c.b], i * 3);
    c.setHex(s.c2);
    col2.set([c.r, c.g, c.b], i * 3);
    phase[i] = i * 1.7;
  });
  geo.setAttribute('aCol', new THREE.InstancedBufferAttribute(col, 3));
  geo.setAttribute('aCol2', new THREE.InstancedBufferAttribute(col2, 3));
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
  mesh.frustumCulled = false;
  return mesh;
}

/** Soft volumetric beams from each floodlight bank, visible as dusk falls. */
function lightShafts(): THREE.Group {
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
        float a = pow(vAlong, 2.2) * soft * uFlood * uFlood * 0.07;
        gl_FragColor = vec4(vec3(1.0, 0.96, 0.86) * a, 1.0);
      }
    `,
  });
  for (const [px, pz] of PYLONS) {
    const target = new THREE.Vector3(px * 0.25, 0, pz * 0.25);
    const from = new THREE.Vector3(px, 43, pz);
    const len = from.distanceTo(target);
    const geo = new THREE.ConeGeometry(20, len, 24, 1, true);
    geo.translate(0, -len / 2, 0); // apex at the origin
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(from);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), target.clone().sub(from).normalize());
    m.frustumCulled = false;
    m.renderOrder = 6;
    g.add(m);
  }
  return g;
}

/** Hand-painted supporters' banners hung on the stand fronts. */
function banners(home: number, away: number): THREE.Group {
  const g = new THREE.Group();
  const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
  const make = (text: string, bg: string, fg: string, w: number) => {
    const cv = document.createElement('canvas');
    cv.width = 512;
    cv.height = 96;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const draw = () => {
      const c = cv.getContext('2d')!;
      c.fillStyle = bg;
      c.fillRect(0, 0, 512, 96);
      c.fillStyle = fg;
      c.fillRect(0, 6, 512, 6);
      c.fillRect(0, 84, 512, 6);
      c.font = '800 60px "Barlow Condensed", "Arial Narrow", sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(text, 256, 50);
      tex.needsUpdate = true;
    };
    draw();
    void document.fonts?.ready.then(draw);
    const mat = litMaterial({ roughness: 0.9 });
    mat.map = tex;
    mat.side = THREE.DoubleSide;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.1875), mat);
    return m;
  };
  const spots: [string, string, string, number, number, number, number, number][] = [
    ['ROSSONERI ULTRAS', hex(home), '#f3eee2', 16, -38, 2.6, -(PITCH.halfW + 7.85), 0],
    ['GAMENIGHT', '#14123a', '#ffd447', 12, 0, 2.6, -(PITCH.halfW + 7.85), 0],
    ['ATLANTIC 1903', hex(away), '#23345e', 14, 36, 2.6, -(PITCH.halfW + 7.85), 0],
    ['CURVA ROSSA', hex(home), '#ffffff', 14, -(PITCH.halfL + 8.85), 2.2, 18, Math.PI / 2],
    ['ROVERS TILL I DIE', '#23345e', hex(away), 15, PITCH.halfL + 8.85, 2.2, -16, -Math.PI / 2],
  ];
  for (const [text, bg, fg, w, x, y, z, ry] of spots) {
    const m = make(text, bg, fg, w);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    g.add(m);
  }
  return g;
}

/** Corner flags and the two dugouts on the far touchline. */
function pitchside(home: number, away: number): THREE.Group {
  const g = new THREE.Group();
  const pole = litMaterial({ color: 0xf2f0e8, roughness: 0.5 });
  const flagMat = litMaterial({ color: 0xffd447, roughness: 0.8 });
  flagMat.side = THREE.DoubleSide;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.6, 6), pole);
      p.position.set(sx * PITCH.halfL, 0.8, sz * PITCH.halfW);
      p.castShadow = true;
      g.add(p);
      const f = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.3), flagMat);
      f.position.set(sx * PITCH.halfL + 0.2, 1.45, sz * PITCH.halfW);
      f.castShadow = true;
      g.add(f);
    }
  }
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
  m.renderOrder = -20;
  m.frustumCulled = false;
  return m;
}

/** Distant rooftops and trees: depth behind the stands, softened by the haze. */
function skyline(): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 90; i++) {
    const a = (i / 90) * Math.PI * 2 + rnd() * 0.05;
    const r = 230 + rnd() * 60;
    const tree = rnd() < 0.45;
    const h = tree ? 8 + rnd() * 8 : 10 + rnd() * 26;
    const w = tree ? 10 + rnd() * 10 : 12 + rnd() * 18;
    const g = tree ? new THREE.SphereGeometry(w * 0.5, 7, 5) : new THREE.BoxGeometry(w, h, w * 0.7);
    if (tree) g.scale(1, h / w, 1);
    g.rotateY(-a);
    g.translate(Math.cos(a) * r, tree ? h * 0.4 : h / 2, Math.sin(a) * r);
    parts.push(g.toNonIndexed());
  }
  const geo = mergeGeometries(parts)!;
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x55605e }));
  return mesh;
}

export function createStadium(homeColor: number, awayColor: number): Stadium {
  const group = new THREE.Group();
  group.add(sky());
  group.add(skyline());

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), litMaterial({ color: 0x6f7262, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  group.add(ground);
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(PITCH.length + 30, PITCH.width + 26), litMaterial({ color: 0x4f6a3c, roughness: 0.95 }));
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.02;
  apron.receiveShadow = true;
  group.add(apron);

  const roofLight = new THREE.MeshBasicMaterial({ color: 0xfff1d6, toneMapped: false });
  const mats: StandMats = {
    struct: litMaterial({ color: 0x6d6a64, roughness: 0.9 }),
    roof: litMaterial({ color: 0x3b4048, roughness: 0.7 }),
    roofLight,
  };
  const mainCrowd = crowdMaterial(homeColor, awayColor, 0.15);
  const homeEnd = crowdMaterial(homeColor, 0xf0e9da, 0.25);
  const awayEnd = crowdMaterial(awayColor, homeColor, 0.2);

  const far = stand(124, 30, 1.6, 21, 27, mainCrowd, mats, homeColor);
  far.position.set(0, 0, -(PITCH.halfW + 7.5));
  group.add(far);
  // The near stand sits behind the camera: never drawn, but its roof still shades the
  // near side of the pitch (see STAND_SHADOW_GLSL).
  const endL = stand(78, 22, 1.4, 13, 19, homeEnd, mats, homeColor);
  endL.position.set(-(PITCH.halfL + 8.5), 0, 0);
  endL.rotation.y = Math.PI / 2;
  group.add(endL);
  const endR = stand(78, 22, 1.4, 13, 19, awayEnd, mats, 0x23345e);
  endR.position.set(PITCH.halfL + 8.5, 0, 0);
  endR.rotation.y = -Math.PI / 2;
  group.add(endR);

  const lampMat = lampMaterial();
  const glows: THREE.Sprite[] = [];
  for (const [px, pz] of PYLONS) {
    const p = pylon(lampMat, glows);
    p.position.set(px, 0, pz);
    p.lookAt(0, 0, 0);
    group.add(p);
  }

  group.add(adBoards());
  group.add(flags(homeColor, awayColor));
  group.add(banners(homeColor, awayColor));
  group.add(pitchside(homeColor, awayColor));
  group.add(lightShafts());

  const c = new THREE.Color();
  const c2 = new THREE.Color();
  return {
    group,
    update(time, excitement, atmo) {
      U.uTime.value = time;
      U.uExcite.value = excitement;
      U.uSkyTop.value.copy(atmo.skyTop);
      U.uSkyHorizon.value.copy(atmo.skyHorizon);
      U.uSunDir.value.copy(atmo.sun.position).negate().normalize();
      U.uSunColor.value.copy(atmo.sun.color);
      const fog = atmo.sun.parent instanceof THREE.Scene ? (atmo.sun.parent.fog as THREE.Fog | null) : null;
      if (fog) U.uFog.value.copy(fog.color);
      // Crowd light: sky + a share of the sun + floodlights.
      const flood = SHARED.uFlood.value;
      c.copy(atmo.hemi.color).multiplyScalar(atmo.hemi.intensity * 0.55);
      c2.copy(atmo.sun.color).multiplyScalar(atmo.sun.intensity * 0.22);
      c.add(c2);
      c2.copy(SHARED.uFloodColor.value).multiplyScalar(flood * 0.55);
      c.add(c2);
      U.uLight.value.copy(c);
      roofLight.color.setRGB(0.25 + flood * 1.4, 0.24 + flood * 1.35, 0.22 + flood * 1.2);
      for (const g of glows) {
        (g.material as THREE.SpriteMaterial).opacity = 0.15 + flood * 0.85;
        g.scale.setScalar(18 + flood * 16);
      }
    },
  };
}
