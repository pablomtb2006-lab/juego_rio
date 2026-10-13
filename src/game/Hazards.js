import * as THREE from 'three';
import { mulberry32 } from '../core/random.js';

/**
 * HAZARDS (TRAMO C) — everything on the island that dries, evaporates or slows a river.
 * Positions and mix are rolled fresh from the match seed, so no two races are the same, and
 * they are stacked onto the short branch of every fork: that is what makes "CORTA · PELIGROSA"
 * something you feel rather than something a sign claims.
 *
 * Effects a hazard can have (all optional, all scaled by how deep inside you are):
 *   drain    litres per second burned off while inside
 *   gulp     one-off fraction of your volume, once per visit
 *   slowTo   caps your speed while inside (m/s)
 *   evap     multiplies the normal evaporation while inside
 *   grip     multiplies how fast you can turn while inside (ice)
 *   blind    fogs the player's view while inside
 *   burst    only dangerous while it is erupting (geysers)
 *
 * Contract: hazards.list, hazards.place(seed), hazards.check(stream, dt), hazards.ahead(stream).
 * Stream fields written: hazardEvap, gripMul, blinded, inHazard.
 */
export const HAZARD_TYPES = {
  lava: { drain: 180000, slowTo: 26, radius: [24, 42], color: 0xff5a1e, weight: 1.0, warn: 'lava' },
  geyser: { burst: true, drain: 300000, radius: [13, 20], color: 0xdfe9ff, weight: 0.9, warn: 'geyser' },
  sand: { drain: 68000, slowTo: 17, radius: [34, 62], color: 0xe3cf92, weight: 1.1, warn: 'sand' },
  sinkhole: { gulp: 0.13, radius: [15, 26], color: 0x241d18, weight: 0.8, warn: 'sinkhole' },
  sun: { evap: 2.4, radius: [55, 95], color: 0xffd98a, weight: 0.9, warn: 'sun' },
  ice: { grip: 0.42, slowTo: 46, radius: [32, 58], color: 0xbfe8ff, weight: 0.7, warn: 'ice' },
  rocks: { slowTo: 13, radius: [22, 38], color: 0x8e8174, weight: 1.0, warn: 'rocks' },
  steam: { blind: 1, radius: [30, 52], color: 0xd8e4ec, weight: 0.6, warn: 'steam' },
};

const KEYS = Object.keys(HAZARD_TYPES);
const COUNT = 210; // hazards placed per match (the renderer holds 300: the rest is the lava front)
const SHORT_SHARE = 0.3; // of them, this share is stacked on the fork short branches
const ROUTE_SHARE = 0.85; // …and up to this share sits right on the routes water actually takes

/** Rough size of a kind, used to space them before the exact radius is rolled. */
const radiusHint = (kind) => (HAZARD_TYPES[kind].radius[0] + HAZARD_TYPES[kind].radius[1]) / 2;

export class Hazards {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.version = 0;
  }

  /** Roll a fresh layout for this match. */
  place(seed = 1) {
    const { terrain } = this.game.ctx;
    const hydro = this.game.hydro;
    const zone = this.game.dropZone;
    if (!hydro) return;
    const rand = mulberry32((seed >>> 0) * 7717 + 31);
    const list = [];

    // the biome (game/biomes.js) decides which traps this island grows: a frozen valley is
    // made of ice and steam, a caldera of lava and geysers
    const bw = this.game.biome?.hazards ?? {};
    const w = (k) => HAZARD_TYPES[k].weight * (bw[k] ?? 1);
    const pick = () => {
      let total = 0;
      for (const k of KEYS) total += w(k);
      let r = rand() * total;
      for (const k of KEYS) {
        r -= w(k);
        if (r <= 0) return k;
      }
      return KEYS[0];
    };

    const add = (x, z, kind) => {
      const h = terrain.heightAt(x, z);
      if (h < 12 || h > 1550) return false;
      if (hydro.basinDepthAt(x, z) > 1.5) return false; // not in standing water
      if (zone && Math.hypot(x - zone.x, z - zone.z) < zone.radius * 0.8) return false; // not on the drop
      if (list.some((o) => Math.hypot(o.x - x, o.z - z) < o.radius + radiusHint(kind) * 0.5)) return false;
      const T = HAZARD_TYPES[kind];
      const radius = T.radius[0] + rand() * (T.radius[1] - T.radius[0]);
      list.push({
        id: list.length,
        kind,
        x,
        z,
        y: h,
        radius,
        phase: rand() * Math.PI * 2, // geyser timing / shader variation
        period: 4.5 + rand() * 4,
      });
      return true;
    };

    // 1) stacked on the short (dangerous) branch of every fork
    const shortBranches = (this.game.forks?.list ?? []).map((f) => f.shortBranch).filter(Boolean);
    const wanted = Math.round(COUNT * SHORT_SHARE);
    let tries = 0;
    while (shortBranches.length && list.length < wanted && tries++ < wanted * 12) {
      const br = shortBranches[Math.floor(rand() * shortBranches.length)];
      const pts = br.points;
      const i = 2 + Math.floor(rand() * Math.max(1, pts.length - 4));
      const p = pts[i];
      if (!p) continue;
      // right in the channel or just beside it, so the corridor really is narrow
      const a = rand() * Math.PI * 2;
      const off = rand() * 55;
      add(p.x + Math.cos(a) * off, p.z + Math.sin(a) * off, pick());
    }

    // 2) strung along the routes the water really takes, so they are on the way, not scenery
    const routes = [];
    if (zone) {
      const pts = [];
      for (let k = 0; k < 20; k++) {
        const a = (k / 20) * Math.PI * 2;
        const x = zone.x + Math.cos(a) * zone.radius * 0.8;
        const z = zone.z + Math.sin(a) * zone.radius * 0.8;
        if (!terrain.isLand(x, z)) continue;
        pts.length = 0;
        hydro.traceRoute(x, z, 40000, 60, pts);
        if (pts.length > 8) routes.push(pts.map((p) => ({ x: p.x, z: p.z })));
      }
    }
    const routeWanted = Math.round(COUNT * ROUTE_SHARE);
    tries = 0;
    while (routes.length && list.length < routeWanted && tries++ < routeWanted * 14) {
      const r = routes[Math.floor(rand() * routes.length)];
      const i = 3 + Math.floor(rand() * Math.max(1, r.length - 5));
      const p = r[i];
      if (!p) continue;
      const a = rand() * Math.PI * 2;
      const off = rand() * 48;
      add(p.x + Math.cos(a) * off, p.z + Math.sin(a) * off, pick());
    }

    // 3) a thin scatter elsewhere so the rest of the island is not sterile
    tries = 0;
    const half = terrain.size * 0.46;
    while (list.length < COUNT && tries++ < COUNT * 30) {
      const x = (rand() * 2 - 1) * half;
      const z = (rand() * 2 - 1) * half;
      if (hydro.channelAt(x, z) < 0.25 && rand() < 0.75) continue;
      add(x, z, pick());
    }

    this.list = list;
    this.version++;
    this.hitCool = new WeakMap();
  }

  /** Is this hazard dangerous right now? (geysers only erupt in bursts) */
  activeAt(hz, time) {
    if (!HAZARD_TYPES[hz.kind].burst) return 1;
    const t = (time / hz.period + hz.phase) % 1;
    return t > 0.72 ? Math.min(1, (t - 0.72) / 0.08) : 0;
  }

  /** Called by Rules for every flowing stream. */
  check(s, dt) {
    s.hazardEvap = 1;
    s.gripMul = this.game.biome?.grip ?? 1; // ice biome: the whole island is slippery
    s.inHazard = null;
    if (s.leaping) return; // airborne: hazards on the ground cannot touch you
    const time = this.game.time;
    const { bus } = this.game.ctx;
    for (const hz of this.list) {
      const dx = hz.x - s.pos.x;
      const dz = hz.z - s.pos.z;
      const reach = hz.radius + s.radius * 0.5;
      const d2 = dx * dx + dz * dz;
      if (d2 > reach * reach) continue;
      if (Math.abs(hz.y - s.pos.y) > 45) continue;
      const T = HAZARD_TYPES[hz.kind];
      const live = this.activeAt(hz, time);
      if (live <= 0) continue;
      // deeper inside hurts more — and the traps bite the player a little softer, see
      // game/difficulty.js (the invisible half of "hard but winnable")
      const soft = s.isPlayer ? this.game.difficulty?.playerHazard ?? 1 : 1;
      const bite = live * (1 - Math.sqrt(d2) / reach) ** 0.6 * soft;
      s.inHazard = hz;
      if (T.drain) s.addVolume(-T.drain * bite * dt);
      if (T.evap) s.hazardEvap = Math.max(s.hazardEvap, 1 + (T.evap - 1) * bite);
      if (T.grip) s.gripMul = Math.min(s.gripMul, 1 - (1 - T.grip) * bite);
      if (T.slowTo && s.flowSpeed > T.slowTo) s.flowSpeed += (T.slowTo - s.flowSpeed) * Math.min(1, dt * 3 * bite);
      if (T.blind && s.isPlayer) s.blinded = Math.max(s.blinded || 0, bite);
      if (T.gulp) {
        let cool = this.hitCool.get(s);
        if (!cool) this.hitCool.set(s, (cool = new Map()));
        if ((cool.get(hz.id) ?? -99) < time - 6) {
          cool.set(hz.id, time);
          s.addVolume(-s.volume * T.gulp);
          bus.emit('hazardHit', { stream: s, hazard: hz, kind: hz.kind });
        }
      } else if (s.isPlayer && (!this._lastWarn || time - this._lastWarn > 1.6) && bite > 0.25) {
        this._lastWarn = time;
        bus.emit('hazardHit', { stream: s, hazard: hz, kind: hz.kind });
      }
    }
  }

  /** The nearest hazard in front of a stream, for the HUD warning and for the AI to dodge. */
  ahead(s, range = 220) {
    let best = null;
    let bd = range;
    for (const hz of this.list) {
      const dx = hz.x - s.pos.x;
      const dz = hz.z - s.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > bd || d < 1) continue;
      if ((dx * s.heading.x + dz * s.heading.y) / d < 0.6) continue;
      bd = d;
      best = hz;
    }
    return best;
  }
}
