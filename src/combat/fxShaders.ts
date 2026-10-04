/**
 * Shaders for combat effects. Everything is camera-relative (the camera sits
 * at the origin) and writes logarithmic depth like the rest of the scene.
 */

/** Instanced camera-facing streaks: projectiles, beams, sparks, trails, arcs. */
export const streakVertex = /* glsl */ `
#include <common>
attribute vec3 aStart;
attribute vec3 aDir;
attribute vec2 aSize; // length, width
attribute vec4 aColor; // rgb (HDR), alpha
uniform float uMinAngle;
varying vec2 vUv;
varying vec4 vColor;
#include <logdepthbuf_pars_vertex>
void main() {
  vec3 p = aStart + aDir * aSize.x * position.y;
  vec3 viewDir = normalize(p);
  vec3 side = cross(aDir, viewDir);
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
  // Never thinner than ~1.5 px: widen distant streaks and dim them to match.
  float dist = length(p);
  float w = max(aSize.y, dist * uMinAngle);
  p += side * w * position.x;
  vUv = vec2(position.x * 2.0, position.y);
  vColor = vec4(aColor.rgb, aColor.a * aSize.y / w);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}
`;

export const streakFragment = /* glsl */ `
uniform float uCore;
varying vec2 vUv;
varying vec4 vColor;
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  float across = 1.0 - abs(vUv.x);
  float glow = pow(across, 1.6);
  float core = smoothstep(1.0 - uCore, 1.0, across);
  // Bright head, fading tail.
  float along = smoothstep(0.0, 0.25, vUv.y) * (0.35 + 0.65 * vUv.y) * smoothstep(1.0, 0.92, vUv.y);
  float a = (glow * 0.6 + core * 1.4) * along * vColor.a;
  vec3 col = mix(vColor.rgb, vec3(1.0) * max(max(vColor.r, vColor.g), vColor.b), core * 0.6);
  gl_FragColor = vec4(col * a, a);
}
`;

/** Instanced billboards: glows, fireballs, shock rings and smoke. */
export const spriteVertex = /* glsl */ `
#include <common>
attribute vec3 aPos;
attribute vec4 aParams; // size, age 0..1, kind, seed
attribute vec4 aColor;
uniform float uMinAngle;
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vParams;
#include <logdepthbuf_pars_vertex>
void main() {
  vec4 mv = viewMatrix * vec4(aPos, 1.0);
  float dist = length(mv.xyz);
  float size = max(aParams.x, dist * uMinAngle * 2.0);
  mv.xy += position.xy * size;
  vUv = position.xy * 2.0;
  vColor = vec4(aColor.rgb, aColor.a * min(1.0, aParams.x / size));
  vParams = aParams.yzw;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

export const spriteFragment = /* glsl */ `
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vParams;
#include <logdepthbuf_pars_fragment>
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vUv);
  if (r > 1.0) discard;
  float age = vParams.x;
  float kind = vParams.y;
  float seed = vParams.z;
  float a;
  vec3 col = vColor.rgb;
  if (kind < 0.5) {
    // Soft glow.
    a = pow(1.0 - r, 2.2) + pow(1.0 - r, 8.0) * 2.0;
  } else if (kind < 1.5) {
    // Fireball: noisy, eroding as it ages, white-hot core cooling to embers.
    float ang = atan(vUv.y, vUv.x);
    float n = fbm(vec2(ang * 2.0 + seed * 17.0, r * 3.0 - age * 2.5) + seed * 9.0);
    float edge = 0.55 + 0.45 * n - age * 0.35;
    a = smoothstep(edge, edge - 0.35, r) * (1.0 - age * age);
    float heat = clamp(1.0 - r / max(edge, 0.05) - age * 0.8 + n * 0.3, 0.0, 1.0);
    col = mix(col * vec3(0.55, 0.22, 0.12), col * 2.2 + vec3(0.6), heat * heat);
  } else if (kind < 2.5) {
    // Shock ring.
    float ring = smoothstep(0.12, 0.0, abs(r - 0.82)) ;
    a = ring * (1.0 - age);
  } else {
    // Smoke / vapour (drawn with normal blending).
    float n = fbm(vUv * 1.6 + seed * 13.0 + age * 0.6);
    a = smoothstep(1.0, 0.25, r + n * 0.45 - 0.2) * (1.0 - age) * 0.8;
  }
  a *= vColor.a;
  if (kind > 2.5) gl_FragColor = vec4(col, a);
  else gl_FragColor = vec4(col * a, a);
}
`;

/** Shield bubble: arc-masked fresnel shell with a hex lattice and impact ripples. */
export const shieldVertex = /* glsl */ `
#include <common>
varying vec3 vLocal;
varying vec3 vNormal;
varying vec3 vView;
#include <logdepthbuf_pars_vertex>
void main() {
  vLocal = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vNormal = normalize(mat3(modelMatrix) * normal);
  vView = normalize(-wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

export const shieldFragment = /* glsl */ `
uniform vec3 uColor;
uniform float uHalfArc;
uniform float uFacing;
uniform float uFlux;
uniform float uTime;
uniform float uIntensity;
uniform vec4 uHits[6];
varying vec3 vLocal;
varying vec3 vNormal;
varying vec3 vView;
#include <logdepthbuf_pars_fragment>
const float PI = 3.14159265;
float wrapA(float a) { return mod(a + PI, 2.0 * PI) - PI; }
void main() {
  #include <logdepthbuf_fragment>
  vec3 dir = normalize(vLocal);
  float bearing = atan(-dir.x, -dir.z);
  float off = abs(wrapA(bearing - uFacing));
  float inside = uHalfArc >= PI - 0.01 ? 1.0 : smoothstep(uHalfArc + 0.01, uHalfArc - 0.04, off);
  if (inside <= 0.001) discard;
  float edge = uHalfArc >= PI - 0.01 ? 0.0 : smoothstep(0.1, 0.0, abs(off - uHalfArc + 0.03));
  float fres = pow(1.0 - abs(dot(normalize(vNormal), vView)), 2.5);
  // Hex-ish lattice from spherical coordinates.
  vec2 uv = vec2(bearing * 6.0, asin(clamp(dir.y, -1.0, 1.0)) * 7.0);
  vec2 g = abs(fract(uv + vec2(0.5 * floor(uv.y), 0.0)) - 0.5);
  float lattice = smoothstep(0.43, 0.5, max(g.x, g.y));
  float ripple = 0.0;
  for (int i = 0; i < 6; i++) {
    vec4 h = uHits[i];
    if (h.w <= 0.0 || h.w >= 1.0) continue;
    float d = acos(clamp(dot(dir, normalize(h.xyz)), -1.0, 1.0));
    float front = h.w * 1.2;
    ripple += smoothstep(0.12, 0.0, abs(d - front)) * (1.0 - h.w) * 1.6 + smoothstep(0.35, 0.0, d) * (1.0 - h.w) * (1.0 - h.w) * 2.0;
  }
  float shimmer = 0.85 + 0.15 * sin(uTime * 3.0 + bearing * 4.0 + dir.y * 6.0);
  float a = (fres * 0.9 + 0.06 + lattice * 0.12 * (0.4 + fres)) * shimmer + edge * 1.2 + ripple;
  a *= inside * uIntensity * (gl_FrontFacing ? 1.0 : 0.45);
  vec3 col = mix(uColor, vec3(1.0, 0.45, 0.5), smoothstep(0.6, 1.0, uFlux) * 0.6);
  col = mix(col, vec3(1.0), clamp(ripple * 0.4 + edge * 0.3, 0.0, 0.7));
  gl_FragColor = vec4(col * a, a);
}
`;
