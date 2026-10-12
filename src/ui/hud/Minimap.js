import { h, esc, hex, fmtCompact, clamp } from '../util.js';
import { t } from '../i18n.js';
import { icon } from '../icons.js';

/** North-up local minimap around the player, with a "sea this way" marker. Click/tap → full map. */
export class Minimap {
  constructor(ui, painter) {
    this.ui = ui;
    this.painter = painter;
    this.el = h(`<button class="minimap" type="button" data-i18n-aria="hud.map">
      <canvas></canvas>
      <span class="minimap__n">N</span>
      <span class="minimap__key">M</span>
    </button>`);
    this.canvas = this.el.querySelector('canvas');
    this.g = this.canvas.getContext('2d');
    this.el.addEventListener('click', () => ui.showMap(true));
    this.acc = 1;
    this.seaAngle = null;
    this.seaAcc = 1;
  }

  resize() {
    const r = this.el.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const s = Math.max(64, Math.round((r.width || 150) * dpr));
    if (this.canvas.width !== s) this.canvas.width = this.canvas.height = s;
  }

  update(dt) {
    this.acc += dt;
    this.seaAcc += dt;
    if (this.acc < 1 / 15) return;
    this.acc = 0;
    const { game, terrain } = this.ui.ctx;
    const p = game.player;
    if (!p || !this.painter.base) return;
    if (this.canvas.width < 64) this.resize();
    const g = this.g;
    const W = this.canvas.width;
    const N = this.painter.N;
    const meters = p.phase === 'drop' ? 5600 : 3000;
    const scale = W / ((meters / terrain.size) * N);
    const [cx, cy] = this.painter.toMap(p.pos.x, p.pos.z);

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, W);
    g.fillStyle = '#0a5c8f';
    g.fillRect(0, 0, W, W);
    g.save();
    g.translate(W / 2, W / 2);
    g.scale(scale, scale);
    g.translate(-cx, -cy);
    g.imageSmoothingEnabled = true;
    g.drawImage(this.painter.base, 0, 0);
    this.painter.drawOverlay(g, { scale: scale / (W / 150), puddles: true, headR: 3.4, maxPoints: 260, playerScale: 1.05 });
    g.restore();

    // sea direction marker on the rim
    if (this.seaAcc > 0.5 || this.seaAngle == null) {
      this.seaAcc = 0;
      const a = seaDirection(terrain, p.pos.x, p.pos.z);
      if (a != null) this.seaAngle = this.seaAngle == null ? a : lerpAngle(this.seaAngle, a, 0.5);
    }
    if (this.seaAngle != null && p.distToSea !== 0) {
      const r = W * 0.41;
      const x = W / 2 + Math.cos(this.seaAngle) * r;
      const y = W / 2 + Math.sin(this.seaAngle) * r;
      const s = W / 150;
      g.beginPath();
      g.arc(x, y, 9 * s, 0, Math.PI * 2);
      g.fillStyle = '#1fb6e8';
      g.fill();
      g.lineWidth = 2 * s;
      g.strokeStyle = '#fff';
      g.stroke();
      g.beginPath();
      g.lineWidth = 1.8 * s;
      for (const dy of [-2.2, 2.2]) {
        g.moveTo(x - 5 * s, y + dy * s);
        g.quadraticCurveTo(x - 2.5 * s, y + (dy - 2.4) * s, x, y + dy * s);
        g.quadraticCurveTo(x + 2.5 * s, y + (dy + 2.4) * s, x + 5 * s, y + dy * s);
      }
      g.stroke();
    }
  }
}

function seaDirection(terrain, x, z) {
  let best = Infinity;
  let ang = null;
  const here = terrain.distToSea(x, z);
  if (!(here > 0)) return null;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const d = terrain.distToSea(x + Math.cos(a) * 260, z + Math.sin(a) * 260);
    if (d < best) {
      best = d;
      ang = a;
    }
  }
  return ang;
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** Full-screen island map (reference: every stream's coloured route over the whole island). */
export class FullMap {
  constructor(ui, painter) {
    this.ui = ui;
    this.painter = painter;
    this.open = false;
    this.el = h(`<div class="fullmap" aria-hidden="true">
      <div class="fullmap__panel panel">
        <div class="fullmap__head">
          <div class="fullmap__title">${icon('map')}<span data-i18n="map.title"></span></div>
          <div class="fullmap__alive" data-ref="alive"></div>
          <button class="iconbtn fullmap__close" type="button" data-ref="close" data-i18n-aria="common.close">${icon('close')}</button>
        </div>
        <div class="fullmap__body">
          <div class="fullmap__map" data-ref="mapbox">
            <div class="fullmap__frame"><canvas data-ref="canvas"></canvas>
              <div class="fullmap__compass">${icon('compass')}<span>N</span></div>
            </div>
          </div>
          <div class="fullmap__legend" data-ref="legend"></div>
        </div>
      </div>
    </div>`);
    this.r = {};
    this.el.querySelectorAll('[data-ref]').forEach((e) => (this.r[e.dataset.ref] = e));
    this.g = this.r.canvas.getContext('2d');
    this.r.close.addEventListener('click', () => ui.showMap(false));
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) ui.showMap(false);
    });
    this.acc = 1;
    this.legendAcc = 1;
    this.pulse = 0;
  }

  setOpen(open) {
    this.open = open;
    this.el.classList.toggle('is-open', open);
    this.el.setAttribute('aria-hidden', String(!open));
    if (open) {
      this.acc = 1;
      this.legendAcc = 1;
      this.layout();
      this.update(0, true);
    }
  }

  layout() {
    const box = this.r.mapbox.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const s = Math.max(120, Math.floor(Math.min(box.width, box.height) * dpr));
    if (this.r.canvas.width !== s) this.r.canvas.width = this.r.canvas.height = s;
    this.r.canvas.style.width = this.r.canvas.style.height = `${Math.floor(s / dpr)}px`;
  }

  update(dt, force = false) {
    if (!this.open) return;
    this.acc += dt;
    this.legendAcc += dt;
    this.pulse = (this.pulse + dt * 0.8) % 1;
    if (!force && this.acc < 1 / 12) return;
    this.acc = 0;
    const { game } = this.ui.ctx;
    const g = this.g;
    const W = this.r.canvas.width;
    const N = this.painter.N;
    if (!this.painter.base) return;
    const scale = W / N;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, W);
    g.save();
    g.scale(scale, scale);
    g.drawImage(this.painter.base, 0, 0);
    this.painter.drawOverlay(g, {
      scale: scale / (W / 640),
      puddles: false,
      labels: true,
      headR: 4.5,
      maxPoints: 600,
      lineScale: 1.15,
      playerScale: 1.5,
      pulse: this.pulse,
    });
    g.restore();

    if (this.legendAcc > 0.3 || force) {
      this.legendAcc = 0;
      this.r.alive.innerHTML = `${icon('streams')}<b>${game.aliveCount}</b> <span>${t('hud.alive')}</span>`;
      const rows = rank(game.streams, this.ui.ctx.terrain)
        .map((s, i) => {
          const status =
            s.phase === 'finished'
              ? `<em class="st st--sea">${t('map.atSea', { p: s.place })}</em>`
              : s.phase === 'eliminated'
                ? `<em class="st st--out">${t('map.out')}</em>`
                : `<em class="st">${fmtCompact(s.volume)} L</em>`;
          const name = s.isPlayer ? t('hud.you') : esc(s.name);
          return `<li class="lg${s.isPlayer ? ' is-me' : ''}${s.phase === 'eliminated' ? ' is-out' : ''}"><span class="lg__n">${i + 1}</span><i style="--c:${s.isPlayer ? '#ffffff' : hex(s.color)}"></i><span class="lg__name">${name}</span>${status}</li>`;
        })
        .join('');
      this.r.legend.innerHTML = `<div class="fullmap__lt">${t('map.streams')}</div><ol>${rows}</ol>`;
    }
  }
}

/** Live ranking: finishers by place, then alive by distance to the sea, then eliminated by place. */
export function rank(streams, terrain) {
  const d = new Map();
  for (const s of streams) {
    if (!s.alive) continue;
    d.set(s, Number.isFinite(s.distToSea) ? s.distToSea : terrain ? terrain.distToSea(s.pos.x, s.pos.z) : 1e9 + clamp(s.pos.y, 0, 1e6));
  }
  const fin = streams.filter((s) => s.phase === 'finished').sort((a, b) => a.place - b.place);
  const alive = streams.filter((s) => s.alive).sort((a, b) => d.get(a) - d.get(b));
  const out = streams.filter((s) => s.phase === 'eliminated').sort((a, b) => a.place - b.place);
  return [...fin, ...alive, ...out];
}
