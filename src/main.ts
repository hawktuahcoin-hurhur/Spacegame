import './ui/styles.css';
import { Game } from './game';
import { generateSystem } from './galaxy/systemGen';

const params = new URLSearchParams(location.search);
const seed = params.has('seed') ? Number(params.get('seed')) >>> 0 : 1337;
const q = params.get('q');
const defaultQuality = window.innerWidth * (window.devicePixelRatio || 1) > 2600 ? 'medium' : 'high';
const quality = q === 'low' || q === 'medium' || q === 'high' ? q : defaultQuality;

const loading = document.getElementById('loading')!;
const bar = document.getElementById('loading-bar')!;
const status = document.getElementById('loading-status')!;
const sys = generateSystem(seed);
document.getElementById('loading-system')!.textContent = `${sys.name} system · class ${sys.star.spectralClass}`;

const game = new Game(document.getElementById('app')!, seed, quality);
(window as unknown as { game: Game }).game = game;

void game
  .load((f, label) => {
    bar.style.width = `${(f * 100).toFixed(0)}%`;
    status.textContent = label;
  })
  .then(() => {
    game.start();
    loading.classList.add('done');
    setTimeout(() => loading.remove(), 1500);
  });
