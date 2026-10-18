/**
 * Content hashing (plan §2: contentHash = fnv1a64(canonicalJson)). Pure and
 * identical in every process: keys sorted, no whitespace, UTF-8 bytes.
 */

/** JSON with object keys sorted at every level. Throws on values JSON cannot represent exactly. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (ArrayBuffer.isView(value)) throw new Error('canonicalJson: cannot encode a typed array');
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: cannot encode a ${typeof value}`);
}

const encoder = new TextEncoder();

/**
 * 64-bit FNV-1a of the UTF-8 bytes of `text`, as 16 lowercase hex digits.
 * The 64-bit state is kept in four 16-bit limbs so every step is exact
 * small-integer arithmetic (prime = 2^40 + 0x1b3).
 */
export function fnv1a64(text: string): string {
  // Offset basis 0xcbf29ce484222325, least significant limb first.
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  const bytes = encoder.encode(text);
  for (let i = 0; i < bytes.length; i++) {
    h0 ^= bytes[i]!;
    // (h · prime) mod 2^64: h·0x1b3 plus h shifted left by 40 bits (limb 2 gets h0·0x100, limb 3 gets h1·0x100).
    const t0 = h0 * 0x1b3;
    const t1 = h1 * 0x1b3 + (t0 >>> 16);
    const t2 = h2 * 0x1b3 + h0 * 0x100 + (t1 >>> 16);
    const t3 = h3 * 0x1b3 + h1 * 0x100 + (t2 >>> 16);
    h0 = t0 & 0xffff;
    h1 = t1 & 0xffff;
    h2 = t2 & 0xffff;
    h3 = t3 & 0xffff;
  }
  const hex = (n: number) => n.toString(16).padStart(4, '0');
  return hex(h3) + hex(h2) + hex(h1) + hex(h0);
}

/** The world's contentHash: the town file plus every interior it uses. */
export function townContentHash(town: unknown, interiors: Readonly<Record<string, unknown>>): string {
  return fnv1a64(canonicalJson({ town, interiors }));
}
