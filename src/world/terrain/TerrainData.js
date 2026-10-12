import * as THREE from 'three';
import { mulberry32, createNoise2D, fbm, clamp, smoothstep } from '../../core/random.js';

/**
 * CPU-side island heightfield + hydrology. This is the single source of truth for
 * "where is the ground" used by physics, AI, props, water and the minimap.
 *
 * Grid convention: res × res samples, index = j * res + i,
 *   world x = (i / (res - 1) - 0.5) * size,  world z = (j / (res - 1) - 0.5) * size.
 * Sea level is y = 0. Units are metres.
 *
 * Public contract (others depend on it — keep signatures stable):
 *   size, res, cell, seaLevel, maxHeight
 *   heights: Float32Array, flow: Float32Array (0..1 river-ness), seaDist: Float32Array (m)
 *   heightAt(x, z)                 bilinear height (m)
 *   normalAt(x, z, out?)           THREE.Vector3 unit normal
 *   gradientAt(x, z, out?)         THREE.Vector2 (dh/dx, dh/dz)
 *   distToSea(x, z)                path distance to the coast along land (m), 0 at sea
 *   flowAt(x, z)                   0..1 accumulated flow (valleys/rivers ≈ 1)
 *   isLand(x, z)
 *   lakeSites   [{ x, z, radius, level, volume }]   still-water bodies (volume in litres)
 *   puddleSites [{ x, z, radius, level, volume }]   small ones
 *   peaks       [{ x, y, z }] sorted high → low  (drop targets, landmarks)
 *   heightTexture  THREE.DataTexture (RedFormat, FloatType) of `heights`, linear filtered
 */
export class TerrainData {
  constructor(ctx) {
    this.ctx = ctx;
    this.seed = ctx.params.seed;
    this.size = 12000;
    this.res = 513;
    this.cell = this.size / (this.res - 1);
    this.seaLevel = 0;
    this.maxHeight = 1400;
  }

  async init(onProgress = () => {}) {
    const { res, size } = this;
    const rand = mulberry32(this.seed);
    const n1 = createNoise2D(rand);
    const n2 = createNoise2D(rand);
    const n3 = createNoise2D(rand);
    const h = (this.heights = new Float32Array(res * res));

    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const u = i / (res - 1) - 0.5;
        const v = j / (res - 1) - 0.5;
        const wx = u + 0.08 * fbm(n2, u * 3, v * 3, 3);
        const wz = v + 0.08 * fbm(n2, u * 3 + 17, v * 3 - 9, 3);
        const r = Math.hypot(wx * 1.15, wz) * 2;
        const island = 1 - smoothstep(0.35, 1.0, r);
        const base = fbm(n1, wx * 4, wz * 4, 6) * 0.5 + 0.5;
        const ridge = 1 - Math.abs(fbm(n3, wx * 6, wz * 6, 5));
        const mountains = Math.pow(ridge, 2.2) * smoothstep(0.75, 0.1, r);
        let height = (island * (0.35 + base * 0.65) + mountains * 0.9 * island) * this.maxHeight * 0.75;
        height -= (1 - island) * 160 + 40;
        h[j * res + i] = height;
      }
      if ((j & 63) === 0) {
        onProgress((j / res) * 0.6);
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    onProgress(0.65, 'Trazando cauces');
    this.computeFlow();
    onProgress(0.8, 'Midiendo la distancia al mar');
    this.computeSeaDistance();
    onProgress(0.9, 'Buscando lagos');
    this.findSites(rand);

    this.heightTexture = new THREE.DataTexture(h, res, res, THREE.RedFormat, THREE.FloatType);
    this.heightTexture.magFilter = THREE.LinearFilter;
    this.heightTexture.minFilter = THREE.LinearFilter;
    this.heightTexture.needsUpdate = true;
    onProgress(1);
  }

  // --- sampling -----------------------------------------------------------

  toGrid(x, z) {
    return [(x / this.size + 0.5) * (this.res - 1), (z / this.size + 0.5) * (this.res - 1)];
  }

  sample(arr, x, z) {
    const res = this.res;
    let [gx, gz] = this.toGrid(x, z);
    gx = clamp(gx, 0, res - 1.001);
    gz = clamp(gz, 0, res - 1.001);
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const k = j * res + i;
    const a = arr[k];
    const b = arr[k + 1];
    const c = arr[k + res];
    const d = arr[k + res + 1];
    return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
  }

  heightAt(x, z) {
    return this.sample(this.heights, x, z);
  }

  gradientAt(x, z, out = new THREE.Vector2()) {
    const e = this.cell * 0.5;
    return out.set(
      (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e),
      (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e),
    );
  }

  normalAt(x, z, out = new THREE.Vector3()) {
    const g = this.gradientAt(x, z, _g);
    return out.set(-g.x, 1, -g.y).normalize();
  }

  distToSea(x, z) {
    if (!this.isLand(x, z)) return 0;
    return this.sample(this.seaDist, x, z);
  }

  flowAt(x, z) {
    return this.sample(this.flow, x, z);
  }

  isLand(x, z) {
    return this.heightAt(x, z) > this.seaLevel;
  }

  // --- hydrology ----------------------------------------------------------

  computeFlow() {
    const { res, heights } = this;
    const n = res * res;
    const order = new Uint32Array(n);
    for (let k = 0; k < n; k++) order[k] = k;
    order.sort((a, b) => heights[b] - heights[a]);
    const acc = new Float32Array(n).fill(1);
    for (const k of order) {
      const i = k % res;
      const j = (k / res) | 0;
      let best = -1;
      let bestH = heights[k];
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= res || jj >= res) continue;
          const kk = jj * res + ii;
          if (heights[kk] < bestH) {
            bestH = heights[kk];
            best = kk;
          }
        }
      }
      if (best >= 0) acc[best] += acc[k];
    }
    const flow = (this.flow = new Float32Array(n));
    const maxLog = Math.log(n);
    for (let k = 0; k < n; k++) flow[k] = clamp(Math.log(acc[k]) / (maxLog * 0.6), 0, 1);
  }

  computeSeaDistance() {
    const { res, heights, cell } = this;
    const n = res * res;
    const dist = (this.seaDist = new Float32Array(n).fill(Infinity));
    // Dial's-style bucket queue is overkill here; a binary heap is plenty for 263k cells.
    const heap = new MinHeap(n);
    for (let k = 0; k < n; k++) {
      if (heights[k] <= this.seaLevel) {
        dist[k] = 0;
        heap.push(k, 0);
      }
    }
    const diag = cell * Math.SQRT2;
    while (heap.size) {
      const k = heap.pop();
      const d0 = dist[k];
      const i = k % res;
      const j = (k / res) | 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= res || jj >= res) continue;
          const kk = jj * res + ii;
          const nd = d0 + (di && dj ? diag : cell);
          if (nd < dist[kk]) {
            dist[kk] = nd;
            heap.push(kk, nd);
          }
        }
      }
    }
  }

  findSites(rand) {
    const { res, heights } = this;
    const lakes = [];
    const puddles = [];
    const peaks = [];
    const R = 6;
    for (let j = R; j < res - R; j += 3) {
      for (let i = R; i < res - R; i += 3) {
        const k = j * res + i;
        const hk = heights[k];
        if (hk < 30) continue;
        let isMin = true;
        let isMax = true;
        for (let dj = -R; dj <= R && (isMin || isMax); dj++) {
          for (let di = -R; di <= R; di++) {
            const hh = heights[(j + dj) * res + i + di];
            if (hh < hk) isMin = false;
            if (hh > hk) isMax = false;
          }
        }
        const x = (i / (res - 1) - 0.5) * this.size;
        const z = (j / (res - 1) - 0.5) * this.size;
        if (isMax && hk > this.maxHeight * 0.35) peaks.push({ x, y: hk, z });
        if (isMin) {
          const big = rand() < 0.45;
          const radius = big ? 70 + rand() * 90 : 15 + rand() * 20;
          const site = { x, z, radius, level: hk + 2, volume: Math.round(radius * radius * Math.PI * (big ? 6 : 1.5) * 1000) };
          (big ? lakes : puddles).push(site);
        }
      }
    }
    peaks.sort((a, b) => b.y - a.y);
    this.lakeSites = lakes;
    this.puddleSites = puddles;
    this.peaks = peaks;
  }
}

const _g = new THREE.Vector2();

class MinHeap {
  constructor(cap) {
    this.keys = new Uint32Array(cap * 4);
    this.vals = new Float32Array(cap * 4);
    this.size = 0;
  }
  push(k, v) {
    let i = this.size++;
    if (i >= this.keys.length) {
      const nk = new Uint32Array(this.keys.length * 2);
      nk.set(this.keys);
      const nv = new Float32Array(this.vals.length * 2);
      nv.set(this.vals);
      this.keys = nk;
      this.vals = nv;
    }
    const { keys, vals } = this;
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
    const { keys, vals } = this;
    const top = keys[0];
    const k = keys[--this.size];
    const v = vals[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && vals[c + 1] < vals[c]) c++;
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
