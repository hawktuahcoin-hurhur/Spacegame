import { Rng } from '../core/rng';
import { type Loadout, type ShipStyle, hull } from './defs';
import { cloneLoadout, computeStats, defaultLoadout } from './fitting';

export interface ShipInstance {
  id: string;
  name: string;
  loadout: Loadout;
}

export interface Fleet {
  ships: ShipInstance[];
  flagshipId: string;
}

export const MAX_FLEET_SIZE = 10;
/** Fraction of a hull's list price you get back when selling. */
export const RESALE_FACTOR = 0.7;
export const STARTING_CREDITS = 250_000;

const PREFIX: Record<ShipStyle, string> = { frontier: 'FSV', hegemony: 'HNS', tricorp: 'TCS', pirate: '' };
const NAMES: Record<ShipStyle, string[]> = {
  frontier: ['Wanderer', 'Long Haul', 'Second Chance', 'Prospector', 'Far Horizon', 'Copper Kettle', 'Driftwood', 'Steadfast', 'Lantern', 'Good Fortune', 'Wayfarer', 'Tumbleweed'],
  hegemony: ['Resolute', 'Iron Mandate', 'Vigilant', 'Bulwark', 'Sovereign', 'Indomitable', 'Warden', 'Ardent', 'Paragon', 'Rampart'],
  tricorp: ['Meridian Light', 'Quiet Margin', 'Prism', 'Asymptote', 'Clarity', 'Gradient', 'Halcyon', 'Vector', 'Aperture', 'Lumina'],
  pirate: ['Rusty Knife', 'Bad Debt', "Widow's Grin", 'No Questions', 'Scrapheap', 'Last Laugh', 'Gallows', 'Cutthroat', 'Loose Cannon', 'Grudge'],
};

/** A flavourful, unused ship name for a hull's faction style. */
export function shipName(hullId: string, rng: Rng, taken: Set<string> = new Set()): string {
  const style = hull(hullId).style;
  for (let i = 0; i < 30; i++) {
    const base = rng.pick(NAMES[style]);
    const name = PREFIX[style] ? `${PREFIX[style]} ${base}` : base;
    if (!taken.has(name)) return name;
  }
  return `${hull(hullId).name} ${rng.int(100, 999)}`;
}

let counter = 0;
export function newShipId(): string {
  counter++;
  return `ship-${Date.now().toString(36)}-${counter.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** A new ship with the hull's stock loadout. */
export function createShip(hullId: string, name: string, id = newShipId()): ShipInstance {
  return { id, name, loadout: defaultLoadout(hullId) };
}

export function starterFleet(): Fleet {
  const ship = createShip('kestrel', 'FSV Wanderer');
  return { ships: [ship], flagshipId: ship.id };
}

export function flagship(f: Fleet): ShipInstance {
  return f.ships.find((s) => s.id === f.flagshipId) ?? f.ships[0];
}

export function cloneFleet(f: Fleet): Fleet {
  return { flagshipId: f.flagshipId, ships: f.ships.map((s) => ({ ...s, loadout: cloneLoadout(s.loadout) })) };
}

export interface FleetLogistics {
  fuelCapacity: number;
  /** Supplies live in cargo holds (Phase 5 adds trade goods competing for the space). */
  suppliesCapacity: number;
  /** Slowest drive in the fleet sets the jump range. */
  jumpRange: number;
  /** Multiplier on a single-frigate jump's fuel cost. */
  fuelMultiplier: number;
  suppliesPerJump: number;
  crew: number;
}

/** Fleet-wide logistics: everything that limits how far and how long you can travel. */
export function fleetLogistics(f: Fleet): FleetLogistics {
  const stats = f.ships.map((s) => computeStats(s.loadout));
  return {
    fuelCapacity: Math.round(stats.reduce((a, s) => a + s.fuel, 0)),
    suppliesCapacity: Math.round(stats.reduce((a, s) => a + s.cargo, 0)),
    jumpRange: Math.min(...stats.map((s) => s.jumpRange)),
    fuelMultiplier: stats.reduce((a, s) => a + s.fuelPerLY, 0),
    suppliesPerJump: Math.round(stats.reduce((a, s) => a + s.suppliesPerJump, 0) * 10) / 10,
    crew: stats.reduce((a, s) => a + s.crew[0], 0),
  };
}

/** Deterministic shipyard stock for a station: bigger, rarer hulls in the core. */
export function shipyardStock(stationSeed: number, region: 'core' | 'frontier' | 'fringe'): string[] {
  const rng = new Rng(stationSeed ^ 0x5a1e);
  const pool = ['kestrel', 'wisp', 'jackal', 'harrier', 'bastion', 'lumen', 'vanguard', 'corsair', 'meridian', 'dominion', 'aurora', 'atlas'];
  const capitalChance = region === 'core' ? 0.7 : region === 'frontier' ? 0.35 : 0.1;
  const stock = new Set<string>(['kestrel']);
  const want = rng.int(4, 6);
  for (let guard = 0; stock.size < want && guard < 100; guard++) {
    const id = rng.pick(pool);
    if (hull(id).size === 'capital' && rng.next() > capitalChance) continue;
    if (hull(id).style === 'pirate' && region === 'core' && rng.next() < 0.7) continue;
    stock.add(id);
  }
  return [...stock];
}
