import { Rng } from '../core/rng';

/** Seeded 2D simplex noise (Gustavson), plus the fractal helpers terrain needs. */
export class Noise2 {
  private readonly perm = new Uint8Array(512);
  private readonly gx = new Float32Array(12);
  private readonly gy = new Float32Array(12);

  constructor(seed: number) {
    const rng = new Rng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      this.gx[i] = Math.cos(a);
      this.gy[i] = Math.sin(a);
    }
  }

  /** Simplex noise in roughly [-1, 1]. */
  noise(x: number, y: number): number {
    const F2 = 0.5 * (Math.sqrt(3) - 1);
    const G2 = (3 - Math.sqrt(3)) / 6;
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = 1 - i1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    const p = this.perm;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = p[ii + p[jj]] % 12;
      t0 *= t0;
      n += t0 * t0 * (this.gx[g] * x0 + this.gy[g] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = p[ii + i1 + p[jj + j1]] % 12;
      t1 *= t1;
      n += t1 * t1 * (this.gx[g] * x1 + this.gy[g] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = p[ii + 1 + p[jj + 1]] % 12;
      t2 *= t2;
      n += t2 * t2 * (this.gx[g] * x2 + this.gy[g] * y2);
    }
    return 70 * n;
  }

  fbm(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x, y);
      norm += amp;
      amp *= gain;
      x *= lacunarity;
      y *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal in [0, 1]: sharp crests for mountain ranges. */
  ridged(x: number, y: number, octaves: number): number {
    let sum = 0;
    let amp = 0.5;
    let weight = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      let n = 1 - Math.abs(this.noise(x, y));
      n *= n * weight;
      weight = Math.min(1, n * 2);
      sum += n * amp;
      norm += amp;
      amp *= 0.5;
      x *= 2.1;
      y *= 2.1;
    }
    return sum / norm;
  }
}

/** Fast deterministic hash of integer cell coordinates to [0, 1). */
export function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
