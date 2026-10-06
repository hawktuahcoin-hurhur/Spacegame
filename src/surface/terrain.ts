import * as THREE from 'three';
import { Noise2, hash2 } from './noise';
import type { SurfaceProfile } from './profile';

const _c = new THREE.Color();
const _c2 = new THREE.Color();

/**
 * Heightfield for one landing site. Coordinates are metres on a local flat
 * patch (planets are small enough that curvature doesn't matter on foot);
 * the site's longitude/latitude offset the noise so every spot on a planet
 * is different and revisiting one gives the same ground.
 */
export class Terrain {
  private readonly n: Noise2;
  private readonly d: Noise2;
  private readonly m: Noise2;
  readonly minH: number;
  readonly maxH: number;
  /** Sea surface height (m), or null on dry worlds. */
  readonly seaLevel: number | null;

  constructor(
    readonly profile: SurfaceProfile,
    readonly ox: number,
    readonly oz: number,
  ) {
    this.n = new Noise2(profile.seed);
    this.d = new Noise2(profile.seed ^ 0x51ed);
    this.m = new Noise2(profile.seed ^ 0x3c6e);
    this.minH = -profile.relief * 0.55;
    this.maxH = profile.relief * 1.15;
    if (profile.seaFraction > 0) {
      let sea = this.minH + (this.maxH - this.minH) * profile.seaFraction;
      // Always land on dry ground.
      sea = Math.min(sea, this.rawHeight(0, 0) - 5);
      this.seaLevel = sea;
    } else this.seaLevel = null;
  }

  private rawHeight(x: number, z: number): number {
    const p = this.profile;
    const u = (x + this.ox) / 1000;
    const v = (z + this.oz) / 1000;
    const wx = this.n.fbm(u * 0.8 + 5.2, v * 0.8 - 1.3, 3) * 0.35 * p.roughness;
    const wz = this.n.fbm(u * 0.8 - 7.1, v * 0.8 + 2.9, 3) * 0.35 * p.roughness;
    const continent = this.n.fbm(u * 0.35, v * 0.35, 4);
    let h = continent * p.relief * 0.45;
    h += this.n.fbm((u + wx) * 2.2, (v + wz) * 2.2, 5) * p.relief * 0.3;
    const mountainMask = smooth(-0.15, 0.45, continent + wx * 0.5);
    h += Math.pow(this.n.ridged(u * 1.3 + wx, v * 1.3 + wz, 5), 1.7) * p.relief * (0.4 + p.ridge) * mountainMask;
    h += this.d.fbm(u * 16, v * 16, 3) * 2.2;
    if (p.craters > 0) h += this.craters(x + this.ox, z + this.oz);
    return h;
  }

  private craters(x: number, z: number): number {
    const cell = 260;
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    let h = 0;
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const gx = cx + i;
        const gz = cz + j;
        if (hash2(gx, gz, this.profile.seed) > this.profile.craters * 0.5) continue;
        const px = (gx + hash2(gx, gz, 11)) * cell;
        const pz = (gz + hash2(gx, gz, 13)) * cell;
        const r = 18 + hash2(gx, gz, 17) * 90;
        const d = Math.hypot(x - px, z - pz) / r;
        const depth = r * 0.28;
        if (d < 1) h += (d * d - 1) * depth;
        h += Math.exp(-(((d - 1) / 0.2) ** 2)) * depth * 0.4;
      }
    return h;
  }

  height(x: number, z: number): number {
    return this.rawHeight(x, z);
  }

  /** Ground height or sea surface, whichever is higher (for walking and props). */
  surfaceHeight(x: number, z: number): number {
    const h = this.height(x, z);
    return this.seaLevel !== null && h < this.seaLevel ? this.seaLevel : h;
  }

  normal(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const e = 1.5;
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  /** Is this spot under water? */
  wet(h: number): boolean {
    return this.seaLevel !== null && h < this.seaLevel + 0.6;
  }

  /** Biome colour for a point. `slope` is the normal's y. */
  color(x: number, z: number, h: number, slope: number, out: THREE.Color): THREE.Color {
    const p = this.profile;
    const r = p.ramp;
    const f = (h - this.minH) / (this.maxH - this.minH);
    const sea = this.seaLevel;
    if (sea !== null && h < sea + 1.8) {
      if (h >= sea - 0.5) return out.copy(r.beach);
      const depth = Math.min(1, (sea - h) / 25);
      return out.copy(r.shallow).lerp(r.deep, depth).lerp(r.beach, 0.25 * (1 - depth));
    }
    const moist = this.m.fbm((x + this.ox) / 700, (z + this.oz) / 700, 3) * 0.5 + 0.5;
    out.copy(r.low).lerp(r.lowAlt, smooth(0.25, 0.75, moist));
    out.lerp(_c.copy(r.high), smooth(0.55, 0.78, f));
    out.lerp(_c.copy(r.peak), smooth(0.8, 0.95, f));
    // Steep ground is bare rock.
    out.lerp(_c.copy(r.high).multiplyScalar(0.85), smooth(0.74, 0.52, slope));
    if (f > p.snowLine) out.lerp(_c2.copy(r.snow), smooth(p.snowLine, p.snowLine + 0.08, f) * smooth(0.6, 0.8, slope));
    return out;
  }

  /**
   * Flat-shaded low-poly chunk: `res` quads per side, non-indexed so each
   * triangle gets its own colour, with skirts hiding cracks between LODs.
   */
  buildChunk(x0: number, z0: number, size: number, res: number): THREE.BufferGeometry {
    const step = size / res;
    const n = res + 1;
    const hs = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) hs[j * n + i] = this.height(x0 + i * step, z0 + j * step);
    const tris = res * res * 2 + res * 4 * 2;
    const pos = new Float32Array(tris * 9);
    const colr = new Float32Array(tris * 9);
    let k = 0;
    const tri = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, skirt = false) => {
      pos.set([ax, ay, az, bx, by, bz, cx, cy, cz], k * 9);
      // Face normal for slope; colour from the face centre.
      const ux = bx - ax;
      const uy = by - ay;
      const uz = bz - az;
      const vx = cx - ax;
      const vy = cy - ay;
      const vz = cz - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const slope = Math.abs(ny) / Math.max(1e-6, Math.hypot(nx, ny, nz));
      const mx = (ax + bx + cx) / 3;
      const my = (ay + by + cy) / 3;
      const mz = (az + bz + cz) / 3;
      this.color(x0 + mx, z0 + mz, skirt ? Math.max(ay, by, cy) : my, skirt ? 1 : slope, _c);
      // Facet jitter for the low-poly look.
      const jit = 0.94 + hash2(Math.floor((x0 + mx) * 3), Math.floor((z0 + mz) * 3), 7) * 0.12;
      for (let v = 0; v < 3; v++) colr.set([_c.r * jit, _c.g * jit, _c.b * jit], k * 9 + v * 3);
      k++;
    };
    for (let j = 0; j < res; j++)
      for (let i = 0; i < res; i++) {
        const a = hs[j * n + i];
        const b = hs[j * n + i + 1];
        const c = hs[(j + 1) * n + i];
        const d = hs[(j + 1) * n + i + 1];
        const x = i * step;
        const z = j * step;
        // Alternate the diagonal for a less regular look.
        if ((i + j) % 2) {
          tri(x, a, z, x, c, z + step, x + step, b, z);
          tri(x + step, b, z, x, c, z + step, x + step, d, z + step);
        } else {
          tri(x, a, z, x + step, d, z + step, x + step, b, z);
          tri(x, a, z, x, c, z + step, x + step, d, z + step);
        }
      }
    // Skirts: vertical strips down from every edge.
    const drop = 25;
    for (let i = 0; i < res; i++) {
      const edges: [number, number, number, number, number, number][] = [
        [i * step, 0, hs[i], (i + 1) * step, 0, hs[i + 1]],
        [(i + 1) * step, size, hs[res * n + i + 1], i * step, size, hs[res * n + i]],
        [0, (i + 1) * step, hs[(i + 1) * n], 0, i * step, hs[i * n]],
        [size, i * step, hs[i * n + res], size, (i + 1) * step, hs[(i + 1) * n + res]],
      ];
      for (const [ax, az, ah, bx, bz, bh] of edges) {
        tri(ax, ah, az, bx, bh, bz, ax, ah - drop, az, true);
        tri(bx, bh, bz, bx, bh - drop, bz, ax, ah - drop, az, true);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colr, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }
}

export function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
