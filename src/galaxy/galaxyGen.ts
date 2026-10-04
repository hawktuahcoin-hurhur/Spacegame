import { Rng } from '../core/rng';
import { hsl } from '../planets/planetTypes';
import { generateName } from './names';
import { generateSystem, systemHeader } from './systemGen';
import type { RGB, SpectralClass } from './types';

/**
 * Galaxy-scale data. Units are light-years; the galactic plane is XZ and the
 * galactic centre is the origin. System-space axes are aligned with galaxy
 * axes, so a direction between two stars is the same in both spaces.
 */

export type Region = 'core' | 'frontier' | 'fringe';

export interface GalaxyStar {
  index: number;
  name: string;
  /** Seed for `generateSystem`. */
  seed: number;
  x: number;
  y: number;
  z: number;
  spectralClass: SpectralClass;
  temperature: number;
  luminosity: number;
  color: RGB;
  region: Region;
  /** Index into `nebulae`, or -1. */
  nebula: number;
}

export interface Nebula {
  x: number;
  y: number;
  z: number;
  radius: number;
  color: RGB;
  hue: number;
  name: string;
}

export interface GalaxyShape {
  radius: number;
  arms: number;
  /** Spiral tightness: angle = armOffset + twist * ln(1 + r / scale). */
  twist: number;
  scale: number;
  rotation: number;
  bulgeRadius: number;
}

export interface GalaxyDef {
  seed: number;
  name: string;
  shape: GalaxyShape;
  stars: GalaxyStar[];
  nebulae: Nebula[];
  /** A good first system: frontier, has a station and a living world, well connected. */
  startIndex: number;
}

export const GALAXY_STAR_COUNT = 650;
export const MIN_STAR_SPACING = 3.2;
/** Longest hyperjump any ship can make (ly). Used for connectivity guarantees. */
export const MAX_JUMP_RANGE = 14;

function gauss(rng: Rng): number {
  // Box–Muller.
  const u = Math.max(rng.next(), 1e-9);
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Angle of spiral arm `arm` at radius r. Shared with the galaxy-map disc shader. */
export function armAngle(shape: GalaxyShape, arm: number, r: number): number {
  return shape.rotation + (arm * 2 * Math.PI) / shape.arms + shape.twist * Math.log(1 + r / shape.scale);
}

class SpatialHash {
  private readonly cells = new Map<string, number[]>();
  constructor(private readonly size: number) {}
  private key(x: number, z: number): string {
    return `${Math.floor(x / this.size)},${Math.floor(z / this.size)}`;
  }
  add(i: number, x: number, z: number): void {
    const k = this.key(x, z);
    const c = this.cells.get(k);
    if (c) c.push(i);
    else this.cells.set(k, [i]);
  }
  /** Indices in cells overlapping a square of half-size r. */
  query(x: number, z: number, r: number, out: number[] = []): number[] {
    const x0 = Math.floor((x - r) / this.size);
    const x1 = Math.floor((x + r) / this.size);
    const z0 = Math.floor((z - r) / this.size);
    const z1 = Math.floor((z + r) / this.size);
    for (let cx = x0; cx <= x1; cx++)
      for (let cz = z0; cz <= z1; cz++) {
        const c = this.cells.get(`${cx},${cz}`);
        if (c) out.push(...c);
      }
    return out;
  }
}

export function starDistance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Connected components of the jump graph for a given range. Returns component id per star. */
export function jumpComponents(stars: GalaxyStar[], range: number): number[] {
  const hash = new SpatialHash(range);
  stars.forEach((s) => hash.add(s.index, s.x, s.z));
  const comp = new Array(stars.length).fill(-1);
  let id = 0;
  const near: number[] = [];
  for (const s of stars) {
    if (comp[s.index] >= 0) continue;
    const stack = [s.index];
    comp[s.index] = id;
    while (stack.length) {
      const i = stack.pop()!;
      const a = stars[i];
      near.length = 0;
      for (const j of hash.query(a.x, a.z, range, near)) {
        if (comp[j] < 0 && starDistance(a, stars[j]) <= range) {
          comp[j] = id;
          stack.push(j);
        }
      }
    }
    id++;
  }
  return comp;
}

/** Distance used when stitching components together; below the smallest ship jump range. */
const BRIDGE_HOP = 9;
const BRIDGE_MAX_GAP = 32;

/**
 * Stitch isolated clusters to the main body with lonely "void" stars spaced
 * a jump apart, so the galaxy is one network for any reasonable drive.
 * Gaps wider than BRIDGE_MAX_GAP stay open: remote outliers are a feature.
 */
function bridgeGaps(pts: { x: number; y: number; z: number }[], rng: Rng): void {
  for (let iter = 0; iter < 200; iter++) {
    const asStars = pts.map((p, index) => ({ ...p, index }) as unknown as GalaxyStar);
    const comp = jumpComponents(asStars, BRIDGE_HOP + 0.5);
    const sizes = new Map<number, number>();
    comp.forEach((c) => sizes.set(c, (sizes.get(c) ?? 0) + 1));
    const main = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0][0];
    // Closest pair between the main component and any other component.
    let best: { a: number; b: number; d: number } | null = null;
    for (let i = 0; i < pts.length; i++) {
      if (comp[i] === main) continue;
      for (let j = 0; j < pts.length; j++) {
        if (comp[j] !== main) continue;
        const d = starDistance(pts[i], pts[j]);
        if (d <= BRIDGE_MAX_GAP && (!best || d < best.d)) best = { a: j, b: i, d };
      }
    }
    if (!best) return;
    const a = pts[best.a];
    const b = pts[best.b];
    const steps = Math.ceil(best.d / BRIDGE_HOP);
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      pts.push({
        x: a.x + (b.x - a.x) * t + rng.range(-1, 1),
        y: a.y + (b.y - a.y) * t + rng.range(-0.5, 0.5),
        z: a.z + (b.z - a.z) * t + rng.range(-1, 1),
      });
    }
  }
}

export function generateGalaxy(seed: number, count = GALAXY_STAR_COUNT): GalaxyDef {
  const rng = new Rng(seed);
  const shape: GalaxyShape = {
    radius: 150,
    arms: rng.int(2, 4),
    twist: rng.range(2.2, 3.4) * (rng.next() < 0.5 ? 1 : -1),
    scale: rng.range(18, 30),
    rotation: rng.range(0, Math.PI * 2),
    bulgeRadius: rng.range(18, 26),
  };
  const name = `The ${generateName(rng, 2, 3)} ${rng.pick(['Expanse', 'Spiral', 'Reach', 'Cluster', 'Drift', 'Veil'])}`;

  // --- Star positions: bulge + spiral arms + a sprinkling of disc field stars.
  type P = { x: number; y: number; z: number };
  const pts: P[] = [];
  const hash = new SpatialHash(MIN_STAR_SPACING * 2);
  const near: number[] = [];
  let attempts = 0;
  // Leave headroom for the bridge stars added below.
  const primary = Math.round(count * 0.88);
  while (pts.length < primary && attempts < count * 60) {
    attempts++;
    const roll = rng.next();
    let x: number, z: number, y: number;
    if (roll < 0.16) {
      const r = Math.abs(gauss(rng)) * shape.bulgeRadius * 0.55;
      const a = rng.range(0, Math.PI * 2);
      x = Math.cos(a) * r;
      z = Math.sin(a) * r;
      y = gauss(rng) * 5;
    } else if (roll < 0.86) {
      const arm = rng.int(0, shape.arms - 1);
      const r = shape.bulgeRadius * 0.6 + Math.pow(rng.next(), 0.85) * (shape.radius - shape.bulgeRadius * 0.6);
      const spread = 0.22 + 0.12 * (r / shape.radius);
      const a = armAngle(shape, arm, r) + gauss(rng) * spread;
      x = Math.cos(a) * r + gauss(rng) * 2;
      z = Math.sin(a) * r + gauss(rng) * 2;
      y = gauss(rng) * 2.2;
    } else {
      const r = Math.sqrt(rng.next()) * shape.radius;
      const a = rng.range(0, Math.PI * 2);
      x = Math.cos(a) * r;
      z = Math.sin(a) * r;
      y = gauss(rng) * 2.5;
    }
    if (Math.hypot(x, z) > shape.radius * 1.05) continue;
    near.length = 0;
    let ok = true;
    for (const j of hash.query(x, z, MIN_STAR_SPACING, near)) {
      if (Math.hypot(pts[j].x - x, pts[j].y - y, pts[j].z - z) < MIN_STAR_SPACING) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    hash.add(pts.length, x, z);
    pts.push({ x, y, z });
  }

  bridgeGaps(pts, rng);

  // --- Nebulae sit along the arms.
  const nebulae: Nebula[] = [];
  const nebCount = rng.int(6, 10);
  for (let i = 0; i < nebCount; i++) {
    const arm = rng.int(0, shape.arms - 1);
    const r = rng.range(shape.bulgeRadius * 1.3, shape.radius * 0.9);
    const a = armAngle(shape, arm, r) + gauss(rng) * 0.1;
    const hue = rng.pick([200, 280, 320, 10, 160, 40]) + rng.range(-15, 15);
    nebulae.push({
      x: Math.cos(a) * r,
      y: gauss(rng) * 1.5,
      z: Math.sin(a) * r,
      radius: rng.range(7, 16),
      color: hsl(hue, 0.75, 0.55),
      hue,
      name: `${generateName(rng, 2, 2)} Nebula`,
    });
  }

  // --- Stars: identity comes from each system's own seed header.
  const stars: GalaxyStar[] = pts.map((p, index) => {
    const sysSeed = Rng.derive(seed, index);
    const { name: sysName, star } = systemHeader(sysSeed);
    const r = Math.hypot(p.x, p.z) / shape.radius;
    let nebula = -1;
    let best = Infinity;
    nebulae.forEach((n, ni) => {
      const d = starDistance(p, n) / n.radius;
      if (d < 1 && d < best) {
        best = d;
        nebula = ni;
      }
    });
    return {
      index,
      name: sysName,
      seed: sysSeed,
      x: p.x,
      y: p.y,
      z: p.z,
      spectralClass: star.spectralClass,
      temperature: star.temperature,
      luminosity: star.luminosity,
      color: star.color,
      region: r < 0.28 ? 'core' : r < 0.72 ? 'frontier' : 'fringe',
      nebula,
    };
  });

  // --- Start system: a well-connected frontier system with a station and a living world.
  const comp = jumpComponents(stars, 10);
  const sizes = new Map<number, number>();
  comp.forEach((c) => sizes.set(c, (sizes.get(c) ?? 0) + 1));
  const mainComp = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const startAngle = rng.range(0, Math.PI * 2);
  // Prefer a busy neighbourhood: plenty of systems within a first jump.
  const neighbours = (s: GalaxyStar) => stars.filter((o) => o !== s && starDistance(o, s) <= 10).length;
  const candidates = stars
    .filter((s) => s.region === 'frontier' && comp[s.index] === mainComp && s.spectralClass !== 'O' && s.spectralClass !== 'B' && neighbours(s) >= 5)
    .sort((a, b) => {
      const da = Math.abs(Math.atan2(a.z, a.x) - startAngle);
      const db = Math.abs(Math.atan2(b.z, b.x) - startAngle);
      return da - db;
    });
  let startIndex = candidates[0]?.index ?? 0;
  for (const c of candidates.slice(0, 60)) {
    const sys = generateSystem(c.seed);
    if (sys.stations.length && sys.bodies.some((b) => b.type === 'terran' || b.type === 'ocean')) {
      startIndex = c.index;
      break;
    }
  }

  return { seed, name, shape, stars, nebulae, startIndex };
}
