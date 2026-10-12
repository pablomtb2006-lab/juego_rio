import { CONFIG } from './config.js';
import { PROVIDERS, detectPortal, hasGlobal, loadScript } from './adProviders.js';

/**
 * Ad facade so the game ships to different portals without code changes.
 * Contract (kept from the skeleton, all safe to call at any time):
 *   ads.showRewarded(placement)     -> Promise<boolean>  (true = reward earned)
 *   ads.showInterstitial(placement) -> Promise<boolean>  (respects the frequency cap)
 *   ads.gameplayStart() / ads.gameplayStop()             (portal SDK lifecycle hooks)
 * Added:
 *   ads.init(), ads.loadingFinished(), ads.happyTime()
 *   ads.provider (name), ads.showsAds (a real/simulated ad will play), ads.busy
 *   ads.noteMatchEnd({ won }), ads.interstitialDue()
 * While an ad plays the game is paused and muted through services.pause.
 */
export class Ads {
  constructor(ctx, analytics, pause, storage) {
    this.ctx = ctx;
    this.analytics = analytics;
    this.pause = pause;
    this.storage = storage;
    this.impl = new PROVIDERS.none();
    this.busy = false;
    this.inGameplay = false;
    this.matchesSince = 0;
    this.lastInterstitialAt = 0;
    this.ready = this.init();
  }

  get provider() {
    return this.impl.name;
  }

  get showsAds() {
    return this.impl.showsAds;
  }

  async init() {
    const cfg = CONFIG.ads;
    let name = cfg.provider;
    if (name === 'auto') name = detectPortal() ?? (cfg.simulate ? 'dev' : 'none');
    if (!PROVIDERS[name]) name = 'none';
    if (['poki', 'crazygames', 'gamedistribution'].includes(name) && !hasGlobal(name)) {
      if (cfg.loadSdk && cfg.sdkUrls[name]) {
        if (name === 'gamedistribution') new PROVIDERS.gamedistribution(); // installs GD_OPTIONS before load
        await loadScript(cfg.sdkUrls[name]);
      }
      if (!hasGlobal(name)) {
        console.warn(`[ads] ${name} SDK not found on the page — falling back to ${cfg.simulate ? 'dev' : 'none'}`);
        name = cfg.simulate ? 'dev' : 'none';
      }
    }
    this.impl = new PROVIDERS[name]();
    try {
      await Promise.race([this.impl.init(), new Promise((r) => setTimeout(r, 4000))]);
    } catch {
      /* never block the game on an SDK */
    }
    this.impl.loadingStart?.();
    this.analytics?.track('ads_init', { provider: name });
    return name;
  }

  loadingFinished() {
    this.ready.then(() => this.impl.loadingFinished());
  }

  gameplayStart() {
    if (this.inGameplay || this.busy) return;
    this.inGameplay = true;
    this.impl.gameplayStart();
  }

  gameplayStop() {
    if (!this.inGameplay) return;
    this.inGameplay = false;
    this.impl.gameplayStop();
  }

  happyTime() {
    this.impl.happyTime();
  }

  noteMatchEnd() {
    this.matchesSince++;
  }

  /** Frequency cap: every Nth match, never too often, and not before the player's first win (or grace). */
  interstitialDue() {
    const cap = CONFIG.ads.interstitial;
    if (!cap.enabled || !this.impl.showsAds) return false;
    if (this.impl.selfCapped && cap.trustPortalCap) return true;
    const stats = this.ctx.services?.economy?.stats ?? { wins: 0, matches: 0 };
    if (cap.requireFirstWin && stats.wins < 1 && stats.matches < cap.graceMatches) return false;
    if (this.matchesSince < cap.everyNMatches) return false;
    if (this.lastInterstitialAt && performance.now() - this.lastInterstitialAt < cap.minSecondsBetween * 1000) return false;
    return true;
  }

  async showInterstitial(placement = 'between_matches') {
    await this.ready;
    if (this.busy || !this.interstitialDue()) return false;
    this.analytics?.track('ad_requested', { type: 'interstitial', placement, provider: this.provider });
    const shown = await this.run((hooks) => this.impl.interstitial(hooks), 'interstitial', placement);
    if (shown) {
      this.matchesSince = 0;
      this.lastInterstitialAt = performance.now();
    }
    return shown;
  }

  async showRewarded(placement = 'rewarded') {
    await this.ready;
    if (this.busy) return false;
    this.analytics?.track('ad_requested', { type: 'rewarded', placement, provider: this.provider });
    const ok = await this.run((hooks) => this.impl.rewarded(hooks), 'rewarded', placement);
    this.analytics?.track(ok ? 'ad_rewarded' : 'ad_reward_denied', { placement, provider: this.provider });
    return ok;
  }

  async run(fn, type, placement) {
    this.busy = true;
    const wasPlaying = this.inGameplay;
    if (wasPlaying) this.gameplayStop();
    let started = false;
    const hooks = {
      onStart: () => {
        if (started) return;
        started = true;
        this.pause?.acquire('ad');
        this.analytics?.track('ad_started', { type, placement, provider: this.provider });
      },
    };
    let result = false;
    try {
      result = !!(await fn(hooks));
    } catch (e) {
      this.analytics?.track('ad_error', { type, placement, provider: this.provider, error: String(e?.message ?? e) });
    } finally {
      if (started) this.pause?.release('ad');
      this.busy = false;
      if (wasPlaying) this.gameplayStart();
    }
    this.analytics?.track('ad_finished', { type, placement, provider: this.provider, started, result });
    return result;
  }
}
