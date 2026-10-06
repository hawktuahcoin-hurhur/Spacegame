import { describe, expect, it } from 'vitest';
import { SAVE_VERSION, SaveError, type SaveData, parseSave, playerFromSave } from '../src/save/saveGame';
import { newPlayer, scoopRate } from '../src/player';
import { createShip } from '../src/ships/fleet';

const escort = createShip('harrier', 'FSV Test', 'ship-b');
const flag = createShip('kestrel', 'FSV Wanderer', 'ship-a');

const sample: SaveData = {
  version: SAVE_VERSION,
  savedAt: 123,
  label: 'Test · Day 3',
  galaxySeed: 1337,
  systemIndex: 42,
  time: 259200.5,
  ship: { frameId: 'planet-2', local: [1.5e7, -3, 4.25], velocity: [0, 10, 0], quaternion: [0, 0, 0, 1], throttle: 0.5 },
  player: {
    fuel: 12.5,
    supplies: 40,
    visited: [42, 7],
    jumps: 3,
    distanceLy: 25.2,
    credits: 123456,
    cargo: { food: 120, drugs: 4 },
    reputation: { hegemony: -12, tricorp: 0, league: 30, ascendant: -5, independent: 10, pirates: -50 },
    commission: 'league',
    stipendDay: 14,
    missions: [],
    takenMissions: ['m1-0-0'],
    contacts: {},
    intel: { 42: { day: 3, buy: [1, 2], sell: [3, 4] } },
    codex: { 'x:flora:1': { id: 'x:flora:1', kind: 'flora', name: 'Velaris arbor', planet: 'P', system: 'S', value: 500, day: 2, sold: false, note: 'n' } },
    harvested: ['1:2:3'],
    looted: ['4:5:crate0'],
  },
  fleet: { flagshipId: 'ship-a', ships: [flag, escort] },
  campaign: null,
  route: [42, 50, 60],
  target: { kind: 'system', index: 50 },
};

describe('parseSave', () => {
  it('round-trips through JSON losslessly', () => {
    expect(parseSave(JSON.parse(JSON.stringify(sample)))).toEqual(sample);
  });

  it('rejects malformed saves', () => {
    expect(() => parseSave(null)).toThrow(SaveError);
    expect(() => parseSave({ ...sample, galaxySeed: 'x' })).toThrow(SaveError);
    expect(() => parseSave({ ...sample, ship: { ...sample.ship, local: [1, 2] } })).toThrow(SaveError);
    expect(() => parseSave({ ...sample, player: { ...sample.player, fuel: NaN } })).toThrow(SaveError);
    expect(() => parseSave({ ...sample, version: SAVE_VERSION + 1 })).toThrow(SaveError);
  });

  it('drops an invalid target and route rather than failing', () => {
    const s = parseSave({ ...sample, target: { kind: 'bogus' }, route: ['a'] });
    expect(s.target).toBeNull();
    expect(s.route).toEqual([]);
  });

  it('restores player state, clamped to the fleet capacity', () => {
    const p = playerFromSave(newPlayer(), { ...sample, player: { ...sample.player, fuel: 9999 } });
    expect(p.fuelCapacity).toBe(40 + 90);
    expect(p.fuel).toBe(p.fuelCapacity);
    expect(p.credits).toBe(123456);
    expect(p.fleet.ships.map((s) => s.loadout.hullId)).toEqual(['kestrel', 'harrier']);
    expect([...p.visited]).toEqual([42, 7]);
  });

  it('migrates v1 saves (no fleet) to a starter fleet with starting credits', () => {
    const { fleet: _f, ...v1 } = sample;
    void _f;
    const s = parseSave({ ...v1, version: 1, player: { fuel: 10, supplies: 5, visited: [1], jumps: 0, distanceLy: 0 } });
    expect(s.version).toBe(SAVE_VERSION);
    expect(s.fleet.ships).toHaveLength(1);
    expect(s.fleet.ships[0].loadout.hullId).toBe('kestrel');
    expect(s.player.credits).toBeGreaterThan(0);
  });

  it('migrates v2 saves to a fresh campaign with default reputation', () => {
    const { campaign: _c, ...v2 } = sample;
    void _c;
    const s = parseSave({ ...v2, version: 2, player: { fuel: 10, supplies: 5, visited: [1], jumps: 0, distanceLy: 0, credits: 5 } });
    expect(s.campaign).toBeNull();
    expect(s.player.cargo).toEqual({});
    expect(s.player.reputation.pirates).toBeLessThan(0);
    expect(s.player.commission).toBeNull();
  });

  it('migrates v3 saves with an empty codex', () => {
    const s = parseSave({ ...sample, version: 3, player: { ...sample.player, codex: undefined, harvested: undefined, looted: undefined } });
    expect(s.player.codex).toEqual({});
    expect(s.player.harvested).toEqual([]);
  });

  it('drops unknown commodities and factions', () => {
    const s = parseSave({ ...sample, player: { ...sample.player, cargo: { food: 3, unobtainium: 9 }, reputation: { league: 5, martians: 50 }, commission: 'martians' } });
    expect(s.player.cargo).toEqual({ food: 3 });
    expect(s.player.reputation.martians).toBeUndefined();
    expect(s.player.commission).toBeNull();
  });

  it('drops content that no longer exists instead of failing', () => {
    const broken = JSON.parse(JSON.stringify(sample));
    broken.fleet.ships[0].loadout.weapons.WS01 = 'deleted_weapon';
    broken.fleet.ships[0].loadout.hullmods = ['augmented_engines', 'deleted_mod'];
    broken.fleet.ships[1].loadout.hullId = 'deleted_hull';
    const s = parseSave(broken);
    expect(s.fleet.ships).toHaveLength(1);
    expect(s.fleet.ships[0].loadout.weapons.WS01).toBeNull();
    expect(s.fleet.ships[0].loadout.hullmods).toEqual(['augmented_engines']);
  });
});

describe('scoopRate', () => {
  it('is zero outside the corona and grows toward the surface', () => {
    expect(scoopRate(1e9, 5e5)).toBe(0);
    expect(scoopRate(5e5, 5e5)).toBeGreaterThan(scoopRate(9e5, 5e5));
    expect(scoopRate(0, 5e5)).toBeCloseTo(3.5);
  });
});
