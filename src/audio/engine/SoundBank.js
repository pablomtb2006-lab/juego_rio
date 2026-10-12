import { Biquad, pinkGen, brownGen, normalize, removeDC, seamless, fadeEdges } from './dsp.js';
import { rng } from './util.js';

/**
 * Synthesizes every sample buffer the game needs (no audio files exist).
 * Float32 data is cached per sample rate at module level, so building the bank
 * again for another context (e.g. OfflineAudioContext in tests) is free.
 *
 *   bank.get(name)            -> AudioBuffer | null  (null until generated)
 *   bank.bubble(fLo, fHi)     -> AudioBuffer of a single water bubble in that pitch range
 *   bank.droplet() / bank.crackle()
 *   bank.ready                -> Promise (all tasks done)
 *
 * Generation runs as small tasks separated by setTimeout(0) so unlocking audio
 * from a click never hitches a frame; the essential noise beds are built first.
 */
const CACHE = new Map(); // sampleRate -> Map(name -> { sr, channels: Float32Array[] , meta })

export class SoundBank {
  constructor(ac, { lite = false } = {}) {
    this.ac = ac;
    this.sr = ac.sampleRate;
    this.lite = lite;
    this.buffers = new Map();
    this.bubbles = []; // [{ buf, f0 }] sorted by f0
    this.droplets = [];
    this.crackles = [];
    if (!CACHE.has(this.sr)) CACHE.set(this.sr, new Map());
    this.cache = CACHE.get(this.sr);
    this.ready = this.build();
  }

  get(name) {
    return this.buffers.get(name) ?? null;
  }

  bubble(fLo = 300, fHi = 6000) {
    const list = this.bubbles;
    if (!list.length) return null;
    // binary-ish scan: list is short (≤ 48), linear is fine
    let lo = list.findIndex((b) => b.f0 >= fLo);
    if (lo < 0) lo = list.length - 1;
    let hi = lo;
    while (hi + 1 < list.length && list[hi + 1].f0 <= fHi) hi++;
    return list[lo + ((Math.random() * (hi - lo + 1)) | 0)];
  }

  droplet() {
    return this.droplets.length ? this.droplets[(Math.random() * this.droplets.length) | 0] : null;
  }

  crackle() {
    return this.crackles.length ? this.crackles[(Math.random() * this.crackles.length) | 0] : null;
  }

  // ---------------------------------------------------------------------------

  async build() {
    const tasks = [
      ['noise', () => this.genNoise()],
      ['mod', () => this.genMod()],
      ['bubbles', () => this.genBubbles()],
      ['droplets', () => this.genDroplets()],
      [
        'kit1',
        () => {
          this.genKick();
          this.genSnare();
          this.genClap();
        },
      ],
      [
        'kit2',
        () => {
          this.genHats();
          this.genShaker();
          this.genTom();
          this.genRim();
        },
      ],
      ['crash', () => this.genCrash()],
      ['timpani', () => this.genTimpani()],
      ['crackles', () => this.genCrackles()],
      ['ir', () => this.genIR()],
    ];
    for (const [, fn] of tasks) {
      fn();
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  /** Get-or-create cached channel data, wrap it in an AudioBuffer of this context. */
  make(name, gen, sr = this.sr) {
    let entry = this.cache.get(name);
    if (!entry) {
      const channels = gen(sr);
      entry = { sr, channels };
      this.cache.set(name, entry);
    }
    const buf = this.ac.createBuffer(entry.channels.length, entry.channels[0].length, entry.sr);
    entry.channels.forEach((c, i) => buf.copyToChannel(c, i));
    this.buffers.set(name, buf);
    return buf;
  }

  genNoise() {
    const fade = Math.floor(this.sr * 0.15);
    const loop = (n, gen) => {
      const raw = new Float32Array(n + fade);
      for (let i = 0; i < raw.length; i++) raw[i] = gen();
      return seamless(raw, n, fade);
    };
    this.make('white', (sr) => {
      const r = rng(11);
      return [0, 1].map(() => {
        const d = loop(Math.floor(sr * 2.5), () => r() * 2 - 1);
        normalize([d], 0.7);
        return d;
      });
    });
    this.make('pink', (sr) => {
      const r = rng(23);
      return [0, 1].map(() => {
        const g = pinkGen(r);
        const d = loop(Math.floor(sr * 4.1), g);
        removeDC(d);
        normalize([d], 0.8);
        return d;
      });
    });
    this.make('brown', (sr) => {
      const r = rng(37);
      return [0, 1].map(() => {
        const g = brownGen(r);
        const hp = new Biquad('hp', 18, 0.6, sr);
        for (let i = 0; i < sr; i++) hp.process(g()); // settle
        const d = loop(Math.floor(sr * 5.3), () => hp.process(g()));
        removeDC(d);
        normalize([d], 0.85);
        return d;
      });
    });
  }

  /** Slow smooth random curve (≈1.5 Hz bandwidth at playbackRate 1), ±1, for LFO-style modulation. */
  genMod() {
    this.make(
      'mod',
      (sr) => {
        const r = rng(5);
        const n = sr * 30;
        const fade = sr * 2;
        const raw = new Float32Array(n + fade);
        const lp1 = new Biquad('lp', 1.5, 0.6, sr);
        const lp2 = new Biquad('lp', 1.5, 0.6, sr);
        for (let i = 0; i < sr * 4; i++) lp2.process(lp1.process(r() * 2 - 1));
        for (let i = 0; i < raw.length; i++) raw[i] = lp2.process(lp1.process(r() * 2 - 1));
        const d = seamless(raw, n, fade);
        removeDC(d);
        normalize([d], 1);
        return [d];
      },
      4000,
    );
  }

  /**
   * Van den Doel's bubble model: a damped sine whose pitch rises as the bubble
   * reaches the surface. f0 = 3/r, damping grows for tiny bubbles. Many of these,
   * randomly overlapped, is what makes running water sound "wet" instead of hissy.
   */
  genBubbles() {
    const count = this.lite ? 24 : 40;
    for (let k = 0; k < count; k++) {
      const r = rng(77 + k * 13 + count);
      // log-uniform radius 0.6 mm .. 14 mm  → f0 ≈ 5 kHz .. 215 Hz
      const radius = 0.0006 * Math.pow(14 / 0.6, k / (count - 1)) * (0.95 + r() * 0.1);
      const f0 = 3 / radius;
      const xi = 0.12 + r() * 0.1;
      const name = `bubble${count}_${k}`;
      const buf = this.make(name, (sr) => {
        const damp = (0.13 / radius + 0.0072 * Math.pow(radius, -1.5)) * 0.55; // a bit longer = more "plink"
        const dur = Math.min(0.5, 6.5 / damp + 0.004);
        const n = Math.floor(dur * sr);
        const d = new Float32Array(n);
        let ph = 0;
        const att = Math.floor(sr * 0.0015);
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          const f = f0 * (1 + xi * damp * t);
          ph += (2 * Math.PI * f) / sr;
          const env = Math.exp(-damp * t) * (i < att ? i / att : 1);
          d[i] = Math.sin(ph) * env;
        }
        fadeEdges(d, 8, 32);
        normalize([d], 0.9);
        return [d];
      });
      this.bubbles.push({ buf, f0 });
    }
    this.bubbles.sort((a, b) => a.f0 - b.f0);
  }

  /** Rain drop on water: broadband tick + a small high bubble right after. */
  genDroplets() {
    const r = rng(91);
    const count = this.lite ? 8 : 16;
    for (let k = 0; k < count; k++) {
      const buf = this.make(`drop${k}`, (sr) => {
        const n = Math.floor(sr * 0.06);
        const d = new Float32Array(n);
        const hp = new Biquad('hp', 2500 + r() * 2500, 0.7, sr);
        const bp = new Biquad('bp', 3000 + r() * 4000, 1.4, sr);
        const tauClick = 0.0012 + r() * 0.0015;
        const bubR = 0.0008 + r() * 0.0014;
        const f0 = 3 / bubR;
        const delay = Math.floor((0.002 + r() * 0.006) * sr);
        const bDamp = 0.13 / bubR + 0.0072 * Math.pow(bubR, -1.5);
        const bAmp = 0.3 + r() * 0.5;
        let ph = 0;
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          const click = (r() * 2 - 1) * Math.exp(-t / tauClick);
          let v = bp.process(hp.process(click)) * 1.6;
          if (i >= delay) {
            const tb = (i - delay) / sr;
            ph += (2 * Math.PI * f0 * (1 + 0.15 * bDamp * tb)) / sr;
            v += Math.sin(ph) * Math.exp(-bDamp * tb) * bAmp;
          }
          d[i] = v;
        }
        fadeEdges(d, 4, 64);
        normalize([d], 0.9);
        return [d];
      });
      this.droplets.push(buf);
    }
  }

  /** Firework crackle grains: tiny resonant pops. */
  genCrackles() {
    const r = rng(131);
    for (let k = 0; k < 12; k++) {
      const buf = this.make(`crackle${k}`, (sr) => {
        const n = Math.floor(sr * 0.025);
        const d = new Float32Array(n);
        const bp = new Biquad('bp', 1800 + r() * 5000, 1.5 + r() * 2, sr);
        const tau = 0.0015 + r() * 0.003;
        for (let i = 0; i < n; i++) d[i] = bp.process((r() * 2 - 1) * Math.exp(-i / sr / tau));
        fadeEdges(d, 2, 32);
        normalize([d], 0.9);
        return [d];
      });
      this.crackles.push(buf);
    }
  }

  // --- drum kit ------------------------------------------------------------

  genKick() {
    this.make('kick', (sr) => {
      const r = rng(201);
      const n = Math.floor(sr * 0.65);
      const d = new Float32Array(n);
      const hp = new Biquad('hp', 1800, 0.7, sr);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const f = 46 + 120 * Math.exp(-t / 0.032) + 30 * Math.exp(-t / 0.004);
        ph += (2 * Math.PI * f) / sr;
        const body = Math.sin(ph) * Math.exp(-t / 0.32) * Math.min(1, i / (sr * 0.0015));
        const click = hp.process(r() * 2 - 1) * Math.exp(-t / 0.004) * 0.5;
        d[i] = Math.tanh((body + click) * 1.6);
      }
      fadeEdges(d, 2, 256);
      normalize([d], 0.95);
      return [d];
    });
  }

  genSnare() {
    this.make('snare', (sr) => {
      const r = rng(211);
      const n = Math.floor(sr * 0.45);
      const L = new Float32Array(n);
      const R = new Float32Array(n);
      const hpL = new Biquad('hp', 1400, 0.7, sr), hpR = new Biquad('hp', 1400, 0.7, sr);
      const lpL = new Biquad('lp', 9000, 0.7, sr), lpR = new Biquad('lp', 9000, 0.7, sr);
      const pk = new Biquad('peak', 5200, 1.2, sr, 5);
      let p1 = 0, p2 = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        p1 += (2 * Math.PI * (190 + 40 * Math.exp(-t / 0.01))) / sr;
        p2 += (2 * Math.PI * 340) / sr;
        const tone = (Math.sin(p1) * 0.8 + Math.sin(p2) * 0.4) * Math.exp(-t / 0.055);
        const envN = Math.exp(-t / 0.14) * Math.min(1, i / (sr * 0.001));
        const nl = pk.process(lpL.process(hpL.process(r() * 2 - 1))) * envN;
        const nr = lpR.process(hpR.process(r() * 2 - 1)) * envN;
        L[i] = tone * 0.7 + nl;
        R[i] = tone * 0.7 + nr;
      }
      fadeEdges(L, 2, 256);
      fadeEdges(R, 2, 256);
      normalize([L, R], 0.9);
      return [L, R];
    });
  }

  genClap() {
    this.make('clap', (sr) => {
      const r = rng(221);
      const n = Math.floor(sr * 0.5);
      const chans = [0, 1].map((c) => {
        const d = new Float32Array(n);
        const bp = new Biquad('bp', 1150 + c * 120, 1.6, sr);
        const hp = new Biquad('hp', 500, 0.7, sr);
        const bursts = [0, 0.011, 0.022, 0.031].map((b) => b + c * 0.0017);
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          let env = 0;
          for (let k = 0; k < bursts.length; k++) {
            const tb = t - bursts[k];
            if (tb >= 0) env += k === bursts.length - 1 ? Math.exp(-tb / 0.12) : Math.exp(-tb / 0.006);
          }
          d[i] = hp.process(bp.process((r() * 2 - 1) * env)) * 2.2;
        }
        fadeEdges(d, 2, 256);
        return d;
      });
      normalize(chans, 0.85);
      return chans;
    });
  }

  /** 808-style metallic source: six detuned squares (inharmonic ratios). */
  metal(sr, n, base, r) {
    const ratios = [2, 3, 4.16, 5.43, 6.79, 8.21];
    const ph = ratios.map(() => r());
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let k = 0; k < 6; k++) {
        ph[k] += (base * ratios[k]) / sr;
        v += ph[k] % 1 < 0.5 ? 1 : -1;
      }
      d[i] = v / 6;
    }
    return d;
  }

  genHats() {
    const hat = (name, tau, len, seed) =>
      this.make(name, (sr) => {
        const r = rng(seed);
        const n = Math.floor(sr * len);
        const chans = [0, 1].map((c) => {
          const m = this.metal(sr, n, 40 + c * 0.7, r);
          const hp1 = new Biquad('hp', 7000, 0.7, sr), hp2 = new Biquad('hp', 7000, 0.7, sr);
          const pk = new Biquad('peak', 10000, 1, sr, 4);
          const d = new Float32Array(n);
          for (let i = 0; i < n; i++) {
            const t = i / sr;
            const env = Math.exp(-t / tau) * Math.min(1, i / (sr * 0.0007));
            d[i] = pk.process(hp2.process(hp1.process(m[i] * 0.7 + (r() * 2 - 1) * 0.45))) * env;
          }
          fadeEdges(d, 2, 128);
          return d;
        });
        normalize(chans, 0.8);
        return chans;
      });
    hat('hatC', 0.028, 0.14, 231);
    hat('hatO', 0.24, 0.7, 233);
  }

  genShaker() {
    this.make('shaker', (sr) => {
      const r = rng(241);
      const n = Math.floor(sr * 0.16);
      const d = new Float32Array(n);
      const bp = new Biquad('bp', 6500, 1.1, sr);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const env = t < 0.012 ? t / 0.012 : Math.exp(-(t - 0.012) / 0.035);
        d[i] = bp.process(r() * 2 - 1) * env;
      }
      fadeEdges(d, 2, 128);
      normalize([d], 0.8);
      return [d];
    });
  }

  genTom() {
    this.make('tom', (sr) => {
      const r = rng(251);
      const n = Math.floor(sr * 0.6);
      const d = new Float32Array(n);
      const lp = new Biquad('lp', 3000, 0.7, sr);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        ph += (2 * Math.PI * (105 + 70 * Math.exp(-t / 0.06))) / sr;
        d[i] = Math.sin(ph) * Math.exp(-t / 0.22) + lp.process(r() * 2 - 1) * Math.exp(-t / 0.02) * 0.3;
      }
      fadeEdges(d, 2, 256);
      normalize([d], 0.9);
      return [d];
    });
  }

  genRim() {
    this.make('rim', (sr) => {
      const r = rng(261);
      const n = Math.floor(sr * 0.08);
      const d = new Float32Array(n);
      const bp = new Biquad('bp', 1900, 4, sr);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        ph += (2 * Math.PI * 520) / sr;
        d[i] = bp.process((r() * 2 - 1) * Math.exp(-t / 0.004)) * 3 + Math.sin(ph) * Math.exp(-t / 0.012) * 0.6;
      }
      fadeEdges(d, 2, 64);
      normalize([d], 0.8);
      return [d];
    });
  }

  genCrash() {
    const crash = this.make('crash', (sr) => {
      const r = rng(271);
      const n = Math.floor(sr * (this.lite ? 2.2 : 3.2));
      const chans = [0, 1].map((c) => {
        const m = this.metal(sr, n, 52 + c * 1.3, r);
        const m2 = this.metal(sr, n, 71.3 - c * 0.9, r);
        const hp = new Biquad('hp', 3200, 0.6, sr);
        const hp2 = new Biquad('hp', 2500, 0.6, sr);
        const pk = new Biquad('peak', 7500, 0.8, sr, 5);
        const lp = new Biquad('lp', 14000, 0.6, sr);
        const d = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          const env = (Math.exp(-t / 0.75) * 0.85 + Math.exp(-t / 0.07) * 0.6) * Math.min(1, i / (sr * 0.0015));
          const src = m[i] * 0.45 + m2[i] * 0.35 + (r() * 2 - 1) * 0.6;
          d[i] = lp.process(pk.process(hp2.process(hp.process(src)))) * env;
        }
        fadeEdges(d, 2, 2048);
        return d;
      });
      normalize(chans, 0.8);
      return chans;
    });
    // reversed crash: the classic "swell into the downbeat"
    this.make('revCrash', () => {
      const chans = [0, 1].map((c) => {
        const src = crash.getChannelData(c);
        const n = Math.floor(src.length * 0.7);
        const d = new Float32Array(n);
        for (let i = 0; i < n; i++) d[i] = src[n - 1 - i];
        fadeEdges(d, 512, 64);
        return d;
      });
      return chans;
    });
  }

  /** Orchestral timpani (G2) for fanfares; pitch others with playbackRate. */
  genTimpani() {
    this.make('timpani', (sr) => {
      const r = rng(281);
      const n = Math.floor(sr * 2.4);
      const d = new Float32Array(n);
      const lp = new Biquad('lp', 900, 0.7, sr);
      const f = 98;
      const partials = [
        [1, 1, 0.9],
        [1.5, 0.5, 0.6],
        [1.98, 0.35, 0.45],
        [2.44, 0.2, 0.35],
        [2.9, 0.12, 0.25],
      ];
      const ph = partials.map(() => 0);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        let v = 0;
        const glide = 1 + 0.03 * Math.exp(-t / 0.08);
        for (let k = 0; k < partials.length; k++) {
          const [ratio, amp, tau] = partials[k];
          ph[k] += (2 * Math.PI * f * ratio * glide) / sr;
          v += Math.sin(ph[k]) * amp * Math.exp(-t / tau);
        }
        const mallet = lp.process(r() * 2 - 1) * Math.exp(-t / 0.012) * 0.8;
        d[i] = (v + mallet) * Math.min(1, i / (sr * 0.002));
      }
      fadeEdges(d, 2, 1024);
      normalize([d], 0.9);
      return [d];
    });
  }

  /**
   * "Open valley" impulse response: short pre-delay, sparse early reflections,
   * a diffuse tail that darkens as it decays, and two faint late echoes from
   * the mountain walls.
   */
  genIR() {
    const lite = this.lite;
    this.make(lite ? 'irLite' : 'ir', (sr) => {
      const r = rng(301);
      const len = lite ? 1.4 : 2.6;
      const n = Math.floor(sr * len);
      const pre = Math.floor(sr * 0.014);
      const chans = [0, 1].map((c) => {
        const d = new Float32Array(n);
        // diffuse tail: bright part decays fast, dark part slow
        const lp = new Biquad('lp', 2200, 0.6, sr);
        const lp2 = new Biquad('lp', 5000, 0.6, sr);
        const t60b = lite ? 0.6 : 0.9;
        const t60d = lite ? 1.2 : 2.1;
        for (let i = pre; i < n; i++) {
          const t = (i - pre) / sr;
          const w = r() * 2 - 1;
          const bright = lp2.process(w) * Math.exp((-6.9 * t) / t60b);
          const dark = lp.process(w) * Math.exp((-6.9 * t) / t60d) * 1.3;
          const fadeIn = Math.min(1, t / 0.035);
          d[i] = (bright * 0.6 + dark) * fadeIn * 0.5;
        }
        // early reflections
        for (let k = 0; k < 12; k++) {
          const at = pre + Math.floor(sr * (0.006 + r() * 0.085));
          const g = (0.25 + r() * 0.45) * (r() < 0.5 ? -1 : 1) * ((k + c) % 2 ? 1 : 0.6);
          if (at < n) d[at] += g;
        }
        // late mountain echoes (lowpassed clusters)
        if (!lite) {
          for (const [time, gain] of [
            [0.31 + c * 0.023, 0.09],
            [0.57 + c * 0.031, 0.05],
          ]) {
            const start = Math.floor(sr * time);
            const ec = new Biquad('lp', 1400, 0.7, sr);
            for (let i = 0; i < sr * 0.05 && start + i < n; i++) {
              const t = i / sr;
              d[start + i] += ec.process((r() * 2 - 1) * Math.exp(-t / 0.012)) * gain * 6;
            }
          }
        }
        fadeEdges(d, 0, 4096);
        return d;
      });
      normalize(chans, 0.9);
      return chans;
    });
    this.buffers.set('reverb', this.get(lite ? 'irLite' : 'ir'));
  }
}
