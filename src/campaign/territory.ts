import { Rng } from '../core/rng';
import { type GalaxyDef, starDistance } from '../galaxy/galaxyGen';
import { FACTIONS, INDEPENDENT, PIRATES, fi } from './defs';

export interface Territory {
  /** Owning faction index per star. */
  owner: Int8Array;
  /** Capital star per faction (-1 if none). */
  capitals: number[];
  pirateBases: number[];
}

/** Faction reach: capitals project influence; weaker factions hold smaller realms. */
const REACH: Record<string, { power: number; range: number }> = {
  hegemony: { power: 1.35, range: 72 },
  tricorp: { power: 1.2, range: 60 },
  league: { power: 1.0, range: 50 },
  ascendant: { power: 1.0, range: 46 },
};

/**
 * Deterministic starting map: two core powers on opposite sides of the core,
 * the League around the player's start, the Ascendant Path across the
 * galaxy, pirate havens in the fringe and independents everywhere else.
 */
export function assignTerritory(g: GalaxyDef): Territory {
  const rng = new Rng(Rng.derive(g.seed, 31337));
  const stars = g.stars;
  const start = stars[g.startIndex];
  const capitals = FACTIONS.map(() => -1);
  const angle = (s: { x: number; z: number }) => Math.atan2(s.z, s.x);
  const core = stars.filter((s) => s.region === 'core' && Math.hypot(s.x, s.z) > 10);
  const frontier = stars.filter((s) => s.region === 'frontier');
  const startAngle = angle(start);
  const pickNear = (list: typeof stars, a: number, filter: (s: (typeof stars)[number]) => boolean = () => true) => {
    const cands = list.filter(filter).sort((p, q) => Math.abs(wrap(angle(p) - a)) - Math.abs(wrap(angle(q) - a)));
    return cands[rng.int(0, Math.min(3, cands.length - 1))];
  };
  // Hegemony faces the start side of the core; Tri-Corp the far side.
  capitals[fi('hegemony')] = pickNear(core, startAngle + rng.range(-0.6, 0.6)).index;
  capitals[fi('tricorp')] = pickNear(core, startAngle + Math.PI + rng.range(-0.6, 0.6)).index;
  // The League's capital is a few jumps from the start, so you begin in friendly space.
  const leagueCap = frontier
    .filter((s) => s.index !== start.index)
    .map((s) => ({ s, d: starDistance(s, start) }))
    .filter((e) => e.d > 14 && e.d < 34)
    .sort((a, b) => a.d - b.d);
  capitals[fi('league')] = (leagueCap[rng.int(0, Math.min(4, leagueCap.length - 1))] ?? leagueCap[0] ?? { s: start }).s.index;
  capitals[fi('ascendant')] = pickNear(frontier, startAngle + Math.PI * rng.range(0.55, 0.85) * (rng.next() < 0.5 ? 1 : -1)).index;

  const owner = new Int8Array(stars.length).fill(INDEPENDENT);
  for (const s of stars) {
    let best = -1;
    let bestScore = Infinity;
    for (const [id, r] of Object.entries(REACH)) {
      const cap = stars[capitals[fi(id)]];
      // A little noise so borders aren't perfect Voronoi lines.
      const d = starDistance(s, cap) * (1 + (hash(s.index * 31 + fi(id)) - 0.5) * 0.25);
      if (d > r.range) continue;
      const score = d / r.power;
      if (score < bestScore) {
        bestScore = score;
        best = fi(id);
      }
    }
    if (best >= 0) owner[s.index] = best;
  }
  owner[start.index] = owner[start.index] === fi('league') ? owner[start.index] : INDEPENDENT;

  // Pirate havens: deep fringe, well apart, away from the start.
  const bases: number[] = [];
  const fringe = stars.filter((s) => s.region === 'fringe' && starDistance(s, start) > 40 && owner[s.index] === INDEPENDENT);
  for (let guard = 0; guard < 400 && bases.length < 7 && fringe.length; guard++) {
    const s = rng.pick(fringe);
    if (bases.some((b) => starDistance(stars[b], s) < 34)) continue;
    bases.push(s.index);
  }
  for (const b of bases)
    for (const s of stars) if (owner[s.index] === INDEPENDENT && s.region === 'fringe' && starDistance(s, stars[b]) < 9) owner[s.index] = PIRATES;
  for (const b of bases) owner[b] = PIRATES;
  capitals[PIRATES] = bases[0] ?? -1;
  return { owner, capitals, pirateBases: bases };
}

function wrap(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  return (a < 0 ? a + Math.PI * 2 : a) - Math.PI;
}

function hash(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
