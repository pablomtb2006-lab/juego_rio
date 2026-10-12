import * as THREE from 'three';
import { propMesh, PROP_UNIFORMS } from './propMaterial.js';

/**
 * Chunked, distance-LOD'd instancing for thousands of props with a fixed, tiny
 * number of draw calls (one InstancedMesh per kind × LOD × material part).
 *
 *   near  (d < r0)   full mesh         — rebuilt every frame from visible chunks
 *   mid   (r0..r1)   simplified mesh   — rebuilt every frame from visible chunks
 *   far   (r1..max)  cheap proxy       — rebuilt lazily (camera moved / turned) from a
 *                                         widened frustum, thinned with distance; the
 *                                         far shader hides anything inside r1 of the
 *                                         current LOD centre so bands never overlap.
 *
 * Instances are stored per kind, sorted by chunk (and shuffled inside each chunk so
 * "the first k" of a chunk is a random subset for thinning). Updating a band is a
 * handful of typed-array block copies + one partial buffer upload per mesh.
 */

const _box = new THREE.Box3();
const _proj = new THREE.Matrix4();
const _pv = new THREE.Matrix4();
const _fwd = new THREE.Vector3();

function boxDist(b, p) {
  const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x);
  const dy = Math.max(b.min.y - p.y, 0, p.y - b.max.y);
  const dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
function boxFar(b, p) {
  const dx = Math.max(Math.abs(b.min.x - p.x), Math.abs(b.max.x - p.x));
  const dy = Math.max(Math.abs(b.min.y - p.y), Math.abs(b.max.y - p.y));
  const dz = Math.max(Math.abs(b.min.z - p.z), Math.abs(b.max.z - p.z));
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export class InstanceLOD {
  /**
   * @param ctx
   * @param {object} o  chunkSize, nearAll (radius kept regardless of frustum, for shadows),
   *                    farMove (re-cull far set after moving this far), thin [start, end]
   */
  constructor(ctx, o = {}) {
    this.ctx = ctx;
    this.cs = o.chunkSize ?? 64;
    this.nearAll = o.nearAll ?? 120;
    this.farMove = o.farMove ?? 60;
    this.farMax = o.farMax ?? ctx.quality.drawDistance ?? 12000;
    this.thin = o.thin ?? [2500, 7000];
    const size = ctx.terrain.size;
    this.half = size / 2 + this.cs * 2;
    this.n = Math.ceil((this.half * 2) / this.cs);
    this.kinds = [];
    this.group = new THREE.Group();
    this.group.name = o.name ?? 'instances';
    ctx.scene.add(this.group);
    this.frustum = new THREE.Frustum();
    this.farFrustum = new THREE.Frustum();
    this.lastFar = { pos: new THREE.Vector3(1e9, 0, 0), dir: new THREE.Vector3(), fov: 0, aspect: 0, force: true };
  }

  /**
   * def: {
   *   name, r0, r1,
   *   lod0: [{ geometry, material, castShadow }],   (parts share instance buffers)
   *   lod1: [{ geometry, material, castShadow }],
   *   far:  { geometry, material } | null,
   *   mats: Float32Array(n*16), cols: Float32Array(n*3), count, radius (max instance extent)
   * }
   */
  addKind(def) {
    this.kinds.push({ ...def, k: this.kinds.length });
  }

  chunkOf(x, z) {
    const ci = Math.min(this.n - 1, Math.max(0, Math.floor((x + this.half) / this.cs)));
    const cj = Math.min(this.n - 1, Math.max(0, Math.floor((z + this.half) / this.cs)));
    return cj * this.n + ci;
  }

  build() {
    const N = this.n;
    this.grid = new Int32Array(N * N).fill(-1);
    this.records = [];
    for (const K of this.kinds) {
      const n = K.count;
      // counting sort by chunk id, then a deterministic shuffle inside each chunk so
      // "the first k instances of a chunk" is a random subset (far-band thinning)
      const cid = new Int32Array(n);
      const counts = new Int32Array(N * N + 1);
      for (let i = 0; i < n; i++) {
        cid[i] = this.chunkOf(K.mats[i * 16 + 12], K.mats[i * 16 + 14]);
        counts[cid[i] + 1]++;
      }
      for (let c = 0; c < N * N; c++) counts[c + 1] += counts[c];
      const order = new Int32Array(n);
      const fill = counts.slice(0, N * N);
      for (let i = 0; i < n; i++) order[fill[cid[i]]++] = i;
      let seed = 12345 + K.k * 7919;
      const rnd = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      for (let a = 0; a < n; ) {
        let b = a + 1;
        while (b < n && cid[order[b]] === cid[order[a]]) b++;
        for (let i = b - 1; i > a; i--) {
          const j = a + Math.floor(rnd() * (i - a + 1));
          const t = order[i];
          order[i] = order[j];
          order[j] = t;
        }
        a = b;
      }
      const mats = new Float32Array(n * 16);
      const cols = new Float32Array(n * 3);
      const org = new Float32Array(n * 3);
      const sc = new Float32Array(n);
      for (let dst = 0; dst < n; dst++) {
        const src = order[dst];
        mats.set(K.mats.subarray(src * 16, src * 16 + 16), dst * 16);
        cols.set(K.cols.subarray(src * 3, src * 3 + 3), dst * 3);
        org[dst * 3] = mats[dst * 16 + 12];
        org[dst * 3 + 1] = mats[dst * 16 + 13];
        org[dst * 3 + 2] = mats[dst * 16 + 14];
        sc[dst] = Math.hypot(mats[dst * 16 + 4], mats[dst * 16 + 5], mats[dst * 16 + 6]);
      }
      K.mats = mats;
      K.cols = cols;
      K.org = org;
      K.scale = sc;
      const sortedCid = new Int32Array(n);
      for (let i = 0; i < n; i++) sortedCid[i] = cid[order[i]];
      // chunk entries
      let i = 0;
      while (i < n) {
        const c = sortedCid[i];
        let j = i + 1;
        while (j < n && sortedCid[j] === c) j++;
        let rec = this.grid[c];
        if (rec < 0) {
          rec = this.records.length;
          this.grid[c] = rec;
          const ci = c % N;
          const cj = (c / N) | 0;
          const x0 = ci * this.cs - this.half;
          const z0 = cj * this.cs - this.half;
          this.records.push({
            id: c,
            origin: new THREE.Box3(new THREE.Vector3(x0, 1e9, z0), new THREE.Vector3(x0 + this.cs, -1e9, z0 + this.cs)),
            bounds: new THREE.Box3(),
            pad: 0,
            entries: [],
          });
        }
        const R = this.records[rec];
        let maxExt = 0;
        for (let q = i; q < j; q++) {
          const y = org[q * 3 + 1];
          R.origin.min.y = Math.min(R.origin.min.y, y);
          R.origin.max.y = Math.max(R.origin.max.y, y);
          maxExt = Math.max(maxExt, sc[q] * K.radius);
        }
        R.pad = Math.max(R.pad, maxExt);
        R.entries.push(K.k, i, j - i);
        i = j;
      }
    }
    for (const R of this.records) {
      R.bounds.copy(R.origin);
      R.bounds.min.x -= R.pad;
      R.bounds.min.z -= R.pad;
      R.bounds.min.y -= R.pad * 0.3;
      R.bounds.max.x += R.pad;
      R.bounds.max.z += R.pad;
      R.bounds.max.y += R.pad * 2;
    }
    for (const K of this.kinds) this.createMeshes(K);
  }

  /** Max instances of kind K that can fall inside radius r of any point (chunk-window estimate). */
  capacity(K, r) {
    const N = this.n;
    const cnt = new Int32Array(N * N);
    for (const R of this.records) {
      for (let e = 0; e < R.entries.length; e += 3) if (R.entries[e] === K.k) cnt[R.id] += R.entries[e + 2];
    }
    // prefix sums
    const S = new Float64Array((N + 1) * (N + 1));
    for (let j = 0; j < N; j++) {
      let row = 0;
      for (let i = 0; i < N; i++) {
        row += cnt[j * N + i];
        S[(j + 1) * (N + 1) + i + 1] = S[j * (N + 1) + i + 1] + row;
      }
    }
    const w = Math.ceil(r / this.cs) + 1;
    let best = 0;
    for (const R of this.records) {
      const ci = R.id % N;
      const cj = (R.id / N) | 0;
      const i0 = Math.max(0, ci - w);
      const j0 = Math.max(0, cj - w);
      const i1 = Math.min(N, ci + w + 1);
      const j1 = Math.min(N, cj + w + 1);
      const s = S[j1 * (N + 1) + i1] - S[j0 * (N + 1) + i1] - S[j1 * (N + 1) + i0] + S[j0 * (N + 1) + i0];
      if (s > best) best = s;
    }
    return Math.min(K.count, Math.ceil(best * 1.1) + 16);
  }

  createMeshes(K) {
    const mk = (parts, cap, shadowDefault) => {
      if (!parts || !parts.length || cap <= 0) return null;
      const matAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
      const colAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      matAttr.setUsage(THREE.DynamicDrawUsage);
      colAttr.setUsage(THREE.DynamicDrawUsage);
      const meshes = parts.map((p) => {
        const m = propMesh(p.geometry, p.material, 1);
        m.instanceMatrix = matAttr;
        m.instanceColor = colAttr;
        m.castShadow = p.castShadow ?? shadowDefault;
        m.receiveShadow = true;
        m.name = `${K.name}`;
        this.group.add(m);
        return m;
      });
      return { meshes, mat: matAttr, col: colAttr, cap, n: 0 };
    };
    K.bands = [mk(K.lod0, this.capacity(K, K.r0), true), mk(K.lod1, this.capacity(K, K.r1), true)];
    K.farBand = K.far ? mk([{ geometry: K.far.geometry, material: K.far.material, castShadow: false }], K.count, false) : null;
  }

  copy(band, K, s, c) {
    if (!band) return;
    const room = band.cap - band.n;
    if (room <= 0) return;
    if (c > room) c = room;
    band.mat.array.set(K.mats.subarray(s * 16, (s + c) * 16), band.n * 16);
    band.col.array.set(K.cols.subarray(s * 3, (s + c) * 3), band.n * 3);
    band.n += c;
  }

  flush(band) {
    if (!band) return;
    const n = band.n;
    for (const m of band.meshes) {
      m.count = n;
      m.visible = n > 0;
    }
    if (n > 0) {
      band.mat.clearUpdateRanges();
      band.mat.addUpdateRange(0, n * 16);
      band.mat.needsUpdate = true;
      band.col.clearUpdateRanges();
      band.col.addUpdateRange(0, n * 3);
      band.col.needsUpdate = true;
    }
  }

  update(camera) {
    if (!this.grid) return;
    const cam = camera.position;
    camera.updateMatrixWorld();
    PROP_UNIFORMS.uLodCenter.value.copy(cam);

    // widened frustum for the near/mid bands (covers small camera turns + sway)
    _proj.copy(camera.projectionMatrix);
    _proj.elements[0] *= 0.82;
    _proj.elements[5] *= 0.82;
    _pv.multiplyMatrices(_proj, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(_pv);

    let rmax = 0;
    for (const K of this.kinds) {
      rmax = Math.max(rmax, K.r1);
      if (K.bands[0]) K.bands[0].n = 0;
      if (K.bands[1]) K.bands[1].n = 0;
    }
    const N = this.n;
    const i0 = Math.max(0, Math.floor((cam.x - rmax + this.half) / this.cs));
    const i1 = Math.min(N - 1, Math.floor((cam.x + rmax + this.half) / this.cs));
    const j0 = Math.max(0, Math.floor((cam.z - rmax + this.half) / this.cs));
    const j1 = Math.min(N - 1, Math.floor((cam.z + rmax + this.half) / this.cs));
    const kinds = this.kinds;
    const cx = cam.x;
    const cy = cam.y;
    const cz = cam.z;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const r = this.grid[j * N + i];
        if (r < 0) continue;
        const R = this.records[r];
        const dmin = boxDist(R.origin, cam);
        if (dmin > rmax) continue;
        if (dmin > this.nearAll && !this.frustum.intersectsBox(R.bounds)) continue;
        const dmax = boxFar(R.origin, cam);
        const E = R.entries;
        for (let e = 0; e < E.length; e += 3) {
          const K = kinds[E[e]];
          const s = E[e + 1];
          const c = E[e + 2];
          if (dmin >= K.r1) continue;
          if (dmax < K.r0) this.copy(K.bands[0], K, s, c);
          else if (dmin >= K.r0 && dmax < K.r1) this.copy(K.bands[1], K, s, c);
          else {
            const o = K.org;
            const r0s = K.r0 * K.r0;
            const r1s = K.r1 * K.r1;
            for (let q = s; q < s + c; q++) {
              const dx = o[q * 3] - cx;
              const dy = o[q * 3 + 1] - cy;
              const dz = o[q * 3 + 2] - cz;
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 < r0s) this.copy(K.bands[0], K, q, 1);
              else if (d2 < r1s) this.copy(K.bands[1], K, q, 1);
            }
          }
        }
      }
    }
    for (const K of kinds) {
      this.flush(K.bands[0]);
      this.flush(K.bands[1]);
    }
    this.updateFar(camera);
  }

  updateFar(camera) {
    const L = this.lastFar;
    const cam = camera.position;
    camera.getWorldDirection(_fwd);
    const moved = L.pos.distanceTo(cam);
    const turned = L.dir.dot(_fwd) < Math.cos(THREE.MathUtils.degToRad(7));
    if (!L.force && moved < this.farMove && !turned && L.fov === camera.fov && L.aspect === camera.aspect) return;
    L.force = false;
    L.pos.copy(cam);
    L.dir.copy(_fwd);
    L.fov = camera.fov;
    L.aspect = camera.aspect;

    _proj.copy(camera.projectionMatrix);
    _proj.elements[0] *= 0.62;
    _proj.elements[5] *= 0.62;
    _pv.multiplyMatrices(_proj, camera.matrixWorldInverse);
    this.farFrustum.setFromProjectionMatrix(_pv);

    const kinds = this.kinds;
    for (const K of kinds) if (K.farBand) K.farBand.n = 0;
    const [t0, t1] = this.thin;
    for (const R of this.records) {
      const dmin = boxDist(R.origin, cam);
      if (dmin > this.farMax) continue;
      const dmax = boxFar(R.origin, cam);
      if (!this.farFrustum.intersectsBox(R.bounds)) continue;
      const dc = (dmin + dmax) * 0.5;
      const tt = Math.min(1, Math.max(0, (dc - t0) / (t1 - t0)));
      const keep = 1 - 0.55 * tt * tt * (3 - 2 * tt);
      const E = R.entries;
      for (let e = 0; e < E.length; e += 3) {
        const K = kinds[E[e]];
        if (!K.farBand) continue;
        if (dmax < K.r1 - this.farMove * 1.5) continue;
        const c = E[e + 2];
        const kc = keep >= 0.999 ? c : Math.max(c > 0 ? 1 : 0, Math.round(c * keep));
        this.copy(K.farBand, K, E[e + 1], kc);
      }
    }
    for (const K of kinds) this.flush(K.farBand);
  }

  /** Counts for budgets / debugging. */
  stats() {
    let draws = 0;
    let shadowDraws = 0;
    let instances = 0;
    let tris = 0;
    const per = {};
    for (const K of this.kinds) {
      const row = { total: K.count, near: K.bands[0]?.n ?? 0, mid: K.bands[1]?.n ?? 0, far: K.farBand?.n ?? 0 };
      per[K.name] = row;
      for (const b of [...K.bands, K.farBand]) {
        if (!b || !b.n) continue;
        for (const m of b.meshes) {
          draws++;
          if (m.castShadow) shadowDraws++;
          const g = m.geometry;
          tris += ((g.index ? g.index.count : g.attributes.position.count) / 3) * b.n;
        }
        instances += b.n;
      }
    }
    return { draws, shadowDraws, instances, tris: Math.round(tris), per };
  }
}
