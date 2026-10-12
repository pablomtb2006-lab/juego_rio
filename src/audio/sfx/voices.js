import { Smooth, clamp, rand, mtof } from '../engine/util.js';

/**
 * Continuous, parameter-driven voices. Each builds its node graph on start()
 * and tears it down after stop() fades out, so nothing runs while inaudible.
 * All parameter changes go through Smooth (setTargetAtTime) → no zipper noise.
 *
 *   voice.start()  voice.stop(fade)  voice.set({...}, now)  voice.tick(dt, now)
 */
class Voice {
  constructor(S, { bus = 'sfx', rev = 0.1, fadeIn = 0.4 } = {}) {
    this.S = S;
    this.ac = S.ac;
    this.bus = bus;
    this.rev = rev;
    this.fadeIn = fadeIn;
    this.on = false;
  }

  start() {
    if (this.on) return;
    this.on = true;
    const ac = this.ac;
    const m = this.S.mixer;
    this.nodes = [];
    this.sources = [];
    this.out = ac.createGain();
    this.out.gain.value = 0;
    this.out.connect(this.bus === 'music' ? m.music : m.sfx);
    if (this.rev > 0) {
      const send = this.g(this.rev);
      this.out.connect(send);
      send.connect(m.sfxRev);
    }
    this.p = {};
    this.build();
    this.out.gain.setTargetAtTime(1, ac.currentTime, this.fadeIn / 3);
  }

  stop(fade = 0.5) {
    if (!this.on) return;
    this.on = false;
    const ac = this.ac;
    const { out, nodes, sources } = this;
    out.gain.cancelScheduledValues(ac.currentTime);
    out.gain.setTargetAtTime(0, ac.currentTime, Math.max(fade, 0.02) / 3);
    const end = ac.currentTime + fade * 1.5 + 0.1;
    for (const s of sources) {
      try {
        s.stop(end);
      } catch {
        /* not started */
      }
    }
    const check = () => {
      if (ac.currentTime < end && ac.state !== 'closed') {
        setTimeout(check, 250);
        return;
      }
      out.disconnect();
      for (const n of nodes) n.disconnect();
    };
    setTimeout(check, (fade * 1.5 + 0.3) * 1000);
  }

  // graph helpers ---------------------------------------------------------------
  g(v = 0) {
    const n = this.ac.createGain();
    n.gain.value = v;
    this.nodes.push(n);
    return n;
  }

  f(type, freq, q = 0.707) {
    const n = this.ac.createBiquadFilter();
    n.type = type;
    n.frequency.value = freq;
    n.Q.value = q;
    this.nodes.push(n);
    return n;
  }

  noise(type, rate = 1) {
    const buf = this.S.bank.get(type);
    const src = this.ac.createBufferSource();
    if (buf) {
      src.buffer = buf;
      src.loop = true;
    }
    src.playbackRate.value = rate;
    src.start(this.ac.currentTime, buf ? Math.random() * (buf.duration - 0.5) : 0);
    this.sources.push(src);
    this.nodes.push(src);
    return src;
  }

  /** Slow random modulation source (±1). rate 1 ≈ 1.5 Hz wobble. */
  mod(rate) {
    return this.noise('mod', rate);
  }

  /** gain node whose gain = base (smoothed) + mod·depth (smoothed). */
  amGain(modSrc, base = 0, depth = 0) {
    const g = this.g(0);
    const d = this.g(0);
    if (modSrc) modSrc.connect(d).connect(g.gain);
    return { node: g, base: new Smooth(g.gain, base), depth: new Smooth(d.gain, depth) };
  }

  grain(buf, t, gain, rate, pan, dest = this.out) {
    if (!buf || !this.on) return;
    const ac = this.ac;
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ac.createGain();
    g.gain.value = gain;
    src.connect(g);
    let tail = g;
    if (pan && ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      g.connect(p);
      tail = p;
    }
    tail.connect(dest);
    src.onended = () => {
      g.disconnect();
      if (tail !== g) tail.disconnect();
    };
    src.start(t);
  }
}

/** Poisson-ish grain clock: returns how many grains to emit this frame. */
function grains(state, rate, dt, cap = 6) {
  state.acc = (state.acc ?? 0) + rate * dt;
  let n = Math.floor(state.acc);
  state.acc -= n;
  if (Math.random() < state.acc * 0.15) n++; // jitter
  return Math.min(n, cap);
}

// =============================================================================
/**
 * The player's river: rumble (brown, 2-pole LP) + wash (pink band) + fizz
 * (white HP, flutter) + rapids (choppy band) + surge whoosh + bubble grains.
 * set({ speed 0..1, size 0..1, slope 0..1, foam 0..1, surge 0|1, level 0..1 })
 */
export class RiverVoice extends Voice {
  constructor(S) {
    super(S, { rev: 0.08, fadeIn: 0.6 });
    this.grainState = {};
    this.params = { speed: 0, size: 0, slope: 0, foam: 0, surge: 0, level: 1 };
  }

  build() {
    const p = this.p;
    // rumble
    const br = this.noise('brown');
    const rumbleHP = this.f('highpass', 38, 0.6); // keep sub-sonic mud out of the mix
    p.rumbleLP1 = this.f('lowpass', 220, 0.5);
    p.rumbleLP2 = this.f('lowpass', 220, 0.75);
    const rg = this.amGain(this.mod(0.35), 0, 0);
    br.connect(rumbleHP).connect(p.rumbleLP1).connect(p.rumbleLP2).connect(rg.node).connect(this.out);
    p.rumble = rg;
    p.rumbleF1 = new Smooth(p.rumbleLP1.frequency, 220, 1e-3);
    p.rumbleF2 = new Smooth(p.rumbleLP2.frequency, 220, 1e-3);
    // wash
    const pk = this.noise('pink', rand(0.97, 1.03));
    p.washBP = this.f('bandpass', 600, 0.55);
    const wg = this.amGain(this.mod(0.22), 0, 0);
    pk.connect(p.washBP).connect(wg.node).connect(this.out);
    p.wash = wg;
    p.washF = new Smooth(p.washBP.frequency, 600, 1e-3);
    // fizz
    const wh = this.noise('white');
    p.fizzHP = this.f('highpass', 4200, 0.6);
    const fizzLP = this.f('lowpass', 12000, 0.5);
    const fg = this.amGain(this.mod(3.2), 0, 0);
    wh.connect(p.fizzHP).connect(fizzLP).connect(fg.node).connect(this.out);
    p.fizz = fg;
    p.fizzF = new Smooth(p.fizzHP.frequency, 4200, 1e-3);
    // rapids (choppy)
    const pk2 = this.noise('pink', rand(1.05, 1.12));
    p.rapBP = this.f('bandpass', 1600, 1.1);
    const rpg = this.amGain(this.mod(7.5), 0, 0);
    pk2.connect(p.rapBP).connect(rpg.node).connect(this.out);
    p.rap = rpg;
    p.rapF = new Smooth(p.rapBP.frequency, 1600, 1e-3);
    // surge layer
    const pk3 = this.noise('pink', 0.93);
    p.surgeBP = this.f('bandpass', 900, 1.4);
    p.surgeG = this.g(0);
    pk3.connect(p.surgeBP).connect(p.surgeG).connect(this.out);
    p.surge = new Smooth(p.surgeG.gain, 0);
    p.surgeF = new Smooth(p.surgeBP.frequency, 900, 1e-3);
    // bubbles
    p.bub = this.g(1);
    p.bub.connect(this.out);
  }

  set(o, now) {
    Object.assign(this.params, o);
    if (!this.on) return;
    const { speed, size, slope, foam, surge, level } = this.params;
    const p = this.p;
    const lvl = 1.3 * level * (0.55 + 0.45 * speed) * (0.75 + 0.35 * size);
    const tc = 0.18;
    const rumble = lvl * (0.3 + 0.55 * size) * 0.6;
    p.rumble.base.to(rumble, now, tc);
    p.rumble.depth.to(rumble * 0.3, now, tc);
    const rc = 320 - 160 * size + 100 * speed;
    p.rumbleF1.to(rc, now, 0.25);
    p.rumbleF2.to(rc * 1.1, now, 0.25);
    const wash = lvl * (0.38 + 0.36 * speed + 0.15 * slope) * 0.85;
    p.wash.base.to(wash, now, tc);
    p.wash.depth.to(wash * 0.45, now, tc);
    p.washF.to(420 + 650 * speed - 180 * size + 250 * slope, now, 0.25);
    const fizz = lvl * (0.035 + 0.16 * foam);
    p.fizz.base.to(fizz, now, tc);
    p.fizz.depth.to(fizz * 0.6, now, tc);
    p.fizzF.to(3600 + 2400 * speed - 1400 * size, now, 0.3);
    const rap = lvl * foam * 0.42;
    p.rap.base.to(rap, now, tc);
    p.rap.depth.to(rap * 0.85, now, tc);
    p.rapF.to(1300 + 900 * speed - 450 * size, now, 0.3);
    p.surge.to(surge * lvl * 0.4, now, surge ? 0.08 : 0.3);
    p.surgeF.to(surge ? 900 + 1500 * speed : 500, now, 0.4);
  }

  tick(dt, now) {
    if (!this.on) return;
    const { speed, size, foam, level } = this.params;
    const rate = (5 + 50 * (0.35 * speed + 0.65 * foam)) * level * (this.S.lite ? 0.6 : 1);
    const n = grains(this.grainState, rate, dt);
    const hi = 3200 - 1900 * size;
    const lo = 260 + 420 * (1 - size);
    for (let i = 0; i < n; i++) {
      const b = this.S.bank.bubble(lo, hi);
      if (!b) break;
      const g = rand(0.05, 0.16) * (0.55 + 0.45 * speed) * level * (b.f0 > 2000 ? 0.7 : 1);
      this.grain(b.buf, now + 0.03 + Math.random() * dt, g, rand(0.88, 1.15), rand(-0.75, 0.75), this.p.bub);
    }
    // occasional splashy droplets on rapids
    if (foam > 0.35) {
      const nd = grains((this.dropState ??= {}), foam * 18 * level, dt, 3);
      for (let i = 0; i < nd; i++) this.grain(this.S.bank.droplet(), now + 0.03 + Math.random() * dt, rand(0.04, 0.12) * foam, rand(0.8, 1.2), rand(-0.9, 0.9), this.p.bub);
    }
  }
}

// =============================================================================
/** Free-fall wind: rush + whistle + buffeting + cloud muffle + rain patter. set({ fall 0..1, cloud 0..1, level }) */
export class WindVoice extends Voice {
  constructor(S) {
    super(S, { rev: 0.05, fadeIn: 0.8 });
    this.params = { fall: 0, cloud: 0, level: 1 };
    this.grainState = {};
  }

  build() {
    const p = this.p;
    p.muffle = this.f('lowpass', 18000, 0.6);
    p.muffle.connect(this.out);
    p.muffleF = new Smooth(p.muffle.frequency, 18000, 1e-3);
    // rush
    const pk = this.noise('pink');
    p.rushBP = this.f('bandpass', 400, 0.7);
    const rg = this.amGain(this.mod(0.5), 0, 0);
    pk.connect(p.rushBP).connect(rg.node).connect(p.muffle);
    p.rush = rg;
    p.rushF = new Smooth(p.rushBP.frequency, 400, 1e-3);
    // whistle (resonant band wandering in pitch)
    const wh = this.noise('white');
    p.whBP = this.f('bandpass', 1400, 10);
    const pm = this.mod(0.12);
    const pmd = this.g(260);
    pm.connect(pmd).connect(p.whBP.frequency);
    const wg = this.amGain(this.mod(0.4), 0, 0);
    wh.connect(p.whBP).connect(wg.node).connect(p.muffle);
    p.whistle = wg;
    p.whF = new Smooth(p.whBP.frequency, 1400, 1e-3);
    // buffeting
    const br = this.noise('brown');
    const blp = this.f('lowpass', 150, 0.7);
    const bg = this.amGain(this.mod(8), 0, 0);
    br.connect(blp).connect(bg.node).connect(p.muffle);
    p.buffet = bg;
    // rain bus (not muffled: you're inside the cloud)
    p.rain = this.g(1);
    p.rain.connect(this.out);
  }

  set(o, now) {
    Object.assign(this.params, o);
    if (!this.on) return;
    const { fall, cloud, level } = this.params;
    const p = this.p;
    const lvl = level * (0.12 + 0.88 * Math.pow(fall, 1.4));
    const rush = lvl * 0.75;
    p.rush.base.to(rush, now, 0.2);
    p.rush.depth.to(rush * 0.35, now, 0.2);
    p.rushF.to(260 + 1250 * fall, now, 0.3);
    const wsl = lvl * 0.085 * (0.3 + fall);
    p.whistle.base.to(wsl, now, 0.3);
    p.whistle.depth.to(wsl * 0.8, now, 0.3);
    p.whF.to(900 + 1500 * fall, now, 0.5);
    const buf = lvl * 0.55 * fall;
    p.buffet.base.to(buf, now, 0.2);
    p.buffet.depth.to(buf * 0.8, now, 0.2);
    p.muffleF.to(18000 - 16800 * cloud, now, 0.12);
  }

  tick(dt, now) {
    if (!this.on) return;
    const { cloud, level } = this.params;
    if (cloud < 0.05) return;
    const n = grains(this.grainState, cloud * 110 * level, dt, 8);
    for (let i = 0; i < n; i++) {
      this.grain(this.S.bank.droplet(), now + 0.03 + Math.random() * dt, rand(0.05, 0.2) * cloud * level, rand(0.8, 1.4), rand(-0.95, 0.95), this.p.rain);
    }
  }
}

// =============================================================================
/**
 * Swallowing still water: a "filling bottle" resonance that rises in pitch as
 * the lake empties, churning low water and rhythmic gulps.
 * set({ rate 0..1, fill 0..1 (drained fraction), size 0..1 })
 */
export class AbsorbVoice extends Voice {
  constructor(S) {
    super(S, { rev: 0.15, fadeIn: 0.15 });
    this.params = { rate: 0, fill: 0, size: 0.5, level: 1 };
    this.nextGulp = 0;
  }

  build() {
    const p = this.p;
    const pk = this.noise('pink');
    p.res1 = this.f('bandpass', 300, 9);
    p.res2 = this.f('bandpass', 450, 7);
    const r1 = this.g(1);
    const r2 = this.g(0.6);
    p.resG = this.g(0);
    pk.connect(p.res1).connect(r1).connect(p.resG);
    pk.connect(p.res2).connect(r2).connect(p.resG);
    p.resG.connect(this.out);
    p.res = new Smooth(p.resG.gain, 0);
    p.f1 = new Smooth(p.res1.frequency, 300, 1e-3);
    p.f2 = new Smooth(p.res2.frequency, 450, 1e-3);
    const br = this.noise('brown');
    const lp = this.f('lowpass', 480, 0.9);
    const cg = this.amGain(this.mod(4.5), 0, 0);
    br.connect(lp).connect(cg.node).connect(this.out);
    p.churn = cg;
  }

  set(o, now) {
    Object.assign(this.params, o);
    if (!this.on) return;
    const { rate, fill, size, level } = this.params;
    const p = this.p;
    const base = 170 + 90 * (1 - size);
    const f = base * Math.pow(2, fill * 2.2); // rises ~2 octaves as the lake empties
    p.f1.to(f, now, 0.15);
    p.f2.to(f * 1.5, now, 0.15);
    p.res.to(level * (0.9 + 0.8 * rate) * 1.4, now, 0.1);
    const ch = level * (0.25 + 0.45 * rate);
    p.churn.base.to(ch, now, 0.1);
    p.churn.depth.to(ch * 0.7, now, 0.1);
  }

  tick(dt, now, sfx) {
    if (!this.on) return;
    const { rate, size, level } = this.params;
    if (now >= this.nextGulp - 0.05) {
      const t = Math.max(now + 0.02, this.nextGulp);
      sfx.gulp(this.S, t, { size: clamp(size * 0.7 + Math.random() * 0.3), gain: 0.55 * level * (0.6 + 0.4 * rate), pan: rand(-0.25, 0.25) });
      this.nextGulp = t + rand(0.75, 1.15) * (0.32 - 0.16 * rate);
    }
  }
}

// =============================================================================
/** Background world: wind bed, ocean swell + surf, birds in the valleys, gulls by the sea. */
export class AmbienceVoice extends Voice {
  constructor(S) {
    super(S, { rev: 0.25, fadeIn: 1.5 });
    this.params = { wind: 0.3, ocean: 0.2, birds: 0, gulls: 0, level: 1 };
    this.nextBird = 0;
    this.nextGull = 0;
  }

  build() {
    const p = this.p;
    const pk = this.noise('pink', 0.9);
    const wlp = this.f('lowpass', 650, 0.6);
    const wg = this.amGain(this.mod(0.18), 0, 0);
    pk.connect(wlp).connect(wg.node).connect(this.out);
    p.wind = wg;
    // ocean: shared slow swell drives low roar and surf hiss
    const swell = this.mod(0.07);
    const br = this.noise('brown', 0.8);
    const ohp = this.f('highpass', 70, 0.6);
    const olp = this.f('lowpass', 750, 0.6);
    const og = this.amGain(swell, 0, 0);
    br.connect(ohp).connect(olp).connect(og.node).connect(this.out);
    p.ocean = og;
    const pk2 = this.noise('pink', 1.1);
    const sbp = this.f('bandpass', 1500, 0.45);
    const sg = this.amGain(swell, 0, 0);
    pk2.connect(sbp).connect(sg.node).connect(this.out);
    p.surf = sg;
    p.calls = this.g(1);
    p.calls.connect(this.out);
  }

  set(o, now) {
    Object.assign(this.params, o);
    if (!this.on) return;
    const { wind, ocean, level } = this.params;
    const p = this.p;
    const w = wind * level * 0.24;
    p.wind.base.to(w, now, 0.8);
    p.wind.depth.to(w * 0.55, now, 0.8);
    const oc = ocean * level * 0.42;
    p.ocean.base.to(oc, now, 0.8);
    p.ocean.depth.to(oc * 0.6, now, 0.8);
    const sf = ocean * level * 0.17;
    p.surf.base.to(sf, now, 0.8);
    p.surf.depth.to(sf * 0.9, now, 0.8);
  }

  tick(dt, now) {
    if (!this.on) return;
    const { birds, gulls, level } = this.params;
    if (birds > 0.05 && now > this.nextBird) {
      this.bird(now + 0.05, birds * level);
      this.nextBird = now + rand(1.6, 5.5) / (0.5 + birds);
    }
    if (gulls > 0.05 && now > this.nextGull) {
      this.gull(now + 0.05, gulls * level);
      this.nextGull = now + rand(3.5, 9) / (0.5 + gulls);
    }
  }

  /** Songbird: a phrase of 3–7 fast FM-ish chirps. */
  bird(t, amt) {
    const ac = this.ac;
    const pan = rand(-0.9, 0.9);
    const base = rand(2600, 4200);
    const n = 3 + ((Math.random() * 5) | 0);
    const shape = Math.random() < 0.5 ? 1 : -1;
    const pn = ac.createStereoPanner ? ac.createStereoPanner() : ac.createGain();
    if (pn.pan) pn.pan.value = pan;
    pn.connect(this.p.calls);
    let tt = t;
    for (let i = 0; i < n; i++) {
      const dur = rand(0.04, 0.09);
      const o = ac.createOscillator();
      const g = ac.createGain();
      const f0 = base * rand(0.85, 1.2);
      o.frequency.setValueAtTime(f0, tt);
      o.frequency.exponentialRampToValueAtTime(f0 * (shape > 0 ? rand(1.3, 1.7) : rand(0.6, 0.75)), tt + dur);
      g.gain.setValueAtTime(0, tt);
      g.gain.linearRampToValueAtTime(0.05 * amt, tt + 0.006);
      g.gain.setTargetAtTime(0, tt + dur * 0.6, dur * 0.2);
      o.connect(g).connect(pn);
      o.start(tt);
      o.stop(tt + dur + 0.08);
      o.onended = () => g.disconnect();
      tt += dur + rand(0.03, 0.12);
    }
    setTimeout(() => pn.disconnect(), (tt - ac.currentTime + 1) * 1000);
  }

  /** Seagull "kee-ow": nasal saw through a formant band, falling glide. */
  gull(t, amt) {
    const ac = this.ac;
    const pn = ac.createStereoPanner ? ac.createStereoPanner() : ac.createGain();
    if (pn.pan) pn.pan.value = rand(-0.8, 0.8);
    pn.connect(this.p.calls);
    const calls = 1 + ((Math.random() * 3) | 0);
    let tt = t;
    for (let i = 0; i < calls; i++) {
      const dur = rand(0.28, 0.42);
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      const f0 = rand(1250, 1500);
      o.frequency.setValueAtTime(f0 * 0.85, tt);
      o.frequency.linearRampToValueAtTime(f0, tt + 0.05);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.62, tt + dur);
      const bp = ac.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2200;
      bp.Q.value = 2.5;
      const g = ac.createGain();
      g.gain.setValueAtTime(0, tt);
      g.gain.linearRampToValueAtTime(0.06 * amt, tt + 0.03);
      g.gain.setTargetAtTime(0, tt + dur * 0.7, 0.04);
      o.connect(bp).connect(g).connect(pn);
      o.start(tt);
      o.stop(tt + dur + 0.2);
      o.onended = () => {
        bp.disconnect();
        g.disconnect();
      };
      tt += dur + rand(0.06, 0.16);
    }
    setTimeout(() => pn.disconnect(), (tt - ac.currentTime + 1) * 1000);
  }
}

// =============================================================================
/** Roar of the nearest rivals (2 voices), panned/attenuated around the camera. */
export class RivalVoices extends Voice {
  constructor(S) {
    super(S, { rev: 0.12, fadeIn: 0.5 });
    this.slots = [];
  }

  build() {
    const ac = this.ac;
    this.slots = [0, 1].map(() => {
      const pk = this.noise('pink', rand(0.9, 1.1));
      const bp = this.f('bandpass', 700, 0.6);
      const br = this.noise('brown', rand(0.9, 1.1));
      const lp = this.f('lowpass', 240, 0.7);
      const mix = this.g(1);
      const air = this.f('lowpass', 8000, 0.5);
      const g = this.amGain(this.mod(rand(0.3, 0.5)), 0, 0);
      pk.connect(bp).connect(mix);
      br.connect(lp).connect(mix);
      mix.connect(air).connect(g.node);
      let pn = null;
      if (ac.createStereoPanner) {
        pn = ac.createStereoPanner();
        this.nodes.push(pn);
        g.node.connect(pn).connect(this.out);
      } else g.node.connect(this.out);
      return {
        id: null,
        gain: g,
        air: new Smooth(air.frequency, 8000, 1e-3),
        pan: pn ? new Smooth(pn.pan, 0, 1e-3) : null,
      };
    });
  }

  /** targets: [{ id, x, y, z, size 0..1 }] nearest first (≤ 2). */
  set(targets, now, listener) {
    if (!this.on) return;
    // keep existing assignments stable to avoid pan jumps
    const free = [...this.slots];
    const assigned = new Map();
    for (const tg of targets) {
      const slot = free.find((s) => s.id === tg.id);
      if (slot) {
        assigned.set(slot, tg);
        free.splice(free.indexOf(slot), 1);
      }
    }
    for (const tg of targets) {
      if ([...assigned.values()].includes(tg)) continue;
      const slot = free.shift();
      if (slot) assigned.set(slot, tg);
    }
    for (const slot of this.slots) {
      const tg = assigned.get(slot);
      if (!tg) {
        slot.gain.base.to(0, now, 0.3);
        slot.gain.depth.to(0, now, 0.3);
        slot.id = null;
        continue;
      }
      const fresh = slot.id !== tg.id;
      slot.id = tg.id;
      const d = listener.place(tg.x, tg.y, tg.z, { ref: 35 + tg.size * 30, max: 420, delay: false });
      const g = d.audible ? d.gain * (0.18 + 0.32 * tg.size) * (tg.speed ?? 1) : 0;
      slot.gain.base.to(g, now, fresh ? 0.4 : 0.15);
      slot.gain.depth.to(g * 0.3, now, 0.2);
      slot.air.to(Math.min(d.lpf, 9000), now, 0.2);
      slot.pan?.to(d.pan, now, fresh ? 0.01 : 0.12);
    }
  }
}

// =============================================================================
/** Drop build riser: noise sweep + detuned saw glide, driven by build 0..1. */
export class RiserVoice extends Voice {
  constructor(S) {
    super(S, { bus: 'music', rev: 0.2, fadeIn: 0.3 });
  }

  build() {
    const p = this.p;
    const wh = this.noise('white');
    p.bp = this.f('bandpass', 500, 2);
    p.ng = this.g(0);
    wh.connect(p.bp).connect(p.ng).connect(this.out);
    p.nf = new Smooth(p.bp.frequency, 500, 1e-3);
    p.n = new Smooth(p.ng.gain, 0);
    const ac = this.ac;
    p.lp = this.f('lowpass', 800, 3);
    p.og = this.g(0);
    p.oscs = [-14, 0, 13].map((d) => {
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = mtof(43);
      o.detune.value = d;
      o.start();
      this.sources.push(o);
      this.nodes.push(o);
      o.connect(p.lp);
      return o;
    });
    p.lp.connect(p.og).connect(this.out);
    p.of = p.oscs.map((o) => new Smooth(o.frequency, mtof(43), 1e-3));
    p.lpf = new Smooth(p.lp.frequency, 800, 1e-3);
    p.o = new Smooth(p.og.gain, 0);
  }

  set(build, now, key = 67) {
    if (!this.on) return;
    const p = this.p;
    const b = clamp(build);
    p.nf.to(400 + 7000 * b * b, now, 0.12);
    p.n.to(0.22 * b * b, now, 0.12);
    const f = mtof(key - 24 + 24 * b);
    for (const s of p.of) s.to(f, now, 0.15);
    p.lpf.to(500 + 4000 * b, now, 0.12);
    p.o.to(0.05 * b * b, now, 0.12);
  }
}
