import * as THREE from 'three';
import { mulberry32, createNoise2D, fbm } from '../../core/random.js';

/**
 * Deterministic placement of trees, bushes and rocks from TerrainData.
 * Everything is derived from terrain queries at init (height, slope, flow, sea
 * distance, lake sites, peaks) so it follows whatever island the terrain owner
 * generates. Rules (art direction + gameplay):
 *   - dense forests on valley sides and lowlands (the chase cam races between trunks),
 *     clearings/meadows from noise, a treeline at altitude, nothing on cliffs/beaches,
 *     nothing in lakes, puddles, river beds or the sea
 *   - species mix: dark pines higher and on valley sides, round broadleaf trees in the
 *     lowlands, red/orange autumn groves (reference), birches near water and edges,
 *     bushes on forest edges and as red undergrowth under pines
 *   - rocks: sparse boulders everywhere, debris fields above the treeline, rock
 *     clusters on steep slopes, orange coastal rocks and a few sea stacks
 * Output per catalogue entry: { mats: Float32Array(n*16), cols: Float32Array(n*3), count }.
 */

const C = (hex) => new THREE.Color(hex);
export const PALETTE = {
  pine: [C(0x174d32), C(0x1d5a38), C(0x14452e), C(0x216340), C(0x1a5235)],
  broad: [C(0x6eaa24), C(0x7cb82c), C(0x5f9a20), C(0x8ac22f), C(0x6aa62a)],
  autumn: [C(0xc8432b), C(0xe0762f), C(0xd5582a), C(0xe39a33), C(0xb93a29), C(0xe6862f)],
  birch: [C(0x9bcb32), C(0xa8d63c), C(0x8fbe2d)],
  birchAutumn: [C(0xe2b43a), C(0xebc54a), C(0xd9a032)],
  bush: [C(0x3f7a28), C(0x4a8b2d), C(0x346b26)],
  bushAutumn: [C(0xb8402a), C(0xd0602c), C(0xc44a2a), C(0xd88a30)],
  rock: [C(0x648c99), C(0x6d94a0), C(0x5a8290), C(0x729aa6)],
  rockHigh: [C(0x344f61), C(0x3d5a6d), C(0x2e4857)],
  rockCoast: [C(0xbe8a63), C(0xb37f58), C(0xc79670), C(0xa9754f)],
};

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _qa = new THREE.Quaternion();

class Bucket {
  constructor() {
    this.m = [];
    this.c = [];
  }
  push(mat, col, jitter) {
    for (let i = 0; i < 16; i++) this.m.push(mat.elements[i]);
    this.c.push(col.r * jitter, col.g * jitter, col.b * jitter);
  }
  finish() {
    return { mats: new Float32Array(this.m), cols: new Float32Array(this.c), count: this.c.length / 3 };
  }
}

const sstep = (a, b, v) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Highest land height (m); props use relative altitude so they follow any terrain. */
const _maxH = new WeakMap();
export function terrainMaxHeight(terrain) {
  if (_maxH.has(terrain)) return _maxH.get(terrain);
  let hMax = 1;
  const H = terrain.heights;
  for (let i = 0; i < H.length; i++) if (H[i] > hMax) hMax = H[i];
  if (terrain.peaks?.[0]) hMax = Math.max(hMax * 0.98, terrain.peaks[0].y);
  _maxH.set(terrain, hMax);
  return hMax;
}

/**
 * Still-water test from terrain.lakeSites/puddleSites. Returns a function
 * (x, z, groundY) → { wet, near } (near: 0..1 proximity to a lake shore).
 */
export function makeWaterTest(terrain) {
  const sites = [...(terrain.lakeSites ?? []), ...(terrain.puddleSites ?? [])];
  const HC = 300;
  const siteHash = new Map();
  for (const s of sites) {
    const r = s.radius * 3 + 20;
    for (let gx = Math.floor((s.x - r) / HC); gx <= Math.floor((s.x + r) / HC); gx++)
      for (let gz = Math.floor((s.z - r) / HC); gz <= Math.floor((s.z + r) / HC); gz++) {
        const k = `${gx},${gz}`;
        if (!siteHash.has(k)) siteHash.set(k, []);
        siteHash.get(k).push(s);
      }
  }
  const water = { wet: false, near: 0 };
  return function waterAt(x, z, h) {
    water.wet = false;
    water.near = 0;
    const list = siteHash.get(`${Math.floor(x / HC)},${Math.floor(z / HC)}`);
    if (!list) return water;
    for (const s of list) {
      const d = Math.hypot(x - s.x, z - s.z);
      if (d < s.radius * 1.12 + 3) water.wet = true;
      else if (d < s.radius * 3 && h < s.level + 0.6) water.wet = true;
      water.near = Math.max(water.near, 1 - sstep(s.radius, s.radius * 2.6 + 30, d));
    }
    return water;
  };
}

export function scatterProps(terrain, { density = 1, seed = 7, treeNames, rockNames } = {}) {
  const rand = mulberry32(seed * 977 + 13);
  const nForest = createNoise2D(mulberry32(seed + 101));
  const nClear = createNoise2D(mulberry32(seed + 202));
  const nAutumn = createNoise2D(mulberry32(seed + 303));
  const nMix = createNoise2D(mulberry32(seed + 404));
  const nRock = createNoise2D(mulberry32(seed + 505));

  const hMax = terrainMaxHeight(terrain);
  const waterAt = makeWaterTest(terrain);

  const trees = Object.fromEntries(treeNames.map((n) => [n, new Bucket()]));
  const rocks = Object.fromEntries(rockNames.map((n) => [n, new Bucket()]));
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  const placeTree = (name, x, z, y, scale, col, lean = 0.05) => {
    _e.set((rand() - 0.5) * lean, rand() * Math.PI * 2, (rand() - 0.5) * lean);
    _q.setFromEuler(_e);
    _m.compose(_p.set(x, y, z), _q, _s.setScalar(scale));
    trees[name].push(_m, col, 0.9 + rand() * 0.2);
  };
  const placeRock = (name, x, z, y, scale, col, normal, align, squashY = 1) => {
    _e.set(0, rand() * Math.PI * 2, 0);
    _q.setFromEuler(_e);
    if (align > 0) {
      _qa.setFromUnitVectors(_up, normal);
      _qa.slerp(new THREE.Quaternion(), 1 - align);
      _q.premultiply(_qa);
    }
    // random wobble so rocks never look identical
    _e.set((rand() - 0.5) * 0.35, 0, (rand() - 0.5) * 0.35);
    _q.multiply(_qa.setFromEuler(_e));
    _m.compose(_p.set(x, y, z), _q, _s.set(scale * (0.85 + rand() * 0.3), scale * squashY * (0.8 + rand() * 0.35), scale * (0.85 + rand() * 0.3)));
    rocks[name].push(_m, col, 0.88 + rand() * 0.24);
  };

  const STEP = 20;
  const half = terrain.size / 2;
  const maxTrees = 4.4 * density; // per 400 m² at full forest (dense: you race between trunks)
  const has = (n) => trees[n] !== undefined;
  const pines = treeNames.filter((n) => n.startsWith('pine'));
  const broads = treeNames.filter((n) => n.startsWith('broad'));
  const birches = treeNames.filter((n) => n.startsWith('birch'));
  const bushes = treeNames.filter((n) => n.startsWith('bush'));
  const boulders = rockNames.filter((n) => n.startsWith('boulder'));
  const slabs = rockNames.filter((n) => n.startsWith('slab'));
  const shards = rockNames.filter((n) => n.startsWith('shard'));

  for (let z0 = -half; z0 < half; z0 += STEP) {
    for (let x0 = -half; x0 < half; x0 += STEP) {
      const xc = x0 + STEP / 2;
      const zc = z0 + STEP / 2;
      const hc = terrain.heightAt(xc, zc);
      if (hc < -40) continue;

      if (hc <= 0.5) {
        // sea: occasional stacks near the coast
        if (hc < -30 || rand() > 0.006 * density) continue;
        let landNear = false;
        for (let k = 0; k < 8 && !landNear; k++) {
          const a = (k / 8) * Math.PI * 2;
          if (terrain.heightAt(xc + Math.cos(a) * 140, zc + Math.sin(a) * 140) > 1) landNear = true;
        }
        if (!landNear) continue;
        const sc = 5 + rand() * 14;
        placeRock(pick(rand() < 0.5 ? shards : boulders), xc, zc, hc - sc * 0.3, sc, pick(PALETTE.rockCoast), _up, 0, 1.2);
        continue;
      }

      terrain.normalAt(xc, zc, _n);
      const ny = _n.y;
      const hRel = hc / hMax;
      const flow = terrain.flowAt(xc, zc);
      const coast = terrain.distToSea ? terrain.distToSea(xc, zc) : 1e9;

      const valley = sstep(0.14, 0.42, flow);
      const chan = sstep(0.6, 0.85, flow);
      const low = 1 - sstep(0.08, 0.3, hRel);
      const alt = 1 - sstep(0.4, 0.58, hRel);
      const slopeOK = sstep(0.7, 0.86, ny);
      const coastOK = sstep(3, 10, hc);
      // vegetation fields only where something can grow (skips mountains / cliffs / beaches)
      const veg = hRel < 0.62 && ny > 0.66 && hc > 2.5;
      const forest = veg ? sstep(0.06, 0.3, fbm(nForest, xc / 1100, zc / 1100, 3) + 0.14 + valley * 0.62 + low * 0.12) : 0;
      const clear = veg ? sstep(0.38, 0.62, nClear(xc / 260, zc / 260)) : 0;
      const autumn = veg ? sstep(0.3, 0.62, fbm(nAutumn, xc / 650, zc / 650, 2)) * 0.55 : 0;

      // --- trees -------------------------------------------------------------
      // The river corridor stays OPEN. Trees along the channel are what made the traps
      // invisible: you cannot dodge a lava field you only see when you are inside it.
      const dTree = (maxTrees * forest * (1 - 0.7 * clear) + 0.05 * density) * alt * slopeOK * coastOK * (1 - 0.95 * chan) * (1 - 0.45 * valley);
      let nT = Math.floor(dTree + rand());
      for (let t = 0; t < nT; t++) {
        const x = x0 + rand() * STEP;
        const z = z0 + rand() * STEP;
        const y = terrain.heightAt(x, z);
        if (y < 3) continue;
        const w = waterAt(x, z, y);
        if (w.wet) continue;
        // per-tree, not per-cell: nothing grows in the channel the water runs down, so the
        // view down the valley is clear all the way to the next bend
        const tf = terrain.flowAt(x, z);
        if (tf > 0.5 && rand() < sstep(0.5, 0.78, tf)) continue;
        const hr = y / hMax;
        const mix = nMix(x / 180, z / 180) * 0.5 + 0.5;
        const wPine = 0.25 + 1.1 * sstep(0.1, 0.34, hr) + 0.45 * valley + 0.3 * mix;
        const wBroad = 0.95 * (1 - sstep(0.16, 0.4, hr)) * (1.2 - mix);
        const wAut = (0.1 + 0.85 * autumn) * (1 - sstep(0.42, 0.55, hr));
        const wBirch = 0.07 + 0.6 * w.near;
        let r = rand() * (wPine + wBroad + wAut + wBirch);
        const treeShrink = 0.7 + 0.3 * (1 - sstep(0.36, 0.56, hr));
        // tall forests, tallest along the valleys the rivers run down
        const sc = (1.05 + rand() * 0.65) * treeShrink * (1 + 0.35 * valley) * (1 - 0.3 * sstep(0.3, 0.62, tf));
        if ((r -= wPine) < 0 && pines.length) placeTree(pick(pines), x, z, y - 0.3, sc, pick(PALETTE.pine), 0.04);
        else if ((r -= wBroad) < 0 && broads.length) placeTree(pick(broads), x, z, y - 0.3, sc * 1.05, pick(PALETTE.broad));
        else if ((r -= wAut) < 0 && broads.length) placeTree(pick(broads), x, z, y - 0.3, sc * 1.0, pick(PALETTE.autumn));
        else if (birches.length) placeTree(pick(birches), x, z, y - 0.3, sc, pick(autumn > 0.5 ? PALETTE.birchAutumn : PALETTE.birch), 0.12);
      }

      // --- bushes --------------------------------------------------------------
      if (bushes.length) {
        const edge = forest * (1 - forest) * 4;
        const dBush = (0.75 * edge + 0.35 * forest * (1 - clear) + 0.06 + 0.5 * (1 - sstep(0.62, 0.8, ny))) * density * (1 - sstep(0.46, 0.62, hRel)) * sstep(0.5, 0.72, ny) * sstep(2.5, 6, hc) * (1 - 0.8 * chan);
        const nB = Math.floor(dBush + rand());
        for (let t = 0; t < nB; t++) {
          const x = x0 + rand() * STEP;
          const z = z0 + rand() * STEP;
          const y = terrain.heightAt(x, z);
          if (y < 2.5 || waterAt(x, z, y).wet) continue;
          const red = autumn > 0.35 || (forest > 0.6 && rand() < 0.35);
          placeTree(pick(bushes), x, z, y - 0.15, 0.7 + rand() * 0.7, pick(red ? PALETTE.bushAutumn : PALETTE.bush), 0.15);
        }
      }

      // --- rocks ---------------------------------------------------------------
      const steep = 1 - sstep(0.62, 0.86, ny);
      const high = sstep(0.4, 0.62, hRel);
      const shore = 1 - sstep(8, 40, Math.min(hc, coast));
      const rn = nRock(xc / 300, zc / 300) * 0.5 + 0.5;
      const dRock = (0.03 + 0.2 * steep * rn + 0.08 * high * rn + 0.9 * shore * rn + 0.06 * valley) * density;
      const nR = Math.floor(dRock + rand());
      for (let t = 0; t < nR; t++) {
        const x = x0 + rand() * STEP;
        const z = z0 + rand() * STEP;
        const y = terrain.heightAt(x, z);
        const w = waterAt(x, z, y);
        if (w.wet && rand() < 0.8) continue;
        terrain.normalAt(x, z, _n);
        const isShore = y < 22 && Math.min(y, coast) < 45;
        const col = isShore ? pick(PALETTE.rockCoast) : y / hMax > 0.55 ? pick(PALETTE.rockHigh) : pick(PALETTE.rock);
        const big = rand();
        let sc;
        if (big < 0.72) sc = 0.5 + rand() * 1.6;
        else if (big < 0.94) sc = 2 + rand() * 3.5;
        else sc = 5 + rand() * (6 + 10 * steep);
        if (isShore) sc *= 1.5;
        let name;
        if (_n.y < 0.72 && shards.length && rand() < 0.45) name = pick(shards);
        else if (_n.y > 0.85 && (high > 0.3 || rand() < 0.3) && slabs.length) name = pick(slabs);
        else name = pick(boulders);
        const align = name.startsWith('slab') ? 0.9 : 0.5;
        // sink deeper on slopes so the downhill side never floats
        placeRock(name, x, z, y - sc * (0.2 + 0.5 * (1 - _n.y)), sc, col, _n, align);
      }

      // cliff clusters on very steep ground
      if (ny < 0.6 && rand() < 0.07 * density) {
        const k = 2 + Math.floor(rand() * 3);
        const col = pick(hc < 25 ? PALETTE.rockCoast : PALETTE.rock);
        for (let t = 0; t < k; t++) {
          const x = xc + (rand() - 0.5) * 24;
          const z = zc + (rand() - 0.5) * 24;
          const y = terrain.heightAt(x, z);
          terrain.normalAt(x, z, _n);
          const sc = 6 + rand() * 12;
          placeRock(pick(rand() < 0.5 ? shards : boulders), x, z, y - sc * 0.35, sc, col, _n, 0.7);
        }
      }
    }
  }

  const out = { trees: {}, rocks: {} };
  for (const n of treeNames) out.trees[n] = trees[n].finish();
  for (const n of rockNames) out.rocks[n] = rocks[n].finish();
  return out;
}
