/**
 * Río Royale — procedural audio (100% synthesized WebAudio, no files).
 *
 * PUBLIC API (ctx.audio)
 *   unlock()                         create/resume the AudioContext. Call from a user gesture
 *                                    (UI "play" button). Also auto-armed on the first
 *                                    pointerdown/keydown/touchend anywhere on the page.
 *   update(dt, time)                 per frame (Engine). Cheap when locked/muted.
 *   setMuted(bool) / toggleMute()    persisted. `muted` getter.
 *   setVolume({ master, music, sfx }) 0..1 each (partial objects allowed), persisted in
 *                                    ctx.services.storage under 'audio'. getVolume() → copy.
 *   play(name, opts) -> bool         one-shots. UI: 'click' 'back' 'hover' 'purchase' 'coin'
 *                                    'reward' 'countdown' {n:3|2|1|0} 'go' 'error' 'notify'
 *                                    'equip' 'open' 'close'. World: 'splash' {x,y,z,size}
 *                                    'firework' {x,y,z,launch?,size?} 'whoosh' 'gulp'
 *                                    'impact' {size 0..1}. Music: 'fanfare' 'launch'.
 *                                    opts.delay (s) offsets the start.
 *   duck(amount, seconds)            dip everything (ads / pause overlays). amount 0..1;
 *                                    seconds omitted/Infinity → hold until duck(0).
 *   pauseAll() / resumeAll()         suspend/resume the whole context (ads, pause menu).
 *                                    Tab visibility is handled automatically.
 *   autoFireworks (bool, default true)  play a fireworks show on victory; set false if the
 *                                    renderer triggers play('firework', {x,y,z}) itself.
 *   autoUiSounds  (bool, default true)  delegated hover/click sounds on <button>/.btn/[data-sfx];
 *                                    data-sfx="purchase" picks the sound, data-sfx="none" mutes.
 *   dispose()
 *
 * Reacts to bus events: phase, landed, splash, absorb, cut, eliminated, finished, matchEnd.
 * Disabled entirely with ?mute=1 or ?capture=1 (add &audiotest=1 to force it on for tests).
 *
 * Signal flow / modules
 *   engine/SoundBank  synthesizes buffers (noise beds, bubbles, droplets, drum kit, IR)
 *   engine/Mixer      music/sfx/ui buses → glue comp → limiter → soft clip → master
 *   engine/Spatial    camera-relative pan / distance / air absorption / sound delay
 *   music/*           look-ahead sequencer, songs (menu, drop, match, victory, defeat), stingers
 *   sfx/voices        continuous voices (river, wind, absorb, ambience, rivals, riser)
 *   sfx/oneshots      one-shot catalogue (SFX)
 */
import { SoundBank } from './engine/SoundBank.js';
import { Mixer } from './engine/Mixer.js';
import { Listener } from './engine/Spatial.js';
import { Music } from './music/Music.js';
import { SFX } from './sfx/oneshots.js';
import { RiverVoice, WindVoice, AbsorbVoice, AmbienceVoice, RivalVoices, RiserVoice } from './sfx/voices.js';
import { clamp, rand } from './engine/util.js';

const DEFAULTS = { master: 0.9, music: 0.8, sfx: 1, muted: false };
const MIN_GAP = { hover: 0.045, click: 0.04, back: 0.04, coin: 0.035, splash: 0.03, error: 0.15, countdown: 0.2 };
const GESTURES = ['pointerdown', 'pointerup', 'keydown', 'touchend', 'click'];
const _grad = { x: 0, y: 0, set(a, b) { this.x = a; this.y = b; return this; } };

/** Persisted settings, validated (a corrupt value must never reach an AudioParam). */
function loadSettings(storage) {
  const s = { ...DEFAULTS };
  let saved = null;
  try {
    saved = storage?.get('audio', null);
  } catch {
    /* ignore */
  }
  if (saved && typeof saved === 'object') {
    for (const k of ['master', 'music', 'sfx']) if (Number.isFinite(saved[k])) s[k] = clamp(saved[k]);
    if (typeof saved.muted === 'boolean') s.muted = saved.muted;
  }
  return s;
}

export class AudioSystem {
  constructor(ctx) {
    this.ctx = ctx;
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
    this.forced = q.get('audiotest') === '1';
    this.enabled = this.forced || !(ctx.params?.mute || ctx.params?.capture);
    this.ac = null;
    this.running = false;
    this.autoFireworks = true;
    this.autoUiSounds = true;
    this.pauseReasons = new Set();
    this.lastPlayed = new Map();
    this.settings = loadSettings(this.storage);
    this.st = this.freshState();

    const bus = ctx.bus;
    if (bus) {
      bus.on('phase', (e) => this.onPhase(e.state));
      bus.on('landed', (e) => this.onLanded(e));
      bus.on('splash', (e) => this.onSplash(e));
      bus.on('absorb', (e) => this.onAbsorb(e));
      bus.on('cut', (e) => this.onCut(e));
      bus.on('eliminated', (e) => this.onEliminated(e));
      bus.on('finished', (e) => this.onFinished(e));
      bus.on('matchEnd', (e) => this.onMatchEnd(e));
    }

    if (this.enabled && typeof window !== 'undefined') {
      this.onGesture = () => this.unlock();
      for (const ev of GESTURES) window.addEventListener(ev, this.onGesture, { capture: true, passive: true });
      this.onVisibility = () => (document.hidden ? this.pauseAll('hidden') : this.resumeAll('hidden'));
      document.addEventListener('visibilitychange', this.onVisibility);
      this.onUiOver = (e) => this.uiSound(e, 'hover');
      this.onUiClick = (e) => this.uiSound(e, 'click');
      document.addEventListener('pointerover', this.onUiOver, true);
      document.addEventListener('click', this.onUiClick, true);
      if (this.forced) this.unlock();
    }
  }

  get storage() {
    return this.ctx.services?.storage ?? null;
  }

  get muted() {
    return !!this.settings.muted;
  }

  freshState() {
    return {
      phase: 'menu',
      cloud: 0,
      inCloud: false,
      surging: false,
      absorbAmt: 0,
      absorbBody: null,
      absorbLast: -1,
      comboStep: 0,
      comboAcc: 0,
      emptied: new Set(),
      intensity: 0,
      lifted: false,
      landedAt: -1,
      splashTimes: [],
    };
  }

  // ===========================================================================
  // lifecycle
  // ===========================================================================

  unlock() {
    if (!this.enabled) return;
    if (this.ac) {
      // also recovers iOS 'interrupted' contexts (phone call, Siri) on the next tap
      if (this.ac.state !== 'running' && this.ac.state !== 'closed' && !this.pauseReasons.size) this.ac.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      this.enabled = false;
      return;
    }
    // 'low' quality (old phones) gets the light profile: 1 osc per pad/pluck voice,
    // fewer grains, shorter reverb, and a larger (glitch-safer) output buffer
    const lite = this.ctx.quality?.name === 'low';
    try {
      this.ac = new AC({ latencyHint: lite ? 'balanced' : 'interactive' });
    } catch {
      this.enabled = false;
      return;
    }
    const ac = this.ac;
    // legacy iOS: a buffer must start inside the gesture for the context to unlock
    try {
      const b = ac.createBufferSource();
      b.buffer = ac.createBuffer(1, 1, ac.sampleRate);
      b.connect(ac.destination);
      b.start(0);
    } catch {
      /* not needed elsewhere */
    }
    this.bank = new SoundBank(ac, { lite });
    this.mixer = new Mixer(ac, this.bank);
    this.listener = new Listener();
    this.music = new Music({ ac, mixer: this.mixer, bank: this.bank, lite });
    this.S = { ac, bank: this.bank, mixer: this.mixer, listener: this.listener, music: this.music, lite };
    this.v = {
      river: new RiverVoice(this.S),
      wind: new WindVoice(this.S),
      absorb: new AbsorbVoice(this.S),
      amb: new AmbienceVoice(this.S),
      rivals: new RivalVoices(this.S),
      riser: new RiserVoice(this.S),
    };
    this.applyVolumes();
    this.mixer.setMuted(this.settings.muted);
    if (this.settings.muted) this.pauseReasons.add('mute');
    if (typeof document !== 'undefined' && document.hidden) this.pauseReasons.add('hidden');
    if (!this.pauseReasons.size) ac.resume().catch(() => {});
    else ac.suspend().catch(() => {});
    this.running = true;
    // the sequencer must keep going through long frames → also tick it from a timer
    this.timer = setInterval(() => this.running && this.music.update(), 90);
    // ambience uses the modulation buffers → start it once the bank is complete
    this.bank.ready.then(() => this.ac && this.v.amb.start());
    this.syncToGame();
  }

  dispose() {
    clearInterval(this.timer);
    if (typeof window !== 'undefined' && this.onGesture) {
      for (const ev of GESTURES) window.removeEventListener(ev, this.onGesture, { capture: true });
      document.removeEventListener('visibilitychange', this.onVisibility);
      document.removeEventListener('pointerover', this.onUiOver, true);
      document.removeEventListener('click', this.onUiClick, true);
    }
    this.running = false;
    this.ac?.close().catch(() => {});
    this.ac = null;
  }

  // ===========================================================================
  // settings
  // ===========================================================================

  setMuted(m) {
    this.settings.muted = !!m;
    this.save();
    if (!this.ac) return;
    this.mixer.setMuted(this.settings.muted);
    if (this.settings.muted) {
      // fade, then suspend to save CPU/battery
      setTimeout(() => this.settings.muted && this.pauseAll('mute'), 200);
    } else this.resumeAll('mute');
  }

  toggleMute() {
    this.setMuted(!this.settings.muted);
    return this.settings.muted;
  }

  setVolume(v = {}) {
    for (const k of ['master', 'music', 'sfx']) if (v[k] != null && Number.isFinite(+v[k])) this.settings[k] = clamp(+v[k]);
    this.save();
    this.applyVolumes();
  }

  getVolume() {
    const { master, music, sfx, muted } = this.settings;
    return { master, music, sfx, muted };
  }

  applyVolumes() {
    this.mixer?.setVolumes(this.settings);
  }

  save() {
    this.storage?.set('audio', this.getVolume());
  }

  duck(amount = 0.7, seconds) {
    this.mixer?.duck(amount, seconds);
  }

  pauseAll(reason = 'user') {
    this.pauseReasons.add(reason);
    if (this.ac && this.ac.state === 'running') this.ac.suspend().catch(() => {});
  }

  /** Each pause reason ('user', 'ad', 'hidden', 'mute', …) must be released by its own resumeAll(reason). */
  resumeAll(reason = 'user') {
    this.pauseReasons.delete(reason);
    if (this.ac && !this.pauseReasons.size && this.ac.state !== 'closed') this.ac.resume().catch(() => {});
  }

  // ===========================================================================
  // one-shots
  // ===========================================================================

  play(name, opts = {}) {
    if (!this.running || !this.ac) return false;
    const now = this.ac.currentTime;
    const gap = MIN_GAP[name] ?? 0.02;
    const last = this.lastPlayed.get(name) ?? -1;
    if (now - last < gap) return false;
    this.lastPlayed.set(name, now);
    const t = now + 0.008 + Math.max(0, opts.delay ?? 0);
    try {
      if (name === 'fanfare') return this.music.fanfare(t) > 0;
      if (name === 'launch') return this.music.stinger('launch', t), true;
      const fn = SFX[name];
      if (!fn) return false;
      fn(this.S, t, opts);
      return true;
    } catch (e) {
      console.warn(`[audio] play(${name}) failed`, e);
      return false;
    }
  }

  uiSound(e, kind) {
    if (!this.autoUiSounds || !this.running) return;
    const el = e.target?.closest?.('button, .btn, [data-sfx], [role="button"]');
    if (!el || el.disabled) return;
    const tag = el.dataset?.sfx;
    if (tag === 'none') return;
    if (kind === 'hover') {
      if (e.pointerType === 'touch') return;
      // only when entering a new control (pointerover bubbles from children)
      if (e.relatedTarget && el.contains(e.relatedTarget)) return;
      this.play('hover');
    } else this.play(tag && SFX[tag] ? tag : 'click');
  }

  // ===========================================================================
  // bus events
  // ===========================================================================

  get player() {
    return this.ctx.game?.player ?? null;
  }

  onPhase(state) {
    if (!this.running) return;
    const prev = this.st.phase;
    if (state === prev && state !== 'stream') return;
    if (state === 'drop') this.st = this.freshState();
    this.st.phase = state;
    const m = this.music;
    const v = this.v;
    const now = this.ac.currentTime;
    if (state === 'menu') {
      v.river.stop(0.8);
      v.wind.stop(0.5);
      v.absorb.stop(0.2);
      v.rivals.stop(0.5);
      v.riser.stop(0.3);
      this.mixer.filterMusic(20000, 0.2);
      if (m.playing !== 'menu') {
        // first visit gets the soft intro; coming back from a match drops straight into the groove
        m.play('menu', { at: 'now', section: this.menuPlayed ? 'groove' : null });
        this.menuPlayed = true;
      }
    } else if (state === 'drop') {
      v.river.stop(0.3);
      v.rivals.stop(0.3);
      v.wind.start();
      v.riser.start();
      this.mixer.filterMusic(20000, 0.2);
      m.stop(0.5);
      m.stinger('launch', now + 0.05);
      m.play('drop', { at: now + 0.75 });
      SFX.whoosh(this.S, now + 0.02, { dur: 1.1, f0: 200, f1: 1800, gain: 0.5, q: 0.8, pan0: 0, pan1: 0 });
    } else if (state === 'stream') {
      v.wind.stop(0.5);
      v.riser.stop(0.25);
      v.river.start();
      v.rivals.start();
      if (prev === 'result') {
        // revived by a rewarded ad
        this.mixer.filterMusic(20000, 0.3);
        m.play('match', { at: 'now', layers: 2 });
        this.music.drum('crash', now + 0.08, 0.5);
      } else if (m.playing !== 'match') m.play('match', { at: 'now' });
    } else if (state === 'result') {
      v.wind.stop(0.4);
      v.riser.stop(0.2);
      v.absorb.stop(0.2);
      v.rivals.stop(0.8);
      // unlocked while already on the result screen: just play the matching loop
      if (prev === null) m.play(this.ctx.game?.outcome === 'win' ? 'victory' : 'defeat', { at: 'now' });
    }
  }

  onLanded({ stream }) {
    if (!this.running || !stream?.isPlayer) return;
    const now = this.ac.currentTime;
    const t = now + 0.01;
    this.st.landedAt = now;
    const size = clamp((Math.log10(Math.max(stream.volume, 1)) - 4.5) / 2.5);
    SFX.impact(this.S, t, { size });
    this.v.wind.stop(0.35);
    this.v.riser.stop(0.15);
    this.music.build = 0;
    this.music.play('match', { at: t, layers: 2 });
    this.music.drum('crash', t, 0.55);
    this.music.drum('kick', t, 1);
    this.v.river.start();
    this.v.rivals.start();
  }

  onSplash({ x, y, z, size, stream }) {
    if (!this.running) return;
    const now = this.ac.currentTime;
    if (stream?.isPlayer && now - this.st.landedAt < 0.3) return; // covered by impact()
    // voice limit: at most 5 splashes per half second
    const times = this.st.splashTimes.filter((t) => now - t < 0.5);
    if (times.length >= 5) return;
    times.push(now);
    this.st.splashTimes = times;
    SFX.splash(this.S, now + 0.01, { x, y, z, size });
  }

  onAbsorb({ stream, body, amount }) {
    if (!this.running || !stream?.isPlayer) return;
    const st = this.st;
    const now = this.ac.currentTime;
    if (st.absorbBody !== body) {
      st.absorbBody = body;
      st.comboAcc = 0;
      if (now - st.absorbLast > 0.8) st.comboStep = 0;
    }
    st.absorbLast = now;
    st.absorbAmt = amount;
    // rising combo chimes, in key
    const isCloud = body?.kind === 'cloud';
    const unit = Math.max((body?.maxVolume ?? 1e5) / (isCloud ? 3 : 7), isCloud ? 60000 : 90000);
    st.comboAcc += amount;
    if (st.comboAcc >= unit && st.comboStep < 14 && this.gate('chime', 0.09)) {
      st.comboAcc = Math.min(st.comboAcc - unit, unit);
      SFX.absorbChime(this.S, now + 0.01, { step: st.comboStep++, gain: isCloud ? 0.45 : 0.7 });
    }
    if (body && body.volume <= 0 && !st.emptied.has(body)) {
      st.emptied.add(body);
      if (!isCloud && body.maxVolume > 2e5 && this.gate('absorbDone', 0.3)) {
        SFX.absorbDone(this.S, now + 0.02, { size: clamp((Math.log10(body.maxVolume) - 5) / 2.5) });
      }
    }
  }

  /** Per-category rate limiter on audio time (true = allowed). */
  gate(name, gap) {
    const now = this.ac.currentTime;
    const last = this.lastPlayed.get(name) ?? -1;
    if (now - last < gap) return false;
    this.lastPlayed.set(name, now);
    return true;
  }

  onCut({ attacker, victim }) {
    if (!this.running) return;
    const now = this.ac.currentTime;
    if (attacker?.isPlayer) {
      if (!this.gate('cut', 0.12)) return;
      SFX.cut(this.S, now + 0.01);
      this.mixer.duckMusic(0.3, 0.15, 0.4);
    } else if (victim?.isPlayer) {
      if (!this.gate('cutBy', 0.12)) return;
      SFX.cutBy(this.S, now + 0.01);
      this.mixer.duckMusic(0.45, 0.2, 0.6);
    } else if (victim?.pos && this.gate('cutOther', 0.1)) {
      SFX.splash(this.S, now + 0.01, { x: victim.pos.x, y: victim.pos.y, z: victim.pos.z, size: 10, gain: 0.6 });
    }
  }

  onEliminated({ victim, by }) {
    if (!this.running || !victim) return;
    const now = this.ac.currentTime;
    if (victim.isPlayer) {
      SFX.elimSelf(this.S, now + 0.01);
      this.v.river.stop(1.2);
      this.v.absorb.stop(0.2);
      this.mixer.filterMusic(240, 0.35);
      this.music.stop(2.2);
      return;
    }
    if (by?.isPlayer) {
      if (!this.gate('takedown', 0.2)) return;
      SFX.cut(this.S, now + 0.01);
      SFX.absorbDone(this.S, now + 0.25, { size: 0.8 });
    } else if (victim.pos && this.gate('elimOther', 0.08)) {
      SFX.elimOther(this.S, now + 0.01, { x: victim.pos.x, y: victim.pos.y, z: victim.pos.z });
    }
  }

  onFinished({ stream }) {
    if (!this.running || stream?.isPlayer) return;
    const p = this.player;
    if (p && p.alive && this.gate('finishOther', 0.4)) SFX.finishOther(this.S, this.ac.currentTime + 0.02);
  }

  onMatchEnd({ outcome, player }) {
    if (!this.running) return;
    const now = this.ac.currentTime;
    const m = this.music;
    this.v.river.stop(outcome === 'win' ? 2.5 : 1.2);
    if (outcome === 'win') {
      this.mixer.filterMusic(20000, 0.1);
      m.stop(0.25);
      // reaching the sea: a wave crashing into open water
      SFX.impact(this.S, now + 0.02, { size: 0.6 });
      const dur = m.fanfare(now + 0.45);
      setTimeout(() => {
        if (this.st.phase === 'result' && !m.playing) m.play('victory', { at: 'now' });
      }, (dur + 0.2) * 1000);
      if (this.autoFireworks) this.fireworksShow(player?.pos);
    } else {
      setTimeout(() => {
        if (this.st.phase !== 'result' || !this.ac) return;
        this.mixer.filterMusic(20000, 1.5);
        m.play('defeat', { at: 'now' });
      }, 2600);
    }
  }

  fireworksShow(center) {
    if (!center) return;
    const now = this.ac.currentTime;
    const cx = center.x;
    const cz = center.z;
    for (let i = 0; i < 16; i++) {
      const t = 1.8 + i * rand(0.35, 0.75) + (i > 10 ? rand(0, 1.5) : 0);
      const x = cx + rand(-180, 180);
      const z = cz + rand(-180, 180);
      const y = rand(140, 320);
      setTimeout(() => {
        if (this.st.phase !== 'result' || !this.ac) return;
        SFX.firework(this.S, this.ac.currentTime + 0.01, { x, y, z, size: rand(0.7, 1.2) });
      }, t * 1000);
    }
    return now;
  }

  // ===========================================================================
  // per-frame
  // ===========================================================================

  /** (Re)start the voices / music matching the current game state (after unlock). */
  syncToGame() {
    if (!this.running) return;
    const state = this.ctx.game?.state ?? 'menu';
    this.st.phase = state === 'stream' ? 'drop' : null;
    this.onPhase(state);
  }

  update(dt) {
    if (!this.running || !this.ac || this.ac.state === 'closed') return;
    if (this.ac.state !== 'running') return;
    const now = this.ac.currentTime;
    // grain clocks and smoothing follow *audio* time: a burst of fixed-step frames
    // (capture mode, throttled tab) must not schedule thousands of grains at once
    dt = clamp(now - (this.lastNow ?? now), 0, 0.1);
    this.lastNow = now;
    const ctx = this.ctx;
    this.listener.update(ctx.camera);
    const game = ctx.game;
    const p = game?.player;
    const st = this.st;
    const v = this.v;

    // ambience defaults per phase
    let amb = { wind: 0.4, ocean: 0.3, birds: 0.35, gulls: 0.15 };

    if (p && st.phase === 'drop' && p.phase === 'drop') {
      const fall = clamp(p.speed / 110);
      const inCloud = p.absorbing > 0;
      if (inCloud && !st.inCloud) SFX.cloudEnter(this.S, now + 0.01);
      st.inCloud = inCloud;
      st.cloud += ((inCloud ? 1 : 0) - st.cloud) * (1 - Math.exp(-dt / (inCloud ? 0.08 : 0.5)));
      v.wind.set({ fall, cloud: st.cloud, level: 1 }, now);
      v.wind.tick(dt, now);
      // time to impact → musical build-up + riser
      const ground = Math.max(ctx.terrain?.heightAt?.(p.pos.x, p.pos.z) ?? 0, 0);
      const vy = Math.max(-p.vel.y, 1);
      const tti = (p.pos.y - ground) / vy;
      const build = clamp((5.2 - tti) / 4.8);
      this.music.setBuild(build);
      v.riser.set(build, now, this.music.key);
      amb = { wind: 0.15, ocean: 0.1, birds: 0, gulls: 0 };
    } else if (p && st.phase === 'stream' && p.phase === 'flow') {
      this.updateRiver(p, dt, now);
      amb = this.streamAmbience(p);
    } else if (st.phase === 'result') {
      const win = game?.outcome === 'win';
      amb = { wind: 0.3, ocean: win ? 0.7 : 0.3, birds: win ? 0 : 0.2, gulls: win ? 0.5 : 0.1 };
    }

    if (v.amb.on) {
      v.amb.set(amb, now);
      v.amb.tick(dt, now);
    }
    this.music.update();
  }

  updateRiver(p, dt, now) {
    const st = this.st;
    const v = this.v;
    const terrain = this.ctx.terrain;
    const speed = clamp((p.speed - 6) / 38);
    const size = clamp((Math.log10(Math.max(p.volume, 1)) - 4.6) / 2.6);
    let slope = 0;
    if (terrain?.gradientAt) {
      terrain.gradientAt(p.pos.x, p.pos.z, _grad);
      slope = clamp(Math.hypot(_grad.x, _grad.y) / 0.5);
    }
    const surging = !!p.surging;
    if (surging && !st.surging) SFX.surge(this.S, now + 0.01);
    st.surging = surging;
    const foam = clamp(0.55 * speed + 0.7 * slope - 0.25 + (surging ? 0.3 : 0));
    v.river.set({ speed, size, slope, foam, surge: surging ? 1 : 0, level: 1 }, now);
    v.river.tick(dt, now);

    // swallowing
    const absorbing = p.absorbing > 0 || now - st.absorbLast < 0.12;
    if (absorbing) {
      if (!v.absorb.on) v.absorb.start();
      const b = st.absorbBody;
      const rate = clamp((Math.log10(Math.max(p.absorbing, 1)) - 5) / 2.5);
      const fill = b?.maxVolume ? clamp(1 - b.volume / b.maxVolume) : 0.5;
      const bsize = b?.maxVolume ? clamp((Math.log10(b.maxVolume) - 5) / 2.5) : 0.5;
      v.absorb.set({ rate, fill, size: bsize, level: 1 }, now);
      v.absorb.tick(dt, now, SFX);
    } else if (v.absorb.on) v.absorb.stop(0.35);

    // nearest rivals
    const near = [];
    let danger = 0;
    for (const s of this.ctx.game.streams) {
      if (s === p || s.phase !== 'flow') continue;
      const d = Math.hypot(s.pos.x - p.pos.x, s.pos.z - p.pos.z);
      if (d > 420) continue;
      const closeness = clamp(1 - d / 300);
      danger = Math.max(danger, closeness * (s.volume > p.volume ? 1 : 0.55));
      near.push({ id: s.id, x: s.pos.x, y: s.pos.y, z: s.pos.z, d, size: clamp((Math.log10(Math.max(s.volume, 1)) - 4.6) / 2.6), speed: 0.5 + 0.5 * clamp(s.speed / 40) });
    }
    near.sort((a, b) => a.d - b.d);
    v.rivals.set(near.slice(0, 2), now, this.listener);

    // adaptive music intensity (rises fast, falls slowly)
    const dist = Number.isFinite(p.distToSea) ? p.distToSea : 5000;
    const sea = clamp(1 - dist / 4000);
    // floor 0.3 keeps at least the light groove (layer 1) going during a match
    const target = clamp(0.3 + 0.3 * speed + 0.32 * danger + 0.5 * Math.pow(sea, 1.4) + (surging ? 0.12 : 0) + (absorbing ? 0.05 : 0));
    const tc = target > st.intensity ? 1.2 : 5;
    st.intensity += (target - st.intensity) * (1 - Math.exp(-dt / tc));
    this.music.setIntensity(st.intensity);
    if (!st.lifted && dist < 900) {
      st.lifted = true;
      this.music.lift();
    }
  }

  streamAmbience(p) {
    const dist = Number.isFinite(p.distToSea) ? p.distToSea : 5000;
    const ocean = Math.pow(clamp(1 - dist / 1800), 1.5);
    const alt = clamp(p.pos.y / 900);
    return {
      wind: 0.15 + 0.35 * alt,
      ocean: 0.05 + 0.9 * ocean,
      birds: p.pos.y < 750 ? 0.55 * (1 - ocean) * (1 - alt * 0.5) : 0,
      gulls: ocean > 0.25 ? ocean : 0,
    };
  }
}
