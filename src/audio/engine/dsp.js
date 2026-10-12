// Offline (JS) DSP used to synthesize sample buffers once at start-up: noise beds,
// water bubbles, droplets, drum kit, reverb impulse response. Runtime playback is
// then just AudioBufferSourceNodes — the cheapest thing WebAudio can do.

/** RBJ-cookbook biquad, direct form I. type: 'lp' | 'hp' | 'bp' | 'peak'. */
export class Biquad {
  constructor(type, freq, q = 0.707, sr = 48000, gainDb = 0) {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
    this.type = type;
    this.sr = sr;
    this.set(freq, q, gainDb);
  }

  set(freq, q = 0.707, gainDb = 0) {
    const w = (2 * Math.PI * Math.min(freq, this.sr * 0.49)) / this.sr;
    const cs = Math.cos(w);
    const sn = Math.sin(w);
    const alpha = sn / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    switch (this.type) {
      case 'hp':
        b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2;
        a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
        break;
      case 'bp':
        b0 = alpha; b1 = 0; b2 = -alpha;
        a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
        break;
      case 'peak': {
        const A = Math.pow(10, gainDb / 40);
        b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A;
        break;
      }
      default: // lp
        b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2;
        a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
  }

  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/** Paul Kellet's economy pink-noise filter state. */
export function pinkGen(rand) {
  let b0 = 0, b1 = 0, b2 = 0;
  return () => {
    const w = rand() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    return (b0 + b1 + b2 + w * 0.1848) * 0.25;
  };
}

/** Leaky-integrated (brown/red) noise. */
export function brownGen(rand) {
  let last = 0;
  return () => {
    const w = rand() * 2 - 1;
    last = (last + 0.02 * w) * 0.998;
    return last * 3.5;
  };
}

export function peakOf(data) {
  let p = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > p) p = a;
  }
  return p;
}

export function normalize(channels, target = 0.9) {
  let p = 0;
  for (const c of channels) p = Math.max(p, peakOf(c));
  if (p < 1e-9) return;
  const k = target / p;
  for (const c of channels) for (let i = 0; i < c.length; i++) c[i] *= k;
}

export function removeDC(data) {
  let m = 0;
  for (let i = 0; i < data.length; i++) m += data[i];
  m /= data.length;
  for (let i = 0; i < data.length; i++) data[i] -= m;
}

/** Make a loop seamless: crossfade the overshoot tail [n, n+fade) into the head. */
export function seamless(src, n, fade) {
  const out = new Float32Array(n);
  out.set(src.subarray(0, n));
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    const a = Math.sqrt(t); // equal-power-ish
    const b = Math.sqrt(1 - t);
    out[i] = src[i] * a + src[n + i] * b;
  }
  return out;
}

/** Short linear fades on both ends (no clicks when a grain starts/stops). */
export function fadeEdges(data, inSamples = 32, outSamples = 64) {
  for (let i = 0; i < inSamples && i < data.length; i++) data[i] *= i / inSamples;
  for (let i = 0; i < outSamples && i < data.length; i++) data[data.length - 1 - i] *= i / outSamples;
}
