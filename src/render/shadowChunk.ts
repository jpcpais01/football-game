import * as THREE from 'three';

/**
 * three's soft sun shadows take 5 taps on a Vogel disk turned by a per-pixel angle, working
 * out a cos and a sin for every tap (10 per pixel, on every shadow-receiving pixel). Turning
 * the disk is one rotation: the same 5 offsets come from one cos/sin and a 2x2 matrix
 * (angle addition), with the disk's own points precomputed here.
 */
const GOLDEN = 2.399963229728653;
const vogel = Array.from({ length: 5 }, (_, i) => {
  const r = Math.sqrt((i + 0.5) / 5);
  return `vec2( ${(Math.cos(i * GOLDEN) * r).toFixed(9)}, ${(Math.sin(i * GOLDEN) * r).toFixed(9)} )`;
});

const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
const phiLine = 'float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;';
let patched = chunk.replace(phiLine, `${phiLine}\n\t\t\t\tmat2 vogelRot = mat2( cos( phi ), sin( phi ), - sin( phi ), cos( phi ) ) * radius;`);
for (let i = 0; i < 5; i++) patched = patched.replace(`vogelDiskSample( ${i}, 5, phi ) * radius`, `vogelRot * ${vogel[i]}`);
// Only if three's chunk is still the one this was written for (else leave it as it is).
if (patched.includes('vogelRot') && !patched.includes('vogelDiskSample( 0, 5, phi )')) THREE.ShaderChunk.shadowmap_pars_fragment = patched;
