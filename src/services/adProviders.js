import { CONFIG } from './config.js';

/**
 * Portal ad adapters. Every provider implements the same small surface:
 *   name, showsAds, selfCapped
 *   init() · loadingStart() · loadingFinished() · gameplayStart() · gameplayStop() · happyTime()
 *   interstitial(hooks) -> Promise<boolean shown>
 *   rewarded(hooks)     -> Promise<boolean granted>
 * `hooks.onStart()` must be called right before an ad covers the game (the facade pauses + mutes).
 * No provider ever throws out of these methods; failures resolve to false.
 */

class NoneProvider {
  name = 'none';
  showsAds = false;
  selfCapped = false;
  async init() {}
  loadingStart() {}
  loadingFinished() {}
  gameplayStart() {}
  gameplayStop() {}
  happyTime() {}
  async interstitial() {
    return false;
  }
  async rewarded() {
    return !!CONFIG.ads.grantWithoutProvider;
  }
}

/** Dev / QA provider: a fake ad with a countdown, so every flow can be exercised without an SDK. */
class DevProvider extends NoneProvider {
  name = 'dev';
  showsAds = true;

  show(kind, hooks) {
    hooks.onStart?.();
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.className = 'dev-ad';
      el.setAttribute('role', 'dialog');
      const secs = CONFIG.ads.simulatedSeconds;
      el.innerHTML = `
        <div class="dev-ad__box">
          <div class="dev-ad__tag">AD · ${kind === 'rewarded' ? 'REWARDED' : 'INTERSTITIAL'}</div>
          <div class="dev-ad__title">Simulated advert</div>
          <div class="dev-ad__count">${Math.ceil(secs)}</div>
          <div class="dev-ad__bar"><i></i></div>
          <button class="dev-ad__skip" type="button">${kind === 'rewarded' ? 'Close (no reward)' : 'Skip'}</button>
        </div>`;
      Object.assign(el.style, {
        position: 'fixed', inset: '0', zIndex: '1000', display: 'grid', placeItems: 'center',
        background: 'rgba(3,10,20,.92)', color: '#fff', font: '700 16px Inter, system-ui, sans-serif',
      });
      const box = el.querySelector('.dev-ad__box');
      Object.assign(box.style, { textAlign: 'center', display: 'grid', gap: '12px', width: 'min(320px, 80vw)' });
      el.querySelector('.dev-ad__tag').style.cssText = 'opacity:.6;letter-spacing:2px;font-size:12px';
      el.querySelector('.dev-ad__count').style.cssText = 'font:400 72px "Luckiest Guy", Impact, sans-serif;color:#FFD23F';
      el.querySelector('.dev-ad__bar').style.cssText = 'height:6px;background:rgba(255,255,255,.15);border-radius:3px;overflow:hidden';
      const fill = el.querySelector('.dev-ad__bar i');
      fill.style.cssText = `display:block;height:100%;width:0;background:#FFD23F;transition:width ${secs}s linear`;
      const skip = el.querySelector('.dev-ad__skip');
      skip.style.cssText = 'margin-top:8px;background:none;border:1px solid rgba(255,255,255,.3);color:#fff;border-radius:8px;padding:10px;font:inherit;cursor:pointer';
      document.body.appendChild(el);
      requestAnimationFrame(() => (fill.style.width = '100%'));
      const t0 = performance.now();
      const count = el.querySelector('.dev-ad__count');
      const timer = setInterval(() => {
        const left = Math.max(0, secs - (performance.now() - t0) / 1000);
        count.textContent = String(Math.ceil(left));
        if (left <= 0) done(true);
      }, 100);
      const done = (ok) => {
        clearInterval(timer);
        el.remove();
        resolve(ok);
      };
      skip.onclick = () => done(kind !== 'rewarded');
    });
  }

  async interstitial(hooks) {
    return this.show('interstitial', hooks);
  }
  async rewarded(hooks) {
    return this.show('rewarded', hooks);
  }
}

/** Poki SDK v2 — https://sdk.poki.com */
class PokiProvider extends NoneProvider {
  name = 'poki';
  showsAds = true;
  selfCapped = true;
  get sdk() {
    return window.PokiSDK;
  }
  async init() {
    try {
      await this.sdk.init();
    } catch {
      /* adblock: the game must still run */
    }
  }
  loadingFinished() {
    safe(() => this.sdk.gameLoadingFinished());
  }
  gameplayStart() {
    safe(() => this.sdk.gameplayStart());
  }
  gameplayStop() {
    safe(() => this.sdk.gameplayStop());
  }
  happyTime() {
    safe(() => this.sdk.happyTime?.(1));
  }
  async interstitial(hooks) {
    try {
      let started = false;
      await this.sdk.commercialBreak(() => {
        started = true;
        hooks.onStart?.();
      });
      return started;
    } catch {
      return false;
    }
  }
  async rewarded(hooks) {
    try {
      return !!(await this.sdk.rewardedBreak(() => hooks.onStart?.()));
    } catch {
      return false;
    }
  }
}

/** CrazyGames HTML5 SDK v3 — https://docs.crazygames.com */
class CrazyGamesProvider extends NoneProvider {
  name = 'crazygames';
  showsAds = true;
  selfCapped = true;
  get sdk() {
    return window.CrazyGames?.SDK;
  }
  async init() {
    try {
      await this.sdk.init?.();
    } catch {
      /* ignore */
    }
  }
  loadingStart() {
    safe(() => this.sdk.game.loadingStart());
  }
  loadingFinished() {
    safe(() => this.sdk.game.loadingStop());
  }
  gameplayStart() {
    safe(() => this.sdk.game.gameplayStart());
  }
  gameplayStop() {
    safe(() => this.sdk.game.gameplayStop());
  }
  happyTime() {
    safe(() => this.sdk.game.happytime());
  }
  request(type, hooks) {
    return new Promise((resolve) => {
      try {
        this.sdk.ad.requestAd(type, {
          adStarted: () => hooks.onStart?.(),
          adFinished: () => resolve(true),
          adError: () => resolve(false),
        });
      } catch {
        resolve(false);
      }
    });
  }
  interstitial(hooks) {
    return this.request('midgame', hooks);
  }
  rewarded(hooks) {
    return this.request('rewarded', hooks);
  }
}

/**
 * GameDistribution HTML5 SDK. The page must define window.GD_OPTIONS = { gameId } before the SDK
 * loads; we wrap its onEvent to learn when a rewarded ad was fully watched.
 */
class GameDistributionProvider extends NoneProvider {
  name = 'gamedistribution';
  showsAds = true;
  selfCapped = false;
  constructor() {
    super();
    this.rewardSeen = false;
    installGdOptions((e) => {
      if (e?.name === 'SDK_REWARDED_WATCH_COMPLETE') this.rewardSeen = true;
    });
  }
  get sdk() {
    return window.gdsdk;
  }
  async interstitial(hooks) {
    try {
      hooks.onStart?.();
      await this.sdk.showAd();
      return true;
    } catch {
      return false;
    }
  }
  async rewarded(hooks) {
    this.rewardSeen = false;
    try {
      hooks.onStart?.();
      await this.sdk.showAd('rewarded');
      return true;
    } catch {
      return this.rewardSeen;
    }
  }
}

function installGdOptions(listener) {
  const opts = (window.GD_OPTIONS = window.GD_OPTIONS ?? { gameId: CONFIG.ads.gameDistribution.gameId });
  const prev = opts.onEvent;
  opts.onEvent = (e) => {
    try {
      prev?.(e);
    } finally {
      listener(e);
    }
  };
}

function safe(fn) {
  try {
    fn();
  } catch {
    /* SDK missing a method / blocked */
  }
}

export const PROVIDERS = {
  none: NoneProvider,
  dev: DevProvider,
  poki: PokiProvider,
  crazygames: CrazyGamesProvider,
  gamedistribution: GameDistributionProvider,
};

/** Which portal SDK global is present on the page (null if none). */
export function detectPortal() {
  if (typeof window === 'undefined') return null;
  if (window.PokiSDK) return 'poki';
  if (window.CrazyGames?.SDK) return 'crazygames';
  if (window.gdsdk) return 'gamedistribution';
  return null;
}

const GLOBAL_OF = {
  poki: () => window.PokiSDK,
  crazygames: () => window.CrazyGames?.SDK,
  gamedistribution: () => window.gdsdk,
};

export function hasGlobal(name) {
  return !!GLOBAL_OF[name]?.();
}

/** Inject a portal SDK script (only when CONFIG.ads.loadSdk is explicitly enabled). */
export function loadScript(src, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    const t = setTimeout(() => resolve(false), timeoutMs);
    s.onload = () => {
      clearTimeout(t);
      resolve(true);
    };
    s.onerror = () => {
      clearTimeout(t);
      resolve(false);
    };
    document.head.appendChild(s);
  });
}
