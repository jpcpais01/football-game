import * as THREE from 'three';
import { SHARED } from './look';
import { type Stadium, bakeStatic, groundPlanes, pitchside, sky, updateShared } from './stadium';

/**
 * The bare pitch: the field, its lines, goals and corner flags under an open sky, and
 * nothing else. No stands, crowd, pylons, boards or dugouts (and the app runs no terraces,
 * chants or bench for it), so it shows what the scenery around a match costs.
 */
export function createBarePitch(homeColor: number, awayColor: number): Stadium {
  const group = new THREE.Group();
  group.add(sky());
  const [land, apron] = groundPlanes();
  // Open fields to the horizon rather than the grey land a ground stands on.
  (land.material as THREE.MeshStandardMaterial).color.setHex(0x4a5e36);
  group.add(land, apron);
  group.add(bakeStatic(pitchside(homeColor, awayColor, false)));
  return {
    group,
    setFanBanner: () => {},
    setNearStand: () => {},
    update(time, excitement, atmo) {
      updateShared(time, excitement, atmo);
      // No near stand: no shadow across the pitch.
      SHARED.uShadowZ0.value = 1e4;
    },
  };
}
