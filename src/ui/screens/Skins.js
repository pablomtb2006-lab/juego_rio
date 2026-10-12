import { h, refs, fmtInt } from '../util.js';
import { t, getLang } from '../i18n.js';
import { icon, coin } from '../icons.js';
import { skinArt } from '../skinArt.js';
import { RARITIES, getSkin, skinName } from '../../game/skins.js';
import { Wallet } from './Lobby.js';
import { dayKey } from '../../services/Economy.js';

/**
 * Locker (all skins, equip/buy) and Item Shop (unowned skins, daily featured pair, free-drops
 * rewarded card). One component, two modes.
 */
export class Skins {
  constructor(ui, mode) {
    this.ui = ui;
    this.mode = mode;
    this.selected = null;
    this.el = h(`<section class="screen screen--skins screen--${mode}" data-screen="${mode}">
      <div class="shade shade--full"></div>
      <header class="screenbar">
        <button class="backbtn" type="button" data-ref="back">${icon('back')}<span data-i18n="nav.back"></span></button>
        <div class="screenbar__title"><h2 data-i18n="${mode === 'shop' ? 'shop.title' : 'locker.title'}"></h2><small data-ref="sub"></small></div>
        <div class="screenbar__right" data-ref="right"></div>
      </header>
      <div class="skins">
        <div class="skins__preview" data-ref="preview">
          <div class="skins__rays"></div>
          <div class="skins__stage" data-ref="stage"></div>
          <div class="skins__info">
            <span class="rtag" data-ref="rarity"></span>
            <h3 data-ref="name"></h3>
          </div>
          <div class="skins__action" data-ref="action"></div>
        </div>
        <div class="skins__grid" data-ref="grid"></div>
      </div>
    </section>`);
    this.r = refs(this.el);
    this.wallet = new Wallet(ui, { plus: mode !== 'shop' });
    this.r.right.appendChild(this.wallet.el);
    this.r.back.addEventListener('click', () => ui.go('lobby'));
    this.r.grid.addEventListener('click', (e) => {
      const card = e.target.closest('[data-id]');
      if (!card) return;
      if (card.dataset.id === '__free') return this.freeCoins();
      this.select(card.dataset.id);
    });
    ui.ctx.services.economy.onChange(() => this.el.classList.contains('is-active') && this.render());
  }

  /** Two featured skins rotate every day (deterministic per date). */
  featured() {
    const eco = this.ui.ctx.services.economy;
    const pool = eco.catalog.filter((s) => s.price > 0);
    let seed = [...dayKey()].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    const pick = [];
    while (pick.length < 2 && pool.length) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      pick.push(pool.splice(seed % pool.length, 1)[0]);
    }
    return pick;
  }

  list() {
    const eco = this.ui.ctx.services.economy;
    const all = [...eco.catalog];
    if (this.mode === 'locker') {
      return all.sort((a, b) => (eco.owned.has(b.id) - eco.owned.has(a.id)) || RARITIES[a.rarity].order - RARITIES[b.rarity].order || a.price - b.price);
    }
    const feat = this.featured();
    const rest = all.filter((s) => !feat.includes(s) && s.price > 0).sort((a, b) => RARITIES[b.rarity].order - RARITIES[a.rarity].order || b.price - a.price);
    return [...feat, ...rest];
  }

  show() {
    const eco = this.ui.ctx.services.economy;
    const items = this.list();
    if (!this.selected || !items.find((s) => s.id === this.selected)) {
      this.selected = this.mode === 'locker' ? eco.equippedSkin : items.find((s) => !eco.owned.has(s.id))?.id ?? items[0]?.id;
    }
    this.ui.ctx.services.analytics.track(this.mode === 'shop' ? 'shop_view' : 'locker_view', { coins: eco.coins });
    this.render();
  }

  select(id) {
    this.selected = id;
    this.ui.ctx.services.economy.markSeen(id);
    this.render();
  }

  render() {
    const { economy: eco } = this.ui.ctx.services;
    const lang = getLang();
    const items = this.list();
    const feat = this.mode === 'shop' ? this.featured() : [];
    const r = this.r;

    if (this.mode === 'locker') {
      r.sub.textContent = t('locker.collection', { a: eco.owned.size, b: eco.catalog.length });
    } else {
      const now = new Date();
      const mid = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      const mins = Math.max(0, Math.round((mid - now) / 60000));
      r.sub.textContent = t('shop.sub', { t: `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m` });
    }

    let html = '';
    if (this.mode === 'shop') {
      const left = eco.freeCoinsLeft();
      const free = this.ui.ctx.services.ads.showsAds ? `${icon('ad')}<span>${t('common.ad')}</span>` : `<span>${t('common.free')}</span>`;
      html += `<button class="scard scard--free${left ? '' : ' is-disabled'}" type="button" data-id="__free">
        <div class="scard__bg"></div>
        <div class="scard__art scard__art--coins">${coin('coin--xl')}<b>+${this.ui.ctx.services.config.economy.freeCoinsAd}</b></div>
        <div class="scard__name">${t('shop.free')}</div>
        <div class="scard__foot"><span class="scard__ad">${free}</span><small>${left ? t('shop.freeSub', { n: left }) : t('shop.freeNone')}</small></div>
      </button>`;
    }
    const visible = this.mode === 'shop' ? items.filter((s) => !eco.owned.has(s.id) || feat.includes(s)) : items;
    if (this.mode === 'shop' && !items.some((s) => !eco.owned.has(s.id))) {
      html += `<div class="skins__empty">${icon('trophy')}<span>${t('shop.allOwned')}</span></div>`;
    }
    for (const s of visible) {
      const owned = eco.owned.has(s.id);
      const equipped = eco.equippedSkin === s.id;
      const isNew = !owned && !feat.includes(s) && !eco.flags.seen.includes(s.id) && s.price <= eco.coins;
      const foot = equipped
        ? `<span class="scard__state is-eq">${icon('check')}${t('locker.equipped')}</span>`
        : owned
          ? `<span class="scard__state">${t('locker.owned')}</span>`
          : `<span class="price${s.price > eco.coins ? ' is-short' : ''}">${coin()}${fmtInt(s.price)}</span>`;
      html += `<button class="scard rarity-${s.rarity}${feat.includes(s) ? ' scard--feat' : ''}${owned ? ' is-owned' : ''}${equipped ? ' is-equipped' : ''}${this.selected === s.id ? ' is-selected' : ''}" type="button" data-id="${s.id}">
        <div class="scard__bg"></div>
        ${feat.includes(s) ? `<span class="scard__ribbon">${t('shop.featured')}</span>` : ''}
        ${isNew ? `<span class="scard__new">${t('common.new')}</span>` : ''}
        <div class="scard__art">${skinArt(s)}</div>
        <div class="scard__name">${skinName(s, lang)}</div>
        <div class="scard__foot">${foot}</div>
      </button>`;
    }
    r.grid.innerHTML = html;

    // preview
    const sel = getSkin(this.selected);
    const owned = eco.owned.has(sel.id);
    const equipped = eco.equippedSkin === sel.id;
    r.preview.className = `skins__preview rarity-${sel.rarity}`;
    if (this.stageFor !== sel.id) {
      this.stageFor = sel.id;
      r.stage.innerHTML = skinArt(sel, 'is-hero');
      r.stage.classList.remove('is-pop');
      void r.stage.offsetWidth;
      r.stage.classList.add('is-pop');
    }
    r.rarity.textContent = t(`rarity.${sel.rarity}`);
    r.rarity.className = `rtag rtag--${sel.rarity}`;
    r.name.textContent = skinName(sel, lang);
    let action;
    if (equipped) action = `<button class="btn btn--ghost btn--wide" type="button" disabled><span class="btn__in">${icon('check')}<span>${t('locker.equipped')}</span></span></button>`;
    else if (owned) action = `<button class="btn btn--blue btn--wide" type="button" data-act="equip"><span class="btn__in"><span>${t('locker.equip')}</span></span></button>`;
    else if (sel.price <= eco.coins) action = `<button class="btn btn--yellow btn--wide" type="button" data-act="buy"><span class="btn__in"><span>${t('locker.buy')}</span><span class="price">${coin()}${fmtInt(sel.price)}</span></span></button>`;
    else
      action = `<button class="btn btn--ghost btn--wide is-short" type="button" data-act="short"><span class="btn__in"><span class="price">${coin()}${fmtInt(sel.price)}</span></span></button><small class="skins__need">${t('locker.need', { n: fmtInt(sel.price - eco.coins) })}</small>`;
    r.action.innerHTML = action;
    r.action.querySelector('[data-act]')?.addEventListener('click', (e) => this.act(e.currentTarget.dataset.act, sel));
    this.wallet.refresh();
  }

  act(what, skin) {
    const ui = this.ui;
    const eco = ui.ctx.services.economy;
    const name = skinName(skin, getLang());
    if (what === 'equip') {
      eco.equip(skin.id);
      ui.sfx('equip');
      ui.toast(t('toast.equipped', { name }));
    } else if (what === 'buy') {
      if (eco.buy(skin.id)) {
        eco.equip(skin.id);
        ui.sfx('purchase');
        ui.toast(t('toast.unlocked', { name }), 'gold');
        ui.burst(this.r.stage);
      }
    } else if (what === 'short') {
      ui.sfx('error');
      ui.toast(t('toast.noCoins'), 'warn');
      if (this.mode === 'locker') ui.go('shop');
    }
    this.render();
  }

  async freeCoins() {
    const ui = this.ui;
    const { economy, ads } = ui.ctx.services;
    if (economy.freeCoinsLeft() <= 0) return;
    const ok = await ads.showRewarded('free_coins');
    if (!ok) return ui.toast(t('toast.adFail'), 'warn');
    const n = economy.claimFreeCoins();
    ui.sfx('coins');
    ui.toast(t('toast.coins', { n }), 'gold');
    this.render();
  }
}
