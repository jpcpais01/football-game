import type { Terraces, Vowel } from './terraces';

/**
 * The terraces, synthesised, on top of the recorded crowd bed: the ultras' bass drum and
 * crowd claps keeping the director's songs' rhythm, the Viking "HUH!", boos, and the
 * "ooooh" of a near miss. Voices are breath only (noise through the vowel's two
 * formants): pitched saws sounded like brass. Each end is panned to its side of the
 * ground, through a long stadium reverb.
 *
 * Beats are scheduled a little ahead from the director's song (lookahead scheduling).
 */

/** First and second formants (Hz) of each vowel, a big male crowd. */
const FORMANTS: Record<Vowel, [number, number]> = {
  a: [730, 1090],
  e: [530, 1840],
  i: [390, 1990],
  o: [570, 840],
  u: [320, 800],
};

/** The home end is louder than the travelling fans. */
const END_GAIN = [1, 0.62];
const END_PAN = [-0.55, 0.55];

export class ChantAudio {
  /** Overall level of the terraces (menus sink it). */
  readonly out: GainNode;
  private ends: GainNode[] = [];
  private scheduledId = -1;
  private scheduledTo = 0;
  constructor(
    private ctx: AudioContext,
    dest: AudioNode,
    private noise: AudioBuffer,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    // The bowl: a long, dark reverb (a decaying noise impulse, a touch of early echo off
    // the far stand), mixed under the dry sound.
    const verb = ctx.createConvolver();
    verb.buffer = this.impulse(2.2);
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    const dry = ctx.createGain();
    dry.gain.value = 0.55;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 3800;
    this.out.connect(tone);
    tone.connect(dry).connect(dest);
    tone.connect(verb).connect(wet).connect(dest);
    for (let e = 0; e < 2; e++) {
      const g = ctx.createGain();
      g.gain.value = END_GAIN[e];
      const pan = ctx.createStereoPanner();
      pan.pan.value = END_PAN[e];
      g.connect(pan).connect(this.out);
      this.ends.push(g);
    }
  }

  private impulse(seconds: number): AudioBuffer {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / ctx.sampleRate;
        // Dark tail (one-pole lowpass on the noise), and a slap-back off the far stand.
        lp += (Math.random() * 2 - 1 - lp) * 0.35;
        const slap = t > 0.18 && t < 0.24 ? 1.8 : 1;
        d[i] = lp * Math.pow(1 - i / len, 2.6) * Math.exp(-t * 1.1) * slap;
      }
    }
    return buf;
  }

  /** Schedule what the director's song needs over the next moment. */
  update(dir: Terraces): void {
    const ctx = this.ctx;
    const s = dir.singing;
    // Director time → audio time (a small fixed latency so nothing lands in the past).
    const toCtx = ctx.currentTime + 0.06 - dir.t;
    const horizon = dir.t + 0.35;
    if (dir.boos.length) for (const end of dir.boos.splice(0)) this.boo(end, ctx.currentTime + 0.15);
    if (dir.oohs.length) for (const lv of dir.oohs.splice(0)) this.ooh(lv, ctx.currentTime + 0.05);
    if (dir.erupts.length) for (const end of dir.erupts.splice(0)) this.erupt(end, ctx.currentTime + 0.02);
    if (dir.groans.length) for (const end of dir.groans.splice(0)) this.groan(end, ctx.currentTime + 0.05);
    if (!s) return;
    if (s.id !== this.scheduledId) {
      this.scheduledId = s.id;
      this.scheduledTo = s.start - 1e-3;
    }
    // (After a stall, don't play the backlog all at once.)
    const from = Math.max(this.scheduledTo, dir.t - 0.05);
    if (horizon <= from) return;
    this.scheduledTo = horizon;
    const bus = this.ends[s.end];
    const lv = s.level;
    // Fade in as the end joins in, out as it peters out.
    const swell = (t: number) => Math.min(1, (t - s.start) / 2.5 + 0.35, (s.until - t) / 2 + 0.2);

    if (!s.chant) {
      for (let i = 0; i < s.booms.length; i++) {
        const b = s.booms[i];
        if (b > from && b <= horizon) {
          const at = b + toCtx;
          this.drum(bus, at, 0.6);
          this.huh(bus, at + 0.05, 0.75 + 0.25 * (i / s.booms.length));
        }
      }
      // The roar at the end of it.
      const roar = s.booms[s.booms.length - 1] + 0.5;
      if (roar > from && roar <= horizon) this.roar(bus, roar + toCtx);
      return;
    }

    const c = s.chant;
    const beat = 60 / c.bpm;
    const loop = c.beats * beat;
    const k0 = Math.max(0, Math.floor((from - s.start) / loop));
    const k1 = Math.floor((horizon - s.start) / loop);
    for (let k = k0; k <= k1; k++) {
      const top = s.start + k * loop;
      for (const b of c.claps) {
        const t = top + b * beat;
        if (t > from && t <= horizon && t < s.until) this.clap(bus, t + toCtx, lv * swell(t));
      }
      for (const b of c.drum) {
        const t = top + b * beat;
        if (t > from && t <= horizon && t < s.until) this.drum(bus, t + toCtx, b === 0 ? 1 : 0.75);
      }
    }
  }

  /** A section of the crowd shouting a vowel. */
  private shout(bus: AudioNode, t: number, dur: number, v: Vowel, level: number): void {
    const ctx = this.ctx;
    const [f1, f2] = FORMANTS[v];
    const g = ctx.createGain();
    const peak = Math.max(0.0005, 0.26 * level);
    const end = t + Math.max(0.12, dur * 0.95);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.07);
    g.gain.setTargetAtTime(peak * 0.75, t + 0.1, dur * 0.6);
    g.gain.setTargetAtTime(0.0001, end - 0.05, 0.06);
    const b1 = ctx.createBiquadFilter();
    b1.type = 'bandpass';
    b1.frequency.value = f1;
    b1.Q.value = 2.6;
    const b2 = ctx.createBiquadFilter();
    b2.type = 'bandpass';
    b2.frequency.value = f2;
    b2.Q.value = 3.2;
    const g2 = ctx.createGain();
    g2.gain.value = 0.55;
    b1.connect(g);
    b2.connect(g2).connect(g);
    g.connect(bus);
    this.breath(t, end + 0.3 - t, 2.4, b1, b2);
  }

  /** Breath of many mouths through formant filters, for `dur` seconds from `t`. */
  private breath(t: number, dur: number, gain: number, ...to: AudioNode[]): void {
    const nz = this.ctx.createBufferSource();
    nz.buffer = this.noise;
    const ng = this.ctx.createGain();
    ng.gain.value = gain;
    nz.connect(ng);
    for (const n of to) ng.connect(n);
    nz.start(t, Math.random() * 3);
    nz.stop(t + dur);
  }

  /** A goal: the roar is the recording (GameAudio.goal); the scoring end claps after it. */
  private erupt(end: 0 | 1, t: number): void {
    const bus = this.ends[end];
    for (let i = 0; i < 9; i++) this.clap(bus, t + 3.4 + i * 0.42, 1);
    // The other end: the air goes out of it.
    this.groan(end === 0 ? 1 : 0, t + 0.3);
  }

  /** A shot just wide: "aaaah-ohhh", falling. */
  private groan(end: 0 | 1, t: number): void {
    const ctx = this.ctx;
    const bus = this.ends[end];
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.12);
    g.gain.setTargetAtTime(0.0001, t + 0.6, 0.4);
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.Q.value = 2.5;
    f1.frequency.setValueAtTime(FORMANTS.a[0], t);
    f1.frequency.linearRampToValueAtTime(FORMANTS.o[0], t + 1.0);
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.Q.value = 3;
    f2.frequency.setValueAtTime(FORMANTS.a[1], t);
    f2.frequency.linearRampToValueAtTime(FORMANTS.o[1], t + 1.0);
    f1.connect(g);
    f2.connect(g);
    g.connect(bus);
    this.breath(t, 2.2, 2.4, f1, f2);
    this.burst(bus, t, 1.6, 'bandpass', 700, 0.6, 0.12);
  }

  /** A whole end clapping: many hands, scattered over a few tens of ms. */
  private clap(bus: AudioNode, t: number, level: number): void {
    for (let i = 0; i < 5; i++) this.burst(bus, t + Math.random() * 0.035, 0.06, 'bandpass', 1300 + Math.random() * 900, 1.1, 0.16 * level);
  }

  /** The ultras' big bass drum. */
  private drum(bus: AudioNode, t: number, accent: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(95, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3 * accent, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    o.connect(g).connect(bus);
    o.start(t);
    o.stop(t + 0.5);
    this.burst(bus, t, 0.08, 'lowpass', 900, 0.7, 0.1 * accent);
  }

  /** Viking clap: one big "HUH!" from the end (and the clap that goes with it). */
  private huh(bus: AudioNode, t: number, level: number): void {
    this.shout(bus, t, 0.16, 'u', 0.45 * level);
    this.clap(bus, t, 0.5 * level);
  }

  /** The release: a huge cheer. */
  private roar(bus: AudioNode, t: number): void {
    this.burst(bus, t, 2.6, 'bandpass', 900, 0.5, 0.22);
    this.shout(bus, t, 2.2, 'a', 0.5);
  }

  /** The referee's given a foul against them: a long, low boo, and the whistlers. */
  private boo(end: 0 | 1, t: number): void {
    const bus = this.ends[end];
    this.shout(bus, t, 1.8, 'u', 1.5);
    this.shout(bus, t + 0.1, 1.6, 'o', 1.0);
    const ctx = this.ctx;
    for (let i = 0; i < 6; i++) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      const at = t + Math.random() * 0.4;
      const f = 2300 + Math.random() * 1400;
      o.frequency.setValueAtTime(f, at);
      o.frequency.linearRampToValueAtTime(f * (0.9 + Math.random() * 0.25), at + 0.6);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.012, at + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.5 + Math.random() * 0.6);
      o.connect(g).connect(bus);
      o.start(at);
      o.stop(at + 1.3);
    }
  }

  /** The whole ground: "ooooooh" — rising with the chance, sinking as it goes. */
  private ooh(level: number, t: number): void {
    const ctx = this.ctx;
    for (let e = 0; e < 2; e++) {
      const bus = this.ends[e];
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.06 * level, t + 0.25);
      g.gain.setTargetAtTime(0.0001, t + 0.7, 0.35);
      const b1 = ctx.createBiquadFilter();
      b1.type = 'bandpass';
      b1.frequency.value = FORMANTS.u[0];
      b1.Q.value = 3;
      const b2 = ctx.createBiquadFilter();
      b2.type = 'bandpass';
      b2.frequency.value = FORMANTS.o[1];
      b2.Q.value = 4;
      b1.connect(g);
      b2.connect(g);
      g.connect(bus);
      this.breath(t, 2.2, 2.4, b1, b2);
    }
  }

  private burst(bus: AudioNode, t: number, dur: number, type: BiquadFilterType, freq: number, q: number, gain: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(bus);
    src.start(t, Math.random() * 3);
    src.stop(t + dur + 0.05);
  }
}
