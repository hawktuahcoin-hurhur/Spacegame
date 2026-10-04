import * as THREE from 'three';
import { Rng } from '../core/rng';

/** Star points on a large shell that follows the camera, so stars stay at "infinity". */
export function createStarfield(rng: Rng, count = 6000, radius = 50_000): THREE.Points {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const palette = [
    new THREE.Color('#9bb0ff'),
    new THREE.Color('#cad7ff'),
    new THREE.Color('#fff4ea'),
    new THREE.Color('#ffd2a1'),
    new THREE.Color('#ffcc6f'),
  ];
  for (let i = 0; i < count; i++) {
    // Uniform point on a sphere.
    const u = rng.range(-1, 1);
    const theta = rng.range(0, Math.PI * 2);
    const s = Math.sqrt(1 - u * u);
    positions.set([s * Math.cos(theta) * radius, u * radius, s * Math.sin(theta) * radius], i * 3);
    const c = rng.pick(palette).clone().multiplyScalar(rng.range(0.4, 1.6));
    colors.set([c.r, c.g, c.b], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({
    size: 2,
    sizeAttenuation: false,
    vertexColors: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return points;
}
