import * as THREE from 'three';
import type { Fleet } from '../ships/fleet';
import { cloneFleet } from '../ships/fleet';
import type { Anchor } from '../world/universe';
import { type BattleReport, type EnemyFleet, battleReport, deployFleets } from './encounters';
import { CombatRenderer } from './render';
import type { CombatShip } from './ship';
import { CombatSim, MASS_LOCK_RANGE } from './sim';

export type SessionState = 'fighting' | 'ending' | 'report';

export interface SessionInit {
  fleet: Fleet;
  enemy: EnemyFleet;
  /** Reference frame and frame-local position of the arena centre (the player's position at the start). */
  frame: Anchor | null;
  origin: THREE.Vector3;
  playerQuat: THREE.Quaternion;
  /** Direction the enemy comes from (arena plane). */
  enemyDir: THREE.Vector3;
  distance: number;
  simulated: boolean;
  seed: number;
}

/**
 * One battle in progress: the simulation, its renderer, and the bookkeeping
 * that ties it to the game (arena placement, the player's ship, the ending).
 */
export class CombatSession {
  readonly sim: CombatSim;
  readonly renderer: CombatRenderer;
  readonly enemy: EnemyFleet;
  readonly frame: Anchor | null;
  /** Arena centre in the frame's coordinates. */
  readonly origin: THREE.Vector3;
  readonly simulated: boolean;
  readonly seed: number;
  /** Fleet as it was before the battle (simulations restore it). */
  readonly fleetBefore: Fleet;
  state: SessionState = 'fighting';
  /** Time since the outcome was decided. */
  endT = 0;
  outcome: BattleReport['outcome'] | null = null;
  /** Global time scale: brief slow motion on the decisive kill. */
  timeScale = 1;
  private slowmo = 0;
  age = 0;
  /** Restore point for simulations. */
  restore: { frame: Anchor | null; local: THREE.Vector3; quat: THREE.Quaternion } | null = null;

  constructor(init: SessionInit) {
    this.sim = new CombatSim(init.seed);
    this.enemy = init.enemy;
    this.frame = init.frame;
    this.origin = init.origin.clone();
    this.simulated = init.simulated;
    this.seed = init.seed;
    this.fleetBefore = cloneFleet(init.fleet);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(init.playerQuat);
    deployFleets(this.sim, init.fleet, init.enemy, {
      playerYaw: Math.atan2(-fwd.x, -fwd.z),
      enemyDir: init.enemyDir,
      distance: init.distance,
    });
    this.renderer = new CombatRenderer(this.sim);
  }

  get player(): CombatShip | null {
    return this.sim.player;
  }

  /** Arena centre in system (world) coordinates. */
  arenaWorld(out: THREE.Vector3): THREE.Vector3 {
    out.copy(this.origin);
    if (this.frame) out.add(this.frame.position);
    return out;
  }

  /** Hostiles close enough to block supercruise and jumps. */
  massLocked(playerArena: THREE.Vector3): boolean {
    return this.state === 'fighting' && this.sim.nearestHostile(0, playerArena) < MASS_LOCK_RANGE;
  }

  /** Advance the battle. Returns the outcome the moment it's decided. */
  step(dt: number): void {
    this.age += dt;
    this.sim.step(dt);
    if (this.slowmo > 0) {
      this.slowmo -= dt / Math.max(this.timeScale, 0.05);
      this.timeScale = this.slowmo > 0 ? 0.3 : 1;
    }
    if (this.state === 'fighting' && this.sim.outcome) {
      this.state = 'ending';
      this.outcome = this.sim.outcome;
      this.endT = 0;
      if (this.sim.outcome === 'victory' && this.sim.ships.some((s) => s.side === 1 && !s.alive)) this.slowmo = 1.2;
    }
    if (this.state === 'ending') this.endT += dt;
  }

  /** Ship to take command of when the flagship goes down. */
  successor(): CombatShip | null {
    return this.sim.active(0).sort((a, b) => b.points * b.hpFrac - a.points * a.hpFrac)[0] ?? null;
  }

  report(outcome: BattleReport['outcome']): BattleReport {
    return battleReport(this.sim, this.enemy.name, outcome, this.seed);
  }

  dispose(): void {
    this.renderer.dispose();
  }
}

/**
 * Decides when pirates interdict the player in supercruise: more often in
 * dangerous systems, never too soon after the last fight or near stations.
 */
export class EncounterDirector {
  /** Seconds of game time before the next interdiction may happen. */
  cooldown = 150;
  warning: { t: number; enemy: EnemyFleet } | null = null;
  static readonly WARNING = 5;

  /** Per-second chance while in supercruise. */
  static rate(danger: number): number {
    return danger * 0.006;
  }

  reset(cooldown = 150): void {
    this.cooldown = cooldown;
    this.warning = null;
  }
}
