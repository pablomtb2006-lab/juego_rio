import { h, refs, esc, fmtInt } from '../util.js';
import { t, getLang } from '../i18n.js';
import { icon, coin } from '../icons.js';
import { skinArt } from '../skinArt.js';
import { getSkin, skinName } from '../../game/skins.js';

/** Wallet pill with an animated count-up; clicking opens the shop. */
export class Wallet {
  constructor(ui, { plus = true } = {}) {
    this.ui = ui;
    this.el = h(`<button class="wallet" type="button">${coin()}<b>0</b>${plus ? `<span class="wallet__plus">${icon('plus')}</span>` : ''}</button>`);
    this.num = this.el.querySelector('b');
    this.shown = ui.ctx.services.economy.coins;
    this.num.textContent = fmtInt(this.shown);
    this.el.addEventListener('click', () => ui.go('shop'));
    ui.ctx.services.economy.onChange((eco) => this.to(eco.coins));
  }

  refresh() {
    this.num.textContent = fmtInt(this.shown);
  }

  to(target) {
    const from = this.shown;
    if (from === target) return;
    cancelAnimationFrame(this.raf);
    const t0 = performance.now();
    const dur = Math.min(1200, 300 + Math.abs(target - from) * 2);
    this.el.classList.toggle('is-up', target > from);
    this.el.classList.add('is-changing');
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      this.shown = Math.round(from + (target - from) * e);
      this.num.textContent = fmtInt(this.shown);
      if (k < 1) this.raf = requestAnimationFrame(step);
      else this.el.classList.remove('is-changing');
    };
    this.raf = requestAnimationFrame(step);
  }
}

export class Lobby {
  constructor(ui) {
    this.ui = ui;
    const eco = ui.ctx.services.economy;
    this.el = h(`<section class="screen screen--lobby" data-screen="lobby">
      <div class="shade shade--top"></div><div class="shade shade--bottom"></div>
      <header class="topbar">
        <nav class="tabs" data-ref="tabs">
          <button class="tab is-active" type="button" data-go="lobby"><span data-i18n="nav.play"></span></button>
          <button class="tab" type="button" data-go="locker"><span data-i18n="nav.locker"></span></button>
          <button class="tab" type="button" data-go="shop"><span data-i18n="nav.shop"></span><i class="badge" data-ref="shopBadge"></i></button>
          <button class="tab" type="button" data-go="upgrades"><span data-i18n="nav.upgrades"></span></button>
        </nav>
        <div class="topbar__right" data-ref="right">
          <button class="iconbtn iconbtn--gift" type="button" data-ref="gift" data-i18n-aria="nav.daily">${icon('gift')}<i class="dot"></i></button>
          <button class="iconbtn" type="button" data-go="settings" data-i18n-aria="nav.settings">${icon('gear')}</button>
        </div>
      </header>

      <div class="lobby__hero">
        <h1 class="logo" aria-label="Río Royale">
          <span class="logo__w logo__rio" data-text="RIO">R<span class="logo__i">I<svg class="logo__acc" viewBox="0 0 24 30" aria-hidden="true"><defs><linearGradient id="logo-acc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c6f8ff"/><stop offset="1" stop-color="#1fa6d6"/></linearGradient></defs><path d="M12 2c3 5 9 9.5 9 15.5a9 9 0 0 1-18 0C3 11.5 9 7 12 2z" fill="url(#logo-acc)" stroke="#083a66" stroke-width="3" stroke-linejoin="round"/><path d="M8 18a4 4 0 0 0 3.5 4.2" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg></span>O</span>
          <span class="logo__w logo__royale" data-text="ROYALE">ROYALE</span>
        </h1>
        <p class="ribbon"><span data-i18n="app.tagline"></span></p>
      </div>

      <div class="lobby__left">
        <div class="pcard" data-ref="pcard">
          <div class="pcard__avatar" data-ref="avatar"><span class="pcard__lv" data-ref="lv">1</span></div>
          <div class="pcard__main">
            <div class="pcard__name" data-ref="pname"></div>
            <div class="pcard__xp"><i data-ref="xp"></i></div>
            <div class="pcard__stats">
              <span>${icon('trophy')}<b data-ref="wins">0</b><small data-i18n="lobby.wins"></small></span>
              <span>${icon('flag')}<b data-ref="matches">0</b><small data-i18n="lobby.matches"></small></span>
              <span>${icon('crown')}<b data-ref="best">-</b><small data-i18n="lobby.best"></small></span>
            </div>
          </div>
        </div>
        <button class="skincard" type="button" data-go="locker" data-ref="skincard">
          <div class="skincard__art" data-ref="skinArt"></div>
          <div class="skincard__txt">
            <small data-i18n="lobby.yourStream"></small>
            <b data-ref="skinName"></b>
            <span class="rtag" data-ref="skinRarity"></span>
          </div>
          <span class="skincard__go">${icon('chevronRight')}</span>
        </button>
      </div>

      <div class="lobby__play">
        <div class="mode"><span class="mode__ic">${icon('streams')}</span><span><b data-i18n="lobby.mode"></b><small data-i18n="lobby.modeSub"></small></span></div>
        <button class="btn btn--yellow btn--play" type="button" data-ref="play"><span class="btn__in">${icon('play')}<span data-i18n="lobby.play"></span></span></button>
      </div>

      <nav class="bottomnav">
        <button type="button" data-go="locker">${icon('locker')}<span data-i18n="nav.locker"></span></button>
        <button type="button" data-go="shop">${icon('shop')}<span data-i18n="nav.shop"></span><i class="badge" data-ref="shopBadge2"></i></button>
        <button type="button" data-go="upgrades">${icon('shop')}<span data-i18n="nav.upgrades"></span></button>
        <button type="button" data-ref="gift2">${icon('gift')}<span data-i18n="nav.daily"></span><i class="dot"></i></button>
      </nav>
    </section>`);
    this.r = refs(this.el);
    this.wallet = new Wallet(ui);
    this.r.right.insertBefore(this.wallet.el, this.r.right.lastElementChild);

    this.el.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => ui.go(b.dataset.go)));
    this.r.play.addEventListener('click', () => ui.play());
    this.r.gift.addEventListener('click', () => ui.daily.open());
    this.r.gift2.addEventListener('click', () => ui.daily.open());
    eco.onChange(() => this.refresh());
  }

  refresh() {
    const { economy, storage } = this.ui.ctx.services;
    const r = this.r;
    const skin = getSkin(economy.equippedSkin);
    const lang = getLang();
    if (this.skinShown !== skin.id + lang) {
      this.skinShown = skin.id + lang;
      r.skinArt.innerHTML = skinArt(skin, 'is-idle');
      r.avatar.querySelector('.skinart')?.remove();
      r.avatar.insertAdjacentHTML('afterbegin', skinArt(skin));
      r.skincard.className = `skincard rarity-${skin.rarity}`;
      r.skinName.textContent = skinName(skin, lang);
      r.skinRarity.textContent = t(`rarity.${skin.rarity}`);
      r.skinRarity.className = `rtag rtag--${skin.rarity}`;
    }
    const s = economy.stats;
    r.wins.textContent = fmtInt(s.wins);
    r.matches.textContent = fmtInt(s.matches);
    r.best.textContent = s.bestPlace < 99 ? `#${s.bestPlace}` : '-';
    r.pname.textContent = storage.get('playerName', '') || t('lobby.player');
    const lv = economy.level;
    r.lv.textContent = String(lv.level);
    r.xp.style.width = `${Math.round(Math.max(0.04, lv.progress) * 100)}%`;
    const daily = economy.dailyStatus().claimable;
    this.el.classList.toggle('has-daily', daily);
    const affordable = economy.catalog.some((k) => !economy.owned.has(k.id) && k.price <= economy.coins);
    for (const b of [r.shopBadge, r.shopBadge2]) {
      b.textContent = affordable ? '!' : '';
      b.classList.toggle('is-on', affordable);
    }
    this.wallet.refresh();
  }

  setTab(name) {
    this.r.tabs.querySelectorAll('.tab').forEach((tb) => tb.classList.toggle('is-active', tb.dataset.go === name));
  }
}
