import { h, refs, fmtInt } from '../util.js';
import { t } from '../i18n.js';
import { icon, coin } from '../icons.js';

/** 7-day login streak calendar with a rewarded "claim x2". */
export class Daily {
  constructor(ui) {
    this.ui = ui;
    this.el = h(`<div class="modal modal--daily" aria-hidden="true" role="dialog">
      <div class="modal__card panel">
        <button class="iconbtn modal__x" type="button" data-ref="close" data-i18n-aria="common.close">${icon('close')}</button>
        <div class="modal__head">
          <div class="modal__icon">${icon('gift')}</div>
          <h3 data-i18n="daily.title"></h3>
          <p data-i18n="daily.sub"></p>
        </div>
        <div class="days" data-ref="days"></div>
        <div class="modal__actions" data-ref="actions"></div>
        <p class="modal__foot" data-ref="foot"></p>
      </div>
    </div>`);
    this.r = refs(this.el);
    this.r.close.addEventListener('click', () => this.close());
    this.el.addEventListener('click', (e) => e.target === this.el && this.close());
  }

  get isOpen() {
    return this.el.classList.contains('is-open');
  }

  open() {
    this.ui.sfx('open');
    this.render();
    this.el.classList.add('is-open');
    this.el.setAttribute('aria-hidden', 'false');
    this.ui.ctx.services.analytics.track('daily_view', { claimable: this.ui.ctx.services.economy.dailyStatus().claimable });
  }

  close() {
    this.el.classList.remove('is-open');
    this.el.setAttribute('aria-hidden', 'true');
    this.ui.lobby.refresh();
  }

  render() {
    const { economy, ads } = this.ui.ctx.services;
    const st = economy.dailyStatus();
    const r = this.r;
    r.days.innerHTML = st.rewards
      .map((amount, i) => {
        const day = i + 1;
        const claimed = st.claimable ? day < st.day : day <= st.day;
        const today = st.claimable && day === st.day;
        const big = day === st.rewards.length;
        return `<div class="day${claimed ? ' is-claimed' : ''}${today ? ' is-today' : ''}${big ? ' is-big' : ''}">
          <small>${t('daily.day', { n: day })}</small>
          <div class="day__coin">${coin(big ? 'coin--lg' : '')}</div>
          <b>${fmtInt(amount)}</b>
          ${claimed ? `<span class="day__check">${icon('check')}</span>` : ''}
        </div>`;
      })
      .join('');
    if (st.claimable) {
      const ad = ads.showsAds ? `${icon('ad')}` : '';
      r.actions.innerHTML = `
        <button class="btn btn--green" type="button" data-act="x2"><span class="btn__in">${ad}<span>${t('daily.double')}</span></span></button>
        <button class="btn btn--yellow" type="button" data-act="claim"><span class="btn__in"><span>${t('daily.claim')}</span><span class="price">${coin()}${fmtInt(st.amount)}</span></span></button>`;
      r.foot.textContent = st.streak > 0 ? t('daily.streak', { n: st.streak }) : '';
    } else {
      r.actions.innerHTML = `<button class="btn btn--ghost" type="button" disabled><span class="btn__in">${icon('check')}<span>${t('daily.claimed')}</span></span></button>`;
      r.foot.textContent = t('daily.tomorrow', { n: st.day >= st.rewards.length ? 1 : st.day + 1 });
    }
    r.actions.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => this.claim(b.dataset.act === 'x2')));
  }

  async claim(double) {
    const { economy, ads } = this.ui.ctx.services;
    if (!economy.dailyStatus().claimable) return;
    let mult = 1;
    if (double) {
      const ok = await ads.showRewarded('daily_double');
      if (!ok) return this.ui.toast(t('toast.adFail'), 'warn');
      mult = 2;
    }
    const day = economy.dailyStatus().day;
    const n = economy.claimDaily(mult);
    this.ui.sfx('coins');
    this.ui.toast(t('toast.coins', { n: fmtInt(n) }), 'gold');
    this.render();
    this.ui.burst(this.r.days.children[day - 1] ?? this.r.days);
    setTimeout(() => this.isOpen && this.close(), 1400);
  }
}
