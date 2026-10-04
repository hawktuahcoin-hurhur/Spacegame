import * as THREE from 'three';
import type { HullDef, SlotDef } from '../ships/defs';

/** Half-extents of a hull's hit ellipsoid and its shield bubble, in metres (ship-local axes). */
export interface ShipDims {
  hull: THREE.Vector3;
  shield: THREE.Vector3;
  /** Bounding radius (broadphase). */
  bound: number;
  /** Radius used for ship-to-ship collisions. */
  collide: number;
}

/** Hit volumes derived from the procedural recipe (matches `buildShip` closely enough for gameplay). */
export function hullDims(h: HullDef): ShipDims {
  const r = h.recipe;
  const L = r.length;
  const W = r.beam * L;
  const H = r.height * L;
  const wingSpan = r.wings > 0 ? W * r.wings * 1.5 : 0;
  const halfX = W * 0.5 + wingSpan * 0.6 + (r.pods ? W * 0.15 : 0);
  const halfY = H * 0.6 + (r.towers > 0 ? H * 0.3 : 0);
  const halfZ = L * 0.5;
  const sx = Math.max(halfX * 1.25, halfZ * 0.45) + 2;
  const sz = halfZ * 1.12 + 2;
  const sy = Math.max(halfY * 2.2, sx * 0.5);
  return {
    hull: new THREE.Vector3(halfX, halfY, halfZ),
    shield: new THREE.Vector3(sx, sy, sz),
    bound: Math.max(sx, sy, sz),
    collide: Math.sqrt(halfX * halfZ) * 1.1,
  };
}

/** Approximate mount position for a slot (the game replaces these with the built model's). */
export function approxMount(h: HullDef, slot: SlotDef, out = new THREE.Vector3()): THREE.Vector3 {
  const d = hullDims(h).hull;
  const L = h.recipe.length;
  const W = h.recipe.beam * L;
  const x =
    slot.zone === 'wing' ? d.x * 0.7 : slot.zone === 'flank' ? W * 0.55 : slot.zone === 'nose' ? W * 0.14 : W * 0.24;
  const y = slot.zone === 'ventral' ? -d.y * 0.6 : d.y * 0.6;
  return out.set(slot.side * x, y, -L / 2 + slot.t * L);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Segment p0→p1 against an ellipsoid (centre, orientation, half-extents).
 * Returns the entry parameter in [0, 1], or -1 for a miss. Segments that start
 * inside report 0.
 */
export function segmentEllipsoid(p0: THREE.Vector3, p1: THREE.Vector3, center: THREE.Vector3, quat: THREE.Quaternion, axes: THREE.Vector3): number {
  _q.copy(quat).invert();
  const o = _a.copy(p0).sub(center).applyQuaternion(_q).divide(axes);
  const d = _b.copy(p1).sub(center).applyQuaternion(_q).divide(axes).sub(o);
  const a = d.dot(d);
  const b = 2 * o.dot(d);
  const c = o.dot(o) - 1;
  if (c <= 0) return 0;
  if (a < 1e-12) return -1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : -1;
}

/** Like segmentEllipsoid but only counts entries from outside (a segment starting inside misses). */
export function segmentEllipsoidOutside(p0: THREE.Vector3, p1: THREE.Vector3, center: THREE.Vector3, quat: THREE.Quaternion, axes: THREE.Vector3): number {
  _q.copy(quat).invert();
  const o = _a.copy(p0).sub(center).applyQuaternion(_q).divide(axes);
  if (o.dot(o) <= 1) return -1;
  return segmentEllipsoid(p0, p1, center, quat, axes);
}

/** Squared distance from point p to segment a→b. */
export function pointSegmentDistSq(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const len = abx * abx + aby * aby + abz * abz;
  let t = len > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = a.x + abx * t - p.x;
  const dy = a.y + aby * t - p.y;
  const dz = a.z + abz * t - p.z;
  return dx * dx + dy * dy + dz * dz;
}

/** Bearing of a ship-local direction: 0 = nose, positive = towards port (radians). */
export function bearingOf(local: THREE.Vector3): number {
  return Math.atan2(-local.x, -local.z);
}

/** Wrap an angle to (-π, π]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/** World yaw of a direction on the combat plane (0 = -Z, positive turns towards -X). */
export function yawOf(dir: THREE.Vector3): number {
  return Math.atan2(-dir.x, -dir.z);
}

/**
 * Time for a projectile of `speed` to meet a target at relative position `rel`
 * moving at relative velocity `vel`; null if it can never catch up.
 */
export function interceptTime(rel: THREE.Vector3, vel: THREE.Vector3, speed: number): number | null {
  const a = vel.dot(vel) - speed * speed;
  const b = 2 * rel.dot(vel);
  const c = rel.dot(rel);
  if (Math.abs(a) < 1e-6) {
    if (Math.abs(b) < 1e-9) return null;
    const t = -c / b;
    return t > 0 ? t : null;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t1 = (-b - s) / (2 * a);
  const t2 = (-b + s) / (2 * a);
  const t = Math.min(t1, t2) > 0 ? Math.min(t1, t2) : Math.max(t1, t2);
  return t > 0 ? t : null;
}
