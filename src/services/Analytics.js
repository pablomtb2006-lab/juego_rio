import { CONFIG } from './config.js';

/**
 * Funnel analytics. `track(event, data)` never throws and never blocks.
 *
 * Funnel (in order): session_start → menu_view → match_start → landed → (eliminated | finished)
 *   → match_end → [ad_* / shop_view / purchase / daily_claim / share]
 * Sinks: in-memory queue (window.__analytics in ?debug=1), window.gtag / dataLayer when the host
 * provides them, and an optional HTTP endpoint (batched with sendBeacon) from config.js.
 */
export class Analytics {
  constructor(ctx, storage) {
    this.ctx = ctx;
    this.storage = storage;
    this.queue = [];
    this.outbox = [];
    this.last = new Map();
    this.session = Math.random().toString(36).slice(2, 10);

    const now = Date.now();
    this.user = storage?.get('uid', null);
    if (!this.user) {
      this.user = `u_${Math.random().toString(36).slice(2, 12)}`;
      storage?.set('uid', this.user);
    }
    const firstSeen = storage?.get('firstSeen', null) ?? now;
    storage?.set('firstSeen', firstSeen);
    this.sessionCount = (storage?.get('sessions', 0) ?? 0) + 1;
    storage?.set('sessions', this.sessionCount);
    this.daysSinceInstall = Math.floor((now - firstSeen) / 86400000);

    if (ctx.params?.debug) window.__analytics = this;
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => this.flush());
      document.addEventListener?.('visibilitychange', () => document.visibilityState === 'hidden' && this.flush());
    }
    this.track('session_start', { session: this.sessionCount, day: this.daysSinceInstall, lang: navigator.language });
  }

  /** Listen to gameplay events so the funnel does not depend on the UI being shown. */
  attach(bus, game) {
    let matchStart = 0;
    bus.on('phase', ({ state }) => {
      if (state === 'menu') this.track('menu_view');
      if (state === 'drop') {
        matchStart = performance.now();
        this.track('match_start', { skin: game()?.player?.skin });
      }
    });
    bus.on('landed', ({ stream }) => {
      if (stream?.isPlayer) this.track('landed', { t: secs(matchStart) });
    });
    bus.on('eliminated', ({ victim, by, reason }) => {
      if (victim?.isPlayer) this.track('eliminated', { place: victim.place, reason, by: by?.name ?? null, t: secs(matchStart) });
    });
    bus.on('finished', ({ stream, place }) => {
      if (stream?.isPlayer) this.track('finished', { place, t: secs(matchStart) });
    });
    bus.on('matchEnd', ({ outcome, place, player }) => {
      this.track('match_end', { outcome, place, peak: Math.round(player?.peakVolume ?? 0), t: secs(matchStart) });
    });
  }

  track(event, data = {}) {
    try {
      // The game core also tracks some funnel steps; collapse duplicates fired in the same instant.
      const prev = this.last.get(event);
      const now = performance.now();
      if (prev != null && now - prev < 400 && (event === 'match_start' || event === 'menu_view')) return;
      this.last.set(event, now);

      const entry = { event, data, t: Date.now(), s: this.session, u: this.user };
      this.queue.push(entry);
      if (this.queue.length > CONFIG.analytics.maxQueue) this.queue.shift();
      if (this.ctx.params?.debug) console.debug('[analytics]', event, data);

      if (CONFIG.analytics.forwardToGtag) {
        if (typeof window.gtag === 'function') window.gtag('event', event, data);
        else if (Array.isArray(window.dataLayer)) window.dataLayer.push({ event, ...data });
      }
      if (CONFIG.analytics.endpoint) {
        this.outbox.push(entry);
        if (this.outbox.length >= 20) this.flush();
      }
    } catch {
      /* analytics must never break the game */
    }
  }

  flush() {
    if (!CONFIG.analytics.endpoint || !this.outbox.length) return;
    try {
      const body = JSON.stringify(this.outbox.splice(0));
      if (!navigator.sendBeacon?.(CONFIG.analytics.endpoint, body)) {
        fetch(CONFIG.analytics.endpoint, { method: 'POST', body, keepalive: true }).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }
}

const secs = (t0) => Math.round((performance.now() - t0) / 100) / 10;
