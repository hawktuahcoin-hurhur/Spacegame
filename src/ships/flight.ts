import * as THREE from 'three';

export type FlightStats = typeof SHIP_STATS;

/** Default flight stats (the starter Kestrel frigate). Real ships derive theirs from hull stats. */
export const SHIP_STATS = {
  maxSpeed: 260,
  /** Boost is a sprint: many times top speed, reached in a few seconds. */
  boostMultiplier: 10,
  accel: 95,
  strafeAccel: 70,
  pitchRate: 1.25,
  yawRate: 0.95,
  rollRate: 2.2,
  lateralDamping: 1.4,
};

export const SUPERCRUISE = {
  chargeTime: 2.5,
  minSpeed: 2_000,
  maxSpeed: 3.0e6,
  /** Speed cap per metre of distance to the nearest surface (1/s). */
  k: 0.4,
  turnFactor: 0.55,
};

/** Supercruise speed limit: proportional to the distance to the nearest surface. */
export function supercruiseCap(surfaceDistance: number): number {
  return THREE.MathUtils.clamp(surfaceDistance * SUPERCRUISE.k, SUPERCRUISE.minSpeed, SUPERCRUISE.maxSpeed);
}

export type FlightMode = 'normal' | 'charging' | 'supercruise';

export interface Controls {
  throttleAxis: number;
  strafeX: number;
  strafeY: number;
  roll: number;
  mouseDX: number;
  mouseDY: number;
  boost: boolean;
  zeroThrottle: boolean;
  toggleSupercruise: boolean;
  /**
   * Mouse-aim steering: the orientation the pilot is looking along (system axes).
   * When set, the ship turns itself to match it and mouse deltas are ignored.
   */
  aim?: THREE.Quaternion | null;
}

/** How hard the ship chases the aim orientation (1/s); rates are still capped per axis. */
const AIM_GAIN = 3.2;

export interface FlightEnv {
  /** Distance to the nearest surface (for the supercruise cap). */
  surfaceDistance: number;
  /** Supercruise cannot be engaged (and is dropped) when set. */
  massLock: string | null;
  /** Supercruise target reached: drop automatically. */
  arrived: string | null;
  /** System-space direction to the nav target, used by auto-align. */
  targetDir: THREE.Vector3 | null;
}

export type FlightEvent =
  | { type: 'charging' }
  | { type: 'engaged' }
  | { type: 'dropped'; reason: string }
  | { type: 'masslocked'; reason: string }
  | { type: 'align'; on: boolean };

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _lat = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _local = new THREE.Vector3();

/**
 * Arcade 6DOF flight with a virtual-joystick mouse and an Elite-style
 * supercruise whose speed scales with distance to the nearest gravity well.
 * Velocity and position are relative to the ship's current reference frame.
 */
/** Flight stats from a hull's effective stats (speed in m/s, turn rate in degrees/s). */
export function flightStatsFor(hull: { maxSpeed: number; accel: number; turnRate: number }): FlightStats {
  const turn = THREE.MathUtils.degToRad(hull.turnRate);
  return {
    ...SHIP_STATS,
    maxSpeed: hull.maxSpeed,
    accel: hull.accel,
    strafeAccel: hull.accel * 0.75,
    pitchRate: turn,
    yawRate: turn * 0.78,
    rollRate: Math.max(0.6, turn * 1.8),
  };
}

export class ShipController {
  mode: FlightMode = 'normal';
  stats: FlightStats = { ...SHIP_STATS };
  charge = 0;
  throttle = 0;
  scSpeed = 0;
  autoAlign = false;
  readonly velocity = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  /** Virtual joystick, unit disc. */
  readonly stick = new THREE.Vector2();
  /** Smoothed angular rates: pitch, yaw, roll (rad/s). */
  readonly angular = new THREE.Vector3();
  boosting = false;
  /** Seconds since the last supercruise transition (for VFX). */
  transitionAge = 999;
  private listeners: ((e: FlightEvent) => void)[] = [];

  onEvent(fn: (e: FlightEvent) => void): void {
    this.listeners.push(fn);
  }

  private emit(e: FlightEvent): void {
    for (const l of this.listeners) l(e);
  }

  get forward(): THREE.Vector3 {
    return _fwd.set(0, 0, -1).applyQuaternion(this.quaternion);
  }

  get speed(): number {
    return this.mode === 'supercruise' ? this.scSpeed : this.velocity.length();
  }

  dropOut(reason: string): void {
    if (this.mode === 'normal') return;
    const was = this.mode;
    this.mode = 'normal';
    this.charge = 0;
    if (was === 'supercruise') {
      this.velocity.copy(this.forward).multiplyScalar(Math.min(this.scSpeed, this.stats.maxSpeed));
      this.throttle = Math.min(this.throttle, 0.75);
      this.transitionAge = 0;
    }
    this.emit({ type: 'dropped', reason });
  }

  /** Advance one fixed step. Returns the displacement (frame-relative) to apply. */
  update(dt: number, c: Controls, env: FlightEnv, out: THREE.Vector3): THREE.Vector3 {
    this.transitionAge += dt;
    const s = this.stats;

    // --- Supercruise state machine.
    if (c.toggleSupercruise) {
      if (this.mode === 'normal') {
        if (env.massLock) this.emit({ type: 'masslocked', reason: env.massLock });
        else {
          this.mode = 'charging';
          this.charge = 0;
          this.emit({ type: 'charging' });
        }
      } else {
        this.dropOut(this.mode === 'charging' ? 'Charge cancelled' : 'Disengaged');
      }
    }
    if (this.mode === 'charging') {
      if (env.massLock) {
        this.dropOut(env.massLock);
      } else {
        this.charge += dt;
        if (this.charge >= SUPERCRUISE.chargeTime) {
          this.mode = 'supercruise';
          this.scSpeed = Math.max(this.velocity.dot(this.forward), 500);
          this.throttle = Math.max(this.throttle, 0.5);
          this.transitionAge = 0;
          this.emit({ type: 'engaged' });
        }
      }
    } else if (this.mode === 'supercruise') {
      if (env.massLock) this.dropOut(env.massLock);
      else if (env.arrived) this.dropOut(env.arrived);
    }

    // --- Throttle.
    if (c.zeroThrottle) this.throttle = 0;
    this.throttle = THREE.MathUtils.clamp(this.throttle + c.throttleAxis * dt * 0.7, 0, 1);

    const turn = this.mode === 'supercruise' ? SUPERCRUISE.turnFactor : 1;
    if (c.aim) {
      // --- Mouse aim: rotate toward where the pilot is looking.
      this.stick.multiplyScalar(Math.exp(-dt * 8));
      const err = _q.copy(this.quaternion).invert().multiply(c.aim);
      if (err.w < 0) err.set(-err.x, -err.y, -err.z, -err.w);
      const angle = 2 * Math.acos(Math.min(1, err.w));
      const sinHalf = Math.sqrt(Math.max(1 - err.w * err.w, 0));
      const k = sinHalf > 1e-6 ? (angle / sinHalf) * AIM_GAIN : 0;
      // Error as a local rotation vector (x pitch, y yaw, z roll), turned into capped rates.
      const target = _lat.set(
        THREE.MathUtils.clamp(err.x * k, -s.pitchRate * turn, s.pitchRate * turn),
        THREE.MathUtils.clamp(err.y * k, -s.yawRate * turn, s.yawRate * turn),
        THREE.MathUtils.clamp(err.z * k, -s.rollRate, s.rollRate),
      );
      this.angular.lerp(target, 1 - Math.exp(-dt * 9));
      _q.setFromEuler(_e.set(this.angular.x * dt, this.angular.y * dt, this.angular.z * dt, 'XYZ'));
      this.quaternion.multiply(_q).normalize();
      return this.translate(dt, c, env, out);
    }

    // --- Classic steering: mouse drives a virtual stick that eases back to centre.
    const mouseMag = Math.abs(c.mouseDX) + Math.abs(c.mouseDY);
    if (this.autoAlign && mouseMag > 4) {
      this.autoAlign = false;
      this.emit({ type: 'align', on: false });
    }
    this.stick.x += c.mouseDX * 0.0022;
    this.stick.y += c.mouseDY * 0.0022;
    if (this.stick.lengthSq() > 1) this.stick.normalize();
    if (mouseMag === 0) this.stick.multiplyScalar(Math.exp(-dt * 1.4));

    if (this.autoAlign && env.targetDir) {
      _local.copy(env.targetDir).applyQuaternion(_q.copy(this.quaternion).invert());
      const yawErr = Math.atan2(-_local.x, -_local.z);
      const pitchErr = Math.atan2(_local.y, Math.hypot(_local.x, _local.z));
      this.stick.set(THREE.MathUtils.clamp(-yawErr * 2.5, -1, 1), THREE.MathUtils.clamp(-pitchErr * 2.5, -1, 1));
    }

    const dead = (v: number) => (Math.abs(v) < 0.04 ? 0 : (v - Math.sign(v) * 0.04) / 0.96);
    const target = _lat.set(-dead(this.stick.y) * s.pitchRate * turn, -dead(this.stick.x) * s.yawRate * turn, c.roll * s.rollRate);
    this.angular.lerp(target, 1 - Math.exp(-dt * 6));
    _q.setFromEuler(_e.set(this.angular.x * dt, this.angular.y * dt, this.angular.z * dt, 'XYZ'));
    this.quaternion.multiply(_q).normalize();
    return this.translate(dt, c, env, out);
  }

  /** Thrust, supercruise speed and flight assist; returns the frame-relative displacement. */
  private translate(dt: number, c: Controls, env: FlightEnv, out: THREE.Vector3): THREE.Vector3 {
    const s = this.stats;
    const forward = this.forward.clone();
    _right.set(1, 0, 0).applyQuaternion(this.quaternion);
    _up.set(0, 1, 0).applyQuaternion(this.quaternion);

    if (this.mode === 'supercruise') {
      const cap = supercruiseCap(env.surfaceDistance);
      const want = Math.max(this.throttle * cap, SUPERCRUISE.minSpeed);
      const rate = want > this.scSpeed ? 0.85 : 2.8;
      this.scSpeed += (want - this.scSpeed) * (1 - Math.exp(-dt * rate));
      this.velocity.copy(forward).multiplyScalar(this.scSpeed);
      this.boosting = false;
    } else {
      this.boosting = c.boost && this.mode === 'normal';
      const boost = this.boosting ? s.boostMultiplier : 1;
      const maxSpeed = s.maxSpeed * boost;
      const fwdSpeed = this.velocity.dot(forward);
      // Boost always drives to the boosted top speed, whatever the throttle.
      const desired = this.boosting ? maxSpeed : this.throttle * maxSpeed;
      const dv = THREE.MathUtils.clamp(desired - fwdSpeed, -s.accel * dt * boost, s.accel * dt * boost);
      this.velocity.addScaledVector(forward, dv);
      this.velocity.addScaledVector(_right, c.strafeX * s.strafeAccel * dt);
      this.velocity.addScaledVector(_up, c.strafeY * s.strafeAccel * dt);
      // Flight assist: bleed off drift that isn't along the nose.
      if (c.strafeX === 0 && c.strafeY === 0) {
        _lat.copy(this.velocity).addScaledVector(forward, -this.velocity.dot(forward));
        this.velocity.addScaledVector(_lat, -Math.min(1, s.lateralDamping * dt));
      }
      const limit = Math.max(maxSpeed, s.maxSpeed);
      if (this.velocity.length() > limit) this.velocity.multiplyScalar(1 - Math.min(1, dt * 1.5));
    }
    return out.copy(this.velocity).multiplyScalar(dt);
  }

  setAutoAlign(on: boolean): void {
    this.autoAlign = on;
    this.emit({ type: 'align', on });
  }
}
