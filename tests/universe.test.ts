import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { generateSystem } from '../src/galaxy/systemGen';
import { Universe } from '../src/world/universe';

describe('Universe', () => {
  const u = new Universe(generateSystem(60));

  it('keeps moons and stations inside their parent sphere of influence over time', () => {
    for (const t of [0, 1000, 54321, 1e6]) {
      u.update(t);
      for (const a of u.anchors) {
        if (!a.parent) continue;
        expect(a.position.distanceTo(a.parent.position)).toBeLessThan(a.parent.soiRadius);
      }
    }
  });

  it('exposes a frame hierarchy rooted at the system', () => {
    const roots = u.childrenOf(null);
    expect(roots.length).toBeGreaterThan(0);
    expect(roots.every((r) => r.parent === null && r.kind === 'body')).toBe(true);
    for (const r of roots) for (const c of u.childrenOf(r)) expect(c.parent).toBe(r);
  });

  it('nearestSurface finds the closest body', () => {
    u.update(0);
    const p = u.bodies[0];
    const probe = p.position.clone().add(new THREE.Vector3(p.radius + 1000, 0, 0));
    const n = u.nearestSurface(probe);
    expect(n.anchor).toBe(p);
    expect(n.distance).toBeCloseTo(1000, 3);
  });
});
