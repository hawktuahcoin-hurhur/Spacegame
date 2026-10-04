import * as THREE from 'three';

/**
 * Third-person chase camera. Smoothing happens in ship-relative space, so the
 * camera never lags kilometres behind at supercruise speeds. Produces an
 * offset from the ship (system orientation) plus an orientation.
 */
export class ChaseCamera {
  /** Camera position relative to the ship, in system-space axes. */
  readonly offset = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  private readonly baseOffset = new THREE.Vector3(0, 7.5, 34);
  private readonly lookAhead = new THREE.Vector3(0, 3, -40);
  private readonly shake = new THREE.Vector3();
  zoom = 1;
  /** Ship size factor (1 = starter frigate); bigger flagships pull the camera back. */
  scale = 1;
  orbitYaw = 0;
  orbitPitch = 0;

  snap(shipQuat: THREE.Quaternion): void {
    this.offset.copy(this.baseOffset).multiplyScalar(this.zoom * this.scale).applyQuaternion(shipQuat);
    this.quaternion.copy(shipQuat);
  }

  update(dt: number, shipQuat: THREE.Quaternion, speedFactor: number, shakeAmount: number, time: number): void {
    const local = this.baseOffset.clone().multiplyScalar(this.zoom * this.scale);
    // Pull back slightly with speed.
    local.z += speedFactor * 6 * this.scale;
    local.applyAxisAngle(new THREE.Vector3(1, 0, 0), this.orbitPitch);
    local.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.orbitYaw);
    const desired = local.applyQuaternion(shipQuat);
    const k = 1 - Math.exp(-dt * 7);
    this.offset.lerp(desired, k);

    // Orientation: look at a point ahead of the ship, with the ship's up vector (smoothed).
    const look = this.lookAhead.clone().multiplyScalar(this.scale).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.orbitYaw).applyQuaternion(shipQuat);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(shipQuat);
    const m = new THREE.Matrix4().lookAt(this.offset, look, up);
    const target = new THREE.Quaternion().setFromRotationMatrix(m);
    this.quaternion.slerp(target, 1 - Math.exp(-dt * 9));

    if (shakeAmount > 0) {
      this.shake.set(Math.sin(time * 61.3) + Math.sin(time * 23.1), Math.sin(time * 47.9) + Math.cos(time * 31.7), 0).multiplyScalar(shakeAmount * 0.004);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.shake.x, this.shake.y, 0));
      this.quaternion.multiply(q);
    }
  }
}
