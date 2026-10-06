import { Rng } from '../core/rng';
import type { GalaxyStar } from '../galaxy/galaxyGen';
import type { StarSystemDef } from '../galaxy/types';
import { COMMODITIES, NC, ci } from './defs';

/**
 * The living market model (SUPERPLAN §3.6). Every station is a market with a
 * population and industries; each day industries turn inputs into outputs,
 * people consume, and stockpiles drift back toward normal through background
 * trade. Prices follow stock against a target, so hauling a hold of grain to
 * a starving world pays — until you've flooded it.
 */

export interface IndustryDef {
  id: string;
  name: string;
  /** Units per day per unit of market size. */
  inputs: Partial<Record<string, number>>;
  outputs: Partial<Record<string, number>>;
}

export const INDUSTRIES: Record<string, IndustryDef> = {
  farming: { id: 'farming', name: 'Farming', inputs: { machinery: 0.12 }, outputs: { food: 11, organics: 4 } },
  water: { id: 'water', name: 'Ice mining', inputs: {}, outputs: { water: 10 } },
  mining: { id: 'mining', name: 'Mining', inputs: { machinery: 0.25, supplies: 0.2 }, outputs: { ore: 10, rare_ore: 1.5 } },
  gas: { id: 'gas', name: 'Gas harvesting', inputs: { machinery: 0.15 }, outputs: { volatiles: 6 } },
  refining: { id: 'refining', name: 'Refining', inputs: { ore: 7, rare_ore: 1.2 }, outputs: { metals: 5, rare_metals: 0.8 } },
  fuel: { id: 'fuel', name: 'Fuel production', inputs: { volatiles: 3 }, outputs: { fuel: 16 } },
  heavy: { id: 'heavy', name: 'Heavy industry', inputs: { metals: 4, rare_metals: 0.4 }, outputs: { machinery: 1.6, supplies: 4, weapons: 0.7 } },
  light: { id: 'light', name: 'Light industry', inputs: { organics: 4 }, outputs: { domestic: 4, luxury: 0.4 } },
  labs: { id: 'labs', name: 'Drug labs', inputs: { organics: 1 }, outputs: { drugs: 0.8 } },
  military: { id: 'military', name: 'Military base', inputs: { supplies: 2.5, fuel: 3, weapons: 0.6 }, outputs: {} },
};

/** What every citizen uses per unit of market size per day. */
const PER_CAPITA: Record<string, number> = {
  food: 5,
  water: 4,
  domestic: 1.6,
  supplies: 0.8,
  fuel: 1.2,
  machinery: 0.08,
  luxury: 0.25,
  drugs: 0.2,
};

/** Days of combined flow a market likes to hold in stock. */
const BUFFER_DAYS = 20;
/** Daily pull of stock back toward target (abstract off-map trade). */
const REVERSION = 0.08;
/** How strongly price responds to stock vs target. */
const ELASTICITY = 0.55;
export const PRICE_MIN = 0.3;
export const PRICE_MAX = 4;
/** Bid/ask spread on top of tariffs. */
export const SPREAD = 0.05;

export interface MarketDef {
  /** Star index (one market per system, at its station). */
  index: number;
  name: string;
  system: string;
  /** Population size 1–10. */
  pop: number;
  industries: string[];
  /** Planet types present, for flavour text. */
  worlds: string[];
}

export interface Condition {
  id: string;
  text: string;
  /** Commodity index affected, or -1 for all. */
  commodity: number;
  prodMult: number;
  consMult: number;
  days: number;
}

export interface MarketState {
  stock: Float64Array;
  /** Base daily production and consumption before conditions (cached). */
  prod: Float64Array;
  cons: Float64Array;
  target: Float64Array;
  /** 0–10: raids and wars lower it; low stability cuts production. */
  stability: number;
  conditions: Condition[];
  /** Extra military demand (war) multiplier on supplies, fuel and weapons. */
  warDemand: number;
}

/** Economic weight of a population size (roughly exponential, like Starsector). */
export function marketSize(pop: number): number {
  return 4 * Math.pow(pop, 1.4);
}

/** Decide population and industries from the system's real planets. */
export function generateMarket(star: GalaxyStar, sys: StarSystemDef, factionId: string, capital: boolean): MarketDef {
  const rng = new Rng(Rng.derive(star.seed, 9001));
  const types = sys.bodies.map((b) => b.type);
  const has = (t: string) => types.includes(t as never);
  const home = sys.stations[0] ? sys.bodies.find((b) => b.id === sys.stations[0].parentId) : null;
  let pop = star.region === 'core' ? rng.int(5, 8) : star.region === 'frontier' ? rng.int(3, 6) : rng.int(1, 4);
  if (home && (home.type === 'terran' || home.type === 'ocean')) pop += 1;
  if (factionId === 'pirates') pop = Math.min(pop, rng.int(2, 4));
  if (capital) pop = Math.max(pop + 2, 8);
  pop = Math.max(1, Math.min(10, pop));
  const ind = new Set<string>();
  if (home && (home.type === 'terran' || home.type === 'ocean')) ind.add('farming');
  else if (has('terran') || has('ocean') || (has('desert') && rng.next() < 0.3)) ind.add('farming');
  if (has('ice') || has('ocean')) ind.add('water');
  if (has('barren') || has('lava') || has('desert') || sys.belts.length > 0) ind.add('mining');
  if (has('gasGiant') || has('toxic')) ind.add('gas');
  const regionBias = star.region === 'core' ? 0.75 : star.region === 'frontier' ? 0.45 : 0.15;
  if (pop >= 4 && (ind.has('mining') || rng.next() < regionBias * 0.5) && rng.next() < 0.4 + regionBias * 0.5) ind.add('refining');
  if (pop >= 3 && ind.has('gas') && rng.next() < 0.7) ind.add('fuel');
  if (pop >= 5 && rng.next() < regionBias) ind.add('heavy');
  if (pop >= 4 && rng.next() < 0.3 + regionBias * 0.5) ind.add('light');
  if ((factionId === 'pirates' || (factionId === 'independent' && star.region === 'fringe')) && rng.next() < 0.6) ind.add('labs');
  if (capital || (pop >= 6 && factionId !== 'independent' && factionId !== 'pirates' && rng.next() < 0.35)) ind.add('military');
  if (ind.size === 0) ind.add(has('gasGiant') ? 'gas' : 'mining');
  return {
    index: star.index,
    name: sys.stations[0]?.name ?? `${sys.name} Outpost`,
    system: sys.name,
    pop,
    industries: [...ind],
    worlds: [...new Set(types)],
  };
}

/** Fresh market state: stock at target, flows cached. */
export function initMarketState(def: MarketDef, rng: Rng): MarketState {
  const st: MarketState = {
    stock: new Float64Array(NC),
    prod: new Float64Array(NC),
    cons: new Float64Array(NC),
    target: new Float64Array(NC),
    stability: 7,
    conditions: [],
    warDemand: 1,
  };
  computeFlows(def, st);
  for (let c = 0; c < NC; c++) st.stock[c] = st.target[c] * rng.range(0.7, 1.3);
  return st;
}

/** Cache base production, consumption and target stock from population and industries. */
export function computeFlows(def: MarketDef, st: MarketState): void {
  const size = marketSize(def.pop);
  st.prod.fill(0);
  st.cons.fill(0);
  for (const id of def.industries) {
    const ind = INDUSTRIES[id];
    for (const [c, v] of Object.entries(ind.outputs)) st.prod[ci(c)] += v! * size * (c === 'luxury' && def.pop < 6 ? 0 : 1);
    for (const [c, v] of Object.entries(ind.inputs)) st.cons[ci(c)] += v! * size;
  }
  for (const [c, v] of Object.entries(PER_CAPITA)) {
    if (c === 'luxury' && def.pop < 4) continue;
    st.cons[ci(c)] += v * size;
  }
  for (let c = 0; c < NC; c++) st.target[c] = Math.max(25, BUFFER_DAYS * (st.prod[c] + st.cons[c]));
}

/** Effective production / consumption multipliers today. */
function mults(st: MarketState, c: number): [number, number] {
  let p = 1;
  let k = 1;
  for (const cond of st.conditions)
    if (cond.commodity < 0 || cond.commodity === c) {
      p *= cond.prodMult;
      k *= cond.consMult;
    }
  // Unrest hurts output.
  p *= 0.55 + 0.45 * Math.min(1, st.stability / 6);
  return [p, k];
}

/** Wartime requisitions per unit of market size per day, scaled by (warDemand − 1). */
const WAR_DEMAND: [number, number][] = [
  [ci('supplies'), 3],
  [ci('fuel'), 4],
  [ci('weapons'), 1.2],
];

/** One day of production, consumption and background trade. */
export function tickMarket(def: MarketDef, st: MarketState): void {
  // Industries run only as well as their inputs allow.
  let inputShare = 1;
  for (const id of def.industries) {
    for (const c of Object.keys(INDUSTRIES[id].inputs)) {
      const i = ci(c);
      inputShare = Math.min(inputShare, 0.35 + 0.65 * Math.min(1, st.stock[i] / Math.max(1, st.target[i] * 0.3)));
    }
  }
  const size = marketSize(def.pop);
  for (let c = 0; c < NC; c++) {
    const [pm, cm] = mults(st, c);
    let war = 0;
    if (st.warDemand > 1) for (const [k, v] of WAR_DEMAND) if (k === c) war = v * size * (st.warDemand - 1);
    const produced = st.prod[c] * pm * inputShare;
    const used = st.cons[c] * cm + war;
    const t = st.target[c];
    let s = st.stock[c] + produced - used + REVERSION * (t - st.stock[c]);
    // Spoilage and off-map exports cap gluts; the floor is zero.
    s = Math.min(s, t * 3.5);
    st.stock[c] = Math.max(0, s);
  }
  for (const cond of st.conditions) cond.days--;
  st.conditions = st.conditions.filter((c) => c.days > 0);
  st.stability += (7 - st.stability) * 0.05;
}

/** Mid price of commodity c at a given stock. */
export function priceAt(st: MarketState, c: number, stock = st.stock[c]): number {
  const base = COMMODITIES[c].price;
  const ratio = st.target[c] / Math.max(stock, 1);
  return base * Math.min(PRICE_MAX, Math.max(PRICE_MIN, Math.pow(ratio, ELASTICITY)));
}

/**
 * Total cost of buying (or revenue from selling) `qty` units, walking the
 * price curve as the stock changes so large trades get diminishing returns.
 */
export function quote(st: MarketState, c: number, qty: number, side: 'buy' | 'sell', markup: number): number {
  if (qty <= 0) return 0;
  const steps = Math.min(40, Math.max(1, Math.ceil(qty / 5)));
  const chunk = qty / steps;
  let stock = st.stock[c];
  let total = 0;
  for (let i = 0; i < steps; i++) {
    const mid = side === 'buy' ? stock - chunk / 2 : stock + chunk / 2;
    total += priceAt(st, c, mid) * chunk;
    stock += side === 'buy' ? -chunk : chunk;
  }
  return Math.round(total * (side === 'buy' ? 1 + SPREAD + markup : 1 - SPREAD - markup));
}

/** Unit price for display. */
export function unitPrice(st: MarketState, c: number, side: 'buy' | 'sell', markup: number): number {
  return Math.round(priceAt(st, c) * (side === 'buy' ? 1 + SPREAD + markup : 1 - SPREAD - markup));
}

/** Supply/demand label for the market screen. */
export function stockLabel(st: MarketState, c: number): { text: string; cls: string } {
  const r = st.stock[c] / st.target[c];
  if (st.prod[c] === 0 && st.cons[c] === 0 && r < 0.2) return { text: 'None', cls: 'none' };
  if (r < 0.35) return { text: 'Shortage', cls: 'short' };
  if (r < 0.8) return { text: 'Demand', cls: 'demand' };
  if (r < 1.5) return { text: 'Stable', cls: 'stable' };
  return { text: 'Surplus', cls: 'surplus' };
}
