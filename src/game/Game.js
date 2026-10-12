import * as THREE from 'three';
import { Stream } from './Stream.js';
import { StreamPhysics } from './StreamPhysics.js';
import { Rules, RULES } from './Rules.js';
import { AIController } from './AIController.js';
import { archGate } from './arch.js';
import { PlayerController } from './PlayerController.js';
import { CameraDirector } from './CameraDirector.js';
import { Input } from './Input.js';
import { Hydrology } from './Hydrology.js';
import { RIVAL_NAMES, PERSONALITIES } from './names.js';
import { RIVAL_COLORS } from './skins.js';
import { mulberry32 } from '../core/random.js';
import { runScenario } from './Scenarios.js';

export const RIVAL_COUNT = 15;
export const DROP_ALTITUDE = 3300;
export const START_VOLUME = 150000;

const _v = new THREE.Vector3();
const _c = new THREE.Vector3();

/**
 * Match flow / state machine:  'menu' → 'drop' → 'stream' → 'result'
 * Emits 'phase' { state } on every transition. ctx.game exposes:
 *   state, streams[], player, time, finishCount, aliveCount, cameraDirector, hydro, dropZone,
 *   startMatch(), toMenu(), revivePlayer(), startScenario(name),
 *   getNameTags(), getStandings(), leader, timeScale
 *
 * Streams are driven by controllers that only write `stream.input` (PlayerController,
 * AIController; a NetworkController can slot in the same way).
 */
export class Game {
  constructor(ctx) {
    this.ctx = ctx;
    this.state = 'menu';
    this.streams = [];
    this.player = null;
    this.time = 0;
    this.finishCount = 0;
    this.timeScale = 1;
    this.slowMoT = 0;
    this.slowMoScale = 1;
    this.pendingEnd = null;
    this.outcome = null;
    this.input = new Input(ctx);
    this.physics = new StreamPhysics(this);
    this.rules = new Rules(this);
    this.cameraDirector = new CameraDirector(this);
    this._tags = new Map();

    const bus = ctx.bus;
    bus.on('landed', ({ stream, impact }) => {
      if (stream !== this.player) return;
      this.setState('stream');
      this.cameraDirector.onLanded(stream, impact);
      this.slowMo(0.4, 0.35);
    });
    bus.on('cut', ({ attacker, victim }) => {
      if (attacker === this.player) {
        this.cameraDirector.onCut(true);
        this.slowMo(0.5, 0.22);
      } else if (victim === this.player) this.cameraDirector.onCut(false);
    });
    bus.on('bonus', ({ stream }) => {
      if (stream === this.player) this.cameraDirector.addTrauma(0.35);
    });
    bus.on('finished', ({ stream }) => {
      if (stream !== this.player) return;
      this.cameraDirector.onVictory(stream);
      this.slowMo(0.35, 0.7);
      this.scheduleEnd('win');
    });
    bus.on('eliminated', ({ victim, by }) => {
      if (victim !== this.player) return;
      this.cameraDirector.onEliminated(victim, by);
      this.slowMo(0.3, 0.9);
      this.scheduleEnd('eliminated');
    });
  }

  init() {
    this.ensureWorldData();
  }

  /** Hydrology + drop zone are derived from the terrain once (≈100 ms). */
  ensureWorldData() {
    if (this.hydro) return;
    const { terrain } = this.ctx;
    this.hydro = new Hydrology(terrain);
    this.dropZone = computeDropZone(terrain, this.hydro);
  }

  get aliveCount() {
    return this.streams.filter((s) => s.alive).length;
  }

  /** The stream currently in first place (finished #1, else closest to the sea). */
  get leader() {
    let best = null;
    for (const s of this.streams) {
      if (s.phase === 'eliminated') continue;
      if (!best || (s.livePlace || 99) < (best.livePlace || 99)) best = s;
    }
    return best;
  }

  setState(state) {
    this.state = state;
    this.ctx.bus.emit('phase', { state });
  }

  /** Brief slow motion (sim only — the camera keeps real time). */
  slowMo(scale, seconds) {
    if (this.noSlowMo) return;
    this.slowMoScale = Math.min(this.slowMoT > 0 ? this.slowMoScale : 1, scale);
    this.slowMoT = Math.max(this.slowMoT, seconds);
  }

  scheduleEnd(outcome) {
    if (this.pendingEnd || this.state === 'result') return;
    this.pendingEnd = { outcome, t: RULES.resultDelay };
  }

  startMatch({ seed = this.ctx.params.seed + (Date.now() % 1000), skin, intro = true } = {}) {
    this.ensureWorldData();
    const { world, terrain, services } = this.ctx;
    world.reset();
    this.rules.reset();
    this.time = 0;
    this.finishCount = 0;
    this.pendingEnd = null;
    this.outcome = null;
    this.slowMoT = 0;
    this.timeScale = 1;
    this.dropClaims = [];
    this._tags.clear();
    const rand = mulberry32(seed);
    this.rand = rand;

    const player = new Stream({
      id: 0,
      name: services?.storage?.get('playerName', 'Tú') ?? 'Tú',
      color: 0xffffff,
      skin: skin ?? services?.economy?.equippedSkin ?? 'clear',
      isPlayer: true,
    });
    const streams = [player];
    for (let i = 0; i < RIVAL_COUNT; i++) {
      streams.push(
        new Stream({
          id: i + 1,
          name: RIVAL_NAMES[i % RIVAL_NAMES.length],
          color: RIVAL_COLORS[i % RIVAL_COLORS.length],
          skin: 'clear',
          personality: PERSONALITIES[i % PERSONALITIES.length],
        }),
      );
    }

    const zone = this.dropZone;
    const arch = world.landmarks?.arch;
    // the player starts above the summit arch on a glide line through it (fly straight = arch bonus)
    if (arch) {
      const { center, normal: n } = archGate(arch);
      const fall = DROP_ALTITUDE - center.y;
      const back = fall * 0.29;
      player.pos.set(center.x + n.x * back, DROP_ALTITUDE, center.z + n.z * back);
      player.heading.set(-n.x, -n.z).normalize();
    } else {
      player.pos.set(zone.x, DROP_ALTITUDE, zone.z);
      player.heading.set(-zone.x, -zone.z).normalize();
    }
    streams.forEach((s, i) => {
      if (i > 0) {
        const a = (i / streams.length) * Math.PI * 2 + rand() * 0.4;
        const r = zone.radius * (0.35 + rand() * 0.55);
        s.pos.set(zone.x + Math.cos(a) * r, DROP_ALTITUDE - 150 + rand() * 300, zone.z + Math.sin(a) * r);
        s.heading.set(Math.cos(a + Math.PI + (rand() - 0.5)), Math.sin(a + Math.PI + (rand() - 0.5))).normalize();
      }
      if (!isFinite(s.heading.x) || s.heading.lengthSq() < 0.5) s.heading.set(0, 1);
      s.vel.set(s.heading.x * 20, -30, s.heading.y * 20);
      s.volume = START_VOLUME;
      s.peakVolume = s.volume;
      s.routeDist = this.hydro.routeDistAt(s.pos.x, s.pos.z);
      s.controller = i === 0 ? null : new AIController(s, rand);
    });
    player.controller = new PlayerController(player, this.input, new AIController(player, rand, { skill: 1, rubberBand: false }));

    this.streams = streams;
    this.player = player;
    this.cameraDirector.startMatch(player, { intro });
    this.setState('drop');
    this.ctx.services?.analytics?.track('match_start', { skin: player.skin });
  }

  endMatch(outcome) {
    if (this.state === 'result') return;
    this.outcome = outcome;
    this.pendingEnd = null;
    this.setState('result');
    const p = this.player;
    this.ctx.bus.emit('matchEnd', {
      outcome,
      place: p.place,
      player: p,
      time: this.time,
      finished: p.phase === 'finished',
      by: p.eliminatedBy,
      reason: p.eliminatedReason,
    });
  }

  /** Rewarded-ad revive: bring the player back with half of their peak volume. */
  revivePlayer() {
    const p = this.player;
    if (!p || p.phase !== 'eliminated') return false;
    p.phase = 'flow';
    p.volume = Math.max(p.peakVolume * 0.5, 150000);
    p.eliminatedBy = null;
    p.eliminatedReason = null;
    p.contact = 0;
    p.danger = 0;
    p.protectedFor = RULES.protectTime + 1;
    p.flowSpeed = Math.max(p.flowSpeed, 15);
    p.place = 0;
    this.pendingEnd = null;
    this.outcome = null;
    this.cameraDirector.setMode('chase', { target: p, snap: true });
    this.setState('stream');
    return true;
  }

  toMenu() {
    this.streams = [];
    this.player = null;
    this.pendingEnd = null;
    this.ctx.world.reset();
    this.rules.reset();
    this.cameraDirector.setMode('menu', { snap: true });
    this.setState('menu');
  }

  async startScenario(name) {
    await runScenario(this, name);
  }

  fixedUpdate(dt) {
    if (this.state === 'menu') return;
    // slow motion (cinematic beats)
    if (this.slowMoT > 0) {
      this.slowMoT -= dt;
      this.timeScale += (this.slowMoScale - this.timeScale) * Math.min(1, dt * 14);
    } else {
      this.timeScale += (1 - this.timeScale) * Math.min(1, dt * 5);
      if (this.timeScale > 0.999) this.timeScale = 1;
    }
    const sdt = dt * this.timeScale;
    this.time += sdt;
    this.input.update(dt);
    for (const s of this.streams) {
      if (!s.alive) continue;
      s.controller?.update(sdt, this);
      this.physics.update(sdt, s);
    }
    this.rules.update(sdt);

    if (this.pendingEnd) {
      this.pendingEnd.t -= dt;
      if (this.pendingEnd.t <= 0) this.endMatch(this.pendingEnd.outcome);
    }
  }

  update(dt) {
    this.cameraDirector.update(dt);
  }

  // --- UI helpers -------------------------------------------------------------------

  /**
   * Screen-space name tags for every other stream (and optionally the player):
   *   [{ stream, name, color: '#rrggbb', screen: { x, y } (CSS px), visible, occluded,
   *      distance (m), scale (0..1 suggested size), bigger (vs player), place, phase }]
   * `visible` = in front of the camera, inside the viewport (with margin), not hidden
   * by terrain and within `maxDistance`.
   */
  getNameTags({ includePlayer = false, maxDistance = 3000 } = {}) {
    const { camera, renderer, terrain } = this.ctx;
    camera.updateMatrixWorld();
    const el = renderer?.domElement;
    const w = el?.clientWidth || window.innerWidth;
    const h = el?.clientHeight || window.innerHeight;
    const p = this.player;
    const out = [];
    for (const s of this.streams) {
      if (s === p && !includePlayer) continue;
      if (s.phase === 'eliminated' && this.time - s.eliminatedAt > 2) continue;
      let tag = this._tags.get(s);
      if (!tag) {
        tag = { stream: s, name: s.name, color: `#${s.color.toString(16).padStart(6, '0')}`, screen: { x: 0, y: 0 } };
        this._tags.set(s, tag);
      }
      const lift = s.phase === 'drop' ? s.radius * 1.9 + 8 : s.radius * 1.2 + 7;
      _v.set(s.pos.x, s.pos.y + lift, s.pos.z);
      const distance = _v.distanceTo(camera.position);
      _c.copy(_v).project(camera);
      const inFront = _c.z > -1 && _c.z < 1;
      tag.screen.x = ((_c.x + 1) / 2) * w;
      tag.screen.y = ((1 - _c.y) / 2) * h;
      tag.distance = distance;
      tag.scale = THREE.MathUtils.clamp(1.15 - distance / 2500, 0.45, 1);
      tag.bigger = p ? s.volume >= p.volume * RULES.ratio : false;
      tag.smaller = p ? p.volume >= s.volume * RULES.ratio : false;
      tag.place = s.livePlace || s.place;
      tag.phase = s.phase;
      tag.volume = s.volume;
      tag.occluded = inFront ? this.occluded(camera.position, _v, terrain) : false;
      tag.visible = inFront && !tag.occluded && distance < maxDistance && Math.abs(_c.x) < 1.05 && Math.abs(_c.y) < 1.05;
      out.push(tag);
    }
    return out;
  }

  occluded(from, to, terrain) {
    for (let i = 1; i < 10; i++) {
      const f = i / 10;
      const x = from.x + (to.x - from.x) * f;
      const y = from.y + (to.y - from.y) * f;
      const z = from.z + (to.z - from.z) * f;
      if (terrain.heightAt(x, z) > y + 3) return true;
    }
    return false;
  }

  /** Live standings, best first: [{ stream, name, place, phase, volume, distToSea, isPlayer }]. */
  getStandings() {
    const list = this.streams.map((s) => ({
      stream: s,
      name: s.name,
      place: s.phase === 'finished' || s.phase === 'eliminated' ? s.place : s.livePlace,
      phase: s.phase,
      volume: s.volume,
      distToSea: s.distToSea,
      isPlayer: s.isPlayer,
    }));
    return list.sort((a, b) => (a.place || 99) - (b.place || 99));
  }
}

/** A circle over high ground where every drop must land ("land on the mountain"). */
function computeDropZone(terrain, hydro) {
  const { res, H } = hydro;
  let maxH = 0;
  for (let k = 0; k < H.length; k++) if (H[k] > maxH) maxH = H[k];
  let sx = 0;
  let sz = 0;
  let sw = 0;
  for (let j = 0; j < res; j += 2) {
    for (let i = 0; i < res; i += 2) {
      const w = H[j * res + i] - maxH * 0.45;
      if (w <= 0) continue;
      const [x, z] = hydro.toWorld(i, j);
      sx += x * w;
      sz += z * w;
      sw += w;
    }
  }
  const cx = sw > 0 ? sx / sw : 0;
  const cz = sw > 0 ? sz / sw : 0;
  // shortest distance to the coast around the centre
  let coast = Infinity;
  for (let a = 0; a < 48; a++) {
    const dx = Math.cos((a / 48) * Math.PI * 2);
    const dz = Math.sin((a / 48) * Math.PI * 2);
    for (let r = 50; r < terrain.size / 2; r += 50) {
      if (!terrain.isLand(cx + dx * r, cz + dz * r)) {
        coast = Math.min(coast, r);
        break;
      }
    }
  }
  const radius = Math.max(400, Math.min(1050, coast * 0.42));
  return { x: cx, z: cz, radius };
}
