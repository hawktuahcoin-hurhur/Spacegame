import { describe, expect, it } from 'vitest';
import { generateGalaxy } from '../src/galaxy/galaxyGen';
import { generateSystem } from '../src/galaxy/systemGen';
import type { BodyDef } from '../src/galaxy/types';
import { codexValue, speciesName } from '../src/surface/codex';
import { speciesFor } from '../src/surface/fauna';
import { Noise2 } from '../src/surface/noise';
import { placePois } from '../src/surface/pois';
import { isLandable, surfaceProfile } from '../src/surface/profile';
import { floraModel, placeDeposits, placeFlora } from '../src/surface/props';
import { Terrain } from '../src/surface/terrain';

/** One landable body of each type from a real galaxy. */
function bodiesByType(): Map<string, BodyDef> {
  const g = generateGalaxy(1337);
  const out = new Map<string, BodyDef>();
  for (const s of g.stars.slice(0, 200)) for (const b of generateSystem(s.seed).bodies) if (!out.has(b.type)) out.set(b.type, b);
  return out;
}
const bodies = bodiesByType();

describe('noise', () => {
  it('is deterministic and bounded', () => {
    const a = new Noise2(5);
    const b = new Noise2(5);
    for (let i = 0; i < 200; i++) {
      const v = a.noise(i * 0.37, i * 0.11);
      expect(v).toBe(b.noise(i * 0.37, i * 0.11));
      expect(Math.abs(v)).toBeLessThanOrEqual(1.01);
      expect(a.ridged(i * 0.1, i * 0.2, 4)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('surface profiles', () => {
  it('covers every landable world type', () => {
    for (const t of ['terran', 'ocean', 'desert', 'ice', 'toxic', 'exotic', 'lava', 'barren']) expect(bodies.has(t), t).toBe(true);
    expect(isLandable(bodies.get('gasGiant')!)).toBe(false);
  });

  it('gives each world flora, resources and a hazard that fits', () => {
    for (const [type, b] of bodies) {
      if (!isLandable(b)) continue;
      const p = surfaceProfile(b);
      expect(p.flora.length, type).toBeGreaterThan(0);
      expect(p.resources.length, type).toBeGreaterThan(0);
      expect(p.gravity).toBeGreaterThan(0);
      if (type === 'lava') expect(p.hazard.kind).toBe('heat');
      if (type === 'toxic') expect(p.hazard.kind).toBe('toxic');
      if (type === 'barren' || type === 'lava') expect(speciesFor(p)).toEqual([]);
      if (type === 'terran') expect(speciesFor(p).length).toBeGreaterThan(0);
      for (const f of p.flora) {
        const m = floraModel(f, 1);
        expect(m.body.getAttribute('position').count).toBeGreaterThan(0);
        expect(m.height).toBeGreaterThan(0);
      }
    }
  });
});

describe('terrain', () => {
  const b = bodies.get('terran')!;
  const p = surfaceProfile(b);

  it('is deterministic per site and differs between sites', () => {
    const a = new Terrain(p, 1000, 2000);
    const a2 = new Terrain(p, 1000, 2000);
    const c = new Terrain(p, 9000, -4000);
    expect(a.height(12.5, -40)).toBe(a2.height(12.5, -40));
    expect(a.height(12.5, -40)).not.toBe(c.height(12.5, -40));
  });

  it('always lands you on dry ground', () => {
    for (const [, body] of bodies) {
      if (!isLandable(body)) continue;
      const prof = surfaceProfile(body);
      for (let k = 0; k < 6; k++) {
        const t = new Terrain(prof, k * 3777, -k * 5111);
        expect(t.wet(t.height(0, 0))).toBe(false);
      }
    }
  });

  it('builds chunk meshes with colours and upward faces', () => {
    const t = new Terrain(p, 0, 0);
    const geo = t.buildChunk(0, 0, 64, 16);
    const pos = geo.getAttribute('position');
    expect(pos.count).toBe((16 * 16 * 2 + 16 * 8) * 3);
    expect(geo.getAttribute('color').count).toBe(pos.count);
    const n = geo.getAttribute('normal');
    let up = 0;
    for (let i = 0; i < 16 * 16 * 2 * 3; i++) if (n.getY(i) > 0) up++;
    expect(up).toBe(16 * 16 * 2 * 3);
  });

  it('places flora on dry, gentle ground and deposits deterministically', () => {
    const t = new Terrain(p, 0, 0);
    const models = p.flora.map((f, i) => floraModel(f, i));
    const placed = [];
    for (let i = -5; i <= 5; i++) placed.push(...placeFlora(t, p, models, i, i * 2, 64, true));
    expect(placed.length).toBeGreaterThan(20);
    for (const f of placed) expect(t.wet(t.height(f.x, f.z))).toBe(false);
    expect(placeFlora(t, p, models, 2, 4, 64, true)).toEqual(placeFlora(t, p, models, 2, 4, 64, true));
    let deposits = 0;
    for (let i = 0; i < 20; i++) deposits += placeDeposits(t, p, i, -i, 64).length;
    expect(deposits).toBeGreaterThan(2);
  });

  it('always puts a point of interest near the landing site', () => {
    for (const [, body] of bodies) {
      if (!isLandable(body)) continue;
      const prof = surfaceProfile(body);
      const t = new Terrain(prof, 4242, 1717);
      const poi = placePois(t, prof, 0, 0);
      expect(poi).not.toBeNull();
      expect(Math.hypot(poi!.x, poi!.z)).toBeLessThan(320);
    }
  });
});

describe('codex', () => {
  it('names species stably and values rarer finds higher', () => {
    expect(speciesName(5, 1, 'fauna')).toBe(speciesName(5, 1, 'fauna'));
    expect(speciesName(5, 1, 'fauna')).not.toBe(speciesName(5, 2, 'fauna'));
    expect(codexValue('fauna', 1)).toBeGreaterThan(codexValue('fauna', 0));
    expect(codexValue('ruins', 0.5)).toBeGreaterThan(codexValue('flora', 0.5));
  });
});
