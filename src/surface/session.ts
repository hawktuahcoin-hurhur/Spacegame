import * as THREE from 'three';
import type { AudioEngine } from '../audio/audio';
import { COMMODITIES, ci } from '../campaign/defs';
import type { Input } from '../core/input';
import type { BodyDef } from '../galaxy/types';
import { type PlayerState, cargoFree } from '../player';
import type { RenderPipeline } from '../render/pipeline';
import type { Loadout } from '../ships/defs';
import { type ShipVisual, buildShip } from '../ships/shipBuilder';
import { type CodexEntry, type CodexKind, codexValue, speciesName } from './codex';
import { FaunaManager, type Creature, speciesFor } from './fauna';
import { hash2 } from './noise';
import { POI_CELL, type Poi, buildPoi, placePois } from './pois';
import { type SurfaceProfile, surfaceProfile } from './profile';
import { type PlacedProp, type PropModel, depositModel, floraModel, placeDeposits, placeFlora } from './props';
import { Sky } from './sky';
import { Terrain } from './terrain';

const CHUNK = 64;
const RADIUS = 10;
const LOD0 = 4;
const DENSE = 3;
const EYE = 1.7;

export interface SurfaceHost {
  player: PlayerState;
  day: number;
  systemName: string;
  input: Input;
  audio: AudioEngine;
  pipeline: RenderPipeline;
  sensitivity: number;
  invertY: boolean;
  toast(msg: string, kind?: '' | 'warn' | 'good'): void;
  /** Back aboard and climbing out: return to orbit. */
  onTakeoff(): void;
  /** Persisted per-planet deltas. */
  harvested: Set<string>;
  looted: Set<string>;
}

export interface SurfaceSite {
  body: BodyDef;
  /** Unit direction from the planet centre to the landing site (planet frame). */
  dir: THREE.Vector3;
  /** Direction to the star at landing time (planet frame). */
  toStar: THREE.Vector3;
  starColor: THREE.Color;
  flagship: Loadout;
}

interface Chunk {
  key: string;
  cx: number;
  cz: number;
  lod: number;
  dense: boolean;
  mesh: THREE.Mesh;
  props: THREE.InstancedMesh[];
  placed: PlacedProp[];
  deposits: Deposit[];
}

interface Deposit {
  id: string;
  x: number;
  y: number;
  z: number;
  res: number;
  amount: number;
  group: THREE.Group;
}

export type Tool = 'mining' | 'scanner';

interface AimTarget {
  kind: AimInfo['kind'];
  d: number;
  id: string;
  name: string;
  detail: string;
  scanned: boolean;
  deposit?: Deposit;
  creature?: Creature;
  flora?: PlacedProp;
}

/** What the crosshair is on, for the HUD. */
export interface AimInfo {
  kind: 'creature' | 'flora' | 'deposit' | 'poi' | 'ship' | 'none';
  name: string;
  detail: string;
  distance: number;
  scanned: boolean;
  progress: number;
}

export interface SurfaceHudState {
  planet: string;
  system: string;
  biome: string;
  hazard: { label: string; protection: number; active: boolean };
  health: number;
  jetpack: number;
  stamina: number;
  tool: Tool;
  heat: number;
  overheated: boolean;
  aim: AimInfo;
  prompt: string | null;
  compass: { heading: number; markers: { bearing: number; label: string; kind: string; distance: number }[] };
  cargo: { used: number; capacity: number };
  pulse: number;
  dayLight: number;
  state: 'descend' | 'walk' | 'ascend';
  fade: number;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();

/**
 * A landed visit to a planet (SUPERPLAN Phase 7): its own scene with
 * streamed low-poly terrain, flora, wildlife, ruins and wrecks, an on-foot
 * explorer with a jetpack, mining beam and scanner, and the cinematic
 * landing and take-off that bracket it.
 */
export class SurfaceSession {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(72, 1, 0.1, 6000);
  readonly profile: SurfaceProfile;
  readonly terrain: Terrain;
  private readonly sky: Sky;
  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly sunDir = new THREE.Vector3();
  private readonly sunColor = new THREE.Color();
  private readonly chunks = new Map<string, Chunk>();
  private readonly floraModels: PropModel[];
  private readonly depositModels: PropModel[];
  private readonly floraMat: THREE.MeshStandardMaterial;
  private readonly glowMats: THREE.MeshBasicMaterial[];
  private readonly terrainMat: THREE.MeshStandardMaterial;
  private readonly water: THREE.Mesh | null;
  private readonly pois = new Map<string, Poi>();
  private readonly fauna: FaunaManager;
  private readonly ship: ShipVisual;
  private readonly shipPos = new THREE.Vector3();
  private readonly viewModel = new THREE.Group();
  private readonly toolMeshes: Record<Tool, THREE.Group>;
  private readonly beam: THREE.Mesh;
  private readonly beamHit: THREE.Mesh;
  private readonly pulseRing: THREE.Mesh;

  // Player.
  readonly pos = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private yaw = 0;
  private pitch = 0;
  private onGround = false;
  private jetpack = 1;
  private stamina = 1;
  private protection = 1;
  private health = 1;
  tool: Tool = 'mining';
  private heat = 0;
  private overheated = 0;
  private scanTarget: string | null = null;
  private scanProgress = 0;
  private pulseT = 99;
  private pulseCooldown = 0;
  private bob = 0;
  private time = 0;
  private aim: AimInfo = { kind: 'none', name: '', detail: '', distance: 0, scanned: false, progress: 0 };
  private prompt: string | null = null;
  private aimAction: (() => void) | null = null;
  state: 'descend' | 'walk' | 'ascend' = 'descend';
  private stateT = 0;
  private fade = 1;
  private warnedHazard = false;
  private readonly speciesNames: string[];
  readonly species;
  private minedSinceToast = 0;
  private lastStep = 0;

  constructor(
    readonly site: SurfaceSite,
    private readonly host: SurfaceHost,
  ) {
    const body = site.body;
    this.profile = surfaceProfile(body);
    const p = this.profile;
    // Longitude/latitude → noise offset, so every landing spot is its own place.
    const lon = Math.atan2(site.dir.z, site.dir.x);
    const lat = Math.asin(THREE.MathUtils.clamp(site.dir.y, -1, 1));
    this.terrain = new Terrain(p, lon * body.radius, lat * body.radius);
    this.species = speciesFor(p);
    this.speciesNames = this.species.map((s) => speciesName(p.seed, s.index, 'fauna'));

    // Sun in the local frame: up = surface normal.
    const up = site.dir.clone().normalize();
    const east = new THREE.Vector3(0, 1, 0).cross(up);
    if (east.lengthSq() < 1e-6) east.set(1, 0, 0);
    east.normalize();
    const north = up.clone().cross(east).normalize();
    this.sunDir.set(site.toStar.dot(east), site.toStar.dot(up), -site.toStar.dot(north)).normalize();
    this.sunColor.copy(site.starColor);
    if (p.hasAtmosphere && this.sunDir.y < 0.3) this.sunColor.lerp(new THREE.Color(1, 0.55, 0.3), THREE.MathUtils.smoothstep(0.3 - this.sunDir.y, 0, 0.35) * 0.6);

    this.sky = new Sky(p);
    this.scene.add(this.sky.mesh);
    const day = p.hasAtmosphere ? Sky.daylight(this.sunDir.y) : 1;
    const lit = Math.max(0, this.sunDir.y) > 0 ? 1 : 0;
    this.sun = new THREE.DirectionalLight(this.sunColor, (2.6 * lit + 0.05) * (p.hasAtmosphere ? Math.max(day, 0.2) : 1));
    this.sun.castShadow = true;
    const q = host.pipeline.renderer.getPixelRatio() > 1 ? 2048 : 1536;
    this.sun.shadow.mapSize.set(q, q);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -70;
    sc.right = sc.top = 70;
    sc.near = 1;
    sc.far = 500;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.4;
    this.scene.add(this.sun, this.sun.target);
    const skyCol = p.sky.zenith.clone().lerp(p.sky.horizon, 0.5).multiplyScalar(p.hasAtmosphere ? day : 0.15);
    this.hemi = new THREE.HemisphereLight(skyCol.clone().multiplyScalar(1.6).addScalar(0.04), p.ramp.low.clone().multiplyScalar(0.5 * Math.max(day, 0.15)), 1.1);
    this.scene.add(this.hemi);
    // Starlight so night is dark but playable.
    this.scene.add(new THREE.AmbientLight(new THREE.Color(0.25, 0.3, 0.45), p.hasAtmosphere ? 0.25 + (1 - day) * 0.5 : 0.35));
    const fog = this.sky.fogColor(new THREE.Color(), this.sunDir.y);
    this.scene.fog = new THREE.Fog(fog, p.hasAtmosphere ? 120 + (1 - Math.min(1, p.sky.haze)) * 220 : 400, RADIUS * CHUNK * 0.98);

    // Materials.
    this.terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
    this.floraMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.8 });
    this.floraModels = p.flora.map((f, i) => floraModel(f, p.seed + i));
    this.glowMats = p.flora.map((f) => new THREE.MeshBasicMaterial({ color: f.accent.clone().multiplyScalar(1 + f.glow * 2.5), vertexColors: false }));
    this.depositModels = p.resources.map((r) => depositModel(r));

    // Sea / lava / ice.
    if (this.terrain.seaLevel !== null) {
      const kind = p.oceanKind;
      const mat =
        kind === 'lava'
          ? new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 0.9, 0.2) })
          : kind === 'glow'
            ? new THREE.MeshBasicMaterial({ color: p.ramp.shallow.clone().multiplyScalar(2.2) })
            : kind === 'ice'
              ? new THREE.MeshStandardMaterial({ color: '#d8f0ff', roughness: 0.25, metalness: 0.1, flatShading: true })
              : new THREE.MeshStandardMaterial({
                  color: kind === 'acid' ? p.ramp.shallow.clone().lerp(new THREE.Color('#7dff6a'), 0.4) : p.ramp.shallow,
                  roughness: 0.12,
                  metalness: 0.25,
                  transparent: true,
                  opacity: 0.82,
                });
      this.water = new THREE.Mesh(new THREE.PlaneGeometry(RADIUS * CHUNK * 2.4, RADIUS * CHUNK * 2.4, 1, 1).rotateX(-Math.PI / 2), mat);
      this.water.position.y = this.terrain.seaLevel;
      this.water.receiveShadow = true;
      this.scene.add(this.water);
    } else this.water = null;

    // Wildlife.
    this.fauna = new FaunaManager(this.species, this.terrain, p.seed);
    this.scene.add(this.fauna.group);

    // The ship, parked on the landing site.
    this.ship = buildShip(site.flagship);
    this.ship.root.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
    });
    const groundY = this.terrain.height(0, 0);
    this.shipPos.set(0, groundY + this.ship.radius * 0.18, 0);
    this.ship.root.position.copy(this.shipPos).add(new THREE.Vector3(0, 260, 140));
    this.ship.root.rotation.y = 0.4;
    this.scene.add(this.ship.root);
    // Landing struts.
    const strutMat = new THREE.MeshStandardMaterial({ color: '#30343a', metalness: 0.6, roughness: 0.4 });
    for (const [x, z] of [
      [0.5, -0.35],
      [-0.5, -0.35],
      [0, 0.4],
    ]) {
      const s = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 1, 5), strutMat);
      s.scale.set(this.ship.radius * 0.25, this.ship.radius * 0.22, this.ship.radius * 0.25);
      s.position.set(x * this.ship.radius * 0.6, -this.ship.radius * 0.12, z * this.ship.length * 0.6);
      this.ship.body.add(s);
    }

    // First-person tools.
    this.camera.add(this.viewModel);
    this.scene.add(this.camera);
    this.toolMeshes = { mining: this.buildTool('#ff8a3d'), scanner: this.buildTool('#5fd4ff') };
    for (const t of Object.values(this.toolMeshes)) this.viewModel.add(t);
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 6, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 1.4, 0.4), transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.beam.visible = false;
    this.beam.frustumCulled = false;
    this.scene.add(this.beam);
    this.beamHit = new THREE.Mesh(new THREE.IcosahedronGeometry(0.25, 1), new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 2, 0.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.beamHit.visible = false;
    this.scene.add(this.beamHit);
    this.pulseRing = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 1.6, 2.4), transparent: true, opacity: 0.25, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending, wireframe: true }));
    this.pulseRing.visible = false;
    this.scene.add(this.pulseRing);

    // Build the ground under us before the first frame.
    this.pos.set(0, groundY + 2, 0);
    this.streamChunks(1e9);
    host.pipeline.renderer.shadowMap.enabled = true;
    host.pipeline.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  private buildTool(color: string): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.MeshStandardMaterial({ color: '#2b3038', metalness: 0.6, roughness: 0.35 });
    const accent = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2) });
    const a = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.11, 0.42), body);
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.22, 8).rotateX(Math.PI / 2), body);
    b.position.set(0, 0.01, -0.3);
    const c = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.08), body);
    c.position.set(0, -0.11, 0.08);
    c.rotation.x = 0.3;
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.02, 0.3), accent);
    strip.position.set(0, 0.06, 0);
    const tip = new THREE.Mesh(new THREE.IcosahedronGeometry(0.03, 0), accent);
    tip.position.set(0, 0.01, -0.42);
    g.add(a, b, c, strip, tip);
    g.position.set(0.24, -0.2, -0.82);
    g.rotation.y = -0.08;
    g.scale.setScalar(0.5);
    g.traverse((o) => ((o as THREE.Mesh).renderOrder = 20));
    return g;
  }

  // ---------------------------------------------------------------- streaming

  private chunkKey(cx: number, cz: number): string {
    return `${cx},${cz}`;
  }

  /** Build missing chunks nearest first, within a time budget (ms). */
  private streamChunks(budget: number): void {
    const t0 = performance.now();
    const pcx = Math.floor(this.pos.x / CHUNK);
    const pcz = Math.floor(this.pos.z / CHUNK);
    const want: { cx: number; cz: number; d: number }[] = [];
    for (let j = -RADIUS; j <= RADIUS; j++)
      for (let i = -RADIUS; i <= RADIUS; i++) {
        const d = Math.hypot(i, j);
        if (d > RADIUS + 0.5) continue;
        want.push({ cx: pcx + i, cz: pcz + j, d });
      }
    want.sort((a, b) => a.d - b.d);
    const keep = new Set<string>();
    for (const w of want) {
      const key = this.chunkKey(w.cx, w.cz);
      keep.add(key);
      const lod = w.d <= LOD0 ? 0 : 1;
      const dense = w.d <= DENSE;
      const have = this.chunks.get(key);
      if (have && have.lod === lod && have.dense === dense) continue;
      if (performance.now() - t0 > budget) continue;
      if (have) this.disposeChunk(have);
      this.chunks.set(key, this.buildChunk(w.cx, w.cz, lod, dense));
    }
    for (const [key, c] of this.chunks) if (!keep.has(key)) this.disposeChunk(c);
    // POIs on a coarser grid.
    const gx = Math.floor(this.pos.x / POI_CELL);
    const gz = Math.floor(this.pos.z / POI_CELL);
    for (let j = -2; j <= 2; j++)
      for (let i = -2; i <= 2; i++) {
        const key = `${gx + i},${gz + j}`;
        if (this.pois.has(key)) continue;
        const poi = placePois(this.terrain, this.profile, gx + i, gz + j);
        this.pois.set(key, poi ?? (null as unknown as Poi));
      }
    for (const poi of this.pois.values()) {
      if (!poi) continue;
      const d = Math.hypot(poi.x - this.pos.x, poi.z - this.pos.z);
      if (d < 700 && !poi.group && performance.now() - t0 < budget + 4) {
        buildPoi(poi, this.terrain, this.profile);
        poi.group!.traverse((o) => {
          o.castShadow = true;
          o.receiveShadow = true;
        });
        this.scene.add(poi.group!);
      } else if (d > 900 && poi.group) {
        this.scene.remove(poi.group);
        poi.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
        poi.group = null;
      }
      if (d < 60) poi.known = true;
    }
  }

  private buildChunk(cx: number, cz: number, lod: number, dense: boolean): Chunk {
    const geo = this.terrain.buildChunk(cx * CHUNK, cz * CHUNK, CHUNK, lod === 0 ? 16 : 8);
    const mesh = new THREE.Mesh(geo, this.terrainMat);
    mesh.position.set(cx * CHUNK, 0, cz * CHUNK);
    mesh.receiveShadow = true;
    mesh.castShadow = lod === 0;
    this.scene.add(mesh);
    const placed = placeFlora(this.terrain, this.profile, this.floraModels, cx, cz, CHUNK, dense);
    const props: THREE.InstancedMesh[] = [];
    const bySpec = new Map<number, PlacedProp[]>();
    for (const p of placed) (bySpec.get(p.spec) ?? bySpec.set(p.spec, []).get(p.spec)!).push(p);
    for (const [si, list] of bySpec) {
      const model = this.floraModels[si];
      const build = (geo2: THREE.BufferGeometry, mat: THREE.Material, shadow: boolean) => {
        const im = new THREE.InstancedMesh(geo2, mat, list.length);
        list.forEach((p, i) => {
          _m.compose(_v.set(p.x, p.y, p.z), _q.setFromAxisAngle(_v2.set(0, 1, 0), p.rot), _v2.setScalar(p.scale));
          im.setMatrixAt(i, _m);
        });
        im.castShadow = shadow;
        im.receiveShadow = true;
        im.computeBoundingSphere();
        this.scene.add(im);
        props.push(im);
      };
      build(model.body, this.floraMat, lod === 0 && model.height > 1.2);
      if (model.glow) build(model.glow, this.glowMats[si], false);
    }
    const deposits: Deposit[] = [];
    for (const d of placeDeposits(this.terrain, this.profile, cx, cz, CHUNK)) {
      if (this.host.harvested.has(`${this.profile.seed}:${d.id}`)) continue;
      const model = this.depositModels[d.res];
      const g = new THREE.Group();
      const body = new THREE.Mesh(model.body, this.floraMat);
      body.castShadow = true;
      g.add(body);
      if (model.glow) g.add(new THREE.Mesh(model.glow, new THREE.MeshBasicMaterial({ color: this.profile.resources[d.res].color.clone().multiplyScalar(2.2) })));
      g.position.set(d.x, d.y, d.z);
      g.rotation.y = hash2(cx, cz, d.res) * 6;
      this.scene.add(g);
      deposits.push({ ...d, group: g });
    }
    return { key: this.chunkKey(cx, cz), cx, cz, lod, dense, mesh, props, placed, deposits };
  }

  private disposeChunk(c: Chunk): void {
    this.scene.remove(c.mesh);
    c.mesh.geometry.dispose();
    for (const p of c.props) {
      this.scene.remove(p);
      p.dispose();
    }
    for (const d of c.deposits) {
      this.scene.remove(d.group);
      d.group.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (m && m !== this.floraMat) m.dispose();
      });
    }
    this.chunks.delete(c.key);
  }

  /** Chunks within `r` metres of a point. */
  private nearChunks(x: number, z: number, r: number): Chunk[] {
    const out: Chunk[] = [];
    const n = Math.ceil(r / CHUNK);
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    for (let j = -n; j <= n; j++)
      for (let i = -n; i <= n; i++) {
        const c = this.chunks.get(this.chunkKey(cx + i, cz + j));
        if (c) out.push(c);
      }
    return out;
  }

  // ---------------------------------------------------------------- update

  update(dt: number, mouse: { dx: number; dy: number }): void {
    this.time += dt;
    this.stateT += dt;
    const input = this.host.input;
    if (this.state === 'descend') this.updateDescent();
    else if (this.state === 'ascend') this.updateAscent();
    else this.updateWalk(dt, input, mouse);
    this.fauna.update(dt, this.time, this.pos);
    this.streamChunks(this.state === 'walk' ? 5 : 12);
    if (this.water) this.water.position.set(Math.round(this.pos.x / 64) * 64, this.terrain.seaLevel!, Math.round(this.pos.z / 64) * 64);
    // Ship engines idle while parked.
    this.ship.update(dt, this.time, this.state === 'walk' ? 0 : 0.6, this.state === 'ascend' && this.stateT > 1.2, 0, 0, 0);
    // Pulse ring.
    this.pulseT += dt;
    this.pulseCooldown = Math.max(0, this.pulseCooldown - dt);
    this.pulseRing.visible = this.pulseT < 1.4;
    if (this.pulseRing.visible) {
      this.pulseRing.position.copy(this.pos);
      this.pulseRing.scale.setScalar(5 + this.pulseT * 260);
      (this.pulseRing.material as THREE.MeshBasicMaterial).opacity = 0.25 * (1 - this.pulseT / 1.4);
    }
  }

  private updateDescent(): void {
    const T = 5;
    const t = Math.min(1, this.stateT / T);
    const e = 1 - Math.pow(1 - t, 3);
    const from = this.shipPos.clone().add(new THREE.Vector3(0, 260, 140));
    this.ship.root.position.lerpVectors(from, this.shipPos, e);
    this.ship.root.rotation.x = (1 - e) * 0.25;
    this.fade = Math.max(0, 1 - this.stateT / 0.8);
    // Cinematic camera: off to the side, watching it settle.
    const cam = this.shipPos.clone().add(new THREE.Vector3(this.ship.radius * 3 + 30, this.ship.radius + 12, -this.ship.radius * 2 - 30));
    this.camera.position.copy(cam);
    this.camera.lookAt(this.ship.root.position);
    this.viewModel.visible = false;
    this.pos.copy(this.shipPos).add(new THREE.Vector3(this.ship.radius * 0.8 + 3, 0, 4));
    if (t >= 1) {
      this.state = 'walk';
      this.stateT = 0;
      this.pos.y = this.terrain.surfaceHeight(this.pos.x, this.pos.z);
      // Face away from the ship, toward the nearest ruin or wreck if there is one.
      const poi = [...this.pois.values()].find((p) => p && p.known);
      const look = poi ? new THREE.Vector3(poi.x - this.pos.x, 0, poi.z - this.pos.z) : new THREE.Vector3(1, 0, 0);
      this.yaw = Math.atan2(-look.x, -look.z);
      this.pitch = -0.05;
      this.viewModel.visible = true;
      this.host.audio.boom(0.4);
      this.host.toast(`Landed on ${this.profile.name}`, 'good');
      if (this.profile.hazard.kind !== 'none') this.host.toast(`Hazard: ${this.profile.hazard.label} — exosuit protection draining`, 'warn');
      this.discover('planet', `${this.profile.seed}:planet`, this.profile.name, 0.5 + (this.profile.type === 'exotic' ? 0.5 : 0), `First landfall on a ${this.profile.type} world`);
    }
  }

  private updateAscent(): void {
    const t = this.stateT;
    const rise = t < 1.2 ? t * t * 3 : 4.3 + (t - 1.2) * 40 + (t - 1.2) ** 3 * 30;
    this.ship.root.position.copy(this.shipPos).add(new THREE.Vector3(0, rise, -(Math.max(0, t - 1.4) ** 2) * 30));
    this.ship.root.rotation.x = Math.min(0.5, Math.max(0, t - 1.2) * 0.3);
    const cam = this.shipPos.clone().add(new THREE.Vector3(this.ship.radius * 2.5 + 26, 6, this.ship.radius * 2.2 + 26));
    this.camera.position.copy(cam);
    this.camera.lookAt(this.ship.root.position);
    this.viewModel.visible = false;
    this.fade = Math.max(0, (t - 3) / 1);
    if (t > 4.1) this.host.onTakeoff();
  }

  private updateWalk(dt: number, input: Input, m: { dx: number; dy: number }): void {
    const p = this.profile;
    const g = 9.81 * p.gravity;
    // Look.
    const sens = 0.0022 * this.host.sensitivity;
    if (input.locked) {
      this.yaw -= m.dx * sens;
      this.pitch = THREE.MathUtils.clamp(this.pitch - m.dy * sens * (this.host.invertY ? -1 : 1), -1.45, 1.45);
    }
    // Move.
    const fwd = input.axis('KeyS', 'KeyW');
    const strafe = input.axis('KeyA', 'KeyD');
    const sprint = (input.isDown('ShiftLeft') || input.isDown('ShiftRight')) && this.stamina > 0.05 && fwd > 0;
    const speed = (sprint ? 9 : 4.6) * (p.gravity < 0.5 ? 0.85 : 1);
    const dir = _v.set(-Math.sin(this.yaw) * fwd + Math.cos(this.yaw) * strafe, 0, -Math.cos(this.yaw) * fwd - Math.sin(this.yaw) * strafe);
    if (dir.lengthSq() > 1) dir.normalize();
    const control = this.onGround ? 12 : 2.5;
    this.vel.x += (dir.x * speed - this.vel.x) * Math.min(1, control * dt);
    this.vel.z += (dir.z * speed - this.vel.z) * Math.min(1, control * dt);
    this.stamina = THREE.MathUtils.clamp(this.stamina + (sprint ? -0.18 : 0.12) * dt, 0, 1);
    // Jump and jetpack.
    if (input.pressed('Space') && this.onGround) {
      this.vel.y = 5.2 * Math.sqrt(Math.max(0.4, 1 / p.gravity)) * 0.85;
      this.onGround = false;
    } else if (input.isDown('Space') && !this.onGround && this.jetpack > 0.01) {
      this.vel.y += (g + 9) * dt;
      this.vel.y = Math.min(this.vel.y, 11);
      this.jetpack = Math.max(0, this.jetpack - 0.32 * dt);
      if (Math.random() < dt * 20) this.host.audio.sfx('vent', 0.05);
    }
    if (this.onGround) this.jetpack = Math.min(1, this.jetpack + 0.35 * dt);
    this.vel.y -= g * dt;
    this.pos.addScaledVector(this.vel, dt);
    // Ground.
    const ground = this.terrain.surfaceHeight(this.pos.x, this.pos.z);
    const swimming = this.terrain.seaLevel !== null && this.terrain.height(this.pos.x, this.pos.z) < this.terrain.seaLevel - 1.2 && p.oceanKind === 'water';
    if (this.pos.y <= ground) {
      if (!this.onGround && this.vel.y < -12) this.host.audio.sfx('hullHit', 0.3);
      this.pos.y = ground;
      this.vel.y = Math.max(0, this.vel.y);
      this.onGround = true;
    } else this.onGround = this.pos.y - ground < 0.05;
    if (swimming) this.vel.multiplyScalar(1 - Math.min(1, dt * 2.5));
    if (p.oceanKind === 'lava' && this.terrain.wet(this.terrain.height(this.pos.x, this.pos.z)) && this.onGround) this.health -= dt * 0.25;
    this.collide();
    // Footstep cadence for head bob.
    const moving = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround) this.bob += moving * dt * 1.6;
    if (this.onGround && moving > 1 && Math.floor(this.bob / Math.PI) !== this.lastStep) {
      this.lastStep = Math.floor(this.bob / Math.PI);
      this.host.audio.blip(90 + Math.random() * 30, 0.03);
    }
    // Camera.
    this.camera.position.set(this.pos.x, this.pos.y + EYE + Math.sin(this.bob * 2) * 0.04 * Math.min(1, moving / 4), this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.updateMatrixWorld();
    // Tools.
    if (input.pressed('Digit1')) this.setTool('mining');
    if (input.pressed('Digit2')) this.setTool('scanner');
    if (input.pressed('KeyF') || input.pressed('KeyQ')) this.pulse();
    this.updateHazard(dt);
    this.updateAim(dt, input);
    if (input.pressed('KeyE') && this.aimAction) this.aimAction();
    const swayX = Math.sin(this.bob) * 0.008 * Math.min(1, moving / 4);
    this.toolMeshes.mining.visible = this.tool === 'mining';
    this.toolMeshes.scanner.visible = this.tool === 'scanner';
    this.viewModel.position.set(swayX, Math.abs(Math.cos(this.bob)) * 0.006, 0);
    // Sun shadow box follows the player.
    this.sun.position.copy(this.pos).addScaledVector(this.sunDir, 200);
    this.sun.target.position.copy(this.pos);
  }

  setTool(t: Tool): void {
    if (this.tool === t) return;
    this.tool = t;
    this.host.audio.blip(t === 'scanner' ? 1200 : 600, 0.05);
  }

  private collide(): void {
    const push = (x: number, z: number, r: number, top: number) => {
      if (this.pos.y > top) return;
      const dx = this.pos.x - x;
      const dz = this.pos.z - z;
      const d = Math.hypot(dx, dz);
      const min = r + 0.35;
      if (d >= min || d < 1e-4) return;
      this.pos.x += (dx / d) * (min - d);
      this.pos.z += (dz / d) * (min - d);
    };
    for (const c of this.nearChunks(this.pos.x, this.pos.z, 8)) {
      for (const p of c.placed) if (p.radius > 0 && Math.abs(p.x - this.pos.x) < 4 && Math.abs(p.z - this.pos.z) < 4) push(p.x, p.z, p.radius, p.y + p.height);
      for (const d of c.deposits) push(d.x, d.z, 1.1, d.y + 1.5);
    }
    for (const poi of this.pois.values()) if (poi?.group) for (const c of poi.colliders) push(c.x, c.z, c.r, c.top);
    push(this.shipPos.x, this.shipPos.z, this.ship.radius * 0.5, this.shipPos.y + this.ship.radius * 0.4);
  }

  private updateHazard(dt: number): void {
    const hz = this.profile.hazard;
    const nearShip = this.pos.distanceTo(this.shipPos) < this.ship.radius + 10;
    if (nearShip) this.protection = Math.min(1, this.protection + dt * 0.25);
    else if (hz.rate > 0) this.protection = Math.max(0, this.protection - hz.rate * dt);
    if (this.protection <= 0) {
      this.health -= dt / 25;
      if (!this.warnedHazard) {
        this.warnedHazard = true;
        this.host.toast('Exosuit protection depleted — get back to your ship!', 'warn');
        this.host.audio.alarm();
      }
    } else if (this.protection > 0.2) this.warnedHazard = false;
    if (!nearShip && hz.rate > 0 && this.protection < 0.25 && this.protection + hz.rate * dt >= 0.25) this.host.toast('Hazard protection low', 'warn');
    if (this.health < 1 && this.protection > 0) this.health = Math.min(1, this.health + dt * 0.02);
    if (this.health <= 0) {
      // Blackout: the suit's emergency beacon drags you back to the ship.
      this.health = 0.5;
      this.protection = 0.6;
      this.pos.copy(this.shipPos).add(new THREE.Vector3(this.ship.radius * 0.8 + 3, 0, 4));
      this.pos.y = this.terrain.surfaceHeight(this.pos.x, this.pos.z);
      this.vel.set(0, 0, 0);
      const bill = Math.min(this.host.player.credits, 1500);
      this.host.player.credits -= bill;
      this.host.toast(`You blacked out. The suit's recall beacon brought you back to the ship (medical bill ${bill} ¢).`, 'warn');
    }
  }

  // ---------------------------------------------------------------- aiming, scanning, mining

  private updateAim(dt: number, input: Input): void {
    const origin = this.camera.position;
    const dir = _v2.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.prompt = null;
    this.aimAction = null;
    let best = null as AimTarget | null;
    const consider = (kind: AimInfo['kind'], center: THREE.Vector3, r: number, maxD: number, info: Omit<AimTarget, 'kind' | 'd'>) => {
      const rel = _v.copy(center).sub(origin);
      const along = rel.dot(dir);
      if (along < 0 || along > maxD) return;
      const miss = rel.addScaledVector(dir, -along).length();
      if (miss > r) return;
      if (!best || along < best.d) best = { kind, d: along, ...info };
    };
    // Creatures.
    for (const c of this.fauna.creatures) {
      const name = this.speciesNames[c.species.index];
      consider('creature', _v.copy(c.pos).add(new THREE.Vector3(0, c.species.size * 0.9, 0)).clone(), c.radius + 0.4, 80, {
        id: `${this.profile.seed}:fauna:${c.species.index}`,
        name,
        detail: `${c.species.plan === 'flyer' ? 'Flying' : c.species.plan === 'hopper' ? 'Hopping' : 'Grazing'} lifeform · ${c.species.timid ? 'timid' : 'curious'}`,
        scanned: this.known(`${this.profile.seed}:fauna:${c.species.index}`),
        creature: c,
      });
    }
    // Flora and deposits nearby.
    for (const ch of this.nearChunks(origin.x, origin.z, 60)) {
      for (const p of ch.placed) {
        const spec = this.profile.flora[p.spec];
        if (!spec.living || Math.abs(p.x - origin.x) > 45 || Math.abs(p.z - origin.z) > 45) continue;
        const id = `${this.profile.seed}:flora:${p.spec}`;
        consider('flora', new THREE.Vector3(p.x, p.y + p.height * 0.5, p.z), Math.max(0.6, p.height * 0.35), 45, {
          id,
          name: speciesName(this.profile.seed, p.spec, 'flora'),
          detail: `Flora · ${spec.kind === 'crystalTree' ? 'crystalline' : spec.glow > 0.3 ? 'bioluminescent' : 'photosynthetic'}`,
          scanned: this.known(id),
          flora: p,
        });
      }
      for (const d of ch.deposits) {
        const res = this.profile.resources[d.res];
        consider('deposit', new THREE.Vector3(d.x, d.y + 1, d.z), 1.6, 40, {
          id: `deposit:${d.id}`,
          name: `${COMMODITIES[ci(res.commodity)].name} deposit`,
          detail: `${Math.ceil(d.amount)} units · mining beam`,
          scanned: true,
          deposit: d,
        });
      }
    }
    // POI interaction spots.
    for (const poi of this.pois.values()) {
      if (!poi?.group) continue;
      for (const s of poi.spots) {
        if (this.host.looted.has(s.id)) continue;
        const near = Math.hypot(s.x - this.pos.x, s.z - this.pos.z) < 4.5;
        if (near) {
          this.prompt = `[E] ${s.label}`;
          this.aimAction = () => this.interact(poi, s);
        }
      }
    }
    // Board the ship.
    if (this.pos.distanceTo(this.shipPos) < this.ship.radius * 0.6 + 6) {
      this.prompt = `[E] Board ship and take off`;
      this.aimAction = () => this.takeOff();
    }
    const b = best as AimTarget | null;
    // Mining.
    const firing = input.isMouseDown(0) && input.locked;
    this.overheated = Math.max(0, this.overheated - dt);
    let beamTo: THREE.Vector3 | null = null;
    if (this.tool === 'mining' && firing && this.overheated <= 0) {
      this.heat = Math.min(1, this.heat + dt / 6);
      if (this.heat >= 1) {
        this.overheated = 3;
        this.host.audio.warn();
      }
      beamTo = b ? origin.clone().addScaledVector(dir, b.d) : origin.clone().addScaledVector(dir, 25);
      if (b?.deposit && b.d < 30) this.mine(b.deposit, dt);
      if (Math.random() < dt * 12) this.host.audio.sfx('beam', 0.08);
    } else this.heat = Math.max(0, this.heat - dt * (this.overheated > 0 ? 0.33 : 0.5));
    this.beam.visible = this.beamHit.visible = !!beamTo;
    if (beamTo) {
      const muzzle = new THREE.Vector3(0.24, -0.195, -1.03).applyMatrix4(this.camera.matrixWorld);
      this.beam.position.copy(muzzle);
      this.beam.lookAt(beamTo);
      this.beam.scale.set(1 + Math.sin(this.time * 60) * 0.4, 1 + Math.sin(this.time * 60) * 0.4, muzzle.distanceTo(beamTo));
      this.beamHit.position.copy(beamTo);
      this.beamHit.scale.setScalar(0.8 + Math.random() * 0.8);
    }
    // Scanning.
    const scanning = this.tool === 'scanner' && firing && b && !b.scanned && (b.kind === 'creature' || b.kind === 'flora');
    if (scanning && b) {
      if (this.scanTarget !== b.id) {
        this.scanTarget = b.id;
        this.scanProgress = 0;
      }
      this.scanProgress += dt / 1.4;
      if (Math.random() < dt * 8) this.host.audio.blip(1400 + this.scanProgress * 800, 0.02);
      if (this.scanProgress >= 1) {
        this.scanProgress = 0;
        const rarity = b.creature ? b.creature.species.rarity : hash2(b.flora!.spec, 1, this.profile.seed);
        this.discover(b.kind === 'creature' ? 'fauna' : 'flora', b.id, b.name, rarity, b.detail);
      }
    } else if (!firing) this.scanProgress = Math.max(0, this.scanProgress - dt);
    this.aim = b
      ? { kind: b.kind, name: b.name, detail: b.detail, distance: b.d, scanned: b.scanned, progress: this.scanTarget === b.id ? this.scanProgress : 0 }
      : { kind: 'none', name: '', detail: '', distance: 0, scanned: false, progress: 0 };
  }

  private mine(d: Deposit, dt: number): void {
    const res = this.profile.resources[d.res];
    const p = this.host.player;
    const free = cargoFree(p);
    if (free < 1) {
      this.host.toast('Cargo hold full', 'warn');
      return;
    }
    const before = Math.ceil(d.amount);
    d.amount -= dt * 5;
    const got = before - Math.ceil(Math.max(0, d.amount));
    if (got > 0) {
      const n = Math.min(got, Math.floor(free));
      p.cargo[res.commodity] = (p.cargo[res.commodity] ?? 0) + n;
      this.minedSinceToast += n;
    }
    d.group.scale.setScalar(0.5 + 0.5 * Math.max(0, d.amount) / 30 + 0.2);
    if (d.amount <= 0) {
      this.host.harvested.add(`${this.profile.seed}:${d.id}`);
      d.group.visible = false;
      for (const c of this.chunks.values()) c.deposits = c.deposits.filter((x) => x !== d);
      this.scene.remove(d.group);
      this.host.toast(`+${this.minedSinceToast} ${COMMODITIES[ci(res.commodity)].name}`, 'good');
      this.minedSinceToast = 0;
      this.host.audio.blip(880, 0.08);
    }
  }

  /** Q/F: a sensor pulse that reveals deposits and points of interest nearby. */
  private pulse(): void {
    if (this.pulseCooldown > 0) return;
    this.pulseCooldown = 6;
    this.pulseT = 0;
    this.host.audio.sfx('system', 0.4);
    let found = 0;
    for (const poi of this.pois.values()) {
      if (!poi) continue;
      if (Math.hypot(poi.x - this.pos.x, poi.z - this.pos.z) < 900 && !poi.known) {
        poi.known = true;
        found++;
      }
    }
    if (found) this.host.toast(`Scan pulse: ${found} new point${found > 1 ? 's' : ''} of interest`, 'good');
  }

  private known(id: string): boolean {
    return !!this.host.player.codex[id];
  }

  /** Record a discovery; returns true if it was new. */
  private discover(kind: CodexKind, id: string, name: string, rarity: number, note: string): boolean {
    const p = this.host.player;
    if (p.codex[id]) return false;
    const value = codexValue(kind, rarity);
    const entry: CodexEntry = { id, kind, name, planet: this.profile.name, system: this.host.systemName, value, day: this.host.day, sold: false, note };
    p.codex[id] = entry;
    this.host.toast(`Discovered: ${name} — data worth ${value.toLocaleString()} ¢`, 'good');
    this.host.audio.blip(1320, 0.12);
    return true;
  }

  private interact(poi: Poi, spot: Poi['spots'][number]): void {
    const p = this.host.player;
    this.host.looted.add(spot.id);
    const rng = hash2(Math.round(spot.x), Math.round(spot.z), this.profile.seed);
    if (poi.kind === 'ruins') {
      this.discover('ruins', spot.id, poi.name.replace('Ruins: ', ''), rng, `Precursor ruins on ${this.profile.name}`);
      if (rng < 0.18 && cargoFree(p) >= 1) {
        p.cargo.ai_cores = (p.cargo.ai_cores ?? 0) + 1;
        this.host.toast('Hidden in the altar: an intact AI core!', 'good');
      }
    } else if (poi.kind === 'monolith') {
      this.discover('ruins', spot.id, 'Precursor monolith', rng * 0.5, `It hums. Images of a vast gate near the galactic core.`);
    } else {
      // Salvage crate.
      const picks: [string, number][] = [
        ['supplies', 8 + Math.floor(rng * 25)],
        ['metals', 5 + Math.floor(rng * 20)],
        ['machinery', 2 + Math.floor(rng * 6)],
        ['weapons', 2 + Math.floor(rng * 5)],
      ];
      const [com, qty] = picks[Math.floor(rng * picks.length)];
      const room = Math.floor(cargoFree(p));
      const n = Math.min(qty, room);
      if (com === 'supplies') p.supplies += n;
      else if (n > 0) p.cargo[com] = (p.cargo[com] ?? 0) + n;
      const credits = 500 + Math.floor(rng * 3500);
      p.credits += credits;
      this.host.toast(`Salvaged ${n} ${COMMODITIES[ci(com)].name.toLowerCase()} and ${credits.toLocaleString()} ¢${n < qty ? ' (hold full)' : ''}`, 'good');
      this.discover('wreck', `${poi.id}:wreck`, poi.name, rng * 0.4, 'Flight recorder recovered');
    }
    this.host.audio.blip(700, 0.1);
  }

  takeOff(): void {
    if (this.state !== 'walk') return;
    this.state = 'ascend';
    this.stateT = 0;
    this.beam.visible = this.beamHit.visible = false;
    this.host.audio.boom(0.7);
    this.host.toast('Lifting off');
  }

  // ---------------------------------------------------------------- render

  render(): void {
    const aspect = this.host.pipeline.aspect;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.sky.update(this.camera.position, this.sunDir, this.sunColor, this.time);
    const sunView = this.sunDir.clone().multiplyScalar(4000).add(this.camera.position).applyMatrix4(this.camera.matrixWorldInverse);
    const lit = this.sunDir.y > -0.02;
    this.host.pipeline.render(this.scene, this.camera, {
      atmospheres: [],
      sunColor: this.sunColor,
      sunViewPos: lit ? sunView : null,
      sunRadius: 4000 * 0.006,
      warp: 0,
      time: this.time,
    });
  }

  hud(): SurfaceHudState {
    const markers: SurfaceHudState['compass']['markers'] = [];
    const bearing = (x: number, z: number) => Math.atan2(-(x - this.pos.x), -(z - this.pos.z));
    markers.push({ bearing: bearing(this.shipPos.x, this.shipPos.z), label: 'Ship', kind: 'ship', distance: Math.hypot(this.shipPos.x - this.pos.x, this.shipPos.z - this.pos.z) });
    for (const poi of this.pois.values()) {
      if (!poi?.known) continue;
      const done = poi.spots.length > 0 && poi.spots.every((s) => this.host.looted.has(s.id));
      markers.push({ bearing: bearing(poi.x, poi.z), label: poi.name + (done ? ' ✓' : ''), kind: poi.kind, distance: Math.hypot(poi.x - this.pos.x, poi.z - this.pos.z) });
    }
    if (this.pulseT < 25)
      for (const c of this.nearChunks(this.pos.x, this.pos.z, 200))
        for (const d of c.deposits) {
          const dist = Math.hypot(d.x - this.pos.x, d.z - this.pos.z);
          if (dist < 200) markers.push({ bearing: bearing(d.x, d.z), label: COMMODITIES[ci(this.profile.resources[d.res].commodity)].name, kind: 'deposit', distance: dist });
        }
    const p = this.host.player;
    let goods = 0;
    for (const v of Object.values(p.cargo)) goods += v;
    return {
      planet: this.profile.name,
      system: this.host.systemName,
      biome: `${this.profile.type === 'gasGiant' ? '' : this.profile.type[0].toUpperCase() + this.profile.type.slice(1)} · ${Math.round(this.profile.temperature - 273)}°C · ${this.profile.gravity.toFixed(2)} g`,
      hazard: { label: this.profile.hazard.label, protection: this.protection, active: this.profile.hazard.rate > 0 && this.pos.distanceTo(this.shipPos) >= this.ship.radius + 10 },
      health: this.health,
      jetpack: this.jetpack,
      stamina: this.stamina,
      tool: this.tool,
      heat: this.heat,
      overheated: this.overheated > 0,
      aim: this.aim,
      prompt: this.prompt,
      compass: { heading: this.yaw, markers },
      cargo: { used: Math.round(goods + p.supplies), capacity: p.suppliesCapacity },
      pulse: this.pulseCooldown,
      dayLight: this.profile.hasAtmosphere ? Sky.daylight(this.sunDir.y) : 1,
      state: this.state,
      fade: this.fade,
    };
  }

  dispose(): void {
    for (const c of [...this.chunks.values()]) this.disposeChunk(c);
    for (const poi of this.pois.values()) poi?.group?.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.fauna.dispose();
    this.ship.dispose();
    this.sky.dispose();
    this.terrainMat.dispose();
    this.floraMat.dispose();
    for (const m of this.glowMats) m.dispose();
    for (const m of [...this.floraModels, ...this.depositModels]) {
      m.body.dispose();
      m.glow?.dispose();
    }
    this.scene.clear();
  }
}
