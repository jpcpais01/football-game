/**
 * Sound is synthesised with WebAudio, except the crowd itself: a recorded bed (five
 * offset, drifting copies of one loop, so the seam is never heard) that breathes with the
 * danger on the pitch, and a recorded goal roar. Strikes, whistle, woodwork, net, menus.
 */
import { ChantAudio } from './chantAudio';
import type { Terraces } from './terraces';

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  /** The crowd bed's overall level (excitement, the goal mouth, menus). */
  private crowdGain!: GainNode;
  /** The recordings, once fetched and decoded. */
  private goalRoar: AudioBuffer | null = null;
  /** Everything the crowd makes (bed, chatter, chants, gasps, roars): off at the bare pitch. */
  private crowdBus!: GainNode;
  private crowdOn = true;
  private crowdOff: ReturnType<typeof setTimeout> | undefined;
  private noise!: AudioBuffer;
  private chants: ChantAudio | null = null;
  private rainGain: GainNode | null = null;
  private raining = false;
  private rainOff: ReturnType<typeof setTimeout> | undefined;
  private excite = 0.2;
  private mouth = 0;
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

    this.crowdBus = ctx.createGain();
    this.crowdBus.gain.value = this.crowdOn ? 1 : 0;
    if (this.crowdOn) this.crowdBus.connect(this.master);

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

    // Crowd bed: the recording, five copies started a fifth of a loop apart, each at its
    // own slightly different speed and wandering in level, so no loop point stands out.
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0.3;
    // A limiter on the bed alone, so the goal-mouth surge can go very loud without clipping.
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -8;
    lim.knee.value = 4;
    lim.ratio.value = 20;
    lim.attack.value = 0.005;
    lim.release.value = 0.2;
    this.crowdGain.connect(lim).connect(this.crowdBus);
    void this.load('audio/crowd-bed.mp3').then((buf) => {
      if (!buf) return;
      for (let i = 0; i < 5; i++) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        // Skip the mp3's encoder padding at either end.
        src.loopStart = 0.06;
        src.loopEnd = buf.duration - 0.06;
        src.playbackRate.value = 0.96 + 0.02 * i + Math.random() * 0.01;
        const g = ctx.createGain();
        g.gain.value = 0.5;
        src.connect(g).connect(this.crowdGain);
        src.start(ctx.currentTime, 0.06 + (i / 5) * (buf.duration - 0.12));
        const drift = () => {
          g.gain.setTargetAtTime(0.25 + Math.random() * 0.55, ctx.currentTime, 0.8 + Math.random());
          setTimeout(drift, 1500 + Math.random() * 3000);
        };
        drift();
      }
    });
    void this.load('audio/crowd-goal.mp3').then((buf) => (this.goalRoar = buf));

    // The terraces: chants, drums, claps (see ChantAudio).
    this.chants = new ChantAudio(ctx, this.crowdBus, this.noise);

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
    this.rainGain.gain.value = this.raining ? 0.11 : 0;
    rain.connect(hp).connect(shelf).connect(this.rainGain);
    if (this.raining) this.rainGain.connect(this.master);
    rain.start();
  }

  /** Rain on (or off) the stadium. */
  setRain(on: boolean): void {
    if (on === this.raining) return;
    this.raining = on;
    if (!this.ctx || !this.rainGain) return;
    const g = this.rainGain;
    clearTimeout(this.rainOff);
    // A dry ground unplugs the rain chain once it has faded (nothing left to compute).
    if (on) g.connect(this.master);
    else this.rainOff = setTimeout(() => !this.raining && g.disconnect(), 4000);
    g.gain.setTargetAtTime(on ? 0.11 : 0, this.ctx.currentTime, 0.6);
  }

  /** A ground with or without a crowd. Without, the crowd's whole chain is unplugged
   * once it has faded (nothing left to compute). */
  setCrowd(on: boolean): void {
    this.crowdOn = on;
    if (!this.ctx) return;
    const g = this.crowdBus;
    clearTimeout(this.crowdOff);
    if (on) g.connect(this.master);
    else this.crowdOff = setTimeout(() => !this.crowdOn && g.disconnect(), 1500);
    g.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.2);
  }

  /** Sing what the terraces are singing (call every frame). */
  terraces(dir: Terraces): void {
    if (this.ctx && this.chants && this.ctx.state === 'running') this.chants.update(dir);
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

  private async load(url: string): Promise<AudioBuffer | null> {
    try {
      const res = await fetch(import.meta.env.BASE_URL + url);
      return await this.ctx!.decodeAudioData(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  /**
   * The crowd's level. `e` is the match excitement (0..1); `mouth` (0..1) is how close the
   * ball is to the goal line in front of a goal: the last few metres make the bed surge.
   */
  setExcitement(e: number, mouth = 0): void {
    if (!this.ctx) return;
    if (Math.abs(e - this.excite) < 0.01 && Math.abs(mouth - this.mouth) < 0.01) return;
    const t = this.ctx.currentTime;
    if (this.excite < 0) this.chants?.out.gain.setTargetAtTime(1, t, 0.5);
    this.excite = e;
    this.mouth = mouth;
    this.crowdGain.gain.setTargetAtTime((0.2 + e * 0.6) * (1 + 6 * mouth), t, mouth > 0 ? 0.15 : 0.4);
  }

  private noiseBurst(t: number, dur: number, type: BiquadFilterType, freq: number, q: number, gain: number, rate = 1, out: AudioNode = this.master): void {
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
    src.connect(f).connect(g).connect(out);
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
    this.noiseBurst(this.ctx.currentTime, 1.4, 'bandpass', 700, 0.6, 0.35, 0.9, this.crowdBus);
  }

  /**
   * The roar, held at full for `hold` seconds (the recording chained into itself with
   * crossfades if it's longer than one take), then fading. The pack reveal borrows it,
   * crowd or no crowd.
   */
  goal(hold = 0, out: AudioNode = this.crowdBus): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    if (this.goalRoar) {
      const skip = 0.1; // the recording opens with a beat of dead air
      const take = this.goalRoar.duration - skip;
      const xf = 1;
      const g = ctx.createGain();
      g.gain.value = 1.1;
      g.connect(out);
      if (hold > take) g.gain.setTargetAtTime(0.0001, t + hold, 1.2);
      const until = hold > take ? t + hold + 5 : t + take;
      for (let at = t, first = true; at < until; at += take - xf, first = false) {
        const src = ctx.createBufferSource();
        src.buffer = this.goalRoar;
        const env = ctx.createGain();
        env.gain.setValueAtTime(first ? 1 : 0.0001, at);
        if (!first) env.gain.linearRampToValueAtTime(1, at + xf);
        env.gain.setValueAtTime(1, at + take - xf);
        env.gain.linearRampToValueAtTime(0.0001, at + take);
        src.connect(env).connect(g);
        src.start(at, skip);
        src.stop(Math.min(at + take, until));
      }
      return;
    }
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
    src.connect(f).connect(g).connect(out);
    src.start(t);
    src.stop(t + 7);
  }

  // ---------------------------------------------------------------- menus & packs

  /** Menus: the crowd sinks to a distant murmur (or silence inside a pack opening). */
  setAmbience(level: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.excite = -1;
    this.chants?.out.gain.setTargetAtTime(0.35 * level, t, 0.5);
    this.crowdGain.gain.setTargetAtTime(0.2 * level, t, 0.5);
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
      this.goal(0, this.master);
    }
  }
}
