// Stream-power-law fluvial erosion (implicit, Braun & Willett 2013) with a talus limit.
// Uses the O(n) receiver "stack" ordering; depressions are filled with priority-flood every
// few iterations so the drainage network always reaches the sea.

import { MinHeap, N8_DI, N8_DJ, N8_LEN, priorityFlood } from './grid.js';
import { mulberry32 } from '../../../core/random.js';

/**
 * @param {Float32Array} h        heights (m), modified in place
 * @param {number} res            grid resolution
 * @param {number} cell           cell size (m)
 * @param {Uint8Array} isSea      1 = fixed base level
 * @param {Float32Array} uplift   uplift per iteration (m)
 * @param {Float32Array} K        erodibility × dt per cell
 * @param {object} o              { iters, m, talus, fillEvery, seed, onIter }
 */
export function streamPower(h, res, cell, isSea, uplift, K, o) {
  const n = res * res;
  const iters = o.iters ?? 20;
  const m = o.m ?? 0.42;
  const fillEvery = o.fillEvery ?? 6;
  const talus = (o.talus ?? 0.9) * cell;
  const talusMap = o.talusMap ?? null;
  const rcv = new Int32Array(n);
  const rlen = new Float32Array(n);
  const stack = new Int32Array(n);
  const ndon = new Uint8Array(n);
  const donors = new Int32Array(n * 8);
  const area = new Float32Array(n);
  const isOut = new Uint8Array(n);
  const order = new Int32Array(n);
  const heap = new MinHeap(res * 16);
  const closed = new Uint8Array(n);
  const cellA = cell * cell;
  for (let k = 0; k < n; k++) {
    const i = k % res;
    const j = (k - i) / res;
    isOut[k] = isSea[k] || i === 0 || j === 0 || i === res - 1 || j === res - 1 ? 1 : 0;
  }
  // cheap jitter table for stochastic steepest descent (breaks D8 straight lines)
  const rnd = mulberry32(o.seed ?? 1);
  const JMASK = 65535;
  const jit = new Float32Array(JMASK + 1);
  for (let q = 0; q <= JMASK; q++) jit[q] = 0.65 + 0.7 * rnd();
  const jitter = o.jitter ?? 1;

  for (let it = 0; it < iters; it++) {
    if (it % fillEvery === 0 && (it === 0 || !o.fillOnce)) priorityFlood(h, res, isOut, h, order, 1e-3, heap, closed);
    const joff = (it * 7919) & JMASK;
    // receivers
    for (let k = 0; k < n; k++) {
      rcv[k] = k;
      if (isOut[k]) continue;
      const i = k % res;
      const j = (k - i) / res;
      const hk = h[k];
      let best = 0;
      let bk = k;
      let bd = 1;
      for (let d = 0; d < 8; d++) {
        const kk = (j + N8_DJ[d]) * res + i + N8_DI[d];
        let s = (hk - h[kk]) / N8_LEN[d];
        if (s <= 0) continue;
        if (jitter) s *= jit[(k * 8 + d + joff) & JMASK];
        if (s > best) {
          best = s;
          bk = kk;
          bd = N8_LEN[d];
        }
      }
      rcv[k] = bk;
      rlen[k] = bd * cell;
    }
    // donors + BFS stack (every cell after its receiver)
    ndon.fill(0);
    for (let k = 0; k < n; k++) {
      const r = rcv[k];
      if (r !== k) donors[r * 8 + ndon[r]++] = k;
    }
    let sp = 0;
    for (let k = 0; k < n; k++) if (rcv[k] === k) stack[sp++] = k;
    for (let p = 0; p < sp; p++) {
      const k = stack[p];
      const nd = ndon[k];
      for (let q = 0; q < nd; q++) stack[sp++] = donors[k * 8 + q];
    }
    // drainage area
    area.fill(cellA);
    for (let p = sp - 1; p >= 0; p--) {
      const k = stack[p];
      const r = rcv[k];
      if (r !== k) area[r] += area[k];
    }
    // implicit erosion + uplift
    for (let p = 0; p < sp; p++) {
      const k = stack[p];
      if (isOut[k]) continue;
      const r = rcv[k];
      const hu = h[k] + uplift[k];
      if (r === k) {
        h[k] = hu;
        continue;
      }
      const F = (K[k] * Math.exp(m * Math.log(area[k]))) / rlen[k];
      h[k] = (hu + F * h[r]) / (1 + F);
    }
    // talus (angle of repose) limit
    for (let p = 0; p < sp; p++) {
      const k = stack[p];
      if (isOut[k]) continue;
      const i = k % res;
      const j = (k - i) / res;
      let lim = 1e9;
      const tk = talusMap ? talus * talusMap[k] : talus;
      for (let d = 0; d < 8; d++) {
        const v = h[(j + N8_DJ[d]) * res + i + N8_DI[d]] + tk * N8_LEN[d];
        if (v < lim) lim = v;
      }
      if (h[k] > lim) h[k] = lim;
    }
    o.onIter?.(it);
  }
  return { area, rcv };
}
