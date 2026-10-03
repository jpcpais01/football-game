import * as THREE from 'three';
import { hexRGB, oklab, type Palette } from './palettes';

const MAX_PAL = 32;

/**
 * Pixel-art presentation. The world is rendered at a low resolution into an HDR target
 * (much cheaper than full resolution), then:
 * 1. One pass *at that low resolution* (one fragment per art pixel, not per screen pixel):
 *    1-pixel outlines from the depth buffer, glow, clarity, the filmic tone map and grade,
 *    and an ordered-dither quantise so gradients become pixel bands.
 * 2. A blit to the screen: crisp nearest-neighbour pixels, scrolled by the camera's
 *    sub-pixel remainder. One texture read per screen pixel.
 *
 * Crispness:
 * - The canvas runs at the screen's true resolution (no browser smoothing), and the
 *   upscale is "sharp bilinear": each art pixel is drawn solid, with only the one device
 *   pixel on its border blended. So the art can be any height (the fineness slider moves
 *   in small steps) and every pixel still looks the same size, with no blur.
 * - The world is rendered at 2x the art resolution and each art pixel keeps the one of
 *   its four samples closest to their average: pure colours and hard edges (no blended
 *   halo), but no single-sample speckle or shimmer from grass, crowd and line detail.
 * Every screen pixel inside an art pixel would compute the same colour anyway, so doing
 * the work per art pixel gives the identical picture for a fraction of the fill cost.
 * The HUD and controls are DOM, so they stay sharp.
 *
 * The grass is the exception to the 2x (setGrass): most of the screen, smooth, and the
 * most expensive surface to light, it's shaded once per art pixel in a pass of its own,
 * and the world pass only copies that value into the pitch's four samples (writing its
 * depth as usual, so everything in front, the outlines and the glow work as before).
 */
/** The layer the grass pass draws: the pitch and the lights on it. */
export const GRASS_LAYER = 30;

export class PixelPass {
  readonly target: THREE.WebGLRenderTarget;
  /** The finished low-res picture (graded, outlined, quantised). */
  private post: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private blit: THREE.ShaderMaterial;
  /** Art height in pixels. */
  height = 288;
  /** Supersampling of the world render (2 = 2x2 samples per art pixel, 1 = off). */
  ss = 2;
  /** The grass, shaded once per art pixel (setGrass). */
  private grass: { mesh: THREE.Mesh; material: THREE.Material; rt: THREE.WebGLRenderTarget; copy: THREE.ShaderMaterial } | null = null;
  private compact: boolean;
  private artW = 4;
  private artH = 4;
  private devW = 4;
  private devH = 4;

  /**
   * `compact`: the world target as packed floats (R11G11B10F, 4 bytes a pixel) instead of
   * half floats (RGBA16F, 8): the same HDR range for the bloom and tone map, half the memory
   * traffic in the world pass and in every one of the post pass's dozen reads. Only where
   * the GPU can render to it (EXT_color_buffer_float).
   */
  constructor(compact = false) {
    this.compact = compact;
    this.target = new THREE.WebGLRenderTarget(4, 4, {
      type: compact ? THREE.UnsignedInt101111Type : THREE.HalfFloatType,
      format: compact ? THREE.RGBFormat : THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      samples: 0,
    });
    this.target.texture.generateMipmaps = false;
    this.target.depthTexture = new THREE.DepthTexture(4, 4);
    this.target.depthTexture.type = THREE.UnsignedIntType;
    // Linear filtering, used only across the one-device-pixel seams by the sharp upscale.
    this.post = new THREE.WebGLRenderTarget(4, 4, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    this.post.texture.generateMipmaps = false;

    this.mat = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tColor: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        uRes: { value: new THREE.Vector2(4, 4) },
        uSS: { value: 2 },
        uNear: { value: 1 },
        uFar: { value: 1500 },
        uLevels: { value: 22 },
        uOutline: { value: new THREE.Color(0x120f2a) },
        uNight: { value: 0 },
        uExposure: { value: 1 },
        uCool: { value: 1 },
        // Palette mode (off = the smooth-banded look).
        uPalOn: { value: 0 },
        uPalN: { value: 0 },
        uPal: { value: Array.from({ length: MAX_PAL }, () => new THREE.Vector3()) },
        uPalRGB: { value: Array.from({ length: MAX_PAL }, () => new THREE.Vector3()) },
        uDither: { value: 1 },
        uPreSat: { value: 1 },
        uPreCon: { value: 1 },
        uGrain: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform vec2 uRes;
        uniform float uSS;
        uniform float uNear, uFar, uLevels, uNight, uCool, uExposure;
        uniform float uPalOn, uDither, uPreSat, uPreCon, uGrain;
        uniform int uPalN;
        uniform vec3 uPal[${MAX_PAL}];
        uniform vec3 uPalRGB[${MAX_PAL}];

        vec3 toOklab(vec3 c) {
          c = pow(max(c, 0.0), vec3(2.2));
          float l = pow(0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b, 1.0 / 3.0);
          float m = pow(0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b, 1.0 / 3.0);
          float s = pow(0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b, 1.0 / 3.0);
          return vec3(0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
                      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
                      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
        }

        // Snap to the palette: the nearest colour (lightness weighted a little more, so
        // shading reads right), ordered-dithered toward the second nearest by how far
        // along the way to it the true colour sits.
        vec3 paletteMap(vec3 c, float th) {
          vec3 w = vec3(1.4, 1.0, 1.0);
          vec3 p = toOklab(c);
          float d1 = 1e9;
          float d2 = 1e9;
          int i1 = 0;
          int i2 = 0;
          for (int i = 0; i < ${MAX_PAL}; i++) {
            if (i >= uPalN) break;
            vec3 q = (uPal[i] - p) * w;
            float d = dot(q, q);
            if (d < d1) {
              d2 = d1; i2 = i1;
              d1 = d; i1 = i;
            } else if (d < d2) {
              d2 = d; i2 = i;
            }
          }
          vec3 a = uPal[i1] * w;
          vec3 ab = uPal[i2] * w - a;
          float t = clamp(dot(p * w - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
          // Like a pixel artist: colours near a palette entry stay flat, and the dither
          // only fills the real in-between zones (half-way = a clean 50% checker).
          float mixAmt = clamp((t - 0.2) / 0.3, 0.0, 1.0) * 0.5 * uDither;
          return mixAmt > th ? uPalRGB[i2] : uPalRGB[i1];
        }
        uniform vec3 uOutline;
        varying vec2 vUv;

        // ACES filmic, exactly as three.js does it (it skips tone mapping for render targets,
        // and this pass renders into one).
        vec3 RRTAndODTFit(vec3 v) {
          vec3 a = v * (v + 0.0245786) - 0.000090537;
          vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
          return a / b;
        }
        vec3 acesFilmic(vec3 color) {
          const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
          const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
          color *= uExposure / 0.6;
          color = ACESInputMat * color;
          color = RRTAndODTFit(color);
          color = ACESOutputMat * color;
          return clamp(color, 0.0, 1.0);
        }
        float linDepth(vec2 uv) {
          float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
          return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
        }
        // 4x4 ordered-dither threshold, computed (no table lookup loop).
        float bayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
        float bayer4(vec2 p) { return bayer2(0.5 * p) * 0.25 + bayer2(p); }

        void main() {
          // Rendered at the low resolution: this fragment is exactly one art pixel.
          vec2 px = gl_FragCoord.xy;
          vec2 uv = px / uRes;
          vec3 c;
          if (uSS > 1.5) {
            // Four samples of this art pixel: keep the one nearest their mean, so the pixel is
            // a real colour from the scene (hard edges) but a stable, representative one.
            vec2 st = 1.0 / (uRes * 2.0);
            vec2 b0 = (floor(px) * 2.0 + 0.5) * st;
            vec3 s0 = texture2D(tColor, b0).rgb;
            vec3 s1 = texture2D(tColor, b0 + vec2(st.x, 0.0)).rgb;
            vec3 s2 = texture2D(tColor, b0 + vec2(0.0, st.y)).rgb;
            vec3 s3 = texture2D(tColor, b0 + st).rgb;
            vec3 mean = (s0 + s1 + s2 + s3) * 0.25;
            float d0 = dot(s0 - mean, s0 - mean);
            float d1 = dot(s1 - mean, s1 - mean);
            float d2 = dot(s2 - mean, s2 - mean);
            float d3 = dot(s3 - mean, s3 - mean);
            c = s0;
            float best = d0;
            if (d1 < best) { best = d1; c = s1; }
            if (d2 < best) { best = d2; c = s2; }
            if (d3 < best) { c = s3; }
          } else {
            c = texture2D(tColor, uv).rgb;
          }

          // Silhouette outlines: this pixel is clearly nearer than a neighbour.
          float d = linDepth(uv);
          vec2 e = 1.0 / uRes;
          float dn = max(max(linDepth(uv + vec2(e.x, 0.0)), linDepth(uv - vec2(e.x, 0.0))),
                         max(linDepth(uv + vec2(0.0, e.y)), linDepth(uv - vec2(0.0, e.y))));
          float edge = step(0.35 + d * 0.06, dn - d) * (1.0 - smoothstep(70.0, 110.0, d));

          // Soft glow: bright neighbours bleed light (white kits in the sun, chalk, LEDs,
          // sparkles). Cheap because the image is already low resolution.
          vec3 bloom = vec3(0.0);
          // A tight glow (a pixel or two), so bright things bloom without smearing.
          const int TAPS = 8;
          vec2 offs[8];
          offs[0] = vec2(1.0, 0.0); offs[1] = vec2(-1.0, 0.0); offs[2] = vec2(0.0, 1.0); offs[3] = vec2(0.0, -1.0);
          offs[4] = vec2(2.0, 0.0); offs[5] = vec2(-2.0, 0.0); offs[6] = vec2(0.0, 2.0); offs[7] = vec2(0.0, -2.0);
          // The first four taps are the 1-pixel neighbours: summed for the clarity pass too.
          vec3 nb = vec3(0.0);
          for (int k = 0; k < TAPS; k++) {
            vec3 sc = texture2D(tColor, uv + offs[k] * e).rgb;
            if (k < 4) nb += sc;
            bloom += max(sc - vec3(0.75), 0.0);
          }
          c += bloom / float(TAPS) * 0.8;
          nb *= 0.25;
          if (uPalOn > 0.5) {
            // Palette: smooth flat areas before the snap (sub-pixel grass grain and crowd
            // detail would otherwise turn into palette speckle), but keep edges: only
            // neighbours that are already close in colour are blended in.
            vec3 nd = (texture2D(tColor, uv + e).rgb + texture2D(tColor, uv - e).rgb +
                       texture2D(tColor, uv + vec2(e.x, -e.y)).rgb + texture2D(tColor, uv + vec2(-e.x, e.y)).rgb) * 0.25;
            vec3 box = mix(nb, nd, 0.4);
            float diff = length(c - box) / max(0.04, dot(box, vec3(0.333)));
            c = mix(c, box, 0.7 * (1.0 - smoothstep(0.1, 0.35, diff)));
          } else {
            // Clarity: a touch of local contrast against the 1-pixel neighbourhood, so shapes
            // (kits, numbers, mown stripes) read crisply at low resolution.
            c = max(c + clamp(c - nb, -0.25, 0.25) * 0.35, 0.0);
          }

          // Filmic tone map, then display gamma.
          c = acesFilmic(c);
          c = pow(max(c, 0.0), vec3(1.0 / 2.2));

          // Ghibli palette: lush greens, teal-blue shadows by day (purple-blue at night),
          // golden highlights, a little more colour overall.
          float l = dot(c, vec3(0.299, 0.587, 0.114));
          float green = smoothstep(0.0, 0.08, c.g - max(c.r, c.b));
          c = mix(c, c * vec3(1.02, 1.06, 0.92), green * 0.6);
          vec3 shade = mix(vec3(0.84, 0.97, 1.1), vec3(0.86, 0.84, 1.14), uNight);
          c = mix(c, c * shade, (1.0 - l) * (0.32 + 0.2 * uNight) * uCool);
          c = mix(c, c * vec3(1.07, 1.0, 0.88), smoothstep(0.55, 1.0, l) * 0.4);
          c = mix(vec3(l), c, 1.12);

          // Pop, the way a good print does it rather than a filter: set a real black point,
          // a filmic S-curve for punchy mid-tones, then vibrance — muted colours (grass in
          // shade, kits under ACES) gain the most, already-saturated ones are left alone so
          // skin and sky stay believable.
          c = max(c - 0.015, 0.0) / 0.985;
          c = mix(c, c * c * (3.0 - 2.0 * c), 0.3);
          float hi = max(c.r, max(c.g, c.b));
          float lo = min(c.r, min(c.g, c.b));
          float sat = (hi - lo) / max(hi, 1e-3);
          float l2 = dot(c, vec3(0.299, 0.587, 0.114));
          c = mix(vec3(l2), c, 1.0 + 0.6 * (1.0 - sat) * smoothstep(0.03, 0.2, hi));
          // Light and shadow split: warm light, cool shade, a little stronger than before.
          c *= mix(vec3(0.94, 0.98, 1.08), vec3(1.05, 1.01, 0.95), smoothstep(0.2, 0.75, l2));

          float th = bayer4(px);
          if (uPalOn > 0.5) {
            // Palette: grade for the palette, darken the outlines first so they land on the
            // palette's own shadow colours, then snap every pixel to it.
            float pl = dot(c, vec3(0.299, 0.587, 0.114));
            c = mix(vec3(pl), c, uPreSat);
            c = (c - 0.5) * uPreCon + 0.5;
            c = mix(c, c * c * vec3(0.55, 0.5, 0.7), edge * 0.9);
            c = paletteMap(clamp(c, 0.0, 1.0), th);
            // Printed looks: the paper shows through a little.
            if (uGrain > 0.0) c *= 1.0 - uGrain * fract(sin(dot(px, vec2(12.9898, 78.233))) * 43758.5453);
          } else {
            // Quantise with an ordered dither: gradients turn into crisp pixel bands.
            // Light dither: flat bands, with the checker only right at each band's edge.
            c = floor(c * uLevels + 0.5 + (th - 0.5) * 0.4) / uLevels;
            // Outlines in a deeper shade of the object's own colour (not a flat dark line).
            vec3 ink = c * c * vec3(0.55, 0.5, 0.7);
            c = mix(c, ink, edge * 0.9);
          }
          gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
        }
      `,
    });
    // Upscale: nearest art pixel, scrolled by the camera's sub-pixel remainder so the
    // picture glides instead of stepping a whole pixel at a time.
    this.blit = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tPost: { value: this.post.texture },
        uRes: this.mat.uniforms.uRes,
        uSub: { value: new THREE.Vector2() },
        uScale: { value: 1 },
        uOffset: { value: new THREE.Vector2() },
        uView: { value: new THREE.Vector2(4, 4) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tPost;
        uniform vec2 uRes;
        uniform vec2 uSub;
        uniform vec2 uOffset;
        uniform float uScale;
        uniform vec2 uView;
        // Sharp bilinear: position in art pixels; inside a pixel the colour is flat, and only
        // within half a device pixel of a seam does it blend into the neighbour (linear
        // filtering does the blend). Smooth sub-pixel scrolling comes for free.
        void main() {
          vec2 p = (gl_FragCoord.xy + uOffset) / uScale + uSub;
          vec2 seam = floor(p + 0.5);
          p = seam + clamp((p - seam) * uScale, -0.5, 0.5);
          vec3 c = texture2D(tPost, p / uRes).rgb;
          // The screen vignette (it used to be a CSS layer blended over the whole canvas every
          // frame): radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(20,18,10,.32)),
          // its ellipse reaching the farthest corner (1.579 x the closest-side ellipse).
          vec2 q = (gl_FragCoord.xy / uView - vec2(0.5, 0.55)) / vec2(0.5, 0.45);
          float vig = 0.32 * clamp((length(q) / 1.5792 - 0.55) / 0.45, 0.0, 1.0);
          gl_FragColor = vec4(mix(c, vec3(0.0784, 0.0706, 0.0392), vig), 1.0);
        }
      `,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /**
   * Shade `mesh` (the pitch) once per art pixel. `lights` are put on the grass layer with
   * it. The grass pass reuses the last shadow map (redrawn every other frame anyway).
   */
  setGrass(mesh: THREE.Mesh, lights: THREE.Object3D[]): void {
    mesh.layers.enable(GRASS_LAYER);
    for (const l of lights) l.layers.enable(GRASS_LAYER);
    const rt = new THREE.WebGLRenderTarget(this.artW, this.artH, {
      type: this.compact ? THREE.UnsignedInt101111Type : THREE.HalfFloatType,
      format: this.compact ? THREE.RGBFormat : THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
    });
    rt.texture.generateMipmaps = false;
    const copy = new THREE.ShaderMaterial({
      uniforms: { tGrass: { value: rt.texture }, uSS: { value: this.ss } },
      vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform sampler2D tGrass;
        uniform int uSS;
        void main() { gl_FragColor = vec4(texelFetch(tGrass, ivec2(gl_FragCoord.xy) / uSS, 0).rgb, 1.0); }`,
    });
    this.grass = { mesh, material: mesh.material as THREE.Material, rt, copy };
  }

  /** Palette look (null = the smooth-banded pixel look). */
  setPalette(p: Palette | null): void {
    const u = this.mat.uniforms;
    u.uPalOn.value = p ? 1 : 0;
    if (!p) return;
    const n = Math.min(MAX_PAL, p.colors.length);
    u.uPalN.value = n;
    for (let i = 0; i < n; i++) {
      const rgb = hexRGB(p.colors[i]);
      (u.uPalRGB.value as THREE.Vector3[])[i].set(...rgb);
      (u.uPal.value as THREE.Vector3[])[i].set(...oklab(rgb));
    }
    u.uDither.value = p.dither;
    u.uPreSat.value = p.sat;
    u.uPreCon.value = p.contrast;
    u.uGrain.value = p.grain;
  }

  /** Art resolution for a drawing buffer of w x h *device* pixels: exactly `height` tall. */
  resize(w: number, h: number): void {
    this.devW = w;
    this.devH = h;
    const lh = Math.max(16, Math.min(h, Math.round(this.height)));
    const scale = h / lh;
    const lw = Math.ceil(w / scale);
    this.artW = lw;
    this.artH = lh;
    this.target.setSize(lw * this.ss, lh * this.ss);
    this.post.setSize(lw, lh);
    if (this.grass) {
      this.grass.rt.setSize(lw, lh);
      this.grass.copy.uniforms.uSS.value = this.ss;
    }
    (this.mat.uniforms.uRes.value as THREE.Vector2).set(lw, lh);
    this.mat.uniforms.uSS.value = this.ss;
    this.blit.uniforms.uScale.value = scale;
    (this.blit.uniforms.uView.value as THREE.Vector2).set(w, h);
    (this.blit.uniforms.uOffset.value as THREE.Vector2).set((lw * scale - w) / 2, 0);
  }

  /** Turn supersampling on or off (performance), keeping the same art resolution. */
  setSupersample(ss: number): void {
    if (ss === this.ss) return;
    this.ss = ss;
    this.resize(this.devW, this.devH);
  }

  get pixelHeight(): number {
    return this.artH;
  }

  get pixelWidth(): number {
    return this.artW;
  }

  /** The world pass alone (the grass first, at art resolution) into `target`. */
  renderWorld(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    const g = this.grass;
    // (With one sample a pixel the world pass already shades the grass once per art pixel.)
    const grassOn = !!g && this.ss > 1 && g.mesh.visible && g.mesh.parent !== null;
    if (grassOn) {
      // The grass alone, one fragment per art pixel (the camera sees only the grass layer;
      // the shadow map isn't redrawn here: it would only hold what's on that layer).
      const shadows = renderer.shadowMap.needsUpdate;
      renderer.shadowMap.needsUpdate = false;
      const mask = camera.layers.mask;
      camera.layers.set(GRASS_LAYER);
      renderer.setRenderTarget(g.rt);
      renderer.render(scene, camera);
      camera.layers.mask = mask;
      renderer.shadowMap.needsUpdate = shadows;
      g.mesh.material = g.copy;
    }
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    if (grassOn) g.mesh.material = g.material;
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, night: number, cool = 1, subX = 0, subY = 0): void {
    (this.blit.uniforms.uSub.value as THREE.Vector2).set(subX, subY);
    this.mat.uniforms.uCool.value = cool;
    this.mat.uniforms.uExposure.value = renderer.toneMappingExposure;
    this.mat.uniforms.uNear.value = camera.near;
    this.mat.uniforms.uFar.value = camera.far;
    this.mat.uniforms.uNight.value = night;
    this.renderWorld(renderer, scene, camera);
    this.quad.material = this.mat;
    renderer.setRenderTarget(this.post);
    renderer.render(this.scene, this.cam);
    this.quad.material = this.blit;
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.cam);
  }
}
