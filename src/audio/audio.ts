/**
 * Fully procedural sound (WebAudio synthesis, no assets). Starts on the first
 * user gesture, since browsers block audio before one.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private engineOsc!: OscillatorNode;
  private droneGain!: GainNode;
  private droneOscs: OscillatorNode[] = [];
  private scoopGain!: GainNode;
  private tunnelGain!: GainNode;
  private tunnelFilter!: BiquadFilterNode;
  private chargeOsc: OscillatorNode | null = null;
  private chargeGain: GainNode | null = null;
  private noise!: AudioBuffer;
  muted = false;
  private volume = 0.6;

  /** Call from a user-gesture handler. Safe to call repeatedly. */
  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(comp);

    // Shared brown noise buffer.
    const len = ctx.sampleRate * 3;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = last * 3.5;
    }

    // Engine: low sawtooth + rumbling noise through a lowpass that opens with throttle.
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 200;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter.connect(this.engineGain).connect(this.master);
    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 42;
    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.15;
    this.engineOsc.connect(oscGain).connect(this.engineFilter);
    this.engineOsc.start();
    this.loopNoise(this.engineFilter, 0.9);

    // Supercruise drone: detuned fifths.
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 900;
    this.droneGain.connect(droneFilter).connect(this.master);
    for (const f of [55, 55.4, 82.5, 110.3]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      o.connect(this.droneGain);
      o.start();
      this.droneOscs.push(o);
    }

    // Fuel scoop hiss.
    const scoopFilter = ctx.createBiquadFilter();
    scoopFilter.type = 'highpass';
    scoopFilter.frequency.value = 1800;
    this.scoopGain = ctx.createGain();
    this.scoopGain.gain.value = 0;
    scoopFilter.connect(this.scoopGain).connect(this.master);
    this.loopNoise(scoopFilter, 1, 'white');

    // Hyperspace roar: band-passed noise with a swept centre frequency.
    this.tunnelFilter = ctx.createBiquadFilter();
    this.tunnelFilter.type = 'bandpass';
    this.tunnelFilter.Q.value = 0.8;
    this.tunnelFilter.frequency.value = 300;
    this.tunnelGain = ctx.createGain();
    this.tunnelGain.gain.value = 0;
    this.tunnelFilter.connect(this.tunnelGain).connect(this.master);
    this.loopNoise(this.tunnelFilter, 2.5);
  }

  private loopNoise(dest: AudioNode, gain: number, kind: 'brown' | 'white' = 'brown'): void {
    const ctx = this.ctx!;
    let buffer = this.noise;
    if (kind === 'white') {
      buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = buffer.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(dest);
    src.start();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  /** Continuous parameters, once per frame. */
  update(p: { throttle: number; boost: boolean; supercruise: number; scoop: number; tunnel: number }): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const power = Math.max(p.throttle, p.supercruise * 0.6) * (p.boost ? 1.5 : 1);
    this.engineGain.gain.setTargetAtTime((0.08 + power * 0.32) * (1 - p.tunnel), t, 0.15);
    this.engineFilter.frequency.setTargetAtTime(160 + power * 900, t, 0.2);
    this.engineOsc.frequency.setTargetAtTime(38 + power * 30, t, 0.3);
    this.droneGain.gain.setTargetAtTime(p.supercruise * 0.09 * (1 - p.tunnel), t, 0.4);
    this.scoopGain.gain.setTargetAtTime(Math.min(1, p.scoop / 3.5) * 0.12, t, 0.2);
    this.tunnelGain.gain.setTargetAtTime(p.tunnel * 0.5, t, 0.3);
    this.tunnelFilter.frequency.setTargetAtTime(250 + Math.sin(t * 0.9) * 120 + p.tunnel * 300, t, 0.2);
  }

  /** Rising whine over the frame-shift charge. */
  startCharge(seconds: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.stopCharge();
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 9;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 18;
    lfo.connect(lfoGain).connect(o.frequency);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1400;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(520, t + seconds);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12, t + seconds);
    o.connect(f).connect(g).connect(this.master);
    o.start();
    lfo.start();
    o.onended = () => lfo.stop();
    this.chargeOsc = o;
    this.chargeGain = g;
  }

  stopCharge(): void {
    if (!this.ctx || !this.chargeOsc || !this.chargeGain) return;
    const t = this.ctx.currentTime;
    this.chargeGain.gain.cancelScheduledValues(t);
    this.chargeGain.gain.setTargetAtTime(0, t, 0.05);
    this.chargeOsc.stop(t + 0.3);
    this.chargeOsc = null;
    this.chargeGain = null;
  }

  /** Deep boom with a pitch drop: jump entry/exit, supercruise engage. */
  boom(strength = 1): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(32, t + 1.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5 * strength, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.6);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 1.7);
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const nf = ctx.createBiquadFilter();
    nf.type = 'lowpass';
    nf.frequency.setValueAtTime(2500, t);
    nf.frequency.exponentialRampToValueAtTime(120, t + 1.0);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.6 * strength, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
    n.connect(nf).connect(ng).connect(this.master);
    n.start(t);
    n.stop(t + 1.3);
  }

  /** Short interface blip. */
  blip(freq = 880, dur = 0.06): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 1.5, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.06, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  warn(): void {
    this.blip(330, 0.14);
    setTimeout(() => this.blip(260, 0.14), 160);
  }
}
