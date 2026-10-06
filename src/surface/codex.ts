import { Rng } from '../core/rng';
import { generateName } from '../galaxy/names';

export type CodexKind = 'flora' | 'fauna' | 'mineral' | 'ruins' | 'wreck' | 'planet';

/** A discovery: scanned species, translated ruins, surveyed worlds (SUPERPLAN §3.8). */
export interface CodexEntry {
  id: string;
  kind: CodexKind;
  name: string;
  /** Planet and system it was found on. */
  planet: string;
  system: string;
  /** Credits the data is worth at a station. */
  value: number;
  day: number;
  sold: boolean;
  note: string;
}

const FLORA_SUFFIX = ['arbor', 'frond', 'bloom', 'stalk', 'thorn', 'cap', 'vine', 'spire', 'moss', 'reed'];
const FAUNA_SUFFIX = ['grazer', 'strider', 'hopper', 'stalker', 'drifter', 'skitter', 'lumber', 'wing'];

/** A species name that is stable for a planet + index. */
export function speciesName(seed: number, index: number, kind: 'flora' | 'fauna'): string {
  const rng = new Rng(seed * 31 + index * 977 + (kind === 'fauna' ? 5 : 1));
  const genus = generateName(rng, 2, 3);
  const epithet = generateName(rng, 2, 2).toLowerCase();
  const common = rng.pick(kind === 'flora' ? FLORA_SUFFIX : FAUNA_SUFFIX);
  return `${genus} ${common} (${genus.slice(0, 1)}. ${epithet})`;
}

/** Data value: rarer things on harsher worlds are worth more. */
export function codexValue(kind: CodexKind, rarity: number): number {
  const base = { flora: 450, fauna: 1400, mineral: 300, ruins: 5200, wreck: 900, planet: 1800 }[kind];
  return Math.round((base * (0.7 + rarity * 0.9)) / 50) * 50;
}

/** Faction appetite for exploration data. */
export const DATA_PREMIUM: Record<string, number> = { tricorp: 1.3, league: 1.1, hegemony: 1, independent: 1, ascendant: 0.8, pirates: 0.7 };
