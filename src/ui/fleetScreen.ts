import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Rng } from '../core/rng';
import type { PlayerState } from '../player';
import type { RenderPipeline } from '../render/pipeline';
import { HULLMODS, type HullDef, type Loadout, type SlotDef, type WeaponDef, hull as hullDef, weapon as weaponDef } from '../ships/defs';
import {
  MAX_VENTS,
  type ShipStats,
  autofit,
  cloneLoadout,
  compatibleWeapons,
  computeStats,
  emptyLoadout,
  defaultLoadout,
  hullmodCost,
  hullmodIncompatibility,
  opUsed,
} from '../ships/fitting';
import { MAX_CR, MAX_FLEET_SIZE, RESALE_FACTOR, type ShipInstance, createShip, fleetLogistics, shipName } from '../ships/fleet';
import { type ShipVisual, buildShip } from '../ships/shipBuilder';
import { FACTIONS } from '../campaign/defs';
import { rep as repOf } from '../campaign/trade';
import { type StationContext, renderBar, renderMarket, renderStationInfo } from './stationTabs';

export type FleetTab = 'fleet' | 'market' | 'bar' | 'shipyard' | 'services';

export interface DockInfo {
  stationName: string;
  stock: string[];
}

export interface FleetScreenHost {
  player: PlayerState;
  /** Non-null while docked at a station (refit, shipyard and services available). */
  dock: DockInfo | null;
  /** Called after any change to the fleet (refit, purchase, flagship…). */
  fleetChanged(): void;
  refuel(): void;
  /** Launch a no-risk combat simulation against a pirate fleet. */
  simulate(): void;
  /** Market, bar and politics of the station you're docked at. */
  station: StationContext | null;
  /** Cost to top up fuel and supplies here. */
  refuelCost(): number;
  /** Unsold exploration data and its value here. */
  dataValue(): { count: number; value: number };
  sellData(): void;
  toast(msg: string, kind?: '' | 'warn' | 'good'): void;
  close(): void;
}

const TYPE_COLOR: Record<string, string> = {
  ballistic: '#ffc65c',
  energy: '#5fd4ff',
  missile: '#7dff9a',
  universal: '#ffffff',
  hybrid: '#ffa98a',
  composite: '#d8ff7a',
  synergy: '#9be7d2',
};
const DMG_LABEL: Record<string, string> = { kinetic: 'Kinetic', he: 'High explosive', energy: 'Energy', frag: 'Fragmentation' };
const credits = (n: number) => `¢${Math.round(n).toLocaleString()}`;

const isDmod = (id: string) => !!HULLMODS.find((m) => m.id === id)?.dmod;

/** Credits to bring every ship back to full hull and peak readiness. */
export function repairCost(ships: ShipInstance[]): number {
  let c = 0;
  for (const s of ships) {
    const h = hullDef(s.loadout.hullId);
    c += (1 - (s.hull ?? 1)) * h.cost * 0.12 + Math.max(0, MAX_CR - (s.cr ?? MAX_CR)) * h.cost * 0.06;
  }
  return Math.round(c / 50) * 50;
}

/** Credits to strip every d-mod from a hull. */
export function restoreCost(s: ShipInstance): number {
  const n = s.loadout.hullmods.filter((m) => isDmod(m)).length;
  return Math.round((hullDef(s.loadout.hullId).cost * 0.18 * n) / 100) * 100;
}

/** Hull and readiness bars for a fleet card. */
function shipCondition(s: ShipInstance): string {
  const hull = s.hull ?? 1;
  const cr = s.cr ?? MAX_CR;
  const dm = s.loadout.hullmods.filter((m) => isDmod(m)).length;
  return `<div class="fs-cond"><span class="hb" title="Hull integrity"><i style="width:${hull * 100}%"></i></span><em>HULL ${Math.round(hull * 100)}%</em>
    <span class="cb" title="Combat readiness"><i style="width:${(cr / MAX_CR) * 100}%"></i></span><em class="${cr < 0.4 ? 'bad' : ''}">CR ${Math.round(cr * 100)}%</em>${dm ? `<b>${dm} D-MOD${dm > 1 ? 'S' : ''}</b>` : ''}</div>`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
}

/** Studio scene for the 3D ship preview. */
class RefitView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(32, 1, 0.1, 5000);
  readonly controls: OrbitControls;
  ship: ShipVisual | null = null;
  private arc: THREE.Mesh | null = null;
  private readonly floor: THREE.Mesh;
  private idle = 0;
  private key = '';

  constructor(renderer: THREE.WebGLRenderer) {
    this.scene.background = new THREE.Color('#05080e');
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
    const key = new THREE.DirectionalLight('#fff1dc', 3.2);
    key.position.set(-1, 1.4, 0.8);
    const rim = new THREE.DirectionalLight('#6fb8ff', 2.2);
    rim.position.set(1, 0.4, -1.2);
    this.scene.add(key, rim, new THREE.HemisphereLight('#36507a', '#120c08', 0.5));
    // Holographic floor rings.
    const ringMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color('#1d5e94') } },
      vertexShader: `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
#include <logdepthbuf_vertex>
}`,
      fragmentShader: `#include <logdepthbuf_pars_fragment>
varying vec2 vUv; uniform vec3 uColor; void main(){
#include <logdepthbuf_fragment>
float r = length(vUv*2.0-1.0); float rings = smoothstep(0.03,0.0,abs(fract(r*6.0)-0.5)-0.46);
float a = (rings*0.35 + smoothstep(1.0,0.0,r)*0.025) * smoothstep(1.0,0.85,r); gl_FragColor = vec4(uColor*a, 1.0); }`,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), ringMat);
    this.scene.add(this.floor);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.enabled = false;
    this.controls.addEventListener('start', () => (this.idle = -4));
  }

  setLoadout(l: Loadout): void {
    const key = JSON.stringify(l);
    if (key === this.key) return;
    const first = !this.ship;
    const prevHull = this.ship?.hull.id;
    this.key = key;
    if (this.ship) {
      this.scene.remove(this.ship.root);
      this.ship.dispose();
    }
    this.ship = buildShip(l, { showEmptySlots: true });
    this.ship.update(0, 0, 0.35, false, 0, 0, 0);
    this.scene.add(this.ship.root);
    const r = this.ship.radius;
    this.floor.scale.setScalar(r * 1.3);
    this.floor.position.y = -r * 0.35;
    this.controls.minDistance = r * 1.4;
    this.controls.maxDistance = r * 6;
    if (first || prevHull !== l.hullId) {
      this.controls.target.set(0, 0, 0);
      this.camera.position.set(r * 1.7, r * 1.15, r * 2.1);
    }
    this.showArc(null);
  }

  showArc(slot: SlotDef | null): void {
    if (this.arc) {
      this.scene.remove(this.arc);
      this.arc.geometry.dispose();
      (this.arc.material as THREE.Material).dispose();
      this.arc = null;
    }
    if (!slot || !this.ship) return;
    const r = Math.max(this.ship.radius * 0.45, 5);
    const arc = THREE.MathUtils.degToRad(Math.min(slot.arc, 359.9));
    // Ring geometry starts at +X and sweeps CCW in XY; rotate so 0° is the slot's facing (-Z).
    const geo = new THREE.RingGeometry(r * 0.12, r, 48, 1, Math.PI / 2 - arc / 2, arc).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(TYPE_COLOR[slot.type]).multiplyScalar(0.35), transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    this.arc = new THREE.Mesh(geo, mat);
    this.arc.position.copy(this.ship.slotPosition(slot.id));
    this.arc.rotation.y = THREE.MathUtils.degToRad(slot.angle);
    if (slot.zone === 'ventral') this.arc.position.y -= 0.05;
    this.scene.add(this.arc);
  }

  update(dt: number, time: number, viewOffset: { left: number; right: number; bottom: number }): void {
    this.idle += dt;
    if (this.ship) {
      if (this.idle > 0) this.ship.root.rotation.y += dt * 0.12;
      this.ship.update(dt, time, 0.35, false, 0, 0, 0);
    }
    this.controls.update();
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    // Centre the ship in the free area between the side panels.
    this.camera.setViewOffset(w, h, (viewOffset.left - viewOffset.right) / -2, viewOffset.bottom / 2 - 30, w, h);
    this.camera.updateProjectionMatrix();
  }

  /** Screen position of a slot (for HTML markers). */
  slotScreen(slotId: string): { x: number; y: number; visible: boolean } {
    if (!this.ship) return { x: 0, y: 0, visible: false };
    const p = this.ship.slotPosition(slotId).applyMatrix4(this.ship.root.matrixWorld).project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * window.innerWidth, y: (-p.y * 0.5 + 0.5) * window.innerHeight, visible: p.z < 1 };
  }

  dispose(): void {
    this.controls.dispose();
    this.ship?.dispose();
  }
}

export class FleetScreen {
  open = false;
  private tab: FleetTab = 'fleet';
  private editTab: 'weapons' | 'hullmods' | 'flux' = 'weapons';
  private selectedShipId: string | null = null;
  private selectedSlot: string | null = null;
  private yardHull: string | null = null;
  private readonly root: HTMLDivElement;
  private readonly header: HTMLDivElement;
  private readonly left: HTMLDivElement;
  private readonly right: HTMLDivElement;
  private readonly bottom: HTMLDivElement;
  private readonly markers: HTMLDivElement;
  /** Full-width panel for the market and bar. */
  private readonly full: HTMLDivElement;
  private readonly view: RefitView;
  private markerEls = new Map<string, HTMLButtonElement>();

  constructor(
    private readonly pipeline: RenderPipeline,
    private readonly host: FleetScreenHost,
  ) {
    this.view = new RefitView(pipeline.renderer);
    this.root = el('div', 'fs hidden', document.body);
    this.root.addEventListener('keydown', (e) => e.stopPropagation());
    this.header = el('div', 'fs-header', this.root);
    this.left = el('div', 'fs-left', this.root);
    this.right = el('div', 'fs-right', this.root);
    this.bottom = el('div', 'fs-bottom', this.root);
    this.markers = el('div', 'fs-markers', this.root);
    this.full = el('div', 'fs-full hidden', this.root);
  }

  private get player(): PlayerState {
    return this.host.player;
  }

  private get canEdit(): boolean {
    return !!this.host.dock;
  }

  private get ship(): ShipInstance | null {
    return this.player.fleet.ships.find((s) => s.id === this.selectedShipId) ?? null;
  }

  show(tab: FleetTab = 'fleet'): void {
    this.open = true;
    this.view.controls.enabled = true;
    this.root.classList.remove('hidden');
    this.tab = !this.host.dock && tab !== 'fleet' ? 'fleet' : tab;
    if (!this.ship) this.selectedShipId = this.player.fleet.flagshipId;
    this.selectedSlot = null;
    this.refresh();
  }

  hide(): void {
    this.open = false;
    this.view.controls.enabled = false;
    this.root.classList.add('hidden');
  }

  /** Re-render all panels from current state. */
  refresh(): void {
    this.renderHeader();
    const fullTab = this.tab === 'market' || this.tab === 'bar';
    this.full.classList.toggle('hidden', !fullTab);
    this.right.classList.toggle('hidden', fullTab);
    this.bottom.classList.toggle('hidden', fullTab);
    this.markers.classList.toggle('hidden', fullTab);
    const st = this.host.station;
    if (fullTab && st) {
      const scroll = this.full.scrollTop;
      if (this.tab === 'market') {
        renderStationInfo(this.left, st);
        renderMarket(this.full, st);
      } else renderBar(this.left, this.full, st);
      this.full.scrollTop = scroll;
      return;
    }
    if (this.tab === 'fleet') this.renderFleetTab();
    else if (this.tab === 'shipyard') this.renderShipyardTab();
    else this.renderServicesTab();
  }

  private commit(): void {
    this.host.fleetChanged();
    this.refresh();
  }

  // ------------------------------------------------------------ header

  private renderHeader(): void {
    const dock = this.host.dock;
    const tabs: [FleetTab, string][] = [
      ['fleet', 'Fleet & Refit'],
      ['market', 'Market'],
      ['bar', 'Bar'],
      ['shipyard', 'Shipyard'],
      ['services', 'Services'],
    ];
    this.header.innerHTML = `
      <div class="fs-title">${dock ? dock.stationName : 'Fleet command'}<small>${dock ? 'Docked' : 'In flight — dock at a station to refit or trade'}</small></div>
      <div class="fs-tabs">${tabs
        .map(([id, label]) => `<button data-tab="${id}" class="${this.tab === id ? 'on' : ''}" ${!dock && id !== 'fleet' ? 'disabled' : ''}>${label}</button>`)
        .join('')}</div>
      <div class="fs-credits">${credits(this.player.credits)}</div>
      <button class="fs-close" title="Close (Esc)">✕</button>`;
    this.header.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        this.tab = b.dataset.tab as FleetTab;
        this.selectedSlot = null;
        this.refresh();
      }),
    );
    this.header.querySelector('.fs-close')!.addEventListener('click', () => this.host.close());
  }

  // ------------------------------------------------------------ fleet & refit

  private renderFleetTab(): void {
    const fleet = this.player.fleet;
    const lg = fleetLogistics(fleet);
    this.left.innerHTML = `<h3>Fleet <span>${fleet.ships.length}/${MAX_FLEET_SIZE}</span></h3>
      <div class="fs-roster">${fleet.ships
        .map((s) => {
          const h = hullDef(s.loadout.hullId);
          const st = computeStats(s.loadout);
          const flag = s.id === fleet.flagshipId;
          return `<div class="fs-card ${s.id === this.selectedShipId ? 'on' : ''}" data-ship="${s.id}">
            <div class="n">${flag ? '<span class="star" title="Flagship">★</span>' : ''}${s.name}</div>
            <div class="h">${h.name} · ${h.designation}</div>
            <div class="op"><div style="width:${((st.opUsed / st.opMax) * 100).toFixed(0)}%"></div></div>
            <div class="mini"><span>${st.opUsed}/${st.opMax} OP</span><span>${Math.round(st.dps.total)} DPS</span></div>
            ${shipCondition(s)}
          </div>`;
        })
        .join('')}</div>
      <div class="fs-logi">
        <div><span>Fuel</span><b>${Math.round(this.player.fuel)} / ${lg.fuelCapacity} t</b></div>
        <div><span>Supplies</span><b>${Math.round(this.player.supplies)} / ${lg.suppliesCapacity}</b></div>
        <div><span>Jump range</span><b>${lg.jumpRange} ly</b></div>
        <div><span>Fuel per jump</span><b>×${lg.fuelMultiplier.toFixed(1)}</b></div>
        <div><span>Supplies per jump</span><b>${lg.suppliesPerJump}</b></div>
      </div>`;
    this.left.querySelectorAll<HTMLElement>('[data-ship]').forEach((c) =>
      c.addEventListener('click', () => {
        this.selectedShipId = c.dataset.ship!;
        this.selectedSlot = null;
        this.refresh();
      }),
    );
    const ship = this.ship;
    if (!ship) return;
    this.view.setLoadout(ship.loadout);
    this.renderStats(computeStats(ship.loadout));
    this.renderEditor(ship);
    this.buildMarkers(hullDef(ship.loadout.hullId));
  }

  private renderEditor(ship: ShipInstance): void {
    const h = hullDef(ship.loadout.hullId);
    const isFlag = ship.id === this.player.fleet.flagshipId;
    const dock = this.host.dock;
    const dmods = ship.loadout.hullmods.filter((m) => isDmod(m)).length;
    const resale = Math.round(h.cost * RESALE_FACTOR * Math.max(0.4, 1 - dmods * 0.12));
    const lock = this.canEdit ? '' : '<div class="fs-lock">Viewing only — dock at a station to refit</div>';
    this.bottom.innerHTML = `
      <div class="fs-shiphead">
        <input class="fs-name" value="${ship.name.replace(/"/g, '&quot;')}" ${this.canEdit ? '' : 'disabled'} maxlength="28" />
        <span class="fs-hullname">${h.name}-class ${h.designation} · ${h.manufacturer}</span>
        <div class="fs-actions">
          <button data-act="autofit" ${this.canEdit ? '' : 'disabled'} title="Fit sensible weapons automatically">Autofit</button>
          <button data-act="stock" ${this.canEdit ? '' : 'disabled'} title="Restore the factory loadout">Stock</button>
          <button data-act="strip" ${this.canEdit ? '' : 'disabled'} title="Remove everything">Strip</button>
          <button data-act="flag" ${isFlag || !dock ? 'disabled' : ''}>${isFlag ? '★ Flagship' : 'Make flagship'}</button>
          <button data-act="sell" class="danger" ${isFlag || !dock ? 'disabled' : ''} title="${isFlag ? "Can't sell your flagship" : `Sell for ${credits(resale)}`}">Sell ${isFlag ? '' : credits(resale)}</button>
        </div>
      </div>
      ${lock}
      <div class="fs-edittabs">
        ${(['weapons', 'hullmods', 'flux'] as const)
          .map((t) => `<button data-et="${t}" class="${this.editTab === t ? 'on' : ''}">${t === 'weapons' ? 'Weapons' : t === 'hullmods' ? 'Hullmods' : 'Flux · vents & capacitors'}</button>`)
          .join('')}
      </div>
      <div class="fs-editbody"></div>`;
    const body = this.bottom.querySelector<HTMLDivElement>('.fs-editbody')!;
    if (this.editTab === 'weapons') this.renderWeapons(body, ship);
    else if (this.editTab === 'hullmods') this.renderHullmods(body, ship);
    else this.renderFlux(body, ship);

    this.bottom.querySelectorAll<HTMLButtonElement>('[data-et]').forEach((b) =>
      b.addEventListener('click', () => {
        this.editTab = b.dataset.et as typeof this.editTab;
        this.refresh();
      }),
    );
    const name = this.bottom.querySelector<HTMLInputElement>('.fs-name')!;
    name.addEventListener('change', () => {
      ship.name = name.value.trim() || ship.name;
      this.commit();
    });
    const act = (a: string, fn: () => void) => this.bottom.querySelector(`[data-act=${a}]`)?.addEventListener('click', fn);
    act('autofit', () => {
      ship.loadout = autofit(h.id, ship.loadout.hullmods);
      this.host.toast('Autofit complete');
      this.commit();
    });
    // D-mods are part of the hull, not the fit: they survive stock and strip.
    const dm = ship.loadout.hullmods.filter((m) => isDmod(m));
    act('stock', () => {
      const l = defaultLoadout(h.id);
      ship.loadout = { ...l, hullmods: [...l.hullmods, ...dm] };
      this.commit();
    });
    act('strip', () => {
      ship.loadout = { ...emptyLoadout(h.id), hullmods: [...dm] };
      this.commit();
    });
    act('flag', () => {
      this.player.fleet.flagshipId = ship.id;
      this.host.toast(`${ship.name} is now your flagship`, 'good');
      this.commit();
    });
    act('sell', () => {
      if (!confirm(`Sell ${ship.name} (${h.name}) for ${credits(resale)}?`)) return;
      this.player.fleet.ships = this.player.fleet.ships.filter((s) => s.id !== ship.id);
      this.player.credits += resale;
      this.selectedShipId = this.player.fleet.flagshipId;
      this.host.toast(`Sold ${ship.name} for ${credits(resale)}`, 'good');
      this.commit();
    });
  }

  private renderWeapons(body: HTMLDivElement, ship: ShipInstance): void {
    const h = hullDef(ship.loadout.hullId);
    const slots = h.slots;
    if (!this.selectedSlot || !slots.some((s) => s.id === this.selectedSlot)) this.selectedSlot = slots[0]?.id ?? null;
    const slot = slots.find((s) => s.id === this.selectedSlot)!;
    this.view.showArc(slot);
    const free = h.ordnancePoints - opUsed(ship.loadout);
    const current = ship.loadout.weapons[slot.id];
    const slotList = slots
      .map((s) => {
        const w = ship.loadout.weapons[s.id];
        return `<button class="fs-slot ${s.id === slot.id ? 'on' : ''}" data-slot="${s.id}">
          <span class="dot ${s.size}" style="--c:${TYPE_COLOR[s.type]}"></span>
          <span class="sid">${s.id}</span><span class="sw">${w ? weaponDef(w).name : '<i>empty</i>'}</span>
          <span class="st">${s.size} ${s.type} ${s.mount}</span></button>`;
      })
      .join('');
    const options = compatibleWeapons(slot).sort((a, b) => (b.size === slot.size ? 1 : 0) - (a.size === slot.size ? 1 : 0) || b.op - a.op);
    const row = (w: WeaponDef) => {
      const curOp = current ? weaponDef(current).op : 0;
      const need = w.op - curOp;
      const affordable = need <= free;
      const dps = w.kind === 'beam' ? w.damage : w.damage * w.rof;
      const flux = w.kind === 'beam' ? w.flux : w.flux * w.rof;
      return `<tr class="${w.id === current ? 'on' : ''} ${affordable && this.canEdit ? '' : 'off'}" data-w="${w.id}" title="${w.description}${affordable ? '' : ` — needs ${need - free} more OP`}">
        <td><span class="wt" style="--c:${TYPE_COLOR[w.type]}">${w.size}</span>${w.name}${w.pd ? ' <em>PD</em>' : ''}${w.guided ? ' <em>guided</em>' : ''}</td>
        <td class="dmg ${w.damageType}">${DMG_LABEL[w.damageType]}</td>
        <td>${w.op}</td><td>${Math.round(dps)}</td><td>${w.range}</td><td>${w.type === 'missile' ? `${w.ammo} ammo` : Math.round(flux)}</td></tr>`;
    };
    body.innerHTML = `<div class="fs-weapons">
      <div class="fs-slots">${slotList}</div>
      <div class="fs-wlist"><table>
        <thead><tr><th>Weapon · ${slot.size} ${slot.type} ${slot.mount}, ${slot.arc}° arc</th><th>Damage</th><th>OP</th><th>DPS</th><th>Range</th><th>Flux/s</th></tr></thead>
        <tbody>
          <tr class="${current ? '' : 'on'} ${this.canEdit ? '' : 'off'}" data-w=""><td><i>Empty slot</i></td><td></td><td>0</td><td></td><td></td><td></td></tr>
          ${options.map(row).join('')}
        </tbody></table></div></div>`;
    body.querySelectorAll<HTMLButtonElement>('[data-slot]').forEach((b) =>
      b.addEventListener('click', () => {
        this.selectedSlot = b.dataset.slot!;
        this.refresh();
      }),
    );
    body.querySelectorAll<HTMLTableRowElement>('tr[data-w]').forEach((tr) => {
      const id = tr.dataset.w || null;
      const tentative = () => {
        const l = cloneLoadout(ship.loadout);
        l.weapons[slot.id] = id;
        return l;
      };
      tr.addEventListener('mouseenter', () => this.previewStats(ship, tentative()));
      tr.addEventListener('mouseleave', () => this.previewStats(ship, null));
      tr.addEventListener('click', () => {
        if (!this.canEdit || tr.classList.contains('off')) return;
        ship.loadout = tentative();
        this.commit();
      });
    });
  }

  private renderHullmods(body: HTMLDivElement, ship: ShipInstance): void {
    const h = hullDef(ship.loadout.hullId);
    const free = h.ordnancePoints - opUsed(ship.loadout);
    const installedDmods = HULLMODS.filter((m) => m.dmod && ship.loadout.hullmods.includes(m.id));
    const dmodCards = installedDmods
      .map((m) => `<button class="fs-mod on dmod" disabled><div class="mn">${m.name}<span>D-MOD</span></div><div class="md">${m.description}</div><div class="mw">Permanent damage — restore the hull at a shipyard</div></button>`)
      .join('');
    const cards = dmodCards + HULLMODS.filter((m) => !m.dmod).map((m) => {
      const builtIn = h.builtInMods.includes(m.id);
      const on = builtIn || ship.loadout.hullmods.includes(m.id);
      const why = builtIn ? null : hullmodIncompatibility(m, h, ship.loadout.hullmods.filter((x) => x !== m.id));
      const cost = hullmodCost(m, h);
      const tooExpensive = !on && cost > free;
      const disabled = !this.canEdit || builtIn || !!why || tooExpensive;
      return `<button class="fs-mod ${on ? 'on' : ''} ${disabled ? 'off' : ''}" data-mod="${m.id}" ${disabled && !on ? 'disabled' : ''}>
        <div class="mn">${m.name}<span>${builtIn ? 'BUILT-IN' : `${cost} OP`}</span></div>
        <div class="md">${m.description}</div>
        ${why && !builtIn ? `<div class="mw">${why}</div>` : tooExpensive ? `<div class="mw">Needs ${cost - free} more OP</div>` : ''}
      </button>`;
    }).join('');
    body.innerHTML = `<div class="fs-mods">${cards}</div>`;
    body.querySelectorAll<HTMLButtonElement>('[data-mod]').forEach((b) => {
      const id = b.dataset.mod!;
      const toggled = () => {
        const l = cloneLoadout(ship.loadout);
        l.hullmods = l.hullmods.includes(id) ? l.hullmods.filter((x) => x !== id) : [...l.hullmods, id];
        return l;
      };
      b.addEventListener('mouseenter', () => !b.classList.contains('off') && this.previewStats(ship, toggled()));
      b.addEventListener('mouseleave', () => this.previewStats(ship, null));
      b.addEventListener('click', () => {
        if (b.classList.contains('off') && !ship.loadout.hullmods.includes(id)) return;
        if (!this.canEdit || h.builtInMods.includes(id)) return;
        ship.loadout = toggled();
        this.commit();
      });
    });
  }

  private renderFlux(body: HTMLDivElement, ship: ShipInstance): void {
    const h = hullDef(ship.loadout.hullId);
    const l = ship.loadout;
    const max = MAX_VENTS[h.size];
    const free = h.ordnancePoints - opUsed(l);
    const st = computeStats(l);
    const stepper = (key: 'vents' | 'capacitors', label: string, effect: string) => `
      <div class="fs-step">
        <div class="sl">${label}<small>${effect}</small></div>
        <div class="sb">
          <button data-k="${key}" data-d="-5">−5</button><button data-k="${key}" data-d="-1">−</button>
          <div class="sv"><b>${l[key]}</b>/${max}<div class="bar"><div style="width:${(l[key] / max) * 100}%"></div></div></div>
          <button data-k="${key}" data-d="1">+</button><button data-k="${key}" data-d="5">+5</button>
        </div>
      </div>`;
    body.innerHTML = `<div class="fs-flux">
      ${stepper('vents', 'Flux vents', `+10 dissipation each · now ${st.fluxDissipation}/s`)}
      ${stepper('capacitors', 'Flux capacitors', `+200 capacity each · now ${st.fluxCapacity}`)}
      <div class="fs-fluxinfo">
        <div>Free OP <b>${free}</b></div>
        <div>Weapons generate <b>${Math.round(st.weaponFlux)}/s</b> against <b>${st.fluxDissipation}/s</b> dissipation</div>
        <div class="${st.fluxBalance >= 0 ? 'good' : 'bad'}">${st.fluxBalance >= 0 ? 'Flux-neutral: can fire everything indefinitely' : `Flux-positive by ${Math.round(-st.fluxBalance)}/s — sustained fire will overload in ${Math.round(st.fluxCapacity / -st.fluxBalance)} s`}</div>
        <button data-act="balance" ${this.canEdit ? '' : 'disabled'}>Balance: add vents until flux-neutral</button>
      </div></div>`;
    body.querySelectorAll<HTMLButtonElement>('[data-k]').forEach((b) =>
      b.addEventListener('click', () => {
        if (!this.canEdit) return;
        const key = b.dataset.k as 'vents' | 'capacitors';
        const d = Number(b.dataset.d);
        const next = cloneLoadout(l);
        next[key] = THREE.MathUtils.clamp(l[key] + d, 0, max);
        while (opUsed(next) > h.ordnancePoints && next[key] > l[key]) next[key]--;
        ship.loadout = next;
        this.commit();
      }),
    );
    body.querySelector('[data-act=balance]')?.addEventListener('click', () => {
      const next = cloneLoadout(l);
      while (computeStats(next).fluxBalance < 0 && next.vents < max && opUsed(next) < h.ordnancePoints) next.vents++;
      ship.loadout = next;
      this.commit();
    });
  }

  // ------------------------------------------------------------ stats

  private previewStats(ship: ShipInstance, l: Loadout | null): void {
    this.renderStats(computeStats(l ?? ship.loadout), l ? computeStats(ship.loadout) : null);
  }

  private renderStats(s: ShipStats, base: ShipStats | null = null): void {
    const delta = (v: number, b: number | undefined, lowerIsBetter = false, digits = 0) => {
      if (b === undefined || Math.abs(v - b) < 1e-6) return '';
      const better = lowerIsBetter ? v < b : v > b;
      return `<em class="${better ? 'up' : 'down'}">${v > b ? '+' : ''}${(v - b).toFixed(digits)}</em>`;
    };
    const row = (label: string, value: string, d = '') => `<div class="r"><span>${label}</span><b>${value}${d}</b></div>`;
    const dpsMax = Math.max(s.dps.total, base?.dps.total ?? 0, 1);
    const bar = (type: keyof typeof DMG_LABEL) =>
      `<div class="dps"><span>${DMG_LABEL[type]}</span><div class="bar ${type}"><div style="width:${(s.dps[type as 'kinetic'] / dpsMax) * 100}%"></div></div><b>${Math.round(s.dps[type as 'kinetic'])}</b></div>`;
    const over = s.opUsed > s.opMax;
    this.right.innerHTML = `
      <h3>${s.hull.name} <span>${s.hull.size}</span></h3>
      <div class="fs-op ${over ? 'over' : ''}"><div class="t">Ordnance points <b>${s.opUsed} / ${s.opMax}</b>${delta(s.opUsed, base?.opUsed, true)}</div>
        <div class="bar"><div style="width:${Math.min(100, (s.opUsed / s.opMax) * 100)}%"></div></div></div>
      <h4>Defence</h4>
      ${row('Hull', s.hitpoints.toLocaleString(), delta(s.hitpoints, base?.hitpoints))}
      ${row('Armour', s.armor.toLocaleString(), delta(s.armor, base?.armor))}
      ${row('Shield', s.shield ? `${s.shield.type} ${Math.round(s.shield.arc)}° · ${s.shield.efficiency.toFixed(2)}` : 'none', delta(s.shield?.efficiency ?? 0, base?.shield?.efficiency, true, 2))}
      ${row('Flux capacity', s.fluxCapacity.toLocaleString(), delta(s.fluxCapacity, base?.fluxCapacity))}
      ${row('Dissipation', `${s.fluxDissipation}/s`, delta(s.fluxDissipation, base?.fluxDissipation))}
      <h4>Offence</h4>
      ${bar('kinetic')}${bar('he')}${bar('energy')}${bar('frag')}
      ${row('Total DPS', `${Math.round(s.dps.total)}`, delta(s.dps.total, base?.dps.total))}
      ${row('Weapon flux', `${Math.round(s.weaponFlux)}/s`, delta(s.weaponFlux, base?.weaponFlux, true))}
      ${row('Flux balance', `<span class="${s.fluxBalance >= 0 ? 'good' : 'bad'}">${s.fluxBalance >= 0 ? '+' : ''}${Math.round(s.fluxBalance)}/s</span>`, delta(s.fluxBalance, base?.fluxBalance))}
      ${row('Range', s.rangeMax ? `${s.rangeMin}–${s.rangeMax} m` : '—', delta(s.rangeMax, base?.rangeMax))}
      ${row('Point defence', `${s.pointDefence}`)}
      <h4>Mobility & logistics</h4>
      ${row('Top speed', `${s.maxSpeed} m/s`, delta(s.maxSpeed, base?.maxSpeed))}
      ${row('Turn rate', `${Math.round(s.turnRate)}°/s`, delta(s.turnRate, base?.turnRate))}
      ${row('Cargo', s.cargo.toLocaleString(), delta(s.cargo, base?.cargo))}
      ${row('Fuel tank', `${s.fuel} t`, delta(s.fuel, base?.fuel))}
      ${row('Supplies/jump', `${s.suppliesPerJump}`, delta(s.suppliesPerJump, base?.suppliesPerJump, true, 1))}
      ${row('Fuel use', `×${s.fuelPerLY}`, delta(s.fuelPerLY, base?.fuelPerLY, true, 2))}
      ${row('Jump range', `${s.jumpRange} ly`, delta(s.jumpRange, base?.jumpRange))}
      ${row('Crew', `${s.crew[0]}–${s.crew[1]}`)}
      <div class="fs-system">Ship system: <b>${s.hull.shipSystem}</b></div>`;
  }

  // ------------------------------------------------------------ shipyard

  private renderShipyardTab(): void {
    const dock = this.host.dock!;
    this.view.showArc(null);
    if (!this.yardHull || !dock.stock.includes(this.yardHull)) this.yardHull = dock.stock[0];
    this.left.innerHTML = `<h3>For sale <span>${dock.stock.length} hulls</span></h3><div class="fs-roster">${dock.stock
      .map((id) => {
        const h = hullDef(id);
        return `<div class="fs-card ${id === this.yardHull ? 'on' : ''}" data-hull="${id}">
          <div class="n">${h.name}<span class="price">${credits(h.cost)}</span></div>
          <div class="h">${h.designation} · ${h.size} · ${h.manufacturer}</div></div>`;
      })
      .join('')}</div>`;
    this.left.querySelectorAll<HTMLElement>('[data-hull]').forEach((c) =>
      c.addEventListener('click', () => {
        this.yardHull = c.dataset.hull!;
        this.refresh();
      }),
    );
    const h = hullDef(this.yardHull);
    const stock = defaultLoadout(h.id);
    this.view.setLoadout(stock);
    this.renderStats(computeStats(stock));
    this.clearMarkers();
    const full = this.player.fleet.ships.length >= MAX_FLEET_SIZE;
    const poor = this.player.credits < h.cost;
    const locked = this.militaryLock(h.id);
    this.bottom.innerHTML = `<div class="fs-yard">
      <div class="yh"><h2>${h.name}<small>${h.designation} · ${h.manufacturer}</small></h2><p>${h.description}</p></div>
      <div class="yb"><div class="price">${credits(h.cost)}</div>
        <button class="primary" data-act="buy" ${full || poor || locked ? 'disabled' : ''}>${locked ? locked : full ? 'Fleet is full' : poor ? 'Not enough credits' : 'Purchase'}</button>
        <small>Comes with its factory loadout. Weapons and hullmods are free to refit until markets open.</small></div></div>`;
    this.bottom.querySelector('[data-act=buy]')?.addEventListener('click', () => {
      const taken = new Set(this.player.fleet.ships.map((s) => s.name));
      const ship = createShip(h.id, shipName(h.id, new Rng(Date.now() & 0xffffff), taken));
      this.player.fleet.ships.push(ship);
      this.player.credits -= h.cost;
      this.host.toast(`Purchased ${ship.name} (${h.name})`, 'good');
      this.selectedShipId = ship.id;
      this.tab = 'fleet';
      this.commit();
    });
  }

  /** Warships of the station's own navy are sold only to friends and officers. */
  private militaryLock(hullId: string): string | null {
    const st = this.host.station;
    if (!st) return null;
    const f = FACTIONS[st.campaign.owner[st.star]];
    const h = hullDef(hullId);
    if (!f.military || h.style !== f.style || (h.size !== 'cruiser' && h.size !== 'capital')) return null;
    if (this.player.commission === f.id || repOf(this.player, f.id) >= 25) return null;
    return `Requires ${f.short} commission or Friendly standing`;
  }

  // ------------------------------------------------------------ services

  private renderServicesTab(): void {
    const p = this.player;
    this.clearMarkers();
    this.view.showArc(null);
    const flag = this.player.fleet.ships.find((s) => s.id === this.player.fleet.flagshipId)!;
    this.view.setLoadout(flag.loadout);
    this.renderStats(computeStats(flag.loadout));
    const repair = repairCost(p.fleet.ships);
    const damaged = p.fleet.ships.filter((x) => x.loadout.hullmods.some((m) => isDmod(m)));
    this.left.innerHTML = `<h3>Station services</h3>
      <p class="fs-note">Refuelling buys fuel and supplies at this market's prices. Trade goods are in the Market tab; jobs and commissions in the Bar.</p>
      <h3>Fleet condition</h3>
      <div class="fs-roster">${p.fleet.ships
        .map((x) => `<div class="fs-card static"><div class="n">${x.name}</div><div class="h">${hullDef(x.loadout.hullId).name}</div>${shipCondition(x)}</div>`)
        .join('')}</div>`;
    const needFuel = p.fuelCapacity - p.fuel;
    const needSup = p.suppliesCapacity - p.supplies;
    this.bottom.innerHTML = `<div class="fs-services">
      <div class="svc"><div class="sn">Fuel</div><div class="bar fuel"><div style="width:${(p.fuel / p.fuelCapacity) * 100}%"></div></div><div class="sv">${Math.round(p.fuel)} / ${p.fuelCapacity} t</div></div>
      <div class="svc"><div class="sn">Supplies</div><div class="bar sup"><div style="width:${(p.supplies / p.suppliesCapacity) * 100}%"></div></div><div class="sv">${Math.round(p.supplies)} / ${p.suppliesCapacity}</div></div>
      <div class="svc-buttons">
        <button class="primary" data-act="refuel" ${needFuel < 0.05 && needSup < 0.05 ? 'disabled' : ''}>${needFuel < 0.05 && needSup < 0.05 ? 'Tanks and holds full' : `Refuel & resupply ${credits(this.host.refuelCost())}`}</button>
        <button class="primary" data-act="repair" ${repair <= 0 || p.credits < repair ? 'disabled' : ''} title="Restore hull integrity and combat readiness">${repair <= 0 ? 'Fleet fully repaired' : `Repair & recommission ${credits(repair)}`}</button>
        <button data-act="sim" title="Fight a simulated pirate fleet: no losses, no rewards">Combat simulator</button>
        ${(() => {
          const d = this.host.dataValue();
          return `<button class="primary" data-act="data" ${d.count ? '' : 'disabled'} title="Scans, ruins and surveys from planet surfaces">${d.count ? `Sell exploration data (${d.count}) ${credits(d.value)}` : 'No exploration data to sell'}</button>`;
        })()}
      </div>
      ${damaged.length ? `<div class="svc-dmods">${damaged
        .map((x) => {
          const n = x.loadout.hullmods.filter((m) => isDmod(m)).length;
          const cost = restoreCost(x);
          return `<div><span>${x.name} <small>${n} d-mod${n > 1 ? 's' : ''}</small></span><button data-restore="${x.id}" ${p.credits < cost ? 'disabled' : ''}>Restore hull ${credits(cost)}</button></div>`;
        })
        .join('')}</div>` : ''}
    </div>`;
    this.bottom.querySelector('[data-act=refuel]')?.addEventListener('click', () => {
      this.host.refuel();
      this.refresh();
    });
    this.bottom.querySelector('[data-act=repair]')?.addEventListener('click', () => {
      p.credits -= repair;
      for (const x of p.fleet.ships) {
        x.hull = 1;
        x.cr = MAX_CR;
      }
      this.host.toast(`Fleet repaired and recommissioned for ${credits(repair)}`, 'good');
      this.commit();
    });
    this.bottom.querySelector('[data-act=sim]')?.addEventListener('click', () => this.host.simulate());
    this.bottom.querySelector('[data-act=data]')?.addEventListener('click', () => {
      this.host.sellData();
      this.refresh();
    });
    this.bottom.querySelectorAll<HTMLButtonElement>('[data-restore]').forEach((b) =>
      b.addEventListener('click', () => {
        const x = p.fleet.ships.find((y) => y.id === b.dataset.restore);
        if (!x) return;
        const cost = restoreCost(x);
        p.credits -= cost;
        x.loadout = { ...x.loadout, hullmods: x.loadout.hullmods.filter((m) => !isDmod(m)) };
        this.host.toast(`${x.name} restored to factory condition`, 'good');
        this.commit();
      }),
    );
  }

  // ------------------------------------------------------------ slot markers

  private clearMarkers(): void {
    this.markers.innerHTML = '';
    this.markerEls.clear();
  }

  private buildMarkers(h: HullDef): void {
    this.clearMarkers();
    if (this.editTab !== 'weapons') return;
    for (const slot of h.slots) {
      const b = el('button', `fs-marker ${slot.size} ${slot.id === this.selectedSlot ? 'on' : ''}`, this.markers);
      b.style.setProperty('--c', TYPE_COLOR[slot.type]);
      const w = this.ship?.loadout.weapons[slot.id];
      b.title = `${slot.id} · ${slot.size} ${slot.type} ${slot.mount}${w ? ` — ${weaponDef(w).name}` : ' — empty'}`;
      b.textContent = slot.id.replace('WS', '');
      b.addEventListener('click', () => {
        this.selectedSlot = slot.id;
        this.editTab = 'weapons';
        this.refresh();
      });
      this.markerEls.set(slot.id, b);
    }
  }

  render(dt: number, time: number): void {
    const left = this.left.getBoundingClientRect().width;
    const right = this.right.getBoundingClientRect().width;
    const bottom = this.bottom.getBoundingClientRect().height;
    this.view.update(dt, time, { left, right, bottom });
    for (const [id, b] of this.markerEls) {
      const p = this.view.slotScreen(id);
      b.style.display = p.visible ? '' : 'none';
      b.style.transform = `translate(${p.x}px, ${p.y}px)`;
    }
    this.pipeline.render(this.view.scene, this.view.camera, {
      atmospheres: [],
      sunColor: new THREE.Color(1, 1, 1),
      sunViewPos: null,
      sunRadius: 1,
      warp: 0,
      time,
    });
  }
}
