import { Rng } from '../core/rng';
import { type PlayerState, cargoFree } from '../player';
import type { Campaign } from './campaign';
import { COMMODITIES, FACTIONS, NC, PIRATES, ci, fi, standing } from './defs';
import { quote, unitPrice } from './economy';
import type { Mission } from './missions';

export type Legality = 'legal' | 'restricted' | 'illegal';

/** Whether a good can be traded openly at a star's market. */
export function legality(c: Campaign, star: number, commodity: string, commission: string | null): Legality {
  const f = FACTIONS[c.owner[star]];
  if (f.illegal.includes(commodity)) return 'illegal';
  if (f.restricted.includes(commodity)) return commission === f.id ? 'legal' : 'restricted';
  return 'legal';
}

export function rep(p: PlayerState, faction: string): number {
  return p.reputation[faction] ?? 0;
}

/** Shift reputation, clamped. Returns the new value. */
export function adjustRep(p: PlayerState, faction: string, delta: number): number {
  const v = Math.max(-100, Math.min(100, rep(p, faction) + delta));
  p.reputation[faction] = Math.round(v * 10) / 10;
  return p.reputation[faction];
}

/** Factions whose ships attack on sight. */
export function hostileTo(c: Campaign, p: PlayerState, faction: number): boolean {
  const id = FACTIONS[faction].id;
  if (faction === PIRATES) return rep(p, id) < 0;
  if (rep(p, id) <= -50) return true;
  return !!p.commission && c.atWar(fi(p.commission), faction);
}

/** Can the player dock at this star's station? */
export function dockingAllowed(c: Campaign, p: PlayerState, star: number): { ok: boolean; why?: string } {
  const f = FACTIONS[c.owner[star]];
  const r = rep(p, f.id);
  if (c.owner[star] === PIRATES) return r <= -70 ? { ok: false, why: 'The pirates here want you dead' } : { ok: true };
  if (hostileTo(c, p, c.owner[star])) return { ok: false, why: `${f.short} control denies docking — you are ${standing(r).label.toLowerCase()}${p.commission && c.atWar(fi(p.commission), c.owner[star]) ? ' (enemy officer)' : ''}` };
  return { ok: true };
}

/** Import tariff on purchases here for this player. */
export function tariffFor(c: Campaign, p: PlayerState, star: number): number {
  const f = FACTIONS[c.owner[star]];
  let t = f.tariff;
  const r = rep(p, f.id);
  if (p.commission === f.id) t *= 0.5;
  else if (r >= 25) t *= 0.7;
  else if (r <= -20) t *= 1.5;
  return t;
}

export interface TradeLine {
  commodity: number;
  legality: Legality;
  /** Black-market dealing (illegal or restricted goods). */
  black: boolean;
  buy: number;
  sell: number;
  stock: number;
}

/** Black-market premium: goods that can't be sold openly fetch more. */
const BLACK_SELL = 1.3;
const BLACK_BUY = 1.12;

/** Everything a market screen shows. */
export function marketLines(c: Campaign, p: PlayerState, star: number): TradeLine[] {
  const st = c.states[star];
  const t = tariffFor(c, p, star);
  const out: TradeLine[] = [];
  for (let k = 0; k < NC; k++) {
    const id = COMMODITIES[k].id;
    const leg = legality(c, star, id, p.commission);
    const black = leg !== 'legal';
    out.push({
      commodity: k,
      legality: leg,
      black,
      buy: Math.round(unitPrice(st, k, 'buy', black ? 0 : t) * (black ? BLACK_BUY : 1)),
      sell: Math.round(unitPrice(st, k, 'sell', 0) * (black ? BLACK_SELL : 1)),
      stock: Math.floor(st.stock[k]),
    });
  }
  return out;
}

export interface TradeResult {
  ok: boolean;
  /** Credits moved (positive = paid by player on buy, received on sell). */
  credits: number;
  message: string;
  /** Caught dealing on the black market. */
  busted?: boolean;
}

/** Maximum the player can buy right now (credits, stock, hold or tank space). */
export function maxBuy(c: Campaign, p: PlayerState, star: number, k: number): number {
  const st = c.states[star];
  const id = COMMODITIES[k].id;
  const room = id === 'fuel' ? Math.floor(p.fuelCapacity - p.fuel) : cargoFree(p);
  let n = Math.min(Math.floor(st.stock[k]), Math.floor(room));
  const line = marketLines(c, p, star)[k];
  const markup = line.black ? 0 : tariffFor(c, p, star);
  while (n > 0 && quote(st, k, n, 'buy', markup) * (line.black ? BLACK_BUY : 1) > p.credits) n = Math.floor(n * 0.9);
  return Math.max(0, n);
}

export function held(p: PlayerState, k: number): number {
  const id = COMMODITIES[k].id;
  if (id === 'fuel') return Math.floor(p.fuel);
  if (id === 'supplies') return Math.floor(p.supplies);
  return p.cargo[id] ?? 0;
}

/** Black-market dealing risks a fine, confiscation and reputation. */
function blackMarketRisk(c: Campaign, star: number, value: number, rng: Rng): boolean {
  const owner = c.owner[star];
  if (owner === PIRATES) return false;
  const chance = Math.min(0.35, 0.05 + value / 150_000) * (c.states[star].stability > 5 ? 1 : 0.6);
  return rng.next() < chance;
}

export function buy(c: Campaign, p: PlayerState, star: number, k: number, qty: number, rng: Rng): TradeResult {
  qty = Math.min(qty, maxBuy(c, p, star, k));
  if (qty <= 0) return { ok: false, credits: 0, message: 'Nothing you can buy — check credits, stock and hold space' };
  const st = c.states[star];
  const def = COMMODITIES[k];
  const black = legality(c, star, def.id, p.commission) !== 'legal';
  const cost = Math.round(quote(st, k, qty, 'buy', black ? 0 : tariffFor(c, p, star)) * (black ? BLACK_BUY : 1));
  if (cost > p.credits) return { ok: false, credits: 0, message: 'Not enough credits' };
  st.stock[k] -= qty;
  p.credits -= cost;
  if (def.id === 'fuel') p.fuel += qty;
  else if (def.id === 'supplies') p.supplies += qty;
  else p.cargo[def.id] = (p.cargo[def.id] ?? 0) + qty;
  if (black && blackMarketRisk(c, star, cost, rng)) {
    const f = FACTIONS[c.owner[star]];
    p.cargo[def.id] = Math.max(0, (p.cargo[def.id] ?? 0) - qty);
    adjustRep(p, f.id, -8);
    return { ok: true, credits: cost, busted: true, message: `${f.short} customs raided the deal: ${qty} ${def.name.toLowerCase()} confiscated, reputation lost` };
  }
  return { ok: true, credits: cost, message: `Bought ${qty} ${def.name.toLowerCase()} for ${cost.toLocaleString()} ¢${black ? ' on the black market' : ''}` };
}

export function sell(c: Campaign, p: PlayerState, star: number, k: number, qty: number, rng: Rng): TradeResult {
  qty = Math.min(qty, held(p, k));
  if (qty <= 0) return { ok: false, credits: 0, message: 'You have none to sell' };
  const st = c.states[star];
  const def = COMMODITIES[k];
  const black = legality(c, star, def.id, p.commission) !== 'legal';
  const revenue = Math.round(quote(st, k, qty, 'sell', 0) * (black ? BLACK_SELL : 1));
  st.stock[k] += qty;
  if (def.id === 'fuel') p.fuel -= qty;
  else if (def.id === 'supplies') p.supplies -= qty;
  else p.cargo[def.id] = (p.cargo[def.id] ?? 0) - qty;
  if (p.cargo[def.id] === 0) delete p.cargo[def.id];
  if (black && blackMarketRisk(c, star, revenue, rng)) {
    const f = FACTIONS[c.owner[star]];
    adjustRep(p, f.id, -8);
    const fine = Math.round(revenue * 0.25);
    p.credits -= fine;
    return { ok: true, credits: -fine, busted: true, message: `${f.short} customs seized the shipment and fined you ${fine.toLocaleString()} ¢` };
  }
  p.credits += revenue;
  return { ok: true, credits: revenue, message: `Sold ${qty} ${def.name.toLowerCase()} for ${revenue.toLocaleString()} ¢${black ? ' on the black market' : ''}` };
}

/** Remember today's prices at this market. */
export function recordIntel(c: Campaign, p: PlayerState, star: number): void {
  const lines = marketLines(c, p, star);
  p.intel[star] = { day: c.day, buy: lines.map((l) => l.buy), sell: lines.map((l) => l.sell) };
}

/** Goods aboard that a faction would confiscate: illegal, restricted without a commission, and smuggling cargo. */
export function contraband(p: PlayerState, factionIndex: number): { commodity: string; qty: number; mission?: Mission }[] {
  const f = FACTIONS[factionIndex];
  const banned = (id: string) => f.illegal.includes(id) || (f.restricted.includes(id) && p.commission !== f.id);
  const out: { commodity: string; qty: number; mission?: Mission }[] = [];
  for (const [id, qty] of Object.entries(p.cargo)) if (qty > 0 && banned(id)) out.push({ commodity: id, qty });
  for (const m of p.missions) if (m.type === 'smuggle' && m.commodity && banned(m.commodity)) out.push({ commodity: m.commodity, qty: m.qty ?? 0, mission: m });
  return out;
}

/** Value of goods (at galactic base prices). */
export function cargoValue(items: { commodity: string; qty: number }[]): number {
  return items.reduce((a, x) => a + COMMODITIES[ci(x.commodity)].price * x.qty, 0);
}

// ---------------------------------------------------------------- commissions

export function canCommission(c: Campaign, p: PlayerState, factionIndex: number): { ok: boolean; why?: string } {
  const f = FACTIONS[factionIndex];
  if (!f.playable) return { ok: false, why: `The ${f.short} don't commission privateers` };
  if (p.commission === f.id) return { ok: false, why: 'Already commissioned' };
  if (rep(p, f.id) < 15) return { ok: false, why: `Requires Favorable standing (15+); you have ${Math.round(rep(p, f.id))}` };
  void c;
  return { ok: true };
}

/** Sign on: friends get closer, their enemies at war become yours. */
export function takeCommission(c: Campaign, p: PlayerState, factionIndex: number): string[] {
  const notes: string[] = [];
  if (p.commission) notes.push(...resignCommission(p));
  const f = FACTIONS[factionIndex];
  p.commission = f.id;
  p.stipendDay = c.day;
  adjustRep(p, f.id, 10);
  for (const e of c.warsOf(factionIndex)) {
    if (e === PIRATES) continue;
    const id = FACTIONS[e].id;
    if (rep(p, id) > -55) p.reputation[id] = -55;
    notes.push(`The ${FACTIONS[e].short} now treat you as an enemy combatant`);
  }
  return notes;
}

export function resignCommission(p: PlayerState): string[] {
  if (!p.commission) return [];
  const f = p.commission;
  p.commission = null;
  adjustRep(p, f, -5);
  return [`You resigned your ${FACTIONS[fi(f)].short} commission`];
}

/** Weekly pay for commissioned officers, scaled by the faction's size. */
export function stipend(c: Campaign, factionIndex: number): number {
  return Math.round((4000 + c.territory(factionIndex) * 40) / 100) * 100;
}

/** Credits paid by your commissioning faction per enemy ship destroyed. */
export const KILL_BOUNTY = 2500;

// ---------------------------------------------------------------- missions

export interface MissionUpdate {
  completed: { mission: Mission; reward: number }[];
  failed: Mission[];
  notes: string[];
}

function finish(p: PlayerState, m: Mission, out: MissionUpdate): void {
  const key = `${m.giver.name}|${m.giver.faction}`;
  const contact = (p.contacts[key] ??= { ...m.giver, jobs: 0 });
  // Regular contacts pay a little better each time (up to +40%).
  const reward = Math.round(m.reward * (1 + Math.min(0.4, contact.jobs * 0.08)));
  contact.jobs++;
  p.credits += reward;
  adjustRep(p, m.giver.faction, m.rep);
  p.missions = p.missions.filter((x) => x !== m);
  out.completed.push({ mission: m, reward });
}

/** Docked at `star`: hand over deliveries and procurements. */
export function missionsOnDock(c: Campaign, p: PlayerState, star: number): MissionUpdate {
  const out: MissionUpdate = { completed: [], failed: [], notes: [] };
  for (const m of [...p.missions]) {
    if ((m.type === 'delivery' || m.type === 'smuggle') && m.dest === star) finish(p, m, out);
    else if (m.type === 'procure' && m.origin === star && m.commodity) {
      const have = p.cargo[m.commodity] ?? 0;
      if (have >= (m.qty ?? 0)) {
        p.cargo[m.commodity] = have - (m.qty ?? 0);
        if (!p.cargo[m.commodity]) delete p.cargo[m.commodity];
        finish(p, m, out);
      } else if (have > 0) out.notes.push(`${m.title}: you have ${have}/${m.qty}`);
    }
  }
  void c;
  return out;
}

/** Arrived in a system: surveys complete on arrival. Bounties and strikes are fought by the game. */
export function missionsOnArrive(p: PlayerState, star: number): MissionUpdate {
  const out: MissionUpdate = { completed: [], failed: [], notes: [] };
  for (const m of [...p.missions]) if (m.type === 'survey' && m.dest === star) finish(p, m, out);
  return out;
}

/** Combat won against a mission's target fleet. */
export function missionVictory(p: PlayerState, missionId: string): MissionUpdate {
  const out: MissionUpdate = { completed: [], failed: [], notes: [] };
  const m = p.missions.find((x) => x.id === missionId);
  if (m) finish(p, m, out);
  return out;
}

/** Daily: expire missions past their deadline. */
export function expireMissions(c: Campaign, p: PlayerState): MissionUpdate {
  const out: MissionUpdate = { completed: [], failed: [], notes: [] };
  for (const m of [...p.missions]) {
    if (c.day <= m.deadline) continue;
    p.missions = p.missions.filter((x) => x !== m);
    adjustRep(p, m.giver.faction, m.type === 'smuggle' ? -3 : -5);
    out.failed.push(m);
  }
  return out;
}

/** Take a job from the board. */
export function acceptMission(p: PlayerState, m: Mission): { ok: boolean; why?: string } {
  if (p.missions.length >= 8) return { ok: false, why: 'You already have eight jobs on the go' };
  if ((m.type === 'delivery' || m.type === 'smuggle') && (m.qty ?? 0) > cargoFree(p)) return { ok: false, why: `Needs ${m.qty} units of free hold space` };
  p.missions.push(m);
  p.takenMissions.push(m.id);
  if (p.takenMissions.length > 200) p.takenMissions.splice(0, 50);
  return { ok: true };
}

export function abandonMission(p: PlayerState, m: Mission): void {
  p.missions = p.missions.filter((x) => x !== m);
  adjustRep(p, m.giver.faction, -4);
}
