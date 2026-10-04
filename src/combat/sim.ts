import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { DamageType, WeaponDef } from '../ships/defs';
import { MISSILE_MULT, shieldFlux } from './damage';
import { bearingOf, interceptTime, pointSegmentDistSq, segmentEllipsoid, segmentEllipsoidOutside, wrapAngle } from './geometry';
import { type CombatShip, SPREAD, type Side, type WeaponState } from './ship';
import { commanderThink, shieldAi, shipThink, steerShip, wantsToFire } from './ai';

/** Combat happens within this radius of the arena centre; leaving it means retreating. */
export const ARENA_RADIUS = 9_000;
/** Hostiles closer than this block supercruise and hyperjumps. */
export const MASS_LOCK_RANGE = 8_000;

export interface Projectile {
  active: boolean;
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  vel: THREE.Vector3;
  def: WeaponDef;
  damage: number;
  type: DamageType;
  side: Side;
  owner: CombatShip;
  life: number;
  age: number;
  emp: boolean;
  /** Flak: proximity-fused against missiles. */
  flak: boolean;
}

export interface Missile {
  active: boolean;
  id: number;
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  vel: THREE.Vector3;
  dir: THREE.Vector3;
  speed: number;
  maxSpeed: number;
  turn: number;
  hp: number;
  maxHp: number;
  damage: number;
  type: DamageType;
  side: Side;
  owner: CombatShip;
  def: WeaponDef;
  target: CombatShip | null;
  decoy: Flare | null;
  guided: boolean;
  life: number;
  age: number;
  /** Sabot: split into darts at this range from the target. */
  split: boolean;
  radius: number;
}

export interface Flare {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  side: Side;
}

export type CombatEvent =
  | { t: 'shot'; weapon: WeaponState; pos: THREE.Vector3; dir: THREE.Vector3 }
  | { t: 'hit'; pos: THREE.Vector3; kind: 'shield' | 'armor' | 'hull'; ship: CombatShip; damage: number; type: DamageType; source: CombatShip | null; size: number }
  | { t: 'pd'; pos: THREE.Vector3; size: number }
  | { t: 'explode'; pos: THREE.Vector3; size: number; kind: 'missile' | 'flak' | 'torpedo' }
  | { t: 'destroyed'; ship: CombatShip; by: CombatShip | null }
  | { t: 'overload'; ship: CombatShip }
  | { t: 'vent'; ship: CombatShip }
  | { t: 'system'; ship: CombatShip }
  | { t: 'launch'; missile: Missile }
  | { t: 'flare'; flare: Flare }
  | { t: 'retreated'; ship: CombatShip }
  | { t: 'emp'; ship: CombatShip; pos: THREE.Vector3 };

/** Inputs for the player-controlled ship, set by the game before each step. */
export interface PlayerInput {
  /** Fire the selected weapon group. */
  fire: boolean;
  /** Where the player is aiming (arena space). */
  aim: THREE.Vector3 | null;
  toggleShield: boolean;
  vent: boolean;
  system: boolean;
}

export type Outcome = 'victory' | 'defeat' | null;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _e = new THREE.Euler();

/**
 * The combat simulation (SUPERPLAN Phase 4). Pure logic in arena-local metres:
 * no rendering, deterministic for a seed, and fast enough to run whole fleet
 * battles headless in tests. The game drives the player's ship from the flight
 * model and reads everything else back for rendering.
 */
export class CombatSim {
  readonly ships: CombatShip[] = [];
  readonly projectiles: Projectile[] = [];
  readonly missiles: Missile[] = [];
  readonly flares: Flare[] = [];
  readonly events: CombatEvent[] = [];
  readonly rng: Rng;
  time = 0;
  outcome: Outcome = null;
  readonly input: PlayerInput = { fire: false, aim: null, toggleShield: false, vent: false, system: false };
  /** Fleet-wide stance per side, set by the commander AI or the player. */
  readonly stance: ['engage' | 'retreat', 'engage' | 'retreat'] = ['engage', 'engage'];
  private missileIds = 0;
  private commanderIn = [0, 0.25];

  constructor(seed = 1) {
    this.rng = new Rng(seed);
  }

  add(ship: CombatShip): CombatShip {
    this.ships.push(ship);
    return ship;
  }

  get player(): CombatShip | null {
    return this.ships.find((s) => s.controlled && s.alive) ?? null;
  }

  /** Ships still fighting (alive and not retreated). */
  active(side?: Side): CombatShip[] {
    return this.ships.filter((s) => s.alive && !s.retreated && (side === undefined || s.side === side));
  }

  enemiesOf(ship: CombatShip): CombatShip[] {
    return this.active(ship.side === 0 ? 1 : 0);
  }

  emit(e: CombatEvent): void {
    if (this.events.length > 2000) this.events.splice(0, 1000);
    this.events.push(e);
  }

  // ---------------------------------------------------------------- step

  step(dt: number): void {
    this.time += dt;
    for (const side of [0, 1] as const) {
      this.commanderIn[side] -= dt;
      if (this.commanderIn[side] <= 0) {
        this.commanderIn[side] = 0.5;
        commanderThink(this, side);
      }
    }
    for (const s of this.ships) {
      if (!s.alive) {
        this.updateWreck(s, dt);
        continue;
      }
      if (s.retreated) continue;
      if (!s.controlled) {
        s.ai.thinkIn -= dt;
        if (s.ai.thinkIn <= 0) {
          s.ai.thinkIn = 0.12;
          shipThink(this, s);
        }
        steerShip(this, s, dt);
      }
      this.updateSystem(s, dt);
      this.updateFlux(s, dt);
      if (s.controlled) this.playerShield(s);
      else shieldAi(this, s);
      this.updateShield(s, dt);
      this.updateWeapons(s, dt);
      s.pressure *= Math.exp(-dt * 0.5);
    }
    this.updateProjectiles(dt);
    this.updateMissiles(dt);
    this.updateFlares(dt);
    this.collideShips(dt);
    this.checkRetreats();
    this.input.toggleShield = this.input.vent = this.input.system = false;
    if (!this.outcome) {
      if (!this.active(1).length) this.outcome = 'victory';
      else if (!this.active(0).length) this.outcome = 'defeat';
    }
  }

  // ---------------------------------------------------------------- flux & shields

  private updateFlux(s: CombatShip, dt: number): void {
    const diss = s.dissipation * (s.mods.dissipation ?? 1);
    if (s.overload > 0) {
      s.overload -= dt;
      this.dissipate(s, diss * 1.5 * dt, true);
      if (s.overload <= 0) s.overload = 0;
      return;
    }
    if (s.venting) {
      // Active venting: double dissipation plus a share of capacity per second.
      this.dissipate(s, (diss * 2 + s.fluxCap * 0.05) * dt, true);
      if (s.flux <= 0) s.venting = false;
      return;
    }
    if (s.shieldUp && s.shield) s.flux += s.shield.upkeep * s.dissipation * 0.6 * dt;
    this.dissipate(s, diss * dt, !s.shieldUp);
  }

  /** Bleed off flux: soft first; hard flux only drains with shields down. */
  private dissipate(s: CombatShip, amount: number, hardToo: boolean): void {
    const soft = s.flux - s.hardFlux;
    const fromSoft = Math.min(soft, amount);
    s.flux -= fromSoft;
    if (hardToo) {
      const fromHard = Math.min(s.hardFlux, amount - fromSoft);
      s.hardFlux -= fromHard;
      s.flux -= fromHard;
    }
    s.flux = Math.max(0, s.flux);
    s.hardFlux = Math.min(Math.max(0, s.hardFlux), s.flux);
  }

  /** Add flux; hard flux beyond capacity overloads the ship. */
  addFlux(s: CombatShip, amount: number, hard: boolean): void {
    s.flux += amount;
    if (hard) s.hardFlux += amount;
    if (s.flux >= s.fluxCap) {
      s.flux = s.fluxCap;
      s.hardFlux = Math.min(s.hardFlux, s.flux);
      if (hard) this.overloadShip(s);
    }
  }

  overloadShip(s: CombatShip): void {
    if (s.overload > 0) return;
    s.overload = s.overloadMax = 3 + s.sizeIndex * 1.6;
    s.shieldOn = false;
    s.venting = false;
    for (const w of s.weapons) w.beam = 0;
    this.emit({ t: 'overload', ship: s });
  }

  vent(s: CombatShip): boolean {
    if (s.overload > 0 || s.venting || s.flux < s.fluxCap * 0.05) return false;
    s.venting = true;
    s.shieldOn = false;
    this.emit({ t: 'vent', ship: s });
    return true;
  }

  private playerShield(s: CombatShip): void {
    const i = this.input;
    if (i.toggleShield && s.shield) s.shieldOn = !s.shieldOn && s.overload <= 0 && !s.venting;
    if (i.vent) this.vent(s);
    if (i.system) this.activateSystem(s);
    if (s.shield?.type === 'omni' && i.aim) {
      _q.copy(s.quat).invert();
      s.shieldTarget = bearingOf(_a.copy(i.aim).sub(s.pos).applyQuaternion(_q));
    }
  }

  private updateShield(s: CombatShip, dt: number): void {
    if (!s.shield) return;
    const blocked = s.overload > 0 || s.venting || s.mods.noShield;
    const want = s.shieldOn && !blocked ? 1 : 0;
    // Bigger shields unfold more slowly.
    const rate = 2.6 - s.sizeIndex * 0.45;
    s.shieldUnfold = THREE.MathUtils.clamp(s.shieldUnfold + (want ? rate : -rate * 2) * dt, 0, 1);
    if (s.shield.type === 'front') s.shieldTarget = 0;
    const turn = (5 - s.sizeIndex) * dt;
    s.shieldFacing += THREE.MathUtils.clamp(wrapAngle(s.shieldTarget - s.shieldFacing), -turn, turn);
    s.shieldFacing = wrapAngle(s.shieldFacing);
  }

  // ---------------------------------------------------------------- systems

  activateSystem(s: CombatShip): boolean {
    const sys = s.system;
    if (s.systemActive > 0 || s.systemCharges <= 0 || s.overload > 0 || !s.alive) return false;
    if (s.flux + sys.fluxCost * s.fluxCap > s.fluxCap * 0.98) return false;
    s.systemActive = sys.duration;
    s.systemCharges--;
    if (s.systemCooldown <= 0) s.systemCooldown = sys.cooldown;
    if (sys.fluxCost) this.addFlux(s, sys.fluxCost * s.fluxCap, false);
    if (sys.action === 'dash') {
      const dir = s.controlled || s.ai.move.lengthSq() < 1 ? s.forward : _a.copy(s.ai.move).normalize();
      s.vel.addScaledVector(dir, 1100);
    } else if (sys.action === 'reload') {
      for (const w of s.weapons) if (w.def.type === 'missile') w.ammo = Math.min(w.maxAmmo, w.ammo + Math.ceil(w.maxAmmo * 0.5));
    } else if (sys.action === 'flares') {
      for (let i = 0; i < 4; i++) {
        const a = s.yaw + Math.PI + (i - 1.5) * 0.6;
        const flare: Flare = {
          active: true,
          pos: s.pos.clone(),
          vel: new THREE.Vector3(-Math.sin(a), 0, -Math.cos(a)).multiplyScalar(160).add(s.vel),
          life: 4.5,
          side: s.side,
        };
        this.flares.push(flare);
        this.emit({ t: 'flare', flare });
      }
      // Decoy guided missiles already in flight.
      for (const m of this.missiles)
        if (m.active && m.guided && m.side !== s.side && m.target === s && m.pos.distanceTo(s.pos) < 1400 && this.rng.next() < 0.75)
          m.decoy = this.flares[this.flares.length - 1 - this.rng.int(0, 3)];
    }
    this.emit({ t: 'system', ship: s });
    return true;
  }

  private updateSystem(s: CombatShip, dt: number): void {
    if (s.systemActive > 0) s.systemActive = Math.max(0, s.systemActive - dt);
    const max = s.system.charges ?? 1;
    if (s.systemCharges < max) {
      s.systemCooldown -= dt;
      if (s.systemCooldown <= 0) {
        s.systemCharges++;
        s.systemCooldown = s.systemCharges < max ? s.system.cooldown : 0;
      }
    }
  }

  // ---------------------------------------------------------------- weapons

  /** World-space muzzle position of a weapon. */
  muzzle(w: WeaponState, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(w.local).applyQuaternion(w.ship.quat).add(w.ship.pos);
  }

  /** Aim point for hitting `t` from weapon `w` (lead for projectiles). */
  leadPoint(w: WeaponState, t: { pos: THREE.Vector3; vel: THREE.Vector3 }, out: THREE.Vector3): THREE.Vector3 {
    const from = this.muzzle(w, _c);
    if (w.def.kind === 'beam') return out.copy(t.pos);
    const speed = w.def.speed ?? 1000;
    const rel = _d.copy(t.pos).sub(from);
    const relVel = _b.copy(t.vel).sub(w.ship.vel);
    const time = w.def.kind === 'missile' ? null : interceptTime(rel, relVel, speed);
    return out.copy(t.pos).addScaledVector(relVel, time ?? 0);
  }

  private updateWeapons(s: CombatShip, dt: number): void {
    const player = s.controlled;
    const canFire = s.canFire;
    _q.copy(s.quat).invert();
    for (const w of s.weapons) {
      w.sinceShot += dt;
      w.cooldown -= dt * (s.mods.rof ?? 1) * (s.cr < 0.4 ? s.crFactor : 1);
      if (w.disabled > 0) w.disabled -= dt;
      // Choose what this weapon aims at.
      const group = s.groups[w.group];
      let fire = false;
      w.aim = null;
      if (player && group && w.group === s.selectedGroup && this.input.aim) {
        w.aim = this.input.aim;
        fire = this.input.fire;
      } else if (!player || group?.autofire) {
        const t = wantsToFire(this, s, w);
        if (t) {
          w.aim = t.point;
          fire = t.fire;
        }
      }
      // Turret traverse toward the aim, within the arc.
      let desired = 0;
      let inArc = false;
      let elev = 0;
      if (w.aim) {
        const local = this.muzzle(w, _a);
        _b.copy(w.aim).sub(local).applyQuaternion(_q);
        const yaw = wrapAngle(bearingOf(_b) - w.facing);
        elev = Math.atan2(_b.y, Math.hypot(_b.x, _b.z));
        inArc = w.halfArc >= Math.PI || Math.abs(yaw) <= w.halfArc;
        desired = w.halfArc >= Math.PI ? yaw : THREE.MathUtils.clamp(yaw, -w.halfArc, w.halfArc);
      }
      const step = w.traverse * dt;
      w.yaw += THREE.MathUtils.clamp(wrapAngle(desired - w.yaw), -step, step);
      const onTarget = inArc && Math.abs(wrapAngle(desired - w.yaw)) < 0.035 + (w.def.kind === 'missile' ? 0.3 : 0);
      w.firing = false;
      const ready = canFire && w.disabled <= 0 && w.ammo > 0 && fire && (onTarget || (player && !w.turret));
      if (w.def.kind === 'beam') {
        const cost = w.def.flux * (s.mods.weaponFlux ?? 1) * dt;
        const on = ready && s.flux + cost < s.fluxCap;
        w.beam = THREE.MathUtils.clamp(w.beam + (on ? 7 : -5) * dt, 0, 1);
        if (on) {
          w.firing = true;
          this.addFlux(s, cost, false);
          s.lastShot = this.time;
        }
        if (w.beam > 0) this.fireBeam(w, elev, dt);
        else w.beamHit = 'none';
        continue;
      }
      if (!ready || w.cooldown > 0) continue;
      const cost = w.def.flux * (s.mods.weaponFlux ?? 1);
      if (s.flux + cost > s.fluxCap) continue;
      // Low readiness: occasional malfunctions.
      if (s.cr < 0.3 && this.rng.next() < (0.3 - s.cr) * 0.25) {
        w.cooldown = 1 / w.rof;
        w.disabled = 1.5;
        continue;
      }
      w.cooldown += 1 / w.rof;
      if (w.cooldown < 0) w.cooldown = 0;
      this.addFlux(s, cost, false);
      s.lastShot = this.time;
      w.sinceShot = 0;
      if (w.ammo !== Infinity) w.ammo--;
      this.shoot(w, elev);
    }
  }

  /** Barrel direction in world space: the turret's yaw plus the aim's elevation. */
  private barrelDir(w: WeaponState, elev: number, out: THREE.Vector3): THREE.Vector3 {
    const a = w.facing + w.yaw;
    const c = Math.cos(elev);
    return out.set(-Math.sin(a) * c, Math.sin(elev), -Math.cos(a) * c).applyQuaternion(w.ship.quat).normalize();
  }

  private shoot(w: WeaponState, elev: number): void {
    const s = w.ship;
    const pos = this.muzzle(w, new THREE.Vector3());
    const dir = this.barrelDir(w, elev, new THREE.Vector3());
    const spread = SPREAD[w.def.model];
    if (spread > 0) {
      // Random cone around the barrel.
      const perp = _a.set(dir.z, 0, -dir.x);
      if (perp.lengthSq() < 1e-6) perp.set(1, 0, 0);
      perp.normalize();
      dir.applyAxisAngle(perp, this.rng.range(-spread, spread) * 0.6).applyAxisAngle(_up, this.rng.range(-spread, spread)).normalize();
    }
    const energyMult = w.def.damageType === 'energy' ? (s.mods.energyDamage ?? 1) : 1;
    if (w.def.kind === 'missile') {
      this.launchMissile(w, pos, dir);
    } else {
      const speed = w.def.speed ?? 1000;
      this.spawnProjectile(w.def, s, pos, _b.copy(dir).multiplyScalar(speed).add(s.vel), w.def.damage * energyMult, w.def.damageType, w.range / speed);
    }
    this.emit({ t: 'shot', weapon: w, pos, dir });
  }

  spawnProjectile(def: WeaponDef, owner: CombatShip, pos: THREE.Vector3, vel: THREE.Vector3, damage: number, type: DamageType, life: number): Projectile {
    let p = this.projectiles.find((x) => !x.active);
    if (!p) {
      p = {
        active: false,
        pos: new THREE.Vector3(),
        prev: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        def,
        damage: 0,
        type,
        side: owner.side,
        owner,
        life: 0,
        age: 0,
        emp: false,
        flak: false,
      };
      this.projectiles.push(p);
    }
    p.active = true;
    p.pos.copy(pos);
    p.prev.copy(pos);
    p.vel.copy(vel);
    p.def = def;
    p.damage = damage;
    p.type = type;
    p.side = owner.side;
    p.owner = owner;
    p.life = life;
    p.age = 0;
    p.emp = !!def.emp;
    p.flak = def.model === 'flak';
    return p;
  }

  private launchMissile(w: WeaponState, pos: THREE.Vector3, dir: THREE.Vector3): void {
    const def = w.def;
    const s = w.ship;
    const torpedo = def.model === 'torpedo';
    const maxSpeed = def.speed ?? 500;
    const target = s.controlled ? this.playerMissileTarget(s) : s.target;
    const hp = torpedo ? 450 : def.id === 'swarm_rockets' ? 45 : 130;
    const m: Missile = {
      active: true,
      id: ++this.missileIds,
      pos: pos.clone(),
      prev: pos.clone(),
      vel: dir.clone().multiplyScalar(Math.min(maxSpeed * 0.35, 150)).add(s.vel),
      dir: dir.clone(),
      speed: 0,
      maxSpeed,
      turn: torpedo ? 0.55 : def.id === 'sabot_pod' ? 1.6 : 2.1,
      hp,
      maxHp: hp,
      damage: def.damage,
      type: def.damageType,
      side: s.side,
      owner: s,
      def,
      target: def.guided ? target : null,
      decoy: null,
      guided: !!def.guided,
      life: (w.range / maxSpeed) * 1.2 + 0.5,
      age: 0,
      split: def.id === 'sabot_pod',
      radius: torpedo ? 7 : 4,
    };
    const free = this.missiles.findIndex((x) => !x.active);
    if (free >= 0) this.missiles[free] = m;
    else this.missiles.push(m);
    this.emit({ t: 'launch', missile: m });
  }

  /** Guided missiles fired by the player lock onto their target, or whatever is under the aim. */
  private playerMissileTarget(s: CombatShip): CombatShip | null {
    if (s.target?.alive) return s.target;
    const aim = this.input.aim;
    if (!aim) return null;
    let best: CombatShip | null = null;
    let bestD = Infinity;
    for (const e of this.enemiesOf(s)) {
      const d = e.pos.distanceTo(aim);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- beams

  private fireBeam(w: WeaponState, elev: number, dt: number): void {
    const s = w.ship;
    const from = this.muzzle(w, new THREE.Vector3());
    const dir = this.barrelDir(w, elev, new THREE.Vector3());
    const to = _d.copy(from).addScaledVector(dir, w.range);
    let bestT = 1;
    let hitShip: CombatShip | null = null;
    let hitShield = false;
    let hitMissile: Missile | null = null;
    for (const e of this.ships) {
      if (!e.alive || e.retreated || e.side === s.side || e.mods.phased) continue;
      if (pointSegmentDistSq(e.pos, from, to) > e.dims.bound * e.dims.bound) continue;
      const r = this.rayShip(e, from, to);
      if (r && r.t < bestT) {
        bestT = r.t;
        hitShip = e;
        hitShield = r.shield;
        hitMissile = null;
      }
    }
    for (const m of this.missiles) {
      if (!m.active || m.side === s.side) continue;
      const r = m.radius + 3;
      if (pointSegmentDistSq(m.pos, from, to) > r * r) continue;
      const t = _a.copy(m.pos).sub(from).dot(dir) / w.range;
      if (t >= 0 && t < bestT) {
        bestT = t;
        hitMissile = m;
        hitShip = null;
      }
    }
    w.beamLength = bestT * w.range;
    w.beamHit = hitShip ? (hitShield ? 'shield' : 'hull') : hitMissile ? 'missile' : 'none';
    if (!w.firing) return;
    const energyMult = w.def.damageType === 'energy' ? (s.mods.energyDamage ?? 1) : 1;
    const dmg = w.def.damage * energyMult * w.beam * dt;
    const at = _c.copy(from).addScaledVector(dir, w.beamLength);
    if (hitShip) this.damageShip(hitShip, at, dmg, w.def.damageType, s, { shield: hitShield, beam: true, emp: false, beamDps: w.def.damage * energyMult });
    else if (hitMissile) this.damageMissile(hitMissile, dmg * MISSILE_MULT[w.def.damageType], at);
  }

  /** First hit along a segment: shield (if the hit point is inside the arc) or hull. */
  rayShip(e: CombatShip, from: THREE.Vector3, to: THREE.Vector3): { t: number; shield: boolean } | null {
    if (e.shieldUp) {
      const t = segmentEllipsoidOutside(from, to, e.pos, e.quat, e.dims.shield);
      if (t >= 0) {
        const p = _b.copy(from).lerp(to, t);
        if (this.inShieldArc(e, p)) return { t, shield: true };
      }
    }
    const t = segmentEllipsoid(from, to, e.pos, e.quat, e.dims.hull);
    return t >= 0 ? { t, shield: false } : null;
  }

  /** Whether a world point lies within the ship's current shield arc. */
  inShieldArc(e: CombatShip, p: THREE.Vector3): boolean {
    if (!e.shield) return false;
    const local = _a.copy(p).sub(e.pos).applyQuaternion(_q.copy(e.quat).invert());
    const b = bearingOf(local);
    const half = e.shield.halfArc * e.shieldUnfold;
    return half >= Math.PI - 1e-3 || Math.abs(wrapAngle(b - e.shieldFacing)) <= half;
  }

  // ---------------------------------------------------------------- damage

  damageShip(
    e: CombatShip,
    at: THREE.Vector3,
    damage: number,
    type: DamageType,
    source: CombatShip | null,
    o: { shield: boolean; beam: boolean; emp: boolean; beamDps?: number },
  ): void {
    if (!e.alive) return;
    e.lastHit = this.time;
    if (source) source.damageDealt += damage;
    if (o.shield && e.shield) {
      const flux = shieldFlux(damage, type, e.shield.efficiency) * (e.mods.shieldFlux ?? 1);
      this.addFlux(e, flux, !o.beam);
      e.pressure += flux / e.fluxCap;
      if (!o.beam || this.rng.next() < 0.15) this.emit({ t: 'hit', pos: at.clone(), kind: 'shield', ship: e, damage, type, source, size: hitSize(damage, o.beam) });
      return;
    }
    const local = _a.copy(at).sub(e.pos).applyQuaternion(_q.copy(e.quat).invert());
    const cell = e.armor.cellAt(bearingOf(local));
    const mult = e.mods.damageTaken ?? 1;
    const strength = o.beam ? (o.beamDps ?? damage) * 0.35 : damage;
    const res = e.armor.hit(cell, damage * mult, type, strength * mult);
    e.hp -= res.hull;
    e.pressure += (res.hull + res.armor) / e.maxHp;
    if (!o.beam || this.rng.next() < 0.2)
      this.emit({ t: 'hit', pos: at.clone(), kind: res.hull > res.armor ? 'hull' : 'armor', ship: e, damage, type, source, size: hitSize(damage, o.beam) });
    if (o.emp && this.rng.next() < 0.3) {
      const live = e.weapons.filter((w) => w.disabled <= 0);
      if (live.length) {
        this.rng.pick(live).disabled = 3.5;
        this.emit({ t: 'emp', ship: e, pos: at.clone() });
      }
    }
    if (e.hp <= 0) this.destroy(e, source);
  }

  destroy(e: CombatShip, by: CombatShip | null): void {
    if (!e.alive) return;
    e.alive = false;
    e.hp = 0;
    e.shieldOn = false;
    e.shieldUnfold = 0;
    e.deadFor = 0;
    for (const w of e.weapons) w.beam = 0;
    e.spin.set(this.rng.range(-0.25, 0.25), this.rng.range(-0.35, 0.35), this.rng.range(-0.3, 0.3)).multiplyScalar(1 / (1 + e.sizeIndex));
    if (by && by.side !== e.side) by.kills++;
    this.emit({ t: 'destroyed', ship: e, by });
  }

  private updateWreck(s: CombatShip, dt: number): void {
    s.deadFor += dt;
    s.vel.multiplyScalar(Math.exp(-dt * 0.15));
    s.pos.addScaledVector(s.vel, dt);
    if (s.spin.lengthSq() > 0) {
      _q.setFromEuler(_e.set(s.spin.x * dt, s.spin.y * dt, s.spin.z * dt));
      s.quat.multiply(_q).normalize();
    }
  }

  private damageMissile(m: Missile, damage: number, at: THREE.Vector3): void {
    m.hp -= damage;
    if (m.hp <= 0 && m.active) {
      m.active = false;
      this.emit({ t: 'pd', pos: at.clone(), size: m.def.model === 'torpedo' ? 2 : 1 });
    }
  }

  // ---------------------------------------------------------------- projectiles

  private updateProjectiles(dt: number): void {
    const ships = this.ships;
    for (const p of this.projectiles) {
      if (!p.active) continue;
      p.prev.copy(p.pos);
      p.pos.addScaledVector(p.vel, dt);
      p.age += dt;
      if (p.age > p.life) {
        p.active = false;
        if (p.flak) this.flakBurst(p, p.pos);
        continue;
      }
      let bestT = 2;
      let hit: CombatShip | null = null;
      let shield = false;
      for (const e of ships) {
        if (!e.alive || e.retreated || e.side === p.side || e.mods.phased) continue;
        const r = e.dims.bound;
        if (pointSegmentDistSq(e.pos, p.prev, p.pos) > r * r) {
          // Near miss heading this way: lets the AI raise shields in time.
          if (!e.controlled) this.noteThreat(e, p.pos, p.vel);
          continue;
        }
        const res = this.rayShip(e, p.prev, p.pos);
        if (res && res.t < bestT) {
          bestT = res.t;
          hit = e;
          shield = res.shield;
        }
      }
      if (hit) {
        const at = _c.copy(p.prev).lerp(p.pos, bestT);
        p.active = false;
        if (p.flak) this.flakBurst(p, at);
        this.damageShip(hit, at, p.damage, p.type, p.owner, { shield, beam: false, emp: p.emp });
        continue;
      }
      // Projectiles against missiles (PD flak bursts near them).
      for (const m of this.missiles) {
        if (!m.active || m.side === p.side) continue;
        const r = p.flak ? 32 : m.radius + 2;
        if (pointSegmentDistSq(m.pos, p.prev, p.pos) > r * r) continue;
        p.active = false;
        if (p.flak) this.flakBurst(p, m.pos);
        else this.damageMissile(m, p.damage * MISSILE_MULT[p.type], m.pos);
        break;
      }
    }
  }

  /** Lets the AI see incoming fire: anything that will pass close within ~1.5 s. */
  private noteThreat(e: CombatShip, pos: THREE.Vector3, vel: THREE.Vector3): void {
    const rel = _a.copy(e.pos).sub(pos);
    const closing = rel.dot(vel);
    if (closing <= 0) return;
    const v2 = vel.lengthSq();
    const t = closing / v2;
    if (t > 1.5) return;
    const miss = rel.addScaledVector(vel, -t).length();
    if (miss < e.dims.bound * 1.3) {
      e.ai.lastThreat = this.time;
      e.ai.threatDir.copy(pos).sub(e.pos).normalize();
    }
  }

  private flakBurst(p: Projectile, at: THREE.Vector3): void {
    this.emit({ t: 'explode', pos: at.clone(), size: 0.6, kind: 'flak' });
    for (const m of this.missiles) {
      if (!m.active || m.side === p.side) continue;
      if (m.pos.distanceToSquared(at) < 45 * 45) this.damageMissile(m, p.damage * MISSILE_MULT.frag, m.pos);
    }
  }

  // ---------------------------------------------------------------- missiles

  private updateMissiles(dt: number): void {
    for (const m of this.missiles) {
      if (!m.active) continue;
      m.age += dt;
      m.prev.copy(m.pos);
      if (m.age > m.life) {
        m.active = false;
        this.emit({ t: 'explode', pos: m.pos.clone(), size: 0.5, kind: 'missile' });
        continue;
      }
      // Guidance: steer the nose toward a lead point on the target (or a decoy flare).
      const decoy = m.decoy?.active ? m.decoy : null;
      const target = m.target?.alive && !m.target.retreated ? m.target : null;
      if (m.guided && m.age > 0.25 && (decoy || target)) {
        const tp = decoy ? decoy.pos : target!.pos;
        const tv = decoy ? decoy.vel : target!.vel;
        const rel = _a.copy(tp).sub(m.pos);
        const t = interceptTime(rel, _b.copy(tv).sub(m.vel).multiplyScalar(0.5), Math.max(m.speed, 100)) ?? 0;
        const want = rel.addScaledVector(tv, Math.min(t, 3)).normalize();
        const angle = m.dir.angleTo(want);
        if (angle > 1e-4) {
          const axis = _c.crossVectors(m.dir, want);
          if (axis.lengthSq() > 1e-10) m.dir.applyAxisAngle(axis.normalize(), Math.min(angle, m.turn * dt)).normalize();
        }
        if (decoy && m.pos.distanceToSquared(decoy.pos) < 40 * 40) {
          m.active = false;
          this.emit({ t: 'explode', pos: m.pos.clone(), size: 0.6, kind: 'missile' });
          continue;
        }
        if (m.split && target && m.pos.distanceTo(target.pos) < 420 + target.dims.bound) {
          this.splitSabot(m, target);
          continue;
        }
      }
      // Accelerate along the nose; guided missiles bleed sideways drift.
      m.speed = Math.min(m.maxSpeed, m.speed + m.maxSpeed * 1.4 * dt);
      const along = _a.copy(m.dir).multiplyScalar(m.speed);
      m.vel.lerp(along, 1 - Math.exp(-dt * (m.guided ? 5 : 3)));
      m.pos.addScaledVector(m.vel, dt);
      // Hits.
      for (const e of this.ships) {
        if (!e.alive || e.retreated || e.side === m.side || e.mods.phased) continue;
        const r = e.dims.bound + m.radius;
        if (pointSegmentDistSq(e.pos, m.prev, m.pos) > r * r) {
          if (!e.controlled) this.noteThreat(e, m.pos, m.vel);
          continue;
        }
        const res = this.rayShip(e, m.prev, m.pos);
        if (!res) continue;
        const at = _c.copy(m.prev).lerp(m.pos, res.t).clone();
        m.active = false;
        this.damageShip(e, at, m.damage, m.type, m.owner, { shield: res.shield, beam: false, emp: false });
        this.emit({ t: 'explode', pos: at, size: m.def.model === 'torpedo' ? 3.5 : m.damage > 300 ? 1.6 : 1, kind: m.def.model === 'torpedo' ? 'torpedo' : 'missile' });
        break;
      }
    }
  }

  /** Sabot missiles burst into a cone of kinetic darts just short of the target. */
  private splitSabot(m: Missile, target: CombatShip): void {
    m.active = false;
    const darts = 5;
    const speed = 1500;
    const dir = _a.copy(target.pos).sub(m.pos).normalize();
    for (let i = 0; i < darts; i++) {
      const d = _b.copy(dir).applyAxisAngle(_up, this.rng.range(-0.06, 0.06)).normalize();
      this.spawnProjectile(DART, m.owner, m.pos, _c.copy(d).multiplyScalar(speed).add(m.vel.clone().multiplyScalar(0.3)), m.damage / darts, 'kinetic', 0.8);
    }
    this.emit({ t: 'explode', pos: m.pos.clone(), size: 0.5, kind: 'flak' });
  }

  private updateFlares(dt: number): void {
    for (const f of this.flares) {
      if (!f.active) continue;
      f.life -= dt;
      f.vel.multiplyScalar(Math.exp(-dt * 0.8));
      f.pos.addScaledVector(f.vel, dt);
      if (f.life <= 0) f.active = false;
    }
    if (this.flares.length > 64) {
      const live = this.flares.filter((f) => f.active);
      this.flares.length = 0;
      this.flares.push(...live);
    }
  }

  // ---------------------------------------------------------------- ships

  private collideShips(dt: number): void {
    const live = this.ships.filter((s) => s.alive && !s.retreated);
    for (let i = 0; i < live.length; i++)
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i];
        const b = live[j];
        const min = a.dims.collide + b.dims.collide;
        const d = _a.copy(b.pos).sub(a.pos);
        const dist = d.length();
        if (dist >= min || dist < 1e-6) continue;
        const n = d.divideScalar(dist);
        const ma = a.maxHp;
        const mb = b.maxHp;
        const push = min - dist;
        a.pos.addScaledVector(n, -push * (mb / (ma + mb)));
        b.pos.addScaledVector(n, push * (ma / (ma + mb)));
        const rel = _b.copy(b.vel).sub(a.vel).dot(n);
        if (rel < 0) {
          const impulse = -rel * 1.4;
          a.vel.addScaledVector(n, -impulse * (mb / (ma + mb)));
          b.vel.addScaledVector(n, impulse * (ma / (ma + mb)));
          if (-rel > 60 && a.side !== b.side) {
            const dmg = (-rel - 60) * 4;
            const at = _c.copy(a.pos).addScaledVector(n, a.dims.collide);
            this.damageShip(a, at, dmg * (mb / (ma + mb)), 'kinetic', b, { shield: false, beam: false, emp: false });
            this.damageShip(b, at, dmg * (ma / (ma + mb)), 'kinetic', a, { shield: false, beam: false, emp: false });
          }
        }
      }
    void dt;
  }

  private checkRetreats(): void {
    for (const s of this.ships) {
      if (!s.alive || s.retreated || s.controlled) continue;
      if (s.order?.kind !== 'retreat' && this.stance[s.side] !== 'retreat') continue;
      if (s.pos.length() > ARENA_RADIUS) {
        s.retreated = true;
        for (const w of s.weapons) w.beam = 0;
        this.emit({ t: 'retreated', ship: s });
      }
    }
  }

  /** Nearest hostile distance to a point, for mass lock. */
  nearestHostile(side: Side, p: THREE.Vector3): number {
    let best = Infinity;
    for (const e of this.active(side === 0 ? 1 : 0)) best = Math.min(best, e.pos.distanceTo(p));
    return best;
  }
}

function hitSize(damage: number, beam: boolean): number {
  return beam ? 0.6 : THREE.MathUtils.clamp(Math.sqrt(damage / 100), 0.4, 3);
}

/** Kinetic darts from a split sabot missile. */
const DART: WeaponDef = {
  id: 'sabot_dart',
  name: 'Sabot dart',
  size: 'S',
  type: 'missile',
  kind: 'projectile',
  damageType: 'kinetic',
  damage: 100,
  rof: 1,
  range: 1200,
  flux: 0,
  op: 0,
  model: 'railgun',
  description: '',
  speed: 1500,
};
