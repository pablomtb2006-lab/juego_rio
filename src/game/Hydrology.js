import * as THREE from 'three';

const SQRT2 = Math.SQRT2;
const NB_DI = [1, -1, 0, 0, 1, 1, -1, -1];
const NB_DJ = [0, 0, 1, -1, 1, -1, 1, -1];

/**
 * Game-side hydrology, derived once from TerrainData (pure contract: res, size,
 * heights, seaLevel). Everything the river physics, the AI and the camera need
 * to "think like water":
 *
 *  - filled      water surface after a priority-flood: every closed basin is filled up
 *                to its spill level, so water entering a lake fills it and spills over
 *                its lowest outlet — nothing can get stuck in a pit.
 *  - parent      downstream cell of each cell (D8 on the filled surface; inside flats
 *                the pointers run breadth-first towards the outlet). Following it
 *                from anywhere always ends in the sea.
 *  - routeDist   metres along that drainage route to the sea ("KM TO SEA").
 *  - acc         upstream area in cells (big = valley floor / main river).
 *  - dirX/dirZ   smooth "pure-pursuit" flow direction: unit vector from a cell to the
 *                point a few cells downstream. Sampling it bilinearly gives a field that
 *                pulls water onto valley floors and along them.
 */
export class Hydrology {
  constructor(terrain) {
    this.terrain = terrain;
    this.res = terrain.res;
    this.size = terrain.size;
    this.cell = terrain.size / (terrain.res - 1);
    this.seaLevel = terrain.seaLevel ?? 0;
    this.build();
  }

  build() {
    const { res, cell, seaLevel } = this;
    const n = res * res;
    const t = this.terrain;
    let H = t.heights;
    if (!H || H.length !== n) {
      H = new Float32Array(n);
      for (let j = 0; j < res; j++) {
        for (let i = 0; i < res; i++) H[j * res + i] = t.heightAt(...this.toWorld(i, j));
      }
    }
    this.H = H;
    const filled = (this.filled = new Float32Array(n));
    const parent = (this.parent = new Int32Array(n).fill(-1));
    const dist = (this.routeDist = new Float32Array(n));
    const closed = new Uint8Array(n);
    const order = new Int32Array(n);
    let on = 0;
    const heap = new MinHeap(n);
    const pit = new Int32Array(n);
    let ph = 0;
    let pt = 0;

    // seeds: the sea and the world border
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const k = j * res + i;
        const border = i === 0 || j === 0 || i === res - 1 || j === res - 1;
        if (H[k] <= seaLevel || border) {
          filled[k] = Math.min(H[k], seaLevel);
          closed[k] = 1;
          order[on++] = k;
          dist[k] = 0;
          heap.push(k, filled[k]);
        }
      }
    }

    const EPS = 1e-4;
    while (ph < pt || heap.size) {
      const c = ph < pt ? pit[ph++] : heap.pop();
      const ci = c % res;
      const cj = (c / res) | 0;
      const fc = filled[c];
      for (let q = 0; q < 8; q++) {
        const ii = ci + NB_DI[q];
        const jj = cj + NB_DJ[q];
        if (ii < 0 || jj < 0 || ii >= res || jj >= res) continue;
        const nb = jj * res + ii;
        if (closed[nb]) continue;
        closed[nb] = 1;
        parent[nb] = c;
        order[on++] = nb;
        dist[nb] = dist[c] + (q < 4 ? cell : cell * SQRT2);
        if (H[nb] <= fc + EPS) {
          filled[nb] = fc + EPS;
          pit[pt++] = nb;
        } else {
          filled[nb] = H[nb];
          heap.push(nb, H[nb]);
        }
      }
    }

    // upstream area (cells), processed leaves → root
    const acc = (this.acc = new Float32Array(n).fill(1));
    for (let o = on - 1; o >= 0; o--) {
      const k = order[o];
      const p = parent[k];
      if (p >= 0) acc[p] += acc[k];
    }
    let maxAcc = 1;
    for (let k = 0; k < n; k++) if (H[k] > seaLevel && acc[k] > maxAcc) maxAcc = acc[k];
    this.maxAcc = maxAcc;

    // pure-pursuit flow direction (a few cells downstream)
    const LOOK = 4;
    const dirX = (this.dirX = new Float32Array(n));
    const dirZ = (this.dirZ = new Float32Array(n));
    for (let k = 0; k < n; k++) {
      if (filled[k] <= seaLevel && H[k] <= seaLevel) continue;
      let c = k;
      for (let s = 0; s < LOOK; s++) {
        const p = parent[c];
        if (p < 0) break;
        c = p;
      }
      const dx = (c % res) - (k % res);
      const dz = ((c / res) | 0) - ((k / res) | 0);
      const len = Math.hypot(dx, dz);
      if (len > 0) {
        dirX[k] = dx / len;
        dirZ[k] = dz / len;
      }
    }

    let maxRoute = 0;
    for (let k = 0; k < n; k++) if (H[k] > seaLevel && dist[k] > maxRoute) maxRoute = dist[k];
    this.maxRouteDist = maxRoute;
  }

  // --- grid helpers ---------------------------------------------------------

  toWorld(i, j) {
    return [(i / (this.res - 1) - 0.5) * this.size, (j / (this.res - 1) - 0.5) * this.size];
  }

  toGrid(x, z) {
    return [(x / this.size + 0.5) * (this.res - 1), (z / this.size + 0.5) * (this.res - 1)];
  }

  cellIndex(x, z) {
    const res = this.res;
    const i = Math.min(res - 1, Math.max(0, Math.round((x / this.size + 0.5) * (res - 1))));
    const j = Math.min(res - 1, Math.max(0, Math.round((z / this.size + 0.5) * (res - 1))));
    return j * res + i;
  }

  sample(arr, x, z) {
    const res = this.res;
    let gx = (x / this.size + 0.5) * (res - 1);
    let gz = (z / this.size + 0.5) * (res - 1);
    gx = Math.min(Math.max(gx, 0), res - 1.001);
    gz = Math.min(Math.max(gz, 0), res - 1.001);
    const i = gx | 0;
    const j = gz | 0;
    const fx = gx - i;
    const fz = gz - j;
    const k = j * res + i;
    return (arr[k] * (1 - fx) + arr[k + 1] * fx) * (1 - fz) + (arr[k + res] * (1 - fx) + arr[k + res + 1] * fx) * fz;
  }

  // --- queries ----------------------------------------------------------------

  /** Filled water surface height (lakes/pits are flat at their spill level). */
  surfaceAt(x, z) {
    return this.sample(this.filled, x, z);
  }

  /** Smooth gradient of the filled surface (2-cell central difference). */
  gradientAt(x, z, out = new THREE.Vector2()) {
    const e = this.cell;
    return out.set(
      (this.surfaceAt(x + e, z) - this.surfaceAt(x - e, z)) / (2 * e),
      (this.surfaceAt(x, z + e) - this.surfaceAt(x, z - e)) / (2 * e),
    );
  }

  /** Unit flow direction (valley-following). Zero vector at sea. */
  flowDirAt(x, z, out = new THREE.Vector2()) {
    out.set(this.sample(this.dirX, x, z), this.sample(this.dirZ, x, z));
    const l = out.length();
    if (l > 1e-4) out.divideScalar(l);
    else out.set(0, 0);
    return out;
  }

  /** Metres along the drainage route to the sea (0 at sea). */
  routeDistAt(x, z) {
    if (!this.terrain.isLand(x, z)) return 0;
    return this.sample(this.routeDist, x, z);
  }

  /** 0..1 how much of a valley floor / main river this spot is. */
  channelAt(x, z) {
    const a = this.sample(this.acc, x, z);
    return Math.min(1, Math.log(Math.max(1, a)) / Math.log(this.maxAcc));
  }

  /** Depth of still water a basin would hold here (filled − ground), m. */
  basinDepthAt(x, z) {
    return Math.max(0, this.surfaceAt(x, z) - this.terrain.heightAt(x, z));
  }

  /**
   * Where a stream's water surface sits: the ground, or the (capped) pool level in a
   * basin, never below the sea.
   */
  waterY(x, z, radius = 6) {
    const ground = this.terrain.heightAt(x, z);
    if (ground <= this.seaLevel) return this.seaLevel;
    const pool = Math.min(this.surfaceAt(x, z), ground + Math.max(1.5, radius * 0.35));
    return Math.max(ground, pool) + 0.2;
  }

  /**
   * Trace the drainage route downstream from (x, z) for `length` metres. Returns an
   * array of THREE.Vector3 (y = water surface) spaced ~`step` metres apart, smoothed.
   */
  traceRoute(x, z, length, step = 12, out = []) {
    out.length = 0;
    const res = this.res;
    let k = this.cellIndex(x, z);
    let px = x;
    let pz = z;
    let travelled = 0;
    out.push(new THREE.Vector3(px, this.waterY(px, pz), pz));
    let guard = 0;
    while (travelled < length && guard++ < 4000) {
      const p = this.parent[k];
      if (p < 0) break;
      const [wx, wz] = this.toWorld(p % res, (p / res) | 0);
      const d = Math.hypot(wx - px, wz - pz);
      if (d >= step) {
        const n = Math.floor(d / step);
        for (let s = 1; s <= n && travelled < length; s++) {
          const f = (s * step) / d;
          const qx = px + (wx - px) * f;
          const qz = pz + (wz - pz) * f;
          out.push(new THREE.Vector3(qx, this.waterY(qx, qz), qz));
          travelled += step;
        }
        px = out[out.length - 1].x;
        pz = out[out.length - 1].z;
      }
      k = p;
    }
    // light smoothing (removes the D8 staircase)
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < out.length - 1; i++) {
        out[i].x = (out[i - 1].x + out[i].x * 2 + out[i + 1].x) / 4;
        out[i].z = (out[i - 1].z + out[i].z * 2 + out[i + 1].z) / 4;
      }
    }
    for (const v of out) v.y = this.waterY(v.x, v.z);
    return out;
  }

  /**
   * Highest terrain bump between two points relative to the straight line's start
   * surface — used to know if a gentle saddle can be crossed with the current momentum.
   */
  maxRiseAlong(x0, z0, x1, z1, samples = 12) {
    const h0 = this.surfaceAt(x0, z0);
    let rise = -Infinity;
    for (let i = 1; i <= samples; i++) {
      const f = i / samples;
      const h = this.surfaceAt(x0 + (x1 - x0) * f, z0 + (z1 - z0) * f);
      rise = Math.max(rise, h - h0);
    }
    return rise;
  }
}

class MinHeap {
  constructor(cap) {
    this.keys = new Int32Array(Math.max(16, cap));
    this.vals = new Float32Array(Math.max(16, cap));
    this.size = 0;
  }

  push(k, v) {
    if (this.size >= this.keys.length) {
      const nk = new Int32Array(this.keys.length * 2);
      nk.set(this.keys);
      const nv = new Float32Array(this.vals.length * 2);
      nv.set(this.vals);
      this.keys = nk;
      this.vals = nv;
    }
    let i = this.size++;
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
