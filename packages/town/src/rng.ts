/**
 * Counter-based hash RNG (plan §3): hash32(seed, ...parts) → uint32. It keeps
 * no state, so a draw depends only on its inputs (adding a resident changes
 * nobody else's draws). MurmurHash3-style mixing, 32-bit integer math only.
 */

function mix(h: number, k: number): number {
  let x = Math.imul(k, 0xcc9e2d51);
  x = (x << 15) | (x >>> 17);
  x = Math.imul(x, 0x1b873593);
  let y = h ^ x;
  y = (y << 13) | (y >>> 19);
  return (Math.imul(y, 5) + 0xe6546b64) | 0;
}

function finish(h: number, len: number): number {
  let x = h ^ len;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

const TAG_NUMBER = 0x4e;
const TAG_STRING = 0x53;

/** Mix an integer (any safe integer, negative included) as two 32-bit words. */
function mixInt(h: number, n: number): number {
  if (!Number.isSafeInteger(n)) throw new Error(`hash32: ${n} is not a safe integer`);
  const lo = n >>> 0;
  const hi = Math.floor(n / 4294967296) | 0;
  return mix(mix(mix(h, TAG_NUMBER), lo), hi);
}

/** A uint32 from a seed and any mix of integers and strings (order matters). */
export function hash32(seed: number, ...parts: readonly (number | string)[]): number {
  let h = mixInt(0x5eed, seed);
  let len = 1;
  for (const p of parts) {
    if (typeof p === 'number') h = mixInt(h, p);
    else {
      h = mix(h, TAG_STRING);
      h = mix(h, p.length);
      for (let i = 0; i < p.length; i++) h = mix(h, p.charCodeAt(i));
    }
    len++;
  }
  return finish(h, len);
}

/** An integer in [min, max] (inclusive) from the same inputs as hash32. */
export function hashRange(min: number, max: number, seed: number, ...parts: readonly (number | string)[]): number {
  if (max < min) throw new Error(`hashRange: max ${max} < min ${min}`);
  return min + (hash32(seed, ...parts) % (max - min + 1));
}
