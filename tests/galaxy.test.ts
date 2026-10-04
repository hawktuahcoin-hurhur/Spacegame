import { describe, expect, it } from 'vitest';
import { GALAXY_STAR_COUNT, MIN_STAR_SPACING, generateGalaxy, jumpComponents, starDistance } from '../src/galaxy/galaxyGen';
import { JumpGraph, jumpFuelCost } from '../src/galaxy/route';
import { generateSystem } from '../src/galaxy/systemGen';

const galaxy = generateGalaxy(1337);

describe('generateGalaxy', () => {
  it('is deterministic', () => {
    expect(JSON.stringify(generateGalaxy(99))).toBe(JSON.stringify(generateGalaxy(99)));
  });

  it('places the full star count with minimum spacing', () => {
    expect(galaxy.stars.length).toBeGreaterThan(GALAXY_STAR_COUNT * 0.9);
    expect(galaxy.stars.length).toBeLessThan(GALAXY_STAR_COUNT * 1.15);
    const s = galaxy.stars;
    for (let i = 0; i < s.length; i++)
      for (let j = i + 1; j < s.length; j++) expect(starDistance(s[i], s[j])).toBeGreaterThanOrEqual(MIN_STAR_SPACING - 1e-9);
  });

  it('agrees with the systems players arrive in', () => {
    for (const st of galaxy.stars.slice(0, 40)) {
      const sys = generateSystem(st.seed);
      expect(sys.name).toBe(st.name);
      expect(sys.star.spectralClass).toBe(st.spectralClass);
      expect(sys.star.temperature).toBe(st.temperature);
    }
  });

  it('is mostly reachable at a typical jump range', () => {
    for (const seed of [1337, 1, 2, 3, 42]) {
      const g = generateGalaxy(seed);
      const comp = jumpComponents(g.stars, 12);
      const startComp = comp[g.startIndex];
      const reachable = comp.filter((c) => c === startComp).length;
      expect(reachable / g.stars.length).toBeGreaterThan(0.95);
    }
  });

  it('starts somewhere habitable with a station', () => {
    const start = galaxy.stars[galaxy.startIndex];
    const sys = generateSystem(start.seed);
    expect(sys.stations.length).toBe(1);
    expect(sys.bodies.some((b) => b.type === 'terran' || b.type === 'ocean')).toBe(true);
    expect(start.region).toBe('frontier');
  });

  it('assigns nebula membership consistently', () => {
    for (const s of galaxy.stars) {
      if (s.nebula >= 0) expect(starDistance(s, galaxy.nebulae[s.nebula])).toBeLessThan(galaxy.nebulae[s.nebula].radius);
    }
  });
});

describe('JumpGraph', () => {
  const graph = new JumpGraph(galaxy, 12);

  it('plots routes whose hops are within range and fuel adds up', () => {
    const from = galaxy.startIndex;
    let checked = 0;
    for (const to of [0, 50, 100, 200, 400, 600]) {
      const route = graph.plot(from, to);
      if (!route) continue;
      checked++;
      expect(route.stars[0]).toBe(from);
      expect(route.stars[route.stars.length - 1]).toBe(to);
      for (const h of route.hops) {
        expect(h.distance).toBeLessThanOrEqual(12 + 1e-9);
        expect(h.fuel).toBeCloseTo(jumpFuelCost(h.distance, galaxy.stars[h.to].nebula >= 0), 9);
      }
      expect(route.totalFuel).toBeCloseTo(route.hops.reduce((a, h) => a + h.fuel, 0), 9);
    }
    expect(checked).toBeGreaterThan(3);
  });

  it('finds the minimum number of jumps (matches BFS)', () => {
    const from = galaxy.startIndex;
    const dist = new Map<number, number>([[from, 0]]);
    const q = [from];
    while (q.length) {
      const c = q.shift()!;
      for (const n of graph.neighbours[c]) if (!dist.has(n.index)) (dist.set(n.index, dist.get(c)! + 1), q.push(n.index));
    }
    for (const to of [10, 120, 333, 512]) {
      const r = graph.plot(from, to);
      expect(r ? r.hops.length : undefined).toBe(dist.get(to));
    }
  });

  it('returns null when unreachable', () => {
    const tiny = new JumpGraph(galaxy, 1);
    expect(tiny.plot(0, 1)).toBeNull();
  });
});
