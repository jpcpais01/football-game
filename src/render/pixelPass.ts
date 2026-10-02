import * as THREE from 'three';

/**
 * Pixel-art presentation. The world is rendered at a low resolution into an HDR target
 * (much cheaper than full resolution), then one full-screen pass:
 * - upscales with crisp, nearest-neighbour pixels,
 * - draws 1-pixel outlines on silhouettes found in the depth buffer,
 * - applies the filmic tone map and a 90s night grade (cool shadows, warm highlights),
 * - quantises colours with a light ordered dither so gradients become pixel bands.
 * The HUD and controls are DOM, so they stay sharp.
 */
export class PixelPass {
  readonly target: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.ShaderMaterial;
  /** Low-res height in pixels. */
  height = 380;

  constructor() {
    this.target = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      samples: 0,
    });
    this.target.texture.generateMipmaps = false;
    this.target.depthTexture = new THREE.DepthTexture(4, 4);
    this.target.depthTexture.type = THREE.UnsignedIntType;

    this.mat = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tColor: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        uRes: { value: new THREE.Vector2(4, 4) },
        uNear: { value: 1 },
        uFar: { value: 1500 },
        uLevels: { value: 22 },
        uOutline: { value: new THREE.Color(0x120f2a) },
        uNight: { value: 0 },
        uCool: { value: 1 },
        uSub: { value: new THREE.Vector2() },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform vec2 uRes;
        uniform vec2 uSub;
        uniform float uNear, uFar, uLevels, uNight, uCool;
        uniform vec3 uOutline;
        varying vec2 vUv;

        float linDepth(vec2 uv) {
          float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
          return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
        }
        float bayer4(vec2 p) {
          vec2 q = mod(floor(p), 4.0);
          int i = int(q.x + q.y * 4.0);
          float m[16];
          m[0]=0.0; m[1]=8.0; m[2]=2.0; m[3]=10.0; m[4]=12.0; m[5]=4.0; m[6]=14.0; m[7]=6.0;
          m[8]=3.0; m[9]=11.0; m[10]=1.0; m[11]=9.0; m[12]=15.0; m[13]=7.0; m[14]=13.0; m[15]=5.0;
          for (int k = 0; k < 16; k++) if (k == i) return m[k] / 16.0;
          return 0.0;
        }

        void main() {
          // Snap to the centre of the low-res pixel, scrolled by the camera's sub-pixel
          // remainder so the picture glides instead of stepping a whole pixel at a time.
          vec2 px = floor(vUv * uRes + uSub) + 0.5;
          vec2 uv = px / uRes;
          vec3 c = texture2D(tColor, uv).rgb;

          // Silhouette outlines: this pixel is clearly nearer than a neighbour.
          float d = linDepth(uv);
          vec2 e = 1.0 / uRes;
          float dn = max(max(linDepth(uv + vec2(e.x, 0.0)), linDepth(uv - vec2(e.x, 0.0))),
                         max(linDepth(uv + vec2(0.0, e.y)), linDepth(uv - vec2(0.0, e.y))));
          float edge = step(0.35 + d * 0.06, dn - d) * (1.0 - smoothstep(70.0, 110.0, d));

          // Soft glow: bright neighbours bleed light (white kits in the sun, chalk, LEDs,
          // sparkles). Cheap because the image is already low resolution.
          vec3 bloom = vec3(0.0);
          const int TAPS = 12;
          vec2 offs[12];
          offs[0] = vec2(2.0, 0.0); offs[1] = vec2(-2.0, 0.0); offs[2] = vec2(0.0, 2.0); offs[3] = vec2(0.0, -2.0);
          offs[4] = vec2(1.5, 1.5); offs[5] = vec2(-1.5, 1.5); offs[6] = vec2(1.5, -1.5); offs[7] = vec2(-1.5, -1.5);
          offs[8] = vec2(4.0, 0.0); offs[9] = vec2(-4.0, 0.0); offs[10] = vec2(0.0, 3.5); offs[11] = vec2(0.0, -3.5);
          for (int k = 0; k < TAPS; k++) {
            vec3 sc = texture2D(tColor, uv + offs[k] * e).rgb;
            bloom += max(sc - vec3(0.85), 0.0);
          }
          c += bloom / float(TAPS) * 0.9;

          // Clarity: a touch of local contrast against the 1-pixel neighbourhood, so shapes
          // (kits, numbers, mown stripes) read crisply at low resolution.
          vec3 nb = (texture2D(tColor, uv + vec2(e.x, 0.0)).rgb + texture2D(tColor, uv - vec2(e.x, 0.0)).rgb +
                     texture2D(tColor, uv + vec2(0.0, e.y)).rgb + texture2D(tColor, uv - vec2(0.0, e.y)).rgb) * 0.25;
          c = max(c + clamp(c - nb, -0.25, 0.25) * 0.35, 0.0);

          // Filmic tone map, then display gamma.
          c = toneMapping(c);
          c = pow(max(c, 0.0), vec3(1.0 / 2.2));

          // Ghibli palette: lush greens, teal-blue shadows by day (purple-blue at night),
          // golden highlights, a little more colour overall.
          float l = dot(c, vec3(0.299, 0.587, 0.114));
          float green = smoothstep(0.0, 0.08, c.g - max(c.r, c.b));
          c = mix(c, c * vec3(1.03, 1.06, 0.92), green * 0.6);
          vec3 shade = mix(vec3(0.84, 0.97, 1.1), vec3(0.86, 0.84, 1.14), uNight);
          c = mix(c, c * shade, (1.0 - l) * (0.32 + 0.2 * uNight) * uCool);
          c = mix(c, c * vec3(1.07, 1.0, 0.88), smoothstep(0.55, 1.0, l) * 0.4);
          c = mix(vec3(l), c, 1.12);

          // Pop, the way a good print does it rather than a filter: set a real black point,
          // a filmic S-curve for punchy mid-tones, then vibrance — muted colours (grass in
          // shade, kits under ACES) gain the most, already-saturated ones are left alone so
          // skin and sky stay believable.
          c = max(c - 0.03, 0.0) / 0.97;
          c = mix(c, c * c * (3.0 - 2.0 * c), 0.42);
          float hi = max(c.r, max(c.g, c.b));
          float lo = min(c.r, min(c.g, c.b));
          float sat = (hi - lo) / max(hi, 1e-3);
          float l2 = dot(c, vec3(0.299, 0.587, 0.114));
          c = mix(vec3(l2), c, 1.0 + 0.55 * (1.0 - sat) * smoothstep(0.03, 0.2, hi));
          // Light and shadow split: warm light, cool shade, a little stronger than before.
          c *= mix(vec3(0.94, 0.98, 1.08), vec3(1.05, 1.01, 0.95), smoothstep(0.2, 0.75, l2));

          // Quantise with an ordered dither: gradients turn into crisp pixel bands.
          float b = bayer4(px) - 0.5;
          c = floor(c * uLevels + 0.5 + b * 0.85) / uLevels;

          // Outlines in a deeper shade of the object's own colour (not a flat dark line).
          vec3 ink = c * c * vec3(0.55, 0.5, 0.7);
          c = mix(c, ink, edge * 0.9);
          gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
        }
      `,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  /** Low-res size for a screen of w×h CSS pixels. */
  resize(w: number, h: number): void {
    const lh = Math.round(Math.min(this.height, h));
    const lw = Math.max(1, Math.round((w / h) * lh));
    this.target.setSize(lw, lh);
    (this.mat.uniforms.uRes.value as THREE.Vector2).set(lw, lh);
  }

  get pixelHeight(): number {
    return this.target.height;
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, night: number, cool = 1, subX = 0, subY = 0): void {
    (this.mat.uniforms.uSub.value as THREE.Vector2).set(subX, subY);
    this.mat.uniforms.uCool.value = cool;
    this.mat.uniforms.uNear.value = camera.near;
    this.mat.uniforms.uFar.value = camera.far;
    this.mat.uniforms.uNight.value = night;
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.cam);
  }
}
