import { SimHost, type SimRequestType, type SimRequests } from './protocol';

/**
 * Promise-based RPC to the simulation worker. Falls back to running the same
 * handler on the main thread if workers are unavailable.
 */
export class SimClient {
  private worker: Worker | null = null;
  private fallback: SimHost | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor() {
    try {
      this.worker = new Worker(new URL('./simWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.error) p.reject(new Error(e.data.error));
        else p.resolve(e.data.result);
      };
      this.worker.onerror = () => this.useFallback();
    } catch {
      this.useFallback();
    }
  }

  private useFallback(): void {
    this.worker?.terminate();
    this.worker = null;
    this.fallback ??= new SimHost();
    // Re-run anything that was in flight is not possible; reject so callers retry.
    for (const p of this.pending.values()) p.reject(new Error('Simulation worker failed'));
    this.pending.clear();
  }

  call<K extends SimRequestType>(type: K, args: SimRequests[K]['args']): Promise<SimRequests[K]['result']> {
    if (!this.worker) {
      this.fallback ??= new SimHost();
      return Promise.resolve(this.fallback.handle(type, args));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker!.postMessage({ id, type, args });
    });
  }
}
