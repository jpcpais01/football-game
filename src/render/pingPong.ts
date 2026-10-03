import * as THREE from 'three';

/**
 * Per-frame vertex data in a ring of GPU buffers over the same array, taking turns.
 * Rewriting a buffer the GPU may still be reading for an earlier frame makes some phones'
 * drivers stop and wait (or copy it) on the upload; phones keep up to a couple of frames in
 * flight, so the buffer written now was last drawn RING frames ago. All share one array, so
 * the code that fills it never knows.
 */
export const RING = 3;
const next = new WeakMap<THREE.BufferAttribute, THREE.BufferAttribute>();

export function nextBuffer<T extends THREE.BufferAttribute>(a: T): T {
  let b = next.get(a) as T | undefined;
  if (!b) {
    let prev: THREE.BufferAttribute = a;
    for (let i = 1; i < RING; i++) {
      const inst = a as unknown as THREE.InstancedBufferAttribute;
      const c = inst.isInstancedBufferAttribute
        ? new THREE.InstancedBufferAttribute(a.array, a.itemSize, a.normalized, inst.meshPerAttribute)
        : new THREE.BufferAttribute(a.array, a.itemSize, a.normalized);
      c.setUsage(a.usage);
      next.set(prev, c);
      prev = c;
    }
    next.set(prev, a);
    b = next.get(a) as T;
  }
  return b;
}

/** Swaps `mesh`'s instance matrices to the next buffer and marks `count` instances for upload. */
export function flipInstances(mesh: THREE.InstancedMesh, count: number): void {
  const m = nextBuffer(mesh.instanceMatrix);
  mesh.instanceMatrix = m;
  m.clearUpdateRanges();
  m.addUpdateRange(0, count * 16);
  m.needsUpdate = true;
}

/** Swaps `mesh`'s instance colours to the next buffer and marks `count` instances for upload. */
export function flipColors(mesh: THREE.InstancedMesh, count: number): void {
  if (!mesh.instanceColor) return;
  const c = nextBuffer(mesh.instanceColor);
  mesh.instanceColor = c;
  c.clearUpdateRanges();
  c.addUpdateRange(0, count * 3);
  c.needsUpdate = true;
}

/** Swaps `geo`'s attribute `name` to the next buffer and marks its first `n` items for upload. */
export function flipAttribute(geo: THREE.BufferGeometry, name: string, n: number): void {
  const cur = geo.getAttribute(name) as THREE.BufferAttribute | undefined;
  if (!cur) return;
  const b = nextBuffer(cur);
  geo.setAttribute(name, b);
  b.clearUpdateRanges();
  b.addUpdateRange(0, n * b.itemSize);
  b.needsUpdate = true;
}
