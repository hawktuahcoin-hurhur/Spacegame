/** Keyboard + pointer-lock mouse input with per-frame edge detection. */
export class Input {
  private readonly down = new Set<string>();
  private readonly pressedThisFrame = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  /** When false, clicking the canvas won't grab the pointer (e.g. map open). */
  allowPointerLock = true;

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Tab' || e.code === 'F3' || e.code === 'Space') e.preventDefault();
      if (!e.repeat) this.pressedThisFrame.add(e.code);
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
    target.addEventListener('click', () => {
      if (this.allowPointerLock && !this.locked) void target.requestPointerLock?.();
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    window.addEventListener('wheel', (e) => (this.wheel += Math.sign(e.deltaY)), { passive: true });
  }

  get locked(): boolean {
    return document.pointerLockElement === this.target;
  }

  releasePointer(): void {
    if (this.locked) document.exitPointerLock();
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** True once on the frame the key went down. */
  pressed(code: string): boolean {
    return this.pressedThisFrame.has(code);
  }

  /** -1, 0 or 1 from a pair of keys. */
  axis(negative: string, positive: string): number {
    return (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0);
  }

  consumeMouse(): { dx: number; dy: number } {
    const d = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  consumeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** Call at the end of every rendered frame. */
  endFrame(): void {
    this.pressedThisFrame.clear();
  }
}
