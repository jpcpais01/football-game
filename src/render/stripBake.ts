import * as THREE from 'three';

/**
 * A full-screen bake (a quad into a texture) spread over a few frames, a band of rows per
 * frame, into a back buffer; the finished picture is swapped in front at the end. What it
 * bakes changes slowly (the sun's light, drifting clouds), so arriving a few frames later
 * is invisible, while doing it all in one frame was a GPU spike of several milliseconds.
 */
export class StripBake {
  private rts: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private front = 0;
  private strip = -1;

  constructor(
    make: () => THREE.WebGLRenderTarget,
    private readonly strips: number,
    private readonly scene: THREE.Scene,
    private readonly cam: THREE.Camera,
  ) {
    this.rts = [make(), make()];
  }

  /** The finished picture. */
  get texture(): THREE.Texture {
    return this.rts[this.front].texture;
  }

  get busy(): boolean {
    return this.strip >= 0;
  }

  start(): void {
    this.strip = 0;
  }

  /** Draws the next band (all of it at once with `all`); true when the new picture has just gone in front. */
  step(renderer: THREE.WebGLRenderer, all = false): boolean {
    if (this.strip < 0) return false;
    const back = this.rts[1 - this.front];
    const n = all ? 1 : this.strips;
    const i = all ? 0 : this.strip;
    const y0 = Math.floor((back.height * i) / n);
    const y1 = Math.floor((back.height * (i + 1)) / n);
    back.scissor.set(0, y0, back.width, y1 - y0);
    back.scissorTest = true;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(back);
    renderer.render(this.scene, this.cam);
    renderer.setRenderTarget(prev);
    back.scissorTest = false;
    if (!all && ++this.strip < n) return false;
    this.strip = -1;
    this.front = 1 - this.front;
    return true;
  }
}
