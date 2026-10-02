import * as THREE from 'three';
import { PITCH } from '../sim/constants';
import { COLORS, toonMaterial } from './look';

/**
 * A compact, old-ground-meets-modern stadium: four separate stands with open corners,
 * floodlight pylons, ad boards. The crowd is drawn procedurally in the stand shader,
 * so thousands of fans cost one draw call per stand.
 */

export interface Stadium {
  group: THREE.Group;
  update(time: number, excitement: number): void;
}

const crowdUniforms = {
  uTime: { value: 0 },
  uExcite: { value: 0.2 },
  uFog: { value: new THREE.Color(COLORS.fog) },
  uFogNear: { value: 70 },
  uFogFar: { value: 230 },
};

function crowdMaterial(sectionA: number, sectionB: number, mixAB: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...crowdUniforms,
      uA: { value: new THREE.Color(sectionA) },
      uB: { value: new THREE.Color(sectionB) },
      uMix: { value: mixAB },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying float vDist;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vec4 mv = viewMatrix * wp;
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      varying float vDist;
      uniform float uTime, uExcite, uMix, uFogNear, uFogFar;
      uniform vec3 uA, uB, uFog;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 15731.743); }

      vec3 shirt(vec2 cell) {
        float h = hash(cell + 7.1);
        float team = step(hash(cell * 0.37 + floor(cell.x / 14.0)), uMix);
        vec3 tc = mix(uA, uB, team);
        if (h < 0.55) return tc;
        if (h < 0.68) return vec3(0.92, 0.9, 0.84);
        if (h < 0.78) return vec3(0.18, 0.2, 0.24);
        if (h < 0.86) return vec3(0.33, 0.42, 0.55);
        if (h < 0.93) return vec3(0.55, 0.5, 0.42);
        return vec3(0.75, 0.62, 0.3);
      }

      void main() {
        // uv in metres: x along the stand, y up the rake.
        vec2 seat = vec2(0.62, 0.82);
        vec2 g = vUv / seat;
        vec2 cell = floor(g);
        vec2 f = fract(g);
        float occ = step(hash(cell), 0.88);
        // Excited crowd: jumping, out of sync.
        float ph = hash(cell + 3.3) * 6.283;
        float jump = max(0.0, sin(uTime * (7.0 + hash(cell + 1.1) * 3.0) + ph)) * uExcite * uExcite * 0.22;
        float sway = sin(uTime * 1.3 + ph) * 0.03;
        vec2 q = f - vec2(0.5 + sway, 0.0) - vec2(0.0, jump);
        float body = step(abs(q.x), 0.3) * step(0.08, q.y) * step(q.y, 0.62);
        float head = step(length((q - vec2(0.0, 0.74)) * vec2(1.0, 1.25)), 0.16);
        vec3 seatCol = vec3(0.24, 0.27, 0.33) * (0.9 + 0.2 * step(0.5, fract(cell.y * 0.5)));
        vec3 skin = mix(vec3(0.93, 0.76, 0.6), vec3(0.42, 0.28, 0.18), hash(cell + 9.2));
        vec3 c = seatCol;
        c = mix(c, shirt(cell), body * occ);
        c = mix(c, skin, head * occ);
        // Shade lower rows a touch (stand overhang).
        c *= 0.82 + 0.18 * smoothstep(0.0, 30.0, vUv.y);

        // Far away the pattern would shimmer: fade to the average colour.
        float px = max(fwidth(g.x), fwidth(g.y));
        vec3 avg = mix(seatCol, mix(uA, uB, uMix) * 0.7 + 0.15, 0.6);
        c = mix(c, avg, smoothstep(0.35, 0.9, px));

        c = pow(c, vec3(2.2));
        float fog = smoothstep(uFogNear, uFogFar, vDist);
        c = mix(c, uFog, fog * 0.85);
        gl_FragColor = vec4(c, 1.0);
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
  const pos = new Float32Array([-hl, h0, 0, hl, h0, 0, hl, h1, -depth, -hl, h1, -depth]);
  const uv = new Float32Array([0, 0, length, 0, length, slope, 0, slope]);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat);
}

function stand(
  length: number,
  depth: number,
  h0: number,
  h1: number,
  roofH: number,
  crowd: THREE.ShaderMaterial,
  structMat: THREE.Material,
  fasciaColor: number,
): THREE.Group {
  const g = new THREE.Group();
  g.add(deck(length, depth, h0, h1, crowd));
  // Front wall below the first row.
  const wall = new THREE.Mesh(new THREE.BoxGeometry(length, h0, 0.4), structMat);
  wall.position.set(0, h0 / 2, 0.2);
  g.add(wall);
  // Back wall.
  const back = new THREE.Mesh(new THREE.BoxGeometry(length + 0.5, roofH + 1, 0.8), structMat);
  back.position.set(0, (roofH + 1) / 2, -depth - 0.4);
  g.add(back);
  // Side walls (closing the stand ends).
  for (const s of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.6, roofH, depth), structMat);
    side.position.set((s * (length + 0.6)) / 2, roofH / 2, -depth / 2);
    g.add(side);
  }
  // Cantilever roof with a coloured fascia.
  const roofDepth = depth * 0.92;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(length + 1, 0.7, roofDepth), new THREE.MeshLambertMaterial({ color: 0x3a3f46 }));
  roof.position.set(0, roofH, -depth + roofDepth / 2);
  g.add(roof);
  const fascia = new THREE.Mesh(new THREE.BoxGeometry(length + 1.2, 1.6, 0.3), toonMaterial({ color: fasciaColor }));
  fascia.position.set(0, roofH - 0.2, -depth + roofDepth + 0.1);
  g.add(fascia);
  // Roof supports.
  const nPost = Math.max(2, Math.round(length / 22));
  for (let i = 0; i <= nPost; i++) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, roofH, 0.35), structMat);
    post.position.set(-length / 2 + (i * length) / nPost, roofH / 2, -depth * 0.25);
    g.add(post);
  }
  return g;
}

function pylon(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: 0x4b5058 });
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.9, 42, 6), mat);
  mast.position.y = 21;
  g.add(mast);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(7, 4.5, 0.6), mat);
  frame.position.set(0, 43, 0);
  g.add(frame);
  // Lamp grid as one emissive plane with a shader-less texture-free look.
  const lampGeo = new THREE.PlaneGeometry(6.4, 3.9, 1, 1);
  const lampMat = new THREE.ShaderMaterial({
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec2 vUv; void main(){
      vec2 g = fract(vUv * vec2(6.0, 4.0)) - 0.5;
      float l = 1.0 - smoothstep(0.25, 0.42, length(g));
      vec3 c = mix(vec3(0.25, 0.25, 0.27), vec3(1.0, 0.96, 0.84), l);
      gl_FragColor = vec4(c, 1.0);
      #include <colorspace_fragment>
    }`,
  });
  const lamps = new THREE.Mesh(lampGeo, lampMat);
  lamps.position.set(0, 43, 0.31);
  g.add(lamps);
  return g;
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
  const mesh = new THREE.InstancedMesh(geo, toonMaterial(), placements.length);
  const palette = [0x1f3b5c, 0xe9e1cc, 0xc4472f, 0x2f6b4f, 0xd9a93f, 0x26282c];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const c = new THREE.Color();
  placements.forEach((p, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.ry);
    m.compose(new THREE.Vector3(p.x, 0, p.z), q, new THREE.Vector3(1, 1, 1));
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, c.setHex(palette[(i * 7 + (i >> 1)) % palette.length]));
  });
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

function sky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(700, 24, 12);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x9fbcd6) },
      uHorizon: { value: new THREE.Color(COLORS.horizon) },
      uSunDir: { value: new THREE.Vector3(-0.38, 0.32, 0.58).normalize() },
    },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uTop, uHorizon, uSunDir; varying vec3 vDir;
      void main(){
        float h = clamp(vDir.y, 0.0, 1.0);
        vec3 c = mix(uHorizon, uTop, pow(h, 0.55));
        float sun = max(dot(normalize(vDir), uSunDir), 0.0);
        c += vec3(1.0, 0.8, 0.55) * pow(sun, 24.0) * 0.35;
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = -20;
  m.frustumCulled = false;
  return m;
}

export function createStadium(homeColor: number, awayColor: number): Stadium {
  const group = new THREE.Group();
  group.add(sky());

  // Surroundings: concrete apron and ground.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshLambertMaterial({ color: 0x77786a }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  group.add(ground);
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(PITCH.length + 30, PITCH.width + 26), new THREE.MeshLambertMaterial({ color: 0x5b7346 }));
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.02;
  group.add(apron);

  const structMat = new THREE.MeshLambertMaterial({ color: 0x8b8a83 });
  const mainCrowd = crowdMaterial(homeColor, awayColor, 0.15);
  const homeEnd = crowdMaterial(homeColor, 0xf0e9da, 0.25);
  const awayEnd = crowdMaterial(awayColor, homeColor, 0.2);

  // Far main stand (the backdrop for most of the match).
  const far = stand(124, 30, 1.6, 21, 27, mainCrowd, structMat, homeColor);
  far.position.set(0, 0, -(PITCH.halfW + 7.5));
  group.add(far);
  // The near stand sits behind the camera: never drawn, but its roof still shades the
  // near side of the pitch (see STAND_SHADOW_GLSL).
  // End stands, smaller, classic terraces.
  const endL = stand(78, 22, 1.4, 13, 19, homeEnd, structMat, homeColor);
  endL.position.set(-(PITCH.halfL + 8.5), 0, 0);
  endL.rotation.y = Math.PI / 2;
  group.add(endL);
  const endR = stand(78, 22, 1.4, 13, 19, awayEnd, structMat, 0x23345e);
  endR.position.set(PITCH.halfL + 8.5, 0, 0);
  endR.rotation.y = -Math.PI / 2;
  group.add(endR);

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const p = pylon();
      p.position.set(sx * (PITCH.halfL + 22), 0, sz * (PITCH.halfW + 22));
      p.lookAt(0, 0, 0);
      group.add(p);
    }
  }

  group.add(adBoards());

  return {
    group,
    update(time, excitement) {
      crowdUniforms.uTime.value = time;
      crowdUniforms.uExcite.value = excitement;
    },
  };
}
