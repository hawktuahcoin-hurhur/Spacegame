import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { ShipInstance } from './fleet';
import { type ShipVisual, buildShip } from './shipBuilder';

interface Escort {
  ship: ShipInstance;
  visual: ShipVisual;
  /** Formation slot in flagship-local space. */
  slot: THREE.Vector3;
  /** Smoothed offset in flagship-local space (so the formation never lags at supercruise speeds). */
  offset: THREE.Vector3;
  quaternion: THREE.Quaternion;
  phase: number;
}

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

/**
 * The rest of the player's fleet, flying in a loose wedge behind the flagship.
 * Positions are kept relative to the flagship and lag a little in rotation, so
 * escorts bank through turns and drift slightly like real wingmen.
 */
export class EscortFormation {
  readonly group = new THREE.Group();
  private escorts: Escort[] = [];
  private key = '';

  /** Rebuild if the fleet's composition or loadouts changed. */
  sync(ships: ShipInstance[], flagshipRadius: number, flagshipQuat: THREE.Quaternion): void {
    const key = JSON.stringify([flagshipRadius, ships.map((s) => [s.id, s.loadout])]);
    if (key === this.key) return;
    this.key = key;
    this.dispose();
    const rng = new Rng(7);
    // Wingmen fly abreast in widening pairs, slightly behind, so they stay in the chase camera's view.
    const reach = [flagshipRadius, flagshipRadius];
    ships.forEach((ship, i) => {
      const visual = buildShip(ship.loadout);
      const sideIdx = i % 2;
      const side = sideIdx === 0 ? 1 : -1;
      const rank = Math.floor(i / 2) + 1;
      const x = reach[sideIdx] + visual.radius * 1.35;
      reach[sideIdx] = x + visual.radius * 1.1;
      const slot = new THREE.Vector3(side * x, (rank % 2 === 0 ? 1 : -1) * visual.radius * 0.25, visual.radius * 0.6 + rank * flagshipRadius * 0.5);
      this.group.add(visual.root);
      this.escorts.push({
        ship,
        visual,
        slot,
        offset: slot.clone(),
        quaternion: flagshipQuat.clone(),
        phase: rng.range(0, Math.PI * 2),
      });
    });
  }

  /** Snap everyone into formation (after a teleport, load or jump). */
  snap(flagshipQuat: THREE.Quaternion): void {
    for (const e of this.escorts) {
      e.offset.copy(e.slot);
      e.quaternion.copy(flagshipQuat);
    }
  }

  get count(): number {
    return this.escorts.length;
  }

  /**
   * @param flagshipRender flagship position relative to the camera
   * @param aimLocal turret aim direction in ship-local space
   */
  update(dt: number, time: number, flagshipRender: THREE.Vector3, flagshipQuat: THREE.Quaternion, throttle: number, boost: boolean, supercruise: number, aimLocal: THREE.Vector3 | null): void {
    const k = 1 - Math.exp(-dt * 1.6);
    for (const e of this.escorts) {
      // A gentle bob so the formation feels alive.
      const bob = _v.set(Math.sin(time * 0.37 + e.phase), Math.sin(time * 0.53 + e.phase * 1.7) * 0.6, Math.cos(time * 0.29 + e.phase)).multiplyScalar(e.visual.radius * 0.12);
      e.offset.lerp(bob.add(e.slot), k);
      const before = _q.copy(e.quaternion);
      e.quaternion.slerp(flagshipQuat, 1 - Math.exp(-dt * 2.2));
      // Bank in proportion to how hard we're still turning to catch up.
      const turn = before.angleTo(flagshipQuat);
      e.visual.root.position.copy(e.offset).applyQuaternion(flagshipQuat).add(flagshipRender);
      e.visual.root.quaternion.copy(e.quaternion);
      e.visual.update(dt, time, throttle, boost, supercruise, THREE.MathUtils.clamp(turn * 1.5, 0, 0.5), 0);
      e.visual.aimTurrets(aimLocal, dt);
    }
  }

  dispose(): void {
    for (const e of this.escorts) {
      this.group.remove(e.visual.root);
      e.visual.dispose();
    }
    this.escorts = [];
  }

  reset(): void {
    this.key = '';
  }
}
