/**
 * RivalAI — decides where a rival river WANTS to go. It never moves water: its only output is the
 * river's steering input (a direction), turned into a capped acceleration by RiverEntity and
 * applied by the solver. So a rival cannot cross a wall, teleport or change size: it is subject to
 * exactly the same physics as the player.
 *
 * Perception uses only real, measured state: masses, centres of mass and velocities of every
 * river (GPU statistics), who is absorbing whom (AbsorptionSystem), and the solids (the same
 * signed-distance functions the solver uses, JS mirror).
 *
 * Personalities (numbers are mass ratios target/self):
 *   agresivo     hunts anything up to 1.3× its mass, flees only from 2.2× bigger, fights back for a
 *                moment when grabbed by a river of similar size
 *   evasivo      flees from anything ≥ 0.85× its mass, eats only what is clearly smaller (≤ 0.55×),
 *                faster
 *   oportunista  goes for rivers that are already being absorbed or weakened, avoids even fights
 *   territorial  guards a zone around its starting point; attacks intruders, returns home, resists
 */
export const PERSONALITIES = {
  agresivo: { label: 'agresivo', chase: 1.3, flee: 2.2, sense: 15, speed: 1.0, resistance: 0.3, fightBack: 1.25 },
  evasivo: { label: 'evasivo', chase: 0.55, flee: 0.85, sense: 10, speed: 1.12, resistance: 0.45 },
  oportunista: { label: 'oportunista', chase: 0.8, flee: 1.3, sense: 13, speed: 1.0, resistance: 0.35, opportunist: true },
  territorial: { label: 'territorial', chase: 1.5, flee: 2.5, sense: 8, speed: 0.92, resistance: 0.7, territorial: true, zone: 7 },
};

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const norm = (x, z) => {
  const l = Math.hypot(x, z);
  return l > 1e-6 ? [x / l, z / l] : [0, 0];
};

export class RivalAI {
  /**
   * @param {RiverEntity} river
   * @param {string} personality  key of PERSONALITIES
   * @param {{collision: FluidCollision, seed?: number}} world
   */
  constructor(river, personality, { collision, seed = 1 }) {
    this.river = river;
    this.p = PERSONALITIES[personality];
    this.collision = collision;
    this.rnd = mulberry32(seed * 7919 + river.slot);
    this.home = null;
    this.target = null;
    this.targetSince = 0;
    this.waypoint = null;
    this.waypointUntil = 0;
    this.stuck = 0;
    this.detour = null;
    this.detourUntil = 0;
    this.mode = 'patrulla';
    river.ai = this;
    river.personality = personality;
    river.resistance = this.p.resistance;
    river.speedMul = this.p.speed;
  }

  /** Signed clearance at a bed-level point: obstacles and arena walls (m, negative inside). */
  clearance(x, z) {
    const c = this.collision;
    const { min, max } = c.domain;
    return Math.min(c.obstacleDistance(x, 0.3, z), x - min[0], max[0] - x, z - min[2], max[2] - z);
  }

  /** Repulsion from solids along the intended direction (potential field with look-ahead probes). */
  avoid(pos, dir, R) {
    let ax = 0;
    let az = 0;
    const clear = R * 0.6 + 0.8;
    for (const [ang, w] of [[0, 1], [0.7, 0.6], [-0.7, 0.6], [1.6, 0.3], [-1.6, 0.3]]) {
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const dx = dir[0] * c - dir[1] * s;
      const dz = dir[0] * s + dir[1] * c;
      for (const dist of [R * 0.8 + 0.4, R + 1.5, R + 3]) {
        const px = pos[0] + dx * dist;
        const pz = pos[2] + dz * dist;
        const sd = this.clearance(px, pz);
        if (sd >= clear) continue;
        const e = 0.15;
        const [nx, nz] = norm(this.clearance(px + e, pz) - this.clearance(px - e, pz), this.clearance(px, pz + e) - this.clearance(px, pz - e));
        const k = (w * (1 - Math.max(sd, -clear) / clear)) / (1 + dist * 0.25);
        ax += nx * k;
        az += nz * k;
      }
    }
    return [ax, az];
  }

  update(t, dt, rivers) {
    const me = this.river;
    if (!me.alive || me.count === 0) {
      me.setInput(0, 0);
      return;
    }
    const p = this.p;
    if (!this.home) this.home = [me.com[0], me.com[2]];
    const others = rivers.filter((r) => r && r !== me && r.alive && r.type !== 'neutral' && r.count > 0);
    const dist = (r) => Math.hypot(r.com[0] - me.com[0], r.com[2] - me.com[2]);
    let want = [0, 0];
    let throttle = 0.75;

    // 1. being absorbed: escape (real escape: break the contact by moving away and sideways)
    const absorber = me.absorbedBy;
    if (absorber) {
      const R = absorber.mass / Math.max(me.mass, 1);
      const fusionAge = t - (this.grabbedAt ?? t);
      this.grabbedAt ??= t;
      if (p.fightBack && R < p.fightBack && fusionAge < 1.2) {
        want = norm(absorber.com[0] - me.com[0], absorber.com[2] - me.com[2]);
        this.mode = `resiste a ${absorber.name}`;
      } else {
        const away = norm(me.com[0] - absorber.com[0], me.com[2] - absorber.com[2]);
        const side = me.slot % 2 ? 1 : -1;
        want = norm(away[0] - side * away[1] * 0.6, away[1] + side * away[0] * 0.6);
        this.mode = `escapa de ${absorber.name}`;
      }
      throttle = 1;
    } else {
      this.grabbedAt = null;
      // 2. threats
      let fx = 0;
      let fz = 0;
      let threat = null;
      for (const r of others) {
        const d = dist(r);
        if (r.mass < p.flee * me.mass || d > p.sense) continue;
        const w = 1 / Math.max(d - r.radius - me.radius, 0.5);
        const [ux, uz] = norm(me.com[0] - r.com[0], me.com[2] - r.com[2]);
        fx += ux * w;
        fz += uz * w;
        if (!threat || d < dist(threat)) threat = r;
      }
      if (threat) {
        want = norm(fx, fz);
        throttle = 1;
        this.mode = `huye de ${threat.name}`;
      } else {
        // 3. prey (with hysteresis: keep a target ≥ 1.5 s unless it becomes invalid)
        const valid = (r) => r.alive && r.count > 0 && r.mass < p.chase * me.mass * (r.absorbedBy && r.absorbedBy !== me ? 1.6 : 1);
        const centre = p.territorial ? this.home : [me.com[0], me.com[2]];
        const inRange = (r) => Math.hypot(r.com[0] - centre[0], r.com[2] - centre[2]) < (p.territorial ? p.zone : p.sense);
        if (this.target && (!valid(this.target) || !inRange(this.target))) this.target = null;
        if (!this.target || t - this.targetSince > 1.5) {
          let best = this.target;
          let bestScore = best ? this.score(best, dist(best)) * 1.2 : -Infinity;
          for (const r of others) {
            if (!valid(r) || !inRange(r)) continue;
            const s = this.score(r, dist(r));
            if (s > bestScore) {
              best = r;
              bestScore = s;
            }
          }
          if (best !== this.target) this.targetSince = t;
          this.target = best;
        }
        if (this.target) {
          const r = this.target;
          const d = dist(r);
          const lead = Math.min(1.5, d / (me.speed + 1.5));
          want = norm(r.com[0] + r.vel[0] * lead - me.com[0], r.com[2] + r.vel[2] * lead - me.com[2]);
          throttle = 1;
          this.mode = `caza a ${r.name}`;
        } else if (p.territorial) {
          const d = Math.hypot(this.home[0] - me.com[0], this.home[1] - me.com[2]);
          want = d > 1.5 ? norm(this.home[0] - me.com[0], this.home[1] - me.com[2]) : [0, 0];
          throttle = 0.5;
          this.mode = 'guarda su zona';
        } else {
          // wander between random waypoints inside the arena
          const { min, max } = this.collision.domain;
          if (!this.waypoint || t > this.waypointUntil || Math.hypot(this.waypoint[0] - me.com[0], this.waypoint[1] - me.com[2]) < 1.5) {
            for (let k = 0; k < 12; k++) {
              const w = [min[0] + 3 + this.rnd() * (max[0] - min[0] - 6), min[2] + 3 + this.rnd() * (max[2] - min[2] - 6)];
              if (this.clearance(w[0], w[1]) > me.radius) {
                this.waypoint = w;
                break;
              }
            }
            this.waypointUntil = t + 4 + this.rnd() * 3;
          }
          want = norm(this.waypoint[0] - me.com[0], this.waypoint[1] - me.com[2]);
          throttle = 0.55;
          this.mode = 'patrulla';
        }
      }
    }

    // 4. unstick: pushing but not moving → sidestep for a moment
    if (throttle > 0.5 && me.speed < 0.25) this.stuck += dt;
    else this.stuck = Math.max(0, this.stuck - dt);
    if (this.stuck > 1.5) {
      const side = this.rnd() < 0.5 ? 1 : -1;
      this.detour = [-want[1] * side, want[0] * side];
      this.detourUntil = t + 1.2;
      this.stuck = 0;
    }
    if (this.detour && t < this.detourUntil) want = norm(want[0] * 0.3 + this.detour[0], want[1] * 0.3 + this.detour[1]);

    // 5. solids
    const [ax, az] = this.avoid(me.com, want[0] || want[1] ? want : norm(me.vel[0], me.vel[2]), me.radius);
    const [dx, dz] = norm(want[0] + ax * 1.6, want[1] + az * 1.6);
    me.setInput(dx * throttle, dz * throttle);
  }

  score(r, d) {
    const me = this.river;
    let s = (me.mass / Math.max(r.mass, 1)) / (1 + d * 0.3);
    if (this.p.opportunist && r.absorbedBy) s *= 3;
    if (this.p.opportunist && r.mass < 0.5 * r.initialMass) s *= 1.5;
    return s;
  }
}
