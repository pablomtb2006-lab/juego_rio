// Island generator: designed massif + stream-power (fluvial) erosion cascade, valley
// widening, coast shaping, depression filling, sculpted lakes/puddles, hydrology (MFD flow,
// distance to sea), peaks and the auxiliary maps the renderer needs.
// Pure JS (no THREE) so it runs inside a module Web Worker (terrain.worker.js) or in Node.
// Deterministic for a given seed.

import { mulberry32, createNoise2D } from '../../../core/random.js';
import { MinHeap, N8_DI, N8_DJ, sampleBicubic, sampleBilinear, chamferDistance, priorityFlood, blur } from './grid.js';
import { streamPower } from './spl.js';
import { makeDesign } from './design.js';
import { fbm, ridged, sstep, clamp01 } from './noise.js';
import { mfdAccumulation, widenValleys } from './hydro.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Resample a res0 grid to res1 (bicubic or bilinear). */
function resample(src, res0, res1, cubic = true) {
  const out = new Float32Array(res1 * res1);
  const sc = (res0 - 1) / (res1 - 1);
  const f = cubic ? sampleBicubic : sampleBilinear;
  for (let j = 0; j < res1; j++) for (let i = 0; i < res1; i++) out[j * res1 + i] = f(src, res0, i * sc, j * sc);
  return out;
}

/** IEEE half-float bits for a float (for RGBA16F texture data built off the main thread). */
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
export function toHalf(v) {
  _f32[0] = v;
  const x = _u32[0];
  const sign = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (e <= 0) {
    if (e < -10) return sign;
    m = (m | 0x800000) >> (1 - e);
    return sign | ((m + 0x1000) >> 13);
  }
  if (e >= 31) return sign | 0x7c00;
  return sign | (e << 10) | ((m + 0x1000) >> 13);
}

/**
 * @param {{seed:number,size:number,res:number,maxHeight:number}} opts
 * @param {(p:number,label?:string)=>void} progress
 */
export function generateTerrain(opts, progress = () => {}) {
  const T = { t0: now() };
  const lap = (name) => {
    const t = now();
    T[name] = Math.round(t - (T.last ?? T.t0));
    T.last = t;
  };
  const { seed, size, res } = opts;
  const H = opts.maxHeight;
  const rand = mulberry32(seed * 7919 + 13);
  const D = makeDesign(size, rand);
  const nRough = createNoise2D(rand);
  const nCoast = createNoise2D(rand);
  const nSea = createNoise2D(rand);
  const nIsle = createNoise2D(rand);
  const nSite = createNoise2D(rand);
  const nBiome = createNoise2D(rand);
  const nAlp = createNoise2D(rand);
  const siteRand = mulberry32(seed * 104729 + 3);

  // ---------------------------------------------------------------------------------
  // 1) Design on the coarse grid
  // ---------------------------------------------------------------------------------
  progress(0.02, 'Levantando la isla');
  const R0 = 257;
  const c0 = size / (R0 - 1);
  const n0 = R0 * R0;
  const land0 = new Float32Array(n0);
  const relief0 = new Float32Array(n0);
  const K0 = new Float32Array(n0);
  for (let j = 0; j < R0; j++) {
    const z = (j / (R0 - 1) - 0.5) * size;
    for (let i = 0; i < R0; i++) land0[j * R0 + i] = D.landAt((i / (R0 - 1) - 0.5) * size, z);
  }
  const sea0 = new Uint8Array(n0);
  for (let k = 0; k < n0; k++) sea0[k] = land0[k] <= 0 ? 1 : 0;
  const dIn0 = chamferDistance(sea0, R0, c0);
  for (let j = 0; j < R0; j++) {
    const z = (j / (R0 - 1) - 0.5) * size;
    for (let i = 0; i < R0; i++) {
      const k = j * R0 + i;
      const x = (i / (R0 - 1) - 0.5) * size;
      relief0[k] = sea0[k] ? 0 : D.reliefAt(x, z, dIn0[k]);
      K0[k] = D.erodibilityAt(x, z);
    }
  }
  lap('design');

  // ---------------------------------------------------------------------------------
  // 2) Stream-power erosion cascade 257 → 513
  // ---------------------------------------------------------------------------------
  progress(0.05, 'Tallando valles');
  const U0 = opts.splU ?? 0.012;
  const KDT = opts.splK ?? 0.08;
  const levels = opts.levels ?? [
    { res: 257, iters: 50 },
    { res: 513, iters: 10 },
  ];
  let h = null;
  let hres = 0;
  let lastArea = null;
  let lastSea = null;
  for (let L = 0; L < levels.length; L++) {
    const lr = levels[L].res;
    const cell = size / (lr - 1);
    const n = lr * lr;
    const relief = lr === R0 ? relief0 : resample(relief0, R0, lr, false);
    const Kc = lr === R0 ? K0 : resample(K0, R0, lr, false);
    const landL = lr === R0 ? land0 : resample(land0, R0, lr, false);
    const sea = new Uint8Array(n);
    for (let k = 0; k < n; k++) sea[k] = landL[k] <= 0 ? 1 : 0;
    const U = new Float32Array(n);
    const Kk = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      U[k] = U0 * relief[k] * H;
      Kk[k] = KDT * Kc[k];
    }
    if (!h) {
      h = new Float32Array(n);
      for (let j = 0; j < lr; j++) {
        for (let i = 0; i < lr; i++) {
          const k = j * lr + i;
          const x = (i / (lr - 1) - 0.5) * size;
          const z = (j / (lr - 1) - 0.5) * size;
          const rough = 0.5 + 0.5 * fbm(nRough, x / 900, z / 900, 4, 2, 0.6);
          h[k] = sea[k] ? 0 : relief[k] * H * (0.7 + 0.3 * rough);
        }
      }
    } else {
      h = resample(h, hres, lr, true);
      const amp = 6 * (cell / 40);
      for (let j = 0; j < lr; j++) {
        for (let i = 0; i < lr; i++) {
          const k = j * lr + i;
          if (sea[k]) {
            h[k] = 0;
            continue;
          }
          const x = (i / (lr - 1) - 0.5) * size;
          const z = (j / (lr - 1) - 0.5) * size;
          h[k] += amp * fbm(nRough, x / (cell * 6), z / (cell * 6), 2);
        }
      }
    }
    hres = lr;
    const talusMap = new Float32Array(n);
    for (let j = 0; j < lr; j++) {
      for (let i = 0; i < lr; i++) {
        const x = (i / (lr - 1) - 0.5) * size;
        const z = (j / (lr - 1) - 0.5) * size;
        talusMap[j * lr + i] = 1 + 0.35 * fbm(nRough, x / 700 + 40, z / 700 - 13, 3);
      }
    }
    const base = 0.05 + 0.3 * (L / levels.length);
    const r = streamPower(h, lr, cell, sea, U, Kk, {
      iters: levels[L].iters,
      m: 0.32,
      talus: 0.8,
      fillEvery: L === 0 ? 8 : 5,
      talusMap,
      seed: seed + L * 101,
      onIter: (it) => progress(base + (0.3 / levels.length) * (it / levels[L].iters), 'Tallando valles'),
    });
    lastArea = r.area;
    lastSea = sea;
    lap(`spl${lr}`);
  }
  // normalise land relief to the target max height
  {
    let mx = 0;
    for (let k = 0; k < h.length; k++) if (h[k] > mx) mx = h[k];
    T.rawMax = Math.round(mx);
    const s = (H * 0.985) / mx;
    for (let k = 0; k < h.length; k++) h[k] *= s;
  }

  // ---------------------------------------------------------------------------------
  // 3) Valley floors, upsample to the final grid
  // ---------------------------------------------------------------------------------
  progress(0.38, 'Abriendo valles');
  widenValleys(h, hres, size / (hres - 1), lastArea, lastSea, { aMin: 1.2e6, w: 60, wMax: 300 });
  lap('widen');
  const n = res * res;
  const cell = size / (res - 1);
  const heights = resample(h, hres, res, true);
  const areaCoarse = resample(lastArea, hres, res, false);
  const landF = resample(land0, R0, res, false);
  const isSeaF = new Uint8Array(n);
  const isLandF = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    isSeaF[k] = landF[k] <= 0 ? 1 : 0;
    isLandF[k] = 1 - isSeaF[k];
  }
  const dInF = chamferDistance(isSeaF, res, cell);
  const dOutF = chamferDistance(isLandF, res, cell);
  const coastIn = new Float32Array(n);
  for (let k = 0; k < n; k++) coastIn[k] = isSeaF[k] ? -dOutF[k] : dInF[k];
  lap('upsample');

  // alpine ruggedness: jagged crests, gullies and buttresses on the high ground
  {
    const RA = 513;
    const alp0 = new Float32Array(RA * RA);
    for (let j = 0; j < RA; j++) {
      const z = (j / (RA - 1) - 0.5) * size;
      for (let i = 0; i < RA; i++) {
        const x = (i / (RA - 1) - 0.5) * size;
        const r1 = ridged(nAlp, x / 900, z / 900, 4, 2.1, 0.5);
        const r2 = ridged(nAlp, x / 330 + 17, z / 330 - 5, 2, 2.1, 0.5);
        alp0[j * RA + i] = (r1 - 0.42) * 1.0 + (r2 - 0.42) * 0.35;
      }
    }
    const alp = resample(alp0, RA, res, true);
    for (let k = 0; k < n; k++) {
      const hk = heights[k];
      if (hk < 500) continue;
      const w = sstep(500, 1500, hk);
      heights[k] = hk + alp[k] * 110 * w;
    }
  }
  lap('alpine');

  // terraces: stylised cliff bands across the mid-slopes. Rivers crossing them fall as
  // waterfalls; the flat treads between them are where lakes and forests settle.
  {
    const I = 135; // tread + riser height (m)
    for (let j = 0; j < res; j++) {
      const z = (j / (res - 1) - 0.5) * size;
      for (let i = 0; i < res; i++) {
        const k = j * res + i;
        const hk = heights[k];
        if (hk < 110 || hk > 1650) continue;
        const x = (i / (res - 1) - 0.5) * size;
        const band = sstep(110, 240, hk) * sstep(1650, 1350, hk);
        // terraces come in regions (mesas, canyon steps), not as rings over the whole island
        const region = sstep(0.08, 0.38, fbm(nBiome, x / 2600 + 31, z / 2600 - 12, 2));
        const w = band * region * 0.85;
        if (w <= 0.001) continue;
        const off = fbm(nAlp, x / 1500 + 40, z / 1500 - 9, 2) * I * 0.6;
        const v = (hk + off) / I;
        const fl = Math.floor(v);
        const terr = (fl + sstep(0.84, 1.0, v - fl)) * I - off;
        heights[k] = hk + (terr - hk) * w;
      }
    }
  }
  lap('terraces');

  // ---------------------------------------------------------------------------------
  // 4) Coast: beaches in bays, cliffs on headlands, shelf, islets
  // ---------------------------------------------------------------------------------
  progress(0.44, 'Dibujando la costa');
  const beachMap = new Float32Array(n);
  const coastN0 = new Float32Array(n0);
  for (let j = 0; j < R0; j++) {
    for (let i = 0; i < R0; i++) {
      coastN0[j * R0 + i] = fbm(nCoast, ((i / (R0 - 1) - 0.5) * size) / 2600, ((j / (R0 - 1) - 0.5) * size) / 2600, 3);
    }
  }
  const coastN = resample(coastN0, R0, res, false);
  for (let j = 0; j < res; j++) {
    const z = (j / (res - 1) - 0.5) * size;
    for (let i = 0; i < res; i++) {
      const k = j * res + i;
      const x = (i / (res - 1) - 0.5) * size;
      const d = coastIn[k];
      // coast character: smooth noise along the shore
      const cn = coastN[k];
      const cliff = sstep(0.0, 0.25, cn);
      const beach = sstep(-0.05, -0.3, cn);
      beachMap[k] = beach;
      if (d <= 0) {
        const off = -d;
        let floor = -(1.2 + 16 * sstep(0, 320, off) + 55 * sstep(150, 1600, off) + 110 * sstep(1200, 4500, off));
        if (off < 1500) floor += 4 * fbm(nSea, x / 600, z / 600, 2) * sstep(0, 250, off);
        floor -= cliff * 10 * sstep(0, 60, off);
        // rocky islets off the cliffs
        const isleMask = cliff * sstep(900, 250, off);
        if (isleMask > 0.3) {
          const isle = 0.5 + 0.5 * nIsle(x / 260, z / 260);
          const v = (isle - 0.9) * 900 * isleMask - off * 0.01;
          if (v > floor) floor = v;
        }
        heights[k] = floor;
      } else {
        let hv = heights[k];
        // guarantee a clean shoreline and a little rise inland
        hv = Math.max(hv, 0.6 + d * 0.012);
        // beaches: gentle sand slope
        if (beach > 0 && d < 260) {
          const bp = 0.5 + d * 0.022;
          const w = beach * sstep(260, 120, d);
          hv += (Math.min(hv, bp) - hv) * w;
          hv = Math.max(hv, 0.4 + d * 0.004);
        }
        // cliffs: steep rise right at the water
        if (cliff > 0 && d < 400) {
          const ch = 18 + 50 * clamp01(0.5 + fbm(nCoast, x / 900 + 3, z / 900, 2));
          const cp = ch * sstep(0, 55, d) + d * 0.05;
          if (cp > hv) hv += (cp - hv) * cliff * sstep(400, 200, d);
        }
        heights[k] = hv;
      }
    }
  }
  lap('coast');

  // ---------------------------------------------------------------------------------
  // 5) Summit pad (arch landmark), depression filling
  // ---------------------------------------------------------------------------------
  progress(0.5, 'Llenando cuencas');
  {
    let best = 0;
    for (let k = 1; k < n; k++) if (heights[k] > heights[best]) best = k;
    const bi = best % res;
    const bj = (best - bi) / res;
    const top = heights[best];
    const R = Math.ceil(130 / cell);
    for (let dj = -R; dj <= R; dj++) {
      for (let di = -R; di <= R; di++) {
        const d = Math.hypot(di, dj) * cell;
        if (d > 130) continue;
        const k = (bj + dj) * res + bi + di;
        const pad = top - 1.5 - 9 * Math.pow(d / 100, 2);
        const w = sstep(130, 70, d);
        if (pad > heights[k]) heights[k] += (pad - heights[k]) * w;
      }
    }
  }
  const order = new Int32Array(n);
  const heap = new MinHeap(res * 16);
  const closed = new Uint8Array(n);
  const isOut = new Uint8Array(n);
  lap('summit');

  // ---------------------------------------------------------------------------------
  // 6) Lakes and puddles along the drainage network
  // ---------------------------------------------------------------------------------
  progress(0.56, 'Buscando lagos');
  const lakeMask = new Uint8Array(n); // 255 = water, ramps on the shore
  const lakeSites = [];
  const puddleSites = [];
  {
    const probe = (k, rCells) => {
      const i = k % res;
      const j = (k - i) / res;
      let mn = 1e9;
      let mx = -1e9;
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * Math.PI * 2;
        for (const f of [0.5, 1]) {
          const ii = Math.round(i + Math.cos(ang) * rCells * f);
          const jj = Math.round(j + Math.sin(ang) * rCells * f);
          if (ii < 0 || jj < 0 || ii >= res || jj >= res) return 1e9;
          const v = heights[jj * res + ii];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
      }
      return mx - mn;
    };
    const cands = [];
    for (let j = 8; j < res - 8; j += 3) {
      for (let i = 8; i < res - 8; i += 3) {
        const k = j * res + i;
        if (heights[k] < 25 || coastIn[k] < 450) continue;
        if (areaCoarse[k] < 6e4) continue;
        cands.push(k);
      }
    }
    const placed = [];
    const far = (x, z, minD) => {
      for (const p of placed) if ((p.x - x) ** 2 + (p.z - z) ** 2 < (minD + p.r) ** 2) return false;
      return true;
    };
    // lakes
    const scored = [];
    for (const k of cands) {
      const A = areaCoarse[k];
      if (A < 1.5e5) continue;
      const slope = probe(k, 140 / cell) / 280;
      if (slope > 0.11) continue;
      const i = k % res;
      const j = (k - i) / res;
      const x = (i / (res - 1) - 0.5) * size;
      const z = (j / (res - 1) - 0.5) * size;
      const alt = heights[k] / H;
      const score =
        (1 - slope / 0.11) *
        (1 + 0.25 * Math.log10(A / 1.5e5)) *
        (0.8 + 0.6 * sstep(0.1, 0.5, alt)) *
        (0.75 + 0.25 * (1 + nSite(x / 1500, z / 1500)));
      scored.push([score, k, slope]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const lakeTarget = opts.lakes ?? 34;
    for (const [, k, slope] of scored) {
      if (lakeSites.length >= lakeTarget) break;
      const i = k % res;
      const j = (k - i) / res;
      const x = (i / (res - 1) - 0.5) * size;
      const z = (j / (res - 1) - 0.5) * size;
      const R = Math.round(75 + 150 * clamp01(1 - slope / 0.11) * (0.55 + 0.45 * siteRand()));
      if (!far(x, z, 650 + R)) continue;
      const site = sculptLake(heights, res, size, cell, x, z, R, 6 + siteRand() * 7, lakeMask, siteRand);
      if (!site) continue;
      placed.push({ x, z, r: R });
      lakeSites.push(site);
    }
    // puddles: smaller, denser, also on steeper ground
    const pScored = [];
    for (const k of cands) {
      const slope = probe(k, 45 / cell) / 90;
      if (slope > 0.16) continue;
      pScored.push([(1 - slope / 0.16) * (0.6 + 0.4 * siteRand()), k]);
    }
    pScored.sort((a, b) => b[0] - a[0]);
    const puddleTarget = opts.puddles ?? 120;
    for (const [, k] of pScored) {
      if (puddleSites.length >= puddleTarget) break;
      const i = k % res;
      const j = (k - i) / res;
      const x = (i / (res - 1) - 0.5) * size;
      const z = (j / (res - 1) - 0.5) * size;
      const R = Math.round(24 + 20 * siteRand());
      if (!far(x, z, 230 + R)) continue;
      const site = sculptLake(heights, res, size, cell, x, z, R, 1.6 + siteRand() * 1.4, lakeMask, siteRand);
      if (!site) continue;
      placed.push({ x, z, r: R });
      puddleSites.push(site);
    }
  }
  lap('lakes');

  // ---------------------------------------------------------------------------------
  // 7) Hydrology on the final surface: MFD flow (routing through lakes), sea distance
  // ---------------------------------------------------------------------------------
  progress(0.68, 'Trazando cauces');
  const routed = new Float32Array(n);
  for (let k = 0; k < n; k++) isOut[k] = heights[k] <= 0 ? 1 : 0;
  const cnt = priorityFlood(heights, res, isOut, routed, order, 0.004, heap, closed);
  // fill every natural pit except the sculpted lakes/puddles
  for (let k = 0; k < n; k++) if (lakeMask[k] !== 255) heights[k] = routed[k];
  const area = mfdAccumulation(routed, res, cell, order, cnt, 1);
  const flow = new Float32Array(n);
  {
    const l0 = Math.log(3e4);
    const l1 = Math.log(2.5e7);
    for (let k = 0; k < n; k++) flow[k] = heights[k] <= 0 ? 0 : clamp01((Math.log(area[k]) - l0) / (l1 - l0));
    blur(flow, res, 1, 1);
  }
  const seaSrc = new Uint8Array(n);
  for (let k = 0; k < n; k++) seaSrc[k] = heights[k] <= 0 ? 1 : 0;
  const seaDist = chamferDistance(seaSrc, res, cell);
  lap('hydro');

  // ---------------------------------------------------------------------------------
  // 8) Peaks
  // ---------------------------------------------------------------------------------
  const peaks = [];
  {
    const cand = [];
    for (let j = 2; j < res - 2; j += 2) {
      for (let i = 2; i < res - 2; i += 2) {
        const k = j * res + i;
        const hk = heights[k];
        if (hk < H * 0.3) continue;
        let isMax = true;
        for (let d = 0; d < 8 && isMax; d++) if (heights[k + N8_DJ[d] * res * 2 + N8_DI[d] * 2] > hk) isMax = false;
        if (isMax) cand.push(k);
      }
    }
    cand.sort((a, b) => heights[b] - heights[a]);
    const minD = 850;
    for (const k of cand) {
      const i = k % res;
      const j = (k - i) / res;
      const x = (i / (res - 1) - 0.5) * size;
      const z = (j / (res - 1) - 0.5) * size;
      if (peaks.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < minD * minD)) continue;
      peaks.push({ x, y: heights[k], z });
      if (peaks.length >= 24) break;
    }
  }
  lap('peaks');

  // ---------------------------------------------------------------------------------
  // 9) Renderer maps: gradient/flow/AO (RGBA16F) and detail/coast/water/biome (RGBA8)
  // ---------------------------------------------------------------------------------
  progress(0.8, 'Pintando el terreno');
  const ao = computeAO(heights, res, size, cell);
  const biome0 = new Float32Array(n0);
  for (let j = 0; j < R0; j++) {
    for (let i = 0; i < R0; i++) {
      biome0[j * R0 + i] = 0.5 + 0.5 * fbm(nBiome, ((i / (R0 - 1) - 0.5) * size) / 1100, ((j / (R0 - 1) - 0.5) * size) / 1100, 4);
    }
  }
  const biome = resample(biome0, R0, res, true);
  const info = new Uint16Array(n * 4);
  const mask = new Uint8Array(n * 4);
  const inv2c = 1 / (2 * cell);
  for (let j = 0; j < res; j++) {
    const z = (j / (res - 1) - 0.5) * size;
    const jm = j > 0 ? j - 1 : 0;
    const jp = j < res - 1 ? j + 1 : res - 1;
    for (let i = 0; i < res; i++) {
      const k = j * res + i;
      const x = (i / (res - 1) - 0.5) * size;
      const im = i > 0 ? i - 1 : 0;
      const ip = i < res - 1 ? i + 1 : res - 1;
      const gx = (heights[j * res + ip] - heights[j * res + im]) * inv2c;
      const gz = (heights[jp * res + i] - heights[jm * res + i]) * inv2c;
      info[k * 4] = toHalf(gx);
      info[k * 4 + 1] = toHalf(gz);
      info[k * 4 + 2] = toHalf(flow[k]);
      info[k * 4 + 3] = toHalf(ao[k]);
      const slope = Math.hypot(gx, gz);
      const hk = heights[k];
      // detail amplitude: rocky slopes ≫ meadows; none in channels, water, beaches, sea
      let amp = 0.25 + 0.75 * sstep(0.25, 0.85, slope);
      amp *= 1 - sstep(0.35, 0.7, flow[k]);
      amp *= sstep(2, 14, hk);
      amp *= 1 - lakeMask[k] / 255;
      amp *= 1 - beachMap[k] * sstep(60, 0, hk);
      mask[k * 4] = Math.round(clamp01(amp) * 255);
      // coast proximity (orange coastal rock, wet sand)
      const cd = coastIn[k];
      mask[k * 4 + 1] = cd < -600 ? 0 : Math.round(clamp01(1 - cd / 900) * 255);
      mask[k * 4 + 2] = lakeMask[k];
      // biome: forest-ness (lowland/mid, gentle, not near snow) with patchy noise
      const fn = biome[k];
      let forest = sstep(0.45, 0.62, fn) * sstep(1150, 800, hk) * sstep(20, 60, hk) * sstep(0.75, 0.4, slope);
      forest *= 1 - beachMap[k] * sstep(120, 20, cd);
      mask[k * 4 + 3] = Math.round(clamp01(forest) * 255);
    }
  }
  lap('maps');
  T.total = Math.round(now() - T.t0);
  delete T.last;
  delete T.t0;
  progress(1, 'Isla lista');
  return { size, res, cell, heights, flow, seaDist, coastIn, info, mask, lakeSites, puddleSites, peaks, timings: T };
}

/**
 * Sculpt a round-ish basin whose water surface (level) meets the shore at a noisy radius
 * ≤ R·1.1; terrain outside is raised to at least the level (a natural lip / dam).
 * Returns the site or null if the spot is unsuitable.
 */
function sculptLake(h, res, size, cell, x, z, R, depth, lakeMask, rnd) {
  const ci = (x / size + 0.5) * (res - 1);
  const cj = (z / size + 0.5) * (res - 1);
  const RO = R * 1.1 + 70;
  const rc = Math.ceil(RO / cell) + 1;
  const i0 = Math.round(ci);
  const j0 = Math.round(cj);
  if (i0 - rc < 1 || j0 - rc < 1 || i0 + rc >= res - 1 || j0 + rc >= res - 1) return null;
  let ringMin = 1e9;
  let ringMax = -1e9;
  for (let a = 0; a < 24; a++) {
    const ang = (a / 24) * Math.PI * 2;
    const v = h[Math.round(cj + (Math.sin(ang) * R) / cell) * res + Math.round(ci + (Math.cos(ang) * R) / cell)];
    if (v < ringMin) ringMin = v;
    if (v > ringMax) ringMax = v;
  }
  const centre = h[j0 * res + i0];
  if (ringMin <= 3) return null;
  // level: a little above the lowest point of the rim → modest cut on the uphill side
  const level = Math.max(centre + 0.8, ringMin + 0.6 + (ringMax - ringMin) * 0.25);
  if (level - centre > depth + 12) return null;
  const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
  const shoreR = (ang) => R * (1 + 0.07 * Math.sin(ang * 2 + ph[0]) + 0.05 * Math.sin(ang * 3 + ph[1]) - 0.03 * Math.sin(ang * 5 + ph[2]) - 0.05);
  let vol = 0;
  for (let dj = -rc; dj <= rc; dj++) {
    for (let di = -rc; di <= rc; di++) {
      const ii = i0 + di;
      const jj = j0 + dj;
      const dx = (ii / (res - 1) - 0.5) * size - x;
      const dz = (jj / (res - 1) - 0.5) * size - z;
      const d = Math.hypot(dx, dz);
      if (d > RO) continue;
      const k = jj * res + ii;
      const rn = shoreR(Math.atan2(dz, dx));
      if (d < rn) {
        const t = d / rn;
        const bed = level - 0.5 - depth * Math.pow(1 - t * t, 0.75);
        if (h[k] > bed) h[k] = bed;
        vol += (level - h[k]) * cell * cell;
        lakeMask[k] = 255;
      } else {
        const e = d - rn;
        // lip rising to level+2 within 25 m, then an outer slope back down to the terrain
        const lip = e < 25 ? level + 0.35 + e * 0.07 : level + 2.1 - (e - 25) * 0.22;
        if (h[k] < lip) h[k] = lip;
        const wet = Math.round(255 * Math.max(0, 1 - e / 22) * 0.75);
        if (wet > lakeMask[k]) lakeMask[k] = wet;
      }
    }
  }
  return { x, z, radius: Math.round(R * 1.1 * 10) / 10, level, volume: Math.round(vol * 1000) };
}

/** Sky-visibility AO from horizon angles on a reduced grid + local cavity term. 0 = occluded, 1 = open. */
function computeAO(h, res, size, cell) {
  const RA = 257;
  const step = (res - 1) / (RA - 1);
  const ca = size / (RA - 1);
  const hs = new Float32Array(RA * RA);
  for (let j = 0; j < RA; j++) for (let i = 0; i < RA; i++) hs[j * RA + i] = Math.max(0, h[Math.round(j * step) * res + Math.round(i * step)]);
  const aoS = new Float32Array(RA * RA);
  const DIRS = 12;
  const dirs = [];
  for (let d = 0; d < DIRS; d++) dirs.push([Math.cos((d / DIRS) * Math.PI * 2), Math.sin((d / DIRS) * Math.PI * 2)]);
  const dists = [1, 2, 3, 5, 8, 12, 17];
  for (let j = 0; j < RA; j++) {
    for (let i = 0; i < RA; i++) {
      const h0 = hs[j * RA + i] + 2;
      let occ = 0;
      for (const [dx, dz] of dirs) {
        let maxT = 0;
        for (const s of dists) {
          const ii = Math.round(i + dx * s);
          const jj = Math.round(j + dz * s);
          if (ii < 0 || jj < 0 || ii >= RA || jj >= RA) break;
          const t = (hs[jj * RA + ii] - h0) / (s * ca);
          if (t > maxT) maxT = t;
        }
        occ += maxT / Math.sqrt(1 + maxT * maxT); // sin(horizon elevation)
      }
      aoS[j * RA + i] = 1 - occ / DIRS;
    }
  }
  const out = new Float32Array(res * res);
  const sc = (RA - 1) / (res - 1);
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const k = j * res + i;
      let v = sampleBilinear(aoS, RA, i * sc, j * sc);
      // local concavity (laplacian over ±2 cells) darkens creases, brightens crests
      if (i > 1 && j > 1 && i < res - 2 && j < res - 2) {
        const lap = (h[k - 2] + h[k + 2] + h[k - 2 * res] + h[k + 2 * res] - 4 * h[k]) / (4 * cell * cell);
        v *= 1 - clamp01(lap * 180) * 0.35;
        v = Math.min(1, v + clamp01(-lap * 120) * 0.08);
      }
      out[k] = clamp01(v);
    }
  }
  return out;
}
