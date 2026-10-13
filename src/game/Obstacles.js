import * as THREE from 'three';
import { mulberry32 } from '../core/random.js';

const _r = new THREE.Vector2();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const LOGS_PER_DAM = 11;
const DAM_HEIGHT = 7;

/**
 * Log dams across the valleys — the river's walls. Each dam has a `strength` in litres:
 * a stream at least that big smashes through (logs fly, bonus water and speed); a smaller
 * one is stopped and must steer around it or leap over it.
 *
 * Bus events: 'damBreak' { dam, stream }, 'damBlocked' { dam, stream } (throttled).
 * Stream fields written: damBlocked (seconds pressed against a dam), wantLeap (AI hint).
 */
export class Obstacles {
  constructor(game) {
    this.game = game;
    this.ctx = game.ctx;
    this.dams = [];
    this.flying = [];
  }

  build() {
    if (this.built) return;
    this.built = true;
    const { terrain } = this.ctx;
    const hydro = this.game.hydro;
    const zone = this.game.dropZone;
    const rand = mulberry32((terrain.seed ?? 7) * 131 + 17);
    const cand = [];
    const step = 110;
    const half = terrain.size * 0.48;
    let maxRoute = 1;
    for (let z = -half; z < half; z += step) {
      for (let x = -half; x < half; x += step) {
        const jx = x + (rand() - 0.5) * step * 0.6;
        const jz = z + (rand() - 0.5) * step * 0.6;
        const h = terrain.heightAt(jx, jz);
        if (h < 40 || h > 1500) continue;
        const ch = hydro.channelAt(jx, jz);
        if (ch < 0.36) continue;
        if (hydro.basinDepthAt(jx, jz) > 0.8) continue;
        if (zone && Math.hypot(jx - zone.x, jz - zone.z) < zone.radius + 500) continue;
        hydro.flowDirAt(jx, jz, _r);
        if (_r.lengthSq() < 0.5) continue;
        const rd = hydro.routeDistAt(jx, jz);
        if (rd < 350) continue;
        maxRoute = Math.max(maxRoute, rd);
        cand.push({ x: jx, z: jz, h, ch, rd, dx: _r.x, dz: _r.y, score: rand() + (ch > 0.5 ? 0.35 : 0) });
      }
    }
    // routes rivers really take: trace the drainage from all around the drop zone and put
    // dams on them at increasing distances, so every river meets a few on its way down
    if (zone) {
      const route = [];
      for (let k = 0; k < 28; k++) {
        const ang = (k / 28) * Math.PI * 2 + rand() * 0.2;
        const rr = zone.radius * (0.5 + rand() * 0.5);
        hydro.traceRoute(zone.x + Math.cos(ang) * rr, zone.z + Math.sin(ang) * rr, 7000, 40, route);
        for (const at of [900, 1900, 3000, 4200]) {
          const i = Math.round((at + (rand() - 0.5) * 500) / 40);
          if (i < 1 || i >= route.length - 1) continue;
          const p = route[i];
          const h = terrain.heightAt(p.x, p.z);
          if (h < 30 || hydro.basinDepthAt(p.x, p.z) > 0.8) continue;
          const dx = route[i + 1].x - route[i - 1].x;
          const dz = route[i + 1].z - route[i - 1].z;
          const l = Math.hypot(dx, dz) || 1;
          const rd = hydro.routeDistAt(p.x, p.z);
          maxRoute = Math.max(maxRoute, rd);
          cand.push({ x: p.x, z: p.z, h, ch: hydro.channelAt(p.x, p.z), rd, dx: dx / l, dz: dz / l, score: 2 + rand() });
        }
      }
    }
    // the short branch of every fork gets extra dams, so "CORTA · PELIGROSA" is the truth
    for (const f of this.game.forks?.list ?? []) {
      const br = f.shortBranch;
      if (!br) continue;
      const pts = br.points;
      for (const frac of [0.08, 0.2, 0.32, 0.45, 0.58, 0.72, 0.85]) {
        const i = Math.round(frac * (pts.length - 2));
        if (i < 2 || i >= pts.length - 1) continue;
        const p = pts[i];
        const h = terrain.heightAt(p.x, p.z);
        if (h < 25 || hydro.basinDepthAt(p.x, p.z) > 0.8) continue;
        const dx = pts[i + 1].x - pts[i - 1].x;
        const dz = pts[i + 1].z - pts[i - 1].z;
        const l = Math.hypot(dx, dz) || 1;
        const rd = hydro.routeDistAt(p.x, p.z);
        maxRoute = Math.max(maxRoute, rd);
        cand.push({ x: p.x, z: p.z, h, ch: hydro.channelAt(p.x, p.z), rd, dx: dx / l, dz: dz / l, score: 4 + rand(), onShort: true });
      }
    }

    const lakes = this.ctx.world?.lakes?.bodies ?? [];
    cand.sort((a, b) => b.score - a.score);
    for (const c of cand) {
      if (this.dams.length >= 64) break;
      if (this.dams.some((d) => Math.hypot(d.x - c.x, d.z - c.z) < (c.onShort ? 300 : 420))) continue;
      if (lakes.some((b) => Math.hypot(b.x - c.x, b.z - c.z) < b.radius + 90)) continue;
      const f = Math.min(1, c.rd / Math.max(maxRoute, 3000));
      // weak up high (you are small there), tough near the coast (you should be huge)
      const strength = Math.round((140000 + 1150000 * Math.pow(1 - f, 1.5)) * (0.75 + rand() * 0.5) * (c.onShort ? 1.45 : 1) / 10000) * 10000;
      const width = THREE.MathUtils.clamp(36 + c.ch * 70, 40, 105);
      this.dams.push({
        id: this.dams.length,
        x: c.x,
        z: c.z,
        y: c.h,
        dir: new THREE.Vector2(c.dx, c.dz),
        width,
        strength,
        onShort: !!c.onShort,
        broken: false,
        brokenAt: -1,
        seed: rand(),
      });
    }
    this.buildMesh(rand);
  }

  buildMesh(rand) {
    const { scene, terrain } = this.ctx;
    const logGeo = new THREE.CylinderGeometry(0.9, 1.05, 1, 9, 1);
    logGeo.rotateZ(Math.PI / 2); // along local x
    const pos = logGeo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      // bark: darker body, pale cut ends
      const end = Math.abs(pos.getX(i)) > 0.49 && Math.hypot(pos.getY(i), pos.getZ(i)) < 0.95;
      const c = end ? [0.86, 0.68, 0.45] : [0.42, 0.27, 0.16];
      col.set(c, i * 3);
    }
    logGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
    const count = this.dams.length * LOGS_PER_DAM;
    this.mesh = new THREE.InstancedMesh(logGeo, mat, Math.max(1, count));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'dams';

    const rockGeo = new THREE.IcosahedronGeometry(1, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x8e8174, roughness: 1, flatShading: true });
    this.rocks = new THREE.InstancedMesh(rockGeo, rockMat, Math.max(1, this.dams.length * 4));
    this.rocks.castShadow = true;
    this.rocks.receiveShadow = true;
    this.rocks.frustumCulled = false;

    this.logs = [];
    let ri = 0;
    for (const d of this.dams) {
      const ang = Math.atan2(d.dir.y, d.dir.x); // flow direction
      const px = -d.dir.y; // across the valley
      const pz = d.dir.x;
      const r2 = mulberry32(Math.floor(d.seed * 1e9));
      for (let i = 0; i < LOGS_PER_DAM; i++) {
        const row = i < 5 ? 0 : i < 9 ? 1 : 2;
        const inRow = row === 0 ? i : row === 1 ? i - 5 : i - 9;
        const nRow = row === 0 ? 5 : row === 1 ? 4 : 2;
        const lat = (inRow - (nRow - 1) / 2) * (d.width / nRow) * 0.55 + (r2() - 0.5) * 4;
        const x = d.x + px * lat + d.dir.x * (row - 1) * 1.2;
        const z = d.z + pz * lat + d.dir.y * (row - 1) * 1.2;
        const g = terrain.heightAt(x, z);
        const len = d.width * (0.5 + r2() * 0.35);
        const log = {
          dam: d,
          pos: new THREE.Vector3(x, g + 1 + row * 1.7, z),
          rot: new THREE.Euler((r2() - 0.5) * 0.3, -ang + Math.PI / 2 + (r2() - 0.5) * 0.35, (r2() - 0.5) * 0.12),
          scale: new THREE.Vector3(len, 1.2 + r2() * 0.5, 1.2 + r2() * 0.5),
          vel: new THREE.Vector3(),
          spin: new THREE.Vector3(),
          index: this.logs.length,
        };
        this.logs.push(log);
        this.writeLog(log);
      }
      for (let k = 0; k < 4; k++) {
        const side = k < 2 ? -1 : 1;
        const lat = side * (d.width * 0.5 + 3 + r2() * 4);
        const x = d.x + px * lat + d.dir.x * (r2() - 0.5) * 6;
        const z = d.z + pz * lat + d.dir.y * (r2() - 0.5) * 6;
        const s = 3 + r2() * 4;
        _m.compose(_p.set(x, terrain.heightAt(x, z) + s * 0.3, z), _q.setFromEuler(_e.set(r2() * 3, r2() * 3, r2() * 3)), _s.set(s, s * 0.8, s));
        this.rocks.setMatrixAt(ri++, _m);
      }
    }
    this.mesh.count = this.logs.length;
    this.rocks.count = ri;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.rocks.instanceMatrix.needsUpdate = true;
    scene.add(this.mesh, this.rocks);
  }

  writeLog(log, hidden = false) {
    _m.compose(log.pos, _q.setFromEuler(log.rot), hidden ? _s.set(0, 0, 0) : log.scale);
    this.mesh.setMatrixAt(log.index, _m);
  }

  reset() {
    if (!this.built) return;
    this.flying.length = 0;
    for (const d of this.dams) {
      d.broken = false;
      d.brokenAt = -1;
    }
    // rebuild resting positions
    const rand = mulberry32((this.ctx.terrain.seed ?? 7) * 131 + 17);
    this.ctx.scene.remove(this.mesh, this.rocks);
    this.mesh.geometry.dispose();
    this.rocks.geometry.dispose();
    this.buildMesh(rand);
  }

  /** Litres this stream needs to smash `d` (new players face weaker dams — see difficulty.js). */
  strengthFor(d, s) {
    return s?.isPlayer ? d.strength * (this.game.difficulty?.damMul ?? 1) : d.strength;
  }

  /** Called by Rules for every flowing stream. */
  check(s, dt) {
    if (s.damBlocked > 0) s.damBlocked = Math.max(0, s.damBlocked - dt * 0.5);
    const { bus } = this.ctx;
    for (const d of this.dams) {
      if (d.broken) continue;
      const rx = s.pos.x - d.x;
      const rz = s.pos.z - d.z;
      if (rx * rx + rz * rz > (d.width + 40) ** 2) continue;
      const along = rx * d.dir.x + rz * d.dir.y;
      const lat = -rx * d.dir.y + rz * d.dir.x;
      const reach = 4 + s.radius * 0.5;
      if (Math.abs(along) > reach || Math.abs(lat) > d.width * 0.5 + s.radius * 0.4) continue;
      // airborne above the logs: sail over
      if (s.leaping && s.pos.y > d.y + DAM_HEIGHT) continue;
      if (s.volume >= this.strengthFor(d, s)) {
        this.breakDam(d, s);
        continue;
      }
      // blocked: pushed back to the upstream face, current killed
      const back = -reach - along;
      if (along > -reach) {
        s.pos.x += d.dir.x * back;
        s.pos.z += d.dir.y * back;
      }
      s.flowSpeed = Math.min(s.flowSpeed, 2.5);
      s.damBlocked = (s.damBlocked || 0) + dt * 1.5;
      s.lastDam = d; // result screen: "you were N litres short"
      if (s.damBlocked > 0.6) s.wantLeap = true; // AI / autopilot hint
      const now = this.game.time;
      if (!s._damMsg || now - s._damMsg > 2.5) {
        s._damMsg = now;
        bus.emit('damBlocked', { dam: d, stream: s });
      }
    }
  }

  /** The earthquake (game/Catastrophe.js): every dam on the island gives way at once. */
  breakAll() {
    const { bus } = this.ctx;
    for (const d of this.dams) {
      if (d.broken) continue;
      d.broken = true;
      d.brokenAt = this.game.time;
      bus.emit('splash', { x: d.x, y: d.y + 2, z: d.z, size: d.width * 0.5, kind: 'clash' });
    }
    for (const log of this.logs) {
      if (!log.dam) continue;
      log.vel.set((Math.random() - 0.5) * 22, 12 + Math.random() * 18, (Math.random() - 0.5) * 22);
      log.spin.set((Math.random() - 0.5) * 5, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 5);
      log.t = 0;
      this.flying.push(log);
    }
  }

  breakDam(d, s) {
    d.broken = true;
    d.brokenAt = this.game.time;
    const bonus = Math.round(d.strength * 0.18);
    s.addVolume(bonus);
    s.flowSpeed += 12;
    const { bus } = this.ctx;
    bus.emit('damBreak', { dam: d, stream: s, bonus });
    bus.emit('splash', { x: d.x, y: d.y + 2, z: d.z, size: d.width * 0.5, stream: s, kind: 'clash' });
    for (const log of this.logs) {
      if (log.dam !== d) continue;
      log.vel.set(s.heading.x * (14 + Math.random() * 18) + (Math.random() - 0.5) * 16, 10 + Math.random() * 16, s.heading.y * (14 + Math.random() * 18) + (Math.random() - 0.5) * 16);
      log.spin.set((Math.random() - 0.5) * 5, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 5);
      log.t = 0;
      this.flying.push(log);
    }
  }

  /** Visual update (logs flying from broken dams). */
  update(dt) {
    if (!this.flying.length) return;
    const { terrain } = this.ctx;
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const log = this.flying[i];
      log.t += dt;
      log.vel.y -= 22 * dt;
      log.pos.addScaledVector(log.vel, dt);
      log.rot.x += log.spin.x * dt;
      log.rot.y += log.spin.y * dt;
      log.rot.z += log.spin.z * dt;
      const g = terrain.heightAt(log.pos.x, log.pos.z) + 0.8;
      if (log.pos.y < g) {
        log.pos.y = g;
        log.vel.multiplyScalar(0.4);
        log.vel.y = Math.abs(log.vel.y) * 0.3;
        log.spin.multiplyScalar(0.5);
      }
      const gone = log.t > 6;
      this.writeLog(log, gone);
      if (gone) this.flying.splice(i, 1);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Nearest intact dam ahead of a stream within `range` m (for HUD warnings / AI). */
  ahead(s, range = 260) {
    let best = null;
    let bd = range;
    for (const d of this.dams) {
      if (d.broken) continue;
      const dx = d.x - s.pos.x;
      const dz = d.z - s.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > bd) continue;
      if ((dx * s.heading.x + dz * s.heading.y) / (dist || 1) < 0.55) continue;
      bd = dist;
      best = d;
    }
    return best;
  }
}
