/**
 * Pure data describing a generated star system. Everything here is derived
 * deterministically from a seed (SUPERPLAN §2.6) and is never saved.
 *
 * Units: metres, seconds, kelvin. Colours are linear RGB in [0, 1+].
 */

export type RGB = [number, number, number];

export type SpectralClass = 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M';

export type PlanetType =
  | 'barren'
  | 'lava'
  | 'desert'
  | 'terran'
  | 'ocean'
  | 'ice'
  | 'toxic'
  | 'exotic'
  | 'gasGiant';

export type OceanKind = 'none' | 'water' | 'lava' | 'ice' | 'acid' | 'glow';

export interface StarDef {
  name: string;
  spectralClass: SpectralClass;
  temperature: number;
  radius: number;
  /** Gameplay-compressed luminosity relative to a G star. */
  luminosity: number;
  color: RGB;
}

/** Keplerian orbit in the parent's frame. The system plane is XZ, +Y is "north". */
export interface OrbitDef {
  semiMajorAxis: number;
  eccentricity: number;
  inclination: number;
  ascendingNode: number;
  argPeriapsis: number;
  meanAnomalyAtEpoch: number;
  period: number;
}

export interface AtmosphereDef {
  /** Thickness of the scattering shell above the surface. */
  height: number;
  /** Vertical Rayleigh optical depth per channel (Earth ≈ 0.05, 0.11, 0.27). */
  rayleigh: RGB;
  /** Vertical Mie optical depth. */
  mie: number;
  mieG: number;
  /** Scale heights as a fraction of `height`. */
  rayleighScale: number;
  mieScale: number;
  /** Mie scattering tint (dust/haze colour). */
  mieColor: RGB;
  density: 'thin' | 'standard' | 'thick';
  composition: string;
}

export interface RingDef {
  innerRadius: number;
  outerRadius: number;
  colorA: RGB;
  colorB: RGB;
  opacity: number;
  seed: number;
}

export interface SurfaceDef {
  /** Height (0..1) below which the ocean kind fills. -1 for no sea. */
  seaLevel: number;
  oceanKind: OceanKind;
  /** Biome colour ramp, low to high. */
  deep: RGB;
  shallow: RGB;
  beach: RGB;
  low: RGB;
  lowAlt: RGB;
  high: RGB;
  peak: RGB;
  snow: RGB;
  continentFreq: number;
  mountainAmp: number;
  ridgeAmp: number;
  craterAmp: number;
  warp: number;
  /** Normal-map strength. */
  bump: number;
  /** 0 = no ice caps, 1 = fully frozen. */
  iceCap: number;
  cloudCover: number;
  cloudColor: RGB;
  /** Gas giant band parameters. */
  bandFreq: number;
  bandTurbulence: number;
  storms: number;
}

export interface BodyDef {
  id: string;
  name: string;
  kind: 'planet' | 'moon';
  type: PlanetType;
  seed: number;
  radius: number;
  /** Surface gravity in g. */
  gravity: number;
  temperature: number;
  /** null = orbits the star. */
  parentId: string | null;
  orbit: OrbitDef;
  rotationPeriod: number;
  axialTilt: number;
  tiltAzimuth: number;
  /** Radius of this body's reference frame (sphere of influence). */
  soiRadius: number;
  atmosphere: AtmosphereDef | null;
  rings: RingDef | null;
  surface: SurfaceDef;
  moonIds: string[];
  description: string;
}

export interface BeltDef {
  id: string;
  name: string;
  radius: number;
  width: number;
  thickness: number;
  seed: number;
  color: RGB;
  icy: boolean;
}

export interface StationDef {
  id: string;
  name: string;
  parentId: string;
  orbit: OrbitDef;
  seed: number;
  radius: number;
}

export interface StarSystemDef {
  seed: number;
  name: string;
  star: StarDef;
  /** Habitable-zone orbit radius. */
  habitableRadius: number;
  bodies: BodyDef[];
  belts: BeltDef[];
  stations: StationDef[];
}
