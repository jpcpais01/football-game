import * as THREE from 'three';
import { COLORS, SHARED, SUN_DIR } from './look';
import { clamp, lerp, smoothstep } from '../sim/vec';

/**
 * Time of day across the match: kick-off in warm late-afternoon sun, full time at dusk
 * with the floodlights doing most of the work. Drives lights, sky, fog and the shared
 * material uniforms. `progress` is 0 at kick-off and 1 at full time.
 */
export class Atmosphere {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly skyTop = new THREE.Color();
  readonly skyHorizon = new THREE.Color();
  readonly sunGlow = new THREE.Color();
  private fog: THREE.Fog;
  private bg: THREE.Color;
  private c1 = new THREE.Color();
  private c2 = new THREE.Color();
  private shadowTarget = new THREE.Vector3();

  // Key colours at kick-off (a) and at full time (b).
  private sunA = new THREE.Color(0xffe6c2);
  private sunB = new THREE.Color(0xffab6b);
  private topA = new THREE.Color(0x86acd4);
  private topB = new THREE.Color(0x26305e);
  private horA = new THREE.Color(0xf3dcb6);
  private horB = new THREE.Color(0xe08a62);
  private fogA = new THREE.Color(COLORS.fog);
  private fogB = new THREE.Color(0x6f6a86);
  private hemiSkyA = new THREE.Color(COLORS.hemiSky);
  private hemiSkyB = new THREE.Color(0x8d9cc7);

  constructor(scene: THREE.Scene, quality: { shadowSize: number }) {
    this.bg = new THREE.Color(COLORS.fog);
    scene.background = this.bg;
    this.fog = new THREE.Fog(COLORS.fog, 95, 300);
    scene.fog = this.fog;

    this.sun = new THREE.DirectionalLight(COLORS.sun, 2.4);
    this.sun.castShadow = true;
    const s = this.sun.shadow;
    s.mapSize.set(quality.shadowSize, quality.shadowSize);
    s.camera.left = -40;
    s.camera.right = 40;
    s.camera.top = 32;
    s.camera.bottom = -32;
    s.camera.near = 10;
    s.camera.far = 220;
    s.bias = -0.0006;
    s.normalBias = 0.02;
    s.radius = 3;
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(COLORS.hemiSky, COLORS.hemiGround, 1.0);
    scene.add(this.hemi);
    this.set(0);
  }

  /** Sets the time of day. */
  set(progress: number): void {
    const t = clamp(progress, 0, 1);
    // Sun sinks from ~30° to ~11°.
    const elev = lerp(30, 15, t) * (Math.PI / 180);
    const az = lerp(-0.42, -0.62, t); // swings slowly along the stand
    const h = Math.cos(elev);
    SUN_DIR.set(Math.sin(-az) * h, -Math.sin(elev), -Math.cos(az) * h).normalize();

    const dusk = smoothstep(0.35, 1, t);
    this.sun.color.copy(this.sunA).lerp(this.sunB, dusk);
    this.sun.intensity = lerp(2.5, 1.15, dusk);
    this.hemi.color.copy(this.hemiSkyA).lerp(this.hemiSkyB, dusk);
    this.hemi.intensity = lerp(1.05, 0.42, dusk);

    this.skyTop.copy(this.topA).lerp(this.topB, dusk);
    this.skyHorizon.copy(this.horA).lerp(this.horB, dusk);
    this.sunGlow.copy(this.sun.color);
    this.c1.copy(this.fogA).lerp(this.fogB, dusk);
    this.fog.color.copy(this.c1);
    this.bg.copy(this.c1);

    // The near stand's shadow creeps across the pitch as the sun drops.
    SHARED.uShadowZ0.value = lerp(25, 9, smoothstep(0, 1, t));
    // Floodlights: faintly on from the start, carrying the light by full time.
    SHARED.uFlood.value = lerp(0.12, 1.0, smoothstep(0.15, 0.95, t));
    SHARED.uDew.value = smoothstep(0.55, 1, t);
    this.c2.setHex(0x9fb0cc).lerp(new THREE.Color(0x8a96c4), dusk);
    SHARED.uShadeTint.value.copy(this.c2);
  }

  /** Keeps the shadow map centred on what the camera sees (snapped to texels: no shimmer). */
  follow(x: number, z: number): void {
    const size = 80 / this.sun.shadow.mapSize.x;
    const sx = Math.round(x / size) * size;
    const sz = Math.round(z / size) * size;
    this.shadowTarget.set(sx, 0, sz);
    this.sun.target.position.copy(this.shadowTarget);
    this.sun.position.copy(this.shadowTarget).addScaledVector(SUN_DIR, -120);
    this.sun.target.updateMatrixWorld();
  }
}
