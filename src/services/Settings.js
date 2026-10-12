/**
 * Player settings, persisted. Contract:
 *   settings.get(key), settings.set(key, value), settings.onChange(fn) -> unsubscribe
 * Keys: lang ('auto'|'es'|'en'), quality ('auto'|'low'|'medium'|'high'|'ultra'),
 *       master / music / sfx (0..1), nameTags (bool), haptics (bool), playerName (string)
 */
export const DEFAULT_SETTINGS = {
  lang: 'auto',
  quality: 'auto',
  master: 1,
  music: 0.7,
  sfx: 1,
  nameTags: true,
  haptics: true,
};

export class Settings {
  constructor(storage) {
    this.storage = storage;
    this.values = { ...DEFAULT_SETTINGS, ...(storage.get('settings', {}) ?? {}) };
    this.listeners = new Set();
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    if (this.values[key] === value) return;
    this.values[key] = value;
    this.storage.set('settings', this.values);
    for (const fn of this.listeners) fn(key, value);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
