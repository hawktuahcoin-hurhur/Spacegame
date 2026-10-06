import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hash2 } from './noise';
import type { FloraKind, FloraSpec, ResourceSpec, SurfaceProfile } from './profile';
import type { Terrain } from './terrain';

/** A piece of geometry painted one colour (merged into a kind's mesh). */
function part(geo: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set([color.r, color.g, color.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  return g;
}

const brown = new THREE.Color('#5a4030');
const dark = (c: THREE.Color, k: number) => c.clone().multiplyScalar(k);

export interface PropModel {
  body: THREE.BufferGeometry;
  /** Emissive parts (pods, crystals, cracks), drawn unlit and bright. */
  glow: THREE.BufferGeometry | null;
  /** Trunk radius for collisions (0 = walk through). */
  radius: number;
  /** Rough height, for scanning and placement. */
  height: number;
}

/** Low-poly model for a flora kind in this world's colours. Height in metres at scale 1. */
export function floraModel(spec: FloraSpec, seed: number): PropModel {
  const c = spec.color;
  const a = spec.accent;
  const body: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];
  const r = (n: number) => hash2(seed, n, 99);
  let radius = 0;
  let height = 1;
  switch (spec.kind as FloraKind) {
    case 'broadleaf': {
      body.push(part(new THREE.CylinderGeometry(0.18, 0.32, 3.4, 6).translate(0, 1.7, 0), brown));
      body.push(part(new THREE.IcosahedronGeometry(2.3, 0).scale(1, 0.85, 1).translate(0, 4.4, 0), c));
      body.push(part(new THREE.IcosahedronGeometry(1.5, 0).translate(1.1, 3.6, 0.4), dark(c, 0.85)));
      body.push(part(new THREE.IcosahedronGeometry(1.3, 0).translate(-1, 3.8, -0.6), dark(c, 1.1)));
      radius = 0.4;
      height = 6.2;
      break;
    }
    case 'conifer': {
      body.push(part(new THREE.CylinderGeometry(0.15, 0.3, 2, 5).translate(0, 1, 0), brown));
      for (let i = 0; i < 3; i++) body.push(part(new THREE.ConeGeometry(2.1 - i * 0.55, 2.8 - i * 0.4, 7).translate(0, 2.4 + i * 1.6, 0), dark(c, 0.9 + i * 0.1)));
      radius = 0.35;
      height = 7.5;
      break;
    }
    case 'bush':
      body.push(part(new THREE.IcosahedronGeometry(0.9, 0).scale(1.2, 0.75, 1).translate(0, 0.55, 0), c));
      body.push(part(new THREE.IcosahedronGeometry(0.6, 0).translate(0.6, 0.5, 0.3), dark(c, 1.15)));
      height = 1.3;
      break;
    case 'grass':
      for (let i = 0; i < 4; i++) {
        const ang = (i / 4) * Math.PI * 2 + r(i);
        body.push(part(new THREE.ConeGeometry(0.07, 0.6 + r(i + 5) * 0.4, 3).rotateZ((r(i + 9) - 0.5) * 0.5).translate(Math.cos(ang) * 0.15, 0.3, Math.sin(ang) * 0.15), i % 2 ? c : dark(c, 1.2)));
      }
      height = 0.7;
      break;
    case 'palm': {
      const segs = 5;
      for (let i = 0; i < segs; i++) body.push(part(new THREE.CylinderGeometry(0.2, 0.26, 1.3, 5).rotateZ(-0.08 * i).translate(i * 0.12, 0.65 + i * 1.2, 0), brown));
      const top = new THREE.Vector3(segs * 0.12, segs * 1.2 + 0.2, 0);
      for (let i = 0; i < 7; i++) {
        const ang = (i / 7) * Math.PI * 2;
        body.push(part(new THREE.ConeGeometry(0.45, 3.2, 3).rotateZ(Math.PI / 2 + 0.35).rotateY(ang).translate(top.x + Math.cos(ang) * 1.4, top.y - 0.3, top.z - Math.sin(ang) * 1.4), i % 2 ? c : dark(c, 0.85)));
      }
      radius = 0.3;
      height = 7;
      break;
    }
    case 'cactus':
      body.push(part(new THREE.CylinderGeometry(0.42, 0.48, 3.2, 7).translate(0, 1.6, 0), c));
      body.push(part(new THREE.CylinderGeometry(0.25, 0.28, 1.3, 6).translate(0.75, 1.9, 0), c));
      body.push(part(new THREE.CylinderGeometry(0.25, 0.25, 0.5, 6).rotateZ(Math.PI / 2).translate(0.45, 1.3, 0), c));
      body.push(part(new THREE.CylinderGeometry(0.22, 0.25, 1, 6).translate(-0.65, 1.5, 0), dark(c, 0.9)));
      body.push(part(new THREE.CylinderGeometry(0.22, 0.22, 0.4, 6).rotateZ(Math.PI / 2).translate(-0.4, 1.05, 0), dark(c, 0.9)));
      body.push(part(new THREE.IcosahedronGeometry(0.22, 0).translate(0, 3.3, 0), a));
      radius = 0.5;
      height = 3.4;
      break;
    case 'shrub':
      for (let i = 0; i < 5; i++) {
        const ang = (i / 5) * Math.PI * 2;
        body.push(part(new THREE.CylinderGeometry(0.03, 0.06, 1.1, 3).rotateZ(0.5).rotateY(ang).translate(Math.cos(ang) * 0.25, 0.45, -Math.sin(ang) * 0.25), c));
      }
      body.push(part(new THREE.IcosahedronGeometry(0.3, 0).translate(0, 0.2, 0), dark(c, 0.8)));
      height = 1;
      break;
    case 'mushroom':
      body.push(part(new THREE.CylinderGeometry(0.22, 0.35, 2.4, 7).translate(0, 1.2, 0), dark(c, 0.6).lerp(new THREE.Color(1, 1, 1), 0.3)));
      body.push(part(new THREE.SphereGeometry(1.5, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.55, 1).translate(0, 2.3, 0), c));
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2;
        glow.push(part(new THREE.IcosahedronGeometry(0.13, 0).translate(Math.cos(ang) * 1.05, 2.25, Math.sin(ang) * 1.05), a));
      }
      radius = 0.4;
      height = 3.1;
      break;
    case 'spore':
      body.push(part(new THREE.CylinderGeometry(0.05, 0.09, 1.2, 4).translate(0, 0.6, 0), dark(c, 0.6)));
      glow.push(part(new THREE.IcosahedronGeometry(0.28, 1).translate(0, 1.3, 0), a));
      body.push(part(new THREE.ConeGeometry(0.35, 0.3, 5).translate(0, 0.12, 0), dark(c, 0.8)));
      height = 1.6;
      break;
    case 'crystalTree':
      for (let i = 0; i < 5; i++) {
        const ang = (i / 5) * Math.PI * 2 + r(i);
        const h = 2 + r(i + 3) * 3.5;
        const g = new THREE.OctahedronGeometry(0.5, 0).scale(1, h, 1).rotateZ((r(i + 7) - 0.5) * 0.6).translate(Math.cos(ang) * 0.5, h * 0.8, Math.sin(ang) * 0.5);
        (i % 2 ? glow : body).push(part(g, i % 2 ? a : c));
      }
      radius = 0.8;
      height = 5;
      break;
    case 'iceSpike':
      for (let i = 0; i < 4; i++) {
        const ang = (i / 4) * Math.PI * 2 + r(i);
        const h = 1.5 + r(i + 2) * 3;
        body.push(part(new THREE.OctahedronGeometry(0.45, 0).scale(1, h, 1).rotateZ((r(i + 5) - 0.5) * 0.4).translate(Math.cos(ang) * 0.4, h * 0.6, Math.sin(ang) * 0.4), dark(c, 0.85 + r(i) * 0.3)));
      }
      radius = 0.6;
      height = 4;
      break;
    case 'obsidian':
      for (let i = 0; i < 3; i++) {
        const ang = (i / 3) * Math.PI * 2 + r(i);
        const h = 2 + r(i + 2) * 2.5;
        const g = new THREE.ConeGeometry(0.6, h, 5).rotateZ((r(i + 5) - 0.5) * 0.5).translate(Math.cos(ang) * 0.5, h / 2, Math.sin(ang) * 0.5);
        body.push(part(g, c));
        glow.push(part(new THREE.ConeGeometry(0.12, h * 0.8, 3).translate(Math.cos(ang) * 0.5 + 0.35, h * 0.4, Math.sin(ang) * 0.5), a));
      }
      radius = 0.7;
      height = 3.5;
      break;
    case 'rock':
      body.push(part(new THREE.DodecahedronGeometry(0.8, 0).scale(1.3, 0.75, 1).translate(0, 0.35, 0), c));
      radius = 0.8;
      height = 1;
      break;
    case 'boulder':
      body.push(part(new THREE.DodecahedronGeometry(1.8, 0).scale(1.2, 0.85, 1).translate(0, 1, 0), c));
      body.push(part(new THREE.DodecahedronGeometry(0.9, 0).translate(1.6, 0.4, 0.6), dark(c, 0.9)));
      radius = 1.9;
      height = 2.6;
      break;
  }
  const merged = mergeGeometries(body)!;
  merged.computeVertexNormals();
  const glowGeo = glow.length ? mergeGeometries(glow) : null;
  return { body: merged, glow: glowGeo, radius, height };
}

/** A glowing mineral deposit for the mining beam. */
export function depositModel(res: ResourceSpec): PropModel {
  const body: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];
  const rockCol = new THREE.Color('#3a3a40');
  body.push(part(new THREE.DodecahedronGeometry(1.1, 0).scale(1.3, 0.6, 1.1).translate(0, 0.2, 0), rockCol));
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2;
    const h = 0.9 + (i % 3) * 0.45;
    glow.push(part(new THREE.OctahedronGeometry(0.28, 0).scale(1, h * 2, 1).rotateZ(0.3 * Math.cos(ang)).rotateX(0.3 * Math.sin(ang)).translate(Math.cos(ang) * 0.55, 0.5 + h * 0.5, Math.sin(ang) * 0.55), res.color));
  }
  const b = mergeGeometries(body)!;
  b.computeVertexNormals();
  return { body: b, glow: mergeGeometries(glow), radius: 1.2, height: 2 };
}

export interface PlacedProp {
  x: number;
  y: number;
  z: number;
  scale: number;
  rot: number;
  /** Index into the profile's flora list. */
  spec: number;
  radius: number;
  height: number;
}

/** Deterministic flora placement for a chunk. `dense` adds ground cover (near chunks only). */
export function placeFlora(t: Terrain, profile: SurfaceProfile, models: PropModel[], cx: number, cz: number, size: number, dense: boolean): PlacedProp[] {
  const out: PlacedProp[] = [];
  const seed = profile.seed;
  profile.flora.forEach((spec, si) => {
    const ground = spec.kind === 'grass' || spec.kind === 'shrub' || spec.kind === 'spore' || spec.kind === 'bush';
    if (ground && !dense) return;
    const count = Math.round(((spec.density * size * size) / 1000) * (ground ? 1 : 1));
    for (let i = 0; i < count; i++) {
      const hx = hash2(cx * 977 + i, cz * 613 + si * 31, seed);
      const hz = hash2(cx * 389 + i * 7, cz * 157 + si * 17, seed ^ 0x55);
      const x = cx * size + hx * size;
      const z = cz * size + hz * size;
      // Forests and clearings: clump by a low-frequency mask.
      const clump = hash2(Math.floor(x / 48), Math.floor(z / 48), seed + si) * 0.6 + hash2(Math.floor(x / 160), Math.floor(z / 160), seed - si) * 0.8;
      if (clump < 0.55 && !ground) continue;
      const h = t.height(x, z);
      if (t.wet(h)) continue;
      const f = (h - t.minH) / (t.maxH - t.minH);
      if (f > profile.snowLine + 0.03 && spec.kind !== 'iceSpike' && spec.kind !== 'rock' && spec.kind !== 'boulder') continue;
      const slope = t.normal(x, z).y;
      if (slope < (spec.living ? 0.82 : 0.6)) continue;
      const scale = spec.scale[0] + hash2(i, cx + cz * 31, seed + 5) * (spec.scale[1] - spec.scale[0]);
      out.push({ x, y: h - 0.15, z, scale, rot: hx * Math.PI * 2 * 7, spec: si, radius: models[si].radius * scale, height: models[si].height * scale });
    }
  });
  return out;
}

/** Mineral deposits in a chunk (ids are stable so harvested ones stay gone). */
export function placeDeposits(t: Terrain, profile: SurfaceProfile, cx: number, cz: number, size: number): { id: string; x: number; y: number; z: number; res: number; amount: number }[] {
  const out: { id: string; x: number; y: number; z: number; res: number; amount: number }[] = [];
  const total = profile.resources.reduce((a, r) => a + r.weight, 0);
  for (let i = 0; i < 2; i++) {
    if (hash2(cx * 7 + i, cz * 13, profile.seed ^ 0xdead) > 0.32) continue;
    const x = cx * size + hash2(cx, cz * 3 + i, profile.seed + 1) * size;
    const z = cz * size + hash2(cx * 5 + i, cz, profile.seed + 2) * size;
    const h = t.height(x, z);
    if (t.wet(h) || t.normal(x, z).y < 0.75) continue;
    let pick = hash2(cx + i, cz - i, profile.seed + 3) * total;
    let res = 0;
    while (res < profile.resources.length - 1 && pick > profile.resources[res].weight) pick -= profile.resources[res++].weight;
    out.push({ id: `${Math.round(x + t.ox)}:${Math.round(z + t.oz)}`, x, y: h - 0.2, z, res, amount: 10 + Math.floor(hash2(cx, cz, i + 77) * 22) });
  }
  return out;
}
