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
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform vec2 uRes;
        uniform float uNear, uFar, uLevels, uNight;
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
          // Snap to the centre of the low-res pixel.
          vec2 px = floor(vUv * uRes) + 0.5;
          vec2 uv = px / uRes;
          vec3 c = texture2D(tColor, uv).rgb;

          // Silhouette outlines: this pixel is clearly nearer than a neighbour.
          float d = linDepth(uv);
          vec2 e = 1.0 / uRes;
          float dn = max(max(linDepth(uv + vec2(e.x, 0.0)), linDepth(uv - vec2(e.x, 0.0))),
                         max(linDepth(uv + vec2(0.0, e.y)), linDepth(uv - vec2(0.0, e.y))));
          float edge = step(0.35 + d * 0.06, dn - d) * (1.0 - smoothstep(70.0, 110.0, d));

          // Filmic tone map, then display gamma.
          c = toneMapping(c);
          c = pow(max(c, 0.0), vec3(1.0 / 2.2));

          // 90s night grade: cool, slightly purple shadows; warm, creamy highlights.
          float l = dot(c, vec3(0.299, 0.587, 0.114));
          c = mix(c, c * vec3(0.86, 0.84, 1.14), (1.0 - l) * (0.3 + 0.25 * uNight));
          c = mix(c, c * vec3(1.06, 1.0, 0.9), smoothstep(0.55, 1.0, l) * 0.35);
          c = mix(vec3(l), c, 1.08); // a touch more colour

          // Quantise with an ordered dither: gradients turn into crisp pixel bands.
          float b = bayer4(px) - 0.5;
          c = floor(c * uLevels + 0.5 + b * 0.85) / uLevels;

          c = mix(c, uOutline, edge * 0.8);
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

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, night: number): void {
    this.mat.uniforms.uNear.value = camera.near;
    this.mat.uniforms.uFar.value = camera.far;
    this.mat.uniforms.uNight.value = night;
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.cam);
  }
}
