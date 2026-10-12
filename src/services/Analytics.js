/** Analytics hook. Swap `send` for a real backend (GameAnalytics, PostHog…) when monetising. */
export class Analytics {
  constructor(ctx) {
    this.ctx = ctx;
    this.queue = [];
  }

  track(event, data = {}) {
    const entry = { event, data, t: Date.now() };
    this.queue.push(entry);
    if (this.queue.length > 200) this.queue.shift();
    if (this.ctx.params.debug) console.debug('[analytics]', event, data);
  }
}
