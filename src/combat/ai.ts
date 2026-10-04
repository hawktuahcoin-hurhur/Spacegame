import * as THREE from 'three';
import { bearingOf, wrapAngle, yawOf } from './geometry';
import type { CombatShip, Side, WeaponState } from './ship';
import { ARENA_RADIUS, type CombatSim } from './sim';

/**
 * Ship AI as a small behaviour tree, re-evaluated ~8× a second, plus per-tick
 * shield and fire control. A fleet commander per side assigns targets
 * (preferring focus fire on weakened or overloaded ships) and decides when a
 * beaten fleet should run.
 */

type Status = 'success' | 'failure' | 'running';
interface Ctx {
  sim: CombatSim;
  s: CombatShip;
}
type Node = (c: Ctx) => Status;

const sel =
  (...nodes: Node[]): Node =>
  (c) => {
    for (const n of nodes) {
      const r = n(c);
      if (r !== 'failure') return r;
    }
    return 'failure';
  };
const seq =
  (...nodes: Node[]): Node =>
  (c) => {
    for (const n of nodes) {
      const r = n(c);
      if (r !== 'success') return r;
    }
    return 'success';
  };
const cond =
  (f: (c: Ctx) => boolean): Node =>
  (c) =>
    f(c) ? 'success' : 'failure';
const act =
  (f: (c: Ctx) => void): Node =>
  (c) => {
    f(c);
    return 'running';
  };

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q = new THREE.Quaternion();

// ---------------------------------------------------------------- helpers

function nearestEnemy(sim: CombatSim, s: CombatShip): { e: CombatShip; d: number } | null {
  let best: CombatShip | null = null;
  let bestD = Infinity;
  for (const e of sim.enemiesOf(s)) {
    const d = e.pos.distanceTo(s.pos);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best ? { e: best, d: bestD } : null;
}

/** How far an enemy's guns reach. */
function reachOf(e: CombatShip): number {
  return e.ai.range / 0.82 + e.dims.bound;
}

/** Facing that puts `bearing` on the target. */
function faceTarget(s: CombatShip, p: THREE.Vector3, bearing = 0): number {
  return yawOf(_a.copy(p).sub(s.pos)) + bearing;
}

/** Desired velocity toward/around a point at a range band. */
function rangeKeep(s: CombatShip, p: THREE.Vector3, want: number, orbit: number, out: THREE.Vector3): THREE.Vector3 {
  const rel = _a.copy(p).sub(s.pos);
  rel.y = 0;
  const d = Math.max(rel.length(), 1);
  const dir = rel.divideScalar(d);
  const v = s.maxSpeed;
  let radial: number;
  if (d > want * 1.08) radial = v;
  else if (d < want * 0.78) radial = -v * 0.8;
  else radial = THREE.MathUtils.clamp(((d - want) / want) * v * 3, -v * 0.5, v * 0.5);
  const perp = _b.set(-dir.z, 0, dir.x).multiplyScalar(orbit * v * [0.42, 0.32, 0.2, 0.1][s.sizeIndex]);
  return out.copy(dir).multiplyScalar(radial).add(perp);
}

/** Keep clear of allies and inside the arena. */
function avoid(sim: CombatSim, s: CombatShip, move: THREE.Vector3): void {
  for (const o of sim.ships) {
    if (o === s || !o.alive || o.retreated) continue;
    const rel = _a.copy(s.pos).sub(o.pos);
    rel.y = 0;
    const d = rel.length();
    const min = (s.dims.collide + o.dims.collide) * 2.2;
    if (d < min && d > 1e-3) move.addScaledVector(rel.divideScalar(d), ((min - d) / min) * s.maxSpeed * 1.5);
  }
  const r = Math.hypot(s.pos.x, s.pos.z);
  if (r > ARENA_RADIUS * 0.8 && s.order?.kind !== 'retreat' && s.ai.state !== 'Retreating') {
    move.addScaledVector(_a.set(-s.pos.x / r, 0, -s.pos.z / r), ((r - ARENA_RADIUS * 0.8) / (ARENA_RADIUS * 0.2)) * s.maxSpeed);
  }
}

function enemyCentroid(sim: CombatSim, s: CombatShip, out: THREE.Vector3): THREE.Vector3 | null {
  const es = sim.enemiesOf(s);
  if (!es.length) return null;
  out.set(0, 0, 0);
  for (const e of es) out.add(e.pos);
  return out.divideScalar(es.length);
}

// ---------------------------------------------------------------- behaviours

function evade(c: Ctx, label: string): void {
  const { sim, s } = c;
  const n = nearestEnemy(sim, s);
  s.ai.state = label;
  if (!n) {
    s.ai.move.set(0, 0, 0);
    return;
  }
  const away = _a.copy(s.pos).sub(n.e.pos);
  away.y = 0;
  away.normalize().multiplyScalar(s.maxSpeed);
  s.ai.move.copy(away);
  // Back off facing the threat (armour and guns toward it).
  s.ai.facing = faceTarget(s, n.e.pos, s.ai.attackBearing);
}

function retreat(c: Ctx): void {
  const { sim, s } = c;
  s.ai.state = 'Retreating';
  const centre = enemyCentroid(sim, s, new THREE.Vector3());
  const out = centre ? _a.copy(s.pos).sub(centre) : _a.copy(s.pos);
  out.y = 0;
  if (out.lengthSq() < 1) out.set(1, 0, 0);
  out.normalize();
  // Blend toward the nearest arena edge.
  const r = Math.hypot(s.pos.x, s.pos.z);
  if (r > 1) out.add(_b.set(s.pos.x / r, 0, s.pos.z / r)).normalize();
  s.ai.move.copy(out).multiplyScalar(s.maxSpeed);
  s.ai.facing = yawOf(out);
  if (s.system.use === 'gapclose' || s.system.use === 'manoeuvre' || s.system.use === 'dash') sim.activateSystem(s);
}

function engage(c: Ctx): void {
  const { sim, s } = c;
  const t = s.target!;
  const d = t.pos.distanceTo(s.pos);
  let want = s.ai.range + t.dims.bound * 0.5;
  // Press overloaded or venting targets; keep out of reach when hot.
  if (t.overload > 0 || t.venting) want *= 0.6;
  if (s.fluxFrac > 0.55) want = Math.max(want, reachOf(t) * 1.05);
  s.ai.state = t.overload > 0 ? `Pressing ${t.name}` : `Engaging ${t.name}`;
  rangeKeep(s, t.pos, want, s.ai.orbit, s.ai.move);
  // Cohesion: while closing from afar, don't outrun the fleet and arrive alone.
  if (d > reachOf(t) + 900 && !s.order) {
    let slowest = s.maxSpeed;
    for (const f of sim.active(s.side)) if (f !== s && f.pos.distanceTo(s.pos) < 3000) slowest = Math.min(slowest, f.maxSpeed * 1.05);
    if (s.ai.move.length() > slowest) s.ai.move.setLength(slowest);
  }
  s.ai.facing = faceTarget(s, t.pos, s.ai.attackBearing);
  if (Math.abs(t.pos.y) > 1) s.ai.move.y = THREE.MathUtils.clamp(t.pos.y, -300, 300) - s.pos.y;
  // Ship systems.
  const use = s.system.use;
  const facingErr = Math.abs(wrapAngle(s.ai.facing - s.yaw));
  // Only burn in when it won't strand us alone among their whole fleet.
  const crowd = sim.enemiesOf(s).filter((e) => e !== t && e.pos.distanceTo(t.pos) < 2200).length;
  const friends = sim.active(s.side).filter((f) => f !== s && f.pos.distanceTo(t.pos) < 1600).length;
  if ((use === 'gapclose' || use === 'dash') && d > want * 1.9 && d < reachOf(t) + 2500 && facingErr < 0.3 && s.fluxFrac < 0.5 && crowd <= friends) sim.activateSystem(s);
  else if (use === 'offence' && d < s.ai.range * 1.1 && s.fluxFrac < 0.55) sim.activateSystem(s);
  else if (use === 'manoeuvre' && (d > want * 1.6 || facingErr > 1.2)) sim.activateSystem(s);
}

function backOff(c: Ctx): void {
  const { sim, s } = c;
  const n = nearestEnemy(sim, s);
  if (!n) return;
  s.ai.state = 'Backing off';
  rangeKeep(s, n.e.pos, reachOf(n.e) * 1.15, s.ai.orbit, s.ai.move);
  s.ai.facing = faceTarget(s, n.e.pos, s.ai.attackBearing);
  if (s.system.use === 'manoeuvre' || s.system.use === 'dash') sim.activateSystem(s);
}

function moveTo(c: Ctx, p: THREE.Vector3, label: string): void {
  const { sim, s } = c;
  const rel = _a.copy(p).sub(s.pos);
  rel.y = 0;
  const d = rel.length();
  const v = s.maxSpeed * THREE.MathUtils.clamp(d / 600, 0, 1);
  s.ai.move.copy(rel.normalize()).multiplyScalar(v);
  s.ai.state = d > 300 ? label : 'Holding';
  // Face enemies in reach, otherwise the direction of travel.
  const n = nearestEnemy(sim, s);
  if (n && n.d < s.ai.range * 1.3) {
    s.target = n.e;
    s.ai.facing = faceTarget(s, n.e.pos, s.ai.attackBearing);
  } else if (d > 50) s.ai.facing = yawOf(rel);
}

function escort(c: Ctx): void {
  const { sim, s } = c;
  const lead = s.order!.target!;
  const n = nearestEnemy(sim, lead);
  const toward = n ? _a.copy(n.e.pos).sub(lead.pos).setY(0).normalize() : lead.forward.setY(0).normalize();
  const side = s.ai.orbit;
  const gap = (lead.dims.collide + s.dims.collide) * 1.8;
  const spot = new THREE.Vector3(-toward.z, 0, toward.x).multiplyScalar(side * gap).addScaledVector(toward, lead.dims.collide * 1.2).add(lead.pos);
  // Engage anything threatening the escorted ship; otherwise hold station.
  if (n && n.e.pos.distanceTo(lead.pos) < reachOf(n.e) * 1.4) {
    s.target = n.e;
    const d = spot.distanceTo(s.pos);
    if (d > gap * 2) moveTo(c, spot, `Escorting ${lead.name}`);
    else {
      rangeKeep(s, n.e.pos, s.ai.range, s.ai.orbit, s.ai.move);
      s.ai.move.multiplyScalar(0.5).add(_b.copy(spot).sub(s.pos).setY(0).multiplyScalar(0.4));
      s.ai.facing = faceTarget(s, n.e.pos, s.ai.attackBearing);
      s.ai.state = `Escorting ${lead.name}`;
    }
  } else moveTo(c, spot, `Escorting ${lead.name}`);
  if (s.ai.state === 'Holding') s.ai.state = `Escorting ${lead.name}`;
}

function regroup(c: Ctx): void {
  const { sim, s } = c;
  const friends = sim.active(s.side).filter((x) => x !== s);
  const lead = friends.find((x) => x.controlled) ?? friends.sort((a, b) => b.maxHp - a.maxHp)[0];
  if (!lead) {
    s.ai.move.set(0, 0, 0);
    s.ai.state = 'Idle';
    return;
  }
  moveTo(c, _b.copy(lead.pos).addScaledVector(lead.forward, -lead.dims.collide * 3), 'Regrouping');
}

function shouldVent(c: Ctx): boolean {
  const { sim, s } = c;
  if (s.fluxFrac < 0.7 || s.overload > 0) return false;
  if (sim.time - s.ai.lastThreat < 1.2) return false;
  const n = nearestEnemy(sim, s);
  return !n || n.d > reachOf(n.e) * 1.02 || s.fluxFrac > 0.95;
}

function hasTarget(c: Ctx): boolean {
  const { sim, s } = c;
  if (s.order?.kind === 'attack' && s.order.target?.alive && !s.order.target.retreated) {
    s.target = s.order.target;
    return true;
  }
  if (s.target && (!s.target.alive || s.target.retreated)) s.target = null;
  if (!s.target) s.target = nearestEnemy(sim, s)?.e ?? null;
  return !!s.target;
}

const TREE: Node = sel(
  seq(
    cond((c) => c.s.overload > 0),
    act((c) => evade(c, 'Overloaded!')),
  ),
  seq(
    cond((c) => c.s.venting),
    act((c) => evade(c, 'Venting flux')),
  ),
  seq(
    cond((c) => c.s.order?.kind === 'retreat' || c.sim.stance[c.s.side] === 'retreat'),
    act(retreat),
  ),
  seq(
    cond(shouldVent),
    act((c) => {
      c.sim.vent(c.s);
      evade(c, 'Venting flux');
    }),
  ),
  seq(
    cond((c) => c.s.order?.kind === 'move' && !!c.s.order.point),
    act((c) => moveTo(c, c.s.order!.point!, 'Moving')),
  ),
  seq(
    cond((c) => c.s.order?.kind === 'hold'),
    act((c) => {
      if (!c.s.ai.anchor) c.s.ai.anchor = c.s.order!.point?.clone() ?? c.s.pos.clone();
      moveTo(c, c.s.ai.anchor, 'Holding');
    }),
  ),
  seq(
    cond((c) => c.s.order?.kind === 'escort' && !!c.s.order.target?.alive),
    act(escort),
  ),
  seq(
    cond((c) => c.s.fluxFrac > 0.72 || (c.s.pressure > 0.3 && c.s.fluxFrac > 0.4 && c.s.hpFrac < 0.75)),
    act(backOff),
  ),
  seq(cond(hasTarget), act(engage)),
  act(regroup),
);

/** Re-run the behaviour tree for one ship. */
export function shipThink(sim: CombatSim, s: CombatShip): void {
  if (s.order?.kind !== 'hold') s.ai.anchor = null;
  if (s.order?.kind === 'escort' && !s.order.target?.alive) s.order = null;
  if (s.order?.kind === 'attack' && (!s.order.target?.alive || s.order.target.retreated)) s.order = null;
  if (s.attackBearingStale) {
    s.ai.attackBearing = bestBearing(s);
    s.attackBearingStale = false;
  }
  TREE({ sim, s });
  avoid(sim, s, s.ai.move);
  // Defensive and utility systems.
  const use = s.system.use;
  if (use === 'defend' && (s.pressure > 0.12 || (s.fluxFrac > 0.75 && sim.time - s.ai.lastThreat < 0.5)) && (s.system.mods.shieldFlux ? s.shieldUp : true)) sim.activateSystem(s);
  else if (use === 'flares' && sim.missiles.some((m) => m.active && m.guided && m.target === s && m.pos.distanceTo(s.pos) < 1300)) sim.activateSystem(s);
  else if (use === 'reload' && s.weapons.some((w) => w.def.type === 'missile' && w.ammo < w.maxAmmo * 0.3)) sim.activateSystem(s);
  else if (use === 'dash' && sim.time - s.ai.lastThreat < 0.3 && s.fluxFrac > 0.6) sim.activateSystem(s);
}

/** The bearing (relative to the nose) that brings the most firepower to bear. */
export function bestBearing(s: CombatShip): number {
  let best = 0;
  let bestScore = -1;
  for (let deg = 0; deg <= 180; deg += 10) {
    for (const sign of deg === 0 || deg === 180 ? [1] : [1, -1]) {
      const b = THREE.MathUtils.degToRad(deg * sign);
      let score = 0;
      for (const w of s.weapons) {
        if (w.def.pd) continue;
        const dps = w.def.kind === 'beam' ? w.def.damage : w.def.damage * w.rof;
        if (Math.abs(wrapAngle(b - w.facing)) <= w.halfArc + 0.02) score += dps;
      }
      // Prefer pointing the nose (and front shields) at the enemy when it's close.
      score *= 1 - deg / 900;
      if (s.shield?.type === 'front') score *= Math.cos(THREE.MathUtils.degToRad(deg) * 0.5);
      if (score > bestScore + 1e-6) {
        bestScore = score;
        best = b;
      }
    }
  }
  return best;
}

/** Integrate an AI ship's motion toward its desired facing and velocity. */
export function steerShip(sim: CombatSim, s: CombatShip, dt: number): void {
  const burn = !!s.mods.burn;
  // Turning: rate-limited with a little angular inertia.
  const tr = s.turnRate;
  const err = wrapAngle(s.ai.facing - s.yaw);
  const wantRate = THREE.MathUtils.clamp(err * 2.5, -tr, tr);
  s.angVel += THREE.MathUtils.clamp(wantRate - s.angVel, -tr * 3 * dt, tr * 3 * dt);
  s.setYaw(wrapAngle(s.yaw + s.angVel * dt));
  // Thrust: full along the nose, weaker sideways and in reverse.
  const fwd = _a.set(-Math.sin(s.yaw), 0, -Math.cos(s.yaw));
  const want = _b.copy(burn ? fwd : s.ai.move);
  want.y = 0;
  const max = s.maxSpeed;
  if (burn) want.multiplyScalar(max);
  else if (want.length() > max) want.setLength(max);
  const dv = want.sub(_c.copy(s.vel).setY(0));
  const along = dv.dot(fwd);
  const a = s.accel;
  const alongClamped = THREE.MathUtils.clamp(along, -a * 0.75 * dt, a * dt);
  const lat = dv.addScaledVector(fwd, -along);
  const latLen = lat.length();
  if (latLen > a * 0.6 * dt) lat.multiplyScalar((a * 0.6 * dt) / latLen);
  s.vel.addScaledVector(fwd, alongClamped).add(lat);
  // Hold the combat plane (or the target's altitude band).
  const wantY = s.ai.move.y !== 0 && !burn ? s.pos.y + s.ai.move.y : 0;
  s.vel.y += (THREE.MathUtils.clamp((wantY - s.pos.y) * 0.5, -60, 60) - s.vel.y) * Math.min(1, dt * 1.5);
  s.ai.move.y = 0;
  const speed = Math.hypot(s.vel.x, s.vel.z);
  if (speed > max * 1.02 && !s.mods.phased) {
    const k = Math.max(max / speed, 1 - dt * 2);
    s.vel.x *= k;
    s.vel.z *= k;
  }
  s.pos.addScaledVector(s.vel, dt);
  s.throttle = THREE.MathUtils.clamp(s.vel.dot(fwd) / Math.max(s.stats.maxSpeed, 1), 0, 1.5);
  void sim;
}

/** Raise shields against incoming fire, drop them to bleed hard flux when it's quiet. */
export function shieldAi(sim: CombatSim, s: CombatShip): void {
  if (!s.shield) return;
  if (s.overload > 0 || s.venting) {
    s.shieldOn = false;
    return;
  }
  const since = sim.time - s.ai.lastThreat;
  if (since < 0.45) {
    // Too hot to keep blocking and the armour is healthy: take it on the plates instead of overloading.
    s.shieldOn = !(s.fluxFrac > 0.93 && s.armor.fraction > 0.5 && s.hpFrac > 0.6) || !!s.mods.shieldFlux;
  } else if (since > 1.1) s.shieldOn = false;
  if (s.shield.type === 'omni') {
    _q.copy(s.quat).invert();
    const dir = since < 1 ? s.ai.threatDir : s.target ? _a.copy(s.target.pos).sub(s.pos).normalize() : null;
    if (dir) s.shieldTarget = bearingOf(_a.copy(dir).applyQuaternion(_q));
  }
}

const aimBuf = new WeakMap<WeaponState, THREE.Vector3>();
const shot = { point: new THREE.Vector3(), fire: false };

/** Fire control for an AI weapon (or a player group on autofire). */
export function wantsToFire(sim: CombatSim, s: CombatShip, w: WeaponState): { point: THREE.Vector3; fire: boolean } | null {
  let buf = aimBuf.get(w);
  if (!buf) aimBuf.set(w, (buf = new THREE.Vector3()));
  const muzzle = sim.muzzle(w, _a);
  // Point defence: the most dangerous enemy missile in reach.
  if (w.def.pd) {
    let best = null;
    let bestScore = Infinity;
    for (const m of sim.missiles) {
      if (!m.active || m.side === s.side) continue;
      const d = m.pos.distanceTo(muzzle);
      if (d > w.range) continue;
      const score = d * (m.target === s ? 0.5 : 1) / (m.def.model === 'torpedo' ? 2 : 1);
      if (score < bestScore && inArc(s, w, m.pos)) {
        bestScore = score;
        best = m;
      }
    }
    if (best) {
      sim.leadPoint(w, best, buf);
      shot.point = buf;
      shot.fire = true;
      return shot;
    }
  }
  // Ships: the assigned target if it's in reach, else the nearest in arc.
  let target: CombatShip | null = null;
  const reach = (e: CombatShip) => e.pos.distanceTo(muzzle) - e.dims.bound * 0.6 <= w.range;
  if (s.target?.alive && !s.target.retreated && reach(s.target) && inArc(s, w, s.target.pos)) target = s.target;
  else {
    let bestD = Infinity;
    for (const e of sim.enemiesOf(s)) {
      const d = e.pos.distanceTo(muzzle);
      if (d < bestD && reach(e) && inArc(s, w, e.pos)) {
        bestD = d;
        target = e;
      }
    }
  }
  if (!target) {
    // Nothing in reach: track the main target so turrets are ready.
    if (s.target?.alive) {
      shot.point = sim.leadPoint(w, s.target, buf);
      shot.fire = false;
      return shot;
    }
    return null;
  }
  shot.point = sim.leadPoint(w, target, buf);
  shot.fire = fireDiscipline(sim, s, w, target);
  return shot;
}

function inArc(s: CombatShip, w: WeaponState, p: THREE.Vector3): boolean {
  if (w.halfArc >= Math.PI) return true;
  _q.copy(s.quat).invert();
  const b = bearingOf(_b.copy(p).sub(s.pos).applyQuaternion(_q));
  return Math.abs(wrapAngle(b - w.facing)) <= w.halfArc + 0.05;
}

/** When to hold fire: flux discipline, HE into shields, saving missiles for openings. */
function fireDiscipline(sim: CombatSim, s: CombatShip, w: WeaponState, t: CombatShip): boolean {
  const def = w.def;
  const vulnerable = t.overload > 0 || t.venting || !t.shieldUp;
  if (def.type === 'missile') {
    const d = t.pos.distanceTo(s.pos);
    if (def.model === 'torpedo') return vulnerable || t.fluxFrac > 0.8 || (t.sizeIndex >= 2 && d < w.range * 0.5);
    if (def.guided) return vulnerable || t.fluxFrac > 0.6 || t.hpFrac < 0.4 || w.ammo > w.maxAmmo * 0.6;
    return d < w.range * 0.8;
  }
  if (def.flux > 0 && s.fluxFrac > 0.88 && !vulnerable) return false;
  // High explosive splashes uselessly on a raised shield once we're getting hot.
  if (def.damageType === 'he' && t.shieldUp && s.fluxFrac > 0.45 && sim.inShieldArc(t, s.pos)) return false;
  // Frag does nothing to shields.
  if (def.damageType === 'frag' && t.shieldUp && sim.inShieldArc(t, s.pos) && !def.pd) return false;
  return true;
}

// ---------------------------------------------------------------- commander

const initialStrength = new WeakMap<CombatSim, [number, number]>();

function strength(ships: CombatShip[]): number {
  return ships.reduce((a, s) => a + s.points * (0.35 + 0.65 * s.hpFrac), 0);
}

/** Fleet-level decisions for one side: target assignment and retreat. */
export function commanderThink(sim: CombatSim, side: Side): void {
  const mine = sim.active(side);
  const theirs = sim.active(side === 0 ? 1 : 0);
  if (!mine.length || !theirs.length) return;
  let init = initialStrength.get(sim);
  if (!init) initialStrength.set(sim, (init = [strength(sim.active(0)), strength(sim.active(1))]));
  const mineNow = strength(mine);
  const theirsNow = strength(theirs);
  // AI fleets break and run when the fight is clearly lost.
  if (side === 1 && sim.stance[1] === 'engage' && mineNow < init[1] * 0.4 && mineNow < theirsNow * 0.45) {
    sim.stance[1] = 'retreat';
    sim.emit({ t: 'retreated', ship: mine[0] });
  }
  if (side === 1)
    for (const s of mine) if (s.hpFrac < 0.22 && mine.length > 1 && !s.order && s.sizeIndex >= 1) s.order = { kind: 'retreat' };

  // Focus fire: score targets by value, weakness and distance; spread a little.
  const player = sim.player;
  const assigned = new Map<CombatShip, number>();
  for (const s of mine) {
    if (s.controlled || (s.order && s.order.kind !== 'escort')) continue;
    let best: CombatShip | null = null;
    let bestScore = -Infinity;
    for (const e of theirs) {
      const d = e.pos.distanceTo(s.pos);
      let score = (e.points * (1.6 - e.hpFrac)) / (d + 1200);
      if (e.overload > 0 || e.venting) score *= 2;
      if (e.fluxFrac > 0.7) score *= 1.3;
      if (player && side === player.side && player.target === e) score *= 1.6;
      const n = assigned.get(e) ?? 0;
      score *= n < 2 ? 1 + n * 0.25 : 1 / (n - 0.5);
      // Small ships hunt small ships; big guns go for big hulls.
      score *= 1 - Math.abs(s.sizeIndex - e.sizeIndex) * 0.08;
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    if (best) {
      s.target = best;
      assigned.set(best, (assigned.get(best) ?? 0) + 1);
    }
  }
}
