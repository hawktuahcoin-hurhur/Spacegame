import * as THREE from 'three';
import { GameLoop } from './core/loop';
import { Input } from './core/input';
import { Renderer } from './render/renderer';
import { ChaseCamera } from './render/chaseCamera';
import { createPlaceholderShip } from './ships/shipMesh';
import { FlightModel } from './ships/flightModel';
import { buildSandbox } from './scenes/sandboxScene';

const SEED = 1337;

const container = document.getElementById('app')!;
const hud = document.getElementById('hud')!;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 1e7);
const renderer = new Renderer(container, scene, camera);
const input = new Input(renderer.gl.domElement);

const sandbox = buildSandbox(scene, SEED);

const ship = createPlaceholderShip();
scene.add(ship);
const flight = new FlightModel(ship);
const chase = new ChaseCamera(camera, ship);

const loop = new GameLoop(
  (dt) => {
    flight.update(dt, input);
    sandbox.tick(dt);
  },
  (_alpha, frameDt) => {
    chase.update(frameDt);
    // Keep the starfield centred on the camera so stars appear infinitely far away.
    sandbox.starfield.position.copy(camera.position);
    hud.textContent = `Throttle ${(flight.throttle * 100).toFixed(0)}%  ·  Speed ${flight.speed.toFixed(0)} m/s`;
    renderer.render();
  },
);
loop.start();
