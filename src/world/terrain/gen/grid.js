// Small grid utilities shared by the generator (pure JS: runs in a worker or Node).

export const N8_DI = [1, 1, 0, -1, -1, -1, 0, 1];
export const N8_DJ = [0, 1, 1, 1, 0, -1, -1, -1];
export const N8_LEN = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];

/** Binary min-heap of (int key, float priority) with typed arrays. */
export class MinHeap {
  constructor(cap) {
    this.keys = new Int32Array(cap);
    this.vals = new Float64Array(cap);
    this.size = 0;
  }
  clear() {
    this.size = 0;
  }
  push(k, v) {
    let i = this.size++;
    if (i >= this.keys.length) {
      const nk = new Int32Array(this.keys.length * 2);
      nk.set(this.keys);
      const nv = new Float64Array(this.vals.length * 2);
      nv.set(this.vals);
      this.keys = nk;
      this.vals = nv;
    }
    const keys = this.keys;
    const vals = this.vals;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (vals[p] <= v) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = k;
    vals[i] = v;
  }
  pop() {
    const keys = this.keys;
    const vals = this.vals;
    const top = keys[0];
    const n = --this.size;
    const k = keys[n];
    const v = vals[n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && vals[c + 1] < vals[c]) c++;
      if (vals[c] >= v) break;
      keys[i] = keys[c];
      vals[i] = vals[c];
      i = c;
    }
    keys[i] = k;
    vals[i] = v;
    return top;
  }
}

/** Catmull-Rom weights for fraction t. Writes into w[0..3]. */
export function crWeights(t, w) {
  const t2 = t * t;
  const t3 = t2 * t;
  w[0] = -0.5 * t3 + t2 - 0.5 * t;
  w[1] = 1.5 * t3 - 2.5 * t2 + 1;
  w[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
  w[3] = 0.5 * t3 - 0.5 * t2;
}

const _wx = new Float64Array(4);
const _wz = new Float64Array(4);

/** Catmull-Rom bicubic sample of a res×res grid at fractional grid coords (gx, gz), clamped. */
export function sampleBicubic(arr, res, gx, gz) {
  const max = res - 1;
  if (gx < 0) gx = 0;
  else if (gx > max) gx = max;
  if (gz < 0) gz = 0;
  else if (gz > max) gz = max;
  let i = Math.floor(gx);
  let j = Math.floor(gz);
  if (i > max - 1) i = max - 1;
  if (j > max - 1) j = max - 1;
  crWeights(gx - i, _wx);
  crWeights(gz - j, _wz);
  let sum = 0;
  for (let b = 0; b < 4; b++) {
    let jj = j - 1 + b;
    if (jj < 0) jj = 0;
    else if (jj > max) jj = max;
    const row = jj * res;
    let rs = 0;
    for (let a = 0; a < 4; a++) {
      let ii = i - 1 + a;
      if (ii < 0) ii = 0;
      else if (ii > max) ii = max;
      rs += _wx[a] * arr[row + ii];
    }
    sum += _wz[b] * rs;
  }
  return sum;
}

/** Bilinear sample at fractional grid coords, clamped. */
export function sampleBilinear(arr, res, gx, gz) {
  const max = res - 1;
  if (gx < 0) gx = 0;
  else if (gx > max) gx = max;
  if (gz < 0) gz = 0;
  else if (gz > max) gz = max;
  let i = Math.floor(gx);
  let j = Math.floor(gz);
  if (i > max - 1) i = max - 1;
  if (j > max - 1) j = max - 1;
  const fx = gx - i;
  const fz = gz - j;
  const k = j * res + i;
  const a = arr[k];
  const b = arr[k + 1];
  const c = arr[k + res];
  const d = arr[k + res + 1];
  return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
}

/** Separable box blur (radius r cells), `passes` times — approximates a gaussian. In place. */
export function blur(arr, res, r, passes = 2, tmp = new Float32Array(arr.length)) {
  const inv = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    // horizontal: arr -> tmp
    for (let j = 0; j < res; j++) {
      const row = j * res;
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += arr[row + Math.min(Math.max(i, 0), res - 1)];
      for (let i = 0; i < res; i++) {
        tmp[row + i] = acc * inv;
        const add = Math.min(i + r + 1, res - 1);
        const sub = Math.max(i - r, 0);
        acc += arr[row + add] - arr[row + sub];
      }
    }
    // vertical: tmp -> arr
    for (let i = 0; i < res; i++) {
      let acc = 0;
      for (let j = -r; j <= r; j++) acc += tmp[Math.min(Math.max(j, 0), res - 1) * res + i];
      for (let j = 0; j < res; j++) {
        arr[j * res + i] = acc * inv;
        const add = Math.min(j + r + 1, res - 1);
        const sub = Math.max(j - r, 0);
        acc += tmp[add * res + i] - tmp[sub * res + i];
      }
    }
  }
  return arr;
}

/**
 * Two-pass chamfer distance transform (exact octile path distance on the 8-connected grid,
 * which for an obstacle-free domain equals Dijkstra). `src` = 1 where distance is 0.
 */
export function chamferDistance(src, res, cell, out = new Float32Array(res * res)) {
  const INF = 1e30;
  const d1 = cell;
  const d2 = cell * Math.SQRT2;
  for (let k = 0; k < out.length; k++) out[k] = src[k] ? 0 : INF;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const k = j * res + i;
      let v = out[k];
      if (v === 0) continue;
      if (i > 0) v = Math.min(v, out[k - 1] + d1);
      if (j > 0) {
        v = Math.min(v, out[k - res] + d1);
        if (i > 0) v = Math.min(v, out[k - res - 1] + d2);
        if (i < res - 1) v = Math.min(v, out[k - res + 1] + d2);
      }
      out[k] = v;
    }
  }
  for (let j = res - 1; j >= 0; j--) {
    for (let i = res - 1; i >= 0; i--) {
      const k = j * res + i;
      let v = out[k];
      if (v === 0) continue;
      if (i < res - 1) v = Math.min(v, out[k + 1] + d1);
      if (j < res - 1) {
        v = Math.min(v, out[k + res] + d1);
        if (i < res - 1) v = Math.min(v, out[k + res + 1] + d2);
        if (i > 0) v = Math.min(v, out[k + res - 1] + d2);
      }
      out[k] = v;
    }
  }
  return out;
}

/**
 * Priority-flood depression filling (Barnes et al.) with a tiny epsilon gradient so every
 * cell drains. Edge cells and cells with seed[k]=1 are outlets. Writes the filled surface
 * into `out` and the visiting order (non-decreasing filled height) into `order`.
 */
export function priorityFlood(h, res, isOutlet, out, order, eps = 1e-3, heap = new MinHeap(res * 8), closed = new Uint8Array(res * res)) {
  const n = res * res;
  closed.fill(0);
  heap.clear();
  if (out !== h) out.set(h);
  for (let k = 0; k < n; k++) {
    const i = k % res;
    const j = (k / res) | 0;
    if (isOutlet[k] || i === 0 || j === 0 || i === res - 1 || j === res - 1) {
      closed[k] = 1;
      heap.push(k, out[k]);
    }
  }
  let cnt = 0;
  while (heap.size) {
    const k = heap.pop();
    order[cnt++] = k;
    const hk = out[k];
    const i = k % res;
    const j = (k - i) / res;
    for (let d = 0; d < 8; d++) {
      const ii = i + N8_DI[d];
      const jj = j + N8_DJ[d];
      if (ii < 0 || jj < 0 || ii >= res || jj >= res) continue;
      const kk = jj * res + ii;
      if (closed[kk]) continue;
      closed[kk] = 1;
      if (out[kk] <= hk + eps) out[kk] = hk + eps;
      heap.push(kk, out[kk]);
    }
  }
  return cnt;
}
