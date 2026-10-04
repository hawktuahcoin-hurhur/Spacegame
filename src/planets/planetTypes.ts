import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { AtmosphereDef, PlanetType, RGB, RingDef, SpectralClass, SurfaceDef } from '../galaxy/types';

const _c = new THREE.Color();

/** HSL (h in degrees, s/l in 0..1, sRGB-space) to linear RGB. */
export function hsl(h: number, s: number, l: number): RGB {
  _c.setHSL((((h % 360) + 360) % 360) / 360, THREE.MathUtils.clamp(s, 0, 1), THREE.MathUtils.clamp(l, 0, 1));
  return [_c.r, _c.g, _c.b];
}

export function scaleRGB(c: RGB, k: number): RGB {
  return [c[0] * k, c[1] * k, c[2] * k];
}

/** Approximate blackbody colour (Tanner Helland fit), returned as normalised linear RGB. */
export function blackbody(kelvin: number): RGB {
  const t = kelvin / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  _c.setRGB(
    THREE.MathUtils.clamp(r, 0, 255) / 255,
    THREE.MathUtils.clamp(g, 0, 255) / 255,
    THREE.MathUtils.clamp(b, 0, 255) / 255,
    THREE.SRGBColorSpace,
  );
  const m = Math.max(_c.r, _c.g, _c.b);
  return [_c.r / m, _c.g / m, _c.b / m];
}

export interface SpectralInfo {
  temperature: [number, number];
  radius: [number, number];
  luminosity: number;
  weight: number;
}

/** Gameplay-compressed stellar classes (radii in metres). */
export const SPECTRAL: Record<SpectralClass, SpectralInfo> = {
  O: { temperature: [30000, 40000], radius: [2.0e6, 2.4e6], luminosity: 9, weight: 0.02 },
  B: { temperature: [11000, 25000], radius: [1.4e6, 1.8e6], luminosity: 6, weight: 0.05 },
  A: { temperature: [7600, 9800], radius: [1.0e6, 1.2e6], luminosity: 3.5, weight: 0.1 },
  F: { temperature: [6100, 7400], radius: [7.5e5, 9.0e5], luminosity: 1.8, weight: 0.18 },
  G: { temperature: [5300, 6000], radius: [5.5e5, 6.8e5], luminosity: 1, weight: 0.25 },
  K: { temperature: [3900, 5200], radius: [4.0e5, 5.0e5], luminosity: 0.45, weight: 0.22 },
  M: { temperature: [2600, 3800], radius: [2.4e5, 3.2e5], luminosity: 0.12, weight: 0.18 },
};

export const PLANET_TYPE_LABEL: Record<PlanetType, string> = {
  barren: 'Barren',
  lava: 'Volcanic',
  desert: 'Desert',
  terran: 'Terran',
  ocean: 'Oceanic',
  ice: 'Frozen',
  toxic: 'Toxic',
  exotic: 'Exotic',
  gasGiant: 'Gas Giant',
};

/** Radius range in metres per type (rocky worlds are compressed for gameplay). */
export const RADIUS_RANGE: Record<PlanetType, [number, number]> = {
  barren: [1.2e4, 3.0e4],
  lava: [1.5e4, 3.4e4],
  desert: [2.0e4, 4.4e4],
  terran: [2.6e4, 5.0e4],
  ocean: [2.6e4, 5.4e4],
  ice: [1.5e4, 4.0e4],
  toxic: [2.0e4, 4.4e4],
  exotic: [1.8e4, 4.0e4],
  gasGiant: [1.2e5, 2.6e5],
};

function baseSurface(): SurfaceDef {
  const grey: RGB = [0.2, 0.2, 0.2];
  return {
    seaLevel: -1,
    oceanKind: 'none',
    deep: grey,
    shallow: grey,
    beach: grey,
    low: grey,
    lowAlt: grey,
    high: grey,
    peak: grey,
    snow: [0.9, 0.93, 1.0],
    continentFreq: 1.2,
    mountainAmp: 0.5,
    ridgeAmp: 0.4,
    craterAmp: 0,
    warp: 0.4,
    bump: 1,
    iceCap: 0,
    cloudCover: 0,
    cloudColor: [1, 1, 1],
    bandFreq: 0,
    bandTurbulence: 0,
    storms: 0,
  };
}

/** Procedural biome palette + terrain parameters per world type. Vivid NMS-style colours. */
export function makeSurface(type: PlanetType, rng: Rng, temperature: number): SurfaceDef {
  const s = baseSurface();
  const j = (n: number) => rng.range(-n, n);
  switch (type) {
    case 'terran': {
      // Mostly green worlds, but alien flora hues are common.
      const flora = rng.next() < 0.6 ? rng.range(85, 135) : rng.pick([160, 45, 285, 330, 20, 190]) + j(12);
      const sea = rng.range(195, 228);
      s.seaLevel = rng.range(0.44, 0.58);
      s.oceanKind = 'water';
      s.deep = hsl(sea, 0.75, 0.13);
      s.shallow = hsl(sea - rng.range(15, 30), 0.7, 0.32);
      s.beach = hsl(rng.range(35, 48), 0.45, 0.62);
      s.low = hsl(flora, rng.range(0.5, 0.7), rng.range(0.26, 0.34));
      s.lowAlt = hsl(flora + rng.range(15, 45), rng.range(0.45, 0.65), rng.range(0.33, 0.42));
      s.high = hsl(rng.range(18, 34), 0.28, 0.32);
      s.peak = hsl(rng.range(20, 40), 0.1, 0.5);
      s.continentFreq = rng.range(0.9, 1.6);
      s.mountainAmp = rng.range(0.45, 0.75);
      s.ridgeAmp = rng.range(0.35, 0.6);
      s.warp = rng.range(0.3, 0.7);
      s.iceCap = rng.range(0.12, 0.3) * THREE.MathUtils.clamp((320 - temperature) / 60, 0.3, 1.5);
      s.cloudCover = rng.range(0.34, 0.52);
      s.bump = rng.range(0.9, 1.3);
      break;
    }
    case 'ocean': {
      const sea = rng.range(180, 215);
      const flora = rng.range(70, 160);
      s.seaLevel = rng.range(0.66, 0.76);
      s.oceanKind = 'water';
      s.deep = hsl(sea + 15, 0.8, 0.12);
      s.shallow = hsl(sea - 15, 0.75, 0.42);
      s.beach = hsl(rng.range(40, 50), 0.5, 0.7);
      s.low = hsl(flora, 0.6, 0.32);
      s.lowAlt = hsl(flora + 25, 0.55, 0.38);
      s.high = hsl(25, 0.25, 0.35);
      s.peak = hsl(30, 0.08, 0.6);
      s.continentFreq = rng.range(1.4, 2.2);
      s.mountainAmp = rng.range(0.4, 0.7);
      s.iceCap = rng.range(0.08, 0.22);
      s.cloudCover = rng.range(0.42, 0.58);
      break;
    }
    case 'desert': {
      const variant = rng.int(0, 2);
      const h = variant === 0 ? rng.range(28, 42) : variant === 1 ? rng.range(8, 20) : rng.range(40, 55);
      const sat = variant === 2 ? 0.25 : rng.range(0.45, 0.65);
      const lum = variant === 2 ? 0.66 : rng.range(0.4, 0.5);
      s.low = hsl(h, sat, lum);
      s.lowAlt = hsl(h - 8, sat + 0.05, lum - 0.08);
      s.beach = hsl(h + 6, sat * 0.6, lum + 0.12);
      s.high = hsl(h - 12, sat * 0.8, lum * 0.6);
      s.peak = hsl(h, sat * 0.4, lum * 0.9);
      s.snow = hsl(h + 10, 0.2, 0.85);
      s.ridgeAmp = rng.range(0.6, 0.9);
      s.mountainAmp = rng.range(0.35, 0.6);
      s.craterAmp = rng.range(0, 0.3);
      s.warp = rng.range(0.5, 0.9);
      s.cloudCover = rng.range(0.02, 0.14);
      s.cloudColor = hsl(h, 0.3, 0.85);
      s.iceCap = temperature < 260 ? rng.range(0.05, 0.15) : 0;
      break;
    }
    case 'barren': {
      const h = rng.range(0, 360);
      const sat = rng.range(0.03, 0.15);
      const lum = rng.range(0.28, 0.45);
      s.low = hsl(h, sat, lum);
      s.lowAlt = hsl(h + 20, sat, lum * 0.85);
      s.beach = s.low;
      s.high = hsl(h, sat * 0.7, lum * 0.7);
      s.peak = hsl(h, sat * 0.5, lum * 1.25);
      s.snow = s.peak;
      s.craterAmp = rng.range(0.6, 1);
      s.mountainAmp = rng.range(0.25, 0.5);
      s.ridgeAmp = rng.range(0.1, 0.35);
      s.warp = rng.range(0.1, 0.3);
      s.bump = rng.range(1.1, 1.6);
      break;
    }
    case 'lava': {
      s.seaLevel = rng.range(0.3, 0.4);
      s.oceanKind = 'lava';
      const glowHue = rng.range(8, 28);
      // Emissive at runtime (scaled in the planet shader).
      s.deep = hsl(glowHue, 1, 0.45);
      s.shallow = hsl(glowHue + 22, 1, 0.55);
      s.beach = hsl(10, 0.3, 0.1);
      s.low = hsl(rng.range(0, 30), 0.15, 0.07);
      s.lowAlt = hsl(rng.range(0, 30), 0.2, 0.11);
      s.high = hsl(20, 0.1, 0.16);
      s.peak = hsl(25, 0.06, 0.3);
      s.snow = s.peak;
      s.ridgeAmp = rng.range(0.7, 1);
      s.mountainAmp = rng.range(0.5, 0.8);
      s.warp = rng.range(0.5, 1);
      s.cloudCover = rng.range(0.1, 0.25);
      s.cloudColor = hsl(20, 0.15, 0.25);
      s.bump = 1.4;
      break;
    }
    case 'ice': {
      const h = rng.range(185, 230);
      s.seaLevel = rng.range(0.35, 0.5);
      s.oceanKind = 'ice';
      s.deep = hsl(h, 0.5, 0.5);
      s.shallow = hsl(h - 10, 0.45, 0.68);
      s.beach = hsl(h, 0.2, 0.8);
      s.low = hsl(h, 0.18, 0.86);
      s.lowAlt = hsl(h + 10, 0.3, 0.72);
      s.high = hsl(h + 15, 0.2, 0.36);
      s.peak = hsl(h, 0.1, 0.9);
      s.craterAmp = rng.range(0.1, 0.5);
      s.ridgeAmp = rng.range(0.4, 0.8);
      s.iceCap = rng.range(0.2, 0.35);
      s.cloudCover = rng.range(0.1, 0.3);
      break;
    }
    case 'toxic': {
      const h = rng.range(60, 95);
      s.seaLevel = rng.range(0.4, 0.55);
      s.oceanKind = 'acid';
      s.deep = hsl(h + 20, 0.85, 0.2);
      s.shallow = hsl(h, 0.9, 0.4);
      s.beach = hsl(h - 15, 0.5, 0.5);
      s.low = hsl(h - 25, 0.5, 0.38);
      s.lowAlt = hsl(h - 10, 0.45, 0.3);
      s.high = hsl(h - 30, 0.35, 0.22);
      s.peak = hsl(55, 0.4, 0.62);
      s.snow = s.peak;
      s.ridgeAmp = rng.range(0.4, 0.7);
      s.warp = rng.range(0.6, 1);
      s.cloudCover = rng.range(0.45, 0.65);
      s.cloudColor = hsl(rng.range(50, 70), 0.45, 0.72);
      break;
    }
    case 'exotic': {
      const h = rng.range(0, 360);
      s.seaLevel = rng.range(0.38, 0.52);
      s.oceanKind = 'glow';
      s.deep = hsl(h + 150, 0.9, 0.15);
      s.shallow = hsl(h + 170, 0.95, 0.4);
      s.beach = hsl(h + 60, 0.4, 0.7);
      s.low = hsl(h, 0.65, 0.35);
      s.lowAlt = hsl(h + 50, 0.6, 0.4);
      s.high = hsl(h + 200, 0.35, 0.28);
      s.peak = hsl(h + 120, 0.35, 0.8);
      s.snow = hsl(h + 120, 0.25, 0.92);
      s.ridgeAmp = rng.range(0.6, 1);
      s.mountainAmp = rng.range(0.6, 0.9);
      s.warp = rng.range(0.7, 1.2);
      s.cloudCover = rng.range(0.25, 0.45);
      s.cloudColor = hsl(h + 30, 0.4, 0.85);
      s.iceCap = rng.range(0, 0.15);
      break;
    }
    case 'gasGiant': {
      const variant = rng.int(0, 3);
      const h =
        variant === 0 ? rng.range(22, 38) : variant === 1 ? rng.range(40, 52) : variant === 2 ? rng.range(195, 228) : rng.range(0, 360);
      const sat = variant === 1 ? 0.35 : rng.range(0.35, 0.6);
      s.deep = hsl(h - 10, sat, 0.3);
      s.shallow = hsl(h, sat * 0.8, 0.55);
      s.beach = hsl(h + 8, sat * 0.4, 0.78);
      s.low = hsl(h - 5, sat * 1.1, 0.45);
      s.lowAlt = hsl(h + 15, sat * 0.7, 0.62);
      s.high = hsl(h - 18, sat, 0.36);
      s.peak = hsl(h + 25, sat * 0.5, 0.7);
      s.snow = hsl(h - 25, sat * 1.2, 0.4);
      s.bandFreq = rng.range(5, 14);
      s.bandTurbulence = rng.range(0.35, 1);
      s.storms = rng.int(0, 3);
      s.warp = rng.range(0.6, 1.2);
      s.bump = 0.25;
      break;
    }
  }
  return s;
}

export function makeAtmosphere(type: PlanetType, rng: Rng, radius: number): AtmosphereDef | null {
  const thick = (d: AtmosphereDef['density']) => (d === 'thin' ? 0.45 : d === 'thick' ? 1.9 : 1);
  const pickDensity = (): AtmosphereDef['density'] => {
    const r = rng.next();
    return r < 0.25 ? 'thin' : r < 0.8 ? 'standard' : 'thick';
  };
  const build = (
    rayleigh: RGB,
    mie: number,
    mieColor: RGB,
    density: AtmosphereDef['density'],
    composition: string,
    heightFrac = rng.range(0.11, 0.17),
  ): AtmosphereDef => {
    const k = thick(density);
    return {
      height: radius * heightFrac,
      rayleigh: [rayleigh[0] * k, rayleigh[1] * k, rayleigh[2] * k],
      mie: mie * k,
      mieG: rng.range(0.72, 0.84),
      rayleighScale: 0.22,
      mieScale: 0.08,
      mieColor,
      density,
      composition,
    };
  };
  switch (type) {
    case 'terran': {
      const r = rng.next();
      // Earth-like blue most of the time; occasionally teal or lilac skies.
      const ray: RGB = r < 0.65 ? [0.05, 0.12, 0.29] : r < 0.85 ? [0.04, 0.17, 0.2] : [0.14, 0.07, 0.26];
      return build(ray, 0.03, [1, 1, 1], pickDensity(), 'Nitrogen-oxygen');
    }
    case 'ocean':
      return build([0.045, 0.12, 0.32], 0.035, [1, 1, 1], rng.next() < 0.6 ? 'standard' : 'thick', 'Nitrogen-oxygen, humid');
    case 'desert':
      return rng.next() < 0.15
        ? null
        : build([0.17, 0.1, 0.06], 0.12, hsl(30, 0.5, 0.7), rng.next() < 0.5 ? 'thin' : 'standard', 'Carbon dioxide, dust');
    case 'barren':
      return rng.next() < 0.75 ? null : build([0.03, 0.04, 0.06], 0.01, [1, 1, 1], 'thin', 'Trace argon', 0.08);
    case 'lava':
      return build([0.12, 0.05, 0.03], 0.18, hsl(15, 0.6, 0.45), rng.next() < 0.5 ? 'standard' : 'thick', 'Sulphur dioxide, ash');
    case 'ice':
      return rng.next() < 0.3 ? null : build([0.04, 0.09, 0.15], 0.02, [1, 1, 1], 'thin', 'Nitrogen, methane traces');
    case 'toxic':
      return build([0.12, 0.17, 0.04], 0.26, hsl(60, 0.6, 0.6), rng.next() < 0.6 ? 'thick' : 'standard', 'Chlorine, ammonia');
    case 'exotic': {
      const h = rng.range(0, 360);
      const c = hsl(h, 0.8, 0.5);
      return build([0.06 + c[0] * 0.18, 0.06 + c[1] * 0.18, 0.06 + c[2] * 0.18], 0.06, hsl(h + 40, 0.5, 0.7), pickDensity(), 'Unknown — anomalous spectra');
    }
    case 'gasGiant':
      return build([0.025, 0.045, 0.09], 0.03, [1, 0.95, 0.85], 'standard', 'Hydrogen, helium', rng.range(0.035, 0.05));
  }
}

export function makeRings(rng: Rng, radius: number, base: RGB): RingDef {
  const tint = hsl(rng.range(20, 50), rng.range(0.1, 0.35), rng.range(0.55, 0.75));
  return {
    innerRadius: radius * rng.range(1.3, 1.6),
    outerRadius: radius * rng.range(2.0, 2.7),
    colorA: tint,
    colorB: [base[0] * 0.6 + 0.2, base[1] * 0.6 + 0.2, base[2] * 0.6 + 0.2],
    opacity: rng.range(0.55, 0.9),
    seed: rng.int(0, 1e9),
  };
}

const ADJECTIVES: Record<PlanetType, string[]> = {
  barren: ['Airless, cratered', 'Desolate, dust-blown', 'Scarred, ancient', 'Silent, cratered'],
  lava: ['Molten, unstable', 'Volcanic, tectonically violent', 'Scorched, magma-veined'],
  desert: ['Arid, wind-carved', 'Sun-baked, dune-covered', 'Dry, canyon-riven'],
  terran: ['Temperate, verdant', 'Lush, life-bearing', 'Mild, forested'],
  ocean: ['Storm-swept, oceanic', 'Archipelago-dotted', 'Deep-sea, humid'],
  ice: ['Frozen, glacial', 'Ice-locked, crevassed', 'Frigid, wind-scoured'],
  toxic: ['Caustic, acid-misted', 'Poisonous, chemically active', 'Corrosive, fog-shrouded'],
  exotic: ['Anomalous, bioluminescent', 'Crystalline, uncanny', 'Strange, resonant'],
  gasGiant: ['Banded, storm-wracked', 'Colossal, turbulent', 'Vast, hydrogen-rich'],
};

export function describe(type: PlanetType, rng: Rng): string {
  const noun = type === 'gasGiant' ? 'gas giant' : `${PLANET_TYPE_LABEL[type].toLowerCase()} world`;
  return `${rng.pick(ADJECTIVES[type])} ${noun}.`;
}
