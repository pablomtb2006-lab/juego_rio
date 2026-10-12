/**
 * Ad abstraction so the game can ship to different portals without code changes.
 * Default provider is a no-op (resolves immediately, rewarded = granted) for dev.
 * Contract:
 *   ads.showRewarded(placement) -> Promise<boolean>   (true = reward earned)
 *   ads.showInterstitial(placement) -> Promise<void>
 *   ads.gameplayStart() / ads.gameplayStop()          (portal SDK lifecycle hooks)
 */
export class Ads {
  constructor(ctx, analytics) {
    this.ctx = ctx;
    this.analytics = analytics;
    this.provider = 'none';
  }

  async showRewarded(placement) {
    this.analytics.track('ad_rewarded', { placement, provider: this.provider });
    return true;
  }

  async showInterstitial(placement) {
    this.analytics.track('ad_interstitial', { placement, provider: this.provider });
  }

  gameplayStart() {}
  gameplayStop() {}
}
