import { header, neighbours } from './gpu/glsl.js';
import { SpatialHash } from './SpatialHash.js';

/** Rivers that can share one solver (owner slots in the identity texture; the last is "neutral"). */
export const MAX_OWNERS = 8;

/**
 * FluidSolver — Position Based Fluids (Macklin & Müller 2013) on the GPU, WebGL2.
 *
 * One substep:
 *   predict    v* = v + (g + a_ext)·dt,  p* = collide(x + v*·dt)          (explicit forces)
 *   neighbours hash + bitonic sort + cell table                           (SpatialHash)
 *   reorder    gather x, p*, v into sorted order (coherent memory, IDs ride in .w)
 *   × iters    λ_i = −C_i / (Σ_k |∇_k C_i|² + ε),  C_i = max(ρ_i/ρ0 − 1, 0)
 *              Δp_i = (1/ρ0) Σ_j m (λ_i + λ_j + s_corr) ∇W_ij,  p* = collide(p* + Δp_i)
 *   velocity   v = (p* − x)/dt, contact: no velocity into a solid + bed drag
 *   xsph       v_i += c Σ_j V_j (v_j − v_i) W_ij; also ∇·v, ∇×v and a pressure estimate
 *
 * The constraint is UNILATERAL (only compression is corrected): particles at the free surface
 * are under-dense by nature, and pulling them together would be a fake surface tension.
 *
 * Pressure estimate: matching the PBF correction with the symmetric SPH pressure force gives
 * p_i ≈ −ρ0 Σ_iters λ_i / dt². It is a diagnostic (hydrostatic test), the solver never uses it.
 */
export class FluidSolver {
  constructor(gpu, L, cfg, collision) {
    this.gpu = gpu;
    this.L = L;
    this.cfg = cfg;
    this.collision = collision;
    this.hash = new SpatialHash(gpu, L);
    const T = () => gpu.texture(L.TW, L.TH);
    this.pos = [T(), T()];
    this.vel = [T(), T()];
    this.cur = 0;
    this.pred = T();
    this.sX = T();
    this.sV = T();
    this.sP = [T(), T()];
    this.lam = [T(), T()];
    this.rawV = T();
    this.fields = T(); // ∇·v, ρ, p, |ω|
    this.aniso = [T(), T(), T()]; // render-only: ellipsoid axis 1 + scale, axis 2 + scale, smoothed centre + scale 3
    // IDENTITY (rivers): rgb = dye absorbance σ (1/m, visual), a = owner river index (0..MAX_OWNERS−1).
    // Created zeroed (owner 0, no dye): without rivers nothing reads it and nothing changes.
    // It is permuted with the particles every substep, so index i is always the same particle in
    // pos / vel / id. Ping-pong index `idCur` (independent of `cur`).
    this.id = [T(), T()];
    this.idCur = 0;
    // per-river force data, MAX_OWNERS × 3 texels (a texture, not uniforms: the collision geometry
    // already uses ~190 of the 224 fragment uniform vectors WebGL2 guarantees)
    this.ownerTex = gpu.texture(MAX_OWNERS, 3);
    this.ownersOn = false;
    this.buildPrograms();
  }

  buildPrograms() {
    const { gpu, L } = this;
    const H = header(L);
    const KERNEL = /* glsl */ `
uniform float uMass;
uniform float uRho0;
uniform float uPoly6;
uniform float uSpiky;
uniform float uH;
uniform float uH2;
uniform sampler2D uCells;`;

    // solids as virtual particles (FluidProperties: boundaryTable). xyz = ∇ρ_b, w = ρ_b
    const BOUNDARY = /* glsl */ `
#define BN ${this.cfg.boundaryTable.samples}
uniform float uRhoB[BN];
uniform float uDRhoB[BN];
void wallTerm(float delta, vec3 n, inout vec4 acc) {
  if (delta >= uH) return;
  float x = clamp(delta / uH, 0.0, 1.0) * float(BN - 1);
  int k = min(int(floor(x)), BN - 2);
  float f = x - float(k);
  acc.w += mix(uRhoB[k], uRhoB[k + 1], f);
  acc.xyz += mix(uDRhoB[k], uDRhoB[k + 1], f) * n;
}
vec4 boundary(vec3 p) {
  vec4 acc = vec4(0.0);
  wallTerm(p.y - uDomMin.y, vec3(0.0, 1.0, 0.0), acc);
  wallTerm(uDomMax.y - p.y, vec3(0.0, -1.0, 0.0), acc);
  wallTerm(p.x - uDomMin.x, vec3(1.0, 0.0, 0.0), acc);
  wallTerm(uDomMax.x - p.x, vec3(-1.0, 0.0, 0.0), acc);
  wallTerm(p.z - uDomMin.z, vec3(0.0, 0.0, 1.0), acc);
  wallTerm(uDomMax.z - p.z, vec3(0.0, 0.0, -1.0), acc);
  vec4 o = obstacle(p);
  wallTerm(o.w, o.xyz, acc);
  return acc;
}`;

    this.predictProg = gpu.program(
      'predict',
      `${H}
${this.collision.glsl}
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform float uDt;
uniform vec3 uGravity;
uniform vec4 uCtrlA;   // xyz: commanded acceleration (m/s²); w: radius of influence (≤0: everywhere)
uniform vec4 uCtrlC;   // xyz: centre of influence; w: 1 = on
uniform vec3 uSinkMin;
uniform vec3 uSinkMax;
// PER-RIVER FORCES (RiverEcosystem). uOwners = 0: off, the solver is exactly the single-body one.
// uOwnerTex, texel (k, row):
//   row 0 .xyz  steering acceleration of river k (m/s², player input or AI)  — external, booked
//   row 0 .w    body cohesion stiffness κ (1/s²)                            — GAME RULE
//   row 1 .xyz  centre of mass of river k (last measurement), .w cohesion cap (m/s²)
//   row 2 .xyz  mean velocity of river k, .w internal damping c (1/s)          — GAME RULE
// Cohesion κ(C−x)·(horizontal) and damping −c(v−v̄) are INTERNAL to a river: summed over its
// particles they vanish (Σ(C−x_i) = 0, Σ(v_i−v̄) = 0), so they do not move the river's centre of
// mass; they only keep it a body. Exact only with the current C and v̄: here they lag one frame.
uniform int uOwners;
uniform sampler2D uOwnerTex;
uniform sampler2D uId;
out vec4 o;
vec3 controlAccel(vec3 p) {
  if (uCtrlC.w < 0.5) return vec3(0.0);
  if (uCtrlA.w <= 0.0) return uCtrlA.xyz;
  float d = length((p - uCtrlC.xyz).xz);
  return uCtrlA.xyz * (1.0 - smoothstep(uCtrlA.w * 0.6, uCtrlA.w, d));
}
vec3 ownerAccel(int i, vec3 p, vec3 v) {
  if (uOwners == 0) return vec3(0.0);
  int k = clamp(int(texelFetch(uId, tc(i), 0).a + 0.5), 0, ${MAX_OWNERS - 1});
  vec4 A = texelFetch(uOwnerTex, ivec2(k, 0), 0);
  vec4 C = texelFetch(uOwnerTex, ivec2(k, 1), 0);
  vec4 Vm = texelFetch(uOwnerTex, ivec2(k, 2), 0);
  vec3 d = C.xyz - p;
  d.y = 0.0;
  vec3 coh = A.w * d;
  float l = length(coh);
  if (l > C.w) coh *= C.w / l;
  vec3 dv = v - Vm.xyz;
  dv.y = 0.0;
  return A.xyz + coh - Vm.w * dv;
}
void main() {
  int i = fragIndex();
  vec4 P = texelFetch(uPos, tc(i), 0);
  vec4 V = texelFetch(uVel, tc(i), 0);
  if (P.w < 0.0) { o = P; return; }
  if (any(isnan(P.xyz)) || any(isnan(V.xyz)) || any(isinf(P.xyz))) { o = vec4(0.0, -1.0e4, 0.0, -2.0); return; } // lost: counted
  if (all(greaterThanEqual(P.xyz, uSinkMin)) && all(lessThanEqual(P.xyz, uSinkMax))) { o = vec4(P.xyz, -1.0); return; }
  vec3 v = V.xyz + (uGravity + controlAccel(P.xyz) + ownerAccel(i, P.xyz, V.xyz)) * uDt;
  o = vec4(collide(P.xyz + v * uDt), P.w);
}`,
    );

    this.reorderProg = gpu.program(
      'reorder',
      `${H}
uniform sampler2D uKeys;
uniform sampler2D uPos;
uniform sampler2D uPred;
uniform sampler2D uVel;
uniform sampler2D uId;
layout(location = 0) out vec4 oX;
layout(location = 1) out vec4 oP;
layout(location = 2) out vec4 oV;
layout(location = 3) out vec4 oI;
void main() {
  int i = fragIndex();
  ivec2 s = tc(int(texelFetch(uKeys, tc(i), 0).y));
  oX = texelFetch(uPos, s, 0);
  oP = texelFetch(uPred, s, 0);
  oV = texelFetch(uVel, s, 0);
  oI = texelFetch(uId, s, 0);
}`,
    );

    this.lambdaProg = gpu.program(
      'lambda',
      `${H}
${KERNEL}
${this.collision.glsl}
${BOUNDARY}
uniform sampler2D uP;
uniform sampler2D uLambdaPrev;
uniform int uFirst;
uniform float uEps;
out vec4 o;
void main() {
  int i = fragIndex();
  vec4 Pi = texelFetch(uP, tc(i), 0);
  float acc = uFirst == 1 ? 0.0 : texelFetch(uLambdaPrev, tc(i), 0).z;
  if (Pi.w < 0.0) { o = vec4(0.0, 0.0, acc, 0.0); return; }
  float rho = 0.0;
  vec3 gi = vec3(0.0);
  float g2 = 0.0;
  ${neighbours(
    'Pi.xyz',
    `vec3 r = Pi.xyz - texelFetch(uP, tc(j), 0).xyz;
      float r2 = dot(r, r);
      if (r2 < uH2) {
        float x = uH2 - r2;
        rho += uMass * uPoly6 * x * x * x;
        if (r2 > 1e-12) {
          float rl = sqrt(r2);
          float hr = uH - rl;
          vec3 g = (uMass / uRho0) * uSpiky * hr * hr * (r / rl);
          gi += g;
          g2 += dot(g, g);
        }
      }`,
  )}
  vec4 B = boundary(Pi.xyz);
  rho += B.w;
  gi += B.xyz / uRho0; // solids do not move: no |∇_b C|² term for them
  float C = max(rho / uRho0 - 1.0, 0.0);
  float lambda = -C / (dot(gi, gi) + g2 + uEps);
  o = vec4(lambda, rho, acc + lambda, C);
}`,
    );

    this.deltaProg = gpu.program(
      'delta',
      `${H}
${KERNEL}
${this.collision.glsl}
${BOUNDARY}
uniform sampler2D uP;
uniform sampler2D uLambda;
uniform float uSCorr;
uniform float uWdq;
out vec4 o;
void main() {
  int i = fragIndex();
  vec4 Pi = texelFetch(uP, tc(i), 0);
  if (Pi.w < 0.0) { o = Pi; return; }
  float li = texelFetch(uLambda, tc(i), 0).x;
  vec3 dp = vec3(0.0);
  ${neighbours(
    'Pi.xyz',
    `if (j == i) continue;
      vec3 r = Pi.xyz - texelFetch(uP, tc(j), 0).xyz;
      float r2 = dot(r, r);
      if (r2 < uH2 && r2 > 1e-12) {
        float lj = texelFetch(uLambda, tc(j), 0).x;
        float x = uH2 - r2;
        float q = uPoly6 * x * x * x / uWdq;
        float q2 = q * q;
        float sc = -uSCorr * q2 * q2; // uSCorr is already divided by the iteration count
        float rl = sqrt(r2);
        float hr = uH - rl;
        dp += (li + lj + sc) * uSpiky * hr * hr * (r / rl);
      }`,
  )}
  dp *= uMass / uRho0;
  // solids: a static body has no constraint of its own (λ_b = 0), so the boundary enters only
  // through i's own constraint gradient: Δp_i += λ_i ∇_i C_i|_b = λ_i ∇ρ_b / ρ0.
  // (SPH's mirrored pressure, factor 2, is not consistent with a PBD projection: measured as an
  // 11% over-pressure and a jittering rest state.)
  dp += li * boundary(Pi.xyz).xyz / uRho0;
  o = vec4(collide(Pi.xyz + dp), Pi.w);
}`,
    );

    this.velocityProg = gpu.program(
      'velocity',
      `${H}
${this.collision.glsl}
uniform sampler2D uX;
uniform sampler2D uP;
uniform float uDt;
uniform float uWallDrag;
uniform float uMaxSpeed;
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oV;
void main() {
  int i = fragIndex();
  vec4 X = texelFetch(uX, tc(i), 0);
  vec4 P = texelFetch(uP, tc(i), 0);
  if (P.w < 0.0) { oPos = P; oV = vec4(0.0); return; }
  vec3 v = (P.xyz - X.xyz) / uDt;
  vec3 n = contactNormal(P.xyz);
  if (dot(n, n) > 0.0) {
    float vn = dot(v, n);
    if (vn < 0.0) v -= vn * n;           // no velocity into the solid
    vec3 vt = v - dot(v, n) * n;
    v -= vt * (1.0 - exp(-uWallDrag * uDt)); // bed / wall roughness
  }
  float flag = 0.0;
  float sp = length(v);
  if (sp > uMaxSpeed) { v *= uMaxSpeed / sp; flag = 1.0; }
  oPos = P;
  oV = vec4(v, flag);
}`,
    );

    this.xsphProg = gpu.program(
      'xsph',
      `${H}
${KERNEL}
uniform sampler2D uPos;
uniform sampler2D uV;
uniform sampler2D uVOld;   // previous velocity, sorted: .w carries the foam value of last step
uniform sampler2D uLambda;
uniform float uXsph;
uniform float uDt;
uniform vec4 uFoam;        // x: vorticity onset (1/s), y: speed onset (m/s), z: crest density ratio, w: lifetime (s)
uniform float uCohesion;   // γ of the sub-resolution cohesion force (Akinci et al. 2013)
uniform float uCohC;       // 32 / (π h⁹)
layout(location = 0) out vec4 oVel; // xyz velocity, w foam 0..1
layout(location = 1) out vec4 oF;   // ∇·v (1/s), ρ (kg/m³), p estimate (Pa), |ω| (1/s)
void main() {
  int i = fragIndex();
  vec4 Pi = texelFetch(uPos, tc(i), 0);
  vec4 Vi = texelFetch(uV, tc(i), 0);
  if (Pi.w < 0.0) { oVel = vec4(0.0); oF = vec4(0.0); return; }
  vec3 smoothV = vec3(0.0);
  float div = 0.0;
  vec3 curl = vec3(0.0);
  vec3 coh = vec3(0.0);
  // cohesion acts only where the water is under-dense (thin sheets, edges): in the bulk it would
  // be a stiff spring around the rest spacing and only add jitter (measured in the rest test)
  float fi = clamp((1.0 - texelFetch(uLambda, tc(i), 0).y / uRho0) / 0.3, 0.0, 1.0);
  ${neighbours(
    'Pi.xyz',
    `if (j == i) continue;
      vec3 r = Pi.xyz - texelFetch(uPos, tc(j), 0).xyz;
      float r2 = dot(r, r);
      if (r2 < uH2 && r2 > 1e-12) {
        vec3 vij = texelFetch(uV, tc(j), 0).xyz - Vi.xyz;
        float x = uH2 - r2;
        smoothV += vij * (uPoly6 * x * x * x);
        float rl = sqrt(r2);
        float hr = uH - rl;
        vec3 g = uSpiky * hr * hr * (r / rl); // ∇_i W_ij
        div += dot(vij, g);
        curl -= cross(vij, g);
        // cohesion spline: attracts at mid range, repels when very close (Akinci et al. 2013)
        float a3 = hr * hr * hr * r2 * rl;
        float Ck = uCohC * (2.0 * rl > uH ? a3 : 2.0 * a3 - uH2 * uH2 * uH2 / 64.0);
        float fj = clamp((1.0 - texelFetch(uLambda, tc(j), 0).y / uRho0) / 0.3, 0.0, 1.0);
        coh -= 0.5 * (fi + fj) * Ck * (r / rl); // symmetric weight: still antisymmetric forces
      }`,
  )}
  float vol = uMass / uRho0;
  vec4 L = texelFetch(uLambda, tc(i), 0);
  // pairwise and antisymmetric: it conserves momentum (the free-fall test checks it)
  vec3 v = Vi.xyz + uXsph * vol * smoothV + uDt * uCohesion * uMass * coh;
  float omega = length(curl) * vol;
  // FOAM (secondary, visual — no air is simulated). Diffuse-particle criteria after Ihmsen et al.
  // 2012, evaluated on quantities the solver already has:
  //   trapped air  = vorticity above onset × enough kinetic energy
  //   wave crest   = particle at a free surface (low density incl. solids) moving fast
  // The value persists and decays with a lifetime, and travels with the water particle.
  float speed = length(v);
  float trapped = smoothstep(uFoam.x, uFoam.x * 3.0, omega) * smoothstep(uFoam.y * 0.5, uFoam.y, speed);
  float crest = (1.0 - smoothstep(uFoam.z * 0.8, uFoam.z, L.y / uRho0)) * smoothstep(uFoam.y, uFoam.y * 2.0, speed);
  float old = texelFetch(uVOld, tc(i), 0).w;
  float foam = max(clamp(trapped + crest, 0.0, 1.0), old * exp(-uDt / uFoam.w));
  oVel = vec4(v, foam);
  oF = vec4(div * vol, L.y, -uRho0 * L.z / (uDt * uDt), omega);
}`,
    );
  }

  /**
   * RENDER-ONLY: anisotropic kernels (Yu & Turk 2013). For each particle, the weighted covariance
   * of its neighbours gives an ellipsoid: a sphere inside the water, a flat disc lying in a thin
   * sheet (so sheets thinner than a particle render as a continuous film), a small sphere for an
   * isolated droplet. Centres are pulled part-way to their neighbourhood mean (Laplacian
   * smoothing). Nothing here feeds back into the simulation.
   */
  buildAnisoProgram() {
    const { gpu, L } = this;
    this.anisoProg = gpu.program(
      'aniso',
      `${header(L)}
uniform sampler2D uPos;
uniform sampler2D uCells;
uniform float uH;
uniform float uR0;       // isotropic splat radius
uniform float uKr;       // max anisotropy (ratio of eigenvalues)
uniform float uLambda;   // centre smoothing
uniform float uNIso;     // neighbour count under which a particle is a droplet
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
layout(location = 2) out vec4 oC;
vec3 eigenvalues(mat3 A) {
  float p1 = A[0][1] * A[0][1] + A[0][2] * A[0][2] + A[1][2] * A[1][2];
  float q = (A[0][0] + A[1][1] + A[2][2]) / 3.0;
  if (p1 < 1e-24) {
    vec3 e = vec3(A[0][0], A[1][1], A[2][2]);
    if (e.x < e.y) e.xy = e.yx;
    if (e.y < e.z) e.yz = e.zy;
    if (e.x < e.y) e.xy = e.yx;
    return e;
  }
  float p2 = (A[0][0] - q) * (A[0][0] - q) + (A[1][1] - q) * (A[1][1] - q) + (A[2][2] - q) * (A[2][2] - q) + 2.0 * p1;
  float p = sqrt(p2 / 6.0);
  mat3 B = (A - q * mat3(1.0)) / p;
  float r = clamp(determinant(B) * 0.5, -1.0, 1.0);
  float phi = acos(r) / 3.0;
  float e1 = q + 2.0 * p * cos(phi);
  float e3 = q + 2.0 * p * cos(phi + 2.0943951);
  return vec3(e1, 3.0 * q - e1 - e3, e3);
}
vec3 eigenvector(mat3 A, float l) {
  mat3 M = A - l * mat3(1.0);
  vec3 a = cross(M[0], M[1]);
  vec3 b = cross(M[0], M[2]);
  vec3 c = cross(M[1], M[2]);
  float la = dot(a, a), lb = dot(b, b), lc = dot(c, c);
  vec3 v = la > lb ? (la > lc ? a : c) : (lb > lc ? b : c);
  float n = length(v);
  return n > 1e-20 ? v / n : vec3(0.0);
}
void main() {
  int i = fragIndex();
  vec4 Pi = texelFetch(uPos, tc(i), 0);
  if (Pi.w < 0.0) { oA = vec4(1.0, 0.0, 0.0, 0.0); oB = vec4(0.0, 1.0, 0.0, 0.0); oC = vec4(Pi.xyz, 0.0); return; }
  float ws = 0.0;
  vec3 mean = vec3(0.0);
  float count = 0.0;
  ${neighbours(
    'Pi.xyz',
    `vec3 pj = texelFetch(uPos, tc(j), 0).xyz;
      float r = length(Pi.xyz - pj);
      if (r < uH) {
        float q = r / uH;
        float w = 1.0 - q * q * q;
        ws += w;
        mean += w * pj;
        count += 1.0;
      }`,
  )}
  mean /= max(ws, 1e-6);
  mat3 C = mat3(0.0);
  ${neighbours(
    'Pi.xyz',
    `vec3 pj = texelFetch(uPos, tc(j), 0).xyz;
      float r = length(Pi.xyz - pj);
      if (r < uH) {
        float q = r / uH;
        float w = 1.0 - q * q * q;
        vec3 d = pj - mean;
        C += w * outerProduct(d, d);
      }`,
  )}
  C /= max(ws, 1e-6);
  vec3 centre = mix(Pi.xyz, mean, uLambda);
  vec3 e = eigenvalues(C);
  vec3 a1 = vec3(1.0, 0.0, 0.0), a2 = vec3(0.0, 1.0, 0.0), a3 = vec3(0.0, 0.0, 1.0);
  vec3 s = vec3(uR0);
  if (count < uNIso) {
    s = vec3(uR0 * 0.5); // a droplet (spray): smaller than a particle's splat, so it does not read as a bubble
  } else if (e.x > 1e-12 && e.x - e.z > 0.05 * e.x) {
    a3 = eigenvector(C, e.z);
    a1 = eigenvector(C, e.x);
    if (dot(a3, a3) > 0.5 && dot(a1, a1) > 0.5 && abs(dot(a1, a3)) < 0.2) {
      a1 = normalize(a1 - dot(a1, a3) * a3);
      a2 = cross(a3, a1);
      vec3 lt = vec3(e.x, max(e.y, e.x / uKr), max(e.z, e.x / uKr));
      float g = pow(lt.x * lt.y * lt.z, 1.0 / 6.0); // keep the splat volume of the sphere
      s = uR0 * sqrt(lt) / g;
    } else {
      a1 = vec3(1.0, 0.0, 0.0); a2 = vec3(0.0, 1.0, 0.0); a3 = vec3(0.0, 0.0, 1.0);
    }
  }
  oA = vec4(a1, s.x);
  oB = vec4(a2, s.y);
  oC = vec4(centre, s.z);
}`,
    );
  }

  /** Render-only anisotropy pass on the current state (uses the last substep's cell table). */
  anisotropy(r0, { kr = 6, lambda = 0.5, nIso = 6 } = {}) {
    if (!this.anisoProg) this.buildAnisoProgram();
    if (!this.lastCells) return null;
    this.gpu.pass(this.anisoProg, this.aniso, {
      uGridMin: this.L.gridMin,
      uCell: this.L.cell,
      uPos: this.position,
      uCells: this.lastCells,
      uH: this.cfg.h,
      uR0: r0,
      uKr: kr,
      uLambda: lambda,
      uNIso: nIso,
    });
    return this.aniso;
  }

  get position() {
    return this.pos[this.cur];
  }

  get velocity() {
    return this.vel[this.cur];
  }

  /** Common uniforms for a substep. */
  uniforms(dt, ctrl, sink) {
    const c = this.cfg;
    const L = this.L;
    this._u ??= {};
    const u = this._u;
    Object.assign(u, this.collision.uniforms(), {
      uGridMin: L.gridMin,
      uCell: L.cell,
      uPR: c.particleRadius,
      uMass: c.mass,
      uRho0: c.density,
      uPoly6: c.kernel.poly6,
      uSpiky: c.kernel.spikyGrad,
      uH: c.h,
      uH2: c.kernel.h2,
      uEps: c.epsilon,
      // artificial pressure is a per-SUBSTEP term: spread it over the iterations, otherwise its
      // effect grows with the iteration count (measured: +4% water height going from 4 to 8)
      uSCorr: c.sCorrScaled / c.iterations,
      uWdq: c.wDq,
      uDt: dt,
      uGravity: c.gravity,
      uWallDrag: c.wallDrag,
      uMaxSpeed: c.maxSpeed,
      uXsph: c.xsph,
      uFoam: c.foam,
      uCohesion: c.cohesion,
      uCohC: 32 / (Math.PI * c.h ** 9),
      uRhoB: c.boundaryTable.rhoB,
      uDRhoB: c.boundaryTable.dRhoB,
      uCtrlA: ctrl?.accel ?? [0, 0, 0, 0],
      uCtrlC: ctrl?.center ?? [0, 0, 0, 0],
      uSinkMin: sink?.min ?? [1e9, 1e9, 1e9],
      uSinkMax: sink?.max ?? [-1e9, -1e9, -1e9],
      uOwners: this.ownersOn ? 1 : 0,
      uOwnerTex: this.ownerTex,
    });
    return u;
  }

  /**
   * Per-river forces for the next substeps (RiverEcosystem, once per frame).
   * @param {Float32Array|null} data  MAX_OWNERS × 3 × 4 floats (rows: steer+κ, centre+cap, v̄+damping); null = off
   */
  setOwners(data) {
    this.ownersOn = !!data;
    if (data) this.gpu.upload(this.ownerTex, data);
  }

  get identity() {
    return this.id[this.idCur];
  }

  /**
   * @param {number} dt
   * @param {object} [ctrl]   uniform control field (RiverController)
   * @param {object} [sink]
   */
  substep(dt, ctrl = null, sink = null) {
    const { gpu, hash, cfg } = this;
    const u = this.uniforms(dt, ctrl, sink);
    const a = this.cur;
    const b = 1 - a;
    const ia = this.idCur;

    gpu.timeBegin('predict');
    gpu.pass(this.predictProg, [this.pred], { ...u, uPos: this.pos[a], uVel: this.vel[a], uId: this.id[ia] });
    gpu.timeEnd();

    gpu.timeBegin('neighbours');
    const keys = hash.sort(this.pred, u);
    gpu.pass(this.reorderProg, [this.sX, this.sP[0], this.sV, this.id[1 - ia]], { uKeys: keys, uPos: this.pos[a], uPred: this.pred, uVel: this.vel[a], uId: this.id[ia] });
    this.idCur = 1 - ia;
    const cells = hash.buildCells();
    this.lastCells = cells;
    gpu.timeEnd();

    gpu.timeBegin('constraints');
    let p = 0;
    let l = 0;
    for (let it = 0; it < cfg.iterations; it++) {
      gpu.pass(this.lambdaProg, [this.lam[1 - l]], { ...u, uP: this.sP[p], uLambdaPrev: this.lam[l], uFirst: it === 0 ? 1 : 0, uCells: cells });
      l = 1 - l;
      gpu.pass(this.deltaProg, [this.sP[1 - p]], { ...u, uP: this.sP[p], uLambda: this.lam[l], uCells: cells });
      p = 1 - p;
    }
    gpu.timeEnd();

    gpu.timeBegin('velocity');
    gpu.pass(this.velocityProg, [this.pos[b], this.rawV], { ...u, uX: this.sX, uP: this.sP[p] });
    gpu.pass(this.xsphProg, [this.vel[b], this.fields], { ...u, uPos: this.pos[b], uV: this.rawV, uVOld: this.sV, uLambda: this.lam[l], uCells: cells });
    gpu.timeEnd();

    this.cur = b;
  }
}
