import hullsJson from '../content/hulls.json';
import hullmodsJson from '../content/hullmods.json';
import weaponsJson from '../content/weapons.json';

/** Ship content definitions, loaded from `src/content/*.json` and validated at startup. */

export type HullSize = 'frigate' | 'destroyer' | 'cruiser' | 'capital';
export const HULL_SIZES: HullSize[] = ['frigate', 'destroyer', 'cruiser', 'capital'];
export type SlotSize = 'S' | 'M' | 'L';
export type WeaponType = 'ballistic' | 'energy' | 'missile';
export type SlotType = WeaponType | 'universal' | 'hybrid' | 'composite' | 'synergy';
export type DamageType = 'kinetic' | 'he' | 'energy' | 'frag';
export type ShipStyle = 'frontier' | 'hegemony' | 'tricorp' | 'pirate';
export type SlotZone = 'nose' | 'dorsal' | 'ventral' | 'flank' | 'wing' | 'aft';
export type HullProfile = 'dart' | 'wedge' | 'needle' | 'brick' | 'hauler';

export interface SlotDef {
  id: string;
  size: SlotSize;
  type: SlotType;
  mount: 'turret' | 'hardpoint';
  /** Where on the hull the procedural builder places the mount. */
  zone: SlotZone;
  /** Fraction along the hull from nose (0) to tail (1). */
  t: number;
  /** -1 port, 0 centreline, 1 starboard. */
  side: number;
  /** Facing in degrees: 0 = forward, positive = towards port. */
  angle: number;
  /** Firing arc in degrees. */
  arc: number;
}

export interface ShipRecipe {
  profile: HullProfile;
  length: number;
  beam: number;
  height: number;
  wings: number;
  engines: number;
  pods: boolean;
  towers: number;
  seed: number;
}

export interface Loadout {
  hullId: string;
  weapons: Record<string, string | null>;
  hullmods: string[];
  vents: number;
  capacitors: number;
}

export interface HullDef {
  id: string;
  name: string;
  size: HullSize;
  designation: string;
  style: ShipStyle;
  manufacturer: string;
  description: string;
  hitpoints: number;
  armor: number;
  fluxCapacity: number;
  fluxDissipation: number;
  shield: { type: 'omni' | 'front'; arc: number; efficiency: number; upkeep: number } | null;
  maxSpeed: number;
  accel: number;
  /** Degrees per second. */
  turnRate: number;
  ordnancePoints: number;
  cargo: number;
  fuel: number;
  crew: [number, number];
  suppliesPerJump: number;
  fuelPerLY: number;
  jumpRange: number;
  cost: number;
  shipSystem: string;
  builtInMods: string[];
  recipe: ShipRecipe;
  slots: SlotDef[];
  defaultLoadout: Omit<Loadout, 'hullId'>;
}

export interface WeaponDef {
  id: string;
  name: string;
  size: SlotSize;
  type: WeaponType;
  kind: 'projectile' | 'beam' | 'missile';
  damageType: DamageType;
  /** Per shot (projectile/missile) or per second (beam). */
  damage: number;
  /** Shots per second (1 for beams). */
  rof: number;
  range: number;
  /** Flux per shot (or per second for beams). */
  flux: number;
  op: number;
  model: 'autocannon' | 'cannon' | 'flak' | 'railgun' | 'laser' | 'beam' | 'plasma' | 'rocket-pod' | 'missile-rack' | 'torpedo';
  description: string;
  speed?: number;
  ammo?: number;
  pd?: boolean;
  guided?: boolean;
  emp?: boolean;
}

export type StatKey =
  | 'hitpoints'
  | 'armor'
  | 'fluxCapacity'
  | 'fluxDissipation'
  | 'shieldEfficiency'
  | 'shieldArc'
  | 'shieldType'
  | 'maxSpeed'
  | 'accel'
  | 'turnRate'
  | 'cargo'
  | 'fuel'
  | 'suppliesPerJump'
  | 'fuelPerLY'
  | 'jumpRange'
  | 'range.all'
  | 'rof.missile';

export interface ModEffect {
  stat: StatKey;
  /** Multiplier, applied after additions. */
  mult?: number;
  /** Flat addition: a number, or one value per hull size. */
  add?: number | number[];
  set?: string;
}

export interface HullmodDef {
  id: string;
  name: string;
  /** OP cost per hull size: frigate, destroyer, cruiser, capital. */
  op: number[];
  effects: ModEffect[];
  description: string;
  requires?: 'shield' | 'omniShield' | 'missileSlot';
  notSizes?: HullSize[];
  incompatible?: string[];
  /** Permanent damage from being disabled and recovered: free, can't be removed in a refit. */
  dmod?: boolean;
}

export const HULLS = hullsJson as unknown as HullDef[];
export const WEAPONS = weaponsJson as unknown as WeaponDef[];
export const HULLMODS = hullmodsJson as unknown as HullmodDef[];

const hullById = new Map(HULLS.map((h) => [h.id, h]));
const weaponById = new Map(WEAPONS.map((w) => [w.id, w]));
const modById = new Map(HULLMODS.map((m) => [m.id, m]));

export function hull(id: string): HullDef {
  const h = hullById.get(id);
  if (!h) throw new Error(`Unknown hull ${id}`);
  return h;
}
export function weapon(id: string): WeaponDef {
  const w = weaponById.get(id);
  if (!w) throw new Error(`Unknown weapon ${id}`);
  return w;
}
export function hullmod(id: string): HullmodDef {
  const m = modById.get(id);
  if (!m) throw new Error(`Unknown hullmod ${id}`);
  return m;
}
export const hasHull = (id: string) => hullById.has(id);
export const hasWeapon = (id: string) => weaponById.has(id);
export const hasHullmod = (id: string) => modById.has(id);

/**
 * Structural validation of the content files: catches typos in hand-edited
 * JSON (or mods) with a readable message instead of a crash mid-game.
 */
export function validateContent(): string[] {
  const errors: string[] = [];
  const ids = (list: { id: string }[], what: string) => {
    const seen = new Set<string>();
    for (const x of list) {
      if (seen.has(x.id)) errors.push(`Duplicate ${what} id "${x.id}"`);
      seen.add(x.id);
    }
  };
  ids(HULLS, 'hull');
  ids(WEAPONS, 'weapon');
  ids(HULLMODS, 'hullmod');
  for (const h of HULLS) {
    if (!HULL_SIZES.includes(h.size)) errors.push(`${h.id}: bad size ${h.size}`);
    const slotIds = new Set<string>();
    for (const s of h.slots) {
      if (slotIds.has(s.id)) errors.push(`${h.id}: duplicate slot ${s.id}`);
      slotIds.add(s.id);
      if (!['S', 'M', 'L'].includes(s.size)) errors.push(`${h.id}/${s.id}: bad slot size`);
      if (s.t < 0 || s.t > 1) errors.push(`${h.id}/${s.id}: t out of range`);
    }
    for (const m of h.builtInMods) if (!modById.has(m)) errors.push(`${h.id}: unknown built-in mod ${m}`);
    for (const [slot, w] of Object.entries(h.defaultLoadout.weapons)) {
      if (!slotIds.has(slot)) errors.push(`${h.id}: default loadout uses unknown slot ${slot}`);
      if (w && !weaponById.has(w)) errors.push(`${h.id}: default loadout uses unknown weapon ${w}`);
    }
    for (const m of h.defaultLoadout.hullmods) if (!modById.has(m)) errors.push(`${h.id}: default loadout uses unknown mod ${m}`);
  }
  for (const m of HULLMODS) {
    if (m.op.length !== 4) errors.push(`${m.id}: op must list 4 sizes`);
    for (const i of m.incompatible ?? []) if (!modById.has(i)) errors.push(`${m.id}: unknown incompatible mod ${i}`);
  }
  return errors;
}
