import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { meanOrbitalSpeed, orbitPath } from '../galaxy/orbits';
import { PLANET_TYPE_LABEL } from '../planets/planetTypes';
import type { RenderPipeline } from '../render/pipeline';
import type { Anchor, BodyState, Universe } from '../world/universe';
import type { PlanetView } from '../world/systemView';
import { formatDistance, formatDuration, formatSpeed, formatTemp } from './format';

const MAP_R0 = 2e6;
const MAP_K = 12;

/** Radial log compression so inner and outer planets both fit on screen. */
export function mapRadius(r: number): number {
  return MAP_K * Math.log10(1 + r / MAP_R0);
}

function displayRadius(b: BodyState): number {
  return b.def.kind === 'moon' ? 0.09 + 0.08 * Math.sqrt(b.radius / 1.5e4) : 0.22 + 0.55 * Math.sqrt(b.radius / 2.6e5);
}

const globeVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vObj;
varying vec3 vNormalW;
varying vec3 vWorld;
void main() {
  vObj = position;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}
`;
const globeFragment = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform samplerCube uAlbedo;
uniform samplerCube uNormalMap;
uniform vec3 uSunPos;
uniform vec3 uSky;
uniform float uHasClouds;
uniform vec3 uCloudColor;
varying vec3 vObj;
varying vec3 vNormalW;
varying vec3 vWorld;
void main() {
  #include <logdepthbuf_fragment>
  vec3 d = normalize(vObj);
  vec3 alb = textureCube(uAlbedo, d).rgb;
  float cl = uHasClouds * textureCube(uNormalMap, d).a;
  alb = mix(alb, uCloudColor, cl * 0.9);
  vec3 L = normalize(uSunPos - vWorld);
  vec3 V = normalize(cameraPosition - vWorld);
  float diff = max(dot(vNormalW, L), 0.0);
  float rim = pow(1.0 - max(dot(vNormalW, V), 0.0), 3.0);
  vec3 col = alb * (diff * 1.6 + 0.05) + uSky * rim * 6.0 * (0.3 + diff);
  gl_FragColor = vec4(col, 1.0);
}
`;

interface MapItem {
  anchor: Anchor;
  object: THREE.Object3D;
  label: HTMLDivElement;
  pickRadius: number;
  orbitLine?: THREE.LineLoop;
  ringMesh?: THREE.Mesh;
  isMoon: boolean;
  parentItem?: MapItem;
  moonIndex: number;
}

export class SystemMap {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e5);
  private readonly controls: OrbitControls;
  private readonly ui: HTMLDivElement;
  private readonly info: HTMLDivElement;
  private readonly items: MapItem[] = [];
  private readonly shipMarker: THREE.Mesh;
  private readonly shipLabel: HTMLDivElement;
  private readonly focus = new THREE.Vector3();
  private focusItem: MapItem | null = null;
  private selected: MapItem | null = null;
  private down = { x: 0, y: 0, t: 0 };
  open = false;
  onSetTarget: (a: Anchor) => void = () => {};
  targetId: string | null = null;

  constructor(
    private readonly universe: Universe,
    private readonly pipeline: RenderPipeline,
    private readonly planetViews: PlanetView[],
    background: THREE.Texture | null,
  ) {
    const dom = pipeline.renderer.domElement;
    this.scene.background = background;
    this.scene.backgroundIntensity = 0.5;
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.6;
    this.controls.maxDistance = 120;
    this.controls.enablePan = false;
    this.controls.enabled = false;
    this.camera.position.set(0, 35, 45);

    this.ui = document.createElement('div');
    this.ui.className = 'map-ui hidden';
    document.body.appendChild(this.ui);
    const sys = universe.system;
    this.ui.innerHTML = `<div class="title">${sys.name}<small>Class ${sys.star.spectralClass} star · ${universe.bodies.filter((b) => b.def.kind === 'planet').length} planets · ${universe.bodies.filter((b) => b.def.kind === 'moon').length} moons</small></div>
      <div class="hint">DRAG rotate · WHEEL zoom · CLICK select · DOUBLE-CLICK focus · [M] close</div>`;
    this.info = document.createElement('div');
    this.info.className = 'map-info hidden';
    this.ui.appendChild(this.info);

    this.build();

    this.shipMarker = new THREE.Mesh(
      new THREE.ConeGeometry(0.08, 0.28, 4).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color('#6dffb0').multiplyScalar(3) }),
    );
    this.scene.add(this.shipMarker);
    this.shipLabel = this.makeLabel('YOU', 'ship');

    dom.addEventListener('pointerdown', (e) => {
      this.down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    dom.addEventListener('pointerup', (e) => {
      if (!this.open) return;
      if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 5) {
        const hit = this.pick(e.clientX, e.clientY);
        if (hit) this.select(hit);
      }
    });
    dom.addEventListener('dblclick', (e) => {
      if (!this.open) return;
      const hit = this.pick(e.clientX, e.clientY);
      if (hit) this.setFocus(hit);
    });
  }

  private makeLabel(text: string, cls = ''): HTMLDivElement {
    const l = document.createElement('div');
    l.className = `map-label ${cls}`;
    l.textContent = text;
    this.ui.appendChild(l);
    return l;
  }

  private build(): void {
    const u = this.universe;
    // Star.
    const starColor = new THREE.Color(...u.system.star.color);
    const star = new THREE.Mesh(new THREE.SphereGeometry(1.1, 32, 16), new THREE.MeshBasicMaterial({ color: starColor.clone().multiplyScalar(5) }));
    this.scene.add(star);
    const glowTex = radialTexture();
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: starColor.clone().multiplyScalar(2), blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.scale.setScalar(9);
    star.add(glow);
    const starItem: MapItem = { anchor: u.star, object: star, label: this.makeLabel(u.star.name), pickRadius: 1.4, isMoon: false, moonIndex: 0 };
    this.items.push(starItem);

    // Belts.
    for (const belt of u.system.belts) {
      const n = 2500;
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = mapRadius(belt.radius + (Math.random() - 0.5) * belt.width);
        pos.set([Math.cos(a) * r, (Math.random() - 0.5) * 0.15, Math.sin(a) * r], i * 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: new THREE.Color(...belt.color).multiplyScalar(1.5), size: 2, sizeAttenuation: false })));
    }

    // Bodies.
    const moonCount = new Map<string, number>();
    for (const pv of this.planetViews) {
      const b = pv.state;
      const r = displayRadius(b);
      const mat = new THREE.ShaderMaterial({
        vertexShader: globeVertex,
        fragmentShader: globeFragment,
        uniforms: {
          uAlbedo: { value: pv.low.albedo.texture },
          uNormalMap: { value: pv.low.normal.texture },
          uSunPos: { value: new THREE.Vector3() }, // star sits at the map origin
          uSky: { value: pv.skyColor },
          uHasClouds: { value: b.def.surface.cloudCover > 0.01 ? 1 : 0 },
          uCloudColor: { value: new THREE.Color(...b.def.surface.cloudColor) },
        },
      });
      const globe = new THREE.Mesh(new THREE.SphereGeometry(r, 48, 24), mat);
      this.scene.add(globe);
      let ringMesh: THREE.Mesh | undefined;
      if (b.def.rings) {
        const rg = new THREE.RingGeometry(r * (b.def.rings.innerRadius / b.radius), r * (b.def.rings.outerRadius / b.radius), 64);
        rg.rotateX(-Math.PI / 2);
        ringMesh = new THREE.Mesh(
          rg,
          new THREE.MeshBasicMaterial({ color: new THREE.Color(...b.def.rings.colorA), transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }),
        );
        ringMesh.quaternion.copy(b.tilt);
        this.scene.add(ringMesh);
      }
      const isMoon = b.def.kind === 'moon';
      const idx = isMoon ? (moonCount.get(b.def.parentId!) ?? 0) : 0;
      if (isMoon) moonCount.set(b.def.parentId!, idx + 1);
      const item: MapItem = {
        anchor: b,
        object: globe,
        label: this.makeLabel(b.name, isMoon ? 'moon' : ''),
        pickRadius: Math.max(r, 0.25),
        isMoon,
        moonIndex: idx,
        ringMesh,
      };
      if (!isMoon) {
        const pts = orbitPath(b.def.orbit, 256).map((p) => p.clone().normalize().multiplyScalar(mapRadius(p.length())));
        const line = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: new THREE.Color('#5fa8d8'), transparent: true, opacity: 0.35 }),
        );
        this.scene.add(line);
        item.orbitLine = line;
      }
      this.items.push(item);
    }
    for (const it of this.items) {
      if (it.isMoon) {
        const parent = this.items.find((p) => p.anchor === it.anchor.parent);
        it.parentItem = parent;
        const pr = displayRadius(parent!.anchor as BodyState);
        const ring = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(
            Array.from({ length: 96 }, (_, i) => {
              const a = (i / 96) * Math.PI * 2;
              const rr = pr * 1.9 + 0.45 * (it.moonIndex + 1);
              return new THREE.Vector3(Math.cos(a) * rr, 0, Math.sin(a) * rr);
            }),
          ),
          new THREE.LineBasicMaterial({ color: '#5fa8d8', transparent: true, opacity: 0.18 }),
        );
        ring.quaternion.copy((parent!.anchor as BodyState).tilt);
        this.scene.add(ring);
        it.orbitLine = ring;
      }
    }
    // Stations.
    for (const st of this.universe.stations) {
      const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.09), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffd27a').multiplyScalar(2) }));
      this.scene.add(m);
      const parent = this.items.find((p) => p.anchor === st.parent);
      this.items.push({ anchor: st, object: m, label: this.makeLabel(st.name, 'moon'), pickRadius: 0.2, isMoon: true, parentItem: parent, moonIndex: -1 });
    }
    const amb = new THREE.AmbientLight(0xffffff, 0.2);
    this.scene.add(amb);
  }

  /** Map-space position for any system-space point, keeping local structure around planets. */
  private mapPosition(world: THREE.Vector3, frame: Anchor | null, out: THREE.Vector3): THREE.Vector3 {
    let planet: Anchor | null = frame;
    while (planet && planet.parent) planet = planet.parent;
    if (planet && planet.kind === 'body') {
      const item = this.items.find((i) => i.anchor === planet)!;
      const rel = world.clone().sub(planet.position);
      const pr = displayRadius(planet as BodyState);
      const f = Math.log10(1 + rel.length() / planet.radius) / Math.log10(1 + planet.soiRadius / planet.radius);
      return out.copy(item.object.position).add(rel.normalize().multiplyScalar(pr * (1 + f * 4)));
    }
    const r = world.length();
    return out.copy(world).normalize().multiplyScalar(mapRadius(r));
  }

  private layout(): void {
    for (const it of this.items) {
      const a = it.anchor;
      if (a.kind === 'star') continue;
      if (!it.isMoon) {
        it.object.position.copy(a.position).normalize().multiplyScalar(mapRadius(a.position.length()));
      }
    }
    for (const it of this.items) {
      if (!it.isMoon || !it.parentItem) continue;
      const parent = it.parentItem;
      const pa = parent.anchor as BodyState;
      const pr = displayRadius(pa);
      const rel = it.anchor.position.clone().sub(pa.position).normalize();
      const rr = it.moonIndex < 0 ? pr * 1.45 : pr * 1.9 + 0.45 * (it.moonIndex + 1);
      it.object.position.copy(parent.object.position).addScaledVector(rel, rr);
      if (it.orbitLine) it.orbitLine.position.copy(parent.object.position);
    }
    for (const it of this.items) {
      if (it.anchor.kind === 'body') {
        const b = it.anchor as BodyState;
        it.object.quaternion.copy(b.rotation);
        it.ringMesh?.position.copy(it.object.position);
      }
    }
  }

  setOpen(open: boolean, shipWorld: THREE.Vector3, shipFrame: Anchor | null): void {
    this.open = open;
    this.controls.enabled = open;
    this.ui.classList.toggle('hidden', !open);
    if (open) {
      this.layout();
      let planet: Anchor | null = shipFrame;
      while (planet && planet.parent) planet = planet.parent;
      const it = this.items.find((i) => i.anchor === planet) ?? this.items[0];
      this.setFocus(it, true);
      const target = this.items.find((i) => i.anchor.id === this.targetId);
      this.select(target ?? it);
      void shipWorld;
    }
  }

  private setFocus(it: MapItem, instant = false): void {
    this.focusItem = it;
    const p = it.object.position;
    const dist = it.anchor.kind === 'star' ? 40 : it.isMoon ? 3 : 7;
    if (instant) {
      this.controls.target.copy(p);
      this.camera.position.copy(p).add(new THREE.Vector3(0, dist * 0.6, dist));
    }
    this.focus.copy(p);
  }

  private select(it: MapItem): void {
    this.selected = it;
    for (const i of this.items) i.label.classList.toggle('selected', i === it);
    this.renderInfo();
  }

  private renderInfo(): void {
    const it = this.selected;
    if (!it) {
      this.info.classList.add('hidden');
      return;
    }
    const a = it.anchor;
    const rows: [string, string][] = [];
    let title = a.name;
    let type = '';
    let desc = '';
    if (a.kind === 'star') {
      const s = this.universe.system.star;
      type = `Class ${s.spectralClass} star`;
      desc = `A ${s.temperature > 7500 ? 'brilliant blue-white' : s.temperature > 5200 ? 'yellow' : s.temperature > 3900 ? 'orange' : 'smouldering red'} sun anchoring the ${this.universe.system.name} system.`;
      rows.push(['Surface temp', `${Math.round(s.temperature).toLocaleString()} K`], ['Radius', formatDistance(s.radius)], ['Luminosity', `${s.luminosity.toFixed(2)} L☉`]);
    } else if (a.kind === 'body') {
      const b = (a as BodyState).def;
      type = `${PLANET_TYPE_LABEL[b.type]} ${b.kind}`;
      desc = b.description;
      rows.push(
        ['Radius', formatDistance(b.radius)],
        ['Gravity', `${b.gravity.toFixed(2)} g`],
        ['Temperature', formatTemp(b.temperature)],
        ['Atmosphere', b.atmosphere ? `${b.atmosphere.composition} (${b.atmosphere.density})` : 'None'],
        ['Day length', formatDuration(Math.abs(b.rotationPeriod))],
        ['Orbit', `${formatDistance(b.orbit.semiMajorAxis)} · ${formatDuration(b.orbit.period)}`],
        ['Orbital speed', `${formatSpeed(meanOrbitalSpeed(b.orbit)).value} ${formatSpeed(meanOrbitalSpeed(b.orbit)).unit}`],
      );
      if (b.moonIds.length) rows.push(['Moons', String(b.moonIds.length)]);
      if (b.rings) rows.push(['Rings', 'Yes']);
      rows.push(['Resources', 'Unscanned']);
    } else {
      type = 'Orbital trade hub';
      desc = `Independent station in orbit of ${a.parent?.name}. Markets and docking arrive in a later update.`;
      rows.push(['Orbiting', a.parent?.name ?? '—'], ['Size', formatDistance(a.radius * 2)]);
      title = a.name;
    }
    const isTarget = this.targetId === a.id;
    this.info.classList.remove('hidden');
    this.info.innerHTML = `<h2>${title}</h2><div class="type">${type}</div><p>${desc}</p>${rows
      .map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`)
      .join('')}<div class="buttons"><button data-act="target">${isTarget ? 'Targeted ✓' : 'Set target'}</button><button class="secondary" data-act="focus">Focus</button></div>`;
    this.info.querySelector<HTMLButtonElement>('[data-act=target]')!.onclick = () => {
      this.onSetTarget(a);
      this.targetId = a.id;
      this.renderInfo();
    };
    this.info.querySelector<HTMLButtonElement>('[data-act=focus]')!.onclick = () => this.setFocus(it);
  }

  private pick(x: number, y: number): MapItem | null {
    let best: MapItem | null = null;
    let bestD = 28;
    const v = new THREE.Vector3();
    for (const it of this.items) {
      if (it.label.style.display === 'none') continue;
      v.copy(it.object.position).project(this.camera);
      if (v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-v.y * 0.5 + 0.5) * window.innerHeight;
      const d = Math.hypot(sx - x, sy - y);
      if (d < bestD) {
        bestD = d;
        best = it;
      }
    }
    return best;
  }

  render(shipWorld: THREE.Vector3, shipFrame: Anchor | null, shipQuat: THREE.Quaternion, time: number): void {
    this.layout();
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    // Smoothly follow the focused body as it orbits.
    if (this.focusItem) {
      const p = this.focusItem.object.position;
      const delta = p.clone().sub(this.focus);
      const step = delta.multiplyScalar(0.12);
      this.focus.add(step);
      this.controls.target.add(step);
      this.camera.position.add(step);
    }
    this.controls.update();

    this.mapPosition(shipWorld, shipFrame, this.shipMarker.position);
    this.shipMarker.quaternion.copy(shipQuat);
    const pulse = 1 + 0.25 * Math.sin(time * 4);
    this.shipMarker.scale.setScalar(pulse * Math.max(0.6, this.camera.position.distanceTo(this.shipMarker.position) / 8));

    // Labels.
    const v = new THREE.Vector3();
    const camDist = this.camera.position.distanceTo(this.controls.target);
    const place = (label: HTMLDivElement, pos: THREE.Vector3, visible: boolean, offset: number) => {
      v.copy(pos).project(this.camera);
      if (!visible || v.z > 1) {
        label.style.display = 'none';
        return;
      }
      label.style.display = '';
      const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-v.y * 0.5 + 0.5) * window.innerHeight;
      label.style.transform = `translate(${sx + offset}px, ${sy - 8}px)`;
    };
    for (const it of this.items) {
      const parentDist = it.parentItem ? this.camera.position.distanceTo(it.parentItem.object.position) : 0;
      const visible = !it.isMoon || parentDist < 14 || it.anchor.id === this.targetId;
      place(it.label, it.object.position, visible, 12);
      it.object.visible = !it.isMoon || parentDist < 40;
      if (it.orbitLine && it.isMoon) it.orbitLine.visible = parentDist < 14;
      it.label.classList.toggle('selected', it === this.selected || it.anchor.id === this.targetId);
    }
    place(this.shipLabel, this.shipMarker.position, true, 12);
    void camDist;

    this.pipeline.render(this.scene, this.camera, {
      atmospheres: [],
      sunColor: new THREE.Color(1, 1, 1),
      sunViewPos: null,
      sunRadius: 1,
      warp: 0,
      time,
    });
  }

  dispose(): void {
    this.controls.dispose();
    this.ui.remove();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mat of mats) mat.dispose();
    });
  }
}

function radialTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.2, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
