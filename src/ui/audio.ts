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
  private rainGain: GainNode | null = null;
  private raining = false;
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

    // Rain: a hiss of drops on the roofs and the turf, with a softer low rumble under it.
    const rain = ctx.createBufferSource();
    rain.buffer = this.noise;
    rain.loop = true;
    rain.playbackRate.value = 0.83;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1600;
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'peaking';
    shelf.frequency.value = 4200;
    shelf.gain.value = 5;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = this.raining ? 0.22 : 0;
    rain.connect(hp).connect(shelf).connect(this.rainGain).connect(this.master);
    rain.start();
  }

  /** Rain on (or off) the stadium. */
  setRain(on: boolean): void {
    if (on === this.raining) return;
    this.raining = on;
    if (this.ctx && this.rainGain) this.rainGain.gain.setTargetAtTime(on ? 0.22 : 0, this.ctx.currentTime, 0.6);
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

  // ---------------------------------------------------------------- menus & packs

  /** Menus: the crowd sinks to a distant murmur (or silence inside a pack opening). */
  setAmbience(level: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.excite = -1;
    this.crowdGain.gain.setTargetAtTime(0.1 * level, t, 0.5);
    this.chatterGain.gain.setTargetAtTime(0.04 * level, t, 0.5);
  }

  private tone(t: number, freq: number, dur: number, type: OscillatorType, gain: number, freqEnd = freq, attack = 0.005): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freqEnd !== freq) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  uiTap(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, 1250, 0.06, 'sine', 0.12, 900);
  }

  coins(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, 1568, 0.18, 'triangle', 0.16);
    this.tone(t + 0.08, 2093, 0.3, 'triangle', 0.16);
  }

  /** Pack charging up: each tap a little higher and louder. */
  packShake(level: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 0.25 + level * 0.1, 'bandpass', 500 + level * 500, 1.2, 0.25 + level * 0.12, 1.1);
    this.tone(t, 180 + level * 120, 0.5, 'sawtooth', 0.05 + level * 0.02, 360 + level * 260, 0.08);
    this.tone(t, 520 + level * 200, 0.35, 'sine', 0.08, 900 + level * 300);
  }

  packBurst(tier: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, 110, 1.2, 'sine', 0.55, 38);
    this.noiseBurst(t, 1.1, 'lowpass', 2400, 0.5, 0.6, 0.8);
    this.noiseBurst(t + 0.02, 1.6 + tier * 0.3, 'highpass', 5000, 0.4, 0.18, 1.3);
    const notes = [523, 659, 784, 1047, 1319, 1568];
    for (let i = 0; i < 3 + tier; i++) this.tone(t + 0.05 + i * 0.04, notes[i % notes.length] * (i >= 6 ? 2 : 1), 1.4, 'triangle', 0.07, undefined, 0.01);
  }

  /** A card flying in. */
  whoosh(): void {
    if (!this.ctx) return;
    this.noiseBurst(this.ctx.currentTime, 0.35, 'bandpass', 1800, 0.9, 0.18, 1.6);
  }

  /** Walkout beat: nation / position stingers. */
  stinger(step: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, 65, 0.7, 'sine', 0.5, 45);
    this.noiseBurst(t, 0.5, 'lowpass', 900, 0.7, 0.35, 0.7);
    this.tone(t, [392, 494, 587][step % 3], 0.9, 'triangle', 0.1);
  }

  /** The card turns face up. Better cards get a bigger chord. */
  reveal(tier: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const chords = [
      [523, 659],
      [523, 659, 784],
      [523, 659, 784, 1047],
      [440, 554, 659, 880, 1109, 1319],
      [392, 494, 587, 784, 988, 1175, 1568],
    ];
    const ch = chords[Math.min(4, tier)];
    ch.forEach((f, i) => this.tone(t + i * (tier >= 3 ? 0.07 : 0.04), f, 0.8 + tier * 0.5, tier >= 3 ? 'sawtooth' : 'triangle', tier >= 3 ? 0.04 : 0.09, undefined, 0.01));
    if (tier >= 2) this.noiseBurst(t, 0.9 + tier * 0.3, 'highpass', 6000, 0.5, 0.12 + tier * 0.04, 1.2);
    if (tier >= 3) {
      this.tone(t, 98, 2, 'sine', 0.4, 49);
      this.goal();
    }
  }
}
