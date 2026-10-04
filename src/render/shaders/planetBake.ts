import { NOISE_GLSL } from './noise';

/**
 * Bakes a body's surface into two cube maps (rendered from the inside of a
 * sphere by a CubeCamera, so `textureCube(map, objectSpaceDir)` reads it back).
 *   pass 0 → rgb: albedo (sRGB target), a: height 0..1
 *   pass 1 → rgb: object-space normal (×0.5+0.5), a: cloud coverage
 */
export const planetBakeVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const planetBakeFragment = /* glsl */ `
precision highp float;
varying vec3 vDir;

uniform int uPass;
uniform int uGas;
uniform int uOct;
uniform vec3 uSeed;
uniform float uSeaLevel;
uniform vec3 uDeep, uShallow, uBeach, uLow, uLowAlt, uHigh, uPeak, uSnow;
uniform float uContinentFreq, uMountainAmp, uRidgeAmp, uCraterAmp, uWarp, uBump, uIceCap, uCloudCover;
uniform float uBandFreq, uBandTurb;
uniform vec4 uStorms[3];
uniform int uStormCount;
uniform float uEps;

${NOISE_GLSL}

vec3 rotateAxis(vec3 p, vec3 axis, float a) {
  return p * cos(a) + cross(axis, p) * sin(a) + axis * dot(axis, p) * (1.0 - cos(a));
}

vec3 warpOffset(vec3 p) {
  return vec3(fbm(p + vec3(1.7, 9.2, 3.4), 4), fbm(p + vec3(8.3, 2.8, 5.1), 4), fbm(p + vec3(4.1, 6.6, 0.7), 4));
}

float craterProfile(float x) {
  float bowl = x * x - 1.0;
  float rim = exp(-pow((x - 1.0) * 4.0, 2.0)) * 0.3;
  return mix(bowl, 0.0, smoothstep(0.85, 1.05, x)) + rim;
}

float craters(vec3 d) {
  float h = 0.0;
  float freq = 3.0;
  for (int o = 0; o < 3; o++) {
    vec3 p = d * freq + uSeed * 0.37 + float(o) * 11.0;
    vec3 cell = floor(p);
    vec3 f = fract(p);
    for (int z = -1; z <= 1; z++)
    for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec3 oc = vec3(float(x), float(y), float(z));
      vec3 rnd = hash33(cell + oc);
      if (rnd.z > 0.5) continue;
      float rad = mix(0.12, 0.45, rnd.y * rnd.y);
      float dist = length(oc + rnd - f) / rad;
      if (dist < 1.6) h += craterProfile(dist) * rad;
    }
    freq *= 2.4;
  }
  return h;
}

float heightAt(vec3 d) {
  vec3 p = d * uContinentFreq + uSeed;
  vec3 w = warpOffset(p * 0.8);
  p += w * uWarp;
  float h = 0.5 + fbm(p, uOct) * 0.8;
  float r = ridged(d * uContinentFreq * 2.6 + uSeed * 1.31 + w * 0.6, uOct - 1);
  float land = uSeaLevel > 0.0 ? smoothstep(uSeaLevel - 0.02, uSeaLevel + 0.15, h) : 1.0;
  h += (r - 0.45) * uRidgeAmp * 0.3 * mix(0.3, 1.0, land);
  h += fbm(d * uContinentFreq * 6.0 + uSeed * 2.0, uOct - 2) * uMountainAmp * 0.09;
  if (uCraterAmp > 0.0) h += craters(d) * uCraterAmp * 0.14;
  return h;
}

float iceAt(vec3 d) {
  if (uIceCap <= 0.0) return 0.0;
  float edge = 1.0 - uIceCap;
  return smoothstep(edge - 0.03, edge + 0.03, abs(d.y) + fbm(d * 6.0 + uSeed, 4) * 0.07);
}

vec3 rockyAlbedo(vec3 d, float h) {
  float sea = uSeaLevel;
  float lat = abs(d.y);
  float m = fbm(d * 2.2 + uSeed * 1.7 + 5.0, 5) * 0.5 + 0.5;
  float detail = fbm(d * 38.0 + uSeed, 4);
  vec3 col;
  if (sea > 0.0 && h < sea) {
    float depth = (sea - h) / max(sea, 0.01);
    col = mix(uShallow, uDeep, smoothstep(0.0, 0.16, depth));
  } else {
    float e = sea > 0.0 ? (h - sea) / max(1.0 - sea, 0.01) : clamp(h, 0.0, 1.0);
    // Wetter near the equator band, drier in the subtropics.
    float wet = m + detail * 0.12 - smoothstep(0.15, 0.35, lat) * 0.1 + smoothstep(0.45, 0.7, lat) * 0.1;
    col = mix(uLow, uLowAlt, smoothstep(0.38, 0.62, wet));
    if (sea > 0.0) col = mix(uBeach, col, smoothstep(0.004, 0.03, e));
    col = mix(col, uHigh, smoothstep(0.3, 0.52, e + detail * 0.06));
    col = mix(col, uPeak, smoothstep(0.52, 0.72, e + detail * 0.06));
    float snowLine = 0.85 - uIceCap * 0.6;
    col = mix(col, uSnow, smoothstep(snowLine, snowLine + 0.08, e + lat * 0.25 + detail * 0.05));
    col *= 0.86 + 0.28 * (detail * 0.5 + 0.5);
  }
  return mix(col, uSnow, iceAt(d));
}


vec3 band(int i) {
  if (i == 0) return uDeep;
  if (i == 1) return uShallow;
  if (i == 2) return uBeach;
  if (i == 3) return uLow;
  if (i == 4) return uLowAlt;
  return uHigh;
}

vec3 gasAlbedo(vec3 d) {
  vec3 p = d;
  float stormMask = 0.0;
  float stormRing = 0.0;
  for (int i = 0; i < 3; i++) {
    if (i >= uStormCount) break;
    vec3 c = uStorms[i].xyz;
    float s = uStorms[i].w;
    vec3 rel = p - c;
    // Oval storms: stretched along longitude.
    float dist = length(vec2(length(rel.xz) * 0.55, rel.y));
    float infl = exp(-dist * dist / (s * s));
    p = normalize(rotateAxis(p, c, infl * 4.0));
    stormMask = max(stormMask, smoothstep(s * 0.7, s * 0.25, dist));
    stormRing = max(stormRing, smoothstep(s * 0.9, s * 0.6, dist) - smoothstep(s * 0.6, s * 0.4, dist));
  }
  vec3 q = p + uWarp * 0.1 * uBandTurb * warpOffset(p * vec3(3.0, 10.0, 3.0) + uSeed);
  float lat = q.y;
  float b = lat * uBandFreq
    + fbm(vec3(lat * 3.0, 1.0, 2.0) + uSeed, 3) * 1.8
    + fbm(q * vec3(2.5, 16.0, 2.5) + uSeed, 5) * 0.4 * uBandTurb;
  float t = fract(b / 6.0) * 6.0;
  int i0 = int(floor(t));
  vec3 col = mix(band(i0), band(i0 == 5 ? 0 : i0 + 1), smoothstep(0.15, 0.85, fract(t)));
  col *= 0.9 + 0.2 * fbm(q * vec3(6.0, 30.0, 6.0) + uSeed, 4);
  col = mix(col, uPeak, stormRing * 0.7);
  col = mix(col, uSnow, stormMask * 0.85);
  col *= mix(1.0, 0.7, smoothstep(0.75, 0.98, abs(d.y)));
  return col;
}

float cloudsAt(vec3 d) {
  if (uCloudCover <= 0.0) return 0.0;
  // Cyclones: spiral the domain around a few storm centres.
  float eye = 0.0;
  for (int i = 0; i < 3; i++) {
    if (i >= uStormCount) break;
    vec3 c = uStorms[i].xyz;
    float s = uStorms[i].w;
    float dist = length(d - c);
    float infl = exp(-dist * dist / (s * s));
    d = normalize(rotateAxis(d, c, infl * 5.0 * sign(c.y)));
    eye = max(eye, smoothstep(s * 0.12, s * 0.04, dist));
  }
  vec3 p = d * 2.3 + uSeed * 0.71 + 40.0;
  vec3 w = warpOffset(p * 1.1);
  p += w * 1.1;
  float n = fbm(p, uOct) * 0.5 + 0.5;
  float detail = fbm(d * 20.0 + w * 2.0 + uSeed, 5) * 0.5 + 0.5;
  n = n * 0.78 + detail * 0.27;
  // Storm belts at mid latitudes, clearer subtropics.
  n += smoothstep(0.35, 0.6, abs(d.y)) * 0.06 - smoothstep(0.15, 0.3, abs(d.y)) * 0.05;
  return smoothstep(1.0 - uCloudCover - 0.02, 1.0 - uCloudCover + 0.22, n) * (1.0 - eye);
}

vec3 surfPoint(vec3 d) {
  float h = heightAt(d);
  if (uSeaLevel > 0.0) h = max(h, uSeaLevel + iceAt(d) * 0.004);
  return d * (1.0 + h * uBump * 0.03);
}

void main() {
  vec3 d = normalize(vDir);
  if (uPass == 0) {
    if (uGas == 1) {
      vec3 c = gasAlbedo(d);
      gl_FragColor = vec4(c, 0.5 + (dot(c, vec3(0.3, 0.5, 0.2)) - 0.4) * 0.3);
    } else {
      float h = heightAt(d);
      if (uSeaLevel > 0.0 && iceAt(d) > 0.5) h = max(h, uSeaLevel + 0.004);
      gl_FragColor = vec4(rockyAlbedo(d, h), clamp(h, 0.0, 1.0));
    }
  } else {
    vec3 n = d;
    if (uGas == 0) {
      vec3 t1 = normalize(cross(d, abs(d.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
      vec3 t2 = cross(d, t1);
      vec3 p0 = surfPoint(d);
      vec3 p1 = surfPoint(normalize(d + t1 * uEps));
      vec3 p2 = surfPoint(normalize(d + t2 * uEps));
      n = normalize(cross(p1 - p0, p2 - p0));
      if (dot(n, d) < 0.0) n = -n;
    }
    gl_FragColor = vec4(n * 0.5 + 0.5, cloudsAt(d));
  }
}
`;
