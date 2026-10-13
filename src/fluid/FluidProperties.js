/**
 * FluidProperties — the single place where physical constants and solver parameters live.
 *
 * UNITS. Everything inside the fluid module is SI: metres, kilograms, seconds, pascals.
 * Three.js scenes in this project use 1 unit = 1 metre, so there is no conversion at all
 * between the solver and the renderer. (Unreal Engine would need ×100: it works in cm.)
 *
 * WHAT IS PHYSICAL AND WHAT IS NUMERICAL. The reference continuum model is incompressible
 * Navier–Stokes with gravity and a free surface. The solver is Position Based Fluids (PBF,
 * Macklin & Müller 2013): particles carry mass, and incompressibility is enforced as a density
 * constraint ρ_i = ρ0 solved iteratively. At the particle sizes a real-time game can afford
 * (centimetres to decimetres) some properties of real water cannot be resolved, and this file
 * says so instead of pretending:
 *   - density ρ0 = 998.2 kg/m³        → used directly (rest density of the constraint)
 *   - gravity g = 9.81 m/s²          → used directly
 *   - dynamic viscosity 1.002e-3 Pa·s → NOT resolvable at h ≈ 0.1 m (Reynolds number ~10⁵–10⁶):
 *       the solver has numerical dissipation far above it. `xsph` is an explicit, documented
 *       smoothing term (XSPH), not water's viscosity.
 *   - surface tension 0.0728 N/m     → negligible at this scale (Bond number ρgL²/σ ≈ 10³ for
 *       L = 0.1 m). Not modelled. `sCorrK` is the PBF "artificial pressure" that prevents particle
 *       clumping (numerical). `cohesion` keeps films thinner than a particle continuous: a
 *       sub-resolution model, declared as such, not the 0.0728 N/m of real water.
 */

/** Fresh water at 20 °C (reference values requested in the brief). */
export const WATER_20C = Object.freeze({
  density: 998.2, // kg/m³
  dynamicViscosity: 1.002e-3, // Pa·s
  kinematicViscosity: 1.002e-3 / 998.2, // m²/s
  surfaceTension: 0.0728, // N/m
  gravity: 9.81, // m/s²
});

/** Default solver configuration. Every number here is overridable from one object. */
export const DEFAULT_CONFIG = Object.freeze({
  spacing: 0.1, // m — particle lattice spacing d (sets the resolution)
  hFactor: 2.0, // smoothing radius h = hFactor · d  (~33 neighbours in 3D)
  density: WATER_20C.density,
  gravity: [0, -WATER_20C.gravity, 0],
  substeps: 3, // solver steps per rendered frame
  iterations: 4, // PBF constraint iterations per substep
  relaxation: 0.05, // ε as a fraction of the rest-state constraint gradient norm (softness)
  sCorrK: 0.03, // artificial pressure per substep, in units of an equivalent density error
  sCorrDq: 0.3, // artificial pressure reference distance, as a fraction of h
  sCorrN: 4,
  xsph: 0.04, // XSPH velocity smoothing (numerical, see header)
  wallDrag: 1.5, // 1/s tangential velocity decay while touching a solid (bed roughness)
  // SUB-RESOLUTION COHESION (Akinci et al. 2013), NOT water's surface tension: a sheet of water
  // thinner than one particle would otherwise break into separate particles (a resolution
  // artefact; a real 5 cm film is continuous). Pairwise and antisymmetric: momentum is conserved.
  cohesion: 0.08,
  maxSpeed: 25, // m/s safety clamp; every clamp is counted in the diagnostics
  // foam onset criteria (visual layer, see FluidSolver xsph pass): vorticity 1/s, speed m/s,
  // free-surface density ratio, lifetime s
  foam: [12, 3.5, 0.55, 1.0],
});

/** Smoothing kernels (Müller et al. 2003): poly6 for density, spiky for gradients. */
export function kernelConstants(h) {
  return {
    h,
    h2: h * h,
    poly6: 315 / (64 * Math.PI * h ** 9),
    spikyGrad: -45 / (Math.PI * h ** 6),
  };
}

export function poly6(K, r2) {
  if (r2 >= K.h2) return 0;
  const x = K.h2 - r2;
  return K.poly6 * x * x * x;
}

/** |∇W_spiky| at distance r (a scalar; the gradient points along −r̂). */
export function spikyGradMag(K, r) {
  if (r >= K.h || r <= 0) return 0;
  const x = K.h - r;
  return -K.spikyGrad * x * x;
}

/**
 * Derive everything the solver needs from a config.
 *
 * MASS CALIBRATION: with a finite kernel, Σ_j W(r_ij) over a regular lattice of spacing d is not
 * exactly 1/d³. The particle mass is chosen so that an interior particle of a regular lattice at
 * rest has density ρ0 exactly: m = ρ0 / Σ_j W(r_ij). Its volume is therefore m/ρ0, which is what
 * the mass accounting reports (not d³).
 */
export function resolveConfig(overrides = {}) {
  const c = { ...DEFAULT_CONFIG, ...overrides };
  const d = c.spacing;
  const h = c.hFactor * d;
  const K = kernelConstants(h);
  const reach = Math.ceil(c.hFactor) + 1;
  let sumW = 0;
  let sumG2 = 0;
  for (let k = -reach; k <= reach; k++) {
    for (let j = -reach; j <= reach; j++) {
      for (let i = -reach; i <= reach; i++) {
        const r2 = (i * i + j * j + k * k) * d * d;
        sumW += poly6(K, r2);
        const g = spikyGradMag(K, Math.sqrt(r2));
        sumG2 += g * g;
      }
    }
  }
  const mass = c.density / sumW; // kg per particle
  // BOUNDARY DENSITY (Akinci et al. 2012, as a precomputed table): a solid surface is treated as a
  // half-space filled with a virtual lattice of solid particles continuing the fluid lattice
  // through the wall. For a fluid particle at distance δ from the surface, rhoB(δ) is their density
  // contribution and dRhoB(δ) the (spiky) gradient magnitude along the surface normal.
  // Without this, particles next to the floor and walls miss half their neighbours, under-estimate
  // their density, and the bottom layers compress: measured as a lower free surface and a pressure
  // slope 25% under ρg in the hydrostatic test before this term existed.
  const BN = 32;
  const rhoB = new Float32Array(BN);
  const dRhoB = new Float32Array(BN);
  const lat = Math.ceil(c.hFactor) + 1;
  for (let s = 0; s < BN; s++) {
    const delta = (s / (BN - 1)) * h;
    let rho = 0;
    let grad = 0;
    for (let k = 0; k <= lat + 1; k++) {
      const dn = delta + d / 2 + k * d; // normal distance to a layer of solid particles
      if (dn >= h) break;
      for (let j = -lat; j <= lat; j++) {
        for (let i = -lat; i <= lat; i++) {
          const r2 = dn * dn + (i * i + j * j) * d * d;
          if (r2 >= h * h) continue;
          rho += poly6(K, r2);
          const r = Math.sqrt(r2);
          grad -= spikyGradMag(K, r) * (dn / r);
        }
      }
    }
    rhoB[s] = rho * (c.density / sumW);
    dRhoB[s] = grad * (c.density / sumW);
  }
  const volume = mass / c.density; // m³ per particle
  // Σ_k |∇_k C_i|² for an interior lattice particle (the Σ_j ∇W term cancels by symmetry)
  const denomRest = (mass / c.density) ** 2 * sumG2;
  return {
    ...c,
    h,
    kernel: K,
    mass,
    volume,
    particleRadius: d * 0.5,
    denomRest,
    epsilon: c.relaxation * denomRest,
    // artificial pressure is added to λ (units m²): scale it like λ = −C/denom
    sCorrScaled: c.sCorrK / denomRest,
    wDq: poly6(K, (c.sCorrDq * h) ** 2),
    restNeighbourSum: sumW,
    boundaryTable: { rhoB, dRhoB, samples: BN },
  };
}
