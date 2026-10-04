import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../core/rng';

export interface StationVisual {
  root: THREE.Group;
  update(dt: number, time: number): void;
}

/**
 * Procedural orbital trade hub (~1.8 km across): a central spindle, a rotating
 * habitat ring on spokes, docking bay with guide lights, and solar arrays.
 * Spin axis is local +Y.
 */
export function createStation(seed: number, radius: number): StationVisual {
  const rng = new Rng(seed);
  const root = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color: '#c9ced6', metalness: 0.45, roughness: 0.55, flatShading: true });
  const darkMat = new THREE.MeshStandardMaterial({ color: '#3a3f48', metalness: 0.6, roughness: 0.5, flatShading: true });
  const accent = new THREE.Color().setHSL(rng.next(), 0.6, 0.5);
  const accentMat = new THREE.MeshStandardMaterial({ color: accent, metalness: 0.3, roughness: 0.6, flatShading: true });
  const windowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffd9a0').multiplyScalar(3.5) });
  const panelMat = new THREE.MeshStandardMaterial({
    color: '#1b2a4a',
    metalness: 0.9,
    roughness: 0.25,
    emissive: new THREE.Color('#0a1530'),
    flatShading: true,
  });

  const R = radius * 0.78;

  // Spindle.
  const spindle = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.11, radius * 0.11, radius * 1.3, 10), hullMat);
  root.add(spindle);
  const capTop = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.06, radius * 0.16, radius * 0.18, 10), darkMat);
  capTop.position.y = radius * 0.74;
  root.add(capTop);
  const bay = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.2, radius * 0.2, radius * 0.22, 10), accentMat);
  bay.position.y = -radius * 0.62;
  root.add(bay);
  const bayMouth = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.14, 10), new THREE.MeshBasicMaterial({ color: new THREE.Color('#6fd0ff').multiplyScalar(2.5) }));
  bayMouth.rotation.x = Math.PI / 2;
  bayMouth.position.y = -radius * 0.732;
  root.add(bayMouth);

  // Rotating habitat ring.
  const ring = new THREE.Group();
  root.add(ring);
  ring.add(new THREE.Mesh(new THREE.TorusGeometry(R, radius * 0.07, 6, 48), hullMat));
  // Window band: thin emissive boxes around the outer rim.
  const windows: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 96; i++) {
    if (rng.next() < 0.25) continue;
    const a = (i / 96) * Math.PI * 2;
    const g = new THREE.BoxGeometry(radius * 0.02, radius * 0.025, radius * 0.035);
    g.rotateY(-a);
    g.translate(Math.cos(a) * (R + radius * 0.068), 0, Math.sin(a) * (R + radius * 0.068));
    windows.push(g);
  }
  const windowMesh = new THREE.Mesh(mergeGeometries(windows), windowMat);
  ring.add(windowMesh);
  ring.children[0].rotation.x = Math.PI / 2;
  // Spokes.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(R * 2, radius * 0.035, radius * 0.035), darkMat);
    spoke.rotation.y = a;
    if (i < 2) ring.add(spoke);
    const pod = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.12, radius * 0.1, radius * 0.18), accentMat);
    pod.position.set(Math.cos(a) * R, 0, Math.sin(a) * R);
    pod.rotation.y = -a;
    ring.add(pod);
  }

  // Solar arrays on the upper spindle.
  for (let i = 0; i < 2; i++) {
    const arm = new THREE.Group();
    arm.position.y = radius * 0.45;
    arm.rotation.y = i * Math.PI;
    const strut = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.7, radius * 0.02, radius * 0.02), darkMat);
    strut.position.x = radius * 0.45;
    arm.add(strut);
    for (let j = 0; j < 3; j++) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.18, radius * 0.005, radius * 0.4), panelMat);
      panel.position.set(radius * (0.25 + j * 0.21), 0, 0);
      arm.add(panel);
    }
    root.add(arm);
  }

  // Comms dish.
  const dish = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.09, 10, 6, 0, Math.PI * 2, 0, Math.PI / 3), hullMat);
  dish.position.set(radius * 0.12, radius * 0.2, 0);
  dish.rotation.z = -Math.PI / 2.5;
  root.add(dish);

  // Beacons and docking guide lights.
  const beacons: { mesh: THREE.Mesh; phase: number; period: number }[] = [];
  const beaconGeo = new THREE.SphereGeometry(radius * 0.012, 6, 4);
  const addBeacon = (pos: THREE.Vector3, color: string, phase: number, period: number, parent: THREE.Object3D = root) => {
    const m = new THREE.Mesh(beaconGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(10) }));
    m.position.copy(pos);
    parent.add(m);
    beacons.push({ mesh: m, phase, period });
  };
  addBeacon(new THREE.Vector3(0, radius * 0.84, 0), '#ff3030', 0, 1.6);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    addBeacon(new THREE.Vector3(Math.cos(a) * radius * 0.21, -radius * 0.74, Math.sin(a) * radius * 0.21), '#40ff80', i * 0.12, 1.2);
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    addBeacon(new THREE.Vector3(Math.cos(a) * (R + radius * 0.08), 0, Math.sin(a) * (R + radius * 0.08)), '#ffffff', i * 0.25, 2.2, ring);
  }

  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.frustumCulled = false;
  });

  return {
    root,
    update(_dt, time) {
      ring.rotation.y = time * 0.06;
      for (const b of beacons) b.mesh.visible = (time + b.phase) % b.period < 0.18;
    },
  };
}
