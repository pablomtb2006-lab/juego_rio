import * as THREE from 'three';

/**
 * Unified input → { steer: -1..1, move: Vector2 (drop steering, x=right, y=forward), surge }.
 * Keyboard (A/D, ←/→, W/S, ↑/↓, Space/Shift), touch (hold left/right half; swipe up = surge)
 * and gamepad (left stick, A / RT).
 */
export class Input {
  constructor() {
    this.keys = new Set();
    this.touch = { active: false, x: 0, y: 0, startY: 0 };
    this.steer = 0;
    this.move = new THREE.Vector2();
    this.surge = false;

    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    const onTouch = (e) => {
      const t = e.touches[0];
      if (!t) {
        this.touch.active = false;
        return;
      }
      if (!this.touch.active) this.touch.startY = t.clientY;
      this.touch.active = true;
      this.touch.x = (t.clientX / window.innerWidth) * 2 - 1;
      this.touch.y = (t.clientY / window.innerHeight) * 2 - 1;
      this.touch.swipeUp = this.touch.startY - t.clientY > 80;
    };
    window.addEventListener('touchstart', onTouch, { passive: true });
    window.addEventListener('touchmove', onTouch, { passive: true });
    window.addEventListener('touchend', onTouch, { passive: true });
  }

  update() {
    const k = this.keys;
    let x = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let y = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    let surge = k.has('Space') || k.has('ShiftLeft');

    if (this.touch.active) {
      x = THREE.MathUtils.clamp(this.touch.x * 1.6, -1, 1);
      y = THREE.MathUtils.clamp(-this.touch.y * 1.6, -1, 1);
      surge = surge || this.touch.swipeUp;
    }

    const pad = navigator.getGamepads?.()[0];
    if (pad) {
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      if (Math.abs(ax) > 0.15) x = ax;
      if (Math.abs(ay) > 0.15) y = -ay;
      surge = surge || pad.buttons[0]?.pressed || pad.buttons[7]?.pressed;
    }

    this.steer = x;
    this.move.set(x, y);
    this.surge = !!surge;
  }
}
