import * as THREE from 'three';

/**
 * Per-frame vertex data in two GPU buffers over the same array, taking turns. Rewriting a
 * buffer the GPU may still be reading for the frame before makes some phones' drivers stop
 * and wait (or copy it) on every upload; the other buffer was last drawn two frames ago.
 * Both share one array, so the code that fills it never knows.
 */
const other = new WeakMap<THREE.BufferAttribute, THREE.BufferAttribute>();

export function nextBuffer<T extends THREE.BufferAttribute>(a: T): T {
  let b = other.get(a) as T | undefined;
  if (!b) {
    const inst = a as unknown as THREE.InstancedBufferAttribute;
    b = (inst.isInstancedBufferAttribute
      ? new THREE.InstancedBufferAttribute(a.array, a.itemSize, a.normalized, inst.meshPerAttribute)
      : new THREE.BufferAttribute(a.array, a.itemSize, a.normalized)) as unknown as T;
    b.setUsage(a.usage);
    other.set(a, b);
    other.set(b, a);
  }
  return b;
}

/** Swaps `mesh`'s instance matrices to the other buffer and marks `count` instances for upload. */
export function flipInstances(mesh: THREE.InstancedMesh, count: number): void {
  const m = nextBuffer(mesh.instanceMatrix);
  mesh.instanceMatrix = m;
  m.clearUpdateRanges();
  m.addUpdateRange(0, count * 16);
  m.needsUpdate = true;
}

/** Swaps `geo`'s attribute `name` to the other buffer and marks its first `n` items for upload. */
export function flipAttribute(geo: THREE.BufferGeometry, name: string, n: number): void {
  const cur = geo.getAttribute(name) as THREE.BufferAttribute | undefined;
  if (!cur) return;
  const b = nextBuffer(cur);
  geo.setAttribute(name, b);
  b.clearUpdateRanges();
  b.addUpdateRange(0, n * b.itemSize);
  b.needsUpdate = true;
}
