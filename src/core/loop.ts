/** Fixed-step simulation with variable-rate rendering. */
export class GameLoop {
  private accumulator = 0;
  private last = 0;
  private running = false;

  constructor(
    private readonly update: (dt: number) => void,
    private readonly render: (alpha: number, frameDt: number) => void,
    private readonly step = 1 / 60,
  ) {}

  start(): void {
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    // Clamp to avoid a spiral of death after tab switches.
    const frameDt = Math.min((now - this.last) / 1000, 0.25);
    this.last = now;
    this.accumulator += frameDt;
    while (this.accumulator >= this.step) {
      this.update(this.step);
      this.accumulator -= this.step;
    }
    this.render(this.accumulator / this.step, frameDt);
    requestAnimationFrame(this.frame);
  };
}
