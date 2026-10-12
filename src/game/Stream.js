import * as THREE from 'three';

/** Growable trail of points [x, y, z, halfWidth] left behind by a stream. */
export class Trail {
  constructor(capacity = 2048) {
    this.data = new Float32Array(capacity * 4);
    this.count = 0;
    this.version = 0;
  }

  push(x, y, z, w) {
    if ((this.count + 1) * 4 > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data.set([x, y, z, w], this.count * 4);
    this.count++;
    this.version++;
  }

  /** Widen the most recent points (the river swells as it grows). */
  swell(w, points = 12) {
    for (let i = Math.max(0, this.count - points); i < this.count; i++) {
      this.data[i * 4 + 3] = Math.max(this.data[i * 4 + 3], w);
    }
    this.version++;
  }

  clear() {
    this.count = 0;
    this.version++;
  }
}

/**
 * One player (human or AI). Pure data + derived helpers; behaviour lives in
 * StreamPhysics (movement), Rules (absorb / cut / finish) and the controllers.
 *
 * phase: 'drop' (falling from the sky) → 'flow' (river on the ground)
 *        → 'finished' (reached the sea) | 'eliminated' (cut off / dried up)
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
    this.volume = 60000; // litres
    this.peakVolume = this.volume;
    this.trail = new Trail();
    this.distToSea = Infinity;
    this.place = 0;
    this.eliminatedBy = null;
    this.absorbing = 0; // litres/s currently being absorbed (for VFX/audio)
    this.surging = false;
    this.landedAt = -1;
    this.finishedAt = -1;
    this.input = { steer: 0, move: new THREE.Vector2(), surge: false };
  }

  get alive() {
    return this.phase === 'drop' || this.phase === 'flow';
  }

  /** River half-width in metres, grows with the cube root of volume. */
  get radius() {
    return 3 + 0.9 * Math.cbrt(this.volume / 1000);
  }

  get speed() {
    return this.vel.length();
  }

  addVolume(litres) {
    this.volume = Math.max(0, this.volume + litres);
    this.peakVolume = Math.max(this.peakVolume, this.volume);
  }
}
