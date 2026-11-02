// Короткоживущий кэш в памяти процесса. Хранит только справочники
// (воронки, стадии, валюта, имена сотрудников) и контекст сессии —
// сами сделки не кэшируются. Записи истекают по TTL, размер ограничен.

export class TtlCache {
  constructor({ ttlMs, maxEntries = 500, now = () => Date.now() }) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.map = new Map();
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= this.now()) { this.map.delete(key); return undefined; }
    return e.value;
  }

  set(key, value) {
    if (this.map.size >= this.maxEntries) {
      const t = this.now();
      for (const [k, e] of this.map) if (e.expires <= t) this.map.delete(k);
      while (this.map.size >= this.maxEntries) this.map.delete(this.map.keys().next().value);
    }
    this.map.set(key, { value, expires: this.now() + this.ttlMs });
  }

  async getOrLoad(key, loader) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await loader();
    this.set(key, value);
    return value;
  }
}
