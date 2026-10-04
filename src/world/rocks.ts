import * as THREE from 'three';
import { Rng } from '../core/rng';

/** Lumpy low-poly asteroid: an icosphere displaced by a sum of random sine waves. */
export function createRockGeometry(seed: number, detail = 2): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const g = new THREE.IcosahedronGeometry(1, detail);
  const waves: { dir: THREE.Vector3; freq: number; phase: number; amp: number }[] = [];
  for (let i = 0; i < 9; i++) {
    const dir = new THREE.Vector3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalize();
    waves.push({ dir, freq: rng.range(1.2, 5.5), phase: rng.range(0, 6.28), amp: rng.range(0.03, 0.14) / (1 + i * 0.25) });
  }
  const stretch = new THREE.Vector3(rng.range(0.7, 1.3), rng.range(0.6, 1.0), rng.range(0.8, 1.4));
  const pos = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let d = 1;
    for (const w of waves) d += Math.sin(v.dot(w.dir) * w.freq + w.phase) * w.amp;
    v.multiplyScalar(d).multiply(stretch);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  g.dispose();
  return flat;
}
