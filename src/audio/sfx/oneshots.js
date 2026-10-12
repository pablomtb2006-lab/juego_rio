import { Shot } from './Shot.js';
import { clamp, mtof, rand } from '../engine/util.js';
import * as inst from '../music/instruments.js';

/**
 * Catalogue of synthesized one-shots. Signature: (S, t, opts) -> duration (s)
 *   S = { ac, bank, mixer, listener, music }   t = AudioContext start time
 * Positional sounds take {x, y, z} (world metres) and are spatialized relative
 * to the camera (pan, distance gain, air absorption, speed-of-sound delay).
 * Musical sounds read the current key from S.music so they always fit the score.
 */

const key = (S) => S.music?.key ?? 67;

function sweep(param, t, from, to, dur, exp = true) {
  param.setValueAtTime(from, t);
  if (exp) param.exponentialRampToValueAtTime(Math.max(to, 1e-4), t + dur);
  else param.linearRampToValueAtTime(to, t + dur);
}

function spatial(S, o, opts) {
  if (o.x == null || !S.listener) return null;
  return S.listener.place(o.x, o.y ?? 0, o.z, opts);
}

export const SFX = {
  // ---------------------------------------------------------------- water --
  /** Generic splash, spatialized. size ≈ metres of water hitting (4..120). */
  splash(S, t, o = {}) {
    const size = o.size ?? 20;
    const sp = spatial(S, o, { ref: 25 + size, max: 2600 });
    if (sp && !sp.audible) return 0;
    const k = clamp(Math.log2(Math.max(size, 4) / 6) / 4);
    const t0 = t + (sp ? sp.delay : 0);
    const g = (sp ? sp.gain : 1) * (o.gain ?? 1) * (0.55 + 0.45 * k);
    if (g < 0.008) return 0;
    const sh = new Shot(S, t0, { gain: g, spatial: sp, rev: 0.22 });
    const far = sp && sp.dist > 450;

    const src = sh.noise('pink', t0, 1 + k);
    const bp = sh.filter('bandpass', 1800, 0.9);
    sweep(bp.frequency, t0, 2300 - 700 * k, 420 - 160 * k, 0.32 + 0.3 * k);
    sh.chain(src, bp, sh.env(1.1, t0, 0.004, 0.11 + 0.17 * k));

    if (k > 0.15) {
      const o1 = sh.osc('sine', 100, t0, 0.9);
      sweep(o1.frequency, t0, 100, 36, 0.4);
      sh.chain(o1, sh.env(0.6 * k, t0, 0.005, 0.15));
    }
    const w = sh.noise('white', t0, 1.6 + k);
    sh.chain(w, sh.filter('highpass', 2800, 0.7), sh.env(0.16 + 0.1 * k, t0 + 0.012, 0.03, 0.2 + 0.35 * k));

    if (!far) {
      const nb = Math.round(4 + 12 * k);
      for (let i = 0; i < nb; i++) {
        const b = S.bank.bubble(380, 2600);
        sh.grain(b?.buf, t0 + 0.015 + Math.pow(Math.random(), 1.7) * 0.55, rand(0.16, 0.34), rand(0.9, 1.12), rand(-0.45, 0.45));
      }
      const nd = Math.round(5 + 16 * k);
      for (let i = 0; i < nd; i++) {
        const dt = 0.2 + Math.pow(Math.random(), 1.4) * (0.5 + 0.9 * k);
        sh.grain(S.bank.droplet(), t0 + dt, rand(0.08, 0.24) * (1 - dt / 2.2), rand(0.85, 1.2), rand(-0.6, 0.6));
      }
    }
    return sh.done();
  },

  /** The player's landing: sub thump + crash + wash + spray + water raining back. k = size 0..1 */
  impact(S, t, o = {}) {
    const k = clamp(o.size ?? 0.5);
    const sh = new Shot(S, t, { gain: 0.95, rev: 0.32 });
    // sub thump (+ an octave up so laptops hear it)
    const sub = sh.osc('sine', 74, t, 1.6);
    sweep(sub.frequency, t, 74, 29, 0.65);
    sh.chain(sub, sh.env(0.95, t, 0.004, 0.36 + 0.22 * k));
    const sub2 = sh.osc('sine', 150, t, 0.7);
    sweep(sub2.frequency, t, 150, 58, 0.3);
    sh.chain(sub2, sh.env(0.34, t, 0.003, 0.13));
    // crash of water
    const w = sh.noise('white', t, 1.6);
    const lp = sh.filter('lowpass', 9000, 0.6);
    sweep(lp.frequency, t, 9500, 520, 0.95);
    sh.chain(w, lp, sh.env(0.72, t, 0.002, 0.22 + 0.14 * k));
    // the big wash
    const p = sh.noise('pink', t, 3);
    const bp = sh.filter('bandpass', 750, 0.55);
    sweep(bp.frequency, t, 1100, 420, 1.4);
    sh.chain(p, bp, sh.env(1.0, t + 0.008, 0.035, 0.45 + 0.4 * k));
    const br = sh.noise('brown', t, 3);
    sh.chain(br, sh.filter('lowpass', 260, 0.7), sh.env(0.85, t, 0.02, 0.6 + 0.5 * k));
    // spray tail
    const sp = sh.noise('white', t, 4);
    sh.chain(sp, sh.filter('highpass', 3600, 0.7), sh.env(0.2, t + 0.05, 0.14, 0.75 + 0.5 * k));
    // bubbles churning + droplets raining back down
    for (let i = 0; i < 26; i++) {
      const b = S.bank.bubble(240, 1900);
      sh.grain(b?.buf, t + 0.03 + Math.pow(Math.random(), 1.5) * 1.3, rand(0.18, 0.4), rand(0.9, 1.1), rand(-0.7, 0.7));
    }
    for (let i = 0; i < 48; i++) {
      const dt = 0.3 + Math.pow(Math.random(), 1.8) * 2.7;
      sh.grain(S.bank.droplet(), t + dt, rand(0.1, 0.32) * (1 - dt / 3.6), rand(0.8, 1.25), rand(-0.85, 0.85));
    }
    S.mixer.duckMusic(0.5, 0.25, 1.4, t);
    return sh.done();
  },

  /** Band-passed noise sweep. Used by surge, cloud, UI transitions. */
  whoosh(S, t, o = {}) {
    const { dur = 0.6, f0 = 300, f1 = 2400, q = 1.1, gain = 0.5, pan0 = -0.4, pan1 = 0.4, type = 'pink', bus = 'sfx', peak = 0.65 } = o;
    const sh = new Shot(S, t, { gain, rev: 0.12, bus });
    const src = sh.noise(type, t, dur + 0.15);
    const bp = sh.filter('bandpass', f0, q);
    sweep(bp.frequency, t, f0, f1, dur);
    const g = sh.gainNode(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + dur * peak);
    g.gain.setTargetAtTime(0, t + dur * peak, dur * 0.14);
    sh.end = t + dur + 0.3;
    if (!src) return sh.done();
    let last = g;
    if (S.ac.createStereoPanner) {
      const pn = S.ac.createStereoPanner();
      sweep(pn.pan, t, pan0, pan1, dur, false);
      sh.nodes.push(pn);
      g.connect(pn);
      last = pn;
    }
    src.connect(bp);
    bp.connect(g);
    last.connect(sh.in);
    return sh.done();
  },

  cloudEnter(S, t, o = {}) {
    SFX.whoosh(S, t, { dur: 0.9, f0: 240, f1: 1700, q: 0.7, gain: 0.8 * (o.gain ?? 1), pan0: rand(-0.5, 0.5), pan1: 0 });
    const sh = new Shot(S, t, { gain: 1.3 * (o.gain ?? 1), rev: 0.2 });
    for (let i = 0; i < 18; i++) sh.grain(S.bank.droplet(), t + 0.1 + Math.random() * 0.6, rand(0.1, 0.3), rand(0.9, 1.3), rand(-0.8, 0.8));
    return sh.done();
  },

  /** Surge start: a jet of water kicking in. */
  surge(S, t, o = {}) {
    const g = o.gain ?? 1;
    SFX.whoosh(S, t, { dur: 0.5, f0: 380, f1: 3400, q: 1.3, gain: 0.85 * g, pan0: 0, pan1: 0 });
    const sh = new Shot(S, t, { gain: 1.3 * g, rev: 0.12 });
    sh.chain(sh.noise('white', t, 0.9), sh.filter('highpass', 1600, 0.7), sh.env(0.2, t, 0.04, 0.26));
    sh.chain(sh.noise('brown', t, 1.2), sh.filter('lowpass', 190, 0.8), sh.env(0.75, t, 0.07, 0.32));
    return sh.done();
  },

  /** One swallow pulse. size 0..1 (bigger = lower, longer). */
  gulp(S, t, o = {}) {
    const size = clamp(o.size ?? 0.5);
    const sh = new Shot(S, t, { gain: o.gain ?? 0.8, rev: 0.1, pan: o.pan ?? 0 });
    const f1 = (340 - 190 * size) * rand(0.92, 1.08);
    const o1 = sh.osc('sine', f1, t, 0.5);
    sweep(o1.frequency, t, f1, f1 * 0.48, 0.1 + 0.06 * size);
    sh.chain(o1, sh.env(0.62, t, 0.006, 0.055 + 0.04 * size));
    const o2 = sh.osc('triangle', f1 * 2, t, 0.3);
    sweep(o2.frequency, t, f1 * 2, f1, 0.08);
    sh.chain(o2, sh.env(0.1, t, 0.004, 0.03));
    sh.chain(sh.noise('brown', t, 0.5), sh.filter('bandpass', 480 - 180 * size, 2.2), sh.env(0.55, t, 0.012, 0.07 + 0.05 * size));
    for (let i = 0; i < 3; i++) {
      const b = S.bank.bubble(180, 750);
      sh.grain(b?.buf, t + 0.02 + Math.random() * 0.13, rand(0.15, 0.3), rand(0.9, 1.1), rand(-0.3, 0.3));
    }
    return sh.done();
  },

  /** Combo chime while swallowing a big lake: rising major-pentatonic steps in key. */
  absorbChime(S, t, o = {}) {
    const deg = o.step ?? 0;
    const m = S.music ? S.music.keyNote(deg, 1) : 72 + deg * 2;
    const sh = new Shot(S, t, { gain: o.gain ?? 0.75, rev: 0.3 });
    inst.mallet(S.ac, sh.in, t, Math.min(m, 100), 0.65, { decay: 0.3 });
    inst.bell(S.ac, sh.in, t + 0.005, Math.min(m + 12, 108), 0.22, { decay: 0.5, ratio: 3.01, index: 1.2 });
    sh.end = t + 2.5;
    return sh.done();
  },

  /** A whole lake swallowed. */
  absorbDone(S, t, o = {}) {
    const size = clamp(o.size ?? 0.6);
    SFX.gulp(S, t, { size: 1, gain: 0.9 });
    const k = key(S);
    const sh = new Shot(S, t, { gain: 0.8, rev: 0.32 });
    [0, 4, 7, 12, 16].forEach((iv, i) => {
      inst.mallet(S.ac, sh.in, t + 0.07 + i * 0.055, k + 12 + iv, 0.55);
      inst.bell(S.ac, sh.in, t + 0.07 + i * 0.055, k + 24 + iv, 0.14, { decay: 0.6 });
    });
    const sv = S.bank.get('hatO');
    if (sv) sh.grain(sv, t + 0.3, 0.12 + 0.1 * size, 1.5, 0);
    sh.end = t + 3;
    return sh.done();
  },

  // ------------------------------------------------------------ combat --
  /** You cut a rival: slice + thump + V→I brass stab + sparkle. */
  cut(S, t) {
    const k = key(S);
    SFX.whoosh(S, t, { dur: 0.16, f0: 7500, f1: 1400, q: 2.2, gain: 0.6, pan0: -0.7, pan1: 0.7, type: 'white', peak: 0.3 });
    const sh = new Shot(S, t, { gain: 1, rev: 0.22 });
    const kick = S.bank.get('kick');
    if (kick) sh.grain(kick, t, 0.75, 1.15, 0);
    inst.brass(S.ac, sh.in, t + 0.02, [k + 7, k + 14], 0.08, 0.8, { bright: 1.2 });
    inst.brass(S.ac, sh.in, t + 0.12, [k + 12, k + 16, k + 19], 0.36, 0.95, { bright: 1.4 });
    [24, 28, 31, 36].forEach((iv, i) => inst.bell(S.ac, sh.in, t + 0.12 + i * 0.045, k + iv, 0.16, { decay: 0.45 }));
    sh.end = t + 2;
    return sh.done();
  },

  /** You got cut (and survived): thud + drain + falling dissonant stab. */
  cutBy(S, t) {
    const k = key(S);
    const sh = new Shot(S, t, { gain: 0.95, rev: 0.2 });
    const kick = S.bank.get('kick');
    if (kick) sh.grain(kick, t, 0.7, 0.72, 0);
    sh.chain(sh.noise('brown', t, 0.6), sh.filter('lowpass', 220, 0.8), sh.env(0.8, t, 0.004, 0.16));
    const pn = sh.noise('pink', t, 1.2);
    const lp = sh.filter('lowpass', 3200, 0.8);
    sweep(lp.frequency, t, 3200, 180, 0.75);
    sh.chain(pn, lp, sh.env(0.45, t, 0.02, 0.28));
    const f = sh.filter('lowpass', 1900, 1.5);
    sweep(f.frequency, t, 1900, 500, 0.5);
    const vca = sh.env(0.2, t, 0.01, 0.2, 0.08);
    f.connect(vca).connect(sh.in);
    for (const m of [k - 8, k - 7]) {
      for (const d of [-9, 9]) {
        const o = sh.osc('sawtooth', mtof(m), t, 0.9);
        o.detune.setValueAtTime(d, t);
        sweep(o.frequency, t + 0.04, mtof(m), mtof(m - 5), 0.45);
        o.connect(f);
      }
    }
    return sh.done();
  },

  /** A rival eliminated somewhere (spatial): fizzle + pop + sinking bubbles. */
  elimOther(S, t, o = {}) {
    const sp = spatial(S, o, { ref: 70, max: 3200 });
    if (sp && !sp.audible) return 0;
    const t0 = t + (sp ? sp.delay : 0);
    const g = (sp ? sp.gain : 0.5) * 0.85;
    if (g < 0.01) return 0;
    const sh = new Shot(S, t0, { gain: g, spatial: sp, rev: 0.3 });
    const w = sh.noise('white', t0, 0.8);
    const bp = sh.filter('bandpass', 3000, 1.4);
    sweep(bp.frequency, t0, 3200, 700, 0.4);
    sh.chain(w, bp, sh.env(0.45, t0, 0.01, 0.2));
    const o1 = sh.osc('sine', 260, t0, 0.5);
    sweep(o1.frequency, t0, 260, 70, 0.22);
    sh.chain(o1, sh.env(0.55, t0, 0.003, 0.09));
    for (let i = 0; i < 6; i++) {
      const b = S.bank.bubble(250 + 300 * (5 - i), 500 + 400 * (5 - i));
      sh.grain(b?.buf, t0 + 0.05 + i * 0.07, 0.25 - i * 0.03, 1, rand(-0.3, 0.3));
    }
    return sh.done();
  },

  /** Your elimination: everything drains and falls. */
  elimSelf(S, t) {
    const k = key(S);
    const sh = new Shot(S, t, { gain: 1, rev: 0.35 });
    const f = sh.filter('lowpass', 4200, 2);
    sweep(f.frequency, t, 4200, 160, 1.9);
    const vca = sh.env(0.24, t, 0.012, 0.65, 0.3);
    f.connect(vca).connect(sh.in);
    for (const m of [k - 3, k, k + 4]) {
      for (const d of [-11, 10]) {
        const o = sh.osc('sawtooth', mtof(m), t, 3);
        o.detune.setValueAtTime(d, t);
        sweep(o.frequency, t + 0.08, mtof(m), mtof(m) / 4, 1.9);
        o.connect(f);
      }
    }
    const sub = sh.osc('sine', 112, t, 2.6);
    sweep(sub.frequency, t, 112, 27, 1.7);
    sh.chain(sub, sh.env(0.75, t, 0.01, 0.55, 0.2));
    const pn = sh.noise('pink', t, 2.8);
    const lp = sh.filter('lowpass', 2600, 0.7);
    sweep(lp.frequency, t, 2600, 140, 1.6);
    sh.chain(pn, lp, sh.env(0.42, t, 0.04, 0.55, 0.1));
    for (let i = 0; i < 14; i++) {
      const dt = 0.08 * Math.pow(i, 1.35);
      const hi = 1800 - i * 110;
      const b = S.bank.bubble(hi * 0.4, hi);
      sh.grain(b?.buf, t + dt, 0.32 * (1 - i / 16), 1, rand(-0.4, 0.4));
    }
    return sh.done();
  },

  /** A rival reached the sea before you. */
  finishOther(S, t, o = {}) {
    const k = key(S);
    const sh = new Shot(S, t, { gain: 0.85 * (o.gain ?? 1), rev: 0.35, pan: rand(-0.3, 0.3) });
    inst.bell(S.ac, sh.in, t, k + 19, 0.4, { decay: 0.6, ratio: 3.5 });
    inst.bell(S.ac, sh.in, t + 0.16, k + 12, 0.35, { decay: 0.8, ratio: 3.5 });
    sh.end = t + 4;
    return sh.done();
  },

  // ------------------------------------------------------------ fireworks --
  /** Rocket whistle → boom → crackle. {x,y,z} = burst position; launch=false skips the rocket. */
  firework(S, t, o = {}) {
    const sp = spatial(S, o, { ref: 140, max: 6000 });
    if (sp && !sp.audible) return 0;
    const g = (sp ? Math.max(sp.gain, 0.12) : 0.6) * (o.gain ?? 1);
    const launch = o.launch !== false;
    const fly = launch ? rand(0.95, 1.3) : 0;
    if (launch) {
      const sh = new Shot(S, t, { gain: g * 0.9, spatial: sp, rev: 0.25 });
      const f0 = rand(650, 900);
      const wh = sh.osc('sine', f0, t, fly + 0.1);
      sweep(wh.frequency, t, f0, f0 * rand(2, 2.6), fly);
      const lfo = sh.osc('sine', rand(9, 14), t, fly + 0.1);
      const lg = sh.gainNode(f0 * 0.025);
      lfo.connect(lg).connect(wh.frequency);
      sh.chain(wh, sh.env(0.09, t, 0.12, 0.08, fly - 0.2));
      sh.chain(sh.noise('white', t, fly + 0.1), sh.filter('bandpass', 4200, 0.9), sh.env(0.16, t, 0.03, 0.1, fly - 0.15));
      sh.done();
    }
    const tb = t + fly + (sp ? sp.delay : 0);
    const size = o.size ?? 1;
    const sh = new Shot(S, tb, { gain: g, spatial: sp, rev: 0.55 });
    sh.chain(sh.noise('brown', tb, 1.5), sh.filter('lowpass', 950, 0.7), sh.env(1.1 * size, tb, 0.003, 0.32));
    sh.chain(sh.noise('pink', tb, 0.5), sh.filter('lowpass', 3800, 0.6), sh.env(0.55, tb, 0.001, 0.06));
    const sub = sh.osc('sine', 72, tb, 0.9);
    sweep(sub.frequency, tb, 72, 31, 0.35);
    sh.chain(sub, sh.env(0.7 * size, tb, 0.003, 0.22));
    const n = Math.round(rand(35, 70) * size);
    const basePan = sp ? sp.pan : 0;
    for (let i = 0; i < n; i++) {
      const dt = 0.25 + Math.pow(Math.random(), 0.8) * 1.9;
      sh.grain(S.bank.crackle(), tb + dt, rand(0.05, 0.22) * (1 - dt / 2.6), rand(0.8, 1.3), clamp(basePan + rand(-0.4, 0.4), -1, 1));
    }
    return sh.done() + fly;
  },

  // ------------------------------------------------------------------- UI --
  /** Water-drop "bloop" — the main button click. */
  click(S, t, o = {}) {
    const sh = new Shot(S, t, { bus: 'ui', gain: 0.6 * (o.gain ?? 1), rev: 0.05 });
    const f = o.pitch ?? 1;
    const o1 = sh.osc('sine', 520 * f, t, 0.15);
    sweep(o1.frequency, t, 520 * f, 1250 * f, 0.045);
    sh.chain(o1, sh.env(0.62, t, 0.002, 0.034));
    const o2 = sh.osc('triangle', 1040 * f, t, 0.1);
    sweep(o2.frequency, t, 1040 * f, 2500 * f, 0.04);
    sh.chain(o2, sh.env(0.12, t, 0.001, 0.018));
    sh.chain(sh.noise('white', t, 0.03), sh.filter('highpass', 5000, 0.7), sh.env(0.14, t, 0.0005, 0.004));
    return sh.done();
  },

  back(S, t) {
    const sh = new Shot(S, t, { bus: 'ui', gain: 0.55, rev: 0.05 });
    const o1 = sh.osc('sine', 1100, t, 0.16);
    sweep(o1.frequency, t, 1100, 480, 0.06);
    sh.chain(o1, sh.env(0.55, t, 0.002, 0.04));
    return sh.done();
  },

  hover(S, t) {
    const sh = new Shot(S, t, { bus: 'ui', gain: 0.6, rev: 0.03 });
    const o1 = sh.osc('sine', 1900, t, 0.08);
    sweep(o1.frequency, t, 1900, 2350, 0.03);
    sh.chain(o1, sh.env(0.14, t, 0.003, 0.016));
    return sh.done();
  },

  /** Purchase: two-note coin in key + metallic clinks + shimmer. */
  purchase(S, t) {
    const k = key(S);
    const sh = new Shot(S, t, { bus: 'ui', gain: 0.75, rev: 0.18 });
    const lp = sh.filter('lowpass', 6500, 0.7);
    lp.connect(sh.in);
    const n1 = sh.osc('square', mtof(k + 19), t, 0.1);
    n1.connect(sh.env(0.12, t, 0.002, 0.03, 0.06)).connect(lp);
    const n2 = sh.osc('square', mtof(k + 24), t + 0.08, 0.6);
    n2.connect(sh.env(0.12, t + 0.08, 0.002, 0.13, 0.05)).connect(lp);
    for (let i = 0; i < 6; i++) {
      const ti = t + 0.12 + i * rand(0.04, 0.07);
      const f = rand(2600, 5200);
      const c = sh.osc('sine', f, ti, 0.3);
      const m = sh.osc('sine', f * 1.414, ti, 0.3);
      const mg = sh.gainNode(f * 0.8);
      m.connect(mg).connect(c.frequency);
      sh.chain(c, sh.env(0.06, ti, 0.001, 0.05));
    }
    const sv = S.bank.get('hatO');
    if (sv) sh.grain(sv, t + 0.1, 0.18, 1.7, 0);
    inst.bell(S.ac, sh.in, t + 0.08, k + 31, 0.12, { decay: 0.5 });
    return sh.done();
  },

  /** One coin tick (counting up rewards). */
  coin(S, t, o = {}) {
    const k = key(S);
    const sh = new Shot(S, t, { bus: 'ui', gain: 0.5 * (o.gain ?? 1), rev: 0.1 });
    const lp = sh.filter('lowpass', 7000, 0.7);
    lp.connect(sh.in);
    const n = sh.osc('square', mtof(k + 24 + (o.step ?? 0) % 5), t, 0.2);
    n.connect(sh.env(0.15, t, 0.001, 0.05)).connect(lp);
    return sh.done();
  },

  /** Reward unlocked / daily gift: major arpeggio + pad swell + shimmer. */
  reward(S, t) {
    const k = key(S);
    const sh = new Shot(S, t, { bus: 'ui', gain: 0.8, rev: 0.3 });
    [0, 4, 7, 12, 16, 19].forEach((iv, i) => {
      inst.mallet(S.ac, sh.in, t + i * 0.07, k + iv, 0.55);
      inst.bell(S.ac, sh.in, t + i * 0.07, k + 12 + iv, 0.12, { decay: 0.7 });
    });
    inst.pad(S.ac, sh.in, t + 0.05, [k - 12, k - 5, k, k + 4, k + 7], 0.9, 0.7, { cutoff: 3000, attack: 0.25, rel: 1.2 });
    const hat = S.bank.get('hatO');
    if (hat) sh.grain(hat, t + 0.42, 0.15, 1.4, 0);
    sh.end = t + 3;
    return sh.done();
  },

  /** Countdown beep: n > 0 → short in-key tick, n = 0 → "GO!" chord. */
  countdown(S, t, o = {}) {
    const k = key(S);
    const n = o.n ?? o.value ?? 1;
    const sh = new Shot(S, t, { bus: 'ui', gain: 0.75, rev: 0.12 });
    if (n > 0) {
      inst.mallet(S.ac, sh.in, t, k + 7, 0.8, { decay: 0.18 });
      inst.bell(S.ac, sh.in, t, k + 19, 0.25, { decay: 0.25 });
    } else {
      inst.brass(S.ac, sh.in, t, [k, k + 4, k + 7, k + 12], 0.45, 0.9, { bright: 1.3 });
      inst.bell(S.ac, sh.in, t, k + 24, 0.25, { decay: 0.6 });
      const c = S.bank.get('crash');
      if (c) sh.grain(c, t, 0.25, 1, 0);
    }
    sh.end = t + 2.5;
    return sh.done();
  },

  error(S, t) {
    const sh = new Shot(S, t, { bus: 'ui', gain: 0.6, rev: 0.04 });
    const lp = sh.filter('lowpass', 1500, 0.8);
    lp.connect(sh.in);
    const a = sh.osc('square', 233, t, 0.12);
    a.connect(sh.env(0.16, t, 0.004, 0.03, 0.06)).connect(lp);
    const b = sh.osc('square', 207.7, t + 0.13, 0.2);
    b.connect(sh.env(0.16, t + 0.13, 0.004, 0.05, 0.08)).connect(lp);
    return sh.done();
  },

  notify(S, t) {
    const k = key(S);
    const sh = new Shot(S, t, { bus: 'ui', gain: 0.6, rev: 0.2 });
    inst.bell(S.ac, sh.in, t, k + 12, 0.3, { decay: 0.5 });
    inst.bell(S.ac, sh.in, t + 0.1, k + 19, 0.3, { decay: 0.7 });
    sh.end = t + 3;
    return sh.done();
  },

  equip(S, t) {
    SFX.whoosh(S, t, { dur: 0.3, f0: 600, f1: 4000, q: 1, gain: 0.35, bus: 'ui', pan0: 0, pan1: 0 });
    SFX.click(S, t + 0.18, { pitch: 1.25 });
    return 0.6;
  },

  open(S, t) {
    return SFX.whoosh(S, t, { dur: 0.25, f0: 500, f1: 2600, q: 0.9, gain: 0.42, bus: 'ui', pan0: -0.2, pan1: 0.2 });
  },

  close(S, t) {
    return SFX.whoosh(S, t, { dur: 0.22, f0: 2400, f1: 500, q: 0.9, gain: 0.38, bus: 'ui', pan0: 0.2, pan1: -0.2 });
  },
};

// friendly aliases for UI code
SFX.unlock = SFX.reward;
SFX.buy = SFX.purchase;
SFX.tick = SFX.hover;
SFX.go = (S, t) => SFX.countdown(S, t, { n: 0 });
