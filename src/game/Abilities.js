import * as THREE from 'three';
import { mulberry32 } from '../core/random.js';

/**
 * HABILIDADES OFENSIVAS (TRAMO E) — verbs, not just dodging.
 *
 * Until now the player could steer, surge and leap: every one of those is about the island. These
 * three are about the OTHER RIVERS, and each one is a different kind of problem for its target:
 *
 *   wall   MURO       a rock wall slammed across the valley ahead of a rival. Telegraphed (a rune
 *                      on the ground for ~1 s) so it is a skill-shot to land and a skill-move to
 *                      dodge. Holds against anything smaller than ~0.9× you; anything bigger smashes it.
 *   leech  SANGUIJUELA a tether that drinks a rival's litres for a few seconds. Breaks if they get
 *                      out of range, leap, or you do — so it rewards sticking to someone, and the
 *                      answer to it is to run.
 *   fog    VAPOR      a steam cloud on a rival: a player is blinded, a bot veers all over the place.
 *
 * Everything here is symmetric: the AI casts the same abilities with the same cooldowns (a little
 * slower), at other rivals and at you. The only asymmetry is a pressure budget on the player
 * (`PRESSURE`), so a pack of bots can never chain-stun you — you will feel hunted, not farmed.
 *
 * Contract:
 *   abilities.walls[]            { id, x, z, y, dirx, dirz, width, height, strength, owner, t0, rise, end, broken, brokenAt }
 *   abilities.marks[]            { x, z, r, kind (8 warning | 9 reticle), p }   read by world/props/HazardField.js
 *   abilities.lock               the rival the player is aiming at (or null)
 *   abilities.state(s, id)       { unlocked, level, cd (0 = ready … 1 = just used), ready, target }  for the HUD
 *   abilities.cast(s, id, T?)    { ok, reason? }
 *   abilities.check(s, dt)       wall collision, called from Rules for every flowing stream
 *   abilities.wallAhead(s, r)    nearest wall (or its warning) in front of s, for the AI
 *
 * Stream fields: abil{wall,leech,fog} (cooldown seconds), leechT/leechTarget, leechedT, fogT.
 * Bus events: 'ability' { kind, caster, target, wall? } · 'abilityDenied' { kind, reason }
 *             'wallBreak' { wall, stream } · 'wallBlocked' { wall, stream } · 'leechEnd' { caster, target }
 */
export const ABILITIES = {
  wall: { id: 'wall', icon: '🪨', key: 'Q', color: 0x9cc4d4, cool: 15, cost: 0.05, unlock: 1, range: 280, telegraph: 1.0, life: 8, hold: 0.9, height: 15 },
  leech: { id: 'leech', icon: '🌀', key: 'R', color: 0x38e0ff, cool: 21, cost: 0.03, unlock: 2, range: 150, hold: 4.6, drain: 0.036, give: 0.65, breakRange: 235 },
  fog: { id: 'fog', icon: '☁️', key: 'F', color: 0xdfe9f0, cool: 23, cost: 0.04, unlock: 3, range: 230, hold: 5.6 },
};
export const ABILITY_IDS = Object.keys(ABILITIES);

const MIN_VOLUME = 70000; // below this a river is too small to throw anything
const AI_SLOWER = 1.45; // bots wait this much longer between casts than you do
const AI_FIRST = 38; // nobody fights on the way down the mountain
const PRESSURE = { window: 14, max: 2 }; // at most this many bot casts on the player per window

const _d = new THREE.Vector2();
const _f = new THREE.Vector2();

export class Abilities {
  constructor(game) {
    this.game = game;
    this.walls = [];
    this.marks = [];
    this.lock = null;
    this.lockReady = false;
    this.pressure = [];
    this.nextId = 1;
    this.forceAll = false;
    try {
      this.forceAll = new URLSearchParams(globalThis.location?.search ?? '').get('abilities') === 'all';
    } catch {
      /* no location (tests) */
    }
  }

  reset() {
    this.walls.length = 0;
    this.marks.length = 0;
    this.lock = null;
    this.lockReady = false;
    this.pressure.length = 0;
    this._tick = 0;
  }

  // --- availability --------------------------------------------------------------------

  /** Which abilities the player owns: by account level, so there is something to play towards. */
  unlocked(s, id) {
    if (!s.isPlayer) return !!this.game.difficulty?.abilityAI;
    if (this.forceAll || this.game.ctx.params.capture) return true;
    const eco = this.game.ctx.services?.economy;
    if (!eco) return true;
    const A = ABILITIES[id];
    // the very first match stays clean: one thing at a time
    if (id === 'wall' && eco.stats.matches < 1) return false;
    return eco.level.level >= A.unlock;
  }

  /** Level needed (for the lock badge). */
  levelFor(id) {
    return ABILITIES[id].unlock;
  }

  /** Streams that can be a target right now. */
  candidates(s) {
    const t = this.game.time;
    const out = [];
    for (const o of this.game.streams) {
      if (o === s || o.phase !== 'flow' || !o.alive) continue;
      if (o.protectedFor > 0 || t - o.landedAt < 4) continue;
      out.push(o);
    }
    return out;
  }

  /** Is T a legal, useful target for `id` cast by s? */
  valid(s, id, T) {
    if (!T || T === s || T.phase !== 'flow' || !T.alive || T.protectedFor > 0) return false;
    const A = ABILITIES[id];
    const dx = T.pos.x - s.pos.x;
    const dz = T.pos.z - s.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > A.range || d < 1) return false;
    if (id === 'wall') {
      if ((dx * s.heading.x + dz * s.heading.y) / d < 0.15) return false; // must be in front of you
      if (T.volume >= s.volume * 0.9 * 0.97) return false; // it would just smash through
    } else if (id === 'leech') {
      if (T.volume < 60000 || T.volume < s.volume * 0.3) return false; // nothing worth drinking
      if (T.leaping) return false;
    } else if (id === 'fog') {
      if (T.fogT > 1.5) return false;
    }
    return true;
  }

  /** Best target for `id`: the lock if it fits, else the best of the rest. */
  pickTarget(s, id) {
    if (s.isPlayer && this.lock && this.valid(s, id, this.lock)) return this.lock;
    let best = null;
    let bs = -Infinity;
    for (const T of this.candidates(s)) {
      if (!this.valid(s, id, T)) continue;
      const d = Math.hypot(T.pos.x - s.pos.x, T.pos.z - s.pos.z);
      // the leader carries a target on its back; leeches go for the juiciest; the rest for the nearest
      let score = -d + (T.livePlace === 1 ? 80 : 0);
      if (id === 'leech') score = T.volume / 4000 - d * 0.4;
      if (score > bs) {
        bs = score;
        best = T;
      }
    }
    return best;
  }

  /** The player's soft lock: nearest rival in front, else nearest at all. */
  computeLock(p) {
    let best = null;
    let bd = Infinity;
    for (const T of this.candidates(p)) {
      const dx = T.pos.x - p.pos.x;
      const dz = T.pos.z - p.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 280 || d < 1) continue;
      const front = (dx * p.heading.x + dz * p.heading.y) / d;
      const score = d * (front > 0.15 ? 1 : 1.8) - (T.livePlace === 1 ? 60 : 0);
      if (score < bd && (front > 0.15 || d < 150)) {
        bd = score;
        best = T;
      }
    }
    return best;
  }

  /** HUD view of one ability. */
  state(s, id) {
    const A = ABILITIES[id];
    const unlocked = this.unlocked(s, id);
    const cool = (s.abil?.[id] ?? 0) > 0 ? s.abil[id] : 0;
    const total = A.cool * (s.abilityCoolMul ?? 1);
    const target = unlocked && this.pickTarget(s, id) !== null;
    return { unlocked, level: A.unlock, cd: Math.min(1, cool / total), cool, ready: unlocked && cool <= 0, target };
  }

  // --- casting -------------------------------------------------------------------------

  cast(s, id, T = null) {
    const A = ABILITIES[id];
    const { bus } = this.game.ctx;
    const fail = (reason) => ({ ok: false, reason });
    if (!A || s.phase !== 'flow' || !s.alive || s.leaping) return fail('state');
    if (!this.unlocked(s, id)) return fail('locked');
    if ((s.abil[id] ?? 0) > 0) return fail('cooldown');
    if (s.volume < MIN_VOLUME) return fail('volume');
    T = T && this.valid(s, id, T) ? T : this.pickTarget(s, id);
    if (!T) return fail('target');

    let wall = null;
    if (id === 'wall') {
      wall = this.plantWall(s, T);
      if (!wall) return fail('terrain');
    } else if (id === 'leech') {
      s.leechTarget = T;
      s.leechT = A.hold;
    } else if (id === 'fog') {
      T.fogT = A.hold;
    }
    s.abil[id] = A.cool * (s.abilityCoolMul ?? 1) * (s.isPlayer ? 1 : AI_SLOWER);
    s.addVolume(-s.volume * A.cost);
    s.lastCast = this.game.time;
    if (T.isPlayer && !s.isPlayer) this.pressure.push(this.game.time);
    bus.emit('ability', { kind: id, caster: s, target: T, wall });
    return { ok: true, target: T };
  }

  plantWall(s, T) {
    const { terrain } = this.game.ctx;
    const hydro = this.game.hydro;
    const A = ABILITIES.wall;
    const sp = Math.max(T.flowSpeed || 0, 12);
    _d.set(T.heading.x, T.heading.y);
    if (_d.lengthSq() < 0.01) return null;
    _d.normalize();
    // ahead of the target by what it will cover during the warning, so it lands on the line it is on
    const lead = sp * (A.telegraph + 0.3) + T.radius * 1.5 + 14;
    const x = T.pos.x + _d.x * lead;
    const z = T.pos.z + _d.y * lead;
    if (!terrain.isLand(x, z)) return null;
    // lie across the valley the water actually runs down, not across the rival's last bend
    hydro.flowDirAt(x, z, _f);
    if (_f.lengthSq() > 0.3 && _f.dot(_d) > 0.4) _d.copy(_f);
    const time = this.game.time;
    const wall = {
      id: this.nextId++,
      x,
      z,
      y: terrain.heightAt(x, z),
      dirx: _d.x,
      dirz: _d.y,
      width: THREE.MathUtils.clamp(40 + Math.sqrt(s.volume / 1000) * 1.1, 48, 92),
      height: A.height,
      strength: s.volume * A.hold, // holds against anyone smaller than you; a bigger river smashes it
      owner: s,
      t0: time,
      rise: time + A.telegraph,
      end: time + A.telegraph + A.life,
      broken: false,
      brokenAt: -1,
    };
    this.walls.push(wall);
    return wall;
  }

  breakWall(w, s) {
    w.broken = true;
    w.brokenAt = this.game.time;
    s.flowSpeed *= 0.8; // it is a wall: smashing through is not free
    this.game.ctx.bus.emit('wallBreak', { wall: w, stream: s });
  }

  // --- wall collision (called from Rules) -----------------------------------------------

  check(s, dt) {
    if (!this.walls.length) return;
    const time = this.game.time;
    for (const w of this.walls) {
      if (w.broken || time < w.rise || time > w.end || s === w.owner) continue;
      const rx = s.pos.x - w.x;
      const rz = s.pos.z - w.z;
      if (rx * rx + rz * rz > (w.width + 40) ** 2) continue;
      const along = rx * w.dirx + rz * w.dirz;
      const lat = -rx * w.dirz + rz * w.dirx;
      const reach = 4 + s.radius * 0.5;
      if (Math.abs(along) > reach || Math.abs(lat) > w.width * 0.5 + s.radius * 0.4) continue;
      if (s.leaping && s.pos.y > w.y + w.height) continue; // sail over it
      if (s.volume >= w.strength) {
        this.breakWall(w, s);
        continue;
      }
      // blocked: pushed back to the upstream face, current killed
      const back = -reach - along;
      if (along > -reach) {
        s.pos.x += w.dirx * back;
        s.pos.z += w.dirz * back;
      }
      s.flowSpeed = Math.min(s.flowSpeed, 2.5);
      s.damBlocked = (s.damBlocked || 0) + dt * 1.5;
      if (s.damBlocked > 0.6) s.wantLeap = true; // AI / autopilot hint
      s.lastWall = w;
      if (!s._wallMsg || time - s._wallMsg > 2.5) {
        s._wallMsg = time;
        this.game.ctx.bus.emit('wallBlocked', { wall: w, stream: s });
      }
    }
  }

  /** Nearest live wall (or one still being warned) in front of s within `range`, for the AI. */
  wallAhead(s, range = 150) {
    const time = this.game.time;
    let best = null;
    let bd = range;
    for (const w of this.walls) {
      if (w.broken || time > w.end || w.owner === s) continue;
      const dx = w.x - s.pos.x;
      const dz = w.z - s.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > bd || d < 1) continue;
      if ((dx * s.heading.x + dz * s.heading.y) / d < 0.5) continue;
      if (s.volume >= w.strength) continue; // it would smash through: no need to dodge
      bd = d;
      best = w;
    }
    return best;
  }

  // --- per tick --------------------------------------------------------------------------

  update(dt) {
    const game = this.game;
    const { bus } = game.ctx;
    if (game.state !== 'stream' && game.state !== 'drop') return;
    const time = game.time;

    // walls expire
    for (let i = this.walls.length - 1; i >= 0; i--) {
      const w = this.walls[i];
      if (time > w.end + 1.2 || (w.broken && time - w.brokenAt > 1.4)) this.walls.splice(i, 1);
    }
    while (this.pressure.length && time - this.pressure[0] > PRESSURE.window) this.pressure.shift();

    for (const s of game.streams) {
      if (!s.abil) continue;
      for (const id of ABILITY_IDS) if (s.abil[id] > 0) s.abil[id] = Math.max(0, s.abil[id] - dt);
      if (s.leechedT > 0) s.leechedT = Math.max(0, s.leechedT - dt);

      // the player's key presses
      if (s.isPlayer && s.input.ability) {
        const id = s.input.ability;
        s.input.ability = null;
        const res = this.cast(s, id);
        if (!res.ok) bus.emit('abilityDenied', { kind: id, reason: res.reason });
      }

      // leech: drinks while the tether holds
      if (s.leechT > 0) this.tickLeech(s, dt);

      // fog: a human is blinded, a bot is just made to wander (AIController)
      if (s.fogT > 0) {
        s.fogT = Math.max(0, s.fogT - dt);
        if (s.isPlayer) s.blinded = Math.max(s.blinded || 0, 0.92 * Math.min(1, s.fogT / 1.1));
      }

      // bots (and the autopilot, which is how the headless sims play) throw things too
      if (!s.isPlayer || s.controller?.autopilot) this.aiThink(s, dt);
    }

    // the player's aim + the marks the ground shader draws
    const p = game.player;
    this._tick = (this._tick ?? 0) + 1;
    if (p && p.phase === 'flow' && (this._tick % 5 === 0 || !this.lock)) {
      const lock = this.computeLock(p);
      this.lock = lock;
      this.lockReady = !!lock && ABILITY_IDS.some((id) => this.unlocked(p, id) && p.abil[id] <= 0 && this.valid(p, id, lock));
    } else if (!p || p.phase !== 'flow') {
      this.lock = null;
      this.lockReady = false;
    }
    this.buildMarks(time);
  }

  tickLeech(s, dt) {
    const A = ABILITIES.leech;
    const T = s.leechTarget;
    const { bus } = this.game.ctx;
    const end = () => {
      s.leechT = 0;
      s.leechTarget = null;
      bus.emit('leechEnd', { caster: s, target: T });
    };
    if (!T || !s.alive || s.phase !== 'flow' || T.phase !== 'flow' || !T.alive || T.leaping || T.protectedFor > 0) return end();
    if (Math.hypot(T.pos.x - s.pos.x, T.pos.z - s.pos.z) > A.breakRange) return end();
    s.leechT -= dt;
    if (s.leechT <= 0) return end();
    const drain = T.volume * A.drain * dt;
    T.addVolume(-drain);
    s.addVolume(drain * A.give);
    T.leechedT = 0.35;
    T.lastHitAt = this.game.time;
  }

  // --- the bots ------------------------------------------------------------------------

  pressureOpen() {
    return this.pressure.length < PRESSURE.max;
  }

  aiThink(s, dt) {
    const game = this.game;
    const D = game.difficulty;
    if (!D?.abilityAI) return;
    const rand = game.rand ?? Math.random;
    s.abilityT = (s.abilityT ?? 2 + rand() * 3) - dt;
    if (s.abilityT > 0) return;
    s.abilityT = 1.1 + rand() * 1.4;
    if (s.phase !== 'flow' || s.leaping || s.volume < MIN_VOLUME * 1.3 || game.time < AI_FIRST) return;
    const ctl = s.isPlayer ? s.controller?.ai : s.controller;
    const aggr = ctl?.traits?.aggression ?? 0.4;
    // a stream already tethered / blinded / stuck behind a wall is busy
    if (s.leechT > 0) return;
    const order = ABILITY_IDS.slice().sort(() => rand() - 0.5);
    for (const id of order) {
      if (s.abil[id] > 0 || !this.unlocked(s, id)) continue;
      const T = this.pickTarget(s, id);
      if (!T) continue;
      let p = (0.14 + 0.5 * aggr) * (D.abilityRate ?? 1);
      if (T.isPlayer) {
        if (!D.huntPlayer || !this.pressureOpen()) continue;
        p *= D.abilityVsPlayer ?? 1;
      }
      if (rand() < p) {
        this.cast(s, id, T);
        return;
      }
    }
  }

  // --- marks for the ground shader --------------------------------------------------------

  buildMarks(time) {
    const m = this.marks;
    m.length = 0;
    for (const w of this.walls) {
      if (time >= w.rise || w.broken) continue;
      const k = (time - w.t0) / ABILITIES.wall.telegraph;
      const px = -w.dirz;
      const pz = w.dirx;
      for (let i = -1; i <= 1; i++) {
        const o = i * w.width * 0.3;
        m.push({ x: w.x + px * o, z: w.z + pz * o, r: w.width * 0.27, kind: 8, p: THREE.MathUtils.clamp(k, 0, 1) });
      }
    }
    const lock = this.lock;
    const p = this.game.player;
    if (lock && p && this.lockReady && lock.phase === 'flow') {
      m.push({ x: lock.pos.x, z: lock.pos.z, r: lock.radius * 2.3 + 6, kind: 9, p: (time * 0.35) % 1 });
    }
  }
}
