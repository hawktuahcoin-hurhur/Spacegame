import { beforeAll, describe, expect, it } from 'vitest';
import { Campaign } from '../src/campaign/campaign';
import { COMMODITIES, FACTIONS, INDEPENDENT, NC, PIRATES, ci, fi, standing, validateCampaignContent } from '../src/campaign/defs';
import { priceAt, quote } from '../src/campaign/economy';
import { generateBoard } from '../src/campaign/missions';
import {
  acceptMission,
  buy,
  contraband,
  dockingAllowed,
  expireMissions,
  hostileTo,
  legality,
  marketLines,
  missionsOnArrive,
  missionsOnDock,
  sell,
  takeCommission,
  tariffFor,
} from '../src/campaign/trade';
import { Rng } from '../src/core/rng';
import { type GalaxyDef, generateGalaxy } from '../src/galaxy/galaxyGen';
import { cargoFree, newPlayer } from '../src/player';
import { hasHull } from '../src/ships/defs';
import { createShip } from '../src/ships/fleet';
import { refreshLogistics } from '../src/player';

let galaxy: GalaxyDef;
let base: Campaign;

beforeAll(() => {
  galaxy = generateGalaxy(1337);
  base = Campaign.create(galaxy, 30);
});

/** A rich player with a big freighter. */
function trader() {
  const p = newPlayer();
  const ship = createShip('atlas', 'Hauler', 'h1');
  p.fleet = { ships: [ship], flagshipId: ship.id };
  p.credits = 5_000_000;
  p.supplies = 0;
  refreshLogistics(p);
  return p;
}

describe('content', () => {
  it('is valid', () => {
    expect(COMMODITIES.length).toBe(16);
    expect(FACTIONS.length).toBe(6);
    expect(validateCampaignContent(hasHull)).toEqual([]);
    expect(standing(-60).label).toBe('Hostile');
    expect(standing(30).label).toBe('Friendly');
  });
});

describe('territory & markets', () => {
  it('gives every faction land and starts the player in friendly space', () => {
    for (let f = 0; f < FACTIONS.length; f++) expect(base.territory(f)).toBeGreaterThan(5);
    const startOwner = base.owner[galaxy.startIndex];
    expect([fi('league'), INDEPENDENT]).toContain(startOwner);
    expect(base.pirateBases.length).toBeGreaterThan(2);
    for (const b of base.pirateBases) expect(base.owner[b]).toBe(PIRATES);
  });

  it('builds a market in every system with sensible industries', () => {
    expect(base.markets.length).toBe(galaxy.stars.length);
    for (const m of base.markets) {
      expect(m.pop).toBeGreaterThanOrEqual(1);
      expect(m.pop).toBeLessThanOrEqual(10);
      expect(m.industries.length).toBeGreaterThan(0);
    }
    const capital = base.capitals[fi('hegemony')];
    expect(base.markets[capital].pop).toBeGreaterThanOrEqual(8);
  });

  it('is deterministic for a galaxy seed', () => {
    const again = Campaign.create(galaxy, 30);
    expect([...again.owner]).toEqual([...base.owner]);
    expect(again.states[17].stock[3]).toBeCloseTo(base.states[17].stock[3]);
  });
});

describe('pricing', () => {
  it('is cheap where goods pile up and dear where they are short', () => {
    const st = base.states[0];
    const k = ci('food');
    expect(priceAt(st, k, st.target[k] * 3)).toBeLessThan(COMMODITIES[k].price);
    expect(priceAt(st, k, st.target[k] * 0.2)).toBeGreaterThan(COMMODITIES[k].price);
  });

  it('charges more per unit for big trades (walks the curve)', () => {
    const st = base.states[5];
    const k = ci('metals');
    const one = quote(st, k, 1, 'buy', 0);
    const many = quote(st, k, 500, 'buy', 0);
    expect(many / 500).toBeGreaterThan(one * 0.99);
    expect(quote(st, k, 500, 'sell', 0) / 500).toBeLessThan(quote(st, k, 1, 'sell', 0) + 1);
  });
});

/** Find the most profitable 400-unit run between two nearby markets (as a trader would, from price intel). */
function findRoute(c: Campaign, p: ReturnType<typeof trader>) {
  let best = { from: -1, to: -1, k: -1, profit: 0 };
  for (const k of ['food', 'water', 'ore', 'metals', 'domestic', 'organics', 'volatiles'].map(ci)) {
    for (let from = 0; from < c.markets.length; from += 2) {
      if (c.owner[from] === PIRATES || c.states[from].stock[k] < 450) continue;
      const cost = quote(c.states[from], k, 400, 'buy', tariffFor(c, p, from));
      for (const to of c.near[from].slice(0, 25)) {
        if (c.owner[to] === PIRATES) continue;
        const profit = quote(c.states[to], k, 400, 'sell', 0) - cost;
        if (profit > best.profit) best = { from, to, k, profit };
      }
    }
  }
  return best;
}

describe('the Phase 5 demo: a trade route that dries up', () => {
  it('pays at first, then less and less as you flood the buyer', () => {
    const c = Campaign.restore(galaxy, base.snapshot());
    const p = trader();
    const r = findRoute(c, p);
    expect(r.from).toBeGreaterThanOrEqual(0);
    const rng = new Rng(1);
    const profits: number[] = [];
    for (let run = 0; run < 5; run++) {
      const before = p.credits;
      buy(c, p, r.from, r.k, 400, rng);
      sell(c, p, r.to, r.k, p.cargo[COMMODITIES[r.k].id] ?? 0, rng);
      profits.push(p.credits - before);
      // Two days for the round trip.
      c.tickDay();
      c.tickDay();
    }
    expect(profits[0]).toBeGreaterThan(2000);
    expect(profits[4]).toBeLessThan(profits[0] * 0.75);
  });

  it('recovers once you leave it alone', () => {
    const c = Campaign.restore(galaxy, base.snapshot());
    const p = trader();
    const r = findRoute(c, p);
    const rng = new Rng(2);
    const fresh = marketLines(c, p, r.to)[r.k].sell;
    buy(c, p, r.from, r.k, 800, rng);
    sell(c, p, r.to, r.k, 800, rng);
    const flooded = marketLines(c, p, r.to)[r.k].sell;
    expect(flooded).toBeLessThan(fresh);
    for (let d = 0; d < 40; d++) c.tickDay();
    expect(marketLines(c, p, r.to)[r.k].sell).toBeGreaterThan(flooded);
  });
});

describe('living galaxy', () => {
  it('runs convoys that move goods, and patrols', () => {
    const c = Campaign.restore(galaxy, base.snapshot());
    let convoys = 0;
    for (let d = 0; d < 10; d++) {
      c.tickDay();
      convoys = Math.max(convoys, c.fleets.filter((f) => f.kind === 'convoy').length);
    }
    expect(convoys).toBeGreaterThan(3);
    expect(c.fleets.some((f) => f.kind === 'patrol')).toBe(true);
    expect(c.events.length).toBeGreaterThan(0);
  });

  it('the Phase 6 demo: war breaks out and military prices spike on the front', () => {
    const p = trader();
    const heg = fi('hegemony');
    const asc = fi('ascendant');
    const peace = Campaign.restore(galaxy, base.snapshot());
    const war = Campaign.restore(galaxy, base.snapshot());
    for (const c of [peace, war]) {
      c.wars = [];
      c.updateFronts();
      // No other diplomacy during the comparison.
      c.baseRelations.fill(0);
      c.relations.fill(0);
    }
    war.declareWar(heg, asc);
    expect(war.atWar(heg, asc)).toBe(true);
    const front = [...war.front];
    expect(front.length).toBeGreaterThan(3);
    for (let d = 0; d < 10; d++) {
      peace.tickDay();
      war.tickDay();
    }
    const avg = (c: Campaign) => {
      let sum = 0;
      for (const s of front) for (const k of ['supplies', 'fuel', 'weapons'].map(ci)) sum += marketLines(c, p, s)[k].sell / COMMODITIES[k].price;
      return sum / (front.length * 3);
    };
    expect(avg(war)).toBeGreaterThan(avg(peace) * 1.2);
    expect(war.events.some((e) => e.kind === 'war' && e.major)).toBe(true);
  });

  it('snapshots and restores exactly', () => {
    const c = Campaign.restore(galaxy, base.snapshot());
    for (let d = 0; d < 7; d++) c.tickDay();
    const snap = JSON.parse(JSON.stringify(c.snapshot()));
    const r = Campaign.restore(galaxy, snap);
    expect(r.day).toBe(c.day);
    expect(r.fleets.length).toBe(c.fleets.length);
    r.tickDay();
    c.tickDay();
    expect(r.wars.length).toBe(c.wars.length);
    expect(r.states[40].stock[2]).toBeCloseTo(c.states[40].stock[2], 0);
  });

  it('ticks a day in a few milliseconds', () => {
    const c = Campaign.restore(galaxy, base.snapshot());
    const t0 = performance.now();
    for (let d = 0; d < 20; d++) c.tickDay();
    expect((performance.now() - t0) / 20).toBeLessThan(25);
  });
});

describe('law, reputation & commissions', () => {
  const owned = (f: string) => base.owner.findIndex((o) => o === fi(f));

  it('applies legality, tariffs and the black market', () => {
    const p = newPlayer();
    const heg = owned('hegemony');
    expect(legality(base, heg, 'drugs', null)).toBe('illegal');
    expect(legality(base, heg, 'weapons', null)).toBe('restricted');
    expect(legality(base, heg, 'weapons', 'hegemony')).toBe('legal');
    const lines = marketLines(base, p, heg);
    expect(lines[ci('drugs')].black).toBe(true);
    p.reputation.hegemony = 30;
    const friendly = tariffFor(base, p, heg);
    p.reputation.hegemony = -30;
    expect(tariffFor(base, p, heg)).toBeGreaterThan(friendly);
  });

  it('flags contraband for the faction that bans it', () => {
    const p = newPlayer();
    p.cargo = { drugs: 5, food: 10 };
    expect(contraband(p, fi('hegemony')).map((x) => x.commodity)).toEqual(['drugs']);
    expect(contraband(p, PIRATES)).toEqual([]);
  });

  it('hostile factions refuse docking and attack; commissions make enemies', () => {
    const c = Campaign.restore(galaxy, base.snapshot());
    const p = newPlayer();
    const heg = owned('hegemony');
    expect(dockingAllowed(c, p, heg).ok).toBe(true);
    p.reputation.hegemony = -60;
    expect(dockingAllowed(c, p, heg).ok).toBe(false);
    expect(hostileTo(c, p, fi('hegemony'))).toBe(true);
    expect(hostileTo(c, p, PIRATES)).toBe(true);
    const q = newPlayer();
    q.reputation.league = 20;
    c.wars = [];
    c.declareWar(fi('league'), fi('ascendant'));
    takeCommission(c, q, fi('league'));
    expect(q.commission).toBe('league');
    expect(hostileTo(c, q, fi('ascendant'))).toBe(true);
    expect(q.reputation.ascendant).toBeLessThanOrEqual(-55);
  });
});

describe('missions', () => {
  const ctx = (p: ReturnType<typeof newPlayer>) => ({
    rep: (f: string) => p.reputation[f] ?? 0,
    commission: p.commission,
    visited: p.visited,
    strength: 20,
    cargoSpace: cargoFree(p),
  });

  it('boards are stable within a period and offer varied work', () => {
    const p = trader();
    const types = new Set<string>();
    for (let s = 0; s < 120; s += 3) {
      const a = generateBoard(base, s, 0, ctx(p));
      expect(generateBoard(base, s, 0, ctx(p))).toEqual(a);
      for (const m of a) {
        types.add(m.type);
        expect(m.reward).toBeGreaterThan(0);
        expect(m.deadline).toBeGreaterThan(base.day);
      }
    }
    for (const t of ['delivery', 'procure', 'bounty', 'survey']) expect(types).toContain(t);
  });

  it('deliveries pay on docking, surveys on arrival, late jobs fail', () => {
    const c = Campaign.restore(galaxy, base.snapshot());
    const p = trader();
    let board = generateBoard(c, 0, 0, ctx(p));
    for (let s = 1; !board.some((m) => m.type === 'delivery') && s < 300; s++) board = generateBoard(c, s, 0, ctx(p));
    const job = board.find((m) => m.type === 'delivery')!;
    expect(acceptMission(p, job).ok).toBe(true);
    const space = cargoFree(p);
    expect(space).toBeLessThan(p.suppliesCapacity);
    const before = p.credits;
    const u = missionsOnDock(c, p, job.dest);
    expect(u.completed).toHaveLength(1);
    expect(p.credits).toBeGreaterThan(before);
    expect(p.contacts[`${job.giver.name}|${job.giver.faction}`].jobs).toBe(1);

    const survey = { ...job, id: 'sv', type: 'survey' as const, dest: 99 };
    acceptMission(p, survey);
    expect(missionsOnArrive(p, 99).completed).toHaveLength(1);

    const late = { ...job, id: 'late', deadline: c.day - 1 };
    acceptMission(p, late);
    const repBefore = p.reputation[job.giver.faction];
    expect(expireMissions(c, p).failed).toHaveLength(1);
    expect(p.reputation[job.giver.faction]).toBeLessThan(repBefore);
  });
});
void NC;
