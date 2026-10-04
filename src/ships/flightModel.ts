import * as THREE from 'three';
import type { Input } from '../core/input';

export interface FlightStats {
  maxSpeed: number;
  boostMultiplier: number;
  accel: number;
  strafeAccel: number;
  turnRate: number; // rad/s at full stick
  rollRate: number;
  linearDamping: number; // fraction of velocity lost per second when not thrusting
}

export const DEFAULT_FLIGHT: FlightStats = {
  maxSpeed: 120,
  boostMultiplier: 3,
  accel: 60,
  strafeAccel: 40,
  turnRate: 1.6,
  rollRate: 2.2,
  linearDamping: 0.6,
};

/**
 * Arcade 6DOF flight: throttle-based forward thrust, strafe, mouse pitch/yaw.
 * Combat will constrain this to the combat plane slab (SUPERPLAN §3.5).
 */
export class FlightModel {
  readonly velocity = new THREE.Vector3();
  throttle = 0; // 0..1
  private angular = new THREE.Vector3(); // pitch, yaw, roll (smoothed)

  constructor(
    readonly object: THREE.Object3D,
    readonly stats: FlightStats = DEFAULT_FLIGHT,
  ) {}

  update(dt: number, input: Input): void {
    const s = this.stats;
    const { dx, dy } = input.consumeMouse();

    this.throttle = THREE.MathUtils.clamp(this.throttle + input.axis('KeyS', 'KeyW') * dt * 0.8, 0, 1);

    // Mouse steers; smoothing gives the ship a sense of mass.
    const target = new THREE.Vector3(
      THREE.MathUtils.clamp(-dy * 0.08, -1, 1) * s.turnRate,
      THREE.MathUtils.clamp(-dx * 0.08, -1, 1) * s.turnRate,
      input.axis('KeyE', 'KeyQ') * s.rollRate,
    );
    this.angular.lerp(target, 1 - Math.exp(-dt * 8));
    const q = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(this.angular.x * dt, this.angular.y * dt, this.angular.z * dt, 'XYZ'),
    );
    this.object.quaternion.multiply(q).normalize();

    const boost = input.isDown('ShiftLeft') ? s.boostMultiplier : 1;
    const maxSpeed = s.maxSpeed * boost;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.object.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.object.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.object.quaternion);

    // Drive forward speed toward throttle setpoint.
    const forwardSpeed = this.velocity.dot(forward);
    const desired = this.throttle * maxSpeed;
    const dv = THREE.MathUtils.clamp(desired - forwardSpeed, -s.accel * dt * boost, s.accel * dt * boost);
    this.velocity.addScaledVector(forward, dv);

    this.velocity.addScaledVector(right, input.axis('KeyA', 'KeyD') * s.strafeAccel * dt);
    this.velocity.addScaledVector(up, input.axis('ControlLeft', 'Space') * s.strafeAccel * dt);

    // Bleed off lateral drift so the ship doesn't slide forever.
    const lateral = this.velocity.clone().addScaledVector(forward, -this.velocity.dot(forward));
    this.velocity.addScaledVector(lateral, -Math.min(1, s.linearDamping * dt));

    if (this.velocity.length() > maxSpeed) this.velocity.setLength(maxSpeed);
    this.object.position.addScaledVector(this.velocity, dt);
  }

  get speed(): number {
    return this.velocity.length();
  }
}
