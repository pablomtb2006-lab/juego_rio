/**
 * localStorage wrapper that never throws (private mode, blocked storage, sandboxed iframes,
 * quota errors, corrupted JSON). An in-memory copy keeps the session consistent when the
 * browser refuses to persist.
 */
export class Storage {
  constructor(namespace) {
    this.ns = namespace;
    this.memory = new Map();
    this.persistent = Storage.probe();
  }

  static probe() {
    try {
      const k = '__rr_probe__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    } catch {
      return false;
    }
  }

  get(key, fallback = null) {
    if (this.memory.has(key)) return clone(this.memory.get(key));
    if (!this.persistent) return fallback;
    try {
      const raw = localStorage.getItem(`${this.ns}:${key}`);
      if (raw == null) return fallback;
      const value = JSON.parse(raw);
      this.memory.set(key, value);
      return clone(value);
    } catch {
      return fallback;
    }
  }

  set(key, value) {
    this.memory.set(key, clone(value));
    if (!this.persistent) return;
    try {
      localStorage.setItem(`${this.ns}:${key}`, JSON.stringify(value));
    } catch {
      /* quota / blocked — the memory copy is enough for this session */
    }
  }

  remove(key) {
    this.memory.delete(key);
    try {
      localStorage.removeItem(`${this.ns}:${key}`);
    } catch {
      /* ignore */
    }
  }
}

function clone(v) {
  return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
}
