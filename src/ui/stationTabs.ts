import type { Campaign } from '../campaign/campaign';
import { COMMODITIES, FACTIONS, PIRATES, fi, standing } from '../campaign/defs';
import { INDUSTRIES } from '../campaign/economy';
import type { Mission } from '../campaign/missions';
import {
  type TradeResult,
  acceptMission,
  buy,
  canCommission,
  held,
  marketLines,
  maxBuy,
  rep,
  resignCommission,
  sell,
  stipend,
  takeCommission,
  tariffFor,
} from '../campaign/trade';
import type { Rng } from '../core/rng';
import { type PlayerState, cargoFree, goodsAboard } from '../player';

export interface StationContext {
  campaign: Campaign;
  player: PlayerState;
  star: number;
  rng: Rng;
  toast: (msg: string, kind?: '' | 'warn' | 'good') => void;
  /** Something changed: refresh logistics, autosave, re-render. */
  changed: () => void;
  board: () => Mission[];
}

const cr = (n: number) => `${Math.round(n).toLocaleString()} ¢`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function factionBadge(id: string): string {
  const f = FACTIONS[fi(id)];
  return `<span class="st-faction" style="--fc:${f.color}">${f.short}</span>`;
}

export function standingBadge(value: number): string {
  const s = standing(value);
  return `<span class="st-standing ${s.cls}">${s.label} ${value > 0 ? '+' : ''}${Math.round(value)}</span>`;
}

/** Left panel: who runs this place and what's going on here. */
export function renderStationInfo(el: HTMLElement, ctx: StationContext): void {
  const { campaign: c, player: p, star } = ctx;
  const m = c.markets[star];
  const st = c.states[star];
  const f = FACTIONS[c.owner[star]];
  const wars = c.warsOf(c.owner[star]).filter((x) => x !== PIRATES);
  el.innerHTML = `
    <h3>${esc(m.name)}</h3>
    <div class="st-info">
      <div class="r"><span>System</span><b>${esc(m.system)}</b></div>
      <div class="r"><span>Controlled by</span><b>${factionBadge(f.id)}</b></div>
      <div class="r"><span>Your standing</span><b>${standingBadge(rep(p, f.id))}</b></div>
      <div class="r"><span>Population</span><b>Size ${m.pop}</b></div>
      <div class="r"><span>Stability</span><b><span class="st-bar"><i style="width:${st.stability * 10}%"></i></span></b></div>
      <div class="r"><span>Tariff</span><b>${Math.round(tariffFor(c, p, star) * 100)}%</b></div>
    </div>
    <h4>Industry</h4>
    <div class="st-tags">${m.industries.map((i) => `<span>${INDUSTRIES[i].name}</span>`).join('')}</div>
    ${wars.length ? `<div class="st-alert war">At war with ${wars.map((w) => FACTIONS[w].short).join(', ')}${c.front.has(star) ? ' — <b>front line</b>: military goods in heavy demand' : ''}</div>` : ''}
    ${c.pirateActivity(star) >= 1 ? '<div class="st-alert">Pirate activity reported in this system</div>' : ''}
    ${st.conditions.length ? `<h4>Conditions</h4>${st.conditions.map((x) => `<div class="st-cond">${esc(x.text)} <small>${x.days}d</small></div>`).join('')}` : ''}
    ${f.illegal.length || f.restricted.length ? `<h4>Law</h4><p class="fs-note">Illegal: ${f.illegal.map((x) => COMMODITIES.find((k) => k.id === x)!.name).join(', ') || 'nothing'}.${f.restricted.length ? ` Restricted (commission only): ${f.restricted.map((x) => COMMODITIES.find((k) => k.id === x)!.name).join(', ')}.` : ''} Banned goods trade on the black market, at a risk.</p>` : '<p class="fs-note">Anything goes here — no contraband laws.</p>'}`;
}

/** The commodity exchange. */
export function renderMarket(el: HTMLElement, ctx: StationContext): void {
  const { campaign: c, player: p, star } = ctx;
  const lines = marketLines(c, p, star);
  const st = c.states[star];
  const free = cargoFree(p);
  const best = (k: number, side: 'buy' | 'sell') => {
    let bestV = side === 'buy' ? Infinity : -Infinity;
    let at = -1;
    for (const [s, intel] of Object.entries(p.intel)) {
      const i = Number(s);
      if (i === star) continue;
      const v = side === 'buy' ? intel.buy[k] : intel.sell[k];
      if (v === undefined) continue;
      if (side === 'buy' ? v < bestV : v > bestV) {
        bestV = v;
        at = i;
      }
    }
    return at >= 0 ? { v: bestV, at, age: c.day - p.intel[at].day } : null;
  };
  el.innerHTML = `
    <div class="mk-head">
      <div><span>Credits</span><b>${cr(p.credits)}</b></div>
      <div><span>Hold</span><b>${goodsAboard(p) + Math.round(p.supplies)} / ${p.suppliesCapacity}</b><small>${free} free</small></div>
      <div><span>Fuel</span><b>${Math.round(p.fuel)} / ${p.fuelCapacity} t</b></div>
      <div class="mk-hint">Click quantities to trade. Prices move as you buy and sell; big trades get worse as you go.</div>
    </div>
    <table class="mk">
      <thead><tr><th>Commodity</th><th>Market</th><th class="n">Buy</th><th class="n">Sell</th><th class="n">Held</th><th>Trade</th><th>Best known elsewhere</th></tr></thead>
      <tbody>${lines
        .map((l) => {
          const def = COMMODITIES[l.commodity];
          const ratio = st.stock[l.commodity] / st.target[l.commodity];
          const status = ratio < 0.35 ? ['Shortage', 'short'] : ratio < 0.8 ? ['Demand', 'demand'] : ratio < 1.5 ? ['Stable', 'stable'] : ['Surplus', 'surplus'];
          const h = held(p, l.commodity);
          const mb = maxBuy(c, p, star, l.commodity);
          const b = best(l.commodity, 'sell');
          const bb = best(l.commodity, 'buy');
          const tag = l.legality === 'illegal' ? '<i class="mk-illegal">ILLEGAL</i>' : l.legality === 'restricted' ? '<i class="mk-restricted">RESTRICTED</i>' : '';
          return `<tr class="${l.black ? 'black' : ''}" title="${esc(def.description)}">
            <td><b>${def.name}</b>${tag}</td>
            <td><span class="mk-stock ${status[1]}">${status[0]}</span><small>${l.stock.toLocaleString()}</small></td>
            <td class="n">${l.buy.toLocaleString()}</td>
            <td class="n">${l.sell.toLocaleString()}</td>
            <td class="n">${h || ''}</td>
            <td class="mk-btns">
              <button data-b="${l.commodity}" data-q="1" ${mb < 1 ? 'disabled' : ''}>+1</button><button data-b="${l.commodity}" data-q="10" ${mb < 1 ? 'disabled' : ''}>+10</button><button data-b="${l.commodity}" data-q="${mb}" ${mb < 1 ? 'disabled' : ''}>Max</button>
              <span class="sellgrp"><button class="s" data-s="${l.commodity}" data-q="1" ${h < 1 ? 'disabled' : ''}>−1</button><button class="s" data-s="${l.commodity}" data-q="10" ${h < 1 ? 'disabled' : ''}>−10</button><button class="s" data-s="${l.commodity}" data-q="${h}" ${h < 1 ? 'disabled' : ''}>All</button></span>
            </td>
            <td class="mk-intel">${b && b.v > l.buy ? `<span class="up">sell ${b.v.toLocaleString()} @ ${esc(c.galaxy.stars[b.at].name)} <small>${b.age}d</small></span>` : ''}${bb && bb.v < l.sell ? `<span class="down">buy ${bb.v.toLocaleString()} @ ${esc(c.galaxy.stars[bb.at].name)} <small>${bb.age}d</small></span>` : ''}</td>
          </tr>`;
        })
        .join('')}</tbody>
    </table>`;
  const run = (r: TradeResult) => {
    ctx.toast(r.message, r.busted ? 'warn' : r.ok ? 'good' : 'warn');
    ctx.changed();
  };
  el.querySelectorAll<HTMLButtonElement>('[data-b]').forEach((btn) =>
    btn.addEventListener('click', () => run(buy(c, p, star, Number(btn.dataset.b), Number(btn.dataset.q), ctx.rng))),
  );
  el.querySelectorAll<HTMLButtonElement>('[data-s]').forEach((btn) =>
    btn.addEventListener('click', () => run(sell(c, p, star, Number(btn.dataset.s), Number(btn.dataset.q), ctx.rng))),
  );
}

export function missionCard(c: Campaign, m: Mission, action: string, extra = ''): string {
  const dist = c.distance(m.origin, m.dest);
  const icon = { delivery: '📦', procure: '🛒', bounty: '☠', smuggle: '🕶', survey: '🛰', strike: '⚔' }[m.type];
  return `<div class="bar-job ${m.type}">
    <div class="bj-h"><span class="bj-icon">${icon}</span><b>${esc(m.title)}</b><em>${m.reward.toLocaleString()} ¢</em></div>
    <p>${esc(m.text)}</p>
    <div class="bj-meta"><span>${esc(m.giver.name)}, ${esc(m.giver.title)} ${factionBadge(m.giver.faction)}</span>
      <span>${m.dest === m.origin ? 'Here' : `${esc(c.galaxy.stars[m.dest].name)} · ${dist.toFixed(1)} ly`}</span>
      <span>Due day ${m.deadline}</span>${extra}</div>
    ${action}
  </div>`;
}

/** The bar: jobs, contacts and commissions. */
export function renderBar(left: HTMLElement, main: HTMLElement, ctx: StationContext): void {
  const { campaign: c, player: p, star } = ctx;
  const owner = c.owner[star];
  const f = FACTIONS[owner];
  const board = ctx.board();
  const contacts = Object.values(p.contacts).sort((a, b) => b.jobs - a.jobs);
  const can = canCommission(c, p, owner);
  const pay = stipend(c, owner);
  left.innerHTML = `
    <h3>${f.military ? `${f.short} liaison` : 'The bar'}</h3>
    ${
      f.playable
        ? p.commission === f.id
          ? `<div class="bar-comm on"><b>Commissioned officer</b><p>You fly for the ${f.name}: ${pay.toLocaleString()} ¢ every 7 days, a bounty on every enemy ship, half tariffs and their restricted goods are legal for you.</p><button data-act="resign" class="danger">Resign commission</button></div>`
          : `<div class="bar-comm"><b>Commission with the ${f.short}</b><p>Fight for the ${f.name}: ${pay.toLocaleString()} ¢ every 7 days and a bounty per enemy ship. Their enemies become yours${c.warsOf(owner).filter((x) => x !== PIRATES).length ? ` — currently ${c.warsOf(owner).filter((x) => x !== PIRATES).map((x) => FACTIONS[x].short).join(', ')}` : ''}.</p>
             <button data-act="commission" ${can.ok ? '' : 'disabled'}>Accept commission</button>${can.ok ? '' : `<small>${esc(can.why ?? '')}</small>`}${p.commission ? `<small>Accepting resigns your ${FACTIONS[fi(p.commission)].short} commission.</small>` : ''}</div>`
        : `<p class="fs-note">${f.name} don't offer commissions.</p>`
    }
    <h3>Contacts <span>${contacts.length}</span></h3>
    ${contacts.length ? contacts.map((x) => `<div class="bar-contact"><b>${esc(x.name)}</b><small>${esc(x.title)} · ${FACTIONS[fi(x.faction)].short}</small><em>${x.jobs} job${x.jobs > 1 ? 's' : ''} · +${Math.min(40, x.jobs * 8)}% pay</em></div>`).join('') : '<p class="fs-note">Complete jobs to build a network of contacts who pay better.</p>'}`;
  const active = p.missions;
  main.innerHTML = `
    <h3>Jobs on offer <span>${board.length}</span></h3>
    <div class="bar-jobs">${board.length ? board.map((m) => missionCard(c, m, `<button data-take="${m.id}">Accept</button>`)).join('') : `<p class="fs-note">${rep(p, f.id) <= -20 ? `Nobody here will work with someone the ${f.short} distrust.` : 'Nothing right now. New work comes in every few days.'}</p>`}</div>
    <h3>Your jobs <span>${active.length}/8</span></h3>
    <div class="bar-jobs">${active.length ? active.map((m) => missionCard(c, m, '', m.type === 'procure' && m.commodity ? `<span>Have ${p.cargo[m.commodity] ?? 0}/${m.qty}</span>` : '')).join('') : '<p class="fs-note">No active jobs.</p>'}</div>`;
  main.querySelectorAll<HTMLButtonElement>('[data-take]').forEach((b) =>
    b.addEventListener('click', () => {
      const m = board.find((x) => x.id === b.dataset.take);
      if (!m) return;
      const r = acceptMission(p, m);
      ctx.toast(r.ok ? `Accepted: ${m.title}` : (r.why ?? 'Cannot accept'), r.ok ? 'good' : 'warn');
      ctx.changed();
    }),
  );
  left.querySelector('[data-act=commission]')?.addEventListener('click', () => {
    for (const n of takeCommission(c, p, owner)) ctx.toast(n, 'warn');
    ctx.toast(`You are now a commissioned officer of the ${f.name}`, 'good');
    ctx.changed();
  });
  left.querySelector('[data-act=resign]')?.addEventListener('click', () => {
    for (const n of resignCommission(p)) ctx.toast(n);
    ctx.changed();
  });
}
