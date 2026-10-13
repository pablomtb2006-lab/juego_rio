import { SKINS, getSkin } from '../game/skins.js';
import { UPGRADES, nextCost } from '../game/upgrades.js';
import { CONFIG } from './config.js';

const E = CONFIG.economy;

/** Local calendar day as 'YYYY-MM-DD' (daily rewards follow the player's clock, like most mobile games). */
export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysBetween(a, b) {
  const pa = new Date(`${a}T12:00:00`);
  const pb = new Date(`${b}T12:00:00`);
  return Math.round((pb - pa) / 86400000);
}

/**
 * Soft currency ("Gotas"), skins, stats, daily streak. Contract (kept from the skeleton):
 *   economy.coins, economy.owned (Set), economy.equippedSkin, economy.stats
 *   economy.rewardFor({ place, peakVolume, total }) -> coins
 *   economy.grant(coins, reason), economy.buy(skinId) -> bool, economy.equip(skinId) -> bool
 *   economy.recordMatch(place)
 * Added:
 *   economy.settleMatch({ outcome, place, total, peakVolume, cuts, eliminations, objectives, duration })
 *       -> { items: [{ key, amount, detail }], total }   (grants + records stats once)
 *   economy.dailyStatus() / economy.claimDaily(multiplier)
 *   economy.freeCoinsLeft() / economy.claimFreeCoins()
 *   economy.onChange(fn) -> unsubscribe
 */
export class Economy {
  constructor(ctx, storage, analytics) {
    this.ctx = ctx;
    this.storage = storage;
    this.analytics = analytics;
    this.listeners = new Set();
    this.coins = Math.max(0, Number(storage.get('coins', E.startingCoins)) || 0);
    const owned = storage.get('owned', ['clear']);
    this.owned = new Set(Array.isArray(owned) ? owned : ['clear']);
    this.owned.add('clear');
    this.equippedSkin = storage.get('equipped', 'clear');
    if (!this.owned.has(this.equippedSkin)) this.equippedSkin = 'clear';
    this.stats = {
      matches: 0,
      wins: 0,
      top3: 0,
      bestPlace: 99,
      bestVolume: 0,
      totalLitres: 0,
      cuts: 0,
      eliminations: 0,
      // per-world record (game/biomes.js): { <biomeId>: { played, wins, best } }. Six worlds
      // to conquer is a reason to press play on a world you have not beaten yet.
      worlds: {},
      ...(storage.get('stats', {}) ?? {}),
    };
    this.daily = { last: null, streak: 0, ...(storage.get('daily', {}) ?? {}) };
    this.flags = { firstWinDay: null, freeDay: null, freeCount: 0, seen: [], ...(storage.get('flags', {}) ?? {}) };
    this.upgrades = { ...(storage.get('upgrades', {}) ?? {}) };
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(reason) {
    for (const fn of this.listeners) {
      try {
        fn(this, reason);
      } catch (e) {
        console.error(e);
      }
    }
  }

  save() {
    this.storage.set('coins', this.coins);
    this.storage.set('owned', [...this.owned]);
    this.storage.set('equipped', this.equippedSkin);
    this.storage.set('stats', this.stats);
    this.storage.set('daily', this.daily);
    this.storage.set('flags', this.flags);
    this.storage.set('upgrades', this.upgrades);
  }

  get catalog() {
    return SKINS;
  }

  // --- match rewards ------------------------------------------------------------

  rewardFor({ place, peakVolume, total = 16 }) {
    return this.breakdown({ outcome: place === 1 ? 'win' : 'eliminated', place, peakVolume, total, firstWin: false }).total;
  }

  /** Itemised reward for a finished match (does not grant). */
  breakdown({ outcome, place, peakVolume = 0, total = 16, cuts = 0, eliminations = 0, objectives = 0, objectivesDone = 0, firstWin }) {
    const items = [];
    const quit = outcome === 'quit';
    items.push({ key: 'participation', amount: E.participation });
    if (!quit && place > 0) {
      const p = Math.round(((total - place + 1) / total) * E.placementMax);
      items.push({ key: 'placement', amount: p, detail: `#${place}` });
    }
    if (!quit && place === 1 && outcome === 'win') items.push({ key: 'victory', amount: E.victory });
    else if (!quit && outcome === 'win' && place <= 3) items.push({ key: 'podium', amount: E.podium });
    const vol = Math.round(Math.log10(Math.max(peakVolume, 1e4) / 1e4) * E.volumePerDecade);
    if (vol > 0) items.push({ key: 'volume', amount: vol, detail: peakVolume });
    if (cuts > 0) items.push({ key: 'cuts', amount: cuts * E.perCut, detail: cuts });
    if (eliminations > 0) items.push({ key: 'eliminations', amount: eliminations * E.perElimination, detail: eliminations });
    if (objectives > 0) items.push({ key: 'objectives', amount: objectives, detail: objectivesDone });
    const fw = firstWin ?? (place === 1 && outcome === 'win' && this.flags.firstWinDay !== dayKey());
    if (fw) items.push({ key: 'firstWin', amount: E.firstWinOfDay });
    return { items, total: items.reduce((a, i) => a + i.amount, 0) };
  }

  /** Grant the match reward, update stats; call exactly once per match. */
  settleMatch({ outcome, place, total = 16, peakVolume = 0, cuts = 0, eliminations = 0, objectives = 0, objectivesDone = 0, duration = 0, biome = null }) {
    const result = this.breakdown({ outcome, place, total, peakVolume, cuts, eliminations, objectives, objectivesDone });
    if (result.items.some((i) => i.key === 'firstWin')) this.flags.firstWinDay = dayKey();
    this.recordMatch(place, { outcome, peakVolume, cuts, eliminations, duration, biome }, false);
    this.grant(result.total, 'match');
    return result;
  }

  grant(coins, reason) {
    coins = Math.max(0, Math.round(coins || 0));
    if (!coins) return;
    this.coins += coins;
    this.save();
    this.analytics?.track('coins_granted', { coins, reason, balance: this.coins });
    this.emit('grant');
  }

  recordMatch(place, extra = {}, save = true) {
    const s = this.stats;
    s.matches++;
    const won = place === 1 && (extra.outcome ?? 'win') === 'win';
    if (won) s.wins++;
    if (place > 0 && place <= 3 && extra.outcome !== 'eliminated') s.top3++;
    if (place > 0) s.bestPlace = Math.min(s.bestPlace, place);
    s.bestVolume = Math.max(s.bestVolume, Math.round(extra.peakVolume ?? 0));
    s.totalLitres += Math.round(extra.peakVolume ?? 0);
    s.cuts += extra.cuts ?? 0;
    s.eliminations += extra.eliminations ?? 0;
    if (extra.biome) {
      s.worlds = s.worlds ?? {};
      const w = (s.worlds[extra.biome] = s.worlds[extra.biome] ?? { played: 0, wins: 0, best: 99 });
      w.played++;
      if (won) w.wins++;
      if (place > 0) w.best = Math.min(w.best, place);
    }
    if (save) {
      this.save();
      this.emit('stats');
    }
  }

  /** Account level derived from career stats (no extra persistence): { level, progress 0..1, xp } */
  get level() {
    const s = this.stats;
    const xp = s.matches * 40 + s.wins * 250 + s.top3 * 60 + s.cuts * 10 + s.eliminations * 20;
    const level = 1 + Math.floor(Math.sqrt(xp / 120));
    const at = (l) => 120 * (l - 1) * (l - 1);
    return { level, xp, progress: (xp - at(level)) / (at(level + 1) - at(level)) };
  }

  // --- upgrades (progression) --------------------------------------------------------

  upgradeLevel(id) {
    return this.upgrades[id] | 0;
  }

  /** Buy the next level of an upgrade. Returns true on success. */
  buyUpgrade(id) {
    if (!UPGRADES.some((u) => u.id === id)) return false;
    const level = this.upgradeLevel(id);
    const cost = nextCost(id, level);
    if (cost == null || this.coins < cost) return false;
    this.coins -= cost;
    this.upgrades[id] = level + 1;
    this.save();
    this.analytics?.track('upgrade', { id, level: level + 1, price: cost, balance: this.coins });
    this.emit('upgrade');
    return true;
  }

  // --- skins ----------------------------------------------------------------------

  buy(id) {
    const skin = getSkin(id);
    if (!skin || skin.id !== id || this.owned.has(id) || this.coins < skin.price) return false;
    this.coins -= skin.price;
    this.owned.add(id);
    this.save();
    this.analytics?.track('purchase', { item: id, price: skin.price, currency: E.currency, rarity: skin.rarity, balance: this.coins });
    this.emit('buy');
    return true;
  }

  equip(id) {
    if (!this.owned.has(id)) return false;
    this.equippedSkin = id;
    this.save();
    this.analytics?.track('equip', { item: id });
    this.emit('equip');
    return true;
  }

  /** Skins the player has not looked at yet (drives the "NEW" badge in the locker). */
  markSeen(id) {
    if (this.flags.seen.includes(id)) return;
    this.flags.seen.push(id);
    this.save();
  }

  // --- daily streak ---------------------------------------------------------------

  dailyStatus(today = dayKey()) {
    const { last, streak } = this.daily;
    const gap = last ? daysBetween(last, today) : Infinity;
    const claimable = gap >= 1;
    // streak continues only if the last claim was yesterday; after day 7 the calendar restarts
    let nextStreak = gap === 1 ? streak + 1 : 1;
    if (nextStreak > E.daily.length) nextStreak = 1;
    const day = claimable ? nextStreak : Math.max(1, streak);
    return { claimable, day, streak: claimable ? nextStreak - 1 : streak, rewards: E.daily, amount: E.daily[day - 1] };
  }

  claimDaily(multiplier = 1) {
    const st = this.dailyStatus();
    if (!st.claimable) return 0;
    this.daily = { last: dayKey(), streak: st.day };
    const amount = st.amount * multiplier;
    this.save();
    this.analytics?.track('daily_claim', { day: st.day, amount, multiplier });
    this.grant(amount, 'daily');
    return amount;
  }

  // --- rewarded "free gotas" in the shop -------------------------------------------

  freeCoinsLeft() {
    if (this.flags.freeDay !== dayKey()) return CONFIG.ads.rewarded.freeCoinsPerDay;
    return Math.max(0, CONFIG.ads.rewarded.freeCoinsPerDay - this.flags.freeCount);
  }

  claimFreeCoins() {
    if (this.freeCoinsLeft() <= 0) return 0;
    if (this.flags.freeDay !== dayKey()) {
      this.flags.freeDay = dayKey();
      this.flags.freeCount = 0;
    }
    this.flags.freeCount++;
    this.grant(E.freeCoinsAd, 'ad_free_coins');
    return E.freeCoinsAd;
  }
}
