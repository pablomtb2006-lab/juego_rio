import { h, refs, esc, hex, fmtInt, fmtCompact, fmtFixed, fmtTime, clamp } from '../util.js';
import { t } from '../i18n.js';
import { icon, coin } from '../icons.js';
import { Confetti } from '../Confetti.js';

const REVIVE_SECONDS = 9;

/**
 * End-of-match flow (all timing driven by ui.update(dt), so it freezes during ads):
 *   eliminated → [#N + "CUT OFF BY x"] → revive offer (rewarded, once per match, countdown)
 *              → declined / timeout → rewards
 *   finished   → [#N burst + confetti for #1] → rewards → x2 (rewarded) → play again / lobby / share
 */
export class Result {
  constructor(ui) {
    this.ui = ui;
    this.el = h(`<section class="result" aria-live="polite">
      <div class="result__shade"></div>
      <div class="result__rays"></div>
      <canvas class="result__confetti" data-ref="confetti"></canvas>
      <div class="result__wrap">
        <div class="result__head">
          <div class="result__place" data-ref="place"></div>
          <div class="result__title" data-ref="title"></div>
          <div class="result__by" data-ref="by"></div>
        </div>
        <div class="result__stats" data-ref="stats"></div>
        <div class="result__card" data-ref="card"></div>
        <div class="result__actions" data-ref="actions">
          <button class="iconbtn iconbtn--lg" type="button" data-act="share" data-i18n-aria="res.share">${icon('share')}</button>
          <button class="btn btn--blue" type="button" data-act="lobby"><span class="btn__in">${icon('home')}<span data-i18n="res.lobby"></span></span></button>
          <button class="btn btn--yellow btn--again" type="button" data-act="again"><span class="btn__in">${icon('play')}<span data-i18n="res.playAgain"></span></span></button>
        </div>
      </div>
    </section>`);
    this.r = refs(this.el);
    this.confetti = new Confetti(this.r.confetti);
    this.r.actions.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b) this.action(b.dataset.act);
    });
    this.r.card.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b) this.action(b.dataset.act);
    });
    this.state = null;
  }

  /** Called on 'matchEnd'. `info` = { outcome, place, player, reason, by, cuts, eliminations, time, reviveUsed } */
  open(info) {
    const ui = this.ui;
    const total = ui.ctx.game.streams.length || 16;
    this.state = { ...info, total, age: 0, stage: 'intro', settled: null, shownTotal: 0, doubled: false, reviveLeft: REVIVE_SECONDS, busy: false };
    const s = this.state;
    const win = info.outcome === 'win';
    const kind = win ? (info.place === 1 ? 'victory' : info.place <= 3 ? 'podium' : 'finished') : 'out';
    this.el.className = `result is-open result--${kind}`;
    this.r.place.innerHTML = `<span class="result__hash">#</span><span class="result__num">${info.place || '-'}</span><small class="result__of">${esc(t('res.of', { n: total }))}</small>`;
    this.r.title.textContent = win ? t(`res.${kind}`) : t('res.eliminated');
    if (!win) {
      const by = info.by;
      const label = info.reason === 'dried' || !by ? t('res.dried') : info.reason === 'swallowed' ? t('res.swallowedBy') : t('res.cutBy');
      this.r.by.innerHTML = `${esc(label)}${by && info.reason !== 'dried' ? ` <span class="who" style="--c:${hex(by.color)}">${esc(by.name)}</span>` : ''}`;
    } else this.r.by.innerHTML = '';
    const p = info.player;
    const dist = Number.isFinite(p.distToSea) ? p.distToSea : 0;
    this.r.stats.innerHTML = [
      tile('drop', fmtCompact(p.peakVolume) + ' L', t('res.peak')),
      tile('clock', fmtTime(info.time), t('res.time')),
      tile('scissors', fmtInt(info.cuts), t('res.cuts')),
      win ? tile('trophy', `#${info.place}`, t('hud.place')) : tile('wave', `${fmtFixed(dist / 1000, 2)} KM`, t('res.toSea')),
    ].join('');
    this.r.card.innerHTML = '';
    this.r.card.className = 'result__card';
    this.r.actions.classList.remove('is-show');
    if (kind === 'victory') {
      this.confetti.start();
      ui.ctx.services.ads.happyTime();
    } else this.confetti.stop();
    // the revive offer only makes sense if the game supports it
    s.canRevive = !win && !info.reviveUsed && typeof ui.ctx.game.revivePlayer === 'function';
  }

  close() {
    this.el.className = 'result';
    this.confetti.stop();
    this.state = null;
  }

  get isOpen() {
    return !!this.state;
  }

  showRevive() {
    const s = this.state;
    s.stage = 'revive';
    const { ads } = this.ui.ctx.services;
    const badge = ads.showsAds ? `<span class="adtag">${icon('ad')}${t('common.ad')}</span>` : `<span class="adtag adtag--free">${t('common.free')}</span>`;
    this.r.card.className = 'result__card is-show';
    this.r.card.innerHTML = `<div class="revive panel">
      <div class="revive__ring"><svg viewBox="0 0 100 100"><circle class="bg" cx="50" cy="50" r="44"/><circle class="fg" data-ref="ring" cx="50" cy="50" r="44"/></svg>${icon('revive')}<b data-ref="count">${REVIVE_SECONDS}</b></div>
      <div class="revive__txt"><h3>${t('res.revive')}</h3><p>${t('res.reviveSub')}</p></div>
      <button class="btn btn--green btn--wide btn--pulse" type="button" data-act="revive"><span class="btn__in">${icon('heart')}<span>${t('res.revive')}</span>${badge}</span></button>
      <button class="linkbtn" type="button" data-act="skip">${t('res.noThanks')}</button>
    </div>`;
    this.ring = this.r.card.querySelector('[data-ref=ring]');
    this.count = this.r.card.querySelector('[data-ref=count]');
    this.ui.ctx.services.analytics.track('revive_offer', { place: s.place });
  }

  settle() {
    const s = this.state;
    if (s.settled) return;
    const { economy, ads } = this.ui.ctx.services;
    s.settled = economy.settleMatch({
      outcome: s.outcome,
      place: s.place,
      total: s.total,
      peakVolume: s.player.peakVolume,
      cuts: s.cuts,
      eliminations: s.eliminations,
      duration: s.time,
    });
    ads.noteMatchEnd({ won: s.outcome === 'win' && s.place === 1 });
    this.showRewards();
  }

  showRewards() {
    const s = this.state;
    s.stage = 'rewards';
    s.rewardsAge = 0;
    const { ads } = this.ui.ctx.services;
    const items = s.settled.items
      .map((it, i) => {
        const d = it.key === 'volume' ? `${fmtCompact(it.detail)} L` : it.detail ?? '';
        return `<li style="--i:${i}"><span>${esc(t(`rw.${it.key}`, { d }))}</span><b>+${fmtInt(it.amount)}</b></li>`;
      })
      .join('');
    const x2 = ads.showsAds
      ? `<button class="btn btn--green btn--wide btn--pulse" type="button" data-act="double"><span class="btn__in">${icon('ad')}<span>${t('res.double')}</span></span></button>`
      : '';
    this.r.card.className = 'result__card is-show';
    this.r.card.innerHTML = `<div class="rewards panel">
      <h4>${icon('gift')}${t('res.rewards')}</h4>
      <ul>${items}</ul>
      <div class="rewards__total"><span>${t('res.total')}</span><b>${coin()}<span data-ref="total">0</span></b><i class="rewards__stamp" data-ref="stamp">${t('res.doubled')}</i></div>
      ${x2}
    </div>`;
    this.totalEl = this.r.card.querySelector('[data-ref=total]');
    this.stamp = this.r.card.querySelector('[data-ref=stamp]');
    s.shownTotal = 0;
    this.r.actions.classList.add('is-show');
  }

  async action(act) {
    const ui = this.ui;
    const s = this.state;
    if (!s || s.busy) return;
    const { ads, economy, analytics } = ui.ctx.services;
    analytics.track('result_action', { action: act, place: s.place, outcome: s.outcome });
    if (act === 'skip') {
      this.settle();
    } else if (act === 'revive') {
      s.busy = true;
      const ok = await ads.showRewarded('revive');
      s.busy = false;
      if (!this.state) return;
      if (ok && ui.ctx.game.revivePlayer()) {
        ui.revived();
      } else {
        ui.toast(t('toast.adFail'), 'warn');
        this.settle();
      }
    } else if (act === 'double') {
      if (s.doubled || !s.settled) return;
      s.busy = true;
      const ok = await ads.showRewarded('double_reward');
      s.busy = false;
      if (!this.state) return;
      if (!ok) return ui.toast(t('toast.adFail'), 'warn');
      s.doubled = true;
      economy.grant(s.settled.total, 'double_reward');
      this.r.card.querySelector('[data-act=double]')?.remove();
      this.stamp?.classList.add('is-on');
      ui.sfx('coins');
      ui.burst(this.totalEl);
    } else if (act === 'again' || act === 'lobby') {
      if (!s.settled) this.settle();
      s.busy = true;
      await ui.betweenMatches();
      s.busy = false;
      if (act === 'again') ui.play();
      else ui.ctx.game.toMenu();
    } else if (act === 'share') {
      ui.share({ place: s.place, volume: s.player.peakVolume });
    }
  }

  update(dt) {
    const s = this.state;
    if (!s) return;
    s.age += dt;
    this.confetti.update(dt, this.ui.w, this.ui.h);
    if (s.stage === 'intro' && s.age > (s.outcome === 'win' ? 1.0 : 0.9)) {
      if (s.canRevive) this.showRevive();
      else this.settle();
    }
    if (s.stage === 'revive' && !s.busy) {
      s.reviveLeft -= dt;
      const f = clamp(s.reviveLeft / REVIVE_SECONDS, 0, 1);
      if (this.ring) this.ring.style.strokeDashoffset = String((1 - f) * 276.5);
      if (this.count) this.count.textContent = String(Math.max(0, Math.ceil(s.reviveLeft)));
      if (s.reviveLeft <= 0) this.settle();
    }
    if (s.stage === 'rewards' && s.settled) {
      s.rewardsAge += dt;
      const target = s.settled.total * (s.doubled ? 2 : 1);
      if (s.shownTotal !== target && s.rewardsAge > 0.45) {
        const step = Math.max(1, Math.ceil(Math.abs(target - s.shownTotal) * (1 - Math.exp(-dt * 6))));
        s.shownTotal = Math.min(target, s.shownTotal + step);
        if (this.totalEl) this.totalEl.textContent = fmtInt(s.shownTotal);
      }
    }
  }
}

function tile(ic, value, label) {
  return `<div class="stat">${icon(ic)}<b>${esc(value)}</b><small>${esc(label)}</small></div>`;
}
