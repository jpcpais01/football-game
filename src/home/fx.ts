/**
 * Pack-opening effects, built to stay at full frame rate on phones:
 * - particles are drawn from small pre-rendered sprites (one per colour, cached), never
 *   from per-particle gradients; the canvas runs at a capped resolution and only while
 *   something is alive;
 * - light rays are painted once into a canvas (soft tapered beams, radial fade baked in)
 *   and spun with a CSS transform, so the compositor does the work.
 */

interface P {
  kind: 0 | 1 | 2 | 3 | 4; // 0 spark streak, 1 glow ember, 2 confetti, 3 ring, 4 twinkle star
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  rot: number;
  vr: number;
  drag: number;
  grav: number;
}

const MAX_PARTICLES = 420;
const DPR = Math.min(1.5, window.devicePixelRatio || 1);

/** Soft round glow, white core into the colour. */
const glowCache = new Map<string, HTMLCanvasElement>();
function glowSprite(color: string): HTMLCanvasElement {
  let cv = glowCache.get(color);
  if (cv) return cv;
  cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, '#ffffff');
  grd.addColorStop(0.18, color);
  grd.addColorStop(0.45, color + '55');
  grd.addColorStop(1, color + '00');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  glowCache.set(color, cv);
  return cv;
}

/** Four-point twinkle with a soft halo. */
const starCache = new Map<string, HTMLCanvasElement>();
function starSprite(color: string): HTMLCanvasElement {
  let cv = starCache.get(color);
  if (cv) return cv;
  cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d')!;
  const halo = g.createRadialGradient(32, 32, 0, 32, 32, 22);
  halo.addColorStop(0, color + 'aa');
  halo.addColorStop(1, color + '00');
  g.fillStyle = halo;
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.moveTo(32, 2);
  g.quadraticCurveTo(34, 30, 62, 32);
  g.quadraticCurveTo(34, 34, 32, 62);
  g.quadraticCurveTo(30, 34, 2, 32);
  g.quadraticCurveTo(30, 30, 32, 2);
  g.fill();
  starCache.set(color, cv);
  return cv;
}

/** Normalise any CSS colour we use ('#rgb', '#rrggbb') to '#rrggbb' so alpha suffixes work. */
function norm(c: string): string {
  if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c.slice(1).split('').map((ch) => ch + ch).join('');
  return c.length === 7 ? c : '#ffffff';
}

export class Fx {
  readonly canvas = document.createElement('canvas');
  private g = this.canvas.getContext('2d')!;
  private ps: P[] = [];
  private raf = 0;
  private last = 0;

  constructor() {
    this.canvas.className = 'fx-canvas';
    window.addEventListener('resize', () => (this.measured = false));
  }

  /** The canvas size is read when an effect starts and after a resize, not every frame
   * (reading it then forces a layout in the middle of the pack opening's animations). */
  private measured = false;

  private resize(): void {
    if (this.measured) return;
    this.measured = true;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const W = Math.round(w * DPR);
    const H = Math.round(h * DPR);
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
  }

  private add(p: Partial<P> & Pick<P, 'x' | 'y'>): void {
    if (this.ps.length >= MAX_PARTICLES) return;
    this.ps.push({ kind: 1, vx: 0, vy: 0, life: 0, max: 1, size: 3, color: '#ffffff', rot: 0, vr: 0, drag: 1.5, grav: 0, ...p, ...(p.color ? { color: norm(p.color) } : {}) });
    if (!this.raf) {
      this.measured = false;
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  /** Radial explosion: streaks, glowing embers and a few twinkles. */
  burst(x: number, y: number, colors: string[], count = 80, speed = 900): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.25 + Math.random() * 0.75);
      const kind = i % 7 === 0 ? 4 : i % 3 === 0 ? 1 : 0;
      this.add({ kind, x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, max: 0.6 + Math.random() * 0.9, size: kind === 4 ? 10 + Math.random() * 10 : 2 + Math.random() * 3, color: colors[i % colors.length], drag: 2.6, grav: kind === 4 ? 60 : 260 });
    }
  }

  /** Expanding shockwave ring. */
  ring(x: number, y: number, color: string, size = 400, life = 0.7): void {
    this.add({ kind: 3, x, y, max: life, size, color, drag: 0 });
  }

  /** Embers drifting up around a point (the pack charging). */
  embers(x: number, y: number, color: string, count = 6, spread = 120): void {
    for (let i = 0; i < count; i++) {
      this.add({ kind: i % 4 === 0 ? 4 : 1, x: x + (Math.random() - 0.5) * spread, y: y + (Math.random() - 0.3) * spread, vx: (Math.random() - 0.5) * 60, vy: -80 - Math.random() * 160, max: 0.8 + Math.random() * 0.8, size: i % 4 === 0 ? 8 + Math.random() * 8 : 2 + Math.random() * 3, color, drag: 0.6, grav: -40 });
    }
  }

  /** Confetti rain from the top of the screen. */
  confetti(colors: string[], count = 140): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    for (let i = 0; i < count; i++) {
      this.add({ kind: 2, x: Math.random() * w, y: -20 - Math.random() * 200, vx: (Math.random() - 0.5) * 160, vy: 120 + Math.random() * 220, max: 3 + Math.random() * 2, size: 5 + Math.random() * 6, color: colors[i % colors.length], rot: Math.random() * 6, vr: (Math.random() - 0.5) * 14, drag: 0.4, grav: 90 });
    }
  }

  /** Fountain shooting up from a point (legendary walkouts). */
  fountain(x: number, y: number, colors: string[], count = 60): void {
    for (let i = 0; i < count; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.1;
      const s = 500 + Math.random() * 700;
      this.add({ kind: i % 2 ? 2 : 4, x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, max: 1.6 + Math.random(), size: i % 2 ? 4 + Math.random() * 4 : 10 + Math.random() * 8, color: colors[i % colors.length], rot: Math.random() * 6, vr: (Math.random() - 0.5) * 16, drag: 1.2, grav: 700 });
    }
  }

  clear(): void {
    this.ps.length = 0;
  }

  private tick = (now: number): void => {
    const dt = Math.max(0, Math.min(0.05, (now - this.last) / 1000));
    this.last = now;
    this.resize();
    const g = this.g;
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    let alive = 0;
    // Additive pass: streaks, glows, twinkles, rings.
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    for (const p of this.ps) {
      p.life += dt;
      if (p.life >= p.max) continue;
      this.ps[alive++] = p;
      const k = Math.exp(-p.drag * dt);
      p.vx *= k;
      p.vy = p.vy * k + p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.kind === 2) continue;
      const t = p.life / p.max;
      const a = 1 - t;
      g.globalAlpha = a;
      if (p.kind === 0) {
        g.strokeStyle = p.color;
        g.lineWidth = p.size * 0.6;
        g.beginPath();
        g.moveTo(p.x, p.y);
        g.lineTo(p.x - p.vx * 0.04, p.y - p.vy * 0.04);
        g.stroke();
      } else if (p.kind === 1) {
        const r = p.size * (3 + 2 * t);
        g.drawImage(glowSprite(p.color), p.x - r, p.y - r, r * 2, r * 2);
      } else if (p.kind === 4) {
        // Twinkle: grows in, pulses, fades.
        const r = p.size * Math.min(1, t * 6) * (0.8 + 0.2 * Math.sin(p.life * 22));
        g.drawImage(starSprite(p.color), p.x - r, p.y - r, r * 2, r * 2);
      } else {
        const r = p.size * (1 - Math.pow(1 - t, 3));
        g.globalAlpha = a * 0.85;
        g.strokeStyle = p.color;
        g.lineWidth = 2 + 12 * a;
        g.beginPath();
        g.arc(p.x, p.y, r, 0, Math.PI * 2);
        g.stroke();
      }
    }
    this.ps.length = alive;
    // Normal pass: confetti (opaque paper).
    g.globalCompositeOperation = 'source-over';
    for (const p of this.ps) {
      if (p.kind !== 2) continue;
      const a = 1 - p.life / p.max;
      g.globalAlpha = Math.min(1, a * 3);
      const c = Math.cos(p.rot);
      const s = Math.sin(p.rot);
      const flip = Math.cos(p.rot * 1.7);
      g.setTransform(DPR * c, DPR * s, -DPR * s * flip, DPR * c * flip, DPR * p.x, DPR * p.y);
      g.fillStyle = p.color;
      g.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    this.raf = alive ? requestAnimationFrame(this.tick) : 0;
    if (!alive) g.clearRect(0, 0, this.canvas.width, this.canvas.height);
  };
}

/**
 * Light rays behind the pack and the cards: soft tapered beams with a bright core, painted
 * once per colour into a canvas and rotated by CSS (cheap: no per-frame repaint).
 */
export class Rays {
  readonly canvas = document.createElement('canvas');
  private color = '';

  constructor() {
    this.canvas.className = 'op-rays';
    this.canvas.width = this.canvas.height = 640;
    this.set('#ffffff');
  }

  set(color: string): void {
    color = norm(color);
    if (color === this.color) return;
    this.color = color;
    const g = this.canvas.getContext('2d')!;
    const S = 640;
    const c = S / 2;
    g.clearRect(0, 0, S, S);
    g.globalCompositeOperation = 'lighter';
    // Beams of varying width and strength, like light through a stadium roof.
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const n = 18;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd() * 0.12;
      const w = 0.05 + rnd() * 0.07;
      const strength = 0.35 + rnd() * 0.65;
      const grd = g.createRadialGradient(c, c, 0, c, c, c);
      grd.addColorStop(0, color + 'ff');
      grd.addColorStop(0.25, color + Math.round(150 * strength).toString(16).padStart(2, '0'));
      grd.addColorStop(1, color + '00');
      g.fillStyle = grd;
      g.beginPath();
      g.moveTo(c, c);
      g.arc(c, c, c, a - w, a + w);
      g.closePath();
      g.fill();
    }
    // Hot centre.
    const core = g.createRadialGradient(c, c, 0, c, c, c * 0.45);
    core.addColorStop(0, '#ffffffcc');
    core.addColorStop(0.3, color + '88');
    core.addColorStop(1, color + '00');
    g.fillStyle = core;
    g.fillRect(0, 0, S, S);
    g.globalCompositeOperation = 'source-over';
  }
}
