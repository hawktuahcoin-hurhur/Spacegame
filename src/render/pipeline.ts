import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import {
  MAX_ATMOSPHERES,
  atmosphereFragment,
  bloomDownFragment,
  bloomUpFragment,
  finalFragment,
  fullscreenVertex,
} from './shaders/post';

export interface AtmosphereUniform {
  /** View-space centre (camera-relative). */
  center: THREE.Vector3;
  planetRadius: number;
  topRadius: number;
  betaR: THREE.Vector3;
  betaM: number;
  mieColor: THREE.Color;
  scaleHeightR: number;
  scaleHeightM: number;
  g: number;
  /** View-space direction from the planet to the sun. */
  sunDir: THREE.Vector3;
}

export interface FrameParams {
  atmospheres: AtmosphereUniform[];
  sunColor: THREE.Color;
  /** View-space position of the star centre; null if no flare. */
  sunViewPos: THREE.Vector3 | null;
  sunRadius: number;
  warp: number;
  time: number;
}

export interface Quality {
  pixelRatio: number;
  msaa: number;
  atmoSteps: number;
  atmoLightSteps: number;
}

export const QUALITY: Record<'low' | 'medium' | 'high', Quality> = {
  low: { pixelRatio: 0.75, msaa: 0, atmoSteps: 8, atmoLightSteps: 3 },
  medium: { pixelRatio: 1, msaa: 4, atmoSteps: 12, atmoLightSteps: 4 },
  high: { pixelRatio: 2, msaa: 4, atmoSteps: 16, atmoLightSteps: 6 },
};

const BLOOM_MIPS = 6;

function hdrTarget(w: number, h: number, opts: THREE.RenderTargetOptions = {}): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    ...opts,
  });
}

/**
 * HDR pipeline: scene (MSAA, float depth) → atmospheric scattering →
 * PBR bloom → final composite (flare, ACES, sRGB) to screen.
 */
export class RenderPipeline {
  readonly renderer: THREE.WebGLRenderer;
  private sceneRT!: THREE.WebGLRenderTarget;
  private atmoRT!: THREE.WebGLRenderTarget;
  private bloomRTs: THREE.WebGLRenderTarget[] = [];
  private readonly quad = new FullScreenQuad();
  private readonly atmoMat: THREE.ShaderMaterial;
  private readonly downMat: THREE.ShaderMaterial;
  private readonly upMat: THREE.ShaderMaterial;
  private readonly finalMat: THREE.ShaderMaterial;
  private width = 1;
  private height = 1;
  quality: Quality;
  exposure = 1.0;
  bloomStrength = 0.06;

  constructor(container: HTMLElement, quality: Quality) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    // Passes overwrite whole targets; bloom upsampling relies on additive blending into existing mips.
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);

    const atmoUniforms: Record<string, THREE.IUniform> = {
      tColor: { value: null },
      tDepth: { value: null },
      uInvProj: { value: new THREE.Matrix4() },
      uLogFar: { value: 1 },
      uCount: { value: 0 },
      uSteps: { value: quality.atmoSteps },
      uLightSteps: { value: quality.atmoLightSteps },
      uCenter: { value: Array.from({ length: MAX_ATMOSPHERES }, () => new THREE.Vector3()) },
      uRp: { value: new Array(MAX_ATMOSPHERES).fill(1) },
      uRa: { value: new Array(MAX_ATMOSPHERES).fill(1) },
      uBetaR: { value: Array.from({ length: MAX_ATMOSPHERES }, () => new THREE.Vector3()) },
      uBetaM: { value: new Array(MAX_ATMOSPHERES).fill(0) },
      uMieColor: { value: Array.from({ length: MAX_ATMOSPHERES }, () => new THREE.Color()) },
      uHR: { value: new Array(MAX_ATMOSPHERES).fill(1) },
      uHM: { value: new Array(MAX_ATMOSPHERES).fill(1) },
      uG: { value: new Array(MAX_ATMOSPHERES).fill(0.76) },
      uSunDir: { value: Array.from({ length: MAX_ATMOSPHERES }, () => new THREE.Vector3(0, 1, 0)) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSunIntensity: { value: 22 },
    };
    this.atmoMat = new THREE.ShaderMaterial({
      vertexShader: fullscreenVertex,
      fragmentShader: atmosphereFragment,
      uniforms: atmoUniforms,
      depthTest: false,
      depthWrite: false,
    });
    this.downMat = new THREE.ShaderMaterial({
      vertexShader: fullscreenVertex,
      fragmentShader: bloomDownFragment,
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 } },
      depthTest: false,
      depthWrite: false,
    });
    this.upMat = new THREE.ShaderMaterial({
      vertexShader: fullscreenVertex,
      fragmentShader: bloomUpFragment,
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 } },
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.finalMat = new THREE.ShaderMaterial({
      vertexShader: fullscreenVertex,
      fragmentShader: finalFragment,
      uniforms: {
        tHdr: { value: null },
        tBloom: { value: null },
        tDepth: { value: null },
        uResolution: { value: new THREE.Vector2() },
        uBloom: { value: this.bloomStrength },
        uExposure: { value: this.exposure },
        uTime: { value: 0 },
        uWarp: { value: 0 },
        uSunUv: { value: new THREE.Vector2() },
        uSunOnScreen: { value: 0 },
        uSunDist: { value: 1 },
        uSunRadiusUv: { value: 0.001 },
        uSunColor: { value: new THREE.Color() },
        uSunViewDir: { value: new THREE.Vector3(0, 0, -1) },
        uFlare: { value: 1 },
        uLogFar: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setQuality(q: Quality): void {
    this.quality = q;
    this.atmoMat.uniforms.uSteps.value = q.atmoSteps;
    this.atmoMat.uniforms.uLightSteps.value = q.atmoLightSteps;
    this.resize();
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.width = Math.max(1, Math.floor(window.innerWidth * dpr));
    this.height = Math.max(1, Math.floor(window.innerHeight * dpr));

    this.sceneRT?.dispose();
    this.atmoRT?.dispose();
    this.bloomRTs.forEach((rt) => rt.dispose());

    const depthTexture = new THREE.DepthTexture(this.width, this.height, THREE.FloatType);
    depthTexture.format = THREE.DepthFormat;
    this.sceneRT = hdrTarget(this.width, this.height, {
      depthBuffer: true,
      depthTexture,
      samples: this.quality.msaa,
    });
    this.atmoRT = hdrTarget(this.width, this.height);
    this.bloomRTs = [];
    let w = this.width;
    let h = this.height;
    for (let i = 0; i < BLOOM_MIPS; i++) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      this.bloomRTs.push(hdrTarget(w, h));
    }
    (this.finalMat.uniforms.uResolution.value as THREE.Vector2).set(this.width, this.height);
  }

  get aspect(): number {
    return this.width / this.height;
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, frame: FrameParams): void {
    const r = this.renderer;
    const logFar = Math.log2(camera.far + 1);

    // 1. Scene.
    r.setRenderTarget(this.sceneRT);
    r.clear(true, true, false);
    r.render(scene, camera);

    // 2. Atmospheres.
    const au = this.atmoMat.uniforms;
    au.tColor.value = this.sceneRT.texture;
    au.tDepth.value = this.sceneRT.depthTexture;
    (au.uInvProj.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    au.uLogFar.value = logFar;
    const n = Math.min(frame.atmospheres.length, MAX_ATMOSPHERES);
    au.uCount.value = n;
    (au.uSunColor.value as THREE.Color).copy(frame.sunColor);
    for (let i = 0; i < n; i++) {
      const a = frame.atmospheres[i];
      au.uCenter.value[i].copy(a.center);
      au.uRp.value[i] = a.planetRadius;
      au.uRa.value[i] = a.topRadius;
      au.uBetaR.value[i].copy(a.betaR);
      au.uBetaM.value[i] = a.betaM;
      au.uMieColor.value[i].copy(a.mieColor);
      au.uHR.value[i] = a.scaleHeightR;
      au.uHM.value[i] = a.scaleHeightM;
      au.uG.value[i] = a.g;
      au.uSunDir.value[i].copy(a.sunDir);
    }
    this.quad.material = this.atmoMat;
    r.setRenderTarget(this.atmoRT);
    this.quad.render(r);

    // 3. Bloom: downsample chain, then tent upsample accumulating back up.
    this.quad.material = this.downMat;
    let src: THREE.Texture = this.atmoRT.texture;
    let srcW = this.width;
    let srcH = this.height;
    for (let i = 0; i < BLOOM_MIPS; i++) {
      this.downMat.uniforms.tSrc.value = src;
      (this.downMat.uniforms.uTexel.value as THREE.Vector2).set(1 / srcW, 1 / srcH);
      this.downMat.uniforms.uFirst.value = i === 0 ? 1 : 0;
      r.setRenderTarget(this.bloomRTs[i]);
      this.quad.render(r);
      src = this.bloomRTs[i].texture;
      srcW = this.bloomRTs[i].width;
      srcH = this.bloomRTs[i].height;
    }
    this.quad.material = this.upMat;
    for (let i = BLOOM_MIPS - 1; i > 0; i--) {
      const s = this.bloomRTs[i];
      this.upMat.uniforms.tSrc.value = s.texture;
      (this.upMat.uniforms.uTexel.value as THREE.Vector2).set(1 / s.width, 1 / s.height);
      this.upMat.uniforms.uRadius.value = 1.0;
      r.setRenderTarget(this.bloomRTs[i - 1]);
      this.quad.render(r);
    }

    // 4. Composite to screen.
    const fu = this.finalMat.uniforms;
    fu.tHdr.value = this.atmoRT.texture;
    fu.tBloom.value = this.bloomRTs[0].texture;
    fu.tDepth.value = this.sceneRT.depthTexture;
    fu.uBloom.value = this.bloomStrength;
    fu.uExposure.value = this.exposure;
    fu.uTime.value = frame.time;
    fu.uWarp.value = frame.warp;
    fu.uLogFar.value = logFar;
    this.setupFlare(camera, frame);
    this.quad.material = this.finalMat;
    r.setRenderTarget(null);
    this.quad.render(r);
  }

  private readonly _v = new THREE.Vector3();

  private setupFlare(camera: THREE.PerspectiveCamera, frame: FrameParams): void {
    const fu = this.finalMat.uniforms;
    fu.uSunOnScreen.value = 0;
    if (!frame.sunViewPos) return;
    const sv = frame.sunViewPos;
    if (sv.z >= 0) return;
    const dist = sv.length();
    this._v.copy(sv).applyMatrix4(camera.projectionMatrix);
    const uv = fu.uSunUv.value as THREE.Vector2;
    uv.set(this._v.x * 0.5 + 0.5, this._v.y * 0.5 + 0.5);
    const edge = Math.min(uv.x, uv.y, 1 - uv.x, 1 - uv.y);
    fu.uSunOnScreen.value = THREE.MathUtils.smoothstep(edge, -0.05, 0.1);
    fu.uSunDist.value = dist - frame.sunRadius;
    // Angular radius → uv radius (vertical).
    const angular = Math.asin(Math.min(1, frame.sunRadius / dist));
    fu.uSunRadiusUv.value = Math.max(0.002, angular / THREE.MathUtils.degToRad(camera.fov));
    (fu.uSunViewDir.value as THREE.Vector3).copy(sv).normalize();
    (fu.uSunColor.value as THREE.Color).copy(frame.sunColor);
  }
}
