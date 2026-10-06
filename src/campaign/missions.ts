import { Rng } from '../core/rng';
import { generateName } from '../galaxy/names';
import type { Campaign } from './campaign';
import { COMMODITIES, FACTIONS, INDEPENDENT, PIRATES, ci } from './defs';
import { priceAt } from './economy';

export type MissionType = 'delivery' | 'procure' | 'bounty' | 'smuggle' | 'survey' | 'strike';

export interface Contact {
  name: string;
  title: string;
  faction: string;
}

/** A job from a station's bar (SUPERPLAN §3.8). */
export interface Mission {
  id: string;
  type: MissionType;
  title: string;
  text: string;
  giver: Contact;
  /** Where it was offered. */
  origin: number;
  /** Destination star (delivery target, bounty location, system to chart…). */
  dest: number;
  commodity?: string;
  qty?: number;
  reward: number;
  /** Reputation gained with the giver's faction on success. */
  rep: number;
  /** Last day it can be completed. */
  deadline: number;
  /** Bounty and strike targets: who to fight and how strong they are. */
  enemy?: { faction: string; strength: number; seed: number; name: string };
}

/** Missions on a station board stay up for this many days. */
export const BOARD_PERIOD = 4;

const TITLES: Record<string, string[]> = {
  hegemony: ['Commander', 'Prefect', 'Quartermaster', 'Intelligence Officer'],
  tricorp: ['Logistics Director', 'Account Manager', 'Security Liaison', 'Procurement Lead'],
  league: ['Guildmaster', 'Convoy Master', 'Trader', 'Port Factor'],
  ascendant: ['Deacon', 'Pathwarden', 'Elder', 'Seeker'],
  independent: ['Station Administrator', 'Freight Broker', 'Militia Captain', 'Prospector'],
  pirates: ['Fixer', 'Smuggler', 'Boss', 'Fence'],
};

function contactFor(rng: Rng, faction: string): Contact {
  return { name: `${generateName(rng, 1, 2)} ${generateName(rng, 2, 3)}`, title: rng.pick(TITLES[faction]), faction };
}

const round = (n: number, to = 100) => Math.round(n / to) * to;

export interface BoardContext {
  /** Player reputation with a faction id. */
  rep: (faction: string) => number;
  /** Faction id the player holds a commission with. */
  commission: string | null;
  visited: Set<number>;
  /** Player fleet strength (for sizing bounties). */
  strength: number;
  /** Cargo space the player could free for a delivery. */
  cargoSpace: number;
}

/**
 * The job board at a station: deterministic for the station and the
 * four-day period, so it doesn't reshuffle every time you dock.
 */
export function generateBoard(c: Campaign, star: number, period: number, ctx: BoardContext): Mission[] {
  const rng = new Rng(Rng.derive(c.galaxy.seed ^ 0x6a09e667, star * 1009 + period));
  const owner = c.owner[star];
  const fid = FACTIONS[owner].id;
  if (owner !== PIRATES && ctx.rep(fid) <= -20) return [];
  const out: Mission[] = [];
  const near = c.near[star].filter((s) => c.distance(star, s) > 5);
  const count = rng.int(3, 5);
  const day = c.day;
  const deadlineFor = (to: number) => day + Math.ceil(c.distance(star, to) / 9) * 2 + 6;
  const friendly = (to: number) => !c.atWar(owner, c.owner[to]) || owner === INDEPENDENT;
  for (let k = 0; k < count * 3 && out.length < count; k++) {
    const roll = rng.next();
    const id = `m${star}-${period}-${k}`;
    const giverFaction = owner === PIRATES ? 'pirates' : rng.next() < 0.15 ? 'independent' : fid;
    const giver = contactFor(rng, giverFaction);
    const wars = c.warsOf(owner).filter((e) => e !== PIRATES);
    if (roll < 0.28 && owner !== PIRATES) {
      // Delivery: cargo is provided and held separately; just get it there.
      const dests = near.filter((s) => friendly(s) && c.owner[s] !== PIRATES && c.distance(star, s) < 26);
      if (!dests.length) continue;
      const to = rng.pick(dests);
      const com = rng.pick(['food', 'machinery', 'domestic', 'metals', 'supplies', 'luxury']);
      const qty = Math.max(10, Math.min(ctx.cargoSpace, round(rng.range(30, 260), 10)));
      const dist = c.distance(star, to);
      out.push({
        id,
        type: 'delivery',
        title: `Deliver ${qty} ${COMMODITIES[ci(com)].name.toLowerCase()} to ${c.markets[to].name}`,
        text: `"I need ${qty} units of ${COMMODITIES[ci(com)].name.toLowerCase()} delivered to ${c.markets[to].name} in the ${c.galaxy.stars[to].name} system. We load it, you fly it. Don't be late."`,
        giver,
        origin: star,
        dest: to,
        commodity: com,
        qty,
        reward: round(2000 + dist * 420 + qty * COMMODITIES[ci(com)].price * 0.12),
        rep: 4,
        deadline: deadlineFor(to),
      });
    } else if (roll < 0.42) {
      // Procurement: they're short of something; find it and bring it here.
      const st = c.states[star];
      const shortages = ['food', 'water', 'machinery', 'domestic', 'supplies', 'metals', 'fuel', 'organics', 'luxury'].filter((x) => st.stock[ci(x)] < st.target[ci(x)] * 0.7);
      if (!shortages.length) continue;
      const com = rng.pick(shortages);
      const qty = round(Math.min(400, Math.max(20, st.target[ci(com)] * rng.range(0.15, 0.4))), 10);
      out.push({
        id,
        type: 'procure',
        title: `Procure ${qty} ${COMMODITIES[ci(com)].name.toLowerCase()}`,
        text: `"We're running short of ${COMMODITIES[ci(com)].name.toLowerCase()} here at ${c.markets[star].name}. Bring me ${qty} units within ${8 + Math.round(qty / 40)} days and I'll pay well over market."`,
        giver,
        origin: star,
        dest: star,
        commodity: com,
        qty,
        reward: round(priceAt(st, ci(com)) * qty * 1.45 + 1500),
        rep: 5,
        deadline: day + 8 + Math.round(qty / 40),
      });
    } else if (roll < 0.62 && owner !== PIRATES) {
      // Bounty on a pirate band operating nearby.
      const dests = near.filter((s) => c.distance(star, s) < 28 && c.owner[s] !== PIRATES);
      if (!dests.length) continue;
      const to = dests.sort((a, b) => c.pirateActivity(b) - c.pirateActivity(a))[rng.int(0, Math.min(4, dests.length - 1))];
      const strength = Math.max(8, ctx.strength * rng.range(0.6, 1.15));
      const boss = `${generateName(rng, 1, 2)} "${rng.pick(['the Knife', 'Redeye', 'Bonesaw', 'the Butcher', 'Lucky', 'Hollow', 'Grin', 'the Wolf'])}"`;
      out.push({
        id,
        type: 'bounty',
        title: `Bounty: ${boss}`,
        text: `"A pirate captain called ${boss} has been preying on shipping around ${c.galaxy.stars[to].name}. Find them in that system and put an end to it."`,
        giver,
        origin: star,
        dest: to,
        reward: round(6000 + strength * 1400),
        rep: 7,
        deadline: deadlineFor(to) + 6,
        enemy: { faction: 'pirates', strength, seed: rng.int(1, 1e9), name: `${boss}'s raiders` },
      });
    } else if (roll < 0.74) {
      // Smuggling: illegal goods into a market that bans them.
      if (owner !== PIRATES && owner !== INDEPENDENT && rng.next() < 0.7) continue;
      const com = rng.pick(['drugs', 'weapons', 'ai_cores']);
      const dests = near.filter((s) => {
        const f = FACTIONS[c.owner[s]];
        return (f.illegal.includes(com) || f.restricted.includes(com)) && c.distance(star, s) < 30;
      });
      if (!dests.length) continue;
      const to = rng.pick(dests);
      const qty = com === 'ai_cores' ? rng.int(1, 3) : Math.max(5, Math.min(ctx.cargoSpace, round(rng.range(10, 60), 5)));
      const smuggler = contactFor(rng, owner === PIRATES ? 'pirates' : 'independent');
      out.push({
        id,
        type: 'smuggle',
        title: `Smuggle ${qty} ${COMMODITIES[ci(com)].name.toLowerCase()} into ${c.galaxy.stars[to].name}`,
        text: `"Quiet job. ${qty} crates of ${COMMODITIES[ci(com)].name.toLowerCase()} for a friend at ${c.markets[to].name}. The ${FACTIONS[c.owner[to]].short} patrols scan cargo — don't get caught, and if you do, you never met me."`,
        giver: smuggler,
        origin: star,
        dest: to,
        commodity: com,
        qty,
        reward: round(qty * COMMODITIES[ci(com)].price * 0.7 + 7000 + c.distance(star, to) * 500),
        rep: 3,
        deadline: deadlineFor(to) + 2,
      });
    } else if (roll < 0.86) {
      // Survey: chart a system the player hasn't visited.
      const dests = c.near[star].filter((s) => !ctx.visited.has(s) && c.distance(star, s) > 8);
      if (!dests.length) continue;
      const to = rng.pick(dests.slice(0, 20));
      const dist = c.distance(star, to);
      out.push({
        id,
        type: 'survey',
        title: `Chart the ${c.galaxy.stars[to].name} system`,
        text: `"Our charts of ${c.galaxy.stars[to].name} are decades old. Jump in, let your sensors sweep the system, and the data is worth ${round(3000 + dist * 450).toLocaleString()} credits to us."`,
        giver,
        origin: star,
        dest: to,
        reward: round(3000 + dist * 450),
        rep: 3,
        deadline: deadlineFor(to) + 10,
      });
    } else if (wars.length && FACTIONS[owner].military && (ctx.commission === fid || ctx.rep(fid) >= 10)) {
      // Wartime strike against an enemy fleet at the front.
      const enemy = rng.pick(wars);
      const dests = [...c.front].filter((s) => c.owner[s] === enemy && c.distance(star, s) < 40);
      if (!dests.length) continue;
      const to = rng.pick(dests);
      const strength = Math.max(10, ctx.strength * rng.range(0.7, 1.2));
      out.push({
        id,
        type: 'strike',
        title: `War: strike the ${FACTIONS[enemy].short} at ${c.galaxy.stars[to].name}`,
        text: `"The ${FACTIONS[enemy].name} has a squadron staging at ${c.galaxy.stars[to].name}. Hit them before they hit us — the ${FACTIONS[owner].short} pays its debts."`,
        giver: contactFor(rng, fid),
        origin: star,
        dest: to,
        reward: round(9000 + strength * 1800),
        rep: 10,
        deadline: deadlineFor(to) + 6,
        enemy: { faction: FACTIONS[enemy].id, strength, seed: rng.int(1, 1e9), name: `${FACTIONS[enemy].short} strike group` },
      });
    }
  }
  return out;
}
