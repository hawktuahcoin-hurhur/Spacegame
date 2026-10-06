import commoditiesJson from '../content/commodities.json';
import factionsJson from '../content/factions.json';
import type { ShipStyle } from '../ships/defs';

export interface CommodityDef {
  id: string;
  name: string;
  /** Galactic average price per unit (¢). Fuel units are tonnes. */
  price: number;
  category: 'basic' | 'raw' | 'industrial' | 'logistics' | 'consumer' | 'contraband';
  description: string;
}

export interface FactionDef {
  id: string;
  name: string;
  short: string;
  color: string;
  description: string;
  /** Ship style used for names. */
  style: ShipStyle;
  /** Import tariff on purchases at their markets. */
  tariff: number;
  /** Goods that can't be traded openly at all. */
  illegal: string[];
  /** Goods only commissioned officers may trade openly. */
  restricted: string[];
  /** Hull weights for this faction's fleets. */
  hulls: Record<string, number>;
  aggression: number;
  /** Has a navy that patrols and goes to war. */
  military: boolean;
  /** Offers commissions. */
  playable: boolean;
}

export const COMMODITIES = commoditiesJson as CommodityDef[];
export const FACTIONS = factionsJson as unknown as FactionDef[];
export const NC = COMMODITIES.length;
export const NF = FACTIONS.length;

const cIndex = new Map(COMMODITIES.map((c, i) => [c.id, i]));
const fIndex = new Map(FACTIONS.map((f, i) => [f.id, i]));

/** Commodity index by id. */
export function ci(id: string): number {
  const i = cIndex.get(id);
  if (i === undefined) throw new Error(`Unknown commodity ${id}`);
  return i;
}

/** Faction index by id. */
export function fi(id: string): number {
  const i = fIndex.get(id);
  if (i === undefined) throw new Error(`Unknown faction ${id}`);
  return i;
}

export const hasCommodity = (id: string) => cIndex.has(id);
export const hasFaction = (id: string) => fIndex.has(id);
export const faction = (id: string) => FACTIONS[fi(id)];

export const PIRATES = fi('pirates');
export const INDEPENDENT = fi('independent');

/** Reputation bands, Starsector-style. */
export function standing(rep: number): { label: string; cls: 'vengeful' | 'hostile' | 'inhospitable' | 'neutral' | 'favorable' | 'friendly' | 'cooperative' } {
  if (rep <= -75) return { label: 'Vengeful', cls: 'vengeful' };
  if (rep <= -50) return { label: 'Hostile', cls: 'hostile' };
  if (rep <= -20) return { label: 'Inhospitable', cls: 'inhospitable' };
  if (rep < 10) return { label: 'Neutral', cls: 'neutral' };
  if (rep < 25) return { label: 'Favorable', cls: 'favorable' };
  if (rep < 50) return { label: 'Friendly', cls: 'friendly' };
  return { label: 'Cooperative', cls: 'cooperative' };
}

/** Structural checks on the campaign content files. */
export function validateCampaignContent(knownHulls: (id: string) => boolean): string[] {
  const errors: string[] = [];
  for (const f of FACTIONS) {
    for (const c of [...f.illegal, ...f.restricted]) if (!cIndex.has(c)) errors.push(`${f.id}: unknown commodity ${c}`);
    for (const h of Object.keys(f.hulls)) if (!knownHulls(h)) errors.push(`${f.id}: unknown hull ${h}`);
  }
  for (const c of COMMODITIES) if (!(c.price > 0)) errors.push(`${c.id}: bad price`);
  return errors;
}
