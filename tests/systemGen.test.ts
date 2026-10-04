import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { generateSystem } from '../src/galaxy/systemGen';
import { eccentricAnomaly, orbitPosition } from '../src/galaxy/orbits';

const SEEDS = Array.from({ length: 200 }, (_, i) => i * 7919 + 13);

describe('generateSystem', () => {
  it('is deterministic', () => {
    for (const seed of SEEDS.slice(0, 20)) {
      expect(JSON.stringify(generateSystem(seed))).toBe(JSON.stringify(generateSystem(seed)));
    }
  });

  it('produces different systems for different seeds', () => {
    const names = new Set(SEEDS.map((s) => generateSystem(s).name));
    expect(names.size).toBeGreaterThan(SEEDS.length * 0.8);
  });

  it('has sane physical layout', () => {
    for (const seed of SEEDS) {
      const sys = generateSystem(seed);
      const planets = sys.bodies.filter((b) => b.kind === 'planet');
      expect(planets.length).toBeGreaterThan(0);
      for (let i = 0; i < planets.length; i++) {
        const p = planets[i];
        // Outside the star, with room to spare.
        expect(p.orbit.semiMajorAxis * (1 - p.orbit.eccentricity)).toBeGreaterThan(sys.star.radius * 4);
        expect(p.soiRadius).toBeGreaterThan(p.radius * 2);
        if (p.atmosphere) expect(p.soiRadius).toBeGreaterThan(p.radius + p.atmosphere.height);
        // Neighbouring spheres of influence never overlap.
        if (i > 0) {
          const prev = planets[i - 1];
          const gap = p.orbit.semiMajorAxis * (1 - p.orbit.eccentricity) - prev.orbit.semiMajorAxis * (1 + prev.orbit.eccentricity);
          expect(gap).toBeGreaterThan(p.soiRadius + prev.soiRadius);
        }
      }
      for (const moon of sys.bodies.filter((b) => b.kind === 'moon')) {
        const parent = sys.bodies.find((b) => b.id === moon.parentId)!;
        expect(parent.moonIds).toContain(moon.id);
        expect(moon.radius).toBeLessThan(parent.radius);
        const apo = moon.orbit.semiMajorAxis * (1 + moon.orbit.eccentricity);
        const peri = moon.orbit.semiMajorAxis * (1 - moon.orbit.eccentricity);
        expect(peri - moon.soiRadius).toBeGreaterThan(parent.radius + (parent.atmosphere?.height ?? 0));
        if (parent.rings) expect(peri).toBeGreaterThan(parent.rings.outerRadius);
        expect(apo + moon.soiRadius).toBeLessThan(parent.soiRadius);
      }
      for (const st of sys.stations) {
        const parent = sys.bodies.find((b) => b.id === st.parentId)!;
        expect(st.orbit.semiMajorAxis).toBeGreaterThan(parent.radius + (parent.atmosphere?.height ?? 0) + st.radius);
        expect(st.orbit.semiMajorAxis).toBeLessThan(parent.soiRadius);
      }
    }
  });

  it('usually contains a habitable world', () => {
    const living = SEEDS.filter((s) => generateSystem(s).bodies.some((b) => b.type === 'terran' || b.type === 'ocean'));
    expect(living.length / SEEDS.length).toBeGreaterThan(0.6);
  });
});

describe('orbits', () => {
  it('solves Kepler accurately', () => {
    for (const e of [0, 0.1, 0.5, 0.9]) {
      for (let M = 0; M < Math.PI * 2; M += 0.37) {
        const E = eccentricAnomaly(M, e);
        expect(E - e * Math.sin(E)).toBeCloseTo(M, 9);
      }
    }
  });

  it('returns to the same position after one period', () => {
    const sys = generateSystem(42);
    for (const b of sys.bodies) {
      const p0 = orbitPosition(b.orbit, 1234);
      const p1 = orbitPosition(b.orbit, 1234 + b.orbit.period);
      expect(p0.distanceTo(p1) / b.orbit.semiMajorAxis).toBeLessThan(1e-9);
      const r = p0.length();
      expect(r).toBeGreaterThanOrEqual(b.orbit.semiMajorAxis * (1 - b.orbit.eccentricity) - 1e-6);
      expect(r).toBeLessThanOrEqual(b.orbit.semiMajorAxis * (1 + b.orbit.eccentricity) + 1e-6);
    }
  });

  it('circular orbit stays at constant radius', () => {
    const orbit = { semiMajorAxis: 1e7, eccentricity: 0, inclination: 0.1, ascendingNode: 1, argPeriapsis: 2, meanAnomalyAtEpoch: 0, period: 100 };
    for (let t = 0; t < 100; t += 7) expect(orbitPosition(orbit, t, new THREE.Vector3()).length()).toBeCloseTo(1e7, 3);
  });
});
