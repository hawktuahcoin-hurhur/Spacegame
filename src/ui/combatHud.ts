import type { CombatShip } from '../combat/ship';
import type { CombatSim } from '../combat/sim';
import { formatDistance } from './format';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.appendChild(e);
  return e;
}

const pct = (f: number) => `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`;

interface Bracket {
  root: HTMLDivElement;
  hull: HTMLDivElement;
  flux: HTMLDivElement;
  label: HTMLDivElement;
  key: string;
}

interface Floater {
  el: HTMLDivElement;
  age: number;
  x: number;
  y: number;
  vy: number;
}

export interface CombatHudView {
  width: number;
  height: number;
  /** Arena point → screen px (null when behind the camera). */
  project: (p: { x: number; y: number; z: number }) => { x: number; y: number } | null;
  /** Lead indicator for the selected group against the target (screen px). */
  lead: { x: number; y: number } | null;
  /** Pixels per metre at a ship's distance, for bracket sizes. */
  pxPerMetre: (p: { x: number; y: number; z: number }) => number;
  banner: { title: string; sub: string; kind: 'warn' | 'good' | '' } | null;
  /** Distance to the nearest hostile, and whether supercruise is blocked. */
  massLocked: boolean;
}

/**
 * The combat layer over the flight HUD: your ship's hull/armour/flux and
 * shield state, weapon groups, the locked target, brackets over every ship,
 * a lead indicator and floating damage numbers.
 */
export class CombatHud {
  readonly root: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly groups: HTMLDivElement;
  private readonly target: HTMLDivElement;
  private readonly roster: HTMLDivElement;
  private readonly brackets = new Map<CombatShip, Bracket>();
  private readonly layer: HTMLDivElement;
  private readonly leadEl: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly floaters: Floater[] = [];
  private lastStatus = '';
  private lastGroups = '';
  private lastTarget = '';
  private lastRoster = '';
  private lastBanner = '';

  constructor(parent: HTMLElement) {
    this.root = el('div', 'combat-hud hidden', parent);
    this.layer = el('div', 'cb-layer', this.root);
    this.leadEl = el('div', 'cb-lead', this.root);
    this.status = el('div', 'cb-status', this.root);
    this.groups = el('div', 'cb-groups', this.root);
    this.target = el('div', 'cb-target', this.root);
    this.roster = el('div', 'cb-roster', this.root);
    this.banner = el('div', 'cb-banner hidden', this.root);
    this.hint = el('div', 'cb-hint', this.root);
    this.hint.innerHTML =
      '<kbd>LMB</kbd> fire · <kbd>RMB</kbd> shields · <kbd>1</kbd>–<kbd>5</kbd> group · <kbd>Shift</kbd>+<kbd>#</kbd> autofire · <kbd>F</kbd> system · <kbd>V</kbd> vent · <kbd>R</kbd>/<kbd>T</kbd> target · <kbd>Tab</kbd> tactical';
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }

  /** Floating damage number at a screen position. */
  damageNumber(x: number, y: number, amount: number, kind: 'shield' | 'armor' | 'hull'): void {
    if (amount < 1) return;
    let f = this.floaters.find((x) => x.age >= 1);
    if (!f) {
      if (this.floaters.length >= 28) return;
      f = { el: el('div', 'cb-dmg', this.root), age: 1, x: 0, y: 0, vy: 0 };
      this.floaters.push(f);
    }
    f.age = 0;
    f.x = x + (Math.random() - 0.5) * 24;
    f.y = y - 10;
    f.vy = -38 - Math.random() * 20;
    f.el.textContent = String(Math.round(amount));
    f.el.className = `cb-dmg ${kind}`;
    f.el.style.fontSize = `${Math.min(26, 12 + Math.sqrt(amount) * 0.5)}px`;
  }

  update(sim: CombatSim, dt: number, view: CombatHudView): void {
    const me = sim.player;
    // Floaters.
    for (const f of this.floaters) {
      if (f.age >= 1) {
        f.el.style.opacity = '0';
        continue;
      }
      f.age += dt / 1.1;
      f.y += f.vy * dt;
      f.vy *= Math.exp(-dt * 2);
      f.el.style.transform = `translate(${f.x}px, ${f.y}px) translate(-50%, -50%)`;
      f.el.style.opacity = String(Math.max(0, 1 - f.age * f.age));
    }

    // Brackets over ships.
    const seen = new Set<CombatShip>();
    for (const s of sim.ships) {
      if (s.controlled || s.retreated) continue;
      const p = view.project(s.pos);
      if (!p || p.x < -80 || p.y < -80 || p.x > view.width + 80 || p.y > view.height + 80) continue;
      seen.add(s);
      let b = this.brackets.get(s);
      if (!b) {
        const root = el('div', `cb-bracket side${s.side}`, this.layer);
        const bars = el('div', 'cb-bars', root);
        const hull = el('div', 'hull', el('div', 'bar', bars));
        const flux = el('div', 'flux', el('div', 'bar', bars));
        const label = el('div', 'cb-blabel', root);
        b = { root, hull, flux, label, key: '' };
        this.brackets.set(s, b);
      }
      const size = Math.max(22, Math.min(260, s.dims.bound * 1.4 * view.pxPerMetre(s.pos)));
      b.root.style.transform = `translate(${p.x}px, ${p.y}px)`;
      b.root.style.width = b.root.style.height = `${size}px`;
      b.root.style.marginLeft = b.root.style.marginTop = `${-size / 2}px`;
      const isTarget = me?.target === s;
      const cls = `cb-bracket side${s.side}${isTarget ? ' target' : ''}${s.alive ? '' : ' dead'}${s.overload > 0 ? ' overload' : ''}`;
      if (b.root.className !== cls) b.root.className = cls;
      b.hull.style.width = pct(s.hpFrac);
      b.flux.style.width = pct(s.fluxFrac);
      const dist = me ? formatDistance(s.pos.distanceTo(me.pos)) : '';
      const key = `${s.name}|${s.alive}|${isTarget}|${dist}|${s.overload > 0}|${s.venting}`;
      if (key !== b.key) {
        b.key = key;
        const flag = !s.alive ? 'DISABLED' : s.overload > 0 ? 'OVERLOAD' : s.venting ? 'VENTING' : '';
        b.label.innerHTML = isTarget || !s.alive || flag ? `<b>${s.name}</b>${flag ? ` <i>${flag}</i>` : ''}<span>${s.alive ? dist : ''}</span>` : '';
      }
    }
    for (const [s, b] of this.brackets)
      if (!seen.has(s)) {
        if (!sim.ships.includes(s)) {
          b.root.remove();
          this.brackets.delete(s);
        } else b.root.style.transform = 'translate(-9999px, 0)';
      }

    // Lead indicator.
    if (view.lead) {
      this.leadEl.style.display = 'block';
      this.leadEl.style.transform = `translate(${view.lead.x}px, ${view.lead.y}px)`;
    } else this.leadEl.style.display = 'none';

    // Own ship status.
    if (me) {
      const sh = me.shield;
      const shieldState = !sh ? 'NO SHIELD' : me.overload > 0 ? 'OVERLOADED' : me.venting ? 'VENTING' : me.shieldOn ? `${sh.type.toUpperCase()} · UP` : `${sh.type.toUpperCase()} · DOWN`;
      const sys = me.system;
      const charges = sys.charges ?? 1;
      const sysState = me.systemActive > 0 ? 'ACTIVE' : me.systemCharges > 0 ? 'READY' : `${Math.ceil(me.systemCooldown)}s`;
      const hard = me.hardFlux / me.fluxCap;
      const key = [me.name, pct(me.hpFrac), pct(me.armor.fraction), Math.round(me.flux), Math.round(me.hardFlux), shieldState, sysState, me.systemCharges, Math.round(me.cr * 100), view.massLocked].join('|');
      if (key !== this.lastStatus) {
        this.lastStatus = key;
        const crWarn = me.cr < 0.4 ? ' warn' : '';
        this.status.innerHTML = `
          <div class="cb-name">${me.name}<small>${me.hull.name} · ${me.hull.designation}</small></div>
          <div class="cb-row"><span>HULL</span><div class="cb-bar hull"><div style="width:${pct(me.hpFrac)}"></div></div><em>${Math.ceil(me.hp)}</em></div>
          <div class="cb-row"><span>ARMOR</span><div class="cb-bar armor"><div style="width:${pct(me.armor.fraction)}"></div></div><em>${pct(me.armor.fraction)}</em></div>
          <div class="cb-row"><span>FLUX</span><div class="cb-bar flux${me.fluxFrac > 0.85 ? ' hot' : ''}"><div style="width:${pct(me.fluxFrac)}"></div><i style="width:${pct(hard)}"></i></div><em>${Math.round(me.flux)}/${me.fluxCap}</em></div>
          <div class="cb-tags">
            <span class="${me.overload > 0 ? 'bad' : me.shieldOn ? 'on' : ''}">${shieldState}</span>
            <span class="${me.systemActive > 0 ? 'on' : me.systemCharges > 0 ? 'ready' : ''}">${sys.name.toUpperCase()} · ${sysState}${charges > 1 ? ` · ${'●'.repeat(me.systemCharges)}${'○'.repeat(charges - me.systemCharges)}` : ''}</span>
            <span class="cr${crWarn}">CR ${Math.round(me.cr * 100)}%</span>
            ${view.massLocked ? '<span class="bad">MASS LOCKED</span>' : '<span class="on">CLEAR · [J] DISENGAGE</span>'}
          </div>`;
      }
      // Weapon groups.
      const gkey = me.groups
        .map((g, i) => `${i === me.selectedGroup}${g.autofire}${g.weapons.map((w) => `${w.ammo}${w.disabled > 0}${w.cooldown > 0.05 ? Math.ceil(w.cooldown * 4) : 0}`).join(',')}`)
        .join('|');
      if (gkey !== this.lastGroups) {
        this.lastGroups = gkey;
        this.groups.innerHTML = me.groups
          .map((g, i) => {
            const counts = new Map<string, { n: number; ammo: number; max: number; off: boolean; cd: number }>();
            for (const w of g.weapons) {
              const c = counts.get(w.def.name) ?? { n: 0, ammo: 0, max: 0, off: false, cd: 0 };
              c.n++;
              c.ammo += w.ammo === Infinity ? 0 : w.ammo;
              c.max += w.maxAmmo === Infinity ? 0 : w.maxAmmo;
              c.off ||= w.disabled > 0;
              c.cd = Math.max(c.cd, w.def.kind === 'beam' ? 0 : Math.min(1, w.cooldown * w.rof));
              counts.set(w.def.name, c);
            }
            const rows = [...counts]
              .map(
                ([name, c]) =>
                  `<div class="w${c.off ? ' off' : ''}"><span>${c.n > 1 ? `${c.n}× ` : ''}${name}</span><em>${c.max ? `${c.ammo}` : c.off ? 'EMP' : ''}</em><b style="width:${pct(1 - c.cd)}"></b></div>`,
              )
              .join('');
            return `<div class="cb-group${i === me.selectedGroup ? ' sel' : ''}"><div class="gh"><kbd>${i + 1}</kbd>${g.label}${g.autofire ? '<i>AUTO</i>' : ''}</div>${rows}</div>`;
          })
          .join('');
      }
    }

    // Target.
    const t = me?.target ?? null;
    if (t && me) {
      const d = t.pos.distanceTo(me.pos);
      const shield = !t.shield ? 'No shield' : t.overload > 0 ? 'OVERLOADED' : t.venting ? 'VENTING' : t.shieldUp ? `${t.shield.type} shield up` : `${t.shield.type} shield down`;
      const key = [t.name, pct(t.hpFrac), pct(t.armor.fraction), pct(t.fluxFrac), shield, formatDistance(d), t.alive].join('|');
      if (key !== this.lastTarget) {
        this.lastTarget = key;
        this.target.innerHTML = `
          <div class="cb-name side${t.side}">${t.name}<small>${t.hull.name} · ${t.hull.designation}${t.alive ? '' : ' · DISABLED'}</small></div>
          <div class="cb-row"><span>HULL</span><div class="cb-bar hull"><div style="width:${pct(t.hpFrac)}"></div></div></div>
          <div class="cb-row"><span>ARMOR</span><div class="cb-bar armor"><div style="width:${pct(t.armor.fraction)}"></div></div></div>
          <div class="cb-row"><span>FLUX</span><div class="cb-bar flux"><div style="width:${pct(t.fluxFrac)}"></div><i style="width:${pct(t.hardFlux / t.fluxCap)}"></i></div></div>
          <div class="cb-tags"><span class="${t.overload > 0 ? 'bad' : ''}">${shield.toUpperCase()}</span><span>${formatDistance(d)}</span></div>`;
      }
      this.target.classList.add('show');
    } else {
      this.target.classList.remove('show');
      this.lastTarget = '';
    }

    // Fleet roster.
    const ours = sim.ships.filter((s) => s.side === 0);
    const theirs = sim.ships.filter((s) => s.side === 1);
    const rkey = ours.map((s) => `${s.name}${pct(s.hpFrac)}${s.alive}${s.ai.state}${s.order?.kind}`).join('|') + theirs.map((s) => `${s.alive}${s.retreated}`).join('');
    if (rkey !== this.lastRoster) {
      this.lastRoster = rkey;
      const live = theirs.filter((s) => s.alive && !s.retreated).length;
      this.roster.innerHTML =
        `<div class="rh">YOUR FLEET</div>` +
        ours
          .map(
            (s) =>
              `<div class="r${s.alive ? '' : ' dead'}${s.controlled ? ' me' : ''}"><span>${s.name}</span><div class="cb-bar hull mini"><div style="width:${pct(s.hpFrac)}"></div></div><em>${!s.alive ? 'DISABLED' : s.controlled ? 'YOU' : s.order ? s.order.kind.toUpperCase() : s.ai.state.split(' ')[0].toUpperCase()}</em></div>`,
          )
          .join('') +
        `<div class="rh enemy">HOSTILES · ${live} / ${theirs.length}</div>`;
    }

    // Banner.
    const bkey = view.banner ? `${view.banner.title}|${view.banner.sub}` : '';
    if (bkey !== this.lastBanner) {
      this.lastBanner = bkey;
      this.banner.classList.toggle('hidden', !view.banner);
      if (view.banner) {
        this.banner.className = `cb-banner ${view.banner.kind}`;
        this.banner.innerHTML = `<div class="t">${view.banner.title}</div><div class="s">${view.banner.sub}</div>`;
      }
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
