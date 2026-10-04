import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { BeltDef } from '../galaxy/types';
import { type BakedMaps, PlanetBaker, disposeMaps } from '../render/bake/planetBaker';
import type { AtmosphereUniform } from '../render/pipeline';
import {
  coronaFragment,
  coronaVertex,
  planetFragment,
  proxyVertex,
  ringFragment,
  ringVertex,
  starFragment,
} from '../render/shaders/planet';
import {
  dustFragment,
  dustVertex,
  skyBakeFragment,
  skyBakeVertex,
  starPointsFragment,
  starPointsVertex,
} from '../render/shaders/sky';
import { blackbody, hsl } from '../planets/planetTypes';
import { createRockGeometry } from './rocks';
import { createStation, type StationVisual } from './stationMesh';
import type { BodyState, StationState, Universe } from './universe';

const OCEAN_KIND: Record<string, number> = { none: 0, water: 1, lava: 2, ice: 3, acid: 4, glow: 5 };
const LOW_RES = 256;
const MOON_RES = 128;
const HIGH_RES = 1024;
const MAX_HIGH = 2;

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export interface ViewContext {
  /** Camera position in system space (float64). Everything renders relative to it. */
  origin: THREE.Vector3;
  camera: THREE.PerspectiveCamera;
  time: number;
  dt: number;
  /** Pixels per radian (vertical), for LOD decisions. */
  pixelsPerRadian: number;
}

/** View-space conversion: camera sits at the render origin. */
function toView(world: THREE.Vector3, ctx: ViewContext, camInv: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(world).sub(ctx.origin).applyQuaternion(camInv);
}

function premultipliedBlending(mat: THREE.Material): void {
  mat.blending = THREE.CustomBlending;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneMinusSrcAlphaFactor;
  mat.blendSrcAlpha = THREE.OneFactor;
  mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
}

class StarView {
  readonly mesh: THREE.Mesh;
  readonly corona: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly coronaMat: THREE.ShaderMaterial;
  readonly color: THREE.Color;

  constructor(private readonly universe: Universe) {
    const star = universe.system.star;
    this.color = new THREE.Color(...star.color);
    this.material = new THREE.ShaderMaterial({
      vertexShader: proxyVertex,
      fragmentShader: starFragment,
      side: THREE.BackSide,
      uniforms: {
        uCenter: { value: new THREE.Vector3() },
        uRadius: { value: star.radius },
        uObjFromView: { value: new THREE.Matrix3() },
        uColor: { value: this.color.clone() },
        uIntensity: { value: 60 },
        uTime: { value: 0 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), this.material);
    this.mesh.scale.setScalar(star.radius * 1.01);

    const extent = 7;
    this.coronaMat = new THREE.ShaderMaterial({
      vertexShader: coronaVertex,
      fragmentShader: coronaFragment,
      uniforms: {
        uColor: { value: this.color.clone().lerp(new THREE.Color(1, 1, 1), 0.3) },
        uIntensity: { value: 6 },
        uTime: { value: 0 },
        uExtent: { value: extent },
      },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.corona = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.coronaMat);
    this.corona.scale.setScalar(star.radius * extent);
    this.corona.renderOrder = 2;
  }

  update(ctx: ViewContext, camInv: THREE.Quaternion): void {
    const star = this.universe.star;
    this.mesh.position.copy(star.position).sub(ctx.origin);
    this.corona.position.copy(this.mesh.position);
    this.corona.quaternion.copy(ctx.camera.quaternion);
    toView(star.position, ctx, camInv, this.material.uniforms.uCenter.value);
    const rot = _q.setFromAxisAngle(_v.set(0, 1, 0), ctx.time * 0.002).invert().multiply(ctx.camera.quaternion);
    (this.material.uniforms.uObjFromView.value as THREE.Matrix3).setFromMatrix4(_m4.makeRotationFromQuaternion(rot));
    this.material.uniforms.uTime.value = ctx.time;
    this.coronaMat.uniforms.uTime.value = ctx.time;
  }
}

export class PlanetView {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly ring: THREE.Mesh | null = null;
  private readonly ringMat: THREE.ShaderMaterial | null = null;
  low!: BakedMaps;
  high: BakedMaps | null = null;
  private pending: { cancel: () => void } | null = null;
  pixelRadius = 0;
  distance = Infinity;
  readonly skyColor = new THREE.Color();
  readonly cloudRadius: number;

  constructor(readonly state: BodyState, sunColor: THREE.Color) {
    const def = state.def;
    const s = def.surface;
    const atm = def.atmosphere;
    const hasClouds = s.cloudCover > 0.01;
    this.cloudRadius = hasClouds ? def.radius * (def.radius > 1e5 ? 1.003 : 1.012) : def.radius;

    if (atm) {
      const r = atm.rayleigh;
      const m = Math.max(...r);
      this.skyColor.setRGB(r[0] / m, r[1] / m, r[2] / m).multiplyScalar(0.12 * Math.min(1, m * 4));
      this.skyColor.lerp(new THREE.Color(...atm.mieColor).multiplyScalar(0.1), Math.min(0.6, atm.mie * 2));
    }
    this.material = new THREE.ShaderMaterial({
      vertexShader: proxyVertex,
      fragmentShader: planetFragment,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: true,
      uniforms: {
        uCenter: { value: new THREE.Vector3() },
        uRadius: { value: def.radius },
        uCloudRadius: { value: this.cloudRadius },
        uObjFromView: { value: new THREE.Matrix3() },
        uObjFromViewCloud: { value: new THREE.Matrix3() },
        uViewFromObj: { value: new THREE.Matrix3() },
        uAlbedo: { value: null },
        uNormalMap: { value: null },
        uSunDir: { value: new THREE.Vector3() },
        uSunColor: { value: sunColor.clone().multiplyScalar(1.8) },
        uSeaLevel: { value: s.seaLevel },
        uOceanKind: { value: OCEAN_KIND[s.oceanKind] },
        uGas: { value: def.type === 'gasGiant' ? 1 : 0 },
        uHasClouds: { value: hasClouds ? 1 : 0 },
        uCloudColor: { value: new THREE.Color(...s.cloudColor) },
        uHasAtmo: { value: atm ? 1 : 0 },
        uTau: { value: atm ? new THREE.Vector3(atm.rayleigh[0] + atm.mie, atm.rayleigh[1] + atm.mie, atm.rayleigh[2] + atm.mie) : new THREE.Vector3() },
        uSkyColor: { value: this.skyColor },
        uHasRings: { value: def.rings ? 1 : 0 },
        uRingInner: { value: def.rings?.innerRadius ?? 0 },
        uRingOuter: { value: def.rings?.outerRadius ?? 1 },
        uRingNormal: { value: new THREE.Vector3(0, 1, 0) },
        uRingSeed: { value: def.rings ? (def.rings.seed % 1000) / 10 : 0 },
        uRingOpacity: { value: def.rings?.opacity ?? 0 },
        uDetail: { value: 0 },
        uTime: { value: 0 },
        uFlow: { value: 0.35 },
        uBandFreq: { value: s.bandFreq },
      },
    });
    premultipliedBlending(this.material);
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), this.material);
    this.mesh.scale.setScalar(this.cloudRadius * 1.002);
    this.mesh.renderOrder = 0;

    if (def.rings) {
      const geo = new THREE.RingGeometry(def.rings.innerRadius, def.rings.outerRadius, 256, 1);
      geo.rotateX(-Math.PI / 2);
      this.ringMat = new THREE.ShaderMaterial({
        vertexShader: ringVertex,
        fragmentShader: ringFragment,
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uInner: { value: def.rings.innerRadius },
          uOuter: { value: def.rings.outerRadius },
          uSeed: { value: (def.rings.seed % 1000) / 10 },
          uOpacity: { value: def.rings.opacity },
          uColorA: { value: new THREE.Color(...def.rings.colorA) },
          uColorB: { value: new THREE.Color(...def.rings.colorB) },
          uSunDir: { value: new THREE.Vector3() },
          uSunColor: { value: sunColor.clone().multiplyScalar(1.8) },
          uCenter: { value: new THREE.Vector3() },
          uPlanetRadius: { value: def.radius },
          uNormal: { value: new THREE.Vector3() },
        },
      });
      premultipliedBlending(this.ringMat);
      this.ring = new THREE.Mesh(geo, this.ringMat);
      this.ring.renderOrder = 1;
      this.ring.frustumCulled = false;
    }
  }

  setMaps(maps: BakedMaps): void {
    this.material.uniforms.uAlbedo.value = maps.albedo.texture;
    this.material.uniforms.uNormalMap.value = maps.normal.texture;
  }

  get atmosphere() {
    return this.state.def.atmosphere;
  }

  update(ctx: ViewContext, camInv: THREE.Quaternion, starPos: THREE.Vector3): void {
    const st = this.state;
    const u = this.material.uniforms;
    this.mesh.position.copy(st.position).sub(ctx.origin);
    this.distance = this.mesh.position.length();
    this.pixelRadius = (Math.asin(Math.min(1, st.radius / Math.max(this.distance, st.radius))) || 0) * ctx.pixelsPerRadian;

    const center = toView(st.position, ctx, camInv, u.uCenter.value as THREE.Vector3);
    const sunDir = (u.uSunDir.value as THREE.Vector3).copy(starPos).sub(st.position).normalize().applyQuaternion(camInv);

    _q.copy(st.rotation).invert().multiply(ctx.camera.quaternion);
    _m4.makeRotationFromQuaternion(_q);
    (u.uObjFromView.value as THREE.Matrix3).setFromMatrix4(_m4);
    (u.uViewFromObj.value as THREE.Matrix3).copy(u.uObjFromView.value).transpose();
    _q.copy(st.cloudRotation).invert().multiply(ctx.camera.quaternion);
    (u.uObjFromViewCloud.value as THREE.Matrix3).setFromMatrix4(_m4.makeRotationFromQuaternion(_q));

    const altitude = this.distance - st.radius;
    u.uDetail.value = THREE.MathUtils.clamp(1 - altitude / (st.radius * 0.6), 0, 1);
    u.uTime.value = ctx.time;
    const ringNormal = (u.uRingNormal.value as THREE.Vector3).set(0, 1, 0).applyQuaternion(st.tilt).applyQuaternion(camInv);

    if (this.ring && this.ringMat) {
      this.ring.position.copy(this.mesh.position);
      this.ring.quaternion.copy(st.tilt);
      const ru = this.ringMat.uniforms;
      (ru.uSunDir.value as THREE.Vector3).copy(sunDir);
      (ru.uCenter.value as THREE.Vector3).copy(center);
      (ru.uNormal.value as THREE.Vector3).copy(ringNormal);
    }
  }

  get hasHighLod(): boolean {
    return this.high !== null || this.pending !== null;
  }

  /** Request/release high-resolution maps based on on-screen size. */
  manageLod(baker: PlanetBaker, highCount: number): void {
    if (!this.hasHighLod && this.pixelRadius > 170 && highCount < MAX_HIGH && !baker.busy) {
      const job = baker.bakeProgressive(this.state.def, HIGH_RES);
      this.pending = job;
      void job.promise.then((maps) => {
        this.pending = null;
        this.high = maps;
        this.setMaps(maps);
      });
      return;
    }
    if (this.pixelRadius < 70) {
      if (this.pending) {
        this.pending.cancel();
        this.pending = null;
      }
      if (this.high) {
        this.setMaps(this.low);
        disposeMaps(this.high);
        this.high = null;
      }
    }
  }

  atmosphereUniform(ctx: ViewContext, camInv: THREE.Quaternion, starPos: THREE.Vector3): AtmosphereUniform | null {
    const atm = this.state.def.atmosphere;
    if (!atm) return null;
    const hR = atm.height * atm.rayleighScale;
    const hM = atm.height * atm.mieScale;
    return {
      center: toView(this.state.position, ctx, camInv, new THREE.Vector3()),
      planetRadius: this.state.radius,
      topRadius: this.state.atmosphereTop,
      betaR: new THREE.Vector3(atm.rayleigh[0] / hR, atm.rayleigh[1] / hR, atm.rayleigh[2] / hR),
      betaM: atm.mie / hM,
      mieColor: new THREE.Color(...atm.mieColor),
      scaleHeightR: hR,
      scaleHeightM: hM,
      g: atm.mieG,
      sunDir: _v2.copy(starPos).sub(this.state.position).normalize().applyQuaternion(camInv).clone(),
    };
  }
}

interface LocalRock {
  position: THREE.Vector3;
  radius: number;
  axis: THREE.Vector3;
  spin: number;
  scale: THREE.Vector3;
  variant: number;
  index: number;
  color: THREE.Color;
}

const ROCK_VARIANTS = 5;
const ROCK_CELL = 4000;
const ROCK_CAPACITY = 500;

class BeltView {
  readonly group = new THREE.Group();
  readonly dust: THREE.Points;
  readonly rockGroup = new THREE.Group();
  private readonly rockMeshes: THREE.InstancedMesh[] = [];
  private readonly anchor = new THREE.Vector3();
  private cellKey = '';
  rocks: LocalRock[] = [];
  private readonly dustMat: THREE.ShaderMaterial;

  constructor(readonly def: BeltDef, sunColor: THREE.Color) {
    const rng = new Rng(def.seed);
    const count = 40000;
    const pos = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const gauss = () => (rng.next() + rng.next() + rng.next() - 1.5) / 1.5;
    for (let i = 0; i < count; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = def.radius + gauss() * def.width * 0.5;
      pos.set([Math.cos(a) * r, gauss() * def.thickness * 0.5, Math.sin(a) * r], i * 3);
      size[i] = rng.range(0.4, 2.2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.dustMat = new THREE.ShaderMaterial({
      vertexShader: dustVertex,
      fragmentShader: dustFragment,
      uniforms: {
        uPixelRatio: { value: 1 },
        uScale: { value: 4e5 },
        uColor: { value: new THREE.Color(...def.color) },
        uSunColor: { value: sunColor.clone() },
      },
      transparent: true,
      depthWrite: false,
    });
    premultipliedBlending(this.dustMat);
    this.dust = new THREE.Points(geo, this.dustMat);
    this.dust.frustumCulled = false;
    this.group.add(this.dust);

    const rockMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.92, metalness: 0.05, flatShading: true });
    for (let v = 0; v < ROCK_VARIANTS; v++) {
      const mesh = new THREE.InstancedMesh(createRockGeometry(def.seed + v * 101, 2), rockMat, ROCK_CAPACITY);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.rockMeshes.push(mesh);
      this.rockGroup.add(mesh);
    }
  }

  /** Signed-ish distance from a point to the belt's core torus. */
  distanceToCore(p: THREE.Vector3): number {
    const r = Math.hypot(p.x, p.z);
    return Math.hypot(r - this.def.radius, p.y);
  }

  private rebuild(cam: THREE.Vector3): void {
    const cx = Math.floor(cam.x / ROCK_CELL);
    const cy = Math.floor(cam.y / ROCK_CELL);
    const cz = Math.floor(cam.z / ROCK_CELL);
    const key = `${cx},${cy},${cz}`;
    if (key === this.cellKey) return;
    this.cellKey = key;
    this.anchor.set(cx * ROCK_CELL, cy * ROCK_CELL, cz * ROCK_CELL);
    this.rocks = [];
    const counts = new Array(ROCK_VARIANTS).fill(0);
    const base = new THREE.Color(...this.def.color);
    for (let dz = -3; dz <= 3; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const ix = cx + dx;
          const iy = cy + dy;
          const iz = cz + dz;
          const rng = new Rng(Rng.derive(Rng.derive(Rng.derive(this.def.seed, ix), iy), iz));
          const centre = _v.set((ix + 0.5) * ROCK_CELL, (iy + 0.5) * ROCK_CELL, (iz + 0.5) * ROCK_CELL);
          const core = this.distanceToCore(centre);
          const density = Math.exp(-Math.pow(core / (this.def.width * 0.35), 2)) * Math.exp(-Math.pow(centre.y / (this.def.thickness * 0.5), 2));
          const n = Math.floor(density * 5 + rng.next());
          for (let k = 0; k < n; k++) {
            const variant = rng.int(0, ROCK_VARIANTS - 1);
            if (counts[variant] >= ROCK_CAPACITY) continue;
            const radius = 12 * Math.pow(rng.range(0.02, 1), -0.75);
            const position = new THREE.Vector3(
              (ix + rng.next()) * ROCK_CELL,
              (iy + rng.next()) * ROCK_CELL,
              (iz + rng.next()) * ROCK_CELL,
            );
            this.rocks.push({
              position,
              radius: Math.min(radius, 450),
              axis: new THREE.Vector3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalize(),
              spin: rng.range(-0.15, 0.15),
              scale: new THREE.Vector3(1, 1, 1),
              variant,
              index: counts[variant]++,
              color: base.clone().offsetHSL(rng.range(-0.03, 0.03), rng.range(-0.05, 0.05), rng.range(-0.08, 0.08)),
            });
          }
        }
    this.rockMeshes.forEach((m, v) => {
      m.count = counts[v];
    });
    for (const r of this.rocks) this.rockMeshes[r.variant].setColorAt(r.index, r.color);
    for (const m of this.rockMeshes) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }

  update(ctx: ViewContext, starPos: THREE.Vector3, pixelRatio: number): void {
    this.group.position.copy(starPos).sub(ctx.origin);
    this.dustMat.uniforms.uPixelRatio.value = pixelRatio;
    // Local rock field only near the belt.
    const camLocal = _v2.copy(ctx.origin).sub(starPos);
    const near = this.distanceToCore(camLocal) < this.def.width * 0.9;
    this.rockGroup.visible = near;
    if (!near) {
      if (this.rocks.length) {
        this.rocks = [];
        this.cellKey = '';
        for (const m of this.rockMeshes) m.count = 0;
      }
      return;
    }
    this.rebuild(camLocal);
    this.rockGroup.position.copy(this.anchor).add(starPos).sub(ctx.origin);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (const r of this.rocks) {
      q.setFromAxisAngle(r.axis, ctx.time * r.spin + r.index);
      m.compose(_v.copy(r.position).sub(this.anchor), q, r.scale.setScalar(r.radius));
      this.rockMeshes[r.variant].setMatrixAt(r.index, m);
    }
    for (const mesh of this.rockMeshes) mesh.instanceMatrix.needsUpdate = true;
  }

  /** Rocks in system space, for collisions. */
  worldRocks(starPos: THREE.Vector3): { position: THREE.Vector3; radius: number }[] {
    return this.rocks.map((r) => ({ position: r.position.clone().add(starPos), radius: r.radius * 0.85 }));
  }
}

class StationView {
  readonly visual: StationVisual;
  constructor(readonly state: StationState) {
    this.visual = createStation(state.def.seed, state.def.radius);
  }
  update(ctx: ViewContext): void {
    this.visual.root.position.copy(this.state.position).sub(ctx.origin);
    this.visual.root.quaternion.copy(this.state.rotation);
    this.visual.update(ctx.dt, ctx.time);
  }
}

/** Builds and updates every renderable in a star system. */
export class SystemView {
  readonly star: StarView;
  readonly planets: PlanetView[] = [];
  readonly belts: BeltView[] = [];
  readonly stations: StationView[] = [];
  readonly sunLight: THREE.DirectionalLight;
  readonly fillLight: THREE.HemisphereLight;
  readonly sunColor: THREE.Color;
  private skyRT: THREE.WebGLCubeRenderTarget | null = null;
  private readonly starPointsMat: THREE.ShaderMaterial;
  private readonly camInv = new THREE.Quaternion();

  constructor(
    readonly scene: THREE.Scene,
    readonly universe: Universe,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly baker: PlanetBaker,
  ) {
    this.sunColor = new THREE.Color(...universe.system.star.color);
    this.star = new StarView(universe);
    scene.add(this.star.mesh, this.star.corona);
    for (const b of universe.bodies) {
      const pv = new PlanetView(b, this.sunColor);
      this.planets.push(pv);
      scene.add(pv.mesh);
      if (pv.ring) scene.add(pv.ring);
    }
    for (const def of universe.system.belts) {
      const bv = new BeltView(def, this.sunColor);
      this.belts.push(bv);
      scene.add(bv.group, bv.rockGroup);
    }
    for (const st of universe.stations) {
      const sv = new StationView(st);
      this.stations.push(sv);
      scene.add(sv.visual.root);
    }

    this.sunLight = new THREE.DirectionalLight(this.sunColor, 3.2);
    scene.add(this.sunLight, this.sunLight.target);
    this.fillLight = new THREE.HemisphereLight(0x000000, 0x000000, 1);
    scene.add(this.fillLight);

    const { points, material } = this.createStarPoints();
    this.starPointsMat = material;
    scene.add(points);
  }

  private createStarPoints(): { points: THREE.Points; material: THREE.ShaderMaterial } {
    const rng = new Rng(Rng.derive(this.universe.system.seed, 3));
    const count = 3500;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const phase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const u = rng.range(-1, 1);
      const th = rng.range(0, Math.PI * 2);
      const s = Math.sqrt(1 - u * u);
      pos.set([s * Math.cos(th) * 1000, u * 1000, s * Math.sin(th) * 1000], i * 3);
      const mag = Math.pow(rng.next(), 6);
      const c = blackbody(rng.range(3000, 15000));
      const b = 0.25 + mag * 6;
      col.set([c[0] * b, c[1] * b, c[2] * b], i * 3);
      size[i] = 2.2 + mag * 7;
      phase[i] = rng.next();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    const material = new THREE.ShaderMaterial({
      vertexShader: starPointsVertex,
      fragmentShader: starPointsFragment,
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: 1 } },
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: false,
    });
    const points = new THREE.Points(geo, material);
    points.frustumCulled = false;
    points.renderOrder = -10;
    return { points, material };
  }

  /** Bake skybox + low-res surfaces. Yields between bodies so the loading bar can update. */
  async bake(onProgress: (f: number, label: string) => void): Promise<void> {
    const total = this.planets.length + 1;
    onProgress(0, 'Charting nebulae');
    await nextFrame();
    this.bakeSky();
    for (let i = 0; i < this.planets.length; i++) {
      const pv = this.planets[i];
      onProgress((i + 1) / total, `Surveying ${pv.state.name}`);
      await nextFrame();
      pv.low = this.baker.bakeNow(pv.state.def, pv.state.def.kind === 'moon' ? MOON_RES : LOW_RES);
      pv.setMaps(pv.low);
    }
    onProgress(1, 'Ready');
  }

  private bakeSky(): void {
    const sys = this.universe.system;
    const rng = new Rng(Rng.derive(sys.seed, 77));
    const size = 1024;
    const rt = new THREE.WebGLCubeRenderTarget(size, {
      type: THREE.UnsignedByteType,
      colorSpace: THREE.SRGBColorSpace,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      depthBuffer: false,
    });
    const palettes: [number, number, number][] = [
      [190, 280, 330],
      [210, 300, 20],
      [10, 40, 200],
      [150, 190, 280],
      [260, 320, 180],
      [30, 200, 340],
    ];
    const [h1, h2, h3] = rng.pick(palettes);
    const jitter = () => rng.range(-15, 15);
    const mat = new THREE.ShaderMaterial({
      vertexShader: skyBakeVertex,
      fragmentShader: skyBakeFragment,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uSeed: { value: new THREE.Vector3(rng.range(-100, 100), rng.range(-100, 100), rng.range(-100, 100)) },
        uColA: { value: new THREE.Color(...hsl(h1 + jitter(), 0.75, 0.45)) },
        uColB: { value: new THREE.Color(...hsl(h2 + jitter(), 0.7, 0.4)) },
        uColC: { value: new THREE.Color(...hsl(h3 + jitter(), 0.8, 0.6)) },
        uGalaxyNormal: { value: new THREE.Vector3(rng.range(-0.4, 0.4), 1, rng.range(-0.4, 0.4)).normalize() },
        uDensity: { value: rng.range(0.1, 0.22) },
      },
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), mat));
    const cam = new THREE.CubeCamera(0.01, 10, rt);
    const prevAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = true;
    cam.update(this.renderer, scene);
    this.renderer.autoClear = prevAutoClear;
    mat.dispose();
    this.skyRT = rt;
    this.scene.background = rt.texture;
    this.scene.backgroundIntensity = 1;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromCubemap(rt.texture).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
  }

  get skyTexture(): THREE.Texture | null {
    return this.skyRT?.texture ?? null;
  }

  update(ctx: ViewContext, pixelRatio: number): { atmospheres: AtmosphereUniform[] } {
    const camInv = this.camInv.copy(ctx.camera.quaternion).invert();
    const starPos = this.universe.star.position;
    this.star.update(ctx, camInv);
    this.starPointsMat.uniforms.uTime.value = ctx.time;
    this.starPointsMat.uniforms.uPixelRatio.value = pixelRatio;

    for (const pv of this.planets) pv.update(ctx, camInv, starPos);
    // Closest-looking bodies get first claim on high-res bakes.
    const byScreen = [...this.planets].sort((a, b) => b.pixelRadius - a.pixelRadius);
    for (const pv of byScreen) pv.manageLod(this.baker, this.planets.filter((p) => p.hasHighLod).length);
    this.baker.update(2);
    for (const b of this.belts) b.update(ctx, starPos, pixelRatio);
    for (const s of this.stations) s.update(ctx);

    // Sun light comes from the star toward the camera region.
    this.sunLight.position.copy(starPos).sub(ctx.origin).normalize();
    this.sunLight.target.position.set(0, 0, 0);

    // Atmospheres: pick the largest on screen (or the one we're inside), sort far → near.
    const candidates: { pv: PlanetView; score: number }[] = [];
    for (const pv of this.planets) {
      if (!pv.atmosphere) continue;
      const top = pv.state.atmosphereTop;
      const view = _v.copy(pv.state.position).sub(ctx.origin).applyQuaternion(camInv);
      const inside = pv.distance < top;
      if (!inside && view.z > top) continue; // behind the camera
      const score = inside ? Infinity : top / pv.distance;
      if (score * ctx.pixelsPerRadian < 1.5) continue;
      candidates.push({ pv, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    const atmospheres = candidates
      .slice(0, 4)
      .sort((a, b) => b.pv.distance - a.pv.distance)
      .map((c) => c.pv.atmosphereUniform(ctx, camInv, starPos)!)
      .filter(Boolean);
    return { atmospheres };
  }

  /** Light the ship/station: sun (with planet shadowing) + reflected light from the nearest planet. */
  updateLocalLighting(at: THREE.Vector3): void {
    const starPos = this.universe.star.position;
    const toStar = _v.copy(starPos).sub(at);
    const dist = toStar.length();
    toStar.normalize();
    let light = 1;
    let nearest: PlanetView | null = null;
    let nearestScore = 0;
    for (const pv of this.planets) {
      const rel = _v2.copy(pv.state.position).sub(at);
      const t = rel.dot(toStar);
      if (t > 0 && t < dist) {
        const perp = Math.sqrt(Math.max(0, rel.lengthSq() - t * t));
        const r = pv.state.radius;
        // Soft penumbra over 1.5% of the radius.
        light = Math.min(light, THREE.MathUtils.smoothstep(perp, r * 0.985, r * 1.015));
      }
      const score = (pv.state.radius / rel.length()) ** 2;
      if (score > nearestScore) {
        nearestScore = score;
        nearest = pv;
      }
    }
    this.sunLight.intensity = 3.2 * light;
    if (nearest && nearestScore > 1e-4) {
      // Planetshine: tinted by the planet's dominant colour, scaled by its lit fraction.
      const dir = _v2.copy(nearest.state.position).sub(at).normalize();
      const litFrac = THREE.MathUtils.clamp(0.5 - 0.5 * dir.dot(toStar), 0, 1);
      const c = nearest.state.def.surface;
      const tint = new THREE.Color(...(nearest.state.def.type === 'ocean' || nearest.state.def.type === 'terran' ? c.deep : c.low));
      tint.lerp(nearest.skyColor.clone().multiplyScalar(6), 0.4);
      this.fillLight.color.copy(tint).multiplyScalar(Math.min(1, nearestScore * 4) * litFrac * 1.5);
      this.fillLight.groundColor.setRGB(0.004, 0.005, 0.008);
      this.fillLight.position.copy(dir);
    } else {
      this.fillLight.color.setRGB(0, 0, 0);
    }
  }

  rockColliders(): { position: THREE.Vector3; radius: number }[] {
    const starPos = this.universe.star.position;
    return this.belts.flatMap((b) => b.worldRocks(starPos));
  }
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
