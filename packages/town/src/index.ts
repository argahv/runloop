/**
 * @runloop-world/town: the town's data and geometry. Pure (no I/O, clock or
 * randomness; see test/purity.test.ts) and shared by the sim and Studio.
 *
 * - schema: the town and interior files (zod);
 * - compile: validation (every problem at once) and lookup tables;
 * - raster: the ground layers; nav: outdoor BFS fields and walks;
 * - lots: agent lots; decorate: trees and props; rng: hash32; hash: contentHash.
 */
export * from './schema';
export * from './hash';
export * from './frame';
export * from './time';
export * from './rng';
export * from './raster';
export * from './compile';
export * from './nav';
export * from './lots';
export * from './decorate';

import type { CompiledTown } from './compile';
import type { TownRaster } from './raster';

/** The compiled town's ground raster (painted once by compileTown). */
export function rasterize(town: CompiledTown): TownRaster {
  return town.raster;
}
