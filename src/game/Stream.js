import * as THREE from 'three';

/** Growable trail of points [x, y, z, halfWidth] left behind by a stream. */
export class Trail {
  constructor(capacity = 2048) {
    this.data = new Float32Array(capacity * 4);
    this.count = 0;
    this.version = 0;
    // first index of the "live" channel (near the head: blocks / can be cut). Older points are
    // the calm riverbed — renderers may draw them quieter.
    this.liveFrom = 0;
    this.epoch = 0; // bumped by clear(): spatial indexes must rebuild
  }

  push(x, y, z, w) {
    if ((this.count + 1) * 4 > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    const o = this.count * 4;
    this.data[o] = x;
    this.data[o + 1] = y;
    this.data[o + 2] = z;
    this.data[o + 3] = w;
    this.count++;
    this.version++;
  }

  /** Widen the most recent points (the river swells as it grows). Only bumps version on change. */
  swell(w, points = 12) {
    let changed = false;
    for (let i = Math.max(0, this.count - points); i < this.count; i++) {
      if (this.data[i * 4 + 3] < w) {
        this.data[i * 4 + 3] = w;
        changed = true;
      }
    }
    if (changed) this.version++;
  }

  clear() {
    this.count = 0;
    this.liveFrom = 0;
    this.epoch++;
    this.version++;
  }
}

/** Litres → river half-width (m). Cube-root growth keeps giants readable. */
export const radiusForVolume = (v) => 3 + 0.9 * Math.cbrt(Math.max(v, 0) / 1000);

/**
 * One player (human or AI). Pure data + derived helpers; behaviour lives in
 * StreamPhysics (movement), Rules (absorb / cut / finish) and the controllers
 * (PlayerController, AIController — a future NetworkController writes the same `input`).
 *
 * phase: 'drop' (falling from the sky) → 'flow' (river on the ground)
 *        → 'finished' (reached the sea) | 'eliminated' (cut off / dried up)
 *
 * Contract fields (docs/ARCHITECTURE.md) are kept; extra read-only fields for UI / VFX / audio:
 *   routeDist   metres to the sea along the drainage route (same as distToSea while flowing)
 *   progress    0..1 of the way from the landing point to the sea
 *   livePlace   current ranking (1 = leading), updated every tick
 *   danger      0..1 a bigger river (threat) is about to block you
 *   threat      Stream | null — who is about to block you
 *   contact     0..1 being blocked right now (eliminated at 1); contactWith = by whom
 *   inWake      Stream | null — you're inside a bigger river's channel and it's draining you
 *   protectedFor seconds of post-landing protection left (can't be blocked or cut)
 *   dive        -1..1 skydive pitch (−1 flare … +1 dive), bank: −1..1 turn lean (drop + flow)
 *   lastCutAt / lastHitAt  game time of the last cut dealt / received (VFX flashes)
 *   kills, cuts, absorbedTotal   per-match stats
 */
export class Stream {
  constructor({ id, name, color, skin = 'clear', isPlayer = false, personality = 'balanced' }) {
    this.id = id;
    this.name = name;
    this.color = color;
    this.skin = skin;
    this.isPlayer = isPlayer;
    this.personality = personality;
    this.controller = null;

    this.phase = 'drop';
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.heading = new THREE.Vector2(0, 1); // ground-plane direction of travel
    this.flowSpeed = 0; // scalar speed along heading while flowing (m/s)
    this.volume = 60000; // litres
    this.peakVolume = this.volume;
    this.trail = new Trail();
    this.distToSea = Infinity;
    this.routeDist = Infinity;
    this.landRouteDist = 0;
    this.progress = 0;
    this.place = 0;
    this.livePlace = 0;
    this.eliminatedBy = null;
    this.eliminatedReason = null;
    this.eliminatedHow = null;
    this.absorbing = 0; // litres/s currently being absorbed (for VFX/audio)
    this.inflow = 0; // litres/s gathered from the valley's tributaries (main rivers swell)
    this.absorbBody = null;
    this.surging = false;
    this.landedAt = -1;
    this.finishedAt = -1;
    this.eliminatedAt = -1;
    this.protectedFor = 0;
    this.hazardEvap = 1; // set by game/Hazards.js while inside a scorching / drying zone
    this.gripMul = 1; //   …and how much of your turning you keep (ice)
    this.blinded = 0; //   …and how fogged the player's view is (steam)
    this.inHazard = null;
    this.danger = 0;
    this.threat = null;
    this.contact = 0;
    this.contactWith = null;
    this.inWake = null; // Stream whose channel is draining you right now
    this.dive = 0;
    this.bank = 0;
    this.turnRate = 0;
    this.speedMul = 1; // rubber-band / handicap multiplier on terminal speed (AI only)
    this.lastCutAt = -10;
    this.lastHitAt = -10;
    this.archBonus = false;
    this.kills = 0;
    this.cuts = 0;
    this.absorbedTotal = 0;
    this.input = { steer: 0, move: new THREE.Vector2(), surge: false, jump: false };
    // leap: the river throws itself into the air to hop a ridge or a dam (see StreamPhysics.leap)
    this.leaping = false;
    this.leapVy = 0;
    this.leapCool = 0;
    this.leapCooldown = 9; // s, reduced by upgrades
    this.leapPower = 1; // upgrades
    this.upgrades = null;
  }

  get alive() {
    return this.phase === 'drop' || this.phase === 'flow';
  }

  /**
   * River half-width in metres, grows with the cube root of volume. While falling the
   * stream is a giant drop (renderers draw it at ~1.5 × radius), so it reads bigger.
   */
  get radius() {
    const r = radiusForVolume(this.volume);
    return this.phase === 'drop' ? r * 1.6 : r;
  }

  get speed() {
    return this.vel.length();
  }

  addVolume(litres) {
    this.volume = Math.max(0, this.volume + litres);
    this.peakVolume = Math.max(this.peakVolume, this.volume);
  }
}
