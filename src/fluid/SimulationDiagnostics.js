/**
 * SimulationDiagnostics — measurements, not impressions.
 *
 * Reads the solver state back to the CPU (synchronous: call it a few times per second at most,
 * never every frame in a shipped build) and reports:
 *   speeds (mean / max), kinetic and potential energy, centre of mass, density error,
 *   velocity divergence, vorticity, pressure, particles inside solids, speed clamps, NaN losses.
 * Penetration is checked with the JS mirror of the collision geometry, independently of the
 * GPU projection code.
 */
export class SimulationDiagnostics {
  constructor(sim) {
    this.sim = sim;
    const n = sim.L.TW * sim.L.TH * 4;
    this.posBuf = new Float32Array(n);
    this.velBuf = new Float32Array(n);
    this.fldBuf = new Float32Array(n);
    this.rawBuf = new Float32Array(n);
  }

  /** Raw arrays (sorted order: pos/vel/fields of index i belong to the same particle). */
  read() {
    const { gpu, solver } = this.sim;
    gpu.read(solver.position, this.posBuf);
    gpu.read(solver.velocity, this.velBuf);
    gpu.read(solver.fields, this.fldBuf);
    gpu.read(solver.rawV, this.rawBuf);
    return { pos: this.posBuf, vel: this.velBuf, fields: this.fldBuf, raw: this.rawBuf };
  }

  compute() {
    const sim = this.sim;
    const { cfg, collision } = sim;
    const { pos, vel, fields, raw } = this.read();
    const N = sim.L.TW * sim.L.TH;
    const m = cfg.mass;
    const g = -cfg.gravity[1];
    const floor = collision.domain.min[1];
    let active = 0;
    let lost = 0;
    let ke = 0;
    let pe = 0;
    let vmax = 0;
    let vsum = 0;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let cvx = 0;
    let cvy = 0;
    let cvz = 0;
    let inside = 0;
    let outside = 0;
    let clamps = 0;
    let rhoErrSum = 0;
    let rhoErrMax = 0;
    let compressed = 0;
    let divAbs = 0;
    let vortMax = 0;
    let vortSum = 0;
    let foamSum = 0;
    const tol = -0.25 * cfg.particleRadius;
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      const w = pos[o + 3];
      if (w === -2) {
        lost++;
        continue;
      }
      if (w < 0) continue;
      const x = pos[o];
      const y = pos[o + 1];
      const z = pos[o + 2];
      if (!Number.isFinite(x + y + z)) {
        lost++;
        continue;
      }
      active++;
      const vx = vel[o];
      const vy = vel[o + 1];
      const vz = vel[o + 2];
      const s2 = vx * vx + vy * vy + vz * vz;
      const s = Math.sqrt(s2);
      vsum += s;
      if (s > vmax) vmax = s;
      ke += 0.5 * m * s2;
      pe += m * g * (y - floor);
      cx += x;
      cy += y;
      cz += z;
      cvx += vx;
      cvy += vy;
      cvz += vz;
      if (collision.obstacleDistance(x, y, z) < tol) inside++;
      if (collision.wallDistance(x, y, z) < tol) outside++;
      const rho = fields[o + 1];
      if (rho > 0) {
        const e = rho / cfg.density - 1;
        if (e > 0) {
          rhoErrSum += e;
          compressed++;
          if (e > rhoErrMax) rhoErrMax = e;
        }
      }
      divAbs += Math.abs(fields[o]);
      if (raw[o + 3] > 0.5) clamps++;
      foamSum += vel[o + 3];
      const vort = fields[o + 3];
      vortSum += vort;
      if (vort > vortMax) vortMax = vort;
    }
    const n = Math.max(active, 1);
    const acct = sim.accounting.evaluate(active, lost);
    return {
      time: sim.time,
      steps: sim.steps,
      active,
      lost,
      ...acct,
      speedMean: vsum / n,
      speedMax: vmax,
      kinetic: ke,
      potential: pe,
      energy: ke + pe,
      com: [cx / n, cy / n, cz / n],
      comVel: [cvx / n, cvy / n, cvz / n],
      densityErrorMean: compressed ? rhoErrSum / n : 0, // mean over ALL particles of max(ρ/ρ0−1, 0)
      densityErrorMax: rhoErrMax,
      divergenceMean: divAbs / n, // 1/s
      vorticityMean: vortSum / n,
      vorticityMax: vortMax,
      foamFraction: foamSum / n,
      insideSolids: inside,
      outsideDomain: outside,
      speedClamps: clamps,
    };
  }
}
