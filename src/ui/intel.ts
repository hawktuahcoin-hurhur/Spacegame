import type { Campaign, IntelEvent } from '../campaign/campaign';
import { COMMODITIES, FACTIONS, NF, PIRATES, standing } from '../campaign/defs';
import { abandonMission, rep } from '../campaign/trade';
import type { PlayerState } from '../player';
import { factionBadge, missionCard, standingBadge } from './stationTabs';

export type IntelTab = 'news' | 'jobs' | 'factions' | 'trade' | 'codex';

export interface IntelHost {
  campaign: Campaign;
  player: PlayerState;
  here: number;
  plotRoute(star: number): void;
  close(): void;
  toast(msg: string, kind?: '' | 'warn' | 'good'): void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const ICON: Record<IntelEvent['kind'], string> = {
  war: '⚔',
  peace: '☮',
  raid: '☠',
  captured: '⚑',
  shortage: '▼',
  boom: '▲',
  convoy: '☠',
  incident: '⚠',
  unrest: '✊',
};

/**
 * The Intel screen (I): galactic news, your jobs, faction politics and the
 * prices you've seen — everything you need to plan the next run.
 */
export class IntelScreen {
  readonly root: HTMLDivElement;
  open = false;
  private tab: IntelTab = 'news';
  private newsFilter: 'near' | 'all' | 'major' = 'near';
  private host: IntelHost | null = null;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'intel hidden';
    document.body.appendChild(this.root);
    this.root.addEventListener('keydown', (e) => e.stopPropagation());
  }

  show(host: IntelHost, tab: IntelTab = this.tab): void {
    this.host = host;
    this.tab = tab;
    this.open = true;
    this.root.classList.remove('hidden');
    this.render();
  }

  hide(): void {
    this.open = false;
    this.root.classList.add('hidden');
  }

  render(): void {
    const h = this.host;
    if (!h) return;
    const tabs: [IntelTab, string][] = [
      ['news', 'News'],
      ['jobs', `Jobs (${h.player.missions.length})`],
      ['factions', 'Factions'],
      ['trade', 'Trade intel'],
      ['codex', `Codex (${Object.keys(h.player.codex).length})`],
    ];
    this.root.innerHTML = `
      <div class="in-head"><div class="in-title">Intel<small>Day ${h.campaign.day + 1}</small></div>
        <div class="in-tabs">${tabs.map(([id, l]) => `<button data-tab="${id}" class="${this.tab === id ? 'on' : ''}">${l}</button>`).join('')}</div>
        <button class="in-close" title="Close (I / Esc)">✕</button></div>
      <div class="in-body">${this.body(h)}</div>`;
    this.root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => (b.onclick = () => ((this.tab = b.dataset.tab as IntelTab), this.render())));
    this.root.querySelector<HTMLButtonElement>('.in-close')!.onclick = () => h.close();
    this.root.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((b) => (b.onclick = () => ((this.newsFilter = b.dataset.filter as typeof this.newsFilter), this.render())));
    this.root.querySelectorAll<HTMLButtonElement>('[data-route]').forEach((b) => (b.onclick = () => h.plotRoute(Number(b.dataset.route))));
    this.root.querySelectorAll<HTMLButtonElement>('[data-abandon]').forEach(
      (b) =>
        (b.onclick = () => {
          const m = h.player.missions.find((x) => x.id === b.dataset.abandon);
          if (!m || !confirm(`Abandon "${m.title}"? Your standing with the ${FACTIONS.find((f) => f.id === m.giver.faction)?.short} will suffer.`)) return;
          abandonMission(h.player, m);
          h.toast(`Abandoned: ${m.title}`, 'warn');
          this.render();
        }),
    );
  }

  private body(h: IntelHost): string {
    const c = h.campaign;
    const p = h.player;
    if (this.tab === 'news') {
      const near = (e: IntelEvent) => c.distance(e.star, h.here) < 40;
      const list = c.events.filter((e) => (this.newsFilter === 'all' ? true : this.newsFilter === 'major' ? e.major : near(e) || e.major)).slice(0, 80);
      const wars = c.wars.map((w) => `<div class="in-war">${factionBadge(FACTIONS[w.a].id)} <b>at war with</b> ${factionBadge(FACTIONS[w.b].id)} <small>${w.since < 0 ? 'since before you arrived' : `since day ${w.since + 1}`}</small></div>`).join('');
      return `${wars ? `<div class="in-wars">${wars}</div>` : '<div class="in-wars"><div class="in-war calm">The major powers are at peace — for now.</div></div>'}
        <div class="in-filters">${(['near', 'major', 'all'] as const).map((f) => `<button data-filter="${f}" class="${this.newsFilter === f ? 'on' : ''}">${f === 'near' ? 'Within 40 ly' : f === 'major' ? 'Major' : 'Everything'}</button>`).join('')}</div>
        <div class="in-news">${
          list.length
            ? list
                .map(
                  (e) => `<div class="in-ev ${e.kind}${e.major ? ' major' : ''}"><span class="ic">${ICON[e.kind]}</span><div><p>${esc(e.text)}</p><small>${e.day < 0 ? `${-e.day} day${e.day === -1 ? '' : 's'} before you arrived` : `Day ${e.day + 1}`} · ${esc(c.galaxy.stars[e.star].name)} · ${c.distance(e.star, h.here).toFixed(0)} ly</small></div>
                  ${e.star !== h.here ? `<button data-route="${e.star}">Route</button>` : ''}</div>`,
                )
                .join('')
            : '<p class="fs-note">No news.</p>'
        }</div>`;
    }
    if (this.tab === 'jobs') {
      if (!p.missions.length) return '<p class="fs-note">No active jobs. Visit the bar at any station for work.</p>';
      return `<div class="bar-jobs">${p.missions
        .map((m) => {
          const left = m.deadline - c.day;
          const status = `<span class="${left < 3 ? 'late' : ''}">${left >= 0 ? `${left} day${left === 1 ? '' : 's'} left` : 'Overdue'}</span>`;
          return missionCard(
            c,
            m,
            `<div class="in-jobbtns">${m.dest !== h.here ? `<button data-route="${m.dest}">Plot route</button>` : '<span class="here">Destination: this system</span>'}<button class="danger" data-abandon="${m.id}">Abandon</button></div>`,
            status,
          );
        })
        .join('')}</div>`;
    }
    if (this.tab === 'factions') {
      const rows = FACTIONS.map((f, i) => {
        const r = rep(p, f.id);
        const wars = c.warsOf(i).filter((x) => x !== PIRATES || i === PIRATES);
        const rel = FACTIONS.map((_g, j) => (j === i ? '<td class="self">—</td>' : `<td class="${relClass(c.relation(i, j), c.atWar(i, j) && i !== PIRATES && j !== PIRATES)}">${Math.round(c.relation(i, j))}</td>`)).join('');
        return `<tr><td>${factionBadge(f.id)}${p.commission === f.id ? ' <b class="comm">★ commissioned</b>' : ''}</td><td>${standingBadge(r)}</td><td class="n">${c.territory(i)}</td>
          <td>${i === PIRATES ? 'Everyone' : wars.map((w) => FACTIONS[w].short).join(', ') || '—'}</td>${rel}</tr>`;
      }).join('');
      return `<table class="in-fac"><thead><tr><th>Faction</th><th>Your standing</th><th class="n">Systems</th><th>At war with</th>${FACTIONS.map((f) => `<th class="rel" title="${f.name}">${f.short.slice(0, 4)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
        <div class="in-facdesc">${FACTIONS.map((f) => `<div><b style="color:${f.color}">${f.name}</b><p>${esc(f.description)}</p><small>Illegal: ${f.illegal.map((x) => COMMODITIES.find((k) => k.id === x)!.name).join(', ') || 'nothing'}${f.restricted.length ? ` · Restricted: ${f.restricted.map((x) => COMMODITIES.find((k) => k.id === x)!.name).join(', ')}` : ''} · Tariff ${Math.round(f.tariff * 100)}%</small></div>`).join('')}</div>
        <p class="fs-note">Standing: ${['Vengeful ≤ −75', 'Hostile ≤ −50 (attacked on sight, no docking)', 'Inhospitable ≤ −20 (higher tariffs, no jobs)', 'Favorable 10+ (commissions from 15)', 'Friendly 25+ (warships for sale, lower tariffs)'].join(' · ')}. ${standing(0).label} is the default.</p>`;
    }
    if (this.tab === 'codex') {
      const all = Object.values(p.codex).sort((a, b) => b.day - a.day);
      if (!all.length) return '<p class="fs-note">Land on planets (L when close) and scan plants and animals, translate ruins and salvage wrecks. Discoveries are logged here and sell as data at any station.</p>';
      const unsold = all.filter((e) => !e.sold).reduce((a, e) => a + e.value, 0);
      const icon: Record<string, string> = { flora: '❦', fauna: '🐾', mineral: '◆', ruins: '◈', wreck: '✦', planet: '◯' };
      return `<p class="fs-note">${all.length} discoveries · unsold data worth about <b>${unsold.toLocaleString()} ¢</b> — sell it at any station's Services (Tri-Corp pays best).</p>
        <div class="in-codex">${all
          .map(
            (e) => `<div class="cx ${e.kind}${e.sold ? ' sold' : ''}"><span class="ic">${icon[e.kind] ?? '•'}</span><div><b>${esc(e.name)}</b><small>${e.kind} · ${esc(e.planet)}, ${esc(e.system)} · day ${e.day}</small><p>${esc(e.note)}</p></div><em>${e.sold ? 'sold' : `${e.value.toLocaleString()} ¢`}</em></div>`,
          )
          .join('')}</div>`;
    }
    // Trade intel: best prices seen per commodity.
    const seen = Object.entries(p.intel).map(([k, v]) => ({ star: Number(k), ...v }));
    if (!seen.length) return '<p class="fs-note">Dock at stations to record their prices here.</p>';
    const rows = COMMODITIES.map((def, k) => {
      let lo = { v: Infinity, star: -1, day: 0 };
      let hi = { v: -Infinity, star: -1, day: 0 };
      for (const s of seen) {
        if (s.buy[k] < lo.v) lo = { v: s.buy[k], star: s.star, day: s.day };
        if (s.sell[k] > hi.v) hi = { v: s.sell[k], star: s.star, day: s.day };
      }
      const margin = hi.v - lo.v;
      const cell = (x: typeof lo) => `${x.v.toLocaleString()} ¢ <small>${esc(c.galaxy.stars[x.star].name)} · ${c.day - x.day}d ago</small>`;
      return { def, lo, hi, margin, html: `<tr><td><b>${def.name}</b></td><td>${cell(lo)}</td><td>${cell(hi)}</td><td class="n ${margin > 0 ? 'pos' : 'neg'}">${margin > 0 ? '+' : ''}${margin.toLocaleString()}</td><td>${lo.star !== h.here ? `<button data-route="${lo.star}">Route to buy</button>` : ''}</td></tr>` };
    }).sort((a, b) => b.margin / b.def.price - a.margin / a.def.price);
    return `<p class="fs-note">Best prices recorded at the ${seen.length} market${seen.length > 1 ? 's' : ''} you've docked at. Prices drift daily — and fall as you flood a market.</p>
      <table class="mk in-trade"><thead><tr><th>Commodity</th><th>Cheapest to buy</th><th>Best to sell</th><th class="n">Margin / unit</th><th></th></tr></thead><tbody>${rows.map((r) => r.html).join('')}</tbody></table>`;
  }
}

function relClass(v: number, war: boolean): string {
  if (war) return 'war';
  return v <= -50 ? 'hostile' : v <= -20 ? 'bad' : v >= 25 ? 'good' : '';
}
void NF;
