import type { BattleReport } from '../combat/encounters';
import { hull } from '../ships/defs';

export interface AftermathContext {
  report: BattleReport;
  credits: number;
  fleetSize: number;
  maxFleet: number;
  simulated: boolean;
  /** Fuel/supply room left, to show what actually fits. */
  fuelRoom: number;
  suppliesRoom: number;
}

const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * Post-battle screen: what was destroyed, what you salvaged, and which
 * disabled hulls (yours and theirs) to recover — each comes back with d-mods.
 */
export class AftermathScreen {
  private root: HTMLDivElement | null = null;

  show(ctx: AftermathContext, onDone: (recover: Set<string>) => void): void {
    this.hide();
    const r = ctx.report;
    const root = document.createElement('div');
    root.className = 'aftermath';
    this.root = root;
    const title =
      r.outcome === 'victory' ? (ctx.simulated ? 'Simulation won' : 'Victory') : r.outcome === 'defeat' ? (ctx.simulated ? 'Simulation lost' : 'Defeat') : 'Disengaged';
    const sub =
      r.outcome === 'victory'
        ? `${r.enemyName} ${r.retreated.length ? 'broken and scattered' : 'destroyed'}`
        : r.outcome === 'defeat'
          ? ctx.simulated
            ? 'Every ship in the simulation was disabled'
            : 'Your fleet was destroyed'
          : `You escaped ${r.enemyName}`;
    const theirs = r.destroyed.filter((d) => d.side === 1);
    const ours = r.destroyed.filter((d) => d.side === 0);
    const list = (xs: { name: string; hullId: string }[], empty: string) =>
      xs.length ? xs.map((d) => `<li>${d.name}<small>${hull(d.hullId).name}</small></li>`).join('') : `<li class="none">${empty}</li>`;
    const fuel = Math.min(r.salvage.fuel, ctx.fuelRoom);
    const sup = Math.min(r.salvage.supplies, ctx.suppliesRoom);
    root.innerHTML = `
      <div class="am-panel ${r.outcome}">
        <div class="am-title">${title}</div>
        <div class="am-sub">${sub}</div>
        <div class="am-cols">
          <div><h4>Enemy losses</h4><ul>${list(theirs, 'None')}</ul>${r.retreated.length ? `<p class="dim">Fled: ${r.retreated.join(', ')}</p>` : ''}</div>
          <div><h4>Your losses</h4><ul class="loss">${list(ours, 'None — not a scratch lost')}</ul></div>
          <div><h4>Salvage</h4>${
            ctx.simulated
              ? '<p class="dim">Simulated battle — no salvage, no losses.</p>'
              : r.outcome === 'victory'
                ? `<div class="am-loot"><span>Credits</span><b>+${fmt(r.salvage.credits)} ¢</b></div>
                   <div class="am-loot"><span>Fuel</span><b>+${fuel} t</b>${fuel < r.salvage.fuel ? '<i>tanks full</i>' : ''}</div>
                   <div class="am-loot"><span>Supplies</span><b>+${sup}</b>${sup < r.salvage.supplies ? '<i>holds full</i>' : ''}</div>`
                : '<p class="dim">Nothing recovered.</p>'
          }</div>
        </div>
        ${
          r.recoverable.length && !ctx.simulated
            ? `<h4>Recoverable hulls <small>— recovered ships come back damaged, with d-mods</small></h4>
               <div class="am-recover">${r.recoverable
                 .map(
                   (x) => `<label class="${x.own ? 'own' : ''}"><input type="checkbox" data-id="${x.id}" ${x.own ? 'checked' : ''}>
                   <span>${x.name}<small>${hull(x.loadout.hullId).name} · ${hull(x.loadout.hullId).designation}${x.own ? ' · your ship' : ''}</small></span>
                   <em>${fmt(x.cost)} ¢</em><i>+${x.dmods} d-mod${x.dmods > 1 ? 's' : ''}</i></label>`,
                 )
                 .join('')}</div>`
            : ''
        }
        ${r.kills.some((k) => k.damage > 0) ? `<div class="am-mvp">${r.kills.filter((k) => k.damage > 0).sort((a, b) => b.damage - a.damage).slice(0, 3).map((k) => `<span>${k.name}<b>${k.kills} kill${k.kills === 1 ? '' : 's'} · ${fmt(k.damage)} dmg</b></span>`).join('')}</div>` : ''}
        <div class="am-foot"><span class="am-cost"></span><button class="am-go">${r.outcome === 'defeat' && !ctx.simulated ? 'Eject' : 'Continue'}</button></div>
      </div>`;
    document.body.appendChild(root);
    const boxes = [...root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
    const costEl = root.querySelector('.am-cost') as HTMLSpanElement;
    const go = root.querySelector('.am-go') as HTMLButtonElement;
    const refresh = () => {
      const chosen = boxes.filter((b) => b.checked);
      const cost = chosen.reduce((a, b) => a + (r.recoverable.find((x) => x.id === b.dataset.id)?.cost ?? 0), 0);
      const credits = ctx.credits + (r.outcome === 'victory' && !ctx.simulated ? r.salvage.credits : 0);
      const lostOwn = ours.length;
      const room = ctx.maxFleet - (ctx.fleetSize - lostOwn);
      const tooMany = chosen.length > room;
      const broke = cost > credits;
      costEl.textContent = chosen.length ? `Recovery: ${fmt(cost)} ¢ of ${fmt(credits)} ¢${tooMany ? ' — fleet is full' : broke ? ' — not enough credits' : ''}` : '';
      costEl.classList.toggle('bad', tooMany || broke);
      go.disabled = tooMany || broke;
    };
    for (const b of boxes) b.addEventListener('change', refresh);
    refresh();
    go.addEventListener('click', () => {
      const chosen = new Set(boxes.filter((b) => b.checked).map((b) => b.dataset.id!));
      this.hide();
      onDone(chosen);
    });
  }

  get open(): boolean {
    return !!this.root;
  }

  hide(): void {
    this.root?.remove();
    this.root = null;
  }
}
