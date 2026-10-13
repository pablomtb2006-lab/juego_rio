import { RiverSimulation } from './RiverSimulation.js';

/**
 * FluidValidationTests — reproducible scenarios with quantitative pass/fail criteria.
 * Run headless with `node tools/fluid-tests.mjs` (or open lab/agua/tests.html).
 *
 * References used (all analytic, no digitised data):
 *   A  hydrostatics: p(depth) = ρ g depth  (the slope of p against depth must be ρg)
 *   B  mass: particle books (see RiverMassAccounting), in every test
 *   G1 free fall: internal forces are pairwise and symmetric, so the centre of mass of a blob in
 *      the air must follow y0 − ½ g t² exactly
 *   G2 dam break on a dry, frictionless bed — Ritter (1892), shallow-water theory:
 *        depth at the dam site → 4/9 H0, front speed → 2 √(g H0) (an upper bound: real fronts,
 *        resolved 3D flow and any dissipation are slower)
 *   J  time-step independence, I resolution independence (spread of the G2 measurements)
 */
const yieldUI = () => new Promise((r) => setTimeout(r, 0));

function makeSim(gl, opts) {
  return new RiverSimulation(gl, opts);
}

async function run(sim, seconds, frameDt, onSample, every = 0.25) {
  let next = 0;
  while (sim.time < seconds - 1e-9) {
    sim.step(frameDt);
    if (sim.time >= next - 1e-9) {
      next += every;
      await onSample?.(sim);
      await yieldUI();
    }
  }
}

/** Least-squares slope and intercept of y on x. */
function fit(xs, ys) {
  const n = xs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
  }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return { slope, intercept: (sy - slope * sx) / n, n };
}

const percentile = (arr, q) => {
  if (!arr.length) return NaN;
  const a = Float64Array.from(arr).sort();
  return a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))];
};

/** Mean κ_yy = Σ_j V_j (y_j − y_i) (∂W_ij/∂y_i) over the particles selected by `keep` (CPU, grid hash). */
function measureKappaYY(pos, cfg, keep) {
  const h = cfg.h;
  const V = cfg.mass / cfg.density;
  const K = cfg.kernel;
  const grid = new Map();
  const key = (x, y, z) => `${Math.floor(x / h)},${Math.floor(y / h)},${Math.floor(z / h)}`;
  const n = pos.length / 4;
  for (let i = 0; i < n; i++) {
    if (pos[i * 4 + 3] < 0) continue;
    const k = key(pos[i * 4], pos[i * 4 + 1], pos[i * 4 + 2]);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (pos[o + 3] < 0 || !keep(pos[o], pos[o + 1], pos[o + 2])) continue;
    const cx = Math.floor(pos[o] / h), cy = Math.floor(pos[o + 1] / h), cz = Math.floor(pos[o + 2] / h);
    let k = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      for (const j of grid.get(`${cx + a},${cy + b},${cz + c}`) ?? []) {
        if (j === i) continue;
        const rx = pos[o] - pos[j * 4], ry = pos[o + 1] - pos[j * 4 + 1], rz = pos[o + 2] - pos[j * 4 + 2];
        const r = Math.hypot(rx, ry, rz);
        if (r >= h || r <= 0) continue;
        const x = h - r;
        const gy = K.spikyGrad * x * x * (ry / r); // ∂W/∂y_i (spiky)
        k += V * -ry * gy; // (y_j − y_i) = −ry
      }
    }
    sum += k;
    count++;
  }
  return count ? sum / count : 1;
}

const massChecks = (m) => ({
  massRelError: m.relError,
  lostParticles: m.lost,
  insideSolids: m.insideSolids,
  outsideDomain: m.outsideDomain,
  speedClamps: m.speedClamps,
});
const massPass = (m) => m.relError < 1e-9 && m.lost === 0 && m.insideSolids === 0 && m.outsideDomain === 0;

// ------------------------------------------------------------------------------------------------

export const TESTS = {
  /** A — water at rest in a closed tank. */
  async rest(gl, { spacing = 0.05, seconds = 5, substeps = 3, config = {} } = {}) {
    const W = 1.0, D = 0.5, Hw = 0.6;
    const sim = makeSim(gl, {
      capacity: 4096,
      domain: { min: [0, 0, 0], max: [W, 1.2, D] },
      config: { spacing, substeps, ...config },
    });
    const n = sim.fill([{ min: [0, 0, 0], max: [W, Hw, D] }]);
    const ke = [];
    let peak = 0;
    await run(sim, seconds, 1 / 60, (s) => {
      const m = s.measure();
      ke.push([+s.time.toFixed(2), m.kinetic]);
      peak = Math.max(peak, m.kinetic);
    });
    const m = sim.measure();
    // hydrostatics: pressure against depth below the free surface, away from walls and surface
    const { pos, fields } = sim.diagnostics.read();
    const h = sim.cfg.h;
    const ys = [];
    for (let i = 0; i < pos.length / 4; i++) if (pos[i * 4 + 3] >= 0) ys.push(pos[i * 4 + 1]);
    const surface = percentile(ys, 0.995) + sim.cfg.particleRadius;
    const depth = [];
    const press = [];
    for (let i = 0; i < pos.length / 4; i++) {
      const o = i * 4;
      if (pos[o + 3] < 0) continue;
      const [x, y, z] = [pos[o], pos[o + 1], pos[o + 2]];
      if (x < h || x > W - h || z < h || z > D - h) continue;
      const dep = surface - y;
      if (dep < 2 * h || y < h) continue;
      depth.push(dep);
      press.push(fields[o + 2]);
    }
    const f = fit(depth, press);
    const rhoG = sim.cfg.density * 9.81;
    // The estimator p = −ρ0 Σλ/dt² assumes the discrete gradient is normalised:
    // Σ_j V_j (x_j − x_i)⊗∇W_ij = I. It is not exactly (κ ≈ 0.947 on an ideal lattice, and the
    // real particles are not a lattice), so κ_yy is MEASURED on the actual configuration and the
    // slope is corrected by it. This corrects the estimator, not the solver.
    const kappa = measureKappaYY(pos, sim.cfg, (x, y, z) => x > h && x < W - h && z > h && z < D - h && surface - y > 2 * h && y > 2 * h);
    const slopeCorrected = f.slope * kappa;
    const slopeErr = Math.abs(slopeCorrected - rhoG) / rhoG;
    const metrics = {
      particles: n,
      seconds,
      surfaceHeight: surface,
      expectedSurface: (n * sim.cfg.volume) / (W * D),
      pressureSlopeRaw: f.slope,
      kappaYY: kappa,
      pressureSlope: slopeCorrected,
      expectedSlope: rhoG,
      expectedSurfaceGeometric: (n * spacing ** 3) / (W * D),
      pressureSlopeError: slopeErr,
      pressureSamples: f.n,
      kineticPeak: peak,
      kineticEnd: m.kinetic,
      speedMaxEnd: m.speedMax,
      speedMeanEnd: m.speedMean,
      densityErrorMean: m.densityErrorMean,
      densityErrorMax: m.densityErrorMax,
      keSeries: ke,
      ...massChecks(m),
    };
    const pass = massPass(m) && slopeErr < 0.1 && m.speedMean < 0.02 && m.kinetic < 0.02 * peak;
    return {
      pass,
      metrics,
      criteria: 'mass exact, nothing inside solids; |dp/dz − ρg|/ρg < 10%; mean speed < 2 cm/s; KE_end < 2% of KE_peak',
    };
  },

  /** G1 — a blob in free fall: centre of mass vs y0 − ½gt². */
  async freefall(gl, { spacing = 0.05, substeps = 3 } = {}) {
    const sim = makeSim(gl, {
      capacity: 1024,
      domain: { min: [-2, 0, -2], max: [2, 6, 2] },
      config: { spacing, substeps },
    });
    sim.fill([{ min: [-0.2, 4.0, -0.2], max: [0.2, 4.4, 0.2] }]);
    const m0 = sim.measure();
    const y0 = m0.com[1];
    const T = 0.6; // lands at ≈ 0.9 s: stay well before
    await run(sim, T, 1 / 60);
    const m = sim.measure();
    const dt = 1 / 60 / substeps;
    const yExpected = y0 - 0.5 * 9.81 * T * T;
    // symplectic Euler (v += g dt; x += v dt) lands exactly here: the extra g·T·dt/2 is the
    // integrator's first-order truncation error, not a force
    const yDiscrete = y0 - 0.5 * 9.81 * T * (T + dt);
    const vExpected = -9.81 * T;
    const fallErr = Math.abs(m.com[1] - yExpected) / (y0 - yExpected);
    const discreteErr = Math.abs(m.com[1] - yDiscrete) / (y0 - yDiscrete);
    const velErr = Math.abs(m.comVel[1] - vExpected) / Math.abs(vExpected);
    const drift = Math.hypot(m.com[0] - m0.com[0], m.com[2] - m0.com[2]);
    return {
      pass: massPass(m) && discreteErr < 1e-3 && velErr < 1e-3 && drift < 1e-3,
      metrics: { y0, t: T, dt, com: m.com, yExpected, fallError: fallErr, yDiscrete, discreteError: discreteErr, integratorTerm: 0.5 * 9.81 * T * dt, comVel: m.comVel, vExpected, velError: velErr, lateralDrift: drift, ...massChecks(m) },
      criteria: 'centre of mass within 0.1% of the exact discrete free fall, velocity within 0.1% of −gt, lateral drift < 1 mm (internal forces are pairwise: they cannot move the centre of mass)',
    };
  },

  /** B — mass books with a source and a sink: a channel fed at one end and drained at the other. */
  async flow(gl, { spacing = 0.04, substeps = 3, seconds = 4 } = {}) {
    // (first version of this test had a 30 cm weir: the water never reached the sink and the
    // source filled the capacity — the books balanced, but the sink was never exercised)
    const sim = makeSim(gl, {
      capacity: 8192,
      domain: { min: [0, 0, 0], max: [4, 1.2, 0.6] },
      obstacles: { boxes: [{ center: [2, 0.05, 0.3], half: [0.15, 0.05, 0.3] }] }, // a low weir across the channel
      config: { spacing, substeps },
    });
    sim.fill([{ min: [0, 0, 0], max: [1.6, 0.3, 0.6] }]);
    const src = sim.addSource({ center: [0.3, 0.9, 0.3], dir: [0.6, -1, 0], radius: 0.12, speed: 2.0 });
    sim.setSink([3.2, 0, 0], [4, 1.2, 0.6]);
    const series = [];
    await run(sim, seconds, 1 / 60, (s) => {
      const m = s.measure();
      series.push([+s.time.toFixed(2), m.active, Math.round(m.massIn), Math.round(m.massOut), m.relError]);
    });
    const m = sim.measure();
    return {
      pass: m.relError < 1e-9 && m.lost === 0 && m.insideSolids === 0 && m.massIn > 0 && m.massOut > 0,
      metrics: {
        designFlow: src.flow,
        massIn: m.massIn,
        massOut: m.massOut,
        massDomain: m.massDomain,
        massInitial: m.massInitial,
        balance: m.massDomain - m.massInitial - m.massIn + m.massOut,
        starvedLayers: src.starved ?? 0,
        series,
        ...massChecks(m),
      },
      criteria: 'M_domain = M_initial + M_in − M_out exactly (relative error < 1e-9), water reaches the sink, nothing inside solids',
    };
  },

  /** Player control: a uniform horizontal force moves the water; its work is booked. */
  async control(gl, { spacing = 0.05, substeps = 3 } = {}) {
    const { RiverController } = await import('./RiverController.js');
    const sim = makeSim(gl, { capacity: 4096, domain: { min: [0, 0, 0], max: [6, 1.5, 1.0] }, config: { spacing, substeps } });
    sim.fill([{ min: [0.2, 0, 0.2], max: [1.4, 0.5, 0.8] }]);
    const ctl = new RiverController(sim, { maxAccel: 4, response: 3 });
    const m0 = sim.measure();
    ctl.account(m0);
    ctl.setInput(1, 0);
    await run(sim, 1.5, 1 / 60, (s) => {
      ctl.update(1 / 60 * 15); // the controller is updated once per sample in this test (coarser than the lab)
      ctl.account(s.measure());
    }, 0.25);
    ctl.setInput(0, 0);
    const mA = sim.measure();
    await run(sim, 3.0, 1 / 60, (s) => {
      ctl.update(1 / 60 * 15);
      ctl.account(s.measure());
    }, 0.25);
    const mB = sim.measure();
    const moved = mA.com[0] - m0.com[0];
    return {
      pass: moved > 0.2 && mB.relError < 1e-9 && mB.lost === 0 && ctl.work > 0,
      metrics: { comStart: m0.com, comAfterPush: mA.com, comAfterRelease: mB.com, moved, workBooked: ctl.work, keAfterPush: mA.kinetic, keAfterRelease: mB.kinetic, ...massChecks(mB) },
      criteria: 'the force moves the water (> 0.2 m), mass is untouched, the work done is booked as external energy (> 0)',
    };
  },

  /** G2 — dam break on a dry, frictionless bed vs Ritter's shallow-water solution. */
  async dambreak(gl, { spacing = 0.03, substeps = 3, capacity = 4096, seconds = 1.6, record = false } = {}) {
    const L = 2.4, H0 = 0.3, Wz = 0.15, X = 8;
    const sim = makeSim(gl, {
      capacity,
      domain: { min: [0, 0, 0], max: [X, 0.7, Wz] },
      config: { spacing, substeps, wallDrag: 0 }, // Ritter assumes no bed friction
    });
    const n = sim.fill([{ min: [0, 0, 0], max: [L, H0, Wz] }]);
    const c0 = Math.sqrt(9.81 * H0);
    const samples = [];
    await run(
      sim,
      seconds,
      1 / 60,
      (s) => {
        const { pos } = s.diagnostics.read();
        const xs = [];
        const gateY = [];
        for (let i = 0; i < pos.length / 4; i++) {
          const o = i * 4;
          if (pos[o + 3] < 0) continue;
          xs.push(pos[o]);
          if (Math.abs(pos[o] - L) < 1.5 * spacing) gateY.push(pos[o + 1]);
        }
        const front = percentile(xs, 0.997) + spacing / 2;
        const gateDepth = gateY.length ? percentile(gateY, 0.97) + spacing / 2 : 0;
        samples.push({ t: +s.time.toFixed(3), front, gateDepth });
      },
      0.1,
    );
    const m = sim.measure();
    // window where the shallow-water solution applies: after the column has collapsed (t·c0/H0 > 2),
    // before the rarefaction reflected from the back wall returns to the gate (≈ 2L/c0)
    const t0 = (2.2 * H0) / c0;
    const t1 = Math.min(seconds, (1.6 * L) / c0);
    const win = samples.filter((s) => s.t >= t0 && s.t <= t1);
    const gateMean = win.reduce((a, s) => a + s.gateDepth, 0) / Math.max(win.length, 1);
    const gateRatio = gateMean / ((4 / 9) * H0);
    // front speed: slope of front(t) over the window
    const fr = fit(win.map((s) => s.t), win.map((s) => s.front));
    const frontRatio = fr.slope / (2 * c0);
    return {
      pass: massPass(m) && Math.abs(gateRatio - 1) < 0.15 && frontRatio > 0.5 && frontRatio < 1.05,
      metrics: {
        particles: n,
        spacing,
        substeps,
        H0,
        reservoir: L,
        c0,
        window: [t0, t1],
        gateDepthMean: gateMean,
        gateDepthRitter: (4 / 9) * H0,
        gateRatio,
        frontSpeed: fr.slope,
        frontSpeedRitter: 2 * c0,
        frontRatio,
        ...(record ? { samples } : {}),
        ...massChecks(m),
      },
      criteria: 'mass exact; gate depth within 15% of 4/9·H0 in the shallow-water window; front speed between 0.5 and 1.05 × 2√(gH0)',
    };
  },
};

/** J and I are sweeps of G2. */
export async function sweep(gl, kind) {
  const runs = [];
  const variants =
    kind === 'timestep'
      ? [{ substeps: 2 }, { substeps: 3 }, { substeps: 5 }]
      : [
          { spacing: 0.04, capacity: 2048 },
          { spacing: 0.03, capacity: 4096 },
          { spacing: 0.024, capacity: 8192 },
        ];
  for (const v of variants) {
    const r = await TESTS.dambreak(gl, v);
    runs.push({ ...v, gateRatio: r.metrics.gateRatio, frontRatio: r.metrics.frontRatio, massRelError: r.metrics.massRelError, lost: r.metrics.lostParticles, pass: r.pass });
  }
  const g = runs.map((r) => r.gateRatio);
  const f = runs.map((r) => r.frontRatio);
  const spread = (a) => (Math.max(...a) - Math.min(...a)) / (a.reduce((x, y) => x + y, 0) / a.length);
  const stable = runs.every((r) => r.lost === 0 && r.massRelError < 1e-9);
  // distance to the analytic reference per run: tells "converging towards Ritter" apart from
  // "wandering" (reported, not used to soften the pass criterion)
  const gateErrorVsRitter = runs.map((r) => Math.abs(r.gateRatio - 1));
  const monotone = gateErrorVsRitter.every((e, i) => i === 0 || e <= gateErrorVsRitter[i - 1] + 1e-9);
  return {
    pass: stable && spread(g) < 0.1 && spread(f) < 0.1,
    metrics: { runs, gateSpread: spread(g), frontSpread: spread(f), gateErrorVsRitter, convergesTowardsRitter: monotone },
    criteria: 'no losses in any run; gate depth and front speed vary < 10% across the sweep',
  };
}
