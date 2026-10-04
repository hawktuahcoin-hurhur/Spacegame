import * as THREE from 'three';
import type { CombatShip, Order } from '../combat/ship';
import { ARENA_RADIUS, type CombatSim } from '../combat/sim';
import { formatDistance } from './format';

const SIZE_PX = [7, 10, 13, 17];
const COL = {
  own: '#5fc8ff',
  me: '#ffb547',
  enemy: '#ff6a4d',
  dead: 'rgba(160,160,160,0.45)',
  grid: 'rgba(120, 190, 255, 0.07)',
  gridMajor: 'rgba(120, 190, 255, 0.14)',
};

/**
 * Tactical command view (Tab): a top-down map of the battle with the
 * simulation paused. Select your ships and give orders — move, attack,
 * escort, hold, retreat — Starsector-style.
 */
export class TacticalView {
  readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly info: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly pauseEl: HTMLDivElement;
  open = false;
  /** Simulation paused while the view is open (Space toggles). */
  paused = true;
  private readonly selected = new Set<CombatShip>();
  private centre = new THREE.Vector2();
  private scale = 0.05; // px per metre
  private hover: CombatShip | null = null;
  private drag: { x: number; y: number; pan: boolean; cx: number; cz: number } | null = null;
  private box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private time = 0;
  private sim: CombatSim | null = null;
  /** Feedback (sound/toast) when an order is given. */
  onOrder: (text: string) => void = () => {};
  onClose: () => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'tactical hidden';
    parent.appendChild(this.root);
    this.canvas = document.createElement('canvas');
    this.root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    const head = document.createElement('div');
    head.className = 'tc-head';
    head.innerHTML = '<b>TACTICAL</b><span>Click to select · drag to box-select · right-click: move / attack / escort · wheel zoom · middle-drag pan</span>';
    this.root.appendChild(head);
    this.pauseEl = document.createElement('div');
    this.pauseEl.className = 'tc-pause';
    this.root.appendChild(this.pauseEl);
    this.info = document.createElement('div');
    this.info.className = 'tc-info';
    this.root.appendChild(this.info);
    this.bar = document.createElement('div');
    this.bar.className = 'tc-bar';
    this.root.appendChild(this.bar);
    const button = (label: string, key: string, fn: () => void, cls = '') => {
      const b = document.createElement('button');
      b.className = cls;
      b.innerHTML = `${label}<kbd>${key}</kbd>`;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      this.bar.appendChild(b);
    };
    button('Select all', 'Q', () => this.selectAll());
    button('Hold position', 'H', () => this.orderSelected({ kind: 'hold' }, 'Hold position'));
    button('Clear orders', 'C', () => this.orderSelected(null, 'Orders cleared — engage at will'));
    button('Retreat', 'X', () => this.orderSelected({ kind: 'retreat' }, 'Retreat'), 'warn');
    button('Full assault', 'A', () => this.fullAssault());
    button('Pause', 'Space', () => (this.paused = !this.paused));
    button('Resume combat', 'Tab', () => this.onClose(), 'go');

    this.canvas.addEventListener('mousemove', (e) => this.onMove(e));
    this.canvas.addEventListener('mousedown', (e) => this.onDown(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const before = this.toWorld(e.offsetX, e.offsetY);
        this.scale = THREE.MathUtils.clamp(this.scale * Math.exp(-e.deltaY * 0.0015), 0.008, 0.6);
        const after = this.toWorld(e.offsetX, e.offsetY);
        this.centre.x += before.x - after.x;
        this.centre.y += before.y - after.y;
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      if (!this.open) return;
      if (e.code === 'KeyQ') this.selectAll();
      else if (e.code === 'KeyH') this.orderSelected({ kind: 'hold' }, 'Hold position');
      else if (e.code === 'KeyC') this.orderSelected(null, 'Orders cleared — engage at will');
      else if (e.code === 'KeyX') this.orderSelected({ kind: 'retreat' }, 'Retreat');
      else if (e.code === 'KeyA') this.fullAssault();
      else if (e.code === 'Space') this.paused = !this.paused;
    });
  }

  show(sim: CombatSim): void {
    this.sim = sim;
    this.open = true;
    this.paused = true;
    this.root.classList.remove('hidden');
    this.fit();
    // Preselect the player's escorts.
    if (!this.selected.size) for (const s of sim.active(0)) if (!s.controlled) this.selected.add(s);
  }

  hide(): void {
    this.open = false;
    this.root.classList.add('hidden');
    this.drag = null;
    this.box = null;
  }

  /** Frame every active ship. */
  private fit(): void {
    const sim = this.sim!;
    const pts = sim.ships.filter((s) => !s.retreated).map((s) => s.pos);
    if (!pts.length) return;
    const min = new THREE.Vector2(Infinity, Infinity);
    const max = new THREE.Vector2(-Infinity, -Infinity);
    for (const p of pts) {
      min.min(new THREE.Vector2(p.x, p.z));
      max.max(new THREE.Vector2(p.x, p.z));
    }
    this.centre.copy(min).add(max).multiplyScalar(0.5);
    const span = Math.max(max.x - min.x, max.y - min.y, 2500) * 1.35;
    this.scale = Math.min(window.innerWidth, window.innerHeight - 160) / span;
  }

  private toScreen(x: number, z: number): { x: number; y: number } {
    return { x: (x - this.centre.x) * this.scale + this.canvas.width / 2 / devicePixelRatio, y: (z - this.centre.y) * this.scale + this.canvas.height / 2 / devicePixelRatio };
  }

  private toWorld(px: number, py: number): THREE.Vector2 {
    return new THREE.Vector2((px - this.canvas.width / 2 / devicePixelRatio) / this.scale + this.centre.x, (py - this.canvas.height / 2 / devicePixelRatio) / this.scale + this.centre.y);
  }

  private shipAt(px: number, py: number): CombatShip | null {
    let best: CombatShip | null = null;
    let bestD = 18;
    for (const s of this.sim?.ships ?? []) {
      if (s.retreated) continue;
      const p = this.toScreen(s.pos.x, s.pos.z);
      const d = Math.hypot(p.x - px, p.y - py) - SIZE_PX[s.sizeIndex] * 0.5;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  private selectAll(): void {
    this.selected.clear();
    for (const s of this.sim?.active(0) ?? []) if (!s.controlled) this.selected.add(s);
  }

  private fullAssault(): void {
    if (!this.sim) return;
    for (const s of this.sim.active(0)) if (!s.controlled) s.order = null;
    this.sim.stance[0] = 'engage';
    this.onOrder('Full assault — all ships engage');
  }

  private orderSelected(order: Order | null, text: string): void {
    const ships = [...this.selected].filter((s) => s.alive && !s.retreated && !s.controlled);
    if (!ships.length) {
      this.onOrder('Select ships first (your flagship takes your orders directly)');
      return;
    }
    ships.forEach((s, i) => {
      s.order = order ? { ...order, point: order.point ? spread(order.point, i, ships.length, s.dims.collide) : undefined } : null;
      s.ai.anchor = null;
      s.ai.thinkIn = 0;
    });
    this.onOrder(`${text} — ${ships.length === 1 ? ships[0].name : `${ships.length} ships`}`);
  }

  private onMove(e: MouseEvent): void {
    if (this.drag?.pan) {
      this.centre.set(this.drag.cx - (e.offsetX - this.drag.x) / this.scale, this.drag.cz - (e.offsetY - this.drag.y) / this.scale);
      return;
    }
    if (this.drag && !this.drag.pan && Math.hypot(e.offsetX - this.drag.x, e.offsetY - this.drag.y) > 6) this.box = { x0: this.drag.x, y0: this.drag.y, x1: e.offsetX, y1: e.offsetY };
    this.hover = this.shipAt(e.offsetX, e.offsetY);
  }

  private onDown(e: MouseEvent): void {
    if (!this.sim) return;
    if (e.button === 1) {
      e.preventDefault();
      this.drag = { x: e.offsetX, y: e.offsetY, pan: true, cx: this.centre.x, cz: this.centre.y };
      return;
    }
    if (e.button === 0) {
      this.drag = { x: e.offsetX, y: e.offsetY, pan: false, cx: 0, cz: 0 };
      return;
    }
    if (e.button === 2) {
      const hit = this.shipAt(e.offsetX, e.offsetY);
      if (hit && hit.alive && hit.side === 1) this.orderSelected({ kind: 'attack', target: hit }, `Attack ${hit.name}`);
      else if (hit && hit.alive && hit.side === 0) {
        for (const s of this.selected) if (s === hit) this.selected.delete(s);
        this.orderSelected({ kind: 'escort', target: hit }, `Escort ${hit.name}`);
      } else {
        const w = this.toWorld(e.offsetX, e.offsetY);
        this.orderSelected({ kind: 'move', point: new THREE.Vector3(w.x, 0, w.y) }, `Move to ${formatDistance(Math.hypot(w.x, w.y))} from centre`);
      }
    }
  }

  private onUp(e: MouseEvent): void {
    if (!this.open || !this.drag) return;
    const d = this.drag;
    this.drag = null;
    if (d.pan || e.button !== 0) return;
    if (!e.shiftKey) this.selected.clear();
    if (this.box) {
      const b = this.box;
      this.box = null;
      const [x0, x1] = [Math.min(b.x0, b.x1), Math.max(b.x0, b.x1)];
      const [y0, y1] = [Math.min(b.y0, b.y1), Math.max(b.y0, b.y1)];
      for (const s of this.sim?.active(0) ?? []) {
        const p = this.toScreen(s.pos.x, s.pos.z);
        if (!s.controlled && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) this.selected.add(s);
      }
      return;
    }
    const hit = this.shipAt(e.offsetX, e.offsetY);
    if (hit && hit.side === 0 && hit.alive && !hit.controlled) {
      if (this.selected.has(hit) && e.shiftKey) this.selected.delete(hit);
      else this.selected.add(hit);
    }
  }

  render(dt: number): void {
    if (!this.open || !this.sim) return;
    this.time += dt;
    const sim = this.sim;
    const dpr = devicePixelRatio;
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
    }
    const c = this.ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);

    // Grid: 500 m cells, kilometre lines brighter.
    const step = this.scale * 500 < 18 ? 2000 : 500;
    const tl = this.toWorld(0, 0);
    const br = this.toWorld(W, H);
    c.lineWidth = 1;
    for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
      const p = this.toScreen(x, 0);
      c.strokeStyle = x % 1000 === 0 ? COL.gridMajor : COL.grid;
      c.beginPath();
      c.moveTo(p.x, 0);
      c.lineTo(p.x, H);
      c.stroke();
    }
    for (let z = Math.floor(tl.y / step) * step; z <= br.y; z += step) {
      const p = this.toScreen(0, z);
      c.strokeStyle = z % 1000 === 0 ? COL.gridMajor : COL.grid;
      c.beginPath();
      c.moveTo(0, p.y);
      c.lineTo(W, p.y);
      c.stroke();
    }
    // Arena edge: ships ordered to retreat leave here.
    const o = this.toScreen(0, 0);
    c.strokeStyle = 'rgba(255, 181, 71, 0.35)';
    c.setLineDash([8, 8]);
    c.beginPath();
    c.arc(o.x, o.y, ARENA_RADIUS * this.scale, 0, Math.PI * 2);
    c.stroke();
    c.setLineDash([]);

    // Weapon ranges for selected ships.
    for (const s of this.selected) {
      if (!s.alive) continue;
      const p = this.toScreen(s.pos.x, s.pos.z);
      c.strokeStyle = 'rgba(95, 200, 255, 0.18)';
      c.beginPath();
      c.arc(p.x, p.y, (s.ai.range / 0.82) * this.scale, 0, Math.PI * 2);
      c.stroke();
    }

    // Orders.
    for (const s of sim.active(0)) {
      if (!s.order) continue;
      const p = this.toScreen(s.pos.x, s.pos.z);
      const o2 = s.order;
      let to: { x: number; y: number } | null = null;
      let col = 'rgba(95,200,255,0.7)';
      if (o2.kind === 'move' && o2.point) to = this.toScreen(o2.point.x, o2.point.z);
      else if (o2.kind === 'hold') {
        const a = s.ai.anchor ?? s.pos;
        to = this.toScreen(a.x, a.z);
      } else if ((o2.kind === 'attack' || o2.kind === 'escort') && o2.target) {
        to = this.toScreen(o2.target.pos.x, o2.target.pos.z);
        col = o2.kind === 'attack' ? 'rgba(255,106,77,0.8)' : 'rgba(109,255,176,0.75)';
      } else if (o2.kind === 'retreat') {
        const r = Math.hypot(s.pos.x, s.pos.z) || 1;
        to = this.toScreen((s.pos.x / r) * ARENA_RADIUS, (s.pos.z / r) * ARENA_RADIUS);
        col = 'rgba(255,181,71,0.75)';
      }
      if (!to) continue;
      c.strokeStyle = col;
      c.setLineDash([6, 5]);
      c.lineDashOffset = -this.time * 20;
      c.beginPath();
      c.moveTo(p.x, p.y);
      c.lineTo(to.x, to.y);
      c.stroke();
      c.setLineDash([]);
      if (o2.kind === 'move' || o2.kind === 'hold') {
        c.beginPath();
        c.arc(to.x, to.y, 6, 0, Math.PI * 2);
        c.stroke();
      }
    }

    // Projectiles and missiles.
    for (const p of sim.projectiles) {
      if (!p.active) continue;
      const s = this.toScreen(p.pos.x, p.pos.z);
      c.fillStyle = p.side === 0 ? 'rgba(160,220,255,0.7)' : 'rgba(255,170,140,0.7)';
      c.fillRect(s.x - 0.75, s.y - 0.75, 1.5, 1.5);
    }
    for (const m of sim.missiles) {
      if (!m.active) continue;
      const s = this.toScreen(m.pos.x, m.pos.z);
      c.fillStyle = m.side === 0 ? '#9fe3ff' : '#ff9c85';
      c.beginPath();
      c.arc(s.x, s.y, m.def.model === 'torpedo' ? 3 : 2, 0, Math.PI * 2);
      c.fill();
    }

    // Ships.
    for (const s of sim.ships) {
      if (s.retreated) continue;
      const p = this.toScreen(s.pos.x, s.pos.z);
      const size = Math.max(SIZE_PX[s.sizeIndex], s.dims.hull.z * this.scale);
      const col = !s.alive ? COL.dead : s.side === 1 ? COL.enemy : s.controlled ? COL.me : COL.own;
      // Shield arc.
      if (s.alive && s.shieldUp && s.shield) {
        const yaw = Math.atan2(-s.forward.x, -s.forward.z);
        const centre = -Math.PI / 2 - yaw - s.shieldFacing;
        const half = s.shield.halfArc * s.shieldUnfold;
        c.strokeStyle = s.side === 0 ? 'rgba(95,200,255,0.6)' : 'rgba(255,120,90,0.6)';
        c.lineWidth = 2;
        c.beginPath();
        c.arc(p.x, p.y, size * 0.9 + 4, centre - half, centre + half);
        c.stroke();
        c.lineWidth = 1;
      }
      const fwd = s.forward;
      const ang = Math.atan2(fwd.z, fwd.x);
      c.save();
      c.translate(p.x, p.y);
      c.rotate(ang);
      c.fillStyle = col;
      c.strokeStyle = col;
      c.beginPath();
      c.moveTo(size * 0.75, 0);
      c.lineTo(-size * 0.55, size * 0.5);
      c.lineTo(-size * 0.3, 0);
      c.lineTo(-size * 0.55, -size * 0.5);
      c.closePath();
      if (s.alive) c.fill();
      else c.stroke();
      c.restore();
      if (this.selected.has(s) && s.alive) {
        c.strokeStyle = '#fff';
        c.beginPath();
        c.arc(p.x, p.y, size * 0.9 + 9, 0, Math.PI * 2);
        c.stroke();
      }
      if (s.overload > 0 && s.alive && Math.floor(this.time * 8) % 2) {
        c.strokeStyle = '#c88cff';
        c.beginPath();
        c.arc(p.x, p.y, size + 6, 0, Math.PI * 2);
        c.stroke();
      }
      if (s.alive) {
        // Hull and flux bars.
        const bw = 26;
        c.fillStyle = 'rgba(0,0,0,0.5)';
        c.fillRect(p.x - bw / 2, p.y + size * 0.7 + 6, bw, 6);
        c.fillStyle = s.side === 0 ? '#6dffb0' : '#ff7a5c';
        c.fillRect(p.x - bw / 2, p.y + size * 0.7 + 6, bw * s.hpFrac, 2.5);
        c.fillStyle = '#c88cff';
        c.fillRect(p.x - bw / 2, p.y + size * 0.7 + 9.5, bw * s.fluxFrac, 2.5);
      }
      if (this.scale > 0.03 || this.selected.has(s) || s === this.hover || s.controlled) {
        c.fillStyle = s.alive ? (s.side === 0 ? 'rgba(200,235,255,0.85)' : 'rgba(255,190,170,0.85)') : COL.dead;
        c.font = '600 11px Rajdhani, sans-serif';
        c.textAlign = 'center';
        c.fillText(s.name.toUpperCase(), p.x, p.y - size * 0.7 - 8);
      }
    }

    // Box select.
    if (this.box) {
      const b = this.box;
      c.strokeStyle = 'rgba(159,227,255,0.8)';
      c.fillStyle = 'rgba(159,227,255,0.08)';
      c.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
      c.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    }

    // Hover / selection info.
    const s = this.hover ?? (this.selected.size === 1 ? [...this.selected][0] : null);
    if (s) {
      const order = s.order ? `${s.order.kind}${s.order.target ? ` · ${s.order.target.name}` : ''}` : 'engage at will';
      this.info.innerHTML = `<b class="side${s.side}">${s.name}</b><small>${s.hull.name} · ${s.hull.designation}</small>
        <div>Hull <em>${Math.round(s.hpFrac * 100)}%</em> · Armor <em>${Math.round(s.armor.fraction * 100)}%</em> · Flux <em>${Math.round(s.fluxFrac * 100)}%</em></div>
        <div>${s.alive ? (s.controlled ? 'Your flagship' : s.ai.state) : 'Disabled'}${s.side === 0 && !s.controlled && s.alive ? ` · Orders: <em>${order}</em>` : ''}</div>`;
      this.info.style.display = 'block';
    } else if (this.selected.size > 1) {
      this.info.innerHTML = `<b>${this.selected.size} ships selected</b><div>Right-click: move · attack · escort</div>`;
      this.info.style.display = 'block';
    } else this.info.style.display = 'none';
    this.pauseEl.textContent = this.paused ? 'PAUSED — SPACE TO RESUME' : 'LIVE — SPACE TO PAUSE';
    this.pauseEl.classList.toggle('live', !this.paused);
  }

  dispose(): void {
    this.root.remove();
  }
}

/** Fan a group's move point out so ships don't pile onto one spot. */
function spread(p: THREE.Vector3, i: number, n: number, r: number): THREE.Vector3 {
  if (n === 1) return p.clone();
  const a = (i / n) * Math.PI * 2;
  const d = Math.max(150, r * 3) * Math.sqrt(n) * 0.6;
  return p.clone().add(new THREE.Vector3(Math.cos(a) * d, 0, Math.sin(a) * d));
}
