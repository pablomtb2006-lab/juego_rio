import { mtof } from '../engine/util.js';

/**
 * Real-time synth voices for the sequencer. Each call builds a tiny node graph,
 * schedules it at time `t` and lets it stop itself (no lingering oscillators).
 * `dest` is a channel-strip input. Velocities are 0..1.
 *
 * CPU budget per note: pad 2 osc/voice (+1 filter per chord), pluck 2, bass 2,
 * mallet 3, bell 2, lead 3 (+LFO), brass 3/voice, strings 2/voice.
 */

const WAVES = new WeakMap();

/** Band-limited custom waveforms (cached per context). */
export function waves(ac) {
  let w = WAVES.get(ac);
  if (w) return w;
  const make = (fn, n = 48) => {
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let k = 1; k < n; k++) im[k] = fn(k);
    return ac.createPeriodicWave(re, im);
  };
  w = {
    // saw with a gentle high roll-off: rich but not buzzy
    warm: make((k) => Math.pow(k, -1.15) * Math.exp(-k / 28)),
    // hollow odd-harmonic tone for plucks
    hollow: make((k) => (k % 2 ? Math.pow(k, -1.05) : Math.pow(k, -1.6) * 0.35) * Math.exp(-k / 20)),
    // bright brassy saw
    brass: make((k) => Math.pow(k, -0.95) * Math.exp(-k / 36), 64),
    // soft "sub" with a touch of 2nd harmonic so it reads on small speakers
    sub: make((k) => (k === 1 ? 1 : k === 2 ? 0.25 : k === 3 ? 0.08 : 0), 4),
  };
  WAVES.set(ac, w);
  return w;
}

function osc(ac, type, freq, t, stopAt, detune = 0) {
  const o = ac.createOscillator();
  if (typeof type === 'string') o.type = type;
  else o.setPeriodicWave(type);
  o.frequency.setValueAtTime(freq, t);
  if (detune) o.detune.setValueAtTime(detune, t);
  o.start(t);
  o.stop(stopAt);
  return o;
}

function lp(ac, freq, q = 0.7) {
  const f = ac.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function vca(ac) {
  const g = ac.createGain();
  g.gain.value = 0;
  return g;
}

function release(src, ...nodes) {
  src.onended = () => nodes.forEach((n) => n.disconnect());
}

/** Sustained chord pad. `midis` = voiced chord. */
export function pad(ac, dest, t, midis, dur, vel = 0.5, { cutoff = 1800, attack = 0.6, rel = 1.2, lite = false } = {}) {
  const W = waves(ac);
  cutoff *= 1.4;
  const f = lp(ac, cutoff * 0.45, 0.6);
  const amp = vca(ac);
  const end = t + dur + rel * 1.3;
  const level = (vel * 0.16) / Math.sqrt(midis.length);
  let last = null;
  midis.forEach((m, i) => {
    const fr = mtof(m);
    const det = lite ? [0] : [-8 - i, 7 + i];
    for (const d of det) {
      last = osc(ac, W.warm, fr, t, end, d);
      last.connect(f);
    }
  });
  f.connect(amp).connect(dest);
  f.frequency.setValueAtTime(cutoff * 0.45, t);
  f.frequency.setTargetAtTime(cutoff, t, attack * 0.6);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(level, t + attack);
  amp.gain.setTargetAtTime(0, t + Math.max(dur, attack), rel / 4);
  release(last, f, amp);
}

/** Bright plucked synth (arpeggios). */
export function pluck(ac, dest, t, midi, vel = 0.6, { bright = 0.6, decay = 0.2, lite = false } = {}) {
  const W = waves(ac);
  const fr = mtof(midi);
  const end = t + decay * 5 + 0.05; // stop at ≈ -43 dB
  const o1 = osc(ac, W.hollow, fr, t, end, -4);
  const f = lp(ac, 400, 2.2);
  const amp = vca(ac);
  o1.connect(f);
  const extra = [];
  if (!lite) {
    const o2 = osc(ac, 'triangle', fr * 2, t, end, 5);
    const g2 = ac.createGain();
    g2.gain.value = 0.35;
    o2.connect(g2).connect(f);
    extra.push(o2, g2);
  }
  f.connect(amp).connect(dest);
  const peakF = 900 + bright * 5200;
  f.frequency.setValueAtTime(peakF, t);
  f.frequency.setTargetAtTime(Math.min(peakF, 700 + fr * 2.5), t + 0.004, 0.08);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(vel * 0.2, t + 0.003);
  amp.gain.setTargetAtTime(0, t + 0.003, decay);
  release(o1, ...extra, f, amp);
}

/** Round synth bass (saw + sub through a resonant low-pass). */
export function bass(ac, dest, t, midi, dur, vel = 0.7, { bite = 0.5 } = {}) {
  const W = waves(ac);
  const fr = mtof(midi);
  const end = t + dur + 0.2;
  const o1 = osc(ac, W.warm, fr, t, end);
  const o2 = osc(ac, W.sub, fr, t, end);
  const gs = ac.createGain();
  gs.gain.value = 0.65;
  const f = lp(ac, 300, 3.5);
  const amp = vca(ac);
  o1.connect(f);
  o2.connect(gs).connect(amp);
  f.connect(amp).connect(dest);
  // harmonics up to ~400–700 Hz keep the bass line audible on phone/laptop speakers
  f.frequency.setValueAtTime(300 + bite * 1700 * vel, t);
  f.frequency.setTargetAtTime(220 + fr * 2.8, t + 0.005, 0.1);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(vel * 0.32, t + 0.006);
  amp.gain.setTargetAtTime(vel * 0.24, t + 0.006, 0.12);
  amp.gain.setTargetAtTime(0, t + dur, 0.03);
  release(o1, o2, gs, f, amp);
}

/** Marimba-like mallet (the playful lobby lead). */
export function mallet(ac, dest, t, midi, vel = 0.6, { decay } = {}) {
  const fr = mtof(midi);
  const tau = decay ?? Math.max(0.12, 0.5 - (midi - 60) * 0.012);
  const end = t + tau * 5;
  const amp = vca(ac);
  const o1 = osc(ac, 'sine', fr, t, end);
  o1.connect(amp);
  const nyq = ac.sampleRate * 0.45;
  const extra = [];
  // inharmonic bar partials (skipped when they'd alias)
  for (const [ratio, level, tauP, len] of [
    [3.99, 0.32, 0.035, 0.25],
    [9.3, 0.12, 0.006, 0.05],
  ]) {
    if (fr * ratio > nyq) continue;
    const o = osc(ac, 'sine', fr * ratio, t, t + len);
    const g = vca(ac);
    g.gain.setValueAtTime(level, t);
    g.gain.setTargetAtTime(0, t, tauP);
    o.connect(g).connect(amp);
    extra.push(o, g);
  }
  amp.connect(dest);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(vel * 0.32, t + 0.002);
  amp.gain.setTargetAtTime(0, t + 0.002, tau);
  release(o1, ...extra, amp);
}

/** FM bell / glass (sparkles, combo chimes). ratio 3.01 glassy, 3.5 bell, 1 e-piano. */
export function bell(ac, dest, t, midi, vel = 0.5, { ratio = 3.01, index = 2.2, decay = 0.9 } = {}) {
  const fr = mtof(midi);
  if (fr > ac.sampleRate * 0.4) return;
  const end = t + decay * 5;
  const car = osc(ac, 'sine', fr, t, end);
  const mod = osc(ac, 'sine', Math.min(fr * ratio, ac.sampleRate * 0.45), t, end);
  const mg = ac.createGain();
  mod.connect(mg).connect(car.frequency);
  mg.gain.setValueAtTime(fr * index, t);
  mg.gain.setTargetAtTime(fr * index * 0.12, t, decay * 0.25);
  const amp = vca(ac);
  car.connect(amp).connect(dest);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(vel * 0.22, t + 0.002);
  amp.gain.setTargetAtTime(0, t + 0.002, decay);
  release(car, mod, mg, amp);
}

/** Expressive saw lead with delayed vibrato. */
export function lead(ac, dest, t, midi, dur, vel = 0.6, { cutoff = 2600 } = {}) {
  const W = waves(ac);
  const fr = mtof(midi);
  const end = t + dur + 0.4;
  const o1 = osc(ac, W.warm, fr, t, end, -6);
  const o2 = osc(ac, 'square', fr, t, end, 6);
  const g2 = ac.createGain();
  g2.gain.value = 0.28;
  const lfo = osc(ac, 'sine', 5.6, t, end);
  const lg = ac.createGain();
  lg.gain.setValueAtTime(0, t);
  lg.gain.setTargetAtTime(14, t + 0.2, 0.15);
  lfo.connect(lg);
  lg.connect(o1.detune);
  lg.connect(o2.detune);
  const f = lp(ac, cutoff, 1.2);
  const amp = vca(ac);
  o1.connect(f);
  o2.connect(g2).connect(f);
  f.connect(amp).connect(dest);
  f.frequency.setValueAtTime(cutoff * 1.6, t);
  f.frequency.setTargetAtTime(cutoff, t, 0.12);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(vel * 0.15, t + 0.012);
  amp.gain.setTargetAtTime(vel * 0.12, t + 0.012, 0.15);
  amp.gain.setTargetAtTime(0, t + dur, 0.07);
  release(o1, o2, g2, lfo, lg, f, amp);
}

/** Synth brass section (fanfares, stings): scooped attack, filter "blat". */
export function brass(ac, dest, t, midis, dur, vel = 0.7, { bright = 1 } = {}) {
  const W = waves(ac);
  const end = t + dur + 0.6;
  const f = lp(ac, 500, 1.1);
  const amp = vca(ac);
  let last;
  for (const m of midis) {
    const fr = mtof(m);
    for (const d of [-11, 0, 10]) {
      const o = osc(ac, W.brass, fr, t, end, d - 70);
      o.detune.setTargetAtTime(d, t, 0.025);
      o.connect(f);
      last = o;
    }
  }
  f.connect(amp).connect(dest);
  const top = 2600 + 2400 * bright;
  f.frequency.setValueAtTime(450, t);
  f.frequency.linearRampToValueAtTime(top, t + 0.05);
  f.frequency.setTargetAtTime(top * 0.55, t + 0.05, 0.18);
  f.frequency.setTargetAtTime(400, t + dur, 0.12);
  const level = (vel * 0.13) / Math.sqrt(midis.length);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(level * 1.25, t + 0.03);
  amp.gain.setTargetAtTime(level, t + 0.03, 0.15);
  amp.gain.setTargetAtTime(0, t + dur, 0.09);
  release(last, f, amp);
}

/** String ensemble (slow attack, shared vibrato). */
export function strings(ac, dest, t, midis, dur, vel = 0.5, { attack = 0.35 } = {}) {
  const W = waves(ac);
  const end = t + dur + 1.4;
  const f = lp(ac, 2800, 0.5);
  const amp = vca(ac);
  const lfo = osc(ac, 'sine', 5.1, t, end);
  const lg = ac.createGain();
  lg.gain.value = 9;
  lfo.connect(lg);
  for (const m of midis) {
    const fr = mtof(m);
    for (const d of [-7, 8]) {
      const o = osc(ac, W.warm, fr, t, end, d);
      lg.connect(o.detune);
      o.connect(f);
    }
  }
  f.connect(amp).connect(dest);
  const level = (vel * 0.12) / Math.sqrt(midis.length);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(level, t + attack);
  amp.gain.setTargetAtTime(0, t + dur, 0.3);
  release(lfo, lg, f, amp);
}

/** Play a bank sample (drums, timpani, crash) through a gain and optional pan. */
export function sample(ac, dest, buf, t, { gain = 1, rate = 1, pan = 0, offset = 0, dur } = {}) {
  if (!buf) return null;
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.playbackRate.setValueAtTime(rate, t);
  const g = ac.createGain();
  g.gain.value = gain;
  src.connect(g);
  let tail = g;
  if (pan && ac.createStereoPanner) {
    const p = ac.createStereoPanner();
    p.pan.value = pan;
    g.connect(p);
    tail = p;
  }
  tail.connect(dest);
  src.start(t, offset, dur);
  src.onended = () => {
    g.disconnect();
    if (tail !== g) tail.disconnect();
  };
  return src;
}
