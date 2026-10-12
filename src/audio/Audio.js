/**
 * Procedural WebAudio. Skeleton: a filtered-noise water roar that follows player speed.
 * Contract: unlock() (call from a user gesture), update(dt, time), setMuted(bool).
 * Reacts to bus events: 'splash', 'absorb', 'cut', 'eliminated', 'finished', 'phase'.
 */
export class AudioSystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.muted = ctx.params.mute || ctx.params.capture;
    this.ac = null;
  }

  unlock() {
    if (this.muted || this.ac) return;
    try {
      this.ac = new AudioContext();
    } catch {
      return;
    }
    const ac = this.ac;
    const buf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    this.filter = ac.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.gain = ac.createGain();
    this.gain.gain.value = 0;
    src.connect(this.filter).connect(this.gain).connect(ac.destination);
    src.start();
  }

  setMuted(m) {
    this.muted = m;
    if (this.gain) this.gain.gain.value = 0;
  }

  update() {
    if (!this.ac || this.muted) return;
    const p = this.ctx.game.player;
    const active = p && p.alive;
    const speed = active ? p.speed : 0;
    this.gain.gain.setTargetAtTime(active ? 0.05 + Math.min(speed / 60, 1) * 0.15 : 0, this.ac.currentTime, 0.2);
    this.filter.frequency.setTargetAtTime(400 + speed * 40, this.ac.currentTime, 0.2);
  }
}
