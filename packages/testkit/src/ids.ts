/**
 * Deterministic, valid RFC 4122 v4-shaped UUIDs (zod 4's z.uuid() checks the
 * version and variant bits, so all-zero fakes are rejected).
 */
export function idGen(namespace = 0): () => string {
  let n = 0;
  const ns = (namespace >>> 0).toString(16).padStart(8, '0');
  return () => {
    n += 1;
    return `${ns}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  };
}

/** A fixed valid UUID for a given small number, e.g. uuidFor(1, 7). */
export function uuidFor(namespace: number, n: number): string {
  const ns = (namespace >>> 0).toString(16).padStart(8, '0');
  return `${ns}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}
