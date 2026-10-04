import * as THREE from 'three';
import { Rng } from '../core/rng';
import { createStarfield } from '../render/starfield';

/**
 * Phase 0 test scene: a star, a planet and an asteroid field for scale.
 * Phase 1 replaces this with the seeded SystemScene.
 */
export function buildSandbox(scene: THREE.Scene, seed: number): { starfield: THREE.Points; tick: (dt: number) => void } {
  const rng = new Rng(seed);
  scene.background = new THREE.Color('#02030a');

  const starfield = createStarfield(new Rng(Rng.derive(seed, 1)));
  scene.add(starfield);

  const starPos = new THREE.Vector3(-4000, 800, -9000);
  const star = new THREE.Mesh(
    new THREE.IcosahedronGeometry(600, 3),
    new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffd27a').multiplyScalar(3) }),
  );
  star.position.copy(starPos);
  scene.add(star);

  const sun = new THREE.DirectionalLight('#fff1d6', 2.5);
  sun.position.copy(starPos);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight('#3a4a7a', '#0a0612', 0.6));

  const planet = new THREE.Mesh(
    new THREE.IcosahedronGeometry(450, 4),
    new THREE.MeshToonMaterial({ color: '#3f8f7a' }),
  );
  planet.position.set(900, -200, -2500);
  scene.add(planet);

  const atmosphere = new THREE.Mesh(
    new THREE.IcosahedronGeometry(480, 4),
    new THREE.MeshBasicMaterial({ color: '#7fd8ff', transparent: true, opacity: 0.12, side: THREE.BackSide }),
  );
  atmosphere.position.copy(planet.position);
  scene.add(atmosphere);

  // Instanced asteroid belt around the spawn point.
  const count = 600;
  const rocks = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(1, 0),
    new THREE.MeshToonMaterial({ color: '#7a6f66' }),
    count,
  );
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (let i = 0; i < count; i++) {
    const angle = rng.range(0, Math.PI * 2);
    const r = rng.range(250, 900);
    const pos = new THREE.Vector3(Math.cos(angle) * r, rng.range(-40, 40), Math.sin(angle) * r - 400);
    q.setFromEuler(e.set(rng.next() * 6, rng.next() * 6, rng.next() * 6));
    const sc = rng.range(1.5, 14);
    m.compose(pos, q, new THREE.Vector3(sc, sc * rng.range(0.6, 1), sc));
    rocks.setMatrixAt(i, m);
  }
  scene.add(rocks);

  return {
    starfield,
    tick: (dt) => {
      planet.rotation.y += dt * 0.01;
      rocks.rotation.y += dt * 0.002;
    },
  };
}
