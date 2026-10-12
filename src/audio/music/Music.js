import { SONGS } from './songs.js';
import { SCALES, chordPcs, chordRoot, voiceLead } from './theory.js';
import * as inst from './instruments.js';
import { clamp } from '../engine/util.js';

/**
 * Adaptive music: a look-ahead 16th-note sequencer ("tale of two clocks") that
 * schedules synth notes slightly ahead of AudioContext time, so timing is
 * sample-accurate even when frames stutter.
 *
 *   music.play(name, { at })   switch song ('menu'|'drop'|'match'|'victory'|'defeat');
 *                              at: AudioContext time or 'now' | 'bar' (next bar line)
 *   music.stop(fade)
 *   music.intensity = 0..1     (match) drives vertical layers, quantized to bar lines
 *   music.build = 0..1         (drop) snare-roll / filter build towards the impact
 *   music.lift()               final-stretch key change (+2 semitones) with riser
 *   music.stinger(name)        'launch' | 'fanfare' — one-off musical cues
 *   music.update()             call often (every frame + a timer)
 *   music.keyNote(deg)         MIDI of a major-pentatonic degree in the current key
 *
 * Every song plays into its own "session" (channel strips + fade gains) so a
 * new song can start while the previous one's tails fade out independently.
 */

const CHANNELS = {
  pad: { level: 0.9, rev: 0.35, dly: 0 },
  bass: { level: 0.62, rev: 0.02, dly: 0 },
  pluck: { level: 0.9, rev: 0.16, dly: 0.3, pan: -0.08 },
  mallet: { level: 1, rev: 0.22, dly: 0.16, pan: 0.1 },
  bell: { level: 0.85, rev: 0.42, dly: 0.32 },
  lead: { level: 0.9, rev: 0.25, dly: 0.2 },
  brass: { level: 0.95, rev: 0.32, dly: 0 },
  strings: { level: 0.85, rev: 0.45, dly: 0 },
  kick: { level: 0.46, rev: 0.02, dly: 0 },
  snare: { level: 0.55, rev: 0.2, dly: 0 },
  hats: { level: 0.72, rev: 0.05, dly: 0, pan: 0.22 },
  perc: { level: 0.62, rev: 0.08, dly: 0, pan: -0.28 },
  fx: { level: 0.6, rev: 0.3, dly: 0 },
};
const DRUM_CH = {
  kick: 'kick',
  snare: 'snare',
  clap: 'snare',
  hatC: 'hats',
  hatO: 'hats',
  shaker: 'perc',
  rim: 'perc',
  tom: 'fx',
  crash: 'fx',
  revCrash: 'fx',
  timpani: 'fx',
};
const LAYER_TH = [0, 0.3, 0.55, 0.78];

/** sections: [[name, bars], ...]; after the last one, loop back to song.loopFrom. */
function sectionAt(song, bar) {
  const secs = song.sections;
  let b = bar;
  let i = 0;
  while (b >= secs[i][1]) {
    b -= secs[i][1];
    i++;
    if (i >= secs.length) i = song.loopFrom;
  }
  return { section: secs[i][0], sbar: b, len: secs[i][1] };
}

/** First bar of the named section (to start a song mid-way, e.g. skip the intro). */
function barOfSection(song, name) {
  let bar = 0;
  for (const [n, len] of song.sections) {
    if (n === name) return bar;
    bar += len;
  }
  return 0;
}

export class Music {
  constructor({ ac, mixer, bank, lite = false }) {
    this.ac = ac;
    this.mixer = mixer;
    this.bank = bank;
    this.lite = lite;
    this.lookahead = 0.22;
    this.cur = null;
    this.intensity = 0;
    this.build = 0;
    this.stingers = this.session(); // persistent session for one-off cues
  }

  // --- sessions / channel strips ------------------------------------------------

  session() {
    const ac = this.ac;
    const mk = (v, to) => {
      const g = ac.createGain();
      g.gain.value = v;
      g.connect(to);
      return g;
    };
    const s = {
      out: mk(1, this.mixer.music),
      rev: mk(1, this.mixer.musicRev),
      dly: mk(1, this.mixer.delayIn),
      ch: {},
    };
    for (const [name, c] of Object.entries(CHANNELS)) {
      const level = mk(c.level, s.out);
      let input = level;
      if (c.pan && ac.createStereoPanner) {
        const p = ac.createStereoPanner();
        p.pan.value = c.pan;
        p.connect(level);
        input = p;
      }
      s.ch[name] = { input, level };
      // sends
      if (c.rev) {
        const send = ac.createGain();
        send.gain.value = c.rev;
        level.connect(send).connect(s.rev);
      }
      if (c.dly) {
        const send = ac.createGain();
        send.gain.value = c.dly;
        level.connect(send).connect(s.dly);
      }
    }
    return s;
  }

  fadeSession(s, seconds, at = this.ac.currentTime) {
    for (const g of [s.out, s.rev, s.dly]) {
      g.gain.cancelScheduledValues(at);
      g.gain.setValueAtTime(g.gain.value, at);
      g.gain.setTargetAtTime(0, at, Math.max(seconds, 0.01) / 3);
    }
    setTimeout(() => {
      for (const g of [s.out, s.rev, s.dly]) g.disconnect();
    }, (seconds * 2 + (at - this.ac.currentTime) + 4) * 1000);
  }

  // --- transport --------------------------------------------------------------

  get playing() {
    return this.cur?.name ?? null;
  }

  play(name, { at = 'bar', layers = null, section = null } = {}) {
    const song = SONGS[name];
    if (!song) return;
    const now = this.ac.currentTime;
    let start = now + 0.06;
    if (typeof at === 'number') start = Math.max(at, now + 0.01);
    else if (at === 'bar' && this.cur) start = Math.max(this.nextBarTime(), now + 0.05);
    if (this.cur) this.fadeSession(this.cur.session, at === 'now' ? 0.25 : 0.6, Math.max(now, start - 0.15));
    this.mixer.setDelayTime((60 / song.bpm) * 0.75); // dotted eighth
    this.cur = {
      name,
      song,
      session: this.session(),
      stepDur: 60 / song.bpm / 4,
      nextTime: start,
      step: 0,
      bar: 0,
      layers: layers ?? (song.adaptive ? this.layerFor(this.intensity, 0) : 3),
      forcedLayers: layers,
      forcedBars: layers != null ? 4 : 0,
      transpose: 0,
      liftAt: -1,
      voicing: null,
    };
    if (section) {
      this.cur.bar = barOfSection(song, section);
      this.cur.step = this.cur.bar * 16;
    }
    this.prepareBar(this.cur);
  }

  stop(fade = 1) {
    if (!this.cur) return;
    this.lastKey = this.key; // stingers after the song keep its (possibly lifted) key
    this.fadeSession(this.cur.session, fade);
    this.cur = null;
  }

  nextBarTime() {
    const c = this.cur;
    if (!c) return this.ac.currentTime;
    const stepsLeft = (16 - (c.step % 16)) % 16;
    return c.nextTime + stepsLeft * c.stepDur;
  }

  /** Final-stretch key lift: riser during the next bar, +2 semitones after it. */
  lift() {
    const c = this.cur;
    if (!c || c.liftAt >= 0) return;
    c.liftAt = c.bar + 2;
  }

  layerFor(x, current) {
    let L = current;
    while (L < 3 && x > LAYER_TH[L + 1] + 0.03) L++;
    while (L > 0 && x < LAYER_TH[L] - 0.07) L--;
    return L;
  }

  get key() {
    const c = this.cur;
    return c ? c.song.key + c.transpose : this.lastKey ?? 67;
  }

  /** MIDI note for major-pentatonic degree `deg` above the current tonic (combo chimes). */
  keyNote(deg, octave = 0) {
    const sc = SCALES.majPent;
    const n = sc.length;
    const o = Math.floor(deg / n);
    return this.key + octave * 12 + o * 12 + sc[((deg % n) + n) % n];
  }

  prepareBar(c) {
    const song = c.song;
    // every section restarts the progression, so phrases always begin on the I chord
    const { section, sbar, len } = sectionAt(song, c.bar);
    const sym = song.progression[sbar % song.progression.length];
    const key = song.key + c.transpose;
    const pcs = chordPcs(key, sym);
    const inRange = (lo, hi) => {
      const out = [];
      for (let m = lo; m <= hi; m++) if (pcs.includes(((m % 12) + 12) % 12)) out.push(m);
      return out;
    };
    c.voicing = voiceLead(pcs.slice(0, 4), c.voicing, 52, 74);
    c.state = {
      t: 0,
      step: 0,
      bar: c.bar,
      sbar,
      slen: len,
      section,
      sym,
      pcs,
      voicing: c.voicing,
      root: chordRoot(key, sym, 40),
      arp: inRange(62, 81),
      high: inRange(79, 98),
      key,
      scale: sym.scale ?? SCALES.major,
      layers: c.layers,
      build: this.build,
      stepDur: c.stepDur,
    };
  }

  update() {
    const c = this.cur;
    if (!c) return;
    const now = this.ac.currentTime;
    if (c.nextTime < now - 0.2) {
      // fell behind (tab throttled, long frame): skip ahead instead of machine-gunning notes
      const missed = Math.ceil((now - c.nextTime) / c.stepDur);
      c.nextTime += missed * c.stepDur;
      c.step += missed;
      const newBar = Math.floor(c.step / 16);
      if (newBar !== c.bar) {
        c.bar = newBar;
        this.prepareBar(c);
      }
    }
    const horizon = now + this.lookahead;
    let guard = 64;
    while (c.nextTime < horizon && guard-- > 0) {
      const inBar = c.step % 16;
      if (inBar === 0) this.onBar(c);
      const swing = inBar % 2 ? c.song.swing * c.stepDur : 0;
      const s = c.state;
      s.t = c.nextTime + swing;
      s.step = inBar;
      s.build = this.build;
      try {
        c.song.step(this, s);
      } catch (e) {
        console.warn('[audio] music step failed', e);
      }
      c.nextTime += c.stepDur;
      c.step++;
    }
  }

  onBar(c) {
    c.bar = Math.floor(c.step / 16);
    if (c.song.adaptive) {
      if (c.forcedBars > 0) {
        c.forcedBars--;
        c.layers = Math.max(c.forcedLayers, this.layerFor(this.intensity, c.layers));
      } else {
        const prev = c.layers;
        c.layers = this.layerFor(this.intensity, c.layers);
        if (c.layers === 3 && prev < 3) this.drum('crash', c.nextTime, 0.42);
      }
      if (c.liftAt >= 0 && c.bar === c.liftAt - 1) this.riser(c, c.nextTime);
      if (c.liftAt >= 0 && c.bar === c.liftAt) {
        c.transpose += 2;
        c.layers = 3;
        c.forcedLayers = 3;
        c.forcedBars = 9999;
        this.drum('crash', c.nextTime, 0.6);
        this.drum('kick', c.nextTime, 1);
      }
    }
    this.prepareBar(c);
  }

  riser(c, t) {
    const bar = c.stepDur * 16;
    this.drum('revCrash', t, 0.5, { tail: bar });
    for (let i = 0; i < 16; i++) {
      const sub = i < 8 ? 2 : 1;
      if (i % sub) continue;
      this.drum('snare', t + i * c.stepDur, 0.25 + (i / 16) * 0.5);
      if (i >= 12) this.drum('snare', t + (i + 0.5) * c.stepDur, 0.3 + (i / 16) * 0.5);
    }
  }

  // --- instrument helpers used by songs.js (route into the current session) ----

  ch(name, sess) {
    return (sess ?? this.cur?.session ?? this.stingers).ch[name].input;
  }

  steps(n) {
    return n * (this.cur?.stepDur ?? 0.125);
  }

  pad(t, midis, steps, vel, o) {
    inst.pad(this.ac, this.ch('pad'), t, midis, this.steps(steps), vel, { lite: this.lite, ...o });
  }

  pluck(t, midi, vel, o) {
    inst.pluck(this.ac, this.ch('pluck'), t, midi, vel, { lite: this.lite, ...o });
  }

  bass(t, midi, steps, vel, o) {
    inst.bass(this.ac, this.ch('bass'), t, midi, this.steps(steps) * 0.92, vel, o);
  }

  mallet(t, midi, vel, o) {
    inst.mallet(this.ac, this.ch('mallet'), t, midi, vel, o);
  }

  bell(t, midi, vel, o) {
    if (this.lite && vel < 0.15) return;
    inst.bell(this.ac, this.ch('bell'), t, midi, vel, o);
  }

  lead(t, midi, steps, vel, o) {
    inst.lead(this.ac, this.ch('lead'), t, midi, this.steps(steps) * 0.95, vel, o);
  }

  drum(name, t, vel = 1, { rate = 1, tail, sess } = {}) {
    const buf = this.bank.get(name);
    if (!buf) return;
    const dest = this.ch(DRUM_CH[name] ?? 'fx', sess);
    if (tail != null) {
      // play only the last `tail` seconds so the swell peaks exactly at t + tail
      const offset = Math.max(0, buf.duration - tail);
      inst.sample(this.ac, dest, buf, t, { gain: vel, rate, offset });
    } else inst.sample(this.ac, dest, buf, t, { gain: vel, rate });
  }

  // --- stingers -----------------------------------------------------------------

  stinger(name, at = this.ac.currentTime + 0.03) {
    const S = this.stingers;
    const ac = this.ac;
    const key = this.key;
    if (name === 'launch') {
      // rising major-pentatonic sweep up into the sky
      const notes = [0, 2, 4, 7, 9, 12, 14, 16, 19, 24].map((d) => key - 12 + d);
      notes.forEach((m, i) => inst.bell(ac, S.ch.bell.input, at + i * 0.055, m + 12, 0.24, { decay: 0.6, ratio: 3.01, index: 1.6 }));
      inst.pad(ac, S.ch.pad.input, at, [key - 12, key - 5, key, key + 4, key + 7], 1.6, 0.5, { cutoff: 2600, attack: 0.5, rel: 1.6 });
      this.drum('revCrash', at, 0.35, { tail: 0.55, sess: S });
      this.drum('crash', at + 0.55, 0.32, { sess: S });
    } else if (name === 'fanfare') {
      this.fanfare(at);
    }
  }

  /**
   * Victory fanfare in the current key: I — bVI — bVII — I (the "heroic" borrowed
   * cadence), brass melody over brass/string chords, timpani, cymbal and a shower
   * of sparkles. ~6 s. Returns its duration.
   */
  fanfare(at) {
    const S = this.stingers;
    const ac = this.ac;
    const k = this.key; // tonic, octave 4 (G4 by default)
    const beat = 0.5; // 120 BPM
    const T = (b) => at + b * beat;
    const ch = (n) => S.ch[n].input;
    // chords (low brass + strings), voiced around the tonic
    const I = [k - 12, k - 8, k - 5, k];
    const bVI = [k - 13, k - 9, k - 4]; // Eb G Bb (in G)
    const bVII = [k - 11, k - 7, k - 2]; // F A C
    const Ibig = [k - 12, k - 8, k - 5, k, k + 4];
    inst.brass(ac, ch('brass'), T(0), I, beat * 3.8, 0.75);
    inst.strings(ac, ch('strings'), T(0), I.map((m) => m + 12), beat * 4, 0.5, { attack: 0.2 });
    inst.brass(ac, ch('brass'), T(4), bVI, beat * 1.9, 0.75);
    inst.strings(ac, ch('strings'), T(4), bVI.map((m) => m + 12), beat * 2, 0.55, { attack: 0.15 });
    inst.brass(ac, ch('brass'), T(6), bVII, beat * 1.9, 0.8);
    inst.strings(ac, ch('strings'), T(6), bVII.map((m) => m + 12), beat * 2, 0.6, { attack: 0.15 });
    inst.brass(ac, ch('brass'), T(8), Ibig, beat * 3.6, 0.95, { bright: 1.3 });
    inst.strings(ac, ch('strings'), T(8), Ibig.map((m) => m + 12), beat * 4.5, 0.7, { attack: 0.1 });
    // melody (lead brass, an octave above)
    const mel = [
      [0, 4, 0.5], [0.5, 7, 0.5], [1, 12, 1], [2, 16, 2],
      [4, 12, 1], [5, 15, 1], [6, 14, 1], [7, 17, 1], [8, 19, 3.5],
    ];
    for (const [b, iv, len] of mel) inst.brass(ac, ch('brass'), T(b), [k + iv], beat * len * 0.92, 0.85, { bright: 1.4 });
    // bass
    for (const [b, iv, len] of [[0, -24, 4], [4, -28, 2], [6, -26, 2], [8, -24, 3.5]]) {
      inst.bass(ac, ch('bass'), T(b), k + iv, beat * len * 0.95, 0.85, { bite: 0.4 });
    }
    // timpani (G2 sample re-pitched), roll into the final chord
    const timp = (b, semis, vel) => this.drum('timpani', T(b), vel, { rate: Math.pow(2, semis / 12), sess: S });
    const tk = k - 67; // sample is a G2 timpani; tonic two octaves below k
    timp(0, tk, 0.9);
    timp(4, tk - 4, 0.8);
    timp(6, tk - 2, 0.8);
    for (let i = 0; i < 8; i++) timp(7 + i * 0.125, tk - 2, 0.25 + i * 0.07);
    timp(8, tk, 1);
    this.drum('crash', T(8), 0.6, { sess: S });
    this.drum('revCrash', T(8) - 1.2, 0.3, { tail: 1.2, sess: S });
    this.drum('kick', T(8), 0.8, { sess: S });
    // sparkles
    const sparkle = [0, 4, 7, 12, 16, 19, 24, 28, 31, 36];
    sparkle.forEach((iv, i) => inst.bell(ac, ch('bell'), T(8) + i * 0.06, k + iv, 0.2, { decay: 0.8 }));
    for (let i = 0; i < 18; i++) {
      const iv = [0, 2, 4, 7, 9][i % 5] + 12 * (1 + (i % 3));
      inst.bell(ac, ch('bell'), T(9) + i * 0.13 + Math.random() * 0.05, k + iv, 0.1 + Math.random() * 0.08, { decay: 0.6 });
    }
    return beat * 12 + 1.5;
  }

  /** Adaptive intensity helper (clamped, used by AudioSystem). */
  setIntensity(x) {
    this.intensity = clamp(x);
  }

  setBuild(x) {
    this.build = clamp(x);
  }
}
