import * as THREE from 'three';
import { BALL } from '../sim/constants';
import type { Match } from '../sim/match';
import { lerp } from '../sim/vec';
import { blobMaterial, litMaterial } from './look';

/** Classic panelled ball (dark pentagons make spin readable), plus a projected sun shadow. */
export class BallView {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh;
  private contact: THREE.Mesh;
  private quat = new THREE.Quaternion();
  private dq = new THREE.Quaternion();
  private axis = new THREE.Vector3();

  constructor() {
    const r = BALL.radius;
    const geo = new THREE.IcosahedronGeometry(r, 3);
    // Colour vertices near the 12 icosahedron vertices dark: a truncated-icosahedron look.
    const ico = new THREE.IcosahedronGeometry(1, 0);
    const centers: THREE.Vector3[] = [];
    const ip = ico.getAttribute('position');
    for (let i = 0; i < ip.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(ip, i).normalize();
      if (!centers.some((c) => c.distanceTo(v) < 0.01)) centers.push(v);
    }
    const pos = geo.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).normalize();
      let best = 0;
      for (const c of centers) best = Math.max(best, v.dot(c));
      const dark = best > 0.93;
      const c = dark ? 0.12 : 0.97;
      colors[i * 3] = c;
      colors[i * 3 + 1] = c;
      colors[i * 3 + 2] = dark ? 0.14 : 0.94;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.mesh = new THREE.Mesh(geo, litMaterial({ vertexColors: true, roughness: 0.45 }));
    this.mesh.castShadow = true;
    this.group.add(this.mesh);

    const sGeo = new THREE.PlaneGeometry(1, 1);
    sGeo.rotateX(-Math.PI / 2);
    this.contact = new THREE.Mesh(sGeo, blobMaterial(0.5));
    this.contact.renderOrder = 1;
    this.group.add(this.contact);
  }

  update(match: Match, alpha: number, frameDt: number): void {
    const b = match.ball;
    const x = lerp(b.prevPos.x, b.pos.x, alpha);
    const y = lerp(b.prevPos.y, b.pos.y, alpha);
    const z = lerp(b.prevPos.z, b.pos.z, alpha);
    this.mesh.position.set(x, y, z);

    // Integrate visual rotation from the simulated spin.
    const w = b.spin;
    const wl = w.len();
    if (wl > 1e-3) {
      this.axis.set(w.x / wl, w.y / wl, w.z / wl);
      this.dq.setFromAxisAngle(this.axis, Math.min(wl * frameDt, 1.2));
      this.quat.premultiply(this.dq);
    }
    this.mesh.quaternion.copy(this.quat);

    // Contact occlusion fades as the ball leaves the grass; the real shadow comes from the sun.
    const hgt = Math.max(0, y - BALL.radius);
    const cs = 0.34 + hgt * 0.05;
    this.contact.position.set(x, 0.016, z);
    this.contact.scale.set(cs, 1, cs);
    (this.contact.material as THREE.ShaderMaterial).uniforms.uOpacity.value = 0.55 / (1 + hgt * 1.2);
    this.contact.visible = hgt < 3;
  }
}
