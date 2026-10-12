import * as THREE from 'three';

const _g = new THREE.Vector2();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();

export const PHYS = {
  gravity: 9.81,
  terminalFall: 90, // m/s while dropping
  dropSteerAccel: 35,
  dropMaxHorizontal: 70,
  slopeAccel: 9.81 * 5, // arcade: slopes pull hard
  steerAccel: 30,
  surgeAccel: 25,
  surgeCostPerSec: 0.05, // fraction of volume
  drag: 0.35,
  minSpeed: 7,
  trailSpacing: 4,
};

/** Moves streams. Emits 'landed' and 'splash' on touchdown. */
export class StreamPhysics {
  constructor(game) {
    this.game = game;
  }

  update(dt, s) {
    if (s.phase === 'drop') this.updateDrop(dt, s);
    else if (s.phase === 'flow') this.updateFlow(dt, s);
  }

  updateDrop(dt, s) {
    const { terrain, camera } = this.game.ctx;
    const mv = s.input.move;
    let ax = 0;
    let az = 0;
    if (s.input.worldSpace) {
      ax = mv.x;
      az = mv.y;
    } else {
      // camera-relative steering for the human player
      camera.getWorldDirection(_fwd);
      _fwd.y = 0;
      _fwd.normalize();
      _right.set(-_fwd.z, 0, _fwd.x);
      ax = _fwd.x * mv.y + _right.x * mv.x;
      az = _fwd.z * mv.y + _right.z * mv.x;
    }
    s.vel.x += ax * PHYS.dropSteerAccel * dt;
    s.vel.z += az * PHYS.dropSteerAccel * dt;
    const h = Math.hypot(s.vel.x, s.vel.z);
    if (h > PHYS.dropMaxHorizontal) {
      s.vel.x *= PHYS.dropMaxHorizontal / h;
      s.vel.z *= PHYS.dropMaxHorizontal / h;
    }
    s.vel.x *= 1 - 0.4 * dt;
    s.vel.z *= 1 - 0.4 * dt;
    s.vel.y = Math.max(s.vel.y - PHYS.gravity * dt * 2, -PHYS.terminalFall);
    s.pos.addScaledVector(s.vel, dt);

    // keep drops over the island
    const lim = terrain.size * 0.42;
    s.pos.x = THREE.MathUtils.clamp(s.pos.x, -lim, lim);
    s.pos.z = THREE.MathUtils.clamp(s.pos.z, -lim, lim);

    if (h > 1) s.heading.set(s.vel.x, s.vel.z).normalize();

    const ground = Math.max(terrain.heightAt(s.pos.x, s.pos.z), terrain.seaLevel);
    if (s.pos.y <= ground + s.radius * 0.5) {
      s.pos.y = ground;
      s.phase = 'flow';
      s.landedAt = this.game.time;
      terrain.gradientAt(s.pos.x, s.pos.z, _g);
      s.vel.set(s.vel.x * 0.3 - _g.x * 10, 0, s.vel.z * 0.3 - _g.y * 10);
      if (s.vel.lengthSq() < 1) s.vel.set(s.heading.x * PHYS.minSpeed, 0, s.heading.y * PHYS.minSpeed);
      s.trail.push(s.pos.x, s.pos.y, s.pos.z, s.radius);
      this.game.ctx.bus.emit('landed', { stream: s });
      this.game.ctx.bus.emit('splash', { x: s.pos.x, y: s.pos.y, z: s.pos.z, size: s.radius * 4, stream: s });
    }
  }

  updateFlow(dt, s) {
    const { terrain } = this.game.ctx;
    terrain.gradientAt(s.pos.x, s.pos.z, _g);

    // slope pulls water downhill
    s.vel.x += -_g.x * PHYS.slopeAccel * dt;
    s.vel.z += -_g.y * PHYS.slopeAccel * dt;

    // steering: lateral push along the heading's right vector (-hz, hx)
    const hx = s.heading.x;
    const hz = s.heading.y;
    s.vel.x += -hz * s.input.steer * PHYS.steerAccel * dt;
    s.vel.z += hx * s.input.steer * PHYS.steerAccel * dt;

    s.surging = s.input.surge && s.volume > 20000;
    if (s.surging) {
      s.vel.x += hx * PHYS.surgeAccel * dt;
      s.vel.z += hz * PHYS.surgeAccel * dt;
      s.addVolume(-s.volume * PHYS.surgeCostPerSec * dt);
    }

    // drag, speed limits (bigger rivers carry more momentum)
    const maxSpeed = 32 + 5 * Math.log10(Math.max(s.volume, 1e4) / 1e4);
    s.vel.y = 0;
    s.vel.multiplyScalar(1 - PHYS.drag * dt);
    let sp = s.vel.length();
    if (sp > maxSpeed * (s.surging ? 1.4 : 1)) s.vel.multiplyScalar((maxSpeed * (s.surging ? 1.4 : 1)) / sp);
    sp = s.vel.length();
    if (sp < PHYS.minSpeed) {
      if (sp < 0.01) s.vel.set(hx, 0, hz);
      s.vel.setLength(PHYS.minSpeed);
    }

    s.pos.x += s.vel.x * dt;
    s.pos.z += s.vel.z * dt;
    s.pos.y = Math.max(terrain.heightAt(s.pos.x, s.pos.z), terrain.seaLevel - 1);
    s.heading.set(s.vel.x, s.vel.z).normalize();

    // trail
    const t = s.trail;
    const last = (t.count - 1) * 4;
    if (t.count === 0 || Math.hypot(s.pos.x - t.data[last], s.pos.z - t.data[last + 2]) > PHYS.trailSpacing) {
      t.push(s.pos.x, s.pos.y, s.pos.z, s.radius);
    }
  }
}
