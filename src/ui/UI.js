import '@fontsource/luckiest-guy/latin-400.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-800.css';
import '@fontsource/inter/latin-900.css';
import './styles/base.css';
import './styles/menu.css';
import './styles/hud.css';
import './styles/result.css';

import { h, refs, fmtInt, fmtCompact, isTouch, vibrate } from './util.js';
import { t, setLang, getLang, onLangChange, applyI18n } from './i18n.js';
import { SPRITE } from './icons.js';
import { MapPainter } from './MapPainter.js';
import { Callouts } from './hud/Callouts.js';
import { NameTags } from './hud/NameTags.js';
import { Minimap, FullMap } from './hud/Minimap.js';
import { Hud } from './hud/Hud.js';
import { Lobby } from './screens/Lobby.js';
import { Skins } from './screens/Skins.js';
import { SettingsScreen } from './screens/Settings.js';
import { Daily } from './screens/Daily.js';
import { Result } from './screens/Result.js';
import { Pause } from './screens/Pause.js';
import { UiSynth } from './UiSynth.js';
import { rank } from './hud/Minimap.js';

const MENU_SCREENS = ['lobby', 'locker', 'shop', 'settings'];
const NAME_SEEDS = ['splash', 'gota', 'brook', 'arroyo', 'drizzle', 'cascada', 'ripple', 'torrente'];

/**
 * DOM overlay: lobby, locker/shop, settings, daily reward, HUD (counters, minimap, full map,
 * name tags, kill feed, callouts, floating numbers, touch controls), pause and result screens.
 * Listens to bus events; drives the game only through game.startMatch / toMenu / revivePlayer
 * and the services (economy, ads, analytics, pause).
 * Contract: ui.update(dt), ui.resize(w, h), ui.showMap(bool), ui.callout(text, highlight?)
 */
export class UI {
  constructor(ctx) {
    this.ctx = ctx;
    this.time = 0;
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    const svc = ctx.services;
    setLang(svc.settings.get('lang'));
    this.lang = getLang();
    if (!svc.storage.get('playerName', '')) {
      const n = NAME_SEEDS[Math.floor(Math.random() * NAME_SEEDS.length)];
      svc.storage.set('playerName', `${n}${Math.floor(10 + Math.random() * 890)}`);
    }

    const root = (this.root = h(`<div id="ui">
      ${SPRITE}
      <div class="layer layer--world" data-ref="world"></div>
      <div class="layer layer--hud" data-ref="hudLayer"></div>
      <div class="layer layer--callout" data-ref="calloutLayer"></div>
      <div class="layer layer--screens" data-ref="screens"></div>
      <div class="layer layer--top" data-ref="top"></div>
      <div class="toasts" data-ref="toasts"></div>
    </div>`));
    if (ctx.params.nohud) root.style.display = 'none';
    if (ctx.params.capture) root.classList.add('capture');
    document.body.appendChild(root);
    this.r = refs(root);

    // components
    this.painter = new MapPainter(ctx);
    this.tags = new NameTags(this);
    this.callouts = new Callouts(this);
    this.hud = new Hud(this);
    this.minimap = new Minimap(this, this.painter);
    this.fullmap = new FullMap(this, this.painter);
    this.lobby = new Lobby(this);
    this.locker = new Skins(this, 'locker');
    this.shop = new Skins(this, 'shop');
    this.settingsScreen = new SettingsScreen(this);
    this.daily = new Daily(this);
    this.result = new Result(this);
    this.pauseScreen = new Pause(this);
    this.synth = new UiSynth(ctx);

    this.r.world.append(this.tags.el, this.callouts.floatLayer);
    this.r.hudLayer.appendChild(this.hud.el);
    this.hud.r.side.prepend(this.minimap.el);
    this.r.calloutLayer.appendChild(this.callouts.el);
    this.r.screens.append(this.lobby.el, this.locker.el, this.shop.el, this.settingsScreen.el, this.result.el);
    this.r.top.append(this.fullmap.el, this.pauseScreen.el, this.daily.el);
    this.screens = { lobby: this.lobby, locker: this.locker, shop: this.shop, settings: this.settingsScreen };

    applyI18n(root);
    this.bindBus();
    this.bindInput();
    this.bindSettings();
    this.match = this.newMatch();
    this.layout();
    this.onPhase(ctx.game?.state ?? 'menu');
  }

  init() {
    this.painter.build();
    this.minimap.resize();
    this.applyAudio();
  }

  newMatch() {
    return { cuts: 0, eliminations: 0, reviveUsed: false, reason: null, by: null, announced: new Set(), absorb: new Map(), bodyTotals: new Map(), biggestAcc: 0, landedAt: -1 };
  }

  // --- wiring -----------------------------------------------------------------------

  bindBus() {
    const { bus } = this.ctx;
    bus.on('phase', ({ state }) => this.onPhase(state));
    bus.on('landed', ({ stream }) => {
      if (!stream?.isPlayer) return;
      this.match.landedAt = this.time;
      this.callouts.show(t('co.swallow'), { priority: 2, hold: 3.4, stagger: 0.12 });
      this.hud.hint(t(this.touch ? 'hint.streamTouch' : 'hint.streamKeys'), 7);
      this.hud.showSteerZones();
      vibrate(this.ctx, 40);
    });
    bus.on('absorb', ({ stream, body, amount }) => {
      if (!stream?.isPlayer || !body) return;
      let a = this.match.absorb.get(body);
      if (!a) this.match.absorb.set(body, (a = { amount: 0, since: 0, flushed: false }));
      a.amount += amount;
      this.match.bodyTotals.set(body, (this.match.bodyTotals.get(body) ?? 0) + amount);
    });
    bus.on('cut', ({ attacker, victim, amount }) => {
      const p = this.ctx.game.player;
      if (attacker === p) {
        this.match.cuts++;
        this.callouts.float(`+${fmtInt(amount)} L`, { world: headOf(p), kind: 'gold', big: true });
        this.hud.feed(attacker, 'feed.stole', victim, 'scissors');
        vibrate(this.ctx, 25);
      } else if (victim === p) {
        this.callouts.float(`-${fmtInt(amount)} L`, { world: headOf(p), kind: 'loss', big: true });
        this.callouts.show(t('co.wasCut'), { priority: 2, hold: 1.6 });
        this.hud.feed(attacker, 'feed.stole', victim, 'scissors');
        vibrate(this.ctx, [30, 40, 30]);
      }
    });
    bus.on('eliminated', ({ victim, by, reason }) => {
      const p = this.ctx.game.player;
      if (by) this.hud.feed(by, reason === 'swallowed' ? 'feed.swallowed' : 'feed.cutOff', victim, reason === 'swallowed' ? 'drop' : 'scissors');
      else this.hud.feed(victim, 'feed.dried', null, 'sun');
      if (victim === p) {
        this.match.reason = reason;
        this.match.by = by;
        vibrate(this.ctx, [60, 50, 120]);
        return;
      }
      if (by === p) {
        this.match.eliminations++;
        this.callouts.show(t(reason === 'swallowed' ? 'co.swallowed' : 'co.cutOff', { name: victim.name }), { priority: 3, hold: 2.0 });
        const gain = victim.volume * (reason === 'swallowed' ? 0.7 : 0.5);
        if (gain > 0) this.callouts.float(`+${fmtCompact(gain)} L`, { world: headOf(p), kind: 'gold', big: true });
        vibrate(this.ctx, [40, 30, 60]);
      }
      this.checkAlive();
    });
    bus.on('finished', ({ stream, place }) => {
      this.hud.feed(stream, 'feed.finished', null, 'wave');
      const p = this.ctx.game.player;
      if (stream !== p && place === 1 && p?.alive) this.callouts.show(t('co.firstAtSea', { name: stream.name }), { priority: 2, hold: 2.4 });
      this.checkAlive();
    });
    bus.on('matchEnd', ({ outcome, place, player }) => {
      const m = this.match;
      this.callouts.clear();
      this.result.open({
        outcome,
        place,
        player,
        reason: m.reason,
        by: m.by ?? player?.eliminatedBy ?? null,
        cuts: m.cuts,
        eliminations: m.eliminations,
        time: this.ctx.game.time,
        reviveUsed: m.reviveUsed,
      });
    });
  }

  bindInput() {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      const st = this.ctx.game.state;
      if (e.code === 'Escape' || e.code === 'KeyP') {
        if (this.fullmap.open) return this.showMap(false);
        if (this.daily.isOpen) return this.daily.close();
        if (this.pauseScreen.isOpen) {
          if (this.screenName === 'settings') return this.go('pause');
          return this.pause(false);
        }
        if (st === 'drop' || st === 'stream') return this.pause(true);
        if (st === 'menu' && this.screenName !== 'lobby' && e.code === 'Escape') return this.go('lobby');
      }
      if (e.code === 'KeyM' && (st === 'drop' || st === 'stream') && !this.pauseScreen.isOpen) this.showMap(!this.fullmap.open);
    });
    // first gesture unlocks audio (browsers require it)
    const unlock = () => {
      this.ctx.audio?.unlock?.();
      this.synth.unlock();
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
    // UI click sound for every button
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target.closest?.('button:not([disabled])')) this.sfx('tap');
    });
    document.addEventListener('visibilitychange', () => {
      const { pause } = this.ctx.services;
      if (document.hidden) {
        pause.muteFor('hidden');
        const st = this.ctx.game.state;
        if (!this.ctx.params.capture && (st === 'drop' || st === 'stream')) this.pause(true);
      } else pause.unmuteFor('hidden');
    });
  }

  bindSettings() {
    const { settings } = this.ctx.services;
    settings.onChange((key) => {
      if (key === 'lang') setLang(settings.get('lang'));
      if (['master', 'music', 'sfx'].includes(key)) this.applyAudio();
    });
    onLangChange((lang) => {
      this.lang = lang;
      applyI18n(this.root);
      this.hud.cache = {};
      this.lobby.refresh();
      const cur = this.screens[this.screenName];
      if (cur === this.locker || cur === this.shop) cur.render();
      if (cur === this.settingsScreen) cur.show(cur.back);
    });
  }

  applyAudio() {
    const a = this.ctx.audio;
    const s = this.ctx.services.settings;
    if (!a) return;
    const m = s.get('master');
    const mu = s.get('music');
    const fx = s.get('sfx');
    try {
      if (typeof a.setVolume === 'function') {
        a.setVolume('master', m);
        a.setVolume('music', mu);
        a.setVolume('sfx', fx);
      } else if (typeof a.setMasterVolume === 'function') {
        a.setMasterVolume(m);
        a.setMusicVolume?.(mu);
        a.setSfxVolume?.(fx);
      } else if (!this.ctx.params.mute && !this.ctx.params.capture) {
        a.setMuted?.(m <= 0);
      }
    } catch (e) {
      console.error(e);
    }
  }

  // --- phases -----------------------------------------------------------------------

  onPhase(state) {
    const { ads } = this.ctx.services;
    const root = this.root;
    root.dataset.phase = state;
    const inMatch = state === 'drop' || state === 'stream';
    root.classList.toggle('in-match', inMatch);
    if (inMatch) this.minimap.resize();
    if (state === 'menu') {
      this.result.close();
      this.pauseScreen.close();
      this.showMap(false);
      this.callouts.clear();
      this.tags.clear();
      this.hud.reset();
      this.go('lobby');
      ads.gameplayStop();
      this.ctx.services.analytics.track('menu_view'); // deduped with the bus-driven one
      // daily reward pops up for returning players (never in screenshot mode)
      const eco = this.ctx.services.economy;
      if (!this.ctx.params.capture && eco.stats.matches > 0 && eco.dailyStatus().claimable) setTimeout(() => this.ctx.game.state === 'menu' && this.daily.open(), 700);
    } else if (state === 'drop') {
      this.match = this.newMatch();
      this.result.close();
      this.daily.close();
      this.hideMenus();
      this.hud.reset();
      this.tags.clear();
      this.callouts.clear();
      this.callouts.show(`${t('co.goal')}\n${t('co.goal2')}`, { priority: 2, delay: 0.35, hold: 4.8, stagger: 0.75 });
      this.hud.hint(t(this.touch ? 'hint.dropTouch' : 'hint.dropKeys'), 7.5);
      ads.gameplayStart();
    } else if (state === 'stream') {
      this.hideMenus();
      if (this.result.isOpen) {
        // came back from the result screen → revived through a rewarded ad
        this.result.close();
        this.match.reviveUsed = true;
        this.match.reason = this.match.by = null;
        this.hud.reset();
        this.callouts.show(t('co.revived'), { priority: 3, hold: 2.2 });
      }
      ads.gameplayStart();
    } else if (state === 'result') {
      this.showMap(false);
      this.pause(false);
      this.hud.releaseSurge?.();
      ads.gameplayStop();
    }
  }

  checkAlive() {
    const game = this.ctx.game;
    const p = game.player;
    if (!p?.alive) return;
    const n = game.aliveCount;
    const a = this.match.announced;
    for (const m of [10, 5, 3, 2]) {
      if (n <= m && !a.has(m)) {
        a.add(m);
        if (n === m) {
          this.callouts.show(m === 2 ? t('co.final', { n: 2 }) : t('co.left', { n: m }), { priority: 2, hold: 2.2 });
          this.sfx('alert');
        }
      }
    }
  }

  // --- navigation -------------------------------------------------------------------

  go(name) {
    if (name === 'pause') {
      this.settingsScreen.el.classList.remove('is-active', 'is-over');
      this.screenName = null;
      return;
    }
    if (!MENU_SCREENS.includes(name)) return;
    const prev = this.screenName;
    this.screenName = name;
    for (const [k, s] of Object.entries(this.screens)) s.el.classList.toggle('is-active', k === name);
    this.r.screens.classList.add('menu-on');
    this.lobby.setTab(name);
    if (name === 'lobby') this.lobby.refresh();
    else if (name === 'settings') this.settingsScreen.show(this.pauseScreen.isOpen ? 'pause' : 'lobby');
    else this.screens[name].show();
    if (prev && prev !== name) this.sfx(name === 'lobby' ? 'back' : 'open');
  }

  hideMenus() {
    for (const s of Object.values(this.screens)) s.el.classList.remove('is-active', 'is-over');
    this.r.screens.classList.remove('menu-on');
    this.screenName = null;
  }

  openSettingsFromPause() {
    this.screenName = 'settings';
    this.settingsScreen.el.classList.add('is-active', 'is-over');
    this.settingsScreen.show('pause');
  }

  play() {
    this.ctx.audio?.unlock?.();
    this.synth.unlock();
    this.daily.close();
    this.ctx.services.analytics.track('play_click', { screen: this.screenName ?? 'result' });
    this.ctx.game.startMatch();
  }

  /** Natural break between matches: interstitial if the frequency cap allows. */
  async betweenMatches() {
    try {
      await this.ctx.services.ads.showInterstitial('between_matches');
    } catch {
      /* never block the flow on ads */
    }
  }

  pause(on) {
    const { pause, ads } = this.ctx.services;
    const st = this.ctx.game.state;
    if (on) {
      if (this.pauseScreen.isOpen || !(st === 'drop' || st === 'stream')) return;
      this.showMap(false);
      this.hud.releaseSurge?.();
      this.pauseScreen.open();
      pause.acquire('menu');
      ads.gameplayStop();
      this.sfx('open');
    } else {
      if (!this.pauseScreen.isOpen) return;
      this.go('pause');
      this.pauseScreen.close();
      pause.release('menu');
      if (st === 'drop' || st === 'stream') ads.gameplayStart();
    }
  }

  quitMatch() {
    const { game } = this.ctx;
    const p = game.player;
    const place = p ? rank(game.streams, this.ctx.terrain).indexOf(p) + 1 : 0;
    this.pause(false);
    if (p) {
      this.ctx.services.economy.settleMatch({ outcome: 'quit', place, total: game.streams.length, peakVolume: p.peakVolume, cuts: this.match.cuts, eliminations: this.match.eliminations });
      this.ctx.services.ads.noteMatchEnd({ won: false });
      this.ctx.services.analytics.track('match_quit', { place, t: Math.round(game.time) });
    }
    game.toMenu();
  }

  revived() {
    /* handled in onPhase('stream'); kept for API symmetry */
  }

  // --- contract ---------------------------------------------------------------------

  showMap(open) {
    if (open && !this.ctx.game.player) return;
    if (open === this.fullmap.open) return;
    this.fullmap.setOpen(open);
    this.root.classList.toggle('map-open', open);
    if (open) this.sfx('open');
  }

  callout(text, highlight = '') {
    this.callouts.show(highlight ? `${text}\n*${highlight}*` : text, { priority: 2 });
  }

  toast(text, kind = '') {
    const el = h(`<div class="toast${kind ? ` toast--${kind}` : ''}"></div>`);
    el.textContent = text;
    this.r.toasts.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-in'));
    setTimeout(() => {
      el.classList.remove('is-in');
      setTimeout(() => el.remove(), 400);
    }, 2200);
  }

  /** Radial sparkle burst over an element (purchases, rewards). */
  burst(target) {
    if (!target?.getBoundingClientRect) return;
    const b = target.getBoundingClientRect();
    const el = h('<div class="burst"></div>');
    el.style.left = `${b.left + b.width / 2}px`;
    el.style.top = `${b.top + b.height / 2}px`;
    for (let i = 0; i < 14; i++) {
      const s = document.createElement('i');
      s.style.setProperty('--a', `${(i / 14) * 360}deg`);
      s.style.setProperty('--d', `${60 + (i % 3) * 26}px`);
      el.appendChild(s);
    }
    this.r.top.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  async share({ place, volume }) {
    const { analytics, config } = this.ctx.services;
    const text = t('share.text', { p: place, v: fmtInt(volume) });
    const url = config.share.url ?? `${location.origin}${location.pathname}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Río Royale', text, url });
        analytics.track('share', { method: 'native', place });
        return;
      }
    } catch (e) {
      if (e?.name === 'AbortError') return;
    }
    const full = `${text} ${url}`;
    let ok = false;
    try {
      await navigator.clipboard.writeText(full);
      ok = true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = full;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch {
        ok = false;
      }
    }
    if (ok) this.toast(t('res.copied'));
    analytics.track('share', { method: ok ? 'clipboard' : 'failed', place });
  }

  sfx(name) {
    const a = this.ctx.audio;
    const vol = this.ctx.services.settings.get('sfx') * this.ctx.services.settings.get('master');
    if (this.ctx.services.pause.muteReasons.size || vol <= 0) return;
    if (typeof a?.play === 'function') {
      try {
        a.play(`ui_${name}`);
      } catch {
        /* unknown sound */
      }
      return;
    }
    this.synth.play(name, vol);
  }

  // --- per frame --------------------------------------------------------------------

  update(dt) {
    this.time += dt;
    const { game, params } = this.ctx;
    // in screenshot mode skip DOM/canvas-heavy work while the scenario fast-forwards
    const heavy = !(params.capture && !window.__READY);
    const st = game.state;
    const playing = (st === 'drop' || st === 'stream') && game.player;

    if (playing) {
      this.hud.update(dt, heavy);
      if (heavy) this.minimap.update(dt);
      this.flushAbsorb(dt);
      this.watchMilestones(dt);
    }
    if (heavy) this.tags.update(dt, !!playing && this.ctx.services.settings.get('nameTags') !== false && !this.fullmap.open);
    this.callouts.update(dt);
    this.result.update(dt);
    if (heavy) this.fullmap.update(dt);
  }

  flushAbsorb(dt) {
    const m = this.match;
    for (const [body, a] of m.absorb) {
      a.since += dt;
      const draining = body.volume > 0;
      const due = a.amount > 0 && (a.since > (a.flushed ? 0.6 : 0.22) || !draining);
      if (due) {
        this.callouts.float(`+${fmtInt(a.amount)} L`, { world: { x: body.x, y: body.y + (body.radius ?? 0) * 0.2 + 4, z: body.z }, kind: 'gain', big: a.amount > 200000 });
        a.amount = 0;
        a.since = 0;
        a.flushed = true;
      }
      if (!draining) {
        const total = m.bodyTotals.get(body) ?? 0;
        if (body.kind === 'lake' && total > 0) {
          this.callouts.show(t('co.lake', { v: fmtCompact(total) }), { priority: 1, hold: 2.0 });
          vibrate(this.ctx, 30);
        }
        m.absorb.delete(body);
        m.bodyTotals.delete(body);
      } else if (a.since > 2) m.absorb.delete(body);
    }
  }

  watchMilestones(dt) {
    const game = this.ctx.game;
    const p = game.player;
    const m = this.match;
    if (!p || p.phase !== 'flow') return;
    if (Number.isFinite(p.distToSea) && p.distToSea < 1000 && p.distToSea > 0 && !m.announced.has('near')) {
      m.announced.add('near');
      this.callouts.show(t('co.near', { km: '1' }), { priority: 2, hold: 2.2 });
      this.sfx('alert');
    }
    m.biggestAcc += dt;
    if (m.biggestAcc > 1 && m.landedAt >= 0 && this.time - m.landedAt > 8 && !m.announced.has('biggest')) {
      m.biggestAcc = 0;
      const bigger = game.streams.some((s) => s !== p && s.alive && s.volume >= p.volume);
      if (!bigger && game.aliveCount > 2) {
        m.announced.add('biggest');
        this.callouts.show(t('co.biggest'), { priority: 1, hold: 2.2 });
      }
    }
  }

  layout() {
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.touch = isTouch() || (this.w < 600 && this.h > this.w);
    this.root.classList.toggle('is-touch', this.touch);
    this.root.classList.toggle('is-portrait', this.h > this.w);
  }

  resize() {
    this.layout();
    this.minimap.resize();
    if (this.fullmap.open) this.fullmap.layout();
  }
}

function headOf(s) {
  return { x: s.pos.x, y: s.pos.y + s.radius + 4, z: s.pos.z };
}
