/**
 * All sound is synthesised with WebAudio: no audio files to download, instant start.
 * Crowd bed that breathes with the danger on the pitch, strikes, whistle, woodwork, net.
 */
export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private crowdGain!: GainNode;
  private chatterGain!: GainNode;
  private noise!: AudioBuffer;
  private excite = 0.2;
  muted = false;

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(comp).connect(ctx.destination);

    // Pink-ish noise buffer, shared by everything.
    const len = ctx.sampleRate * 4;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18;
    }

    // Crowd bed: low murmur + mid chatter with slow swells.
    const bed = ctx.createBufferSource();
    bed.buffer = this.noise;
    bed.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0.15;
    bed.connect(lp).connect(this.crowdGain).connect(this.master);
    bed.start();

    const chat = ctx.createBufferSource();
    chat.buffer = this.noise;
    chat.loop = true;
    chat.playbackRate.value = 1.37;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1100;
    bp.Q.value = 0.7;
    this.chatterGain = ctx.createGain();
    this.chatterGain.gain.value = 0.05;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.23;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.025;
    lfo.connect(lfoGain).connect(this.chatterGain.gain);
    lfo.start();
    chat.connect(bp).connect(this.chatterGain).connect(this.master);
    chat.start();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }

  suspend(): void {
    void this.ctx?.suspend();
  }

  resume(): void {
    void this.ctx?.resume();
  }

  setExcitement(e: number): void {
    if (!this.ctx) return;
    if (Math.abs(e - this.excite) < 0.01) return;
    this.excite = e;
    const t = this.ctx.currentTime;
    this.crowdGain.gain.setTargetAtTime(0.1 + e * 0.32, t, 0.4);
    this.chatterGain.gain.setTargetAtTime(0.04 + e * 0.1, t, 0.4);
  }

  private noiseBurst(t: number, dur: number, type: BiquadFilterType, freq: number, q: number, gain: number, rate = 1): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = rate;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 3);
    src.stop(t + dur + 0.05);
  }

  kick(strength: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(170 + strength * 40, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.09);
    const g = ctx.createGain();
    const v = 0.15 + strength * 0.65;
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13 + strength * 0.05);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.25);
    this.noiseBurst(t, 0.035 + strength * 0.03, 'highpass', 1600, 0.7, 0.1 + strength * 0.35, 1.6);
  }

  bounce(speed: number): void {
    if (!this.ctx || speed < 1.2) return;
    const s = Math.min(1, speed / 12);
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.07);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.25 * s, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.15);
  }

  whistle(kind: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const blasts = kind === 3 ? [0.35, 0.35, 1.1] : kind === 2 ? [0.3, 0.9] : [0.32];
    let t = ctx.currentTime + 0.02;
    for (const dur of blasts) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.setValueAtTime(0.12, t + dur - 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const trem = ctx.createGain();
      trem.gain.value = 0.6;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 28;
      const lg = ctx.createGain();
      lg.gain.value = 0.4;
      lfo.connect(lg).connect(trem.gain);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 4200;
      for (const f of [2750, 2930]) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = f;
        o.connect(trem);
        o.start(t);
        o.stop(t + dur + 0.05);
      }
      trem.connect(lp).connect(g).connect(this.master);
      lfo.start(t);
      lfo.stop(t + dur + 0.05);
      t += dur + 0.12;
    }
  }

  post(speed: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const v = Math.min(1, speed / 20) * 0.35;
    for (const [f, d] of [
      [523, 0.9],
      [1347, 0.6],
      [2211, 0.4],
      [3010, 0.25],
    ]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + d + 0.05);
    }
    this.crowdGasp();
  }

  net(speed: number): void {
    if (!this.ctx) return;
    this.noiseBurst(this.ctx.currentTime, 0.4, 'bandpass', 1300, 0.8, Math.min(0.5, speed / 30), 1.2);
  }

  crowdGasp(): void {
    if (!this.ctx) return;
    this.noiseBurst(this.ctx.currentTime, 1.4, 'bandpass', 700, 0.6, 0.35, 0.9);
  }

  goal(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 800;
    f.Q.value = 0.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9, t + 0.35);
    g.gain.setTargetAtTime(0.0001, t + 2.2, 1.1);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 7);
  }
}
