import { h, refs, esc, hex, fmtInt, fmtFixed, clamp } from '../util.js';
import { t } from '../i18n.js';
import { icon, dropIcon } from '../icons.js';
import { rank } from './Minimap.js';
import { HAZARD_TYPES } from '../../game/Hazards.js';
import { CATASTROPHES } from '../../game/Catastrophe.js';

const HAZARD_ICON = {
  lava: '🌋', geyser: '💨', sand: '🏜️', sinkhole: '🕳️', sun: '☀️', ice: '🧊', rocks: '🪨', steam: '♨️',
};

const SURGE_MIN = 20000; // StreamPhysics: surge needs volume > 20,000 L
const LOW_WATER = 15000; // Rules: a stream dries up below 5,000 L

/** Stop touch events reaching the gameplay Input (which listens on window). */
export function shield(el) {
  for (const ev of ['touchstart', 'touchmove', 'touchend']) el.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
}

export class Hud {
  constructor(ui) {
    this.ui = ui;
    this.el = h(`<div class="hud">
      <button class="iconbtn hud-pause" type="button" data-ref="pause" data-i18n-aria="ctl.pause">${icon('pause')}</button>
      <div class="hud-top">
        <div class="hud-dist"><b data-ref="dist">0.00</b><span data-i18n="hud.kmToSea"></span></div>
        <div class="hud-vol" data-ref="volRow">${dropIcon()}<b data-ref="vol">0</b><span>L</span></div>
      </div>
      <div class="hud-side" data-ref="side">
        <div class="hud-chips">
          <div class="chip" data-ref="aliveChip">${icon('streams')}<b data-ref="alive">16</b><small data-i18n="hud.alive"></small></div>
          <div class="chip chip--place" data-ref="placeChip"><b data-ref="place">#1</b><small data-i18n="hud.place"></small></div>
        </div>
        <div class="goals" data-ref="goals"></div>
      </div>
      <div class="cat" data-ref="cat">
        <i class="cat__ic" data-ref="catIc"></i>
        <div class="cat__txt"><b data-ref="catName"></b><small data-ref="catSub"></small></div>
        <div class="cat__bar"><i data-ref="catFill"></i></div>
      </div>
      <div class="danger" data-ref="danger">
        <i class="danger__ic" data-ref="dangerIc">⚠️</i>
        <b data-ref="dangerName"></b>
        <small data-ref="dangerDist"></small>
        <i class="danger__arrow" data-ref="dangerArrow">▲</i>
      </div>
      <div class="fork" data-ref="fork">
        <div class="fork__side fork__side--l" data-ref="forkL"><i>◀</i><b></b><small></small></div>
        <div class="fork__side fork__side--r" data-ref="forkR"><i>▶</i><b></b><small></small></div>
      </div>
      <div class="drought" data-ref="drought">
        <div class="drought__bar"><i data-ref="droughtFill"></i></div>
        <div class="drought__row"><b data-ref="droughtTime">0</b><span data-ref="droughtWho"></span></div>
      </div>
      <div class="feed" data-ref="feed"></div>
      <div class="alt" data-ref="alt">
        <small data-i18n="hud.altitude"></small>
        <div class="alt__bar"><i data-ref="altFill"></i><b data-ref="altMark">${icon('drop')}</b></div>
        <div class="alt__val"><b data-ref="altVal">0</b><small>m</small></div>
      </div>
      <div class="hint" data-ref="hint"></div>
      <div class="steer-zones" data-ref="steer"><span>${icon('back')}</span><span>${icon('chevronRight')}</span></div>
      <button class="leap" type="button" data-ref="leap" data-sfx="none">
        <i class="leap__cd" data-ref="leapCd"></i>
        <b>🐬</b><span data-ref="leapLbl"></span><kbd>E</kbd>
      </button>
      <button class="surge" type="button" data-ref="surge">
        <svg class="surge__ring" viewBox="0 0 100 100"><circle cx="50" cy="50" r="46"/></svg>
        ${icon('bolt')}<span data-i18n="hud.surge"></span>
      </button>
    </div>`);
    this.r = refs(this.el);
    this.r.pause.addEventListener('click', () => ui.pause(true));
    shield(this.r.pause);
    this.setupSurge();
    shield(this.r.leap);
    this.r.leap.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      ui.ctx.game?.input?.requestJump();
    });

    this.dispVol = 0;
    this.lastVol = 0;
    this.flash = 0;
    this.flashKind = '';
    this.rankAcc = 1;
    this.lastAlive = -1;
    this.feedItems = [];
    this.hintText = '';
    this.hintAge = 99;
    this.hintLife = 0;
    this.steerAge = 99;
    this.cache = {};
  }

  setupSurge() {
    const b = this.r.surge;
    shield(b);
    let held = false;
    const set = (on) => {
      if (held === on) return;
      held = on;
      b.classList.toggle('is-held', on);
      window.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code: 'Space', key: ' ' }));
    };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      b.setPointerCapture?.(e.pointerId);
      set(true);
    });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, () => set(false));
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    this.releaseSurge = () => set(false);
  }

  /** Text helper that skips identical DOM writes. */
  set(key, el, text) {
    if (this.cache[key] === text) return;
    this.cache[key] = text;
    el.textContent = text;
  }

  reset() {
    this.dispVol = this.ui.ctx.game.player?.volume ?? 0;
    this.lastVol = this.dispVol;
    this.feedItems.forEach((f) => f.el.remove());
    this.feedItems = [];
    this.lastAlive = -1;
    this.cache = {};
    this.hint('', 0);
    this.releaseSurge?.();
  }

  hint(html, life = 7) {
    this.hintText = html;
    this.hintAge = 0;
    this.hintLife = life;
    this.r.hint.innerHTML = html;
  }

  showSteerZones() {
    this.steerAge = 0;
  }

  /** Kill feed: a, b are streams (b may be null), verb is an i18n key, ic an icon name. */
  feed(a, verbKey, b, ic) {
    const player = this.ui.ctx.game.player;
    const who = (s) =>
      s ? `<span class="kf__who${s === player ? ' is-me' : ''}" style="--c:${s === player ? '#FFD23F' : hex(s.color)}">${s === player ? t('hud.you') : esc(s.name)}</span>` : '';
    const me = a === player || b === player;
    const el = h(`<div class="kf${me ? ' kf--me' : ''}"><span class="kf__ic">${icon(ic)}</span>${who(a)}<span class="kf__verb">${esc(t(verbKey))}</span>${who(b)}</div>`);
    this.r.feed.prepend(el);
    this.feedItems.unshift({ el, age: 0 });
    while (this.feedItems.length > 5) this.feedItems.pop().el.remove();
    requestAnimationFrame(() => el.classList.add('is-in'));
    if (this.ui.ctx.params.capture) el.classList.add('is-in');
  }

  /**
   * LA CATÁSTROFE (game/Catastrophe.js): the countdown while it is announced, then a bar
   * that empties while it runs. This banner IS the feature — an unannounced modifier is just
   * bad luck, an announced one is a decision.
   */
  renderCatastrophe() {
    const c = this.ui.ctx.game.catastrophe;
    const r = this.r;
    const on = !!c && (c.phase === 'warn' || c.phase === 'active');
    r.cat.classList.toggle('is-on', on);
    if (!on) {
      this._catKey = null;
      return;
    }
    const warn = c.phase === 'warn';
    r.cat.classList.toggle('is-warn', warn);
    const total = warn ? c.def.warn : c.def.duration;
    r.catFill.style.width = `${Math.max(0, Math.min(100, (c.timeLeft / Math.max(total, 1)) * 100))}%`;
    const key = `${c.kind}:${warn}:${Math.ceil(c.timeLeft)}`;
    if (key === this._catKey) return;
    this._catKey = key;
    r.cat.style.setProperty('--c', hex(CATASTROPHES[c.kind].color));
    r.catIc.textContent = CATASTROPHES[c.kind].icon;
    r.catName.textContent = t(`cat.${c.kind}`);
    r.catSub.textContent = warn
      ? t('cat.in', { d: Math.max(0, Math.ceil(c.timeLeft)) })
      : t('cat.left', { d: Math.max(0, Math.ceil(c.timeLeft)) });
  }

  /**
   * PELIGRO ADELANTE — the nearest hazard on your line, named and measured while you can
   * still do something about it. The arrow says which way to lean to miss it.
   */
  renderDanger() {
    const game = this.ui.ctx.game;
    const p = game.player;
    const blind = game.catastrophe?.active && game.catastrophe.def.hideWarnings;
    const hz = p?.phase === 'flow' && game.state === 'stream' && !blind ? game.hazards?.ahead(p, 320) : null;
    const r = this.r;
    r.danger.classList.toggle('is-on', !!hz);
    if (!hz) {
      this._dangerKey = null;
      return;
    }
    const d = Math.hypot(hz.x - p.pos.x, hz.z - p.pos.z);
    r.danger.classList.toggle('is-close', d < 120);
    const key = `${hz.id}:${Math.round(d / 10)}`;
    if (key === this._dangerKey) return;
    this._dangerKey = key;
    const T = HAZARD_TYPES[hz.kind];
    r.danger.style.setProperty('--c', hex(T.color));
    r.dangerIc.textContent = HAZARD_ICON[hz.kind] ?? '⚠️';
    r.dangerName.textContent = t(`hzn.${hz.kind}`);
    r.dangerDist.textContent = `${Math.round(d)} m`;
    // sign of the cross product: positive → the hazard is to your right, so lean left
    const side = (hz.x - p.pos.x) * p.heading.y - (hz.z - p.pos.z) * p.heading.x;
    r.dangerArrow.textContent = side > 0 ? '◀' : '▶';
    r.dangerArrow.style.setProperty('--a', '0deg');
  }

  /** The fork prompt (game/Forks.js): which way out is which, shown on the side it is on. */
  renderFork() {
    const game = this.ui.ctx.game;
    const p = game.player;
    const near = p?.phase === 'flow' ? game.forks?.nearest(p, 420) : null;
    this.r.fork.classList.toggle('is-on', !!near);
    if (!near) {
      this._forkKey = null;
      return;
    }
    const [a, b] = near.fork.branches;
    // the branch that leans to the player's right goes on the right
    const side = (br) => br.dir.x * p.heading.y - br.dir.y * p.heading.x;
    const [left, right] = side(a) < side(b) ? [a, b] : [b, a];
    const key = `${near.fork.id}:${left.label}`;
    if (key !== this._forkKey) {
      this._forkKey = key;
      for (const [el, br] of [[this.r.forkL, left], [this.r.forkR, right]]) {
        el.style.setProperty('--c', `#${br.color.toString(16).padStart(6, '0')}`);
        el.querySelector('b').textContent = t(`fork.${br.label}`);
        el.querySelector('small').textContent = `${(br.length / 1000).toFixed(1)} km`;
      }
    }
  }

  /** The drought countdown (game/Drought.js): who gets swept next, and in how long. */
  renderDrought() {
    const d = this.ui.ctx.game.drought;
    const r = this.r;
    const on = !!d?.active;
    r.drought.classList.toggle('is-on', on);
    if (!on) return;
    const left = Math.max(0, d.timeLeft);
    const me = d.playerAtRisk;
    r.drought.classList.toggle('is-me', me);
    r.drought.classList.toggle('is-soon', left < 5);
    const secs = left < 10 ? left.toFixed(1) : String(Math.ceil(left));
    if (r.droughtTime.textContent !== secs) r.droughtTime.textContent = secs;
    const who = me ? t('hud.droughtYou') : d.victim ? d.victim.name : '';
    if (r.droughtWho.textContent !== who) r.droughtWho.textContent = who;
    r.droughtFill.style.width = `${Math.min(100, (left / Math.max(d.interval, 1)) * 100)}%`;
  }

  /** Match objectives (game/Objectives.js): rebuilt only when something changes. */
  renderGoals() {
    const list = this.ui.ctx.game.objectives?.list ?? [];
    const key = list.map((o) => `${o.id}${o.done ? 1 : 0}${Math.round((o.progress / o.target) * 20)}`).join('|');
    if (key === this._goalKey) return;
    this._goalKey = key;
    this.r.goals.innerHTML = list
      .map((o) => {
        const pct = Math.round(Math.min(1, o.progress / o.target) * 100);
        const n = o.counter && o.on !== 'volume' ? `<em>${Math.floor(o.progress)}/${o.target}</em>` : '';
        return `<div class="goal${o.done ? ' is-done' : ''}"><i>${o.done ? '✓' : o.icon}</i><span>${o.text}${n}</span><u style="--p:${pct}%"></u></div>`;
      })
      .join('');
  }

  update(dt, heavy) {
    const ui = this.ui;
    const { game, terrain } = ui.ctx;
    const p = game.player;
    if (!p) return;
    const r = this.r;

    this.renderGoals();
    this.renderDrought();
    this.renderFork();
    this.renderDanger();
    this.renderCatastrophe();

    // --- distance & litres (top centre, like the trailer) ---
    let dist = p.phase === 'drop' ? terrain.distToSea(p.pos.x, p.pos.z) : p.distToSea;
    if (!Number.isFinite(dist)) dist = terrain.distToSea(p.pos.x, p.pos.z);
    if (p.phase === 'finished') dist = 0;
    this.set('dist', r.dist, fmtFixed(Math.max(0, dist) / 1000, 2));

    const vol = p.volume;
    const dv = vol - this.lastVol;
    if (dv > Math.max(800, this.lastVol * 0.004)) this.pulse('gain');
    else if (dv < -this.lastVol * 0.03) this.pulse('loss');
    this.lastVol = vol;
    const k = 1 - Math.exp(-dt * 7);
    this.dispVol += (vol - this.dispVol) * k;
    if (Math.abs(vol - this.dispVol) < 2) this.dispVol = vol;
    this.set('vol', r.vol, fmtInt(this.dispVol));
    this.flash = Math.max(0, this.flash - dt);
    const low = p.phase === 'flow' && vol < LOW_WATER;
    const cls = `hud-vol${this.flash > 0 ? ` is-${this.flashKind}` : ''}${low ? ' is-low' : ''}`;
    if (this.cache.volCls !== cls) {
      this.cache.volCls = cls;
      r.volRow.className = cls;
    }

    // --- alive & live placement ---
    const alive = game.aliveCount;
    if (alive !== this.lastAlive) {
      if (this.lastAlive > 0) bump(r.aliveChip);
      this.lastAlive = alive;
      this.set('alive', r.alive, String(alive));
    }
    this.rankAcc += dt;
    if (this.rankAcc > 0.3) {
      this.rankAcc = 0;
      const order = rank(game.streams, terrain);
      const place = p.phase === 'finished' || p.phase === 'eliminated' ? p.place : order.indexOf(p) + 1;
      const txt = `#${place || '-'}`;
      if (this.cache.place !== txt && this.cache.place) bump(r.placeChip);
      this.set('place', r.place, txt);
      r.placeChip.classList.toggle('is-top', place === 1);
    }

    // --- altimeter while dropping ---
    const dropping = p.phase === 'drop';
    r.alt.classList.toggle('is-on', dropping);
    if (dropping) {
      const ground = Math.max(terrain.heightAt(p.pos.x, p.pos.z), 0);
      const alt = Math.max(0, p.pos.y - ground);
      const f = clamp(alt / 3600, 0, 1);
      r.altFill.style.transform = `scaleY(${f.toFixed(3)})`;
      r.altMark.style.bottom = `${(f * 100).toFixed(1)}%`;
      this.set('alt', r.altVal, fmtInt(Math.round(alt / 10) * 10));
    }

    // --- hints ---
    this.hintAge += dt;
    const hintOn = this.hintText && this.hintAge < this.hintLife;
    r.hint.classList.toggle('is-on', !!hintOn);

    // --- touch controls ---
    const touch = ui.touch;
    const surgeOn = touch && p.phase === 'flow' && game.state === 'stream';
    r.surge.classList.toggle('is-on', surgeOn);
    if (surgeOn) {
      r.surge.classList.toggle('is-active', !!p.surging);
      r.surge.classList.toggle('is-disabled', vol <= SURGE_MIN);
    }
    // leap: visible while flowing, ring fills while recharging
    const leapOn = p.phase === 'flow' && game.state === 'stream';
    r.leap.classList.toggle('is-on', leapOn);
    if (leapOn) {
      const cd = p.leapCooldown ? Math.min(1, (p.leapCool || 0) / p.leapCooldown) : 0;
      r.leapCd.style.setProperty('--cd', `${Math.round(cd * 360)}deg`);
      r.leap.classList.toggle('is-ready', cd <= 0 && !p.leaping);
      r.leap.classList.toggle('is-touch', !!touch);
      const lbl = ui.lang === 'en' ? 'LEAP' : 'SALTO';
      if (r.leapLbl.textContent !== lbl) r.leapLbl.textContent = lbl;
    }
    this.steerAge += dt;
    r.steer.classList.toggle('is-on', touch && this.steerAge < 4.5 && p.phase === 'flow');

    // --- kill feed lifetime ---
    for (let i = this.feedItems.length - 1; i >= 0; i--) {
      const f = this.feedItems[i];
      f.age += dt;
      if (f.age > 5.5) {
        f.el.remove();
        this.feedItems.splice(i, 1);
      } else if (f.age > 5.1) f.el.classList.add('is-out');
    }
  }

  pulse(kind) {
    this.flash = 0.35;
    this.flashKind = kind;
  }
}

function bump(el) {
  el.classList.remove('is-bump');
  void el.offsetWidth;
  el.classList.add('is-bump');
}
