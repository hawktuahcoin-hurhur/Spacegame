/** Player-side campaign state that persists across systems. */
export interface PlayerState {
  fuel: number;
  fuelCapacity: number;
  supplies: number;
  suppliesCapacity: number;
  /** Maximum hyperjump distance (ly). */
  jumpRange: number;
  visited: Set<number>;
  jumps: number;
  distanceLy: number;
}

export const SECONDS_PER_DAY = 86_400;
/** In-game time a hyperjump takes. */
export const JUMP_DURATION_DAYS = 1;
/** Supplies used per jump (crew, maintenance). */
export const SUPPLIES_PER_JUMP = 2;

export function newPlayer(): PlayerState {
  return {
    fuel: 32,
    fuelCapacity: 40,
    supplies: 60,
    suppliesCapacity: 80,
    jumpRange: 12,
    visited: new Set(),
    jumps: 0,
    distanceLy: 0,
  };
}

/** Fuel scooping rate (t/s) at a given altitude above a star of radius r. */
export function scoopRate(altitude: number, starRadius: number): number {
  const zone = starRadius * 2.2;
  if (altitude >= zone || altitude < 0) return 0;
  const f = 1 - altitude / zone;
  return 3.5 * f * f;
}
