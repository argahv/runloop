/** Read a town's files from `<worldsDir>/<townId>/` (town.json and interiors/*.json). */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { TownFiles } from './world-host';

export const DEFAULT_TOWN_ID = 'runloop-commons';
const SAFE_TOWN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function readTownFiles(worldsDir: string, townId: string = DEFAULT_TOWN_ID): TownFiles {
  if (!SAFE_TOWN_ID.test(townId)) throw new Error(`Invalid town id: ${townId}`);
  const dir = path.join(worldsDir, townId);
  const town = JSON.parse(readFileSync(path.join(dir, 'town.json'), 'utf8')) as unknown;
  const interiors: Record<string, unknown> = {};
  const idir = path.join(dir, 'interiors');
  if (existsSync(idir)) {
    for (const f of readdirSync(idir).sort()) {
      if (f.endsWith('.json')) interiors[f.slice(0, -5)] = JSON.parse(readFileSync(path.join(idir, f), 'utf8'));
    }
  }
  return { town, interiors };
}
