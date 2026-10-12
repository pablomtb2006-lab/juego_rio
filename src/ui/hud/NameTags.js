import * as THREE from 'three';
import { h, esc, hex, clamp } from '../util.js';

const _p = new THREE.Vector3();
const _a = new THREE.Vector3();

/**
 * Floating rival name tags (reference: small white labels with a leader line over each stream).
 * Uses game.getNameTags() when the gameplay module provides it — items may be streams or
 * { stream, position|pos|anchor, visible?, occluded? } — otherwise projects stream heads itself
 * and ray-marches the heightfield to hide tags behind mountains.
 */
export class NameTags {
  constructor(ui) {
    this.ui = ui;
    this.el = h('<div class="tags" aria-hidden="true"></div>');
    this.views = new Map();
    this.frame = 0;
  }

  view(stream) {
    let v = this.views.get(stream.id);
    if (!v || v.stream !== stream) {
      v?.el.remove();
      const el = h(`<div class="tag"><div class="tag__label"><i class="tag__dot"></i><span class="tag__name"></span><b class="tag__rel"></b></div><div class="tag__pin"></div></div>`);
      el.style.setProperty('--c', hex(stream.color));
      el.querySelector('.tag__name').innerHTML = esc(stream.name);
      this.el.appendChild(el);
      v = { stream, el, rel: el.querySelector('.tag__rel'), relState: '', alpha: 0, occluded: false, shown: false };
      this.views.set(stream.id, v);
    }
    return v;
  }

  clear() {
    for (const v of this.views.values()) v.el.remove();
    this.views.clear();
  }

  collect(game) {
    if (typeof game.getNameTags === 'function') {
      try {
        const items = game.getNameTags();
        if (Array.isArray(items)) {
          return items
            .map((it) => {
              const stream = it?.stream ?? (it?.pos && it?.name ? it : null);
              if (!stream) return null;
              const pos = it.position ?? it.anchor ?? (it !== stream ? it.pos : null);
              return { stream, pos, visible: it.visible, occluded: it.occluded };
            })
            .filter(Boolean);
        }
      } catch {
        /* fall back to our own */
      }
    }
    return game.streams.filter((s) => !s.isPlayer).map((stream) => ({ stream }));
  }

  update(dt, enabled) {
    const { game, camera, terrain } = this.ui.ctx;
    const live = new Set();
    this.frame++;
    if (enabled && game.player && game.streams.length) {
      camera.updateMatrixWorld();
      const W = this.ui.w;
      const H = this.ui.h;
      const player = game.player;
      const dropView = player.phase === 'drop' || game.state === 'drop';
      const maxDist = dropView ? 7000 : 2400;
      for (const item of this.collect(game)) {
        const s = item.stream;
        if (s.isPlayer || !s.alive || item.visible === false) continue;
        live.add(s.id);
        const v = this.view(s);
        if (item.pos) _a.set(item.pos.x, item.pos.y, item.pos.z);
        else _a.set(s.pos.x, s.pos.y + (s.phase === 'drop' ? s.radius * 1.6 + 4 : s.radius * 0.8 + 6), s.pos.z);
        const dist = camera.position.distanceTo(_a);
        _p.copy(_a).project(camera);
        const onScreen = _p.z < 1 && _p.x > -1.05 && _p.x < 1.05 && _p.y > -1.05 && _p.y < 1.15;
        // occlusion is pricey-ish: refresh each tag every 3rd frame
        if (item.occluded != null) v.occluded = !!item.occluded;
        else if (onScreen && (this.frame + s.id) % 3 === 0) v.occluded = occluded(terrain, camera.position, _a);
        const want = onScreen && !v.occluded && dist < maxDist ? 1 - clamp((dist - maxDist * 0.75) / (maxDist * 0.25), 0, 1) : 0;
        v.alpha += (want - v.alpha) * (1 - Math.exp(-dt * 12));
        if (v.alpha < 0.02) {
          if (v.shown) {
            v.el.style.opacity = '0';
            v.shown = false;
          }
          continue;
        }
        v.shown = true;
        const x = (_p.x * 0.5 + 0.5) * W;
        const y = (-_p.y * 0.5 + 0.5) * H;
        const sc = clamp(1.12 - (dist / maxDist) * 0.45, 0.72, 1.12);
        v.el.style.opacity = v.alpha.toFixed(2);
        v.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${sc.toFixed(3)})`;
        // size relation to the player: bigger = danger, smaller = prey (only on the ground)
        let rel = '';
        if (s.phase === 'flow' && player.phase === 'flow') rel = s.volume > player.volume * 1.03 ? 'big' : 'small';
        if (rel !== v.relState) {
          v.relState = rel;
          v.el.dataset.rel = rel;
          v.rel.textContent = rel === 'big' ? '▲' : rel === 'small' ? '▼' : '';
        }
      }
    }
    for (const [id, v] of this.views) {
      if (!live.has(id) && v.shown) {
        v.el.style.opacity = '0';
        v.shown = false;
        v.alpha = 0;
      }
    }
  }
}

/**
 * March the camera→target segment against the heightfield. Ignores the stretch next to the camera
 * (a chase camera may clip into slopes) and needs two consecutive hits, so tags only hide behind
 * real ridges.
 */
function occluded(terrain, from, to) {
  if (terrain.heightAt(from.x, from.z) > from.y) return false; // camera underground: can't judge
  const steps = 16;
  let hits = 0;
  for (let i = 3; i < steps - 1; i++) {
    const t = i / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    const z = from.z + (to.z - from.z) * t;
    if (terrain.heightAt(x, z) > y + 4) {
      if (++hits >= 2) return true;
    } else hits = 0;
  }
  return false;
}
