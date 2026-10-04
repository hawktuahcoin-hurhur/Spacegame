import { NOISE_GLSL, RING_GLSL, SPHERE_GLSL } from './noise';

/**
 * Analytic (ray-traced) planet. Drawn on a back-faced proxy cube; every pixel
 * intersects a perfect sphere, so silhouettes are exact at any distance and
 * depth is written explicitly (log depth).
 */
export const proxyVertex = /* glsl */ `
varying vec3 vViewPos;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

export const LOG_DEPTH_WRITE = /* glsl */ `
uniform float logDepthBufFC;
void writeDepth(vec3 viewPos) {
  gl_FragDepth = log2(1.0 + max(-viewPos.z, 1e-6)) * logDepthBufFC * 0.5;
}
`;

export const planetFragment = /* glsl */ `
precision highp float;
varying vec3 vViewPos;

uniform vec3 uCenter;
uniform float uRadius;
uniform float uCloudRadius;
uniform mat3 uObjFromView;
uniform mat3 uObjFromViewCloud;
uniform mat3 uViewFromObj;
uniform samplerCube uAlbedo;
uniform samplerCube uNormalMap;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSeaLevel;
uniform int uOceanKind;   // 0 none, 1 water, 2 lava, 3 ice, 4 acid, 5 glow
uniform int uGas;
uniform float uHasClouds;
uniform vec3 uCloudColor;
uniform float uHasAtmo;
uniform vec3 uTau;
uniform vec3 uSkyColor;
uniform float uHasRings;
uniform float uRingInner;
uniform float uRingOuter;
uniform vec3 uRingNormal;
uniform float uRingSeed;
uniform float uRingOpacity;
uniform float uDetail;
uniform float uTime;
uniform float uFlow;
uniform float uBandFreq;

${NOISE_GLSL}
${SPHERE_GLSL}
${RING_GLSL}
${LOG_DEPTH_WRITE}

vec3 sunTransmittance(float mu) {
  if (uHasAtmo < 0.5) return vec3(1.0);
  float m = clamp(mu, 0.0, 1.0);
  float airmass = 1.0 / (m + 0.15 * pow(max(93.885 - degrees(acos(m)), 0.01), -1.253));
  return exp(-uTau * min(airmass, 38.0));
}

float ringShadow(vec3 p) {
  if (uHasRings < 0.5) return 1.0;
  float denom = dot(uSunDir, uRingNormal);
  if (abs(denom) < 1e-4) return 1.0;
  float t = dot(uCenter - p, uRingNormal) / denom;
  if (t <= 0.0) return 1.0;
  float r = length(p + uSunDir * t - uCenter);
  float x = (r - uRingInner) / (uRingOuter - uRingInner);
  return 1.0 - ringDensity(x, uRingSeed) * uRingOpacity * 0.9;
}

vec3 rotY(vec3 d, float a) {
  float c = cos(a), s = sin(a);
  return vec3(c * d.x + s * d.z, d.y, -s * d.x + c * d.z);
}

vec4 sampleAlbedo(vec3 dObj) {
  if (uGas == 0) return textureCube(uAlbedo, dObj);
  // Differential band flow, cross-faded between two phases so distortion stays bounded.
  float t = uTime * 0.004;
  float p1 = fract(t), p2 = fract(t + 0.5);
  float shear = sin(dObj.y * uBandFreq * 1.7) * 0.6 + sin(dObj.y * 23.0) * 0.25;
  vec4 a = textureCube(uAlbedo, rotY(dObj, (p1 - 0.5) * shear * uFlow));
  vec4 b = textureCube(uAlbedo, rotY(dObj, (p2 - 0.5) * shear * uFlow));
  return mix(a, b, abs(p1 * 2.0 - 1.0));
}

vec3 shadeSurface(vec3 p, vec3 rd) {
  vec3 nS = normalize(p - uCenter);
  vec3 dObj = uObjFromView * nS;
  vec4 alb = sampleAlbedo(dObj);
  vec4 nm = textureCube(uNormalMap, dObj);
  vec3 albedo = alb.rgb;
  float h = alb.a;
  vec3 n = normalize(uViewFromObj * normalize(nm.xyz * 2.0 - 1.0));

  bool liquid = uSeaLevel > 0.0 && h <= uSeaLevel + 0.0015 && uOceanKind != 3;

  // Close-range detail: extra octaves of albedo variation and micro normals.
  if (uDetail > 0.001) {
    vec3 q = dObj * (uRadius / 700.0);
    float d1 = simplex3(q);
    float d2 = simplex3(q * 4.1 + 7.0);
    float dn = d1 * 0.65 + d2 * 0.35;
    if (!liquid) {
      albedo *= 1.0 + dn * 0.22 * uDetail;
      vec3 g = vec3(simplex3(q * 2.0 + 1.3), simplex3(q * 2.0 + 5.7), simplex3(q * 2.0 + 9.1));
      n = normalize(n + (uViewFromObj * (g - dObj * dot(g, dObj))) * 0.12 * uDetail);
    }
  }

  vec3 V = -rd;
  vec3 L = uSunDir;
  float muS = dot(nS, L);
  vec3 sunT = sunTransmittance(muS);
  float geo = smoothstep(-0.08, 0.06, muS);
  float shadow = geo * ringShadow(p);
  if (uHasClouds > 0.5) {
    float cs = textureCube(uNormalMap, uObjFromViewCloud * normalize(nS + L * 0.012)).a;
    shadow *= 1.0 - cs * 0.55;
  }

  vec3 col;
  if (liquid && uOceanKind == 2) {
    // Lava: hotter with depth, churning, with dark cooled crust rafts floating on top.
    float depth = smoothstep(0.0, 0.08, (uSeaLevel - h) / max(uSeaLevel, 0.01));
    float flick = 0.7 + 0.3 * simplex3(dObj * 40.0 + vec3(0.0, uTime * 0.03, 0.0));
    float crust = smoothstep(0.15, 0.55, simplex3(dObj * 90.0 + vec3(uTime * 0.01, 0.0, 0.0)) * 0.6 + simplex3(dObj * 260.0) * 0.4);
    float heat = mix(0.35, 1.0, depth) * flick * (1.0 - crust * 0.85);
    col = albedo * (0.4 + 4.5 * heat * heat);
    // The crust is lit like rock.
    col += albedo * 0.08 * uSunColor * max(dot(nS, L), 0.0) * crust;
  } else {
    vec3 nL = liquid ? nS : n;
    if (liquid && uDetail > 0.001) {
      vec3 w = vec3(simplex3(dObj * uRadius / 90.0 + uTime * 0.08), simplex3(dObj * uRadius / 90.0 + 3.0 - uTime * 0.07), 0.0);
      nL = normalize(nS + (uViewFromObj * (w - dObj * dot(w, dObj))) * 0.035 * uDetail);
    }
    float NdotL = dot(nL, L);
    float diff = max((NdotL + 0.08) / 1.08, 0.0);
    col = albedo * uSunColor * sunT * diff * shadow;
    // Sky ambient (soft, from the atmosphere) + a whisper of starlight.
    col += albedo * uSkyColor * smoothstep(-0.25, 0.35, muS) * 0.35 + albedo * 0.0025;

    if (liquid && (uOceanKind == 1 || uOceanKind == 4 || uOceanKind == 5)) {
      vec3 H = normalize(L + V);
      float nh = max(dot(nL, H), 0.0);
      float spec = pow(nh, 900.0) * 1.6 + pow(nh, 90.0) * 0.05;
      float fres = 0.02 + 0.98 * pow(1.0 - max(dot(nL, V), 0.0), 5.0);
      col += uSunColor * sunT * spec * shadow;
      col += uSkyColor * fres * 0.6 * smoothstep(-0.15, 0.3, muS);
    }
    if (uOceanKind == 3 && h <= uSeaLevel + 0.004) {
      // Frozen seas get a soft sheen.
      vec3 H = normalize(L + V);
      col += uSunColor * sunT * pow(max(dot(n, H), 0.0), 40.0) * 0.25 * shadow;
    }
  }

  // Lava glow bleeding into low-lying cracks, visible on the night side.
  if (uOceanKind == 2 && !liquid) {
    float crack = smoothstep(uSeaLevel + 0.04, uSeaLevel + 0.002, h);
    col += vec3(1.0, 0.3, 0.06) * crack * 1.4;
  }
  // Bioluminescent seas glow at night.
  if (uOceanKind == 5 && liquid) {
    float night = 1.0 - smoothstep(-0.15, 0.1, muS);
    float pulse = 0.6 + 0.4 * simplex3(dObj * 25.0 + uTime * 0.05);
    col += albedo * night * pulse * 2.0;
  }
  return col;
}

vec4 shadeCloud(vec3 p, bool fromBelow) {
  vec3 nS = normalize(p - uCenter);
  vec3 dObj = uObjFromViewCloud * nS;
  float c = textureCube(uNormalMap, dObj).a;
  if (uDetail > 0.001) {
    float b = simplex3(dObj * (uRadius / 1500.0)) * 0.5 + simplex3(dObj * (uRadius / 400.0)) * 0.25;
    c = clamp(c + b * 0.35 * uDetail * c, 0.0, 1.0);
  }
  float muS = dot(nS, uSunDir);
  vec3 sunT = sunTransmittance(muS + 0.05);
  float lit = smoothstep(-0.12, 0.2, muS) * ringShadow(p);
  vec3 col = uCloudColor * (uSunColor * sunT * (0.35 + 0.65 * max(muS, 0.0)) * lit + uSkyColor * 0.25 * lit + 0.002);
  if (fromBelow) col *= 0.55;
  return vec4(col, c * 0.96);
}

void main() {
  vec3 rd = normalize(vViewPos);
  vec2 hc = raySphere(vec3(0.0), rd, uCenter, uCloudRadius);
  if (hc.x > hc.y || hc.y < 0.0) discard;
  vec2 hs = raySphere(vec3(0.0), rd, uCenter, uRadius);
  bool hitSurf = hs.x <= hs.y && hs.y > 0.0;

  vec4 result = vec4(0.0);
  float tDepth = 0.0;
  if (hitSurf) {
    float t = max(hs.x, 0.0);
    result = vec4(shadeSurface(rd * t, rd), 1.0);
    tDepth = t;
  }
  if (uHasClouds > 0.5) {
    bool inside = length(uCenter) < uCloudRadius;
    float tc = -1.0;
    if (!inside) tc = hc.x;
    else if (!hitSurf) tc = hc.y;
    if (tc > 0.0) {
      vec4 cl = shadeCloud(rd * tc, inside);
      result = vec4(cl.rgb * cl.a + result.rgb * (1.0 - cl.a), cl.a + result.a * (1.0 - cl.a));
      if (!hitSurf) tDepth = tc;
    }
  }
  if (result.a < 0.004) discard;
  writeDepth(rd * tDepth);
  gl_FragColor = result;
}
`;

export const starFragment = /* glsl */ `
precision highp float;
varying vec3 vViewPos;
uniform vec3 uCenter;
uniform float uRadius;
uniform mat3 uObjFromView;
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;

${NOISE_GLSL}
${SPHERE_GLSL}
${LOG_DEPTH_WRITE}

void main() {
  vec3 rd = normalize(vViewPos);
  vec2 hs = raySphere(vec3(0.0), rd, uCenter, uRadius);
  if (hs.x > hs.y || hs.y < 0.0) discard;
  float t = max(hs.x, 0.0);
  vec3 p = rd * t;
  vec3 nS = normalize(p - uCenter);
  vec3 d = uObjFromView * nS;
  float mu = clamp(dot(nS, -rd), 0.0, 1.0);
  float limb = 1.0 - 0.55 * (1.0 - mu) - 0.25 * pow(1.0 - mu, 2.0);
  vec3 w = worley(d * 55.0 + vec3(0.0, uTime * 0.01, 0.0));
  float gran = smoothstep(0.0, 0.6, w.y - w.x);
  float large = fbm(d * 4.0 + uTime * 0.003, 4) * 0.5 + 0.5;
  float spots = smoothstep(0.66, 0.78, fbm(d * 2.5 + 11.0 + uTime * 0.001, 5) * 0.5 + 0.5);
  vec3 col = uColor * uIntensity * limb * (0.72 + 0.28 * gran) * (0.85 + 0.3 * large) * (1.0 - spots * 0.75);
  // Warmer chromosphere at the limb.
  col *= mix(vec3(1.0), vec3(1.25, 0.8, 0.55), pow(1.0 - mu, 3.0));
  writeDepth(p);
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Camera-facing corona around the star (additive, HDR). */
export const coronaVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv * 2.0 - 1.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

export const coronaFragment = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec2 vUv;
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
uniform float uExtent; // quad half-size in star radii
${NOISE_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vUv) * uExtent;
  if (r < 0.98) discard;
  float a = atan(vUv.y, vUv.x);
  float streamers = 0.55 + 0.45 * fbm(vec3(cos(a) * 3.0, sin(a) * 3.0, uTime * 0.02 + r * 0.15), 4);
  float glow = pow(1.0 / r, 3.0) * streamers + 0.25 * pow(1.0 / r, 1.6);
  glow *= smoothstep(uExtent, uExtent * 0.55, r);
  gl_FragColor = vec4(uColor * glow * uIntensity, 1.0);
}
`;

export const ringVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vLocal;
varying vec3 vViewPos;
void main() {
  vLocal = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

export const ringFragment = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec3 vLocal;
varying vec3 vViewPos;
uniform float uInner;
uniform float uOuter;
uniform float uSeed;
uniform float uOpacity;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uCenter;
uniform float uPlanetRadius;
uniform vec3 uNormal;
${NOISE_GLSL}
${SPHERE_GLSL}
${RING_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vLocal.xz);
  float x = (r - uInner) / (uOuter - uInner);
  float dens = ringDensity(x, uSeed);
  if (dens < 0.01) discard;
  vec3 col = mix(uColorA, uColorB, fbm1(x * 9.0 + uSeed * 0.3, 4));
  // Planet shadow on the rings.
  vec2 hp = raySphere(vViewPos, uSunDir, uCenter, uPlanetRadius);
  float shadow = (hp.x <= hp.y && hp.y > 0.0) ? 0.04 : 1.0;
  vec3 V = normalize(-vViewPos);
  float sunSide = dot(uNormal, uSunDir);
  float viewSide = dot(uNormal, V);
  // Lit face vs back-lit (light diffusing through the ring particles).
  // Multiple scattering between ring particles keeps rings bright even at grazing sun angles.
  float lit = sunSide * viewSide > 0.0 ? 0.35 + 0.65 * sqrt(abs(sunSide)) : (1.0 - dens) * 0.5 * sqrt(abs(sunSide)) + 0.18;
  float forward = pow(max(dot(-V, uSunDir), 0.0), 8.0) * (1.0 - dens) * 1.5;
  vec3 c = col * uSunColor * (lit + forward) * shadow + col * 0.003;
  float a = dens * uOpacity;
  gl_FragColor = vec4(c * a, a);
}
`;
