import type { SaveData } from '../save/saveGame';
import { SLOT_LABEL, type SaveStorage, type SlotId, exportSave, importSave } from '../save/storage';

export interface MenuActions {
  newGame(seed: number): void;
  continueGame(save: SaveData): void;
  resume(): void;
  saveTo(slot: SlotId): Promise<void>;
  currentSave(): SaveData | null;
  setQuality(q: 'low' | 'medium' | 'high'): void;
  quality(): 'low' | 'medium' | 'high';
  setMuted(m: boolean): void;
  muted(): boolean;
  quitToTitle(): void;
}

function relTime(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

/** Title screen, pause menu, save/load and settings: one overlay, several screens. */
export class Menu {
  private readonly root: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private mode: 'title' | 'pause' = 'title';
  private titleSeed = 1337;
  visible = false;
  onClick: () => void = () => {};

  constructor(
    private readonly storage: SaveStorage,
    private readonly actions: MenuActions,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'menu hidden';
    this.panel = document.createElement('div');
    this.panel.className = 'menu-panel';
    this.root.appendChild(this.panel);
    document.body.appendChild(this.root);
    this.root.addEventListener('keydown', (e) => e.stopPropagation());
  }

  private show(html: string): void {
    this.visible = true;
    this.root.classList.remove('hidden');
    this.panel.innerHTML = html;
    this.panel.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => this.onClick()));
  }

  hide(): void {
    this.visible = false;
    this.root.classList.add('hidden');
  }

  private bind(sel: string, fn: () => void): void {
    this.panel.querySelector<HTMLElement>(sel)?.addEventListener('click', fn);
  }

  async showTitle(defaultSeed: number): Promise<void> {
    this.mode = 'title';
    this.titleSeed = defaultSeed;
    this.root.classList.add('title');
    const latest = await this.storage.latest();
    this.show(`
      <h1 class="menu-title">Spacegame</h1>
      <div class="menu-sub">Explore · Trade · Command</div>
      <div class="menu-buttons">
        ${latest ? `<button class="primary" data-act="continue">Continue<small>${latest.data.label} · ${relTime(latest.data.savedAt)}</small></button>` : ''}
        <button class="${latest ? '' : 'primary'}" data-act="new">New expedition</button>
        <button data-act="load">Load game</button>
        <button data-act="settings">Settings</button>
      </div>
      <div class="menu-seed"><label>Galaxy seed</label><input data-seed value="${defaultSeed}" inputmode="numeric" /><button class="icon" data-act="dice" title="Random galaxy">🎲</button></div>`);
    const seedInput = this.panel.querySelector<HTMLInputElement>('[data-seed]')!;
    if (latest) this.bind('[data-act=continue]', () => this.actions.continueGame(latest.data));
    this.bind('[data-act=new]', () => this.actions.newGame(Number(seedInput.value) >>> 0));
    this.bind('[data-act=dice]', () => (seedInput.value = String(Math.floor(Math.random() * 1e9))));
    this.bind('[data-act=load]', () => void this.showSlots('load'));
    this.bind('[data-act=settings]', () => this.showSettings());
  }

  showPause(): void {
    this.mode = 'pause';
    this.root.classList.remove('title');
    this.show(`
      <h2 class="menu-heading">Paused</h2>
      <div class="menu-buttons">
        <button class="primary" data-act="resume">Resume</button>
        <button data-act="save">Save game</button>
        <button data-act="load">Load game</button>
        <button data-act="settings">Settings</button>
        <button data-act="quit">Exit to title</button>
      </div>`);
    this.bind('[data-act=resume]', () => this.actions.resume());
    this.bind('[data-act=save]', () => void this.showSlots('save'));
    this.bind('[data-act=load]', () => void this.showSlots('load'));
    this.bind('[data-act=settings]', () => this.showSettings());
    this.bind('[data-act=quit]', () => this.actions.quitToTitle());
  }

  private back(): void {
    if (this.mode === 'title') void this.showTitle(this.titleSeed);
    else this.showPause();
  }

  async showSlots(kind: 'save' | 'load'): Promise<void> {
    const list = await this.storage.list();
    const writable = (slot: SlotId) => slot !== 'auto';
    const rows = list
      .filter((e) => kind === 'load' || writable(e.slot))
      .map(({ slot, data }) => {
        const info = data ? `<b>${data.label}</b><small>${relTime(data.savedAt)} · ${data.player.jumps} jump${data.player.jumps === 1 ? '' : 's'} · ${data.player.visited.length} system${data.player.visited.length === 1 ? '' : 's'}</small>` : '<b class="empty">Empty</b>';
        const btns =
          kind === 'save'
            ? `<button data-save="${slot}">${data ? 'Overwrite' : 'Save'}</button>`
            : data
              ? `<button data-load="${slot}">Load</button><button class="icon" data-export="${slot}" title="Export to file">⇩</button><button class="icon danger" data-del="${slot}" title="Delete">✕</button>`
              : '';
        return `<div class="slot"><div class="slot-name">${SLOT_LABEL[slot]}</div><div class="slot-info">${info}</div><div class="slot-btns">${btns}</div></div>`;
      })
      .join('');
    this.show(`
      <h2 class="menu-heading">${kind === 'save' ? 'Save game' : 'Load game'}</h2>
      <div class="slots">${rows}</div>
      <div class="menu-row">
        ${kind === 'load' ? '<button data-act="import">Import file…</button>' : '<button data-act="export">Export current to file</button>'}
        <button data-act="back">Back</button>
      </div>
      <div class="menu-msg" data-msg></div>`);
    const msg = this.panel.querySelector<HTMLDivElement>('[data-msg]')!;
    this.bind('[data-act=back]', () => this.back());
    this.panel.querySelectorAll<HTMLButtonElement>('[data-save]').forEach((b) =>
      b.addEventListener('click', async () => {
        await this.actions.saveTo(b.dataset.save as SlotId);
        await this.showSlots('save');
        this.panel.querySelector<HTMLDivElement>('[data-msg]')!.textContent = 'Saved.';
      }),
    );
    this.panel.querySelectorAll<HTMLButtonElement>('[data-load]').forEach((b) =>
      b.addEventListener('click', () => {
        const entry = list.find((e) => e.slot === b.dataset.load);
        if (entry?.data) this.actions.continueGame(entry.data);
      }),
    );
    this.panel.querySelectorAll<HTMLButtonElement>('[data-export]').forEach((b) =>
      b.addEventListener('click', () => {
        const entry = list.find((e) => e.slot === b.dataset.export);
        if (entry?.data) exportSave(entry.data);
      }),
    );
    this.panel.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        await this.storage.remove(b.dataset.del as SlotId);
        await this.showSlots('load');
      }),
    );
    this.bind('[data-act=import]', async () => {
      try {
        this.actions.continueGame(await importSave());
      } catch (e) {
        msg.textContent = `Could not import: ${(e as Error).message}`;
      }
    });
    this.bind('[data-act=export]', () => {
      const s = this.actions.currentSave();
      if (s) exportSave(s);
    });
  }

  showSettings(): void {
    const q = this.actions.quality();
    this.show(`
      <h2 class="menu-heading">Settings</h2>
      <div class="setting"><span>Graphics quality</span><div class="seg">${(['low', 'medium', 'high'] as const)
        .map((x) => `<button data-q="${x}" class="${x === q ? 'on' : ''}">${x}</button>`)
        .join('')}</div></div>
      <div class="setting"><span>Sound</span><div class="seg"><button data-mute="0" class="${this.actions.muted() ? '' : 'on'}">On</button><button data-mute="1" class="${this.actions.muted() ? 'on' : ''}">Off</button></div></div>
      <div class="menu-row"><button data-act="back">Back</button></div>`);
    this.panel.querySelectorAll<HTMLButtonElement>('[data-q]').forEach((b) =>
      b.addEventListener('click', () => {
        this.actions.setQuality(b.dataset.q as 'low' | 'medium' | 'high');
        this.showSettings();
      }),
    );
    this.panel.querySelectorAll<HTMLButtonElement>('[data-mute]').forEach((b) =>
      b.addEventListener('click', () => {
        this.actions.setMuted(b.dataset.mute === '1');
        this.showSettings();
      }),
    );
    this.bind('[data-act=back]', () => this.back());
  }
}
