import * as THREE from 'three';
import { HULLS } from '../ships/defs';
import { defaultLoadout } from '../ships/fitting';
import { buildShip } from '../ships/shipBuilder';
import { hash2 } from './noise';
import type { SurfaceProfile } from './profile';
import type { Terrain } from './terrain';

export type PoiKind = 'ruins' | 'crash' | 'monolith';

export interface Poi {
  id: string;
  kind: PoiKind;
  name: string;
  x: number;
  y: number;
  z: number;
  /** Interaction spots: altar / crates / obelisk face. */
  spots: { x: number; y: number; z: number; id: string; label: string }[];
  /** Solid shapes for walking into: circles on the ground. */
  colliders: { x: number; z: number; r: number; top: number }[];
  group: THREE.Group | null;
  /** Revealed on the compass (pulse scan or walked near). */
  known: boolean;
}

export const POI_CELL = 460;

const RUIN_NAMES = ['Silent Ring', 'Glyph Court', 'Broken Spire', 'Sunken Hall', 'Watcher Stones', 'Echoing Gate', 'Hollow Shrine'];
const CRASH_NAMES = ['Crashed freighter', 'Downed warship', 'Wrecked hauler', 'Lost survey ship', 'Fallen corvette'];

/** POIs for the cell grid around the landing site (one is guaranteed close by). */
export function placePois(t: Terrain, profile: SurfaceProfile, gx: number, gz: number): Poi | null {
  const seed = profile.seed ^ 0x7017;
  const origin = gx === 0 && gz === 0;
  if (!origin && hash2(gx, gz, seed) > 0.42) return null;
  let x: number;
  let z: number;
  if (origin) {
    // Guaranteed find near the landing site: try a few bearings until one is dry.
    x = z = 0;
    for (let k = 0; k < 8; k++) {
      const a = hash2(1, 2 + k, seed) * Math.PI * 2;
      const d = 150 + hash2(3, 4 + k, seed) * 150;
      x = Math.cos(a) * d;
      z = Math.sin(a) * d;
      if (!t.wet(t.height(x, z))) break;
    }
  } else {
    x = (gx + 0.15 + hash2(gx, gz, seed + 1) * 0.7) * POI_CELL;
    z = (gz + 0.15 + hash2(gx, gz, seed + 2) * 0.7) * POI_CELL;
  }
  const h = t.height(x, z);
  if (t.wet(h)) return null;
  const roll = hash2(gx, gz, seed + 3);
  // Ruins are rarer on dead worlds; wrecks are everywhere.
  const kind: PoiKind = roll < (profile.hasAtmosphere ? 0.42 : 0.25) ? 'ruins' : roll < 0.85 ? 'crash' : 'monolith';
  const id = `${Math.round(x + t.ox)}:${Math.round(z + t.oz)}`;
  const nameRoll = Math.floor(hash2(gx, gz, seed + 4) * 7);
  const name = kind === 'ruins' ? `Ruins: ${RUIN_NAMES[nameRoll % RUIN_NAMES.length]}` : kind === 'crash' ? CRASH_NAMES[nameRoll % CRASH_NAMES.length] : 'Precursor monolith';
  return { id, kind, name, x, y: h, z, spots: [], colliders: [], group: null, known: origin };
}

function std(color: THREE.Color | string, opts: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05, flatShading: true, ...opts });
}

/** Build the POI's meshes and interaction spots. */
export function buildPoi(p: Poi, t: Terrain, profile: SurfaceProfile): void {
  const g = new THREE.Group();
  g.position.set(p.x, 0, p.z);
  const ground = (lx: number, lz: number) => t.height(p.x + lx, p.z + lz);
  const seed = hash2(Math.round(p.x), Math.round(p.z), profile.seed);
  const stone = profile.ramp.peak.clone().lerp(new THREE.Color('#9a9aa5'), 0.6);
  const glowCol = new THREE.Color().setHSL((0.5 + seed * 0.35) % 1, 0.9, 0.6);
  if (p.kind === 'ruins') {
    const mat = std(stone);
    const glow = new THREE.MeshBasicMaterial({ color: glowCol.clone().multiplyScalar(3) });
    const n = 9;
    const R = 13;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const lx = Math.cos(a) * R;
      const lz = Math.sin(a) * R;
      const broken = hash2(i, 3, seed * 1e6) < 0.35;
      const h = broken ? 2 + hash2(i, 5, seed * 1e6) * 3 : 7 + hash2(i, 7, seed * 1e6) * 2;
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(1.6, h, 1.6), mat);
      pillar.position.set(lx, ground(lx, lz) + h / 2 - 0.4, lz);
      pillar.rotation.y = a + (broken ? 0.3 : 0);
      if (broken) pillar.rotation.z = 0.12;
      g.add(pillar);
      p.colliders.push({ x: p.x + lx, z: p.z + lz, r: 1.2, top: pillar.position.y + h / 2 });
      if (!broken && i % 2 === 0) {
        const rune = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.6, 0.6), glow);
        rune.position.set(lx * 0.93, pillar.position.y + 1, lz * 0.93);
        rune.rotation.y = a;
        g.add(rune);
      }
    }
    // Lintels between some standing pillars.
    for (let i = 0; i < n; i += 3) {
      const a = ((i + 0.5) / n) * Math.PI * 2;
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1, 2 * R * Math.sin(Math.PI / n) + 1.6), mat);
      const lx = Math.cos(a) * R;
      const lz = Math.sin(a) * R;
      lintel.position.set(lx, ground(lx, lz) + 7.2, lz);
      lintel.rotation.y = a;
      if (hash2(i, 11, seed * 1e6) < 0.6) g.add(lintel);
    }
    // Central altar with a glowing glyph tablet.
    const base = ground(0, 0);
    const altar = new THREE.Mesh(new THREE.CylinderGeometry(3, 3.6, 1.2, 8), mat);
    altar.position.set(0, base + 0.4, 0);
    g.add(altar);
    const tablet = new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.6, 0.4), mat);
    tablet.position.set(0, base + 2.3, 0);
    g.add(tablet);
    const glyph = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.8), glow);
    glyph.position.set(0, base + 2.4, 0.21);
    g.add(glyph);
    const glyph2 = glyph.clone();
    glyph2.rotation.y = Math.PI;
    glyph2.position.z = -0.21;
    g.add(glyph2);
    p.colliders.push({ x: p.x, z: p.z, r: 3.2, top: base + 1 });
    p.spots.push({ x: p.x, y: base + 2, z: p.z + 3.4, id: `${p.id}:glyph`, label: 'Translate the glyphs' });
  } else if (p.kind === 'crash') {
    const hullIds = HULLS.filter((h) => h.size !== 'capital').map((h) => h.id);
    const hull = hullIds[Math.floor(seed * hullIds.length)];
    const wreck = buildShip(defaultLoadout(hull));
    wreck.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m instanceof THREE.MeshStandardMaterial) {
        m.color.multiplyScalar(0.35);
        m.emissive?.setRGB(0, 0, 0);
      } else if (m) (o as THREE.Mesh).visible = false;
    });
    const base = ground(0, 0);
    wreck.root.position.set(0, base + wreck.radius * 0.12, 0);
    wreck.root.rotation.set(-0.12, seed * Math.PI * 2, 0.45);
    g.add(wreck.root);
    p.colliders.push({ x: p.x, z: p.z, r: wreck.radius * 0.55, top: base + wreck.radius * 0.5 });
    // Debris and a scorched scar.
    const scorch = new THREE.Mesh(new THREE.CircleGeometry(wreck.radius * 1.4, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#0a0806', transparent: true, opacity: 0.55, depthWrite: false }));
    scorch.position.set(0, base + 0.25, 0);
    g.add(scorch);
    const debrisMat = std('#2c2a2a', { metalness: 0.5, roughness: 0.6 });
    for (let i = 0; i < 10; i++) {
      const a = hash2(i, 1, seed * 1e6) * Math.PI * 2;
      const d = wreck.radius * (0.7 + hash2(i, 2, seed * 1e6) * 1.2);
      const lx = Math.cos(a) * d;
      const lz = Math.sin(a) * d;
      const s = 0.4 + hash2(i, 3, seed * 1e6) * 1.4;
      const piece = new THREE.Mesh(new THREE.BoxGeometry(s * 2, s * 0.4, s), debrisMat);
      piece.position.set(lx, ground(lx, lz) + s * 0.1, lz);
      piece.rotation.set(hash2(i, 4, seed) * 2, a, hash2(i, 5, seed));
      g.add(piece);
    }
    // Cargo crates thrown clear of the wreck.
    const crateMat = std('#6b5a3a');
    const stripe = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffb547').multiplyScalar(2.5) });
    const crates = 2 + Math.floor(seed * 2);
    for (let i = 0; i < crates; i++) {
      const a = seed * 9 + i * 2.1;
      const d = wreck.radius * 0.9 + 4 + i * 2;
      const lx = Math.cos(a) * d;
      const lz = Math.sin(a) * d;
      const y = ground(lx, lz);
      const crate = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1, 1), crateMat);
      crate.position.set(lx, y + 0.45, lz);
      crate.rotation.y = a;
      g.add(crate);
      const band = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.12, 1.02), stripe);
      band.position.copy(crate.position);
      band.rotation.y = a;
      g.add(band);
      p.spots.push({ x: p.x + lx, y: y + 0.5, z: p.z + lz, id: `${p.id}:crate${i}`, label: 'Open the cargo crate' });
      p.colliders.push({ x: p.x + lx, z: p.z + lz, r: 0.8, top: y + 1 });
    }
  } else {
    const base = ground(0, 0);
    const obelisk = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.6, 14, 4), std('#1a1a22', { metalness: 0.4, roughness: 0.3 }));
    obelisk.position.set(0, base + 6.6, 0);
    obelisk.rotation.y = Math.PI / 4;
    g.add(obelisk);
    const rune = new THREE.Mesh(new THREE.BoxGeometry(0.2, 9, 0.2), new THREE.MeshBasicMaterial({ color: glowCol.clone().multiplyScalar(4) }));
    rune.position.set(0, base + 7, 1.15);
    g.add(rune);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(4.5, 0.25, 6, 24).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: glowCol.clone().multiplyScalar(2) }));
    ring.position.set(0, base + 0.3, 0);
    g.add(ring);
    p.colliders.push({ x: p.x, z: p.z, r: 1.6, top: base + 14 });
    p.spots.push({ x: p.x, y: base + 1.5, z: p.z + 2.2, id: `${p.id}:monolith`, label: 'Touch the monolith' });
  }
  p.group = g;
}
