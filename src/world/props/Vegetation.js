import * as THREE from 'three';
import { TREE_SPECIES, buildSpecies } from './TreeFactory.js';
import { ROCK_SPECS, buildRockSpec } from './RockFactory.js';
import { scatterProps, terrainMaxHeight } from './Scatter.js';
import { InstanceLOD } from './InstanceLOD.js';
import { GroundCover } from './GroundCover.js';
import { createPropMaterial, PROP_UNIFORMS, linkAtmosphere } from './propMaterial.js';

/**
 * Trees, bushes, rocks and ground cover for the whole island.
 *
 * Public (read-only for other systems):
 *   vegetation.materials   every prop material (e.g. for CSM / shader setup by render)
 *   vegetation.canopyTexture  R8 DataTexture over the terrain grid (same x/z mapping as
 *                          terrain.heightTexture): 0 = open ground … 1 = closed canopy.
 *                          Terrain may use it to darken / tint the forest floor.
 *   vegetation.stats()     { draws, shadowDraws, instances, tris, per-kind counts, ground }
 *   vegetation.counts      total placed instances per kind
 *
 * Quality: ctx.quality.vegetationDensity scales placement density and LOD radii,
 * ctx.quality.grass toggles the near ground cover, ctx.quality.drawDistance caps the far band.
 */

const WIND_AMP = { pine: 0.55, broad: 0.45, birch: 0.6, bush: 0.12 };
const LOD_SCALE = { low: 0.55, medium: 0.75, high: 1, ultra: 1.3 };

export class Vegetation {
  constructor(ctx) {
    this.ctx = ctx;
    this.materials = [];
    this.counts = {};
  }

  init() {
    const { ctx } = this;
    const { terrain, quality } = ctx;
    linkAtmosphere(ctx);
    const t0 = performance.now();
    const dens = quality.vegetationDensity ?? 1;
    const ls = LOD_SCALE[quality.name] ?? 1;
    const hMax = terrainMaxHeight(terrain);
    PROP_UNIFORMS.uSnowLine.value = hMax * 0.74;

    // --- materials (shared by every species) ----------------------------------
    const treeR1 = Math.round(620 * ls);
    const rockR1 = Math.round(420 * ls);
    const M = {
      solid: createPropMaterial({ name: 'tree', wind: 1, flutter: 0.05, stream: true, streamBend: 5, foliage: true, translucency: 0.5, roughness: 0.88, occlude: true }),
      cards: createPropMaterial({ name: 'leaves', cards: true, wind: 1, flutter: 0.07, stream: true, streamBend: 5, foliage: true, translucency: 0.6, roughness: 0.85, occlude: true }),
      far: createPropMaterial({ name: 'tree-far', far: true, wind: 1, foliage: true, translucency: 0.4, farHide: treeR1, roughness: 0.9 }),
      rock: createPropMaterial({ name: 'rock', rock: true, roughness: 0.95, snow: 0.25, occlude: true }),
      rockFar: createPropMaterial({ name: 'rock-far', rock: true, far: true, farHide: rockR1, roughness: 0.95, snow: 0.25 }),
    };
    this.materials.push(...Object.values(M));
    PROP_UNIFORMS.uThin.value.set(2500 * ls, 7500 * ls);

    // --- placement ------------------------------------------------------------
    const treeSpecs = quality.name === 'low' ? TREE_SPECIES.filter((s) => !/[2]$/.test(s.name)) : TREE_SPECIES;
    const tS = performance.now();
    const sc = scatterProps(terrain, {
      density: dens,
      seed: terrain.seed ?? ctx.params?.seed ?? 7,
      treeNames: treeSpecs.map((s) => s.name),
      rockNames: ROCK_SPECS.map((s) => s.name),
    });

    const tScatter = performance.now() - tS;
    this.canopyTexture = this.buildCanopy(sc, treeSpecs);
    // --- instancing -------------------------------------------------------------
    const tG = performance.now();
    this.lod = new InstanceLOD(ctx, {
      name: 'vegetation',
      chunkSize: 64,
      nearAll: 130 * ls,
      farMove: 60,
      farMax: quality.drawDistance ?? 12000,
      thin: [2500 * ls, 7500 * ls],
    });

    for (const spec of treeSpecs) {
      const g = buildSpecies(spec);
      const amp = WIND_AMP[spec.kind] ?? 0.4;
      for (const geo of [g.lod0.solid, g.lod0.cards, g.lod1.solid, g.lod1.cards, g.far]) {
        if (!geo) continue;
        const w = geo.attributes.aWind;
        for (let i = 0; i < w.count; i++) w.setX(i, w.getX(i) * amp);
      }
      const inst = sc.trees[spec.name];
      const bush = spec.kind === 'bush';
      const parts = (lod) => [
        { geometry: lod.solid, material: M.solid, castShadow: true },
        ...(lod.cards ? [{ geometry: lod.cards, material: M.cards, castShadow: !bush }] : []),
      ];
      this.lod.addKind({
        name: spec.name,
        r0: Math.round((bush ? 60 : 150) * ls),
        r1: bush ? Math.round(240 * ls) : treeR1,
        lod0: parts(g.lod0),
        lod1: parts(g.lod1),
        far: g.far ? { geometry: g.far, material: M.far } : null,
        mats: inst.mats,
        cols: inst.cols,
        count: inst.count,
        radius: spec.H * 0.7,
      });
      this.counts[spec.name] = inst.count;
    }

    // rocks: split by size — small ones vanish beyond the mid band, big ones get a far LOD
    for (const spec of ROCK_SPECS) {
      const g = buildRockSpec(spec);
      const inst = sc.rocks[spec.name];
      const small = { m: [], c: [] };
      const big = { m: [], c: [] };
      for (let i = 0; i < inst.count; i++) {
        const s = Math.hypot(inst.mats[i * 16], inst.mats[i * 16 + 1], inst.mats[i * 16 + 2]);
        const dst = s < 3.2 ? small : big;
        for (let k = 0; k < 16; k++) dst.m.push(inst.mats[i * 16 + k]);
        dst.c.push(inst.cols[i * 3], inst.cols[i * 3 + 1], inst.cols[i * 3 + 2]);
      }
      const add = (name, d, isBig) => {
        if (!d.c.length) return;
        this.lod.addKind({
          name,
          r0: Math.round((isBig ? 160 : 70) * ls),
          r1: isBig ? rockR1 : Math.round(300 * ls),
          lod0: [{ geometry: g.lod0, material: M.rock, castShadow: true }],
          lod1: [{ geometry: g.lod1, material: M.rock, castShadow: isBig }],
          far: isBig ? { geometry: g.far, material: M.rockFar } : null,
          mats: new Float32Array(d.m),
          cols: new Float32Array(d.c),
          count: d.c.length / 3,
          radius: 1.6,
        });
        this.counts[name] = d.c.length / 3;
      };
      add(spec.name, small, false);
      add(`${spec.name}_big`, big, true);
    }
    const tGeo = performance.now() - tG;
    const tB = performance.now();
    this.lod.build();
    const tBuild = performance.now() - tB;

    // --- near ground cover -------------------------------------------------------
    this.ground = new GroundCover(ctx);
    this.ground.init();
    if (this.ground.materials) this.materials.push(...this.ground.materials);

    this.buildMs = Math.round(performance.now() - t0);
    let total = 0;
    for (const v of Object.values(this.counts)) total += v;
    this.totalInstances = total;
    console.info(`[props] vegetation: ${total} instances in ${this.buildMs} ms (scatter ${tScatter | 0}, geometry ${tGeo | 0}, chunks ${tBuild | 0})`);
  }

  /** Tree coverage map (for terrain tinting / minimap). */
  buildCanopy(sc, specs) {
    const { terrain } = this.ctx;
    const R = 256;
    const acc = new Float32Array(R * R);
    const cell = terrain.size / R;
    for (const spec of specs) {
      if (spec.kind === 'bush') continue;
      const inst = sc.trees[spec.name];
      const area = Math.PI * Math.pow(spec.H * (spec.maxR ?? spec.crownR ?? 0.3), 2);
      for (let i = 0; i < inst.count; i++) {
        const x = inst.mats[i * 16 + 12];
        const z = inst.mats[i * 16 + 14];
        const s2 = inst.mats[i * 16 + 4] ** 2 + inst.mats[i * 16 + 5] ** 2 + inst.mats[i * 16 + 6] ** 2;
        const u = Math.floor((x / terrain.size + 0.5) * R);
        const v = Math.floor((z / terrain.size + 0.5) * R);
        if (u < 0 || v < 0 || u >= R || v >= R) continue;
        acc[v * R + u] += (area * s2) / (cell * cell);
      }
    }
    // one box blur pass, then encode coverage 0..1
    const data = new Uint8Array(R * R);
    for (let v = 0; v < R; v++) {
      for (let u = 0; u < R; u++) {
        let sum = 0;
        let n = 0;
        for (let dv = -1; dv <= 1; dv++)
          for (let du = -1; du <= 1; du++) {
            const uu = u + du;
            const vv = v + dv;
            if (uu < 0 || vv < 0 || uu >= R || vv >= R) continue;
            sum += acc[vv * R + uu] * (du || dv ? 1 : 2);
            n += du || dv ? 1 : 2;
          }
        data[v * R + u] = Math.round(255 * Math.min(1, sum / n));
      }
    }
    const tex = new THREE.DataTexture(data, R, R, THREE.RedFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  /** Pass up to 4 stream heads near the camera to the bend shader (juice). */
  updateStreams() {
    const U = PROP_UNIFORMS.uStreams.value;
    for (const v of U) v.set(0, 0, 0, 0);
    const streams = this.ctx.game?.streams;
    if (!streams?.length) return;
    const cam = this.ctx.camera.position;
    const list = [];
    for (const s of streams) {
      if (s.phase !== 'flow') continue;
      const d = Math.hypot(s.pos.x - cam.x, s.pos.z - cam.z);
      if (d < 700) list.push([d, s]);
    }
    list.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < Math.min(4, list.length); i++) {
      const s = list[i][1];
      const sp = Math.min(1, (s.speed ?? 10) / 25);
      U[i].set(s.pos.x, s.pos.z, (s.radius ?? 5) * 1.3, 0.6 + 0.4 * sp);
    }
  }

  /** Chase cam: fade props standing between the camera and the stream head. */
  updateFocus() {
    const F = PROP_UNIFORMS.uFocus.value;
    const dir = this.ctx.game?.cameraDirector;
    const s = dir?.target;
    if (dir && s && dir.mode === 'chase' && s.pos) {
      F.set(s.pos.x, s.pos.y + 2, s.pos.z, 1);
      PROP_UNIFORMS.uOccRadius.value = Math.max(5, (s.radius ?? 5) * 1.2 + 3);
      const a = dir.aheadPt;
      if (a) PROP_UNIFORMS.uAhead.value.set(a.x, a.y + 2, a.z, 1);
      else PROP_UNIFORMS.uAhead.value.w = 0;
    } else {
      F.w = 0;
      PROP_UNIFORMS.uAhead.value.w = 0;
    }
  }

  update(dt, time) {
    PROP_UNIFORMS.uPropTime.value = time;
    this.updateFocus();
    const sun = this.ctx.atmosphere?.sunDirection;
    if (sun && PROP_UNIFORMS.uSunDirP.value !== sun) PROP_UNIFORMS.uSunDirP.value.copy(sun);
    this.updateStreams();
    const cam = this.ctx.camera;
    this.lod?.update(cam);
    this.ground?.update(cam);
  }

  stats() {
    const s = this.lod ? this.lod.stats() : { draws: 0, instances: 0, tris: 0 };
    const g = this.ground?.stats() ?? { draws: 0, instances: 0, tris: 0 };
    return { ...s, ground: g, draws: s.draws + g.draws, totalPlaced: this.totalInstances };
  }
}
