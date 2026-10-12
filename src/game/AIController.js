import * as THREE from 'three';

const _g = new THREE.Vector2();
const _want = new THREE.Vector2();
const _to = new THREE.Vector2();

/**
 * Rival brain. Writes stream.input like a human would (steer / move / surge),
 * so humans and bots obey the exact same physics.
 */
export class AIController {
  constructor(stream, rand) {
    this.stream = stream;
    this.rand = rand;
    this.wander = rand() * 100;
    this.dropTarget = null;
    this.greed = stream.personality === 'greedy' ? 1.6 : stream.personality === 'sprinter' ? 0.4 : 1;
  }

  update(dt, game) {
    const s = this.stream;
    const { terrain } = game.ctx;
    this.wander += dt * 0.7;

    if (s.phase === 'drop') {
      if (!this.dropTarget) {
        const peaks = terrain.peaks.length ? terrain.peaks : [{ x: 0, z: 0 }];
        const p = peaks[Math.floor(this.rand() * Math.min(peaks.length, 12))];
        this.dropTarget = new THREE.Vector2(p.x + (this.rand() - 0.5) * 300, p.z + (this.rand() - 0.5) * 300);
      }
      _to.set(this.dropTarget.x - s.pos.x, this.dropTarget.y - s.pos.z);
      const d = _to.length();
      s.input.move.set(0, 0);
      if (d > 20) {
        _to.divideScalar(d);
        // move is camera-relative for the player; for bots treat it as world x/z
        s.input.move.set(_to.x, _to.y);
      }
      s.input.worldSpace = true;
      return;
    }

    if (s.phase !== 'flow') return;

    // downhill preference
    terrain.gradientAt(s.pos.x, s.pos.z, _g);
    _want.set(-_g.x, -_g.y);
    if (_want.lengthSq() < 1e-6) _want.copy(s.heading);
    _want.normalize();

    // attraction to nearby still water that is not uphill
    let best = null;
    let bestScore = 0;
    for (const b of game.ctx.world.lakes.bodies) {
      if (b.volume <= 0) continue;
      const dx = b.x - s.pos.x;
      const dz = b.z - s.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 500 || b.y > s.pos.y + 5) continue;
      const ahead = (dx * s.heading.x + dz * s.heading.y) / (dist || 1);
      if (ahead < 0.2) continue;
      const score = (b.volume / 1e6) * this.greed * ahead / (1 + dist / 150);
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }
    if (best) {
      _to.set(best.x - s.pos.x, best.z - s.pos.z).normalize();
      _want.lerp(_to, Math.min(0.7, bestScore * 2)).normalize();
    }

    _want.rotateAround(_to.set(0, 0), Math.sin(this.wander) * 0.25);
    const cross = s.heading.x * _want.y - s.heading.y * _want.x;
    s.input.steer = THREE.MathUtils.clamp(cross * 3, -1, 1);
    s.input.surge = s.personality === 'sprinter' && s.volume > 400000 && Math.sin(this.wander * 3) > 0.9;
  }
}
