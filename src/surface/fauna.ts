import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../core/rng';
import { hash2 } from './noise';
import type { SurfaceProfile } from './profile';
import type { Terrain } from './terrain';

export type BodyPlan = 'grazer' | 'hopper' | 'flyer';

export interface Species {
  index: number;
  plan: BodyPlan;
  size: number;
  speed: number;
  timid: boolean;
  color: THREE.Color;
  accent: THREE.Color;
  rarity: number;
}

export interface Creature {
  species: Species;
  group: THREE.Group;
  legs: THREE.Object3D[];
  wings: THREE.Object3D[];
  pos: THREE.Vector3;
  heading: number;
  goal: THREE.Vector3;
  phase: number;
  speed: number;
  /** Flight altitude for flyers. */
  alt: number;
  scanned: boolean;
  radius: number;
}

function paint(geo: THREE.BufferGeometry, c: THREE.Color): THREE.BufferGeometry {
  const g = geo.toNonIndexed();
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  g.deleteAttribute('uv');
  return g;
}

/** The planet's 1–3 animal species. */
export function speciesFor(profile: SurfaceProfile): Species[] {
  if (profile.fauna <= 0) return [];
  const rng = new Rng(profile.seed ^ 0xfa);
  const count = profile.fauna > 0.7 ? 3 : profile.fauna > 0.3 ? 2 : 1;
  const out: Species[] = [];
  for (let i = 0; i < count; i++) {
    const plan: BodyPlan = i === 2 || (profile.type === 'exotic' && i === 1) ? 'flyer' : rng.next() < 0.6 ? 'grazer' : 'hopper';
    const h = rng.next();
    out.push({
      index: i,
      plan,
      size: plan === 'flyer' ? rng.range(0.6, 1.4) : rng.range(0.6, 2.4),
      speed: rng.range(1.5, 3.5),
      timid: rng.next() < 0.7,
      color: new THREE.Color().setHSL(h, rng.range(0.25, 0.6), rng.range(0.3, 0.55)),
      accent: new THREE.Color().setHSL((h + rng.range(0.3, 0.6)) % 1, 0.7, 0.55),
      rarity: rng.next(),
    });
  }
  return out;
}

const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.8 });

/** Build a low-poly creature for a species. */
function buildCreature(sp: Species): { group: THREE.Group; legs: THREE.Object3D[]; wings: THREE.Object3D[] } {
  const g = new THREE.Group();
  const s = sp.size;
  const legs: THREE.Object3D[] = [];
  const wings: THREE.Object3D[] = [];
  const parts: THREE.BufferGeometry[] = [];
  if (sp.plan === 'grazer') {
    parts.push(paint(new THREE.IcosahedronGeometry(0.6, 0).scale(1, 0.7, 1.5).translate(0, 1.0, 0), sp.color));
    parts.push(paint(new THREE.IcosahedronGeometry(0.32, 0).translate(0, 1.25, -0.95), sp.color.clone().multiplyScalar(1.1)));
    parts.push(paint(new THREE.ConeGeometry(0.08, 0.4, 4).rotateX(-0.6).translate(0.15, 1.6, -1.0), sp.accent));
    parts.push(paint(new THREE.ConeGeometry(0.08, 0.4, 4).rotateX(-0.6).translate(-0.15, 1.6, -1.0), sp.accent));
    parts.push(paint(new THREE.BoxGeometry(0.5, 0.12, 0.9).translate(0, 1.45, 0.1), sp.accent));
    for (const [x, z] of [
      [0.3, -0.55],
      [-0.3, -0.55],
      [0.3, 0.55],
      [-0.3, 0.55],
    ]) {
      const leg = new THREE.Mesh(paint(new THREE.BoxGeometry(0.16, 0.8, 0.16).translate(0, -0.4, 0), sp.color.clone().multiplyScalar(0.7)), mat);
      leg.position.set(x, 0.85, z);
      g.add(leg);
      legs.push(leg);
    }
  } else if (sp.plan === 'hopper') {
    parts.push(paint(new THREE.IcosahedronGeometry(0.55, 1).scale(1, 1.1, 1).translate(0, 0.9, 0), sp.color));
    parts.push(paint(new THREE.IcosahedronGeometry(0.16, 0).translate(0.2, 1.25, -0.45), sp.accent));
    parts.push(paint(new THREE.IcosahedronGeometry(0.16, 0).translate(-0.2, 1.25, -0.45), sp.accent));
    parts.push(paint(new THREE.ConeGeometry(0.1, 0.9, 4).translate(0, 1.85, 0.1), sp.accent));
    for (const x of [0.28, -0.28]) {
      const leg = new THREE.Mesh(paint(new THREE.BoxGeometry(0.18, 0.55, 0.4).translate(0, -0.25, 0), sp.color.clone().multiplyScalar(0.7)), mat);
      leg.position.set(x, 0.55, 0.1);
      g.add(leg);
      legs.push(leg);
    }
  } else {
    parts.push(paint(new THREE.IcosahedronGeometry(0.3, 0).scale(1, 0.8, 2).translate(0, 0, 0), sp.color));
    parts.push(paint(new THREE.ConeGeometry(0.1, 0.5, 4).rotateX(-Math.PI / 2).translate(0, 0, -0.75), sp.accent));
    for (const side of [1, -1]) {
      const wing = new THREE.Mesh(paint(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, -0.3), new THREE.Vector3(side * 1.6, 0, 0), new THREE.Vector3(0, 0, 0.4)]), sp.accent), new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide }));
      (wing.geometry as THREE.BufferGeometry).computeVertexNormals();
      g.add(wing);
      wings.push(wing);
    }
  }
  const body = new THREE.Mesh(mergeGeometries(parts)!, mat);
  body.geometry.computeVertexNormals();
  g.add(body);
  g.scale.setScalar(s);
  g.traverse((o) => (o.castShadow = true));
  return { group: g, legs, wings };
}

/**
 * Wildlife around the player: herds spawn in the distance, graze, wander and
 * bolt when you get close (or come to investigate, if they're the curious kind).
 */
export class FaunaManager {
  readonly group = new THREE.Group();
  readonly creatures: Creature[] = [];
  private spawnT = 0;
  private serial = 0;

  constructor(
    private readonly species: Species[],
    private readonly terrain: Terrain,
    private readonly seed: number,
  ) {}

  update(dt: number, time: number, player: THREE.Vector3): void {
    this.spawnT -= dt;
    if (this.species.length && this.spawnT <= 0 && this.creatures.length < 14) {
      this.spawnT = 2;
      this.spawnHerd(player);
    }
    for (let i = this.creatures.length - 1; i >= 0; i--) {
      const c = this.creatures[i];
      if (c.pos.distanceTo(player) > 340) {
        this.group.remove(c.group);
        this.creatures.splice(i, 1);
        continue;
      }
      this.step(c, dt, time, player);
    }
  }

  private spawnHerd(player: THREE.Vector3): void {
    const n = this.serial++;
    const sp = this.species[Math.floor(hash2(n, 1, this.seed) * this.species.length)];
    const a = hash2(n, 2, this.seed) * Math.PI * 2;
    const d = 110 + hash2(n, 3, this.seed) * 120;
    const cx = player.x + Math.cos(a) * d;
    const cz = player.z + Math.sin(a) * d;
    const ground = this.terrain.height(cx, cz);
    if (this.terrain.wet(ground) && sp.plan !== 'flyer') return;
    const size = sp.plan === 'flyer' ? 2 + Math.floor(hash2(n, 4, this.seed) * 3) : 1 + Math.floor(hash2(n, 4, this.seed) * 4);
    for (let k = 0; k < size; k++) {
      const { group, legs, wings } = buildCreature(sp);
      const pos = new THREE.Vector3(cx + (hash2(n, k, 5) - 0.5) * 14, 0, cz + (hash2(n, k, 6) - 0.5) * 14);
      pos.y = this.terrain.surfaceHeight(pos.x, pos.z);
      const c: Creature = {
        species: sp,
        group,
        legs,
        wings,
        pos,
        heading: hash2(n, k, 7) * Math.PI * 2,
        goal: pos.clone(),
        phase: hash2(n, k, 8) * 10,
        speed: 0,
        alt: sp.plan === 'flyer' ? 14 + hash2(n, k, 9) * 18 : 0,
        scanned: false,
        radius: sp.size * (sp.plan === 'grazer' ? 1.2 : 0.8),
      };
      this.group.add(group);
      this.creatures.push(c);
    }
  }

  private step(c: Creature, dt: number, time: number, player: THREE.Vector3): void {
    const sp = c.species;
    const toPlayer = player.distanceTo(c.pos);
    let want = 0;
    if (toPlayer < 14 && sp.timid && sp.plan !== 'flyer') {
      // Bolt away from the player.
      c.goal.copy(c.pos).add(c.pos.clone().sub(player).setY(0).normalize().multiplyScalar(30));
      want = sp.speed * 2.6;
    } else if (!sp.timid && toPlayer < 30 && toPlayer > 6 && sp.plan !== 'flyer') {
      c.goal.copy(player);
      want = sp.speed * 0.8;
    } else {
      if (c.pos.distanceTo(c.goal) < 2 || Math.sin(time * 0.1 + c.phase) > 0.995) {
        const a = Math.random() * Math.PI * 2;
        c.goal.set(c.pos.x + Math.cos(a) * 25, 0, c.pos.z + Math.sin(a) * 25);
      }
      // Grazers pause to eat.
      want = sp.plan === 'flyer' ? sp.speed * 3 : Math.sin(time * 0.3 + c.phase) > 0.2 ? sp.speed : 0;
    }
    c.speed += (want - c.speed) * Math.min(1, dt * 3);
    const dx = c.goal.x - c.pos.x;
    const dz = c.goal.z - c.pos.z;
    const target = Math.atan2(-dx, -dz);
    let dh = target - c.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    c.heading += Math.max(-3 * dt, Math.min(3 * dt, dh));
    c.pos.x += -Math.sin(c.heading) * c.speed * dt;
    c.pos.z += -Math.cos(c.heading) * c.speed * dt;
    const ground = this.terrain.surfaceHeight(c.pos.x, c.pos.z);
    const gait = time * (2 + c.speed * 2.2) + c.phase;
    if (sp.plan === 'flyer') {
      c.pos.y += (ground + c.alt + Math.sin(time * 0.7 + c.phase) * 3 - c.pos.y) * Math.min(1, dt);
      for (const [i, w] of c.wings.entries()) w.rotation.z = Math.sin(time * 9 + c.phase) * 0.7 * (i ? -1 : 1);
    } else if (sp.plan === 'hopper') {
      const hop = c.speed > 0.3 ? Math.abs(Math.sin(gait * 0.8)) * 0.9 * sp.size : 0;
      c.pos.y = ground + hop;
      for (const l of c.legs) l.rotation.x = c.speed > 0.3 ? Math.sin(gait * 0.8) * 0.6 : 0;
    } else {
      c.pos.y = ground;
      c.legs.forEach((l, i) => (l.rotation.x = c.speed > 0.2 ? Math.sin(gait + (i % 2 ? Math.PI : 0) + (i > 1 ? Math.PI / 2 : 0)) * 0.6 : 0));
    }
    c.group.position.copy(c.pos);
    c.group.rotation.y = c.heading;
  }

  dispose(): void {
    this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.group.clear();
    this.creatures.length = 0;
  }
}
