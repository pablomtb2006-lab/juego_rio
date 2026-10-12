import { clamp, rotateByQuat } from './util.js';

const FWD = { x: 0, y: 0, z: -1 };
const RIGHT = { x: 1, y: 0, z: 0 };

/**
 * Camera-relative spatialization computed in JS (cheap, identical in every
 * browser, and lets us add things PannerNode can't: air absorption and
 * speed-of-sound delay for far-away splashes / fireworks).
 *
 *   listener.update(camera)               once per frame
 *   listener.place(x, y, z, opts) -> { dist, pan, gain, lpf, delay, behind, audible }
 */
export class Listener {
  constructor() {
    this.pos = { x: 0, y: 0, z: 0 };
    this.fwd = { x: 0, y: 0, z: -1 };
    this.right = { x: 1, y: 0, z: 0 };
    this._d = { dist: 0, pan: 0, gain: 1, lpf: 20000, delay: 0, behind: false, audible: true };
  }

  update(camera) {
    if (!camera) return;
    this.pos.x = camera.position.x;
    this.pos.y = camera.position.y;
    this.pos.z = camera.position.z;
    rotateByQuat(FWD, camera.quaternion, this.fwd);
    rotateByQuat(RIGHT, camera.quaternion, this.right);
  }

  /**
   * ref:  distance (m) at which gain = 1
   * max:  beyond this the sound is culled
   * Inverse-distance law, gentle stereo (never hard-panned), air-absorption low-pass.
   */
  place(x, y, z, { ref = 40, max = 3000, rolloff = 1, delay = true } = {}) {
    const d = this._d;
    const dx = x - this.pos.x;
    const dy = y - this.pos.y;
    const dz = z - this.pos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    d.dist = dist;
    d.audible = dist < max;
    const inv = dist > 1e-3 ? 1 / dist : 0;
    const side = (dx * this.right.x + dy * this.right.y + dz * this.right.z) * inv;
    const front = (dx * this.fwd.x + dy * this.fwd.y + dz * this.fwd.z) * inv;
    // close sounds are wide, far ones collapse slightly towards the centre
    d.pan = clamp(side * (dist < 8 ? dist / 8 : 1) * 0.85, -0.85, 0.85);
    d.behind = front < -0.2;
    d.gain = ref / (ref + rolloff * Math.max(0, dist - ref));
    if (dist > max * 0.7) d.gain *= clamp((max - dist) / (max * 0.3));
    d.lpf = clamp(20000 * Math.exp(-dist / 1400), 700, 20000) * (d.behind ? 0.6 : 1);
    d.delay = delay && dist > 120 ? Math.min((dist - 120) / 343, 1.6) : 0;
    return d;
  }
}
