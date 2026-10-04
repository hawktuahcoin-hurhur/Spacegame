/// <reference lib="webworker" />
import { SimHost } from './protocol';

const host = new SimHost();

self.onmessage = (e: MessageEvent<{ id: number; type: 'galaxy' | 'route'; args: never }>) => {
  const { id, type, args } = e.data;
  try {
    (self as DedicatedWorkerGlobalScope).postMessage({ id, result: host.handle(type, args) });
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({ id, error: String(err) });
  }
};
