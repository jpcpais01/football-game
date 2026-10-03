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
  /** The text to show (refreshed every two seconds). */
  text = '';

  attachGpu(gl: WebGL2RenderingContext): void {
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
    // The slowest frame, by section (biggest first).
    this.worst = this.worstNow.slice().sort((a, b) => b[1] - a[1]);
    lines.push(`worst frame: ${this.worst.map(([k, v]) => (k === 'gc' ? 'GC' : `${k} ${v.toFixed(1)}`)).join(' · ')}`);
    this.text = lines.join('\n');
    this.windowAt = now;
    this.frames = this.long = this.gcs = 0;
    this.frameSum = this.cpuSum = this.cpuMax = this.worstMs = 0;
    this.gpuSum = this.gpuMax = this.gpuN = 0;
    for (const s of this.secs) s.sum = s.max = 0;
  }
}
