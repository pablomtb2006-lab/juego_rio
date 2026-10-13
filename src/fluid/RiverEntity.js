/**
 * RiverEntity — one river (the player's, a rival, or the free "neutral" water) as a game object.
 *
 * ONE SOURCE OF TRUTH FOR MASS. A river owns no water of its own: its water is the set of solver
 * particles carrying its owner index. Mass, volume, centre of mass, velocity and size are
 * MEASURED from those particles every frame (RiverIdentity statistics), never stored separately,
 * so they cannot disagree with the simulation:
 *
 *   m = N · m_p          (m_p from the solver's mass calibration, FluidProperties)
 *   V = m / ρ,  ρ = 998.2 kg/m³  (incompressible water; the solver keeps ρ within ~1%)
 *
 * Derived quantities and their DEFINITIONS (they are measurements of a free-surface blob, not
 * channel hydraulics, so they are defined here explicitly):
 *   footprint radius   R = √2 · r_rms,  r_rms² = ⟨(x−x̄)² + (z−z̄)²⟩   (exact for a uniform disc)
 *   footprint area     A = π R²
 *   mean depth         H = V / A
 *   cross-section      A⊥ = 2R · H (perpendicular to the motion)
 *   mass flux          Q = ρ · A⊥ · |v̄_h|   (kg/s, "caudal" of the moving body)
 *
 * STEERING (player input or AI) is a commanded horizontal acceleration, approached progressively
 * and capped by the river's maneuverability. Maneuverability depends on mass (GAME RULE):
 *   a_max(m) = a_ref · (m_ref / m)^(1/4), clamped — big rivers are slower to turn and to escape.
 * The work of the steering force is booked like the lab's RiverController: P = a · (M v̄).
 */
export const DENSITY = 998.2;

/** Linear absorbance (1/m) that gives a water body the requested sRGB colour (visual only). */
export function absorbanceForColor(rgb, strength = 3.2) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return rgb.map((c) => Math.min(12, strength * -Math.log(Math.max(lin(c), 0.004))));
}

export class RiverEntity {
  /**
   * @param {object} o
   * @param {number} o.slot        owner index in the identity texture
   * @param {string} o.name
   * @param {'player'|'rival'|'neutral'} o.type
   * @param {number[]} o.color     sRGB 0..1 (display; the water's colour comes from `sigma`)
   * @param {string} [o.personality]
   * @param {number} [o.resistance]  0..1, slows absorption of this river (GAME RULE)
   * @param {number} [o.speed]       steering multiplier (personality)
   */
  constructor({ slot, name, type = 'rival', color, personality = null, resistance = 0.3, speed = 1 }) {
    this.slot = slot;
    this.name = name;
    this.type = type;
    this.color = color;
    this.sigma = absorbanceForColor(color);
    this.personality = personality;
    this.resistance = resistance;
    this.speedMul = speed;
    // measured
    this.count = 0;
    this.particleMass = 0;
    this.com = [0, 0, 0];
    this.vel = [0, 0, 0];
    this.speed = 0;
    this.radius = 0;
    this.footprint = 0;
    this.depth = 0;
    this.flux = 0;
    this.meanSigma = [0, 0, 0];
    this.foam = 0;
    // absorption
    this.state = 'libre'; // libre · agarre · absorbiendo · siendo absorbido · absorbido
    this.absorbedBy = null; // RiverEntity absorbing this one (active episode)
    this.fusion = 0; // f of the active episode in which this river is the absorbed one
    this.alive = true;
    this.massLog = []; // { t, dm (kg, + gained / − lost), other, reason }
    this.initialMass = 0;
    // steering
    this.input = [0, 0];
    this.accel = [0, 0, 0];
    this.response = 3; // 1/s
    this.aRef = 5; // m/s² at m_ref
    this.mRef = 3000; // kg
    this.work = 0;
    this.lastPower = 0;
    this.ai = null; // RivalAI state, if any
  }

  get mass() {
    return this.count * this.particleMass;
  }

  get volume() {
    return this.mass / DENSITY;
  }

  /** Maneuverability (GAME RULE): maximum steering acceleration for the current mass. */
  get maxAccel() {
    if (this.count === 0) return 0;
    const a = this.aRef * (this.mRef / Math.max(this.mass, 1)) ** 0.25;
    return Math.min(8, Math.max(2.5, a)) * this.speedMul;
  }

  /** Desired horizontal direction, components −1..1 (length > 1 is normalised). */
  setInput(x, z) {
    const l = Math.hypot(x, z);
    const s = l > 1 ? 1 / l : 1;
    this.input = [x * s, z * s];
  }

  updateSteering(dt) {
    const a = this.maxAccel;
    const k = 1 - Math.exp(-this.response * dt);
    const target = [this.input[0] * a, 0, this.input[1] * a];
    for (let i = 0; i < 3; i++) this.accel[i] += (target[i] - this.accel[i]) * k;
  }

  /** Fold the GPU statistics of this river's particles (sums) into measurements. */
  ingest(sum0, sum1, sum2, sum3, particleMass, dt) {
    const n = sum0[3];
    this.particleMass = particleMass;
    const prev = this.count;
    this.count = Math.round(n);
    if (this.count === 0) {
      this.speed = 0;
      this.flux = 0;
      return prev;
    }
    const inv = 1 / n;
    this.com = [sum0[0] * inv, sum0[1] * inv, sum0[2] * inv];
    this.vel = [sum1[0] * inv, sum1[1] * inv, sum1[2] * inv];
    this.speed = Math.hypot(this.vel[0], this.vel[2]);
    const r2 = Math.max(sum2[0] * inv - (this.com[0] ** 2 + this.com[2] ** 2), 0);
    this.radius = Math.SQRT2 * Math.sqrt(r2);
    this.footprint = Math.PI * this.radius ** 2;
    this.depth = this.footprint > 0 ? this.volume / this.footprint : 0;
    this.flux = DENSITY * 2 * this.radius * this.depth * this.speed;
    this.meanSigma = [sum3[0] * inv, sum3[1] * inv, sum3[2] * inv];
    this.foam = sum2[2] * inv;
    // work of the steering force on this river, P = a·(M v̄) (trapezoid)
    const P = this.mass * (this.accel[0] * this.vel[0] + this.accel[2] * this.vel[2]);
    this.work += 0.5 * (P + this.lastPower) * dt;
    this.lastPower = P;
    return prev;
  }

  log(t, dParticles, other, reason) {
    if (!dParticles) return;
    this.massLog.push({ t: +t.toFixed(3), dm: dParticles * this.particleMass, other, reason });
    if (this.massLog.length > 400) this.massLog.splice(0, this.massLog.length - 400);
  }
}
