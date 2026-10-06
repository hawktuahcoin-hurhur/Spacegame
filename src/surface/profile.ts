import * as THREE from 'three';
import type { AtmosphereDef, BodyDef, OceanKind, PlanetType, RGB } from '../galaxy/types';
import { Rng } from '../core/rng';

export type FloraKind = 'broadleaf' | 'conifer' | 'bush' | 'grass' | 'palm' | 'cactus' | 'shrub' | 'mushroom' | 'spore' | 'crystalTree' | 'iceSpike' | 'obsidian' | 'rock' | 'boulder';
export type HazardKind = 'none' | 'heat' | 'cold' | 'toxic' | 'radiation' | 'vacuum';

export interface FloraSpec {
  kind: FloraKind;
  /** Instances per 1000 m². */
  density: number;
  color: THREE.Color;
  accent: THREE.Color;
  /** Uniform scale range. */
  scale: [number, number];
  /** Emissive glow (toxic and exotic worlds). */
  glow: number;
  /** Scannable lifeform (rocks aren't). */
  living: boolean;
}

export interface ResourceSpec {
  commodity: string;
  weight: number;
  color: THREE.Color;
}

/**
 * Everything the surface scene needs to know about one world, derived from
 * the same procedural planet definition the orbital view renders — so the
 * colours you saw from orbit are the colours you land in.
 */
export interface SurfaceProfile {
  seed: number;
  type: PlanetType;
  name: string;
  gravity: number;
  temperature: number;
  ramp: { deep: THREE.Color; shallow: THREE.Color; beach: THREE.Color; low: THREE.Color; lowAlt: THREE.Color; high: THREE.Color; peak: THREE.Color; snow: THREE.Color };
  oceanKind: OceanKind;
  /** Height amplitude of mountains (m). */
  relief: number;
  ridge: number;
  craters: number;
  roughness: number;
  /** Fraction of the height range under the sea (−1 = dry world). */
  seaFraction: number;
  /** Snow above this fraction of the height range (1 = none). */
  snowLine: number;
  flora: FloraSpec[];
  fauna: number;
  resources: ResourceSpec[];
  hazard: { kind: HazardKind; rate: number; label: string };
  sky: { zenith: THREE.Color; horizon: THREE.Color; haze: number; stars: number; clouds: number; cloudColor: THREE.Color };
  hasAtmosphere: boolean;
}

const col = (c: RGB) => new THREE.Color(c[0], c[1], c[2]);

/** Sky colours from the atmosphere's scattering coefficients. */
function skyFrom(atmo: AtmosphereDef | null, cloud: number, cloudColor: RGB): SurfaceProfile['sky'] {
  if (!atmo) return { zenith: new THREE.Color(0, 0, 0), horizon: new THREE.Color(0.02, 0.02, 0.03), haze: 0.02, stars: 1, clouds: 0, cloudColor: col(cloudColor) };
  const r = atmo.rayleigh;
  const m = Math.max(r[0], r[1], r[2], 1e-4);
  const ray = new THREE.Color(r[0] / m, r[1] / m, r[2] / m);
  const mie = col(atmo.mieColor);
  const thick = atmo.density === 'thick' ? 1 : atmo.density === 'standard' ? 0.6 : 0.3;
  const zenith = ray.clone().multiplyScalar(0.18 + thick * 0.22).lerp(mie.clone().multiplyScalar(0.3), Math.min(0.7, atmo.mie * 3));
  const horizon = ray.clone().multiplyScalar(0.5).lerp(new THREE.Color(1, 1, 1), 0.35).lerp(mie, Math.min(0.8, atmo.mie * 4 + 0.15)).multiplyScalar(0.55 + thick * 0.35);
  return { zenith, horizon, haze: 0.25 + thick * 0.6 + atmo.mie * 2, stars: atmo.density === 'thin' ? 0.5 : 0.1, clouds: cloud, cloudColor: col(cloudColor) };
}

function hue(c: THREE.Color, shift: number, light = 0): THREE.Color {
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return new THREE.Color().setHSL((hsl.h + shift + 1) % 1, hsl.s, Math.min(1, Math.max(0, hsl.l + light)));
}

/** Build the surface profile for a landable body. */
export function surfaceProfile(body: BodyDef): SurfaceProfile {
  const s = body.surface;
  const rng = new Rng(body.seed ^ 0x5ea1);
  const t = body.type;
  const ramp = {
    deep: col(s.deep),
    shallow: col(s.shallow),
    beach: col(s.beach),
    low: col(s.low),
    lowAlt: col(s.lowAlt),
    high: col(s.high),
    peak: col(s.peak),
    snow: col(s.snow),
  };
  const low = ramp.low;
  const flora: FloraSpec[] = [];
  const add = (kind: FloraKind, density: number, color: THREE.Color, scale: [number, number], opts: Partial<FloraSpec> = {}) =>
    flora.push({ kind, density, color, accent: opts.accent ?? hue(color, 0.05, 0.12), scale, glow: opts.glow ?? 0, living: opts.living ?? true });
  const rocky = hue(ramp.high, 0, -0.05);
  let fauna = 0;
  const resources: ResourceSpec[] = [];
  const res = (commodity: string, weight: number, color: string) => resources.push({ commodity, weight, color: new THREE.Color(color) });
  switch (t) {
    case 'terran':
      add('broadleaf', rng.range(3, 7), hue(low, 0, 0.04), [0.8, 1.6]);
      add('conifer', rng.range(1, 4), hue(low, -0.03, -0.06), [0.8, 1.5]);
      add('bush', rng.range(6, 12), hue(ramp.lowAlt, 0.02), [0.7, 1.4]);
      add('grass', rng.range(30, 60), hue(ramp.lowAlt, 0.01, 0.06), [0.7, 1.3]);
      add('rock', 1.5, rocky, [0.6, 1.8], { living: false });
      fauna = 1;
      res('organics', 3, '#7dff6a');
      res('ore', 2, '#d9a066');
      res('rare_ore', 0.5, '#5fd4ff');
      break;
    case 'ocean':
      add('palm', rng.range(4, 8), hue(low, 0.02, 0.05), [0.8, 1.4]);
      add('bush', rng.range(8, 14), hue(ramp.lowAlt, 0), [0.7, 1.3]);
      add('grass', rng.range(20, 40), hue(ramp.lowAlt, 0.02, 0.08), [0.6, 1.2]);
      add('rock', 1, rocky, [0.5, 1.4], { living: false });
      fauna = 0.8;
      res('organics', 3, '#7dff6a');
      res('water', 2, '#8fd6ff');
      break;
    case 'desert':
      add('cactus', rng.range(1.5, 4), hue(low, 0.25, -0.05), [0.8, 1.6], { accent: new THREE.Color('#ff7ad0') });
      add('shrub', rng.range(3, 6), hue(ramp.lowAlt, 0.1, -0.1), [0.6, 1.2]);
      add('rock', 3, rocky, [0.6, 2], { living: false });
      add('boulder', 0.6, rocky, [1, 2.5], { living: false });
      fauna = 0.35;
      res('ore', 3, '#d9a066');
      res('rare_ore', 1, '#5fd4ff');
      break;
    case 'ice':
      add('iceSpike', rng.range(2, 5), new THREE.Color('#bfe8ff'), [0.7, 2], { glow: 0.15, living: false });
      add('shrub', rng.range(1, 3), hue(ramp.low, 0.5, -0.15), [0.5, 1]);
      add('rock', 2, rocky, [0.6, 1.6], { living: false });
      fauna = 0.2;
      res('water', 3, '#8fd6ff');
      res('volatiles', 2, '#c88cff');
      break;
    case 'toxic':
      add('mushroom', rng.range(4, 9), hue(low, 0.1, 0.08), [0.8, 2.2], { glow: 0.5, accent: hue(low, 0.4, 0.2) });
      add('spore', rng.range(6, 12), hue(ramp.lowAlt, -0.1, 0.05), [0.6, 1.4], { glow: 0.8 });
      add('rock', 1.5, rocky, [0.6, 1.6], { living: false });
      fauna = 0.5;
      res('volatiles', 3, '#c88cff');
      res('organics', 2, '#7dff6a');
      break;
    case 'exotic':
      add('crystalTree', rng.range(3, 7), hue(low, 0, 0.1), [0.8, 2], { glow: 1, accent: hue(low, 0.5, 0.15) });
      add('spore', rng.range(3, 6), hue(ramp.lowAlt, 0.3, 0.1), [0.6, 1.3], { glow: 1.2 });
      add('boulder', 0.8, rocky, [1, 2.2], { living: false });
      fauna = 0.6;
      res('rare_ore', 3, '#5fd4ff');
      res('rare_metals', 1, '#ff7ad0');
      break;
    case 'lava':
      add('obsidian', rng.range(2, 5), new THREE.Color('#1a1418'), [0.8, 2.4], { glow: 0.3, accent: new THREE.Color('#ff6a1a'), living: false });
      add('rock', 3, rocky, [0.6, 2], { living: false });
      res('rare_ore', 2, '#5fd4ff');
      res('ore', 2, '#d9a066');
      res('metals', 0.6, '#ffd27a');
      break;
    default:
      // Barren rock.
      add('rock', 4, rocky, [0.6, 2.2], { living: false });
      add('boulder', 1, rocky, [1, 3], { living: false });
      res('ore', 3, '#d9a066');
      res('rare_ore', 1.2, '#5fd4ff');
      break;
  }
  const temp = body.temperature;
  let hazard: SurfaceProfile['hazard'];
  if (t === 'lava') hazard = { kind: 'heat', rate: 1 / 70, label: 'Extreme heat' };
  else if (t === 'toxic') hazard = { kind: 'toxic', rate: 1 / 120, label: 'Toxic atmosphere' };
  else if (t === 'exotic') hazard = { kind: 'radiation', rate: 1 / 150, label: 'Radiation' };
  else if (!body.atmosphere) hazard = { kind: 'vacuum', rate: 1 / 200, label: 'No atmosphere' };
  else if (temp > 340) hazard = { kind: 'heat', rate: 1 / Math.max(80, 400 - temp), label: 'High temperature' };
  else if (temp < 230) hazard = { kind: 'cold', rate: 1 / Math.max(90, temp - 40), label: 'Freezing' };
  else hazard = { kind: 'none', rate: 0, label: 'Mild' };
  const craterWorld = t === 'barren' || (t === 'ice' && !body.atmosphere) || (!body.atmosphere && t !== 'lava');
  return {
    seed: body.seed,
    type: t,
    name: body.name,
    gravity: Math.max(0.15, body.gravity),
    temperature: temp,
    ramp,
    oceanKind: s.oceanKind,
    relief: 70 + s.mountainAmp * 160,
    ridge: s.ridgeAmp,
    craters: craterWorld ? 0.4 + s.craterAmp : s.craterAmp * 0.3,
    roughness: 0.6 + s.warp * 0.5,
    seaFraction: s.seaLevel > 0 ? Math.min(0.42, s.seaLevel * 0.55) : -1,
    snowLine: t === 'ice' ? 0.15 : s.iceCap > 0.2 ? 0.86 : 1.2,
    flora,
    fauna,
    resources,
    hazard,
    sky: skyFrom(body.atmosphere, s.cloudCover, s.cloudColor),
    hasAtmosphere: !!body.atmosphere,
  };
}

/** Landable: anything with a solid surface. */
export function isLandable(body: BodyDef): boolean {
  return body.type !== 'gasGiant';
}
