/**
 * Engine, tyre and wind audio — synthesised live in the Web Audio graph.
 *
 * There are no audio files in this build. A V6 turbo is four detuned sawtooth
 * oscillators tracking the crank harmonics through a resonant lowpass, mixed
 * with filtered noise for induction and tyre scrub. It costs a few hundred
 * bytes of code instead of a megabyte of samples, and because the pitch is a
 * continuous function of rpm it never sounds looped.
 */

const IDLE_HZ = 42;
const REV_HZ = 265;

export class EngineAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private started = false;
  muted = false;

  private oscs: OscillatorNode[] = [];
  private oscGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;

  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private tyreGain: GainNode | null = null;
  private tyreFilter: BiquadFilterNode | null = null;
  private noise: AudioBufferSourceNode | null = null;

  /** Harmonic multiples of the crank frequency, with relative levels. */
  private static readonly HARMONICS: [number, number, number][] = [
    // ratio, gain, detune cents
    [1, 0.55, 0],
    [1.5, 0.28, 7],
    [2, 0.34, -6],
    [3, 0.2, 11],
    [4.5, 0.12, -13],
  ];

  /** Must be called from a user gesture. Safe to call repeatedly. */
  async start() {
    if (this.started) {
      if (this.ctx?.state === "suspended") await this.ctx.resume();
      return;
    }
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.started = true;

    const ctx = new Ctor({ latencyHint: "interactive" });
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = 0;
    // A limiter keeps the mix from clipping when sixteen cars are close.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 8;
    comp.attack.value = 0.004;
    comp.release.value = 0.18;
    master.connect(comp).connect(ctx.destination);
    this.master = master;

    // --- engine -----------------------------------------------------------
    const engineFilter = ctx.createBiquadFilter();
    engineFilter.type = "lowpass";
    engineFilter.frequency.value = 900;
    engineFilter.Q.value = 5.5;
    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.24;
    engineFilter.connect(oscGain).connect(master);
    this.engineFilter = engineFilter;
    this.oscGain = oscGain;

    for (const [, gain, detune] of EngineAudio.HARMONICS) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = IDLE_HZ;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(engineFilter);
      o.start();
      this.oscs.push(o);
    }

    // --- shared noise source for wind + tyres -----------------------------
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // Slightly brown-tinted noise; pure white is too hissy for wind.
      last = (last + Math.random() * 2 - 1) * 0.5;
      d[i] = last;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;

    const windFilter = ctx.createBiquadFilter();
    windFilter.type = "bandpass";
    windFilter.frequency.value = 600;
    windFilter.Q.value = 0.7;
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    noise.connect(windFilter).connect(windGain).connect(master);

    const tyreFilter = ctx.createBiquadFilter();
    tyreFilter.type = "bandpass";
    tyreFilter.frequency.value = 2100;
    tyreFilter.Q.value = 7;
    const tyreGain = ctx.createGain();
    tyreGain.gain.value = 0;
    noise.connect(tyreFilter).connect(tyreGain).connect(master);

    noise.start();
    this.noise = noise;
    this.windFilter = windFilter;
    this.windGain = windGain;
    this.tyreFilter = tyreFilter;
    this.tyreGain = tyreGain;

    master.gain.setTargetAtTime(this.muted ? 0 : 0.85, ctx.currentTime, 0.4);
  }

  /**
   * @param rpm       0..1
   * @param speedNorm 0..1
   * @param throttle  0..1
   * @param slip      absolute lateral slip, m/s
   * @param offTrack  is the car on grass or gravel
   */
  update(rpm: number, speedNorm: number, throttle: number, slip: number, offTrack: boolean) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime;
    const smooth = 0.045;

    const crank = IDLE_HZ + (REV_HZ - IDLE_HZ) * rpm;
    for (let i = 0; i < this.oscs.length; i++) {
      this.oscs[i].frequency.setTargetAtTime(
        crank * EngineAudio.HARMONICS[i][0],
        t,
        smooth,
      );
    }
    // Open the filter up on throttle: that transition is most of what makes an
    // engine sound like it is working.
    this.engineFilter?.frequency.setTargetAtTime(
      520 + rpm * 3400 + throttle * 1500,
      t,
      smooth,
    );
    this.oscGain?.gain.setTargetAtTime(0.1 + throttle * 0.2 + rpm * 0.1, t, smooth);

    this.windGain?.gain.setTargetAtTime(speedNorm * speedNorm * 0.16, t, 0.1);
    this.windFilter?.frequency.setTargetAtTime(420 + speedNorm * 1500, t, 0.1);

    const scrub = Math.min(1, Math.abs(slip) / 11) * Math.min(1, speedNorm * 3.5);
    const rough = offTrack ? Math.min(1, speedNorm * 2) * 0.5 : 0;
    this.tyreGain?.gain.setTargetAtTime(scrub * 0.2 + rough * 0.12, t, 0.05);
    this.tyreFilter?.frequency.setTargetAtTime(offTrack ? 800 : 1700 + scrub * 1400, t, 0.06);
    this.tyreFilter?.Q.setTargetAtTime(offTrack ? 1.2 : 7, t, 0.06);
  }

  /** Short blip used for countdown lights, lap splits and the finish. */
  beep(freq: number, duration = 0.12, gain = 0.3) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running" || this.muted) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "square";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(gain, ctx.currentTime + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    o.connect(g).connect(this.master ?? ctx.destination);
    o.start();
    o.stop(ctx.currentTime + duration + 0.02);
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.85, this.ctx.currentTime, 0.08);
    }
  }

  suspend() {
    void this.ctx?.suspend();
  }

  dispose() {
    for (const o of this.oscs) {
      try {
        o.stop();
      } catch {
        /* already stopped */
      }
    }
    try {
      this.noise?.stop();
    } catch {
      /* already stopped */
    }
    void this.ctx?.close();
    this.ctx = null;
    this.started = false;
  }
}
