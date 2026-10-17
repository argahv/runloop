/**
 * An immutable id → value map with cheap updates. Entries live in 64
 * buckets; `set` copies the bucket list and the one bucket it touches, so an
 * update costs O(size / 64) instead of O(size). Layer 1 keeps tool calls here:
 * a plain object copied on every event made folding a long run quadratic
 * (a 9,000-call session took ~47 s).
 *
 * Inside a batch fold (`transient` in reduce-execution.ts) the maps and
 * buckets the batch created are updated in place: O(1) per update.
 */
const BUCKETS = 64;

/** FNV-1a: a stable bucket for an id. */
function bucketOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % BUCKETS;
}

export class IdMap<V> {
  private constructor(
    private buckets: Map<string, V>[],
    private count: number,
  ) {}

  static empty<V>(): IdMap<V> {
    return new IdMap<V>(Array.from({ length: BUCKETS }, () => new Map<string, V>()), 0);
  }

  static from<V>(entries: Iterable<readonly [string, V]>): IdMap<V> {
    let m = IdMap.empty<V>();
    for (const [id, v] of entries) m = m.set(id, v);
    return m;
  }

  get size(): number {
    return this.count;
  }

  get(id: string): V | undefined {
    return this.buckets[bucketOf(id)]!.get(id);
  }

  has(id: string): boolean {
    return this.buckets[bucketOf(id)]!.has(id);
  }

  /**
   * The map with `id` set to `value`. `owned` holds the objects the current
   * batch fold created: those are updated in place (nothing else can see them).
   */
  set(id: string, value: V, owned: WeakSet<object> | null = null): IdMap<V> {
    const b = bucketOf(id);
    let bucket = this.buckets[b]!;
    if (!owned?.has(bucket)) {
      bucket = new Map(bucket);
      owned?.add(bucket);
    }
    const added = bucket.has(id) ? 0 : 1;
    bucket.set(id, value);
    if (owned?.has(this)) {
      this.buckets[b] = bucket;
      this.count += added;
      return this;
    }
    const buckets = this.buckets.slice();
    buckets[b] = bucket;
    const next = new IdMap(buckets, this.count + added);
    owned?.add(next);
    return next;
  }

  /** Values in no particular order (the run's order arrays give display order). */
  values(): V[] {
    return this.buckets.flatMap((b) => [...b.values()]);
  }

  /** A plain object with sorted keys, so equal maps serialise the same. */
  toJSON(): Record<string, V> {
    const out: Record<string, V> = {};
    const keys = this.buckets.flatMap((b) => [...b.keys()]).sort();
    for (const k of keys) out[k] = this.get(k)!;
    return out;
  }
}
