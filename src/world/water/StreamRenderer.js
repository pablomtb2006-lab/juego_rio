import * as THREE from 'three';
import { terrainUniforms, envUniforms, syncEnv, streamPalette, waterTime } from './waterCommon.js';
import { RIVER_VERT, RIVER_FRAG, BLOB_VERT, BLOB_FRAG, EXT } from './streamShaders.js';
import { WaterFX, P, D } from './WaterFX.js';

/**
 * Draws every stream (player + rivals): the falling drop, the moving head and the
 * river trail it leaves behind. Reads (never writes) ctx.game.streams.
 * Stream fields it relies on (see game/Stream.js): id, phase, pos, vel, volume, radius,
 * skin, color, isPlayer, trail { data: Float32Array [x,y,z,width,...], count, version }.
 * Listens to bus 'splash' | 'absorb' | 'cut' | 'eliminated' | 'finished' for VFX.
 *
 * Trail ribbons are built incrementally into fixed-size chunks (frustum-culled individually):
 * each new trail point appends one cross-section row (COLS vertices sampled on the terrain),
 * only the freshest rows are rewritten each tick and uploaded with buffer update ranges.
 */

const COLS = 9; // vertices across the river
const CH = 256; // rows per chunk (first row shared with the previous chunk)
const UPDATE_TAIL = 5; // freshest rows rewritten every tick (tangent + swell changes)
const SEA_BIAS = -0.3;

const _v = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _c = new THREE.Color();
const WHITE = new THREE.Color(1, 1, 1);
const LAKE_COL = new THREE.Color(0x5fe0e6);

let sharedIndex = null;
function getSharedIndex() {
  if (sharedIndex) return sharedIndex;
  const idx = new Uint16Array((CH - 1) * (COLS - 1) * 6);
  let o = 0;
  for (let r = 0; r < CH - 1; r++) {
    for (let c = 0; c < COLS - 1; c++) {
      const a = r * COLS + c;
      const b = a + COLS;
      // counter-clockwise seen from above (rows advance along the flow, columns left → right)
      idx[o++] = a;
      idx[o++] = a + 1;
      idx[o++] = b;
      idx[o++] = a + 1;
      idx[o++] = b + 1;
      idx[o++] = b;
    }
  }
  sharedIndex = idx;
  return sharedIndex;
}

class RibbonChunk {
  constructor(material, start) {
    this.start = start; // global row index of local row 0
    this.rows = 0;
    const n = CH * COLS;
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.nrm = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.flow = new THREE.BufferAttribute(new Float32Array(n * 4), 4);
    this.misc = new THREE.BufferAttribute(new Float32Array(n * 4), 4);
    this.attrs = [this.pos, this.nrm, this.flow, this.misc];
    for (const a of this.attrs) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos);
    geo.setAttribute('normal', this.nrm);
    geo.setAttribute('aFlow', this.flow);
    geo.setAttribute('aMisc', this.misc);
    // own BufferAttribute per chunk (shared typed array): disposing one chunk must not free
    // the GPU index buffer other ribbons still use
    geo.setIndex(new THREE.BufferAttribute(getSharedIndex(), 1));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere();
    this.box = new THREE.Box3();
    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.renderOrder = 1;
    this.dirtyLo = Infinity;
    this.dirtyHi = -1;
    this.pos.onUpload(() => {
      this.dirtyLo = Infinity;
      this.dirtyHi = -1;
    });
  }

  markDirty(local) {
    if (local < this.dirtyLo) this.dirtyLo = local;
    if (local > this.dirtyHi) this.dirtyHi = local;
  }

  flush() {
    if (this.dirtyHi < 0) return;
    const lo = this.dirtyLo * COLS;
    const cnt = (this.dirtyHi - this.dirtyLo + 1) * COLS;
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(lo * a.itemSize, cnt * a.itemSize);
      a.needsUpdate = true;
    }
    this.geo.setDrawRange(0, Math.max(0, this.rows - 1) * (COLS - 1) * 6);
    this.box.getBoundingSphere(this.geo.boundingSphere);
    this.geo.boundingSphere.radius += 4;
  }

  dispose() {
    this.geo.dispose();
  }
}

/** Everything drawn for one stream. */
class StreamView {
  constructor(r, stream) {
    this.r = r;
    this.stream = stream;
    this.id = stream.id;
    this.pal = streamPalette(stream);
    this.group = new THREE.Group();
    r.group.add(this.group);
    this.chunks = [];
    this.rows = 0; // rows built
    this.sArr = new Float32Array(1024); // distance along trail per row
    this.phiArr = new Float32Array(1024); // flow phase per row
    this.cut = new Float32Array(1024); // cut mask per row
    this.steepArr = new Float32Array(1024);
    this.deadAt = -1;
    this.landT = -1;
    this.landPos = new THREE.Vector3();
    this.prevPhase = stream.phase;
    this.acc = new Float32Array(8);
    this.lastPulse = -1;
    this.waterfallCooldown = 0;
    this.headDir = new THREE.Vector2(stream.heading.x, stream.heading.y);
    this.visible = true;

    const pal = this.pal;
    const common = {
      uWTime: waterTime,
      uDeep: { value: pal.deep },
      uShallow: { value: pal.shallow },
      uFoam: { value: pal.foam },
      uGlow: { value: pal.glow },
      uTint: { value: pal.tint },
      uRival: { value: pal.isRival ? 1 : 0 },
    };
    const atm = r.ctx.atmosphere.uniforms;
    const tu = r.terrainU;
    this.ribbonMat = new THREE.ShaderMaterial({
      uniforms: {
        ...atm,
        ...tu,
        ...envUniforms(),
        ...common,
        uFlowSpeed: { value: 12 },
        uHeadS: { value: 0 },
        uDeadT: { value: -1 },
        uSurge: { value: 0 },
      },
      defines: { SKIN_FX: pal.fx },
      vertexShader: RIVER_VERT,
      fragmentShader: RIVER_FRAG,
      transparent: true,
      depthWrite: true,
    });
    this.headMat = new THREE.ShaderMaterial({
      uniforms: {
        ...atm,
        ...tu,
        ...envUniforms(),
        ...common,
        uFlowSpeed: this.ribbonMat.uniforms.uFlowSpeed,
        uHeadS: this.ribbonMat.uniforms.uHeadS,
        uDeadT: { value: -1 },
        uSurge: this.ribbonMat.uniforms.uSurge,
        uHeadPos: { value: new THREE.Vector3() },
        uHeadDir: { value: new THREE.Vector2(0, 1) },
        uHeadR: { value: 5 },
        uHeadPhi: { value: 0 },
        uSpeedF: { value: 1 },
        uCrest: { value: 0.42 },
        uSteepHead: { value: 0 },
      },
      defines: { SKIN_FX: pal.fx, HEAD: '' },
      vertexShader: RIVER_VERT,
      fragmentShader: RIVER_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.head = new THREE.Mesh(r.headGeo, this.headMat);
    this.head.frustumCulled = false;
    this.head.renderOrder = 2;
    this.group.add(this.head);

    this.blobMat = new THREE.ShaderMaterial({
      uniforms: {
        ...atm,
        ...envUniforms(),
        ...common,
        uCenter: { value: new THREE.Vector3() },
        uR: { value: 10 },
        uVelDir: { value: new THREE.Vector3(0, -1, 0) },
        uStretch: { value: 0.15 },
        uSquash: { value: 0 },
        uAlpha: { value: 1 },
        uSeed: { value: stream.id * 3.17 },
      },
      defines: { SKIN_FX: pal.fx },
      vertexShader: BLOB_VERT,
      fragmentShader: BLOB_FRAG,
      transparent: true,
      depthWrite: true,
    });
    this.blob = new THREE.Mesh(r.blobGeo, this.blobMat);
    this.blob.frustumCulled = false;
    this.blob.renderOrder = 3;
    this.group.add(this.blob);
    this.mats = [this.ribbonMat, this.headMat, this.blobMat];
  }

  ensureCapacity(n) {
    if (n <= this.sArr.length) return;
    let cap = this.sArr.length;
    while (cap < n) cap *= 2;
    for (const k of ['sArr', 'phiArr', 'cut', 'steepArr']) {
      const a = new Float32Array(cap);
      a.set(this[k]);
      this[k] = a;
    }
  }

  chunkFor(g, create) {
    const c = g === 0 ? 0 : Math.floor((g - 1) / (CH - 1));
    while (create && this.chunks.length <= c) {
      const ch = new RibbonChunk(this.ribbonMat, this.chunks.length * (CH - 1));
      this.chunks.push(ch);
      this.group.add(ch.mesh);
    }
    return this.chunks[c];
  }

  clearRibbon() {
    for (const ch of this.chunks) {
      this.group.remove(ch.mesh);
      ch.dispose();
    }
    this.chunks = [];
    this.rows = 0;
    this.cut.fill(0);
  }

  dispose() {
    this.clearRibbon();
    this.r.group.remove(this.group);
    for (const m of this.mats) m.dispose();
  }
}

export class StreamRenderer {
  constructor(ctx) {
    this.ctx = ctx;
    this.views = new Map();
    this.group = new THREE.Group();
    ctx.scene.add(this.group);
    this.rowPos = new Float32Array(COLS * 3);
    this.prevRow = new Float32Array(COLS * 3);
    this.nextRow = new Float32Array(COLS * 3);
    this.time = 0;
  }

  init() {
    const { ctx } = this;
    this.terrainU = terrainUniforms(ctx.terrain);
    this.fx = new WaterFX(ctx);

    // head wave grid: (a along: -1 back → +1 nose, b across)
    const NA = 40;
    const NB = 20;
    const pos = [];
    const idx = [];
    for (let i = 0; i <= NA; i++) {
      const u = i / NA;
      const a = u < 0.55 ? -1 + (u / 0.55) * 1.0 : ((u - 0.55) / 0.45) ** 0.8;
      for (let j = 0; j <= NB; j++) pos.push(a, -1 + (2 * j) / NB, 0);
    }
    for (let i = 0; i < NA; i++) {
      for (let j = 0; j < NB; j++) {
        const a = i * (NB + 1) + j;
        const b = a + NB + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    this.headGeo = new THREE.BufferGeometry();
    this.headGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.headGeo.setIndex(idx);
    this.blobGeo = new THREE.IcosahedronGeometry(1, 24);

    const bus = ctx.bus;
    bus.on('splash', (e) => this.onSplash(e));
    bus.on('absorb', (e) => this.onAbsorb(e));
    bus.on('cut', (e) => this.onCut(e));
    bus.on('eliminated', (e) => this.onEliminated(e));
    bus.on('finished', (e) => this.onFinished(e));
  }

  reset() {
    for (const v of this.views.values()) v.dispose();
    this.views.clear();
    this.fx?.reset();
  }

  // ------------------------------------------------------------------ ribbon building

  /** Compute one cross-section row of positions into `out` for trail point i. */
  computeRow(stream, i, out) {
    const { terrain } = this.ctx;
    const d = stream.trail.data;
    const n = stream.trail.count;
    const a = Math.max(i - 1, 0);
    const b = Math.min(i + 1, n - 1);
    let tx = d[b * 4] - d[a * 4];
    let tz = d[b * 4 + 2] - d[a * 4 + 2];
    let len = Math.hypot(tx, tz);
    if (len < 1e-4) {
      tx = stream.heading.x;
      tz = stream.heading.y;
      len = Math.hypot(tx, tz) || 1;
    }
    tx /= len;
    tz /= len;
    const px = -tz;
    const pz = tx;
    const x = d[i * 4];
    const z = d[i * 4 + 2];
    // the visible river swells faster than its collision width: growing has to be felt
    const w = d[i * 4 + 3] * (this._widthMul ?? 1);
    const sea = terrain.seaLevel + SEA_BIAS;
    const hc = Math.max(d[i * 4 + 1], sea);
    const depth = Math.min(Math.max(0.2 * w, 0.6), 3.5);
    for (let j = 0; j < COLS; j++) {
      const t = (-1 + (2 * j) / (COLS - 1)) * EXT;
      const ox = x + px * t * w;
      const oz = z + pz * t * w;
      const h = Math.max(terrain.heightAt(ox, oz), sea);
      const q = t / EXT;
      const prof = Math.max(1 - q * q, 0);
      const y = Math.max(h + 0.12, Math.min(hc + depth, h + depth * prof));
      out[j * 3] = ox;
      out[j * 3 + 1] = y;
      out[j * 3 + 2] = oz;
    }
    return { tx, tz, w };
  }

  writeRow(view, g) {
    const s = view.stream;
    const d = s.trail.data;
    const row = this.rowPos;
    const { tx, tz, w } = this.computeRow(s, g, row);
    // along-trail distance + flow phase (water runs faster down steep sections)
    let steep = 0;
    if (g === 0) {
      view.sArr[0] = 0;
      view.phiArr[0] = 0;
    } else {
      const dx = d[g * 4] - d[(g - 1) * 4];
      const dy = d[g * 4 + 1] - d[(g - 1) * 4 + 1];
      const dz = d[g * 4 + 2] - d[(g - 1) * 4 + 2];
      const ds = Math.hypot(dx, dz) || 0.001;
      steep = Math.min(Math.abs(dy) / ds, 2);
      const speedF = Math.min(Math.max(0.55 + steep * 2.2, 0.55), 2.6);
      view.sArr[g] = view.sArr[g - 1] + ds;
      view.phiArr[g] = view.phiArr[g - 1] + ds / speedF;
    }
    view.steepArr[g] = steep;
    // smoothed steepness so rapids foam spans a few rows
    const sm = (view.steepArr[Math.max(g - 1, 0)] + steep * 2 + view.steepArr[Math.max(g - 2, 0)]) / 4;
    // neighbours for normals: previous row (recomputed cheaply) or next
    const prev = this.prevRow;
    const hasPrev = g > 0;
    if (hasPrev) this.computeRow(s, g - 1, prev);
    else if (s.trail.count > 1) this.computeRow(s, g + 1, prev);
    const sign = hasPrev ? 1 : -1;
    const sVal = view.sArr[g];
    const phi = view.phiArr[g];
    const cutV = view.cut[g];

    const write = (ch, local) => {
      const P = ch.pos.array;
      const Nn = ch.nrm.array;
      const F = ch.flow.array;
      const M = ch.misc.array;
      for (let j = 0; j < COLS; j++) {
        const k = local * COLS + j;
        const x = row[j * 3];
        const y = row[j * 3 + 1];
        const z = row[j * 3 + 2];
        P[k * 3] = x;
        P[k * 3 + 1] = y;
        P[k * 3 + 2] = z;
        // lateral tangent
        const j0 = Math.max(j - 1, 0);
        const j1 = Math.min(j + 1, COLS - 1);
        const lx = row[j1 * 3] - row[j0 * 3];
        const ly = row[j1 * 3 + 1] - row[j0 * 3 + 1];
        const lz = row[j1 * 3 + 2] - row[j0 * 3 + 2];
        // along tangent
        const ax = (x - prev[j * 3]) * sign;
        const ay = (y - prev[j * 3 + 1]) * sign;
        const az = (z - prev[j * 3 + 2]) * sign;
        let nx = ly * az - lz * ay;
        let ny = lz * ax - lx * az;
        let nz = lx * ay - ly * ax;
        if (s.trail.count < 2) {
          nx = 0;
          ny = 1;
          nz = 0;
        }
        if (ny < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        const nl = Math.hypot(nx, ny, nz) || 1;
        Nn[k * 3] = nx / nl;
        Nn[k * 3 + 1] = ny / nl;
        Nn[k * 3 + 2] = nz / nl;
        F[k * 4] = sVal;
        F[k * 4 + 1] = (-1 + (2 * j) / (COLS - 1)) * EXT;
        F[k * 4 + 2] = phi;
        F[k * 4 + 3] = sm;
        M[k * 4] = w;
        M[k * 4 + 1] = cutV;
        M[k * 4 + 2] = tx;
        M[k * 4 + 3] = tz;
        _v.set(x, y, z);
        ch.box.expandByPoint(_v);
      }
      ch.rows = Math.max(ch.rows, local + 1);
      ch.markDirty(local);
    };
    const ch = view.chunkFor(g, true);
    write(ch, g - ch.start);
    // a boundary row (last of its chunk) is also local row 0 of the next chunk
    if (g > 0 && g % (CH - 1) === 0) {
      const next = view.chunkFor(g + 1, true);
      if (next !== ch) write(next, 0);
    }
    return steep;
  }

  syncRibbon(view, time) {
    this._widthMul = view.widthMul ?? 1;
    const s = view.stream;
    const n = s.trail.count;
    if (n < view.rows) view.clearRibbon();
    if (n === 0) return;
    view.ensureCapacity(n + 2);
    const from = Math.max(0, Math.min(view.rows, n) - UPDATE_TAIL);
    for (let g = from; g < n; g++) {
      const steep = this.writeRow(view, g);
      // new steep sections spawn waterfall mist/spray (near the camera only)
      if (g >= view.rows && steep > 0.75 && time > view.waterfallCooldown && this.nearCamera(s.pos, 900)) {
        view.waterfallCooldown = time + 0.25;
        this.waterfallBurst(view, g);
      }
    }
    view.rows = n;
    for (const ch of view.chunks) ch.flush();
  }

  // ------------------------------------------------------------------ per frame

  nearCamera(p, dist) {
    return this.ctx.camera.position.distanceToSquared(p) < dist * dist;
  }

  update(dt, time) {
    waterTime.value = time;
    this.time = time;
    const streams = this.ctx.game?.streams ?? [];
    const env = this.ctx.atmosphere.envMap;
    const seen = new Set();
    for (const s of streams) {
      let view = this.views.get(s.id);
      if (view && view.stream !== s) {
        view.dispose();
        this.views.delete(s.id);
        view = null;
      }
      if (!view) {
        view = new StreamView(this, s);
        this.views.set(s.id, view);
      }
      seen.add(s.id);
      for (const m of view.mats) syncEnv(m, env);
      this.updateView(view, dt, time);
    }
    for (const [id, v] of this.views) {
      if (!seen.has(id)) {
        v.dispose();
        this.views.delete(id);
      }
    }
    this.fx.update(dt, time);
  }

  updateView(view, dt, time) {
    const s = view.stream;
    // half-width multiplier from volume: ×1 at the start, ×2.2 once you are a giant
    view.widthMul = 1 + 1.2 * Math.min(1, Math.log10(Math.max(s.volume, 1e5) / 1e5) / 1.7);
    if (view.trailVersion !== s.trail.version) {
      this.syncRibbon(view, time);
      view.trailVersion = s.trail.version;
    }
    const n = s.trail.count;
    const ru = view.ribbonMat.uniforms;
    const hu = view.headMat.uniforms;
    const bu = view.blobMat.uniforms;

    // landing transition: the blob squashes into the ground for a moment
    if ((view.prevPhase === 'drop' && s.phase !== 'drop') || (view.prevLeap && !s.leaping)) {
      view.landT = time;
      view.landPos.copy(s.pos);
    }
    view.prevPhase = s.phase;
    view.prevLeap = !!s.leaping;

    // ---- drop blob
    const blobR = s.radius * (s.leaping ? 1.25 : 1.7);
    const landAge = view.landT >= 0 ? time - view.landT : 1e9;
    if (s.phase === 'drop' || s.leaping) {
      view.blob.visible = true;
      bu.uCenter.value.copy(s.pos);
      bu.uR.value = blobR;
      const sp = s.vel.length();
      if (sp > 1) bu.uVelDir.value.copy(s.vel).divideScalar(sp);
      bu.uStretch.value = Math.min(sp / 90, 1) * 0.28;
      bu.uSquash.value = 0;
      bu.uAlpha.value = 1;
      if (!s.leaping) this.emitDrop(view, dt); // the drop trail mist would fog the chase cam
    } else if (landAge < 0.3) {
      view.blob.visible = true;
      const k = landAge / 0.3;
      bu.uCenter.value.set(view.landPos.x, view.landPos.y + blobR * 0.35 * (1 - k), view.landPos.z);
      bu.uSquash.value = Math.min(1, landAge / 0.22);
      bu.uStretch.value *= 0.8;
      bu.uAlpha.value = 1 - THREE.MathUtils.smoothstep(k, 0.15, 0.8);
    } else {
      view.blob.visible = false;
    }

    // ---- head wave
    const flowing = s.phase === 'flow';
    view.head.visible = flowing && n > 0 && !s.leaping;
    if (flowing && n > 0) {
      const d = s.trail.data;
      const li = (n - 1) * 4;
      const sp = Math.hypot(s.vel.x, s.vel.z);
      if (sp > 0.5) {
        const k = 1 - Math.exp(-dt * 8);
        view.headDir.x += (s.vel.x / sp - view.headDir.x) * k;
        view.headDir.y += (s.vel.z / sp - view.headDir.y) * k;
        view.headDir.normalize();
      }
      const dLast = Math.hypot(s.pos.x - d[li], s.pos.z - d[li + 2]);
      const sHead = view.sArr[n - 1] + dLast;
      const steep = view.steepArr[n - 1] ?? 0;
      hu.uHeadPos.value.copy(s.pos);
      hu.uHeadDir.value.copy(view.headDir);
      hu.uHeadR.value = s.radius;
      hu.uHeadS.value = sHead;
      const speedF = Math.min(Math.max(0.55 + steep * 2.2, 0.55), 2.6);
      hu.uSpeedF.value = speedF;
      hu.uHeadPhi.value = view.phiArr[n - 1] + dLast / speedF;
      hu.uSteepHead.value = steep;
      hu.uCrest.value = 0.38 + Math.min(sp / 40, 1) * 0.12 + (s.surging ? 0.1 : 0) + Math.min(s.absorbing / 4e5, 0.15);
      ru.uHeadS.value = sHead;
      ru.uFlowSpeed.value = 7 + Math.min(sp, 45) * 0.35;
      ru.uSurge.value += ((s.surging ? 1 : 0) - ru.uSurge.value) * (1 - Math.exp(-dt * 4));
      this.emitHead(view, dt, sp, steep);
    }

    // eliminated: ribbon drains back from the head
    if (view.deadAt >= 0) {
      const dt2 = time - view.deadAt;
      ru.uDeadT.value = dt2;
      // fully dried long ago: stop drawing it
      const total = (view.sArr[Math.max(n - 1, 0)] ?? 0) / 140 + 8;
      view.group.visible = dt2 < total;
    } else {
      ru.uDeadT.value = -1;
      view.group.visible = true;
    }
  }

  // ------------------------------------------------------------------ emitters

  emitDrop(view, dt) {
    const s = view.stream;
    if (!s.isPlayer && !this.nearCamera(s.pos, 1500)) return;
    const fx = this.fx;
    const rand = fx.rand;
    const R = s.radius * 1.7;
    const vel = s.vel;
    const sp = vel.length() || 1;
    const vd = _v.copy(vel).divideScalar(sp);
    const pal = view.pal;
    const acc = view.acc;
    // trailing droplets peeling off the back
    acc[0] += dt * 70;
    for (let i = 0, n = fx.count(Math.floor(acc[0])); i < n; i++) {
      const dx = rand() * 2 - 1;
      const dy = rand() * 2 - 1;
      const dz = rand() * 2 - 1;
      const l = Math.hypot(dx, dy, dz) || 1;
      let ox = dx / l - vd.x * 0.9;
      let oy = dy / l - vd.y * 0.9;
      let oz = dz / l - vd.z * 0.9;
      const ol = Math.hypot(ox, oy, oz) || 1;
      ox /= ol;
      oy /= ol;
      oz /= ol;
      const sz = 0.25 + rand() * 0.7;
      fx.emit(P.DROP, s.pos.x + ox * R * 0.95, s.pos.y + oy * R * 0.95, s.pos.z + oz * R * 0.95, vel.x * 0.8 + ox * 5, vel.y * 0.8 + oy * 5, vel.z * 0.8 + oz * 5, 0.9 + rand() * 0.6, sz, sz * 0.5, 0, 1.2, 0.03, _c.copy(pal.shallow).lerp(WHITE, 0.5), 0.95);
    }
    acc[0] -= Math.floor(acc[0]);
    // mist wake
    acc[1] += dt * 14;
    for (let i = 0, n = fx.count(Math.floor(acc[1])); i < n; i++) {
      const sz = R * (0.5 + rand() * 0.4);
      fx.emit(P.MIST, s.pos.x - vd.x * R * 0.8 + (rand() - 0.5) * R, s.pos.y - vd.y * R * 0.8 + (rand() - 0.5) * R, s.pos.z - vd.z * R * 0.8 + (rand() - 0.5) * R, vel.x * 0.75, vel.y * 0.75, vel.z * 0.75, 1.6, sz, sz * 2.4, 0, 1.6, 0, WHITE, 0.32);
    }
    acc[1] -= Math.floor(acc[1]);
    // air speed streaks rushing past
    acc[2] += dt * 45;
    const ex = _e1.set(Math.abs(vd.y) < 0.9 ? 0 : 1, Math.abs(vd.y) < 0.9 ? 1 : 0, 0).cross(vd).normalize();
    const ey = _e2.crossVectors(vd, ex);
    for (let i = 0, n = fx.count(Math.floor(acc[2])); i < n; i++) {
      const a = rand() * Math.PI * 2;
      const rr = R * (1.3 + rand() * 2.2);
      const ox = (ex.x * Math.cos(a) + ey.x * Math.sin(a)) * rr + vd.x * R * (1 + rand() * 3);
      const oy = (ex.y * Math.cos(a) + ey.y * Math.sin(a)) * rr + vd.y * R * (1 + rand() * 3);
      const oz = (ex.z * Math.cos(a) + ey.z * Math.sin(a)) * rr + vd.z * R * (1 + rand() * 3);
      fx.emit(P.STREAK, s.pos.x + ox, s.pos.y + oy, s.pos.z + oz, vel.x * 0.3, vel.y * 0.3, vel.z * 0.3, 0.35, 0.18, 0.12, 0, 0, 0.35, WHITE, 0.45);
    }
    acc[2] -= Math.floor(acc[2]);
    this.emitSkinSparkles(view, dt, s.pos, R, vel);
  }

  emitHead(view, dt, sp, steep) {
    const s = view.stream;
    if (!s.isPlayer && !this.nearCamera(s.pos, 900)) return;
    const fx = this.fx;
    const rand = fx.rand;
    const r = s.radius;
    const dir = view.headDir;
    const px = -dir.y;
    const pz = dir.x;
    const acc = view.acc;
    const pal = view.pal;
    const crest = view.headMat.uniforms.uCrest.value * r;
    const base = s.pos.y + Math.min(Math.max(0.2 * r, 0.6), 3.5);
    const vx = s.vel.x;
    const vz = s.vel.z;
    const agit = 1 + steep * 2 + (s.surging ? 1 : 0);
    // spray off the wave front
    acc[0] += dt * (30 + sp * 2.2) * agit;
    for (let i = 0, n = fx.count(Math.floor(acc[0])); i < n; i++) {
      const b = rand() * 2 - 1;
      const f = 0.2 + rand() * 0.9;
      const x = s.pos.x + dir.x * r * f + px * b * r * 0.95;
      const z = s.pos.z + dir.y * r * f + pz * b * r * 0.95;
      const up = 3 + rand() * 7 + steep * 6;
      const side = b * (2 + rand() * 4);
      const sz = 0.12 + rand() * 0.35;
      fx.emit(P.DROP, x, base + crest * (0.6 + rand() * 0.5), z, vx * 0.9 + px * side + dir.x * rand() * 3, up, vz * 0.9 + pz * side + dir.y * rand() * 3, 0.7 + rand() * 0.5, sz, sz * 0.6, 1, 0.5, 0.045, _c.copy(pal.foam).lerp(pal.shallow, 0.25), 0.95);
    }
    acc[0] -= Math.floor(acc[0]);
    // foam puffs churning on the crest
    acc[1] += dt * (10 + sp * 0.5) * agit;
    for (let i = 0, n = fx.count(Math.floor(acc[1])); i < n; i++) {
      const b = rand() * 2 - 1;
      const f = -0.3 + rand() * 1.2;
      const sz = r * (0.18 + rand() * 0.22);
      fx.emit(P.FOAM, s.pos.x + dir.x * r * f + px * b * r * 0.8, base + crest * 0.8, s.pos.z + dir.y * r * f + pz * b * r * 0.8, vx * 0.7 + px * b * 2, 1.5 + rand() * 3, vz * 0.7 + pz * b * 2, 0.55 + rand() * 0.4, sz, sz * 1.6, 0.6, 1.5, 0, pal.foam, 0.95);
    }
    acc[1] -= Math.floor(acc[1]);
    // mist rolling off the front
    acc[2] += dt * (3 + steep * 10);
    for (let i = 0, n = fx.count(Math.floor(acc[2])); i < n; i++) {
      const sz = r * (0.8 + rand() * 0.6);
      fx.emit(P.MIST, s.pos.x + dir.x * r + (rand() - 0.5) * r, base + crest, s.pos.z + dir.y * r + (rand() - 0.5) * r, vx * 0.5, 1 + rand() * 2, vz * 0.5, 1.8, sz, sz * 2.5, 0, 1.2, 0, WHITE, 0.22);
    }
    acc[2] -= Math.floor(acc[2]);
    // swallowing: inward ring pulses around the head
    if (s.absorbing > 0 && time() - view.lastPulse > 0.45) {
      view.lastPulse = time();
      fx.decal(D.PULSE, s.pos.x, s.pos.z, r * 3.2, 0.9, pal.shallow, 1);
    }
    this.emitSkinSparkles(view, dt, _v.set(s.pos.x, base + crest * 0.5, s.pos.z), r, s.vel);
  }

  emitSkinSparkles(view, dt, pos, R, vel) {
    const fx = this.fx;
    const rand = fx.rand;
    const pal = view.pal;
    const kind = pal.id;
    if (!['magma', 'galaxy', 'gold', 'toxic', 'glacier'].includes(kind)) return;
    const rate = kind === 'magma' || kind === 'galaxy' ? 28 : 12;
    view.acc[5] += dt * rate;
    for (let i = 0, n = fx.count(Math.floor(view.acc[5])); i < n; i++) {
      const ox = (rand() - 0.5) * R * 2;
      const oy = (rand() - 0.2) * R;
      const oz = (rand() - 0.5) * R * 2;
      if (kind === 'magma') {
        _c.setRGB(1.0, 0.45 + rand() * 0.3, 0.1);
        fx.emit(P.EMBER, pos.x + ox, pos.y + oy, pos.z + oz, vel.x * 0.6 + (rand() - 0.5) * 3, 3 + rand() * 6, vel.z * 0.6 + (rand() - 0.5) * 3, 1.0 + rand() * 0.8, 0.5 + rand() * 0.5, 0.1, -0.15, 1.0, 0.02, _c, 1, 1);
      } else if (kind === 'galaxy') {
        _c.setHSL(0.72 + rand() * 0.2, 0.8, 0.75);
        fx.emit(P.STAR, pos.x + ox, pos.y + oy, pos.z + oz, vel.x * 0.5, 1 + rand() * 2, vel.z * 0.5, 0.9 + rand() * 0.7, 0.9 + rand() * 0.9, 0.2, 0, 1.5, 0, _c, 1, 1);
      } else if (kind === 'gold') {
        _c.setRGB(1.0, 0.85, 0.4);
        fx.emit(P.STAR, pos.x + ox, pos.y + oy, pos.z + oz, vel.x * 0.6, 1 + rand() * 2, vel.z * 0.6, 0.7, 0.7, 0.15, 0, 1.5, 0, _c, 1, 1);
      } else if (kind === 'toxic') {
        _c.setRGB(0.5, 1.0, 0.25);
        fx.emit(P.EMBER, pos.x + ox, pos.y + oy, pos.z + oz, vel.x * 0.6, 1 + rand() * 2, vel.z * 0.6, 0.8, 0.5, 0.2, -0.05, 1.5, 0, _c, 0.8, 1);
      } else {
        _c.setRGB(0.85, 0.95, 1.0);
        fx.emit(P.STAR, pos.x + ox, pos.y + oy, pos.z + oz, vel.x * 0.6, 0.5, vel.z * 0.6, 0.6, 0.5, 0.1, 0, 1.5, 0, _c, 1, 1);
      }
    }
    view.acc[5] -= Math.floor(view.acc[5]);
  }

  waterfallBurst(view, g) {
    const s = view.stream;
    const d = s.trail.data;
    const fx = this.fx;
    const rand = fx.rand;
    const x = d[g * 4];
    const y = d[g * 4 + 1];
    const z = d[g * 4 + 2];
    const w = d[g * 4 + 3];
    for (let i = 0, n = fx.count(6); i < n; i++) {
      const sz = w * (0.9 + rand() * 0.8);
      fx.emit(P.MIST, x + (rand() - 0.5) * w * 2, y + 1 + rand() * 2, z + (rand() - 0.5) * w * 2, (rand() - 0.5) * 3, 1.5 + rand() * 2, (rand() - 0.5) * 3, 3 + rand() * 2, sz, sz * 2.6, 0, 0.8, 0, WHITE, 0.25);
    }
    for (let i = 0, n = fx.count(14); i < n; i++) {
      const sz = 0.2 + rand() * 0.4;
      fx.emit(P.DROP, x + (rand() - 0.5) * w * 2, y + 0.5, z + (rand() - 0.5) * w * 2, (rand() - 0.5) * 6, 4 + rand() * 6, (rand() - 0.5) * 6, 0.9, sz, sz * 0.5, 1, 0.4, 0.04, view.pal.foam, 0.9);
    }
  }

  // ------------------------------------------------------------------ events

  burst(x, y, z, size, pal, { drops = 120, foam = 36, mist = 14, crown = 40, up = 1 } = {}) {
    const fx = this.fx;
    const rand = fx.rand;
    for (let i = 0, n = fx.count(drops); i < n; i++) {
      const a = rand() * Math.PI * 2;
      const hs = (0.35 + rand() * 0.9) * size * 0.9;
      const vs = (0.5 + rand() * 1.0) * size * 0.8 * up;
      const sz = 0.3 + rand() * 0.9 * Math.min(size / 20, 1.6);
      fx.emit(P.DROP, x + Math.cos(a) * size * 0.15, y + 0.5, z + Math.sin(a) * size * 0.15, Math.cos(a) * hs, vs, Math.sin(a) * hs, 1.3 + rand() * 0.9, sz, sz * 0.5, 1, 0.25, 0.05, _c.copy(pal.foam).lerp(pal.shallow, rand() * 0.5), 1);
    }
    for (let i = 0, n = fx.count(foam); i < n; i++) {
      const a = rand() * Math.PI * 2;
      const hs = (0.2 + rand() * 0.6) * size * 0.6;
      const vs = (0.2 + rand() * 0.8) * size * 0.5 * up;
      const sz = size * (0.08 + rand() * 0.1);
      fx.emit(P.FOAM, x, y + 1, z, Math.cos(a) * hs, vs, Math.sin(a) * hs, 1.0 + rand() * 0.6, sz, sz * 2, 0.7, 1.2, 0, pal.foam, 1);
    }
    for (let i = 0, n = fx.count(crown); i < n; i++) {
      const a = (i / crown) * Math.PI * 2 + rand() * 0.2;
      const sz = size * (0.06 + rand() * 0.06);
      fx.emit(P.FOAM, x + Math.cos(a) * size * 0.3, y + 0.8, z + Math.sin(a) * size * 0.3, Math.cos(a) * size * 0.9, size * (0.25 + rand() * 0.25) * up, Math.sin(a) * size * 0.9, 1.1, sz, sz * 1.8, 1, 1.4, 0, pal.foam, 1);
    }
    for (let i = 0, n = fx.count(mist); i < n; i++) {
      const a = rand() * Math.PI * 2;
      const sz = size * (0.3 + rand() * 0.3);
      fx.emit(P.MIST, x + Math.cos(a) * size * 0.3, y + 2, z + Math.sin(a) * size * 0.3, Math.cos(a) * size * 0.3, 2 + rand() * 4, Math.sin(a) * size * 0.3, 2.5 + rand(), sz, sz * 2.2, 0, 1, 0, WHITE, 0.35);
    }
  }

  onSplash({ x, y, z, size, stream }) {
    const view = stream ? this.views.get(stream.id) : null;
    const pal = view?.pal ?? { foam: WHITE, shallow: LAKE_COL };
    this.burst(x, y, z, size, pal, { drops: 170, foam: 46, mist: 18, crown: 56 });
    this.fx.decal(D.SPLASH, x, z, size * 1.5, 4.5, null, 1);
    this.ctx.postfx?.flash?.(0.2);
  }

  onAbsorb({ stream, body, amount }) {
    const view = this.views.get(stream.id);
    if (!view || !(amount > 0)) return;
    const fx = this.fx;
    const rand = fx.rand;
    const s = stream;
    const near = s.isPlayer || this.nearCamera(s.pos, 900);
    if (!near) return;
    const cloud = body.kind === 'cloud';
    const n = fx.count(cloud ? 3 : body.kind === 'lake' ? 5 : 3);
    const tx = s.pos.x;
    const ty = s.pos.y + (cloud ? 0 : Math.max(s.radius * 0.6, 2));
    const tz = s.pos.z;
    const vort = body.vortex;
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const rr = Math.sqrt(rand()) * body.radius * (cloud ? 0.9 : 0.55);
      const x = body.x + (vort?.x ?? 0) + Math.cos(a) * rr;
      const z = body.z + (vort?.y ?? 0) + Math.sin(a) * rr;
      const y = cloud ? body.y + (rand() - 0.5) * body.radius * 0.5 : body.y + 0.3;
      const T = cloud ? 0.5 + rand() * 0.3 : 0.55 + rand() * 0.45;
      const g = cloud ? 0 : 9.81;
      // ballistic arc that lands on the moving head
      const lead = T * 0.85;
      const vx = (tx + s.vel.x * lead - x) / T;
      const vz = (tz + s.vel.z * lead - z) / T;
      const vy = (ty + s.vel.y * lead - y) / T + 0.5 * g * T;
      if (cloud) {
        const sz = 2 + rand() * 3;
        fx.emit(P.MIST, x, y, z, vx, vy, vz, T, sz, sz * 0.4, 0, 0, 0, WHITE, 0.55);
      } else {
        const sz = 0.4 + rand() * 0.9;
        fx.emit(P.DROP, x, y, z, vx, vy, vz, T, sz, sz * 0.8, 1, 0, 0.06, _c.copy(LAKE_COL).lerp(WHITE, rand() * 0.6), 1);
        if (rand() < 0.35) {
          const fs = 1 + rand() * 1.5;
          fx.emit(P.FOAM, x, y, z, vx * 0.5, 3 + rand() * 3, vz * 0.5, 0.8, fs, fs * 1.8, 0.8, 1.5, 0, WHITE, 0.95);
        }
      }
    }
  }

  onCut({ attacker, victim }) {
    const fx = this.fx;
    const av = this.views.get(attacker.id);
    const vv = this.views.get(victim.id);
    const x = attacker.pos.x;
    const z = attacker.pos.z;
    const y = attacker.pos.y;
    const vpal = vv?.pal ?? { foam: WHITE, shallow: LAKE_COL, tint: WHITE };
    this.burst(x, y, z, attacker.radius * 3, { foam: WHITE, shallow: vpal.shallow }, { drops: 90, foam: 24, mist: 6, crown: 24 });
    const tint = vv?.pal.isRival ? vv.pal.tint : vpal.shallow;
    fx.decal(D.CUT, x, z, attacker.radius * 4.5, 1.8, tint, 1);
    // carve a visible gap into the victim's river where it was crossed
    if (vv) {
      const d = victim.trail.data;
      const n = victim.trail.count;
      const reach = attacker.radius * 1.3 + 2;
      let changed = false;
      for (let i = 0; i < n; i++) {
        const dx = d[i * 4] - x;
        const dz = d[i * 4 + 2] - z;
        const dd = Math.hypot(dx, dz);
        if (dd > reach * 1.6) continue;
        const k = 1 - THREE.MathUtils.smoothstep(dd, reach * 0.6, reach * 1.6);
        if (k > vv.cut[i]) {
          vv.cut[i] = k;
          changed = true;
        }
      }
      if (changed) {
        // rewrite the affected rows (cheap: only rows near the cut)
        for (let i = 0; i < Math.min(n, vv.rows); i++) if (vv.cut[i] > 0) this.writeRow(vv, i);
        for (const ch of vv.chunks) ch.flush();
      }
    }
    void av;
  }

  onEliminated({ victim, by, reason }) {
    const v = this.views.get(victim.id);
    if (!v) return;
    v.deadAt = this.time;
    const fx = this.fx;
    const rand = fx.rand;
    const p = victim.pos;
    const r = victim.radius;
    this.burst(p.x, p.y, p.z, r * 2.5, v.pal, { drops: 70, foam: 18, mist: reason === 'dried' ? 20 : 8, crown: 20, up: 0.7 });
    fx.decal(D.COLLAPSE, p.x, p.z, r * 3, 5, v.pal.shallow, 1);
    if (by && (reason === 'swallowed' || reason === 'blocked')) {
      // the winner slurps the loser's water
      for (let i = 0, n = fx.count(50); i < n; i++) {
        const T = 0.5 + rand() * 0.5;
        const x = p.x + (rand() - 0.5) * r * 2;
        const z = p.z + (rand() - 0.5) * r * 2;
        const vx = (by.pos.x + by.vel.x * T - x) / T;
        const vz = (by.pos.z + by.vel.z * T - z) / T;
        const vy = (by.pos.y + 2 - p.y) / T + 0.5 * 9.81 * T;
        const sz = 0.4 + rand() * 0.8;
        fx.emit(P.DROP, x, p.y + 0.5, z, vx, vy, vz, T, sz, sz * 0.7, 1, 0, 0.06, _c.copy(v.pal.shallow).lerp(WHITE, 0.4), 1);
      }
    }
  }

  onFinished({ stream }) {
    const v = this.views.get(stream.id);
    const pal = v?.pal ?? { foam: WHITE, shallow: LAKE_COL };
    const p = stream.pos;
    this.burst(p.x, this.ctx.terrain.seaLevel, p.z, stream.radius * 4, pal, { drops: 140, foam: 40, mist: 16, crown: 60, up: 1.2 });
    this.fx.decal(D.SPLASH, p.x, p.z, stream.radius * 6, 4, null, 1);
  }
}

function time() {
  return waterTime.value;
}
