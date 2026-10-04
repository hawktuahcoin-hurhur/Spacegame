import * as THREE from 'three';
import { type HullDef, type Loadout, type SlotDef, type WeaponDef, hull as hullDef, weapon as weaponDef, HULL_SIZES } from '../ships/defs';
import { type ShipStats, computeStats } from '../ships/fitting';
import { ARMOR_CELLS, ArmorGrid } from './damage';
import { type ShipDims, approxMount, hullDims } from './geometry';
import { type ShipSystemDef, type SystemMods, shipSystem } from './systems';

export type Side = 0 | 1;

export type OrderKind = 'move' | 'attack' | 'escort' | 'hold' | 'retreat';
export interface Order {
  kind: OrderKind;
  point?: THREE.Vector3;
  target?: CombatShip;
}

/** Turret traverse by weapon size (rad/s). */
const TRAVERSE = { S: 2.8, M: 1.7, L: 0.95 };
/** Shot spread by weapon model (radians, half-angle). */
export const SPREAD: Record<WeaponDef['model'], number> = {
  autocannon: 0.012,
  cannon: 0.006,
  flak: 0.035,
  railgun: 0.002,
  laser: 0.007,
  beam: 0,
  plasma: 0.008,
  'rocket-pod': 0.03,
  'missile-rack': 0.02,
  torpedo: 0.01,
};

export interface WeaponState {
  ship: CombatShip;
  slot: SlotDef;
  def: WeaponDef;
  /** Mount position in ship-local space. */
  local: THREE.Vector3;
  /** Mount facing (radians, 0 = nose, positive = port) and half its firing arc. */
  facing: number;
  halfArc: number;
  turret: boolean;
  /** Current aim relative to `facing`. */
  yaw: number;
  traverse: number;
  cooldown: number;
  ammo: number;
  maxAmmo: number;
  /** Seconds the weapon stays disabled (EMP, malfunction). */
  disabled: number;
  range: number;
  rof: number;
  group: number;
  /** Beam state: 0..1 intensity, current length, and what it's hitting. */
  beam: number;
  beamLength: number;
  beamHit: 'none' | 'shield' | 'hull' | 'missile';
  /** Seconds since the last shot (muzzle flash). */
  sinceShot: number;
  /** Whether the weapon wanted to fire this tick (beams). */
  firing: boolean;
  /** The aim point this tick (arena space), if any. */
  aim: THREE.Vector3 | null;
}

export interface WeaponGroup {
  weapons: WeaponState[];
  autofire: boolean;
  label: string;
}

export interface ShipInit {
  id: string;
  name: string;
  side: Side;
  loadout: Loadout;
  /** Hull integrity carried over from earlier battles (0..1). */
  hull?: number;
  /** Combat readiness (0..1). */
  cr?: number;
  /** Player-fleet ship id this combatant represents. */
  instanceId?: string;
}

export interface ShipAi {
  /** Short label for the tactical view ("Engaging Rusty Knife"). */
  state: string;
  facing: number;
  /** Desired velocity on the combat plane (arena space). */
  move: THREE.Vector3;
  thinkIn: number;
  /** Bearing (relative to the nose) that puts most guns on a target. */
  attackBearing: number;
  /** Preferred engagement range. */
  range: number;
  /** Orbit direction when circling a target. */
  orbit: number;
  /** Anchor for hold/move orders. */
  anchor: THREE.Vector3 | null;
  /** Fire guided missiles when this is set (commander says go). */
  lastThreat: number;
  threatDir: THREE.Vector3;
}

let ids = 0;

/** Stable pseudo-random 0..1 from a string (keeps the sim deterministic). */
export function hash01(str: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** A ship in combat: hull, armour grid, flux, shields, weapons and its system. */
export class CombatShip {
  readonly key = ++ids;
  readonly id: string;
  name: string;
  readonly side: Side;
  readonly loadout: Loadout;
  readonly hull: HullDef;
  readonly stats: ShipStats;
  readonly sizeIndex: number;
  readonly dims: ShipDims;
  readonly instanceId: string | null;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  /** World yaw on the combat plane (AI ships). */
  yaw = 0;
  /** Yaw rate (rad/s), used for banking visuals. */
  angVel = 0;
  /** Visual throttle 0..1. */
  throttle = 0;

  hp: number;
  readonly maxHp: number;
  readonly armor: ArmorGrid;
  flux = 0;
  hardFlux = 0;
  readonly fluxCap: number;
  readonly dissipation: number;
  readonly shield: { type: 'omni' | 'front'; halfArc: number; efficiency: number; upkeep: number } | null;
  /** Shield raised (wanted); `shieldUnfold` animates the arc open. */
  shieldOn = false;
  shieldUnfold = 0;
  /** Shield centre bearing (ship-local, radians). */
  shieldFacing = 0;
  shieldTarget = 0;
  overload = 0;
  overloadMax = 1;
  venting = false;
  readonly weapons: WeaponState[] = [];
  readonly groups: WeaponGroup[] = [];
  selectedGroup = 0;
  readonly system: ShipSystemDef;
  systemActive = 0;
  systemCooldown = 0;
  systemCharges: number;
  cr: number;
  /** Player-controlled (inputs come from the game, motion from the flight model). */
  controlled = false;
  alive = true;
  retreated = false;
  /** Seconds since destruction (wreck effects). */
  deadFor = 0;
  /** Wreck spin (rad/s). */
  readonly spin = new THREE.Vector3();
  order: Order | null = null;
  target: CombatShip | null = null;
  readonly ai: ShipAi;
  /** Last time anything fired at this ship (sim time) and the hit flash. */
  lastHit = -99;
  /** Time of the last weapon shot. */
  lastShot = -99;
  /** Recent damage taken (decays), drives AI "defend" decisions. */
  pressure = 0;
  /** Recompute the best firing bearing on the next think. */
  attackBearingStale = true;
  /** Stats for the after-action report. */
  damageDealt = 0;
  kills = 0;

  constructor(init: ShipInit) {
    this.id = init.id;
    this.name = init.name;
    this.side = init.side;
    this.loadout = init.loadout;
    this.instanceId = init.instanceId ?? null;
    this.hull = hullDef(init.loadout.hullId);
    this.stats = computeStats(init.loadout);
    this.sizeIndex = HULL_SIZES.indexOf(this.hull.size);
    this.dims = hullDims(this.hull);
    this.maxHp = this.stats.hitpoints;
    this.hp = Math.max(1, this.maxHp * Math.min(1, init.hull ?? 1));
    this.armor = new ArmorGrid(this.stats.armor, ARMOR_CELLS[this.hull.size]);
    this.fluxCap = this.stats.fluxCapacity;
    this.dissipation = this.stats.fluxDissipation;
    const sh = this.stats.shield;
    this.shield = sh ? { type: sh.type, halfArc: THREE.MathUtils.degToRad(sh.arc) / 2, efficiency: sh.efficiency, upkeep: sh.upkeep } : null;
    this.system = shipSystem(this.hull.shipSystem);
    this.systemCharges = this.system.charges ?? 1;
    this.cr = init.cr ?? 0.7;
    this.ai = {
      state: 'Idle',
      facing: 0,
      move: new THREE.Vector3(),
      thinkIn: hash01(init.id, 1) * 0.12,
      attackBearing: 0,
      range: 800,
      orbit: hash01(init.id, 2) < 0.5 ? 1 : -1,
      anchor: null,
      lastThreat: -99,
      threatDir: new THREE.Vector3(),
    };

    for (const slot of this.hull.slots) {
      const wid = init.loadout.weapons[slot.id];
      if (!wid) continue;
      const def = weaponDef(wid);
      this.weapons.push({
        ship: this,
        slot,
        def,
        local: approxMount(this.hull, slot),
        facing: THREE.MathUtils.degToRad(slot.angle),
        halfArc: THREE.MathUtils.degToRad(Math.max(slot.arc, 4)) / 2,
        turret: slot.mount === 'turret',
        yaw: 0,
        traverse: slot.mount === 'turret' ? TRAVERSE[def.size] : 1.2,
        cooldown: hash01(init.id + slot.id, 3) * 0.4,
        ammo: def.ammo ?? Infinity,
        maxAmmo: def.ammo ?? Infinity,
        disabled: 0,
        range: def.range * this.stats.rangeMult,
        rof: def.rof * (def.type === 'missile' ? this.stats.missileRofMult : 1),
        group: 0,
        beam: 0,
        beamLength: 0,
        beamHit: 'none',
        sinceShot: 99,
        firing: false,
        aim: null,
      });
    }
    this.buildGroups();
    this.ai.range = preferredRange(this);
  }

  /** Default weapon groups: main guns, missiles, point defence. */
  private buildGroups(): void {
    const main = this.weapons.filter((w) => w.def.type !== 'missile' && !w.def.pd);
    const missiles = this.weapons.filter((w) => w.def.type === 'missile');
    const pd = this.weapons.filter((w) => w.def.type !== 'missile' && w.def.pd);
    const groups: [WeaponState[], boolean, string][] = [
      [main, false, 'Main guns'],
      [missiles, false, 'Missiles'],
      [pd, true, 'Point defence'],
    ];
    for (const [weapons, autofire, label] of groups) {
      if (!weapons.length) continue;
      for (const w of weapons) w.group = this.groups.length;
      this.groups.push({ weapons, autofire, label });
    }
  }

  get forward(): THREE.Vector3 {
    return new THREE.Vector3(0, 0, -1).applyQuaternion(this.quat);
  }

  get hpFrac(): number {
    return this.hp / this.maxHp;
  }

  get fluxFrac(): number {
    return this.flux / this.fluxCap;
  }

  get shieldUp(): boolean {
    return !!this.shield && this.shieldUnfold > 0.02 && this.overload <= 0 && !this.venting;
  }

  get canFire(): boolean {
    return this.alive && this.overload <= 0 && !this.venting && !this.mods.noFire;
  }

  /** Active system modifiers (empty when the system is idle). */
  get mods(): SystemMods {
    return this.systemActive > 0 ? this.system.mods : NO_MODS;
  }

  /** Readiness penalty multiplier (1 at 40%+ CR). */
  get crFactor(): number {
    return this.cr >= 0.4 ? 1 : 0.7 + this.cr * 0.75;
  }

  /** Top speed right now: hull, system, readiness and the zero-flux boost. */
  get maxSpeed(): number {
    const zeroFlux = this.flux < this.fluxCap * 0.01 && !this.shieldOn ? [55, 40, 30, 22][this.sizeIndex] : 0;
    return this.stats.maxSpeed * (this.mods.speed ?? 1) * this.crFactor + zeroFlux;
  }

  get accel(): number {
    return this.stats.accel * (this.mods.accel ?? 1) * this.crFactor;
  }

  get turnRate(): number {
    return THREE.MathUtils.degToRad(this.stats.turnRate) * (this.mods.turn ?? 1) * this.crFactor;
  }

  /** Fleet strength used to size encounters and drive retreat decisions. */
  get points(): number {
    return fleetPoints(this.loadout);
  }

  setYaw(yaw: number): void {
    this.yaw = yaw;
    this.quat.setFromAxisAngle(_up, yaw);
  }
}

const NO_MODS: SystemMods = {};
const _up = new THREE.Vector3(0, 1, 0);

/** Engagement range: where most of the ship's non-missile damage can reach. */
export function preferredRange(s: CombatShip): number {
  const guns = s.weapons.filter((w) => w.def.type !== 'missile' && !w.def.pd);
  const list = guns.length ? guns : s.weapons;
  if (!list.length) return 900;
  let total = 0;
  let weighted = 0;
  for (const w of list) {
    const dps = w.def.kind === 'beam' ? w.def.damage : w.def.damage * w.rof;
    total += dps;
    weighted += dps * w.range;
  }
  return (weighted / Math.max(total, 1)) * 0.82;
}

/** Combat strength of a loadout: firepower, toughness and flux. */
export function fleetPoints(l: Loadout): number {
  const s = computeStats(l);
  const tough = s.hitpoints + s.armor * 6 + s.fluxCapacity * 0.25 + (s.shield ? s.fluxCapacity * (1 - s.shield.efficiency) * 0.4 : 0);
  const punch = s.dps.total * 12 + s.fluxDissipation * 4;
  return Math.round(((tough + punch) / 1000) * 10) / 10;
}
