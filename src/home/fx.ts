/** Lightweight 2D particle layer for pack openings: sparks, embers, confetti, shockwaves. */

interface P {
  kind: 0 | 1 | 2 | 3; // 0 spark streak, 1 glow ember, 2 confetti, 3 ring
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

export class Fx {
  readonly canvas = document.createElement('canvas');
  private g = this.canvas.getContext('2d')!;
  private ps: P[] = [];
  private raf = 0;
  private last = 0;
  private dpr = Math.min(2, window.devicePixelRatio || 1);

  constructor() {
    this.canvas.className = 'fx-canvas';
  }

  private resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (this.canvas.width !== Math.round(w * this.dpr) || this.canvas.height !== Math.round(h * this.dpr)) {
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);
    }
  }

  private add(p: Partial<P> & Pick<P, 'x' | 'y'>): void {
    if (this.ps.length > 900) return;
    this.ps.push({ kind: 1, vx: 0, vy: 0, life: 0, max: 1, size: 3, color: '#fff', rot: 0, vr: 0, drag: 1.5, grav: 0, ...p });
    if (!this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  /** Radial explosion of streaks and embers. */
  burst(x: number, y: number, colors: string[], count = 80, speed = 900): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.25 + Math.random() * 0.75);
      const c = colors[i % colors.length];
      this.add({ kind: i % 3 === 0 ? 1 : 0, x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, max: 0.6 + Math.random() * 0.9, size: 2 + Math.random() * 3, color: c, drag: 2.6, grav: 260 });
    }
  }

  /** Expanding shockwave ring. */
  ring(x: number, y: number, color: string, size = 400, life = 0.7): void {
    this.add({ kind: 3, x, y, max: life, size, color, drag: 0 });
  }

  /** Embers drifting up around a point (the pack charging). */
  embers(x: number, y: number, color: string, count = 6, spread = 120): void {
    for (let i = 0; i < count; i++) {
      this.add({ kind: 1, x: x + (Math.random() - 0.5) * spread, y: y + (Math.random() - 0.3) * spread, vx: (Math.random() - 0.5) * 60, vy: -80 - Math.random() * 160, max: 0.8 + Math.random() * 0.8, size: 1.5 + Math.random() * 2.5, color, drag: 0.6, grav: -40 });
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
      this.add({ kind: i % 2 ? 2 : 0, x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, max: 1.6 + Math.random(), size: 4 + Math.random() * 4, color: colors[i % colors.length], rot: Math.random() * 6, vr: (Math.random() - 0.5) * 16, drag: 1.2, grav: 700 });
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
    const d = this.dpr;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.globalCompositeOperation = 'lighter';
    let alive = 0;
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
      const t = p.life / p.max;
      const a = 1 - t;
      if (p.kind === 0) {
        g.strokeStyle = p.color;
        g.globalAlpha = a;
        g.lineWidth = p.size * 0.6;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(p.x, p.y);
        g.lineTo(p.x - p.vx * 0.04, p.y - p.vy * 0.04);
        g.stroke();
      } else if (p.kind === 1) {
        const r = p.size * (1 + t);
        const grd = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3);
        grd.addColorStop(0, p.color);
        grd.addColorStop(1, 'transparent');
        g.globalAlpha = a;
        g.fillStyle = grd;
        g.fillRect(p.x - r * 3, p.y - r * 3, r * 6, r * 6);
      } else if (p.kind === 2) {
        g.globalCompositeOperation = 'source-over';
        g.globalAlpha = Math.min(1, a * 3);
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        g.scale(1, Math.cos(p.rot * 1.7));
        g.fillStyle = p.color;
        g.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        g.restore();
        g.globalCompositeOperation = 'lighter';
      } else {
        const r = p.size * (1 - Math.pow(1 - t, 3));
        g.globalAlpha = a * 0.9;
        g.strokeStyle = p.color;
        g.lineWidth = 2 + 14 * a;
        g.beginPath();
        g.arc(p.x, p.y, r, 0, Math.PI * 2);
        g.stroke();
      }
    }
    this.ps.length = alive;
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    this.raf = alive ? requestAnimationFrame(this.tick) : 0;
    if (!alive) g.clearRect(0, 0, this.canvas.width, this.canvas.height);
  };
}
