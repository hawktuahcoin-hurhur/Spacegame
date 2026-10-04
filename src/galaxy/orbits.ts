import * as THREE from 'three';
import type { BodyDef, OrbitDef } from './types';

/** Solve Kepler's equation M = E - e sin E for E. */
export function eccentricAnomaly(meanAnomaly: number, e: number): number {
  let E = e < 0.8 ? meanAnomaly : Math.PI;
  for (let i = 0; i < 8; i++) {
    const dE = (E - e * Math.sin(E) - meanAnomaly) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

const _q = new THREE.Quaternion();
const _axisY = new THREE.Vector3(0, 1, 0);
const _axisX = new THREE.Vector3(1, 0, 0);

/** Position relative to the parent at time t (seconds), in the orbit's reference plane. */
export function orbitPosition(orbit: OrbitDef, t: number, out = new THREE.Vector3()): THREE.Vector3 {
  const M = orbit.meanAnomalyAtEpoch + (2 * Math.PI * t) / orbit.period;
  const e = orbit.eccentricity;
  const E = eccentricAnomaly(((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), e);
  const a = orbit.semiMajorAxis;
  const x = a * (Math.cos(E) - e);
  const z = -a * Math.sqrt(1 - e * e) * Math.sin(E);
  out.set(x, 0, z);
  out.applyQuaternion(_q.setFromAxisAngle(_axisY, orbit.argPeriapsis));
  out.applyQuaternion(_q.setFromAxisAngle(_axisX, orbit.inclination));
  out.applyQuaternion(_q.setFromAxisAngle(_axisY, orbit.ascendingNode));
  return out;
}

/** Points along the full orbit ellipse, for drawing. */
export function orbitPath(orbit: OrbitDef, segments = 256): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < segments; i++) {
    pts.push(orbitPosition(orbit, (i / segments) * orbit.period));
  }
  return pts;
}

/** Orientation of a body's spin axis (tilt), used for rotation, rings and moon planes. */
export function tiltQuaternion(body: Pick<BodyDef, 'axialTilt' | 'tiltAzimuth'>, out = new THREE.Quaternion()): THREE.Quaternion {
  const tilt = new THREE.Quaternion().setFromAxisAngle(_axisX, body.axialTilt);
  return out.setFromAxisAngle(_axisY, body.tiltAzimuth).multiply(tilt);
}

/** Full orientation of a body at time t: tilt * spin. */
export function bodyRotation(body: BodyDef, t: number, out = new THREE.Quaternion()): THREE.Quaternion {
  const spin = new THREE.Quaternion().setFromAxisAngle(_axisY, (2 * Math.PI * t) / body.rotationPeriod);
  return tiltQuaternion(body, out).multiply(spin);
}

/** Circular orbital speed approximation (for UI). */
export function meanOrbitalSpeed(orbit: OrbitDef): number {
  return (2 * Math.PI * orbit.semiMajorAxis) / orbit.period;
}
