// Hydrology helpers on the final grid: flow accumulation (MFD), valley widening,
// depression analysis.

import { N8_DI, N8_DJ, N8_LEN } from './grid.js';

/**
 * Multiple-flow-direction accumulation (Freeman 1991) on a depression-free surface.
 * `order` lists cells by non-decreasing height (e.g. priority-flood order); processed high→low.
 * Returns contributing area in m².
 */
export function mfdAccumulation(h, res, cell, order, count, p = 1.3, out = new Float32Array(res * res)) {
  const cellA = cell * cell;
  out.fill(cellA);
  const w = new Float32Array(8);
  for (let c = count - 1; c >= 0; c--) {
    const k = order[c];
    const i = k % res;
    const j = (k - i) / res;
    if (i === 0 || j === 0 || i === res - 1 || j === res - 1) continue;
    const hk = h[k];
    let sum = 0;
    for (let d = 0; d < 8; d++) {
      const dh = hk - h[k + N8_DJ[d] * res + N8_DI[d]];
      if (dh > 0) {
        const s = p === 1 ? dh / N8_LEN[d] : Math.pow(dh / N8_LEN[d], p);
        w[d] = s;
        sum += s;
      } else w[d] = 0;
    }
    if (sum <= 0) continue;
    const a = out[k] / sum;
    for (let d = 0; d < 8; d++) if (w[d] > 0) out[k + N8_DJ[d] * res + N8_DI[d]] += a * w[d];
  }
  return out;
}

/**
 * Widen valley floors: every channel cell (area > aMin) stamps a floor whose half-width grows
 * with sqrt(area). Floors follow the channel downhill and blend into the walls.
 */
export function widenValleys(h, res, cell, area, isSea, o = {}) {
  const aMin = o.aMin ?? 1.5e6;
  const wPerSqrtKm2 = o.w ?? 70; // half-width (m) per sqrt(km²)
  const wMax = o.wMax ?? 320;
  const n = res * res;
  const src = new Float32Array(h);
  // channel slope estimate along steepest descent
  const chan = [];
  for (let k = 0; k < n; k++) if (area[k] > aMin && !isSea[k]) chan.push(k);
  for (const k of chan) {
    const i = k % res;
    const j = (k - i) / res;
    if (i < 2 || j < 2 || i > res - 3 || j > res - 3) continue;
    const hc = src[k];
    let s = 0;
    for (let d = 0; d < 8; d++) {
      const dh = (hc - src[k + N8_DJ[d] * res + N8_DI[d]]) / (N8_LEN[d] * cell);
      if (dh > s) s = dh;
    }
    const W = Math.min(wMax, wPerSqrtKm2 * Math.sqrt(area[k] / 1e6));
    const floorSlope = Math.max(0.02, s * 1.1);
    const R = Math.ceil((W * 1.5) / cell);
    for (let dj = -R; dj <= R; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= res) continue;
      for (let di = -R; di <= R; di++) {
        const ii = i + di;
        if (ii < 0 || ii >= res) continue;
        const d = Math.hypot(di, dj) * cell;
        if (d > W * 1.5) continue;
        const kk = jj * res + ii;
        if (isSea[kk]) continue;
        const floor = hc + floorSlope * d;
        const orig = src[kk];
        if (orig <= floor) continue;
        let t = (d - W * 0.55) / (W * 0.95);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        t = t * t * (3 - 2 * t);
        const v = floor + (orig - floor) * t;
        if (v < h[kk]) h[kk] = v;
      }
    }
  }
}
