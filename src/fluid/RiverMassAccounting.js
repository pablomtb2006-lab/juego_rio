/**
 * RiverMassAccounting — where every kilogram of water went.
 *
 * In a particle method mass is carried by particles of fixed mass m, so the books are kept in
 * particles and reported in kg and m³:
 *
 *   M_domain(t) = M_initial + M_in − M_out − M_lost
 *
 * M_in: emitted by sources. M_out: removed by sinks (counted on the GPU as they cross).
 * M_lost: particles that failed numerically (NaN / ∞) — they are not hidden, they are an error.
 * The relative error is the one requested in the brief:
 *
 *   ε_M = |M_final − M_initial − M_in + M_out| / max(M_ref, m)
 *
 * with M_ref = M_initial + M_in (never zero once there is water).
 */
export class RiverMassAccounting {
  constructor(particleMass, particleVolume) {
    this.m = particleMass;
    this.v = particleVolume;
    this.reset(0);
  }

  reset(initialParticles) {
    this.initial = initialParticles;
    this.inflow = 0;
    this.outflow = 0;
    this.externalWork = 0; // J, work done by the player's control force (see RiverController)
  }

  addInflow(n) {
    this.inflow += n;
  }

  setOutflow(n) {
    this.outflow = n;
  }

  /** @param {number} active particles found in the domain  @param {number} lost NaN/∞ particles */
  evaluate(active, lost = 0) {
    const m = this.m;
    const ref = Math.max(this.initial + this.inflow, 1);
    const balance = active - this.initial - this.inflow + this.outflow;
    return {
      particleMass: m,
      massInitial: this.initial * m,
      massIn: this.inflow * m,
      massOut: this.outflow * m,
      massDomain: active * m,
      massLost: lost * m,
      volumeDomain: active * this.v,
      relError: Math.abs(balance) / ref,
      externalWork: this.externalWork,
    };
  }
}
