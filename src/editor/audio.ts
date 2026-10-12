// Buzzer parts: one oscillator per sounding buzzer, through a shared gain so several do not clip.
// Created on the first tone (a browser starts an AudioContext only after a user gesture, and the
// press that set the input is one); everything stops when the editor goes away. No-op without
// Web Audio (tests in Node).

const VOLUME = 0.06;

export class Buzzers {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private voices = new Map<string, OscillatorNode>();

  /** The tones that should sound now, by buzzer (part id); every other buzzer goes quiet. */
  set(tones: Map<string, number>): void {
    for (const [id, osc] of this.voices) if (!tones.get(id)) { osc.stop(); osc.disconnect(); this.voices.delete(id); }
    for (const [id, hz] of tones) {
      if (!hz) continue;
      const v = this.voices.get(id);
      if (v) { if (v.frequency.value !== hz) v.frequency.setValueAtTime(hz, v.context.currentTime); continue; }
      const ctx = this.context();
      if (!ctx || !this.out) return;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = hz;
      osc.connect(this.out);
      osc.start();
      this.voices.set(id, osc);
    }
  }

  stop(): void {
    this.set(new Map());
  }

  destroy(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const AC = typeof AudioContext === 'function' ? AudioContext : null;
    if (!AC) return null;
    try {
      this.ctx = new AC();
      this.out = this.ctx.createGain();
      this.out.gain.value = VOLUME;
      this.out.connect(this.ctx.destination);
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }
}
