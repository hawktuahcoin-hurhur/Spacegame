import { NOISE_GLSL } from './noise';

/** Procedural nebula/galaxy skybox, baked once per system into a cube map. */
export const skyBakeFragment = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform vec3 uSeed;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
uniform vec3 uGalaxyNormal;
uniform float uDensity;
${NOISE_GLSL}

vec3 warp(vec3 p) {
  return vec3(fbm(p + vec3(1.7, 9.2, 3.4), 5), fbm(p + vec3(8.3, 2.8, 5.1), 5), fbm(p + vec3(4.1, 6.6, 0.7), 5));
}

void main() {
  vec3 d = normalize(vDir);
  float gl = dot(d, uGalaxyNormal);
  float band = exp(-gl * gl * 14.0);
  vec3 p = d * 1.8 + uSeed;
  vec3 w = warp(p);
  float n = fbm(p + w * 1.6, 8) * 0.5 + 0.5;
  float n2 = fbm(d * 3.5 + uSeed * 1.3 + w, 6) * 0.5 + 0.5;
  float neb = pow(smoothstep(0.38, 1.0, n), 2.2) * (0.25 + band * 1.1);
  vec3 col = mix(uColA, uColB, smoothstep(0.3, 0.7, n2)) * neb * uDensity;
  col += uColC * pow(smoothstep(0.55, 0.95, n * n2 * 1.7), 3.0) * 0.8 * uDensity;
  // Dark dust lanes across the galactic band.
  float dust = smoothstep(0.42, 0.72, fbm(d * 5.5 + uSeed * 2.0 + w * 0.6, 7) * 0.5 + 0.5) * band;
  // Unresolved starlight of the galactic disc.
  float milky = band * (0.5 + 0.7 * (fbm(d * 10.0 + uSeed, 5) * 0.5 + 0.5));
  col += vec3(0.75, 0.75, 0.9) * milky * 0.035;
  col *= 1.0 - dust * 0.85;
  // Dense faint stars, more of them in the band.
  for (int layer = 0; layer < 2; layer++) {
    float scale = layer == 0 ? 380.0 : 900.0;
    vec3 g = d * scale + float(layer) * 31.0;
    vec3 cell = floor(g);
    float h = hash13(cell);
    float thresh = layer == 0 ? 0.985 - band * 0.01 : 0.95 - band * 0.05;
    if (h > thresh) {
      vec3 sp = cell + hash33(cell);
      float dist = length(g - sp);
      float b = (h - thresh) / (1.0 - thresh);
      vec3 tint = mix(vec3(1.0, 0.8, 0.6), vec3(0.7, 0.8, 1.0), hash13(cell + 5.0));
      col += tint * smoothstep(0.6, 0.0, dist) * b * (layer == 0 ? 0.35 : 0.12) * (1.0 - dust * 0.7);
    }
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Bright foreground stars as HDR points, pinned behind everything. */
export const starPointsVertex = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
attribute float aPhase;
uniform float uTime;
uniform float uPixelRatio;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w * 0.9999999;
  float tw = 0.85 + 0.15 * sin(uTime * (1.5 + aPhase) + aPhase * 40.0);
  vColor = aColor * tw;
  gl_PointSize = aSize * uPixelRatio;
}
`;

export const starPointsFragment = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = dot(c, c);
  float core = exp(-r * 6.0);
  float cross = (exp(-abs(c.x) * 18.0) + exp(-abs(c.y) * 18.0)) * exp(-r * 2.0) * 0.25;
  float a = core + cross;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * a, 1.0);
}
`;

/** Asteroid-belt dust seen from afar. */
export const dustVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aSize;
uniform float uPixelRatio;
uniform float uScale;
varying float vFade;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = -mv.z;
  float raw = aSize * uScale / dist;
  gl_PointSize = clamp(raw, 1.0, 3.0) * uPixelRatio;
  // Sub-pixel motes fade out instead of piling up into a solid line.
  vFade = smoothstep(uScale * 0.002, uScale * 0.02, dist) * clamp(raw * raw, 0.0, 1.0);
  #include <logdepthbuf_vertex>
}
`;

export const dustFragment = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform vec3 uSunColor;
varying float vFade;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float a = (1.0 - dot(c, c)) * vFade;
  if (a <= 0.0) discard;
  gl_FragColor = vec4(uColor * uSunColor * a * 0.35, a * 0.35);
}
`;

/** Space dust / supercruise streaks around the camera. */
export const streakVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aOffset;
attribute float aEnd;
uniform vec3 uTravel;
uniform vec3 uVelDir;
uniform float uLength;
uniform float uBox;
varying float vAlpha;
varying float vEnd;
void main() {
  vec3 p = mod(aOffset - uTravel + uBox * 0.5, uBox) - uBox * 0.5;
  p += uVelDir * uLength * aEnd; // tail trails back along previous positions
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = length(p) / (uBox * 0.5);
  vAlpha = smoothstep(1.0, 0.6, d) * smoothstep(0.0, 0.08, d);
  vEnd = aEnd;
  #include <logdepthbuf_vertex>
}
`;

export const streakFragment = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uIntensity;
varying float vAlpha;
varying float vEnd;
void main() {
  #include <logdepthbuf_fragment>
  float a = vAlpha * (1.0 - vEnd) * uIntensity;
  gl_FragColor = vec4(uColor * a, 1.0);
}
`;

export const skyBakeVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
