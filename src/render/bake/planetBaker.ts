import * as THREE from 'three';
import { Rng } from '../../core/rng';
import type { BodyDef } from '../../galaxy/types';
import { planetBakeFragment, planetBakeVertex } from '../shaders/planetBake';

export interface BakedMaps {
  size: number;
  albedo: THREE.WebGLCubeRenderTarget;
  normal: THREE.WebGLCubeRenderTarget;
}

interface BakeJob {
  body: BodyDef;
  size: number;
  maps: BakedMaps;
  /** Next strip index across 2 passes × 6 faces × strips. */
  step: number;
  stripsPerFace: number;
  resolve: (maps: BakedMaps) => void;
  cancelled: boolean;
}

function createTarget(size: number, srgb: boolean): THREE.WebGLCubeRenderTarget {
  const rt = new THREE.WebGLCubeRenderTarget(size, {
    type: THREE.UnsignedByteType,
    generateMipmaps: false,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
  });
  rt.texture.anisotropy = 4;
  return rt;
}

/**
 * Renders procedural planet surfaces into cube maps.
 * Low-res bakes run synchronously at load; high-res bakes for the body the
 * player approaches are spread over many frames in horizontal strips.
 */
export class PlanetBaker {
  private readonly scene = new THREE.Scene();
  private readonly material: THREE.ShaderMaterial;
  private readonly cubeCamera: THREE.CubeCamera;
  private readonly queue: BakeJob[] = [];

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: planetBakeVertex,
      fragmentShader: planetBakeFragment,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uPass: { value: 0 },
        uGas: { value: 0 },
        uOct: { value: 7 },
        uSeed: { value: new THREE.Vector3() },
        uSeaLevel: { value: -1 },
        uDeep: { value: new THREE.Color() },
        uShallow: { value: new THREE.Color() },
        uBeach: { value: new THREE.Color() },
        uLow: { value: new THREE.Color() },
        uLowAlt: { value: new THREE.Color() },
        uHigh: { value: new THREE.Color() },
        uPeak: { value: new THREE.Color() },
        uSnow: { value: new THREE.Color() },
        uContinentFreq: { value: 1 },
        uMountainAmp: { value: 0.5 },
        uRidgeAmp: { value: 0.5 },
        uCraterAmp: { value: 0 },
        uWarp: { value: 0.5 },
        uBump: { value: 1 },
        uIceCap: { value: 0 },
        uCloudCover: { value: 0 },
        uBandFreq: { value: 8 },
        uBandTurb: { value: 0.5 },
        uStorms: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
        uStormCount: { value: 0 },
        uEps: { value: 0.002 },
      },
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), this.material));
    this.cubeCamera = new THREE.CubeCamera(0.01, 10, createTarget(4, false));
  }

  private configure(body: BodyDef, size: number): void {
    const u = this.material.uniforms;
    const s = body.surface;
    const rng = new Rng(body.seed ^ 0x5eed);
    (u.uSeed.value as THREE.Vector3).set(rng.range(-500, 500), rng.range(-500, 500), rng.range(-500, 500));
    u.uGas.value = body.type === 'gasGiant' ? 1 : 0;
    u.uOct.value = size >= 1024 ? 9 : size >= 512 ? 8 : 7;
    u.uSeaLevel.value = s.seaLevel;
    for (const k of ['deep', 'shallow', 'beach', 'low', 'lowAlt', 'high', 'peak', 'snow'] as const) {
      const name = `u${k.charAt(0).toUpperCase()}${k.slice(1)}`;
      (u[name].value as THREE.Color).setRGB(...s[k]);
    }
    u.uContinentFreq.value = s.continentFreq;
    u.uMountainAmp.value = s.mountainAmp;
    u.uRidgeAmp.value = s.ridgeAmp;
    u.uCraterAmp.value = s.craterAmp;
    u.uWarp.value = s.warp;
    u.uBump.value = s.bump;
    u.uIceCap.value = s.iceCap;
    u.uCloudCover.value = s.cloudCover;
    u.uBandFreq.value = s.bandFreq;
    u.uBandTurb.value = s.bandTurbulence;
    // Gas giants get banded storms; cloudy rocky worlds get a couple of cyclones.
    u.uStormCount.value = body.type === 'gasGiant' ? s.storms : s.cloudCover > 0.2 ? 2 : 0;
    const storms = u.uStorms.value as THREE.Vector4[];
    const gas = body.type === 'gasGiant';
    for (let i = 0; i < 3; i++) {
      // Gas giant storms sit anywhere in the bands; cyclones live at mid-latitudes.
      const lat = gas ? rng.range(-0.45, 0.45) : (rng.next() < 0.5 ? -1 : 1) * rng.range(0.3, 0.6);
      const lon = rng.range(0, Math.PI * 2);
      const r = Math.sqrt(1 - lat * lat);
      storms[i].set(Math.cos(lon) * r, lat, Math.sin(lon) * r, gas ? rng.range(0.06, 0.14) : rng.range(0.1, 0.18));
    }
    u.uEps.value = 1.5 / size;
  }

  private prepareCamera(): void {
    if (this.cubeCamera.coordinateSystem !== this.renderer.coordinateSystem) {
      this.cubeCamera.coordinateSystem = this.renderer.coordinateSystem;
      this.cubeCamera.updateCoordinateSystem();
    }
    this.cubeCamera.updateMatrixWorld(true);
  }

  private renderStrip(job: BakeJob): void {
    const { stripsPerFace, size } = job;
    const perPass = 6 * stripsPerFace;
    const pass = Math.floor(job.step / perPass);
    const face = Math.floor((job.step % perPass) / stripsPerFace);
    const strip = job.step % stripsPerFace;
    const target = pass === 0 ? job.maps.albedo : job.maps.normal;
    const stripH = size / stripsPerFace;

    this.configure(job.body, size);
    this.material.uniforms.uPass.value = pass;
    this.prepareCamera();

    const isLast = face === 5 && strip === stripsPerFace - 1;
    target.texture.generateMipmaps = isLast;
    target.scissor.set(0, strip * stripH, size, stripH);
    target.scissorTest = stripsPerFace > 1;

    const prevTarget = this.renderer.getRenderTarget();
    const prevAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.setRenderTarget(target, face);
    this.renderer.render(this.scene, this.cubeCamera.children[face] as THREE.Camera);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.autoClear = prevAutoClear;
    target.texture.generateMipmaps = false;
    target.scissorTest = false;
    job.step++;
  }

  private createJob(body: BodyDef, size: number, stripsPerFace: number): Promise<BakedMaps> & { job: BakeJob } {
    let resolve!: (m: BakedMaps) => void;
    const promise = new Promise<BakedMaps>((r) => (resolve = r)) as Promise<BakedMaps> & { job: BakeJob };
    promise.job = {
      body,
      size,
      stripsPerFace,
      step: 0,
      resolve,
      cancelled: false,
      maps: { size, albedo: createTarget(size, true), normal: createTarget(size, false) },
    };
    return promise;
  }

  /** Bake immediately (blocking). Use for low-res bakes at load. */
  bakeNow(body: BodyDef, size: number): BakedMaps {
    const p = this.createJob(body, size, 1);
    while (p.job.step < 12) this.renderStrip(p.job);
    return p.job.maps;
  }

  /** Queue a progressive bake; call `update()` each frame. */
  bakeProgressive(body: BodyDef, size: number): { promise: Promise<BakedMaps>; cancel: () => void } {
    const p = this.createJob(body, size, Math.max(1, size / 64));
    this.queue.push(p.job);
    return {
      promise: p,
      cancel: () => {
        p.job.cancelled = true;
      },
    };
  }

  /** Render a few strips of queued work. */
  update(stripsPerFrame = 2): void {
    for (let n = 0; n < stripsPerFrame && this.queue.length > 0; n++) {
      const job = this.queue[0];
      if (job.cancelled) {
        this.queue.shift();
        disposeMaps(job.maps);
        continue;
      }
      this.renderStrip(job);
      if (job.step >= 12 * job.stripsPerFace) {
        this.queue.shift();
        job.resolve(job.maps);
      }
    }
  }

  get busy(): boolean {
    return this.queue.length > 0;
  }
}

export function disposeMaps(maps: BakedMaps): void {
  maps.albedo.dispose();
  maps.normal.dispose();
}
