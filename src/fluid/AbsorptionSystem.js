import { MAX_OWNERS } from './FluidSolver.js';
import { NEUTRAL } from './RiverIdentity.js';

const K = MAX_OWNERS;

/**
 * AbsorptionSystem — when one river swallows another. THIS IS A GAME RULE, NOT FLUID PHYSICS.
 *
 * Real water mixes by advection and diffusion; nothing in physics decides that one body "belongs"
 * to another. What the game adds is ownership: which river a kilogram of water counts for. Two
 * separate layers, never confused:
 *   - physical mixing: the solver moves the water (pressure, momentum, collisions); the dye
 *     (colour) is advected with it and diffuses (RiverIdentity)
 *   - game absorption: ownership of particles at the contact front changes from the absorbed river
 *     B to the absorber A at a rate set by the rules below. No mass is created, destroyed or moved
 *     by it; every transferred particle is counted on the GPU (RiverIdentity transfer matrix).
 *
 * CONTACT (needs real surface contact, not centre distance). From the GPU contact matrix:
 *   N_AB = particles of A with ≥ 2 neighbours of B within h, excluding droplets (< 3 same-river
 *   neighbours: spray and foam do not count). With h = 2d, a particle has ≥ 2 foreign neighbours
 *   only in the first layer at a flat interface, so each contact particle stands for one
 *   particle's cross-section of interface:
 *       A_c = ½ (N_AB + N_BA) · V_p^(2/3)        (m²; V_p = particle volume ≈ d³)
 *   Exact for a flat interface between two lattices; when two bodies crash and interpenetrate the
 *   contact zone is a volume and A_c counts it as a larger (equivalent) surface.
 * HYSTERESIS: contact begins at A_c ≥ A_on, must be held (A_c ≥ A_off) for t_grab before any
 * transfer ("agarre"), and ends after A_c < A_off for t_release. A graze never transfers.
 * The shredded REMAINS of an absorbed river (f ≥ 0.85 or under 0.3 m³) are held by all contact
 * particles, droplets included: they are thin and would otherwise drop out of the count
 * (measured: an episode broke at f = 0.84 while the remains were still pressed against A).
 * A body that breaks away is judged on body contact only (measured: otherwise a few enmeshed
 * filaments kept a real escape "in contact" for 2.5 s).
 *
 * WHO ABSORBS WHOM: the larger mass at the end of the grab (ties: the faster one).
 *   R = m_A / max(m_B, m_floor) ≥ 1,  S(R) = (R − 1)/(R + 1) ∈ [0, 1)
 * NOMINAL DURATION (game design, monotone in R):
 *   T(R) = T_max − (T_max − T_min) · S^γ        T_max 7 s, T_min 1.5 s, γ 0.7
 *   R = 1 → 7 s · R = 1.5 → 5.2 s · R = 2 → 4.45 s · R = 4 → 3.15 s · R = 8 → 2.4 s · R → ∞ → 1.5 s
 *   T(R) is the duration under FIRM HEAD-ON contact; anything weaker (less area, aligned currents,
 *   resistance) only takes longer. So the design windows hold by construction: similar sizes
 *   5–8 s, moderate difference 3–5 s, very large 1.5–3 s.
 * RATE (kg/s, never negative, capped):
 *   dm/dt = (m_B0 / T(R0)) · min(φ_A · φ_u · φ_dir · φ_r, 1)
 *   φ_A   = clamp(A_c / A_ref, 0.25, 1.25),  A_ref = c_A · V_B0^(2/3)     more contact, faster;
 *           a light touch (A_c ≪ A_ref) transfers at a quarter of the nominal rate
 *   φ_u   = clamp(0.85 + 0.15 · |u_rel| / u_ref, 0.85, 1.25)             |u_rel| = mean speed of
 *           the contact particles relative to their foreign neighbours (measured on the GPU)
 *   φ_dir = (1 − 0.25 · cos θ) · clamp(1 + 1.5 χ, 0, 1)
 *           θ = angle between the two rivers' CURRENTS, the current of a river being
 *           ĉ = normalize(a_steer + 0.5 s⁻¹ · v̄); χ = ½ (ĉ_A − ĉ_B) · n̂_AB, n̂_AB the line of
 *           centres: χ = +1 head-on, 0 chase or side by side, −1 pulling apart.
 *           Head-on → 1.25 · aligned chase → 0.75 · pulling apart (χ ≤ −⅔) → 0: absorption happens
 *           through a pressed contact; when both currents pull away, the contact is in tension and
 *           nothing is transferred, so escaping is a matter of manoeuvre and speed. The separation
 *           term is faded in with the centre distance (from ½ to 0.8 of the sum of radii): while
 *           the bodies interpenetrate the line of centres is not a reliable direction.
 *           Needed because after a crash both bodies move together (measured: local |u_rel| alone
 *           could not tell head-on from aligned; and with cos θ alone, two rivers pulling apart
 *           counted as "head-on" and f rose from 0.31 to 0.68 during a real escape)
 *   φ_r   = 1 − 0.35 · resistance_B · (1 − S)                           resistance matters most
 *           between similar rivers
 *   The product is capped at 1 (measured: with a cap of 1.25 a head-on duel at R0 = 1.13 took
 *   4.9 s, under the 5 s of the design). Also dm/dt ≤ 2 m_B0 / T_min and never more than B has.
 * The GPU realises the rate by converting front particles with probability p = q / N_front, where
 * q is the deficit between the model's cumulative transfer and the transfer actually counted.
 * PROGRESS f = m_transferred / m_B0 ∈ [0, 1], from the exact counts (the bar shows this).
 * PHASES: agarre (grab, f = 0) → fusión (0 < f < 0.85) → integración (f ≥ 0.85) → completa.
 * Integration is a point of no return: pulling away no longer slows the transfer (only losing the
 * contact entirely still interrupts it).
 * If contact is lost: interrumpida; transfer stops; what was transferred stays with A.
 * When B's remains fall under 3 % of m_B0 (scattered droplets that may never touch A again), they
 * are released as free (neutral) water, not deleted: mass is still conserved. Free water touching
 * a river joins it at `neutralRate` (1/s per front particle).
 * MINIMUM VIABLE RIVER (game rule): a river under V_min = 0.12 m³ is spray, not a body; it
 * dissolves into free water (measured: without this rule a 0.09 m³ remnant of 28 particles kept
 * "escaping" as a droplet cloud).
 */
export const ABSORPTION_DEFAULTS = {
  areaOn: 0.6, // m² (a measured graze between two 1.5–3 m³ rivers peaked at 0.40)
  areaOff: 0.25, // m²
  grabTime: 0.6, // s (measured: a fast side-swipe kept 0.9 m² for ~0.5 s)
  releaseTime: 0.35, // s
  Tmax: 7, // s
  Tmin: 1.5, // s
  gamma: 0.7,
  areaRefCoef: 2.5, // calibrated: sustained contact between mounds measured 3–12 m² (they interpenetrate)
  cap: 1,
  uRef: 1.0, // m/s
  resistWeight: 0.35,
  integration: 0.85,
  leftover: 0.03,
  minParticles: 6,
  neutralRate: 1.5, // 1/s
  massFloorParticles: 10,
  minVolume: 0.12, // m³
};

/** The current of a river: unit horizontal vector of its driving force plus inertia (0 if still). */
function current(r) {
  const x = r.accel[0] + 0.5 * r.vel[0];
  const z = r.accel[2] + 0.5 * r.vel[2];
  const l = Math.hypot(x, z);
  return l > 0.05 ? [x / l, z / l] : [0, 0];
}

export const nominalDuration = (R, p = ABSORPTION_DEFAULTS) => {
  const S = (R - 1) / (R + 1);
  return p.Tmax - (p.Tmax - p.Tmin) * Math.max(S, 0) ** p.gamma;
};

export class AbsorptionSystem {
  constructor(params = {}) {
    this.p = { ...ABSORPTION_DEFAULTS, ...params };
    this.active = new Map(); // pair key → episode
    this.history = []; // finished episodes (complete, interrupted, grazes)
    this.prevT = new Float32Array(K * K);
    this.transfers = new Float32Array(K * K); // cumulative particles [from][to]
  }

  key(a, b) {
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  }

  /**
   * @param {number} t  simulated time (s)
   * @param {number} dt frame time (s)
   * @param {RiverEntity[]} rivers  indexed by slot (neutral at NEUTRAL)
   * @param {object} out  RiverIdentity.update() result
   * @param {object} identity  RiverIdentity (P / release are written for the next frame)
   * @param {{volume:number,h:number,mass:number}} cfg
   */
  update(t, dt, rivers, out, identity, cfg) {
    const p = this.p;
    const P = identity.P;
    P.fill(0);
    identity.release.fill(0);

    // 1. what was actually transferred this frame (exact GPU counts)
    const delta = new Float32Array(K * K);
    for (let from = 0; from < K; from++) {
      for (let to = 0; to < K; to++) {
        if (from === to) continue;
        const v = out.transfer[(from * K + to) * 4];
        delta[from * K + to] = v - this.prevT[from * K + to];
        this.prevT[from * K + to] = v;
        this.transfers[from * K + to] = v;
        const d = delta[from * K + to];
        if (d > 0) {
          rivers[from]?.log(t, -d, to, from === NEUTRAL || to === NEUTRAL ? 'agua libre' : 'absorción');
          rivers[to]?.log(t, d, from, from === NEUTRAL || to === NEUTRAL ? 'agua libre' : 'absorción');
        }
      }
    }

    // 2. contact per pair
    const C = (i, j) => out.contact[(i * K + j) * 4];
    const U = (i, j) => out.contact[(i * K + j) * 4 + 1];
    const Call = (i, j) => out.contact[(i * K + j) * 4 + 3];
    const cell = cfg.volume ** (2 / 3);
    const contactOf = (a, b) => {
      const n = C(a, b) + C(b, a);
      return {
        n,
        area: 0.5 * n * cell, // body contact only: decides whether a contact STARTS (robust to spray)
        areaAll: 0.5 * (Call(a, b) + Call(b, a)) * cell, // any contact: HOLDS an established fusion
        urel: n > 0 ? (U(a, b) + U(b, a)) / n : 0,
        front: (victim) => Call(victim, victim === a ? b : a), // particles that can change owner
      };
    };

    const alive = rivers.filter((r) => r && r.alive && r.type !== 'neutral' && r.count > 0);
    for (let x = 0; x < alive.length; x++) {
      for (let y = x + 1; y < alive.length; y++) {
        const a = alive[x];
        const b = alive[y];
        const k = this.key(a.slot, b.slot);
        const c = contactOf(a.slot, b.slot);
        let ep = this.active.get(k);
        if (!ep) {
          if (c.area < p.areaOn) continue;
          ep = { key: k, phase: 'agarre', tContact: t, grab: 0, off: 0, area: c.area, areaMax: c.area, urel: c.urel, samples: [] };
          this.active.set(k, ep);
        }
        // Contact is measured on BODY particles (spray excluded). Exception: the shredded remains of
        // an absorbed river (integration phase, or a victim under 0.3 m³) are thin, with few
        // same-river neighbours; for them every contact particle counts. Not for a body breaking
        // away: measured, a few enmeshed filaments otherwise held the contact 2.5 s after a real
        // escape and let f climb from 0.31 to 0.82.
        const victim = ep.phase === 'agarre' ? null : rivers[ep.b];
        const remains = victim && (ep.f >= p.integration || victim.volume < 0.3);
        const held = remains ? c.areaAll : c.area;
        ep.area = held;
        ep.areaMax = Math.max(ep.areaMax, held);
        ep.urel = c.urel;
        ep.off = held < p.areaOff ? ep.off + dt : 0;
        if (ep.phase === 'agarre') {
          ep.grab += dt;
          if (ep.off > p.releaseTime) {
            this.finish(ep, t, 'rozadura', rivers);
            continue;
          }
          if (ep.grab >= p.grabTime) this.startFusion(ep, t, a, b, cfg);
          continue;
        }
        // fusion / integration
        const A = rivers[ep.a];
        const B = rivers[ep.b];
        ep.transferred += delta[ep.b * K + ep.a];
        ep.f = Math.min(1, ep.transferred / ep.nB0);
        if (ep.off > p.releaseTime) {
          this.finish(ep, t, 'interrumpida', rivers);
          continue;
        }
        if (B.count === 0) {
          this.finish(ep, t, 'completa', rivers);
          continue;
        }
        if (ep.f >= p.integration) ep.phase = 'integración';
        // the model: dm/dt (kg/s)
        const vB0 = (ep.nB0 * cfg.mass) / 998.2;
        const phiA = Math.min(1.25, Math.max(0.25, held / (p.areaRefCoef * vB0 ** (2 / 3))));
        const phiU = Math.min(1.25, Math.max(0.85, 0.85 + (0.15 * c.urel) / p.uRef));
        const cA = current(A);
        const cB = current(B);
        const cos = cA[0] * cB[0] + cA[1] * cB[1];
        // line of centres A → B; closing χ: +1 head-on, 0 side-by-side or chase, −1 pulling apart
        const lx = B.com[0] - A.com[0];
        const lz = B.com[2] - A.com[2];
        const ll = Math.hypot(lx, lz) || 1;
        const chi = ((cA[0] * lx + cA[1] * lz) - (cB[0] * lx + cB[1] * lz)) / (2 * ll);
        // the line of centres only means something once the bodies are apart: while they are
        // interpenetrated (centre distance < ½ of the sum of radii) it can flip as one body pushes
        // through the other (measured: a head-on fusion stopped at f = 0.72 that way)
        // integration (f ≥ 0.85) is a point of no return: the remains are dragged in even if they
        // push away (measured: in a head-on duel between equals the last 15 % punched through A and
        // out of the far side); only a complete loss of contact still interrupts the episode
        const apart = ep.f >= p.integration ? 0 : Math.min(1, Math.max(0, (ll / Math.max(A.radius + B.radius, 1e-3) - 0.5) / 0.3));
        const phiD = (1 - 0.25 * cos) * (1 - apart * (1 - Math.min(1, Math.max(0, 1 + 1.5 * chi))));
        ep.chi = chi;
        const phiR = 1 - p.resistWeight * B.resistance * (1 - ep.S);
        const factor = Math.min(phiA * phiU * phiD * phiR, p.cap);
        const rate = Math.min(((ep.nB0 * cfg.mass) / ep.T) * factor, (2 * ep.nB0 * cfg.mass) / p.Tmin);
        ep.rateModel = rate;
        ep.phi = [phiA, phiU, phiD, phiR];
        ep.cos = cos;
        // a river that is itself being absorbed cannot absorb (no chains, no double counting)
        const blocked = A.absorbedBy !== null;
        if (!blocked) ep.target = Math.min(ep.target + (rate * dt) / cfg.mass, ep.nB0);
        const deficit = Math.max(0, ep.target - ep.transferred);
        const want = Math.min(deficit, B.count, (3 * rate * dt) / cfg.mass + 1);
        const front = c.front(ep.b);
        if (!blocked && want > 0) P[ep.b * K + ep.a] = Math.min(1, want / Math.max(front, 1));
        // leftovers: release as free water when only scattered remains are left
        if (ep.f >= p.integration && B.count <= Math.max(p.leftover * ep.nB0, p.minParticles)) identity.release[ep.b] = 1;
        ep.R = A.count / Math.max(B.count, p.massFloorParticles);
        ep.samples.push([+(t - ep.tStart).toFixed(3), +ep.f.toFixed(4), +held.toFixed(3), +c.urel.toFixed(3), +rate.toFixed(1)]);
      }
    }
    // episodes whose rivers vanished (e.g. B fully converted by another absorber)
    for (const ep of this.active.values()) {
      const a = rivers[ep.a ?? +ep.key.split('-')[0]];
      const b = rivers[ep.b ?? +ep.key.split('-')[1]];
      if (!a?.alive || !b?.alive || a.count === 0 || b.count === 0) {
        if (ep.phase !== 'agarre' && b?.count === 0) this.finish(ep, t, 'completa', rivers);
        else this.finish(ep, t, ep.phase === 'agarre' ? 'rozadura' : 'interrumpida', rivers);
      }
    }
    // minimum viable river: below V_min it dissolves into free water
    for (const r of alive) if (r.volume < p.minVolume) identity.release[r.slot] = 1;
    // free water joins any river it touches (that is not being absorbed)
    const k = 1 - Math.exp(-p.neutralRate * dt);
    for (const r of alive) if (r.absorbedBy === null) P[NEUTRAL * K + r.slot] = k;
    this.updateStates(rivers);
  }

  startFusion(ep, t, a, b, cfg) {
    const p = this.p;
    let A = a;
    let B = b;
    if (b.count > a.count * 1.01 || (Math.abs(b.count - a.count) <= a.count * 0.01 && b.speed > a.speed)) {
      A = b;
      B = a;
    }
    ep.phase = 'fusión';
    ep.a = A.slot;
    ep.b = B.slot;
    ep.tStart = t;
    ep.nA0 = A.count;
    ep.nB0 = B.count;
    ep.R0 = A.count / Math.max(B.count, p.massFloorParticles);
    ep.S = (ep.R0 - 1) / (ep.R0 + 1);
    ep.T = nominalDuration(ep.R0, p);
    ep.transferred = 0;
    ep.target = 0;
    ep.f = 0;
    ep.R = ep.R0;
    ep.mB0 = B.count * cfg.mass;
    ep.mA0 = A.count * cfg.mass;
  }

  finish(ep, t, how, rivers) {
    ep.phase = how;
    ep.tEnd = t;
    if (ep.tStart !== undefined) ep.duration = t - ep.tStart;
    ep.contactDuration = t - ep.tContact;
    if (ep.nB0) ep.mTransferred = ep.transferred * (rivers[ep.a]?.particleMass ?? 0);
    this.active.delete(ep.key);
    this.history.push(ep);
    if (this.history.length > 200) this.history.shift();
  }

  /** Entity labels from the active episodes. */
  updateStates(rivers) {
    for (const r of rivers) {
      if (!r) continue;
      r.absorbedBy = null;
      r.fusion = 0;
      r.absorbing = [];
      r.grabbing = false;
    }
    for (const ep of this.active.values()) {
      if (ep.phase === 'agarre') {
        for (const s of ep.key.split('-')) if (rivers[+s]) rivers[+s].grabbing = true;
        continue;
      }
      const A = rivers[ep.a];
      const B = rivers[ep.b];
      B.absorbedBy = A;
      B.fusion = Math.max(B.fusion, ep.f);
      A.absorbing.push(B);
    }
    for (const r of rivers) {
      if (!r || r.type === 'neutral') continue;
      if (r.alive && r.count === 0 && r.initialMass > 0) r.alive = false;
      r.state = !r.alive ? 'absorbido' : r.absorbedBy ? 'siendo absorbido' : r.absorbing.length ? 'absorbiendo' : r.grabbing ? 'agarre' : 'libre';
    }
  }
}
