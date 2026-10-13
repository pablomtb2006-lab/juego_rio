import * as THREE from 'three';

/**
 * Unified input → { steer: -1..1, forward: -1..1, move: Vector2 (x = steer, y = forward), surge }.
 *
 *  Keyboard  A/D or ←/→ steer · W/↑ dive (drop) / surge (river) · S/↓ flare · Space/Shift surge · E/J leap
 *  Touch     one-thumb floating stick anywhere on screen: drag sideways to steer, drag up to
 *            dive / surge, down to flare. The anchor follows the thumb once you pass the edge,
 *            so reversing is instant. Double-tap-and-hold or a second finger also surges.
 *  Gamepad   left stick (steer / dive-flare), A or RT surge.
 *
 * `touch` is exposed for the UI to draw the floating stick: { active, anchorX, anchorY, x, y, surge }
 * (CSS pixels).
 */
const ABILITY_KEYS = [['KeyQ', 'wall'], ['KeyR', 'leech'], ['KeyF', 'fog']];

export class Input {
  constructor(ctx) {
    this.ctx = ctx;
    this.keys = new Set();
    this.steer = 0;
    this.forward = 0;
    this.move = new THREE.Vector2();
    this.surge = false;
    this.ability = null;
    this.abilityQueued = null;
    this._abilityDown = new Set();
    this.device = 'keyboard';
    this.touch = { active: false, id: null, anchorX: 0, anchorY: 0, x: 0, y: 0, surge: false, lastEnd: -1, fingers: 0 };
    this._kSteer = 0;
    this._kFwd = 0;
    if (typeof window === 'undefined' || !window.addEventListener) return;

    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      this.device = 'keyboard';
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.touch.active = false;
    });

    const range = () => Math.max(44, Math.min(window.innerWidth, window.innerHeight) * 0.16);
    const t = this.touch;
    const now = () => performance.now();
    window.addEventListener(
      'touchstart',
      (e) => {
        this.device = 'touch';
        t.fingers = e.touches.length;
        if (t.active) return;
        const p = e.changedTouches[0];
        t.active = true;
        t.id = p.identifier;
        t.anchorX = t.x = p.clientX;
        t.anchorY = t.y = p.clientY;
        t.surge = now() - t.lastEnd < 280; // double-tap & hold
      },
      { passive: true },
    );
    window.addEventListener(
      'touchmove',
      (e) => {
        t.fingers = e.touches.length;
        for (const p of e.changedTouches) {
          if (p.identifier !== t.id) continue;
          t.x = p.clientX;
          t.y = p.clientY;
          const R = range();
          // floating anchor: drag it along when the thumb goes past the rim
          const dx = t.x - t.anchorX;
          const dy = t.y - t.anchorY;
          if (Math.abs(dx) > R) t.anchorX = t.x - Math.sign(dx) * R;
          if (Math.abs(dy) > R) t.anchorY = t.y - Math.sign(dy) * R;
        }
      },
      { passive: true },
    );
    const end = (e) => {
      t.fingers = e.touches.length;
      for (const p of e.changedTouches) {
        if (p.identifier !== t.id) continue;
        t.active = false;
        t.id = null;
        t.surge = false;
        t.lastEnd = now();
      }
    };
    window.addEventListener('touchend', end, { passive: true });
    window.addEventListener('touchcancel', end, { passive: true });
  }

  update(dt = 1 / 60) {
    const k = this.keys;
    const kx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const ky = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    // keyboard is digital: ramp it so steering feels analog
    this._kSteer = approach(this._kSteer, kx, (kx === 0 ? 9 : Math.sign(kx) !== Math.sign(this._kSteer) ? 12 : 6) * dt);
    this._kFwd = approach(this._kFwd, ky, 8 * dt);
    let x = this._kSteer;
    let y = this._kFwd;
    let surge = k.has('Space') || k.has('ShiftLeft') || k.has('ShiftRight');

    const t = this.touch;
    if (t.active && typeof window !== 'undefined') {
      const R = Math.max(44, Math.min(window.innerWidth, window.innerHeight) * 0.16);
      x = shape(THREE.MathUtils.clamp((t.x - t.anchorX) / R, -1, 1));
      y = shape(THREE.MathUtils.clamp(-(t.y - t.anchorY) / R, -1, 1));
      surge = surge || t.surge || t.fingers > 1;
    }

    const pad = typeof navigator !== 'undefined' ? navigator.getGamepads?.()?.[0] : null;
    if (pad) {
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      if (Math.abs(ax) > 0.15 || Math.abs(ay) > 0.15) this.device = 'gamepad';
      if (Math.abs(ax) > 0.15) x = shape((ax - Math.sign(ax) * 0.15) / 0.85);
      if (Math.abs(ay) > 0.15) y = -shape((ay - Math.sign(ay) * 0.15) / 0.85);
      surge = surge || pad.buttons[0]?.pressed || (pad.buttons[7]?.value ?? 0) > 0.3;
      if (pad.buttons[1]?.pressed || pad.buttons[3]?.pressed) this.jumpQueued = true;
    }
    if (k.has('KeyE') || k.has('KeyJ')) this.jumpQueued = true;
    // abilities (game/Abilities.js): one key each, edge-triggered so holding it does not spam
    for (const [code, id] of ABILITY_KEYS) {
      const down = k.has(code);
      if (down && !this._abilityDown.has(code)) this.abilityQueued = id;
      if (down) this._abilityDown.add(code);
      else this._abilityDown.delete(code);
    }
    if (pad) {
      for (const [btn, id] of [[2, 'wall'], [4, 'leech'], [5, 'fog']]) {
        const down = !!pad.buttons[btn]?.pressed;
        const key = `pad${btn}`;
        if (down && !this._abilityDown.has(key)) this.abilityQueued = id;
        if (down) this._abilityDown.add(key);
        else this._abilityDown.delete(key);
      }
    }

    this.steer = x;
    this.forward = y;
    this.move.set(x, y);
    this.surge = !!surge;
    // jump is an edge-triggered action: consumed by the player controller
    this.jump = !!this.jumpQueued;
    this.jumpQueued = false;
    this.ability = this.abilityQueued;
    this.abilityQueued = null;
  }

  /** UI ability buttons / tests. */
  requestAbility(id) {
    this.abilityQueued = id;
  }

  /** UI jump button / tests. */
  requestJump() {
    this.jumpQueued = true;
  }
}

/** Soft response curve: precise near the centre, full lock at the edge. */
function shape(v) {
  return Math.sign(v) * Math.pow(Math.abs(v), 1.35);
}

function approach(v, target, step) {
  if (v < target) return Math.min(target, v + step);
  if (v > target) return Math.max(target, v - step);
  return v;
}
