import { MAX_OWNERS } from './FluidSolver.js';
import { RiverIdentity, NEUTRAL } from './RiverIdentity.js';
import { RiverEntity, DENSITY } from './RiverEntity.js';
import { AbsorptionSystem } from './AbsorptionSystem.js';
import { RivalAI } from './RivalAI.js';

const K = MAX_OWNERS;

/**
 * RiverEcosystem — several rivers in ONE water simulation.
 *
 *   const eco = new RiverEcosystem(sim, { rivers: [...], neutral: [...] });
 *   eco.fill();               // fills the solver: every river is a body of real particles
 *   eco.frame(1 / 60);        // steering → solver step → identity/contact/transfer → absorption
 *
 * Per frame:
 *   1. intentions: player input / RivalAI → each river's steering acceleration (capped)
 *   2. forces to the solver (per-owner texture): steering, body cohesion, internal damping
 *   3. solver step (the same PBF step as everything else: pressure, collisions, momentum)
 *   4. RiverIdentity: contact, ownership transfers, dye, per-river statistics (GPU)
 *   5. AbsorptionSystem: episodes and the transfer probabilities for the next frame
 *   6. conservation checks (every frame, from exact counts)
 *
 * BODY COHESION (GAME RULE, declared): a river would otherwise spread into a film and merge with
 * every other river on contact. Each particle feels κ·(C − x) horizontally (capped), C the
 * river's centre of mass, plus an internal damping −c·(v − v̄). Both sum to zero over the river:
 * they shape it, they do not propel it. With gravity this gives a mound whose radius follows from
 * its own volume (hydrostatic balance ρg dH/dr = −ρκr):
 *   H(r) = H0 − κ r² / (2g),   V = π κ R⁴ / (4g)   ⇒   R = (4 g V / (π κ))^(1/4)
 * so the size of a river EMERGES from its mass; nothing is scaled.
 *
 * COLOUR POLICY (visual): 'receptor' — absorbed water slowly takes the absorber's colour;
 * 'mezcla' — physical mixing only: the dye is advected and diffuses, conserved, no relaxation;
 * 'estilizado' — like receptor, but each completed absorption moves the absorber's own colour
 * 20 % towards the mass-weighted mix (a trophy tint).
 */
export const COHESION_DEFAULTS = { kappa: 8, cap: 14, damping: 0.6 };

export function moundRadius(volume, kappa = COHESION_DEFAULTS.kappa) {
  return ((4 * 9.81 * volume) / (Math.PI * kappa)) ** 0.25;
}

export class RiverEcosystem {
  /**
   * @param {RiverSimulation} sim
   * @param {object} o
   * @param {{name:string,type?:string,color:number[],at:number[],volume:number,personality?:string,resistance?:number}[]} o.rivers
   * @param {{at:number[],volume:number}[]} [o.neutral]  free water patches
   */
  constructor(sim, { rivers, neutral = [], cohesion = {}, absorption = {}, colorPolicy = 'receptor', seed = 1 } = {}) {
    if (rivers.length > K - 1) throw new Error(`[rivers] at most ${K - 1} rivers (slot ${NEUTRAL} is free water)`);
    this.sim = sim;
    this.cohesion = { ...COHESION_DEFAULTS, ...cohesion };
    this.identity = new RiverIdentity(sim);
    this.absorption = new AbsorptionSystem(absorption);
    this.spec = rivers;
    this.neutralSpec = neutral;
    this.rivers = new Array(K).fill(null);
    rivers.forEach((r, slot) => {
      const e = new RiverEntity({ slot, name: r.name, type: r.type ?? 'rival', color: r.color, resistance: r.resistance ?? 0.3 });
      if (r.personality) new RivalAI(e, r.personality, { collision: sim.collision, seed: seed + slot });
      this.rivers[slot] = e;
    });
    this.rivers[NEUTRAL] = new RiverEntity({ slot: NEUTRAL, name: 'agua libre', type: 'neutral', color: [0.75, 0.85, 0.9] });
    this.rivers[NEUTRAL].sigma = [1.6, 0.6, 0.18]; // free water: clear, slightly blue (visual)
    this.ownerData = new Float32Array(K * 3 * 4);
    this.colorPolicy = colorPolicy;
    this.checks = { total0: 0, totalNow: 0, countError: 0, bookError: 0, maxF: 0, ok: true };
    this.time = 0;
  }

  get player() {
    return this.rivers.find((r) => r?.type === 'player') ?? null;
  }

  get list() {
    return this.rivers.filter((r) => r && r.type !== 'neutral');
  }

  /**
   * Fill blocks: each river starts as a cylinder of about its mound radius (it settles into the
   * mound). The height is a whole number of particle layers and the radius is re-fitted to it, so
   * the volume is right at any resolution (measured: rounding the height alone gave a mass ratio
   * of 1.40 instead of 2.14 at d = 0.18 m).
   */
  blocks() {
    const d = this.sim.cfg.spacing;
    const cyl = (at, volume, owner, dye) => {
      const R0 = moundRadius(volume, this.cohesion.kappa);
      const layers = Math.max(2, Math.round(volume / (Math.PI * R0 * R0) / d));
      const H = layers * d;
      const R = Math.sqrt(volume / (Math.PI * H));
      const y0 = this.sim.collision.domain.min[1];
      return { min: [at[0] - R, y0, at[1] - R], max: [at[0] + R, y0 + H, at[1] + R], radius: R, owner, dye };
    };
    const b = this.spec.map((r, slot) => cyl(r.at, r.volume, slot, this.rivers[slot].sigma));
    for (const n of this.neutralSpec) b.push(cyl(n.at, n.volume, NEUTRAL, this.rivers[NEUTRAL].sigma));
    return b;
  }

  fill(extra = []) {
    const n = this.sim.fill([...this.blocks(), ...extra]);
    this.identity.resetTransfers();
    this.applyColorPolicy();
    this.ingest(this.identity.measure(), 0);
    for (const r of this.rivers) if (r) r.initialMass = r.mass;
    this.counts0 = this.rivers.map((r) => r?.count ?? 0);
    this.checks.total0 = this.counts0.reduce((a, b) => a + b, 0);
    this.time = 0;
    return n;
  }

  applyColorPolicy() {
    const base = this.identity.base;
    const relax = this.colorPolicy !== 'mezcla';
    for (let k = 0; k < K; k++) {
      const r = this.rivers[k];
      const s = r?.sigma ?? [0, 0, 0];
      base.set([s[0], s[1], s[2], relax && r ? 1 : 0], k * 4);
    }
  }

  ingest(out, dt) {
    const m = this.sim.cfg.mass;
    for (let k = 0; k < K; k++) {
      const r = this.rivers[k];
      if (!r) continue;
      const o = k * 4;
      r.ingest(out.s0.subarray(o, o + 4), out.s1.subarray(o, o + 4), out.s2.subarray(o, o + 4), out.s3.subarray(o, o + 4), m, dt);
    }
  }

  /** Forces for the solver (texture rows: steering + κ, centre + cap, mean velocity + damping). */
  writeOwners() {
    const D = this.ownerData;
    D.fill(0);
    const c = this.cohesion;
    for (let k = 0; k < K; k++) {
      const r = this.rivers[k];
      if (!r || r.type === 'neutral' || r.count === 0) continue;
      D.set([r.accel[0], 0, r.accel[2], c.kappa], (0 * K + k) * 4);
      D.set([r.com[0], r.com[1], r.com[2], c.cap], (1 * K + k) * 4);
      D.set([r.vel[0], r.vel[1], r.vel[2], c.damping], (2 * K + k) * 4);
    }
    this.sim.solver.setOwners(D);
  }

  frame(dt) {
    const t = this.time;
    for (const r of this.rivers) {
      if (!r || r.type === 'neutral') continue;
      r.ai?.update(t, dt, this.rivers);
      r.updateSteering(dt);
    }
    this.writeOwners();
    this.sim.step(dt);
    const out = this.identity.update(dt);
    this.time += dt;
    this.ingest(out, dt);
    const before = this.absorption.history.length;
    this.absorption.update(this.time, dt, this.rivers, out, this.identity, { volume: this.sim.cfg.volume, h: this.sim.cfg.h, mass: this.sim.cfg.mass });
    if (this.colorPolicy === 'estilizado') {
      for (const ep of this.absorption.history.slice(before)) {
        if (ep.phase !== 'completa') continue;
        const A = this.rivers[ep.a];
        const B = this.rivers[ep.b];
        const wA = ep.nA0 / (ep.nA0 + ep.nB0);
        A.sigma = A.sigma.map((s, i) => s + 0.2 * (wA * s + (1 - wA) * B.sigma[i] - s));
        this.applyColorPolicy();
      }
    }
    this.check(out);
    return out;
  }

  /**
   * CONSERVATION (brief §14), from exact integer counts:
   *   - total particles (all rivers + free water) never changes          → countError
   *   - every river: N_k(t) − N_k(0) = Σ_j T[j→k] − Σ_j T[k→j]           → bookError (worst)
   *     i.e. each river's mass changes ONLY by counted transfers (no double counting, no loss)
   *   - no episode transfers more than the absorbed river had: f ≤ 1   → maxF
   */
  check(out) {
    const T = out.transfer;
    let total = 0;
    let worst = 0;
    for (let k = 0; k < K; k++) {
      const n = this.rivers[k]?.count ?? 0;
      total += n;
      let inflow = 0;
      let outflow = 0;
      for (let j = 0; j < K; j++) {
        if (j === k) continue;
        inflow += T[(j * K + k) * 4];
        outflow += T[(k * K + j) * 4];
      }
      worst = Math.max(worst, Math.abs(n - (this.counts0[k] ?? 0) - inflow + outflow));
    }
    let maxF = 0;
    for (const ep of [...this.absorption.active.values(), ...this.absorption.history]) if (ep.nB0) maxF = Math.max(maxF, ep.transferred / ep.nB0);
    const c = this.checks;
    c.totalNow = total;
    c.countError = Math.abs(total - c.total0);
    c.bookError = worst;
    c.maxF = maxF;
    c.massTotal = total * this.sim.cfg.mass;
    c.ok = c.countError === 0 && c.bookError === 0 && maxF <= 1 + 1e-9;
    return c;
  }

  /** Mass of each river (kg) — convenience for HUD and tests. */
  masses() {
    return this.rivers.map((r) => (r ? r.mass : 0));
  }
}

export { DENSITY, NEUTRAL };
