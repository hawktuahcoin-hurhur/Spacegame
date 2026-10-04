import { describe, expect, it } from 'vitest';
import { SAVE_VERSION, SaveError, type SaveData, parseSave, playerFromSave } from '../src/save/saveGame';
import { newPlayer, scoopRate } from '../src/player';

const sample: SaveData = {
  version: SAVE_VERSION,
  savedAt: 123,
  label: 'Test · Day 3',
  galaxySeed: 1337,
  systemIndex: 42,
  time: 259200.5,
  ship: { frameId: 'planet-2', local: [1.5e7, -3, 4.25], velocity: [0, 10, 0], quaternion: [0, 0, 0, 1], throttle: 0.5 },
  player: { fuel: 12.5, supplies: 40, visited: [42, 7], jumps: 3, distanceLy: 25.2 },
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

  it('restores player state, clamped to capacity', () => {
    const p = playerFromSave(newPlayer(), { ...sample, player: { ...sample.player, fuel: 9999 } });
    expect(p.fuel).toBe(p.fuelCapacity);
    expect([...p.visited]).toEqual([42, 7]);
  });
});

describe('scoopRate', () => {
  it('is zero outside the corona and grows toward the surface', () => {
    expect(scoopRate(1e9, 5e5)).toBe(0);
    expect(scoopRate(5e5, 5e5)).toBeGreaterThan(scoopRate(9e5, 5e5));
    expect(scoopRate(0, 5e5)).toBeCloseTo(3.5);
  });
});
