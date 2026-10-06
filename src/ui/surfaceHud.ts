import type { SurfaceHudState } from '../surface/session';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  parent.appendChild(e);
  return e;
}

const KIND_ICON: Record<string, string> = { ship: '▲', ruins: '◈', crash: '✦', monolith: '▮', deposit: '◆' };

/** On-foot HUD: compass, scanner readout, suit gauges, tool and prompts. */
export class SurfaceHud {
  readonly root: HTMLDivElement;
  private readonly compass: HTMLDivElement;
  private readonly strip: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly target: HTMLDivElement;
  private readonly ring: SVGCircleElement;
  private readonly gauges: HTMLDivElement;
  private readonly tool: HTMLDivElement;
  private readonly prompt: HTMLDivElement;
  private readonly fade: HTMLDivElement;
  private readonly entry: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private lastTitle = '';
  private lastTarget = '';

  constructor(parent: HTMLElement) {
    this.root = el('div', 'sf-hud hidden', parent);
    this.compass = el('div', 'sf-compass', this.root);
    this.strip = el('div', 'sf-strip', this.compass);
    el('div', 'sf-needle', this.compass);
    this.title = el('div', 'sf-title', this.root);
    const cross = el('div', 'sf-cross', this.root);
    cross.innerHTML = `<svg viewBox="-30 -30 60 60" width="60" height="60"><circle r="2" fill="rgba(220,240,255,0.9)"/><circle r="11" fill="none" stroke="rgba(220,240,255,0.35)" stroke-width="1"/><circle class="ring" r="15" fill="none" stroke="#5fd4ff" stroke-width="2.5" stroke-dasharray="0 999" transform="rotate(-90)"/></svg>`;
    this.ring = cross.querySelector('.ring') as SVGCircleElement;
    this.target = el('div', 'sf-target', this.root);
    this.gauges = el('div', 'sf-gauges', this.root);
    this.tool = el('div', 'sf-tool', this.root);
    this.prompt = el('div', 'sf-prompt', this.root);
    this.hint = el('div', 'sf-hint', this.root);
    this.hint.innerHTML =
      '<kbd>WASD</kbd> move · <kbd>Shift</kbd> sprint · <kbd>Space</kbd> jump / jetpack · <kbd>1</kbd> mining beam · <kbd>2</kbd> scanner · <kbd>LMB</kbd> use · <kbd>F</kbd> pulse scan · <kbd>E</kbd> interact · <kbd>I</kbd> codex';
    this.fade = el('div', 'sf-fade', document.body);
    this.entry = el('div', 'sf-entry', document.body);
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }

  /** White-out level (landing/take-off transitions). */
  setFade(v: number): void {
    this.fade.style.opacity = String(Math.max(0, Math.min(1, v)));
  }

  /** Re-entry plasma glow around the screen edges during the orbital descent. */
  setEntry(v: number, time: number): void {
    this.entry.style.opacity = String(Math.max(0, Math.min(1, v)) * (0.85 + Math.sin(time * 37) * 0.1 + Math.sin(time * 23) * 0.05));
  }

  update(s: SurfaceHudState): void {
    const walk = s.state === 'walk';
    this.root.classList.toggle('cinematic', !walk);
    this.setFade(s.fade);
    // Compass: 1 px per 0.25° across 120° of view.
    const pxPerRad = 900 / Math.PI;
    const marks: string[] = [];
    for (const [label, b] of [
      ['N', Math.PI],
      ['E', -Math.PI / 2],
      ['S', 0],
      ['W', Math.PI / 2],
    ] as [string, number][]) {
      const x = wrap(s.compass.heading - b) * pxPerRad;
      if (Math.abs(x) < 300) marks.push(`<span class="cardinal" style="left:${x}px">${label}</span>`);
    }
    for (const m of s.compass.markers) {
      const x = wrap(s.compass.heading - m.bearing) * pxPerRad;
      if (Math.abs(x) > 300) continue;
      const near = m.distance < 400 || m.kind === 'ship';
      marks.push(
        `<span class="mk ${m.kind}" style="left:${x}px"><i>${KIND_ICON[m.kind] ?? '•'}</i>${near ? `<b>${m.label}</b><em>${m.distance < 1000 ? `${Math.round(m.distance)} m` : `${(m.distance / 1000).toFixed(1)} km`}</em>` : ''}</span>`,
      );
    }
    this.strip.innerHTML = marks.join('');
    const title = `${s.planet}|${s.system}|${s.biome}`;
    if (title !== this.lastTitle) {
      this.lastTitle = title;
      this.title.innerHTML = `<b>${s.planet}</b><small>${s.system} system · ${s.biome}</small>`;
    }
    // Target readout.
    const a = s.aim;
    const tkey = `${a.kind}|${a.name}|${a.scanned}|${Math.round(a.distance)}|${s.tool}`;
    if (tkey !== this.lastTarget) {
      this.lastTarget = tkey;
      if (a.kind === 'none') this.target.innerHTML = '';
      else {
        const unknown = !a.scanned && (a.kind === 'creature' || a.kind === 'flora');
        const action = a.kind === 'deposit' ? (s.tool === 'mining' ? 'Hold LMB to mine' : 'Switch to the mining beam [1]') : unknown ? (s.tool === 'scanner' ? 'Hold LMB to scan' : 'Switch to the scanner [2]') : 'Catalogued';
        this.target.innerHTML = `<b>${unknown ? 'Unknown lifeform' : a.name}</b><small>${unknown ? a.detail.split('·')[0] : a.detail}</small><em>${Math.round(a.distance)} m · ${action}</em>`;
      }
    }
    this.target.classList.toggle('show', a.kind !== 'none');
    const circ = 2 * Math.PI * 15;
    this.ring.setAttribute('stroke-dasharray', `${(a.progress * circ).toFixed(1)} 999`);
    // Gauges.
    const bar = (label: string, v: number, cls: string, warn = false) =>
      `<div class="g ${cls}${warn ? ' warn' : ''}"><span>${label}</span><div><i style="width:${Math.round(Math.max(0, v) * 100)}%"></i></div></div>`;
    this.gauges.innerHTML =
      bar(`${s.hazard.label}${s.hazard.active ? '' : ' · recharging'}`, s.hazard.protection, 'hz', s.hazard.protection < 0.25) +
      bar('Health', s.health, 'hp', s.health < 0.5) +
      bar('Jetpack', s.jetpack, 'jp') +
      `<div class="cargo">HOLD ${s.cargo.used}/${s.cargo.capacity}</div>`;
    this.tool.innerHTML = `<div class="tn">${s.tool === 'mining' ? '<kbd>1</kbd> Mining beam' : '<kbd>2</kbd> Analysis scanner'}</div>
      ${s.tool === 'mining' ? `<div class="heat${s.overheated ? ' hot' : ''}"><i style="width:${Math.round(s.heat * 100)}%"></i></div><small>${s.overheated ? 'OVERHEATED' : 'Beam heat'}</small>` : '<small>Scan plants and animals for the codex</small>'}
      <div class="pulse">${s.pulse > 0 ? `Pulse scan ${Math.ceil(s.pulse)}s` : '<kbd>F</kbd> Pulse scan ready'}</div>`;
    this.prompt.textContent = s.prompt ?? '';
    this.prompt.classList.toggle('show', !!s.prompt && walk);
  }

  dispose(): void {
    this.root.remove();
    this.fade.remove();
    this.entry.remove();
  }
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
