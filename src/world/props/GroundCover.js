import * as THREE from 'three';
import { mulberry32, createNoise2D, fbm } from '../../core/random.js';
import { MeshBuilder, hash2 } from './util.js';
import { createPropMaterial, propMesh, PROP_UNIFORMS } from './propMaterial.js';
import { makeWaterTest, terrainMaxHeight } from './Scatter.js';
import { buildRockMesh } from './RockFactory.js';

/**
 * Near-camera ground cover: grass tufts, flower clumps and pebbles in a ring of
 * tiles around the camera. Tiles are generated deterministically from their grid
 * coordinates (cached), so the cover is stable while you move; the instance
 * buffers are only rebuilt when the camera crosses a tile. Grass shrinks into the
 * ground towards the edge of the ring (no visible border) and is wind animated in
 * the vertex shader; stream heads flatten it.
 * Disabled when quality.grass is false or the camera is high above the ground.
 */

const TILE = 12;

const GRASS_LUSH = [new THREE.Color(0x5dbb3a), new THREE.Color(0x6cc23c), new THREE.Color(0x8ccb3f), new THREE.Color(0x52aa36)];
const GRASS_DRY = new THREE.Color(0xb9b45a);
const FLOWERS = [0xf6f2e6, 0xf3d34a, 0xe88ab5, 0x9b7be0, 0xe0452e, 0xffffff, 0xf0a33c].map((c) => new THREE.Color(c));

function buildTuft(seed, blades, lod) {
  const rng = mulberry32(seed);
  const b = new MeshBuilder();
  const up = new THREE.Vector3(0, 1, 0);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const c = new THREE.Color();
  const segs = lod === 0 ? 3 : 2;
  for (let k = 0; k < blades; k++) {
    const a = rng() * Math.PI * 2;
    const d = Math.sqrt(rng()) * 0.32;
    const bx = Math.cos(a) * d;
    const bz = Math.sin(a) * d;
    const hb = 0.45 + rng() * 0.5;
    const wb = 0.055 + rng() * 0.045;
    const la = a + (rng() - 0.5) * 1.2;
    const lx = Math.cos(la);
    const lz = Math.sin(la);
    const lean = (0.15 + rng() * 0.3) * hb;
    const fa = rng() * Math.PI;
    const px = -Math.sin(fa);
    const pz = Math.cos(fa);
    n.set(lx * 0.35, 1, lz * 0.35).normalize();
    const rows = [];
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const cx = bx + lx * lean * t * t;
      const cz = bz + lz * lean * t * t;
      const cy = hb * t;
      const w = wb * (1 - t * 0.92);
      c.setScalar(0.42 + 0.75 * t);
      const wind = t * t * 0.32;
      if (s < segs) {
        const l = b.vert(p.set(cx - px * w, cy, cz - pz * w), n, c, 1, wind);
        const r = b.vert(p.set(cx + px * w, cy, cz + pz * w), n, c, 1, wind);
        rows.push([l, r]);
      } else {
        rows.push([b.vert(p.set(cx, cy, cz), n, c, 1, wind)]);
      }
    }
    for (let s = 0; s < segs; s++) {
      const [l0, r0] = rows[s];
      if (s + 1 < segs) {
        const [l1, r1] = rows[s + 1];
        b.quad(l0, r0, r1, l1);
      } else b.tri(l0, r0, rows[s + 1][0]);
    }
  }
  return b.build();
}

function buildFlowers(seed) {
  const rng = mulberry32(seed);
  const b = new MeshBuilder();
  const p = new THREE.Vector3();
  const n = new THREE.Vector3(0, 1, 0);
  const green = new THREE.Color(0x3f8a2a);
  for (let k = 0; k < 4; k++) {
    const a = rng() * Math.PI * 2;
    const d = rng() * 0.3;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const h = 0.35 + rng() * 0.35;
    // stem (thin quad, keeps vertex colour → aTint 0)
    const s0 = b.vert(p.set(x - 0.015, 0, z), n, green, 0, 0);
    const s1 = b.vert(p.set(x + 0.015, 0, z), n, green, 0, 0);
    const s2 = b.vert(p.set(x, h, z), n, green, 0, 0.12);
    b.tri(s0, s1, s2);
    // head: 5-petal star facing up, tinted by the instance colour
    const R = 0.09 + rng() * 0.05;
    const ctr = b.vert(p.set(x, h + 0.01, z), n, new THREE.Color(1.15, 1.1, 0.7), 0, 0.12);
    const ring = [];
    const rot = rng() * 6.28;
    for (let j = 0; j < 10; j++) {
      const ang = rot + (j / 10) * Math.PI * 2;
      const rr = j % 2 === 0 ? R : R * 0.45;
      ring.push(b.vert(p.set(x + Math.cos(ang) * rr, h - 0.01 + (j % 2 ? 0.01 : -0.015), z + Math.sin(ang) * rr), n, new THREE.Color(1, 1, 1), 1, 0.12));
    }
    for (let j = 0; j < 10; j++) b.tri(ctr, ring[(j + 1) % 10], ring[j]);
  }
  return b.build();
}

export class GroundCover {
  constructor(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'groundcover';
    ctx.scene.add(this.group);
    this.cache = new Map();
    this.lastKey = '';
    this.enabled = !!ctx.quality.grass;
  }

  init() {
    if (!this.enabled) return;
    const { terrain, quality } = this.ctx;
    const dens = quality.vegetationDensity ?? 1;
    this.radius = Math.round(46 + 26 * Math.min(dens, 1.4));
    PROP_UNIFORMS.uGrassFar.value = this.radius;
    this.perTile = Math.round(TILE * TILE * 1.15 * Math.min(dens, 1.4));
    this.hMax = terrainMaxHeight(terrain);
    this.waterAt = makeWaterTest(terrain);
    const seed = terrain.seed ?? 7;
    this.seed = seed;
    this.nPatch = createNoise2D(mulberry32(seed + 901));
    this.nColor = createNoise2D(mulberry32(seed + 902));
    this.nFlower = createNoise2D(mulberry32(seed + 903));

    const rt = Math.ceil(this.radius / TILE) + 1;
    this.tileRange = rt;
    const maxTiles = (2 * rt + 1) * (2 * rt + 1);

    const grassMat = createPropMaterial({ name: 'grass', grass: true, wind: 1, flutter: 0.0, stream: true, streamBend: 2.5, foliage: true, translucency: 0.35, side: THREE.DoubleSide, noFlip: true, roughness: 0.95 });
    const flowerMat = createPropMaterial({ name: 'flowers', grass: true, wind: 1, stream: true, streamBend: 2.5, side: THREE.DoubleSide, noFlip: true, roughness: 0.8 });
    const rockMat = createPropMaterial({ name: 'pebbles', rock: true, roughness: 0.95, grass: false });
    this.materials = [grassMat, flowerMat, rockMat];

    const pebbleGeo = buildRockMesh({ seed: 77, detail: 1, scale: new THREE.Vector3(1.2, 0.6, 1), cuts: 6, noise: 0.25 });
    this.layers = [
      { name: 'grass', geo: buildTuft(5, 9, 0), mat: grassMat, cap: maxTiles * this.perTile, shadow: false },
      { name: 'flowers', geo: buildFlowers(6), mat: flowerMat, cap: maxTiles * 6, shadow: false },
      { name: 'pebbles', geo: pebbleGeo, mat: rockMat, cap: maxTiles * 8, shadow: true },
    ];
    for (const L of this.layers) {
      L.mesh = propMesh(L.geo, L.mat, L.cap);
      L.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      L.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(L.cap * 3), 3);
      L.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      L.mesh.castShadow = L.shadow;
      L.mesh.receiveShadow = true;
      L.mesh.name = L.name;
      this.group.add(L.mesh);
    }
  }

  /** Deterministic content of tile (ti, tj): Float32 arrays per layer. */
  tile(ti, tj) {
    const key = `${ti},${tj}`;
    let t = this.cache.get(key);
    if (t) return t;
    const { terrain } = this.ctx;
    const rand = mulberry32((hash2(ti, tj, this.seed) * 4294967296) >>> 0);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const n = new THREE.Vector3();
    const col = new THREE.Color();
    const out = { grass: [], grassC: [], flowers: [], flowersC: [], pebbles: [], pebblesC: [] };
    const x0 = ti * TILE;
    const z0 = tj * TILE;
    const hMax = this.hMax;
    for (let k = 0; k < this.perTile; k++) {
      const x = x0 + rand() * TILE;
      const z = z0 + rand() * TILE;
      const y = terrain.heightAt(x, z);
      const r1 = rand();
      const r2 = rand();
      const r3 = rand();
      if (y < 2.4) continue;
      terrain.normalAt(x, z, n);
      const hr = y / hMax;
      const flow = terrain.flowAt(x, z);
      const patch = fbm(this.nPatch, x / 38, z / 38, 2);
      const grassOK = n.y > 0.78 && hr < 0.6 && flow < 0.66 && patch > -0.45 + hr * 0.6 && !this.waterAt(x, z, y).wet;
      if (grassOK) {
        e.set(n.z * 0.4, r1 * Math.PI * 2, -n.x * 0.4);
        q.setFromEuler(e);
        const hs = (0.65 + r2 * 0.7) * (1 - 0.35 * Math.max(0, hr - 0.3) / 0.3) * (patch > 0.25 ? 1.3 : 1);
        m.compose(p.set(x, y - 0.05, z), q, s.set(0.9 + r3 * 0.4, hs, 0.9 + r3 * 0.4));
        out.grass.push(...m.elements);
        const cn = this.nColor(x / 220, z / 220) * 0.5 + 0.5;
        const ci = Math.min(GRASS_LUSH.length - 1, Math.floor(cn * GRASS_LUSH.length));
        col.copy(GRASS_LUSH[ci]).lerp(GRASS_LUSH[(ci + 1) % GRASS_LUSH.length], (cn * GRASS_LUSH.length) % 1);
        col.lerp(GRASS_DRY, Math.min(1, Math.max(0, (hr - 0.3) / 0.25)) * 0.85);
        const j = 0.9 + r2 * 0.2;
        out.grassC.push(col.r * j, col.g * j, col.b * j);
        // flowers in meadow patches
        const fl = this.nFlower(x / 70, z / 70);
        if (fl > 0.35 && r3 < 0.09 && hr < 0.45) {
          e.set(0, r2 * 6.28, 0);
          q.setFromEuler(e);
          m.compose(p.set(x + 0.3, terrain.heightAt(x + 0.3, z) - 0.03, z), q, s.setScalar(0.8 + r1 * 0.6));
          out.flowers.push(...m.elements);
          const fc = FLOWERS[Math.floor(((fl * 37.1) % 1) * FLOWERS.length + r1 * 1.5) % FLOWERS.length];
          out.flowersC.push(fc.r, fc.g, fc.b);
        }
      }
      // pebbles on rocky ground / near water
      const rocky = n.y < 0.86 || hr > 0.5 || flow > 0.5;
      if ((rocky && r3 > 0.93) || r3 > 0.992) {
        e.set(r1 * 6, r2 * 6, r3 * 6);
        q.setFromEuler(e);
        const sc = 0.12 + r1 * r1 * 0.55;
        m.compose(p.set(x, y - sc * 0.15, z), q, s.set(sc, sc * (0.6 + r2 * 0.5), sc));
        out.pebbles.push(...m.elements);
        const g = 0.5 + r2 * 0.12;
        out.pebblesC.push(g * 1.05, g * 0.96, g * 0.88);
      }
    }
    t = {
      grass: new Float32Array(out.grass),
      grassC: new Float32Array(out.grassC),
      flowers: new Float32Array(out.flowers),
      flowersC: new Float32Array(out.flowersC),
      pebbles: new Float32Array(out.pebbles),
      pebblesC: new Float32Array(out.pebblesC),
    };
    this.cache.set(key, t);
    if (this.cache.size > 1200) {
      // drop the oldest quarter
      let i = 0;
      for (const k of this.cache.keys()) {
        if (i++ > 300) break;
        this.cache.delete(k);
      }
    }
    return t;
  }

  update(camera) {
    if (!this.enabled || !this.layers) return;
    const { terrain } = this.ctx;
    const cam = camera.position;
    const ground = terrain.heightAt(cam.x, cam.z);
    const high = cam.y - ground > 260;
    this.group.visible = !high;
    if (high) return;
    const ti = Math.floor(cam.x / TILE);
    const tj = Math.floor(cam.z / TILE);
    const key = `${ti},${tj}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const counts = this.layers.map(() => 0);
    const rt = this.tileRange;
    const r2 = (this.radius + TILE) * (this.radius + TILE);
    for (let dj = -rt; dj <= rt; dj++) {
      for (let di = -rt; di <= rt; di++) {
        const cx = (ti + di + 0.5) * TILE - cam.x;
        const cz = (tj + dj + 0.5) * TILE - cam.z;
        if (cx * cx + cz * cz > r2) continue;
        const t = this.tile(ti + di, tj + dj);
        this.layers.forEach((L, li) => {
          const mats = t[L.name];
          const cols = t[`${L.name}C`];
          const n = mats.length / 16;
          const room = Math.min(n, L.cap - counts[li]);
          if (room <= 0) return;
          L.mesh.instanceMatrix.array.set(mats.subarray(0, room * 16), counts[li] * 16);
          L.mesh.instanceColor.array.set(cols.subarray(0, room * 3), counts[li] * 3);
          counts[li] += room;
        });
      }
    }
    this.layers.forEach((L, li) => {
      const n = counts[li];
      L.mesh.count = n;
      L.mesh.visible = n > 0;
      L.mesh.instanceMatrix.clearUpdateRanges();
      L.mesh.instanceMatrix.addUpdateRange(0, Math.max(1, n) * 16);
      L.mesh.instanceMatrix.needsUpdate = true;
      L.mesh.instanceColor.clearUpdateRanges();
      L.mesh.instanceColor.addUpdateRange(0, Math.max(1, n) * 3);
      L.mesh.instanceColor.needsUpdate = true;
    });
  }

  stats() {
    if (!this.layers) return { draws: 0, instances: 0, tris: 0 };
    let draws = 0;
    let instances = 0;
    let tris = 0;
    for (const L of this.layers) {
      if (!L.mesh.visible || !L.mesh.count || !this.group.visible) continue;
      draws++;
      instances += L.mesh.count;
      const g = L.geo;
      tris += ((g.index ? g.index.count : g.attributes.position.count) / 3) * L.mesh.count;
    }
    return { draws, instances, tris: Math.round(tris) };
  }
}
