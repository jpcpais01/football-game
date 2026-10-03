import type { Match } from '../sim/match';
import { PITCH } from '../sim/constants';

const hexes = new Map<number, string>();
const hex = (c: number) => hexes.get(c) ?? (hexes.set(c, '#' + c.toString(16).padStart(6, '0')), hexes.get(c)!);
/** Perceived brightness 0..255 (to give light kits a dark rim on the light pitch lines). */
const lum = (c: number) => 0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255);

/**
 * The radar at the bottom of the screen: the pitch from above, both teams as dots in their
 * shirt colours, the ball, and the player you control ringed. The same way round as the
 * match camera (home attacking right, the near touchline at the bottom). Drawn on a small
 * canvas every frame.
 */
export class Minimap {
  private el = document.createElement('div');
  private cv = document.createElement('canvas');
  private g = this.cv.getContext('2d')!;
  /** The pitch and its markings, drawn once per size. */
  private bg = document.createElement('canvas');
  private W = 0;
  private H = 0;
  private dpr = Math.min(2, window.devicePixelRatio || 1);
  /** Measure again before the next draw (reading the layout every draw forces a reflow). */
  private dirty = true;

  constructor(parent: HTMLElement) {
    this.el.className = 'minimap';
    this.el.appendChild(this.cv);
    parent.appendChild(this.el);
    window.addEventListener('resize', () => (this.dirty = true));
  }

  setVisible(v: boolean): void {
    this.el.style.display = v ? '' : 'none';
    this.dirty = true;
  }

  private size(): void {
    this.dirty = false;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(this.el.clientWidth);
    const h = Math.round((w * PITCH.width) / PITCH.length);
    if (w === this.W && h === this.H) return;
    this.W = w;
    this.H = h;
    this.cv.width = this.bg.width = Math.round(w * this.dpr);
    this.cv.height = this.bg.height = Math.round(h * this.dpr);
    this.cv.style.height = `${h}px`;
    if (w) this.drawPitch();
  }

  private drawPitch(): void {
    const { W, H } = this;
    const g = this.bg.getContext('2d')!;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const sx = W / PITCH.length;
    const sz = H / PITCH.width;
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
  }

  update(m: Match): void {
    if (this.dirty) this.size();
    const { W, H, g } = this;
    if (!W) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.cv.width, this.cv.height);
    g.drawImage(this.bg, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const sx = W / PITCH.length;
    const sz = H / PITCH.width;
    const px = (x: number) => (x + PITCH.halfL) * sx;
    const pz = (z: number) => (z + PITCH.halfW) * sz;

    // Players: the opponents first, so your team draws on top. One path per shirt colour.
    const r = Math.max(2.2, W / 64);
    g.lineWidth = 1;
    for (let ti = 0; ti < 2; ti++) {
      const t = ti === 0 ? 1 - m.humanTeam : m.humanTeam;
      const kit = m.teams[t].info.kit;
      for (let gi = 0; gi < 2; gi++) {
        const gk = gi === 1;
        const c = gk ? kit.gkShirt : kit.shirt;
        g.fillStyle = hex(c);
        g.strokeStyle = lum(c) > 150 ? 'rgba(10, 12, 20, 0.85)' : 'rgba(244, 239, 227, 0.8)';
        g.beginPath();
        for (const p of m.teams[t].players) {
          if ((p.role === 'GK') !== gk) continue;
          const x = px(p.pos.x);
          const y = pz(p.pos.z);
          g.moveTo(x + r, y);
          g.arc(x, y, r, 0, Math.PI * 2);
        }
        g.fill();
        g.stroke();
      }
    }
    // The player you control.
    const c = m.controlled;
    g.strokeStyle = '#ffd447';
    g.lineWidth = 1.6;
    g.beginPath();
    g.arc(px(c.pos.x), pz(c.pos.z), r + 2.2, 0, Math.PI * 2);
    g.stroke();
    // Ball (a little bigger when it's in the air).
    const b = m.ball.pos;
    g.fillStyle = '#ffffff';
    g.strokeStyle = 'rgba(10, 12, 20, 0.9)';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(px(b.x), pz(b.z), r * 0.8 + Math.min(2, b.y * 0.25), 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }
}
