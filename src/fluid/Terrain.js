/**
 * Terrain — an analytic landscape for the water to run down: a sloping valley with carved river
 * channels that join each other (a drainage network), so rivers meet at confluences like real ones.
 *
 * Height (metres) and its exact gradient are evaluated identically in JS (diagnostics, AI, the
 * render mesh) and in GLSL (solver collisions); the GLSL is generated with the numbers baked in.
 *
 *   H(x, z) = base(x, z) − D · U(x, z)
 *   base     inclined plane (downhill towards +x), a drop into the sea at the end, banks that rise
 *            towards the lateral edges, a couple of long gentle waves, optional hills
 *   U        channel network: every channel is a polyline; each segment s contributes
 *            e_s = a_s · exp(−d_s² / w_s²)  (d_s = distance to the segment), and
 *            U = tanh(1.5 Σ e_s) / tanh(1.5) — 1 on a channel's axis, a little deeper where two
 *            channels overlap (a confluence pool), smooth everywhere
 *
 * As a solid for the solver: signed distance ≈ (y − H) / √(1 + |∇H|²), normal (−∇H, 1)/√(…).
 * Exact on planes, first-order on gentle curvature (slopes here are ≤ ~0.6).
 */
const T15 = Math.tanh(1.5);

const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return [t * t * (3 - 2 * t), t > 0 && t < 1 ? (6 * t * (1 - t)) / (e1 - e0) : 0];
};

export class Terrain {
  /**
   * @param {object} spec
   * @param {{x0:number,h0:number,slope:number,drop?:{from:number,to:number,depth:number},edges?:{from:number,to:number,rise:number},waves?:number[][]}} spec.base
   * @param {number} spec.depth   channel depth D (m)
   * @param {{width:number,amp?:number,points:number[][]}[]} spec.channels
   * @param {number[][]} [spec.hills]  [cx, cz, radius, height]
   */
  constructor(spec) {
    this.spec = spec;
    this.base = { drop: null, edges: null, waves: [], ...spec.base };
    this.depth = spec.depth;
    this.hills = spec.hills ?? [];
    this.segments = [];
    for (const c of spec.channels) {
      for (let i = 0; i + 1 < c.points.length; i++) {
        const [x0, z0] = c.points[i];
        const [x1, z1] = c.points[i + 1];
        this.segments.push({ x0, z0, x1, z1, w: c.width, a: c.amp ?? 1 });
      }
    }
  }

  baseHeight(x, z) {
    const b = this.base;
    let h = b.h0 + b.slope * (b.x0 - x);
    let gx = -b.slope;
    let gz = 0;
    if (b.drop) {
      const [s, ds] = smooth(b.drop.from, b.drop.to, x);
      h -= b.drop.depth * s;
      gx -= b.drop.depth * ds;
    }
    if (b.edges) {
      const [s, ds] = smooth(b.edges.from, b.edges.to, Math.abs(z));
      h += b.edges.rise * s;
      gz += b.edges.rise * ds * Math.sign(z);
    }
    for (const [A, kx, kz] of b.waves) {
      const ph = kx * x + kz * z;
      h += A * Math.sin(ph);
      gx += A * kx * Math.cos(ph);
      gz += A * kz * Math.cos(ph);
    }
    for (const [cx, cz, r, a] of this.hills) {
      const dx = x - cx;
      const dz = z - cz;
      const e = a * Math.exp(-(dx * dx + dz * dz) / (r * r));
      h += e;
      gx += (e * -2 * dx) / (r * r);
      gz += (e * -2 * dz) / (r * r);
    }
    return [h, gx, gz];
  }

  /** Channel field U ∈ [0, ~1.1] and its gradient. */
  channels(x, z) {
    let S = 0;
    let gx = 0;
    let gz = 0;
    for (const s of this.segments) {
      const abx = s.x1 - s.x0;
      const abz = s.z1 - s.z0;
      const t = Math.min(1, Math.max(0, ((x - s.x0) * abx + (z - s.z0) * abz) / (abx * abx + abz * abz)));
      const dx = x - (s.x0 + t * abx);
      const dz = z - (s.z0 + t * abz);
      const d2 = dx * dx + dz * dz;
      const w2 = s.w * s.w;
      if (d2 > 9 * w2) continue;
      const e = s.a * Math.exp(-d2 / w2);
      S += e;
      gx += (e * -2 * dx) / w2;
      gz += (e * -2 * dz) / w2;
    }
    const th = Math.tanh(1.5 * S);
    const k = (1.5 * (1 - th * th)) / T15;
    return [th / T15, k * gx, k * gz];
  }

  /** [H, ∂H/∂x, ∂H/∂z] */
  sample(x, z) {
    const [h, bx, bz] = this.baseHeight(x, z);
    const [U, ux, uz] = this.channels(x, z);
    return [h - this.depth * U, bx - this.depth * ux, bz - this.depth * uz];
  }

  height(x, z) {
    return this.sample(x, z)[0];
  }

  /** Signed distance (approx., see header) of a point to the ground; negative below it. */
  distance(x, y, z) {
    const [H, gx, gz] = this.sample(x, z);
    return (y - H) / Math.sqrt(1 + gx * gx + gz * gz);
  }

  /** GLSL: `vec3 terrain(vec2 q)` → (H, ∂H/∂x, ∂H/∂z), numbers baked in. */
  glsl() {
    const f = (v) => {
      const s = (+v).toPrecision(7);
      return s.includes('.') || s.includes('e') ? s : `${s}.0`;
    };
    const b = this.base;
    const segs = this.segments.length ? this.segments : [{ x0: 1e6, z0: 1e6, x1: 1e6 + 1, z1: 1e6, w: 1, a: 0 }];
    const n = segs.length;
    const lines = [];
    lines.push(`const int TER_NSEG = ${n};`);
    lines.push(`const vec4 TER_SEG[${n}] = vec4[${n}](${segs.map((s) => `vec4(${f(s.x0)}, ${f(s.z0)}, ${f(s.x1)}, ${f(s.z1)})`).join(', ')});`);
    lines.push(`const vec2 TER_WA[${n}] = vec2[${n}](${segs.map((s) => `vec2(${f(s.w)}, ${f(s.a)})`).join(', ')});`);
    let base = `float h = ${f(b.h0)} + ${f(b.slope)} * (${f(b.x0)} - q.x);\n  vec2 g = vec2(${f(-b.slope)}, 0.0);\n`;
    if (b.drop) {
      base += `  { float t = clamp((q.x - ${f(b.drop.from)}) / ${f(b.drop.to - b.drop.from)}, 0.0, 1.0);
    h -= ${f(b.drop.depth)} * t * t * (3.0 - 2.0 * t);
    g.x -= ${f(b.drop.depth)} * 6.0 * t * (1.0 - t) / ${f(b.drop.to - b.drop.from)}; }\n`;
    }
    if (b.edges) {
      base += `  { float az = abs(q.y); float t = clamp((az - ${f(b.edges.from)}) / ${f(b.edges.to - b.edges.from)}, 0.0, 1.0);
    h += ${f(b.edges.rise)} * t * t * (3.0 - 2.0 * t);
    g.y += ${f(b.edges.rise)} * 6.0 * t * (1.0 - t) / ${f(b.edges.to - b.edges.from)} * sign(q.y); }\n`;
    }
    for (const [A, kx, kz] of b.waves) {
      base += `  { float ph = ${f(kx)} * q.x + ${f(kz)} * q.y; h += ${f(A)} * sin(ph); g += ${f(A)} * cos(ph) * vec2(${f(kx)}, ${f(kz)}); }\n`;
    }
    for (const [cx, cz, r, a] of this.hills) {
      base += `  { vec2 d = q - vec2(${f(cx)}, ${f(cz)}); float e = ${f(a)} * exp(-dot(d, d) / ${f(r * r)}); h += e; g += e * -2.0 * d / ${f(r * r)}; }\n`;
    }
    return /* glsl */ `
#define HAS_TERRAIN 1
${lines.join('\n')}
vec3 terrain(vec2 q) {
  ${base}
  float S = 0.0;
  vec2 gS = vec2(0.0);
  for (int s = 0; s < TER_NSEG; s++) {
    vec2 a = TER_SEG[s].xy;
    vec2 ab = TER_SEG[s].zw - a;
    float t = clamp(dot(q - a, ab) / dot(ab, ab), 0.0, 1.0);
    vec2 dv = q - (a + t * ab);
    float d2 = dot(dv, dv);
    float w2 = TER_WA[s].x * TER_WA[s].x;
    if (d2 > 9.0 * w2) continue;
    float e = TER_WA[s].y * exp(-d2 / w2);
    S += e;
    gS += e * -2.0 * dv / w2;
  }
  float th = tanh(1.5 * S);
  float U = th / ${f(T15)};
  vec2 gU = 1.5 * (1.0 - th * th) / ${f(T15)} * gS;
  return vec3(h - ${f(this.depth)} * U, g - ${f(this.depth)} * gU);
}`;
  }
}
