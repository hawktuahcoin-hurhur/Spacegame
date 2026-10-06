export interface CommOption {
  label: string;
  kind?: 'primary' | 'danger' | '';
  action: () => void;
}

/**
 * Comm channel dialog: hails from patrols, pirates and targets. Pauses the
 * flight while open (the game checks `open`).
 */
export class CommDialog {
  private root: HTMLDivElement | null = null;

  get open(): boolean {
    return !!this.root;
  }

  show(o: { faction: string; color: string; speaker: string; text: string; options: CommOption[] }): void {
    this.hide();
    const root = document.createElement('div');
    root.className = 'comm';
    root.innerHTML = `<div class="comm-panel" style="--fc:${o.color}">
      <div class="comm-h"><span class="comm-sig"></span><div><b>${o.speaker}</b><small>${o.faction} · incoming transmission</small></div></div>
      <p>${o.text}</p>
      <div class="comm-opts">${o.options.map((x, i) => `<button data-i="${i}" class="${x.kind ?? ''}"><kbd>${i + 1}</kbd>${x.label}</button>`).join('')}</div></div>`;
    document.body.appendChild(root);
    this.root = root;
    const pick = (i: number) => {
      const opt = o.options[i];
      if (!opt) return;
      this.hide();
      opt.action();
    };
    root.querySelectorAll<HTMLButtonElement>('[data-i]').forEach((b) => (b.onclick = () => pick(Number(b.dataset.i))));
    const onKey = (e: KeyboardEvent) => {
      if (!this.root) return window.removeEventListener('keydown', onKey, true);
      const n = Number(e.key);
      if (n >= 1 && n <= o.options.length) {
        e.stopPropagation();
        window.removeEventListener('keydown', onKey, true);
        pick(n - 1);
      }
    };
    window.addEventListener('keydown', onKey, true);
  }

  hide(): void {
    this.root?.remove();
    this.root = null;
  }
}
