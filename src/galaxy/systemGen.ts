import { Rng } from '../core/rng';
import {
  RADIUS_RANGE,
  SPECTRAL,
  blackbody,
  describe,
  makeAtmosphere,
  makeRings,
  makeSurface,
} from '../planets/planetTypes';
import { generateName, generateStationName, generateSystemName, romanNumeral } from './names';
import type {
  BeltDef,
  BodyDef,
  OrbitDef,
  PlanetType,
  SpectralClass,
  StarDef,
  StarSystemDef,
  StationDef,
} from './types';

/** Habitable zone radius for a G star (luminosity 1), in metres. */
export const HZ_BASE = 2.2e7;
/** Orbital period at the habitable zone, in seconds. Planets visibly move on the system map. */
export const HZ_PERIOD = 4 * 3600;
/** Base moon period scale (seconds) — period = MOON_PERIOD_BASE * (a / R)^1.5. */
const MOON_PERIOD_BASE = 150;

function pickWeighted<T>(rng: Rng, entries: [T, number][]): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng.next() * total;
  for (const [v, w] of entries) {
    r -= w;
    if (r <= 0) return v;
  }
  return entries[entries.length - 1][0];
}

function makeStar(rng: Rng, name: string): StarDef {
  const cls = pickWeighted(
    rng,
    (Object.keys(SPECTRAL) as SpectralClass[]).map((k) => [k, SPECTRAL[k].weight] as [SpectralClass, number]),
  );
  const info = SPECTRAL[cls];
  const temperature = rng.range(...info.temperature);
  return {
    name,
    spectralClass: cls,
    temperature,
    radius: rng.range(...info.radius),
    luminosity: info.luminosity * rng.range(0.85, 1.15),
    color: blackbody(temperature),
  };
}

/** Planet type from its distance relative to the habitable zone. */
function pickPlanetType(rng: Rng, x: number): PlanetType {
  if (x < 0.45)
    return pickWeighted<PlanetType>(rng, [
      ['lava', 50],
      ['barren', 35],
      ['toxic', 15],
    ]);
  if (x < 0.8)
    return pickWeighted<PlanetType>(rng, [
      ['desert', 40],
      ['toxic', 25],
      ['barren', 20],
      ['terran', 15],
    ]);
  if (x < 1.35)
    return pickWeighted<PlanetType>(rng, [
      ['terran', 45],
      ['ocean', 30],
      ['desert', 10],
      ['exotic', 10],
      ['toxic', 5],
    ]);
  if (x < 2.6)
    return pickWeighted<PlanetType>(rng, [
      ['ice', 35],
      ['barren', 20],
      ['gasGiant', 25],
      ['exotic', 10],
      ['desert', 10],
    ]);
  return pickWeighted<PlanetType>(rng, [
    ['gasGiant', 60],
    ['ice', 30],
    ['barren', 10],
  ]);
}

function pickMoonType(rng: Rng, parentTemp: number): PlanetType {
  if (parentTemp > 450)
    return pickWeighted<PlanetType>(rng, [
      ['lava', 40],
      ['barren', 60],
    ]);
  if (parentTemp < 220)
    return pickWeighted<PlanetType>(rng, [
      ['ice', 50],
      ['barren', 35],
      ['toxic', 5],
      ['exotic', 5],
      ['lava', 5],
    ]);
  return pickWeighted<PlanetType>(rng, [
    ['barren', 55],
    ['ice', 15],
    ['desert', 15],
    ['toxic', 5],
    ['terran', 5],
    ['exotic', 5],
  ]);
}

function equilibriumTemperature(type: PlanetType, x: number, rng: Rng): number {
  let t = 285 / Math.sqrt(Math.max(x, 0.05));
  if (type === 'toxic') t += rng.range(60, 180);
  if (type === 'lava') t = Math.max(t, 700) + rng.range(0, 400);
  if (type === 'terran' || type === 'ocean') t = 255 + rng.range(10, 45);
  if (type === 'ice') t = Math.min(t, 230);
  if (type === 'gasGiant') t = Math.min(t, 180) - rng.range(0, 60);
  return Math.round(t);
}

function gravityFor(type: PlanetType, radius: number, rng: Rng): number {
  if (type === 'gasGiant') return +(1.4 + (radius / 2.6e5) * 1.4 * rng.range(0.85, 1.15)).toFixed(2);
  return +((radius / 4.0e4) * rng.range(0.75, 1.25)).toFixed(2);
}

interface BodyParams {
  id: string;
  name: string;
  kind: BodyDef['kind'];
  type: PlanetType;
  radius: number;
  parentId: string | null;
  orbit: OrbitDef;
  temperature: number;
  seed: number;
}

function makeBody(p: BodyParams): BodyDef {
  const rng = new Rng(p.seed);
  const surface = makeSurface(p.type, rng, p.temperature);
  const atmosphere = makeAtmosphere(p.type, rng, p.radius);
  const isGas = p.type === 'gasGiant';
  const rotationPeriod = isGas ? rng.range(240, 600) : rng.range(8 * 60, 40 * 60) * (rng.next() < 0.5 ? 1 : -1);
  const axialTilt = rng.next() < 0.9 ? rng.range(0, 0.45) : rng.range(0.45, 1.4);
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    type: p.type,
    seed: p.seed,
    radius: p.radius,
    gravity: gravityFor(p.type, p.radius, rng),
    temperature: p.temperature,
    parentId: p.parentId,
    orbit: p.orbit,
    rotationPeriod,
    axialTilt: p.kind === 'moon' ? rng.range(0, 0.1) : axialTilt,
    tiltAzimuth: rng.range(0, Math.PI * 2),
    soiRadius: p.radius * 10,
    atmosphere,
    rings: null,
    surface,
    moonIds: [],
    description: describe(p.type, rng),
  };
}

function makeOrbit(rng: Rng, a: number, period: number, maxIncl: number, maxEcc: number): OrbitDef {
  return {
    semiMajorAxis: a,
    eccentricity: rng.range(0, maxEcc),
    inclination: rng.range(-maxIncl, maxIncl),
    ascendingNode: rng.range(0, Math.PI * 2),
    argPeriapsis: rng.range(0, Math.PI * 2),
    meanAnomalyAtEpoch: rng.range(0, Math.PI * 2),
    period,
  };
}

/**
 * Deterministically generate a star system from a seed.
 * Same seed → identical output (tested in tests/systemGen.test.ts).
 */
export function generateSystem(seed: number): StarSystemDef {
  const rng = new Rng(seed);
  const name = generateSystemName(rng);
  const star = makeStar(rng, name);
  const hz = HZ_BASE * Math.sqrt(star.luminosity);

  const bodies: BodyDef[] = [];
  const belts: BeltDef[] = [];
  const stations: StationDef[] = [];

  // Orbit slots: geometric spacing outward from the star.
  const slots: number[] = [];
  let a = Math.max(star.radius * 8, hz * rng.range(0.28, 0.42));
  const count = rng.int(4, 8);
  for (let i = 0; i < count; i++) {
    slots.push(a);
    a *= rng.range(1.45, 1.85);
  }

  // One slot (between the warm and cold zones) may become an asteroid belt.
  let beltSlot = -1;
  if (rng.next() < 0.7) {
    const candidates = slots.map((s, i) => [i, s / hz] as const).filter(([, x]) => x > 1.3 && x < 3.5);
    if (candidates.length > 0) beltSlot = rng.pick(candidates)[0];
  }

  // Guarantee interesting systems: force a living world near the HZ most of the time.
  const hzSlot = slots.reduce((best, s, i) => (Math.abs(Math.log(s / hz)) < Math.abs(Math.log(slots[best] / hz)) ? i : best), 0);
  const forceLiving = rng.next() < 0.8;

  let planetNumber = 0;
  slots.forEach((slotA, i) => {
    const x = slotA / hz;
    const period = HZ_PERIOD * Math.pow(x, 1.5);
    if (i === beltSlot) {
      const icy = x > 2.6;
      belts.push({
        id: `belt-${belts.length}`,
        name: `${name} ${icy ? 'Ice Ring' : 'Belt'}`,
        radius: slotA,
        width: slotA * rng.range(0.07, 0.12),
        thickness: slotA * rng.range(0.006, 0.012),
        seed: Rng.derive(seed, 9000 + i),
        color: icy ? [0.55, 0.6, 0.68] : [0.42, 0.36, 0.3],
        icy,
      });
      return;
    }
    planetNumber++;
    const pSeed = Rng.derive(seed, 100 + i);
    const prng = new Rng(pSeed);
    let type = pickPlanetType(prng, x);
    if (i === hzSlot && forceLiving && type !== 'terran' && type !== 'ocean') {
      type = prng.next() < 0.7 ? 'terran' : 'ocean';
    }
    const radius = prng.range(...RADIUS_RANGE[type]);
    const pname = prng.next() < 0.35 ? generateName(prng, 2, 3) : `${name} ${romanNumeral(planetNumber)}`;
    const temperature = equilibriumTemperature(type, x, prng);
    const planet = makeBody({
      id: `planet-${i}`,
      name: pname,
      kind: 'planet',
      type,
      radius,
      parentId: null,
      orbit: makeOrbit(prng, slotA, period, 0.05, 0.05),
      temperature,
      seed: pSeed,
    });
    bodies.push(planet);

    // Rings.
    if ((type === 'gasGiant' && prng.next() < 0.5) || (type === 'ice' && prng.next() < 0.12)) {
      planet.rings = makeRings(prng, radius, planet.surface.low);
    }

    // Moons.
    const moonCount =
      type === 'gasGiant' ? pickWeighted(prng, [[0, 10], [1, 20], [2, 30], [3, 25], [4, 15]]) : pickWeighted(prng, [[0, 50], [1, 35], [2, 15]]);
    let moonA = Math.max(radius * prng.range(4, 6), (planet.rings?.outerRadius ?? 0) * 1.5);
    let maxReach = radius * 4;
    for (let m = 0; m < moonCount; m++) {
      const mSeed = Rng.derive(pSeed, 50 + m);
      const mrng = new Rng(mSeed);
      const mType = pickMoonType(mrng, temperature);
      const mRadius = Math.min(mrng.range(4.5e3, 1.4e4) * (type === 'gasGiant' ? 1.5 : 1), radius * 0.4);
      const moon = makeBody({
        id: `${planet.id}-moon-${m}`,
        name: `${pname} ${String.fromCharCode(65 + m)}`,
        kind: 'moon',
        type: mType,
        radius: mRadius,
        parentId: planet.id,
        orbit: makeOrbit(mrng, moonA, MOON_PERIOD_BASE * Math.pow(moonA / radius, 1.5), 0.08, 0.03),
        temperature: Math.round(temperature * mrng.range(0.85, 1.0)),
        seed: mSeed,
      });
      // Tidally locked.
      moon.rotationPeriod = moon.orbit.period;
      moon.soiRadius = Math.min(mRadius * 8, moonA * 0.25);
      bodies.push(moon);
      planet.moonIds.push(moon.id);
      maxReach = moonA + moon.soiRadius;
      moonA *= mrng.range(1.5, 2.1);
    }
    planet.soiRadius = Math.max(radius * 12, maxReach * 1.3);
  });

  // Cap each planet's SOI so neighbours never overlap.
  const planets = bodies.filter((b) => b.kind === 'planet');
  for (let i = 0; i < planets.length; i++) {
    const p = planets[i];
    const inner = i > 0 ? p.orbit.semiMajorAxis - planets[i - 1].orbit.semiMajorAxis : p.orbit.semiMajorAxis - star.radius;
    const outer = i < planets.length - 1 ? planets[i + 1].orbit.semiMajorAxis - p.orbit.semiMajorAxis : Infinity;
    p.soiRadius = Math.min(p.soiRadius, 0.35 * Math.min(inner, outer));
    // Drop moons that no longer fit inside the capped sphere of influence.
    p.moonIds = p.moonIds.filter((id) => {
      const moon = bodies.find((b) => b.id === id)!;
      const fits = moon.orbit.semiMajorAxis * (1 + moon.orbit.eccentricity) + moon.soiRadius < p.soiRadius;
      if (!fits) bodies.splice(bodies.indexOf(moon), 1);
      return fits;
    });
  }

  // A trade station around the most habitable planet (Phase 5 gives it a market).
  const homeworld =
    planets.find((p) => p.type === 'terran' || p.type === 'ocean') ??
    planets.find((p) => p.type !== 'gasGiant' && p.type !== 'lava') ??
    planets[0];
  if (homeworld) {
    const srng = new Rng(Rng.derive(seed, 7000));
    const moonInner = homeworld.moonIds.length
      ? Math.min(...homeworld.moonIds.map((id) => bodies.find((b) => b.id === id)!.orbit.semiMajorAxis))
      : Infinity;
    const stationA = Math.min(homeworld.radius * srng.range(2.2, 2.8), moonInner * 0.6);
    stations.push({
      id: 'station-0',
      name: generateStationName(srng, homeworld.name),
      parentId: homeworld.id,
      orbit: makeOrbit(srng, stationA, MOON_PERIOD_BASE * 4 * Math.pow(stationA / homeworld.radius, 1.5), 0.02, 0),
      seed: srng.int(0, 1e9),
      radius: 900,
    });
  }

  return { seed, name, star, habitableRadius: hz, bodies, belts, stations };
}
