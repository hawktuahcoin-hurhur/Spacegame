import { type Fleet, STARTING_CREDITS, fleetLogistics, starterFleet } from './ships/fleet';

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
}

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
  });
}

/** Fuel scooping rate (t/s) at a given altitude above a star of radius r. */
export function scoopRate(altitude: number, starRadius: number): number {
  const zone = starRadius * 2.2;
  if (altitude >= zone || altitude < 0) return 0;
  const f = 1 - altitude / zone;
  return 3.5 * f * f;
}
