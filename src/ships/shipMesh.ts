import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Procedural low-poly flagship ("Kestrel" frigate). Phase 3 generalises this
 * into the part-grammar builder (SUPERPLAN §3.4). Faces -Z; ~24 m long.
 */

interface Section {
  z: number;
  w: number;
  h: number;
  y?: number;
}

/** Loft a closed hull through octagonal cross-sections, capped at both ends. */
function loft(sections: Section[], bevel = 0.32): THREE.BufferGeometry {
  const ring = (s: Section): THREE.Vector3[] => {
    const pts: THREE.Vector3[] = [];
    const b = bevel;
    const prof: [number, number][] = [
      [1, b],
      [b, 1],
      [-b, 1],
      [-1, b],
      [-1, -b],
      [-b, -1],
      [b, -1],
      [1, -b],
    ];
    for (const [x, y] of prof) pts.push(new THREE.Vector3(x * s.w * 0.5, y * s.h * 0.5 + (s.y ?? 0), s.z));
    return pts;
  };
  const rings = sections.map(ring);
  const pos: number[] = [];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let i = 0; i < rings.length - 1; i++) {
    const r0 = rings[i];
    const r1 = rings[i + 1];
    for (let j = 0; j < 8; j++) {
      const k = (j + 1) % 8;
      tri(r0[j], r1[j], r1[k]);
      tri(r0[j], r1[k], r0[k]);
    }
  }
  const capCenter = (r: THREE.Vector3[]) => r.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / r.length);
  const c0 = capCenter(rings[0]);
  const c1 = capCenter(rings[rings.length - 1]);
  for (let j = 0; j < 8; j++) {
    const k = (j + 1) % 8;
    tri(c0, rings[0][k], rings[0][j]);
    tri(c1, rings[rings.length - 1][j], rings[rings.length - 1][k]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function wingGeometry(span: number, rootChord: number, tipChord: number, sweep: number, thickness: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(span, sweep);
  shape.lineTo(span, sweep + tipChord);
  shape.lineTo(0, rootChord);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true, bevelThickness: thickness * 0.4, bevelSize: thickness * 0.5, bevelSegments: 1 });
  // Shape lies in XY; lay it flat in XZ with +Y as the shape's "chord" → +Z (aft).
  g.rotateX(Math.PI / 2);
  g.translate(0, thickness / 2, 0);
  return g;
}

export interface ShipVisual {
  root: THREE.Group;
  /** Child that banks/pitches visually; parented to root. */
  body: THREE.Group;
  engines: THREE.Mesh[];
  plumes: THREE.Mesh[];
  navLights: { mesh: THREE.Mesh; phase: number; strobe: boolean }[];
  update(dt: number, time: number, throttle: number, boost: boolean, supercruise: number, bank: number, pitchLean: number): void;
}

const plumeVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;
const plumeFragment = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec2 vUv;
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
void main() {
  #include <logdepthbuf_fragment>
  float along = vUv.y; // 1 at nozzle, 0 at tail
  float across = abs(vUv.x - 0.5) * 2.0;
  float core = pow(along, 2.2) * (1.0 - across * 0.6);
  float shock = 0.75 + 0.25 * sin(along * 38.0 - uTime * 50.0);
  float a = core * shock * uIntensity;
  vec3 col = mix(uColor, vec3(1.0), pow(along, 6.0) * 0.6);
  gl_FragColor = vec4(col * a, 1.0);
}
`;

export function createShip(accentHex = '#ff7a2f'): ShipVisual {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const hullMat = new THREE.MeshStandardMaterial({ color: '#b8c2cc', metalness: 0.55, roughness: 0.42, flatShading: true });
  const darkMat = new THREE.MeshStandardMaterial({ color: '#2b3038', metalness: 0.7, roughness: 0.55, flatShading: true });
  const accentMat = new THREE.MeshStandardMaterial({ color: accentHex, metalness: 0.3, roughness: 0.5, flatShading: true });
  const glassMat = new THREE.MeshStandardMaterial({
    color: '#0b1a26',
    metalness: 1,
    roughness: 0.08,
    emissive: new THREE.Color('#2fb4ff'),
    emissiveIntensity: 0.25,
    flatShading: true,
  });
  const glowColor = new THREE.Color('#5fd4ff');
  const engineMat = new THREE.MeshBasicMaterial({ color: glowColor.clone().multiplyScalar(6) });

  // Fuselage.
  const fuselage = loft([
    { z: -12.5, w: 0.4, h: 0.3, y: -0.1 },
    { z: -10, w: 2.0, h: 1.2, y: 0 },
    { z: -6, w: 3.2, h: 2.0, y: 0.15 },
    { z: -1, w: 3.8, h: 2.4, y: 0.2 },
    { z: 4, w: 4.4, h: 2.2, y: 0.1 },
    { z: 8.5, w: 4.0, h: 2.0, y: 0 },
    { z: 10.5, w: 3.2, h: 1.6, y: 0 },
  ]);
  body.add(new THREE.Mesh(fuselage, hullMat));

  // Dorsal spine + accent stripe.
  const spine = loft([
    { z: -5, w: 0.3, h: 0.2, y: 1.2 },
    { z: -2, w: 1.0, h: 0.8, y: 1.45 },
    { z: 6, w: 1.2, h: 0.9, y: 1.3 },
    { z: 9.5, w: 0.8, h: 0.6, y: 1.05 },
  ]);
  body.add(new THREE.Mesh(spine, accentMat));

  // Canopy.
  const canopy = loft(
    [
      { z: -8.2, w: 0.3, h: 0.2, y: 0.55 },
      { z: -6.5, w: 1.5, h: 0.9, y: 0.95 },
      { z: -3.8, w: 1.7, h: 1.0, y: 1.1 },
      { z: -2.4, w: 1.2, h: 0.5, y: 1.15 },
    ],
    0.45,
  );
  body.add(new THREE.Mesh(canopy, glassMat));

  // Wings, engine nacelles, fins — mirrored.
  const engines: THREE.Mesh[] = [];
  const plumes: THREE.Mesh[] = [];
  const plumeGeo = new THREE.PlaneGeometry(1, 1, 1, 1);
  plumeGeo.translate(0, -0.5, 0);
  plumeGeo.rotateX(Math.PI / 2); // lies in XZ, extends towards +Z from origin
  const plumeMat = new THREE.ShaderMaterial({
    vertexShader: plumeVertex,
    fragmentShader: plumeFragment,
    uniforms: { uColor: { value: glowColor.clone().multiplyScalar(3) }, uIntensity: { value: 1 }, uTime: { value: 0 } },
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(wingGeometry(7.5, 7.5, 2.6, 4.4, 0.35), hullMat);
    wing.position.set(side * 1.7, -0.35, -1.0);
    wing.scale.x = side;
    wing.rotation.z = side * -0.06;
    body.add(wing);

    const tipFin = new THREE.Mesh(wingGeometry(1.8, 2.6, 1.0, 1.2, 0.2), accentMat);
    tipFin.position.set(side * 9.0, -0.2, 3.4);
    tipFin.rotation.z = side * (Math.PI / 2 + 0.25);
    tipFin.scale.x = side;
    body.add(tipFin);

    const nacelle = loft([
      { z: -1.5, w: 0.6, h: 0.6, y: 0 },
      { z: 0.5, w: 1.6, h: 1.5, y: 0 },
      { z: 7.5, w: 1.8, h: 1.7, y: 0 },
      { z: 9.6, w: 1.5, h: 1.4, y: 0 },
    ]);
    const nac = new THREE.Mesh(nacelle, darkMat);
    nac.position.set(side * 3.4, -0.25, 1.4);
    body.add(nac);

    const intake = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.35, 0.6), accentMat);
    intake.position.set(side * 3.4, 0.55, 2.2);
    body.add(intake);

    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.72, 0.5, 8, 1, true), darkMat);
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.set(side * 3.4, -0.25, 11.2);
    body.add(nozzle);

    const glow = new THREE.Mesh(new THREE.CircleGeometry(0.6, 8), engineMat);
    glow.position.set(side * 3.4, -0.25, 11.1);
    body.add(glow);
    engines.push(glow);

    // Two crossed quads make a volumetric-looking plume.
    for (const rot of [0, Math.PI / 2]) {
      const plume = new THREE.Mesh(plumeGeo, plumeMat);
      plume.position.set(side * 3.4, -0.25, 11.15);
      plume.rotation.z = rot;
      plume.scale.set(1.2, 1, 6);
      body.add(plume);
      plumes.push(plume);
    }

    const fin = new THREE.Mesh(wingGeometry(2.4, 3.2, 1.2, 1.8, 0.2), hullMat);
    fin.position.set(side * 1.2, 1.1, 5.0);
    fin.rotation.z = side * (Math.PI / 2 - 0.35);
    fin.scale.x = side;
    body.add(fin);
  }

  // Central main engine.
  const mainNozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.0, 0.6, 8, 1, true), darkMat);
  mainNozzle.rotation.x = Math.PI / 2;
  mainNozzle.position.set(0, 0, 10.8);
  body.add(mainNozzle);
  const mainGlow = new THREE.Mesh(new THREE.CircleGeometry(0.85, 8), engineMat);
  mainGlow.position.set(0, 0, 10.6);
  body.add(mainGlow);
  engines.push(mainGlow);
  for (const rot of [0, Math.PI / 2]) {
    const plume = new THREE.Mesh(plumeGeo, plumeMat);
    plume.position.set(0, 0, 10.65);
    plume.rotation.z = rot;
    plume.scale.set(1.6, 1, 8);
    body.add(plume);
    plumes.push(plume);
  }

  // Greebles along the hull (deterministic).
  const greebles: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 14; i++) {
    const g = new THREE.BoxGeometry(0.3 + (i % 3) * 0.25, 0.18, 0.5 + ((i * 7) % 5) * 0.2);
    const side = i % 2 === 0 ? -1 : 1;
    g.translate(side * (0.9 + ((i * 3) % 4) * 0.25), 1.05 + ((i * 5) % 3) * 0.06, -1 + i * 0.75);
    greebles.push(g);
  }
  body.add(new THREE.Mesh(mergeGeometries(greebles), darkMat));

  // Navigation lights.
  const navLights: ShipVisual['navLights'] = [];
  const lightGeo = new THREE.SphereGeometry(0.14, 6, 4);
  const addLight = (color: string, x: number, y: number, z: number, strobe: boolean, phase: number) => {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(8) });
    const m = new THREE.Mesh(lightGeo, mat);
    m.position.set(x, y, z);
    body.add(m);
    navLights.push({ mesh: m, phase, strobe });
  };
  addLight('#ff2020', -9.15, -0.1, 3.0, false, 0);
  addLight('#20ff40', 9.15, -0.1, 3.0, false, 0);
  addLight('#ffffff', 0, 1.6, 9.4, true, 0.3);
  addLight('#ffffff', 0, -1.0, -10.5, true, 0.55);

  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.frustumCulled = false;
  });

  let smoothThrottle = 0;
  return {
    root,
    body,
    engines,
    plumes,
    navLights,
    update(dt, time, throttle, boost, supercruise, bank, pitchLean) {
      smoothThrottle += (Math.max(throttle, supercruise) - smoothThrottle) * (1 - Math.exp(-dt * 5));
      const power = smoothThrottle * (boost ? 1.6 : 1) + supercruise * 0.6;
      plumeMat.uniforms.uTime.value = time;
      plumeMat.uniforms.uIntensity.value = 0.25 + power * 1.4;
      (plumeMat.uniforms.uColor.value as THREE.Color)
        .copy(glowColor)
        .lerp(new THREE.Color('#b48cff'), supercruise)
        .multiplyScalar(3);
      for (const p of plumes) p.scale.z = (p.position.x === 0 ? 8 : 6) * (0.35 + power * 1.3);
      engineMat.color.copy(glowColor).multiplyScalar(3 + power * 6);
      for (const l of navLights) {
        const on = l.strobe ? (time + l.phase) % 1.4 < 0.08 : true;
        l.mesh.visible = on;
      }
      body.rotation.z += (bank - body.rotation.z) * (1 - Math.exp(-dt * 4));
      body.rotation.x += (pitchLean - body.rotation.x) * (1 - Math.exp(-dt * 4));
    },
  };
}
