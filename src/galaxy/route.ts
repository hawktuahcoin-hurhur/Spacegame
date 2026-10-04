import { type GalaxyDef, type GalaxyStar, starDistance } from './galaxyGen';

/** Fuel (tonnes) for a single hyperjump. Nebulae are turbulent and cost more to enter. */
export function jumpFuelCost(distanceLy: number, intoNebula: boolean): number {
  return (1 + distanceLy * 0.6) * (intoNebula ? 1.4 : 1);
}

export interface RouteHop {
  from: number;
  to: number;
  distance: number;
  fuel: number;
}

export interface Route {
  stars: number[];
  hops: RouteHop[];
  totalDistance: number;
  totalFuel: number;
}

/** Neighbour lists for a jump range, built once per (galaxy, range). */
export class JumpGraph {
  readonly neighbours: { index: number; distance: number }[][];

  constructor(
    readonly galaxy: GalaxyDef,
    readonly range: number,
  ) {
    const stars = galaxy.stars;
    // Sort by x for a cheap sweep instead of O(n²).
    const order = [...stars].sort((a, b) => a.x - b.x);
    this.neighbours = stars.map(() => []);
    for (let i = 0; i < order.length; i++) {
      const a = order[i];
      for (let j = i + 1; j < order.length && order[j].x - a.x <= range; j++) {
        const b = order[j];
        const d = starDistance(a, b);
        if (d <= range) {
          this.neighbours[a.index].push({ index: b.index, distance: d });
          this.neighbours[b.index].push({ index: a.index, distance: d });
        }
      }
    }
  }

  /**
   * A* route that minimises the number of jumps, tie-broken by fuel.
   * Returns null if the destination is unreachable at this range.
   */
  plot(from: number, to: number): Route | null {
    const stars = this.galaxy.stars;
    if (from === to) return { stars: [from], hops: [], totalDistance: 0, totalFuel: 0 };
    const goal = stars[to];
    const JUMP = 1000;
    const h = (s: GalaxyStar) => Math.ceil(starDistance(s, goal) / this.range) * JUMP;
    const g = new Map<number, number>([[from, 0]]);
    const came = new Map<number, number>();
    const open = new MinHeap();
    open.push(from, h(stars[from]));
    const closed = new Set<number>();
    while (open.size) {
      const cur = open.pop()!;
      if (cur === to) break;
      if (closed.has(cur)) continue;
      closed.add(cur);
      for (const n of this.neighbours[cur]) {
        if (closed.has(n.index)) continue;
        const cost = g.get(cur)! + JUMP + jumpFuelCost(n.distance, stars[n.index].nebula >= 0);
        if (cost < (g.get(n.index) ?? Infinity)) {
          g.set(n.index, cost);
          came.set(n.index, cur);
          open.push(n.index, cost + h(stars[n.index]));
        }
      }
    }
    if (!came.has(to)) return null;
    const path = [to];
    while (path[0] !== from) path.unshift(came.get(path[0])!);
    const hops: RouteHop[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      const d = starDistance(stars[path[i]], stars[path[i + 1]]);
      hops.push({ from: path[i], to: path[i + 1], distance: d, fuel: jumpFuelCost(d, stars[path[i + 1]].nebula >= 0) });
    }
    return {
      stars: path,
      hops,
      totalDistance: hops.reduce((s, x) => s + x.distance, 0),
      totalFuel: hops.reduce((s, x) => s + x.fuel, 0),
    };
  }
}

class MinHeap {
  private readonly items: number[] = [];
  private readonly prio: number[] = [];
  get size(): number {
    return this.items.length;
  }
  push(item: number, p: number): void {
    this.items.push(item);
    this.prio.push(p);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prio[parent] <= this.prio[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }
  pop(): number | undefined {
    if (!this.items.length) return undefined;
    const top = this.items[0];
    const lastI = this.items.pop()!;
    const lastP = this.prio.pop()!;
    if (this.items.length) {
      this.items[0] = lastI;
      this.prio[0] = lastP;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.prio[l] < this.prio[m]) m = l;
        if (r < this.items.length && this.prio[r] < this.prio[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.prio[a], this.prio[b]] = [this.prio[b], this.prio[a]];
  }
}
