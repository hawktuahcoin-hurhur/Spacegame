import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { type Controls, type FlightEnv, SHIP_STATS, SUPERCRUISE, ShipController, supercruiseCap } from '../src/ships/flight';

const idle: Controls = {
  throttleAxis: 0,
  strafeX: 0,
  strafeY: 0,
  roll: 0,
  mouseDX: 0,
  mouseDY: 0,
  boost: false,
  zeroThrottle: false,
  toggleSupercruise: false,
};
const openSpace: FlightEnv = { surfaceDistance: 1e9, massLock: null, arrived: null, targetDir: null };

function run(ship: ShipController, seconds: number, c: Partial<Controls> = {}, env: Partial<FlightEnv> = {}): THREE.Vector3 {
  const total = new THREE.Vector3();
  const d = new THREE.Vector3();
  for (let t = 0; t < seconds; t += 1 / 60) total.add(ship.update(1 / 60, { ...idle, ...c }, { ...openSpace, ...env }, d));
  return total;
}

describe('supercruiseCap', () => {
  it('scales with distance and is clamped', () => {
    expect(supercruiseCap(0)).toBe(SUPERCRUISE.minSpeed);
    expect(supercruiseCap(1e12)).toBe(SUPERCRUISE.maxSpeed);
    expect(supercruiseCap(1e6)).toBeGreaterThan(supercruiseCap(1e5));
  });
});

describe('ShipController', () => {
  it('accelerates to max speed at full throttle and moves forward (-Z)', () => {
    const ship = new ShipController();
    ship.throttle = 1;
    const moved = run(ship, 10);
    expect(ship.speed).toBeCloseTo(SHIP_STATS.maxSpeed, 0);
    expect(moved.z).toBeLessThan(-1000);
    expect(Math.abs(moved.x)).toBeLessThan(1e-6);
  });

  it('refuses to charge while mass locked', () => {
    const ship = new ShipController();
    const events: string[] = [];
    ship.onEvent((e) => events.push(e.type));
    run(ship, 0.1, { toggleSupercruise: true }, { massLock: 'Mass locked' });
    expect(ship.mode).toBe('normal');
    expect(events).toContain('masslocked');
  });

  it('charges, engages, and drops on arrival with a sane speed', () => {
    const ship = new ShipController();
    ship.throttle = 1;
    ship.update(1 / 60, { ...idle, toggleSupercruise: true }, openSpace, new THREE.Vector3());
    expect(ship.mode).toBe('charging');
    run(ship, SUPERCRUISE.chargeTime + 0.1);
    expect(ship.mode).toBe('supercruise');
    run(ship, 20);
    expect(ship.speed).toBeGreaterThan(1e5);
    run(ship, 0.1, {}, { arrived: 'Arrived' });
    expect(ship.mode).toBe('normal');
    expect(ship.speed).toBeLessThanOrEqual(SHIP_STATS.maxSpeed + 1e-6);
  });

  it('slows down when approaching a gravity well', () => {
    const ship = new ShipController();
    ship.mode = 'supercruise';
    ship.scSpeed = SUPERCRUISE.maxSpeed;
    ship.throttle = 1;
    run(ship, 5, {}, { surfaceDistance: 1e6 });
    expect(ship.speed).toBeLessThan(supercruiseCap(1e6) * 1.05);
  });

  it('auto-align turns the nose toward the target', () => {
    const ship = new ShipController();
    const target = new THREE.Vector3(1, 0.3, 0).normalize();
    ship.setAutoAlign(true);
    run(ship, 8, {}, { targetDir: target });
    expect(ship.forward.angleTo(target)).toBeLessThan(0.05);
  });

  it('mouse aim: turns onto the aimed orientation, including roll, without overshooting', () => {
    for (const [axis, angle] of [
      [new THREE.Vector3(0, 1, 0), Math.PI / 2],
      [new THREE.Vector3(1, 0, 0), -Math.PI * 0.8],
      [new THREE.Vector3(0, 0, 1), Math.PI / 3],
      [new THREE.Vector3(1, 1, 0).normalize(), 2.5],
    ] as const) {
      const ship = new ShipController();
      const aim = new THREE.Quaternion().setFromAxisAngle(axis, angle);
      let maxErrAfter = 0;
      for (let t = 0; t < 8; t += 1 / 60) {
        ship.update(1 / 60, { ...idle, aim }, openSpace, new THREE.Vector3());
        if (t > 5) maxErrAfter = Math.max(maxErrAfter, ship.quaternion.angleTo(aim));
      }
      expect(ship.quaternion.angleTo(aim)).toBeLessThan(0.01);
      expect(maxErrAfter).toBeLessThan(0.02);
    }
  });

  it('mouse aim ignores raw mouse deltas', () => {
    const ship = new ShipController();
    const aim = new THREE.Quaternion();
    run(ship, 2, { aim, mouseDX: 400, mouseDY: 400 });
    expect(ship.quaternion.angleTo(aim)).toBeLessThan(1e-6);
  });
});
