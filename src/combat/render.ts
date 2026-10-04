import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { DamageType } from '../ships/defs';
import { STYLES, type ShipVisual, buildShip } from '../ships/shipBuilder';
import { shieldFragment, shieldVertex, spriteFragment, spriteVertex, streakFragment, streakVertex } from './fxShaders';
import type { CombatShip, WeaponState } from './ship';
import type { CombatEvent, CombatSim } from './sim';

/** Projectile colours by damage type (HDR, they feed the bloom). */
const BOLT: Record<DamageType, [number, number, number]> = {
  kinetic: [2.6, 2.2, 1.3],
  he: [3.2, 1.4, 0.45],
  energy: [0.6, 1.9, 3.4],
  frag: [2.4, 2.0, 0.9],
};
const MODEL_BOLT: Partial<Record<string, [number, number, number]>> = {
  plasma: [2.6, 0.8, 3.2],
  railgun: [1.6, 2.4, 3.6],
};
const BEAM_COLOR: Record<string, [number, number, number]> = {
  pd_laser: [3.0, 0.8, 0.6],
  graviton_beam: [1.2, 0.8, 3.4],
  phase_lance: [3.4, 1.2, 0.6],
  tachyon_lance: [1.4, 2.4, 4.0],
};
const SIZE_SCALE = { S: 1, M: 1.7, L: 2.8 };
const SIDE_SHIELD = [new THREE.Color('#5fc8ff'), new THREE.Color('#ff7a5c')];

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const _dummy = new THREE.Object3D();

/** A growable batch of instanced streaks. */
class StreakBatch {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private start: Float32Array;
  private dir: Float32Array;
  private size: Float32Array;
  private color: Float32Array;
  private n = 0;
  private cap: number;
  readonly material: THREE.ShaderMaterial;

  constructor(cap: number, core: number) {
    this.cap = cap;
    this.geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.start = new Float32Array(cap * 3);
    this.dir = new Float32Array(cap * 3);
    this.size = new Float32Array(cap * 2);
    this.color = new Float32Array(cap * 4);
    this.attach();
    this.material = new THREE.ShaderMaterial({
      vertexShader: streakVertex,
      fragmentShader: streakFragment,
      uniforms: { uMinAngle: { value: 0.001 }, uCore: { value: core } },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  private attach(): void {
    this.geo.setAttribute('aStart', new THREE.InstancedBufferAttribute(this.start, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aDir', new THREE.InstancedBufferAttribute(this.dir, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(this.size, 2).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage));
  }

  begin(): void {
    this.n = 0;
  }

  /** A streak from `tail` along `dir` (unit) for `len` metres. */
  push(tail: THREE.Vector3, dir: THREE.Vector3, len: number, width: number, r: number, g: number, b: number, a = 1): void {
    if (this.n >= this.cap) {
      if (this.cap >= 16384) return;
      this.grow();
    }
    const i = this.n++;
    this.start[i * 3] = tail.x;
    this.start[i * 3 + 1] = tail.y;
    this.start[i * 3 + 2] = tail.z;
    this.dir[i * 3] = dir.x;
    this.dir[i * 3 + 1] = dir.y;
    this.dir[i * 3 + 2] = dir.z;
    this.size[i * 2] = len;
    this.size[i * 2 + 1] = width;
    this.color[i * 4] = r;
    this.color[i * 4 + 1] = g;
    this.color[i * 4 + 2] = b;
    this.color[i * 4 + 3] = a;
  }

  private grow(): void {
    const cap = this.cap * 2;
    const resize = (a: Float32Array, k: number) => {
      const b = new Float32Array(cap * k);
      b.set(a);
      return b;
    };
    this.start = resize(this.start, 3);
    this.dir = resize(this.dir, 3);
    this.size = resize(this.size, 2);
    this.color = resize(this.color, 4);
    this.cap = cap;
    this.attach();
  }

  end(minAngle: number): void {
    this.geo.instanceCount = this.n;
    this.material.uniforms.uMinAngle.value = minAngle;
    for (const name of ['aStart', 'aDir', 'aSize', 'aColor']) {
      const attr = this.geo.getAttribute(name) as THREE.InstancedBufferAttribute;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, this.n * attr.itemSize);
      attr.needsUpdate = true;
    }
    this.mesh.visible = this.n > 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
  }
}

/** A growable batch of instanced billboards (glows, fireballs, rings, smoke). */
class SpriteBatch {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private pos: Float32Array;
  private params: Float32Array;
  private color: Float32Array;
  private n = 0;
  private cap: number;
  readonly material: THREE.ShaderMaterial;

  constructor(cap: number, blending: THREE.Blending) {
    this.cap = cap;
    this.geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.pos = new Float32Array(cap * 3);
    this.params = new Float32Array(cap * 4);
    this.color = new Float32Array(cap * 4);
    this.attach();
    this.material = new THREE.ShaderMaterial({
      vertexShader: spriteVertex,
      fragmentShader: spriteFragment,
      uniforms: { uMinAngle: { value: 0.001 } },
      blending,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = blending === THREE.NormalBlending ? 4 : 6;
  }

  private attach(): void {
    this.geo.setAttribute('aPos', new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aParams', new THREE.InstancedBufferAttribute(this.params, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage));
  }

  begin(): void {
    this.n = 0;
  }

  /** kind: 0 glow, 1 fireball, 2 ring, 3 smoke. */
  push(p: THREE.Vector3, size: number, age: number, kind: number, seed: number, r: number, g: number, b: number, a = 1): void {
    if (this.n >= this.cap) {
      if (this.cap >= 16384) return;
      const cap = this.cap * 2;
      const grow = (x: Float32Array, k: number) => {
        const y = new Float32Array(cap * k);
        y.set(x);
        return y;
      };
      this.pos = grow(this.pos, 3);
      this.params = grow(this.params, 4);
      this.color = grow(this.color, 4);
      this.cap = cap;
      this.attach();
    }
    const i = this.n++;
    this.pos[i * 3] = p.x;
    this.pos[i * 3 + 1] = p.y;
    this.pos[i * 3 + 2] = p.z;
    this.params[i * 4] = size;
    this.params[i * 4 + 1] = age;
    this.params[i * 4 + 2] = kind;
    this.params[i * 4 + 3] = seed;
    this.color[i * 4] = r;
    this.color[i * 4 + 1] = g;
    this.color[i * 4 + 2] = b;
    this.color[i * 4 + 3] = a;
  }

  end(minAngle: number): void {
    this.geo.instanceCount = this.n;
    this.material.uniforms.uMinAngle.value = minAngle;
    for (const name of ['aPos', 'aParams', 'aColor']) {
      const attr = this.geo.getAttribute(name) as THREE.InstancedBufferAttribute;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, this.n * attr.itemSize);
      attr.needsUpdate = true;
    }
    this.mesh.visible = this.n > 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
  }
}

interface Particle {
  /** Arena-space position and velocity. */
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  life: number;
  size: number;
  grow: number;
  color: [number, number, number];
  alpha: number;
  /** 0 glow, 1 fireball, 2 ring, 3 smoke, 4 spark (streak). */
  kind: number;
  seed: number;
  /** Follow a ship (ship-local offset) instead of drifting. */
  ship?: CombatShip;
  local?: THREE.Vector3;
}

interface Debris {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Quaternion;
  spin: THREE.Vector3;
  scale: THREE.Vector3;
  age: number;
  life: number;
  hot: number;
}

interface ShipFx {
  visual: ShipVisual | null;
  shield: THREE.Mesh | null;
  shieldMat: THREE.ShaderMaterial | null;
  hits: THREE.Vector4[];
  hitIdx: number;
  wrecked: boolean;
  /** Smoke/fire emitter accumulator. */
  smokeT: number;
  fires: THREE.Vector3[];
  warpIn: number;
}

/**
 * Draws a CombatSim: the AI ships' models, shields, every projectile, beam and
 * missile, and the particles that make hits and kills read at a glance.
 */
export class CombatRenderer {
  readonly group = new THREE.Group();
  private readonly bolts = new StreakBatch(1024, 0.35);
  private readonly beams = new StreakBatch(128, 0.25);
  private readonly glows = new SpriteBatch(1024, THREE.AdditiveBlending);
  private readonly smoke = new SpriteBatch(512, THREE.NormalBlending);
  private readonly fx = new Map<CombatShip, ShipFx>();
  private readonly particles: Particle[] = [];
  private readonly debris: Debris[] = [];
  private readonly debrisMesh: THREE.InstancedMesh;
  private readonly rng = new Rng(99);
  private readonly shieldGeo = new THREE.SphereGeometry(1, 48, 24);
  private time = 0;
  /** Screen shake requested by nearby explosions (read by the game). */
  shake = 0;
  /** The player's flagship visual (owned by the game). */
  playerVisual: ShipVisual | null = null;
  /** Called for audio on events near the camera: kind, intensity 0..1. */
  onSound: (kind: string, intensity: number, e: CombatEvent) => void = () => {};
  /** Every sim event, before the renderer turns it into effects. */
  onEvent: (e: CombatEvent) => void = () => {};

  constructor(private readonly sim: CombatSim) {
    this.group.add(this.smoke.mesh, this.bolts.mesh, this.beams.mesh, this.glows.mesh);
    const debrisMat = new THREE.MeshStandardMaterial({ color: '#3a3a40', roughness: 0.6, metalness: 0.6, emissive: new THREE.Color('#ff5a1a'), emissiveIntensity: 0 });
    this.debrisMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), debrisMat, 400);
    this.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debrisMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(400 * 3), 3);
    this.debrisMesh.count = 0;
    this.debrisMesh.frustumCulled = false;
    this.group.add(this.debrisMesh);
  }

  /** Visual for a ship (creates it lazily; the player's own comes from the game). */
  private fxFor(s: CombatShip): ShipFx {
    let f = this.fx.get(s);
    if (!f) {
      f = { visual: null, shield: null, shieldMat: null, hits: [], hitIdx: 0, wrecked: false, smokeT: 0, fires: [], warpIn: s.side === 1 ? 0 : 1 };
      for (let i = 0; i < 6; i++) f.hits.push(new THREE.Vector4(0, 0, -1, 0));
      if (s.shield) {
        f.shieldMat = new THREE.ShaderMaterial({
          vertexShader: shieldVertex,
          fragmentShader: shieldFragment,
          uniforms: {
            uColor: { value: (s.side === 0 ? SIDE_SHIELD[0] : SIDE_SHIELD[1]).clone().multiplyScalar(1.4) },
            uHalfArc: { value: 0 },
            uFacing: { value: 0 },
            uFlux: { value: 0 },
            uTime: { value: 0 },
            uIntensity: { value: 1 },
            uHits: { value: f.hits },
          },
          blending: THREE.AdditiveBlending,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        f.shield = new THREE.Mesh(this.shieldGeo, f.shieldMat);
        f.shield.frustumCulled = false;
        f.shield.renderOrder = 7;
        this.group.add(f.shield);
      }
      this.fx.set(s, f);
    }
    if (!s.controlled && !f.visual) {
      f.visual = buildShip(s.loadout);
      this.group.add(f.visual.root);
      fitToVisual(s, f.visual);
      if (!s.alive) this.wreckVisual(f);
    }
    if (s.controlled && f.visual) {
      // Command transferred to this ship: the game draws it now.
      f.visual.root.removeFromParent();
      f.visual.dispose();
      f.visual = null;
    }
    return f;
  }

  /** Point every ship's weapons at the real mounts and size the hit volumes from the model. */
  attachPlayerVisual(s: CombatShip, visual: ShipVisual): void {
    this.playerVisual = visual;
    fitToVisual(s, visual);
  }

  private wreckVisual(f: ShipFx): void {
    if (!f.visual || f.wrecked) return;
    f.wrecked = true;
    f.visual.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (!m) return;
      if (m instanceof THREE.MeshStandardMaterial) {
        m.color.multiplyScalar(0.28);
        m.emissive?.setRGB(0, 0, 0);
        m.emissiveIntensity = 0;
      } else if (m instanceof THREE.ShaderMaterial || m instanceof THREE.MeshBasicMaterial) o.visible = false;
    });
  }

  // ---------------------------------------------------------------- events

  private consume(origin: THREE.Vector3): void {
    const sim = this.sim;
    for (const e of sim.events) {
      this.onEvent(e);
      switch (e.t) {
        case 'shot': {
          const w = e.weapon;
          const sz = SIZE_SCALE[w.def.size];
          const c = w.def.kind === 'missile' ? [3, 1.6, 0.6] : (MODEL_BOLT[w.def.model] ?? BOLT[w.def.damageType]);
          this.spawn({ pos: _v.copy(e.pos).addScaledVector(e.dir, 2 * sz), vel: w.ship.vel.clone(), life: 0.07, size: 5 * sz, grow: 20, color: c as [number, number, number], alpha: 1.4, kind: 0 });
          if (w.def.type === 'missile') this.spawn({ pos: e.pos, vel: w.ship.vel.clone(), life: 0.9, size: 4 * sz, grow: 10, color: [0.6, 0.6, 0.62], alpha: 0.5, kind: 3 });
          this.onSound('shot', 1, e);
          break;
        }
        case 'hit': {
          const big = e.size;
          if (e.kind === 'shield') {
            const f = this.fx.get(e.ship);
            if (f) {
              const local = _v2.copy(e.pos).sub(e.ship.pos).applyQuaternion(_q.copy(e.ship.quat).invert()).divide(e.ship.dims.shield);
              const h = f.hits[f.hitIdx++ % f.hits.length];
              h.set(local.x, local.y, local.z, 0.001);
            }
            this.spawn({ pos: e.pos, vel: e.ship.vel.clone(), life: 0.22, size: 9 * big, grow: 15, color: [0.8, 1.6, 3.2], alpha: 1.2, kind: 0 });
            this.sparks(e.pos, e.ship.vel, _v2.copy(e.pos).sub(e.ship.pos).normalize(), Math.round(2 + big * 2), [1.2, 2.2, 3.4], 120);
          } else {
            const he = e.type === 'he';
            this.spawn({ pos: e.pos, vel: e.ship.vel.clone(), life: 0.18, size: (he ? 14 : 9) * big, grow: 20, color: [3.2, 2.2, 1.2], alpha: 1.3, kind: 0 });
            if (he || big > 1.3)
              this.spawn({ pos: e.pos, vel: e.ship.vel.clone(), life: 0.55 + big * 0.15, size: 7 * big, grow: 14 * big, color: [2.4, 1.2, 0.5], alpha: 1, kind: 1 });
            this.sparks(e.pos, e.ship.vel, _v2.copy(e.pos).sub(e.ship.pos).normalize(), Math.round(3 + big * 4), [3, 1.9, 0.8], 180);
            if (e.kind === 'hull' && this.rng.next() < 0.5) this.spawn({ pos: e.pos, vel: e.ship.vel.clone(), life: 1.6, size: 6 * big, grow: 8, color: [0.18, 0.16, 0.15], alpha: 0.7, kind: 3 });
          }
          this.onSound(e.kind === 'shield' ? 'shieldHit' : 'hullHit', Math.min(1, big / 2), e);
          break;
        }
        case 'pd':
          this.spawn({ pos: e.pos, vel: new THREE.Vector3(), life: 0.25, size: 10 * e.size, grow: 30, color: [3, 2.4, 1.4], alpha: 1, kind: 0 });
          this.sparks(e.pos, _v2.set(0, 0, 0), null, 6, [3, 2, 1], 140);
          break;
        case 'explode': {
          const s = e.size;
          const torp = e.kind === 'torpedo';
          if (e.kind === 'flak') {
            this.spawn({ pos: e.pos, vel: new THREE.Vector3(), life: 0.28, size: 26, grow: 50, color: [3, 2.4, 1.2], alpha: 0.8, kind: 0 });
            this.spawn({ pos: e.pos, vel: new THREE.Vector3(), life: 0.9, size: 10, grow: 26, color: [0.3, 0.28, 0.26], alpha: 0.35, kind: 3 });
            break;
          }
          this.spawn({ pos: e.pos, vel: new THREE.Vector3(), life: 0.25, size: 40 * s, grow: 60 * s, color: [3.5, 2.6, 1.6], alpha: 1.2, kind: 0 });
          this.spawn({ pos: e.pos, vel: new THREE.Vector3(), life: 0.9 + s * 0.2, size: 14 * s, grow: 26 * s, color: [2.6, 1.3, 0.5], alpha: 1, kind: 1 });
          if (torp) this.spawn({ pos: e.pos, vel: new THREE.Vector3(), life: 0.8, size: 20, grow: 260, color: [1.6, 1.2, 1.0], alpha: 0.9, kind: 2 });
          this.sparks(e.pos, _v2.set(0, 0, 0), null, Math.round(6 + s * 6), [3, 1.8, 0.7], 220 + s * 60);
          this.onSound('explode', Math.min(1, s / 3), e);
          break;
        }
        case 'destroyed':
          this.shipDeath(e.ship);
          this.onSound('death', 1, e);
          break;
        case 'overload':
          this.onSound('overload', 1, e);
          break;
        case 'vent':
          this.onSound('vent', 1, e);
          break;
        case 'system':
          this.onSound('system', 1, e);
          if (e.ship.system.action === 'dash') this.spawn({ pos: e.ship.pos, vel: new THREE.Vector3(), life: 0.4, size: e.ship.dims.bound * 2, grow: 80, color: [1.4, 0.8, 3.2], alpha: 1, kind: 2 });
          break;
        case 'launch':
          this.onSound('launch', 1, e);
          break;
        case 'emp':
          for (let i = 0; i < 3; i++) this.arc(e.pos, e.ship, 0.25);
          break;
        case 'retreated':
          if (e.ship.retreated) this.spawn({ pos: e.ship.pos, vel: new THREE.Vector3(), life: 0.7, size: e.ship.dims.bound * 2, grow: e.ship.dims.bound * 8, color: [1.5, 1.2, 3.4], alpha: 1.2, kind: 0 });
          break;
        default:
          break;
      }
    }
    sim.events.length = 0;
    void origin;
  }

  private spawn(p: Omit<Particle, 'age' | 'seed' | 'pos' | 'vel'> & { pos: THREE.Vector3; vel: THREE.Vector3 }): Particle {
    const part: Particle = { ...p, pos: p.pos.clone(), vel: p.vel.clone(), age: 0, seed: this.rng.next() };
    if (this.particles.length < 3000) this.particles.push(part);
    return part;
  }

  private sparks(at: THREE.Vector3, baseVel: THREE.Vector3, normal: THREE.Vector3 | null, n: number, color: [number, number, number], speed: number): void {
    for (let i = 0; i < n; i++) {
      const dir = new THREE.Vector3(this.rng.range(-1, 1), this.rng.range(-1, 1), this.rng.range(-1, 1)).normalize();
      if (normal) dir.addScaledVector(normal, 1.2).normalize();
      this.spawn({ pos: at, vel: dir.multiplyScalar(speed * this.rng.range(0.3, 1.2)).add(baseVel), life: this.rng.range(0.2, 0.6), size: 0.6, grow: 0, color, alpha: 1, kind: 4 });
    }
  }

  /** An electric arc flickering over a ship's hull. */
  private arc(at: THREE.Vector3, s: CombatShip, life: number): void {
    const local = at.clone().sub(s.pos).applyQuaternion(_q.copy(s.quat).invert());
    this.spawn({ pos: at, vel: new THREE.Vector3(), life, size: 0.8, grow: 0, color: [1.6, 0.9, 3.6], alpha: 1, kind: 5, ship: s, local });
  }

  private shipDeath(s: CombatShip): void {
    const r = s.dims.bound;
    const f = this.fx.get(s);
    // A rolling chain of blasts along the hull, a flash, a shock ring and debris.
    for (let i = 0; i < 6 + s.sizeIndex * 3; i++) {
      const local = new THREE.Vector3(this.rng.range(-1, 1) * s.dims.hull.x, this.rng.range(-1, 1) * s.dims.hull.y, this.rng.range(-1, 1) * s.dims.hull.z);
      const p = this.spawn({ pos: s.pos, vel: s.vel.clone(), life: 1 + this.rng.next() * 0.8, size: r * 0.25, grow: r * this.rng.range(0.4, 0.8), color: [2.6, 1.2, 0.45], alpha: 1, kind: 1, ship: s, local });
      p.age = -this.rng.range(0, 0.9 + s.sizeIndex * 0.3);
    }
    this.spawn({ pos: s.pos, vel: s.vel.clone(), life: 0.45, size: r * 3, grow: r * 6, color: [4, 3.2, 2.4], alpha: 1.4, kind: 0 });
    this.spawn({ pos: s.pos, vel: s.vel.clone(), life: 1.2, size: r, grow: r * 10, color: [1.8, 1.4, 1.1], alpha: 0.9, kind: 2 });
    this.sparks(s.pos, s.vel, null, 30 + s.sizeIndex * 15, [3.2, 2, 0.8], 260 + r * 2);
    for (let i = 0; i < 10 + s.sizeIndex * 10 && this.debris.length < 400; i++) {
      const dir = new THREE.Vector3(this.rng.range(-1, 1), this.rng.range(-0.5, 0.5), this.rng.range(-1, 1)).normalize();
      const sz = r * this.rng.range(0.03, 0.12);
      this.debris.push({
        pos: s.pos.clone().addScaledVector(dir, r * 0.3),
        vel: dir.multiplyScalar(this.rng.range(30, 140)).add(s.vel),
        rot: new THREE.Quaternion().setFromEuler(new THREE.Euler(this.rng.range(0, 6), this.rng.range(0, 6), this.rng.range(0, 6))),
        spin: new THREE.Vector3(this.rng.range(-3, 3), this.rng.range(-3, 3), this.rng.range(-3, 3)),
        scale: new THREE.Vector3(sz * this.rng.range(0.5, 2), sz * this.rng.range(0.2, 0.6), sz * this.rng.range(0.8, 2.5)),
        age: 0,
        life: this.rng.range(14, 30),
        hot: 1,
      });
    }
    if (f) {
      this.wreckVisual(f);
      f.fires = [];
      for (let i = 0; i < 2 + s.sizeIndex * 2; i++) f.fires.push(new THREE.Vector3(this.rng.range(-0.8, 0.8) * s.dims.hull.x, this.rng.range(0, 0.5) * s.dims.hull.y, this.rng.range(-0.9, 0.9) * s.dims.hull.z));
    }
    const d = this.camDist(s.pos);
    this.shake = Math.max(this.shake, THREE.MathUtils.clamp((r * 40) / Math.max(d, 1), 0, 2.5));
  }

  private origin = new THREE.Vector3();
  private camDist(p: THREE.Vector3): number {
    return _v.copy(p).add(this.origin).length();
  }

  /** Arena point → render space. */
  toRender(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(p).add(this.origin);
  }

  // ---------------------------------------------------------------- frame

  /**
   * @param origin the arena origin in render (camera-relative) space
   * @param minAngle radians per ~1.5 px, so tiny things never vanish
   */
  update(dt: number, origin: THREE.Vector3, minAngle: number): void {
    this.time += dt;
    this.origin.copy(origin);
    this.shake *= Math.exp(-dt * 4);
    this.consume(origin);
    const sim = this.sim;

    // Ships.
    for (const s of sim.ships) {
      const f = this.fxFor(s);
      const visual = s.controlled ? this.playerVisual : f.visual;
      if (s.retreated) {
        if (f.visual) f.visual.root.visible = false;
        if (f.shield) f.shield.visible = false;
        continue;
      }
      if (visual && !s.controlled) {
        visual.root.position.copy(s.pos).add(origin);
        visual.root.quaternion.copy(s.quat);
        if (s.alive) {
          const boost = !!s.mods.burn;
          visual.update(dt, this.time, s.throttle, boost, 0, THREE.MathUtils.clamp(-s.angVel * 0.6, -0.5, 0.5), 0);
        }
        f.warpIn = Math.min(1, f.warpIn + dt * 1.5);
        visual.root.visible = true;
      }
      if (visual && s.alive) {
        for (const w of s.weapons) {
          const m = visual.mounts.get(w.slot.id);
          if (!m || !w.turret) continue;
          m.yaw.rotation.y = w.slot.zone === 'ventral' ? -w.yaw : w.yaw;
        }
      }
      // Shield bubble.
      if (f.shield && f.shieldMat) {
        const on = s.alive && s.shield && s.shieldUnfold > 0.01;
        f.shield.visible = !!on;
        if (on) {
          f.shield.position.copy(s.pos).add(origin);
          f.shield.quaternion.copy(s.quat);
          f.shield.scale.copy(s.dims.shield);
          const u = f.shieldMat.uniforms;
          u.uHalfArc.value = s.shield!.halfArc * easeOut(s.shieldUnfold);
          u.uFacing.value = s.shieldFacing;
          u.uFlux.value = s.fluxFrac;
          u.uTime.value = this.time;
          u.uIntensity.value = 0.55 + 0.45 * s.shieldUnfold;
        }
        for (const h of f.hits) if (h.w > 0) h.w = h.w + dt * 1.6 >= 1 ? 0 : h.w + dt * 1.6;
      }
      // Damage smoke, fires on wrecks, overload arcs, venting vapour.
      if (s.alive) {
        f.smokeT += dt * (s.hpFrac < 0.5 ? (0.5 - s.hpFrac) * 10 : 0);
        while (f.smokeT > 1) {
          f.smokeT -= 1;
          const local = new THREE.Vector3(this.rng.range(-0.7, 0.7) * s.dims.hull.x, s.dims.hull.y * 0.5, this.rng.range(-0.8, 0.8) * s.dims.hull.z);
          const p = local.clone().applyQuaternion(s.quat).add(s.pos);
          this.spawn({ pos: p, vel: s.vel.clone().multiplyScalar(0.8), life: 2.2, size: s.dims.bound * 0.12, grow: s.dims.bound * 0.25, color: [0.12, 0.11, 0.1], alpha: 0.8, kind: 3 });
          if (s.hpFrac < 0.3) this.spawn({ pos: p, vel: s.vel.clone(), life: 0.5, size: s.dims.bound * 0.1, grow: 4, color: [2.6, 1.1, 0.3], alpha: 1, kind: 1 });
        }
        if (s.overload > 0 && this.rng.next() < dt * 30) {
          const local = new THREE.Vector3(this.rng.range(-1, 1) * s.dims.hull.x, this.rng.range(-1, 1) * s.dims.hull.y, this.rng.range(-1, 1) * s.dims.hull.z);
          this.arc(local.applyQuaternion(s.quat).add(s.pos), s, 0.12);
        }
        if (s.venting && this.rng.next() < dt * 40) {
          const side = this.rng.next() < 0.5 ? -1 : 1;
          const local = new THREE.Vector3(side * s.dims.hull.x * 0.8, s.dims.hull.y * 0.6, this.rng.range(-0.6, 0.6) * s.dims.hull.z);
          const p = local.clone().applyQuaternion(s.quat).add(s.pos);
          const out = new THREE.Vector3(side, 0.6, 0).normalize().applyQuaternion(s.quat).multiplyScalar(60 + s.dims.bound).add(s.vel);
          this.spawn({ pos: p, vel: out, life: 0.9, size: s.dims.bound * 0.08, grow: s.dims.bound * 0.4, color: [0.85, 0.9, 1.0], alpha: 0.45, kind: 3 });
        }
      } else if (f.fires.length && s.deadFor < 40) {
        f.smokeT += dt * f.fires.length * 3;
        while (f.smokeT > 1) {
          f.smokeT -= 1;
          const fire = f.fires[this.rng.int(0, f.fires.length - 1)];
          const p = fire.clone().applyQuaternion(s.quat).add(s.pos);
          const k = Math.max(0, 1 - s.deadFor / 40);
          this.spawn({ pos: p, vel: s.vel.clone(), life: 0.5, size: s.dims.bound * 0.07 * k, grow: 4, color: [2.6, 1.0, 0.25], alpha: k, kind: 1 });
          this.spawn({ pos: p, vel: s.vel.clone().add(new THREE.Vector3(0, 8, 0)), life: 2.5, size: s.dims.bound * 0.08, grow: s.dims.bound * 0.2, color: [0.1, 0.09, 0.09], alpha: 0.6 * k, kind: 3 });
        }
      }
    }

    // Particles.
    this.bolts.begin();
    this.beams.begin();
    this.glows.begin();
    this.smoke.begin();
    const keep: Particle[] = [];
    for (const p of this.particles) {
      p.age += dt;
      if (p.age >= p.life) continue;
      keep.push(p);
      if (p.age < 0) continue;
      const t = p.age / p.life;
      let pos: THREE.Vector3;
      if (p.ship && p.local) pos = _v.copy(p.local).applyQuaternion(p.ship.quat).add(p.ship.pos).add(origin);
      else {
        p.pos.addScaledVector(p.vel, dt);
        pos = _v.copy(p.pos).add(origin);
      }
      const [r, g, b] = p.color;
      if (p.kind === 4) {
        const sp = p.vel.length();
        if (sp > 1e-3) this.bolts.push(pos, _v2.copy(p.vel).divideScalar(-sp), Math.min(sp * 0.04, 12), p.size, r, g, b, (1 - t) * p.alpha);
      } else if (p.kind === 5) {
        // Lightning: a few jagged segments.
        let a = pos.clone();
        for (let k = 0; k < 4; k++) {
          const next = a.clone().add(_v2.set(this.rng.range(-1, 1), this.rng.range(-1, 1), this.rng.range(-1, 1)).multiplyScalar(4 + (p.ship?.dims.bound ?? 20) * 0.08));
          const d = next.clone().sub(a);
          const len = d.length();
          this.bolts.push(a, d.divideScalar(len), len, 0.5, r, g, b, (1 - t) * 1.5);
          a = next;
        }
      } else if (p.kind === 3) this.smoke.push(pos, p.size + p.grow * p.age, t, 3, p.seed, r, g, b, p.alpha);
      else this.glows.push(pos, p.size + p.grow * p.age, t, p.kind, p.seed, r, g, b, p.alpha * (p.kind === 0 ? (1 - t) * (1 - t) : 1));
    }
    this.particles.length = 0;
    this.particles.push(...keep);

    // Projectiles.
    for (const p of sim.projectiles) {
      if (!p.active) continue;
      const sp = p.vel.length();
      const dir = _v2.copy(p.vel).divideScalar(sp);
      const sz = SIZE_SCALE[p.def.size];
      const c = MODEL_BOLT[p.def.model] ?? BOLT[p.type];
      const len = Math.min(sp * 0.035, 12 + sz * 10) * (p.def.model === 'railgun' ? 2.2 : p.def.model === 'flak' ? 0.5 : 1) * Math.min(1, p.age * 30 + 0.2);
      const tail = _v.copy(p.pos).addScaledVector(dir, -len).add(origin);
      const fade = THREE.MathUtils.clamp((p.life - p.age) / 0.15, 0, 1);
      const width = (p.def.model === 'plasma' ? 2.2 : p.def.kind === 'projectile' && p.type === 'energy' ? 1.3 : 0.9) * sz;
      this.bolts.push(tail, dir, len, width, c[0], c[1], c[2], fade);
      if (p.def.model === 'plasma' || p.def.model === 'cannon') this.glows.push(_v.copy(p.pos).add(origin), width * 4, 0, 0, 0, c[0] * 0.5, c[1] * 0.5, c[2] * 0.5, fade);
    }

    // Missiles: hot head, exhaust trail.
    for (const m of sim.missiles) {
      if (!m.active) continue;
      const torp = m.def.model === 'torpedo';
      const sp = Math.max(m.vel.length(), 1);
      const dir = _v2.copy(m.vel).divideScalar(sp);
      const head = _v.copy(m.pos).add(origin);
      this.glows.push(head, torp ? 16 : 7, 0, 0, m.id, torp ? 3 : 3, torp ? 1.4 : 2.0, torp ? 0.6 : 1.0, 1);
      const trail = Math.min(m.age * sp, torp ? 70 : 45);
      this.bolts.push(head.clone().addScaledVector(dir, -trail), dir, trail, torp ? 2.2 : 1.1, 2.4, 1.3, 0.6, 0.8);
      if (this.rng.next() < dt * 25) this.spawn({ pos: m.pos, vel: m.vel.clone().multiplyScalar(0.1), life: 1.4, size: torp ? 5 : 2.5, grow: torp ? 10 : 5, color: [0.55, 0.55, 0.58], alpha: 0.25, kind: 3 });
    }
    for (const fl of sim.flares) {
      if (!fl.active) continue;
      const p = _v.copy(fl.pos).add(origin);
      this.glows.push(p, 9 + Math.sin(this.time * 40 + fl.pos.x) * 2, 0, 0, 0, 3.4, 2.6, 1.6, Math.min(1, fl.life));
    }

    // Beams.
    for (const s of sim.ships) {
      if (!s.alive || s.retreated) continue;
      for (const w of s.weapons) if (w.def.kind === 'beam' && w.beam > 0.01) this.drawBeam(w, origin, dt);
    }

    // Debris.
    const dummy = _dummy;
    let n = 0;
    const keepD: Debris[] = [];
    for (const d of this.debris) {
      d.age += dt;
      if (d.age > d.life) continue;
      keepD.push(d);
      d.pos.addScaledVector(d.vel, dt);
      d.rot.multiply(_q.setFromEuler(_e.set(d.spin.x * dt, d.spin.y * dt, d.spin.z * dt))).normalize();
      d.hot = Math.max(0, 1 - d.age / 3);
      dummy.position.copy(d.pos).add(origin);
      dummy.quaternion.copy(d.rot);
      dummy.scale.copy(d.scale).multiplyScalar(Math.min(1, (d.life - d.age) / 3));
      dummy.updateMatrix();
      this.debrisMesh.setMatrixAt(n, dummy.matrix);
      this.debrisMesh.setColorAt(n, _c.setRGB(1 + d.hot * 4, 1 + d.hot * 1.5, 1));
      n++;
      if (d.hot > 0.2 && this.rng.next() < dt * 12) this.spawn({ pos: d.pos, vel: d.vel.clone().multiplyScalar(0.5), life: 0.8, size: d.scale.x * 2, grow: 3, color: [0.15, 0.13, 0.12], alpha: 0.5 * d.hot, kind: 3 });
    }
    this.debris.length = 0;
    this.debris.push(...keepD);
    this.debrisMesh.count = n;
    this.debrisMesh.instanceMatrix.needsUpdate = true;
    if (this.debrisMesh.instanceColor) this.debrisMesh.instanceColor.needsUpdate = true;

    this.bolts.end(minAngle);
    this.beams.end(minAngle);
    this.glows.end(minAngle);
    this.smoke.end(minAngle);
  }

  private drawBeam(w: WeaponState, origin: THREE.Vector3, dt: number): void {
    const s = w.ship;
    const visual = s.controlled ? this.playerVisual : this.fx.get(s)?.visual;
    const from = _v.copy(w.local).applyQuaternion(s.quat).add(s.pos);
    void visual;
    const a = w.facing + w.yaw;
    const aim = w.aim ? _v2.copy(w.aim).sub(from) : null;
    const elev = aim ? Math.atan2(aim.applyQuaternion(_q.copy(s.quat).invert()).y, Math.hypot(aim.x, aim.z)) : 0;
    const dir = new THREE.Vector3(-Math.sin(a) * Math.cos(elev), Math.sin(elev), -Math.cos(a) * Math.cos(elev)).applyQuaternion(s.quat);
    const c = BEAM_COLOR[w.def.id] ?? [2, 1.4, 3];
    const sz = SIZE_SCALE[w.def.size];
    const flicker = 0.85 + 0.15 * Math.sin(this.time * 60 + w.slot.t * 40);
    const k = w.beam * flicker * (s.mods.energyDamage ? 1.4 : 1);
    const start = from.clone().add(origin);
    this.beams.push(start, dir, w.beamLength, 0.7 * sz, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, k);
    this.beams.push(start, dir, w.beamLength, 3.2 * sz, c[0] * 0.5, c[1] * 0.5, c[2] * 0.5, k * 0.7);
    this.glows.push(start, 4 * sz, 0, 0, 0, c[0], c[1], c[2], k);
    if (w.beamHit !== 'none') {
      const end = start.clone().addScaledVector(dir, w.beamLength);
      this.glows.push(end, (w.beamHit === 'shield' ? 10 : 7) * sz, 0, 0, 0, c[0], c[1], c[2], k * 1.2);
      if (this.rng.next() < dt * 30) {
        const at = from.clone().addScaledVector(dir, w.beamLength);
        this.sparks(at, s.vel, dir.clone().negate(), 1, w.beamHit === 'shield' ? [1, 2, 3.4] : [3, 1.8, 0.8], 120);
      }
    }
  }

  /** Remove a ship's visuals (e.g. after the game takes over drawing it). */
  dispose(): void {
    for (const f of this.fx.values()) {
      f.visual?.root.removeFromParent();
      f.visual?.dispose();
      f.shield?.removeFromParent();
      f.shieldMat?.dispose();
    }
    this.fx.clear();
    this.group.removeFromParent();
    this.bolts.dispose();
    this.beams.dispose();
    this.glows.dispose();
    this.smoke.dispose();
    this.debrisMesh.geometry.dispose();
    (this.debrisMesh.material as THREE.Material).dispose();
    this.shieldGeo.dispose();
  }

  /** Current visual of a ship (AI ships only). */
  visualOf(s: CombatShip): ShipVisual | null {
    return this.fx.get(s)?.visual ?? null;
  }

  /** Colour of a side's shields, for UI. */
  static sideColor(side: 0 | 1): string {
    return side === 0 ? '#5fc8ff' : '#ff6a4d';
  }
}

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/** Use the built model's real mount positions and size the hit volumes to its bounds. */
export function fitToVisual(s: CombatShip, v: ShipVisual): void {
  for (const w of s.weapons) v.slotPosition(w.slot.id, w.local);
  const box = new THREE.Box3();
  v.body.updateMatrixWorld(true);
  // Bounds in body space (ignore the root's transform).
  const inv = new THREE.Matrix4().copy(v.root.matrixWorld).invert();
  v.body.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    m.geometry.computeBoundingBox();
    const b = m.geometry.boundingBox!.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    box.union(b);
  });
  if (box.isEmpty()) return;
  const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  // Ellipsoids bulge past box corners; shrink a little so the hit volume hugs the hull.
  s.dims.hull.set(half.x * 0.85, Math.max(half.y * 0.85, 1), half.z * 0.95);
  const h = s.dims.hull;
  const sx = Math.max(h.x * 1.25, h.z * 0.45) + 2;
  const sz = h.z * 1.12 + 2;
  s.dims.shield.set(sx, Math.max(h.y * 2.2, sx * 0.5), sz);
  s.dims.bound = Math.max(s.dims.shield.x, s.dims.shield.y, s.dims.shield.z);
  s.dims.collide = Math.sqrt(h.x * h.z) * 1.1;
}

export { STYLES };
