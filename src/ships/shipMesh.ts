import * as THREE from 'three';

/**
 * Placeholder low-poly ship. Phase 3 replaces this with the procedural
 * part-grammar builder (see docs/SUPERPLAN.md §3.4).
 */
export function createPlaceholderShip(hullColor = '#8fa3b8', accent = '#ff7a2f'): THREE.Group {
  const ship = new THREE.Group();
  const hullMat = new THREE.MeshToonMaterial({ color: hullColor });
  const accentMat = new THREE.MeshToonMaterial({ color: accent });
  const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#5fd4ff').multiplyScalar(4) });

  // Ships face -Z (Three.js forward).
  const body = new THREE.Mesh(new THREE.ConeGeometry(1.2, 6, 6), hullMat);
  body.rotation.x = -Math.PI / 2;
  body.scale.set(1, 1, 0.55);
  ship.add(body);

  const cockpit = new THREE.Mesh(new THREE.OctahedronGeometry(0.6), accentMat);
  cockpit.position.set(0, 0.55, -0.6);
  cockpit.scale.set(1, 0.6, 1.8);
  ship.add(cockpit);

  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.15, 1.8), hullMat);
    wing.position.set(side * 2, -0.1, 1.2);
    wing.rotation.y = side * 0.35;
    ship.add(wing);

    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 2.2, 6), accentMat);
    pod.rotation.x = Math.PI / 2;
    pod.position.set(side * 1.3, 0, 2.4);
    ship.add(pod);

    const engine = new THREE.Mesh(new THREE.CircleGeometry(0.32, 8), glowMat);
    engine.position.set(side * 1.3, 0, 3.51);
    ship.add(engine);
  }
  return ship;
}
