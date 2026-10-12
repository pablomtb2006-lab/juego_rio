/** localStorage wrapper that never throws (private mode, blocked storage, sandboxed iframes). */
export class Storage {
  constructor(namespace) {
    this.ns = namespace;
    this.memory = new Map();
  }

  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(`${this.ns}:${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return this.memory.has(key) ? this.memory.get(key) : fallback;
    }
  }

  set(key, value) {
    this.memory.set(key, value);
    try {
      localStorage.setItem(`${this.ns}:${key}`, JSON.stringify(value));
    } catch {
      /* storage unavailable — memory copy is enough for this session */
    }
  }
}
