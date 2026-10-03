import * as THREE from 'three';
/**
 * Frame profiler for the FPS readout: where each frame's time goes, section by section, and
 * what the worst frame of the last two seconds was made of (that's where a stutter shows).
 *
 * The frame loop calls `lap(name)` after each stage (time since the previous lap); hot
 * functions inside a stage (the AI, kicks) are wrapped and reported as part of it. The GPU
 * time of the world render comes from a timer query where the browser offers one.
 */
const WINDOW_MS = 2000;

interface Sec {
  name: string;
  /** Inside another section (shown indented, not added to the total). */
  sub: boolean;
  now: number;
  sum: number;
  max: number;
}

export class Profiler {
  private secs: Sec[] = [];
  private byName = new Map<string, Sec>();
  private t = 0;
  private frames = 0;
  private windowAt = 0;
  private long = 0;
  private worstMs = 0;
  private worst: [string, number][] = [];
  private worstNow: [string, number][] = [];
  private frameSum = 0;
  private cpuSum = 0;
  private cpuMax = 0;
  private heapLast = 0;
  private gcs = 0;
  private gcNow = false;
  // GPU timer queries (WebGL2 EXT_disjoint_timer_query_webgl2), a small pool read back late.
  private gl: WebGL2RenderingContext | null = null;
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  private free: WebGLQuery[] = [];
  private pending: WebGLQuery[] = [];
  private open: WebGLQuery | null = null;
  private gpuSum = 0;
  private gpuMax = 0;
  private gpuN = 0;
  // GPU probes (a pixel read back, where no timer query exists): once a window the frame's passes are
  // each waited for, and so is any bake (stand shadow, ground light, clouds) when it runs.
  private gpuLast = new Map<string, number>();
  private gpuPeak = new Map<string, number>();
  private probeAt = 0;
  private stalled = 0;
  /** The text to show (refreshed every two seconds). */
  text = '';

  private renderer: THREE.WebGLRenderer | null = null;
  private tiny = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  private px = new Uint8Array(4);

  attachGpu(renderer: THREE.WebGLRenderer): void {
    this.renderer = renderer;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  private sec(name: string, sub = false): Sec {
    let s = this.byName.get(name);
    if (!s) {
      s = { name, sub, now: 0, sum: 0, max: 0 };
      this.byName.set(name, s);
      this.secs.push(s);
    }
    return s;
  }

  /** Times every call of obj[method] into a sub-section (while the profiler is on). */
  wrap<T extends object>(obj: T, method: keyof T & string, name: string): void {
    const f = obj[method] as unknown as (...a: unknown[]) => unknown;
    const s = this.sec(name, true);
    (obj as Record<string, unknown>)[method] = function (this: unknown, ...a: unknown[]) {
      const t0 = performance.now();
      const r = f.apply(this, a);
      s.now += performance.now() - t0;
      return r;
    };
  }

  /** Whether this frame should wait for the GPU after each pass (once a window). */
  probeDue(now: number): boolean {
    if (!this.gl || now - this.probeAt < WINDOW_MS) return false;
    this.probeAt = now;
    this.stalled = 2; // this frame and the next don't count toward the frame times
    return true;
  }

  /** Waits for the GPU; the wait is charged to `name` (null: just drain what's queued). */
  gpuSync(name: string | null): void {
    if (!this.gl) return;
    const t = performance.now();
    // Read a pixel back: the browser has to wait for everything queued before it (a
    // gl.finish() can return at once, as it does in Chrome on Android).
    const r = this.renderer!;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.tiny);
    r.clear(true, false, false);
    r.readRenderTargetPixels(this.tiny, 0, 0, 1, 1, this.px);
    r.setRenderTarget(prev);
    const ms = performance.now() - t;
    if (name) {
      this.gpuLast.set(name, ms);
      this.gpuPeak.set(name, Math.max(ms, this.gpuPeak.get(name) ?? 0));
    }
    if (name?.startsWith('bake')) this.stalled = Math.max(this.stalled, 2);
  }

  begin(): void {
    this.t = performance.now();
  }

  /** The time since the last lap (or begin) goes to `name`. */
  lap(name: string): void {
    const t = performance.now();
    this.sec(name).now += t - this.t;
    this.t = t;
  }

  gpuBegin(): void {
    const { gl, ext } = this;
    if (!gl || !ext || this.open) return;
    const q = this.free.pop() ?? gl.createQuery();
    if (!q) return;
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    this.open = q;
  }

  gpuEnd(): void {
    const { gl, ext } = this;
    if (!gl || !ext || !this.open) return;
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    this.pending.push(this.open);
    this.open = null;
    // Read back whatever has finished (in order: the oldest first).
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    while (this.pending.length && gl.getQueryParameter(this.pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      const q = this.pending.shift()!;
      if (!disjoint) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        this.gpuSum += ms;
        this.gpuMax = Math.max(this.gpuMax, ms);
        this.gpuN++;
      }
      this.free.push(q);
    }
  }

  /** End of a drawn frame: `frameMs` is the time since the last one. */
  end(now: number, frameMs: number, cpuMs: number): void {
    if (this.stalled > 0) {
      // A probed frame (it waited for the GPU on purpose) and the one after: not counted.
      this.stalled--;
      for (const s of this.secs) s.now = 0;
      if (now - this.windowAt >= WINDOW_MS) this.report(now);
      return;
    }
    // A drop in the JS heap since the last frame: the garbage collector ran in between.
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    if (mem) {
      const h = mem.usedJSHeapSize;
      this.gcNow = h < this.heapLast - 256 * 1024;
      if (this.gcNow) this.gcs++;
      this.heapLast = h;
    }
    this.frames++;
    this.frameSum += frameMs;
    this.cpuSum += cpuMs;
    this.cpuMax = Math.max(this.cpuMax, cpuMs);
    if (frameMs > 12) this.long++;
    if (frameMs > this.worstMs) {
      this.worstMs = frameMs;
      this.worstNow.length = 0;
      for (const s of this.secs) if (s.now >= 0.3) this.worstNow.push([s.name, s.now]);
      if (this.gcNow) this.worstNow.push(['gc', 0]);
      // Beyond our own work: the browser, the GPU catching up (the frame before), layout, GC.
      if (frameMs - cpuMs > 0.3) this.worstNow.push(['outside', frameMs - cpuMs]);
    }
    for (const s of this.secs) {
      s.sum += s.now;
      if (s.now > s.max) s.max = s.now;
      s.now = 0;
    }
    if (now - this.windowAt >= WINDOW_MS) this.report(now);
  }

  private report(now: number): void {
    const n = Math.max(1, this.frames);
    const f = (x: number) => x.toFixed(1).padStart(5);
    const lines: string[] = [];
    lines.push(`frame avg${f(this.frameSum / n)} worst${f(this.worstMs)} ms · ${this.long} over 12 ms`);
    lines.push(`cpu   avg${f(this.cpuSum / n)} max${f(this.cpuMax)}`);
    if (this.ext) lines.push(this.gpuN ? `gpu   avg${f(this.gpuSum / this.gpuN)} max${f(this.gpuMax)}  (world render)` : 'gpu   (waiting)');
    else lines.push('gpu   not measurable on this browser');
    for (const s of this.secs) {
      if (s.sum / n < 0.05 && s.max < 0.5) continue;
      lines.push(`${s.sub ? ' └' : ''}${s.name.padEnd(s.sub ? 5 : 7)}avg${f(s.sum / n)} max${f(s.max)}`);
    }
    if (this.gcs) lines.push(`gc    ${this.gcs}× in 2 s`);
    // GPU time per pass (from the last probe; the peak over the window for bakes).
    if (this.gpuLast.size) {
      // Every figure less the round trip a wait costs on its own.
      const idle = this.gpuLast.get('#idle') ?? 0;
      const net = (v: number) => Math.max(0, v - idle);
      const parts: string[] = [];
      for (const [k, v] of this.gpuLast) if (!k.startsWith('bake') && !k.startsWith('#')) parts.push(`${k} ${net(v).toFixed(1)}`);
      lines.push(`gpu*  ${parts.join(' · ')}  (wait itself ${idle.toFixed(1)}, taken off)`);
      // The world's parts: what each adds (the whole world, less the world without it).
      const all = this.gpuLast.get('#all');
      if (all !== undefined) {
        const g = (k: string) => this.gpuLast.get(k) ?? all;
        const ground = Math.max(0, all - g('#ground'));
        const people = Math.max(0, all - g('#people'));
        const rest = Math.max(0, net(all) - ground - people);
        lines.push(`gpu*  world: ground ${ground.toFixed(1)} · people ${people.toFixed(1)} · rest ${rest.toFixed(1)} · sun shadows ${Math.max(0, g('#shadow') - all).toFixed(1)}`);
        // Issuing the draws (the scene into one pixel) and the frame's uploads (the first time).
        const c2 = this.gpuLast.get('#calls2');
        if (c2 !== undefined) lines.push(`gpu*  draw commands ${net(c2).toFixed(1)} · uploads ${Math.max(0, (this.gpuLast.get('#calls1') ?? c2) - c2).toFixed(1)}`);
      }
      // The bakes: the dearest frame of each in the last two seconds (a dash: none ran).
      const bakes: string[] = [];
      for (const [k, v] of this.gpuLast) {
        if (!k.startsWith('bake:')) continue;
        const peak = this.gpuPeak.get(k);
        bakes.push(`${k.slice(5)} ${peak !== undefined ? net(peak).toFixed(1) : `– (last ${net(v).toFixed(1)})`}`);
      }
      if (bakes.length) lines.push(`gpu*  bakes: ${bakes.join(' · ')}`);
    }
    // The slowest frame, by section (biggest first).
    this.worst = this.worstNow.slice().sort((a, b) => b[1] - a[1]);
    lines.push(`worst frame: ${this.worst.map(([k, v]) => (k === 'gc' ? 'GC' : `${k} ${v.toFixed(1)}`)).join(' · ')}`);
    this.text = lines.join('\n');
    this.windowAt = now;
    this.frames = this.long = this.gcs = 0;
    this.frameSum = this.cpuSum = this.cpuMax = this.worstMs = 0;
    this.gpuSum = this.gpuMax = this.gpuN = 0;
    for (const s of this.secs) s.sum = s.max = 0;
    this.gpuPeak.clear();
  }
}
