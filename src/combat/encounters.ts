import * as THREE from 'three';
import { Rng } from '../core/rng';
import { type Loadout, type ShipStyle, HULLMODS, hull } from '../ships/defs';
import { autofit, cloneLoadout, defaultLoadout } from '../ships/fitting';
import { type Fleet, type ShipInstance, MAX_FLEET_SIZE, createShip, shipName } from '../ships/fleet';
import { CombatShip, fleetPoints } from './ship';
import type { CombatSim } from './sim';

/** D-mods: permanent damage from being disabled and recovered. */
export const DMODS = HULLMODS.filter((m) => m.dmod).map((m) => m.id);

export type Region = 'core' | 'frontier' | 'fringe';

/** How dangerous a system is (0..1): pirates haunt the fringe. */
export function systemDanger(region: Region, isStart: boolean): number {
  const base = region === 'core' ? 0.15 : region === 'frontier' ? 0.5 : 0.9;
  return isStart ? base * 0.5 : base;
}

export interface EnemyShip {
  id: string;
  name: string;
  loadout: Loadout;
  hull: number;
  cr: number;
}

export interface EnemyFleet {
  name: string;
  /** Faction id (see content/factions.json). */
  faction: string;
  ships: EnemyShip[];
  /** Mission this fight belongs to (bounty/strike), if any. */
  missionId?: string;
}

const PIRATE_POOL: [string, number, number][] = [
  // hull, weight, minimum danger
  ['jackal', 6, 0],
  ['kestrel', 2, 0],
  ['corsair', 2.5, 0.25],
  ['harrier', 1, 0.3],
  ['bastion', 1, 0.45],
  ['meridian', 0.6, 0.5],
  ['vanguard', 0.5, 0.7],
  ['dominion', 0.15, 0.95],
];

const FLEET_NAMES = ['Raiders', 'Reavers', 'Marauders', 'Scavenger Band', 'Corsairs', 'Wreckers', 'Cutthroat Crew', 'Brigands'];
const BOSS = ['Vex', 'One-Eye Marrow', 'Captain Sallow', 'Grist', 'the Widow', 'Old Harrow', 'Kessa Thorn', 'Dagon Rusk'];

/** Total combat strength of a fleet. */
export function fleetStrength(f: Fleet): number {
  return f.ships.reduce((a, s) => a + fleetPoints(s.loadout) * (0.4 + 0.6 * (s.hull ?? 1)), 0);
}

/** Add `n` random d-mods to a loadout (no duplicates, respecting shield requirements). */
export function addDmods(l: Loadout, n: number, rng: Rng): Loadout {
  const out = cloneLoadout(l);
  const h = hull(l.hullId);
  const options = DMODS.filter((id) => !out.hullmods.includes(id) && (id !== 'dmod_shields' || h.shield));
  for (let i = 0; i < n && options.length; i++) out.hullmods.push(options.splice(rng.int(0, options.length - 1), 1)[0]);
  return out;
}

/** A pirate fleet sized against the player's strength and the system's danger. */
export function pirateFleet(seed: number, playerStrength: number, danger: number): EnemyFleet {
  const rng = new Rng(seed);
  const want = Math.max(4, playerStrength * (0.55 + danger * 0.55) * rng.range(0.85, 1.2));
  const pool = PIRATE_POOL.filter(([, , min]) => danger >= min);
  const ships: EnemyShip[] = [];
  const taken = new Set<string>();
  let total = 0;
  for (let guard = 0; guard < 40 && total < want && ships.length < 8; guard++) {
    const weights = pool.map(([id, w]) => {
      const fp = fleetPoints(defaultLoadout(id));
      // Don't pick a hull that alone overshoots the budget by a lot (unless the fleet is empty).
      return fp > (want - total) * 1.6 && ships.length ? 0 : w;
    });
    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum <= 0) break;
    let r = rng.next() * sum;
    let idx = 0;
    while (r > weights[idx]) r -= weights[idx++];
    const id = pool[idx][0];
    const pirateHull = hull(id).style === 'pirate';
    let loadout = pirateHull || rng.next() < 0.5 ? defaultLoadout(id) : autofit(id);
    if (!pirateHull || rng.next() < 0.5) loadout = addDmods(loadout, rng.int(1, pirateHull ? 1 : 3), rng);
    const name = shipName(id, rng, taken, 'pirate');
    taken.add(name);
    ships.push({ id: `pirate-${seed}-${ships.length}`, name, loadout, hull: rng.range(0.75, 1), cr: rng.range(0.55, 0.7) });
    total += fleetPoints(loadout);
  }
  return { name: `${rng.pick(BOSS)}'s ${rng.pick(FLEET_NAMES)}`, faction: 'pirates', ships };
}

const FACTION_FLEET_NAMES: Record<string, string[]> = {
  hegemony: ['Patrol Group', 'Picket Squadron', 'Line Detachment', 'Security Flotilla'],
  tricorp: ['Asset Protection Group', 'Security Detail', 'Response Team'],
  league: ['Convoy Escort', 'Merchant Guard', 'Militia Squadron'],
  ascendant: ['Crusade Band', 'Pathfinder Host', 'Zealot Squadron'],
  independent: ['Militia Patrol', 'Defence Picket'],
  pirates: ['Raiders'],
};

/** A regular faction fleet (patrol, war group) of roughly `strength` fleet points. */
export function factionFleet(factionId: string, hulls: Record<string, number>, style: ShipStyle, seed: number, strength: number, label?: string): EnemyFleet {
  const rng = new Rng(seed);
  const want = Math.max(4, strength);
  const pool = Object.entries(hulls);
  const ships: EnemyShip[] = [];
  const taken = new Set<string>();
  let total = 0;
  for (let guard = 0; guard < 40 && total < want && ships.length < 8; guard++) {
    const weights = pool.map(([id, w]) => (fleetPoints(defaultLoadout(id)) > (want - total) * 1.6 && ships.length ? 0 : w));
    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum <= 0) break;
    let r = rng.next() * sum;
    let idx = 0;
    while (r > weights[idx]) r -= weights[idx++];
    const id = pool[idx][0];
    const loadout = rng.next() < 0.7 ? defaultLoadout(id) : autofit(id);
    const name = shipName(id, rng, taken, style);
    taken.add(name);
    ships.push({ id: `${factionId}-${seed}-${ships.length}`, name, loadout, hull: 1, cr: 0.7 });
    total += fleetPoints(loadout);
  }
  return { name: label ?? rng.pick(FACTION_FLEET_NAMES[factionId] ?? ['Squadron']), faction: factionId, ships };
}

/** Deployment readiness cost per hull size. */
export const DEPLOY_CR = [0.08, 0.1, 0.12, 0.15];

export interface Deployment {
  /** Where the player's flagship sits (arena space) and which way it faces (yaw). */
  playerYaw: number;
  /** Direction from the player to the enemy (unit, arena plane). */
  enemyDir: THREE.Vector3;
  distance: number;
}

/**
 * Place both fleets: the player's around the flagship (which the game controls),
 * the enemy in a loose line abreast `distance` away, facing them.
 */
export function deployFleets(sim: CombatSim, fleet: Fleet, enemy: EnemyFleet, d: Deployment): CombatShip[] {
  const flagId = fleet.flagshipId;
  const toEnemy = d.enemyDir.clone().setY(0).normalize();
  const right = new THREE.Vector3(-toEnemy.z, 0, toEnemy.x);
  const faceEnemy = Math.atan2(-toEnemy.x, -toEnemy.z);
  const ours = fleet.ships.filter((s) => (s.hull ?? 1) > 0);
  const placed: CombatShip[] = [];
  let reach = [0, 0];
  for (const inst of [ours.find((s) => s.id === flagId)!, ...ours.filter((s) => s.id !== flagId)]) {
    if (!inst) continue;
    const s = new CombatShip({ id: inst.id, name: inst.name, side: 0, loadout: inst.loadout, hull: inst.hull ?? 1, cr: inst.cr ?? 0.7, instanceId: inst.id });
    const i = placed.length;
    if (i === 0) {
      s.controlled = true;
      s.setYaw(d.playerYaw);
    } else {
      const side = i % 2 ? 1 : -1;
      const k = i % 2 ? 0 : 1;
      reach[k] += s.dims.collide * 2.6 + 60;
      s.pos.copy(right).multiplyScalar(side * (placed[0].dims.collide + reach[k])).addScaledVector(toEnemy, -Math.floor((i - 1) / 2) * 120 - 150);
      s.setYaw(faceEnemy);
    }
    placed.push(sim.add(s));
  }
  reach = [0, 0];
  enemy.ships.forEach((e, i) => {
    const s = new CombatShip({ id: e.id, name: e.name, side: 1, loadout: e.loadout, hull: e.hull, cr: e.cr });
    const side = i % 2 ? 1 : -1;
    const k = i % 2 ? 0 : 1;
    const off = i === 0 ? 0 : (reach[k] += s.dims.collide * 2.8 + 120);
    s.pos.copy(toEnemy).multiplyScalar(d.distance + (i % 3) * 140).addScaledVector(right, side * off);
    s.setYaw(faceEnemy + Math.PI);
    s.vel.set(-Math.sin(s.yaw), 0, -Math.cos(s.yaw)).multiplyScalar(s.stats.maxSpeed * 0.6);
    sim.add(s);
  });
  return placed;
}

// ---------------------------------------------------------------- aftermath

export interface Salvage {
  credits: number;
  fuel: number;
  supplies: number;
}

export interface Recoverable {
  /** Combat ship id (own fleet: the ship instance id). */
  id: string;
  name: string;
  loadout: Loadout;
  own: boolean;
  /** Credits to recover and recommission. */
  cost: number;
  dmods: number;
}

export interface BattleReport {
  outcome: 'victory' | 'defeat' | 'escaped';
  enemyName: string;
  destroyed: { name: string; hullId: string; side: 0 | 1 }[];
  retreated: string[];
  salvage: Salvage;
  recoverable: Recoverable[];
  /** Surviving player ships: hull fraction and readiness after the fight. */
  survivors: { id: string; hull: number; cr: number }[];
  kills: { name: string; kills: number; damage: number }[];
}

/** Loot, recoverable hulls and survivor state at the end of a battle. */
export function battleReport(sim: CombatSim, enemyName: string, outcome: BattleReport['outcome'], seed: number): BattleReport {
  const rng = new Rng(seed ^ 0xbadc0de);
  const salvage: Salvage = { credits: 0, fuel: 0, supplies: 0 };
  const recoverable: Recoverable[] = [];
  const destroyed: BattleReport['destroyed'] = [];
  for (const s of sim.ships) {
    if (s.alive) continue;
    destroyed.push({ name: s.name, hullId: s.hull.id, side: s.side });
    if (outcome !== 'victory') continue;
    if (s.side === 1) {
      salvage.credits += Math.round((s.hull.cost * rng.range(0.07, 0.13)) / 100) * 100;
      salvage.fuel += Math.round(s.stats.fuel * rng.range(0.1, 0.3));
      salvage.supplies += Math.round(s.stats.cargo * rng.range(0.05, 0.15) + 2 + s.sizeIndex * 3);
      if (rng.next() < 0.4)
        recoverable.push({ id: s.id, name: s.name, loadout: s.loadout, own: false, cost: Math.round((s.hull.cost * 0.12) / 100) * 100, dmods: rng.int(1, 2) });
    } else {
      recoverable.push({ id: s.id, name: s.name, loadout: s.loadout, own: true, cost: Math.round((s.hull.cost * 0.06) / 100) * 100, dmods: 1 });
    }
  }
  const survivors = sim.ships
    .filter((s) => s.side === 0 && s.alive)
    .map((s) => ({ id: s.id, hull: Math.max(0.05, s.hpFrac), cr: Math.max(0, s.cr - DEPLOY_CR[s.sizeIndex]) }));
  return {
    outcome,
    enemyName,
    destroyed,
    retreated: sim.ships.filter((s) => s.retreated).map((s) => s.name),
    salvage,
    recoverable,
    survivors,
    kills: sim.ships.filter((s) => s.side === 0).map((s) => ({ name: s.name, kills: s.kills, damage: Math.round(s.damageDealt) })),
  };
}

/**
 * Apply a battle's results to the player's fleet: losses, survivor damage and
 * the hulls the player chose to recover (each with d-mods).
 */
export function applyReport(fleet: Fleet, report: BattleReport, recover: Set<string>, seed: number): { fleet: Fleet; spent: number; lostFlagship: boolean } {
  const rng = new Rng(seed ^ 0x5eed);
  const byId = new Map(report.survivors.map((s) => [s.id, s]));
  const ships: ShipInstance[] = [];
  let spent = 0;
  for (const inst of fleet.ships) {
    const surv = byId.get(inst.id);
    if (surv) {
      ships.push({ ...inst, loadout: cloneLoadout(inst.loadout), hull: surv.hull, cr: surv.cr });
      continue;
    }
    const rec = report.recoverable.find((r) => r.own && r.id === inst.id);
    if (rec && recover.has(rec.id) && ships.length < MAX_FLEET_SIZE) {
      spent += rec.cost;
      ships.push({ ...inst, loadout: addDmods(inst.loadout, rec.dmods, rng), hull: 0.3, cr: 0.3 });
    }
  }
  for (const r of report.recoverable) {
    if (r.own || !recover.has(r.id) || ships.length >= MAX_FLEET_SIZE) continue;
    spent += r.cost;
    const inst = createShip(r.loadout.hullId, r.name);
    inst.loadout = addDmods(r.loadout, r.dmods, rng);
    inst.hull = 0.3;
    inst.cr = 0.3;
    ships.push(inst);
  }
  const lostFlagship = !ships.some((s) => s.id === fleet.flagshipId);
  return { fleet: { ships, flagshipId: lostFlagship ? (ships[0]?.id ?? '') : fleet.flagshipId }, spent, lostFlagship };
}
