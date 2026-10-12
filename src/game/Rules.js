import { volumeFactor } from './StreamPhysics.js';
import { archGate } from './arch.js';

/**
 * Match rules. Emits on ctx.bus (contract in docs/ARCHITECTURE.md, payloads only grow):
 *   'absorb'     { stream, body, amount }        each tick while swallowing still water / clouds
 *                                                (amount = litres the stream gained this tick)
 *   'cut'        { attacker, victim, amount }    attacker (bigger) crossed victim's river and stole water
 *   'eliminated' { victim, by, reason }          reason: 'blocked' | 'swallowed' | 'dried'
 *   'finished'   { stream, place }               reached the sea
 *   'splash'     { x, y, z, size, stream, kind } kind: 'landing' | 'finish' | 'clash' | 'cut'
 *   'bonus'      { stream, kind: 'arch', amount } (new) flew through the summit arch
 *
 * Fairness rules for blocking ("if you hit a bigger one you're blocked"):
 *   - a river only counts as bigger with a clear margin (RULES.ratio); near-equal rivers
 *     pass through each other;
 *   - `danger` / `threat` warn ~2.5 s before you reach a bigger river;
 *   - touching a bigger channel starts a short `contact` (RULES.blockTime) during which
 *     you bleed water to it — steer out and you survive; stay and you're absorbed;
 *   - freshly landed streams are protected for RULES.protectTime seconds.
 */
export const RULES = {
  absorbK: { lake: 150, puddle: 220, cloud: 90 }, // litres gained overall = min(maxVolume, K·√maxVolume)
  swallowTime: { lake: 3.4, puddle: 1.1, cloud: 1.0 },
  inflow: 26000, // L/s gathered on the biggest rivers (scaled by how much of a valley floor you're on)
  inflowFrom: 0.35, //   channel strength (0..1) below which there's nothing to gather
  drainRatio: 1.4, // wakes / captures / bumps only drain when the other river is clearly bigger
  evapBase: 0.0032, // fraction of volume per second
  evapRamp: 0.000035, // extra per second of match time (the drought tightens)
  stagnantMul: 1.7, // slow water evaporates faster
  dryLimit: 15000,
  ratio: 1.15, // "bigger" means at least 15% more water
  cutFraction: 0.3,
  cutGain: 0.8,
  cutCooldown: 4,
  captureRate: 0.04, // bigger river running along your live channel drains it (fraction/s)
  wakeDrain: 0.05, // smaller river running inside a bigger one's channel loses this fraction/s
  crossCos: 0.6, // hitting a channel at more than ~53° is a crossing (cut / block); less is a wake
  blockTime: 0.35, // contact time before you're absorbed = blockTime + blockSlack / (ratio − 1)
  blockSlack: 1.1, //   (×1.2 bigger → 5.8 s to steer out, ×2 → 1.4 s, ×5 → 0.6 s)
  blockDrain: 0.3, // fraction of your volume per second while blocked (+0.1 per extra ×1 of size)
  swallowRatio: 3.5, // a head this many times bigger 'swallows' you (UI wording; still a short press)
  bumpSpeed: 9, // m/s: a bigger head catching you slower than this only shoulders you aside
  swallowGain: 0.5,
  protectTime: 8,
  archBonus: 220000,
  dangerLook: 2.6, // seconds of travel scanned ahead for bigger rivers
  liveLength: 380, // metres of channel behind a head that block / can be cut at full strength
  liveFade: 350, //   …then fading out over this many metres (the old riverbed is harmless)
  resultDelay: 1.6, // seconds between the player's finish/elimination and the result screen
};

const CELL = 40;
const keyOf = (cx, cz) => (cx + 2048) * 4096 + (cz + 2048);

/** Spatial hash of river channel points; append-only during a match. */
class TrailGrid {
  constructor() {
    this.map = new Map();
    this.indexed = new Map();
    this.epochs = new Map();
  }

  reset() {
    this.map.clear();
    this.indexed.clear();
    this.epochs.clear();
  }

  index(s) {
    const t = s.trail;
    if (this.epochs.get(s) !== t.epoch) {
      // the trail was cleared (teleport / revive): drop its old points
      if (this.indexed.has(s)) {
        for (const [k, arr] of this.map) {
          const keep = [];
          for (let n = 0; n < arr.length; n += 2) if (arr[n] !== s) keep.push(arr[n], arr[n + 1]);
          if (keep.length) this.map.set(k, keep);
          else this.map.delete(k);
        }
      }
      this.indexed.set(s, 0);
      this.epochs.set(s, t.epoch);
    }
    let i = this.indexed.get(s) ?? 0;
    const d = t.data;
    for (; i < t.count; i++) {
      const k = keyOf(Math.floor(d[i * 4] / CELL), Math.floor(d[i * 4 + 2] / CELL));
      let arr = this.map.get(k);
      if (!arr) this.map.set(k, (arr = []));
      arr.push(s, i);
    }
    this.indexed.set(s, i);
  }

  /** Calls fn(stream, index) for every channel point in cells overlapping the circle. */
  query(x, z, r, fn) {
    const x0 = Math.floor((x - r) / CELL);
    const x1 = Math.floor((x + r) / CELL);
    const z0 = Math.floor((z - r) / CELL);
    const z1 = Math.floor((z + r) / CELL);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const arr = this.map.get(keyOf(cx, cz));
        if (!arr) continue;
        for (let n = 0; n < arr.length; n += 2) fn(arr[n], arr[n + 1]);
      }
    }
  }
}

export class Rules {
  constructor(game) {
    this.game = game;
    this.config = RULES;
    this.grid = new TrailGrid();
    this.cutCooldown = new Map();
    this.clashCooldown = new Map();
    this._contacts = new Map();
    this._pressed = new Set();
  }

  reset() {
    this.grid.reset();
    this.cutCooldown.clear();
    this.clashCooldown.clear();
    this.rankTimer = 0;
  }

  /** Number of trailing points that belong to a stream's own head (not its channel yet). */
  headSkip(o) {
    return Math.ceil((o.radius * 2.2 + 6) / 4);
  }

  isBigger(a, b) {
    return a.volume >= b.volume * RULES.ratio;
  }

  /** 0..1 how "live" channel point i of stream o is (1 near the head, 0 on the old riverbed). */
  liveness(o, i) {
    const d = (o.trail.count - i) * 4;
    if (d <= RULES.liveLength) return 1;
    return Math.max(0, 1 - (d - RULES.liveLength) / RULES.liveFade);
  }

  /** Effective size of o's channel at point i. */
  channelVolume(o, i) {
    return o.volume * this.liveness(o, i);
  }

  update(dt) {
    const game = this.game;
    const { world, terrain, bus } = game.ctx;
    const hydro = game.hydro;
    const streams = game.streams;

    for (const s of streams) {
      if (s.phase !== 'flow') continue;
      this.grid.index(s);
      s.trail.liveFrom = Math.max(0, s.trail.count - Math.ceil((RULES.liveLength + RULES.liveFade) / 4));
    }
    this._pressed.clear();
    this.heads(dt);

    for (const s of streams) {
      if (!s.alive) continue;
      s.absorbing = 0;
      s.absorbBody = null;
      s.inWake = null;
      if (s.protectedFor > 0) s.protectedFor = Math.max(0, s.protectedFor - dt);

      if (!s.leaping) this.absorb(s, dt);
      if (s.phase === 'drop') {
        this.archCheck(s);
        s.routeDist = hydro.routeDistAt(s.pos.x, s.pos.z);
        s.distToSea = s.routeDist;
        continue;
      }
      if (s.phase !== 'flow') continue;

      s.trail.swell(s.radius, 6);
      s.routeDist = hydro.routeDistAt(s.pos.x, s.pos.z);
      s.distToSea = s.routeDist;
      s.progress = Math.min(1, Math.max(0, 1 - s.routeDist / Math.max(1, s.landRouteDist)));

      // reached the sea
      if (!terrain.isLand(s.pos.x, s.pos.z)) {
        this.finish(s);
        continue;
      }

      // tributaries: flowing down a big valley gathers its runoff (main rivers swell)
      const ch = hydro.channelAt(s.pos.x, s.pos.z);
      const inflow = RULES.inflow * Math.pow(Math.max(0, (ch - RULES.inflowFrom) / (1 - RULES.inflowFrom)), 1.5);
      s.inflow = inflow;
      if (inflow > 0) s.addVolume(inflow * dt);

      // evaporation: the drought tightens as the match goes on; still water dries fastest
      const stagnant = s.flowSpeed < 12 ? RULES.stagnantMul : 1;
      s.addVolume(-s.volume * (RULES.evapBase + RULES.evapRamp * game.time) * stagnant * (s.evapMul || 1) * dt);
      if (s.volume < RULES.dryLimit) {
        this.eliminate(s, null, 'dried', 'dried');
        continue;
      }

      game.obstacles?.check(s, dt);
      if (s.leaping) continue; // airborne: rivers below can't block you
      this.channels(s, dt);
      if (!s.alive) continue;
      this.scanThreats(s);
    }

    // contact released: recover
    for (const s of streams) {
      if (s.phase !== 'flow' || this._pressed.has(s) || s.contact <= 0) continue;
      s.contact = Math.max(0, s.contact - dt * 1.2);
      if (s.contact === 0) s.contactWith = null;
    }
    this.tickCooldowns(this.cutCooldown, dt);
    this.tickCooldowns(this.clashCooldown, dt);

    this.rankTimer = (this.rankTimer ?? 0) - dt;
    if (this.rankTimer <= 0) {
      this.rankTimer = 0.2;
      this.rank();
    }
  }

  tickCooldowns(map, dt) {
    for (const [k, t] of map) {
      if (t - dt <= 0) map.delete(k);
      else map.set(k, t - dt);
    }
  }

  // --- still water / clouds ---------------------------------------------------

  absorb(s, dt) {
    const { world, bus } = this.game.ctx;
    const drop = s.phase === 'drop';
    const holder = drop ? world.skyWater : world.lakes;
    if (!holder) return;
    const vf = volumeFactor(s.volume);
    for (const b of holder.bodies) {
      if (b.volume <= 0) continue;
      const dx = b.x - s.pos.x;
      const dz = b.z - s.pos.z;
      const dy = drop ? (b.y - s.pos.y) / 0.8 : 0;
      const reach = b.radius + s.radius * (drop ? 1.0 : 0.8);
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
      if (!drop && Math.abs(b.y - s.pos.y) > 30 + b.radius * 0.15) continue;
      const T = RULES.swallowTime[b.kind] ?? 2;
      const want = (b.maxVolume / T) * (1 + 0.25 * Math.max(0, vf)) * dt;
      const drained = holder.drain(b, want);
      if (drained <= 0) continue;
      const K = RULES.absorbK[b.kind] ?? RULES.absorbK.lake;
      const eff = Math.min(1, K / Math.sqrt(Math.max(1, b.maxVolume)));
      const amount = drained * eff * (s.absorbMul || 1);
      b.drainedBy = s;
      s.addVolume(amount);
      s.absorbing += amount / dt;
      s.absorbBody = b;
      s.absorbedTotal += amount;
      bus.emit('absorb', { stream: s, body: b, amount });
    }
  }

  archCheck(s) {
    const arch = this.game.ctx.world?.landmarks?.arch;
    if (!arch || s.archBonus) return;
    const gate = archGate(arch);
    const d = s.pos.distanceTo(gate.center);
    if (d < gate.radius + s.radius * 0.6) {
      s.archBonus = true;
      s.addVolume(RULES.archBonus);
      this.game.ctx.bus.emit('bonus', { stream: s, kind: 'arch', amount: RULES.archBonus });
    }
  }

  // --- river vs river -----------------------------------------------------------

  channels(s, dt) {
    const game = this.game;
    const { bus } = game.ctx;
    const contacts = this._contacts;
    contacts.clear();
    const r = s.radius;
    const px = s.pos.x;
    const pz = s.pos.z;
    this.grid.query(px, pz, r + 30, (o, i) => {
      if (o === s || o.phase !== 'flow') return;
      if (i >= o.trail.count - this.headSkip(o) || i < o.trail.liveFrom) return;
      const d = o.trail.data;
      const dx = d[i * 4] - px;
      const dz = d[i * 4 + 2] - pz;
      const reach = d[i * 4 + 3] + r * 0.5;
      const dd = dx * dx + dz * dz;
      if (dd > reach * reach) return;
      const prev = contacts.get(o);
      if (prev === undefined || i > prev.i) contacts.set(o, { dd, i, cv: this.channelVolume(o, i) });
    });

    let blocked = null;
    let blockedV = 0;
    for (const [o, c] of contacts) {
      if (s.protectedFor > 0) break;
      if (c.cv <= 0) continue;
      if (s.volume >= c.cv * RULES.ratio) {
        // crossing (not running along) a smaller river cuts it off
        const along = this.alongness(o, c.i, s);
        const key = `${s.id}:${o.id}`;
        if (along < RULES.crossCos) {
          if (!this.cutCooldown.has(key)) this.cut(s, o, c.i);
        } else if (s.volume >= c.cv * RULES.drainRatio) {
          // running down someone's channel: capture their flow little by little
          const amount = o.volume * RULES.captureRate * this.liveness(o, c.i) * dt;
          o.addVolume(-amount);
          s.addVolume(amount * RULES.cutGain);
          o.lastHitAt = game.time;
          if (o.volume < RULES.dryLimit) this.eliminate(o, s, 'blocked', 'captured');
        }
      } else if (c.cv >= s.volume * RULES.ratio && o.protectedFor <= 0) {
        if (this.alongness(o, c.i, s) >= RULES.crossCos) {
          // caught in a bigger river's wake: it drains you, get out
          if (c.cv < s.volume * RULES.drainRatio) continue;
          const amount = s.volume * RULES.wakeDrain * this.liveness(o, c.i) * dt;
          s.addVolume(-amount);
          o.addVolume(amount * RULES.cutGain);
          s.lastHitAt = game.time;
          s.inWake = o;
          if (s.volume < RULES.dryLimit) {
            o.kills++;
            this.eliminate(s, o, 'blocked', 'wake');
            return;
          }
        } else if (!blocked || c.cv > blockedV) {
          blocked = o;
          blockedV = c.cv;
        }
      }
    }

    if (blocked) this.press(s, blocked, dt, 'blocked', blockedV, 'crossed');
  }

  /** |cos| between o's channel direction at point i and s's heading (1 = running along it). */
  alongness(o, i, s) {
    const d = o.trail.data;
    const i0 = Math.max(0, i - 2);
    const i1 = Math.min(o.trail.count - 1, i + 2);
    const tx = d[i1 * 4] - d[i0 * 4];
    const tz = d[i1 * 4 + 2] - d[i0 * 4 + 2];
    const tl = Math.hypot(tx, tz) || 1;
    return Math.abs((tx * s.heading.x + tz * s.heading.y) / tl);
  }

  /** `s` is pressed against a bigger river `big`: bleed water, and be absorbed if it lasts. */
  press(s, big, dt, reason, bigV = big.volume, how = 'crossed') {
    const game = this.game;
    const ratio = bigV / Math.max(1, s.volume);
    const T = RULES.blockTime + RULES.blockSlack / Math.max(0.05, ratio - 1);
    this._pressed.add(s);
    s.contact = Math.min(1, s.contact + dt / T);
    s.contactWith = big;
    s.lastHitAt = game.time;
    const loss = s.volume * Math.min(0.8, RULES.blockDrain + 0.1 * (ratio - 1)) * dt;
    s.addVolume(-loss);
    big.addVolume(loss * RULES.swallowGain);
    s.flowSpeed *= 1 - Math.min(0.5, dt * 0.35);
    if (s.contact >= 1 || s.volume < RULES.dryLimit) {
      big.addVolume(s.volume * RULES.swallowGain);
      big.kills++;
      big.lastCutAt = game.time;
      this.splash(s, 'cut', s.radius * 3);
      this.eliminate(s, big, reason, how);
    }
  }

  cut(attacker, victim, index) {
    const game = this.game;
    const amount = victim.volume * RULES.cutFraction;
    victim.addVolume(-amount);
    attacker.addVolume(amount * RULES.cutGain);
    victim.lastHitAt = game.time;
    victim.flowSpeed *= 0.75;
    attacker.lastCutAt = game.time;
    attacker.cuts++;
    this.cutCooldown.set(`${attacker.id}:${victim.id}`, RULES.cutCooldown);
    game.ctx.bus.emit('cut', { attacker, victim, amount, x: attacker.pos.x, y: attacker.pos.y, z: attacker.pos.z, index });
    this.splash(attacker, 'cut', attacker.radius * 2.5);
    if (victim.volume < RULES.dryLimit * 2) {
      attacker.addVolume(victim.volume * RULES.swallowGain);
      attacker.kills++;
      this.eliminate(victim, attacker, 'blocked', 'cut');
    }
  }

  /** Head-on collisions: a clearly bigger head swallows the smaller; equals bounce. */
  heads(dt) {
    const streams = this.game.streams;
    for (let i = 0; i < streams.length; i++) {
      const a = streams[i];
      if (a.phase !== 'flow' || a.leaping) continue;
      for (let j = i + 1; j < streams.length; j++) {
        const b = streams[j];
        if (b.phase !== 'flow' || b.leaping) continue;
        const r = a.radius + b.radius;
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const dd = dx * dx + dz * dz;
        if (dd > r * r) continue;
        if (a.protectedFor > 0 || b.protectedFor > 0) continue;
        const [big, small] = a.volume >= b.volume ? [a, b] : [b, a];
        // how hard are they running into each other?
        const d = Math.sqrt(dd) || 1;
        const nx = (small.pos.x - big.pos.x) / d;
        const nz = (small.pos.z - big.pos.z) / d;
        const closing = (big.vel.x - small.vel.x) * nx + (big.vel.z - small.vel.z) * nz;
        const sameWay = big.heading.dot(small.heading) > RULES.crossCos;
        if (sameWay && closing < RULES.bumpSpeed && this.isBigger(big, small)) {
          const drains = big.volume >= small.volume * RULES.drainRatio;
          // a bigger river catching up from behind shoulders you aside and drinks some of you
          const push = (r - d) * 0.6 + 0.3;
          const side = Math.sign(-big.heading.y * nx + big.heading.x * nz) || 1;
          small.pos.x += -big.heading.y * side * push;
          small.pos.z += big.heading.x * side * push;
          const amount = drains ? small.volume * RULES.wakeDrain * dt : 0;
          small.addVolume(-amount);
          big.addVolume(amount * RULES.cutGain);
          small.lastHitAt = this.game.time;
          if (drains) small.inWake = big;
          if (small.volume < RULES.dryLimit) {
            big.kills++;
            this.eliminate(small, big, 'swallowed', 'bumped');
          }
        } else if (this.isBigger(big, small)) {
          // rammed by a bigger head: a short, readable struggle (≥ blockTime) — a much bigger
          // one wins it fast, a slightly bigger one gives you seconds to tear free
          this.press(small, big, dt, 'swallowed', big.volume, big.volume >= small.volume * RULES.swallowRatio ? 'swallowed' : 'head');
        } else {
          // equals clash: shove apart, both lose a little
          const push = (r - d) * 0.5 + 0.5;
          a.pos.x -= (dx / d) * push;
          a.pos.z -= (dz / d) * push;
          b.pos.x += (dx / d) * push;
          b.pos.z += (dz / d) * push;
          a.addVolume(-a.volume * 0.004);
          b.addVolume(-b.volume * 0.004);
          const key = `${a.id}:${b.id}`;
          if (!this.clashCooldown.has(key)) {
            this.clashCooldown.set(key, 1.2);
            this.splash(a, 'clash', (a.radius + b.radius) * 1.2, (a.pos.x + b.pos.x) / 2, (a.pos.z + b.pos.z) / 2);
          }
        }
      }
    }
  }

  /** Look ahead along the heading for bigger rivers (channels or heads) — UI/AI warnings. */
  scanThreats(s) {
    const look = Math.max(45, s.flowSpeed * RULES.dangerLook);
    let best = null;
    let bestD = Infinity;
    const r = s.radius;
    const steps = 5;
    for (let k = 0; k <= steps && !best; k++) {
      const dist = (k / steps) * look;
      const qx = s.pos.x + s.heading.x * dist;
      const qz = s.pos.z + s.heading.y * dist;
      this.grid.query(qx, qz, r + 30, (o, i) => {
        if (o === s || o.phase !== 'flow' || !this.isBigger(o, s)) return;
        if (i >= o.trail.count - this.headSkip(o) || i < o.trail.liveFrom) return;
        if (this.channelVolume(o, i) < s.volume * RULES.ratio) return;
        const d = o.trail.data;
        const dx = d[i * 4] - qx;
        const dz = d[i * 4 + 2] - qz;
        const reach = d[i * 4 + 3] + r;
        if (dx * dx + dz * dz > reach * reach) return;
        if (dist < bestD) {
          bestD = dist;
          best = o;
        }
      });
    }
    // bigger heads closing in (predicted 1.5 s ahead)
    for (const o of this.game.streams) {
      if (o === s || o.phase !== 'flow' || !this.isBigger(o, s)) continue;
      const dx = o.pos.x + o.vel.x * 0.8 - (s.pos.x + s.vel.x * 0.8);
      const dz = o.pos.z + o.vel.z * 0.8 - (s.pos.z + s.vel.z * 0.8);
      const d = Math.hypot(dx, dz) - o.radius - r;
      if (d < look * 0.6 && d < bestD) {
        bestD = Math.max(0, d);
        best = o;
      }
    }
    const target = best ? 1 - Math.min(1, bestD / look) : 0;
    s.danger += (Math.max(target, s.contact) - s.danger) * 0.35;
    s.threat = best ?? (s.contact > 0 ? s.contactWith : null);
  }

  // --- outcomes -----------------------------------------------------------------------

  finish(s) {
    const game = this.game;
    const { bus, terrain } = game.ctx;
    s.phase = 'finished';
    s.place = ++game.finishCount;
    s.livePlace = s.place;
    s.finishedAt = game.time;
    s.distToSea = 0;
    s.routeDist = 0;
    s.progress = 1;
    s.danger = 0;
    s.contact = 0;
    s.pos.y = terrain.seaLevel;
    bus.emit('finished', { stream: s, place: s.place });
    this.splash(s, 'finish', s.radius * 6);
  }

  splash(s, kind, size, x = s.pos.x, z = s.pos.z) {
    this.game.ctx.bus.emit('splash', { x, y: s.pos.y, z, size, stream: s, kind });
  }

  /**
   * how (extra detail for UI copy): 'crossed' ran into a bigger river's path · 'head' rammed by a
   * bigger head · 'swallowed' a much bigger head ate you · 'cut' your channel was cut until dry ·
   * 'wake' / 'bumped' / 'captured' drained dry by a bigger river · 'dried' evaporated
   */
  eliminate(victim, by, reason, how = reason) {
    if (!victim.alive) return;
    const game = this.game;
    victim.phase = 'eliminated';
    victim.eliminatedBy = by;
    victim.eliminatedReason = reason;
    victim.eliminatedHow = how;
    victim.eliminatedAt = game.time;
    victim.danger = 0;
    victim.contact = 0;
    victim.place = game.streams.filter((s) => s.alive).length + game.finishCount + 1;
    victim.livePlace = victim.place;
    game.ctx.bus.emit('eliminated', { victim, by, reason, how });
  }

  /** Live ranking: finishers by place, then the living by distance to the sea, then the fallen. */
  rank() {
    const list = this.game.streams.slice();
    const key = (s) => {
      if (s.phase === 'finished') return s.place;
      if (s.alive) return 100 + (s.phase === 'drop' ? s.routeDist + Math.max(0, s.pos.y) * 0.5 : s.routeDist) / 1e5;
      return 1000 + (100 - s.place);
    };
    list.sort((a, b) => key(a) - key(b));
    list.forEach((s, i) => {
      if (s.alive) s.livePlace = i + 1;
    });
  }
}
