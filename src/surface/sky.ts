import * as THREE from 'three';
import type { SurfaceProfile } from './profile';

const vertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const fragment = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uDay;
uniform float uStars;
uniform float uClouds;
uniform vec3 uCloudColor;
uniform float uTime;
uniform float uHaze;
varying vec3 vDir;
float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
  float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
  float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}
void main() {
  #include <logdepthbuf_fragment>
  vec3 d = normalize(vDir);
  float up = max(d.y, 0.0);
  float sunUp = uSunDir.y;
  // Gradient: hazy horizon to deep zenith; dims through dusk into night.
  float t = pow(up, 0.45);
  vec3 sky = mix(uHorizon, uZenith, t);
  // Sunset: warm the horizon around the sun when it's low.
  float sunset = smoothstep(0.35, 0.0, abs(sunUp)) * smoothstep(-0.25, 0.05, sunUp);
  float towardSun = max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0);
  sky = mix(sky, vec3(1.0, 0.45, 0.2) * (0.6 + uHaze * 0.4), sunset * pow(towardSun, 3.0) * (1.0 - t) * 0.85);
  sky *= uDay;
  // Below the horizon fades to the ground haze colour.
  if (d.y < 0.0) sky = mix(sky, uHorizon * uDay * 0.6, smoothstep(0.0, -0.15, d.y));
  // Sun disc and glow.
  float cosA = dot(d, uSunDir);
  float disc = smoothstep(0.9993, 0.9997, cosA);
  float glow = pow(max(cosA, 0.0), 120.0) * 2.0 + pow(max(cosA, 0.0), 8.0) * 0.25 * uHaze;
  sky += uSunColor * (disc * 18.0 + glow) * smoothstep(-0.05, 0.02, sunUp);
  // Stars where the sky is dark.
  float dark = clamp(1.0 - max(uDay * 2.0, 0.0), 0.0, 1.0) * uStars + uStars * (1.0 - uHaze) * 0.3;
  if (dark > 0.01 && d.y > -0.05) {
    vec3 cell = floor(d * 380.0);
    float h = hash(cell);
    float star = step(0.9975, h) * (0.5 + 0.5 * hash(cell + 3.1));
    sky += vec3(star) * dark * 1.6;
  }
  // Clouds drifting overhead.
  if (uClouds > 0.01 && d.y > 0.02) {
    vec2 uv = d.xz / (d.y + 0.12) * 1.4 + vec2(uTime * 0.004, uTime * 0.0013);
    float c = fbm(uv);
    float cover = smoothstep(1.0 - uClouds * 0.9, 1.05 - uClouds * 0.6, c);
    vec3 cc = uCloudColor * (0.35 + 0.65 * uDay) + uSunColor * pow(max(cosA, 0.0), 6.0) * 0.5 * uDay;
    sky = mix(sky, cc * max(uDay, 0.05), cover * smoothstep(0.02, 0.25, d.y) * 0.9);
  }
  gl_FragColor = vec4(sky, 1.0);
}
`;

/** Sky dome that follows the camera. */
export class Sky {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;

  constructor(readonly profile: SurfaceProfile) {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        uZenith: { value: profile.sky.zenith.clone() },
        uHorizon: { value: profile.sky.horizon.clone() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uDay: { value: 1 },
        uStars: { value: profile.sky.stars },
        uClouds: { value: profile.sky.clouds },
        uCloudColor: { value: profile.sky.cloudColor.clone() },
        uTime: { value: 0 },
        uHaze: { value: Math.min(1, profile.sky.haze) },
      },
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(4500, 48, 24), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
  }

  /** Daylight factor 0 (night) .. 1 (day) for a sun elevation (sin). */
  static daylight(sunY: number): number {
    return THREE.MathUtils.smoothstep(sunY, -0.18, 0.12) * 0.97 + 0.03;
  }

  update(cam: THREE.Vector3, sunDir: THREE.Vector3, sunColor: THREE.Color, time: number): void {
    this.mesh.position.copy(cam);
    const u = this.mat.uniforms;
    (u.uSunDir.value as THREE.Vector3).copy(sunDir);
    (u.uSunColor.value as THREE.Color).copy(sunColor);
    u.uDay.value = this.profile.hasAtmosphere ? Sky.daylight(sunDir.y) : 0.03;
    u.uTime.value = time;
  }

  /** Fog/horizon colour for the current light. */
  fogColor(out: THREE.Color, sunY: number): THREE.Color {
    const day = this.profile.hasAtmosphere ? Sky.daylight(sunY) : 0.03;
    return out.copy(this.profile.sky.horizon).multiplyScalar(day * 0.85);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
