import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { HULLMODS, HULLS, WEAPONS, hull, validateContent, weapon } from '../src/ships/defs';
import {
  MAX_VENTS,
  autofit,
  computeStats,
  defaultLoadout,
  emptyLoadout,
  hullmodIncompatibility,
  opUsed,
  slotIncompatibility,
  validateLoadout,
} from '../src/ships/fitting';
import { createShip, fleetLogistics, shipName, shipyardStock, starterFleet } from '../src/ships/fleet';

describe('content', () => {
  it('has the planned amount of content and no structural errors', () => {
    expect(HULLS.length).toBe(12);
    expect(WEAPONS.length).toBe(20);
    expect(HULLMODS.length).toBe(15);
    for (const size of ['frigate', 'destroyer', 'cruiser', 'capital']) expect(HULLS.filter((h) => h.size === size).length).toBe(3);
    expect(validateContent()).toEqual([]);
  });

  it('every stock loadout is legal', () => {
    for (const h of HULLS) expect(validateLoadout(defaultLoadout(h.id)), h.id).toEqual([]);
  });

  it('every hull has at least one weapon in its stock loadout and sane stats', () => {
    for (const h of HULLS) {
      const s = computeStats(defaultLoadout(h.id));
      expect(s.dps.total, h.id).toBeGreaterThan(0);
      expect(s.opUsed).toBeLessThanOrEqual(s.opMax);
      expect(s.maxSpeed).toBeGreaterThan(0);
    }
  });

  it('bigger hulls are tougher and slower on average', () => {
    const avg = (size: string, f: (s: ReturnType<typeof computeStats>) => number) => {
      const list = HULLS.filter((h) => h.size === size).map((h) => f(computeStats(defaultLoadout(h.id))));
      return list.reduce((a, b) => a + b, 0) / list.length;
    };
    const sizes = ['frigate', 'destroyer', 'cruiser', 'capital'];
    for (let i = 1; i < sizes.length; i++) {
      expect(avg(sizes[i], (s) => s.hitpoints)).toBeGreaterThan(avg(sizes[i - 1], (s) => s.hitpoints));
      expect(avg(sizes[i], (s) => s.maxSpeed)).toBeLessThan(avg(sizes[i - 1], (s) => s.maxSpeed));
    }
  });
});

describe('fitting rules', () => {
  const kestrel = hull('kestrel');
  const slot = (id: string) => kestrel.slots.find((s) => s.id === id)!;

  it('enforces slot type and size', () => {
    expect(slotIncompatibility(slot('WS01'), weapon('light_autocannon'))).toBeNull();
    expect(slotIncompatibility(slot('WS01'), weapon('pulse_laser'))).toMatch(/ballistic/);
    expect(slotIncompatibility(slot('WS01'), weapon('heavy_autocannon'))).toMatch(/Too large/);
    // Universal medium takes a small weapon of any type, but not a large one.
    expect(slotIncompatibility(slot('WS03'), weapon('swarm_rockets'))).toBeNull();
    expect(slotIncompatibility(slot('WS03'), weapon('plasma_cannon'))).toMatch(/Too large/);
  });

  it('a large slot does not take small weapons', () => {
    const bastion = hull('bastion');
    expect(slotIncompatibility(bastion.slots.find((s) => s.size === 'L')!, weapon('light_autocannon'))).toMatch(/Too small/);
  });

  it('counts OP for weapons, hullmods, vents and capacitors', () => {
    const l = emptyLoadout('kestrel');
    l.weapons.WS03 = 'heavy_blaster';
    l.hullmods = ['augmented_engines'];
    l.vents = 3;
    l.capacitors = 2;
    expect(opUsed(l)).toBe(14 + 5 + 3 + 2);
  });

  it('rejects over-budget and out-of-range vents', () => {
    const l = emptyLoadout('kestrel');
    l.vents = MAX_VENTS.frigate + 1;
    expect(validateLoadout(l).join()).toMatch(/Vents/);
    const fat = defaultLoadout('kestrel');
    fat.capacitors = 10;
    fat.vents = 10;
    expect(validateLoadout(fat).join()).toMatch(/Over budget/);
  });

  it('applies hullmod requirements and incompatibilities', () => {
    expect(hullmodIncompatibility(HULLMODS.find((m) => m.id === 'safety_overrides')!, hull('dominion'), [])).toMatch(/capital/);
    expect(hullmodIncompatibility(HULLMODS.find((m) => m.id === 'front_shield_emitter')!, hull('wisp'), [])).toMatch(/omni/);
    expect(hullmodIncompatibility(HULLMODS.find((m) => m.id === 'missile_racks')!, hull('wisp'), [])).toMatch(/missile/);
    expect(hullmodIncompatibility(HULLMODS.find((m) => m.id === 'integrated_targeting')!, hull('kestrel'), ['safety_overrides'])).toMatch(/Incompatible/);
    expect(hullmodIncompatibility(HULLMODS.find((m) => m.id === 'heavy_armor')!, hull('bastion'), [])).toBe('Built in');
  });
});

describe('stats', () => {
  it('vents, capacitors and hullmods change the right numbers', () => {
    const base = computeStats(emptyLoadout('kestrel'));
    const l = emptyLoadout('kestrel');
    l.vents = 5;
    l.capacitors = 4;
    l.hullmods = ['heavy_armor', 'augmented_engines'];
    const s = computeStats(l);
    expect(s.fluxDissipation).toBe(base.fluxDissipation + 50);
    expect(s.fluxCapacity).toBe(base.fluxCapacity + 800);
    expect(s.armor).toBe(base.armor + 150);
    expect(s.maxSpeed).toBe(Math.round(base.maxSpeed * 0.95 * 1.15));
  });

  it('dps and flux balance follow the weapons', () => {
    const l = emptyLoadout('kestrel');
    l.weapons.WS01 = 'light_autocannon';
    l.weapons.WS03 = 'phase_lance';
    const s = computeStats(l);
    expect(s.dps.kinetic).toBeCloseTo(50 * 4);
    expect(s.dps.energy).toBeCloseTo(300);
    expect(s.weaponFlux).toBeCloseTo(40 * 4 + 330);
    expect(s.fluxBalance).toBeCloseTo(s.fluxDissipation - s.weaponFlux);
  });

  it('front shield emitter converts the shield', () => {
    const l = emptyLoadout('kestrel');
    l.hullmods = ['front_shield_emitter'];
    const s = computeStats(l);
    expect(s.shield?.type).toBe('front');
    expect(s.shield!.arc).toBe(240);
  });
});

describe('autofit', () => {
  it('produces a legal, armed loadout for every hull', () => {
    for (const h of HULLS) {
      const l = autofit(h.id);
      expect(validateLoadout(l), h.id).toEqual([]);
      expect(computeStats(l).dps.total).toBeGreaterThan(0);
      expect(Object.values(l.weapons).filter(Boolean).length).toBeGreaterThanOrEqual(Math.ceil(h.slots.length * 0.6));
    }
  });
});

describe('fleet', () => {
  it('starter fleet matches the Phase 2 logistics', () => {
    const lg = fleetLogistics(starterFleet());
    expect(lg.fuelCapacity).toBe(40);
    expect(lg.suppliesCapacity).toBe(80);
    expect(lg.jumpRange).toBe(12);
    expect(lg.fuelMultiplier).toBeCloseTo(1);
    expect(lg.suppliesPerJump).toBe(2);
  });

  it('bigger fleets carry more but jump as far as their slowest drive', () => {
    const f = starterFleet();
    f.ships.push(createShip('dominion', 'HNS Test'));
    const lg = fleetLogistics(f);
    expect(lg.fuelCapacity).toBeGreaterThan(400);
    expect(lg.jumpRange).toBe(10);
    expect(lg.fuelMultiplier).toBeCloseTo(10);
  });

  it('names and shipyard stock are deterministic and sensible', () => {
    expect(shipName('vanguard', new Rng(1))).toBe(shipName('vanguard', new Rng(1)));
    expect(shipName('vanguard', new Rng(1))).toMatch(/^HNS /);
    const stock = shipyardStock(1234, 'frontier');
    expect(stock).toEqual(shipyardStock(1234, 'frontier'));
    expect(stock).toContain('kestrel');
    expect(stock.length).toBeGreaterThanOrEqual(4);
  });
});
