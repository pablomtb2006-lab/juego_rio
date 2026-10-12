/**
 * Fallback UI blips (only used when ctx.audio.play() does not exist). Tiny WebAudio synth,
 * created on the first user gesture, honouring the sfx/master volume and ad/pause muting.
 */
const PRESETS = {
  tap: [[520, 0.035, 'triangle', 0.18]],
  open: [[420, 0.05, 'triangle', 0.16], [640, 0.07, 'triangle', 0.14, 0.04]],
  back: [[520, 0.05, 'triangle', 0.14], [380, 0.07, 'triangle', 0.12, 0.04]],
  equip: [[660, 0.06, 'triangle', 0.2], [990, 0.09, 'triangle', 0.18, 0.06]],
  coins: [[988, 0.06, 'square', 0.07], [1319, 0.08, 'square', 0.07, 0.06], [1760, 0.14, 'square', 0.06, 0.12]],
  purchase: [[523, 0.08, 'triangle', 0.2], [659, 0.08, 'triangle', 0.2, 0.08], [784, 0.08, 'triangle', 0.2, 0.16], [1047, 0.2, 'triangle', 0.22, 0.24]],
  error: [[180, 0.12, 'square', 0.08], [140, 0.16, 'square', 0.08, 0.1]],
  alert: [[740, 0.08, 'triangle', 0.16], [988, 0.12, 'triangle', 0.16, 0.09]],
};

export class UiSynth {
  constructor(ctx) {
    this.ctx = ctx;
    this.ac = null;
  }

  unlock() {
    if (this.ac || this.ctx.params.mute || this.ctx.params.capture || typeof this.ctx.audio?.play === 'function') return;
    try {
      this.ac = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      this.ac = null;
    }
  }

  play(name, vol = 1) {
    const ac = this.ac;
    const notes = PRESETS[name];
    if (!ac || !notes) return;
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    const t0 = ac.currentTime + 0.005;
    for (const [f, dur, type, gain, at = 0] of notes) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f, t0 + at);
      g.gain.setValueAtTime(0, t0 + at);
      g.gain.linearRampToValueAtTime(gain * vol, t0 + at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      o.connect(g).connect(ac.destination);
      o.start(t0 + at);
      o.stop(t0 + at + dur + 0.02);
    }
  }
}
