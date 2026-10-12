import { h, refs, esc } from '../util.js';
import { t } from '../i18n.js';
import { icon } from '../icons.js';

const QUALITIES = ['auto', 'low', 'medium', 'high', 'ultra'];

export class SettingsScreen {
  constructor(ui) {
    this.ui = ui;
    this.back = 'lobby';
    this.el = h(`<section class="screen screen--settings" data-screen="settings">
      <div class="shade shade--full"></div>
      <header class="screenbar">
        <button class="backbtn" type="button" data-ref="back">${icon('back')}<span data-i18n="nav.back"></span></button>
        <div class="screenbar__title"><h2 data-i18n="settings.title"></h2><small data-ref="ver"></small></div>
        <div class="screenbar__right"></div>
      </header>
      <div class="settings">
        <div class="sgroup panel">
          <h4>${icon('mountain')}<span data-i18n="settings.graphics"></span></h4>
          <div class="seg seg--5" data-ref="quality" role="radiogroup"></div>
          <p class="note" data-ref="qnote"></p>
        </div>
        <div class="sgroup panel">
          <h4>${icon('volume')}<span data-i18n="settings.audio"></span></h4>
          <label class="slider"><span data-i18n="settings.master"></span><input type="range" min="0" max="100" step="5" data-key="master"><output></output></label>
          <label class="slider"><span data-i18n="settings.music"></span><input type="range" min="0" max="100" step="5" data-key="music"><output></output></label>
          <label class="slider"><span data-i18n="settings.sfx"></span><input type="range" min="0" max="100" step="5" data-key="sfx"><output></output></label>
        </div>
        <div class="sgroup panel">
          <h4>${icon('flag')}<span data-i18n="settings.gameplay"></span></h4>
          <label class="toggle"><span data-i18n="settings.nameTags"></span><input type="checkbox" data-key="nameTags"><i></i></label>
          <label class="toggle"><span data-i18n="settings.haptics"></span><input type="checkbox" data-key="haptics"><i></i></label>
          <h4 class="sgroup__sub">${icon('globe')}<span data-i18n="settings.language"></span></h4>
          <div class="seg" data-ref="lang" role="radiogroup">
            <button type="button" data-lang="es">ESPAÑOL</button>
            <button type="button" data-lang="en">ENGLISH</button>
          </div>
          <h4 class="sgroup__sub">${icon('drop')}<span data-i18n="settings.player"></span></h4>
          <input class="textin" data-ref="name" maxlength="16" autocomplete="off" spellcheck="false">
        </div>
        <div class="sgroup panel sgroup--controls">
          <h4>${icon('gamepad')}<span data-i18n="settings.controls"></span></h4>
          <div class="controls">
            <div class="ctl"><div class="ctl__h">${icon('keyboard')}<b data-i18n="settings.keyboard"></b></div>
              <ul>
                <li><span><k>A</k><k>D</k></span><em data-i18n="ctl.steer"></em></li>
                <li><span><k>W</k><k>A</k><k>S</k><k>D</k></span><em data-i18n="ctl.drop"></em></li>
                <li><span><k>SPACE</k></span><em data-i18n="ctl.surge"></em></li>
                <li><span><k>M</k></span><em data-i18n="ctl.map"></em></li>
                <li><span><k>ESC</k></span><em data-i18n="ctl.pause"></em></li>
              </ul></div>
            <div class="ctl"><div class="ctl__h">${icon('hand')}<b data-i18n="settings.touch"></b></div>
              <ul>
                <li><em data-i18n="ctl.touchSteer"></em></li>
                <li><em data-i18n="ctl.touchDrop"></em></li>
                <li><em data-i18n="ctl.touchSurge"></em></li>
                <li><em data-i18n="ctl.touchMap"></em></li>
              </ul></div>
            <div class="ctl"><div class="ctl__h">${icon('gamepad')}<b data-i18n="settings.gamepad"></b></div>
              <ul>
                <li><span><k>L</k></span><em data-i18n="ctl.padSteer"></em></li>
                <li><span><k>A</k><k>RT</k></span><em data-i18n="ctl.surge"></em></li>
              </ul></div>
          </div>
        </div>
      </div>
    </section>`);
    this.r = refs(this.el);
    const { settings, storage } = ui.ctx.services;

    this.r.back.addEventListener('click', () => ui.go(this.back));
    this.r.quality.innerHTML = QUALITIES.map((q) => `<button type="button" data-q="${q}" data-i18n="q.${q}"></button>`).join('');
    this.r.quality.addEventListener('click', (e) => {
      const b = e.target.closest('[data-q]');
      if (!b || b.dataset.q === settings.get('quality')) return;
      settings.set('quality', b.dataset.q);
      ui.ctx.services.analytics.track('settings_change', { key: 'quality', value: b.dataset.q });
      reloadWithQuality(b.dataset.q);
    });
    this.el.querySelectorAll('input[type=range]').forEach((inp) => {
      inp.addEventListener('input', () => {
        settings.set(inp.dataset.key, Number(inp.value) / 100);
        inp.nextElementSibling.textContent = inp.value;
        inp.style.setProperty('--v', `${inp.value}%`);
      });
    });
    this.el.querySelectorAll('input[type=checkbox]').forEach((inp) => {
      inp.addEventListener('change', () => {
        settings.set(inp.dataset.key, inp.checked);
      });
    });
    this.r.lang.addEventListener('click', (e) => {
      const b = e.target.closest('[data-lang]');
      if (!b) return;
      settings.set('lang', b.dataset.lang);
      ui.ctx.services.analytics.track('settings_change', { key: 'lang', value: b.dataset.lang });
    });
    this.r.name.addEventListener('change', () => {
      const v = this.r.name.value.replace(/[<>]/g, '').trim().slice(0, 16);
      if (v) storage.set('playerName', v);
      this.r.name.value = storage.get('playerName', '');
    });
    // keep typing from steering / opening the map
    this.r.name.addEventListener('keydown', (e) => e.stopPropagation());
  }

  show(back = 'lobby') {
    this.back = back;
    const { settings, storage, ads, config } = this.ui.ctx.services;
    const q = settings.get('quality');
    this.r.quality.querySelectorAll('[data-q]').forEach((b) => b.classList.toggle('is-on', b.dataset.q === q));
    const active = this.ui.ctx.quality?.name;
    this.r.qnote.innerHTML = `${esc(t('settings.reload'))}${active ? ` · <b>${esc(t(`q.${active}`))}</b>` : ''}`;
    this.el.querySelectorAll('input[type=range]').forEach((inp) => {
      const v = Math.round((settings.get(inp.dataset.key) ?? 1) * 100);
      inp.value = v;
      inp.nextElementSibling.textContent = v;
      inp.style.setProperty('--v', `${v}%`);
    });
    this.el.querySelectorAll('input[type=checkbox]').forEach((inp) => (inp.checked = !!settings.get(inp.dataset.key)));
    const lang = this.ui.lang;
    this.r.lang.querySelectorAll('[data-lang]').forEach((b) => b.classList.toggle('is-on', b.dataset.lang === lang));
    this.r.name.value = storage.get('playerName', '');
    this.r.ver.textContent = `v${config.version} · ${ads.provider}`;
  }
}

function reloadWithQuality(q) {
  try {
    const url = new URL(location.href);
    if (q === 'auto') url.searchParams.delete('quality');
    else url.searchParams.set('quality', q);
    location.replace(url.toString());
  } catch {
    location.reload();
  }
}
