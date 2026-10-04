import { type SaveData, parseSave } from './saveGame';

export type SlotId = 'auto' | 'quick' | 'slot1' | 'slot2' | 'slot3';
export const SLOTS: SlotId[] = ['auto', 'quick', 'slot1', 'slot2', 'slot3'];
export const SLOT_LABEL: Record<SlotId, string> = {
  auto: 'Autosave',
  quick: 'Quicksave',
  slot1: 'Slot 1',
  slot2: 'Slot 2',
  slot3: 'Slot 3',
};

const DB_NAME = 'spacegame';
const STORE = 'saves';
const LS_PREFIX = 'spacegame:save:';

/**
 * Save slots in IndexedDB, falling back to localStorage when IndexedDB is
 * unavailable (some private-browsing modes).
 */
export class SaveStorage {
  private db: Promise<IDBDatabase | null>;

  constructor() {
    this.db = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db;
    if (!db) throw new Error('IndexedDB unavailable');
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async write(slot: SlotId, data: SaveData): Promise<void> {
    try {
      await this.tx('readwrite', (s) => s.put(data, slot));
    } catch {
      localStorage.setItem(LS_PREFIX + slot, JSON.stringify(data));
    }
  }

  async read(slot: SlotId): Promise<SaveData | null> {
    let raw: unknown;
    try {
      raw = await this.tx('readonly', (s) => s.get(slot));
    } catch {
      const txt = localStorage.getItem(LS_PREFIX + slot);
      raw = txt ? JSON.parse(txt) : undefined;
    }
    if (!raw) return null;
    try {
      return parseSave(raw);
    } catch (e) {
      console.warn(`Ignoring corrupt save in ${slot}:`, e);
      return null;
    }
  }

  async remove(slot: SlotId): Promise<void> {
    try {
      await this.tx('readwrite', (s) => s.delete(slot));
    } catch {
      localStorage.removeItem(LS_PREFIX + slot);
    }
  }

  async list(): Promise<{ slot: SlotId; data: SaveData | null }[]> {
    return Promise.all(SLOTS.map(async (slot) => ({ slot, data: await this.read(slot) })));
  }

  /** Most recently written save of any slot. */
  async latest(): Promise<{ slot: SlotId; data: SaveData } | null> {
    const all = (await this.list()).filter((s): s is { slot: SlotId; data: SaveData } => !!s.data);
    all.sort((a, b) => b.data.savedAt - a.data.savedAt);
    return all[0] ?? null;
  }
}

/** Trigger a browser download of a save as JSON. */
export function exportSave(data: SaveData): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `spacegame-${data.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Ask the user for a JSON save file and parse it. */
export function importSave(): Promise<SaveData> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return reject(new Error('No file chosen'));
      try {
        resolve(parseSave(JSON.parse(await file.text())));
      } catch (e) {
        reject(e);
      }
    };
    input.click();
  });
}
