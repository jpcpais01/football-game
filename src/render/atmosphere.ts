import * as THREE from 'three';
import { COLORS, SHARED, SUN_DIR } from './look';
import { clamp, lerp, smoothstep } from '../sim/vec';

const SHADE_DUSK = new THREE.Color(0x8c9ae0);

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
  /** 'evening': kick-off at golden hour, full time under floodlights. 'sunny': a clear,
   * crisp midday match. */
  weather: 'evening' | 'sunny' = 'evening';
  /** How much atmospheric haze the background gets (read by the stadium shaders). */
  haze = 1;

  // Key colours at kick-off (a) and at full time (b). Ghibli light: a generous warm sun,
  // and shade that is lit by a bright blue sky — coloured, never murky.
  private sunA = new THREE.Color(0xfff0d4);
  private sunB = new THREE.Color(0xffb47a);
  private topA = new THREE.Color(0x6fa6e6);
  private topB = new THREE.Color(0x2c3a78);
  private horA = new THREE.Color(0xfbe6c0);
  private horB = new THREE.Color(0xf09a6a);
  private fogA = new THREE.Color(0xe6dcc4);
  private fogB = new THREE.Color(0x8a82a8);
  private hemiSkyA = new THREE.Color(0xc4dcff);
  private hemiSkyB = new THREE.Color(0xa4b2ea);

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
    if (this.weather === 'sunny') return this.setSunny();
    this.haze = 1;
    this.fog.near = 95;
    this.fog.far = 300;
    const t = clamp(progress, 0, 1);
    // Sun sinks from ~30° to ~11°.
    const elev = lerp(30, 15, t) * (Math.PI / 180);
    const az = lerp(-0.42, -0.62, t); // swings slowly along the stand
    const h = Math.cos(elev);
    SUN_DIR.set(Math.sin(-az) * h, -Math.sin(elev), -Math.cos(az) * h).normalize();

    const dusk = smoothstep(0.35, 1, t);
    this.sun.color.copy(this.sunA).lerp(this.sunB, dusk);
    this.sun.intensity = lerp(3.1, 1.6, dusk);
    this.hemi.color.copy(this.hemiSkyA).lerp(this.hemiSkyB, dusk);
    this.hemi.groundColor.setHex(0x6f8a45);
    this.hemi.intensity = lerp(1.35, 0.85, dusk);

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
    this.c2.setHex(0x8fb8e8).lerp(SHADE_DUSK, dusk);
    SHARED.uShadeTint.value.copy(this.c2);
    SHARED.uClouds.value = lerp(0.55, 0.0, dusk);
    SHARED.uSunColor.value.copy(this.sun.color);
  }

  /** Clear midday: high bright sun, crisp shadows, deep blue sky, almost no haze. */
  private setSunny(): void {
    const elev = (52 * Math.PI) / 180;
    const az = -0.5;
    const h = Math.cos(elev);
    SUN_DIR.set(Math.sin(-az) * h, -Math.sin(elev), -Math.cos(az) * h).normalize();
    this.sun.color.setHex(0xfff6e6);
    this.sun.intensity = 3.4;
    this.hemi.color.setHex(0xc6deff);
    this.hemi.groundColor.setHex(0x6f8a45);
    this.hemi.intensity = 1.3;
    this.skyTop.setHex(0x3f86e0);
    this.skyHorizon.setHex(0xc7e2f7);
    this.sunGlow.copy(this.sun.color);
    this.fog.color.setHex(0xcfe3f2);
    this.bg.setHex(0xcfe3f2);
    this.fog.near = 260;
    this.fog.far = 900;
    this.haze = 0.15;
    // High sun: the near stand's shadow barely reaches the touchline.
    SHARED.uShadowZ0.value = 33;
    SHARED.uFlood.value = 0;
    SHARED.uDew.value = 0;
    SHARED.uShadeTint.value.setHex(0x9cc4f0);
    SHARED.uClouds.value = 1;
    SHARED.uSunColor.value.copy(this.sun.color);
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
