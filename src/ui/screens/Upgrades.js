import { h, refs, fmtInt } from '../util.js';
import { getLang } from '../i18n.js';
import { icon, coin } from '../icons.js';
import { Wallet } from './Lobby.js';
import { UPGRADES, MAX_LEVEL, nextCost } from '../../game/upgrades.js';

/** Permanent upgrades (progression): buy levels with Gotas, applied to your river every match. */
export class Upgrades {
  constructor(ui) {
    this.ui = ui;
    this.el = h(`<section class="screen screen--upgrades" data-screen="upgrades">
      <div class="shade shade--full"></div>
      <header class="screenbar">
        <button class="backbtn" type="button" data-ref="back">${icon('back')}<span data-i18n="nav.back"></span></button>
        <div class="screenbar__title"><h2 data-ref="title"></h2><small data-ref="sub"></small></div>
        <div class="screenbar__right" data-ref="right"></div>
      </header>
      <div class="upg" data-ref="list"></div>
    </section>`);
    this.r = refs(this.el);
    this.wallet = new Wallet(ui, { plus: true });
    this.r.right.appendChild(this.wallet.el);
    this.r.back.addEventListener('click', () => ui.go('lobby'));
    this.r.list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-buy]');
      if (!b) return;
      const eco = ui.ctx.services.economy;
      if (eco.buyUpgrade(b.dataset.buy)) {
        ui.sfx?.('purchase');
        ui.burst?.(b);
      } else ui.sfx?.('error');
      this.render();
    });
    ui.ctx.services.economy.onChange(() => this.el.classList.contains('is-active') && this.render());
  }

  show() {
    this.render();
  }

  render() {
    const es = getLang() === 'es';
    const eco = this.ui.ctx.services.economy;
    this.r.title.textContent = es ? 'MEJORAS' : 'UPGRADES';
    this.r.sub.textContent = es ? 'Tu río se vuelve más fuerte para siempre' : 'Your river gets stronger for good';
    this.r.list.innerHTML = UPGRADES.map((u) => {
      const lvl = eco.upgradeLevel(u.id);
      const cost = nextCost(u.id, lvl);
      const pips = Array.from({ length: MAX_LEVEL }, (_, i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('');
      const can = cost != null && eco.coins >= cost;
      const btn =
        cost == null
          ? `<span class="upg__max">${es ? 'MÁX' : 'MAX'}</span>`
          : `<button type="button" class="upg__buy${can ? '' : ' is-poor'}" data-buy="${u.id}" data-sfx="none">${coin()}<b>${fmtInt(cost)}</b></button>`;
      return `<div class="upg__card">
        <div class="upg__icon">${u.icon}</div>
        <div class="upg__body">
          <h3>${u.name[es ? 'es' : 'en']} <small>${es ? 'NIV' : 'LV'} ${lvl}</small></h3>
          <p>${u.desc[es ? 'es' : 'en']}</p>
          <div class="upg__pips">${pips}</div>
        </div>
        ${btn}
      </div>`;
    }).join('');
  }
}
