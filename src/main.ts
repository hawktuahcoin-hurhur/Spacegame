import './ui/styles.css';
import { Game, type QualityName } from './game';
import { Menu } from './ui/menu';

const params = new URLSearchParams(location.search);
const q = params.get('q');
const defaultQuality: QualityName = window.innerWidth * (window.devicePixelRatio || 1) > 2600 ? 'medium' : 'high';
const quality: QualityName = q === 'low' || q === 'medium' || q === 'high' ? q : defaultQuality;
const defaultSeed = params.has('galaxy') ? Number(params.get('galaxy')) >>> 0 : 1337;

const loading = document.getElementById('loading')!;
const bar = document.getElementById('loading-bar')!;
const status = document.getElementById('loading-status')!;
const subtitle = document.getElementById('loading-system')!;

const game = new Game(document.getElementById('app')!, quality);
(window as unknown as { game: Game }).game = game;
let running = false;

function progress(f: number, label: string): void {
  bar.style.width = `${(f * 100).toFixed(0)}%`;
  status.textContent = label;
}

async function launch(load: () => Promise<void>): Promise<void> {
  menu.hide();
  game.setPaused(true);
  loading.classList.remove('done');
  progress(0, 'Initialising');
  try {
    await load();
  } catch (e) {
    console.error(e);
    status.textContent = `Failed to load: ${(e as Error).message}`;
    return;
  }
  subtitle.textContent = `${game.universe.system.name} system · class ${game.universe.system.star.spectralClass}`;
  game.start();
  game.setPaused(false);
  running = true;
  loading.classList.add('done');
}

const menu = new Menu(game.storage, {
  newGame: (seed) => void launch(() => game.newGame(seed, progress)),
  continueGame: (save) => void launch(() => game.loadSave(save, progress)),
  resume: () => {
    menu.hide();
    game.setPaused(false);
    void game.pipeline.renderer.domElement.requestPointerLock?.();
  },
  saveTo: (slot) => game.saveTo(slot),
  currentSave: () => (running ? game.snapshot() : null),
  setQuality: (qq) => game.setQuality(qq),
  quality: () => game.quality,
  setMuted: (m) => game.audio.setMuted(m),
  muted: () => game.audio.muted,
  quitToTitle: async () => {
    await game.saveTo('auto');
    location.href = location.pathname;
  },
});
menu.onClick = () => {
  game.audio.start();
  game.audio.blip(700, 0.05);
};
game.onPauseRequest = () => {
  if (!running || game.inTunnel || menu.visible) return;
  game.setPaused(true);
  menu.showPause();
};

// Quickload is handled here so it can go through the same loading path.
window.addEventListener('keydown', async (e) => {
  if (e.code !== 'F9' || !running) return;
  e.preventDefault();
  const save = await game.storage.read('quick');
  if (save) void launch(() => game.loadSave(save, progress));
});

if (params.has('new')) void launch(() => game.newGame(defaultSeed, progress));
else {
  loading.classList.add('done');
  void menu.showTitle(defaultSeed);
}
