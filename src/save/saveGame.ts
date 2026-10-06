import type { CampaignSnapshot } from '../campaign/campaign';
import { hasCommodity, hasFaction } from '../campaign/defs';
import type { Mission } from '../campaign/missions';
import { type PlayerState, type PriceIntel, START_REPUTATION, refreshLogistics } from '../player';
import { type Loadout, hasHull, hasHullmod, hasWeapon, hull } from '../ships/defs';
import { type Fleet, MAX_CR, STARTING_CREDITS, starterFleet } from '../ships/fleet';

export const SAVE_VERSION = 3;

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
    credits: number;
    cargo: Record<string, number>;
    reputation: Record<string, number>;
    commission: string | null;
    stipendDay: number;
    missions: Mission[];
    takenMissions: string[];
    contacts: PlayerState['contacts'];
    intel: Record<number, PriceIntel>;
  };
  fleet: Fleet;
  /** The galaxy's economy, factions, fleets and news (null: start fresh from the seed). */
  campaign: CampaignSnapshot | null;
  route: number[];
  target: SavedTarget;
}

export class SaveError extends Error {}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(isNum);

/** Upgrade older saves step by step. Add a case per version bump. */
function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  const v = raw.version;
  if (typeof v !== 'number' || v > SAVE_VERSION || v < 1) throw new SaveError(`Unsupported save version ${String(v)}`);
  let out = { ...raw };
  if ((out.version as number) === 1) {
    // v1 → v2: fleets and credits arrived with Phase 3. Everyone starts with the frigate they flew.
    out = { ...out, version: 2, fleet: starterFleet(), player: { ...(out.player as object), credits: STARTING_CREDITS } };
  }
  if ((out.version as number) === 2) {
    // v2 → v3: the economy and factions (Phases 5–6) start fresh from the galaxy seed.
    out = { ...out, version: 3, campaign: null };
  }
  return out;
}

/**
 * Keep a saved loadout usable even if content changed since it was written:
 * unknown weapons/mods are dropped rather than failing the whole load.
 */
function sanitizeLoadout(raw: unknown): Loadout | null {
  const l = raw as Partial<Loadout> | null;
  if (!l || typeof l.hullId !== 'string' || !hasHull(l.hullId)) return null;
  const h = hull(l.hullId);
  const weapons: Record<string, string | null> = {};
  for (const slot of h.slots) {
    const w = l.weapons?.[slot.id];
    weapons[slot.id] = typeof w === 'string' && hasWeapon(w) ? w : null;
  }
  const hullmods = Array.isArray(l.hullmods) ? l.hullmods.filter((m): m is string => typeof m === 'string' && hasHullmod(m)) : [];
  const n = (x: unknown) => (isNum(x) ? Math.max(0, Math.floor(x)) : 0);
  return { hullId: l.hullId, weapons, hullmods, vents: n(l.vents), capacitors: n(l.capacitors) };
}

function parseFleet(raw: unknown): Fleet {
  const f = raw as { ships?: unknown; flagshipId?: unknown } | null;
  const ships: Fleet['ships'] = [];
  if (f && Array.isArray(f.ships)) {
    for (const s of f.ships as { id?: unknown; name?: unknown; loadout?: unknown; hull?: unknown; cr?: unknown }[]) {
      const loadout = sanitizeLoadout(s?.loadout);
      if (!loadout || typeof s.id !== 'string') continue;
      const ship: Fleet['ships'][number] = { id: s.id, name: typeof s.name === 'string' ? s.name : 'Unnamed', loadout };
      // Battle damage and readiness (Phase 4); absent in older saves means pristine.
      if (typeof s.hull === 'number' && Number.isFinite(s.hull)) ship.hull = Math.min(1, Math.max(0.05, s.hull));
      if (typeof s.cr === 'number' && Number.isFinite(s.cr)) ship.cr = Math.min(MAX_CR, Math.max(0, s.cr));
      ships.push(ship);
    }
  }
  if (ships.length === 0) return starterFleet();
  const flagshipId = typeof f?.flagshipId === 'string' && ships.some((s) => s.id === f.flagshipId) ? f.flagshipId : ships[0].id;
  return { ships, flagshipId };
}

const MISSION_TYPES = new Set(['delivery', 'procure', 'bounty', 'smuggle', 'survey', 'strike']);

function parseMissions(raw: unknown): Mission[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((m): m is Mission => {
    const x = m as Partial<Mission> | null;
    return (
      !!x &&
      typeof x.id === 'string' &&
      MISSION_TYPES.has(x.type as string) &&
      isNum(x.dest) &&
      isNum(x.origin) &&
      isNum(x.reward) &&
      isNum(x.deadline) &&
      !!x.giver &&
      hasFaction(x.giver.faction) &&
      (x.commodity === undefined || hasCommodity(x.commodity))
    );
  });
}

function numberRecord(raw: unknown, keyOk: (k: string) => boolean): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) if (keyOk(k) && isNum(v)) out[k] = v;
  return out;
}

function parseCampaign(raw: unknown): CampaignSnapshot | null {
  const c = raw as Partial<CampaignSnapshot> | null;
  if (!c || !isNum(c.day) || !Array.isArray(c.owner) || !Array.isArray(c.markets) || !Array.isArray(c.fleets) || !Array.isArray(c.relations)) return null;
  return {
    day: c.day,
    rng: isNum(c.rng) ? c.rng : 1,
    owner: c.owner,
    relations: c.relations,
    wars: Array.isArray(c.wars) ? c.wars : [],
    fleets: c.fleets,
    events: Array.isArray(c.events) ? c.events : [],
    nextFleetId: isNum(c.nextFleetId) ? c.nextFleetId : 1,
    raided: Array.isArray(c.raided) ? c.raided : [],
    markets: c.markets,
  };
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
      credits: isNum(player.credits) ? player.credits : STARTING_CREDITS,
      cargo: numberRecord(player.cargo, hasCommodity),
      reputation: { ...START_REPUTATION, ...numberRecord(player.reputation, hasFaction) },
      commission: typeof player.commission === 'string' && hasFaction(player.commission) ? player.commission : null,
      stipendDay: isNum(player.stipendDay) ? player.stipendDay : 0,
      missions: parseMissions(player.missions),
      takenMissions: Array.isArray(player.takenMissions) ? player.takenMissions.filter((x): x is string => typeof x === 'string') : [],
      contacts: player.contacts && typeof player.contacts === 'object' ? player.contacts : {},
      intel: player.intel && typeof player.intel === 'object' ? player.intel : {},
    },
    fleet: parseFleet(raw.fleet),
    campaign: parseCampaign(raw.campaign),
    route,
    target,
  };
}

export function playerFromSave(base: PlayerState, s: SaveData): PlayerState {
  return refreshLogistics({
    ...base,
    credits: s.player.credits,
    fleet: { flagshipId: s.fleet.flagshipId, ships: s.fleet.ships.map((x) => ({ ...x, loadout: { ...x.loadout, weapons: { ...x.loadout.weapons }, hullmods: [...x.loadout.hullmods] } })) },
    fuel: s.player.fuel,
    supplies: s.player.supplies,
    visited: new Set(s.player.visited),
    jumps: s.player.jumps,
    distanceLy: s.player.distanceLy,
    cargo: { ...s.player.cargo },
    reputation: { ...s.player.reputation },
    commission: s.player.commission,
    stipendDay: s.player.stipendDay,
    missions: s.player.missions.map((m) => ({ ...m })),
    takenMissions: [...s.player.takenMissions],
    contacts: { ...s.player.contacts },
    intel: { ...s.player.intel },
  });
}
