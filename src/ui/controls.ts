import { Btn, type InputState, makeInput } from '../sim/input';

/**
 * FIFA-Mobile style controls: floating joystick on the left, contextual action buttons
 * on the right (Pass / Through / Shoot in attack, Switch / Press / Tackle in defence),
 * plus Sprint. Keyboard works too for desktop testing.
 */

const LABELS = {
  attack: ['PASS', 'THROUGH', 'SHOOT', 'SPRINT'],
  // Lining up your corner / goal kick: what each button does with the ball on the ring.
  corner: ['WHIP', 'SHORT', 'FLOAT', 'SPRINT'],
  goalkick: ['DRIVE', 'SHORT', 'FLOAT', 'SPRINT'],
  defend: ['TACKLE', 'SWITCH', 'PRESS', 'SPRINT<br><small>▼ TACKLE · ◀ SLIDE</small>'],
  // After your goal (same order as CELEBRATIONS in the match).
  celebrate: ['KNEE<br>SLIDE', 'AERO<br>PLANE', 'SIUU', 'BACK<br>FLIP'],
};
export type Mode = keyof typeof LABELS;

export class Controls {
  readonly input: InputState = makeInput();
  private root: HTMLElement;
  private joyBase: HTMLElement;
  private joyKnob: HTMLElement;
  private joyId = -1;
  private joyCx = 0;
  private joyCy = 0;
  private joyR = 56;
  private btnEls: HTMLElement[] = [];
  private sprintEl: HTMLElement;
  private btnPointer: number[] = [-1, -1, -1];
  private btnDownAt: number[] = [0, 0, 0];
  private btnStartY: number[] = [0, 0, 0];
  private sprintPointer = -1;
  private sprintStartX = 0;
  private sprintStartY = 0;
  /** Sprint swipe this press: 0 none, 1 tackle (slid down), 2 slide tackle (slid left). */
  private sprintSwipe = 0;
  mode: Mode = 'attack';
  /** The celebration picked (0-3: Pass, Through, Shoot, Sprint), -1 = none yet. */
  private picked = -1;
  private keys = new Set<string>();
  private keySprint = false;
  enabled = true;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'controls';
    this.root.innerHTML = `
      <div class="joy-zone"></div>
      <div class="joy-base"><div class="joy-knob"></div></div>
      <div class="btn btn-sprint"><span>SPRINT</span></div>
      <div class="btn btn-a"><span>PASS</span></div>
      <div class="btn btn-b"><span>THROUGH</span></div>
      <div class="btn btn-c"><span>SHOOT</span><i class="power"></i></div>
    `;
    parent.appendChild(this.root);
    const zone = this.root.querySelector('.joy-zone') as HTMLElement;
    this.joyBase = this.root.querySelector('.joy-base') as HTMLElement;
    this.joyKnob = this.root.querySelector('.joy-knob') as HTMLElement;
    this.btnEls = [this.root.querySelector('.btn-a')!, this.root.querySelector('.btn-b')!, this.root.querySelector('.btn-c')!] as HTMLElement[];
    this.sprintEl = this.root.querySelector('.btn-sprint') as HTMLElement;
    this.resetJoyPosition();

    zone.addEventListener('pointerdown', (e) => this.joyStart(e));
    window.addEventListener(
      'pointermove',
      (e) => {
        this.joyMove(e);
        this.buttonSwipe(e);
      },
      { passive: false },
    );
    window.addEventListener('pointerup', (e) => this.pointerEnd(e));
    window.addEventListener('pointercancel', (e) => this.pointerEnd(e));

    this.btnEls.forEach((el, i) => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (!this.enabled) return;
        el.setPointerCapture?.(e.pointerId);
        this.btnPointer[i] = e.pointerId;
        this.btnStartY[i] = e.clientY;
        this.press(i as Btn);
      });
    });
    this.sprintEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.sprintEl.setPointerCapture?.(e.pointerId);
      this.sprintPointer = e.pointerId;
      this.sprintStartX = e.clientX;
      this.sprintStartY = e.clientY;
      this.sprintSwipe = 0;
      this.sprintEl.classList.add('down');
    });

    window.addEventListener('keydown', (e) => this.key(e, true));
    window.addEventListener('keyup', (e) => this.key(e, false));
    window.addEventListener('blur', () => this.releaseAll());
    window.addEventListener('resize', () => this.resetJoyPosition());
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
    if (!v) this.releaseAll();
  }

  setMode(mode: Mode, picked = -1): void {
    if (mode === this.mode && picked === this.picked) return;
    this.mode = mode;
    this.picked = picked;
    const labels = LABELS[mode];
    const all = [...this.btnEls, this.sprintEl];
    all.forEach((el, i) => {
      (el.querySelector('span') as HTMLElement).innerHTML = labels[i];
      el.classList.toggle('defend', mode === 'defend');
      el.classList.toggle('celebrate', mode === 'celebrate');
      el.classList.toggle('picked', mode === 'celebrate' && picked === i);
      el.classList.toggle('faded', mode === 'celebrate' && picked >= 0 && picked !== i);
    });
    this.root.classList.toggle('celebrating', mode === 'celebrate');
  }

  /** Per-frame: hold timers and the shot power ring. */
  update(dt: number): void {
    const inp = this.input;
    for (let i = 0; i < 3; i++) {
      if (inp.held[i]) inp.holdTime[i] += dt;
    }
    inp.sprint = this.sprintPointer >= 0 || this.keySprint;
    // Keyboard movement.
    if (this.joyId < 0) {
      let x = 0;
      let y = 0;
      if (this.keys.has('ArrowLeft') || this.keys.has('KeyA')) x -= 1;
      if (this.keys.has('ArrowRight') || this.keys.has('KeyD')) x += 1;
      if (this.keys.has('ArrowUp') || this.keys.has('KeyW')) y += 1;
      if (this.keys.has('ArrowDown') || this.keys.has('KeyS')) y -= 1;
      const m = Math.hypot(x, y);
      inp.moveX = m > 0 ? x / m : 0;
      inp.moveY = m > 0 ? y / m : 0;
    }
    const c = this.btnEls[2];
    const p = this.mode === 'attack' && inp.held[2] ? Math.min(1, inp.holdTime[2] / 0.85) : 0;
    // The shot ring: touch the style only when it visibly changes (steps of half a percent).
    const q = Math.round(p * 200);
    if (q !== this.ringQ) {
      if ((q > 0) !== (this.ringQ > 0)) c.classList.toggle('charging', q > 0);
      this.ringQ = q;
      c.style.setProperty('--p', (q / 200).toFixed(3));
    }
  }
  private ringQ = -1;

  /**
   * Sliding up on Pass / Through while holding = lofted ball (FIFA-Mobile style).
   * Sliding down on Sprint in defence = tackle; sliding left = slide tackle.
   */
  private buttonSwipe(e: PointerEvent): void {
    if (e.pointerId === this.sprintPointer && this.mode === 'defend') {
      const down = e.clientY - this.sprintStartY;
      const left = this.sprintStartX - e.clientX;
      const stage = left > 28 && left > down ? 2 : down > 28 ? 1 : 0;
      if (stage > this.sprintSwipe) {
        this.sprintSwipe = stage;
        this.input.tackleSwipe = stage === 2 ? 'slide' : 'tackle';
        this.sprintEl.classList.add('swipe-down');
        this.sprintEl.classList.toggle('slide', stage === 2);
      }
    }
    for (let i = 0; i < 2; i++) {
      if (this.btnPointer[i] !== e.pointerId) continue;
      const up = this.btnStartY[i] - e.clientY > 26;
      if (up !== this.input.swipe[i]) {
        this.input.swipe[i] = up;
        this.btnEls[i].classList.toggle('swipe', up);
      }
    }
  }

  private press(i: Btn): void {
    const inp = this.input;
    if (inp.held[i]) return;
    inp.held[i] = true;
    inp.holdTime[i] = 0;
    this.btnDownAt[i] = performance.now();
    inp.events.push({ btn: i, kind: 'down', hold: 0 });
    this.btnEls[i].classList.add('down');
  }

  private release(i: Btn): void {
    const inp = this.input;
    if (!inp.held[i]) return;
    inp.held[i] = false;
    const hold = (performance.now() - this.btnDownAt[i]) / 1000;
    inp.events.push({ btn: i, kind: 'up', hold, swipeUp: inp.swipe[i] });
    inp.holdTime[i] = 0;
    inp.swipe[i] = false;
    this.btnEls[i].classList.remove('down', 'swipe');
  }

  private releaseAll(): void {
    for (let i = 0; i < 3; i++) {
      this.btnPointer[i] = -1;
      this.release(i as Btn);
    }
    this.sprintPointer = -1;
    this.sprintEl.classList.remove('down', 'swipe-down', 'slide');
    this.joyId = -1;
    this.input.moveX = 0;
    this.input.moveY = 0;
    this.keys.clear();
    this.keySprint = false;
    this.resetJoyPosition();
  }

  private resetJoyPosition(): void {
    const h = window.innerHeight;
    this.joyCx = Math.max(110, window.innerWidth * 0.12);
    this.joyCy = h - Math.max(100, h * 0.26);
    this.joyBase.style.transform = `translate(${this.joyCx}px, ${this.joyCy}px)`;
    this.joyKnob.style.transform = 'translate(0px, 0px)';
    this.joyBase.classList.remove('active');
  }

  private joyStart(e: PointerEvent): void {
    e.preventDefault();
    if (!this.enabled || this.joyId >= 0) return;
    this.joyId = e.pointerId;
    this.joyCx = e.clientX;
    this.joyCy = e.clientY;
    this.joyBase.style.transform = `translate(${this.joyCx}px, ${this.joyCy}px)`;
    this.joyBase.classList.add('active');
    this.joyMove(e);
  }

  private joyMove(e: PointerEvent): void {
    if (e.pointerId !== this.joyId) return;
    e.preventDefault();
    let dx = e.clientX - this.joyCx;
    let dy = e.clientY - this.joyCy;
    const d = Math.hypot(dx, dy);
    const r = this.joyR;
    if (d > r) {
      // Drag the base along so the stick never "runs out".
      const over = d - r;
      this.joyCx += (dx / d) * over;
      this.joyCy += (dy / d) * over;
      this.joyBase.style.transform = `translate(${this.joyCx}px, ${this.joyCy}px)`;
      dx = (dx / d) * r;
      dy = (dy / d) * r;
    }
    this.joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    const m = Math.min(1, Math.hypot(dx, dy) / r);
    const dead = 0.12;
    const mm = m < dead ? 0 : (m - dead) / (1 - dead);
    const n = Math.max(1e-6, Math.hypot(dx, dy));
    this.input.moveX = (dx / n) * mm;
    this.input.moveY = (-dy / n) * mm;
  }

  private pointerEnd(e: PointerEvent): void {
    if (e.pointerId === this.joyId) {
      this.joyId = -1;
      this.input.moveX = 0;
      this.input.moveY = 0;
      this.resetJoyPosition();
    }
    for (let i = 0; i < 3; i++) {
      if (this.btnPointer[i] === e.pointerId) {
        this.btnPointer[i] = -1;
        this.release(i as Btn);
      }
    }
    if (e.pointerId === this.sprintPointer) {
      this.sprintPointer = -1;
      this.sprintEl.classList.remove('down', 'swipe-down', 'slide');
    }
  }

  private key(e: KeyboardEvent, down: boolean): void {
    if (e.repeat) return;
    // U / O: lofted pass / lofted through ball (the keyboard version of sliding up).
    if (e.code === 'KeyU' || e.code === 'KeyO') {
      e.preventDefault();
      const b = e.code === 'KeyU' ? Btn.A : Btn.B;
      if (down) {
        this.press(b);
        this.input.swipe[b] = true;
      } else this.release(b);
      return;
    }
    const map: Record<string, Btn> = { KeyJ: Btn.A, KeyK: Btn.B, KeyL: Btn.C, Space: Btn.C };
    if (e.code in map) {
      e.preventDefault();
      if (down) this.press(map[e.code]);
      else this.release(map[e.code]);
      return;
    }
    // N: the keyboard version of sliding down on Sprint (tackle; Shift+N = slide).
    if (e.code === 'KeyN') {
      if (down && this.mode === 'defend') this.input.tackleSwipe = e.shiftKey ? 'slide' : 'tackle';
      return;
    }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      this.keySprint = down;
      return;
    }
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
  }
}
