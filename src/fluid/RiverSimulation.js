import { GPU } from './gpu/GPU.js';
import { header } from './gpu/glsl.js';
import { resolveConfig } from './FluidProperties.js';
import { FluidCollision } from './FluidCollision.js';
import { FluidSolver } from './FluidSolver.js';
import { RiverMassAccounting } from './RiverMassAccounting.js';
import { SimulationDiagnostics } from './SimulationDiagnostics.js';

/**
 * RiverSimulation — the coordinator. Owns the configuration, the solids, the solver, the
 * boundary conditions (sources and sinks) and the mass books, and advances them together.
 *
 *   const sim = new RiverSimulation(gl, { capacity: 16384, domain, obstacles, config });
 *   sim.fillBlock({ min, max, velocity });
 *   sim.step(1 / 60);                // runs cfg.substeps solver substeps
 *   sim.diagnostics.compute();       // measurements (CPU readback)
 *
 * Capacity is fixed at construction (GPU textures); unused slots are inactive particles.
 * Shares the WebGL2 context with three.js when given `renderer.getContext()`: call
 * `renderer.resetState()` after `step()`.
 */
export class RiverSimulation {
  constructor(gl, { capacity = 16384, domain, obstacles = {}, config = {} } = {}) {
    if ((capacity & (capacity - 1)) !== 0) throw new Error('[fluid] capacity must be a power of two');
    this.gl = gl;
    this.cfg = resolveConfig(config);
    const cfg = this.cfg;
    const TW = 2 ** Math.ceil(Math.log2(capacity) / 2);
    const TH = capacity / TW;
    const cell = cfg.h;
    const GX = Math.max(1, Math.ceil((domain.max[0] - domain.min[0]) / cell));
    const GY = Math.max(1, Math.ceil((domain.max[1] - domain.min[1]) / cell));
    const GZ = Math.max(1, Math.ceil((domain.max[2] - domain.min[2]) / cell));
    const cells = GX * GY * GZ;
    const CTW = Math.min(2048, 2 ** Math.ceil(Math.log2(Math.sqrt(cells))));
    const CTH = Math.ceil(cells / CTW);
    if (CTH > 8192) throw new Error(`[fluid] domain too large for h = ${cfg.h.toFixed(3)} m (${cells} cells)`);
    this.L = { TW, TH, GX, GY, GZ, CTW, CTH, cell, gridMin: [...domain.min], capacity };

    this.gpu = new GPU(gl);
    this.collision = new FluidCollision(domain, obstacles);
    this.solver = new FluidSolver(this.gpu, this.L, cfg, this.collision);
    this.accounting = new RiverMassAccounting(cfg.mass, cfg.volume);
    this.diagnostics = new SimulationDiagnostics(this);
    this.sources = [];
    this.sink = null;
    this.control = null; // { accel:[ax,ay,az,radius], center:[x,y,z,on] } — set by RiverController
    this.time = 0;
    this.steps = 0;
    this.nActiveBound = 0; // upper bound of active particles (exact when there are no sinks)
    this.buildSinkCounter();
  }

  // --- initial conditions ---------------------------------------------------------------------

  /**
   * Fill boxes with water on a regular lattice at rest density. Tiny deterministic jitter breaks
   * the perfect symmetry of the lattice (a perfect lattice is an unstable equilibrium).
   * A block may belong to a river: `owner` (identity slot) and `dye` (absorbance σ, 1/m, visual).
   * Block shapes: a box (min/max) or, with `radius`, the part of the box inside a vertical cylinder.
   * @param {{min:number[],max:number[],velocity?:number[],owner?:number,dye?:number[],radius?:number}[]} blocks
   */
  fill(blocks) {
    const { TW, TH } = this.L;
    const N = TW * TH;
    const d = this.cfg.spacing;
    const pos = new Float32Array(N * 4);
    const vel = new Float32Array(N * 4);
    const id = new Float32Array(N * 4);
    this.blockCounts = [];
    let n = 0;
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 0.02 * d;
    for (const b of blocks) {
      const v = b.velocity ?? [0, 0, 0];
      const dye = b.dye ?? [0, 0, 0];
      const owner = b.owner ?? 0;
      const cx = (b.min[0] + b.max[0]) / 2;
      const cz = (b.min[2] + b.max[2]) / 2;
      const n0 = n;
      for (let z = b.min[2] + d / 2; z < b.max[2]; z += d) {
        for (let y = b.min[1] + d / 2; y < b.max[1]; y += d) {
          for (let x = b.min[0] + d / 2; x < b.max[0]; x += d) {
            if (b.radius && Math.hypot(x - cx, z - cz) > b.radius) continue;
            if (this.collision.obstacleDistance(x, y, z) < this.cfg.particleRadius) continue;
            if (n >= N) throw new Error(`[fluid] capacity ${N} exceeded while filling`);
            pos.set([x + rnd(), y + rnd(), z + rnd(), n], n * 4);
            vel.set([v[0], v[1], v[2], 0], n * 4);
            id.set([dye[0], dye[1], dye[2], owner], n * 4);
            n++;
          }
        }
      }
      this.blockCounts.push(n - n0);
    }
    for (let i = n; i < N; i++) pos.set([0, -1e4, 0, -1], i * 4);
    const s = this.solver;
    this.gpu.upload(s.pos[s.cur], pos);
    this.gpu.upload(s.vel[s.cur], vel);
    this.gpu.upload(s.id[s.idCur], id);
    this.accounting.reset(n);
    this.nActiveBound = n;
    this.time = 0;
    this.steps = 0;
    if (this.sinkCount) this.gpu.clear([this.sinkCount]);
    return n;
  }

  // --- boundary conditions --------------------------------------------------------------------

  /**
   * A source: a disc of radius `radius` at `center`, pouring along unit `dir` at `speed` m/s.
   * Volumetric flow Q = A · v (A = πr²) is honoured by emitting one lattice layer every time the
   * water has advanced one spacing. Every particle is booked as inflow.
   */
  addSource({ center, dir, radius, speed, owner = 0, dye = [0, 0, 0] }) {
    const l = Math.hypot(...dir);
    const src = { center: [...center], dir: dir.map((x) => x / l), radius, speed, travelled: 0, on: true, owner, dye: [...dye] };
    // the disc lattice, built once
    const d = this.cfg.spacing;
    const [ux, uy, uz] = Math.abs(src.dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    // a = normalize(up × dir), b = dir × a
    let ax = uy * src.dir[2] - uz * src.dir[1];
    let ay = uz * src.dir[0] - ux * src.dir[2];
    let az = ux * src.dir[1] - uy * src.dir[0];
    const al = Math.hypot(ax, ay, az);
    ax /= al;
    ay /= al;
    az /= al;
    const bx = src.dir[1] * az - src.dir[2] * ay;
    const by = src.dir[2] * ax - src.dir[0] * az;
    const bz = src.dir[0] * ay - src.dir[1] * ax;
    src.layer = [];
    for (let j = -radius; j <= radius; j += d) {
      for (let i = -radius; i <= radius; i += d) {
        if (i * i + j * j > radius * radius) continue;
        src.layer.push([center[0] + ax * i + bx * j, center[1] + ay * i + by * j, center[2] + az * i + bz * j]);
      }
    }
    src.flow = src.layer.length * this.cfg.volume * (speed / d); // m³/s actually delivered
    this.sources.push(src);
    return src;
  }

  /** A sink: an axis-aligned box; water entering it leaves the domain and is booked as outflow. */
  setSink(min, max) {
    if (!this.gpu.floatBlend) console.warn('[fluid] EXT_float_blend missing: sink outflow cannot be counted exactly');
    this.sink = { min: [...min], max: [...max] };
  }

  buildSinkCounter() {
    const gpu = this.gpu;
    this.sinkCount = gpu.texture(1, 1);
    gpu.clear([this.sinkCount]);
    this.sinkProg = gpu.program(
      'sinkCount',
      `${header(this.L)}
out vec4 o;
void main() { o = vec4(1.0); }`,
      `${header(this.L, { vertex: true })}
uniform sampler2D uPos;
uniform vec3 uSinkMin;
uniform vec3 uSinkMax;
void main() {
  vec4 P = texelFetch(uPos, tc(gl_VertexID), 0);
  gl_PointSize = 1.0;
  bool inSink = P.w >= 0.0 && all(greaterThanEqual(P.xyz, uSinkMin)) && all(lessThanEqual(P.xyz, uSinkMax));
  gl_Position = inSink ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`,
    );
  }

  countSink() {
    const { gpu, gl } = this;
    gpu.begin(gpu.target([this.sinkCount]));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.blendEquation(gl.FUNC_ADD);
    gpu.use(this.sinkProg, { uPos: this.solver.position, uSinkMin: this.sink.min, uSinkMax: this.sink.max });
    gl.drawArrays(gl.POINTS, 0, this.L.TW * this.L.TH);
    gl.disable(gl.BLEND);
  }

  emit(src, dt) {
    src.travelled += src.speed * dt;
    const d = this.cfg.spacing;
    if (src.travelled < d) return;
    src.travelled -= d;
    const k = src.layer.length;
    const { TW, TH } = this.L;
    const N = TW * TH;
    if (this.nActiveBound + k > N) {
      this.refreshBound();
      if (this.nActiveBound + k > N) {
        src.starved = (src.starved ?? 0) + 1; // capacity reached: nothing emitted, nothing booked
        return;
      }
    }
    // inactive particles sort last, so [N−k, N) is free whenever nActive ≤ N − k
    const pos = new Float32Array(k * 4);
    const vel = new Float32Array(k * 4);
    const id = new Float32Array(k * 4);
    const off = src.travelled; // sub-step placement keeps layers evenly spaced
    for (let i = 0; i < k; i++) {
      const p = src.layer[i];
      pos.set([p[0] + src.dir[0] * off, p[1] + src.dir[1] * off, p[2] + src.dir[2] * off, this.nextId++], i * 4);
      vel.set([src.dir[0] * src.speed, src.dir[1] * src.speed, src.dir[2] * src.speed, 0], i * 4);
      id.set([src.dye[0], src.dye[1], src.dye[2], src.owner], i * 4);
    }
    this.writeTail(pos, vel, k, id);
    this.accounting.addInflow(k);
    this.nActiveBound += k;
  }

  /** Write k particles into the last k texels (row-major), in at most two rectangles. */
  writeTail(pos, vel, k, id) {
    const { TW, TH } = this.L;
    const s = this.solver;
    const start = TW * TH - k;
    const y0 = Math.floor(start / TW);
    const x0 = start % TW;
    let o = 0;
    if (x0 > 0) {
      const w = TW - x0;
      this.gpu.upload(s.pos[s.cur], pos.subarray(0, w * 4), x0, y0, w, 1);
      this.gpu.upload(s.vel[s.cur], vel.subarray(0, w * 4), x0, y0, w, 1);
      this.gpu.upload(s.id[s.idCur], id.subarray(0, w * 4), x0, y0, w, 1);
      o = w;
    }
    const rows = (k - o) / TW;
    if (rows > 0) {
      const y = TH - rows;
      this.gpu.upload(s.pos[s.cur], pos.subarray(o * 4), 0, y, TW, rows);
      this.gpu.upload(s.vel[s.cur], vel.subarray(o * 4), 0, y, TW, rows);
      this.gpu.upload(s.id[s.idCur], id.subarray(o * 4), 0, y, TW, rows);
    }
  }

  /** Refresh the active-particle bound from the sink counter (one 1-texel readback). */
  refreshBound() {
    if (!this.sink) return;
    const out = this.gpu.read(this.sinkCount);
    this.accounting.setOutflow(Math.round(out[0]));
    this.nActiveBound = this.accounting.initial + this.accounting.inflow - this.accounting.outflow;
  }

  // --- time stepping --------------------------------------------------------------------------

  step(frameDt) {
    const n = this.cfg.substeps;
    const dt = frameDt / n;
    this.nextId ??= this.accounting.initial;
    for (let i = 0; i < n; i++) {
      for (const src of this.sources) if (src.on) this.emit(src, dt);
      if (this.sink) this.countSink();
      this.solver.substep(dt, this.control, this.sink);
      this.time += dt;
      this.steps++;
    }
  }

  /** Measurements (synchronous readback). */
  measure() {
    if (this.sink) this.refreshBound();
    return this.diagnostics.compute();
  }

  /** Render-only ellipsoids for the surface reconstruction (see FluidSolver.anisotropy). */
  anisotropy(splatRadius, opts) {
    return this.solver.anisotropy(splatRadius, opts);
  }

  get position() {
    return this.solver.position;
  }

  get velocity() {
    return this.solver.velocity;
  }

  /** Identity texture: rgb dye absorbance, a owner river (same order as position/velocity). */
  get identity() {
    return this.solver.identity;
  }
}
