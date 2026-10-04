import * as THREE from 'three';
import { Rng } from '../core/rng';
import { streakFragment, streakVertex } from './shaders/sky';

const BOX = 700;
const COUNT = 1400;

/**
 * Camera-local dust motes that wrap around the camera. They sell speed in
 * normal flight and stretch into hyperspace streaks during supercruise.
 */
export class SpaceDust {
  readonly mesh: THREE.LineSegments;
  private readonly material: THREE.ShaderMaterial;
  private readonly travel = new THREE.Vector3();

  constructor(seed: number) {
    const rng = new Rng(seed);
    const offsets = new Float32Array(COUNT * 2 * 3);
    const ends = new Float32Array(COUNT * 2);
    for (let i = 0; i < COUNT; i++) {
      const x = rng.range(-BOX / 2, BOX / 2);
      const y = rng.range(-BOX / 2, BOX / 2);
      const z = rng.range(-BOX / 2, BOX / 2);
      offsets.set([x, y, z, x, y, z], i * 6);
      ends[i * 2] = 0;
      ends[i * 2 + 1] = 1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 2 * 3), 3));
    geo.setAttribute('aOffset', new THREE.BufferAttribute(offsets, 3));
    geo.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    this.material = new THREE.ShaderMaterial({
      vertexShader: streakVertex,
      fragmentShader: streakFragment,
      uniforms: {
        uTravel: { value: new THREE.Vector3() },
        uVelDir: { value: new THREE.Vector3(0, 0, -1) },
        uLength: { value: 1 },
        uBox: { value: BOX },
        uColor: { value: new THREE.Color(0.7, 0.8, 1.0) },
        uIntensity: { value: 0 },
      },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.LineSegments(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  /**
   * @param velocity frame-relative velocity in system axes
   * @param supercruise 0..1 blend
   */
  update(dt: number, velocity: THREE.Vector3, speed: number, supercruise: number): void {
    const u = this.material.uniforms;
    const dir = speed > 0.01 ? velocity.clone().divideScalar(Math.max(velocity.length(), 1e-6)) : new THREE.Vector3(0, 0, -1);
    // Visual flow speed: true speed in normal flight; a log-mapped rate in supercruise.
    const visSpeed = THREE.MathUtils.lerp(speed, 1400 + 380 * Math.log10(Math.max(speed, 1000) / 1000), supercruise);
    this.travel.addScaledVector(dir, visSpeed * dt);
    this.travel.set(this.travel.x % BOX, this.travel.y % BOX, this.travel.z % BOX);
    (u.uTravel.value as THREE.Vector3).copy(this.travel);
    (u.uVelDir.value as THREE.Vector3).copy(dir);
    u.uLength.value = THREE.MathUtils.lerp(Math.min(speed * 0.03, 30), 90 + 260 * supercruise, supercruise);
    u.uIntensity.value = THREE.MathUtils.lerp(THREE.MathUtils.smoothstep(speed, 8, 160) * 0.4, 1.3, supercruise);
    (u.uColor.value as THREE.Color).setRGB(0.7, 0.8, 1.0).lerp(new THREE.Color(0.75, 0.6, 1.4), supercruise);
  }
}
