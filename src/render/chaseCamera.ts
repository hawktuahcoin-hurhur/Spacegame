import * as THREE from 'three';

/** Smoothed third-person chase camera. */
export class ChaseCamera {
  private readonly offset = new THREE.Vector3(0, 3.5, 14);
  private readonly lookAhead = new THREE.Vector3(0, 1.5, -20);

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private readonly target: THREE.Object3D,
  ) {
    this.snap();
  }

  snap(): void {
    this.camera.position.copy(this.offset).applyQuaternion(this.target.quaternion).add(this.target.position);
    this.camera.quaternion.copy(this.target.quaternion);
  }

  update(dt: number): void {
    const desiredPos = this.offset.clone().applyQuaternion(this.target.quaternion).add(this.target.position);
    const k = 1 - Math.exp(-dt * 6);
    this.camera.position.lerp(desiredPos, k);
    this.camera.quaternion.slerp(this.target.quaternion, k);
    const look = this.lookAhead.clone().applyQuaternion(this.target.quaternion).add(this.target.position);
    const m = new THREE.Matrix4().lookAt(this.camera.position, look, new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion));
    this.camera.quaternion.setFromRotationMatrix(m);
  }
}
