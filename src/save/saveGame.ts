import type { PlayerState } from '../player';

export const SAVE_VERSION = 1;

export type SavedTarget = { kind: 'local'; id: string } | { kind: 'system'; index: number } | null;

/**
 * Everything needed to restore a session. Procedural content is never stored —
 * only seeds and what the player changed (SUPERPLAN §2.6).
 */
export interface SaveData {
  version: number;
  savedAt: number;
  /** Short human label, e.g. "Kretrocass Prime · Day 12". */
  label: string;
  galaxySeed: number;
  systemIndex: number;
  /** Global game clock (s). Orbits in every system derive from it. */
  time: number;
  ship: {
    frameId: string | null;
    local: [number, number, number];
    velocity: [number, number, number];
    quaternion: [number, number, number, number];
    throttle: number;
  };
  player: {
    fuel: number;
    supplies: number;
    visited: number[];
    jumps: number;
    distanceLy: number;
  };
  route: number[];
  target: SavedTarget;
}

export class SaveError extends Error {}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(isNum);

/** Upgrade older saves in place. Add a case per version bump. */
function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  const v = raw.version;
  if (v === SAVE_VERSION) return raw;
  if (typeof v !== 'number' || v > SAVE_VERSION) throw new SaveError(`Unsupported save version ${String(v)}`);
  // (no older versions yet)
  return raw;
}

/** Validate untrusted JSON (from storage or an imported file) into a SaveData. */
export function parseSave(input: unknown): SaveData {
  if (!input || typeof input !== 'object') throw new SaveError('Save is not an object');
  const raw = migrate(input as Record<string, unknown>);
  const ship = raw.ship as SaveData['ship'] | undefined;
  const player = raw.player as SaveData['player'] | undefined;
  if (!isNum(raw.galaxySeed) || !isNum(raw.systemIndex) || !isNum(raw.time)) throw new SaveError('Save is missing core fields');
  if (!ship || !isVec(ship.local, 3) || !isVec(ship.velocity, 3) || !isVec(ship.quaternion, 4) || !isNum(ship.throttle))
    throw new SaveError('Save ship state is invalid');
  if (ship.frameId !== null && typeof ship.frameId !== 'string') throw new SaveError('Save frame is invalid');
  if (!player || !isNum(player.fuel) || !isNum(player.supplies) || !Array.isArray(player.visited) || !player.visited.every(isNum))
    throw new SaveError('Save player state is invalid');
  const route = Array.isArray(raw.route) && raw.route.every(isNum) ? (raw.route as number[]) : [];
  let target: SavedTarget = null;
  const t = raw.target as SavedTarget;
  if (t && t.kind === 'local' && typeof t.id === 'string') target = { kind: 'local', id: t.id };
  if (t && t.kind === 'system' && isNum(t.index)) target = { kind: 'system', index: t.index };
  return {
    version: SAVE_VERSION,
    savedAt: isNum(raw.savedAt) ? raw.savedAt : Date.now(),
    label: typeof raw.label === 'string' ? raw.label : 'Unnamed save',
    galaxySeed: raw.galaxySeed,
    systemIndex: raw.systemIndex,
    time: raw.time,
    ship: {
      frameId: ship.frameId,
      local: [...ship.local],
      velocity: [...ship.velocity],
      quaternion: [...ship.quaternion],
      throttle: ship.throttle,
    },
    player: {
      fuel: player.fuel,
      supplies: player.supplies,
      visited: [...player.visited],
      jumps: isNum(player.jumps) ? player.jumps : 0,
      distanceLy: isNum(player.distanceLy) ? player.distanceLy : 0,
    },
    route,
    target,
  };
}

export function playerFromSave(base: PlayerState, s: SaveData): PlayerState {
  return {
    ...base,
    fuel: Math.min(s.player.fuel, base.fuelCapacity),
    supplies: Math.min(s.player.supplies, base.suppliesCapacity),
    visited: new Set(s.player.visited),
    jumps: s.player.jumps,
    distanceLy: s.player.distanceLy,
  };
}
