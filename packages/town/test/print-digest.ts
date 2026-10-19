/**
 * Prints the Commons content hash, a decoration digest and a hash32 sample as
 * JSON. Run in a child process by compile.test.ts to check that both are the
 * same in every process (plan §8 S1).
 */
import { canonicalJson, decorate, fnv1a64, hash32, loadTown } from '../src/index';
import { readCommons } from './load-commons';

const raw = readCommons();
const town = loadTown(raw.town, raw.interiors);
const seed = Number(process.argv[2] ?? 42);
process.stdout.write(
  JSON.stringify({
    contentHash: town.contentHash,
    decoration: fnv1a64(canonicalJson(decorate(town, seed))),
    hash32: [hash32(seed, 'dec', 480, 3), hash32(seed, 'sched', 7), hash32(-5, 'x', 2 ** 40)],
  }),
);
