import * as THREE from 'three';
import { bodyRotation, orbitPosition, tiltQuaternion } from '../galaxy/orbits';
import type { BodyDef, StarSystemDef, StationDef } from '../galaxy/types';

/**
 * Anything the player can navigate to and that can act as a local reference
 * frame. Positions are system-space metres in float64 (JS numbers); the
 * renderer converts them to camera-relative float32 every frame.
 */
export interface Anchor {
  id: string;
  name: string;
  kind: 'star' | 'body' | 'station';
  position: THREE.Vector3;
  radius: number;
  /** Radius of this anchor's reference frame. Infinity for the star. */
  soiRadius: number;
  /** Frame parent; null = system frame. */
  parent: Anchor | null;
}

export interface StarState extends Anchor {
  kind: 'star';
}

export interface BodyState extends Anchor {
  kind: 'body';
  def: BodyDef;
  rotation: THREE.Quaternion;
  cloudRotation: THREE.Quaternion;
  tilt: THREE.Quaternion;
  /** Top of atmosphere (radius from centre), or radius if airless. */
  atmosphereTop: number;
  parent: BodyState | null;
}

export interface StationState extends Anchor {
  kind: 'station';
  def: StationDef;
  rotation: THREE.Quaternion;
  parent: BodyState;
}

const _v = new THREE.Vector3();
const _spin = new THREE.Quaternion();
const _yAxis = new THREE.Vector3(0, 1, 0);

export class Universe {
  readonly star: StarState;
  readonly bodies: BodyState[] = [];
  readonly stations: StationState[] = [];
  readonly anchors: Anchor[] = [];
  private readonly byId = new Map<string, Anchor>();
  time = 0;

  constructor(readonly system: StarSystemDef) {
    this.star = {
      id: 'star',
      name: system.star.name,
      kind: 'star',
      position: new THREE.Vector3(),
      radius: system.star.radius,
      soiRadius: Infinity,
      parent: null,
    };
    this.anchors.push(this.star);
    this.byId.set('star', this.star);

    for (const def of system.bodies) {
      const state: BodyState = {
        id: def.id,
        name: def.name,
        kind: 'body',
        def,
        position: new THREE.Vector3(),
        rotation: new THREE.Quaternion(),
        cloudRotation: new THREE.Quaternion(),
        tilt: tiltQuaternion(def),
        radius: def.radius,
        soiRadius: def.soiRadius,
        atmosphereTop: def.radius + (def.atmosphere?.height ?? 0),
        parent: null,
      };
      this.bodies.push(state);
      this.byId.set(def.id, state);
    }
    for (const b of this.bodies) b.parent = b.def.parentId ? (this.byId.get(b.def.parentId) as BodyState) : null;
    for (const def of system.stations) {
      const parent = this.byId.get(def.parentId) as BodyState;
      const st: StationState = {
        id: def.id,
        name: def.name,
        kind: 'station',
        def,
        position: new THREE.Vector3(),
        rotation: new THREE.Quaternion(),
        radius: def.radius,
        soiRadius: 25_000,
        parent,
      };
      this.stations.push(st);
      this.byId.set(def.id, st);
    }
    this.anchors.push(...this.bodies, ...this.stations);
    this.update(0);
  }

  get(id: string): Anchor | undefined {
    return this.byId.get(id);
  }

  /** Recompute every position/rotation at time t. Parents come before children. */
  update(t: number): void {
    this.time = t;
    for (const b of this.bodies) {
      orbitPosition(b.def.orbit, t, b.position);
      if (b.parent) b.position.applyQuaternion(b.parent.tilt).add(b.parent.position);
      bodyRotation(b.def, t, b.rotation);
      // Clouds drift slightly faster than the surface.
      const cloudAngle = (2 * Math.PI * t) / (b.def.rotationPeriod * 0.82);
      b.cloudRotation.copy(b.tilt).multiply(_spin.setFromAxisAngle(_yAxis, cloudAngle));
    }
    for (const s of this.stations) {
      orbitPosition(s.def.orbit, t, s.position).applyQuaternion(s.parent.tilt).add(s.parent.position);
      // Station spin axis follows the planet's axis; it slowly turns to face along its orbit.
      s.rotation.copy(s.parent.tilt).multiply(_spin.setFromAxisAngle(_yAxis, t * 0.01));
    }
  }

  /** Anchors whose frame parent is `frame` (null → system-level). */
  childrenOf(frame: Anchor | null): Anchor[] {
    if (frame === null) return this.bodies.filter((b) => b.parent === null);
    return this.anchors.filter((a) => a.parent === frame);
  }

  /** Distance from a point to the nearest surface (star, body, or station hull). */
  nearestSurface(p: THREE.Vector3, includeStations = true): { anchor: Anchor; distance: number } {
    let best: Anchor = this.star;
    let bestD = p.distanceTo(this.star.position) - this.star.radius;
    for (const a of this.anchors) {
      if (a.kind === 'star' || (!includeStations && a.kind === 'station')) continue;
      const d = _v.copy(p).sub(a.position).length() - a.radius;
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return { anchor: best, distance: bestD };
  }
}
