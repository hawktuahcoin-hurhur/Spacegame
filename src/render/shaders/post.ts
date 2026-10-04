import { SPHERE_GLSL } from './noise';

export const MAX_ATMOSPHERES = 4;

export const fullscreenVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const DEPTH_DECODE = /* glsl */ `
uniform float uLogFar; // log2(far + 1)
// Distance along a (normalised, view-space) ray from a logarithmic depth sample.
float rayDistance(float depth, vec3 rd) {
  if (depth >= 0.999999) return 1e30;
  float w = exp2(depth * uLogFar) - 1.0;
  return w / max(-rd.z, 1e-5);
}
`;

/**
 * Single-scattering atmosphere (Rayleigh + Mie) as a screen-space pass.
 * It reads the scene depth so haze correctly wraps planets, ships and stations,
 * and the sky turns blue (and hides stars) when you're inside an atmosphere.
 */
export const atmosphereFragment = /* glsl */ `
precision highp float;
#define N ${MAX_ATMOSPHERES}
#define PI 3.14159265359
varying vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform int uCount;
uniform int uSteps;
uniform int uLightSteps;
uniform vec3 uCenter[N];
uniform float uRp[N];
uniform float uRa[N];
uniform vec3 uBetaR[N];
uniform float uBetaM[N];
uniform vec3 uMieColor[N];
uniform float uHR[N];
uniform float uHM[N];
uniform float uG[N];
uniform vec3 uSunDir[N];
uniform vec3 uSunColor;
uniform float uSunIntensity;
${DEPTH_DECODE}
${SPHERE_GLSL}

float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

vec3 scatter(int i, vec3 rd, float tScene, float jitter, inout vec3 trans) {
  vec3 c = uCenter[i];
  vec2 ta = raySphere(vec3(0.0), rd, c, uRa[i]);
  if (ta.x > ta.y || ta.y < 0.0) return vec3(0.0);
  float t0 = max(ta.x, 0.0);
  float t1 = min(ta.y, tScene);
  vec2 tp = raySphere(vec3(0.0), rd, c, uRp[i]);
  if (tp.x <= tp.y && tp.x > 0.0) t1 = min(t1, tp.x);
  if (t1 <= t0) return vec3(0.0);

  vec3 L = uSunDir[i];
  float mu = dot(rd, L);
  float phaseR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float g = uG[i];
  float g2 = g * g;
  float phaseM = 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * mu, 1.5));

  float seg = (t1 - t0) / float(uSteps);
  float odR = 0.0, odM = 0.0;
  vec3 sumR = vec3(0.0), sumM = vec3(0.0);
  for (int s = 0; s < 32; s++) {
    if (s >= uSteps) break;
    float t = t0 + seg * (float(s) + jitter);
    vec3 p = rd * t - c;
    float h = length(p) - uRp[i];
    float dR = exp(-h / uHR[i]) * seg;
    float dM = exp(-h / uHM[i]) * seg;
    odR += dR;
    odM += dM;
    vec2 tlp = raySphere(p, L, vec3(0.0), uRp[i]);
    if (tlp.x <= tlp.y && tlp.y > 0.0) continue; // in the planet's shadow
    vec2 tl = raySphere(p, L, vec3(0.0), uRa[i]);
    float lseg = tl.y / float(uLightSteps);
    float lodR = 0.0, lodM = 0.0;
    for (int k = 0; k < 16; k++) {
      if (k >= uLightSteps) break;
      vec3 q = p + L * (lseg * (float(k) + 0.5));
      float lh = length(q) - uRp[i];
      lodR += exp(-lh / uHR[i]) * lseg;
      lodM += exp(-lh / uHM[i]) * lseg;
    }
    vec3 att = exp(-(uBetaR[i] * (odR + lodR) + uBetaM[i] * 1.1 * (odM + lodM)));
    sumR += att * dR;
    sumM += att * dM;
  }
  trans *= exp(-(uBetaR[i] * odR + uBetaM[i] * 1.1 * odM));
  return uSunColor * uSunIntensity * (sumR * uBetaR[i] * phaseR + sumM * uBetaM[i] * uMieColor[i] * phaseM);
}

void main() {
  vec4 src = texture2D(tColor, vUv);
  if (uCount == 0) { gl_FragColor = src; return; }
  vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
  vec3 rd = normalize(v.xyz / v.w);
  float tScene = rayDistance(texture2D(tDepth, vUv).r, rd);
  float jitter = ign(gl_FragCoord.xy);
  vec3 col = src.rgb;
  bool sky = tScene > 1e29;
  // Atmospheres are pre-sorted far → near on the CPU.
  for (int i = 0; i < N; i++) {
    if (i >= uCount) break;
    vec3 trans = vec3(1.0);
    vec3 ins = scatter(i, rd, tScene, jitter, trans);
    // A bright sky washes out the stars and nebulae behind it (eye adaptation).
    if (sky) trans /= 1.0 + dot(ins, vec3(0.3, 0.6, 0.1)) * 30.0;
    col = col * trans + ins;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Physically based bloom (Jimenez 2014): 13-tap downsample with Karis average on the first mip. */
export const bloomDownFragment = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform int uFirst;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 karis(vec3 a, vec3 b, vec3 c, vec3 d) {
  vec3 s = (a + b + c + d) * 0.25;
  return s / (1.0 + luma(s));
}
void main() {
  vec2 x = uTexel;
  vec3 a = texture2D(tSrc, vUv + x * vec2(-2.0, 2.0)).rgb;
  vec3 b = texture2D(tSrc, vUv + x * vec2(0.0, 2.0)).rgb;
  vec3 c = texture2D(tSrc, vUv + x * vec2(2.0, 2.0)).rgb;
  vec3 d = texture2D(tSrc, vUv + x * vec2(-2.0, 0.0)).rgb;
  vec3 e = texture2D(tSrc, vUv).rgb;
  vec3 f = texture2D(tSrc, vUv + x * vec2(2.0, 0.0)).rgb;
  vec3 g = texture2D(tSrc, vUv + x * vec2(-2.0, -2.0)).rgb;
  vec3 h = texture2D(tSrc, vUv + x * vec2(0.0, -2.0)).rgb;
  vec3 i = texture2D(tSrc, vUv + x * vec2(2.0, -2.0)).rgb;
  vec3 j = texture2D(tSrc, vUv + x * vec2(-1.0, 1.0)).rgb;
  vec3 k = texture2D(tSrc, vUv + x * vec2(1.0, 1.0)).rgb;
  vec3 l = texture2D(tSrc, vUv + x * vec2(-1.0, -1.0)).rgb;
  vec3 m = texture2D(tSrc, vUv + x * vec2(1.0, -1.0)).rgb;
  vec3 o;
  if (uFirst == 1) {
    o = karis(j, k, l, m) * 0.5
      + karis(a, b, d, e) * 0.125 + karis(b, c, e, f) * 0.125
      + karis(d, e, g, h) * 0.125 + karis(e, f, h, i) * 0.125;
  } else {
    o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  gl_FragColor = vec4(max(o, 0.0001), 1.0);
}
`;

export const bloomUpFragment = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uRadius;
void main() {
  vec2 x = uTexel * uRadius;
  vec3 a = texture2D(tSrc, vUv + vec2(-x.x, x.y)).rgb;
  vec3 b = texture2D(tSrc, vUv + vec2(0.0, x.y)).rgb;
  vec3 c = texture2D(tSrc, vUv + vec2(x.x, x.y)).rgb;
  vec3 d = texture2D(tSrc, vUv + vec2(-x.x, 0.0)).rgb;
  vec3 e = texture2D(tSrc, vUv).rgb;
  vec3 f = texture2D(tSrc, vUv + vec2(x.x, 0.0)).rgb;
  vec3 g = texture2D(tSrc, vUv + vec2(-x.x, -x.y)).rgb;
  vec3 h = texture2D(tSrc, vUv + vec2(0.0, -x.y)).rgb;
  vec3 i = texture2D(tSrc, vUv + vec2(x.x, -x.y)).rgb;
  vec3 o = (e * 4.0 + (b + d + f + h) * 2.0 + (a + c + g + i)) / 16.0;
  gl_FragColor = vec4(o, 1.0);
}
`;

/** Final composite: bloom, sun flare, supercruise distortion, vignette, ACES, sRGB, dither. */
export const finalFragment = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tHdr;
uniform sampler2D tBloom;
uniform sampler2D tDepth;
uniform vec2 uResolution;
uniform float uBloom;
uniform float uExposure;
uniform float uTime;
uniform float uWarp;
uniform vec2 uSunUv;
uniform float uSunOnScreen;
uniform float uSunDist;
uniform float uSunRadiusUv;
uniform vec3 uSunColor;
uniform float uFlare;
uniform vec3 uSunViewDir;
${DEPTH_DECODE}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 aces(vec3 x) {
  const mat3 inM = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 outM = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  x = inM * x;
  vec3 a = x * (x + 0.0245786) - 0.000090537;
  vec3 b = x * (0.983729 * x + 0.4329510) + 0.238081;
  return clamp(outM * (a / b), 0.0, 1.0);
}

vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

float sunVisibility() {
  if (uSunOnScreen <= 0.0) return 0.0;
  float vis = 0.0;
  for (int i = 0; i < 9; i++) {
    vec2 o = vec2(float(i % 3) - 1.0, float(i / 3) - 1.0) * uSunRadiusUv * 0.6;
    vec2 uv = uSunUv + o;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;
    float d = rayDistance(texture2D(tDepth, uv).r, uSunViewDir);
    vis += d > uSunDist * 0.995 ? 1.0 : 0.0;
  }
  return vis / 9.0 * uSunOnScreen;
}

vec3 flare(vec2 uv, float vis) {
  if (vis <= 0.0) return vec3(0.0);
  float aspect = uResolution.x / uResolution.y;
  vec2 d = (uv - uSunUv) * vec2(aspect, 1.0);
  float r = length(d);
  float ang = atan(d.y, d.x);
  vec3 c = vec3(0.0);
  // Glare and starburst.
  c += uSunColor * (exp(-r * 22.0) * 0.5 + exp(-r * 5.0) * 0.06);
  float spikes = pow(abs(cos(ang * 3.0 + 0.3)), 600.0) + pow(abs(cos(ang * 2.0 + 1.1)), 1500.0) * 0.5;
  c += uSunColor * spikes * exp(-r * 11.0) * 0.35;
  // Anamorphic streak.
  c += vec3(0.55, 0.7, 1.0) * exp(-abs(d.y) * 320.0) * exp(-abs(d.x) * 3.0) * 0.18;
  // Ghosts along the sun→centre axis.
  vec2 axis = vec2(0.5) - uSunUv;
  for (int i = 0; i < 5; i++) {
    float k = float(i);
    float pos = 0.45 + k * 0.42;
    float size = 0.025 + fract(k * 0.618) * 0.06;
    vec2 gc = uSunUv + axis * pos * 2.0;
    float gd = length((uv - gc) * vec2(aspect, 1.0));
    float ring = smoothstep(size, size * 0.85, gd) * (0.4 + 0.6 * smoothstep(size * 0.4, size, gd));
    vec3 tint = 0.5 + 0.5 * cos(6.2831 * (k * 0.21 + vec3(0.0, 0.33, 0.67)));
    c += tint * uSunColor * ring * 0.035;
  }
  // Halo ring.
  float halo = length((uv - 0.5) * vec2(aspect, 1.0) - (uSunUv - 0.5) * vec2(aspect, 1.0) * -0.4);
  c += uSunColor * smoothstep(0.03, 0.0, abs(halo - 0.45)) * 0.008;
  return c * vis * uFlare;
}

void main() {
  vec2 uv = vUv;
  vec3 col;
  if (uWarp > 0.001) {
    // Radial streaking and chromatic split during supercruise.
    vec2 dir = uv - 0.5;
    float str = uWarp * 0.035;
    col = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      float k = float(i) / 7.0;
      vec2 o = dir * str * k;
      col.r += texture2D(tHdr, uv - o * 1.15).r;
      col.g += texture2D(tHdr, uv - o).g;
      col.b += texture2D(tHdr, uv - o * 0.85).b;
    }
    col /= 8.0;
  } else {
    col = texture2D(tHdr, uv).rgb;
  }
  vec3 bloom = texture2D(tBloom, uv).rgb;
  col = mix(col, bloom, uBloom);
  col += flare(uv, sunVisibility());
  col *= uExposure;
  float aspect = uResolution.x / uResolution.y;
  float vig = smoothstep(1.25, 0.3, length((uv - 0.5) * vec2(aspect, 1.0)));
  col *= mix(1.0, vig, 0.5 + uWarp * 0.3);
  col = aces(col);
  col = toSRGB(col);
  float n = hash12(gl_FragCoord.xy + fract(uTime) * 100.0);
  col += (n - 0.5) * (1.5 / 255.0) + (n - 0.5) * 0.012;
  gl_FragColor = vec4(col, 1.0);
}
`;
