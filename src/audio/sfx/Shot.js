import { clamp } from '../engine/util.js';

/**
 * Builder for one-shot sound graphs. A Shot owns an output strip
 *   input ─► [air low-pass] ─► [stereo pan] ─► bus      (+ reverb send)
 * and helpers to hang noise / oscillator / grain sources on it. Every node it
 * creates is disconnected after `done()` + the shot's length, so one-shots
 * never leak.
 */
export class Shot {
  constructor(S, t, { bus = 'sfx', gain = 1, pan = 0, rev = 0.15, air = 0, spatial = null } = {}) {
    this.S = S;
    this.ac = S.ac;
    this.t = t;
    this.nodes = [];
    this.end = t;
    const ac = this.ac;
    const m = S.mixer;
    this.in = this.gainNode(gain);
    let tail = this.in;
    let lpf = air;
    let p = pan;
    let revAmt = rev;
    if (spatial) {
      lpf = spatial.lpf < 19000 ? spatial.lpf : 0;
      p = spatial.pan;
      // distant sounds are relatively wetter (more reverb than direct sound)
      revAmt = rev * clamp(0.6 + spatial.dist / 600, 0.6, 2.2);
    }
    if (lpf) {
      const f = this.filter('lowpass', lpf, 0.5);
      tail.connect(f);
      tail = f;
    }
    if (p && ac.createStereoPanner) {
      const pn = ac.createStereoPanner();
      pn.pan.value = clamp(p, -1, 1);
      this.nodes.push(pn);
      tail.connect(pn);
      tail = pn;
    }
    tail.connect(bus === 'ui' ? m.ui : bus === 'music' ? m.music : m.sfx);
    if (revAmt > 0) {
      const send = this.gainNode(revAmt);
      tail.connect(send);
      send.connect(bus === 'ui' ? m.uiRev : m.sfxRev);
    }
  }

  gainNode(v = 0) {
    const g = this.ac.createGain();
    g.gain.value = v;
    this.nodes.push(g);
    return g;
  }

  filter(type, freq, q = 0.707) {
    const f = this.ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    this.nodes.push(f);
    return f;
  }

  /** Looping noise bed ('white' | 'pink' | 'brown') from t0 for dur seconds. */
  noise(type, t0, dur, rate = 1) {
    const buf = this.S.bank.get(type);
    if (!buf) return null;
    const src = this.ac.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = rate;
    src.start(t0, Math.random() * (buf.duration - 0.2));
    src.stop(t0 + dur);
    this.nodes.push(src);
    this.end = Math.max(this.end, t0 + dur);
    return src;
  }

  osc(type, freq, t0, dur) {
    const o = this.ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    o.start(t0);
    o.stop(t0 + dur);
    this.nodes.push(o);
    this.end = Math.max(this.end, t0 + dur);
    return o;
  }

  /** Percussive VCA: linear attack a, exponential decay with time constant tau. */
  env(peak, t0, a, tau, hold = 0) {
    const g = this.gainNode(0);
    const p = g.gain;
    p.setValueAtTime(0, t0);
    p.linearRampToValueAtTime(peak, t0 + Math.max(a, 0.001));
    if (hold > 0) p.setValueAtTime(peak, t0 + a + hold);
    p.setTargetAtTime(0, t0 + a + hold, tau);
    this.end = Math.max(this.end, t0 + a + hold + tau * 6);
    return g;
  }

  /** Connect a chain of nodes ending in the shot input. */
  chain(...nodes) {
    if (nodes.some((n) => !n)) return null; // a buffer wasn't generated yet: skip this layer
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    nodes[nodes.length - 1].connect(this.in);
    return nodes[0];
  }

  /** One sample grain (bubble, droplet, crackle) with its own gain / pan. */
  grain(buf, t0, gain = 1, rate = 1, pan = 0) {
    if (!buf) return;
    const ac = this.ac;
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ac.createGain();
    g.gain.value = gain;
    src.connect(g);
    if (pan && ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      g.connect(p).connect(this.in);
      this.nodes.push(p);
    } else g.connect(this.in);
    src.start(t0);
    this.nodes.push(src, g);
    this.end = Math.max(this.end, t0 + buf.duration / rate);
  }

  /** Schedule cleanup once everything has finished. */
  done() {
    const { ac, nodes, end } = this;
    const input = this.in;
    const check = () => {
      // context time stands still while suspended: wait until the sound really ended
      const left = end + 1 - ac.currentTime;
      if (left > 0 && ac.state !== 'closed') {
        setTimeout(check, Math.max(left * 1000, 250));
        return;
      }
      input.disconnect();
      for (const n of nodes) n.disconnect();
    };
    setTimeout(check, Math.max((end - ac.currentTime + 1) * 1000, 100));
    return end - this.t;
  }
}
