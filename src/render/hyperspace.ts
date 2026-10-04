import * as THREE from 'three';
import { NOISE_GLSL } from './shaders/noise';
import { SpaceDust } from './spaceDust';

const LENGTH = 6000;
const RADIUS = 70;

const tunnelVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vLocal;
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const tunnelFragment = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec3 vLocal;
uniform float uTime;
uniform float uIntensity;
uniform float uExit;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uDest;
${NOISE_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  // Cylinder axis is local Y (CylinderGeometry), rotated to point down -Z.
  float depth = vLocal.y + ${(LENGTH / 2).toFixed(1)};
  float a = atan(vLocal.z, vLocal.x) + depth * 0.0007 + uTime * 0.45;
  float flow = depth * 0.0045 - uTime * 2.6;
  vec3 ring = vec3(cos(a), sin(a), 0.0);
  float n = fbm(ring * 1.4 + vec3(0.0, 0.0, flow), 5) * 0.5 + 0.5;
  float n2 = fbm(ring * 3.0 + vec3(0.0, 0.0, flow * 1.7 + 4.0), 4) * 0.5 + 0.5;
  // Thin electric filaments streaming past.
  float fil = pow(1.0 - abs(simplex3(vec3(cos(a) * 5.0, sin(a) * 5.0, flow * 0.35))), 14.0);
  vec3 col = mix(uColA, uColB, smoothstep(0.3, 0.75, n2)) * (0.15 + pow(n, 2.2) * 2.2);
  col += vec3(0.85, 0.9, 1.0) * fil * 1.6;
  // Far end glows with the destination star; near end fades so huge texels never fill the screen.
  float far = smoothstep(LENGTH_F * 0.35, LENGTH_F * 0.95, depth);
  col = mix(col, uDest * 4.0, far * (0.6 + 0.4 * uExit));
  col *= smoothstep(0.0, 260.0, depth);
  gl_FragColor = vec4(col * uIntensity, 1.0);
}
`.replace(/LENGTH_F/g, LENGTH.toFixed(1));

const glowFragment = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec2 vUv;
uniform vec3 uColor;
uniform float uIntensity;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vUv * 2.0 - 1.0);
  float g = exp(-r * r * 6.0) + exp(-r * 18.0) * 2.0;
  gl_FragColor = vec4(uColor * g * uIntensity, 1.0);
}
`;
const glowVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

/**
 * The witch-space tunnel shown during a hyperjump. It is its own scene,
 * rendered through the normal HDR pipeline (bloom + radial warp), and it
 * hides the next system's loading and surface baking.
 */
export class HyperspaceTunnel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(80, 1, 0.5, 20000);
  private readonly material: THREE.ShaderMaterial;
  private readonly glowMat: THREE.ShaderMaterial;
  private readonly glow: THREE.Mesh;
  private readonly dust: SpaceDust;
  private readonly destColor = new THREE.Color();

  constructor() {
    this.scene.background = new THREE.Color(0, 0, 0);
    this.material = new THREE.ShaderMaterial({
      vertexShader: tunnelVertex,
      fragmentShader: tunnelFragment,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uExit: { value: 0 },
        uColA: { value: new THREE.Color('#2a3cff') },
        uColB: { value: new THREE.Color('#b13cff') },
        uDest: { value: new THREE.Color(1, 1, 1) },
      },
    });
    const geo = new THREE.CylinderGeometry(RADIUS, RADIUS, LENGTH, 96, 1, true);
    const tunnel = new THREE.Mesh(geo, this.material);
    // Cylinder axis Y → -Z, with the near end just behind the camera.
    tunnel.rotation.x = -Math.PI / 2;
    tunnel.position.z = -LENGTH / 2 + 150;
    tunnel.frustumCulled = false;
    this.scene.add(tunnel);

    this.glowMat = new THREE.ShaderMaterial({
      vertexShader: glowVertex,
      fragmentShader: glowFragment,
      uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uIntensity: { value: 1 } },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.glowMat);
    this.glow.position.z = -LENGTH * 0.9;
    this.scene.add(this.glow);

    this.dust = new SpaceDust(4242);
    this.scene.add(this.dust.mesh);
  }

  /** Tint the tunnel for this jump: destination star colour, optional nebula hue. */
  configure(destStarColor: [number, number, number], nebulaColor: [number, number, number] | null): void {
    this.destColor.setRGB(...destStarColor);
    (this.material.uniforms.uDest.value as THREE.Color).copy(this.destColor);
    (this.glowMat.uniforms.uColor.value as THREE.Color).copy(this.destColor).multiplyScalar(6);
    const a = this.material.uniforms.uColA.value as THREE.Color;
    const b = this.material.uniforms.uColB.value as THREE.Color;
    a.set('#2a3cff').lerp(this.destColor, 0.25);
    b.set('#b13cff');
    if (nebulaColor) b.setRGB(...nebulaColor).multiplyScalar(1.4);
  }

  /**
   * @param t seconds since entering the tunnel
   * @param exit 0..1 as the exit approaches (destination glow swells)
   */
  update(dt: number, t: number, exit: number, aspect: number): void {
    const u = this.material.uniforms;
    u.uTime.value = t;
    u.uExit.value = exit;
    u.uIntensity.value = THREE.MathUtils.smoothstep(t, 0, 0.8) * (1 + exit * 1.5);
    const glowScale = 400 + exit * exit * 9000;
    this.glow.scale.set(glowScale, glowScale, 1);
    this.glowMat.uniforms.uIntensity.value = 0.3 + exit * exit * 3;
    this.camera.aspect = aspect;
    this.camera.fov = 95 - THREE.MathUtils.smoothstep(t, 0, 1.2) * 20 + exit * 25;
    this.camera.rotation.set(Math.sin(t * 0.7) * 0.03, Math.cos(t * 0.53) * 0.03, t * 0.35);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.dust.update(dt, new THREE.Vector3(0, 0, -1), 4e6, 1);
  }
}
