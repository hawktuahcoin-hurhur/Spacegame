/**
 * Shared GLSL noise library.
 * simplex3 is the classic Ashima Arts / Stefan Gustavson implementation (MIT).
 */
export const NOISE_GLSL = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float simplex3(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// Fractal Brownian motion, normalised to roughly [-1, 1].
float fbm(vec3 p, int octaves) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 10; i++) {
    if (i >= octaves) break;
    sum += amp * simplex3(p);
    norm += amp;
    p = p * 2.03 + vec3(1.7, 9.2, 4.1);
    amp *= 0.5;
  }
  return sum / norm;
}

// Ridged multifractal in [0, 1]: sharp mountain crests.
float ridged(vec3 p, int octaves) {
  float sum = 0.0, amp = 0.5, norm = 0.0, prev = 1.0;
  for (int i = 0; i < 10; i++) {
    if (i >= octaves) break;
    float n = 1.0 - abs(simplex3(p));
    n *= n;
    sum += n * amp * prev;
    norm += amp;
    prev = n;
    p = p * 2.1 + vec3(3.1, 7.7, 1.3);
    amp *= 0.5;
  }
  return sum / norm;
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

// Worley: x = F1 distance, y = F2 distance, z = cell hash of F1.
vec3 worley(vec3 p) {
  vec3 cell = floor(p);
  vec3 f = fract(p);
  float d1 = 8.0, d2 = 8.0, id = 0.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 r = o + hash33(cell + o) - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = hash13(cell + o + 17.0); }
    else if (d < d2) { d2 = d; }
  }
  return vec3(sqrt(d1), sqrt(d2), id);
}

float valueNoise1(float x) {
  float i = floor(x);
  float f = fract(x);
  return mix(hash11(i), hash11(i + 1.0), f * f * (3.0 - 2.0 * f));
}

float fbm1(float x, int octaves) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * valueNoise1(x);
    norm += amp;
    x *= 2.13;
    amp *= 0.5;
  }
  return sum / norm;
}
`;

/** Numerically stable ray-sphere intersection helpers. */
export const SPHERE_GLSL = /* glsl */ `
// Returns (tNear, tFar); tNear > tFar means miss. Stable for distant spheres.
vec2 raySphere(vec3 ro, vec3 rd, vec3 center, float radius) {
  vec3 oc = ro - center;
  float b = dot(oc, rd);
  vec3 h = oc - b * rd;
  float disc = radius * radius - dot(h, h);
  if (disc < 0.0) return vec2(1e30, -1e30);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}
`;

/** Shared ring density so planets can sample the shadow their rings cast. */
export const RING_GLSL = /* glsl */ `
float ringDensity(float x, float seed) {
  // x: 0 at inner edge, 1 at outer edge.
  if (x < 0.0 || x > 1.0) return 0.0;
  float n = fbm1(x * 22.0 + seed, 6);
  float fine = fbm1(x * 160.0 + seed * 3.1, 4);
  float d = smoothstep(0.25, 0.75, n) * 0.75 + fine * 0.35;
  // Two seeded gaps (Cassini-style divisions).
  float g1 = 0.35 + hash11(seed) * 0.4;
  float g2 = 0.15 + hash11(seed + 7.0) * 0.7;
  d *= smoothstep(0.0, 0.025, abs(x - g1));
  d *= mix(1.0, smoothstep(0.0, 0.012, abs(x - g2)), 0.8);
  d *= smoothstep(0.0, 0.05, x) * smoothstep(1.0, 0.92, x);
  return clamp(d, 0.0, 1.0);
}
`;
