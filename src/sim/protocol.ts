import type { GalaxyDef } from '../galaxy/galaxyGen';
import { generateGalaxy } from '../galaxy/galaxyGen';
import { JumpGraph, type Route } from '../galaxy/route';

/** Requests the simulation worker understands. Phase 5 adds the economy tick here. */
export interface SimRequests {
  galaxy: { args: { seed: number }; result: GalaxyDef };
  route: { args: { seed: number; from: number; to: number; range: number }; result: Route | null };
}

export type SimRequestType = keyof SimRequests;

/** Pure request handler, shared by the worker and the in-thread fallback. */
export class SimHost {
  private galaxies = new Map<number, GalaxyDef>();
  private graphs = new Map<string, JumpGraph>();

  private galaxy(seed: number): GalaxyDef {
    let g = this.galaxies.get(seed);
    if (!g) {
      g = generateGalaxy(seed);
      this.galaxies.set(seed, g);
    }
    return g;
  }

  handle<K extends SimRequestType>(type: K, args: SimRequests[K]['args']): SimRequests[K]['result'] {
    switch (type) {
      case 'galaxy':
        return this.galaxy((args as SimRequests['galaxy']['args']).seed) as SimRequests[K]['result'];
      case 'route': {
        const a = args as SimRequests['route']['args'];
        const key = `${a.seed}:${a.range}`;
        let graph = this.graphs.get(key);
        if (!graph) {
          graph = new JumpGraph(this.galaxy(a.seed), a.range);
          this.graphs.set(key, graph);
        }
        return graph.plot(a.from, a.to) as SimRequests[K]['result'];
      }
    }
    throw new Error(`Unknown sim request ${String(type)}`);
  }
}
