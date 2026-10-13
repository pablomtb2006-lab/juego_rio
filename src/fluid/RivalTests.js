import { RiverSimulation } from './RiverSimulation.js';
import { RiverEcosystem } from './RiverEcosystem.js';
import { nominalDuration } from './AbsorptionSystem.js';
import { NEUTRAL } from './RiverIdentity.js';

/**
 * RivalTests — the ten scenarios of the rivals brief (§15), headless, with numeric criteria.
 * Run: `node tools/fluid-tests.mjs rivales` (or single names, e.g. `r2_similar`).
 *
 * Every test logs, for each absorption: duration, mass ratio R, contact area, transferred mass,
 * and the conservation error (exact particle counts: 0 means not a single particle unaccounted).
 *
 * Scenario: two (or three) rivers on a flat bed, steered by scripts (not by the AI) so the
 * situation is reproducible. Resolution d = 0.15 m unless stated (test 10 sweeps it).
 */
const yieldUI = () => new Promise((r) => setTimeout(r, 0));
const TURQ = [0.1, 0.85, 0.8];
const CORAL = [1.0, 0.38, 0.32];
const GOLD = [1.0, 0.68, 0.1];

async function scenario(gl, { rivers, neutral = [], seconds, steer, spacing = 0.15, substeps = 3, capacity = 4096, domain = { min: [-10, 0, -5], max: [10, 3, 5] }, colorPolicy = 'receptor', every = 6, until = null, onFrame = null }) {
  const sim = new RiverSimulation(gl, { capacity, domain, config: { spacing, substeps } });
  const eco = new RiverEcosystem(sim, { rivers, neutral, colorPolicy });
  eco.fill();
  const trace = [];
  let worstCount = 0;
  let worstBook = 0;
  let f = 0;
  while (eco.time < seconds - 1e-9) {
    steer(eco, eco.time, f);
    eco.frame(1 / 60);
    worstCount = Math.max(worstCount, eco.checks.countError);
    worstBook = Math.max(worstBook, eco.checks.bookError);
    onFrame?.(eco, f);
    if (f % every === 0) trace.push(snapshot(eco));
    f++;
    if (until?.(eco)) break;
    if (f % 20 === 0) await yieldUI();
  }
  const m = sim.measure();
  return { sim, eco, trace, worstCount, worstBook, m };
}

function snapshot(eco) {
  const s = { t: +eco.time.toFixed(3), n: eco.list.map((r) => r.count), free: eco.rivers[NEUTRAL].count };
  const ep = [...eco.absorption.active.values()].find((e) => e.phase !== 'agarre');
  if (ep) Object.assign(s, { f: +ep.f.toFixed(4), area: +ep.area.toFixed(3), rate: +(ep.rateModel ?? 0).toFixed(1) });
  return s;
}

/** Everything a test reports about one absorption episode. */
function episodeReport(ep, cfg) {
  if (!ep) return null;
  const smp = ep.samples ?? [];
  const mean = (k) => (smp.length ? smp.reduce((a, s) => a + s[k], 0) / smp.length : 0);
  return {
    phase: ep.phase,
    massRatioR0: ep.R0,
    nominalT: ep.T,
    duration: ep.duration ?? null,
    grabToEnd: ep.contactDuration ?? null,
    massB0: ep.nB0 ? ep.nB0 * cfg.mass : 0,
    massTransferred: ep.nB0 ? ep.transferred * cfg.mass : 0,
    f: ep.f ?? 0,
    contactAreaMean: mean(2),
    contactAreaMax: ep.areaMax,
    relSpeedMean: mean(3),
    rateModelMean: mean(4),
  };
}

const massOK = (r) => r.worstCount === 0 && r.worstBook === 0 && r.m.relError < 1e-9 && r.m.lost === 0 && r.m.insideSolids === 0 && r.m.outsideDomain === 0;
const conservation = (r) => ({
  conservationCountError: r.worstCount,
  conservationBookError: r.worstBook,
  solverMassRelError: r.m.relError,
  lost: r.m.lost,
  insideSolids: r.m.insideSolids,
  speedClamps: r.m.speedClamps,
  maxF: r.eco.checks.maxF,
});
const lastEpisode = (eco, phase) => [...eco.absorption.history].reverse().find((e) => !phase || e.phase === phase) ?? [...eco.absorption.active.values()][0];

/**
 * Head-on duel: A at the left, B at the right; each keeps steering towards the other's measured
 * centre of mass (a sustained fight). With a fixed direction instead, the remains of the smaller
 * river punched through the bigger one and escaped out of the far side (observed in test 2: a
 * legitimate emergent escape, but not the situation these tests measure).
 */
function headOn(vA, vB, throttle = 0.6) {
  return {
    rivers: [
      { name: 'A', color: TURQ, at: [-3.6, 0], volume: vA },
      { name: 'B', color: CORAL, at: [3.6, 0], volume: vB },
    ],
    steer: (eco, t) => {
      const [A, B] = eco.rivers;
      const go = t > 0.3 ? throttle : 0;
      const dx = B.com[0] - A.com[0];
      const dz = B.com[2] - A.com[2];
      const l = Math.hypot(dx, dz) || 1;
      A.setInput((go * dx) / l, (go * dz) / l);
      B.setInput((-go * dx) / l, (-go * dz) / l);
    },
  };
}

const done = (eco) => eco.absorption.history.some((e) => e.phase === 'completa');
let cache = {};

export const RIVAL_TESTS = {
  /** 1 — a brief graze must not complete an absorption (nor transfer anything worth counting). */
  async r1_graze(gl) {
    const r = await scenario(gl, {
      rivers: [
        { name: 'A', color: TURQ, at: [-4, -1.0], volume: 3 },
        { name: 'B', color: CORAL, at: [4, 1.0], volume: 1.5 },
      ],
      steer: (eco) => {
        eco.rivers[0].setInput(1, 0);
        eco.rivers[1].setInput(-1, 0);
      },
      seconds: 4.5,
    });
    const cfg = r.sim.cfg;
    const transferred = r.eco.absorption.transfers[0 * 8 + 1] + r.eco.absorption.transfers[1 * 8 + 0];
    const eps = r.eco.absorption.history.map((e) => ({ phase: e.phase, contact: e.contactDuration, areaMax: e.areaMax }));
    const mB = r.eco.rivers[1].initialMass;
    return {
      pass: massOK(r) && !r.eco.absorption.history.some((e) => e.phase === 'completa') && transferred * cfg.mass <= 0.02 * mB,
      metrics: { episodes: eps, transferredKg: transferred * cfg.mass, massB: mB, ...conservation(r) },
      criteria: 'no completed absorption, < 2 % of B transferred, mass exact',
    };
  },

  /** 2 — similar sizes (R ≈ 1.1): slow absorption, 5–8 s. */
  async r2_similar(gl) {
    const s = headOn(2.5, 2.25);
    const r = await scenario(gl, { ...s, seconds: 16, until: done });
    const ep = episodeReport(lastEpisode(r.eco), r.sim.cfg);
    return {
      pass: massOK(r) && ep?.phase === 'completa' && ep.duration >= 5 && ep.duration <= 8,
      metrics: { ...ep, ...conservation(r), trace: r.trace.filter((_, i) => i % 5 === 0) },
      criteria: 'completes; duration from end of grab to completion within 5–8 s; mass exact',
    };
  },

  /** 3 — a large difference (R ≈ 6): fast absorption, 1.5–3 s. */
  async r3_large(gl) {
    const s = headOn(5, 0.8);
    const r = await scenario(gl, { ...s, seconds: 10, until: done });
    const ep = episodeReport(lastEpisode(r.eco), r.sim.cfg);
    return {
      pass: massOK(r) && ep?.phase === 'completa' && ep.duration >= 1.5 && ep.duration <= 3,
      metrics: { ...ep, ...conservation(r), trace: r.trace.filter((_, i) => i % 3 === 0) },
      criteria: 'completes; duration within 1.5–3 s; mass exact',
    };
  },

  /** 4 — interrupted: B breaks away at f ≈ 0.3; transfer stops, A keeps what it took. */
  async r4_interrupted(gl) {
    let broke = null;
    let after = null;
    const r = await scenario(gl, {
      rivers: [
        { name: 'A', color: TURQ, at: [-3.6, 0], volume: 3 },
        { name: 'B', color: CORAL, at: [3.6, 0], volume: 1.5 },
      ],
      steer: (eco, t) => {
        const [A, B] = eco.rivers;
        const ep = [...eco.absorption.active.values()].find((e) => e.phase !== 'agarre');
        if (!broke && ep && ep.f >= 0.3) broke = { t, f: ep.f, nA: A.count, nB: B.count };
        if (broke) {
          A.setInput(-1, 0); // both pull apart: a real escape, by force
          B.setInput(1, 0);
        } else {
          A.setInput(t > 0.3 ? 0.6 : 0, 0);
          B.setInput(t > 0.3 ? -0.6 : 0, 0);
        }
      },
      onFrame: (eco) => {
        const ep = eco.absorption.history.find((e) => e.phase === 'interrumpida');
        if (ep && !after) after = { t: eco.time, nA: eco.rivers[0].count, nB: eco.rivers[1].count, transferred: ep.transferred };
      },
      seconds: 9,
    });
    const A = r.eco.rivers[0];
    const B = r.eco.rivers[1];
    const ep = r.eco.absorption.history.find((e) => e.phase === 'interrumpida');
    const rep = episodeReport(ep, r.sim.cfg);
    const transferredTotal = r.eco.absorption.transfers[1 * 8 + 0];
    const nA0 = r.eco.counts0[0];
    const nB0 = r.eco.counts0[1];
    // after the break nothing more moves from B to A
    const stopped = after && A.count === after.nA && B.count === after.nB;
    return {
      pass: massOK(r) && !!ep && rep.f >= 0.25 && rep.f < 0.8 && stopped && A.count === nA0 + transferredTotal && B.count === nB0 - transferredTotal && B.alive,
      metrics: { breakAt: broke, interruptedAt: after, ...rep, A_final: A.count, A_initial: nA0, B_final: B.count, B_initial: nB0, transferredParticles: transferredTotal, ...conservation(r) },
      criteria: 'episode ends as interrumpida with 0.25 ≤ f < 0.8; no transfer after the break; A = A0 + transferred and B = B0 − transferred exactly; B survives',
    };
  },

  /** 5 — opposing currents (head-on, R ≈ 2). */
  async r5_opposing(gl) {
    const out = await this._rate(gl, 'opposing');
    cache.opposing = out;
    return {
      pass: out.ok && out.phiDirMean >= 1.15 && out.f15 > 0,
      metrics: out,
      criteria: 'currents measured as opposed (φ_dir ≥ 1.15); progress after 1.5 s of fusion reported; mass exact',
    };
  },

  /** 6 — aligned currents (A catches B from behind, same direction, R ≈ 2): gentler than 5. */
  async r6_aligned(gl) {
    const al = await this._rate(gl, 'aligned');
    const op = cache.opposing ?? (await this._rate(gl, 'opposing'));
    return {
      pass: al.ok && al.phiDirMean <= 0.85 && al.f15 < op.f15,
      metrics: { aligned: al, opposingF15: op.f15, ratioOpposingToAligned: op.f15 / al.f15 },
      criteria: 'currents measured as aligned (φ_dir ≤ 0.85); less progress after 1.5 s than the opposing case; mass exact',
    };
  },

  async _rate(gl, kind) {
    let tF = null;
    let f15 = null;
    const phiD = [];
    const rivers =
      kind === 'opposing'
        ? [{ name: 'A', color: TURQ, at: [-3.6, 0], volume: 3 }, { name: 'B', color: CORAL, at: [3.6, 0], volume: 1.5 }]
        : [{ name: 'A', color: TURQ, at: [-9, 0], volume: 3 }, { name: 'B', color: CORAL, at: [-3.5, 0], volume: 1.5 }];
    const r = await scenario(gl, {
      rivers,
      domain: { min: [-12, 0, -5], max: [12, 3, 5] },
      steer: (eco, t) => {
        const [A, B] = eco.rivers;
        if (kind === 'opposing') {
          A.setInput(1, 0);
          B.setInput(-1, 0);
        } else {
          A.setInput(1, 0);
          B.setInput(0.55, 0);
        }
      },
      onFrame: (eco) => {
        const ep = [...eco.absorption.active.values()].find((e) => e.phase !== 'agarre');
        if (ep && tF === null) tF = eco.time;
        if (ep?.phi) phiD.push(ep.phi[2]);
        if (tF !== null && f15 === null && eco.time - tF >= 1.5) f15 = ep?.f ?? lastEpisode(eco)?.f ?? null;
      },
      until: (eco) => f15 !== null,
      seconds: 9,
    });
    const ep = episodeReport([...r.eco.absorption.active.values()][0] ?? lastEpisode(r.eco), r.sim.cfg);
    return { kind, ok: massOK(r), fusionStart: tF, f15, rate15KgPerS: f15 !== null ? (f15 * ep.massB0) / 1.5 : null, phiDirMean: phiD.reduce((a, b) => a + b, 0) / Math.max(phiD.length, 1), ...ep, ...conservation(r) };
  },

  /** 7 — conservation through everything: absorption, completion, remnants to free water, free water joining. */
  async r7_conservation(gl) {
    const r = await scenario(gl, {
      rivers: [
        { name: 'A', color: TURQ, at: [-4, 0], volume: 3.5 },
        { name: 'B', color: CORAL, at: [2.5, 0], volume: 1.0 },
        { name: 'C', color: GOLD, at: [6.5, 2], volume: 0.6 },
      ],
      neutral: [{ at: [-1, -2.6], volume: 0.3 }], // free water in A's way
      steer: (eco, t) => {
        const [A, B, C] = eco.rivers;
        const toward = (r, target, k) => {
          const dx = target.com[0] - r.com[0];
          const dz = target.com[2] - r.com[2];
          const l = Math.hypot(dx, dz) || 1;
          r.setInput((k * dx) / l, (k * dz) / l);
        };
        // A first sweeps through the free water, then hunts B, then C; B and C come to meet it
        const prey = B.count > 0 ? B : C;
        if (t < 1.4) A.setInput(0.6, -0.6);
        else if (prey.count > 0) toward(A, prey, 0.8);
        else A.setInput(0, 0);
        if (B.count > 0) toward(B, A, 0.4);
        if (C.count > 0) toward(C, A, t > 3 ? 0.4 : 0);
      },
      seconds: 14,
      until: (eco) => eco.rivers[1].count === 0 && eco.rivers[2].count === 0,
    });
    const eco = r.eco;
    const T = eco.absorption.transfers;
    const toFree = eco.rivers.reduce((a, _, k) => a + (k === NEUTRAL ? 0 : T[k * 8 + NEUTRAL]), 0);
    const fromFree = eco.rivers.reduce((a, _, k) => a + (k === NEUTRAL ? 0 : T[NEUTRAL * 8 + k]), 0);
    const events = eco.absorption.history.map((e) => ({ phase: e.phase, a: eco.rivers[e.a]?.name, b: eco.rivers[e.b]?.name, ...episodeReport(e, r.sim.cfg) }));
    return {
      pass: massOK(r) && eco.checks.maxF <= 1 && eco.checks.totalNow === eco.checks.total0 && events.some((e) => e.phase === 'completa') && fromFree > 0,
      metrics: {
        totalParticles0: eco.checks.total0,
        totalParticlesEnd: eco.checks.totalNow,
        massTotalKg: eco.checks.massTotal,
        perRiverEnd: eco.list.map((x) => ({ name: x.name, kg: x.mass, alive: x.alive })),
        freeWaterKg: eco.rivers[NEUTRAL].mass,
        particlesToFreeWater: toFree,
        particlesFromFreeWater: fromFree,
        events,
        ...conservation(r),
      },
      criteria: 'every frame: total particle count unchanged, every river N(t) − N(0) = Σ in − Σ out of the transfer matrix (0 particles of error), f ≤ 1, solver mass exact; the run must include at least one completed absorption and free water joining a river',
    };
  },

  /** 8 — visual identity: colours are distinct, change gradually, end as the policy says; dye conserved in physical mixing. */
  async r8_color(gl) {
    const runOne = async (policy) => {
      let maxJump = 0;
      let prev = null;
      let sumSigma0 = null;
      let sumSigmaEnd = null;
      let colours0 = null;
      const r = await scenario(gl, {
        ...headOn(3, 1.0),
        colorPolicy: policy,
        seconds: 9,
        onFrame: (eco) => {
          const A = eco.rivers[0];
          const B = eco.rivers[1];
          if (!colours0) colours0 = { A: [...A.meanSigma], B: [...B.meanSigma], baseA: A.sigma, baseB: B.sigma };
          // dye inventory of all water (Σσ over particles): conserved by advection + diffusion
          const tot = eco.rivers.reduce((s, x) => s + (x ? x.count * (x.meanSigma[0] + x.meanSigma[1] + x.meanSigma[2]) : 0), 0);
          if (sumSigma0 === null) sumSigma0 = tot;
          sumSigmaEnd = tot;
          // per-frame change of A's mean colour, relative to the colour distance between A and B
          const dAB = Math.hypot(...A.sigma.map((s, i) => s - B.sigma[i]));
          if (prev) maxJump = Math.max(maxJump, Math.hypot(...A.meanSigma.map((s, i) => s - prev[i])) / dAB);
          prev = [...A.meanSigma];
        },
      });
      const A = r.eco.rivers[0];
      const finalDist = Math.hypot(...A.meanSigma.map((s, i) => s - A.sigma[i])) / Math.hypot(...A.sigma);
      return { policy, ok: massOK(r), initialMatchesBase: colours0 && Math.hypot(...colours0.A.map((s, i) => s - colours0.baseA[i])) / Math.hypot(...colours0.baseA) < 0.01, maxColourJumpPerFrame: maxJump, finalDistanceToOwnColour: finalDist, dyeInventoryChange: (sumSigmaEnd - sumSigma0) / sumSigma0, completed: done(r.eco), ...conservation(r) };
    };
    const rec = await runOne('receptor');
    const mix = await runOne('mezcla');
    return {
      pass: rec.ok && mix.ok && rec.initialMatchesBase && rec.maxColourJumpPerFrame < 0.03 && rec.finalDistanceToOwnColour < 0.1 && Math.abs(mix.dyeInventoryChange) < 0.01,
      metrics: { receptor: rec, mezcla: mix },
      criteria: 'start: each river has its own colour (< 1 %); A\'s colour never jumps (< 3 % of the A–B colour distance per frame); receptor policy ends within 10 % of A\'s colour; physical mixing conserves the dye inventory (< 1 %)',
    };
  },

  /** 9 — several rivers: two absorbed at once (no double transfer), and a river being absorbed cannot absorb. */
  async r9_multiple(gl) {
    let chainViolations = 0;
    let simultaneous = 0;
    const r = await scenario(gl, {
      rivers: [
        { name: 'A', color: TURQ, at: [0, 0], volume: 5 },
        { name: 'B', color: CORAL, at: [-5.5, 0], volume: 1.0 },
        { name: 'C', color: GOLD, at: [5.5, 0], volume: 0.9 },
      ],
      steer: (eco, t) => {
        const [, B, C] = eco.rivers;
        B.setInput(t > 0.3 ? 0.7 : 0, 0);
        C.setInput(t > 0.3 ? -0.7 : 0, 0);
      },
      onFrame: (eco) => {
        const act = [...eco.absorption.active.values()].filter((e) => e.phase !== 'agarre');
        if (act.length >= 2) simultaneous++;
        // a river that is itself being absorbed must not gain from anyone it touches as absorber
        for (const e of act) if (eco.rivers[e.a].absorbedBy && eco.identity.P[e.b * 8 + e.a] > 0) chainViolations++;
      },
      seconds: 9,
      until: (eco) => eco.absorption.history.filter((e) => e.phase === 'completa').length >= 2,
    });
    const eco = r.eco;
    const T = eco.absorption.transfers;
    const gainA = eco.rivers[0].count - eco.counts0[0];
    const inA = T[1 * 8 + 0] + T[2 * 8 + 0] + T[NEUTRAL * 8 + 0] - T[0 * 8 + NEUTRAL];
    const eps = eco.absorption.history.filter((e) => e.phase !== 'rozadura').map((e) => ({ a: eco.rivers[e.a].name, b: eco.rivers[e.b].name, ...episodeReport(e, r.sim.cfg) }));
    return {
      pass: massOK(r) && simultaneous > 0 && chainViolations === 0 && gainA === inA && eco.checks.maxF <= 1,
      metrics: { framesWithTwoAbsorptions: simultaneous, chainViolations, gainA, transfersIntoA: inA, episodes: eps, ...conservation(r) },
      criteria: 'two absorptions at the same time; A gains exactly what the transfer matrix says; no transfer counted twice; f ≤ 1; mass exact',
    };
  },

  /** 10 — stability: the same absorption at different time steps and resolutions. */
  async r10_stability(gl) {
    const variants = [
      { spacing: 0.15, substeps: 2 },
      { spacing: 0.15, substeps: 3 },
      { spacing: 0.15, substeps: 4 },
      { spacing: 0.18, substeps: 3 },
      { spacing: 0.13, substeps: 3 },
    ];
    const runs = [];
    for (const v of variants) {
      const r = await scenario(gl, { ...headOn(3, 1.5), ...v, seconds: 12, until: done });
      const ep = episodeReport(lastEpisode(r.eco), r.sim.cfg);
      runs.push({ ...v, particles: r.eco.checks.total0, phase: ep?.phase, duration: ep?.duration, R0: ep?.massRatioR0, massTransferred: ep?.massTransferred, ok: massOK(r), speedClamps: r.m.speedClamps });
    }
    const d = runs.map((x) => x.duration).filter((x) => x != null);
    const meanD = d.reduce((a, b) => a + b, 0) / Math.max(d.length, 1);
    const spread = d.length ? (Math.max(...d) - Math.min(...d)) / meanD : Infinity;
    return {
      pass: runs.every((x) => x.ok && x.phase === 'completa') && spread < 0.25,
      metrics: { runs, durationMean: meanD, durationSpread: spread, nominalT: nominalDuration(2) },
      criteria: 'every run completes with exact mass and no losses; absorption duration varies < 25 % across dt and resolution',
    };
  },
};

export const RIVAL_TEST_NAMES = Object.keys(RIVAL_TESTS).filter((k) => !k.startsWith('_'));
