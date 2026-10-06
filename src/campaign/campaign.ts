import { Rng } from '../core/rng';
import { type GalaxyDef, starDistance } from '../galaxy/galaxyGen';
import { JumpGraph } from '../galaxy/route';
import { generateSystem } from '../galaxy/systemGen';
import { COMMODITIES, FACTIONS, INDEPENDENT, NC, NF, PIRATES, ci, fi } from './defs';
import { type Condition, type MarketDef, type MarketState, computeFlows, generateMarket, initMarketState, marketSize, tickMarket } from './economy';
import { assignTerritory } from './territory';

export interface War {
  a: number;
  b: number;
  since: number;
  weariness: number;
}

export type FleetKind = 'convoy' | 'patrol' | 'raid' | 'invasion';

/** An NPC fleet moving across the galaxy, one jump per day. */
export interface NpcFleet {
  id: number;
  faction: number;
  kind: FleetKind;
  /** Star indices; the fleet is at route[leg] today. */
  route: number[];
  leg: number;
  /** Convoy cargo: commodity index and units. */
  cargo: number;
  amount: number;
  /** Combat strength (fleet points). */
  strength: number;
}

export type EventKind = 'war' | 'peace' | 'raid' | 'captured' | 'shortage' | 'boom' | 'convoy' | 'incident' | 'unrest';

export interface IntelEvent {
  day: number;
  kind: EventKind;
  text: string;
  star: number;
  factions: number[];
  /** Big news: shown as a toast wherever you are. */
  major: boolean;
}

export interface CampaignSnapshot {
  day: number;
  rng: number;
  owner: number[];
  relations: number[];
  wars: War[];
  fleets: NpcFleet[];
  events: IntelEvent[];
  nextFleetId: number;
  raided: [number, number][];
  markets: { stock: number[]; stability: number; conditions: Condition[] }[];
}

/** How many days a raided system stays "hot" with pirate activity. */
const RAID_HEAT_DAYS = 8;
const CONVOY_CAP = 48;
const NEAR_LY = 30;

/** Starting attitudes (symmetric). */
const BASE_RELATIONS: [string, string, number][] = [
  ['hegemony', 'tricorp', -15],
  ['hegemony', 'league', 10],
  ['hegemony', 'ascendant', -52],
  ['hegemony', 'independent', 5],
  ['tricorp', 'league', -20],
  ['tricorp', 'ascendant', -35],
  ['tricorp', 'independent', 10],
  ['league', 'ascendant', -25],
  ['league', 'independent', 25],
  ['ascendant', 'independent', -10],
];

/**
 * The galaxy's living state (SUPERPLAN Phases 5–6): markets, territory,
 * diplomacy, NPC fleets and the news. Pure and deterministic for a galaxy
 * seed; advanced one day at a time as in-game days pass.
 */
export class Campaign {
  readonly markets: MarketDef[];
  readonly states: MarketState[];
  readonly owner: Int8Array;
  readonly capitals: number[];
  readonly pirateBases: number[];
  /** relations[a * NF + b], −100..100. */
  readonly relations: Float64Array;
  readonly baseRelations: Float64Array;
  wars: War[] = [];
  fleets: NpcFleet[] = [];
  events: IntelEvent[] = [];
  day = 0;
  /** Star → last day pirates raided it. */
  readonly raided = new Map<number, number>();
  readonly graph: JumpGraph;
  /** Markets within NEAR_LY, nearest first. */
  readonly near: number[][];
  /** Systems on a front line (a warring enemy within reach). */
  front = new Set<number>();
  private rng: Rng;
  private nextFleetId = 1;
  /** New events since the game last drained them (for toasts). */
  fresh: IntelEvent[] = [];

  constructor(readonly galaxy: GalaxyDef) {
    const t = assignTerritory(galaxy);
    this.owner = t.owner;
    this.capitals = t.capitals;
    this.pirateBases = t.pirateBases;
    this.rng = new Rng(Rng.derive(galaxy.seed, 4242));
    this.markets = galaxy.stars.map((s) => generateMarket(s, generateSystem(s.seed), FACTIONS[t.owner[s.index]].id, t.capitals.includes(s.index)));
    this.states = this.markets.map((m) => initMarketState(m, this.rng));
    this.relations = new Float64Array(NF * NF);
    for (const [a, b, v] of BASE_RELATIONS) this.setRelation(fi(a), fi(b), v);
    for (let f = 0; f < NF; f++) if (f !== PIRATES) this.setRelation(f, PIRATES, -80);
    for (let f = 0; f < NF; f++) this.relations[f * NF + f] = 100;
    this.baseRelations = this.relations.slice();
    this.graph = new JumpGraph(galaxy, 12);
    const stars = galaxy.stars;
    this.near = stars.map((s) =>
      stars
        .filter((o) => o.index !== s.index && Math.abs(o.x - s.x) < NEAR_LY && starDistance(o, s) < NEAR_LY)
        .sort((a, b) => starDistance(a, s) - starDistance(b, s))
        .map((o) => o.index),
    );
    this.spawnPatrols();
  }

  /** A new campaign with a few weeks of history behind it, so trade flows and news exist on day one. */
  static create(galaxy: GalaxyDef, burnIn = 30): Campaign {
    const c = new Campaign(galaxy);
    for (let i = 0; i < burnIn; i++) c.tickDay();
    c.day = 0;
    for (const e of c.events) e.day -= burnIn;
    for (const w of c.wars) w.since -= burnIn;
    for (const [k, v] of c.raided) c.raided.set(k, v - burnIn);
    c.fresh = [];
    return c;
  }

  // ---------------------------------------------------------------- queries

  relation(a: number, b: number): number {
    return this.relations[a * NF + b];
  }

  setRelation(a: number, b: number, v: number): void {
    v = Math.max(-100, Math.min(100, v));
    this.relations[a * NF + b] = v;
    this.relations[b * NF + a] = v;
  }

  atWar(a: number, b: number): boolean {
    if (a === b) return false;
    if (a === PIRATES || b === PIRATES) return true;
    return this.wars.some((w) => (w.a === a && w.b === b) || (w.a === b && w.b === a));
  }

  warsOf(f: number): number[] {
    return this.wars.filter((w) => w.a === f || w.b === f).map((w) => (w.a === f ? w.b : w.a));
  }

  /** Fleets present in a system today. */
  fleetsAt(star: number): NpcFleet[] {
    return this.fleets.filter((f) => f.route[f.leg] === star);
  }

  /** Pirates are active here: a recent raid, a raid fleet present, or a haven nearby. */
  pirateActivity(star: number): number {
    let heat = 0;
    const last = this.raided.get(star);
    if (last !== undefined && this.day - last < RAID_HEAT_DAYS) heat += 1;
    if (this.fleetsAt(star).some((f) => f.faction === PIRATES)) heat += 1;
    if (this.owner[star] === PIRATES) heat += 0.5;
    else if (this.pirateBases.some((b) => starDistance(this.galaxy.stars[b], this.galaxy.stars[star]) < 25)) heat += 0.5;
    return heat;
  }

  territory(f: number): number {
    let n = 0;
    for (const o of this.owner) if (o === f) n++;
    return n;
  }

  /** Military and economic weight of a faction. */
  strength(f: number): number {
    let s = 0;
    for (let i = 0; i < this.owner.length; i++) if (this.owner[i] === f) s += marketSize(this.markets[i].pop);
    return s;
  }

  distance(a: number, b: number): number {
    return starDistance(this.galaxy.stars[a], this.galaxy.stars[b]);
  }

  private news(kind: EventKind, text: string, star: number, factions: number[], major = false): void {
    const e: IntelEvent = { day: this.day, kind, text, star, factions, major };
    this.events.unshift(e);
    if (this.events.length > 160) this.events.length = 160;
    this.fresh.push(e);
  }

  // ---------------------------------------------------------------- time

  /** Advance whole days until `day`. Returns the events that happened. */
  advanceTo(day: number): IntelEvent[] {
    const out: IntelEvent[] = [];
    let guard = 0;
    while (this.day < day && guard++ < 400) {
      const before = this.fresh.length;
      this.tickDay();
      out.push(...this.fresh.slice(before));
    }
    return out;
  }

  tickDay(): void {
    this.day++;
    for (let i = 0; i < this.markets.length; i++) tickMarket(this.markets[i], this.states[i]);
    this.moveFleets();
    this.spawnConvoys();
    this.randomEvents();
    if (this.day % 3 === 0) this.strategic();
    this.fresh.length = Math.min(this.fresh.length, 200);
  }

  // ---------------------------------------------------------------- fleets

  private addFleet(f: Omit<NpcFleet, 'id' | 'leg'>): NpcFleet | null {
    if (f.route.length < 1) return null;
    const fleet: NpcFleet = { ...f, id: this.nextFleetId++, leg: 0 };
    this.fleets.push(fleet);
    return fleet;
  }

  private plot(from: number, to: number, maxHops = 6): number[] | null {
    const r = this.graph.plot(from, to);
    if (!r || r.stars.length - 1 > maxHops) return null;
    return r.stars;
  }

  private spawnPatrols(): void {
    for (let f = 0; f < NF; f++) {
      if (!FACTIONS[f].military && f !== INDEPENDENT) continue;
      const own = this.ownedBy(f);
      const want = Math.ceil(own.length / (f === INDEPENDENT ? 30 : 12));
      for (let i = 0; i < want && own.length; i++) {
        const at = this.rng.pick(own);
        this.addFleet({ faction: f, kind: 'patrol', route: [at], cargo: -1, amount: 0, strength: this.rng.range(20, 60) });
      }
    }
  }

  private ownedBy(f: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.owner.length; i++) if (this.owner[i] === f) out.push(i);
    return out;
  }

  private moveFleets(): void {
    const keep: NpcFleet[] = [];
    for (const f of this.fleets) {
      if (f.leg < f.route.length - 1) {
        f.leg++;
        const here = f.route[f.leg];
        // Convoys crossing pirate-infested space can be hit.
        if (f.kind === 'convoy' && f.leg < f.route.length - 1 && this.pirateActivity(here) >= 1 && this.rng.next() < 0.25) {
          this.news('convoy', `A ${FACTIONS[f.faction].short} convoy carrying ${COMMODITIES[f.cargo].name.toLowerCase()} was raided by pirates near ${this.galaxy.stars[here].name}.`, here, [f.faction, PIRATES]);
          continue;
        }
        if (f.leg < f.route.length - 1) {
          keep.push(f);
          continue;
        }
      }
      // Arrived (or idle).
      if (this.arrive(f)) keep.push(f);
    }
    this.fleets = keep;
  }

  /** Handle a fleet reaching the end of its route. Returns true to keep it. */
  private arrive(f: NpcFleet): boolean {
    const here = f.route[f.route.length - 1];
    const st = this.states[here];
    switch (f.kind) {
      case 'convoy':
        if (f.cargo >= 0) st.stock[f.cargo] += f.amount;
        return false;
      case 'patrol': {
        if (this.owner[here] !== f.faction && !this.ownedBy(f.faction).length) return false;
        // Next leg: somewhere else in their space, preferring the front.
        const own = this.near[here].filter((i) => this.owner[i] === f.faction).slice(0, 14);
        const front = own.filter((i) => this.front.has(i));
        const pool = front.length && this.rng.next() < 0.6 ? front : own;
        const dest = pool.length ? this.rng.pick(pool) : here;
        f.route = this.plot(here, dest, 4) ?? [here];
        f.leg = 0;
        return true;
      }
      case 'raid':
        this.raidSystem(here, f.faction);
        return false;
      case 'invasion':
        this.invade(here, f);
        return false;
    }
  }

  private raidSystem(star: number, by: number): void {
    const st = this.states[star];
    const victims: string[] = [];
    for (let k = 0; k < 3; k++) {
      const c = this.rng.int(0, NC - 1);
      st.stock[c] *= 0.55;
      victims.push(COMMODITIES[c].name.toLowerCase());
    }
    st.stability = Math.max(0, st.stability - 2.5);
    this.raided.set(star, this.day);
    const name = this.galaxy.stars[star].name;
    const who = by === PIRATES ? 'Pirates' : `${FACTIONS[by].short} raiders`;
    this.news('raid', `${who} hit ${this.markets[star].name} in ${name}, looting ${[...new Set(victims)].join(', ')}.`, star, [by, this.owner[star]], by !== PIRATES);
  }

  private invade(star: number, f: NpcFleet): void {
    const def = this.owner[star];
    if (def === f.faction || !this.atWar(def, f.faction)) return;
    const defence = (marketSize(this.markets[star].pop) / 4) * (this.markets[star].industries.includes('military') ? 6 : 2.5) + 10;
    const name = this.galaxy.stars[star].name;
    if (this.rng.next() < f.strength / (f.strength + defence)) {
      this.owner[star] = f.faction;
      const st = this.states[star];
      st.stability = 1.5;
      st.conditions.push({ id: 'occupation', text: 'Recently occupied: production disrupted', commodity: -1, prodMult: 0.6, consMult: 1, days: 20 });
      this.news('captured', `${FACTIONS[f.faction].name} forces have captured ${name} from the ${FACTIONS[def].short}.`, star, [f.faction, def], true);
      for (const w of this.wars) if ((w.a === def && w.b === f.faction) || (w.b === def && w.a === f.faction)) w.weariness += 3;
    } else {
      this.states[star].stability = Math.max(0, this.states[star].stability - 1.5);
      this.news('incident', `A ${FACTIONS[f.faction].short} assault on ${name} was beaten back by ${FACTIONS[def].short} defenders.`, star, [f.faction, def], true);
      for (const w of this.wars) if ((w.a === def && w.b === f.faction) || (w.b === def && w.a === f.faction)) w.weariness += 2;
    }
  }

  /** Move surplus to nearby shortages with real convoys. */
  private spawnConvoys(): void {
    let active = this.fleets.filter((f) => f.kind === 'convoy').length;
    for (let attempt = 0; attempt < 40 && active < CONVOY_CAP; attempt++) {
      const from = this.rng.int(0, this.markets.length - 1);
      const st = this.states[from];
      const c = this.rng.int(0, NC - 1);
      if (st.prod[c] <= 0 || st.stock[c] < st.target[c] * 1.3) continue;
      const of = this.owner[from];
      if (of === PIRATES && this.rng.next() < 0.7) continue;
      let best = -1;
      let bestNeed = 0.6;
      for (const to of this.near[from].slice(0, 40)) {
        const ds = this.states[to];
        if (ds.cons[c] <= 0) continue;
        const need = ds.stock[c] / ds.target[c];
        if (need >= bestNeed || this.atWar(of, this.owner[to])) continue;
        bestNeed = need;
        best = to;
      }
      if (best < 0) continue;
      const route = this.plot(from, best, 5);
      if (!route) continue;
      const ds = this.states[best];
      const amount = Math.min(st.stock[c] - st.target[c] * 0.9, ds.target[c] - ds.stock[c], 800);
      if (amount < 10) continue;
      st.stock[c] -= amount;
      this.addFleet({ faction: of, kind: 'convoy', route, cargo: c, amount, strength: 8 + amount / 40 });
      active++;
    }
  }

  // ---------------------------------------------------------------- local events

  private randomEvents(): void {
    for (let i = 0; i < 3; i++) {
      if (this.rng.next() > 0.5) continue;
      const star = this.rng.int(0, this.markets.length - 1);
      const m = this.markets[star];
      const st = this.states[star];
      const roll = this.rng.next();
      const name = this.galaxy.stars[star].name;
      if (roll < 0.35 && m.industries.includes('farming')) {
        st.conditions.push({ id: 'blight', text: 'Crop blight: food output collapsed', commodity: ci('food'), prodMult: 0.25, consMult: 1, days: this.rng.int(10, 20) });
        this.news('shortage', `Crop blight on ${name}: food prices are climbing at ${m.name}.`, star, [this.owner[star]]);
      } else if (roll < 0.55 && m.industries.includes('mining')) {
        st.conditions.push({ id: 'accident', text: 'Mining disaster: ore output down', commodity: ci('ore'), prodMult: 0.3, consMult: 1, days: this.rng.int(8, 16) });
        this.news('shortage', `A mining disaster at ${name} has halted ore shipments.`, star, [this.owner[star]]);
      } else if (roll < 0.75 && m.pop >= 4) {
        const c = this.rng.pick(['luxury', 'domestic', 'drugs', 'machinery']);
        st.conditions.push({ id: 'boom', text: `Boom: demand for ${COMMODITIES[ci(c)].name.toLowerCase()} up`, commodity: ci(c), prodMult: 1, consMult: 2.5, days: this.rng.int(10, 18) });
        this.news('boom', `${m.name} is booming — traders report strong demand for ${COMMODITIES[ci(c)].name.toLowerCase()}.`, star, [this.owner[star]]);
      } else if (roll < 0.85) {
        st.conditions.push({ id: 'strike', text: 'Labour unrest: industry slowed', commodity: -1, prodMult: 0.7, consMult: 1, days: this.rng.int(6, 12) });
        st.stability = Math.max(0, st.stability - 1.5);
        this.news('unrest', `Strikes and protests at ${m.name} (${name}) are slowing production.`, star, [this.owner[star]]);
      }
    }
  }

  // ---------------------------------------------------------------- strategy

  /** Every three days: diplomacy, wars, raids and invasions. */
  private strategic(): void {
    const majors = FACTIONS.map((f, i) => (f.military ? i : -1)).filter((i) => i >= 0);
    // Relations drift toward their base, with border incidents between rivals.
    for (const a of majors)
      for (const b of majors) {
        if (b <= a) continue;
        const base = this.baseRelations[a * NF + b];
        let v = this.relation(a, b);
        v += (base - v) * 0.03 + this.rng.range(-1.5, 1.5);
        if (base < 0 && this.rng.next() < 0.06 * (FACTIONS[a].aggression + FACTIONS[b].aggression)) {
          v -= this.rng.range(6, 14);
          const where = this.borderSystem(a, b);
          if (where >= 0) this.news('incident', `Border incident: ${FACTIONS[a].short} and ${FACTIONS[b].short} warships exchanged fire near ${this.galaxy.stars[where].name}.`, where, [a, b]);
        }
        this.setRelation(a, b, v);
        const war = this.wars.find((w) => (w.a === a && w.b === b) || (w.a === b && w.b === a));
        if (!war && v < -55 && this.rng.next() < 0.25 * Math.max(FACTIONS[a].aggression, FACTIONS[b].aggression)) this.declareWar(a, b);
      }
    // Wars: raids, invasions, weariness and peace.
    for (const w of [...this.wars]) {
      w.weariness += 0.6;
      if (w.weariness > 18 && this.rng.next() < 0.1) {
        this.makePeace(w);
        continue;
      }
      for (const [att, def] of [
        [w.a, w.b],
        [w.b, w.a],
      ]) {
        const targets = [...this.front].filter((s) => this.owner[s] === def);
        if (!targets.length) continue;
        const target = this.rng.pick(targets);
        const from = this.near[target].find((s) => this.owner[s] === att);
        if (from === undefined) continue;
        const route = this.plot(from, target, 4);
        if (!route) continue;
        const ratio = this.strength(att) / Math.max(1, this.strength(def));
        if (this.rng.next() < 0.5) this.addFleet({ faction: att, kind: 'raid', route, cargo: -1, amount: 0, strength: this.rng.range(30, 70) });
        if (this.rng.next() < 0.14 * Math.min(2, ratio)) this.addFleet({ faction: att, kind: 'invasion', route, cargo: -1, amount: 0, strength: this.rng.range(60, 140) * Math.min(1.6, ratio) });
      }
    }
    // Pirate raids out of the havens.
    for (const base of this.pirateBases) {
      if (this.owner[base] !== PIRATES || this.rng.next() > 0.3) continue;
      const targets = this.near[base].filter((s) => this.owner[s] !== PIRATES && this.distance(base, s) < 26);
      if (!targets.length) continue;
      const target = this.rng.pick(targets);
      const route = this.plot(base, target, 4);
      if (route) this.addFleet({ faction: PIRATES, kind: 'raid', route, cargo: -1, amount: 0, strength: this.rng.range(15, 45) });
    }
    this.updateFronts();
  }

  private borderSystem(a: number, b: number): number {
    for (let i = 0; i < this.owner.length; i++) if (this.owner[i] === a && this.near[i].slice(0, 8).some((j) => this.owner[j] === b)) return i;
    return -1;
  }

  declareWar(a: number, b: number): void {
    if (this.wars.some((w) => (w.a === a && w.b === b) || (w.a === b && w.b === a))) return;
    this.wars.push({ a, b, since: this.day, weariness: 0 });
    this.setRelation(a, b, Math.min(this.relation(a, b), -70));
    const where = this.borderSystem(a, b);
    this.news('war', `WAR: the ${FACTIONS[a].name} has declared war on the ${FACTIONS[b].name}. Military demand for supplies, fuel and weapons is surging along the front.`, Math.max(0, where), [a, b], true);
    this.updateFronts();
  }

  makePeace(w: War): void {
    this.wars = this.wars.filter((x) => x !== w);
    this.setRelation(w.a, w.b, -35);
    this.news('peace', `Ceasefire: the ${FACTIONS[w.a].short} and ${FACTIONS[w.b].short} have signed a peace treaty.`, Math.max(0, this.borderSystem(w.a, w.b)), [w.a, w.b], true);
    this.updateFronts();
  }

  /** Recompute front lines and wartime demand. */
  updateFronts(): void {
    this.front.clear();
    const atWar = new Set<number>();
    for (const w of this.wars) {
      atWar.add(w.a).add(w.b);
      for (let i = 0; i < this.owner.length; i++) {
        const o = this.owner[i];
        if (o !== w.a && o !== w.b) continue;
        const enemy = o === w.a ? w.b : w.a;
        if (this.near[i].some((j) => this.owner[j] === enemy && this.distance(i, j) < 16)) this.front.add(i);
      }
    }
    for (let i = 0; i < this.states.length; i++) this.states[i].warDemand = this.front.has(i) ? 3.2 : atWar.has(this.owner[i]) ? 1.6 : 1;
  }

  // ---------------------------------------------------------------- persistence

  snapshot(): CampaignSnapshot {
    const r = (n: number) => Math.round(n * 10) / 10;
    return {
      day: this.day,
      rng: this.rng.stateValue,
      owner: [...this.owner],
      relations: [...this.relations].map(r),
      wars: this.wars.map((w) => ({ ...w })),
      fleets: this.fleets.map((f) => ({ ...f, route: [...f.route], amount: r(f.amount), strength: r(f.strength) })),
      events: this.events.slice(0, 120),
      nextFleetId: this.nextFleetId,
      raided: [...this.raided],
      markets: this.states.map((s) => ({ stock: [...s.stock].map(r), stability: r(s.stability), conditions: s.conditions.map((c) => ({ ...c })) })),
    };
  }

  /** Rebuild from a snapshot (markets regenerate from the seed; only the dynamic state is saved). */
  static restore(galaxy: GalaxyDef, snap: CampaignSnapshot): Campaign {
    const c = new Campaign(galaxy);
    c.day = snap.day;
    c.rng.stateValue = snap.rng;
    if (snap.owner.length === c.owner.length) c.owner.set(snap.owner);
    if (snap.relations.length === c.relations.length) c.relations.set(snap.relations);
    c.wars = snap.wars.filter((w) => w.a < NF && w.b < NF);
    c.fleets = snap.fleets.filter((f) => f.route.every((s) => s >= 0 && s < galaxy.stars.length) && f.faction < NF);
    c.events = snap.events;
    c.nextFleetId = snap.nextFleetId;
    for (const [k, v] of snap.raided) c.raided.set(k, v);
    snap.markets.forEach((m, i) => {
      const st = c.states[i];
      if (!st || m.stock.length !== NC) return;
      st.stock.set(m.stock);
      st.stability = m.stability;
      st.conditions = m.conditions;
      computeFlows(c.markets[i], st);
    });
    c.updateFronts();
    return c;
  }
}
