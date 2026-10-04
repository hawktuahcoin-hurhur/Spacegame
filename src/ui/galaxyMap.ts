import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Rng } from '../core/rng';
import { type GalaxyDef, type GalaxyStar, starDistance } from '../galaxy/galaxyGen';
import { jumpFuelCost, type Route } from '../galaxy/route';
import { generateSystem } from '../galaxy/systemGen';
import { PLANET_TYPE_LABEL } from '../planets/planetTypes';
import { NOISE_GLSL } from '../render/shaders/noise';
import type { RenderPipeline } from '../render/pipeline';

export interface GalaxyMapState {
  current: number;
  route: Route | null;
  fuel: number;
  fuelCapacity: number;
  jumpRange: number;
  visited: Set<number>;
  systemTarget: number | null;
}

const LOGDEPTH_VS_HEAD = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
`;

const discVertex = /* glsl */ `
${LOGDEPTH_VS_HEAD}
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}
`;

const discFragment = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec3 vWorld;
uniform float uRadius;
uniform float uArms;
uniform float uTwist;
uniform float uScale;
uniform float uRotation;
uniform float uBulge;
uniform float uIntensity;
${NOISE_GLSL}
float wrapAngle(float a) { return mod(a + 3.14159265, 6.2831853) - 3.14159265; }
void main() {
  #include <logdepthbuf_fragment>
  vec2 p = vWorld.xz;
  float r = length(p);
  float th = atan(p.y, p.x);
  float arms = 0.0;
  for (int i = 0; i < 4; i++) {
    if (float(i) >= uArms) break;
    float a = uRotation + float(i) * 6.2831853 / uArms + uTwist * log(1.0 + r / uScale);
    float d = wrapAngle(th - a) * r;
    float w = 7.0 + r * 0.09;
    arms += exp(-d * d / (w * w));
  }
  float clumps = fbm(vec3(p * 0.06, 1.0), 5) * 0.5 + 0.5;
  float fine = fbm(vec3(p * 0.22, 7.0), 4) * 0.5 + 0.5;
  float bulge = exp(-r * r / (uBulge * uBulge * 0.45));
  float disc = smoothstep(uRadius * 1.1, uRadius * 0.3, r);
  float lanes = smoothstep(0.5, 0.72, fbm(vec3(p * 0.045, 3.0), 5) * 0.5 + 0.5);
  float density = bulge * 2.2 + arms * (0.35 + clumps * 0.9) * disc * (1.0 - lanes * 0.65) + disc * 0.07;
  density *= 0.75 + fine * 0.5;
  vec3 armCol = mix(vec3(0.45, 0.6, 1.0), vec3(0.85, 0.9, 1.0), clumps);
  vec3 col = mix(armCol, vec3(1.0, 0.78, 0.5), clamp(bulge * 1.4, 0.0, 1.0)) * density;
  // Star-forming knots.
  col += vec3(1.0, 0.35, 0.6) * pow(clumps * fine, 5.0) * arms * disc * 2.0;
  gl_FragColor = vec4(col * uIntensity, 1.0);
}
`;

const starVertex = /* glsl */ `
${LOGDEPTH_VS_HEAD}
attribute vec3 aColor;
attribute float aSize;
attribute float aDim;
uniform float uPixelRatio;
uniform float uScale;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / -mv.z, 2.0, 30.0) * uPixelRatio;
  vColor = aColor * aDim;
  #include <logdepthbuf_vertex>
}
`;
const starFragment = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  float a = exp(-r2 * 9.0) * 1.6 + exp(-r2 * 2.5) * 0.25;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * a, 1.0);
}
`;

const hazeVertex = /* glsl */ `
${LOGDEPTH_VS_HEAD}
attribute vec3 aColor;
uniform float uPixelRatio;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(60.0 / -mv.z, 1.0, 2.5) * uPixelRatio;
  vColor = aColor;
  #include <logdepthbuf_vertex>
}
`;
const hazeFragment = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
void main() {
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(vColor, 1.0);
}
`;

const billboardVertex = /* glsl */ `
${LOGDEPTH_VS_HEAD}
varying vec2 vUv;
void main() {
  vUv = uv * 2.0 - 1.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;
const nebulaFragment = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec2 vUv;
uniform vec3 uColor;
uniform float uSeed;
uniform float uTime;
${NOISE_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vUv);
  if (r > 1.0) discard;
  vec3 p = vec3(vUv * 2.2, uSeed + uTime * 0.01);
  vec3 w = vec3(fbm(p + 3.1, 4), fbm(p + 7.7, 4), 0.0);
  float n = fbm(p + w * 1.4, 6) * 0.5 + 0.5;
  float a = pow(smoothstep(0.35, 0.95, n), 1.6) * smoothstep(1.0, 0.25, r);
  vec3 col = mix(uColor, vec3(1.0), pow(n, 6.0) * 0.6);
  gl_FragColor = vec4(col * a * 0.9, 1.0);
}
`;
const ringFragment = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec2 vUv;
uniform vec3 uColor;
uniform float uTime;
uniform float uMode; // 0 = pulsing ring, 1 = bracket reticle
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vUv);
  float a = 0.0;
  if (uMode < 0.5) {
    float pulse = fract(uTime * 0.6);
    a = smoothstep(0.08, 0.0, abs(r - 0.55)) + smoothstep(0.06, 0.0, abs(r - (0.3 + pulse * 0.7))) * (1.0 - pulse);
  } else {
    vec2 q = abs(vUv);
    float box = step(max(q.x, q.y), 0.9) * step(0.8, max(q.x, q.y));
    float corner = step(0.55, min(q.x, q.y));
    a = box * corner;
  }
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor * a, 1.0);
}
`;
const routeFragment = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec2 vUv;
uniform float uTime;
uniform float uLength;
uniform vec3 uColor;
void main() {
  #include <logdepthbuf_fragment>
  float along = vUv.x * uLength;
  float chevron = smoothstep(0.35, 0.5, fract(along * 0.35 - uTime * 0.9));
  gl_FragColor = vec4(uColor * (0.5 + chevron * 1.2), 1.0);
}
`;
const routeVertex = /* glsl */ `
${LOGDEPTH_VS_HEAD}
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  parent.appendChild(e);
  return e;
}

const v3 = (s: GalaxyStar) => new THREE.Vector3(s.x, s.y, s.z);

/** Max distance affordable with `fuel`, capped by the drive's range. */
export function fuelRange(fuel: number, jumpRange: number): number {
  return THREE.MathUtils.clamp((fuel - 1) / 0.6, 0, jumpRange);
}

export class GalaxyMap {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
  private readonly controls: OrbitControls;
  private readonly ui: HTMLDivElement;
  private readonly info: HTMLDivElement;
  private readonly routePanel: HTMLDivElement;
  private readonly tooltip: HTMLDivElement;
  private readonly results: HTMLDivElement;
  private readonly labelLayer: HTMLDivElement;
  private readonly labels = new Map<number, HTMLDivElement>();
  private readonly starMat: THREE.ShaderMaterial;
  private readonly starGeo: THREE.BufferGeometry;
  private readonly hazeMat: THREE.ShaderMaterial;
  private readonly nebulaMats: THREE.ShaderMaterial[] = [];
  private readonly nebulaMeshes: THREE.Mesh[] = [];
  private readonly here: THREE.Mesh;
  private readonly hereMat: THREE.ShaderMaterial;
  private readonly reticle: THREE.Mesh;
  private readonly reticleMat: THREE.ShaderMaterial;
  private readonly rangeRing: THREE.LineLoop;
  private readonly fuelRing: THREE.LineLoop;
  private readonly grid: THREE.LineSegments;
  private dropLines: THREE.LineSegments | null = null;
  private routeMesh: THREE.Mesh | null = null;
  private readonly routeMat: THREE.ShaderMaterial;
  private readonly flyTarget = new THREE.Vector3();
  private flying = 0;
  private lastDropFocus = new THREE.Vector3(1e9, 0, 0);
  private selected: number | null = null;
  private down = { x: 0, y: 0 };
  private state: GalaxyMapState | null = null;
  private routeKey = '';
  open = false;
  onPlotRoute: (to: number) => void = () => {};
  onClearRoute: () => void = () => {};
  onSetTarget: (index: number) => void = () => {};

  constructor(
    private readonly galaxy: GalaxyDef,
    private readonly pipeline: RenderPipeline,
  ) {
    const dom = pipeline.renderer.domElement;
    this.scene.background = new THREE.Color(0.002, 0.002, 0.006);
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 520;
    this.controls.screenSpacePanning = false;
    this.controls.enabled = false;
    this.controls.maxPolarAngle = Math.PI * 0.49;

    const shape = galaxy.shape;
    // Galactic disc glow (two layers for a hint of thickness).
    for (const [y, k] of [
      [0, 1],
      [-1.2, 0.35],
      [1.2, 0.35],
    ] as const) {
      const disc = new THREE.Mesh(
        new THREE.PlaneGeometry(shape.radius * 2.4, shape.radius * 2.4).rotateX(-Math.PI / 2),
        new THREE.ShaderMaterial({
          vertexShader: discVertex,
          fragmentShader: discFragment,
          uniforms: {
            uRadius: { value: shape.radius },
            uArms: { value: shape.arms },
            uTwist: { value: shape.twist },
            uScale: { value: shape.scale },
            uRotation: { value: shape.rotation },
            uBulge: { value: shape.bulgeRadius },
            uIntensity: { value: 0.32 * k },
          },
          blending: THREE.AdditiveBlending,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      disc.position.y = y;
      disc.renderOrder = -2;
      this.scene.add(disc);
    }

    // Unresolved stars: a dense haze tracing the same structure.
    this.hazeMat = new THREE.ShaderMaterial({
      vertexShader: hazeVertex,
      fragmentShader: hazeFragment,
      uniforms: { uPixelRatio: { value: 1 } },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.scene.add(this.createHaze());

    // Nebulae.
    galaxy.nebulae.forEach((n, i) => {
      const mat = new THREE.ShaderMaterial({
        vertexShader: billboardVertex,
        fragmentShader: nebulaFragment,
        uniforms: { uColor: { value: new THREE.Color(...n.color) }, uSeed: { value: i * 13.7 }, uTime: { value: 0 } },
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(n.radius * 2.6, n.radius * 2.6), mat);
      m.position.set(n.x, n.y, n.z);
      this.scene.add(m);
      this.nebulaMats.push(mat);
      this.nebulaMeshes.push(m);
    });

    // Navigable stars.
    const count = galaxy.stars.length;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const dim = new Float32Array(count).fill(1);
    for (const s of galaxy.stars) {
      pos.set([s.x, s.y, s.z], s.index * 3);
      const b = 1.4 + Math.sqrt(s.luminosity) * 1.2;
      col.set([s.color[0] * b, s.color[1] * b, s.color[2] * b], s.index * 3);
      size[s.index] = 1.2 + Math.sqrt(s.luminosity) * 0.9;
    }
    this.starGeo = new THREE.BufferGeometry();
    this.starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.starGeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    this.starGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.starGeo.setAttribute('aDim', new THREE.BufferAttribute(dim, 1));
    this.starMat = new THREE.ShaderMaterial({
      vertexShader: starVertex,
      fragmentShader: starFragment,
      uniforms: { uPixelRatio: { value: 1 }, uScale: { value: 300 } },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    const points = new THREE.Points(this.starGeo, this.starMat);
    points.frustumCulled = false;
    this.scene.add(points);

    // "You are here" ring and selection reticle.
    this.hereMat = new THREE.ShaderMaterial({
      vertexShader: billboardVertex,
      fragmentShader: ringFragment,
      uniforms: { uColor: { value: new THREE.Color(0.4, 1.0, 0.7).multiplyScalar(3) }, uTime: { value: 0 }, uMode: { value: 0 } },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.here = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), this.hereMat);
    this.scene.add(this.here);
    this.reticleMat = new THREE.ShaderMaterial({
      vertexShader: billboardVertex,
      fragmentShader: ringFragment,
      uniforms: { uColor: { value: new THREE.Color(1.0, 0.7, 0.25).multiplyScalar(3) }, uTime: { value: 0 }, uMode: { value: 1 } },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.reticle = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), this.reticleMat);
    this.reticle.visible = false;
    this.scene.add(this.reticle);

    const circle = (r: number, color: THREE.Color, opacity: number) => {
      const pts = Array.from({ length: 128 }, (_, i) => {
        const a = (i / 128) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
      });
      return new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
    };
    this.rangeRing = circle(1, new THREE.Color(0.35, 0.75, 1.0).multiplyScalar(1.6), 0.8);
    this.fuelRing = circle(1, new THREE.Color(1.0, 0.6, 0.2).multiplyScalar(1.6), 0.8);
    this.scene.add(this.rangeRing, this.fuelRing);

    // Polar grid around the current system for depth perception.
    const gridPts: THREE.Vector3[] = [];
    for (let r = 10; r <= 40; r += 10)
      for (let i = 0; i < 96; i++) {
        const a0 = (i / 96) * Math.PI * 2;
        const a1 = ((i + 1) / 96) * Math.PI * 2;
        gridPts.push(new THREE.Vector3(Math.cos(a0) * r, 0, Math.sin(a0) * r), new THREE.Vector3(Math.cos(a1) * r, 0, Math.sin(a1) * r));
      }
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      gridPts.push(new THREE.Vector3(Math.cos(a) * 4, 0, Math.sin(a) * 4), new THREE.Vector3(Math.cos(a) * 40, 0, Math.sin(a) * 40));
    }
    this.grid = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(gridPts),
      new THREE.LineBasicMaterial({ color: new THREE.Color(0.3, 0.55, 0.8), transparent: true, opacity: 0.12 }),
    );
    this.scene.add(this.grid);

    this.routeMat = new THREE.ShaderMaterial({
      vertexShader: routeVertex,
      fragmentShader: routeFragment,
      uniforms: { uTime: { value: 0 }, uLength: { value: 1 }, uColor: { value: new THREE.Color(1.0, 0.62, 0.2).multiplyScalar(2.5) } },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });

    // --- DOM.
    this.ui = document.createElement('div');
    this.ui.className = 'map-ui galaxy-ui hidden';
    document.body.appendChild(this.ui);
    this.labelLayer = el('div', 'gm-labels', this.ui);
    const title = el('div', 'title', this.ui);
    title.innerHTML = `${galaxy.name}<small>${galaxy.stars.length} systems · ${galaxy.nebulae.length} nebulae</small>`;
    const search = el('input', 'gm-search', this.ui);
    search.placeholder = 'Search systems…';
    search.spellcheck = false;
    this.results = el('div', 'gm-results', this.ui);
    search.addEventListener('input', () => this.renderSearch(search.value));
    search.addEventListener('keydown', (e) => e.stopPropagation());
    this.info = el('div', 'map-info hidden', this.ui);
    this.routePanel = el('div', 'gm-route hidden', this.ui);
    this.tooltip = el('div', 'gm-tooltip hidden', this.ui);
    const legend = el('div', 'gm-legend', this.ui);
    legend.innerHTML = `<span class="sw range"></span>Jump range <span class="sw fuel"></span>Fuel range <span class="sw route"></span>Route <span class="sw here"></span>You`;
    const hint = el('div', 'hint', this.ui);
    hint.textContent = 'DRAG rotate · RIGHT-DRAG pan · WHEEL zoom · CLICK select · DOUBLE-CLICK focus · [N] close';

    dom.addEventListener('pointerdown', (e) => (this.down = { x: e.clientX, y: e.clientY }));
    dom.addEventListener('pointerup', (e) => {
      if (!this.open || e.button !== 0) return;
      if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 5) {
        const hit = this.pick(e.clientX, e.clientY);
        if (hit !== null) this.select(hit);
      }
    });
    dom.addEventListener('dblclick', (e) => {
      if (!this.open) return;
      const hit = this.pick(e.clientX, e.clientY);
      if (hit !== null) this.flyTo(v3(galaxy.stars[hit]));
    });
    dom.addEventListener('pointermove', (e) => {
      if (!this.open) return;
      const hit = this.pick(e.clientX, e.clientY);
      if (hit === null) {
        this.tooltip.classList.add('hidden');
        return;
      }
      const s = galaxy.stars[hit];
      this.tooltip.classList.remove('hidden');
      this.tooltip.textContent = `${s.name} · ${s.spectralClass}`;
      this.tooltip.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 10}px)`;
    });
  }

  private createHaze(): THREE.Points {
    const g = this.galaxy;
    const rng = new Rng(Rng.derive(g.seed, 555));
    const n = 30000;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const gauss = () => (rng.next() + rng.next() + rng.next() - 1.5) * 1.15;
    for (let i = 0; i < n; i++) {
      let x: number, z: number, y: number;
      if (rng.next() < 0.25) {
        const r = Math.abs(gauss()) * g.shape.bulgeRadius * 0.6;
        const a = rng.range(0, Math.PI * 2);
        x = Math.cos(a) * r;
        z = Math.sin(a) * r;
        y = gauss() * 4;
      } else {
        const arm = rng.int(0, g.shape.arms - 1);
        const r = g.shape.bulgeRadius * 0.5 + Math.pow(rng.next(), 0.8) * g.shape.radius;
        const a = g.shape.rotation + (arm * 2 * Math.PI) / g.shape.arms + g.shape.twist * Math.log(1 + r / g.shape.scale) + gauss() * 0.3;
        x = Math.cos(a) * r + gauss() * 3;
        z = Math.sin(a) * r + gauss() * 3;
        y = gauss() * 1.6;
      }
      pos.set([x, y, z], i * 3);
      const warm = Math.exp(-(x * x + z * z) / (g.shape.bulgeRadius * g.shape.bulgeRadius));
      const b = rng.range(0.04, 0.14);
      col.set([b * (0.75 + warm * 0.3), b * (0.8 + warm * 0.1), b * (1.0 - warm * 0.35)], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    const pts = new THREE.Points(geo, this.hazeMat);
    pts.frustumCulled = false;
    return pts;
  }

  setOpen(open: boolean, state: GalaxyMapState): void {
    this.open = open;
    this.controls.enabled = open;
    this.ui.classList.toggle('hidden', !open);
    this.state = state;
    if (!open) return;
    const cur = v3(this.galaxy.stars[state.current]);
    this.controls.target.copy(cur);
    this.camera.position.copy(cur).add(new THREE.Vector3(0, 48, 62));
    this.flyTarget.copy(cur);
    this.flying = 0;
    this.select(state.systemTarget ?? state.route?.stars[state.route.stars.length - 1] ?? state.current);
    this.refreshRanges();
  }

  /** Called when route/fuel/target change while open. */
  refresh(state: GalaxyMapState): void {
    this.state = state;
    this.refreshRanges();
    this.renderInfo();
  }

  private refreshRanges(): void {
    const st = this.state!;
    const cur = this.galaxy.stars[st.current];
    this.here.position.set(cur.x, cur.y, cur.z);
    this.rangeRing.position.copy(this.here.position);
    this.rangeRing.scale.setScalar(st.jumpRange);
    const fr = fuelRange(st.fuel, st.jumpRange);
    this.fuelRing.position.copy(this.here.position);
    this.fuelRing.scale.setScalar(Math.max(fr, 0.01));
    this.fuelRing.visible = fr < st.jumpRange - 0.05;
    this.grid.position.copy(this.here.position);
    // Dim stars outside jump range of here.
    const dim = this.starGeo.getAttribute('aDim') as THREE.BufferAttribute;
    for (const s of this.galaxy.stars) dim.setX(s.index, starDistance(s, cur) <= st.jumpRange ? 1.25 : 0.7);
    dim.needsUpdate = true;
    this.buildRoute();
  }

  private buildRoute(): void {
    const r = this.state?.route;
    const key = r ? r.stars.join(',') : '';
    if (key === this.routeKey) return;
    this.routeKey = key;
    if (this.routeMesh) {
      this.scene.remove(this.routeMesh);
      this.routeMesh.geometry.dispose();
      this.routeMesh = null;
    }
    if (!r || r.stars.length < 2) return;
    const path = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 0; i < r.stars.length - 1; i++) path.add(new THREE.LineCurve3(v3(this.galaxy.stars[r.stars[i]]), v3(this.galaxy.stars[r.stars[i + 1]])));
    const geo = new THREE.TubeGeometry(path, r.hops.length * 24, 0.16, 6, false);
    this.routeMat.uniforms.uLength.value = path.getLength();
    this.routeMesh = new THREE.Mesh(geo, this.routeMat);
    this.scene.add(this.routeMesh);
  }

  private buildDropLines(focus: THREE.Vector3): void {
    if (focus.distanceTo(this.lastDropFocus) < 4) return;
    this.lastDropFocus.copy(focus);
    if (this.dropLines) {
      this.scene.remove(this.dropLines);
      this.dropLines.geometry.dispose();
    }
    const pts: THREE.Vector3[] = [];
    const planeY = focus.y;
    for (const s of this.galaxy.stars) {
      const d = Math.hypot(s.x - focus.x, s.z - focus.z);
      if (d > 32) continue;
      pts.push(new THREE.Vector3(s.x, s.y, s.z), new THREE.Vector3(s.x, planeY, s.z));
    }
    this.dropLines = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: new THREE.Color(0.35, 0.6, 0.85), transparent: true, opacity: 0.22 }),
    );
    this.scene.add(this.dropLines);
  }

  private flyTo(p: THREE.Vector3): void {
    this.flyTarget.copy(p);
    this.flying = 1;
  }

  private select(index: number): void {
    this.selected = index;
    this.renderInfo();
  }

  private renderSearch(q: string): void {
    this.results.innerHTML = '';
    const query = q.trim().toLowerCase();
    if (!query) return;
    const matches = this.galaxy.stars.filter((s) => s.name.toLowerCase().includes(query)).slice(0, 8);
    for (const m of matches) {
      const row = el('div', 'gm-result', this.results);
      row.textContent = `${m.name}  ·  ${m.spectralClass}`;
      row.onclick = () => {
        this.select(m.index);
        this.flyTo(v3(m));
        this.results.innerHTML = '';
      };
    }
  }

  private renderInfo(): void {
    const st = this.state;
    if (!st || this.selected === null) {
      this.info.classList.add('hidden');
      return;
    }
    const s = this.galaxy.stars[this.selected];
    const cur = this.galaxy.stars[st.current];
    const dist = starDistance(s, cur);
    const visited = st.visited.has(s.index);
    const rows: [string, string][] = [
      ['Distance', `${dist.toFixed(1)} ly`],
      ['Region', s.region[0].toUpperCase() + s.region.slice(1)],
      ['Star', `Class ${s.spectralClass} · ${Math.round(s.temperature).toLocaleString()} K`],
    ];
    if (s.nebula >= 0) rows.push(['Nebula', this.galaxy.nebulae[s.nebula].name]);
    let desc = 'Unexplored. Long-range scans resolve only the primary star.';
    if (visited) {
      const sys = generateSystem(s.seed);
      const planets = sys.bodies.filter((b) => b.kind === 'planet');
      const moons = sys.bodies.length - planets.length;
      rows.push(['Planets', `${planets.length} (+${moons} moons)`], ['Station', sys.stations[0]?.name ?? 'None']);
      const notable = [...new Set(planets.map((p) => PLANET_TYPE_LABEL[p.type]))].join(', ');
      desc = `Surveyed. ${notable} worlds.`;
    }
    if (s.index === st.current) desc = 'Your current location. ' + desc;
    const direct = dist <= st.jumpRange && s.index !== st.current;
    if (direct) rows.push(['Direct jump fuel', `${jumpFuelCost(dist, s.nebula >= 0).toFixed(1)} t`]);
    const onRoute = st.route?.stars[st.route.stars.length - 1] === s.index;
    this.info.classList.remove('hidden');
    this.info.innerHTML = `<h2>${s.name}</h2><div class="type">${visited ? 'Explored system' : 'Unexplored system'}</div><p>${desc}</p>${rows
      .map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`)
      .join('')}<div class="buttons">${
      s.index === st.current ? '' : `<button data-act="plot">${onRoute ? 'Route plotted ✓' : 'Plot route'}</button>`
    }<button class="secondary" data-act="focus">Focus</button></div>`;
    this.info.querySelector<HTMLButtonElement>('[data-act=plot]')?.addEventListener('click', () => this.onPlotRoute(s.index));
    this.info.querySelector<HTMLButtonElement>('[data-act=focus]')!.onclick = () => this.flyTo(v3(s));
    this.renderRoutePanel();
  }

  private renderRoutePanel(): void {
    const st = this.state!;
    const r = st.route;
    if (!r || r.hops.length === 0) {
      this.routePanel.classList.add('hidden');
      return;
    }
    let fuel = st.fuel;
    let warned = false;
    const rows = r.hops
      .map((h, i) => {
        fuel -= h.fuel;
        const short = fuel < 0 && !warned;
        if (short) warned = true;
        const to = this.galaxy.stars[h.to];
        return `<div class="hop ${fuel < 0 ? 'short' : ''}"><span>${i + 1}. ${to.name}${to.nebula >= 0 ? ' ☁' : ''}</span><span>${h.distance.toFixed(1)} ly · ${h.fuel.toFixed(1)} t</span></div>${
          short ? '<div class="hop-warn">⚠ Refuel before this jump — scoop at a star</div>' : ''
        }`;
      })
      .join('');
    this.routePanel.classList.remove('hidden');
    this.routePanel.innerHTML = `<h3>Route to ${this.galaxy.stars[r.stars[r.stars.length - 1]].name}</h3>
      <div class="sum">${r.hops.length} jump${r.hops.length > 1 ? 's' : ''} · ${r.totalDistance.toFixed(1)} ly · ${r.totalFuel.toFixed(1)} t fuel (have ${st.fuel.toFixed(1)} t)</div>
      <div class="hops">${rows}</div><button class="secondary" data-act="clear">Clear route</button>`;
    this.routePanel.querySelector<HTMLButtonElement>('[data-act=clear]')!.onclick = () => this.onClearRoute();
  }

  private pick(x: number, y: number): number | null {
    let best: number | null = null;
    let bestD = 14;
    const v = new THREE.Vector3();
    for (const s of this.galaxy.stars) {
      v.set(s.x, s.y, s.z).project(this.camera);
      if (v.z > 1 || v.z < -1) continue;
      const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-v.y * 0.5 + 0.5) * window.innerHeight;
      const d = Math.hypot(sx - x, sy - y);
      if (d < bestD) {
        bestD = d;
        best = s.index;
      }
    }
    return best;
  }

  private updateLabels(): void {
    const st = this.state!;
    const target = this.controls.target;
    const camDist = this.camera.position.distanceTo(target);
    const show = new Set<number>([st.current]);
    if (this.selected !== null) show.add(this.selected);
    st.route?.stars.forEach((i) => show.add(i));
    const radius = THREE.MathUtils.clamp(camDist * 0.35, 8, 60);
    const nearby = this.galaxy.stars
      .map((s) => ({ s, d: Math.hypot(s.x - target.x, s.y - target.y, s.z - target.z) }))
      .filter((e) => e.d < radius)
      .sort((a, b) => a.d - b.d)
      .slice(0, 36);
    for (const e of nearby) show.add(e.s.index);
    const v = new THREE.Vector3();
    for (const [idx, label] of this.labels) {
      if (!show.has(idx)) {
        label.remove();
        this.labels.delete(idx);
      }
    }
    // Place labels by priority, hiding any that would overlap one already placed.
    const priority = (idx: number) =>
      idx === st.current || idx === this.selected ? 0 : st.route?.stars.includes(idx) ? 1 : st.visited.has(idx) ? 2 : 3;
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    for (const idx of [...show].sort((a, b) => priority(a) - priority(b))) {
      const s = this.galaxy.stars[idx];
      v.set(s.x, s.y, s.z).project(this.camera);
      let label = this.labels.get(idx);
      if (!label) {
        label = el('div', 'gm-label', this.labelLayer);
        label.textContent = s.name;
        label.onclick = () => this.select(idx);
        this.labels.set(idx, label);
      }
      const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-v.y * 0.5 + 0.5) * window.innerHeight;
      const box = { x0: sx + 6, y0: sy - 9, x1: sx + 14 + s.name.length * 7, y1: sy + 7 };
      const overlaps = placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0);
      if (v.z > 1 || (overlaps && priority(idx) > 1)) {
        label.style.display = 'none';
        continue;
      }
      placed.push(box);
      label.style.display = '';
      label.classList.toggle('current', idx === st.current);
      label.classList.toggle('selected', idx === this.selected);
      label.classList.toggle('visited', st.visited.has(idx));
      label.classList.toggle('route', !!st.route?.stars.includes(idx));
      label.style.transform = `translate(${sx + 9}px, ${sy - 7}px)`;
    }
  }

  render(dt: number, time: number): void {
    if (!this.state) return;
    // Smooth fly-to for focus changes.
    if (this.flying > 0) {
      const k = 1 - Math.exp(-dt * 5);
      const delta = this.flyTarget.clone().sub(this.controls.target).multiplyScalar(k);
      this.controls.target.add(delta);
      this.camera.position.add(delta);
      if (this.flyTarget.distanceTo(this.controls.target) < 0.05) this.flying = 0;
    }
    this.controls.update();
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();

    const pr = this.pipeline.renderer.getPixelRatio();
    this.starMat.uniforms.uPixelRatio.value = pr;
    this.hazeMat.uniforms.uPixelRatio.value = pr;
    for (const m of this.nebulaMats) m.uniforms.uTime.value = time;
    for (const m of this.nebulaMeshes) m.quaternion.copy(this.camera.quaternion);
    const camDist = this.camera.position.distanceTo(this.controls.target);
    this.here.quaternion.copy(this.camera.quaternion);
    this.here.scale.setScalar(THREE.MathUtils.clamp(camDist / 40, 0.6, 8));
    this.hereMat.uniforms.uTime.value = time;
    if (this.selected !== null && this.selected !== this.state.current) {
      const s = this.galaxy.stars[this.selected];
      this.reticle.visible = true;
      this.reticle.position.set(s.x, s.y, s.z);
      this.reticle.quaternion.copy(this.camera.quaternion);
      this.reticle.scale.setScalar(THREE.MathUtils.clamp(camDist / 45, 0.5, 8));
    } else this.reticle.visible = false;
    this.routeMat.uniforms.uTime.value = time;
    this.buildDropLines(this.controls.target);
    this.updateLabels();

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
