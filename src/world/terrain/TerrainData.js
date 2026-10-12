import * as THREE from 'three';
import { sampleBicubic, sampleBilinear } from './gen/grid.js';
import { DETAIL_MAX, detailNoise } from './detail.js';
import { createMapCanvas } from './MapCanvas.js';

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
 *   heightAt(x, z)                 ground height (m) — bicubic grid + small detail; this is
 *                                  exactly the surface TerrainRenderer draws (< 1 cm apart)
 *   normalAt(x, z, out?)           THREE.Vector3 unit normal
 *   gradientAt(x, z, out?)         THREE.Vector2 (dh/dx, dh/dz)
 *   distToSea(x, z)                path distance to the coast along land (m), 0 at sea
 *   flowAt(x, z)                   0..1 accumulated flow (valleys/rivers ≈ 1)
 *   isLand(x, z)
 *   lakeSites   [{ x, z, radius, level, volume }]   still-water bodies (volume in litres)
 *   puddleSites [{ x, z, radius, level, volume }]   small ones
 *   peaks       [{ x, y, z }] sorted high → low  (drop targets, landmarks; peaks[0] has a
 *                                                 flattened summit pad ~70 m wide)
 *   heightTexture  THREE.DataTexture (RedFormat, FloatType) of `heights`, linear filtered
 *                  (nearest where the GPU can't filter float32 — read it with texelFetch)
 *
 * Optional extras (added; nothing depends on them yet):
 *   forestAt(x, z)      0..1 forest-ness used by the terrain shader + map (props may use it)
 *   coastAt(x, z)       0..1 proximity to the shoreline (1 = at the water)
 *   waterAt(x, z)       0..1 lake/puddle water mask (1 = under still water, ramps on shores)
 *   createMapCanvas(size = 512)  stylised hill-shaded map of the island (HTMLCanvasElement)
 *   worldToMap(x, z, size)       → [px, py] pixel coords on that canvas
 *   infoTexture   RGBA16F: dh/dx, dh/dz, flow, ambient occlusion (linear)
 *   maskTexture   RGBA8:   detail amount, coast proximity, still water, forest (linear)
 *   timings       generation timings (ms)
 */
export class TerrainData {
  constructor(ctx) {
    this.ctx = ctx;
    this.seed = ctx.params.seed;
    this.size = 18000; // smaller island: more encounters, 2.5–4 min races
    this.res = 1025;
    this.cell = this.size / (this.res - 1);
    this.seaLevel = 0;
    this.maxHeight = 1900;
    this._gScale = (this.res - 1) / this.size;
  }

  async init(onProgress = () => {}) {
    const opts = { seed: this.seed, size: this.size, res: this.res, maxHeight: this.maxHeight };
    const r = await runGenerator(opts, onProgress);
    this.heights = r.heights;
    this.flow = r.flow;
    this.seaDist = r.seaDist;
    this.coastIn = r.coastIn;
    this.lakeSites = r.lakeSites;
    this.puddleSites = r.puddleSites;
    this.peaks = r.peaks;
    this.timings = r.timings;
    this._info = r.info;
    this._mask = r.mask;
    const n = this.res * this.res;
    // per-channel views of the RGBA8 mask for CPU sampling (identical to what the GPU reads)
    this.detailAmp = new Float32Array(n);
    this.forest = new Float32Array(n);
    this.coast = new Float32Array(n);
    this.water = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      this.detailAmp[k] = r.mask[k * 4] / 255;
      this.coast[k] = r.mask[k * 4 + 1] / 255;
      this.water[k] = r.mask[k * 4 + 2] / 255;
      this.forest[k] = r.mask[k * 4 + 3] / 255;
    }
    this.createTextures();
    onProgress(1, 'Isla lista');
  }

  createTextures() {
    const { res } = this;
    const gl = this.ctx.renderer?.getContext?.();
    const floatLinear = !!(gl && gl.getExtension('OES_texture_float_linear'));
    const f = floatLinear ? THREE.LinearFilter : THREE.NearestFilter;
    this.heightTexture = new THREE.DataTexture(this.heights, res, res, THREE.RedFormat, THREE.FloatType);
    this.heightTexture.magFilter = f;
    this.heightTexture.minFilter = f;
    this.heightTexture.needsUpdate = true;

    this.infoTexture = new THREE.DataTexture(this._info, res, res, THREE.RGBAFormat, THREE.HalfFloatType);
    this.infoTexture.magFilter = THREE.LinearFilter;
    this.infoTexture.minFilter = THREE.LinearFilter;
    this.infoTexture.needsUpdate = true;

    this.maskTexture = new THREE.DataTexture(this._mask, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.maskTexture.magFilter = THREE.LinearFilter;
    this.maskTexture.minFilter = THREE.LinearFilter;
    this.maskTexture.needsUpdate = true;
  }

  // --- sampling -----------------------------------------------------------

  toGrid(x, z) {
    return [(x / this.size + 0.5) * (this.res - 1), (z / this.size + 0.5) * (this.res - 1)];
  }

  sample(arr, x, z) {
    const s = this._gScale;
    return sampleBilinear(arr, this.res, x * s + (this.res - 1) * 0.5, z * s + (this.res - 1) * 0.5);
  }

  /** Smooth grid height without the small detail layer. */
  baseHeightAt(x, z) {
    const s = this._gScale;
    const o = (this.res - 1) * 0.5;
    return sampleBicubic(this.heights, this.res, x * s + o, z * s + o);
  }

  heightAt(x, z) {
    const s = this._gScale;
    const o = (this.res - 1) * 0.5;
    const gx = x * s + o;
    const gz = z * s + o;
    const h = sampleBicubic(this.heights, this.res, gx, gz);
    const a = sampleBilinear(this.detailAmp, this.res, gx, gz);
    return a > 0 ? h + a * DETAIL_MAX * detailNoise(x, z) : h;
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

  forestAt(x, z) {
    return this.sample(this.forest, x, z);
  }

  coastAt(x, z) {
    return this.sample(this.coast, x, z);
  }

  waterAt(x, z) {
    return this.sample(this.water, x, z);
  }

  createMapCanvas(size = 512) {
    return createMapCanvas(this, size);
  }

  worldToMap(x, z, size = 512) {
    return [(x / this.size + 0.5) * size, (z / this.size + 0.5) * size];
  }
}

const _g = new THREE.Vector2();

/** Run the generator in a module worker (falls back to the main thread). */
async function runGenerator(opts, onProgress) {
  if (typeof Worker !== 'undefined') {
    try {
      return await new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./terrain.worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = (e) => {
          const m = e.data;
          if (m.type === 'progress') onProgress(m.p * 0.97, m.label);
          else if (m.type === 'done') {
            worker.terminate();
            resolve(m.result);
          } else if (m.type === 'error') {
            worker.terminate();
            reject(new Error(m.message));
          }
        };
        worker.onerror = (e) => {
          worker.terminate();
          reject(new Error(e.message || 'terrain worker failed'));
        };
        worker.postMessage(opts);
      });
    } catch (err) {
      console.warn('[terrain] worker unavailable, generating on the main thread:', err.message);
    }
  }
  const { generateTerrain } = await import('./gen/generate.js');
  await new Promise((r) => setTimeout(r, 0));
  return generateTerrain(opts, onProgress);
}
