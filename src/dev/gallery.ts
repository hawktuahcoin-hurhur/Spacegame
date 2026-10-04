import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { HULLS } from '../ships/defs';
import { defaultLoadout } from '../ships/fitting';
import { buildShip } from '../ships/shipBuilder';

/** Dev-only hull gallery (?gallery=1): every hull with its stock loadout, for eyeballing the builder. */
export function runGallery(container: HTMLElement, only: string | null = null): void {
  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0a0f18');
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;
  const sun = new THREE.DirectionalLight('#fff4e0', 3);
  sun.position.set(-1, 1.2, 0.6);
  scene.add(sun, new THREE.HemisphereLight('#6080ff', '#201810', 0.6));
  const cell = 1;
  const list = only ? HULLS.filter((h) => only.split(',').includes(h.id)) : HULLS;
  const cols = only ? Math.min(list.length, 2) : 4;
  const rows = Math.ceil(list.length / cols);
  list.forEach((h, i) => {
    const ship = buildShip(defaultLoadout(h.id));
    // Normalise each ship to the cell so tiny frigates and huge capitals both read.
    const s = (cell * 0.9) / (ship.radius * 2);
    ship.root.scale.setScalar(s);
    ship.root.rotation.set(0.35, -2.5, 0.08);
    ship.root.position.set(((i % cols) - (cols - 1) / 2) * cell * 1.15, -(Math.floor(i / cols) - (rows - 1) / 2) * cell * 0.85, 0);
    ship.update(0, 0, 0.6, false, 0, 0, 0);
    scene.add(ship.root);
    const label = document.createElement('div');
    label.textContent = `${h.name} · ${h.size} · ${h.style}`;
    label.style.cssText = `position:fixed;color:#9fe3ff;font:13px sans-serif;left:${((i % cols) + 0.5) * (100 / cols)}%;top:${(Math.floor(i / cols) + 0.15) * (100 / rows)}%;transform:translateX(-50%)`;
    document.body.appendChild(label);
  });
  const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.01, 100);
  camera.position.set(0, 0, only ? 2.4 * rows : 6.2);
  renderer.render(scene, camera);
  (window as unknown as { galleryReady: boolean }).galleryReady = true;
}
