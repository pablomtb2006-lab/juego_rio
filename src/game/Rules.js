/**
 * Match rules. Emits on ctx.bus:
 *   'absorb'     { stream, body, amount }        each tick while swallowing still water / clouds
 *   'cut'        { attacker, victim, amount }    attacker (bigger) crossed victim's river and stole water
 *   'eliminated' { victim, by, reason }          reason: 'blocked' | 'swallowed' | 'dried'
 *   'finished'   { stream, place }               reached the sea
 */
export class Rules {
  constructor(game) {
    this.game = game;
    this.cellSize = 40;
    this.grid = new Map();
    this.cutCooldown = new Map();
  }

  reset() {
    this.grid.clear();
    this.cutCooldown.clear();
  }

  key(cx, cz) {
    return cx * 73856093 ^ cz * 19349663;
  }

  rebuildGrid(streams) {
    this.grid.clear();
    for (const s of streams) {
      if (s.phase !== 'flow') continue;
      const d = s.trail.data;
      // the freshest points belong to the head itself — skip them
      const n = Math.max(0, s.trail.count - 6);
      for (let i = 0; i < n; i += 2) {
        const k = this.key(Math.floor(d[i * 4] / this.cellSize), Math.floor(d[i * 4 + 2] / this.cellSize));
        let arr = this.grid.get(k);
        if (!arr) this.grid.set(k, (arr = []));
        arr.push(s, i);
      }
    }
  }

  update(dt) {
    const game = this.game;
    const { world, terrain, bus } = game.ctx;
    const streams = game.streams;
    this.rebuildGrid(streams);

    for (const s of streams) {
      if (!s.alive) continue;
      s.absorbing = 0;

      // swallow still water (lakes on the ground, clouds in the sky)
      const bodies = s.phase === 'drop' ? world.skyWater.bodies : world.lakes.bodies;
      const holder = s.phase === 'drop' ? world.skyWater : world.lakes;
      for (const b of bodies) {
        if (b.volume <= 0) continue;
        const dx = b.x - s.pos.x;
        const dy = s.phase === 'drop' ? b.y - s.pos.y : 0;
        const dz = b.z - s.pos.z;
        const reach = b.radius + s.radius * (s.phase === 'drop' ? 2 : 1);
        if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
        if (s.phase === 'flow' && Math.abs(b.y - s.pos.y) > 25) continue;
        const rate = Math.max(b.maxVolume * 0.8, 150000);
        const amount = holder.drain(b, rate * dt);
        if (amount > 0) {
          b.drainedBy = s;
          s.addVolume(amount);
          s.absorbing += amount / dt;
          bus.emit('absorb', { stream: s, body: b, amount });
        }
      }

      if (s.phase !== 'flow') continue;
      s.trail.swell(s.radius, 3);
      s.distToSea = terrain.distToSea(s.pos.x, s.pos.z);

      // reached the sea
      if (!terrain.isLand(s.pos.x, s.pos.z) && s.pos.y <= terrain.seaLevel + 0.5) {
        s.phase = 'finished';
        s.place = ++game.finishCount;
        s.finishedAt = game.time;
        s.distToSea = 0;
        bus.emit('finished', { stream: s, place: s.place });
        continue;
      }

      // evaporation: a tiny constant loss keeps pressure on
      s.addVolume(-s.volume * 0.002 * dt);
      if (s.volume < 5000) {
        this.eliminate(s, null, 'dried');
        continue;
      }

      this.checkTrails(s);
    }

    // head-on collisions: bigger swallows smaller
    for (let i = 0; i < streams.length; i++) {
      const a = streams[i];
      if (a.phase !== 'flow') continue;
      for (let j = i + 1; j < streams.length; j++) {
        const b = streams[j];
        if (b.phase !== 'flow') continue;
        const r = a.radius + b.radius;
        if (a.pos.distanceToSquared(b.pos) > r * r) continue;
        const [big, small] = a.volume >= b.volume ? [a, b] : [b, a];
        big.addVolume(small.volume * 0.7);
        this.eliminate(small, big, 'swallowed');
      }
    }

    for (const [k, t] of this.cutCooldown) {
      if (t - dt <= 0) this.cutCooldown.delete(k);
      else this.cutCooldown.set(k, t - dt);
    }
  }

  checkTrails(s) {
    const { bus } = this.game.ctx;
    const cs = this.cellSize;
    const cx = Math.floor(s.pos.x / cs);
    const cz = Math.floor(s.pos.z / cs);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this.grid.get(this.key(cx + dx, cz + dz));
        if (!arr) continue;
        for (let n = 0; n < arr.length; n += 2) {
          const other = arr[n];
          if (other === s || other.phase !== 'flow') continue;
          const i = arr[n + 1];
          const d = other.trail.data;
          const ddx = d[i * 4] - s.pos.x;
          const ddz = d[i * 4 + 2] - s.pos.z;
          const reach = d[i * 4 + 3] + s.radius * 0.6;
          if (ddx * ddx + ddz * ddz > reach * reach) continue;
          const pair = `${s.id}:${other.id}`;
          if (this.cutCooldown.has(pair)) continue;
          if (s.volume > other.volume) {
            const amount = other.volume * 0.35;
            other.addVolume(-amount);
            s.addVolume(amount);
            this.cutCooldown.set(pair, 2.5);
            bus.emit('cut', { attacker: s, victim: other, amount });
          } else {
            other.addVolume(s.volume * 0.5);
            this.eliminate(s, other, 'blocked');
            return;
          }
        }
      }
    }
  }

  eliminate(victim, by, reason) {
    if (!victim.alive) return;
    victim.phase = 'eliminated';
    victim.eliminatedBy = by;
    victim.place = this.game.streams.filter((s) => s.alive).length + this.game.finishCount + 1;
    this.game.ctx.bus.emit('eliminated', { victim, by, reason });
  }
}
