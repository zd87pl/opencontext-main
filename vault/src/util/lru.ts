/**
 * Minimal least-recently-used cache on top of Map's insertion order. Exists so source bodies (and the search
 * layer's per-source data) stay bounded in memory no matter how large an import was.
 */
export class Lru<K, V> {
  private readonly map = new Map<K, V>();

  constructor(public readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new RangeError('Lru capacity must be a non-negative integer');
    }
  }

  /** Returns the value and marks it most recently used. */
  get(k: K): V | undefined {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k) as V;
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }

  /** Inserts or replaces; evicts the least recently used entries beyond capacity. */
  set(k: K, v: V): void {
    if (this.capacity === 0) return;
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  delete(k: K): void {
    this.map.delete(k);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
