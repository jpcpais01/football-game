import * as THREE from 'three';
import type { Match } from '../sim/match';
import { PITCH } from '../sim/constants';

/** Perceived brightness 0..255 (to give light kits a dark rim on the light pitch lines). */
const lum = (c: number) => 0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255);

/** 22 players, the ring round yours, the ball. */
const DOTS = 24;

/**
 * The radar at the bottom of the screen: the pitch from above, both teams as dots in their
 * shirt colours, the ball, and the player you control ringed. The same way round as the
 * match camera (home attacking right, the near touchline at the bottom).
 *
 * Drawn by the game's own WebGL frame, straight onto the screen canvas after everything
 * else (two draws), instead of on a 2D canvas of its own: that was a second picture for the
 * browser to redraw and composite over the game every frame. The page keeps only an empty
 * frame (its border and shadow, which never change) to say where it goes.
 */
export class Minimap {
  private el = document.createElement('div');
  private visible = false;
  /** Measure again before the next draw (reading the layout every frame forces a reflow). */
  private dirty = true;
  /** Where it goes, in CSS pixels. */
  private x = 0;
  private y = 0;
  private W = 0;
  private H = 0;

  private scene = new THREE.Scene();
  private cam = new THREE.Camera();
  private bgCanvas = document.createElement('canvas');
  private bgTex: THREE.CanvasTexture | null = null;
  private bgMat: THREE.ShaderMaterial;
  private dotMat: THREE.ShaderMaterial;
  private geo = new THREE.BufferGeometry();
  private pos = new Float32Array(DOTS * 3);
  private fill = new Float32Array(DOTS * 3);
  private rim = new Float32Array(DOTS * 4);
  /** Radius, rim width, ring (1: rim only). */
  private shape = new Float32Array(DOTS * 3);

  constructor(parent: HTMLElement) {
    this.el.className = 'minimap';
    parent.appendChild(this.el);
    window.addEventListener('resize', () => (this.dirty = true));

    // Both shaders place things in canvas pixels (y down) and write sRGB colours as they are,
    // the way the 2D canvas did.
    this.bgMat = new THREE.ShaderMaterial({
      uniforms: { tMap: { value: null as THREE.Texture | null }, uRect: { value: new THREE.Vector4() }, uView: { value: new THREE.Vector2(1, 1) } },
      vertexShader: /* glsl */ `
        uniform vec4 uRect;
        uniform vec2 uView;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec2 p = uRect.xy + uv * uRect.zw;
          gl_Position = vec4(p.x / uView.x * 2.0 - 1.0, 1.0 - p.y / uView.y * 2.0, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tMap;
        varying vec2 vUv;
        void main() { gl_FragColor = texture2D(tMap, vec2(vUv.x, vUv.y)); }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
      // (Placing it y-down turns the quad over.)
      side: THREE.DoubleSide,
    });
    const bg = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0), this.bgMat);
    bg.frustumCulled = false;
    this.scene.add(bg);

    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aFill', new THREE.BufferAttribute(this.fill, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aRim', new THREE.BufferAttribute(this.rim, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aShape', new THREE.BufferAttribute(this.shape, 3).setUsage(THREE.DynamicDrawUsage));
    this.dotMat = new THREE.ShaderMaterial({
      uniforms: { uView: { value: new THREE.Vector2(1, 1) }, uScale: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute vec3 aFill;
        attribute vec4 aRim;
        attribute vec3 aShape;
        uniform vec2 uView;
        uniform float uScale;
        varying vec3 vFill;
        varying vec4 vRim;
        varying vec3 vShape;
        varying float vRing;
        void main() {
          vFill = aFill;
          vRing = aShape.z;
          vRim = aRim;
          // In canvas pixels: radius, rim width, the half-size of the point sprite.
          float r = aShape.x * uScale;
          float w = aShape.y * uScale;
          float hs = r + w * 0.5 + 1.0;
          vShape = vec3(r, w, hs);
          gl_PointSize = hs * 2.0;
          gl_Position = vec4(position.x / uView.x * 2.0 - 1.0, 1.0 - position.y / uView.y * 2.0, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vFill;
        varying vec4 vRim;
        varying vec3 vShape;
        varying float vRing;
        void main() {
          // Distance from the centre, in canvas pixels; the rim straddles the radius like a stroke.
          float d = length(gl_PointCoord - 0.5) * vShape.z * 2.0;
          float r = vShape.x;
          float hw = vShape.y * 0.5;
          float inside = clamp(r + 0.5 - d, 0.0, 1.0);
          float band = clamp(hw + 0.5 - abs(d - r), 0.0, 1.0);
          vec4 c = vec4(vFill, inside * (1.0 - vRing));
          c = mix(c, vec4(vRim.rgb, 1.0), band * vRim.a);
          if (c.a < 0.004) discard;
          gl_FragColor = c;
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
    });
    const dots = new THREE.Points(this.geo, this.dotMat);
    dots.frustumCulled = false;
    this.scene.add(dots);
    this.scene.matrixWorldAutoUpdate = false;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.el.style.display = v ? '' : 'none';
    this.dirty = true;
  }

  private size(): void {
    this.dirty = false;
    const r = this.el.getBoundingClientRect();
    const w = Math.round(r.width);
    const h = Math.round((w * PITCH.width) / PITCH.length);
    this.el.style.height = `${h}px`;
    this.x = r.left;
    this.y = r.bottom - h;
    if (w === this.W && h === this.H) return;
    this.W = w;
    this.H = h;
    if (w) this.drawPitch();
  }

  /** The pitch and its markings, drawn once per size (at the screen's full resolution). */
  private drawPitch(): void {
    const { W, H } = this;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.bgCanvas.width = Math.round(W * dpr);
    this.bgCanvas.height = Math.round(H * dpr);
    const g = this.bgCanvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const sx = W / PITCH.length;
    const sz = H / PITCH.width;
    // Rounded like its frame on the page.
    g.beginPath();
    g.roundRect(0, 0, W, H, 6);
    g.clip();
    g.fillStyle = 'rgba(28, 74, 40, 0.72)';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(244, 239, 227, 0.55)';
    g.lineWidth = 1;
    g.strokeRect(0.5, 0.5, W - 1, H - 1);
    g.beginPath();
    g.moveTo(W / 2, 0);
    g.lineTo(W / 2, H);
    g.stroke();
    g.beginPath();
    g.arc(W / 2, H / 2, PITCH.circleRadius * sx, 0, Math.PI * 2);
    g.stroke();
    const boxW = PITCH.boxDepth * sx;
    const boxH = PITCH.boxHalfWidth * 2 * sz;
    g.strokeRect(0.5, (H - boxH) / 2, boxW, boxH);
    g.strokeRect(W - boxW - 0.5, (H - boxH) / 2, boxW, boxH);
    // A new texture per size (the graphics chip can't resize one in place).
    this.bgTex?.dispose();
    const tex = (this.bgTex = new THREE.CanvasTexture(this.bgCanvas));
    tex.colorSpace = THREE.NoColorSpace;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    // (Its first row is the canvas's top: uv.y = 0 at the top, as the vertex shader puts it.)
    tex.flipY = false;
    this.bgMat.uniforms.tMap.value = tex;
  }

  private dot(i: number, x: number, y: number, fill: number, rim: number, rimA: number, r: number, w: number): void {
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.fill[i * 3] = ((fill >> 16) & 255) / 255;
    this.fill[i * 3 + 1] = ((fill >> 8) & 255) / 255;
    this.fill[i * 3 + 2] = (fill & 255) / 255;
    this.rim[i * 4] = ((rim >> 16) & 255) / 255;
    this.rim[i * 4 + 1] = ((rim >> 8) & 255) / 255;
    this.rim[i * 4 + 2] = (rim & 255) / 255;
    this.rim[i * 4 + 3] = rimA;
    this.shape[i * 3] = r;
    this.shape[i * 3 + 1] = w;
    this.shape[i * 3 + 2] = 0;
  }

  /** Where everyone is now (CSS pixels; scaled to the canvas when drawn). */
  update(m: Match): void {
    if (this.dirty) this.size();
    const { W, H } = this;
    if (!W) return;
    const sx = W / PITCH.length;
    const sz = H / PITCH.width;
    const px = (x: number) => this.x + (x + PITCH.halfL) * sx;
    const pz = (z: number) => this.y + (z + PITCH.halfW) * sz;

    // Players: the opponents first, so your team draws on top (points draw in order).
    const r = Math.max(2.2, W / 64);
    let i = 0;
    for (let ti = 0; ti < 2; ti++) {
      const t = ti === 0 ? 1 - m.humanTeam : m.humanTeam;
      const kit = m.teams[t].info.kit;
      for (const p of m.teams[t].players) {
        const c = p.role === 'GK' ? kit.gkShirt : kit.shirt;
        const dark = lum(c) > 150;
        this.dot(i++, px(p.pos.x), pz(p.pos.z), c, dark ? 0x0a0c14 : 0xf4efe3, dark ? 0.85 : 0.8, r, 1);
      }
    }
    // The player you control: a gold ring, no fill.
    const c = m.controlled;
    this.dot(i, px(c.pos.x), pz(c.pos.z), 0xffd447, 0xffd447, 1, r + 2.2, 1.6);
    this.shape[i * 3 + 2] = 1;
    i++;
    // Ball (a little bigger when it's in the air).
    const b = m.ball.pos;
    this.dot(i++, px(b.x), pz(b.z), 0xffffff, 0x0a0c14, 0.9, r * 0.8 + Math.min(2, b.y * 0.25), 1);
    this.geo.setDrawRange(0, i);
    for (const name of ['position', 'aFill', 'aRim', 'aShape']) (this.geo.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Onto the screen canvas, over the finished frame. */
  draw(renderer: THREE.WebGLRenderer): void {
    if (!this.visible || !this.W) return;
    const cv = renderer.domElement;
    // Canvas pixels per CSS pixel (Fast graphics draws the canvas smaller than the screen).
    const k = cv.width / window.innerWidth;
    (this.bgMat.uniforms.uView.value as THREE.Vector2).set(cv.width, cv.height);
    (this.bgMat.uniforms.uRect.value as THREE.Vector4).set(this.x * k, this.y * k, this.W * k, this.H * k);
    (this.dotMat.uniforms.uView.value as THREE.Vector2).set(cv.width / k, cv.height / k);
    this.dotMat.uniforms.uScale.value = k;
    const clear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.cam);
    renderer.autoClear = clear;
  }
}
