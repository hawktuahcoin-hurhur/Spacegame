import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../core/rng';
import { type HullDef, type HullProfile, type Loadout, type ShipStyle, type SlotDef, type WeaponDef, hull as hullDef, weapon as weaponDef } from './defs';

/**
 * Procedural ship builder (SUPERPLAN §3.4): every hull is lofted from a
 * profile + recipe in its manufacturer's style, then weapon models are
 * mounted at the real slot positions. Ships face -Z with +Y up.
 */

interface Palette {
  hull: string;
  dark: string;
  accent: string;
  glow: string;
  patch: string;
  bevel: number;
  metal: number;
  rough: number;
}

export const STYLES: Record<ShipStyle, Palette> = {
  frontier: { hull: '#b8c2cc', dark: '#2b3038', accent: '#ff7a2f', glow: '#5fd4ff', patch: '#8d99a6', bevel: 0.32, metal: 0.55, rough: 0.42 },
  hegemony: { hull: '#69788c', dark: '#21262d', accent: '#d9a441', glow: '#ffb36b', patch: '#4d5866', bevel: 0.14, metal: 0.6, rough: 0.5 },
  tricorp: { hull: '#e8edf3', dark: '#3a4553', accent: '#2fc6ff', glow: '#8fe8ff', patch: '#c9d3de', bevel: 0.5, metal: 0.35, rough: 0.28 },
  pirate: { hull: '#8a6f5a', dark: '#2e2723', accent: '#c0392b', glow: '#ff6a3d', patch: '#6f7d5a', bevel: 0.26, metal: 0.45, rough: 0.7 },
};

/** Cross-section stations: [t, width fraction, height fraction, y offset fraction]. */
const PROFILES: Record<HullProfile, [number, number, number, number][]> = {
  dart: [
    [0, 0.04, 0.04, 0],
    [0.1, 0.4, 0.45, 0],
    [0.35, 0.8, 0.85, 0.05],
    [0.6, 1, 1, 0.05],
    [0.85, 0.95, 0.9, 0],
    [1, 0.75, 0.7, 0],
  ],
  wedge: [
    [0, 0.25, 0.35, -0.05],
    [0.12, 0.55, 0.6, 0],
    [0.45, 0.85, 0.9, 0],
    [0.8, 1, 1, 0],
    [1, 1, 0.92, 0],
  ],
  needle: [
    [0, 0.02, 0.02, 0],
    [0.18, 0.32, 0.3, 0],
    [0.45, 0.62, 0.55, 0],
    [0.72, 0.78, 0.62, 0],
    [1, 0.5, 0.4, 0],
  ],
  brick: [
    [0, 0.6, 0.55, 0],
    [0.05, 0.9, 0.85, 0],
    [0.5, 1, 1, 0],
    [0.92, 0.95, 0.95, 0],
    [1, 0.72, 0.7, 0],
  ],
  hauler: [
    [0, 0.45, 0.5, 0.1],
    [0.08, 0.75, 0.8, 0.1],
    [0.16, 0.55, 0.55, 0],
    [0.86, 0.55, 0.55, 0],
    [0.93, 0.8, 0.8, 0],
    [1, 0.7, 0.7, 0],
  ],
};

interface Section {
  z: number;
  w: number;
  h: number;
  y: number;
}

/** Loft a closed hull through beveled octagonal cross-sections. */
export function loft(sections: Section[], bevel = 0.32): THREE.BufferGeometry {
  const prof: [number, number][] = [
    [1, bevel],
    [bevel, 1],
    [-bevel, 1],
    [-1, bevel],
    [-1, -bevel],
    [-bevel, -1],
    [bevel, -1],
    [1, -bevel],
  ];
  const rings = sections.map((s) => prof.map(([x, y]) => new THREE.Vector3(x * s.w * 0.5, y * s.h * 0.5 + s.y, s.z)));
  const pos: number[] = [];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < 8; j++) {
      const k = (j + 1) % 8;
      tri(rings[i][j], rings[i + 1][j], rings[i + 1][k]);
      tri(rings[i][j], rings[i + 1][k], rings[i][k]);
    }
  }
  const centre = (r: THREE.Vector3[]) => r.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / r.length);
  const c0 = centre(rings[0]);
  const c1 = centre(rings[rings.length - 1]);
  for (let j = 0; j < 8; j++) {
    const k = (j + 1) % 8;
    tri(c0, rings[0][k], rings[0][j]);
    tri(c1, rings[rings.length - 1][j], rings[rings.length - 1][k]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function wingGeometry(span: number, rootChord: number, tipChord: number, sweep: number, thickness: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(span, sweep);
  shape.lineTo(span, sweep + tipChord);
  shape.lineTo(0, rootChord);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true, bevelThickness: thickness * 0.4, bevelSize: thickness * 0.5, bevelSegments: 1 });
  g.rotateX(Math.PI / 2);
  g.translate(0, thickness / 2, 0);
  return g;
}

const plumeVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;
const plumeFragment = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec2 vUv;
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
void main() {
  #include <logdepthbuf_fragment>
  float along = vUv.y;
  float across = abs(vUv.x - 0.5) * 2.0;
  float core = pow(along, 2.2) * (1.0 - across * 0.6);
  float shock = 0.75 + 0.25 * sin(along * 38.0 - uTime * 50.0);
  float a = core * shock * uIntensity;
  vec3 col = mix(uColor, vec3(1.0), pow(along, 6.0) * 0.6);
  gl_FragColor = vec4(col * a, 1.0);
}
`;

export interface Mount {
  slot: SlotDef;
  /** Placed on the hull, oriented to the slot's facing. */
  root: THREE.Group;
  /** Rotates to aim (turrets only). */
  yaw: THREE.Group;
  weapon: WeaponDef | null;
}

export interface ShipVisual {
  root: THREE.Group;
  body: THREE.Group;
  hull: HullDef;
  length: number;
  /** Bounding radius for collisions and camera framing. */
  radius: number;
  mounts: Map<string, Mount>;
  update(dt: number, time: number, throttle: number, boost: boolean, supercruise: number, bank: number, pitchLean: number): void;
  /** Swing turrets toward a direction given in the ship's local space. */
  aimTurrets(localDir: THREE.Vector3 | null, dt: number): void;
  /** Slot position in ship-local space (for UI markers). */
  slotPosition(slotId: string, out?: THREE.Vector3): THREE.Vector3;
  dispose(): void;
}

interface Materials {
  hull: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  patch: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  windows: THREE.MeshBasicMaterial;
  gunmetal: THREE.MeshStandardMaterial;
  engine: THREE.MeshBasicMaterial;
  plume: THREE.ShaderMaterial;
  glowEnergy: THREE.MeshBasicMaterial;
  glowMissile: THREE.MeshBasicMaterial;
  brass: THREE.MeshStandardMaterial;
}

function makeMaterials(p: Palette): Materials {
  const std = (color: string, metal = p.metal, rough = p.rough) => new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough, flatShading: true });
  const glow = new THREE.Color(p.glow);
  return {
    hull: std(p.hull),
    dark: std(p.dark, 0.7, 0.55),
    accent: std(p.accent, 0.3, 0.5),
    patch: std(p.patch, 0.4, 0.75),
    glass: new THREE.MeshStandardMaterial({ color: '#0b1a26', metalness: 1, roughness: 0.08, emissive: glow.clone(), emissiveIntensity: 0.25, flatShading: true }),
    windows: new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffd9a0').multiplyScalar(2.5) }),
    gunmetal: std('#4a5059', 0.8, 0.35),
    engine: new THREE.MeshBasicMaterial({ color: glow.clone().multiplyScalar(6) }),
    plume: new THREE.ShaderMaterial({
      vertexShader: plumeVertex,
      fragmentShader: plumeFragment,
      uniforms: { uColor: { value: glow.clone().multiplyScalar(3) }, uIntensity: { value: 1 }, uTime: { value: 0 } },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    glowEnergy: new THREE.MeshBasicMaterial({ color: new THREE.Color('#5fe0ff').multiplyScalar(4) }),
    glowMissile: new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff5a3c').multiplyScalar(3) }),
    brass: std('#b08d57', 0.85, 0.35),
  };
}

const SLOT_SCALE = { S: 0.55, M: 0.95, L: 1.6 };

/** A weapon model in mount space (facing -Z, up +Y), sized by slot. */
function weaponModel(w: WeaponDef, r: number, m: Materials, turret: boolean): THREE.Group {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    g.add(mesh);
    return mesh;
  };
  const barrel = (radius: number, length: number, x: number, y: number, mat: THREE.Material = m.gunmetal) => {
    const geo = new THREE.CylinderGeometry(radius, radius * 1.1, length, 8).rotateX(Math.PI / 2);
    return add(geo, mat, x, y, -length / 2 - r * 0.4);
  };
  const hy = r * 0.45;
  const housing = (wd: number, ht: number, dp: number, mat: THREE.Material = m.gunmetal) => add(new THREE.BoxGeometry(wd, ht, dp), mat, 0, hy, 0);
  switch (w.model) {
    case 'autocannon':
      housing(r * 1.4, r * 0.75, r * 1.5);
      barrel(r * 0.13, r * 2.2, -r * 0.28, hy);
      barrel(r * 0.13, r * 2.2, r * 0.28, hy);
      break;
    case 'cannon':
      housing(r * 1.3, r * 0.85, r * 1.6);
      barrel(r * 0.22, r * 2.6, 0, hy);
      add(new THREE.CylinderGeometry(r * 0.3, r * 0.3, r * 0.35, 8).rotateX(Math.PI / 2), m.dark, 0, hy, -r * 3.0);
      break;
    case 'flak':
      housing(r * 1.3, r * 0.8, r * 1.2, m.brass);
      for (const [x, y] of [
        [-0.2, 0.15],
        [0.2, 0.15],
        [-0.2, -0.15],
        [0.2, -0.15],
      ])
        barrel(r * 0.09, r * 1.4, x * r, hy + y * r);
      break;
    case 'railgun': {
      housing(r * 1.2, r * 0.7, r * 1.8);
      for (const x of [-0.22, 0.22]) {
        const rail = add(new THREE.BoxGeometry(r * 0.12, r * 0.22, r * 3.4), m.gunmetal, x * r, hy, -r * 2.0);
        rail.castShadow = false;
      }
      for (let i = 0; i < 3; i++)
        add(new THREE.TorusGeometry(r * 0.32, r * 0.06, 4, 10), m.glowEnergy, 0, hy, -r * (1.0 + i * 0.8));
      break;
    }
    case 'laser':
      housing(r * 1.1, r * 0.75, r * 1.3);
      barrel(r * 0.18, r * 1.7, 0, hy);
      add(new THREE.SphereGeometry(r * 0.2, 8, 6), m.glowEnergy, 0, hy, -r * 2.15);
      break;
    case 'beam':
      housing(r * 1.2, r * 0.8, r * 1.4);
      barrel(r * 0.24, r * 1.9, 0, hy, m.dark);
      for (let i = 0; i < 3; i++) add(new THREE.TorusGeometry(r * 0.3, r * 0.05, 4, 10), m.glowEnergy, 0, hy, -r * (0.9 + i * 0.45));
      add(new THREE.SphereGeometry(r * 0.26, 10, 8), m.glowEnergy, 0, hy, -r * 2.35);
      break;
    case 'plasma':
      add(new THREE.SphereGeometry(r * 0.75, 10, 8), m.gunmetal, 0, hy, 0);
      barrel(r * 0.34, r * 1.6, 0, hy, m.dark);
      add(new THREE.CylinderGeometry(r * 0.42, r * 0.42, r * 0.12, 10).rotateX(Math.PI / 2), m.glowEnergy, 0, hy, -r * 1.4);
      break;
    case 'rocket-pod': {
      housing(r * 1.3, r * 1.0, r * 1.5);
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++)
          add(new THREE.CylinderGeometry(r * 0.12, r * 0.12, r * 0.1, 6).rotateX(Math.PI / 2), m.glowMissile, (i - 1) * r * 0.36, hy + (j - 1) * r * 0.26, -r * 0.78);
      break;
    }
    case 'missile-rack': {
      housing(r * 1.4, r * 0.5, r * 1.6);
      for (const x of [-0.35, 0.35]) {
        add(new THREE.CylinderGeometry(r * 0.16, r * 0.16, r * 1.6, 6).rotateX(Math.PI / 2), m.patch, x * r, hy + r * 0.38, -r * 0.2);
        add(new THREE.ConeGeometry(r * 0.16, r * 0.4, 6).rotateX(-Math.PI / 2), m.glowMissile, x * r, hy + r * 0.38, -r * 1.2);
      }
      break;
    }
    case 'torpedo':
      housing(r * 1.6, r * 0.9, r * 2.0);
      for (const x of [-0.38, 0.38])
        add(new THREE.CylinderGeometry(r * 0.3, r * 0.3, r * 0.15, 10).rotateX(Math.PI / 2), m.glowMissile, x * r, hy, -r * 1.02);
      break;
  }
  // Turrets sit on a ring base; hardpoints are recessed into the hull.
  if (!turret) g.position.y = -r * 0.35;
  return g;
}

/** Linear interpolation of the hull profile at t. */
function sectionAt(profile: [number, number, number, number][], t: number): [number, number, number] {
  for (let i = 0; i < profile.length - 1; i++) {
    const [t0, w0, h0, y0] = profile[i];
    const [t1, w1, h1, y1] = profile[i + 1];
    if (t <= t1) {
      const f = (t - t0) / Math.max(t1 - t0, 1e-6);
      return [w0 + (w1 - w0) * f, h0 + (h1 - h0) * f, y0 + (y1 - y0) * f];
    }
  }
  const last = profile[profile.length - 1];
  return [last[1], last[2], last[3]];
}

export interface BuildOptions {
  /** Draw empty slots as hatches (refit view) instead of hiding them. */
  showEmptySlots?: boolean;
}

/** Build a ship from a loadout (or a bare hull id for a stock-less preview). */
export function buildShip(loadout: Loadout, opts: BuildOptions = {}): ShipVisual {
  const h = hullDef(loadout.hullId);
  const r = h.recipe;
  const pal = STYLES[h.style];
  const mats = makeMaterials(pal);
  const rng = new Rng(r.seed * 7919 + 13);
  const L = r.length;
  const W = r.beam * L;
  const H = r.height * L;
  const profile = PROFILES[r.profile];
  const zAt = (t: number) => -L / 2 + t * L;
  const sec = (t: number) => {
    const [w, ht, y] = sectionAt(profile, t);
    return { w: w * W, h: ht * H, y: y * H };
  };

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
    const m = new THREE.Mesh(geo, mat);
    body.add(m);
    return m;
  };

  // --- Main hull.
  add(loft(profile.map(([t, w, ht, y]) => ({ z: zAt(t), w: w * W, h: ht * H, y: y * H })), pal.bevel), mats.hull);

  // --- Dorsal spine / armour belt by style.
  if (h.style === 'hegemony') {
    for (const side of [-1, 1]) {
      const plates: THREE.BufferGeometry[] = [];
      for (let t = 0.2; t < 0.92; t += 0.09) {
        const s = sec(t);
        const g = new THREE.BoxGeometry(W * 0.06, s.h * 0.55, L * 0.075);
        g.translate(side * (s.w * 0.5 + W * 0.02), s.y, zAt(t));
        plates.push(g);
      }
      add(mergeGeometries(plates), mats.dark);
    }
  } else {
    const spine: Section[] = [];
    for (const t of [0.22, 0.35, 0.7, 0.88]) {
      const s = sec(t);
      spine.push({ z: zAt(t), w: s.w * (t === 0.22 || t === 0.88 ? 0.12 : 0.28), h: H * 0.18, y: s.y + s.h * 0.5 });
    }
    add(loft(spine, 0.4), h.style === 'pirate' ? mats.patch : mats.accent);
  }

  // --- Cockpit (small ships) or bridge towers (big ships).
  if (r.towers === 0) {
    const t0 = r.profile === 'needle' ? 0.22 : 0.18;
    const c: Section[] = [0, 0.4, 0.8, 1].map((f) => {
      const t = t0 + f * 0.16;
      const s = sec(t);
      const ww = s.w * (f === 0 || f === 1 ? 0.15 : 0.45);
      return { z: zAt(t), w: ww, h: H * (f === 0 || f === 1 ? 0.05 : 0.32), y: s.y + s.h * 0.45 };
    });
    add(loft(c, 0.45), mats.glass);
  } else {
    for (let i = 0; i < r.towers; i++) {
      const t = 0.58 + i * 0.1 - (r.towers - 1) * 0.05;
      const s = sec(t);
      const tw = Math.min(s.w * 0.45, L * 0.09) * (1 - i * 0.15);
      const th = H * (0.7 - i * 0.12);
      const base = s.y + s.h * 0.5;
      const tower = add(new THREE.BoxGeometry(tw, th, L * 0.06), mats.hull);
      tower.position.set(0, base + th / 2, zAt(t));
      const top = add(new THREE.BoxGeometry(tw * 1.25, th * 0.22, L * 0.045), mats.dark);
      top.position.set(0, base + th, zAt(t) - L * 0.006);
      const win = add(new THREE.BoxGeometry(tw * 1.27, th * 0.06, L * 0.046), mats.windows);
      win.position.set(0, base + th * 0.98, zAt(t) - L * 0.006);
      if (i === 0 && h.size === 'capital') {
        const mast = add(new THREE.CylinderGeometry(L * 0.002, L * 0.003, th * 1.4, 4), mats.dark);
        mast.position.set(tw * 0.3, base + th * 1.8, zAt(t));
        const dish = add(new THREE.SphereGeometry(L * 0.012, 8, 4, 0, Math.PI * 2, 0, Math.PI / 3), mats.hull);
        dish.position.set(-tw * 0.3, base + th * 1.25, zAt(t));
        dish.rotation.x = -0.8;
      }
    }
  }

  // --- Wings.
  let wingSpan = 0;
  if (r.wings > 0) {
    const s = sec(0.55);
    wingSpan = W * r.wings * 1.5;
    for (const side of [-1, 1]) {
      const wing = add(wingGeometry(wingSpan, L * 0.32, L * 0.1, L * 0.2, Math.max(0.12, H * 0.08)), mats.hull);
      wing.position.set(side * s.w * 0.4, s.y - s.h * 0.15, zAt(0.42));
      wing.scale.x = side;
      const tip = add(new THREE.BoxGeometry(Math.max(0.15, L * 0.008), H * 0.35, L * 0.09), mats.accent);
      tip.position.set(side * (s.w * 0.4 + wingSpan), s.y, zAt(0.42) + L * 0.25);
    }
  }

  // --- Engine pods along the flanks.
  const podX = sec(0.75).w * 0.5 + W * 0.16;
  const podR = W * 0.2;
  if (r.pods) {
    for (const side of [-1, 1]) {
      const pod = add(
        loft(
          [
            { z: zAt(0.45), w: podR * 0.5, h: podR * 0.5, y: 0 },
            { z: zAt(0.55), w: podR * 1.6, h: podR * 1.5, y: 0 },
            { z: zAt(0.95), w: podR * 1.8, h: podR * 1.7, y: 0 },
            { z: zAt(1.03), w: podR * 1.5, h: podR * 1.4, y: 0 },
          ],
          pal.bevel,
        ),
        mats.dark,
      );
      pod.position.x = side * podX;
      const strut = add(new THREE.BoxGeometry(podX * 0.9, H * 0.12, L * 0.12), mats.hull);
      strut.position.set(side * podX * 0.55, 0, zAt(0.72));
    }
  }

  // --- Cargo modules (haulers).
  if (r.profile === 'hauler') {
    const containers: THREE.BufferGeometry[] = [];
    const colors = ['#c0392b', '#2f6db0', '#d9a441', '#3d8b5a', '#8a8f96'];
    const byColor = new Map<string, THREE.BufferGeometry[]>();
    for (let t = 0.2; t < 0.84; t += 0.075) {
      const s = sec(t);
      for (const side of [-1, 1])
        for (const level of [-1, 1]) {
          const g = new THREE.BoxGeometry(W * 0.32, s.h * 0.42, L * 0.065);
          g.translate(side * (s.w * 0.5 + W * 0.16), s.y + level * s.h * 0.23, zAt(t));
          const c = rng.pick(colors);
          if (!byColor.has(c)) byColor.set(c, []);
          byColor.get(c)!.push(g);
        }
    }
    for (const [c, geos] of byColor) {
      const mat = new THREE.MeshStandardMaterial({ color: c, metalness: 0.3, roughness: 0.7, flatShading: true });
      containers.push(...geos);
      add(mergeGeometries(geos), mat);
    }
  }

  // --- Greebles.
  const greebles: THREE.BufferGeometry[] = [];
  const nGreebles = Math.round(4 + L * 0.3);
  for (let i = 0; i < nGreebles; i++) {
    const t = rng.range(0.15, 0.95);
    const s = sec(t);
    const gw = rng.range(0.015, 0.045) * L;
    const g = new THREE.BoxGeometry(Math.min(gw, s.w * 0.25), rng.range(0.006, 0.02) * L, rng.range(0.02, 0.06) * L);
    const onTop = rng.next() < 0.7;
    if (onTop) g.translate(rng.range(-0.35, 0.35) * s.w, s.y + s.h * 0.5, zAt(t));
    else g.translate((rng.next() < 0.5 ? -1 : 1) * s.w * 0.5, s.y + rng.range(-0.2, 0.2) * s.h, zAt(t));
    greebles.push(g);
  }
  add(mergeGeometries(greebles), mats.dark);
  // Pirate hulls get mismatched patch plates.
  if (h.style === 'pirate') {
    const patches: THREE.BufferGeometry[] = [];
    for (let i = 0; i < Math.round(L * 0.25); i++) {
      const t = rng.range(0.1, 0.9);
      const s = sec(t);
      const g = new THREE.BoxGeometry(rng.range(0.04, 0.1) * L, L * 0.006, rng.range(0.04, 0.12) * L);
      g.translate(rng.range(-0.3, 0.3) * s.w, s.y + s.h * 0.5 + L * 0.002, zAt(t));
      patches.push(g);
    }
    add(mergeGeometries(patches), mats.patch);
  }

  // --- Engines and plumes.
  const plumeGeo = new THREE.PlaneGeometry(1, 1, 1, 1);
  plumeGeo.translate(0, -0.5, 0);
  plumeGeo.rotateX(Math.PI / 2);
  const plumes: THREE.Mesh[] = [];
  const nozzles: [number, number, number][] = [];
  const stern = sec(1);
  const nozzleR = Math.max(0.35, L * 0.032);
  if (r.pods) for (const side of [-1, 1]) nozzles.push([side * podX, 0, podR * 0.85]);
  const centre = Math.max(0, r.engines - (r.pods ? 2 : 0));
  for (let i = 0; i < centre; i++) {
    const x = centre === 1 ? 0 : (i / (centre - 1) - 0.5) * stern.w * 0.62;
    nozzles.push([x, stern.y, Math.min(nozzleR, stern.w / (centre + 1))]);
  }
  for (const [x, y, nr] of nozzles) {
    const zEnd = r.pods && Math.abs(x) === podX ? zAt(1.03) : zAt(1);
    const bell = add(new THREE.CylinderGeometry(nr * 0.85, nr, nr * 0.8, 8, 1, true).rotateX(Math.PI / 2), mats.dark);
    bell.position.set(x, y, zEnd + nr * 0.3);
    const glow = add(new THREE.CircleGeometry(nr * 0.82, 10), mats.engine);
    glow.position.set(x, y, zEnd + nr * 0.25);
    for (const rot of [0, Math.PI / 2]) {
      const plume = new THREE.Mesh(plumeGeo, mats.plume);
      plume.position.set(x, y, zEnd + nr * 0.3);
      plume.rotation.z = rot;
      plume.userData.len = nr * 8;
      plume.scale.set(nr * 1.9, 1, nr * 8);
      body.add(plume);
      plumes.push(plume);
    }
  }

  // --- Navigation lights.
  const navLights: { mesh: THREE.Mesh; phase: number; strobe: boolean }[] = [];
  const lightGeo = new THREE.SphereGeometry(Math.max(0.12, L * 0.006), 6, 4);
  const addLight = (color: string, x: number, y: number, z: number, strobe: boolean, phase: number) => {
    const m = new THREE.Mesh(lightGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(8) }));
    m.position.set(x, y, z);
    body.add(m);
    navLights.push({ mesh: m, phase, strobe });
  };
  const span = wingSpan > 0 ? sec(0.55).w * 0.4 + wingSpan : r.pods ? podX + podR : sec(0.6).w * 0.5;
  const lightZ = wingSpan > 0 ? zAt(0.42) + L * 0.25 : zAt(0.7);
  addLight('#ff2020', -span - 0.1, 0, lightZ, false, 0);
  addLight('#20ff40', span + 0.1, 0, lightZ, false, 0);
  addLight('#ffffff', 0, sec(0.9).y + sec(0.9).h * 0.5 + 0.2, zAt(0.92), true, 0.3);
  addLight('#ffffff', 0, -sec(0.1).h * 0.5, zAt(0.05), true, 0.55);

  // --- Weapon mounts at the slots.
  const k = THREE.MathUtils.clamp(Math.pow(L / 24, 0.45), 1, 3.5);
  const mounts = new Map<string, Mount>();
  const slotPos = new Map<string, THREE.Vector3>();
  for (const slot of h.slots) {
    const s = sec(slot.t);
    const z = zAt(slot.t);
    let pos!: THREE.Vector3;
    let ventral = false;
    let sponson = 0;
    const onWing = slot.zone === 'wing' && wingSpan > 0;
    if (slot.zone === 'nose') pos = new THREE.Vector3(slot.side * s.w * 0.28, s.y + s.h * 0.2, z);
    else if (slot.zone === 'dorsal') pos = new THREE.Vector3(slot.side * s.w * 0.24, s.y + s.h * 0.5, z);
    else if (slot.zone === 'ventral') {
      pos = new THREE.Vector3(slot.side * s.w * 0.24, s.y - s.h * 0.5, z);
      ventral = true;
    } else if (onWing) {
      const ws = sec(0.55);
      pos = new THREE.Vector3(slot.side * (ws.w * 0.4 + wingSpan * 0.55), ws.y - ws.h * 0.15 + Math.max(0.12, H * 0.08), z);
    } else {
      // Flank (or wing on a wingless hull): a small sponson sticking out of the side.
      sponson = SLOT_SCALE[slot.size] * k * 0.9;
      pos = new THREE.Vector3(slot.side * (s.w * 0.5 + sponson * 0.6), s.y + s.h * 0.1, z);
    }
    if (sponson > 0) {
      const sp = add(new THREE.BoxGeometry(sponson * 1.6, sponson * 0.45, sponson * 1.8), mats.dark);
      sp.position.set(pos.x - slot.side * sponson * 0.4, pos.y - sponson * 0.25, pos.z);
    }
    slotPos.set(slot.id, pos.clone());
    const mroot = new THREE.Group();
    mroot.position.copy(pos);
    // Face the slot's direction; ventral mounts hang upside down (flip first, then yaw).
    mroot.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(slot.angle));
    if (ventral) mroot.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI));
    const yaw = new THREE.Group();
    mroot.add(yaw);
    body.add(mroot);
    const rad = SLOT_SCALE[slot.size] * k;
    const wid = loadout.weapons[slot.id];
    const w = wid ? weaponDef(wid) : null;
    if (slot.mount === 'turret' && (w || opts.showEmptySlots)) {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.75, rad * 0.85, rad * 0.3, 10), mats.dark);
      base.position.y = rad * 0.1;
      mroot.add(base);
    }
    if (w) yaw.add(weaponModel(w, rad, mats, slot.mount === 'turret'));
    else if (opts.showEmptySlots) {
      const hatch = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.55, rad * 0.55, rad * 0.12, slot.mount === 'turret' ? 10 : 4), mats.patch);
      hatch.position.y = rad * 0.22;
      yaw.add(hatch);
    }
    mounts.set(slot.id, { slot, root: mroot, yaw, weapon: w });
  }

  // Bounding radius.
  const box = new THREE.Box3().setFromObject(body);
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.frustumCulled = false;
  });

  let smoothThrottle = 0;
  const glowColor = new THREE.Color(pal.glow);
  const scColor = new THREE.Color('#b48cff');
  const tmp = new THREE.Vector3();
  const qInv = new THREE.Quaternion();
  return {
    root,
    body,
    hull: h,
    length: L,
    radius,
    mounts,
    update(dt, time, throttle, boost, supercruise, bank, pitchLean) {
      smoothThrottle += (Math.max(throttle, supercruise) - smoothThrottle) * (1 - Math.exp(-dt * 5));
      const power = smoothThrottle * (boost ? 1.6 : 1) + supercruise * 0.6;
      mats.plume.uniforms.uTime.value = time;
      mats.plume.uniforms.uIntensity.value = 0.25 + power * 1.4;
      (mats.plume.uniforms.uColor.value as THREE.Color).copy(glowColor).lerp(scColor, supercruise).multiplyScalar(3);
      for (const p of plumes) p.scale.z = (p.userData.len as number) * (0.35 + power * 1.3);
      mats.engine.color.copy(glowColor).multiplyScalar(3 + power * 6);
      for (const l of navLights) l.mesh.visible = l.strobe ? (time + l.phase) % 1.4 < 0.08 : true;
      body.rotation.z += (bank - body.rotation.z) * (1 - Math.exp(-dt * 4));
      body.rotation.x += (pitchLean - body.rotation.x) * (1 - Math.exp(-dt * 4));
    },
    aimTurrets(localDir, dt) {
      const kk = 1 - Math.exp(-dt * 4);
      for (const m of mounts.values()) {
        if (m.slot.mount !== 'turret' || !m.weapon) continue;
        let target = 0;
        if (localDir) {
          // Direction in the mount's frame, then yaw about its up axis, clamped to the arc.
          qInv.copy(m.root.quaternion).invert();
          tmp.copy(localDir).applyQuaternion(qInv);
          const yaw = Math.atan2(-tmp.x, -tmp.z);
          const half = THREE.MathUtils.degToRad(m.slot.arc / 2);
          target = m.slot.arc >= 360 ? yaw : THREE.MathUtils.clamp(yaw, -half, half);
        }
        m.yaw.rotation.y += (target - m.yaw.rotation.y) * kk;
      }
    },
    slotPosition(slotId, out = new THREE.Vector3()) {
      return out.copy(slotPos.get(slotId) ?? new THREE.Vector3());
    },
    dispose() {
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
      });
      for (const m of Object.values(mats)) (m as THREE.Material).dispose();
    },
  };
}
