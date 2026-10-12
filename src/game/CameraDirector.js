import * as THREE from 'three';

const _target = new THREE.Vector3();
const _look = new THREE.Vector3();

/**
 * All camera work. Modes:
 *   'menu'   slow cinematic orbit of the island
 *   'drop'   above/behind the falling drop, looking down at the island
 *   'chase'  third-person, low behind the river head (FOV widens with speed)
 *   'finish' high orbit over the finish point (victory / spectate)
 * Contract: director.mode, director.setMode(mode, opts), director.focus (Vector3,
 * used for shadow placement), director.shake(amount), update(dt).
 */
export class CameraDirector {
  constructor(game) {
    this.game = game;
    this.ctx = game.ctx;
    this.mode = 'menu';
    this.focus = new THREE.Vector3();
    this.lookAt = new THREE.Vector3();
    this.target = null;
    this.t = 0;
    this.shakeAmt = 0;
  }

  setMode(mode, opts = {}) {
    this.mode = mode;
    this.target = opts.target ?? this.target;
    this.t = 0;
    this.snap = opts.snap ?? true;
  }

  shake(amount) {
    this.shakeAmt = Math.max(this.shakeAmt, amount);
  }

  update(dt) {
    const cam = this.ctx.camera;
    const { terrain } = this.ctx;
    this.t += dt;
    const s = this.target;
    let fov = 60;
    let lerp = 1 - Math.exp(-dt * 5);

    if (this.mode === 'menu' || !s) {
      const a = this.ctx.time * 0.03;
      const r = terrain.size * 0.55;
      _target.set(Math.cos(a) * r, terrain.size * 0.22, Math.sin(a) * r);
      this.lookAt.set(0, 200, 0);
      lerp = 1;
    } else if (this.mode === 'drop') {
      _target.set(s.pos.x - s.heading.x * 70, s.pos.y + 90, s.pos.z - s.heading.y * 70);
      this.lookAt.set(s.pos.x + s.heading.x * 40, s.pos.y - 160, s.pos.z + s.heading.y * 40);
      fov = 70;
    } else if (this.mode === 'chase') {
      const r = s.radius;
      const back = 22 + r * 2.2;
      const up = 9 + r * 1.1;
      _target.set(s.pos.x - s.heading.x * back, 0, s.pos.z - s.heading.y * back);
      _target.y = Math.max(terrain.heightAt(_target.x, _target.z), s.pos.y) + up;
      _look.set(s.pos.x + s.heading.x * 30, s.pos.y + 2, s.pos.z + s.heading.y * 30);
      this.lookAt.copy(_look);
      fov = 62 + Math.min(s.speed / 50, 1) * 18;
    } else if (this.mode === 'finish') {
      const a = this.t * 0.15;
      _target.set(s.pos.x + Math.cos(a) * 260, 220, s.pos.z + Math.sin(a) * 260);
      this.lookAt.copy(s.pos);
      lerp = 1 - Math.exp(-dt * 2);
    }

    if (this.snap) {
      cam.position.copy(_target);
      this.snap = false;
    } else cam.position.lerp(_target, lerp);

    if (this.shakeAmt > 0.001) {
      cam.position.x += (Math.random() - 0.5) * this.shakeAmt;
      cam.position.y += (Math.random() - 0.5) * this.shakeAmt;
      this.shakeAmt *= Math.exp(-dt * 6);
    }

    cam.lookAt(this.lookAt);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov += (fov - cam.fov) * (1 - Math.exp(-dt * 3));
      cam.updateProjectionMatrix();
    }
    this.focus.copy(s && this.mode !== 'menu' ? s.pos : this.lookAt);
    this.ctx.postfx?.setSpeed(this.mode === 'chase' && s ? Math.min(s.speed / 45, 1) : 0);
  }
}
