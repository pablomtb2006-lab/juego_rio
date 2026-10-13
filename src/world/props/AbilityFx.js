import * as THREE from 'three';
import { mulberry32 } from '../../core/random.js';
import { P } from '../water/WaterFX.js';

/**
 * Draws game/Abilities.js:
 *   - the ROCK WALLS: instanced hex pillars that erupt out of the ground in a ripple, hold, then
 *     sink (or collapse, if a bigger river smashes through). One draw call for every wall.
 *   - the LEECH TETHER: a camera-facing ribbon arcing from the drinker to the drunk, with
 *     droplets travelling towards the drinker and a hot red end where it is being bled.
 *   - the STEAM on a fogged river, from the shared water particle system.
 * The warning rune and the lock-on reticle are not here: they are drawn by HazardField.
 *
 * Built lazily on first update, because World is constructed before Game.
 */
const SLOTS = 12; // walls alive at once
const PILLARS = 9; // per wall
const BEAMS = 8;
const SEG = 22; // ribbon segments
const ROCKS = [new THREE.Color(0x8fb4c4), new THREE.Color(0xaebfc5), new THREE.Color(0x7d929b), new THREE.Color(0xc9d8de)];

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _t = new THREE.Vector3();
const _side = new THREE.Vector3();
const _perp = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const STEAM = new THREE.Color(0.86, 0.9, 0.94);
const PUFF = new THREE.Color(0.95, 0.97, 1.0);
const LEECH = new THREE.Color(1.3, 0.75, 1.6);
const BLEED = new THREE.Color(1.5, 0.3, 0.25);

const easeOutBack = (x) => {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const BEAM_VERT = /* glsl */ `
attribute float aU;
varying vec2 vUv;
varying float vU;
void main() {
  vUv = uv;
  vU = aU;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;
const BEAM_FRAG = /* glsl */ `
varying vec2 vUv;
varying float vU;
void main() {
  float across = abs(vUv.y * 2.0 - 1.0);
  // a violet body with a blood-red end at the victim: the complement of the turquoise water,
  // so the tether reads over the river, the sky and the pines alike
  vec3 victim = vec3(1.0, 0.16, 0.26);
  vec3 body = vec3(0.62, 0.16, 0.95);
  vec3 col = mix(victim, body, smoothstep(0.0, 0.45, vU));
  // droplets run towards the drinker (u grows towards it, the pattern scrolls with it)
  float drops = pow(0.5 + 0.5 * sin(vUv.x * 2.4), 6.0);
  float core = 1.0 - smoothstep(0.0, 0.45, across);
  col = mix(col * 0.55, col * 1.5, core);
  col = mix(col, vec3(1.0, 0.92, 1.0), drops * core * 0.85);
  float a = (0.62 + 0.38 * drops) * (1.0 - smoothstep(0.78, 1.0, across)) * smoothstep(0.0, 0.05, vU) * smoothstep(1.0, 0.95, vU);
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
}
`;

export class AbilityFx {
  constructor(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'abilities';
    this.built = false;
    this.slotWall = new Array(SLOTS).fill(null);
  }

  init() {}

  build() {
    const { scene } = this.ctx;
    // pillars: a six-sided tapered column with its base on the ground
    const geo = new THREE.CylinderGeometry(0.72, 1.0, 1, 6, 1);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, flatShading: true });
    this.pillars = new THREE.InstancedMesh(geo, mat, SLOTS * PILLARS);
    this.pillars.castShadow = true;
    this.pillars.receiveShadow = true;
    this.pillars.frustumCulled = false;
    this.pillars.name = 'wallPillars';
    _s.set(0, 0, 0);
    _m.compose(_p.set(0, -1e4, 0), _q.identity(), _s);
    for (let i = 0; i < SLOTS * PILLARS; i++) {
      this.pillars.setMatrixAt(i, _m);
      this.pillars.setColorAt(i, ROCKS[0]);
    }
    this.group.add(this.pillars);

    // tether ribbons
    const verts = BEAMS * (SEG + 1) * 2;
    const pos = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    const au = new Float32Array(verts);
    const idx = [];
    for (let b = 0; b < BEAMS; b++) {
      const o = b * (SEG + 1) * 2;
      for (let i = 0; i < SEG; i++) {
        const a = o + i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const bg = new THREE.BufferGeometry();
    this.beamPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.beamUv = new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage);
    this.beamU = new THREE.BufferAttribute(au, 1).setUsage(THREE.DynamicDrawUsage);
    bg.setAttribute('position', this.beamPos);
    bg.setAttribute('uv', this.beamUv);
    bg.setAttribute('aU', this.beamU);
    bg.setIndex(idx);
    bg.setDrawRange(0, 0);
    const bm = new THREE.ShaderMaterial({
      name: 'LeechBeam',
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.beams = new THREE.Mesh(bg, bm);
    this.beams.frustumCulled = false;
    this.beams.renderOrder = 4;
    this.group.add(this.beams);

    scene.add(this.group);
    this.built = true;
    this.hookEvents();
  }

  hookEvents() {
    const { bus } = this.ctx;
    bus.on('ability', ({ kind, caster, target }) => this.onCast(kind, caster, target));
    bus.on('wallBreak', ({ wall, stream }) => this.onBreak(wall, stream));
    bus.on('wallBlocked', ({ wall, stream }) => this.onBlocked(wall, stream));
  }

  get fx() {
    return this.ctx.world?.streams?.fx;
  }

  /** Feel of a cast: you are the one pressing the button, so you get the punch. */
  onCast(kind, caster, target) {
    const game = this.ctx.game;
    const col = new THREE.Color(kind === 'wall' ? 0x9cc4d4 : kind === 'leech' ? 0x38e0ff : 0xdfe9f0);
    if (caster.isPlayer) {
      this.ctx.postfx?.pulse?.(0.32, col);
      game.cameraDirector?.addTrauma?.(kind === 'wall' ? 0.34 : 0.2);
    }
    const fx = this.fx;
    if (!fx) return;
    // a burst of droplets off the caster's head: the throw
    for (let i = 0, n = fx.count(14); i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 4 + Math.random() * 6;
      fx.emit(P.DROP, caster.pos.x, caster.pos.y + caster.radius * 0.7, caster.pos.z, Math.cos(a) * sp, 4 + Math.random() * 5, Math.sin(a) * sp, 0.6 + Math.random() * 0.4, 0.5, 0.25, 1, 0.6, 0.04, col, 0.95, 1);
    }
  }

  onBreak(wall, stream) {
    const fx = this.fx;
    if (!fx) return;
    const col = new THREE.Color(0x9cc4d4);
    const px = -wall.dirz;
    const pz = wall.dirx;
    for (let i = 0, n = fx.count(46); i < n; i++) {
      const lat = (Math.random() - 0.5) * wall.width;
      const x = wall.x + px * lat;
      const z = wall.z + pz * lat;
      fx.emit(P.DROP, x, wall.y + 2 + Math.random() * 8, z, stream.vel.x * 0.4 + (Math.random() - 0.5) * 14, 5 + Math.random() * 9, stream.vel.z * 0.4 + (Math.random() - 0.5) * 14, 0.9 + Math.random() * 0.6, 1.1, 0.5, 1, 0.5, 0.04, col, 0.95);
    }
    for (let i = 0, n = fx.count(18); i < n; i++) {
      fx.emit(P.MIST, wall.x + px * (Math.random() - 0.5) * wall.width, wall.y + 4, wall.z + pz * (Math.random() - 0.5) * wall.width, 0, 2 + Math.random() * 3, 0, 1.6, 5, 14, 0, 1.2, 0, STEAM, 0.4);
    }
    const p = this.ctx.game.player;
    if (p && Math.hypot(p.pos.x - wall.x, p.pos.z - wall.z) < 200) this.ctx.game.cameraDirector?.addTrauma?.(stream === p ? 0.6 : 0.3);
  }

  onBlocked(wall, stream) {
    const fx = this.fx;
    if (!fx) return;
    for (let i = 0, n = fx.count(16); i < n; i++) {
      fx.emit(P.DROP, stream.pos.x, stream.pos.y + 1, stream.pos.z, -wall.dirx * 6 + (Math.random() - 0.5) * 10, 3 + Math.random() * 5, -wall.dirz * 6 + (Math.random() - 0.5) * 10, 0.7, 0.8, 0.4, 1, 0.6, 0.04, STEAM, 0.9);
    }
    if (stream.isPlayer) this.ctx.game.cameraDirector?.addTrauma?.(0.45);
  }

  // --- per tick -------------------------------------------------------------------------

  update(dt) {
    if (!this.built) {
      if (!this.ctx.game?.abilities) return;
      this.build();
    }
    const game = this.ctx.game;
    const ab = game.abilities;
    const now = game.time;
    this.updateWalls(ab, now);
    this.updateBeams(game, now);
    this.updateSteam(game, dt);
  }

  slotFor(w) {
    let s = this.slotWall.indexOf(w);
    if (s >= 0) return s;
    s = this.slotWall.indexOf(null);
    if (s < 0) return -1;
    this.slotWall[s] = w;
    // stable look for this wall: heights, jitter and the rock tones
    const r = mulberry32(w.id * 977 + 13);
    w.fx = [];
    for (let i = 0; i < PILLARS; i++) {
      const t = (i - (PILLARS - 1) / 2) / ((PILLARS - 1) / 2); // -1..1 across the wall
      w.fx.push({
        lat: t * w.width * 0.5,
        off: (r() - 0.5) * 3.2,
        h: w.height * (0.85 + r() * 0.6) * (1 - 0.22 * Math.abs(t)),
        rad: (w.width / PILLARS) * (0.7 + r() * 0.22),
        yaw: r() * Math.PI,
        tilt: (r() - 0.5) * 0.14,
        delay: Math.abs(t) * 0.1 + r() * 0.04, // the slam ripples out from the centre
      });
      this.pillars.setColorAt(s * PILLARS + i, ROCKS[Math.floor(r() * ROCKS.length)]);
    }
    this.pillars.instanceColor.needsUpdate = true;
    return s;
  }

  updateWalls(ab, now) {
    const { terrain } = this.ctx;
    const live = new Set();
    for (const w of ab.walls) {
      const slot = this.slotFor(w);
      if (slot < 0) continue;
      live.add(slot);
      const age = now - w.rise;
      // the moment it lands: spray along the base and a shove on the camera
      if (age >= 0 && !w._landed) {
        w._landed = true;
        this.onLand(w);
      }
      const px = -w.dirz;
      const pz = w.dirx;
      const dying = !w.broken && now > w.end - 0.9 ? clamp01((w.end - now) / 0.9) : 1;
      const brk = w.broken ? clamp01((now - w.brokenAt) / 0.55) : 0;
      for (let i = 0; i < PILLARS; i++) {
        const f = w.fx[i];
        const rise = age < 0 ? 0 : easeOutBack(clamp01((age - f.delay) / 0.34));
        const k = Math.max(0, rise) * dying * (1 - brk);
        const x = w.x + px * f.lat + w.dirx * f.off;
        const z = w.z + pz * f.lat + w.dirz * f.off;
        const g = terrain.heightAt(x, z);
        if (k <= 0.001) {
          _m.compose(_p.set(x, -1e4, z), _q.identity(), _s.set(0, 0, 0));
        } else {
          // a broken wall topples forward as it sinks
          _e.set(f.tilt + brk * (0.5 + f.off * 0.1), f.yaw, f.tilt * 0.5);
          _q.setFromEuler(_e);
          _m.compose(_p.set(x, g - 1.5 - brk * 4, z), _q, _s.set(f.rad, f.h * k, f.rad));
        }
        this.pillars.setMatrixAt(slot * PILLARS + i, _m);
      }
    }
    // free the slots whose wall is gone
    for (let s = 0; s < SLOTS; s++) {
      if (this.slotWall[s] && !live.has(s)) {
        this.slotWall[s] = null;
        for (let i = 0; i < PILLARS; i++) {
          _m.compose(_p.set(0, -1e4, 0), _q.identity(), _s.set(0, 0, 0));
          this.pillars.setMatrixAt(s * PILLARS + i, _m);
        }
      }
    }
    this.pillars.instanceMatrix.needsUpdate = true;
  }

  onLand(w) {
    const fx = this.fx;
    const game = this.ctx.game;
    const p = game.player;
    if (p) {
      const d = Math.hypot(p.pos.x - w.x, p.pos.z - w.z);
      if (d < 220) game.cameraDirector?.addTrauma?.(0.55 * (1 - d / 220) + 0.1);
    }
    if (!fx) return;
    const px = -w.dirz;
    const pz = w.dirx;
    for (let i = 0, n = fx.count(60); i < n; i++) {
      const lat = (Math.random() - 0.5) * w.width;
      fx.emit(P.DROP, w.x + px * lat, w.y + 1, w.z + pz * lat, (Math.random() - 0.5) * 10, 9 + Math.random() * 12, (Math.random() - 0.5) * 10, 0.9 + Math.random() * 0.7, 1.3, 0.5, 1, 0.5, 0.04, STEAM, 0.95);
    }
    for (let i = 0, n = fx.count(22); i < n; i++) {
      const lat = (Math.random() - 0.5) * w.width;
      fx.emit(P.MIST, w.x + px * lat, w.y + 1.5, w.z + pz * lat, 0, 3 + Math.random() * 2, 0, 1.8, 6, 16, 0, 1.2, 0, STEAM, 0.35);
    }
  }

  updateBeams(game, now) {
    const cam = this.ctx.camera.position;
    let nb = 0;
    for (const s of game.streams) {
      if (nb >= BEAMS) break;
      const T = s.leechTarget;
      if (!(s.leechT > 0) || !T || !T.alive || T.phase !== 'flow' || s.phase !== 'flow') continue;
      // u runs from the drained river (0) to the drinker (1)
      _a.set(T.pos.x, T.pos.y + T.radius * 0.6, T.pos.z);
      _b.set(s.pos.x, s.pos.y + s.radius * 0.6, s.pos.z);
      const dist = _a.distanceTo(_b);
      const arc = 5 + dist * 0.07;
      _t.subVectors(_b, _a).normalize();
      _perp.crossVectors(_t, UP).normalize();
      const fade = clamp01(s.leechT / 0.5); // thins out as it lets go
      const o = nb * (SEG + 1) * 2;
      for (let i = 0; i <= SEG; i++) {
        const u = i / SEG;
        const bow = Math.sin(Math.PI * u);
        const wob = Math.sin(u * 11 - now * 9) * 0.7 * bow;
        const px = _a.x + (_b.x - _a.x) * u + _perp.x * wob;
        const py = _a.y + (_b.y - _a.y) * u + bow * arc;
        const pz = _a.z + (_b.z - _a.z) * u + _perp.z * wob;
        // tangent from the neighbours, so the ribbon always faces the camera
        const u2 = Math.min(1, u + 1 / SEG);
        const bow2 = Math.sin(Math.PI * u2);
        _p.set(_a.x + (_b.x - _a.x) * u2 - px, _a.y + (_b.y - _a.y) * u2 + bow2 * arc - py, _a.z + (_b.z - _a.z) * u2 - pz);
        _side.crossVectors(_p, _s.set(px - cam.x, py - cam.y, pz - cam.z)).normalize();
        const w = (1.4 + 2.4 * Math.pow(bow, 0.7) + dist * 0.008) * (0.82 + 0.18 * Math.sin(now * 14 + u * 5)) * fade;
        const v = (o + i * 2) * 3;
        const pa = this.beamPos.array;
        pa[v] = px - _side.x * w;
        pa[v + 1] = py - _side.y * w;
        pa[v + 2] = pz - _side.z * w;
        pa[v + 3] = px + _side.x * w;
        pa[v + 4] = py + _side.y * w;
        pa[v + 5] = pz + _side.z * w;
        const ua = this.beamUv.array;
        const vx = u * dist * 0.18 - now * 2.8;
        ua[(o + i * 2) * 2] = vx;
        ua[(o + i * 2) * 2 + 1] = 0;
        ua[(o + i * 2 + 1) * 2] = vx;
        ua[(o + i * 2 + 1) * 2 + 1] = 1;
        this.beamU.array[o + i * 2] = u;
        this.beamU.array[o + i * 2 + 1] = u;
      }
      // droplets riding the tether towards the drinker: the litres you see leaving
      const fx = this.fx;
      if (fx) {
        for (let k = 0, n = fx.count(3); k < n; k++) {
          const u = Math.random() * 0.25;
          const bow = Math.sin(Math.PI * u);
          const x = _a.x + (_b.x - _a.x) * u;
          const y = _a.y + (_b.y - _a.y) * u + bow * arc;
          const z = _a.z + (_b.z - _a.z) * u;
          const spd = dist / 0.9;
          fx.emit(P.DROP, x, y, z, _t.x * spd, arc * 2.2, _t.z * spd, 0.85, 1.2, 0.5, 2.4, 0, 0.05, LEECH, 1, 1);
        }
        // the target bleeds at the far end
        if (Math.random() < 0.5) fx.emit(P.MIST, _a.x, _a.y, _a.z, 0, 2, 0, 0.8, T.radius * 0.8, T.radius * 2.2, 0, 1, 0, BLEED, 0.45, 1);
      }
      nb++;
    }
    this.beams.geometry.setDrawRange(0, nb * SEG * 6);
    this.beams.visible = nb > 0;
    if (nb > 0) {
      this.beamPos.needsUpdate = true;
      this.beamUv.needsUpdate = true;
      this.beamU.needsUpdate = true;
    }
  }

  /** Steam pouring off a fogged river. */
  updateSteam(game, dt) {
    const fx = this.fx;
    if (!fx) return;
    for (const s of game.streams) {
      if (!(s.fogT > 0) || s.phase !== 'flow') continue;
      const k = Math.min(1, s.fogT / 1.2);
      const n = fx.count(120 * dt * k);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * s.radius * 1.4;
        fx.emit(P.MIST, s.pos.x + Math.cos(a) * r, s.pos.y + s.radius * 0.6, s.pos.z + Math.sin(a) * r, s.vel.x * 0.5 + (Math.random() - 0.5) * 3, 2.5 + Math.random() * 3, s.vel.z * 0.5 + (Math.random() - 0.5) * 3, 2.2 + Math.random(), s.radius * 2 + 4, s.radius * 5.5 + 12, 0, 1.0, 0, STEAM, 0.78 * k);
      }
      // the stylised part: hard-edged cartoon puffs billowing up off the river
      for (let i = 0, m = fx.count(80 * dt * k); i < m; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * s.radius;
        fx.emit(P.FOAM, s.pos.x + Math.cos(a) * r, s.pos.y + s.radius * 0.8, s.pos.z + Math.sin(a) * r, s.vel.x * 0.6 + (Math.random() - 0.5) * 4, 5 + Math.random() * 4, s.vel.z * 0.6 + (Math.random() - 0.5) * 4, 1.5 + Math.random() * 0.6, s.radius * 1.6 + 7, s.radius * 3.4 + 16, -0.12, 1.4, 0, PUFF, 0.97);
      }
    }
  }

  reset() {
    if (!this.built) return;
    this.slotWall.fill(null);
    for (let i = 0; i < SLOTS * PILLARS; i++) {
      _m.compose(_p.set(0, -1e4, 0), _q.identity(), _s.set(0, 0, 0));
      this.pillars.setMatrixAt(i, _m);
    }
    this.pillars.instanceMatrix.needsUpdate = true;
    this.beams.geometry.setDrawRange(0, 0);
  }
}
