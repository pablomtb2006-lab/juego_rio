import * as THREE from 'three';

// Small deterministic helpers shared by every prop builder (trees, rocks, landmarks).

/** Integer hash → [0, 1). Stable across runs (used for per-cell / per-instance randomness). */
export function hash2(x, y, seed = 0) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Cheap smooth 3D value noise in [-1, 1] (CPU side, used to deform rocks / clumps). */
export function makeNoise3(seed = 1) {
  const perm = new Uint8Array(512);
  const vals = new Float32Array(256);
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    p[i] = i;
    vals[i] = rnd() * 2 - 1;
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const fade = (t) => t * t * (3 - 2 * t);
  const v = (i, j, k) => vals[perm[perm[perm[i & 255] + (j & 255)] + (k & 255)]];
  return function noise3(x, y, z) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const xf = fade(x - xi);
    const yf = fade(y - yi);
    const zf = fade(z - zi);
    const a = v(xi, yi, zi) + (v(xi + 1, yi, zi) - v(xi, yi, zi)) * xf;
    const b = v(xi, yi + 1, zi) + (v(xi + 1, yi + 1, zi) - v(xi, yi + 1, zi)) * xf;
    const c = v(xi, yi, zi + 1) + (v(xi + 1, yi, zi + 1) - v(xi, yi, zi + 1)) * xf;
    const d = v(xi, yi + 1, zi + 1) + (v(xi + 1, yi + 1, zi + 1) - v(xi, yi + 1, zi + 1)) * xf;
    const e = a + (b - a) * yf;
    const f = c + (d - c) * yf;
    return e + (f - e) * zf;
  };
}

export function fbm3(noise, x, y, z, oct = 3) {
  let a = 1;
  let f = 1;
  let s = 0;
  let n = 0;
  for (let o = 0; o < oct; o++) {
    s += a * noise(x * f, y * f, z * f);
    n += a;
    a *= 0.5;
    f *= 2.03;
  }
  return s / n;
}

/** Fibonacci sphere direction i of n. */
export function fibDir(i, n, out = new THREE.Vector3()) {
  const y = 1 - ((i + 0.5) / n) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const a = i * 2.399963229728653;
  return out.set(Math.cos(a) * r, y, Math.sin(a) * r);
}

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const sstep = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * Accumulates vertices for prop geometry with the attribute layout every prop
 * material expects:
 *   position, normal, color (albedo × baked AO, may exceed 1 for highlights),
 *   uv (leaf atlas), aCard (camera-facing corner offset in metres, 0 for solids),
 *   aWind (sway weight 0..1), aTint (0 = keep vertex colour, 1 = multiply by instance colour).
 */
export class MeshBuilder {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.col = [];
    this.uv = [];
    this.card = [];
    this.wind = [];
    this.tint = [];
    this.idx = [];
  }

  get count() {
    return this.pos.length / 3;
  }

  vert(p, n, c, tint = 1, wind = 0, uv = null, card = null) {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.col.push(c.r, c.g, c.b);
    this.tint.push(tint);
    this.wind.push(wind);
    if (uv) this.uv.push(uv[0], uv[1]);
    else this.uv.push(0.5, 0.5);
    if (card) this.card.push(card[0], card[1]);
    else this.card.push(0, 0);
    return this.count - 1;
  }

  tri(a, b, c) {
    this.idx.push(a, b, c);
  }

  quad(a, b, c, d) {
    this.idx.push(a, b, c, a, c, d);
  }

  /** Triangle whose winding is fixed so it faces along its (stored) vertex normals. */
  triAuto(a, b, c) {
    const P = this.pos;
    const N = this.nor;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
    const vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const hx = N[a * 3] + N[b * 3] + N[c * 3];
    const hy = N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1];
    const hz = N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2];
    if (nx * hx + ny * hy + nz * hz >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }

  quadAuto(a, b, c, d) {
    this.triAuto(a, b, c);
    this.triAuto(a, c, d);
  }

  /** Merge another builder (indices offset). */
  append(o) {
    const off = this.count;
    this.pos.push(...o.pos);
    this.nor.push(...o.nor);
    this.col.push(...o.col);
    this.uv.push(...o.uv);
    this.card.push(...o.card);
    this.wind.push(...o.wind);
    this.tint.push(...o.tint);
    for (const i of o.idx) this.idx.push(i + off);
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aCard', new THREE.Float32BufferAttribute(this.card, 2));
    g.setAttribute('aWind', new THREE.Float32BufferAttribute(this.wind, 1));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(this.tint, 1));
    const n = this.count;
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Expand an indexed geometry into flat-shaded triangles, keeping custom attributes. */
export function toFlat(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  return g;
}

/** Make sure a geometry has every attribute the prop materials read. */
export function ensurePropAttributes(g, { tint = 1, wind = 0 } = {}) {
  const n = g.attributes.position.count;
  if (!g.attributes.color) g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2).fill(0.5), 2));
  if (!g.attributes.aCard) g.setAttribute('aCard', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  if (!g.attributes.aWind) g.setAttribute('aWind', new THREE.Float32BufferAttribute(new Float32Array(n).fill(wind), 1));
  if (!g.attributes.aTint) g.setAttribute('aTint', new THREE.Float32BufferAttribute(new Float32Array(n).fill(tint), 1));
  return g;
}

/** Triangle count of a geometry (for budget reporting). */
export function triCount(g) {
  return (g.index ? g.index.count : g.attributes.position.count) / 3;
}
