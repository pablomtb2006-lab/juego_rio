/**
 * RiverController — the player steers the WHOLE body of water with a force, never by moving it.
 *
 * Intent (input) and physics are separate (brief §8): the input sets a TARGET horizontal
 * acceleration; the applied acceleration approaches it progressively (`response`, 1/s), is capped
 * (`maxAccel`), and is handed to the solver as an external body force applied to every particle
 * (sim.control). The water then answers with its own physics: it piles against walls, goes round
 * rocks, splits, and keeps moving after you let go — nothing is teleported, no mass is created.
 *
 * ENERGY BOOKS. A uniform acceleration a on all particles does work at the rate
 *   P = Σ m a·v_i = a · (M v_com)
 * which is exact for a uniform field. It is integrated (trapezoid) between measurements, so the
 * figure is a SAMPLED estimate of the work, reported as external energy input — the player is a
 * declared external source, like a pump, not hidden physics. Climbing a slope is possible only
 * through this force, and it shows up in the books.
 */
export class RiverController {
  constructor(sim, { maxAccel = 6, response = 3, climb = false } = {}) {
    this.sim = sim;
    this.maxAccel = maxAccel;
    this.response = response;
    this.climb = climb; // allow a vertical component (explicit "pump" ability)
    this.target = [0, 0, 0];
    this.accel = [0, 0, 0];
    this.lastPower = 0;
    this.lastTime = 0;
    this.work = 0;
  }

  /** Desired direction in world space (x, z), components in −1..1. */
  setInput(x, z, up = 0) {
    const l = Math.hypot(x, z);
    const s = l > 1 ? 1 / l : 1;
    this.target = [x * s * this.maxAccel, this.climb ? up * this.maxAccel : 0, z * s * this.maxAccel];
  }

  update(dt) {
    const k = 1 - Math.exp(-this.response * dt);
    for (let i = 0; i < 3; i++) this.accel[i] += (this.target[i] - this.accel[i]) * k;
    const mag = Math.hypot(...this.accel);
    const on = mag > 1e-3;
    this.sim.control = on ? { accel: [...this.accel, 0], center: [0, 0, 0, 1] } : null;
  }

  /** Fold a measurement into the work books. */
  account(measure) {
    const M = measure.massDomain;
    const v = measure.comVel;
    const P = M * (this.accel[0] * v[0] + this.accel[1] * v[1] + this.accel[2] * v[2]);
    const t = measure.time;
    if (this.lastTime > 0 && t > this.lastTime) this.work += 0.5 * (P + this.lastPower) * (t - this.lastTime);
    this.lastPower = P;
    this.lastTime = t;
    this.sim.accounting.externalWork = this.work;
    return { power: P, work: this.work };
  }

  reset() {
    this.accel = [0, 0, 0];
    this.target = [0, 0, 0];
    this.work = 0;
    this.lastPower = 0;
    this.lastTime = 0;
    this.sim.control = null;
  }
}
