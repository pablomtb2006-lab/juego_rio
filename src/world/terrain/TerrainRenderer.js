import * as THREE from 'three';
import { DETAIL_MAX } from './detail.js';
import { createTerrainTextures } from './TerrainTextures.js';
import { TERRAIN_VERTEX_PARS, TERRAIN_FRAGMENT_PARS, TERRAIN_FRAGMENT_MAIN } from './terrainShader.js';
import { BIOME_UNIFORMS } from '../../game/biomes.js';

/**
 * Draws ctx.terrain with CDLOD (continuous distance-dependent LOD, Strugar 2010):
 * a camera-driven quadtree selects patches every frame; one instanced grid mesh draws them
 * all (1 draw call + 1 for the shadow map), sampling the height texture in the vertex shader
 * (Catmull-Rom bicubic + the shared detail noise → identical to TerrainData.heightAt).
 * Vertices geomorph towards the next coarser grid near each LOD range, so there are no
 * cracks or popping, from 3 km up (drop) down to the chase cam a few metres above a river.
 *
 * Contract: constructor(ctx), init(), update(dt, time). Adds its meshes to ctx.scene.
 * Exposes `material` (MeshStandardMaterial; uniforms in material.userData.uniforms) and
 * `stats` { nodes, triangles } for the last frame.
 */
const MAX_NODES = 1600;
const RANGE_K = 4; // LOD range / node size (≥ 3.5 keeps morph regions crack-free)

const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const _box = new THREE.Box3();
const _camPos = new THREE.Vector3();

export class TerrainRenderer {
  constructor(ctx) {
    this.ctx = ctx;
    this.stats = { nodes: 0, triangles: 0 };
  }

  init() {
    const { terrain, scene, quality, renderer } = this.ctx;
    const q = quality;
    this.patchN = Math.max(8, Math.min(32, Math.round((q.terrainGrid ?? 128) / 8)));
    // finest vertex spacing; terrainRings scales how far the dense levels reach
    this.s0 = { low: 4, medium: 3, high: 2, ultra: 1.5 }[q.name] ?? 2;
    this.leaf = this.patchN * this.s0;
    this.rangeK = RANGE_K * (0.75 + 0.25 * ((q.terrainRings ?? 6) / 6));
    const world = Math.max(terrain.size * 2.6, 60000);
    this.levels = Math.ceil(Math.log2(world / this.leaf)) + 1;
    this.rootSize = this.leaf * 2 ** (this.levels - 1);
    this.ranges = [];
    for (let L = 0; L < this.levels; L++) this.ranges.push(this.rangeK * this.leaf * 2 ** L);

    this.buildMinMax();
    this.geometry = this.buildGeometry();
    this.textures = createTerrainTextures(renderer, q);

    const uniforms = {
      tHeight: { value: terrain.heightTexture },
      tInfo: { value: terrain.infoTexture },
      tMask: { value: terrain.maskTexture },
      tNoise: { value: this.textures.noise },
      tRock: { value: this.textures.rock },
      tGround: { value: this.textures.ground },
      uTerrain: { value: new THREE.Vector4(terrain.size, terrain.res, terrain.cell, terrain.res - 1) },
      uLodCam: { value: new THREE.Vector3() },
      uLodR0: { value: this.ranges[0] },
      uPatchN: { value: this.patchN },
      uTime: { value: 0 },
      ...BIOME_UNIFORMS, // game/biomes.js — same objects, so a new match re-colours the island
    };
    this.uniforms = uniforms;
    const defines = { TERRAIN_HQ: q.name === 'high' || q.name === 'ultra' ? 1 : 0 };

    const material = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
    material.userData.uniforms = uniforms;
    material.defines = { ...defines };
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${TERRAIN_VERTEX_PARS}`)
        .replace('#include <beginnormal_vertex>', `vec3 tPos; vec3 tNrm; terrainVertex(tPos, tNrm);\nvec3 objectNormal = tNrm;`)
        .replace('#include <begin_vertex>', 'vec3 transformed = tPos;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${TERRAIN_FRAGMENT_PARS}`)
        .replace('#include <map_fragment>', TERRAIN_FRAGMENT_MAIN)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRough;')
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
        .replace(
          '#include <normal_fragment_begin>',
          `float faceDirection = gl_FrontFacing ? 1.0 : -1.0;
           vec3 normal = normalize((viewMatrix * vec4(tN, 0.0)).xyz);
           vec3 nonPerturbedNormal = normalize((viewMatrix * vec4(tNg, 0.0)).xyz);`,
        )
        .replace('#include <normal_fragment_maps>', '')
        .replace(
          '#include <aomap_fragment>',
          `reflectedLight.indirectDiffuse *= tAO;
           reflectedLight.directDiffuse *= mix(1.0, tAO, 0.35);
           #if defined( USE_ENVMAP ) && defined( STANDARD )
             reflectedLight.indirectSpecular *= computeSpecularOcclusion(saturate(dot(geometryNormal, geometryViewDir)), tAO, material.roughness);
           #endif`,
        );
    };
    material.customProgramCacheKey = () => `terrain-cdlod-${defines.TERRAIN_HQ}`;

    const depth = new THREE.MeshDepthMaterial();
    depth.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${TERRAIN_VERTEX_PARS}`)
        .replace('#include <begin_vertex>', 'vec3 tPos; vec3 tNrm; terrainVertex(tPos, tNrm);\nvec3 transformed = tPos;');
    };
    depth.customProgramCacheKey = () => 'terrain-cdlod-depth';

    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = !!q.shadows && (q.name === 'high' || q.name === 'ultra');
    mesh.customDepthMaterial = depth;
    mesh.name = 'terrain';
    mesh.renderOrder = -1;
    scene.add(mesh);
    this.mesh = mesh;
    this.material = material;
    this.depthMaterial = depth;
    this.update(0, 0);
  }

  /** Grid patch: (N+1)² vertices with integer coords in position.xz, one diagonal orientation. */
  buildGeometry() {
    const N = this.patchN;
    const pos = new Float32Array((N + 1) * (N + 1) * 3);
    let p = 0;
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        pos[p++] = i;
        pos[p++] = 0;
        pos[p++] = j;
      }
    }
    const idx = new Uint16Array(N * N * 6);
    let q = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * (N + 1) + i;
        const b = a + 1;
        const c = a + N + 1;
        const d = c + 1;
        idx[q++] = a;
        idx[q++] = c;
        idx[q++] = d;
        idx[q++] = a;
        idx[q++] = d;
        idx[q++] = b;
      }
    }
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.nodeData = new Float32Array(MAX_NODES * 4);
    this.nodeAttr = new THREE.InstancedBufferAttribute(this.nodeData, 4);
    this.nodeAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aNode', this.nodeAttr);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(-1e6, -1e4, -1e6), new THREE.Vector3(1e6, 1e4, 1e6));
    return geo;
  }

  /** Min/max height pyramid over the data grid (blocks of 2^l cells) for node bounding boxes. */
  buildMinMax() {
    const { heights, res } = this.ctx.terrain;
    const cells = res - 1;
    const pyr = [];
    let n = cells;
    let mn = new Float32Array(n * n);
    let mx = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * res + i;
        const a = heights[k];
        const b = heights[k + 1];
        const c = heights[k + res];
        const d = heights[k + res + 1];
        mn[j * n + i] = Math.min(a, b, c, d);
        mx[j * n + i] = Math.max(a, b, c, d);
      }
    }
    pyr.push({ n, mn, mx });
    while (n > 1) {
      const m = Math.ceil(n / 2);
      const mn2 = new Float32Array(m * m);
      const mx2 = new Float32Array(m * m);
      for (let j = 0; j < m; j++) {
        for (let i = 0; i < m; i++) {
          let lo = Infinity;
          let hi = -Infinity;
          for (let dj = 0; dj < 2; dj++) {
            for (let di = 0; di < 2; di++) {
              const ii = Math.min(i * 2 + di, n - 1);
              const jj = Math.min(j * 2 + dj, n - 1);
              lo = Math.min(lo, mn[jj * n + ii]);
              hi = Math.max(hi, mx[jj * n + ii]);
            }
          }
          mn2[j * m + i] = lo;
          mx2[j * m + i] = hi;
        }
      }
      n = m;
      mn = mn2;
      mx = mx2;
      pyr.push({ n, mn, mx });
    }
    this.pyr = pyr;
    this._mm = [0, 0];
  }

  /** Height range over a world-space rectangle (+ margins for bicubic overshoot and detail). */
  heightRange(x0, z0, x1, z1, out) {
    const t = this.ctx.terrain;
    const cells = t.res - 1;
    const s = cells / t.size;
    let i0 = Math.floor((x0 + t.size / 2) * s) - 1;
    let i1 = Math.floor((x1 + t.size / 2) * s) + 1;
    let j0 = Math.floor((z0 + t.size / 2) * s) - 1;
    let j1 = Math.floor((z1 + t.size / 2) * s) + 1;
    i0 = Math.max(0, Math.min(cells - 1, i0));
    i1 = Math.max(0, Math.min(cells - 1, i1));
    j0 = Math.max(0, Math.min(cells - 1, j0));
    j1 = Math.max(0, Math.min(cells - 1, j1));
    const span = Math.max(i1 - i0, j1 - j0) + 1;
    let l = Math.max(0, Math.ceil(Math.log2(span / 3)));
    l = Math.min(l, this.pyr.length - 1);
    const P = this.pyr[l];
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = j0 >> l; j <= j1 >> l; j++) {
      for (let i = i0 >> l; i <= i1 >> l; i++) {
        const k = Math.min(j, P.n - 1) * P.n + Math.min(i, P.n - 1);
        if (P.mn[k] < lo) lo = P.mn[k];
        if (P.mx[k] > hi) hi = P.mx[k];
      }
    }
    out[0] = lo - DETAIL_MAX - 6;
    out[1] = hi + DETAIL_MAX + 6;
    return out;
  }

  update(dt, time) {
    const { camera } = this.ctx;
    if (!this.mesh) return;
    camera.updateMatrixWorld();
    camera.getWorldPosition(_camPos);
    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);
    this.uniforms.uLodCam.value.copy(_camPos);
    this.uniforms.uTime.value = time;
    this.count = 0;
    const half = this.rootSize / 2;
    this.select(-half, -half, this.rootSize, this.levels - 1);
    this.geometry.instanceCount = this.count;
    this.nodeAttr.clearUpdateRanges();
    this.nodeAttr.addUpdateRange(0, this.count * 4);
    this.nodeAttr.needsUpdate = true;
    this.stats.nodes = this.count;
    this.stats.triangles = this.count * this.patchN * this.patchN * 2;
  }

  /** Strugar's LOD select. Returns false when the node is outside its LOD range. */
  select(x0, z0, size, L) {
    const mm = this.heightRange(x0, z0, x0 + size, z0 + size, this._mm);
    _box.min.set(x0, mm[0], z0);
    _box.max.set(x0 + size, mm[1], z0 + size);
    const r = this.ranges[L];
    if (_box.distanceToPoint(_camPos) > r) return false;
    // shadow casters right around the camera are kept even when off-screen
    if (!_frustum.intersectsBox(_box) && _box.distanceToPoint(_camPos) > 350) return true;
    if (L === 0) {
      this.add(x0, z0, size, 0);
      return true;
    }
    if (_box.distanceToPoint(_camPos) > this.ranges[L - 1]) {
      this.add(x0, z0, size, L);
      return true;
    }
    const h = size / 2;
    for (let c = 0; c < 4; c++) {
      const cx = x0 + (c & 1) * h;
      const cz = z0 + (c >> 1) * h;
      if (!this.select(cx, cz, h, L - 1)) {
        // child out of its own range: draw it with the child's patch, fully morphed to level L
        const mm2 = this.heightRange(cx, cz, cx + h, cz + h, this._mm);
        _box.min.set(cx, mm2[0], cz);
        _box.max.set(cx + h, mm2[1], cz + h);
        if (_frustum.intersectsBox(_box) || _box.distanceToPoint(_camPos) <= 350) this.add(cx, cz, h, L - 1);
      }
    }
    return true;
  }

  add(x0, z0, size, L) {
    if (this.count >= MAX_NODES) return;
    const o = this.count * 4;
    this.nodeData[o] = x0;
    this.nodeData[o + 1] = z0;
    this.nodeData[o + 2] = size;
    this.nodeData[o + 3] = L;
    this.count++;
  }
}
