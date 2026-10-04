import * as THREE from 'three';
import { AudioEngine } from './audio/audio';
import { GameLoop } from './core/loop';
import { Input } from './core/input';
import { type GalaxyDef, type GalaxyStar, starDistance } from './galaxy/galaxyGen';
import { jumpFuelCost, type Route } from './galaxy/route';
import { generateSystem } from './galaxy/systemGen';
import { PLANET_TYPE_LABEL } from './planets/planetTypes';
import { JUMP_DURATION_DAYS, type PlayerState, SECONDS_PER_DAY, newPlayer, refreshLogistics, scoopRate } from './player';
import { PlanetBaker } from './render/bake/planetBaker';
import { ChaseCamera } from './render/chaseCamera';
import { HyperspaceTunnel } from './render/hyperspace';
import { QUALITY, RenderPipeline } from './render/pipeline';
import { SpaceDust } from './render/spaceDust';
import { SAVE_VERSION, type SaveData, playerFromSave } from './save/saveGame';
import { SaveStorage, type SlotId } from './save/storage';
import { type Controls, type FlightEnv, ShipController, flightStatsFor } from './ships/flight';
import { type ShipVisual, buildShip } from './ships/shipBuilder';
import { EscortFormation } from './ships/escorts';
import { computeStats } from './ships/fitting';
import { flagship } from './ships/fleet';
import { SimClient } from './sim/simClient';
import { type Settings, loadSettings, saveSettings } from './settings';
import { formatDistance, formatDuration, formatSpeed } from './ui/format';
import { GalaxyMap, type GalaxyMapState } from './ui/galaxyMap';
import { FleetScreen, type FleetTab } from './ui/fleetScreen';
import { shipyardStock } from './ships/fleet';
import { Hud, type HudState, type MarkerData } from './ui/hud';
import { SystemMap } from './ui/systemMap';
import { SystemView } from './world/systemView';
import { type Anchor, type BodyState, Universe } from './world/universe';

export type QualityName = keyof typeof QUALITY;
const QUALITY_ORDER: QualityName[] = ['low', 'medium', 'high'];
const BASE_FOV = 62;
/** Frame-shift charge before a hyperjump (s). */
export const JUMP_CHARGE = 5;
/** Extra time allowed to finish aligning once charged (s). */
const JUMP_ALIGN_GRACE = 6;
/** Max angle between the nose and the destination for a jump. */
const JUMP_ALIGN_ANGLE = THREE.MathUtils.degToRad(9);
/** Minimum time in the tunnel (s); it stays open longer if the next system is still loading. */
const TUNNEL_MIN = 5.5;
const AUTOSAVE_INTERVAL = 300;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** Altitude below which supercruise and hyperjumps are unavailable (mass lock). */
function lockAltitude(a: Anchor): number {
  if (a.kind === 'star') return a.radius * 0.6;
  if (a.kind === 'station') return 5_000;
  const b = a as BodyState;
  return b.def.atmosphere ? b.def.atmosphere.height : b.radius * 0.12;
}

/** Supercruise auto-drop distance from the target's surface. */
function arrivalAltitude(a: Anchor): number {
  if (a.kind === 'star') return a.radius * 4;
  if (a.kind === 'station') return 12_000;
  const b = a as BodyState;
  return (b.def.atmosphere?.height ?? 0) + b.radius * 0.8;
}

const galaxyDir = (from: GalaxyStar, to: GalaxyStar) => new THREE.Vector3(to.x - from.x, to.y - from.y, to.z - from.z).normalize();

/** A fully built (baked) system, ready to swap in. */
interface BuiltSystem {
  index: number;
  scene: THREE.Scene;
  universe: Universe;
  view: SystemView;
  map: SystemMap;
}

type Arrival = { kind: 'spawn' } | { kind: 'hyperspace'; from: number } | { kind: 'save'; save: SaveData };

interface JumpState {
  phase: 'charging' | 'tunnel';
  t: number;
  dest: number;
  from: number;
  built: BuiltSystem | null;
  failed: string | null;
}

export class Game {
  readonly pipeline: RenderPipeline;
  scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 1e12);
  readonly input: Input;
  readonly baker: PlanetBaker;
  readonly ship = new ShipController();
  shipVisual!: ShipVisual;
  readonly escorts = new EscortFormation();
  /** Key of the flagship loadout the current visual was built from. */
  private flagshipKey = '';
  readonly chase = new ChaseCamera();
  readonly dust: SpaceDust;
  readonly hud: Hud;
  readonly audio = new AudioEngine();
  readonly sim = new SimClient();
  readonly storage = new SaveStorage();
  readonly tunnel = new HyperspaceTunnel();
  readonly fleetScreen: FleetScreen;

  galaxy!: GalaxyDef;
  galaxyMap!: GalaxyMap;
  systemIndex = 0;
  universe!: Universe;
  view!: SystemView;
  map!: SystemMap;
  player: PlayerState = newPlayer();
  route: Route | null = null;

  /** Ship reference frame and frame-relative position (float64). */
  frame: Anchor | null = null;
  readonly local = new THREE.Vector3();
  target: Anchor | null = null;
  /** Hyperspace destination (another system), exclusive with `target`. */
  systemTarget: GalaxyStar | null = null;
  time = 0;
  paused = false;
  jump: JumpState | null = null;
  quality: QualityName;
  settings: Settings = loadSettings();
  /** Mouse-aim: where the pilot is looking (system axes). The ship turns to follow it. */
  readonly aim = new THREE.Quaternion();
  /** Free-look offset (right mouse held), relative to `aim`; eases back on release. */
  readonly lookOffset = new THREE.Quaternion();
  /** Called when the player wants the pause menu (pointer released, Esc). */
  onPauseRequest: () => void = () => {};

  private loop: GameLoop | null = null;
  private pendingMouse = { dx: 0, dy: 0 };
  private pendingToggleSC = false;
  private pendingZero = false;
  private fps = 60;
  private showFps = false;
  private cameraZoomIndex = 0;
  private readonly camWorld = new THREE.Vector3();
  private readonly shipWorldPos = new THREE.Vector3();
  private lastShake = 0;
  private scooping = 0;
  private wasScooping = false;
  private lastAutosave = 0;
  private started = false;

  constructor(container: HTMLElement, quality: QualityName) {
    this.quality = quality;
    this.pipeline = new RenderPipeline(container, QUALITY[quality]);
    this.input = new Input(this.pipeline.renderer.domElement);
    this.baker = new PlanetBaker(this.pipeline.renderer);
    this.rebuildFleetVisuals();
    this.dust = new SpaceDust(7);
    this.hud = new Hud(document.body);
    this.hud.setVisible(false);
    this.pipeline.renderer.domElement.addEventListener('pointerdown', () => this.audio.start());
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const game = this;
    this.fleetScreen = new FleetScreen(this.pipeline, {
      get player() {
        return game.player;
      },
      get dock() {
        return game.dockInfo();
      },
      fleetChanged: () => {
        this.rebuildFleetVisuals();
        void this.saveTo('auto');
      },
      refuel: () => this.resupply(),
      toast: (m, k) => this.hud.toast(m, k),
      close: () => this.toggleFleetScreen(),
    });

    document.addEventListener('pointerlockchange', () => {
      // Losing the pointer mid-flight (Esc) opens the pause menu.
      if (!this.input.locked && this.started && !this.anyMapOpen && !this.paused) this.onPauseRequest();
    });
    window.addEventListener('visibilitychange', () => {
      if (document.hidden && this.started && !this.jump) void this.saveTo('auto');
    });

    this.ship.onEvent((e) => {
      switch (e.type) {
        case 'charging':
          this.hud.toast('Frame shift drive charging');
          this.audio.startCharge(2.5);
          break;
        case 'engaged':
          this.hud.toast('Supercruise engaged', 'good');
          this.audio.stopCharge();
          this.audio.boom(0.5);
          break;
        case 'dropped':
          this.hud.toast(e.reason, e.reason.startsWith('Mass') ? 'warn' : '');
          this.audio.stopCharge();
          this.audio.boom(0.35);
          break;
        case 'masslocked':
          this.hud.toast(e.reason, 'warn');
          this.audio.warn();
          break;
        case 'align':
          this.hud.toast(e.on ? 'Auto-align engaged' : 'Auto-align released');
          break;
      }
    });
  }

  get anyMapOpen(): boolean {
    return !!(this.map?.open || this.galaxyMap?.open || this.fleetScreen?.open);
  }

  /** Station services available right now (docked = within reach of a station, slow, normal flight). */
  dockInfo(): { stationName: string; stock: string[] } | null {
    const st = this.resupplyStation();
    if (!st || st.kind !== 'station') return null;
    const region = this.galaxy.stars[this.systemIndex].region;
    return { stationName: st.name, stock: shipyardStock((st as unknown as { def: { seed: number } }).def.seed, region) };
  }

  toggleFleetScreen(tab: FleetTab = 'fleet'): void {
    if (this.fleetScreen.open) {
      this.fleetScreen.hide();
      this.afterMapToggle(false);
    } else {
      this.fleetScreen.show(tab);
      this.afterMapToggle(true);
    }
  }

  // ---------------------------------------------------------------- loading

  private async loadGalaxy(seed: number): Promise<void> {
    if (this.galaxy?.seed === seed) return;
    this.galaxyMap?.dispose();
    this.galaxy = await this.sim.call('galaxy', { seed });
    this.galaxyMap = new GalaxyMap(this.galaxy, this.pipeline);
    this.galaxyMap.onPlotRoute = (to) => void this.plotRoute(to);
    this.galaxyMap.onClearRoute = () => this.clearRoute();
  }

  /** Generate and bake a system into its own scene without disturbing the current one. */
  private async buildSystem(index: number, onProgress: (f: number, label: string) => void = () => {}): Promise<BuiltSystem> {
    const star = this.galaxy.stars[index];
    const scene = new THREE.Scene();
    const universe = new Universe(generateSystem(star.seed));
    universe.update(this.time);
    const view = new SystemView(scene, universe, this.pipeline.renderer, this.baker, { galaxy: this.galaxy, index });
    await view.bake(onProgress);
    const map = new SystemMap(universe, this.pipeline, view.planets, view.skyTexture);
    map.onSetTarget = (a) => this.setTarget(a);
    return { index, scene, universe, view, map };
  }

  /** Swap a built system in, disposing the previous one. */
  private swapIn(b: BuiltSystem): void {
    this.view?.dispose();
    this.map?.dispose();
    this.scene = b.scene;
    this.universe = b.universe;
    this.view = b.view;
    this.map = b.map;
    this.systemIndex = b.index;
    this.scene.add(this.shipVisual.root, this.dust.mesh, this.escorts.group);
    this.target = null;
    this.frame = null;
  }

  async newGame(seed: number, onProgress: (f: number, label: string) => void): Promise<void> {
    onProgress(0, 'Mapping the galaxy');
    await this.loadGalaxy(seed);
    this.player = newPlayer();
    this.rebuildFleetVisuals();
    this.route = null;
    this.systemTarget = null;
    this.time = 0;
    const built = await this.buildSystem(this.galaxy.startIndex, onProgress);
    this.arrive(built, { kind: 'spawn' });
  }

  async loadSave(save: SaveData, onProgress: (f: number, label: string) => void): Promise<void> {
    this.jump = null;
    onProgress(0, 'Mapping the galaxy');
    await this.loadGalaxy(save.galaxySeed);
    this.player = playerFromSave(newPlayer(), save);
    this.rebuildFleetVisuals();
    this.time = save.time;
    this.route = save.route.length >= 2 ? this.routeFromStars(save.route) : null;
    this.systemTarget = save.target?.kind === 'system' ? (this.galaxy.stars[save.target.index] ?? null) : null;
    const built = await this.buildSystem(save.systemIndex, onProgress);
    this.arrive(built, { kind: 'save', save });
    if (save.target?.kind === 'local') {
      const id = save.target.id;
      this.target = this.universe.get(id) ?? null;
      this.map.targetId = this.target?.id ?? null;
    }
  }

  private routeFromStars(stars: number[]): Route {
    const hops = stars.slice(0, -1).map((from, i) => {
      const to = stars[i + 1];
      const d = starDistance(this.galaxy.stars[from], this.galaxy.stars[to]);
      return { from, to, distance: d, fuel: jumpFuelCost(d, this.galaxy.stars[to].nebula >= 0) };
    });
    return {
      stars,
      hops,
      totalDistance: hops.reduce((a, h) => a + h.distance, 0),
      totalFuel: hops.reduce((a, h) => a + h.fuel, 0),
    };
  }

  /** Swap in a system and place the ship according to how we got here. */
  private arrive(built: BuiltSystem, how: Arrival): void {
    this.swapIn(built);
    const u = this.universe;
    u.update(this.time);
    this.ship.velocity.set(0, 0, 0);
    this.ship.mode = 'normal';
    this.ship.autoAlign = false;
    const firstVisit = !this.player.visited.has(this.systemIndex);
    let hadRoute = false;
    this.player.visited.add(this.systemIndex);

    if (how.kind === 'spawn') this.placeAtStation();
    else if (how.kind === 'save') {
      const s = how.save.ship;
      this.frame = s.frameId ? (u.get(s.frameId) ?? null) : null;
      this.local.fromArray(s.local);
      this.ship.velocity.fromArray(s.velocity);
      this.ship.quaternion.fromArray(s.quaternion);
      this.ship.throttle = s.throttle;
    } else {
      // Exit hyperspace on the side of the star facing where we came from, already in supercruise.
      const from = this.galaxy.stars[how.from];
      const here = this.galaxy.stars[this.systemIndex];
      const back = galaxyDir(here, from);
      const side = new THREE.Vector3().crossVectors(back, new THREE.Vector3(0, 1, 0)).normalize();
      const pos = back.clone().multiplyScalar(u.star.radius * 14).addScaledVector(side, u.star.radius * 4);
      this.frame = null;
      this.local.copy(pos);
      const lookDir = pos.clone().negate().normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.38);
      this.ship.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), lookDir, new THREE.Vector3(0, 1, 0)));
      this.ship.mode = 'supercruise';
      this.ship.scSpeed = 60_000;
      this.ship.throttle = 0.25;
      this.ship.transitionAge = 0;
      this.player.jumps++;
      this.player.distanceLy += starDistance(from, here);
      // Advance the route.
      hadRoute = !!this.route;
      if (this.route) {
        const i = this.route.stars.indexOf(this.systemIndex);
        this.route = i >= 0 && i < this.route.stars.length - 1 ? this.routeFromStars(this.route.stars.slice(i)) : null;
      }
      this.systemTarget = this.route ? this.galaxy.stars[this.route.stars[1]] : null;
    }
    this.snapView();
    this.updateFrame(false);

    const sys = u.system;
    if (how.kind !== 'save') {
      this.hud.toast(`${sys.name} · Class ${sys.star.spectralClass}`, 'good');
      if (firstVisit && how.kind === 'hyperspace') {
        const planets = sys.bodies.filter((b) => b.kind === 'planet').length;
        setTimeout(() => this.hud.toast(`New system charted: ${planets} planets, ${sys.bodies.length - planets} moons`, 'good'), 1200);
      }
      if (this.systemTarget) setTimeout(() => this.hud.toast(`Next jump: ${this.systemTarget!.name}`), 2400);
      else if (how.kind === 'hyperspace' && hadRoute) setTimeout(() => this.hud.toast('Route complete — destination reached', 'good'), 2400);
    }
    if (this.started) void this.saveTo('auto');
  }

  /** Start near the trade station with the homeworld behind it, lit from the side. */
  private placeAtStation(): void {
    const u = this.universe;
    const station = u.stations[0];
    if (!station) {
      const p = u.bodies[0];
      this.frame = p;
      this.local.set(0, 0, p.radius * 3);
      this.ship.quaternion.identity();
      return;
    }
    // Nudge the clock so the station sits over the planet's morning side.
    let best = this.time;
    let bestScore = -Infinity;
    for (let t = 0; t < station.def.orbit.period; t += station.def.orbit.period / 90) {
      u.update(this.time + t);
      const out = _v.copy(station.position).sub(station.parent.position).normalize();
      const toStar = _v2.copy(u.star.position).sub(station.parent.position).normalize();
      const score = -Math.abs(out.dot(toStar) - 0.35);
      if (score > bestScore) {
        bestScore = score;
        best = this.time + t;
      }
    }
    this.time = best;
    u.update(this.time);
    const planet = station.parent;
    const out = _v.copy(station.position).sub(planet.position).normalize().clone();
    const toStar = _v2.copy(u.star.position).sub(station.position).normalize().clone();
    const side = new THREE.Vector3().crossVectors(out, toStar).normalize();
    const offset = out.clone().multiplyScalar(4200).addScaledVector(side, 1400).addScaledVector(toStar, 900);
    this.frame = station;
    this.local.copy(offset);
    const look = new THREE.Matrix4().lookAt(
      new THREE.Vector3(),
      offset.clone().negate().add(out.clone().multiplyScalar(-1500)),
      new THREE.Vector3(0, 1, 0).applyQuaternion(planet.tilt),
    );
    this.ship.quaternion.setFromRotationMatrix(look);
    this.ship.throttle = 0;
    this.target = station;
    this.map.targetId = station.id;
  }

  start(): void {
    this.hud.setVisible(true);
    if (!this.started) {
      this.started = true;
      this.hud.toast(`Welcome to the ${this.universe.system.name} system`, 'good');
      setTimeout(() => this.hud.setHelp(true), 600);
      setTimeout(() => this.hud.setHelp(false), 14000);
      this.loop = new GameLoop(
        (dt) => this.fixedUpdate(dt),
        (_alpha, frameDt) => this.frame_(frameDt),
      );
      this.loop.start();
      this.lastAutosave = performance.now() / 1000;
      void this.saveTo('auto');
    }
    // Warm up shader compilation so the first frame doesn't hitch.
    this.pipeline.renderer.compile(this.scene, this.camera);
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.hud.setVisible(!p && !this.anyMapOpen && !this.inTunnel);
  }

  setQuality(q: QualityName): void {
    this.quality = q;
    this.pipeline.setQuality(QUALITY[q]);
  }

  updateSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.settings);
    if (patch.controls) this.snapView();
  }

  get mouseAim(): boolean {
    return this.settings.controls === 'aim';
  }

  /** Point the view (and aim) straight down the ship's nose, e.g. after a teleport. */
  snapView(): void {
    this.aim.copy(this.ship.quaternion);
    this.lookOffset.identity();
    this.chase.snap(this.ship.quaternion);
    this.escorts.snap(this.ship.quaternion);
  }

  /**
   * Rebuild the flagship mesh, flight stats and escorts from the fleet. Cheap
   * when nothing changed; call after any refit, purchase or flagship swap.
   */
  rebuildFleetVisuals(): void {
    const flag = flagship(this.player.fleet);
    const key = JSON.stringify([flag.id, flag.loadout]);
    if (key !== this.flagshipKey) {
      this.flagshipKey = key;
      const parent = this.shipVisual?.root.parent;
      if (this.shipVisual) {
        this.shipVisual.root.removeFromParent();
        this.shipVisual.dispose();
      }
      this.shipVisual = buildShip(flag.loadout);
      parent?.add(this.shipVisual.root);
      this.ship.stats = flightStatsFor(computeStats(flag.loadout));
      // The starter frigate's bounding radius is ~13 m; scale the chase camera from it.
      this.chase.scale = Math.max(1, this.shipVisual.radius / 13);
    }
    const others = this.player.fleet.ships.filter((x) => x.id !== flag.id);
    this.escorts.sync(others, this.shipVisual.radius, this.ship.quaternion);
    refreshLogistics(this.player);
  }

  /** Collision radius of the flagship. */
  get shipRadius(): number {
    return this.shipVisual.radius * 0.8;
  }

  /** Orientation the camera looks along this frame. */
  private viewQuaternion(out: THREE.Quaternion): THREE.Quaternion {
    return out.copy(this.mouseAim ? this.aim : this.ship.quaternion).multiply(this.lookOffset);
  }

  /** Apply this frame's mouse movement to the aim (or to free-look while right mouse is held). */
  private steerAim(dt: number, dx: number, dy: number): void {
    const sens = 0.0016 * this.settings.sensitivity;
    const inv = this.settings.invertY ? -1 : 1;
    const freeLook = this.input.isMouseDown(2) && !this.anyMapOpen;
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -dx * sens);
    const pitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -dy * sens * inv);
    if (freeLook) {
      // Look around without turning the ship.
      this.lookOffset.multiply(yaw).multiply(pitch);
      return;
    }
    this.lookOffset.slerp(new THREE.Quaternion(), 1 - Math.exp(-dt * 6));
    if (!this.mouseAim) return;
    if (this.ship.autoAlign && Math.abs(dx) + Math.abs(dy) > 4) this.ship.setAutoAlign(false);
    this.aim.multiply(yaw).multiply(pitch);
    const roll = this.input.axis('KeyE', 'KeyQ');
    if (roll) this.aim.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll * this.ship.stats.rollRate * 0.8 * dt));
    // Auto-align swings the aim onto the target; the ship follows as usual.
    if (this.ship.autoAlign) {
      const dir = this.target ? this.target.position.clone().sub(this.shipWorld(new THREE.Vector3())).normalize() : this.systemTargetDir();
      if (dir) {
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.aim);
        const want = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), dir, up));
        this.aim.rotateTowards(want, 1.2 * dt);
      }
    }
    this.aim.normalize();
  }

  // ---------------------------------------------------------------- saving

  snapshot(): SaveData {
    const star = this.galaxy.stars[this.systemIndex];
    // Never persist mid-supercruise/jump: store a calm normal-flight state.
    const vel = this.ship.mode === 'supercruise' ? this.ship.forward.clone().multiplyScalar(this.ship.stats.maxSpeed * 0.5) : this.ship.velocity;
    return {
      version: SAVE_VERSION,
      savedAt: Date.now(),
      label: `${star.name} · Day ${this.day}`,
      galaxySeed: this.galaxy.seed,
      systemIndex: this.systemIndex,
      time: this.time,
      ship: {
        frameId: this.frame?.id ?? null,
        local: this.local.toArray() as [number, number, number],
        velocity: vel.toArray() as [number, number, number],
        quaternion: this.ship.quaternion.toArray() as [number, number, number, number],
        throttle: this.ship.mode === 'supercruise' ? 0.5 : this.ship.throttle,
      },
      player: {
        fuel: this.player.fuel,
        supplies: this.player.supplies,
        visited: [...this.player.visited],
        jumps: this.player.jumps,
        distanceLy: this.player.distanceLy,
        credits: this.player.credits,
      },
      fleet: { flagshipId: this.player.fleet.flagshipId, ships: this.player.fleet.ships.map((x) => ({ ...x, loadout: { ...x.loadout, weapons: { ...x.loadout.weapons }, hullmods: [...x.loadout.hullmods] } })) },
      route: this.route?.stars ?? [],
      target: this.target ? { kind: 'local', id: this.target.id } : this.systemTarget ? { kind: 'system', index: this.systemTarget.index } : null,
    };
  }

  async saveTo(slot: SlotId): Promise<void> {
    if (!this.galaxy || this.jump) return;
    await this.storage.write(slot, this.snapshot());
    if (slot !== 'auto') this.hud.toast(slot === 'quick' ? 'Quicksaved' : 'Game saved', 'good');
  }

  get day(): number {
    return Math.floor(this.time / SECONDS_PER_DAY) + 1;
  }

  // ---------------------------------------------------------------- navigation

  shipWorld(out = this.shipWorldPos): THREE.Vector3 {
    out.copy(this.local);
    if (this.frame) out.add(this.frame.position);
    return out;
  }

  setTarget(a: Anchor | null): void {
    this.target = a;
    if (a) this.systemTarget = null;
    if (this.map) this.map.targetId = a?.id ?? null;
    if (a) {
      this.hud.toast(`Target: ${a.name}`);
      this.audio.blip();
    }
    if (!a && this.ship.autoAlign) this.ship.setAutoAlign(false);
  }

  setSystemTarget(index: number | null): void {
    this.systemTarget = index === null ? null : this.galaxy.stars[index];
    if (this.systemTarget) {
      this.target = null;
      if (this.map) this.map.targetId = null;
      this.hud.toast(`Hyperspace target: ${this.systemTarget.name}`);
      this.audio.blip(660);
    }
  }

  private async plotRoute(to: number): Promise<void> {
    const route = await this.sim.call('route', { seed: this.galaxy.seed, from: this.systemIndex, to, range: this.player.jumpRange });
    if (!route) {
      this.hud.toast('No route — destination out of range of the jump network', 'warn');
      this.audio.warn();
      return;
    }
    this.route = route;
    this.setSystemTarget(route.stars[1]);
    this.galaxyMap.refresh(this.galaxyMapState());
    this.hud.toast(`Route plotted: ${route.hops.length} jump${route.hops.length > 1 ? 's' : ''}, ${route.totalDistance.toFixed(1)} ly`, 'good');
  }

  private clearRoute(): void {
    this.route = null;
    this.systemTarget = null;
    this.galaxyMap.refresh(this.galaxyMapState());
  }

  private galaxyMapState(): GalaxyMapState {
    return {
      current: this.systemIndex,
      route: this.route,
      fuel: this.player.fuel,
      fuelCapacity: this.player.fuelCapacity,
      fuelMultiplier: this.player.fuelMultiplier,
      jumpRange: this.player.jumpRange,
      visited: this.player.visited,
      systemTarget: this.systemTarget?.index ?? null,
    };
  }

  private setFrame(f: Anchor | null): void {
    const world = this.shipWorld(_v.set(0, 0, 0)).clone();
    this.frame = f;
    this.local.copy(world);
    if (f) this.local.sub(f.position);
  }

  /** Switch reference frames when crossing spheres of influence. */
  private updateFrame(announce = true): void {
    const world = this.shipWorld(new THREE.Vector3());
    while (this.frame && world.distanceTo(this.frame.position) > this.frame.soiRadius * 1.02) {
      const leaving = this.frame;
      this.setFrame(this.frame.parent);
      if (announce && leaving.kind === 'body') this.hud.toast(`Leaving ${leaving.name} orbit`);
    }
    for (let guard = 0; guard < 4; guard++) {
      const child = this.universe.childrenOf(this.frame).find((c) => world.distanceTo(c.position) < c.soiRadius);
      if (!child) break;
      this.setFrame(child);
      if (announce) this.hud.toast(child.kind === 'station' ? `Approaching ${child.name}` : `Entering ${child.name} orbit`);
    }
  }

  private massLock(world: THREE.Vector3): string | null {
    for (const a of this.universe.anchors) {
      const alt = world.distanceTo(a.position) - a.radius;
      if (alt < lockAltitude(a)) return a.kind === 'station' ? `Mass locked — ${a.name}` : `Mass locked — ${a.name} gravity well`;
    }
    return null;
  }

  private systemTargetDir(): THREE.Vector3 | null {
    if (!this.systemTarget) return null;
    return galaxyDir(this.galaxy.stars[this.systemIndex], this.systemTarget);
  }

  private flightEnv(world: THREE.Vector3): FlightEnv {
    let nearestD = Infinity;
    for (const a of this.universe.anchors) nearestD = Math.min(nearestD, world.distanceTo(a.position) - a.radius);
    let arrived: string | null = null;
    let targetDir: THREE.Vector3 | null = this.systemTargetDir();
    if (this.target) {
      const rel = _v2.copy(this.target.position).sub(world);
      const alt = rel.length() - this.target.radius;
      if (alt < arrivalAltitude(this.target)) arrived = `Arrived at ${this.target.name}`;
      targetDir = rel.clone().normalize();
    }
    return { surfaceDistance: Math.max(nearestD, 1), massLock: this.massLock(world), arrived, targetDir };
  }

  // ---------------------------------------------------------------- hyperjump

  /** Why a jump to the current system target can't start, or null if it can. */
  private jumpBlocker(world: THREE.Vector3): string | null {
    const dest = this.systemTarget;
    if (!dest) return 'No hyperspace target';
    const here = this.galaxy.stars[this.systemIndex];
    const d = starDistance(here, dest);
    if (d > this.player.jumpRange) return `${dest.name} is out of range (${d.toFixed(1)} ly > ${this.player.jumpRange} ly)`;
    const fuel = this.jumpFuel(here, dest);
    if (this.player.fuel < fuel) return `Insufficient fuel: need ${fuel.toFixed(1)} t — scoop at the star`;
    if (this.player.supplies < this.player.suppliesPerJump) return 'Insufficient supplies — resupply at a station';
    return this.massLock(world);
  }

  /** Fuel for a jump with the whole fleet. */
  jumpFuel(from: GalaxyStar, to: GalaxyStar): number {
    return jumpFuelCost(starDistance(from, to), to.nebula >= 0) * this.player.fuelMultiplier;
  }

  private startJump(): void {
    const world = this.shipWorld(new THREE.Vector3());
    const blocker = this.jumpBlocker(world);
    if (blocker) {
      this.hud.toast(blocker, 'warn');
      this.audio.warn();
      return;
    }
    if (this.ship.mode === 'charging') this.ship.dropOut('Charge redirected');
    this.jump = { phase: 'charging', t: 0, dest: this.systemTarget!.index, from: this.systemIndex, built: null, failed: null };
    this.hud.toast(`Hyperspace charging — ${this.systemTarget!.name}`, 'good');
    this.audio.startCharge(JUMP_CHARGE);
  }

  private cancelJump(reason: string): void {
    if (!this.jump || this.jump.phase !== 'charging') return;
    this.jump = null;
    this.audio.stopCharge();
    this.hud.toast(reason, 'warn');
    this.audio.warn();
  }

  private alignmentAngle(): number {
    const dir = this.systemTargetDir();
    return dir ? this.ship.forward.angleTo(dir) : Math.PI;
  }

  private updateJump(dt: number): void {
    const j = this.jump!;
    j.t += dt;
    if (j.phase === 'charging') {
      const world = this.shipWorld(new THREE.Vector3());
      const lock = this.massLock(world);
      if (lock) return this.cancelJump(`Jump aborted — ${lock}`);
      if (j.t < JUMP_CHARGE) return;
      if (this.alignmentAngle() > JUMP_ALIGN_ANGLE) {
        if (j.t > JUMP_CHARGE + JUMP_ALIGN_GRACE) this.cancelJump('Jump aborted — not aligned with destination');
        return;
      }
      this.enterTunnel(j);
    } else if (j.phase === 'tunnel') {
      if (j.failed) {
        // Couldn't build the destination: drop back where we were.
        this.jump = null;
        this.hud.setHyperspace(null);
        this.hud.setVisible(true);
        this.hud.toast(`Hyperspace failure: ${j.failed}`, 'warn');
        return;
      }
      if (j.t >= TUNNEL_MIN && j.built) {
        const built = j.built;
        this.jump = null;
        this.hud.setHyperspace(null);
        this.hud.setVisible(true);
        this.hud.flashScreen(1100);
        this.audio.boom(1.2);
        this.arrive(built, { kind: 'hyperspace', from: j.from });
      }
    }
  }

  private enterTunnel(j: JumpState): void {
    const here = this.galaxy.stars[j.from];
    const dest = this.galaxy.stars[j.dest];
    const d = starDistance(here, dest);
    this.player.fuel -= this.jumpFuel(here, dest);
    this.player.supplies -= this.player.suppliesPerJump;
    this.time += JUMP_DURATION_DAYS * SECONDS_PER_DAY;
    this.ship.dropOut('Entering hyperspace');
    this.ship.autoAlign = false;
    if (this.map.open) this.toggleMap();
    if (this.galaxyMap.open) this.toggleGalaxyMap();
    if (this.fleetScreen.open) this.toggleFleetScreen();
    j.phase = 'tunnel';
    j.t = 0;
    this.audio.stopCharge();
    this.audio.boom(1);
    this.hud.flashScreen(500);
    this.hud.setVisible(false);
    this.hud.setHyperspace({ dest: dest.name, detail: `${d.toFixed(1)} ly · Class ${dest.spectralClass} · ${dest.region}` });
    this.tunnel.configure(dest.color, dest.nebula >= 0 ? this.galaxy.nebulae[dest.nebula].color : null);
    // Build the next system while the tunnel plays.
    this.buildSystem(j.dest)
      .then((b) => {
        if (this.jump === j) j.built = b;
        else {
          b.view.dispose();
          b.map.dispose();
        }
      })
      .catch((e: Error) => {
        console.error(e);
        j.failed = e.message;
      });
  }

  get inTunnel(): boolean {
    return this.jump?.phase === 'tunnel';
  }

  // ---------------------------------------------------------------- simulation

  private fixedUpdate(dt: number): void {
    if (this.paused || !this.universe) return;
    if (this.jump) this.updateJump(dt);
    if (this.inTunnel) return;
    this.time += dt;
    this.universe.update(this.time);
    const world = this.shipWorld(new THREE.Vector3());
    const env = this.flightEnv(world);
    const i = this.input;
    const c: Controls = {
      throttleAxis: i.axis('KeyS', 'KeyW'),
      strafeX: i.axis('KeyA', 'KeyD'),
      strafeY: i.axis('ControlLeft', 'Space'),
      roll: this.mouseAim ? 0 : i.axis('KeyE', 'KeyQ'),
      mouseDX: this.pendingMouse.dx,
      mouseDY: this.pendingMouse.dy,
      boost: i.isDown('ShiftLeft') || i.isDown('ShiftRight'),
      zeroThrottle: this.pendingZero,
      toggleSupercruise: this.pendingToggleSC,
      aim: this.mouseAim ? this.aim : null,
    };
    this.pendingMouse = { dx: 0, dy: 0 };
    this.pendingToggleSC = false;
    this.pendingZero = false;
    if (this.anyMapOpen) c.mouseDX = c.mouseDY = 0;
    const disp = this.ship.update(dt, c, env, _v);
    this.local.add(disp);
    this.updateFrame();
    this.collide();

    // Fuel scooping in the star's corona.
    const star = this.universe.star;
    const alt = this.shipWorld(_v2).distanceTo(star.position) - star.radius;
    const rate = this.player.fuel < this.player.fuelCapacity ? scoopRate(alt, star.radius) : 0;
    this.scooping = rate;
    if (rate > 0) this.player.fuel = Math.min(this.player.fuelCapacity, this.player.fuel + rate * dt);
    if (rate > 0 && !this.wasScooping) this.hud.toast('Fuel scoop engaged', 'good');
    if (rate === 0 && this.wasScooping && this.player.fuel >= this.player.fuelCapacity - 1e-6) this.hud.toast('Fuel tanks full', 'good');
    this.wasScooping = rate > 0;
  }

  private collide(): void {
    const world = this.shipWorld(new THREE.Vector3());
    const push = (center: THREE.Vector3, minDist: number) => {
      const rel = world.clone().sub(center);
      const d = rel.length();
      if (d >= minDist || d === 0) return false;
      const n = rel.divideScalar(d);
      this.local.addScaledVector(n, minDist - d);
      world.addScaledVector(n, minDist - d);
      const vn = this.ship.velocity.dot(n);
      if (vn < 0) this.ship.velocity.addScaledVector(n, -vn * 1.3);
      return true;
    };
    for (const b of this.universe.bodies) {
      if (push(b.position, b.radius + 30 + this.shipRadius)) {
        if (this.ship.mode !== 'normal') this.ship.dropOut('Impact warning — emergency drop');
        this.hud.toast('Surface contact', 'warn');
      }
    }
    if (push(this.universe.star.position, this.universe.star.radius * 1.05)) this.ship.dropOut('Stellar proximity');
    for (const st of this.universe.stations) {
      // Spindle (capsule) and habitat ring (torus) in station space.
      const inv = _q.copy(st.rotation).invert();
      const local = world.clone().sub(st.position).applyQuaternion(inv);
      const R = st.radius * 0.78;
      const tube = st.radius * 0.07 + this.shipRadius;
      const ringDist = Math.hypot(Math.hypot(local.x, local.z) - R, local.y);
      if (ringDist < tube) {
        const ringPt = new THREE.Vector3(local.x, 0, local.z).setLength(R).applyQuaternion(st.rotation).add(st.position);
        push(ringPt, tube);
      }
      const spY = THREE.MathUtils.clamp(local.y, -st.radius * 0.72, st.radius * 0.72);
      const spinePt = new THREE.Vector3(0, spY, 0).applyQuaternion(st.rotation).add(st.position);
      push(spinePt, st.radius * 0.2 + this.shipRadius);
    }
    for (const r of this.view.rockColliders()) push(r.position, r.radius + this.shipRadius);
  }

  /** Station in reach for resupply, if any. */
  private resupplyStation(): Anchor | null {
    if (!this.frame || this.frame.kind !== 'station') return null;
    const d = this.shipWorld(_v).distanceTo(this.frame.position);
    return d < 6000 && this.ship.speed < 90 && this.ship.mode === 'normal' ? this.frame : null;
  }

  private resupply(): void {
    const st = this.resupplyStation();
    if (!st) return;
    const p = this.player;
    if (p.fuel >= p.fuelCapacity - 0.01 && p.supplies >= p.suppliesCapacity - 0.01) {
      this.hud.toast('Tanks and holds already full');
      return;
    }
    p.fuel = p.fuelCapacity;
    p.supplies = p.suppliesCapacity;
    this.hud.toast(`${st.name}: refuelled and resupplied`, 'good');
    this.audio.blip(520, 0.12);
    void this.saveTo('auto');
  }

  // ---------------------------------------------------------------- input

  private handleActions(): void {
    const i = this.input;
    if (i.pressed('KeyM') && !this.galaxyMap.open && !this.fleetScreen.open && !this.inTunnel) this.toggleMap();
    if (i.pressed('KeyN') && !this.map.open && !this.fleetScreen.open && !this.inTunnel) this.toggleGalaxyMap();
    if (this.fleetScreen.open && (i.pressed('Escape') || i.pressed('KeyF'))) {
      this.toggleFleetScreen();
      return;
    }
    if (i.pressed('Escape')) {
      if (this.fleetScreen.open) this.toggleFleetScreen();
      else if (this.map.open) this.toggleMap();
      else if (this.galaxyMap.open) this.toggleGalaxyMap();
      else if (!this.input.locked) this.onPauseRequest();
    }
    if (i.pressed('F6')) {
      this.audio.setMuted(!this.audio.muted);
      this.hud.toast(this.audio.muted ? 'Sound off' : 'Sound on');
    }
    if (i.pressed('F5')) void this.saveTo('quick');
    if (this.anyMapOpen || this.inTunnel) return;
    if (i.pressed('KeyJ')) {
      if (this.jump?.phase === 'charging') this.cancelJump('Hyperjump cancelled');
      else if (this.systemTarget) this.startJump();
      else this.pendingToggleSC = true;
    }
    if (i.pressed('KeyX')) this.pendingZero = true;
    if (i.pressed('KeyR')) {
      if (this.resupplyStation()) this.toggleFleetScreen('fleet');
      else this.hud.toast('No station in reach — fly within 6 km and slow down to dock', 'warn');
    }
    if (i.pressed('KeyF')) this.toggleFleetScreen('fleet');
    if (i.pressed('KeyH')) this.hud.setHelp(!this.hud.helpVisible);
    if (i.pressed('F3')) this.showFps = !this.showFps;
    if (i.pressed('F4')) {
      this.setQuality(QUALITY_ORDER[(QUALITY_ORDER.indexOf(this.quality) + 1) % QUALITY_ORDER.length]);
      this.hud.toast(`Graphics quality: ${this.quality}`);
    }
    if (i.pressed('KeyC')) {
      this.cameraZoomIndex = (this.cameraZoomIndex + 1) % 3;
      this.chase.zoom = [1, 1.8, 0.62][this.cameraZoomIndex];
    }
    if (i.pressed('KeyT')) this.targetAhead();
    if (i.pressed('BracketRight') || i.pressed('BracketLeft')) this.cycleTarget(i.pressed('BracketRight') ? 1 : -1);
    if (i.pressed('KeyG')) {
      if (this.target || this.systemTarget) this.ship.setAutoAlign(!this.ship.autoAlign);
      else this.hud.toast('No target selected', 'warn');
    }
  }

  toggleMap(): void {
    const open = !this.map.open;
    this.map.setOpen(open, this.shipWorld(), this.frame);
    this.afterMapToggle(open);
  }

  toggleGalaxyMap(): void {
    const open = !this.galaxyMap.open;
    this.galaxyMap.setOpen(open, this.galaxyMapState());
    this.afterMapToggle(open);
  }

  private afterMapToggle(open: boolean): void {
    this.hud.setVisible(!open);
    this.audio.blip(open ? 740 : 520);
    if (open) {
      this.input.allowPointerLock = false;
      this.input.releasePointer();
    } else {
      setTimeout(() => (this.input.allowPointerLock = true), 50);
    }
  }

  /** Navigable anchors, nearest first. */
  private navList(): Anchor[] {
    const world = this.shipWorld(new THREE.Vector3());
    return [...this.universe.anchors].sort((a, b) => a.position.distanceTo(world) - b.position.distanceTo(world));
  }

  private targetAhead(): void {
    const world = this.shipWorld(new THREE.Vector3());
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    let best: Anchor | null = null;
    let bestAngle = THREE.MathUtils.degToRad(14);
    for (const a of this.universe.anchors) {
      const dir = _v.copy(a.position).sub(world);
      const dist = dir.length();
      const angle = dir.normalize().angleTo(fwd) - Math.asin(Math.min(1, a.radius / dist));
      if (angle < bestAngle) {
        bestAngle = angle;
        best = a;
      }
    }
    // Neighbouring stars in the sky are targetable too.
    let bestSys: GalaxyStar | null = null;
    const here = this.galaxy.stars[this.systemIndex];
    for (const s of this.galaxy.stars) {
      if (s.index === here.index || starDistance(s, here) > this.player.jumpRange * 1.5) continue;
      const angle = galaxyDir(here, s).angleTo(fwd);
      if (angle < Math.min(bestAngle, THREE.MathUtils.degToRad(3))) {
        bestAngle = angle;
        bestSys = s;
      }
    }
    if (bestSys) this.setSystemTarget(bestSys.index);
    else if (best) this.setTarget(best);
    else this.hud.toast('Nothing to target ahead', 'warn');
  }

  private cycleTarget(dir: number): void {
    const list = this.navList();
    const idx = this.target ? list.indexOf(this.target) : -1;
    this.setTarget(list[(idx + dir + list.length) % list.length]);
  }

  // ---------------------------------------------------------------- frame

  private frame_(frameDt: number): void {
    this.fps += (1 / Math.max(frameDt, 1e-4) - this.fps) * 0.05;
    if (!this.paused) this.handleActions();
    else if (this.input.pressed('Escape')) this.onPauseRequest();
    const m = this.input.consumeMouse();
    const free = this.input.isMouseDown(2);
    if (!this.paused && !this.anyMapOpen && !this.inTunnel) this.steerAim(frameDt, m.dx, m.dy);
    if (!this.mouseAim && !free) {
      this.pendingMouse.dx += m.dx * this.settings.sensitivity;
      this.pendingMouse.dy += m.dy * (this.settings.invertY ? -1 : 1) * this.settings.sensitivity;
    }
    this.input.consumeWheel();
    if (!this.paused && performance.now() / 1000 - this.lastAutosave > AUTOSAVE_INTERVAL) {
      this.lastAutosave = performance.now() / 1000;
      void this.saveTo('auto');
    }
    this.renderFrame(frameDt);
    this.input.endFrame();
  }

  renderFrame(frameDt: number): void {
    const ship = this.ship;
    const world = this.shipWorld(new THREE.Vector3());
    const sc = ship.mode === 'supercruise' ? 1 : 0;
    const scBlend = sc ? Math.min(1, ship.transitionAge / 1.2) : Math.max(0, 1 - ship.transitionAge / 0.8) * (ship.transitionAge < 0.8 ? 1 : 0);
    const charging = ship.mode === 'charging' ? ship.charge / 2.5 : 0;
    const jumpCharge = this.jump?.phase === 'charging' ? Math.min(1, this.jump.t / JUMP_CHARGE) : 0;

    this.audio.update({
      throttle: this.paused ? 0 : ship.throttle,
      boost: ship.boosting,
      supercruise: this.paused ? 0 : scBlend,
      scoop: this.paused ? 0 : this.scooping,
      tunnel: this.inTunnel ? Math.min(1, this.jump!.t / 0.6) : 0,
    });

    if (this.inTunnel) {
      const j = this.jump!;
      const exit = j.built ? THREE.MathUtils.clamp((j.t - (TUNNEL_MIN - 1.6)) / 1.6, 0, 1) : 0;
      this.tunnel.update(frameDt, j.t, exit, this.pipeline.aspect);
      this.pipeline.render(this.tunnel.scene, this.tunnel.camera, {
        atmospheres: [],
        sunColor: new THREE.Color(1, 1, 1),
        sunViewPos: null,
        sunRadius: 1,
        warp: 0.55 + exit * 0.6,
        time: j.t,
      });
      return;
    }
    if (this.map?.open) {
      this.map.render(world, this.frame, ship.quaternion, this.time);
      return;
    }
    if (this.galaxyMap?.open) {
      this.galaxyMap.render(frameDt, performance.now() / 1000);
      return;
    }
    if (this.fleetScreen.open) {
      this.fleetScreen.render(frameDt, performance.now() / 1000);
      return;
    }

    // Camera.
    const speedFactor = THREE.MathUtils.clamp(ship.speed / (ship.stats.maxSpeed * ship.stats.boostMultiplier), 0, 1);
    const flash = ship.transitionAge < 0.6 ? 1 - ship.transitionAge / 0.6 : 0;
    const shake = charging * 1.5 + flash * 3 + (ship.boosting ? 0.6 : 0) + jumpCharge * jumpCharge * 3;
    this.lastShake += (shake - this.lastShake) * 0.2;
    this.chase.update(frameDt, this.viewQuaternion(new THREE.Quaternion()), speedFactor + scBlend, this.lastShake, this.time);
    this.camWorld.copy(world).add(this.chase.offset);
    this.camera.position.set(0, 0, 0);
    this.camera.quaternion.copy(this.chase.quaternion);
    const fov = BASE_FOV + scBlend * 14 + charging * 4 - flash * 6 * sc + jumpCharge * 10;
    this.camera.fov += (fov - this.camera.fov) * Math.min(1, frameDt * 6);
    this.camera.aspect = this.pipeline.aspect;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();

    // Ship.
    this.shipVisual.root.position.copy(world).sub(this.camWorld);
    this.shipVisual.root.quaternion.copy(ship.quaternion);
    this.shipVisual.update(
      frameDt,
      this.time,
      ship.throttle,
      ship.boosting,
      Math.max(scBlend, charging * 0.5, jumpCharge),
      -ship.angular.y * 0.35 + ship.angular.z * 0.05,
      ship.angular.x * 0.08,
    );

    // Turrets track wherever the camera is looking; escorts hold formation.
    const aimLocal = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).applyQuaternion(_q.copy(ship.quaternion).invert());
    this.shipVisual.aimTurrets(aimLocal, frameDt);
    this.escorts.update(frameDt, this.time, this.shipVisual.root.position, ship.quaternion, ship.throttle, ship.boosting, Math.max(scBlend, jumpCharge), aimLocal);

    const pixelsPerRadian = window.innerHeight / THREE.MathUtils.degToRad(this.camera.fov);
    const ctx = { origin: this.camWorld, camera: this.camera, time: this.time, dt: frameDt, pixelsPerRadian };
    const { atmospheres } = this.view.update(ctx, this.pipeline.renderer.getPixelRatio());
    this.view.updateLocalLighting(world);
    this.dust.update(frameDt, ship.velocity, ship.speed, Math.max(scBlend, jumpCharge));

    const starView = _v.copy(this.universe.star.position).sub(this.camWorld).applyQuaternion(_q.copy(this.camera.quaternion).invert());
    this.pipeline.render(this.scene, this.camera, {
      atmospheres,
      sunColor: this.view.sunColor,
      sunViewPos: starView.clone(),
      sunRadius: this.universe.star.radius,
      warp: scBlend * 0.6 + charging * 0.15 + flash * 0.8 + jumpCharge * jumpCharge * 0.9,
      time: this.time,
    });

    this.updateHud(world);
  }

  private updateHud(world: THREE.Vector3): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const camInv = _q.copy(this.camera.quaternion).invert();
    const projectDir = (dir: THREE.Vector3): { x: number; y: number } | null => {
      const v = _v.copy(dir).applyQuaternion(camInv);
      if (v.z >= 0) return null;
      v.applyMatrix4(this.camera.projectionMatrix);
      return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h };
    };
    const project = (p: THREE.Vector3) => projectDir(_v2.copy(p).sub(this.camWorld));

    let rootPlanet: Anchor | null = this.frame;
    while (rootPlanet && rootPlanet.parent) rootPlanet = rootPlanet.parent;

    const markers: MarkerData[] = [];
    const pxPerRad = h / THREE.MathUtils.degToRad(this.camera.fov);
    for (const a of this.universe.anchors) {
      const dist = a.position.distanceTo(this.camWorld);
      const isTarget = a === this.target;
      if (!isTarget) {
        if (a.kind === 'body' && (a as BodyState).def.kind === 'moon' && a.parent !== rootPlanet && dist > 3e7) continue;
        if (a.kind === 'station' && a.parent !== rootPlanet && dist > 2e6) continue;
      }
      const s = project(a.position);
      if (!s || s.x < -50 || s.y < -50 || s.x > w + 50 || s.y > h + 50) continue;
      const radiusPx = Math.asin(Math.min(1, a.radius / Math.max(dist, a.radius))) * pxPerRad;
      if (radiusPx > h * 0.9 && !isTarget) continue;
      markers.push({
        id: a.id,
        kind: a.kind,
        name: a.name,
        x: s.x,
        y: s.y,
        distance: Math.max(0, a.position.distanceTo(world) - (a.kind === 'station' ? 0 : a.radius)),
        radiusPx: a.kind === 'station' ? 0 : radiusPx,
        target: isTarget,
      });
    }
    // Hyperspace target (and the rest of the route's next hop) shown at infinity.
    const here = this.galaxy.stars[this.systemIndex];
    if (this.systemTarget) {
      const s = projectDir(galaxyDir(here, this.systemTarget));
      if (s)
        markers.push({
          id: `sys-${this.systemTarget.index}`,
          kind: 'system',
          name: this.systemTarget.name,
          x: s.x,
          y: s.y,
          distance: 0,
          distanceText: `${starDistance(here, this.systemTarget).toFixed(1)} ly`,
          radiusPx: 0,
          target: true,
        });
    }

    // Prograde marker.
    let prograde: HudState['prograde'] = null;
    if (this.ship.speed > 5) {
      const p = projectDir(this.ship.velocity.clone().normalize());
      if (p) prograde = { x: p.x, y: p.y };
    }

    // Target panel.
    let target: HudState['target'] = null;
    const edge = (dir: THREE.Vector3, onScreen: boolean) => {
      if (onScreen) return null;
      const v = dir.clone().applyQuaternion(camInv);
      return Math.atan2(-v.y, v.x);
    };
    if (this.target) {
      const t = this.target;
      const rel = t.position.clone().sub(world);
      const dist = Math.max(0, rel.length() - (t.kind === 'station' ? 0 : t.radius));
      const closing =
        this.ship.mode === 'supercruise'
          ? this.ship.scSpeed * Math.max(0, this.ship.forward.dot(rel.clone().normalize()))
          : this.ship.velocity.dot(rel.clone().normalize());
      const s = project(t.position);
      const sub =
        t.kind === 'star'
          ? `Class ${this.universe.system.star.spectralClass} star`
          : t.kind === 'station'
            ? `Station · ${t.parent?.name ?? ''}`
            : `${PLANET_TYPE_LABEL[(t as BodyState).def.type]} ${(t as BodyState).def.kind}`;
      const rows: [string, string][] = [
        ['Distance', formatDistance(dist)],
        ['ETA', closing > 1 ? formatDuration(dist / closing) : '—'],
      ];
      if (Math.abs(closing) > 0.5) rows.push(['Closing', `${formatSpeed(closing).value} ${formatSpeed(closing).unit}`]);
      target = {
        name: t.name,
        sub,
        rows,
        status: this.ship.autoAlign ? '● AUTO-ALIGN ENGAGED' : '[G] AUTO-ALIGN',
        statusOn: this.ship.autoAlign,
        edgeAngle: edge(rel, !!s && s.x > 0 && s.y > 0 && s.x < w && s.y < h),
        hyperspace: false,
      };
    } else if (this.systemTarget) {
      const dest = this.systemTarget;
      const dir = galaxyDir(here, dest);
      const d = starDistance(here, dest);
      const fuel = this.jumpFuel(here, dest);
      const angle = THREE.MathUtils.radToDeg(this.alignmentAngle());
      const s = projectDir(dir);
      const remaining = this.route ? this.route.hops.length : 1;
      const blocker = this.jumpBlocker(world);
      let status: string;
      let ok = false;
      if (this.jump?.phase === 'charging') status = angle < 9 ? '● CHARGING — HOLD ALIGNMENT' : `▲ ALIGN TO DESTINATION (${angle.toFixed(0)}°)`;
      else if (blocker) status = `✕ ${blocker.toUpperCase()}`;
      else if (angle > 9) status = `ALIGN ${angle.toFixed(0)}° · [G] AUTO-ALIGN · [J] JUMP`;
      else {
        status = '● ALIGNED — PRESS [J] TO JUMP';
        ok = true;
      }
      target = {
        name: dest.name,
        sub: `Hyperspace · Class ${dest.spectralClass}${dest.nebula >= 0 ? ' · nebula' : ''}`,
        rows: [
          ['Distance', `${d.toFixed(2)} ly`],
          ['Fuel', `${fuel.toFixed(1)} / ${this.player.fuel.toFixed(1)} t`],
          ['Route', `${remaining} jump${remaining > 1 ? 's' : ''} remaining`],
        ],
        status,
        statusOn: ok,
        edgeAngle: edge(dir, !!s && s.x > 0 && s.y > 0 && s.x < w && s.y < h),
        hyperspace: true,
      };
    }

    // Altitude.
    let altitude: HudState['altitude'] = null;
    if (this.frame && this.frame.kind === 'body') {
      const b = this.frame as BodyState;
      const alt = world.distanceTo(b.position) - b.radius;
      const inAtmo = b.def.atmosphere && alt < b.def.atmosphere.height;
      altitude = {
        text: `ALT ${formatDistance(alt)}${inAtmo ? ' · IN ATMOSPHERE' : ''}${alt < 1500 ? ' · SURFACE PROXIMITY' : ''}`,
        warn: alt < 1500,
      };
    }
    const starAlt = world.distanceTo(this.universe.star.position) - this.universe.star.radius;
    if (!altitude && starAlt < this.universe.star.radius * 3)
      altitude = { text: `CORONA ${formatDistance(starAlt)}${starAlt < this.universe.star.radius * 0.8 ? ' · HEAT WARNING' : ''}`, warn: starAlt < this.universe.star.radius * 0.8 };
    const frameName = this.frame
      ? this.frame.kind === 'station'
        ? `Approaching ${this.frame.name}`
        : `Orbiting ${this.frame.name}`
      : 'Interplanetary space';

    let banner: HudState['banner'] = null;
    if (this.jump?.phase === 'charging') {
      const left = Math.max(0, JUMP_CHARGE - this.jump.t);
      banner =
        left > 0
          ? { title: `Hyperjump in ${Math.ceil(left)}`, sub: `${this.systemTarget?.name ?? ''} · [J] cancel` }
          : { title: 'Align with destination', sub: 'The jump fires when the target is under the reticle' };
    }
    const station = this.resupplyStation();
    const prompt = station ? `[R] Dock at ${station.name}` : null;

    this.hud.update(
      {
        systemName: this.universe.system.name,
        frameName,
        speed: this.ship.speed,
        mode: this.ship.mode,
        charge: this.ship.charge / 2.5,
        throttle: this.ship.throttle,
        boosting: this.ship.boosting,
        altitude,
        target,
        stick: { x: this.ship.stick.x, y: this.ship.stick.y },
        nose: this.mouseAim && this.ship.forward.angleTo(new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion)) > 0.012 ? projectDir(this.ship.forward.clone()) : null,
        prograde,
        pointerLocked: this.input.locked,
        fps: this.fps,
        showFps: this.showFps,
        fuel: { value: this.player.fuel, capacity: this.player.fuelCapacity, scooping: this.scooping },
        supplies: { value: this.player.supplies, capacity: this.player.suppliesCapacity },
        banner,
        prompt,
        day: this.day,
      },
      markers,
      w,
      h,
    );
  }

  /** Debug helpers, exposed on window.game for testing and screenshots. */
  readonly debug = {
    /**
     * Teleport above a body. `view` 0 looks straight down at it, 1 looks at the horizon.
     * The ship sits over the morning side so terminators and limbs are in view.
     */
    goto: (name: string, altitude: number, options: { view?: number; sunSide?: number } = {}) => {
      const a = this.universe.anchors.find((x) => x.name.toLowerCase() === name.toLowerCase() || x.id === name);
      if (!a) return `No anchor named ${name}. Try: ${this.universe.anchors.map((x) => x.name).join(', ')}`;
      this.ship.dropOut('Debug teleport');
      this.frame = a.kind === 'star' ? null : a;
      const toStar = this.universe.star.position.clone().sub(a.position).normalize();
      if (a.kind === 'star') toStar.set(1, 0, 0);
      const pole = new THREE.Vector3(0, 1, 0);
      const side = new THREE.Vector3().crossVectors(toStar, pole).normalize();
      const sunSide = options.sunSide ?? 0.6;
      const dir = toStar.clone().multiplyScalar(sunSide).addScaledVector(side, Math.sqrt(1 - sunSide * sunSide)).normalize();
      this.local.copy(dir).multiplyScalar(a.radius + altitude);
      if (!this.frame) this.local.add(a.position);
      const horizon = toStar.clone().addScaledVector(dir, -toStar.dot(dir)).normalize();
      const look = dir.clone().negate().lerp(horizon, options.view ?? 0.75).normalize();
      const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), look, dir);
      this.ship.quaternion.setFromRotationMatrix(m);
      this.ship.velocity.set(0, 0, 0);
      this.ship.throttle = 0;
      this.snapView();
      this.updateFrame();
      return `At ${a.name}, altitude ${formatDistance(altitude)}`;
    },
    lookAt: (name: string) => {
      const a = this.universe.anchors.find((x) => x.name.toLowerCase() === name.toLowerCase() || x.id === name);
      if (!a) return 'not found';
      const world = this.shipWorld(new THREE.Vector3());
      const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), a.position.clone().sub(world), new THREE.Vector3(0, 1, 0));
      this.ship.quaternion.setFromRotationMatrix(m);
      this.snapView();
      return 'ok';
    },
    /** Point the ship at the current hyperspace target. */
    alignToSystem: () => {
      const dir = this.systemTargetDir();
      if (!dir) return 'no system target';
      this.ship.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), dir, new THREE.Vector3(0, 1, 0)));
      this.snapView();
      return 'ok';
    },
    supercruise: () => {
      this.ship.mode = 'supercruise';
      this.ship.scSpeed = 2e5;
      this.ship.throttle = 1;
      this.ship.transitionAge = 5;
    },
    setTime: (t: number) => {
      this.time = t;
    },
    target: (name: string) => {
      const a = this.universe.anchors.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (a) this.setTarget(a);
    },
    plot: (to: number | string) => {
      const idx = typeof to === 'number' ? to : this.galaxy.stars.find((s) => s.name.toLowerCase() === to.toLowerCase())?.index;
      if (idx === undefined) return 'unknown system';
      return this.plotRoute(idx);
    },
    /** Nearest systems within jump range. */
    neighbours: () => {
      const here = this.galaxy.stars[this.systemIndex];
      return this.galaxy.stars
        .filter((s) => s.index !== here.index && starDistance(s, here) <= this.player.jumpRange)
        .map((s) => ({ index: s.index, name: s.name, ly: +starDistance(s, here).toFixed(2) }))
        .sort((a, b) => a.ly - b.ly);
    },
    /** Instantly arrive in another system (skips the tunnel). */
    warp: async (index: number) => {
      const from = this.systemIndex;
      const built = await this.buildSystem(index);
      this.arrive(built, { kind: 'hyperspace', from });
      return this.debug.state();
    },
    map: () => this.toggleMap(),
    galaxyMap: () => this.toggleGalaxyMap(),
    anchors: () => this.universe.anchors.map((a) => `${a.name} (${a.kind}${a.kind === 'body' ? ' ' + (a as BodyState).def.type : ''})`),
    system: () => this.universe.system,
    state: () => ({
      system: this.galaxy.stars[this.systemIndex].name,
      index: this.systemIndex,
      day: this.day,
      mode: this.ship.mode,
      jump: this.jump ? { phase: this.jump.phase, t: +this.jump.t.toFixed(2), ready: !!this.jump.built } : null,
      fuel: +this.player.fuel.toFixed(2),
      supplies: this.player.supplies,
      frame: this.frame?.name ?? 'system',
      target: this.target?.name ?? this.systemTarget?.name ?? null,
      route: this.route?.stars.map((i) => this.galaxy.stars[i].name) ?? null,
      visited: this.player.visited.size,
    }),
  };
}
