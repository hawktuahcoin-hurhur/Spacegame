import { formatDistance, formatSpeed } from './format';

export interface MarkerData {
  id: string;
  kind: 'star' | 'body' | 'station' | 'system';
  name: string;
  x: number;
  y: number;
  distance: number;
  /** Overrides the formatted distance (e.g. light-years for other systems). */
  distanceText?: string;
  /** On-screen radius of the object (px), for brackets. */
  radiusPx: number;
  target: boolean;
}

export interface HudState {
  systemName: string;
  frameName: string;
  speed: number;
  mode: 'normal' | 'charging' | 'supercruise';
  charge: number;
  throttle: number;
  boosting: boolean;
  altitude: { text: string; warn: boolean } | null;
  target: {
    name: string;
    sub: string;
    rows: [string, string][];
    status: string;
    statusOn: boolean;
    /** Screen-edge arrow when the target is off-screen: angle in radians, or null. */
    edgeAngle: number | null;
    hyperspace: boolean;
  } | null;
  fuel: { value: number; capacity: number; scooping: number };
  supplies: { value: number; capacity: number };
  /** Large centre banner (jump countdown etc.). */
  banner: { title: string; sub: string } | null;
  /** Contextual action prompt, e.g. "[R] Resupply". */
  prompt: string | null;
  day: number;
  stick: { x: number; y: number };
  prograde: { x: number; y: number } | null;
  pointerLocked: boolean;
  fps: number;
  showFps: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.appendChild(e);
  return e;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent.appendChild(e);
  return e;
}

export class Hud {
  readonly root: HTMLDivElement;
  private readonly system: HTMLDivElement;
  private readonly frame: HTMLDivElement;
  private readonly speed: HTMLDivElement;
  private readonly mode: HTMLDivElement;
  private readonly charge: HTMLDivElement;
  private readonly chargeFill: HTMLDivElement;
  private readonly alt: HTMLDivElement;
  private readonly throttle: HTMLDivElement;
  private readonly throttleFill: HTMLDivElement;
  private readonly throttleLabel: HTMLDivElement;
  private readonly targetPanel: HTMLDivElement;
  private readonly corner: HTMLDivElement;
  private readonly toasts: HTMLDivElement;
  private readonly markersLayer: HTMLDivElement;
  private readonly markerEls = new Map<string, { root: HTMLDivElement; label: HTMLDivElement; brackets: HTMLDivElement; key: string }>();
  private readonly edgeArrow: HTMLDivElement;
  private readonly help: HTMLDivElement;
  private readonly prompt: HTMLDivElement;
  private readonly fuelFill: HTMLDivElement;
  private readonly fuelLabel: HTMLDivElement;
  private readonly supFill: HTMLDivElement;
  private readonly supLabel: HTMLDivElement;
  private readonly scoop: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly action: HTMLDivElement;
  private readonly hyper: HTMLDivElement;
  private readonly flash: HTMLDivElement;
  private readonly stickLine: SVGLineElement;
  private readonly stickDot: SVGCircleElement;
  private readonly prograde: SVGGElement;
  private readonly reticle: SVGGElement;
  private lastToast = '';
  private lastToastTime = 0;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud', parent);
    this.markersLayer = el('div', 'markers', this.root);

    const svgRoot = svg('svg', { class: 'hud-svg' }, this.root);
    this.reticle = svg('g', {}, svgRoot);
    svg('circle', { r: 16, fill: 'none', stroke: 'rgba(159,227,255,0.55)', 'stroke-width': 1 }, this.reticle);
    for (const [x1, y1, x2, y2] of [
      [-26, 0, -19, 0],
      [19, 0, 26, 0],
      [0, -26, 0, -19],
      [0, 19, 0, 26],
    ]) {
      svg('line', { x1, y1, x2, y2, stroke: 'rgba(159,227,255,0.8)', 'stroke-width': 1.5 }, this.reticle);
    }
    svg('circle', { r: 1.5, fill: 'rgba(159,227,255,0.9)' }, this.reticle);
    this.stickLine = svg('line', { stroke: 'rgba(159,227,255,0.35)', 'stroke-width': 1 }, svgRoot);
    this.stickDot = svg('circle', { r: 4, fill: 'none', stroke: 'rgba(255,181,71,0.9)', 'stroke-width': 1.5 }, svgRoot);
    this.prograde = svg('g', {}, svgRoot);
    svg('circle', { r: 7, fill: 'none', stroke: 'rgba(109,255,176,0.85)', 'stroke-width': 1.5 }, this.prograde);
    for (const [x1, y1, x2, y2] of [
      [-13, 0, -7, 0],
      [7, 0, 13, 0],
      [0, -13, 0, -7],
    ]) {
      svg('line', { x1, y1, x2, y2, stroke: 'rgba(109,255,176,0.85)', 'stroke-width': 1.5 }, this.prograde);
    }

    const top = el('div', 'hud-top', this.root);
    this.system = el('div', 'hud-system', top);
    this.frame = el('div', 'hud-frame', top);

    const bottom = el('div', 'hud-bottom', this.root);
    this.speed = el('div', 'hud-speed', bottom);
    this.mode = el('div', 'hud-mode', bottom);
    this.charge = el('div', 'hud-charge', bottom);
    this.chargeFill = el('div', '', this.charge);
    this.alt = el('div', 'hud-alt', bottom);

    this.throttle = el('div', 'hud-throttle', this.root);
    this.throttleFill = el('div', 'fill', this.throttle);
    this.throttleLabel = el('div', 'label', this.throttle);
    for (const f of [0.25, 0.5, 0.75]) {
      const t = el('div', 'tick', this.throttle);
      t.style.bottom = `${f * 100}%`;
    }

    const res = el('div', 'hud-resources', this.root);
    const fuelRow = el('div', 'res-row', res);
    el('span', 'res-name', fuelRow).textContent = 'FUEL';
    const fuelBar = el('div', 'res-bar fuel', fuelRow);
    this.fuelFill = el('div', '', fuelBar);
    this.fuelLabel = el('div', 'res-val', fuelRow);
    const supRow = el('div', 'res-row', res);
    el('span', 'res-name', supRow).textContent = 'SUPPLY';
    const supBar = el('div', 'res-bar sup', supRow);
    this.supFill = el('div', '', supBar);
    this.supLabel = el('div', 'res-val', supRow);
    this.scoop = el('div', 'res-scoop', res);

    this.banner = el('div', 'hud-banner hidden', this.root);
    this.action = el('div', 'hud-action hidden', this.root);
    this.hyper = el('div', 'hyper-overlay hidden', document.body);
    this.flash = el('div', 'flash', document.body);

    this.targetPanel = el('div', 'hud-target', this.root);
    this.corner = el('div', 'hud-corner', this.root);
    this.toasts = el('div', 'toasts', this.root);
    this.edgeArrow = el('div', 'edge-arrow', this.root);

    this.help = el('div', 'help', this.root);
    this.help.innerHTML = `
      <h4>FLIGHT CONTROLS</h4>
      <div><kbd>Mouse</kbd>Steer (virtual stick)</div>
      <div><kbd>W</kbd><kbd>S</kbd>Throttle up / down · <kbd>X</kbd>Cut</div>
      <div><kbd>A</kbd><kbd>D</kbd>Strafe · <kbd>Space</kbd><kbd>Ctrl</kbd>Up / down</div>
      <div><kbd>Q</kbd><kbd>E</kbd>Roll · <kbd>Shift</kbd>Boost</div>
      <div><kbd>J</kbd>Supercruise · hyperjump if a system is targeted</div>
      <div><kbd>T</kbd>Target ahead · <kbd>[</kbd><kbd>]</kbd>Cycle targets</div>
      <div><kbd>G</kbd>Auto-align to target</div>
      <div><kbd>M</kbd>System map · <kbd>N</kbd>Galaxy map</div>
      <div><kbd>R</kbd>Resupply at station · <kbd>C</kbd>Camera</div>
      <div><kbd>F5</kbd>Quicksave · <kbd>F9</kbd>Quickload · <kbd>Esc</kbd>Menu</div>
      <div><kbd>F3</kbd>Stats · <kbd>F4</kbd>Quality · <kbd>F6</kbd>Mute · <kbd>H</kbd>Help</div>`;

    this.prompt = el('div', 'prompt', this.root);
    this.prompt.textContent = 'Click to take the helm';
  }

  setHelp(show: boolean): void {
    this.help.classList.toggle('show', show);
  }

  get helpVisible(): boolean {
    return this.help.classList.contains('show');
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }

  /** Full-screen hyperspace caption. */
  setHyperspace(info: { dest: string; detail: string } | null): void {
    this.hyper.classList.toggle('hidden', !info);
    if (info) this.hyper.innerHTML = `<div class="h-label">HYPERSPACE</div><div class="h-dest">${info.dest}</div><div class="h-detail">${info.detail}</div>`;
  }

  /** White-out flash, e.g. at hyperspace exit. */
  flashScreen(duration = 900): void {
    this.flash.style.transition = 'none';
    this.flash.style.opacity = '1';
    void this.flash.offsetWidth;
    this.flash.style.transition = `opacity ${duration}ms ease-out`;
    this.flash.style.opacity = '0';
  }

  dispose(): void {
    this.root.remove();
    this.hyper.remove();
    this.flash.remove();
  }

  toast(text: string, kind: '' | 'warn' | 'good' = ''): void {
    const now = performance.now();
    if (text === this.lastToast && now - this.lastToastTime < 1500) return;
    this.lastToast = text;
    this.lastToastTime = now;
    const t = el('div', `toast ${kind}`, this.toasts);
    t.textContent = text;
    while (this.toasts.children.length > 4) this.toasts.firstChild!.remove();
    setTimeout(() => t.classList.add('out'), 2600);
    setTimeout(() => t.remove(), 3300);
  }

  update(s: HudState, markers: MarkerData[], width: number, height: number): void {
    const cx = width / 2;
    const cy = height / 2;
    this.system.textContent = s.systemName;
    this.frame.textContent = s.frameName;

    const sp = formatSpeed(s.speed);
    this.speed.innerHTML = `${sp.value}<small>${sp.unit}</small>`;
    this.mode.className = `hud-mode ${s.mode === 'supercruise' ? 'sc' : s.mode === 'charging' ? 'charging' : ''}`;
    this.mode.textContent =
      s.mode === 'supercruise' ? 'Supercruise' : s.mode === 'charging' ? 'Frame shift charging' : s.boosting ? 'Boost' : 'Normal flight';
    this.charge.classList.toggle('show', s.mode === 'charging');
    this.chargeFill.style.width = `${(s.charge * 100).toFixed(1)}%`;
    this.alt.textContent = s.altitude?.text ?? '';
    this.alt.classList.toggle('warn', !!s.altitude?.warn);

    this.throttle.classList.toggle('sc', s.mode === 'supercruise');
    this.throttleFill.style.height = `calc(${(s.throttle * 100).toFixed(1)}% - 4px)`;
    this.throttleLabel.textContent = `${Math.round(s.throttle * 100)}%`;
    this.throttleLabel.style.bottom = `${s.throttle * 100}%`;

    this.reticle.setAttribute('transform', `translate(${cx},${cy})`);
    const sx = cx + s.stick.x * 90;
    const sy = cy + s.stick.y * 90;
    this.stickLine.setAttribute('x1', String(cx));
    this.stickLine.setAttribute('y1', String(cy));
    this.stickLine.setAttribute('x2', String(sx));
    this.stickLine.setAttribute('y2', String(sy));
    this.stickDot.setAttribute('cx', String(sx));
    this.stickDot.setAttribute('cy', String(sy));
    if (s.prograde) {
      this.prograde.style.display = '';
      this.prograde.setAttribute('transform', `translate(${s.prograde.x},${s.prograde.y})`);
    } else this.prograde.style.display = 'none';

    const t = s.target;
    this.targetPanel.classList.toggle('show', !!t);
    this.targetPanel.classList.toggle('hyper', !!t?.hyperspace);
    if (t) {
      this.targetPanel.innerHTML = `<h3>${t.name}</h3><div class="sub">${t.sub}</div>${t.rows
        .map(([a, b]) => `<div class="row"><span>${a}</span><span>${b}</span></div>`)
        .join('')}<div class="align ${t.statusOn ? 'on' : ''}">${t.status}</div>`;
      if (t.edgeAngle !== null) {
        const r = Math.min(cx, cy) - 40;
        const ex = cx + Math.cos(t.edgeAngle) * r;
        const ey = cy + Math.sin(t.edgeAngle) * r;
        this.edgeArrow.style.display = 'block';
        this.edgeArrow.style.transform = `translate(${ex - 9}px, ${ey - 8}px) rotate(${t.edgeAngle + Math.PI / 2}rad)`;
      } else this.edgeArrow.style.display = 'none';
    } else this.edgeArrow.style.display = 'none';

    const fuelFrac = s.fuel.value / s.fuel.capacity;
    this.fuelFill.style.width = `${(fuelFrac * 100).toFixed(1)}%`;
    this.fuelFill.parentElement!.classList.toggle('low', fuelFrac < 0.25);
    this.fuelLabel.textContent = `${s.fuel.value.toFixed(1)} t`;
    this.supFill.style.width = `${((s.supplies.value / s.supplies.capacity) * 100).toFixed(1)}%`;
    this.supLabel.textContent = `${Math.floor(s.supplies.value)}`;
    this.scoop.textContent = s.fuel.scooping > 0 ? `▲ SCOOPING +${s.fuel.scooping.toFixed(2)} t/s` : '';
    this.banner.classList.toggle('hidden', !s.banner);
    if (s.banner) this.banner.innerHTML = `<div class="b-title">${s.banner.title}</div><div class="b-sub">${s.banner.sub}</div>`;
    this.action.classList.toggle('hidden', !s.prompt);
    if (s.prompt) this.action.textContent = s.prompt;

    this.corner.innerHTML = `${s.showFps ? `${s.fps.toFixed(0)} FPS<br>` : ''}DAY ${s.day}<br>[H] CONTROLS · [M] SYSTEM · [N] GALAXY`;
    this.prompt.classList.toggle('hidden', s.pointerLocked);

    this.updateMarkers(markers);
  }

  private updateMarkers(markers: MarkerData[]): void {
    const seen = new Set<string>();
    for (const m of markers) {
      seen.add(m.id);
      let e = this.markerEls.get(m.id);
      if (!e) {
        const root = el('div', `marker ${m.kind}`, this.markersLayer);
        const brackets = el('div', 'brackets', root);
        el('div', 'icon', root);
        const label = el('div', 'label', root);
        e = { root, label, brackets, key: '' };
        this.markerEls.set(m.id, e);
      }
      e.root.classList.toggle('target', m.target);
      e.root.style.transform = `translate(${m.x.toFixed(1)}px, ${m.y.toFixed(1)}px)`;
      const big = m.radiusPx > 14;
      const r = Math.min(m.radiusPx + 6, 4000);
      e.brackets.style.display = big ? '' : 'none';
      if (big) {
        e.brackets.style.left = `${-r}px`;
        e.brackets.style.top = `${-r}px`;
        e.brackets.style.width = `${2 * r}px`;
        e.brackets.style.height = `${2 * r}px`;
      }
      (e.root.children[1] as HTMLElement).style.display = big ? 'none' : '';
      const dist = m.distanceText ?? formatDistance(m.distance);
      const key = `${m.name}|${dist}`;
      if (key !== e.key) {
        e.key = key;
        e.label.innerHTML = `<b>${m.name}</b><i>${dist}</i>`;
      }
      e.label.style.left = big ? `${Math.min(r, 260) + 6}px` : '10px';
      e.label.style.top = big ? `${-Math.min(r, 260)}px` : '-8px';
    }
    for (const [id, e] of this.markerEls) {
      if (!seen.has(id)) {
        e.root.remove();
        this.markerEls.delete(id);
      }
    }
  }
}
