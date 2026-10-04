import * as THREE from 'three';
import { GameLoop } from './core/loop';
import { Input } from './core/input';
import { generateSystem } from './galaxy/systemGen';
import { PLANET_TYPE_LABEL } from './planets/planetTypes';
import { PlanetBaker } from './render/bake/planetBaker';
import { ChaseCamera } from './render/chaseCamera';
import { QUALITY, RenderPipeline } from './render/pipeline';
import { SpaceDust } from './render/spaceDust';
import { type Controls, type FlightEnv, ShipController, SHIP_STATS } from './ships/flight';
import { createShip, type ShipVisual } from './ships/shipMesh';
import { formatDistance } from './ui/format';
import { Hud, type HudState, type MarkerData } from './ui/hud';
import { SystemMap } from './ui/systemMap';
import { SystemView } from './world/systemView';
import { type Anchor, type BodyState, Universe } from './world/universe';

type QualityName = keyof typeof QUALITY;
const QUALITY_ORDER: QualityName[] = ['low', 'medium', 'high'];
const BASE_FOV = 62;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** Altitude below which supercruise is unavailable (mass lock). */
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

export class Game {
  readonly pipeline: RenderPipeline;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 1e12);
  readonly input: Input;
  readonly universe: Universe;
  readonly view: SystemView;
  readonly baker: PlanetBaker;
  readonly ship = new ShipController();
  readonly shipVisual: ShipVisual;
  readonly chase = new ChaseCamera();
  readonly dust: SpaceDust;
  readonly hud: Hud;
  map!: SystemMap;

  /** Ship reference frame and frame-relative position (float64). */
  frame: Anchor | null = null;
  readonly local = new THREE.Vector3();
  target: Anchor | null = null;
  time = 0;
  private quality: QualityName;
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

  constructor(container: HTMLElement, readonly seed: number, quality: QualityName) {
    this.quality = quality;
    this.pipeline = new RenderPipeline(container, QUALITY[quality]);
    this.input = new Input(this.pipeline.renderer.domElement);
    this.universe = new Universe(generateSystem(seed));
    this.baker = new PlanetBaker(this.pipeline.renderer);
    this.view = new SystemView(this.scene, this.universe, this.pipeline.renderer, this.baker);
    this.shipVisual = createShip();
    this.scene.add(this.shipVisual.root);
    this.dust = new SpaceDust(seed);
    this.scene.add(this.dust.mesh);
    this.hud = new Hud(document.body);
    this.hud.setVisible(false);

    this.ship.onEvent((e) => {
      switch (e.type) {
        case 'charging':
          this.hud.toast('Frame shift drive charging');
          break;
        case 'engaged':
          this.hud.toast('Supercruise engaged', 'good');
          break;
        case 'dropped':
          this.hud.toast(e.reason, e.reason.startsWith('Mass') ? 'warn' : '');
          break;
        case 'masslocked':
          this.hud.toast(e.reason, 'warn');
          break;
        case 'align':
          this.hud.toast(e.on ? 'Auto-align engaged' : 'Auto-align released');
          break;
      }
    });
  }

  async load(onProgress: (f: number, label: string) => void): Promise<void> {
    await this.view.bake(onProgress);
    this.map = new SystemMap(this.universe, this.pipeline, this.view.planets, this.view.skyTexture);
    this.map.onSetTarget = (a) => this.setTarget(a);
    this.spawn();
    // Warm up shader compilation so the first frame doesn't hitch.
    this.renderFrame(0);
    this.pipeline.renderer.compile(this.scene, this.camera);
  }

  /** Start near the trade station with the homeworld behind it, lit from the side. */
  private spawn(): void {
    const u = this.universe;
    const station = u.stations[0];
    let best = 0;
    let bestScore = -Infinity;
    if (station) {
      for (let t = 0; t < station.def.orbit.period; t += station.def.orbit.period / 90) {
        u.update(t + 600);
        const out = _v.copy(station.position).sub(station.parent.position).normalize();
        const toStar = _v2.copy(u.star.position).sub(station.parent.position).normalize();
        const score = -Math.abs(out.dot(toStar) - 0.35);
        if (score > bestScore) {
          bestScore = score;
          best = t + 600;
        }
      }
    }
    this.time = best;
    u.update(this.time);
    if (station) {
      const planet = station.parent;
      const out = _v.copy(station.position).sub(planet.position).normalize();
      const toStar = _v2.copy(u.star.position).sub(station.position).normalize();
      const side = new THREE.Vector3().crossVectors(out, toStar).normalize();
      const offset = out.clone().multiplyScalar(4200).addScaledVector(side, 1400).addScaledVector(toStar, 900);
      this.frame = station;
      this.local.copy(offset);
      // Face the station, with the planet looming behind it.
      const look = new THREE.Matrix4().lookAt(new THREE.Vector3(), offset.clone().negate().add(out.clone().multiplyScalar(-1500)), new THREE.Vector3(0, 1, 0).applyQuaternion(planet.tilt));
      this.ship.quaternion.setFromRotationMatrix(look);
      this.target = station;
      this.map.targetId = station.id;
    } else {
      const p = u.bodies[0];
      this.frame = p;
      this.local.set(0, 0, p.radius * 3);
      this.ship.quaternion.identity();
    }
    this.ship.velocity.set(0, 0, 0);
    this.ship.throttle = 0;
    this.chase.snap(this.ship.quaternion);
  }

  start(): void {
    this.hud.setVisible(true);
    this.hud.toast(`Welcome to the ${this.universe.system.name} system`, 'good');
    setTimeout(() => this.hud.setHelp(true), 600);
    setTimeout(() => this.hud.setHelp(false), 14000);
    this.loop = new GameLoop(
      (dt) => this.fixedUpdate(dt),
      (_alpha, frameDt) => this.frame_(frameDt),
    );
    this.loop.start();
  }

  shipWorld(out = this.shipWorldPos): THREE.Vector3 {
    out.copy(this.local);
    if (this.frame) out.add(this.frame.position);
    return out;
  }

  setTarget(a: Anchor | null): void {
    this.target = a;
    if (this.map) this.map.targetId = a?.id ?? null;
    if (a) this.hud.toast(`Target: ${a.name}`);
    if (!a && this.ship.autoAlign) this.ship.setAutoAlign(false);
  }

  private setFrame(f: Anchor | null): void {
    const world = this.shipWorld(_v.set(0, 0, 0)).clone();
    this.frame = f;
    this.local.copy(world);
    if (f) this.local.sub(f.position);
  }

  /** Switch reference frames when crossing spheres of influence. */
  private updateFrame(): void {
    const world = this.shipWorld(new THREE.Vector3());
    while (this.frame && world.distanceTo(this.frame.position) > this.frame.soiRadius * 1.02) {
      const leaving = this.frame;
      this.setFrame(this.frame.parent);
      if (leaving.kind === 'body') this.hud.toast(`Leaving ${leaving.name} orbit`);
    }
    for (let guard = 0; guard < 4; guard++) {
      const child = this.universe.childrenOf(this.frame).find((c) => world.distanceTo(c.position) < c.soiRadius);
      if (!child) break;
      this.setFrame(child);
      this.hud.toast(child.kind === 'station' ? `Approaching ${child.name}` : `Entering ${child.name} orbit`);
    }
  }

  private flightEnv(world: THREE.Vector3): FlightEnv {
    const u = this.universe;
    let massLock: string | null = null;
    let nearestD = Infinity;
    for (const a of u.anchors) {
      const alt = world.distanceTo(a.position) - a.radius;
      nearestD = Math.min(nearestD, alt);
      if (alt < lockAltitude(a)) massLock = a.kind === 'station' ? `Mass locked — ${a.name}` : `Mass locked — ${a.name} gravity well`;
    }
    let arrived: string | null = null;
    let targetDir: THREE.Vector3 | null = null;
    if (this.target) {
      const rel = _v2.copy(this.target.position).sub(world);
      const alt = rel.length() - this.target.radius;
      if (alt < arrivalAltitude(this.target)) arrived = `Arrived at ${this.target.name}`;
      targetDir = rel.clone().normalize();
    }
    return { surfaceDistance: Math.max(nearestD, 1), massLock, arrived, targetDir };
  }

  private fixedUpdate(dt: number): void {
    this.time += dt;
    this.universe.update(this.time);
    const world = this.shipWorld(new THREE.Vector3());
    const env = this.flightEnv(world);
    const i = this.input;
    const c: Controls = {
      throttleAxis: i.axis('KeyS', 'KeyW'),
      strafeX: i.axis('KeyA', 'KeyD'),
      strafeY: i.axis('ControlLeft', 'Space'),
      roll: i.axis('KeyE', 'KeyQ'),
      mouseDX: this.pendingMouse.dx,
      mouseDY: this.pendingMouse.dy,
      boost: i.isDown('ShiftLeft') || i.isDown('ShiftRight'),
      zeroThrottle: this.pendingZero,
      toggleSupercruise: this.pendingToggleSC,
    };
    this.pendingMouse = { dx: 0, dy: 0 };
    this.pendingToggleSC = false;
    this.pendingZero = false;
    if (this.map?.open) {
      c.mouseDX = c.mouseDY = 0;
    }
    const disp = this.ship.update(dt, c, env, _v);
    this.local.add(disp);
    this.updateFrame();
    this.collide();
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
      if (push(b.position, b.radius + 30)) {
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
      const tube = st.radius * 0.07 + 20;
      const ringDist = Math.hypot(Math.hypot(local.x, local.z) - R, local.y);
      if (ringDist < tube) {
        const ringPt = new THREE.Vector3(local.x, 0, local.z).setLength(R).applyQuaternion(st.rotation).add(st.position);
        push(ringPt, tube);
      }
      const spY = THREE.MathUtils.clamp(local.y, -st.radius * 0.72, st.radius * 0.72);
      const spinePt = new THREE.Vector3(0, spY, 0).applyQuaternion(st.rotation).add(st.position);
      push(spinePt, st.radius * 0.2 + 20);
    }
    for (const r of this.view.rockColliders()) push(r.position, r.radius + 15);
  }

  private handleActions(): void {
    const i = this.input;
    if (i.pressed('KeyM') || (this.map.open && i.pressed('Escape'))) this.toggleMap();
    if (this.map.open) return;
    if (i.pressed('KeyJ')) this.pendingToggleSC = true;
    if (i.pressed('KeyX')) this.pendingZero = true;
    if (i.pressed('KeyH')) this.hud.setHelp(!this.hud.helpVisible);
    if (i.pressed('F3')) this.showFps = !this.showFps;
    if (i.pressed('F4')) {
      this.quality = QUALITY_ORDER[(QUALITY_ORDER.indexOf(this.quality) + 1) % QUALITY_ORDER.length];
      this.pipeline.setQuality(QUALITY[this.quality]);
      this.hud.toast(`Graphics quality: ${this.quality}`);
    }
    if (i.pressed('KeyC')) {
      this.cameraZoomIndex = (this.cameraZoomIndex + 1) % 3;
      this.chase.zoom = [1, 1.8, 0.62][this.cameraZoomIndex];
    }
    if (i.pressed('KeyT')) this.targetAhead();
    if (i.pressed('BracketRight') || i.pressed('BracketLeft')) this.cycleTarget(i.pressed('BracketRight') ? 1 : -1);
    if (i.pressed('KeyG')) {
      if (this.target) this.ship.setAutoAlign(!this.ship.autoAlign);
      else this.hud.toast('No target selected', 'warn');
    }
  }

  private toggleMap(): void {
    const open = !this.map.open;
    this.map.setOpen(open, this.shipWorld(), this.frame);
    this.hud.setVisible(!open);
    if (open) {
      this.input.releasePointer();
      this.input.allowPointerLock = false;
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
    if (best) this.setTarget(best);
    else this.hud.toast('Nothing to target ahead', 'warn');
  }

  private cycleTarget(dir: number): void {
    const list = this.navList();
    const idx = this.target ? list.indexOf(this.target) : -1;
    this.setTarget(list[(idx + dir + list.length) % list.length]);
  }

  private frame_(frameDt: number): void {
    this.fps += (1 / Math.max(frameDt, 1e-4) - this.fps) * 0.05;
    this.handleActions();
    const m = this.input.consumeMouse();
    this.pendingMouse.dx += m.dx;
    this.pendingMouse.dy += m.dy;
    this.input.consumeWheel();
    this.renderFrame(frameDt);
    this.input.endFrame();
  }

  private renderFrame(frameDt: number): void {
    const ship = this.ship;
    const world = this.shipWorld(new THREE.Vector3());
    const sc = ship.mode === 'supercruise' ? 1 : 0;
    const scBlend = sc ? Math.min(1, ship.transitionAge / 1.2) : Math.max(0, 1 - ship.transitionAge / 0.8) * (ship.transitionAge < 0.8 ? 1 : 0);
    const charging = ship.mode === 'charging' ? ship.charge / 2.5 : 0;

    if (this.map?.open) {
      this.map.render(world, this.frame, ship.quaternion, this.time);
      return;
    }

    // Camera.
    const speedFactor = THREE.MathUtils.clamp(ship.speed / (SHIP_STATS.maxSpeed * SHIP_STATS.boostMultiplier), 0, 1);
    const flash = ship.transitionAge < 0.6 ? 1 - ship.transitionAge / 0.6 : 0;
    const shake = charging * 1.5 + flash * 3 + (ship.boosting ? 0.6 : 0);
    this.lastShake += (shake - this.lastShake) * 0.2;
    this.chase.update(frameDt, ship.quaternion, speedFactor + scBlend, this.lastShake, this.time);
    this.camWorld.copy(world).add(this.chase.offset);
    this.camera.position.set(0, 0, 0);
    this.camera.quaternion.copy(this.chase.quaternion);
    const fov = BASE_FOV + scBlend * 14 + charging * 4 - flash * 6 * sc;
    this.camera.fov += (fov - this.camera.fov) * Math.min(1, frameDt * 6);
    this.camera.aspect = this.pipeline.aspect;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();

    // Ship.
    this.shipVisual.root.position.copy(world).sub(this.camWorld);
    this.shipVisual.root.quaternion.copy(ship.quaternion);
    this.shipVisual.update(frameDt, this.time, ship.throttle, ship.boosting, Math.max(scBlend, charging * 0.5), -ship.angular.y * 0.35 + ship.angular.z * 0.05, ship.angular.x * 0.08);

    const pixelsPerRadian = window.innerHeight / THREE.MathUtils.degToRad(this.camera.fov);
    const ctx = { origin: this.camWorld, camera: this.camera, time: this.time, dt: frameDt, pixelsPerRadian };
    const { atmospheres } = this.view.update(ctx, this.pipeline.renderer.getPixelRatio());
    this.view.updateLocalLighting(world);
    this.dust.update(frameDt, ship.velocity, ship.speed, scBlend);

    const starView = _v.copy(this.universe.star.position).sub(this.camWorld).applyQuaternion(_q.copy(this.camera.quaternion).invert());
    this.pipeline.exposure = 1.0;
    this.pipeline.render(this.scene, this.camera, {
      atmospheres,
      sunColor: this.view.sunColor,
      sunViewPos: starView.clone(),
      sunRadius: this.universe.star.radius,
      warp: scBlend * 0.6 + charging * 0.15 + flash * 0.8,
      time: this.time,
    });

    this.updateHud(world);
  }

  private updateHud(world: THREE.Vector3): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const camInv = _q.copy(this.camera.quaternion).invert();
    const project = (p: THREE.Vector3): { x: number; y: number; z: number } | null => {
      const v = _v.copy(p).sub(this.camWorld).applyQuaternion(camInv);
      if (v.z >= 0) return null;
      v.applyMatrix4(this.camera.projectionMatrix);
      return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, z: v.z };
    };

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

    // Prograde marker.
    let prograde: HudState['prograde'] = null;
    if (this.ship.speed > 5) {
      const p = project(_v2.copy(this.camWorld).addScaledVector(this.ship.velocity.clone().normalize(), 1e4));
      if (p) prograde = { x: p.x, y: p.y };
    }

    // Target panel.
    let target: HudState['target'] = null;
    if (this.target) {
      const t = this.target;
      const rel = t.position.clone().sub(world);
      const dist = Math.max(0, rel.length() - (t.kind === 'station' ? 0 : t.radius));
      const closing = this.ship.mode === 'supercruise' ? this.ship.scSpeed * Math.max(0, this.ship.forward.dot(rel.clone().normalize())) : this.ship.velocity.dot(rel.clone().normalize());
      const s = project(t.position);
      const onScreen = s && s.x > 0 && s.y > 0 && s.x < w && s.y < h;
      let edgeAngle: number | null = null;
      if (!onScreen) {
        const v = rel.clone().applyQuaternion(camInv);
        edgeAngle = Math.atan2(-v.y, v.x);
      }
      const sub =
        t.kind === 'star'
          ? `Class ${this.universe.system.star.spectralClass} star`
          : t.kind === 'station'
            ? `Station · ${t.parent?.name ?? ''}`
            : `${PLANET_TYPE_LABEL[(t as BodyState).def.type]} ${(t as BodyState).def.kind}`;
      target = {
        name: t.name,
        sub,
        distance: dist,
        eta: closing > 1 ? dist / closing : null,
        relSpeed: Math.abs(closing) > 0.5 ? closing : null,
        align: this.ship.autoAlign,
        edgeAngle,
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
    const frameName = this.frame
      ? this.frame.kind === 'station'
        ? `Approaching ${this.frame.name}`
        : `Orbiting ${this.frame.name}`
      : 'Interplanetary space';

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
        prograde,
        pointerLocked: this.input.locked,
        fps: this.fps,
        showFps: this.showFps,
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
      const pole = new THREE.Vector3(0, 1, 0);
      const side = new THREE.Vector3().crossVectors(toStar, pole).normalize();
      const sunSide = options.sunSide ?? 0.6;
      const dir = toStar.clone().multiplyScalar(sunSide).addScaledVector(side, Math.sqrt(1 - sunSide * sunSide)).normalize();
      this.local.copy(dir).multiplyScalar(a.radius + altitude);
      if (!this.frame) this.local.add(a.position);
      // Horizon direction pointing roughly towards the sun's side.
      const horizon = toStar.clone().addScaledVector(dir, -toStar.dot(dir)).normalize();
      const look = dir.clone().negate().lerp(horizon, options.view ?? 0.75).normalize();
      const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), look, dir);
      this.ship.quaternion.setFromRotationMatrix(m);
      this.ship.velocity.set(0, 0, 0);
      this.ship.throttle = 0;
      this.chase.snap(this.ship.quaternion);
      this.updateFrame();
      return `At ${a.name}, altitude ${formatDistance(altitude)}`;
    },
    lookAt: (name: string) => {
      const a = this.universe.anchors.find((x) => x.name.toLowerCase() === name.toLowerCase() || x.id === name);
      if (!a) return 'not found';
      const world = this.shipWorld(new THREE.Vector3());
      const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), a.position.clone().sub(world), new THREE.Vector3(0, 1, 0));
      this.ship.quaternion.setFromRotationMatrix(m);
      this.chase.snap(this.ship.quaternion);
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
    map: () => this.toggleMap(),
    anchors: () => this.universe.anchors.map((a) => `${a.name} (${a.kind}${a.kind === 'body' ? ' ' + (a as BodyState).def.type : ''})`),
    system: () => this.universe.system,
  };
}
