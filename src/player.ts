import type { Mission } from './campaign/missions';
import { type Fleet, STARTING_CREDITS, fleetLogistics, starterFleet } from './ships/fleet';

/** Prices you saw at a market, for planning trade runs. */
export interface PriceIntel {
  day: number;
  buy: number[];
  sell: number[];
}

/** Player-side campaign state that persists across systems. */
export interface PlayerState {
  credits: number;
  fleet: Fleet;
  fuel: number;
  supplies: number;
  /** Derived from the fleet: call `refreshLogistics` after changing it. */
  fuelCapacity: number;
  suppliesCapacity: number;
  /** Maximum hyperjump distance (ly), set by the fleet's shortest-ranged drive. */
  jumpRange: number;
  /** Multiplier on single-frigate jump fuel (sum of the fleet's fuel use). */
  fuelMultiplier: number;
  suppliesPerJump: number;
  visited: Set<number>;
  jumps: number;
  distanceLy: number;
  /** Trade goods in the hold, by commodity id (supplies and fuel are kept separately). */
  cargo: Record<string, number>;
  /** Reputation per faction id, −100..100. */
  reputation: Record<string, number>;
  /** Faction the player holds a commission with. */
  commission: string | null;
  /** Day the last commission stipend was paid. */
  stipendDay: number;
  missions: Mission[];
  /** Board missions already taken or finished (hidden from boards). */
  takenMissions: string[];
  /** People you've worked for: completed jobs improve their pay. */
  contacts: Record<string, { name: string; title: string; faction: string; jobs: number }>;
  /** Last seen prices per market (star index). */
  intel: Record<number, PriceIntel>;
}

/** Starting reputation: friendly with the frontier, wary of the core, hated by pirates. */
export const START_REPUTATION: Record<string, number> = {
  hegemony: 0,
  tricorp: 0,
  league: 8,
  ascendant: -5,
  independent: 10,
  pirates: -50,
};

export const SECONDS_PER_DAY = 86_400;
/** In-game time a hyperjump takes. */
export const JUMP_DURATION_DAYS = 1;
/** Supplies used per jump by the starter frigate (fleets use the sum of their ships). */
export const SUPPLIES_PER_JUMP = 2;

/** Recompute fleet-derived capacities, clamping current fuel/supplies to fit. */
export function refreshLogistics(p: PlayerState): PlayerState {
  const lg = fleetLogistics(p.fleet);
  p.fuelCapacity = lg.fuelCapacity;
  p.suppliesCapacity = lg.suppliesCapacity;
  p.jumpRange = lg.jumpRange;
  p.fuelMultiplier = lg.fuelMultiplier;
  p.suppliesPerJump = lg.suppliesPerJump;
  p.fuel = Math.min(p.fuel, p.fuelCapacity);
  p.supplies = Math.min(p.supplies, p.suppliesCapacity);
  return p;
}

export function newPlayer(): PlayerState {
  return refreshLogistics({
    credits: STARTING_CREDITS,
    fleet: starterFleet(),
    fuel: 32,
    supplies: 60,
    fuelCapacity: 0,
    suppliesCapacity: 0,
    jumpRange: 0,
    fuelMultiplier: 1,
    suppliesPerJump: SUPPLIES_PER_JUMP,
    visited: new Set(),
    jumps: 0,
    distanceLy: 0,
    cargo: {},
    reputation: { ...START_REPUTATION },
    commission: null,
    stipendDay: 0,
    missions: [],
    takenMissions: [],
    contacts: {},
    intel: {},
  });
}

/** Units of trade goods in the hold, including mission cargo. */
export function goodsAboard(p: PlayerState): number {
  let n = 0;
  for (const v of Object.values(p.cargo)) n += v;
  for (const m of p.missions) if ((m.type === 'delivery' || m.type === 'smuggle') && m.qty) n += m.qty;
  return n;
}

/** Free hold space: supplies and trade goods share the fleet's cargo capacity. */
export function cargoFree(p: PlayerState): number {
  return Math.max(0, p.suppliesCapacity - p.supplies - goodsAboard(p));
}

/** Fuel scooping rate (t/s) at a given altitude above a star of radius r. */
export function scoopRate(altitude: number, starRadius: number): number {
  const zone = starRadius * 2.2;
  if (altitude >= zone || altitude < 0) return 0;
  const f = 1 - altitude / zone;
  return 3.5 * f * f;
}
