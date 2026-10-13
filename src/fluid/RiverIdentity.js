import { header, neighbours } from './gpu/glsl.js';
import { MAX_OWNERS } from './FluidSolver.js';

const K = MAX_OWNERS;
export const NEUTRAL = K - 1; // owner slot of free water that belongs to no river

/**
 * RiverIdentity — which river every particle of water belongs to, measured on the GPU.
 *
 * The water is ONE fluid in ONE solver. A river is the set of particles carrying its owner index
 * (identity texture, FluidSolver.id). This class runs once per frame, after the solver step:
 *
 *   identity pass   per particle, over its real neighbours (distance < h, same exact neighbour
 *                   search as the solver):
 *                     - CONTACT: foreign neighbours per river, mean |v_j − v_i| with them,
 *                       same-river neighbours (a particle with few of them is a droplet / spray)
 *                     - TRANSFER (game rule, see AbsorptionSystem): a particle of river B with at
 *                       least `minForeign` neighbours of river A changes owner to A with the
 *                       probability P[B][A] decided on the CPU. Only particles AT the contact
 *                       front can change owner: the absorption is local and advances as a front.
 *                       Nothing moves, nothing is created: the particle keeps its mass, position
 *                       and velocity. Mass is conserved by construction.
 *                     - DYE: the absorbance σ (visual colour) is carried by the particle
 *                       (Lagrangian advection = exact) and diffuses between neighbours with
 *                       coefficient D (m²/s), SPH Laplacian (Brookshaw 1985), pairwise symmetric
 *                       so Σσ·V is conserved; optionally it relaxes to the owner's base colour
 *                       (colour policy, a visual rule).
 *   stats scatter   per river: Σx, Σv, Σ|v|², Σ(x²+z²), Σσ, count (additive float blending)
 *   contact scatter 8×8 matrix: [river i][river j] = particles of i touching j (not droplets),
 *                   Σ|u_rel|, Σ foreign-neighbour count, and (a) every particle of i touching j
 *   transfer scatter 8×8 CUMULATIVE matrix: [from][to] = particles that changed owner. Exact
 *                   integer counts: the books of every absorption come from here.
 *
 * Needs EXT_float_blend (additive float targets), like the sink counter.
 */
export class RiverIdentity {
  constructor(sim) {
    this.sim = sim;
    this.gpu = sim.gpu;
    const gpu = this.gpu;
    const L = sim.L;
    if (!gpu.floatBlend) throw new Error('Rivals need EXT_float_blend (exact per-river counts on the GPU)');
    this.contactTex = gpu.texture(L.TW, L.TH);
    this.stats = [gpu.texture(K, 1), gpu.texture(K, 1), gpu.texture(K, 1), gpu.texture(K, 1)];
    this.contactM = gpu.texture(K, K);
    this.transferM = gpu.texture(K, K);
    gpu.clear([this.transferM]);
    this.P = new Float32Array(K * K); // conversion probability per frame, [victim * K + absorber]
    this.release = new Float32Array(K); // 1 = every particle of this river becomes neutral water
    this.base = new Float32Array(K * 4); // base absorbance of each river (rgb), a = 1: relax to it
    this.params = { diffusion: 0.004, relax: 0.6, minForeign: 2, minSame: 3 };
    this.frame = 0;
    this.out = {
      s0: new Float32Array(K * 4),
      s1: new Float32Array(K * 4),
      s2: new Float32Array(K * 4),
      s3: new Float32Array(K * 4),
      contact: new Float32Array(K * K * 4),
      transfer: new Float32Array(K * K * 4),
    };
    this.build();
  }

  build() {
    const { gpu } = this;
    const L = this.sim.L;
    const H = header(L);
    this.identityProg = gpu.program(
      'identity',
      `${H}
#define K ${K}
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform sampler2D uId;
uniform sampler2D uCells;
uniform float uH;
uniform float uH2;
uniform float uSpiky;
uniform float uVol;
uniform float uDt;
uniform float uDiff;
uniform float uRelaxK;
uniform float uP[K * K];
uniform float uRelease[K];
uniform vec4 uBase[K];
uniform int uFrame;
uniform float uMinForeign;
layout(location = 0) out vec4 oId;
layout(location = 1) out vec4 oC;
uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float rnd(uint a, uint b) { return float(pcg(a ^ pcg(b))) * (1.0 / 4294967296.0); }
void main() {
  int i = fragIndex();
  vec4 Pi = texelFetch(uPos, tc(i), 0);
  vec4 Ii = texelFetch(uId, tc(i), 0);
  if (Pi.w < 0.0) { oId = Ii; oC = vec4(-1.0, 0.0, 0.0, 0.0); return; }
  vec3 Vi = texelFetch(uVel, tc(i), 0).xyz;
  int own = clamp(int(Ii.a + 0.5), 0, K - 1);
  float cnt[K];
  float ur[K];
  for (int k = 0; k < K; k++) { cnt[k] = 0.0; ur[k] = 0.0; }
  float same = 0.0;
  vec3 lap = vec3(0.0);
  ${neighbours(
    'Pi.xyz',
    `if (j == i) continue;
      vec3 r = Pi.xyz - texelFetch(uPos, tc(j), 0).xyz;
      float r2 = dot(r, r);
      if (r2 < uH2 && r2 > 1e-12) {
        vec4 Ij = texelFetch(uId, tc(j), 0);
        int oj = clamp(int(Ij.a + 0.5), 0, K - 1);
        if (oj == own) same += 1.0;
        else {
          cnt[oj] += 1.0;
          ur[oj] += length(texelFetch(uVel, tc(j), 0).xyz - Vi);
        }
        float rl = sqrt(r2);
        float hr = uH - rl;
        lap += (Ij.rgb - Ii.rgb) * (-uSpiky * hr * hr / rl); // Brookshaw: 2 Σ V (σj−σi) |∇W|/r
      }`,
  )}
  lap *= 2.0 * uVol;
  int co = -1;
  float best = 0.0;
  for (int k = 0; k < K; k++) if (k != own && cnt[k] > best) { best = cnt[k]; co = k; }
  int newOwn = own;
  if (uRelease[own] > 0.5) {
    newOwn = K - 1;
  } else if (co >= 0 && best >= uMinForeign) {
    uint pid = uint(Pi.w);
    // the river touching it most first, then any other river it touches
    if (rnd(pid, uint(uFrame) * 16u) < uP[own * K + co]) newOwn = co;
    else for (int k = 0; k < K; k++) {
      if (k == own || k == co || cnt[k] < uMinForeign) continue;
      if (rnd(pid, uint(uFrame) * 16u + uint(k) + 1u) < uP[own * K + k]) { newOwn = k; break; }
    }
  }
  vec3 s = max(Ii.rgb + uDt * uDiff * lap, vec3(0.0));
  if (uBase[newOwn].a > 0.5) s += (uBase[newOwn].rgb - s) * uRelaxK;
  oId = vec4(s, float(newOwn));
  oC = vec4(float(co), best > 0.0 ? ur[co] / best : 0.0, best, same);
}`,
    );

    const point = (x, y, w, h) => `gl_Position = vec4((vec2(${x}, ${y}) + 0.5) / vec2(${w}.0, ${h}.0) * 2.0 - 1.0, 0.0, 1.0);`;
    const OFF = 'gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return;';

    this.statsProg = gpu.program(
      'riverStats',
      `${H}
flat in vec4 v0;
flat in vec4 v1;
flat in vec4 v2;
flat in vec4 v3;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
void main() { o0 = v0; o1 = v1; o2 = v2; o3 = v3; }`,
      `${header(L, { vertex: true })}
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform sampler2D uId;
flat out vec4 v0;
flat out vec4 v1;
flat out vec4 v2;
flat out vec4 v3;
void main() {
  gl_PointSize = 1.0;
  vec4 P = texelFetch(uPos, tc(gl_VertexID), 0);
  if (P.w < 0.0) { ${OFF} }
  vec4 V = texelFetch(uVel, tc(gl_VertexID), 0);
  vec4 I = texelFetch(uId, tc(gl_VertexID), 0);
  int own = clamp(int(I.a + 0.5), 0, ${K - 1});
  v0 = vec4(P.xyz, 1.0);
  v1 = vec4(V.xyz, dot(V.xyz, V.xyz));
  v2 = vec4(P.x * P.x + P.z * P.z, P.y * P.y, V.w, 0.0);
  v3 = vec4(I.rgb, 0.0);
  ${point('float(own)', '0.0', K, 1)}
}`,
    );

    this.contactProg = gpu.program(
      'riverContact',
      `${H}
flat in vec4 v0;
out vec4 o;
void main() { o = v0; }`,
      `${header(L, { vertex: true })}
uniform sampler2D uPos;
uniform sampler2D uId;
uniform sampler2D uContact;
uniform float uMinForeign;
uniform float uMinSame;
flat out vec4 v0;
void main() {
  gl_PointSize = 1.0;
  vec4 P = texelFetch(uPos, tc(gl_VertexID), 0);
  vec4 C = texelFetch(uContact, tc(gl_VertexID), 0);
  if (P.w < 0.0 || C.x < 0.0 || C.z < uMinForeign) { ${OFF} }
  // owner BEFORE this frame's transfers: who was touching whom
  int own = clamp(int(texelFetch(uId, tc(gl_VertexID), 0).a + 0.5), 0, ${K - 1});
  // r, g, b: body particles only (droplets and spray excluded); a: every contact particle
  float body = C.w >= uMinSame ? 1.0 : 0.0;
  v0 = vec4(body, C.y * body, C.z * body, 1.0);
  ${point('C.x', 'float(own)', K, K)}
}`,
    );

    this.transferProg = gpu.program(
      'riverTransfer',
      `${H}
out vec4 o;
void main() { o = vec4(1.0, 0.0, 0.0, 0.0); }`,
      `${header(L, { vertex: true })}
uniform sampler2D uPos;
uniform sampler2D uIdOld;
uniform sampler2D uIdNew;
void main() {
  gl_PointSize = 1.0;
  vec4 P = texelFetch(uPos, tc(gl_VertexID), 0);
  int a = int(texelFetch(uIdOld, tc(gl_VertexID), 0).a + 0.5);
  int b = int(texelFetch(uIdNew, tc(gl_VertexID), 0).a + 0.5);
  if (P.w < 0.0 || a == b) { ${OFF} }
  ${point('float(b)', 'float(a)', K, K)}
}`,
    );
  }

  scatter(prog, targets, uniforms, clear) {
    const { gpu } = this;
    const gl = gpu.gl;
    if (clear) gpu.clear(targets);
    gpu.begin(gpu.target(targets));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.blendEquation(gl.FUNC_ADD);
    gpu.use(prog, uniforms);
    gl.drawArrays(gl.POINTS, 0, this.sim.L.TW * this.sim.L.TH);
    gl.disable(gl.BLEND);
  }

  /** Only the per-river statistics (no transfer): used once after filling. */
  measure() {
    const s = this.sim.solver;
    this.scatter(this.statsProg, this.stats, { uPos: s.position, uVel: s.velocity, uId: s.identity }, true);
    return this.readStats();
  }

  /**
   * One frame of identity: contact, transfers (with the probabilities in this.P / this.release),
   * dye, statistics. Synchronous readback of 4 tiny textures (8×1, 8×8).
   */
  update(dt) {
    const sim = this.sim;
    const s = sim.solver;
    const cfg = sim.cfg;
    const p = this.params;
    if (!s.lastCells) return this.measure();
    const gpu = this.gpu;
    const idOld = s.id[s.idCur];
    const idNew = s.id[1 - s.idCur];
    gpu.pass(this.identityProg, [idNew, this.contactTex], {
      uGridMin: sim.L.gridMin,
      uCell: sim.L.cell,
      uPos: s.position,
      uVel: s.velocity,
      uId: idOld,
      uCells: s.lastCells,
      uH: cfg.h,
      uH2: cfg.kernel.h2,
      uSpiky: cfg.kernel.spikyGrad,
      uVol: cfg.volume,
      uDt: dt,
      uDiff: p.diffusion,
      uRelaxK: 1 - Math.exp(-p.relax * dt),
      uP: this.P,
      uRelease: this.release,
      uBase: this.base,
      uFrame: this.frame++,
      uMinForeign: p.minForeign,
    });
    this.scatter(this.contactProg, [this.contactM], { uPos: s.position, uId: idOld, uContact: this.contactTex, uMinForeign: p.minForeign, uMinSame: p.minSame }, true);
    this.scatter(this.transferProg, [this.transferM], { uPos: s.position, uIdOld: idOld, uIdNew: idNew }, false);
    s.idCur = 1 - s.idCur;
    this.scatter(this.statsProg, this.stats, { uPos: s.position, uVel: s.velocity, uId: idNew }, true);
    const out = this.readStats();
    gpu.read(this.contactM, out.contact);
    gpu.read(this.transferM, out.transfer);
    return out;
  }

  readStats() {
    const o = this.out;
    this.gpu.read(this.stats[0], o.s0);
    this.gpu.read(this.stats[1], o.s1);
    this.gpu.read(this.stats[2], o.s2);
    this.gpu.read(this.stats[3], o.s3);
    return o;
  }

  resetTransfers() {
    this.gpu.clear([this.transferM]);
    this.out.transfer.fill(0);
  }
}
