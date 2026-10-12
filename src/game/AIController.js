import * as THREE from 'three';
import { PHYS, signedAngle } from './StreamPhysics.js';
import { RULES } from './Rules.js';
import { archGate } from './arch.js';

const _r = new THREE.Vector2();
const _d = new THREE.Vector2();
const _p = new THREE.Vector2();

/**
 * Personalities (see names.js PERSONALITIES):
 *   greedy    lake-hunter: detours for any still water it can reach
 *   sprinter  shortest route: hunts shortcuts across saddles, surges on straights
 *   bully     shadows smaller rivers and cuts across their path
 *   cautious  gives bigger rivers a wide berth, rarely takes risks
 *   balanced  a bit of everything
 */
export const TRAITS = {
  balanced: { greed: 1.1, caution: 0.75, aggression: 0.6, shortcut: 0.7, surge: 0.6, cloud: 0.9, react: 0.26 },
  greedy: { greed: 2.0, caution: 0.55, aggression: 0.3, shortcut: 0.3, surge: 0.4, cloud: 1.4, react: 0.3 },
  sprinter: { greed: 0.4, caution: 0.6, aggression: 0.25, shortcut: 1.0, surge: 1.0, cloud: 0.4, react: 0.24 },
  bully: { greed: 0.8, caution: 0.35, aggression: 1.0, shortcut: 0.4, surge: 0.8, cloud: 0.85, react: 0.26 },
  cautious: { greed: 0.9, caution: 1.0, aggression: 0.15, shortcut: 0.5, surge: 0.45, cloud: 0.9, react: 0.24 },
};

/** Litres a body is worth to whoever swallows it (mirrors Rules.absorb). */
export const bodyValue = (b) =>
  Math.min(b.maxVolume, (RULES.absorbK[b.kind] ?? RULES.absorbK.lake) * Math.sqrt(Math.max(1, b.maxVolume))) * (b.volume / b.maxVolume);

/**
 * Rival brain. Writes stream.input exactly like a human would (steer / move / surge),
 * so humans and bots obey the same physics. Re-plans a few times per second
 * (reaction time) and smooths its inputs.
 */
export class AIController {
  constructor(stream, rand, opts = {}) {
    this.stream = stream;
    this.rand = rand;
    const D = (this.difficulty = opts.difficulty ?? null);
    const base = { ...(TRAITS[stream.personality] ?? TRAITS.balanced), ...(opts.traits ?? {}) };
    if (D) {
      // new-player ramp: bullies hold back and everyone gives bigger rivers a wider berth
      base.aggression *= D.aggression;
      base.caution = Math.min(1.4, base.caution * D.caution);
    }
    this.traits = base;
    this.skill = (opts.skill ?? 0.98 + rand() * 0.07) * (D ? D.aiSkill : 1);
    this.rubberBand = opts.rubberBand ?? !stream.isPlayer;
    this.wander = rand() * 100;
    this.planT = rand() * 0.3;
    this.dropTarget = null;
    this.aim = null; // current drop aim (cloud or landing target)
    this.goal = 'route';
    this.goalBody = null;
    this.prey = null;
    this.steer = 0;
    this.steerTarget = 0;
    this.pitch = 0;
    this.surgeT = 0;
    this.surgeCool = rand() * 4;
    this.stuckT = 0;
    this.stuckRef = Infinity;
    this.routeOnly = 0;
    this.archRun = opts.archRun ?? false;
  }

  update(dt, game) {
    const s = this.stream;
    this.wander += dt * 0.6;
    if (s.phase === 'drop') this.updateDrop(dt, game);
    else if (s.phase === 'flow') this.updateFlow(dt, game);
  }

  // --- DROP -----------------------------------------------------------------------

  pickDropTarget(game) {
    const { terrain } = game.ctx;
    const hydro = game.hydro;
    const zone = game.dropZone;
    const s = this.stream;
    const T = this.traits;
    const lakes = game.ctx.world?.lakes?.bodies ?? [];
    const claims = (game.dropClaims ??= []);
    let best = null;
    let bestScore = -Infinity;
    const alt = s.pos.y;
    const glideReach = (alt / PHYS.dropFall[0]) * PHYS.dropHoriz[0] * 0.8;
    const route = [];
    for (let n = 0; n < 40; n++) {
      const a = this.rand() * Math.PI * 2;
      const r = Math.sqrt(this.rand()) * zone.radius * 0.9;
      const x = zone.x + Math.cos(a) * r;
      const z = zone.z + Math.sin(a) * r;
      if (!terrain.isLand(x, z)) continue;
      const rd = hydro.routeDistAt(x, z);
      const h = terrain.heightAt(x, z);
      const far = Math.hypot(x - s.pos.x, z - s.pos.z);
      let score = -rd / 900 + h / 700;
      // still water downstream is worth a lot to a greedy river
      hydro.traceRoute(x, z, 1800, 40, route);
      for (const b of lakes) {
        if (b.volume <= 0) continue;
        for (let i = 0; i < route.length; i += 2) {
          const p = route[i];
          if ((p.x - b.x) ** 2 + (p.z - b.z) ** 2 < (b.radius + 40) ** 2) {
            score += (bodyValue(b) / 1e6) * T.greed * 1.4;
            break;
          }
        }
      }
      // basins are slow: penalise routes that wade through deep pools
      let pool = 0;
      for (let i = 0; i < route.length; i += 3) if (hydro.basinDepthAt(route[i].x, route[i].z) > 4) pool++;
      score -= pool * 0.08;
      if (far > glideReach) score -= (far - glideReach) / 300;
      for (const c of claims) {
        const dc = Math.hypot(c.x - x, c.z - z);
        if (dc < 220) score -= (220 - dc) / 220;
      }
      // rivals like to land where the action is: near the player's drop line
      const pl = game.player;
      if (pl && pl !== s) {
        const dp = Math.hypot(x - pl.pos.x, z - pl.pos.z);
        score += Math.max(0, 1 - dp / 1400) * 1.3 * (this.difficulty?.dropNearPlayer ?? 1);
      }
      score += this.rand() * 0.6;
      if (score > bestScore) {
        bestScore = score;
        best = { x, z };
      }
    }
    if (!best) best = { x: zone.x, z: zone.z };
    claims.push(best);
    return best;
  }

  updateDrop(dt, game) {
    const s = this.stream;
    const { terrain } = game.ctx;
    if (!this.dropTarget) this.dropTarget = this.pickDropTarget(game);
    this.planT -= dt;
    if (this.planT <= 0) {
      this.planT = this.traits.react;
      this.aim = this.archRun ? this.archAim(game) : this.cloudAim(game) ?? this.dropTarget;
    }
    const aim = this.aim ?? this.dropTarget;
    _d.set(aim.x - s.pos.x, aim.z - s.pos.z);
    const D = _d.length();
    const groundT = terrain.heightAt(aim.x, aim.z);
    const A = Math.max(1, s.pos.y - (aim.y ?? groundT));
    let turn = 0;
    if (D > 12) {
      _d.divideScalar(D);
      turn = THREE.MathUtils.clamp(signedAngle(s.heading.x, s.heading.y, _d.x, _d.y) * 1.8, -1, 1);
    }
    // glide ratio needed to get there
    const q = D / A;
    let pitch = q > 0.42 ? -1 : q > 0.26 ? 0 : 1;
    if (aim.cloud) pitch = q > 0.5 ? -1 : q > 0.3 ? -0.2 : 0.4;
    // nobody wants to be last on the ground
    const tDrop = game.time;
    if (tDrop > 16) pitch = Math.max(pitch, Math.min(1, (tDrop - 16) / 8));
    if (this.archRun && aim.pitch !== undefined) pitch = aim.pitch;
    this.pitch += (pitch - this.pitch) * Math.min(1, dt * 3);
    s.input.move.set(turn, this.pitch);
    s.input.steer = turn;
    s.input.surge = false;
  }

  /** Best cloud reachable on the way down that doesn't wreck the landing plan. */
  cloudAim(game) {
    const s = this.stream;
    const clouds = game.ctx.world?.skyWater?.bodies ?? [];
    const T = this.traits;
    let best = null;
    let bestScore = 0;
    for (const b of clouds) {
      if (b.volume <= b.maxVolume * 0.15) continue;
      const below = s.pos.y - b.y;
      if (below < -b.radius * 0.5 || below > 1200) continue;
      const tFall = Math.max(0.5, below / PHYS.dropFall[1]);
      const reach = tFall * PHYS.dropHoriz[0] + b.radius;
      const d = Math.hypot(b.x - s.pos.x, b.z - s.pos.z);
      if (d > reach) continue;
      // don't stray too far from the landing target
      const dt = this.dropTarget ? Math.hypot(b.x - this.dropTarget.x, b.z - this.dropTarget.z) : 0;
      if (dt > 1100) continue;
      const score = ((bodyValue(b) / 1e5) * T.cloud) / (1 + d / 250 + dt / 900);
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }
    return best ? { x: best.x, z: best.z, y: best.y, cloud: true } : null;
  }

  /** Line the drop up to pass through the summit arch (autopilot showcase / bonus). */
  archAim(game) {
    const arch = game.ctx.world?.landmarks?.arch;
    if (!arch || this.stream.archBonus) return this.dropTarget;
    const s = this.stream;
    const { center: a, normal: n } = archGate(arch);
    const above = s.pos.y - a.y;
    // approach from behind the arch (+n) on a glide line that meets the opening
    const back = Math.max(0, above) * 0.45;
    return { x: a.x + n.x * back, z: a.z + n.z * back, y: a.y, pitch: above > 900 ? 1 : 0.15 };
  }

  // --- FLOW ---------------------------------------------------------------------

  updateFlow(dt, game) {
    const s = this.stream;
    const hydro = game.hydro;
    hydro.flowDirAt(s.pos.x, s.pos.z, _r);
    if (_r.lengthSq() < 0.5) _r.copy(s.heading);

    this.trackStuck(dt);
    this.planT -= dt;
    if (this.planT <= 0) {
      this.planT = this.traits.react * (0.8 + this.rand() * 0.4);
      this.plan(game);
    }

    // convert the desired direction into a steer value relative to the valley line
    let target = 0;
    if (this.desired && this.routeOnly <= 0) {
      target = THREE.MathUtils.clamp(signedAngle(_r.x, _r.y, this.desired.x, this.desired.y) / PHYS.steerAngle, -1, 1);
    }
    target += Math.sin(this.wander * 1.3) * 0.08;
    this.steer += (target - this.steer) * Math.min(1, dt * 5);
    s.input.steer = THREE.MathUtils.clamp(this.steer, -1, 1);
    s.input.move.set(s.input.steer, 0);
    s.input.surge = this.decideSurge(dt, game);

    // leap: over a dam that blocks us, out of a dead end, or a bully pouncing on its prey
    let jump = !!s.wantLeap;
    s.wantLeap = false;
    if (!jump && s.leapCool <= 0) {
      if (this.stuckT > 5 && s.flowSpeed < 4) jump = true;
      else if (this.goal === 'hunt' && this.prey?.phase === 'flow') {
        const d = s.pos.distanceTo(this.prey.pos);
        if (d > 60 && d < 170 && this.prey.volume < s.volume * 0.8 && this.rand() < dt * 0.25) jump = true;
      }
    }
    s.input.jump = jump;

    if (this.rubberBand) this.applyRubberBand(dt, game);
  }

  trackStuck(dt) {
    const s = this.stream;
    this.stuckT += dt;
    if (this.routeOnly > 0) this.routeOnly -= dt;
    if (this.stuckT > 5) {
      if (this.stuckRef - s.routeDist < 25) this.routeOnly = 3; // not progressing: just follow the water
      this.stuckRef = s.routeDist;
      this.stuckT = 0;
    }
  }

  plan(game) {
    const s = this.stream;
    const T = this.traits;
    this.desired = null;
    this.goal = 'route';
    this.goalBody = null;
    this.prey = null;

    // 1. a bigger river ahead: get out of its way
    if (s.threat && (s.danger > 0.08 || s.inWake) && T.caution > 0) {
      const dir = this.escapeDir(game);
      if (dir && this.rand() < 0.55 + T.caution * 0.45) {
        this.desired = dir;
        this.goal = 'evade';
        return;
      }
    }
    // 2. hunt a smaller river
    if (T.aggression > 0.25 && s.volume > 230000 && game.time - s.landedAt > 18) {
      const hunt = this.huntDir(game);
      if (hunt) {
        this.desired = hunt;
        this.goal = 'hunt';
        return;
      }
    }
    // 3. still water worth a detour
    const lake = this.lakeDir(game);
    if (lake) {
      this.desired = lake;
      this.goal = 'lake';
      return;
    }
    // 4. a shortcut across a gentle saddle
    if (T.shortcut > 0.3) {
      const sc = this.shortcutDir(game);
      if (sc) {
        this.desired = sc;
        this.goal = 'shortcut';
      }
    }
  }

  climbBudget() {
    const sp = this.stream.flowSpeed;
    return (sp * sp) / (2 * PHYS.g) * 0.7 + 2;
  }

  passable(game, x, z) {
    const s = this.stream;
    return game.hydro.maxRiseAlong(s.pos.x, s.pos.z, x, z, 10) < this.climbBudget();
  }

  lakeDir(game) {
    const s = this.stream;
    const T = this.traits;
    const lakes = game.ctx.world?.lakes?.bodies ?? [];
    let best = null;
    let bestScore = 0.05;
    for (const b of lakes) {
      if (b.volume <= b.maxVolume * 0.05) continue;
      const dx = b.x - s.pos.x;
      const dz = b.z - s.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 520 + b.radius || dist < 1) continue;
      if (b.y > s.pos.y + 4) continue;
      const ahead = (dx * s.heading.x + dz * s.heading.y) / dist;
      if (ahead < 0.15 && dist > b.radius + s.radius) continue;
      const edge = Math.max(0, dist - b.radius * 0.6);
      const ex = s.pos.x + (dx / dist) * edge;
      const ez = s.pos.z + (dz / dist) * edge;
      if (!this.passable(game, ex, ez)) continue;
      const score = (bodyValue(b) / 1e6) * T.greed * (0.4 + ahead) / (1 + edge / 180);
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }
    if (!best) return null;
    this.goalBody = best;
    return _p.set(best.x - s.pos.x, best.z - s.pos.z).normalize().clone();
  }

  shortcutDir(game) {
    const s = this.stream;
    const hydro = game.hydro;
    hydro.flowDirAt(s.pos.x, s.pos.z, _r);
    const here = s.routeDist;
    let best = null;
    let bestGain = 90 / this.traits.shortcut;
    for (const ang of [-0.75, -0.4, 0.4, 0.75]) {
      const c = Math.cos(ang);
      const sn = Math.sin(ang);
      const dx = _r.x * c - _r.y * sn;
      const dz = _r.y * c + _r.x * sn;
      for (const L of [140, 240]) {
        const x = s.pos.x + dx * L;
        const z = s.pos.z + dz * L;
        if (!game.ctx.terrain.isLand(x, z)) continue;
        const gain = here - (hydro.routeDistAt(x, z) + L);
        // only shortcuts that keep flowing downhill (flat plateaus are slow)
        const drop = hydro.surfaceAt(s.pos.x, s.pos.z) - hydro.surfaceAt(x, z);
        if (gain > bestGain && drop > L * 0.05 && this.passable(game, x, z) && !this.dangerAt(game, x, z)) {
          bestGain = gain;
          best = new THREE.Vector2(dx, dz);
        }
      }
    }
    return best;
  }

  /** Is (x, z) inside or next to a bigger river's channel? */
  dangerAt(game, x, z) {
    const s = this.stream;
    const rules = game.rules;
    let hit = false;
    rules.grid.query(x, z, s.radius + 30, (o, i) => {
      if (hit || o === s || o.phase !== 'flow' || !rules.isBigger(o, s) || i < o.trail.liveFrom) return;
      if (rules.channelVolume(o, i) < s.volume * 1.15) return;
      const d = o.trail.data;
      const reach = d[i * 4 + 3] + s.radius * 1.5 + 6;
      if ((d[i * 4] - x) ** 2 + (d[i * 4 + 2] - z) ** 2 < reach * reach) hit = true;
    });
    return hit;
  }

  escapeDir(game) {
    const s = this.stream;
    const hydro = game.hydro;
    let best = null;
    let bestScore = -Infinity;
    // a bigger head chasing us: get off its line, to the side it isn't on
    const th = s.threat;
    let chaseSide = 0;
    if (th && th.phase === 'flow') {
      const dx = th.pos.x - s.pos.x;
      const dz = th.pos.z - s.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 160 && (dx * s.heading.x + dz * s.heading.y) / (d || 1) < 0.2) {
        chaseSide = Math.sign(-s.heading.y * dx + s.heading.x * dz) || 1; // +1: chaser on our right
      }
    }
    for (const ang of [-1.1, -0.7, -0.35, 0.35, 0.7, 1.1]) {
      const c = Math.cos(ang);
      const sn = Math.sin(ang);
      const dx = s.heading.x * c - s.heading.y * sn;
      const dz = s.heading.y * c + s.heading.x * sn;
      let ok = true;
      for (const L of [25, 55, 90]) {
        if (this.dangerAt(game, s.pos.x + dx * L, s.pos.z + dz * L)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const x = s.pos.x + dx * 80;
      const z = s.pos.z + dz * 80;
      const rise = hydro.maxRiseAlong(s.pos.x, s.pos.z, x, z, 6);
      let score = -hydro.routeDistAt(x, z) / 100 - Math.max(0, rise - this.climbBudget()) * 0.5 - Math.abs(ang) * 0.3;
      if (chaseSide) score += (Math.sign(ang) === -chaseSide ? 3 : -3) + Math.abs(ang) * 1.2;
      if (score > bestScore) {
        bestScore = score;
        best = new THREE.Vector2(dx, dz);
      }
    }
    return best;
  }

  huntDir(game) {
    const s = this.stream;
    let best = null;
    let bestScore = -Infinity;
    let bestD = 0;
    for (const o of game.streams) {
      if (o === s || o.phase !== 'flow' || o.protectedFor > 0) continue;
      if (o.isPlayer && this.difficulty && !this.difficulty.huntPlayer) continue;
      if (o.volume * 1.6 > s.volume) continue;
      const d = Math.hypot(o.pos.x - s.pos.x, o.pos.z - s.pos.z);
      if (d > 420) continue;
      // the leader wears a target: everyone would rather take down whoever is winning
      const score = -d + (o.livePlace === 1 ? 180 : o.livePlace <= 3 ? 80 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestD = d;
        best = o;
      }
    }
    if (!best) return null;
    // cut across in front of the prey
    const lead = THREE.MathUtils.clamp(bestD * 0.5, 25, 110);
    const x = best.pos.x + best.heading.x * lead;
    const z = best.pos.z + best.heading.y * lead;
    if (!this.passable(game, x, z)) return null;
    const dx = x - s.pos.x;
    const dz = z - s.pos.z;
    const l = Math.hypot(dx, dz);
    if (l < 1) return null;
    // only worth it if it doesn't send us backwards
    if ((dx * s.heading.x + dz * s.heading.y) / l < -0.1) return null;
    this.prey = best;
    return new THREE.Vector2(dx / l, dz / l);
  }

  decideSurge(dt, game) {
    const s = this.stream;
    const T = this.traits;
    this.surgeCool -= dt;
    if (this.surgeT > 0) {
      this.surgeT -= dt;
      return s.volume > 120000;
    }
    if (this.surgeCool > 0 || s.volume < 150000) return false;
    let want = 0;
    if (this.goal === 'evade' && s.danger > 0.4) want = 0.9;
    if (this.goal === 'hunt' && this.prey && s.pos.distanceTo(this.prey.pos) < 120) want = 0.8;
    if (s.routeDist < 700) want = Math.max(want, 0.6);
    if (s.flowSpeed > 25 && Math.abs(this.steer) < 0.25 && s.danger < 0.05) want = Math.max(want, 0.25);
    if (this.rand() < want * T.surge) {
      this.surgeT = 1 + T.surge * 1.2;
      this.surgeCool = 5 + this.rand() * 5;
      return true;
    }
    this.surgeCool = 0.5;
    return false;
  }

  /** Keep races close: far-ahead bots ease off, far-behind bots push a little harder. */
  applyRubberBand(dt, game) {
    const s = this.stream;
    const p = game.player;
    let target = this.skill;
    if (p && p !== s && p.phase === 'flow' && isFinite(p.routeDist) && isFinite(s.routeDist)) {
      const diff = s.routeDist - p.routeDist; // + = bot behind the player
      // ahead: ease off progressively; behind: only catch up from far back (no surprise rams)
      const k = diff < 0 ? Math.max(diff / 4000, -0.06) : diff < 300 ? 0 : Math.min((diff - 300) / 1400, 1) * 0.12;
      target *= 1 + k;
    }
    s.speedMul += (target - s.speedMul) * Math.min(1, dt * 0.5);
  }
}

