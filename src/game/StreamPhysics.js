import * as THREE from 'three';

const _g = new THREE.Vector2();
const _r = new THREE.Vector2();
const _h = new THREE.Vector2();

/**
 * Movement tuning. Arcade, but grounded in how water behaves:
 *  - the head follows the drainage field (valley floors) unless steered;
 *  - steering bends the course up to `steerAngle` off the valley line, so you can pick a
 *    branch, hug a bank or cross a gentle saddle with momentum — but gravity across the
 *    slope turns you back and climbing bleeds speed, so real ridges are never climbed;
 *  - on flat water (lakes, filled basins) a current carries you to the lowest outlet;
 *  - bigger rivers carry more momentum (less drag) but turn more slowly.
 */
export const PHYS = {
  g: 12.5, // effective gravity along the water surface (m/s²)
  drive: 1.35, // m/s² base current on any ground that isn't uphill (rivers keep flowing on flats)
  dragQuad: 0.0065, // quadratic drag at 100k L: terminal ≈ √((drive + g·slope)/drag)
  dragLin: 0.04, //   ≈ 15 m/s on flats, 30 at 30% slope, 47 on cliffs (×1.2 at 1M L)
  sizeMomentum: 0.4, // drag ÷ (1 + k·log10(V/100k)): ×1.18 terminal speed at 1M L, ×1.34 at 10M
  maxSpeed: 55,
  surgeMaxSpeed: 68,
  poolCurrent: 16, // min speed on still water (lakes / basins), towards the outlet
  flatCurrent: 9, // min speed on gentle ground that isn't uphill
  uphillSlope: 0.035, // steeper than this against you and the current no longer carries you
  surgeAccel: 22,
  surgeCost: 0.06, // fraction of volume per second
  surgeMinVolume: 25000,
  absorbPush: 9, // m/s² while swallowing still water (it feels like a gulp of energy)
  steerAngle: 1.55, // rad: full steer = 89° off the valley line (you can cross the slope)
  steerFree: 0.6, // how much the valley's pull is released while you actively steer
  climbSteer: 0.55, // |steer| above this, a fast river pushes over a saddle instead of stalling
  climbSpeed: 24, //   …if it is at least this fast
  climbSlope: 0.17, //   …up to this uphill slope
  followGain: 3.2,
  turnMaxSmall: 2.7, // rad/s for small streams
  turnMaxBig: 1.3, // rad/s for giants
  latAccelMax: 80, // m/s² of lateral grip at speed
  gravTurn: 0.6,
  trailSpacing: 4,
  // leap (E / J / jump button): hop a ridge, a dam or a rival's river
  leapVy: 46, // m/s launch (× stream.leapPower)
  leapGravity: 24,
  leapSpeed: 38, // minimum forward speed while airborne
  leapCost: 0.06, // fraction of volume
  leapMinVolume: 40000,
  leapAirTurn: 1.1, // rad/s of air control
  // drop (skydive): [flare, neutral, dive]
  dropFall: [46, 86, 150],
  dropHoriz: [36, 26, 52],
  dropTurn: 1.7,
  dropResponse: 1.5,
};

/** log10-ish size factor: 0 at 100k L, 1 at 1M, 2 at 10M. */
export const volumeFactor = (v) => THREE.MathUtils.clamp(Math.log10(Math.max(v, 1) / 1e5), -1, 2.5);

/** Moves streams. Emits 'landed' and 'splash' on touchdown. */
export class StreamPhysics {
  constructor(game) {
    this.game = game;
  }

  update(dt, s) {
    if (s.phase === 'drop') this.updateDrop(dt, s);
    else if (s.phase === 'flow') this.updateFlow(dt, s);
  }

  // --- DROP -----------------------------------------------------------------

  updateDrop(dt, s) {
    const { terrain } = this.game.ctx;
    const turn = THREE.MathUtils.clamp(s.input.move.x || s.input.steer || 0, -1, 1);
    const pitch = THREE.MathUtils.clamp(s.input.move.y || 0, -1, 1);
    s.dive += (pitch - s.dive) * (1 - Math.exp(-dt * 4));
    s.bank += (turn - s.bank) * (1 - Math.exp(-dt * 5));

    // yaw
    rotate(s.heading, turn * PHYS.dropTurn * dt);

    // keep the landing on the mountain: a soft wall around the drop zone
    const zone = this.game.dropZone;
    if (zone) {
      const dx = s.pos.x - zone.x;
      const dz = s.pos.z - zone.z;
      const d = Math.hypot(dx, dz);
      if (d > zone.radius) {
        const ex = d - zone.radius;
        // turn towards the centre, harder the further out
        _r.set(-dx / d, -dz / d);
        turnTowards(s.heading, _r, Math.min(2.5, 0.4 + ex / 80) * dt);
        if (d > zone.radius + 120) {
          const k = (zone.radius + 120) / d;
          s.pos.x = zone.x + dx * k;
          s.pos.z = zone.z + dz * k;
        }
      }
    }

    const p = s.dive;
    const [fF, fN, fD] = PHYS.dropFall;
    const [hF, hN, hD] = PHYS.dropHoriz;
    const vyT = p >= 0 ? fN + (fD - fN) * p : fN + (fF - fN) * -p;
    const hsT = p >= 0 ? hN + (hD - hN) * p : hN + (hF - hN) * -p;
    const kv = 1 - Math.exp(-dt * PHYS.dropResponse);
    const kh = 1 - Math.exp(-dt * PHYS.dropResponse * 1.4);
    s.vel.y += (-vyT - s.vel.y) * kv;
    s.vel.x += (s.heading.x * hsT - s.vel.x) * kh;
    s.vel.z += (s.heading.y * hsT - s.vel.z) * kh;
    s.pos.addScaledVector(s.vel, dt);

    const ground = Math.max(terrain.heightAt(s.pos.x, s.pos.z), terrain.seaLevel);
    if (s.pos.y <= ground + s.radius * 0.35) this.land(s);
  }

  land(s) {
    const { terrain, bus } = this.game.ctx;
    const hydro = this.game.hydro;
    const dropRadius = s.radius;
    const impact = Math.max(0, -s.vel.y);
    const hs = Math.hypot(s.vel.x, s.vel.z);

    // never start in the sea (the drop zone should prevent it; belt and braces)
    if (!terrain.isLand(s.pos.x, s.pos.z)) {
      const zone = this.game.dropZone ?? { x: 0, z: 0 };
      for (let i = 0; i < 60 && !terrain.isLand(s.pos.x, s.pos.z); i++) {
        s.pos.x += (zone.x - s.pos.x) * 0.08;
        s.pos.z += (zone.z - s.pos.z) * 0.08;
      }
    }

    s.phase = 'flow';
    s.landedAt = this.game.time;
    s.pos.y = hydro.waterY(s.pos.x, s.pos.z, s.radius);
    hydro.flowDirAt(s.pos.x, s.pos.z, _r);
    if (_r.lengthSq() > 0.5) s.heading.multiplyScalar(0.35).addScaledVector(_r, 0.65).normalize();
    s.flowSpeed = THREE.MathUtils.clamp(hs * 0.45 + impact * 0.12 + 8, 12, 40);
    s.vel.set(s.heading.x * s.flowSpeed, 0, s.heading.y * s.flowSpeed);
    s.protectedFor = (this.game.rules?.config.protectTime ?? 3) + (s.isPlayer ? this.game.difficulty?.protectBonus ?? 0 : 0);
    s.routeDist = hydro.routeDistAt(s.pos.x, s.pos.z);
    s.distToSea = s.routeDist;
    s.landRouteDist = Math.max(1, s.routeDist);
    s.trail.push(s.pos.x, s.pos.y, s.pos.z, s.radius);
    bus.emit('landed', { stream: s, impact });
    bus.emit('splash', {
      x: s.pos.x,
      y: s.pos.y,
      z: s.pos.z,
      size: dropRadius * (2.6 + Math.min(impact / 60, 2)),
      stream: s,
      kind: 'landing',
    });
  }

  // --- FLOW -----------------------------------------------------------------

  startLeap(s) {
    const { bus } = this.game.ctx;
    s.leaping = true;
    s.leapVy = PHYS.leapVy * (s.leapPower || 1);
    s.flowSpeed = Math.max(s.flowSpeed, PHYS.leapSpeed);
    s.addVolume(-s.volume * PHYS.leapCost);
    s.leapCool = s.leapCooldown;
    bus.emit('leap', { stream: s });
    bus.emit('splash', { x: s.pos.x, y: s.pos.y, z: s.pos.z, size: s.radius * 2.2, stream: s, kind: 'leap' });
  }

  updateLeap(dt, s) {
    const { terrain, bus } = this.game.ctx;
    rotate(s.heading, THREE.MathUtils.clamp(s.input.steer || 0, -1, 1) * PHYS.leapAirTurn * dt);
    const sp = Math.max(s.flowSpeed, PHYS.leapSpeed);
    s.leapVy -= PHYS.leapGravity * dt;
    const lim = terrain.size * 0.497;
    s.pos.x = THREE.MathUtils.clamp(s.pos.x + s.heading.x * sp * dt, -lim, lim);
    s.pos.z = THREE.MathUtils.clamp(s.pos.z + s.heading.y * sp * dt, -lim, lim);
    s.pos.y += s.leapVy * dt;
    s.vel.set(s.heading.x * sp, s.leapVy, s.heading.y * sp);
    const ground = this.surfaceY(s.pos.x, s.pos.z, s.radius);
    if (s.pos.y <= ground && s.leapVy < 0) {
      const impact = -s.leapVy;
      s.leaping = false;
      s.pos.y = ground;
      s.flowSpeed = sp * 0.85;
      s.trail.push(s.pos.x, s.pos.y, s.pos.z, s.radius);
      bus.emit('leapLanded', { stream: s, impact });
      bus.emit('splash', { x: s.pos.x, y: s.pos.y, z: s.pos.z, size: s.radius * (2.5 + impact / 40), stream: s, kind: 'landing' });
    }
  }

  updateFlow(dt, s) {
    s.leapCool = Math.max(0, s.leapCool - dt);
    if (s.leaping) return this.updateLeap(dt, s);
    if (s.input.jump && s.leapCool <= 0 && s.volume > PHYS.leapMinVolume) {
      this.startLeap(s);
      return this.updateLeap(dt, s);
    }
    const { terrain } = this.game.ctx;
    const hydro = this.game.hydro;
    const x = s.pos.x;
    const z = s.pos.z;
    hydro.gradientAt(x, z, _g);
    hydro.flowDirAt(x, z, _r);
    if (_r.lengthSq() < 0.5) {
      _r.set(-_g.x, -_g.y);
      if (_r.lengthSq() < 1e-8) _r.copy(s.heading);
      _r.normalize();
    }
    const depth = hydro.basinDepthAt(x, z);
    // on a pool the surface is flat: rock islands poking out of it must not create fake slopes
    if (depth > 1.5) _g.set(0, 0);
    const vf = volumeFactor(s.volume);
    let sp = s.flowSpeed;
    const hx = s.heading.x;
    const hz = s.heading.y;

    // --- heading: pursue the valley line, bent by steering, nudged by lateral gravity
    const steer = THREE.MathUtils.clamp(s.input.steer || 0, -1, 1);
    const ang = steer * PHYS.steerAngle;
    const c = Math.cos(ang);
    const sn = Math.sin(ang);
    const tx = _r.x * c - _r.y * sn; // R rotated towards its right (-Rz, Rx)
    const tz = _r.y * c + _r.x * sn;
    const delta = Math.atan2(hx * tz - hz * tx, hx * tx + hz * tz);
    const size01 = THREE.MathUtils.clamp((vf + 0.5) / 2.5, 0, 1);
    let turnMax = PHYS.turnMaxSmall + (PHYS.turnMaxBig - PHYS.turnMaxSmall) * size01;
    turnMax = Math.min(turnMax, PHYS.latAccelMax / Math.max(sp, 1));
    // steering hard releases the valley's grip, so the player really picks the line
    const free = 1 - PHYS.steerFree * Math.abs(steer);
    const wf = THREE.MathUtils.clamp(PHYS.followGain * free * delta, -turnMax, turnMax);
    const lat = -(_g.x * -hz + _g.y * hx); // downhill component towards the right
    const wg = (PHYS.gravTurn * free * PHYS.g * lat) / Math.max(sp, 5);
    let w = THREE.MathUtils.clamp(wf + wg, -3.2, 3.2);

    const slope = -(_g.x * hx + _g.y * hz); // + downhill along heading
    // a fast river that is deliberately steered can pile up and spill over a low saddle
    const climbing = Math.abs(steer) > PHYS.climbSteer && sp > PHYS.climbSpeed && slope > -PHYS.climbSlope;
    s.climbing = climbing;
    const uphill = slope < -PHYS.uphillSlope && !climbing;
    if (uphill && sp < 4) {
      // stalled against a rise: swing round towards the fall line
      _h.set(-_g.x, -_g.y).normalize();
      const dd = Math.atan2(hx * _h.y - hz * _h.x, hx * _h.x + hz * _h.y);
      w = THREE.MathUtils.clamp(dd * 4, -3.5, 3.5);
    }
    rotate(s.heading, w * dt);
    s.turnRate = w;
    s.bank += (THREE.MathUtils.clamp(w / 1.6, -1, 1) - s.bank) * (1 - Math.exp(-dt * 4));

    // --- speed along the heading
    const mul = s.speedMul || 1;
    const dq = PHYS.dragQuad / (1 + PHYS.sizeMomentum * Math.max(vf, -0.5)) / (mul * mul);
    let a = PHYS.g * slope + (uphill ? 0 : PHYS.drive) - PHYS.dragLin * sp - dq * sp * sp;
    s.surging = !!s.input.surge && s.volume > PHYS.surgeMinVolume;
    if (s.surging) {
      a += PHYS.surgeAccel;
      s.addVolume(-s.volume * PHYS.surgeCost * dt);
    }
    if (s.absorbing > 0) a += PHYS.absorbPush;
    sp += a * dt;
    // swallowing still water drags you through it (the lake pours into you): no braking then
    const swallowing = s.absorbing > 0;
    const pool = PHYS.poolCurrent * (swallowing ? 1.6 : 1) * (s.surging ? 1.4 : 1);
    if (depth > 3 && (!swallowing || depth > 20)) {
      // a river entering still water spends its momentum and rides the pool's current to the
      // outlet (deep pools damp harder, so steep basin walls can't pump energy back in)
      const k = Math.min(1, depth / 15);
      if (sp > pool) sp += (pool - sp) * Math.min(1, dt * (0.35 + 1.4 * k * k));
    }
    if (!uphill) sp = Math.max(sp, depth > 1.5 ? pool : PHYS.flatCurrent);
    const cap = (s.surging ? PHYS.surgeMaxSpeed : PHYS.maxSpeed) * mul;
    if (sp > cap) sp -= (sp - cap) * Math.min(1, dt * 8);
    sp = Math.max(0, sp);
    s.flowSpeed = sp;

    // --- integrate
    const nx = x + s.heading.x * sp * dt;
    const nz = z + s.heading.y * sp * dt;
    const lim = terrain.size * 0.497;
    s.pos.x = THREE.MathUtils.clamp(nx, -lim, lim);
    s.pos.z = THREE.MathUtils.clamp(nz, -lim, lim);
    const prevY = s.pos.y;
    s.pos.y = this.surfaceY(s.pos.x, s.pos.z, s.radius);
    s.vel.set(s.heading.x * sp, dt > 0 ? (s.pos.y - prevY) / dt : 0, s.heading.y * sp);

    // --- trail
    const t = s.trail;
    const last = (t.count - 1) * 4;
    if (t.count === 0 || Math.hypot(s.pos.x - t.data[last], s.pos.z - t.data[last + 2]) > PHYS.trailSpacing) {
      t.push(s.pos.x, s.pos.y, s.pos.z, s.radius);
    }
  }

  /** Water surface under a stream head: ground / capped pool / full lakes / sea. */
  surfaceY(x, z, radius) {
    let y = this.game.hydro.waterY(x, z, radius);
    const lakes = this.game.ctx.world?.lakes?.bodies;
    if (lakes) {
      for (const b of lakes) {
        if (b.volume <= 0) continue;
        const dx = b.x - x;
        const dz = b.z - z;
        if (dx * dx + dz * dz < b.radius * b.radius && b.y > y && b.y - y < 40) y = b.y + 0.2;
      }
    }
    return y;
  }
}

/** Rotate a 2D direction by `a` radians towards its right (-y, x). */
export function rotate(v, a) {
  if (!a) return v;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const x = v.x * c - v.y * s;
  const y = v.y * c + v.x * s;
  return v.set(x, y).normalize();
}

/** Turn unit vector `v` towards unit `target` by at most `maxA` radians. */
export function turnTowards(v, target, maxA) {
  const d = Math.atan2(v.x * target.y - v.y * target.x, v.x * target.x + v.y * target.y);
  return rotate(v, THREE.MathUtils.clamp(d, -maxA, maxA));
}

/** Signed angle (rad) from unit a to unit b, positive = b is to the right of a. */
export function signedAngle(ax, az, bx, bz) {
  return Math.atan2(ax * bz - az * bx, ax * bx + az * bz);
}
