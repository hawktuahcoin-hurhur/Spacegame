import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ARMOR_MULT, ArmorGrid, MIN_ARMOR_FACTOR, SHIELD_MULT, shieldFlux } from '../src/combat/damage';
import { DMODS, addDmods, applyReport, battleReport, deployFleets, fleetStrength, pirateFleet, systemDanger } from '../src/combat/encounters';
import { interceptTime, segmentEllipsoid, wrapAngle } from '../src/combat/geometry';
import { CombatShip, fleetPoints } from '../src/combat/ship';
import { CombatSim } from '../src/combat/sim';
import { SHIP_SYSTEMS } from '../src/combat/systems';
import { Rng } from '../src/core/rng';
import { HULLS } from '../src/ships/defs';
import { defaultLoadout, validateLoadout } from '../src/ships/fitting';
import { createShip } from '../src/ships/fleet';
import { parseSave } from '../src/save/saveGame';

const ship = (hullId: string, side: 0 | 1, id = `${hullId}-${side}`) => new CombatShip({ id, name: id, side, loadout: defaultLoadout(hullId) });

/** A sim with one ship per side, `gap` metres apart, facing each other. */
function duel(a: string, b: string, gap = 1500, seed = 1) {
  const sim = new CombatSim(seed);
  const s0 = sim.add(ship(a, 0));
  const s1 = sim.add(ship(b, 1));
  s0.setYaw(0);
  s1.pos.set(0, 0, -gap);
  s1.setYaw(Math.PI);
  return { sim, s0, s1 };
}

function demoBattle(seed: number) {
  const sim = new CombatSim(seed);
  const ships = ['vanguard', 'harrier', 'lumen', 'kestrel', 'wisp'].map((id, i) => createShip(id, `P${i}`, `p${i}`));
  const enemy = {
    name: 'test',
    faction: 'pirate' as const,
    ships: ['corsair', 'bastion', 'jackal', 'jackal', 'harrier'].map((id, i) => ({ id: `e${i}`, name: `E${i}`, loadout: defaultLoadout(id), hull: 1, cr: 0.7 })),
  };
  deployFleets(sim, { ships, flagshipId: ships[0].id }, enemy, { playerYaw: 0, enemyDir: new THREE.Vector3(0, 0, -1), distance: 3600 });
  // Nobody at the helm: let the AI fly the flagship too.
  sim.ships[0].controlled = false;
  return sim;
}

describe('damage model', () => {
  it('weights damage types against shields and armour', () => {
    expect(SHIELD_MULT.kinetic).toBeGreaterThan(SHIELD_MULT.he);
    expect(ARMOR_MULT.he).toBeGreaterThan(ARMOR_MULT.kinetic);
    expect(shieldFlux(100, 'kinetic', 0.8)).toBeCloseTo(160);
    expect(shieldFlux(100, 'he', 1)).toBeCloseTo(50);
  });

  it('armour absorbs hits until stripped, then lets damage through', () => {
    const g = new ArmorGrid(500, 12);
    const first = g.hit(0, 200, 'he');
    expect(first.hull).toBe(0);
    expect(first.armor).toBeGreaterThan(0);
    let hull = 0;
    for (let i = 0; i < 30; i++) hull += g.hit(0, 200, 'he').hull;
    expect(hull).toBeGreaterThan(0);
    // Only the hit cell and its neighbours are stripped.
    expect(g.cells[0]).toBe(0);
    expect(g.cells[6]).toBe(500);
    expect(g.fraction).toBeLessThan(1);
  });

  it('heavy armour shrugs off small kinetic hits but never below the minimum', () => {
    const g = new ArmorGrid(1600, 16);
    const r = g.hit(0, 50, 'kinetic');
    // 50 kinetic → 25 vs armour, reduced to the 15% floor.
    expect(r.armor).toBeCloseTo(25 * MIN_ARMOR_FACTOR, 5);
  });

  it('beams use their per-second strength for armour reduction', () => {
    const a = new ArmorGrid(800, 10);
    const b = new ArmorGrid(800, 10);
    const tiny = a.hit(0, 5, 'energy');
    const strong = b.hit(0, 5, 'energy', 300);
    expect(strong.armor).toBeGreaterThan(tiny.armor);
  });

  it('maps bearings onto the grid', () => {
    const g = new ArmorGrid(100, 8);
    expect(g.cellAt(0)).toBe(0);
    expect(g.cellAt(Math.PI)).toBe(4);
    expect(g.cellAt(-Math.PI / 4)).toBe(7);
  });
});

describe('geometry', () => {
  it('intersects segments with oriented ellipsoids', () => {
    const q = new THREE.Quaternion();
    const axes = new THREE.Vector3(5, 3, 20);
    const t = segmentEllipsoid(new THREE.Vector3(0, 0, -100), new THREE.Vector3(0, 0, 100), new THREE.Vector3(), q, axes);
    expect(t).toBeCloseTo(0.4, 5);
    // Misses beside a thin hull, hits once the hull is turned side-on.
    expect(segmentEllipsoid(new THREE.Vector3(-100, 0, 10), new THREE.Vector3(100, 0, 10), new THREE.Vector3(), q, new THREE.Vector3(5, 3, 8))).toBe(-1);
    // Turned side-on, the long axis lies along x: a shot down the x axis now travels its length.
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    expect(segmentEllipsoid(new THREE.Vector3(-100, 0, 3), new THREE.Vector3(100, 0, 3), new THREE.Vector3(), q, new THREE.Vector3(5, 3, 20))).toBeCloseTo((100 - 20 * Math.sqrt(1 - 9 / 25)) / 200, 4);
  });

  it('solves intercepts', () => {
    const t = interceptTime(new THREE.Vector3(1000, 0, 0), new THREE.Vector3(0, 0, 100), 1000)!;
    const hit = new THREE.Vector3(1000, 0, 100 * t);
    expect(hit.length()).toBeCloseTo(1000 * t, 3);
    expect(interceptTime(new THREE.Vector3(1000, 0, 0), new THREE.Vector3(500, 0, 0), 100)).toBeNull();
    expect(Math.abs(wrapAngle(Math.PI * 3))).toBeCloseTo(Math.PI);
    expect(wrapAngle(Math.PI * 2.5)).toBeCloseTo(Math.PI / 2);
  });
});

describe('ships in combat', () => {
  it('builds every hull with weapons, groups, armour and a system', () => {
    for (const h of HULLS) {
      const s = ship(h.id, 0);
      expect(s.weapons.length).toBeGreaterThan(0);
      expect(s.groups.length).toBeGreaterThan(0);
      expect(s.armor.count).toBeGreaterThanOrEqual(8);
      expect(SHIP_SYSTEMS[h.shipSystem], h.shipSystem).toBeDefined();
      expect(s.ai.range).toBeGreaterThan(200);
      expect(fleetPoints(s.loadout)).toBeGreaterThan(0);
    }
  });

  it('bigger hulls are worth more fleet points', () => {
    expect(fleetPoints(defaultLoadout('dominion'))).toBeGreaterThan(fleetPoints(defaultLoadout('vanguard')));
    expect(fleetPoints(defaultLoadout('vanguard'))).toBeGreaterThan(fleetPoints(defaultLoadout('harrier')));
    expect(fleetPoints(defaultLoadout('harrier'))).toBeGreaterThan(fleetPoints(defaultLoadout('jackal')));
  });

  it('shields turn hits into hard flux and overload at capacity', () => {
    const { sim, s1 } = duel('kestrel', 'jackal');
    s1.shieldOn = true;
    s1.shieldUnfold = 1;
    const at = s1.pos.clone().add(new THREE.Vector3(0, 0, 10));
    sim.damageShip(s1, at, 100, 'kinetic', null, { shield: true, beam: false, emp: false });
    expect(s1.hardFlux).toBeCloseTo(100 * 2 * s1.shield!.efficiency);
    expect(s1.hp).toBe(s1.maxHp);
    for (let i = 0; i < 40 && s1.overload <= 0; i++) sim.damageShip(s1, at, 100, 'kinetic', null, { shield: true, beam: false, emp: false });
    expect(s1.overload).toBeGreaterThan(0);
    expect(s1.shieldUp).toBe(false);
    expect(s1.canFire).toBe(false);
  });

  it('hard flux only dissipates with shields down; venting dumps it fast', () => {
    const { sim, s0 } = duel('kestrel', 'jackal', 20000);
    sim.addFlux(s0, 1000, true);
    s0.shieldOn = true;
    s0.shieldUnfold = 1;
    for (let i = 0; i < 60; i++) sim['updateFlux'](s0, 1 / 60);
    expect(s0.hardFlux).toBeCloseTo(1000);
    s0.shieldOn = false;
    s0.shieldUnfold = 0;
    for (let i = 0; i < 60; i++) sim['updateFlux'](s0, 1 / 60);
    expect(s0.flux).toBeLessThan(1000 - s0.dissipation * 0.9);
    const before = s0.flux;
    expect(sim.vent(s0)).toBe(true);
    for (let i = 0; i < 30; i++) sim['updateFlux'](s0, 1 / 60);
    expect(before - s0.flux).toBeGreaterThan(s0.dissipation * 0.5 * 1.5);
  });

  it('shield arcs only cover their facing', () => {
    const { sim, s0 } = duel('bastion', 'jackal');
    s0.shieldOn = true;
    s0.shieldUnfold = 1;
    expect(s0.shield!.type).toBe('front');
    expect(sim.inShieldArc(s0, new THREE.Vector3(0, 0, -50))).toBe(true);
    expect(sim.inShieldArc(s0, new THREE.Vector3(0, 0, 50))).toBe(false);
  });

  it('weapons fire, projectiles fly and hit the enemy', () => {
    const { sim, s1 } = duel('kestrel', 'jackal', 600, 3);
    // A sitting duck: no AI, no shields.
    s1.controlled = true;
    let shots = 0;
    let hits = 0;
    for (let i = 0; i < 60 * 6; i++) {
      sim.step(1 / 60);
      for (const e of sim.events) {
        if (e.t === 'shot') shots++;
        if (e.t === 'hit' && e.ship === s1) hits++;
      }
      sim.events.length = 0;
    }
    expect(shots).toBeGreaterThan(10);
    expect(hits).toBeGreaterThan(5);
    expect(s1.armor.fraction).toBeLessThan(1);
  });

  it('the player fires the selected group at the aim point and drives shields, vents and systems', () => {
    const { sim, s0, s1 } = duel('vanguard', 'jackal', 900, 2);
    s0.controlled = true;
    s1.controlled = true;
    s0.selectedGroup = 0;
    sim.input.aim = s1.pos.clone();
    sim.input.fire = true;
    sim.input.toggleShield = true;
    const fired = new Set<string>();
    for (let i = 0; i < 60 * 3; i++) {
      sim.step(1 / 60);
      for (const e of sim.events) if (e.t === 'shot' && e.weapon.ship === s0) fired.add(`${e.weapon.group}`);
      sim.events.length = 0;
    }
    expect(fired.has('0')).toBe(true);
    // Missiles stay quiet until selected or set to autofire.
    expect(fired.has('1')).toBe(false);
    expect(s0.shieldOn).toBe(true);
    expect(s1.armor.fraction + s1.fluxFrac).not.toBe(1);
    sim.input.vent = true;
    sim.step(1 / 60);
    expect(s0.venting || s0.flux < s0.fluxCap * 0.05).toBe(true);
    sim.input.system = true;
    sim.step(1 / 60);
    expect(s0.systemActive).toBeGreaterThan(0);
  });

  it('guided missiles home in, and point defence shoots them down', () => {
    const { sim, s0, s1 } = duel('jackal', 'wisp', 1200, 5);
    s0.controlled = true;
    s1.controlled = true; // the wisp just sits there
    const rack = s0.weapons.find((w) => w.def.id === 'harpoon_rack')!;
    s0.target = s1;
    rack.yaw = 0;
    sim['launchMissile'](rack, s0.pos.clone(), new THREE.Vector3(0.3, 0, -1).normalize());
    const m = sim.missiles[0];
    expect(m.target).toBe(s1);
    let minD = Infinity;
    for (let i = 0; i < 60 * 6 && m.active; i++) {
      sim['updateMissiles'](1 / 60);
      minD = Math.min(minD, m.pos.distanceTo(s1.pos));
    }
    expect(minD).toBeLessThan(40);

    // Now let the wisp's PD laser defend itself.
    const { sim: sim2, s0: a, s1: b } = duel('jackal', 'wisp', 1200, 6);
    a.controlled = true;
    b.controlled = false;
    a.target = b;
    const rack2 = a.weapons.find((w) => w.def.id === 'harpoon_rack')!;
    sim2['launchMissile'](rack2, a.pos.clone(), new THREE.Vector3(0, 0, -1));
    let pdKill = false;
    for (let i = 0; i < 60 * 8; i++) {
      sim2.step(1 / 60);
      if (sim2.events.some((e) => e.t === 'pd')) pdKill = true;
      sim2.events.length = 0;
    }
    expect(pdKill).toBe(true);
  });

  it('ship systems activate, cost flux and recharge', () => {
    const { sim, s0 } = duel('kestrel', 'jackal', 5000);
    expect(s0.system.name).toBe('Burn Drive');
    expect(sim.activateSystem(s0)).toBe(true);
    expect(s0.mods.speed).toBe(3);
    expect(s0.maxSpeed).toBeGreaterThan(s0.stats.maxSpeed * 2.5);
    expect(sim.activateSystem(s0)).toBe(false);
    for (let i = 0; i < 60 * 11; i++) sim['updateSystem'](s0, 1 / 60);
    expect(s0.systemActive).toBe(0);
    expect(s0.systemCharges).toBe(1);
  });

  it('destroyed ships become drifting wrecks and credit the killer', () => {
    const { sim, s0, s1 } = duel('kestrel', 'jackal');
    s1.vel.set(50, 0, 0);
    sim.damageShip(s1, s1.pos.clone(), 1e6, 'he', s0, { shield: false, beam: false, emp: false });
    expect(s1.alive).toBe(false);
    expect(s0.kills).toBe(1);
    const p = s1.pos.clone();
    sim.step(1);
    expect(s1.pos.distanceTo(p)).toBeGreaterThan(10);
    expect(sim.outcome).toBe('victory');
  });
});

describe('fleet battles', () => {
  it('a 5v5 resolves within a few minutes, deterministically', () => {
    const run = (seed: number) => {
      const sim = demoBattle(seed);
      let t = 0;
      while (!sim.outcome && t < 400) {
        sim.step(1 / 30);
        sim.events.length = 0;
        t += 1 / 30;
      }
      return { outcome: sim.outcome, t: Math.round(t), hp: sim.ships.map((s) => Math.round(s.hp)) };
    };
    const a = run(11);
    expect(a.outcome).not.toBeNull();
    expect(a.t).toBeLessThan(400);
    expect(run(11)).toEqual(a);
  });

  it('beaten AI fleets retreat off the field', () => {
    const sim = demoBattle(3);
    // Cripple most of the pirates.
    for (const s of sim.ships.filter((x) => x.side === 1).slice(0, 4)) s.hp = s.maxHp * 0.08;
    let retreated = false;
    for (let i = 0; i < 30 * 120 && !retreated; i++) {
      sim.step(1 / 30);
      retreated = sim.stance[1] === 'retreat' || sim.ships.some((s) => s.retreated);
      sim.events.length = 0;
    }
    expect(retreated).toBe(true);
  });

  it('obeys tactical orders', () => {
    const sim = demoBattle(4);
    const escort = sim.ships.find((s) => s.side === 0 && s.hull.id === 'harrier')!;
    const point = new THREE.Vector3(2500, 0, 2500);
    escort.order = { kind: 'move', point };
    for (let i = 0; i < 30 * 40; i++) {
      sim.step(1 / 30);
      sim.events.length = 0;
    }
    expect(escort.pos.distanceTo(point)).toBeLessThan(700);
  });
});

describe('encounters & aftermath', () => {
  it('scales danger by region', () => {
    expect(systemDanger('fringe', false)).toBeGreaterThan(systemDanger('frontier', false));
    expect(systemDanger('frontier', false)).toBeGreaterThan(systemDanger('core', false));
    expect(systemDanger('frontier', true)).toBeLessThan(systemDanger('frontier', false));
  });

  it('generates legal pirate fleets sized against the player', () => {
    const small = fleetStrength({ ships: [createShip('kestrel', 'a')], flagshipId: '' });
    const big = fleetStrength({ ships: ['vanguard', 'harrier', 'lumen', 'kestrel'].map((h) => createShip(h, h)), flagshipId: '' });
    let smallTotal = 0;
    let bigTotal = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const a = pirateFleet(seed, small, 0.5);
      const b = pirateFleet(seed, big, 0.9);
      for (const s of [...a.ships, ...b.ships]) expect(validateLoadout(s.loadout)).toEqual([]);
      expect(a.ships.length).toBeGreaterThan(0);
      smallTotal += a.ships.reduce((x, s) => x + fleetPoints(s.loadout), 0);
      bigTotal += b.ships.reduce((x, s) => x + fleetPoints(s.loadout), 0);
    }
    expect(bigTotal).toBeGreaterThan(smallTotal * 2);
    expect(pirateFleet(7, big, 0.9)).toEqual(pirateFleet(7, big, 0.9));
  });

  it('adds d-mods without duplicates', () => {
    const l = addDmods(defaultLoadout('kestrel'), 3, new Rng(1));
    const d = l.hullmods.filter((m) => DMODS.includes(m));
    expect(d.length).toBe(3);
    expect(new Set(d).size).toBe(3);
    expect(validateLoadout(l)).toEqual([]);
  });

  it('salvages, recovers and applies losses after a victory', () => {
    const sim = new CombatSim(9);
    const ships = [createShip('harrier', 'Flag'), createShip('kestrel', 'Wing')];
    const fleet = { ships, flagshipId: ships[0].id };
    const enemy = pirateFleet(3, 30, 0.6);
    deployFleets(sim, fleet, enemy, { playerYaw: 0, enemyDir: new THREE.Vector3(0, 0, -1), distance: 3000 });
    const wing = sim.ships.find((s) => s.name === 'Wing')!;
    sim.destroy(wing, null);
    sim.ships[0].hp = sim.ships[0].maxHp * 0.5;
    for (const s of sim.ships.filter((x) => x.side === 1)) sim.destroy(s, sim.ships[0]);
    sim.step(1 / 60);
    expect(sim.outcome).toBe('victory');
    const report = battleReport(sim, enemy.name, 'victory', 1);
    expect(report.salvage.credits).toBeGreaterThan(0);
    expect(report.recoverable.some((r) => r.own && r.name === 'Wing')).toBe(true);
    // Recover our frigate, leave the rest.
    const res = applyReport(fleet, report, new Set([wing.id]), 1);
    expect(res.fleet.ships.length).toBe(2);
    const flag = res.fleet.ships.find((s) => s.name === 'Flag')!;
    expect(flag.hull).toBeCloseTo(0.5, 1);
    expect(flag.cr).toBeLessThan(0.7);
    const recovered = res.fleet.ships.find((s) => s.name === 'Wing')!;
    expect(recovered.loadout.hullmods.some((m) => DMODS.includes(m))).toBe(true);
    expect(res.spent).toBeGreaterThan(0);
    // Not recovering loses the ship.
    expect(applyReport(fleet, report, new Set(), 1).fleet.ships.length).toBe(1);
  });

  it('saves keep hull damage and readiness, clamped', () => {
    const ships = [createShip('kestrel', 'A')];
    ships[0].hull = 0.42;
    ships[0].cr = 3;
    const raw = {
      version: 2,
      savedAt: 0,
      label: 'x',
      galaxySeed: 1,
      systemIndex: 0,
      time: 0,
      ship: { frameId: null, local: [0, 0, 0], velocity: [0, 0, 0], quaternion: [0, 0, 0, 1], throttle: 0 },
      player: { fuel: 1, supplies: 1, visited: [], jumps: 0, distanceLy: 0, credits: 5 },
      fleet: { flagshipId: ships[0].id, ships },
      route: [],
      target: null,
    };
    const save = parseSave(JSON.parse(JSON.stringify(raw)))!;
    expect(save.fleet.ships[0].hull).toBeCloseTo(0.42);
    expect(save.fleet.ships[0].cr).toBeCloseTo(0.7);
  });
});
