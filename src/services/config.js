/**
 * Monetisation / distribution config. Everything a portal build needs to tweak lives here,
 * so shipping to Poki / CrazyGames / GameDistribution is a config change, not a code change.
 *
 * URL overrides (handy for QA on a portal's test page):
 *   ?ads=none|dev|poki|crazygames|gamedistribution   force an ad provider
 *   ?fakeads=1                                      simulate ads with an on-screen countdown
 */
const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');

export const CONFIG = {
  version: '0.2.0',

  ads: {
    /** 'auto' detects PokiSDK / CrazyGames.SDK / gdsdk globals; otherwise 'none'. */
    provider: q.get('ads') ?? 'auto',
    /**
     * Never inject third-party scripts unless explicitly enabled for a portal build.
     * Portals normally inject their SDK themselves (or you add the <script> to index.html).
     */
    loadSdk: false,
    sdkUrls: {
      poki: 'https://game-cdn.poki.com/scripts/v2/poki-sdk.js',
      crazygames: 'https://sdk.crazygames.com/crazygames-sdk-v3.js',
      gamedistribution: 'https://html5.api.gamedistribution.com/main.min.js',
    },
    gameDistribution: { gameId: '' },
    /** Simulated ads (countdown overlay) when no SDK is present: on in dev, or with ?fakeads=1. */
    simulate: q.get('fakeads') === '1' || (import.meta.env?.DEV && q.get('fakeads') !== '0'),
    /** Seconds the simulated ad lasts. */
    simulatedSeconds: 2.5,
    /** When no ad provider exists (e.g. self-hosted on itch.io) rewarded buttons grant for free. */
    grantWithoutProvider: true,
    interstitial: {
      enabled: true,
      everyNMatches: 3, // at most one interstitial every N finished matches
      minSecondsBetween: 75, // and never more often than this
      requireFirstWin: true, // protect brand-new players: nothing until their first win…
      graceMatches: 6, // …or until they have played this many matches
      /** Poki / CrazyGames rate-limit breaks server-side and ask you to call on every break. */
      trustPortalCap: true,
    },
    rewarded: {
      revivePerMatch: 1,
      freeCoinsPerDay: 5,
    },
  },

  economy: {
    currency: 'gotas',
    startingCoins: 0,
    participation: 10,
    placementMax: 120, // scaled by (total - place + 1) / total
    victory: 150,
    podium: 40, // #2 and #3
    volumePerDecade: 30, // per ×10 litres of peak volume above 10,000 L
    perCut: 15,
    perElimination: 25,
    firstWinOfDay: 250,
    freeCoinsAd: 60,
    /** 7-day streak calendar; the cycle restarts after day 7. Missing a day resets it. */
    daily: [50, 75, 100, 150, 200, 300, 600],
  },

  analytics: {
    /** POST batches to this URL with navigator.sendBeacon (null = keep local only). */
    endpoint: null,
    /** Forward events to window.gtag / window.dataLayer when the host page provides them. */
    forwardToGtag: true,
    maxQueue: 300,
  },

  share: {
    /** Canonical URL to share; null = the page the game is running on (portal page, itch…). */
    url: null,
    hashtags: ['RioRoyale'],
  },
};
