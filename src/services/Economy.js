import { SKINS, getSkin } from '../game/skins.js';

/**
 * Soft currency ("Gotas"), skins, rewards. Contract:
 *   economy.coins, economy.owned (Set), economy.equippedSkin
 *   economy.rewardFor({ place, peakVolume, total }) -> coins
 *   economy.grant(coins, reason), economy.buy(skinId) -> bool, economy.equip(skinId)
 */
export class Economy {
  constructor(ctx, storage, analytics) {
    this.ctx = ctx;
    this.storage = storage;
    this.analytics = analytics;
    this.coins = storage.get('coins', 0);
    this.owned = new Set(storage.get('owned', ['clear']));
    this.equippedSkin = storage.get('equipped', 'clear');
    this.stats = storage.get('stats', { matches: 0, wins: 0, bestPlace: 99 });
  }

  save() {
    this.storage.set('coins', this.coins);
    this.storage.set('owned', [...this.owned]);
    this.storage.set('equipped', this.equippedSkin);
    this.storage.set('stats', this.stats);
  }

  rewardFor({ place, peakVolume, total = 16 }) {
    const placeBonus = Math.round(((total - place + 1) / total) * 120);
    const volumeBonus = Math.round(Math.log10(Math.max(peakVolume, 1e4) / 1e4) * 30);
    return (place === 1 ? 150 : 0) + placeBonus + volumeBonus + 10;
  }

  grant(coins, reason) {
    this.coins += coins;
    this.save();
    this.analytics.track('coins_granted', { coins, reason });
  }

  buy(id) {
    const skin = getSkin(id);
    if (this.owned.has(id) || this.coins < skin.price) return false;
    this.coins -= skin.price;
    this.owned.add(id);
    this.save();
    this.analytics.track('skin_bought', { id, price: skin.price });
    return true;
  }

  equip(id) {
    if (!this.owned.has(id)) return false;
    this.equippedSkin = id;
    this.save();
    return true;
  }

  recordMatch(place) {
    this.stats.matches++;
    if (place === 1) this.stats.wins++;
    this.stats.bestPlace = Math.min(this.stats.bestPlace, place);
    this.save();
  }

  get catalog() {
    return SKINS;
  }
}
