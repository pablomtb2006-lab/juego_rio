import { mulberry32 } from '../core/random.js';

/**
 * LA CATÁSTROFE (TRAMO D) — one announced, island-wide event per race.
 *
 * The point is the ANNOUNCEMENT. Ten seconds of countdown with a name on screen turns a
 * random modifier into a decision: do I take the short branch now, before the heat wave, or
 * do I bank litres and ride it out? A catastrophe that simply happened would just be noise.
 *
 * Not all of them hurt. A deluge hands everyone litres and an eclipse switches evaporation
 * almost off — those are the races you come back from, and they are why a hard game is still
 * winnable. Everything here hits EVERY stream, the player's rivals included; nothing in this
 * file reads `isPlayer` except the screen effects.
 *
 * Phases:  'idle' → 'warn' (countdown on screen) → 'active' → 'done'  (one per match)
 *
 * Contract read by the HUD, PostFX and Rules:
 *   catastrophe.phase, .kind, .def, .timeLeft, .k (0..1 ramp in/out), .front (lava only)
 *   catastrophe.check(stream, dt)   per-stream effects, called from Rules after hazards
 *
 * Bus events: 'catWarn' { kind, seconds } · 'catStart' { kind } · 'catEnd' { kind }
 */
export const CATASTROPHES = {
  // the lava front: a wall of fire sweeping down the mountain behind the field. You cannot
  // fight it, only outrun it — it is the one that empties the back of the pack.
  lava: {
    icon: '🌋',
    color: 0xff4a1e,
    warn: 13,
    duration: 38,
    front: { speed: 30, lead: 300, width: 220, drain: 430000 },
    shake: 0.28,
  },
  // dust storm: you cannot see, and the wind drinks you
  dust: { icon: '🌪️', color: 0xc9a06a, warn: 10, duration: 40, veil: 0.72, blind: 0.5, evap: 1.5 },
  // earthquake: no grip, and every dam on the island gives way
  quake: { icon: '🌎', color: 0xb08968, warn: 9, duration: 24, grip: 0.46, shake: 0.55, breakDams: true },
  // deluge: free litres for everyone. The comeback event.
  deluge: { icon: '🌧️', color: 0x6fd4ff, warn: 10, duration: 34, rain: 46000, veil: 0.3, evap: 0.6, mood: 'dusk' },
  // heat wave: evaporation goes through the roof. Volume is suddenly worth hoarding.
  heat: { icon: '☀️', color: 0xffcf6a, warn: 11, duration: 34, evap: 2.5 },
  // hail: everyone slows to a crawl, so gaps close and the pack bunches up again
  hail: { icon: '🧊', color: 0xcfe9ff, warn: 9, duration: 26, slowTo: 30, grip: 0.72 },
  // eclipse: the sun goes out, so almost nothing evaporates — but the hazard warnings go dark too
  eclipse: { icon: '🌑', color: 0x4a3e72, warn: 10, duration: 30, evap: 0.3, dark: 1, hideWarnings: true, mood: 'dusk' },
};

const KEYS = Object.keys(CATASTROPHES);

export const CATASTROPHE = {
  earliest: 48, // seconds into the match before it can be announced
  latest: 105, //  …and the last moment it can be
  ramp: 2.5, //    seconds of fade in and out, so nothing snaps on
};

export class Catastrophe {
  constructor(game) {
    this.game = game;
    this.reset();
  }

  reset(seed = 1) {
    const rand = mulberry32((seed >>> 0) * 6151 + 17);
    this.kind = KEYS[Math.floor(rand() * KEYS.length) % KEYS.length];
    this.def = CATASTROPHES[this.kind];
    this.at = CATASTROPHE.earliest + rand() * (CATASTROPHE.latest - CATASTROPHE.earliest);
    this.phase = 'idle';
    this.timeLeft = 0;
    this.k = 0;
    this.front = null;
    this._moodDone = false;
  }

  get active() {
    return this.phase === 'active';
  }

  /** 0..1 — how much the event is biting right now (fades in and out). */
  strength() {
    if (this.phase !== 'active') return 0;
    const d = this.def.duration;
    const t = d - this.timeLeft;
    return Math.min(1, Math.min(t, this.timeLeft) / CATASTROPHE.ramp);
  }

  update(dt) {
    const game = this.game;
    if (game.state !== 'stream' && game.state !== 'drop') return;
    const bus = game.ctx.bus;

    if (this.phase === 'idle') {
      if (game.time < this.at) return;
      this.phase = 'warn';
      this.timeLeft = this.def.warn;
      bus.emit('catWarn', { kind: this.kind, seconds: this.timeLeft });
      return;
    }

    if (this.phase === 'warn') {
      this.timeLeft -= dt;
      if (this.timeLeft > 0) return;
      this.phase = 'active';
      this.timeLeft = this.def.duration;
      this.k = 0;
      if (this.def.front) this.startFront();
      if (this.def.breakDams) game.obstacles?.breakAll?.();
      if (this.def.mood) game.ctx.atmosphere?.setMood?.(this.def.mood, 4);
      bus.emit('catStart', { kind: this.kind });
      return;
    }

    if (this.phase !== 'active') return;
    this.timeLeft -= dt;
    this.k = this.strength();
    if (this.front) this.front.at += this.front.speed * dt;
    if (this.def.shake) game.cameraDirector?.addTrauma?.(this.def.shake * this.k * dt * 2.2);
    if (this.timeLeft <= 0) {
      this.phase = 'done';
      this.k = 0;
      this.front = null;
      if (this.def.mood) game.ctx.atmosphere?.setMood?.('day', 5);
      bus.emit('catEnd', { kind: this.kind });
    }
  }

  /**
   * The lava front is a straight line perpendicular to the race direction, starting just
   * behind the last stream still racing and advancing down the mountain. Streams are measured
   * by how far they have travelled along the race line, so "behind the front" is one dot
   * product — no geometry, no per-frame cost.
   */
  startFront() {
    const game = this.game;
    const d = game.raceDir;
    if (!d) return;
    let min = Infinity;
    for (const s of game.streams) {
      if (s.phase !== 'flow' && s.phase !== 'drop') continue;
      min = Math.min(min, s.pos.x * d.x + s.pos.z * d.y);
    }
    if (!Number.isFinite(min)) min = 0;
    this.front = { at: min - this.def.front.lead, speed: this.def.front.speed, dir: d };
  }

  /** How far a stream is in front of the lava (metres). Negative = inside it. */
  frontGap(s) {
    if (!this.front) return Infinity;
    const d = this.front.dir;
    return s.pos.x * d.x + s.pos.z * d.y - this.front.at;
  }

  /** Called by Rules for every flowing stream, right after the hazards. */
  check(s, dt) {
    s.catEvap = 1;
    if (this.phase !== 'active') return;
    const def = this.def;
    const k = this.k;
    if (k <= 0) return;

    if (def.evap) s.catEvap = 1 + (def.evap - 1) * k;
    if (def.rain) s.addVolume(def.rain * k * dt);
    if (def.grip) s.gripMul = Math.min(s.gripMul ?? 1, 1 - (1 - def.grip) * k);
    if (def.slowTo && s.flowSpeed > def.slowTo) s.flowSpeed += (def.slowTo - s.flowSpeed) * Math.min(1, dt * 1.6 * k);
    if (def.blind && s.isPlayer) s.blinded = Math.max(s.blinded || 0, def.blind * k);

    if (this.front && !s.leaping) {
      const gap = this.frontGap(s);
      const w = def.front.width;
      if (gap < w) {
        // deepest inside the front burns fastest; the leading edge only singes you
        const bite = Math.min(1, (w - gap) / w);
        s.addVolume(-def.front.drain * bite * k * dt);
        if (s.isPlayer) s.blinded = Math.max(s.blinded || 0, bite * 0.3);
      }
    }
  }
}
