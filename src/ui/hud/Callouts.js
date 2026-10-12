import * as THREE from 'three';
import { h, markup, clamp, easeOutBack, easeOutCubic } from '../util.js';

const IN = 0.32;
const OUT = 0.38;
const STAGGER = 0.16;
const _v = new THREE.Vector3();
const JITTER = [0, -26, 22, -12, 30, -34, 12];

/**
 * Big centred callouts (trailer style: heavy white caps, `*keyword*` in yellow) and floating
 * "+120,000 L" numbers. Everything is animated from ui.update(dt), so it freezes with the game
 * and is deterministic in ?capture=1 screenshots.
 */
export class Callouts {
  constructor(ui) {
    this.ui = ui;
    this.el = h('<div class="callout" aria-live="polite"></div>');
    this.cur = null;
    this.queue = [];
    this.floats = [];
    this.floatLayer = h('<div class="floats"></div>');
    this.pool = [];
  }

  /**
   * text: '*YELLOW*\nwhite' markup. opts: { priority=1, hold=2.2, delay=0, kind='' (style variant), stagger }
   */
  show(text, opts = {}) {
    const item = {
      text,
      priority: opts.priority ?? 1,
      hold: opts.hold ?? 2.2,
      delay: opts.delay ?? 0,
      stagger: opts.stagger ?? STAGGER,
      kind: opts.kind ?? '',
      age: 0,
      queuedAt: this.ui.time,
    };
    if (!this.cur || item.priority >= this.cur.priority || this.cur.age > this.cur.hold) this.start(item);
    else if (this.queue.length < 3) this.queue.push(item);
  }

  start(item) {
    this.cur = item;
    this.el.className = `callout ${item.kind ? `callout--${item.kind}` : ''}`;
    const lines = markup(item.text).split('<br>');
    this.el.innerHTML = lines.map((l) => `<div class="callout__line">${l}</div>`).join('');
    item.lines = [...this.el.children];
    this.apply();
  }

  clear() {
    this.cur = null;
    this.queue.length = 0;
    this.el.innerHTML = '';
    for (const f of this.floats) f.el.style.opacity = '0';
  }

  apply() {
    const it = this.cur;
    if (!it) return;
    const total = it.delay + it.hold;
    it.lines.forEach((line, i) => {
      const a = it.age - it.delay - i * it.stagger;
      let o = 0;
      let s = 1;
      let y = 0;
      if (a > 0) {
        if (a < IN) {
          const k = a / IN;
          o = clamp(k * 2, 0, 1);
          s = 1.6 - 0.6 * easeOutBack(k);
        } else o = 1;
      }
      const out = it.age - total;
      if (out > 0) {
        const k = clamp(out / OUT, 0, 1);
        o *= 1 - easeOutCubic(k);
        y = -14 * k;
        s *= 1 - 0.04 * k;
      }
      line.style.opacity = o.toFixed(3);
      line.style.transform = `translate3d(0, ${y.toFixed(1)}px, 0) scale(${s.toFixed(3)})`;
    });
  }

  // --- floating numbers -------------------------------------------------------------

  /** world: THREE.Vector3-like anchor (re-projected every frame) or null to use screen {x, y}. */
  float(text, { world = null, x = 0.5, y = 0.62, kind = 'gain', big = false } = {}) {
    let f = this.pool.pop();
    if (!f) {
      f = { el: h('<div class="float"></div>') };
      this.floatLayer.appendChild(f.el);
    }
    f.el.className = `float float--${kind}${big ? ' float--big' : ''}`;
    f.el.textContent = text;
    f.age = 0;
    f.life = big ? 1.9 : 1.45;
    f.world = world ? { x: world.x, y: world.y, z: world.z } : null;
    f.sx = x;
    f.sy = y;
    this.n = ((this.n ?? 0) + 1) % JITTER.length;
    f.jx = JITTER[this.n];
    // numbers spawned together stack downwards instead of overlapping
    const now = this.ui.time;
    this.stack = now - (this.lastFloat ?? -9) < 0.45 ? ((this.stack ?? 0) + 1) % 4 : 0;
    this.lastFloat = now;
    f.oy = this.stack * 40;
    if (this.stack) f.jx = 0;
    this.floats.push(f);
    // keep the stack readable
    if (this.floats.length > 7) this.floats[0].age = Math.max(this.floats[0].age, this.floats[0].life - 0.2);
  }

  update(dt) {
    const it = this.cur;
    if (it) {
      it.age += dt;
      this.apply();
      if (it.age > it.delay + it.hold + OUT) {
        this.cur = null;
        this.el.innerHTML = '';
        // drop stale queued items
        while (this.queue.length && this.ui.time - this.queue[0].queuedAt > 5) this.queue.shift();
        if (this.queue.length) this.start(this.queue.shift());
      }
    }

    if (!this.floats.length) return;
    const { camera } = this.ui.ctx;
    const W = this.ui.w;
    const H = this.ui.h;
    camera.updateMatrixWorld();
    for (let i = this.floats.length - 1; i >= 0; i--) {
      const f = this.floats[i];
      f.age += dt;
      if (f.age >= f.life) {
        f.el.style.opacity = '0';
        this.floats.splice(i, 1);
        this.pool.push(f);
        continue;
      }
      let px = f.sx * W;
      let py = f.sy * H;
      if (f.world) {
        _v.set(f.world.x, f.world.y, f.world.z).project(camera);
        if (_v.z < 1 && Math.abs(_v.x) < 1 && Math.abs(_v.y) < 1) {
          px = (_v.x * 0.5 + 0.5) * W;
          py = (-_v.y * 0.5 + 0.5) * H;
        }
        px = clamp(px, W * 0.18, W * 0.82);
        py = clamp(py, H * 0.25, H * 0.8);
      }
      const k = f.age / f.life;
      const rise = easeOutCubic(Math.min(1, f.age / 1.1)) * 70;
      const pop = f.age < 0.16 ? 1.5 - 0.5 * easeOutBack(f.age / 0.16) : 1;
      const o = f.age < 0.06 ? f.age / 0.06 : k > 0.72 ? 1 - (k - 0.72) / 0.28 : 1;
      f.el.style.opacity = o.toFixed(3);
      f.el.style.transform = `translate3d(${(px + f.jx).toFixed(1)}px, ${(py - rise + f.oy).toFixed(1)}px, 0) translate(-50%, -50%) scale(${pop.toFixed(3)})`;
    }
  }
}
