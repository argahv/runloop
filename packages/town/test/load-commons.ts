/** Test helper: read Runloop Commons (town + interiors) from worlds/runloop-commons. */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const COMMONS_DIR = path.resolve(import.meta.dirname, '../../../worlds/runloop-commons');
export const WORLDS_DIR = path.resolve(COMMONS_DIR, '..');

export function readCommons(): { town: unknown; interiors: Record<string, unknown> } {
  const town = JSON.parse(readFileSync(path.join(COMMONS_DIR, 'town.json'), 'utf8')) as unknown;
  const interiors: Record<string, unknown> = {};
  for (const f of readdirSync(path.join(COMMONS_DIR, 'interiors')).sort()) {
    if (f.endsWith('.json')) interiors[f.slice(0, -5)] = JSON.parse(readFileSync(path.join(COMMONS_DIR, 'interiors', f), 'utf8'));
  }
  return { town, interiors };
}
