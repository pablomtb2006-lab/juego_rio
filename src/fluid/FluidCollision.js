/**
 * FluidCollision — solids the water cannot enter, as signed distance functions (SDF).
 *
 * Why SDFs and not the render meshes: the solver needs, for any point, "how deep am I inside a
 * solid and which way is out". Analytic SDFs answer that exactly and cheaply on the GPU; a
 * high-poly visual mesh would not. Supported primitives:
 *   - domain   axis-aligned box the water lives in (floor = min.y, four walls, a ceiling)
 *   - boxes    oriented boxes, full 3D rotation (blocks, walls, ramps, steps, ledges)
 *   - spheres  rocks / boulders
 *
 * The same geometry is evaluated twice: in GLSL by the solver (projection + contact normals) and
 * in JS by the diagnostics, which independently count particles found inside a solid. A solver
 * bug cannot hide behind its own collision code that way.
 */
export const MAX_BOXES = 32;
export const MAX_SPHERES = 32;

const toMat3 = (rot) => {
  // rot: [rx, ry, rz] Euler XYZ (radians) → column-major 3×3, local → world
  const [x, y, z] = rot ?? [0, 0, 0];
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  // R = Rz·Ry·Rx applied as in three.js 'XYZ' order: R = Rx·Ry·Rz
  const m = [
    cy * cz, cx * sz + sx * sy * cz, sx * sz - cx * sy * cz,
    -cy * sz, cx * cz - sx * sy * sz, sx * cz + cx * sy * sz,
    sy, -sx * cy, cx * cy,
  ];
  return m; // columns: [m0 m1 m2] = image of local x, etc.
};

export class FluidCollision {
  /**
   * @param {{min:number[],max:number[]}} domain
   * @param {{boxes?:{center:number[],half:number[],rot?:number[]}[], spheres?:{center:number[],radius:number}[]}} obstacles
   */
  constructor(domain, obstacles = {}) {
    this.domain = { min: [...domain.min], max: [...domain.max] };
    this.boxes = [];
    this.spheres = [];
    for (const b of obstacles.boxes ?? []) this.addBox(b);
    for (const s of obstacles.spheres ?? []) this.addSphere(s);
  }

  addBox({ center, half, rot = [0, 0, 0] }) {
    if (this.boxes.length >= MAX_BOXES) throw new Error(`[fluid] at most ${MAX_BOXES} boxes`);
    this.boxes.push({ center: [...center], half: [...half], rot: [...rot], m: toMat3(rot) });
    this.version = (this.version ?? 0) + 1;
  }

  addSphere({ center, radius }) {
    if (this.spheres.length >= MAX_SPHERES) throw new Error(`[fluid] at most ${MAX_SPHERES} spheres`);
    this.spheres.push({ center: [...center], radius });
    this.version = (this.version ?? 0) + 1;
  }

  /** Uniform values for the GLSL below. */
  uniforms() {
    const bc = new Float32Array(MAX_BOXES * 3);
    const bh = new Float32Array(MAX_BOXES * 3);
    const br = new Float32Array(MAX_BOXES * 9);
    this.boxes.forEach((b, i) => {
      bc.set(b.center, i * 3);
      bh.set(b.half, i * 3);
      br.set(b.m, i * 9);
    });
    const sp = new Float32Array(MAX_SPHERES * 4);
    this.spheres.forEach((s, i) => sp.set([...s.center, s.radius], i * 4));
    return {
      uDomMin: this.domain.min,
      uDomMax: this.domain.max,
      uNBox: this.boxes.length,
      uBoxC: bc,
      uBoxH: bh,
      uBoxR: br,
      uNSph: this.spheres.length,
      uSph: sp,
    };
  }

  /** Signed distance to the nearest obstacle (not the domain walls), JS mirror of the GLSL. */
  obstacleDistance(x, y, z) {
    let best = Infinity;
    for (const b of this.boxes) {
      const px = x - b.center[0], py = y - b.center[1], pz = z - b.center[2];
      const m = b.m;
      // q = Rᵀ p (columns of m are the local axes)
      const qx = m[0] * px + m[1] * py + m[2] * pz;
      const qy = m[3] * px + m[4] * py + m[5] * pz;
      const qz = m[6] * px + m[7] * py + m[8] * pz;
      const dx = Math.abs(qx) - b.half[0], dy = Math.abs(qy) - b.half[1], dz = Math.abs(qz) - b.half[2];
      const out = Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0));
      const ins = Math.min(Math.max(dx, dy, dz), 0);
      best = Math.min(best, out + ins);
    }
    for (const s of this.spheres) best = Math.min(best, Math.hypot(x - s.center[0], y - s.center[1], z - s.center[2]) - s.radius);
    return best;
  }

  /** Distance to the domain walls (positive inside). */
  wallDistance(x, y, z) {
    const { min, max } = this.domain;
    return Math.min(x - min[0], max[0] - x, y - min[1], max[1] - y, z - min[2], max[2] - z);
  }
}

/** GLSL: obstacle SDF, projection out of solids, and contact normal. Needs `uPR` (particle radius). */
export const COLLISION_GLSL = /* glsl */ `
#define MAXB ${MAX_BOXES}
#define MAXS ${MAX_SPHERES}
uniform vec3 uDomMin;
uniform vec3 uDomMax;
uniform int uNBox;
uniform vec3 uBoxC[MAXB];
uniform vec3 uBoxH[MAXB];
uniform mat3 uBoxR[MAXB];
uniform int uNSph;
uniform vec4 uSph[MAXS];
uniform float uPR;

// xyz = outward normal of the nearest obstacle surface, w = signed distance (negative inside)
vec4 obstacle(vec3 p) {
  float best = 1e9;
  vec3 n = vec3(0.0, 1.0, 0.0);
  for (int i = 0; i < MAXB; i++) {
    if (i >= uNBox) break;
    vec3 q = transpose(uBoxR[i]) * (p - uBoxC[i]);
    vec3 d = abs(q) - uBoxH[i];
    vec3 dp = max(d, 0.0);
    float outside = length(dp);
    float inside = min(max(d.x, max(d.y, d.z)), 0.0);
    float s = outside + inside;
    if (s < best) {
      best = s;
      vec3 sq = vec3(q.x >= 0.0 ? 1.0 : -1.0, q.y >= 0.0 ? 1.0 : -1.0, q.z >= 0.0 ? 1.0 : -1.0);
      vec3 ln;
      if (outside > 0.0) ln = dp * sq / outside;
      else if (d.x > d.y && d.x > d.z) ln = vec3(sq.x, 0.0, 0.0);
      else if (d.y > d.z) ln = vec3(0.0, sq.y, 0.0);
      else ln = vec3(0.0, 0.0, sq.z);
      n = uBoxR[i] * ln;
    }
  }
  for (int i = 0; i < MAXS; i++) {
    if (i >= uNSph) break;
    vec3 r = p - uSph[i].xyz;
    float l = length(r);
    float s = l - uSph[i].w;
    if (s < best) {
      best = s;
      n = l > 1e-6 ? r / l : vec3(0.0, 1.0, 0.0);
    }
  }
  return vec4(n, best);
}

// push a particle centre out of every solid it overlaps (two rounds settle corners)
vec3 collide(vec3 p) {
  for (int k = 0; k < 2; k++) {
    vec4 o = obstacle(p);
    if (o.w < uPR) p += o.xyz * (uPR - o.w);
  }
  return clamp(p, uDomMin + uPR, uDomMax - uPR);
}

// normal of a surface we are touching, or vec3(0) in open water
vec3 contactNormal(vec3 p) {
  float touch = uPR * 1.6;
  vec3 n = vec3(0.0);
  if (p.y - uDomMin.y < touch) n += vec3(0.0, 1.0, 0.0);
  if (uDomMax.y - p.y < touch) n += vec3(0.0, -1.0, 0.0);
  if (p.x - uDomMin.x < touch) n += vec3(1.0, 0.0, 0.0);
  if (uDomMax.x - p.x < touch) n += vec3(-1.0, 0.0, 0.0);
  if (p.z - uDomMin.z < touch) n += vec3(0.0, 0.0, 1.0);
  if (uDomMax.z - p.z < touch) n += vec3(0.0, 0.0, -1.0);
  vec4 o = obstacle(p);
  if (o.w < touch) n += o.xyz;
  float l = length(n);
  return l > 1e-6 ? n / l : vec3(0.0);
}
`;
