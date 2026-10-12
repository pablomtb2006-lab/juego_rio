import { h, refs, fmtInt, fmtFixed } from '../util.js';
import { t } from '../i18n.js';
import { icon, dropIcon } from '../icons.js';

/** In-match pause menu (Esc / pause button / tab hidden). */
export class Pause {
  constructor(ui) {
    this.ui = ui;
    this.el = h(`<div class="pause" aria-hidden="true" role="dialog">
      <div class="pause__card">
        <h2 class="pause__title" data-i18n="pause.title"></h2>
        <div class="pause__stats" data-ref="stats"></div>
        <div class="pause__btns" data-ref="main">
          <button class="btn btn--yellow btn--wide" type="button" data-act="resume"><span class="btn__in">${icon('play')}<span data-i18n="pause.resume"></span></span></button>
          <button class="btn btn--blue btn--wide" type="button" data-act="settings"><span class="btn__in">${icon('gear')}<span data-i18n="pause.settings"></span></span></button>
          <button class="btn btn--red btn--wide" type="button" data-act="quit"><span class="btn__in">${icon('flag')}<span data-i18n="pause.quit"></span></span></button>
        </div>
        <div class="pause__confirm" data-ref="confirm">
          <p data-i18n="pause.quitConfirm"></p>
          <div class="pause__row">
            <button class="btn btn--ghost" type="button" data-act="cancel"><span class="btn__in"><span data-i18n="common.cancel"></span></span></button>
            <button class="btn btn--red" type="button" data-act="confirm"><span class="btn__in"><span data-i18n="pause.quit"></span></span></button>
          </div>
        </div>
      </div>
    </div>`);
    this.r = refs(this.el);
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const a = b.dataset.act;
      if (a === 'resume') ui.pause(false);
      else if (a === 'settings') ui.openSettingsFromPause();
      else if (a === 'quit') this.el.classList.add('is-confirm');
      else if (a === 'cancel') this.el.classList.remove('is-confirm');
      else if (a === 'confirm') ui.quitMatch();
    });
  }

  get isOpen() {
    return this.el.classList.contains('is-open');
  }

  open() {
    const p = this.ui.ctx.game.player;
    if (p) {
      const d = Number.isFinite(p.distToSea) ? p.distToSea : this.ui.ctx.terrain.distToSea(p.pos.x, p.pos.z);
      this.r.stats.innerHTML = `<span><b>${fmtFixed(d / 1000, 2)}</b> ${t('hud.kmToSea')}</span><span>${dropIcon()}<b>${fmtInt(p.volume)}</b> L</span><span>${icon('streams')}<b>${this.ui.ctx.game.aliveCount}</b> ${t('hud.alive')}</span>`;
    }
    this.el.classList.remove('is-confirm');
    this.el.classList.add('is-open');
    this.el.setAttribute('aria-hidden', 'false');
  }

  close() {
    this.el.classList.remove('is-open', 'is-confirm');
    this.el.setAttribute('aria-hidden', 'true');
  }
}
