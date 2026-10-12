import { Smooth, clamp } from './util.js';

/**
 * Master chain and buses.
 *
 *   music ─► musicFilter ─► musicDuck ─► musicVol ─┐
 *   musicDelay (tempo-synced ping-pong) ─► music   │
 *   sfx ─────────────────────────────► sfxVol ─────┤
 *   ui  ─────────────────────────────► uiVol ──────┼─► glue comp ─► limiter ─► soft clip ─► master ─► duck ─► mute ─► out
 *   reverb sends (sfxRev / musicRev / uiRev) ─► convolver ─► reverbReturn ┘
 *
 * The user's sfx/music volumes are mirrored onto the matching reverb sends so
 * turning a bus down also turns its tail down.
 */
export class Mixer {
  constructor(ac, bank, { destination = ac.destination, dynamics = true } = {}) {
    this.ac = ac;
    this.bank = bank;
    const g = (v = 1) => {
      const n = ac.createGain();
      n.gain.value = v;
      return n;
    };

    // --- output stage -------------------------------------------------------
    this.mute = g(1);
    this.duckNode = g(1);
    this.master = g(0.9);
    this.mute.connect(destination);
    this.duckNode.connect(this.mute);
    this.master.connect(this.duckNode);

    // soft clipper: transparent below ~-3 dBFS, rounds anything hotter (never > 0.99)
    this.clip = ac.createWaveShaper();
    this.clip.curve = softClipCurve();
    this.clip.oversample = 'none';
    this.clip.connect(this.master);

    // NB: DynamicsCompressorNode applies automatic make-up gain (≈0.6 × the gain
    // reduction at 0 dBFS): glue ≈ +3 dB, limiter ≈ +1.1 dB. `trim` compensates.
    this.limiter = ac.createDynamicsCompressor();
    setComp(this.limiter, { threshold: -2, knee: 0, ratio: 20, attack: 0.002, release: 0.1 });
    this.limiter.connect(this.clip);

    this.glue = ac.createDynamicsCompressor();
    setComp(this.glue, { threshold: -10, knee: 10, ratio: 2, attack: 0.015, release: 0.3 });
    this.trim = g(0.5);
    if (dynamics) {
      this.trim.connect(this.glue);
      this.glue.connect(this.limiter);
    } else this.trim.connect(this.clip); // test/analysis mode: measure the raw mix
    this.mix = this.trim;

    // --- buses ----------------------------------------------------------------
    this.musicVol = g(0.7);
    this.musicDuck = g(1);
    this.musicFilter = ac.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 20000;
    this.musicFilter.Q.value = 0.5;
    this.music = g(1);
    // gentle "radio" EQ on the score: less sub mud, a bit of air
    const low = ac.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 90;
    low.gain.value = -3;
    const air = ac.createBiquadFilter();
    air.type = 'highshelf';
    air.frequency.value = 5000;
    air.gain.value = 3;
    this.music.connect(low).connect(air).connect(this.musicFilter).connect(this.musicDuck).connect(this.musicVol).connect(this.mix);

    this.sfxVol = g(1);
    this.sfx = g(1);
    const subsonic = ac.createBiquadFilter(); // strip DC / sub-sonic energy from noise bursts
    subsonic.type = 'highpass';
    subsonic.frequency.value = 25;
    subsonic.Q.value = 0.7;
    this.sfx.connect(subsonic).connect(this.sfxVol).connect(this.mix);

    this.uiVol = g(1);
    this.ui = g(1);
    this.ui.connect(this.uiVol).connect(this.mix);

    // --- reverb ---------------------------------------------------------------
    this.reverb = ac.createConvolver();
    this.reverbReturn = g(0.9);
    this.reverb.connect(this.reverbReturn).connect(this.mix);
    this.sfxRev = g(1);
    this.musicRev = g(1);
    this.uiRev = g(1);
    this.sfxRevVol = g(1);
    this.musicRevVol = g(0.7);
    this.musicRevGate = g(1); // follows filterMusic() so muffled music doesn't keep a bright tail
    this.sfxRev.connect(this.sfxRevVol).connect(this.reverb);
    this.musicRev.connect(this.musicRevGate).connect(this.musicRevVol).connect(this.reverb);
    this.uiRev.connect(this.reverb);
    const setIR = () => {
      const ir = bank.get('reverb');
      if (ir && !this.reverb.buffer) this.reverb.buffer = ir;
    };
    setIR();
    bank.ready.then(setIR);

    // --- music delay (ping-pong) -------------------------------------------------
    this.delayIn = g(1);
    const dl = (this.delayL = ac.createDelay(2));
    const dr = (this.delayR = ac.createDelay(2));
    const fb = (this.delayFb = g(0.38));
    const tone = ac.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 3800;
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 280;
    const merger = ac.createChannelMerger(2);
    const toMono = g(0.5);
    toMono.channelCount = 1;
    toMono.channelCountMode = 'explicit';
    this.delayIn.connect(toMono).connect(hp).connect(dl);
    dl.connect(tone).connect(dr);
    dr.connect(fb).connect(dl);
    dl.connect(merger, 0, 0);
    dr.connect(merger, 0, 1);
    this.delayOut = g(0.5);
    merger.connect(this.delayOut).connect(this.music);
    this.setDelayTime(0.375);

    this.s = {
      musicDuck: new Smooth(this.musicDuck.gain, 1),
      musicFilter: new Smooth(this.musicFilter.frequency, 20000, 1e-3),
      duck: new Smooth(this.duckNode.gain, 1),
      mute: new Smooth(this.mute.gain, 1),
    };
  }

  setDelayTime(seconds) {
    const t = this.ac.currentTime;
    this.delayL.delayTime.setTargetAtTime(seconds, t, 0.05);
    this.delayR.delayTime.setTargetAtTime(seconds, t, 0.05);
  }

  setVolumes({ master, music, sfx }) {
    const t = this.ac.currentTime;
    // perceptual taper (≈ loudness-linear slider)
    const taper = (v) => Math.pow(clamp(v), 1.7);
    this.master.gain.setTargetAtTime(taper(master), t, 0.03);
    this.musicVol.gain.setTargetAtTime(taper(music), t, 0.03);
    this.musicRevVol.gain.setTargetAtTime(taper(music), t, 0.03);
    this.sfxVol.gain.setTargetAtTime(taper(sfx), t, 0.03);
    this.sfxRevVol.gain.setTargetAtTime(taper(sfx), t, 0.03);
    this.uiVol.gain.setTargetAtTime(taper(sfx) * 1.5, t, 0.03); // UI must read over the mix
  }

  setMuted(m) {
    this.s.mute.to(m ? 0 : 1, this.ac.currentTime, 0.04);
  }

  /** External ducking (ads, pause screens): 0 = none, 1 = silent. */
  duck(amount, seconds) {
    const t = this.ac.currentTime;
    const target = 1 - clamp(amount);
    const p = this.duckNode.gain;
    p.cancelScheduledValues(t);
    p.setTargetAtTime(target, t, 0.05);
    this.s.duck.last = target;
    if (Number.isFinite(seconds) && seconds > 0) {
      p.setTargetAtTime(1, t + seconds, 0.25);
      this.s.duck.last = 1;
    }
  }

  /** Short internal music dip under a big sound effect (sidechain feel). */
  duckMusic(depth, hold = 0.3, release = 0.6, at = this.ac.currentTime) {
    const p = this.musicDuck.gain;
    p.cancelScheduledValues(at);
    p.setTargetAtTime(1 - depth, at, 0.02);
    p.setTargetAtTime(1, at + hold, release / 3);
    this.s.musicDuck.last = 1;
  }

  /** Low-pass the music bus (elimination, underwater, pause). freq 20000 = open. */
  filterMusic(freq, tc = 0.3, at = this.ac.currentTime) {
    this.s.musicFilter.last = freq;
    this.musicFilter.frequency.cancelScheduledValues(at);
    this.musicFilter.frequency.setTargetAtTime(freq, at, tc);
    const gate = clamp((Math.log2(freq) - Math.log2(200)) / (Math.log2(8000) - Math.log2(200)));
    this.musicRevGate.gain.cancelScheduledValues(at);
    this.musicRevGate.gain.setTargetAtTime(gate, at, tc);
  }
}

function setComp(c, { threshold, knee, ratio, attack, release }) {
  c.threshold.value = threshold;
  c.knee.value = knee;
  c.ratio.value = ratio;
  c.attack.value = attack;
  c.release.value = release;
}

function softClipCurve(n = 2048) {
  const curve = new Float32Array(n);
  const knee = 0.72;
  const ceil = 0.985;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    let y = a;
    if (a > knee) {
      const over = (a - knee) / (ceil - knee);
      y = knee + (ceil - knee) * Math.tanh(over);
    }
    curve[i] = Math.sign(x) * Math.min(y, ceil);
  }
  return curve;
}
