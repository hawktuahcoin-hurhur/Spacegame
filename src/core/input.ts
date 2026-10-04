/** Keyboard + pointer-lock mouse input. */
export class Input {
  private readonly down = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', (e) => this.down.add(e.code));
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
    target.addEventListener('click', () => target.requestPointerLock());
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this.target) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** -1, 0 or 1 from a pair of keys. */
  axis(negative: string, positive: string): number {
    return (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0);
  }

  /** Call once per sim step after consuming mouse deltas. */
  consumeMouse(): { dx: number; dy: number } {
    const d = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }
}
