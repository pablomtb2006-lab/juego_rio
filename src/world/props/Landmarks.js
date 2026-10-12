import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../../core/random.js';
import { createPropMaterial } from './propMaterial.js';
import { buildRockArch } from './RockArch.js';
import { buildRockMesh } from './RockFactory.js';
import { ensurePropAttributes } from './util.js';
import { makeWaterTest, terrainMaxHeight } from './Scatter.js';
import { Birds } from './Birds.js';

/**
 * Hero props for wayfinding. Every site is searched in TerrainData at init (no
 * hard-coded coordinates), so they follow any island shape.
 *   arch       eroded sandstone ring on peaks[0] — the drop gate (contract below)
 *   lighthouse white/red tower + keeper's cottage on the most exposed coastal headland
 *   ruins      a ring of broken columns on a flat plateau above a valley
 *   spires     a cluster of tall sandstone hoodoos on a secondary summit
 *   birds      gull flocks along the coast, dark flocks over valleys, one around the arch
 *
 * Contract:
 *   landmarks.arch = { position: Vector3 (centre of the opening), radius (clear m),
 *                      mesh (Group), normal (Vector3, axis through the opening, up/outwards) }
 *   landmarks.sites = { lighthouse, ruins, spires } → { x, y, z } | null
 */
export class Landmarks {
  constructor(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'landmarks';
    ctx.scene.add(this.group);
    this.sites = {};
    this.materials = [];
  }

  init() {
    const { ctx } = this;
    const { terrain } = ctx;
    this.rand = mulberry32((terrain.seed ?? 7) * 7 + 3);
    this.hMax = terrainMaxHeight(terrain);
    this.waterAt = makeWaterTest(terrain);

    this.rockMat = createPropMaterial({ name: 'landmark-rock', rock: true, roughness: 0.95, moss: 0.35 });
    this.archMat = createPropMaterial({ name: 'arch-rock', rock: true, roughness: 0.96, moss: 0.15, snow: 0.0, strata: 0.35 });
    this.stoneMat = createPropMaterial({ name: 'ruin-stone', rock: true, roughness: 0.9, moss: 0.8 });
    this.paintMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65, metalness: 0 });
    this.materials.push(this.rockMat, this.archMat, this.stoneMat, this.paintMat);

    // --- summit arch -----------------------------------------------------------
    const t0 = performance.now();
    const arch = buildRockArch(ctx, { material: this.archMat });
    this.archMs = Math.round(performance.now() - t0);
    this.group.add(arch.group);
    this.arch = { position: arch.position, radius: arch.radius, mesh: arch.group, normal: arch.normal };

    // --- other heroes ------------------------------------------------------------
    const avoid = [{ x: arch.position.x, z: arch.position.z, r: 900 }];
    const lh = this.findHeadland(avoid);
    if (lh) {
      this.buildLighthouse(lh);
      avoid.push({ x: lh.x, z: lh.z, r: 900 });
    }
    const ru = this.findPlateau(avoid);
    if (ru) {
      this.buildRuins(ru);
      avoid.push({ x: ru.x, z: ru.z, r: 700 });
    }
    const sp = this.findSpires(avoid);
    if (sp) this.buildSpires(sp);
    this.sites = { lighthouse: lh, ruins: ru, spires: sp };

    // --- birds ------------------------------------------------------------------
    this.birds = new Birds(ctx);
    this.birds.build(this.findFlocks(lh), (terrain.seed ?? 7) + 55);
    console.info(`[props] landmarks: arch ${this.archMs} ms, ${this.birds.count} birds, sites ${JSON.stringify(Object.fromEntries(Object.entries(this.sites).map(([k, v]) => [k, v ? [Math.round(v.x), Math.round(v.z)] : null])))}`);
  }

  // ---------------------------------------------------------------------------
  // site search

  near(avoid, x, z) {
    for (const a of avoid) if (Math.hypot(x - a.x, z - a.z) < a.r) return true;
    return false;
  }

  /** Most exposed coastal point (sea on most sides), moderately high, gentle ground. */
  findHeadland(avoid) {
    const { terrain } = this.ctx;
    const half = terrain.size / 2;
    const n = new THREE.Vector3();
    let best = null;
    for (let z = -half; z < half; z += 50) {
      for (let x = -half; x < half; x += 50) {
        const h = terrain.heightAt(x, z);
        if (h < 6 || h > 70) continue;
        if (this.near(avoid, x, z)) continue;
        let close = false;
        for (let k = 0; k < 8 && !close; k++) {
          const a = (k / 8) * Math.PI * 2;
          if (terrain.heightAt(x + Math.cos(a) * 90, z + Math.sin(a) * 90) < 0) close = true;
        }
        if (!close) continue;
        terrain.normalAt(x, z, n);
        if (n.y < 0.8) continue;
        let sea = 0;
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          if (terrain.heightAt(x + Math.cos(a) * 260, z + Math.sin(a) * 260) < 0) sea++;
        }
        const score = sea / 16 + 0.25 * (1 - Math.min(1, Math.abs(h - 28) / 28)) + 0.2 * n.y;
        if (!best || score > best.score) best = { x, y: h, z, score };
      }
    }
    return best;
  }

  /** Flat plateau at low-mid altitude, overlooking a valley, dry. */
  findPlateau(avoid) {
    const { terrain } = this.ctx;
    const half = terrain.size / 2;
    const n = new THREE.Vector3();
    let best = null;
    for (let z = -half; z < half; z += 70) {
      for (let x = -half; x < half; x += 70) {
        const h = terrain.heightAt(x, z);
        const hr = h / this.hMax;
        if (hr < 0.07 || hr > 0.4 || h < 12) continue;
        if (this.near(avoid, x, z)) continue;
        if ((terrain.distToSea?.(x, z) ?? 1e9) < 250) continue;
        if (this.waterAt(x, z, h).near > 0.2) continue;
        let flat = 0;
        terrain.normalAt(x, z, n);
        flat += n.y;
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          terrain.normalAt(x + Math.cos(a) * 20, z + Math.sin(a) * 20, n);
          flat += n.y;
        }
        flat /= 9;
        if (flat < 0.955) continue;
        // a valley nearby (streams pass by), but not in the channel itself
        let vflow = 0;
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          vflow = Math.max(vflow, terrain.flowAt(x + Math.cos(a) * 160, z + Math.sin(a) * 160));
        }
        const here = terrain.flowAt(x, z);
        if (here > 0.4) continue;
        const score = flat * 2 + Math.min(vflow, 0.7) + 0.3 * (1 - Math.abs(hr - 0.2) / 0.2);
        if (!best || score > best.score) best = { x, y: h, z, score };
      }
    }
    return best;
  }

  /** Secondary summit (not the arch peak) for the spire cluster. */
  findSpires(avoid) {
    const { terrain } = this.ctx;
    for (const p of terrain.peaks ?? []) {
      if (this.near(avoid, p.x, p.z)) continue;
      return { x: p.x, y: p.y, z: p.z };
    }
    // fallback: highest point outside the avoid zones
    const half = terrain.size / 2;
    let best = null;
    for (let z = -half; z < half; z += 100)
      for (let x = -half; x < half; x += 100) {
        if (this.near(avoid, x, z)) continue;
        const h = terrain.heightAt(x, z);
        if (!best || h > best.y) best = { x, y: h, z };
      }
    return best;
  }

  findFlocks(lighthouse) {
    const { terrain } = this.ctx;
    const flocks = [];
    const rand = this.rand;
    // coast: walk around the island and take sea points next to land
    const R0 = terrain.size * 0.5;
    const coastPts = [];
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * Math.PI * 2;
      // march inwards from the edge until land, then back off to sea
      for (let r = R0; r > 200; r -= 40) {
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        if (terrain.heightAt(x, z) > 0) {
          const rr = r + 160;
          coastPts.push({ x: Math.cos(a) * rr, z: Math.sin(a) * rr, a });
          break;
        }
      }
    }
    const nCoast = Math.min(6, coastPts.length);
    for (let i = 0; i < nCoast; i++) {
      const p = coastPts[Math.floor((i / nCoast) * coastPts.length + rand() * 3) % coastPts.length];
      flocks.push({ x: p.x, y: 45 + rand() * 50, z: p.z, radius: 70 + rand() * 60, count: 7 + Math.floor(rand() * 7), kind: 'gull', size: 2.6, speed: 13 });
    }
    if (lighthouse) flocks.push({ x: lighthouse.x, y: lighthouse.y + 55, z: lighthouse.z, radius: 60, count: 9, kind: 'gull', size: 2.6, speed: 12 });
    // valleys: high-flow points at mid altitude
    const half = terrain.size / 2;
    const cand = [];
    for (let z = -half; z < half; z += 300)
      for (let x = -half; x < half; x += 300) {
        const h = terrain.heightAt(x, z);
        const f = terrain.flowAt(x, z);
        if (h > 80 && h < this.hMax * 0.5 && f > 0.45) cand.push({ x, z, h, f });
      }
    cand.sort((a, b) => b.f - a.f);
    const picked = [];
    for (const c of cand) {
      if (picked.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < 1500)) continue;
      picked.push(c);
      flocks.push({ x: c.x, y: c.h + 90 + rand() * 60, z: c.z, radius: 90 + rand() * 70, count: 6 + Math.floor(rand() * 6), kind: 'dark', size: 1.9, speed: 15 });
      if (picked.length >= 4) break;
    }
    // around the arch (seen during the drop)
    const ap = this.arch.position;
    flocks.push({ x: ap.x, y: ap.y + 30, z: ap.z, radius: 150, count: 10, kind: 'gull', size: 3.2, speed: 16 });
    return flocks;
  }

  // ---------------------------------------------------------------------------
  // builders

  /** Mesh of chiselled boulders (vertex coloured) merged into one draw. */
  boulders(list, color, mat = this.rockMat) {
    const geos = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (const b of list) {
      const g = buildRockMesh({ seed: b.seed, detail: b.detail ?? 2, scale: b.shape ?? new THREE.Vector3(1.2, 0.85, 1), cuts: b.cuts ?? 8, noise: 0.26, cutMin: b.cuts ? 0.5 : 0.6 });
      const c = g.attributes.color;
      for (let i = 0; i < c.count; i++) c.setXYZ(i, c.getX(i) * color.r, c.getY(i) * color.g, c.getZ(i) * color.b);
      g.attributes.aTint.array.fill(0);
      q.setFromEuler(new THREE.Euler(b.rx ?? 0, b.ry ?? 0, b.rz ?? 0));
      m.compose(new THREE.Vector3(b.x, b.y, b.z), q, new THREE.Vector3(b.s, b.s * (b.sy ?? 1), b.s));
      g.applyMatrix4(m);
      geos.push(g);
    }
    const merged = mergeGeometries(geos);
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.customDepthMaterial = mat.userData.depth;
    return mesh;
  }

  buildLighthouse(site) {
    const { terrain } = this.ctx;
    const rand = this.rand;
    const g = new THREE.Group();
    g.name = 'lighthouse';
    const S = 1.6; // hero scale (readable from the drop)
    const base = terrain.heightAt(site.x, site.z);
    g.position.set(site.x, base, site.z);
    // face the open sea
    let seaDir = 0;
    let bestSea = -1;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const h = terrain.heightAt(site.x + Math.cos(a) * 200, site.z + Math.sin(a) * 200);
      if (-h > bestSea) {
        bestSea = -h;
        seaDir = a;
      }
    }

    const WHITE = new THREE.Color(0xf2eee6);
    const RED = new THREE.Color(0xc8432b);
    const STONE = new THREE.Color(0xcfc6b8);
    const DARK = new THREE.Color(0x3a3d42);
    const paint = (geo, colFn) => {
      const P = geo.attributes.position;
      const col = new Float32Array(P.count * 3);
      const c = new THREE.Color();
      for (let i = 0; i < P.count; i++) {
        colFn(P.getX(i), P.getY(i), P.getZ(i), c);
        col.set([c.r, c.g, c.b], i * 3);
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      return geo;
    };
    const parts = [];
    // plinth
    parts.push(paint(new THREE.CylinderGeometry(7 * S, 8 * S, 3.2 * S, 18).translate(0, 1.2 * S, 0), (x, y, z, c) => c.copy(STONE).multiplyScalar(0.85 + 0.15 * (y > 2 * S ? 1 : 0))));
    // tower: stacked tapered bands, alternating white / red (crisp stripes)
    const H0 = 2.8 * S;
    const H1 = 27 * S;
    const bands = 6;
    const rAt = (t) => (4.7 - 1.6 * t) * S;
    for (let b = 0; b < bands; b++) {
      const t0 = b / bands;
      const t1 = (b + 1) / bands;
      const y0 = H0 + (H1 - H0) * t0;
      const y1 = H0 + (H1 - H0) * t1;
      const band = new THREE.CylinderGeometry(rAt(t1), rAt(t0), y1 - y0, 24, 1, true).translate(0, (y0 + y1) / 2, 0);
      const col = b % 2 === 0 ? WHITE : RED;
      parts.push(paint(band, (x, y, z, c) => c.copy(col).multiplyScalar(0.94 + 0.06 * t1)));
    }
    // windows
    for (let k = 0; k < 3; k++) {
      const y = H0 + (H1 - H0) * (0.25 + k * 0.25);
      const r = (4.7 - 1.6 * (0.25 + k * 0.25)) * S;
      const a = seaDir + Math.PI * 0.5 * k;
      parts.push(paint(new THREE.BoxGeometry(1.1 * S, 1.8 * S, 0.6 * S).translate(Math.cos(a) * r, y, Math.sin(a) * r).rotateY(0), (x, y2, z, c) => c.copy(DARK)));
    }
    // gallery deck + rail
    parts.push(paint(new THREE.CylinderGeometry(4.6 * S, 4.2 * S, 0.7 * S, 24).translate(0, H1 + 0.3 * S, 0), (x, y, z, c) => c.copy(DARK)));
    parts.push(paint(new THREE.CylinderGeometry(4.5 * S, 4.5 * S, 1.2 * S, 24, 1, true).translate(0, H1 + 1.2 * S, 0), (x, y, z, c) => c.copy(DARK).multiplyScalar(1.3)));
    // roof
    parts.push(paint(new THREE.ConeGeometry(3.4 * S, 3.2 * S, 20).translate(0, H1 + 5.6 * S, 0), (x, y, z, c) => c.copy(RED).multiplyScalar(0.85)));
    parts.push(paint(new THREE.SphereGeometry(0.5 * S, 10, 8).translate(0, H1 + 7.4 * S, 0), (x, y, z, c) => c.copy(DARK)));
    // keeper's cottage (landward)
    const la = seaDir + Math.PI;
    const hx = Math.cos(la) * 14 * S;
    const hz = Math.sin(la) * 14 * S;
    const hy = terrain.heightAt(site.x + hx, site.z + hz) - base;
    const house = new THREE.BoxGeometry(10 * S, 5 * S, 7 * S).translate(0, 2.3 * S, 0);
    const roof = new THREE.CylinderGeometry(0.01, 6.4 * S, 10.6 * S, 3, 1).rotateZ(Math.PI / 2).rotateX(Math.PI / 6).scale(1, 0.6, 1).translate(0, 5.6 * S, 0);
    const chim = new THREE.BoxGeometry(1.2 * S, 3 * S, 1.2 * S).translate(3 * S, 7 * S, 1.2 * S);
    const houseGroup = [paint(house, (x, y, z, c) => c.copy(WHITE).multiplyScalar(0.95)), paint(roof, (x, y, z, c) => c.set(0xc5552f)), paint(chim, (x, y, z, c) => c.copy(STONE))];
    for (const hg of houseGroup) {
      hg.rotateY(-la);
      hg.translate(hx, hy, hz);
      parts.push(hg);
    }
    const merged = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)).map((p) => {
      p.deleteAttribute('uv');
      p.computeVertexNormals();
      return p;
    }));
    const body = new THREE.Mesh(merged, this.paintMat);
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);
    // lantern (emissive → blooms)
    const lantern = new THREE.Mesh(
      new THREE.CylinderGeometry(2.5 * S, 2.5 * S, 3.2 * S, 16).translate(0, H1 + 2.6 * S, 0),
      new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0xffd36a, emissiveIntensity: 2.2, roughness: 0.2 }),
    );
    g.add(lantern);
    // rotating light beams (subtle by day)
    const beamGeo = new THREE.ConeGeometry(9, 160, 16, 1, true).translate(0, -80, 0).rotateZ(Math.PI / 2);
    const beamMat = new THREE.MeshBasicMaterial({ color: 0xfff1b8, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: true });
    this.beam = new THREE.Group();
    this.beam.position.set(0, H1 + 2.6 * S, 0);
    const b1 = new THREE.Mesh(beamGeo, beamMat);
    const b2 = new THREE.Mesh(beamGeo, beamMat);
    b2.rotation.y = Math.PI;
    this.beam.add(b1, b2);
    g.add(this.beam);
    // orange coastal rocks around the plinth
    const ORANGE = new THREE.Color(0xd07a4a);
    const rocks = [];
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + rand() * 0.5;
      const d = (12 + rand() * 14) * S;
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      const s = (3 + rand() * 5) * S;
      rocks.push({ x, y: terrain.heightAt(site.x + x, site.z + z) - base - s * 0.3, z, s, seed: 300 + i, ry: rand() * 6 });
    }
    g.add(this.boulders(rocks, ORANGE));
    this.group.add(g);
    this.lighthouse = g;
  }

  buildRuins(site) {
    const { terrain } = this.ctx;
    const rand = this.rand;
    const STONE = new THREE.Color(0xd9cfbe);
    const geos = [];
    const add = (geo, colScale = 1) => {
      const g = geo.index ? geo.toNonIndexed() : geo;
      g.deleteAttribute('uv');
      g.computeVertexNormals();
      const P = g.attributes.position;
      const col = new Float32Array(P.count * 3);
      for (let i = 0; i < P.count; i++) {
        const ao = 0.8 + 0.2 * Math.min(1, Math.max(0, P.getY(i) / 6));
        col.set([STONE.r * ao * colScale, STONE.g * ao * colScale, STONE.b * ao * colScale], i * 3);
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      ensurePropAttributes(g, { tint: 0 });
      geos.push(g);
    };
    const base = terrain.heightAt(site.x, site.z);
    // stepped platform (sinks into the slope)
    add(new THREE.CylinderGeometry(18, 19.5, 4, 30).translate(0, -1.2, 0), 0.92);
    add(new THREE.CylinderGeometry(15.5, 16.5, 1.2, 30).translate(0, 1.2, 0), 0.98);
    // fluted columns
    const fluted = (h) => {
      const g = new THREE.CylinderGeometry(1.05, 1.2, h, 16, 1);
      const P = g.attributes.position;
      for (let i = 0; i < P.count; i++) {
        const x = P.getX(i);
        const z = P.getZ(i);
        const a = Math.atan2(z, x);
        const k = 1 + 0.07 * Math.cos(a * 8);
        P.setX(i, x * k);
        P.setZ(i, z * k);
      }
      return g;
    };
    const N = 12;
    const standing = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const x = Math.cos(a) * 12.5;
      const z = Math.sin(a) * 12.5;
      const r = rand();
      if (r < 0.17) {
        // fallen column lying outside the platform
        const len = 6 + rand() * 4;
        const fa = a + (rand() - 0.5) * 0.8;
        const d = 21 + rand() * 6;
        const gx = Math.cos(fa) * d;
        const gz = Math.sin(fa) * d;
        const gy = terrain.heightAt(site.x + gx, site.z + gz) - base + 0.6;
        add(fluted(len).rotateZ(Math.PI / 2).rotateY(-fa + (rand() - 0.5)).translate(gx, gy, gz));
        continue;
      }
      const broken = r < 0.5;
      const h = broken ? 2.5 + rand() * 5 : 11;
      add(fluted(h).translate(x, 1.8 + h / 2, z));
      add(new THREE.BoxGeometry(2.8, 0.6, 2.8).translate(x, 2.1, z), 0.95); // base
      if (!broken) {
        add(new THREE.BoxGeometry(2.9, 0.8, 2.9).translate(x, 1.8 + h + 0.4, z), 1.02); // capital
        standing.push({ i, x, z, top: 1.8 + h + 0.8 });
      }
    }
    // architrave across consecutive standing columns
    for (let k = 0; k < standing.length - 1; k++) {
      const a = standing[k];
      const b = standing[k + 1];
      if (b.i !== a.i + 1) continue;
      const mx = (a.x + b.x) / 2;
      const mz = (a.z + b.z) / 2;
      const len = Math.hypot(b.x - a.x, b.z - a.z) + 2.4;
      const ang = Math.atan2(b.z - a.z, b.x - a.x);
      add(new THREE.BoxGeometry(len, 1.4, 2.4).rotateY(-ang).translate(mx, a.top + 0.7, mz), 1.0);
    }
    // altar
    add(new THREE.BoxGeometry(4, 2.2, 2.6).translate(0, 2.9, 0), 0.96);
    const merged = mergeGeometries(geos);
    const mesh = new THREE.Mesh(merged, this.stoneMat);
    mesh.position.set(site.x, base, site.z);
    mesh.rotation.y = rand() * Math.PI * 2;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.customDepthMaterial = this.stoneMat.userData.depth;
    mesh.name = 'ruins';
    this.group.add(mesh);
    // tumbled blocks around
    const blocks = [];
    for (let i = 0; i < 10; i++) {
      const a = rand() * Math.PI * 2;
      const d = 20 + rand() * 18;
      const x = site.x + Math.cos(a) * d;
      const z = site.z + Math.sin(a) * d;
      const s = 1 + rand() * 1.6;
      blocks.push({ x, y: terrain.heightAt(x, z) - s * 0.2, z, s, seed: 600 + i, ry: rand() * 6, shape: new THREE.Vector3(1.3, 0.8, 1) });
    }
    this.group.add(this.boulders(blocks, STONE, this.stoneMat));
  }

  buildSpires(site) {
    const { terrain } = this.ctx;
    const rand = this.rand;
    const SAND = new THREE.Color(0xa88b72);
    const list = [];
    const count = 9;
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const d = i === 0 ? 0 : 30 + rand() * 120;
      const x = site.x + Math.cos(a) * d;
      const z = site.z + Math.sin(a) * d;
      let gy = terrain.heightAt(x, z);
      for (let k = 0; k < 6; k++) {
        const b = (k / 6) * Math.PI * 2;
        gy = Math.min(gy, terrain.heightAt(x + Math.cos(b) * 14, z + Math.sin(b) * 14));
      }
      const H = i === 0 ? 120 : 40 + rand() * 70;
      const w = H * (0.12 + rand() * 0.05);
      // one tall chiselled column (+ a shorter buttress) per spire
      list.push({ x, y: gy - H * 0.12, z, s: w, sy: H / w / 2.2, seed: 700 + i * 10, ry: rand() * 6, rx: (rand() - 0.5) * 0.12, rz: (rand() - 0.5) * 0.12, detail: 2, shape: new THREE.Vector3(1, 2.2, 0.85), cuts: 10 });
      if (rand() < 0.6) list.push({ x: x + w * 0.9, y: gy - 5, z: z + w * 0.3, s: w * 0.8, sy: 1.3, seed: 705 + i * 10, ry: rand() * 6, detail: 2, shape: new THREE.Vector3(1.2, 1.6, 1) });
    }
    const mesh = this.boulders(list, SAND, this.archMat);
    mesh.name = 'spires';
    this.group.add(mesh);
  }

  update(dt, time) {
    if (this.beam) this.beam.rotation.y = time * 0.6;
    this.birds?.update(dt, time);
  }
}
