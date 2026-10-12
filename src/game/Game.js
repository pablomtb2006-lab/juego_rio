import { Stream } from './Stream.js';
import { StreamPhysics } from './StreamPhysics.js';
import { Rules } from './Rules.js';
import { AIController } from './AIController.js';
import { PlayerController } from './PlayerController.js';
import { CameraDirector } from './CameraDirector.js';
import { Input } from './Input.js';
import { RIVAL_NAMES, PERSONALITIES } from './names.js';
import { RIVAL_COLORS } from './skins.js';
import { mulberry32 } from '../core/random.js';
import { runScenario } from './Scenarios.js';

export const RIVAL_COUNT = 15;
export const DROP_ALTITUDE = 3200;

/**
 * Match flow / state machine:  'menu' → 'drop' → 'stream' → 'result'
 * Emits 'phase' { state } on every transition. ctx.game exposes:
 *   state, streams[], player, time, finishCount, aliveCount, cameraDirector,
 *   startMatch(), toMenu(), revivePlayer(), startScenario(name)
 */
export class Game {
  constructor(ctx) {
    this.ctx = ctx;
    this.state = 'menu';
    this.streams = [];
    this.player = null;
    this.time = 0;
    this.finishCount = 0;
    this.input = new Input();
    this.physics = new StreamPhysics(this);
    this.rules = new Rules(this);
    this.cameraDirector = new CameraDirector(this);

    ctx.bus.on('landed', ({ stream }) => {
      if (stream === this.player) {
        this.setState('stream');
        this.cameraDirector.setMode('chase', { target: stream, snap: false });
        this.cameraDirector.shake(6);
      }
    });
    ctx.bus.on('finished', ({ stream }) => {
      if (stream === this.player) this.endMatch('win');
    });
    ctx.bus.on('eliminated', ({ victim }) => {
      if (victim === this.player) this.endMatch('eliminated');
    });
  }

  get aliveCount() {
    return this.streams.filter((s) => s.alive).length;
  }

  setState(state) {
    this.state = state;
    this.ctx.bus.emit('phase', { state });
  }

  startMatch({ seed = this.ctx.params.seed + Date.now() % 1000, skin } = {}) {
    const { world, terrain, services } = this.ctx;
    world.reset();
    this.rules.reset();
    this.time = 0;
    this.finishCount = 0;
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

    const peak = terrain.peaks[0] ?? { x: 0, y: 800, z: 0 };
    streams.forEach((s, i) => {
      const a = (i / streams.length) * Math.PI * 2 + rand();
      const r = i === 0 ? 0 : 600 + rand() * terrain.size * 0.25;
      s.pos.set(peak.x + Math.cos(a) * r, DROP_ALTITUDE + rand() * 300, peak.z + Math.sin(a) * r);
      s.vel.set(0, -20, 0);
      s.heading.set(-peak.x, -peak.z).normalize();
      if (!isFinite(s.heading.x)) s.heading.set(0, 1);
      s.volume = 60000;
      s.controller = i === 0 ? null : new AIController(s, rand);
    });
    player.controller = new PlayerController(player, this.input, new AIController(player, rand));

    this.streams = streams;
    this.player = player;
    this.cameraDirector.setMode('drop', { target: player, snap: true });
    this.setState('drop');
    this.ctx.services?.analytics?.track('match_start', { skin: player.skin });
  }

  endMatch(outcome) {
    this.outcome = outcome;
    this.setState('result');
    this.cameraDirector.setMode('finish', { target: this.player, snap: false });
    this.ctx.bus.emit('matchEnd', { outcome, place: this.player.place, player: this.player });
  }

  /** Rewarded-ad revive: bring the player back with half of their peak volume. */
  revivePlayer() {
    const p = this.player;
    if (!p || p.phase !== 'eliminated') return false;
    p.phase = 'flow';
    p.volume = p.peakVolume * 0.5;
    p.eliminatedBy = null;
    this.cameraDirector.setMode('chase', { target: p, snap: true });
    this.setState('stream');
    return true;
  }

  toMenu() {
    this.streams = [];
    this.player = null;
    this.ctx.world.reset();
    this.cameraDirector.setMode('menu', { snap: true });
    this.setState('menu');
  }

  async startScenario(name) {
    await runScenario(this, name);
  }

  fixedUpdate(dt) {
    if (this.state === 'menu') return;
    this.time += dt;
    this.input.update();
    for (const s of this.streams) {
      if (!s.alive) continue;
      s.controller?.update(dt, this);
      this.physics.update(dt, s);
    }
    this.rules.update(dt);
  }

  update(dt) {
    this.cameraDirector.update(dt);
  }
}
