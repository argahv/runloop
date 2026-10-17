import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** A mission loaded from `<missionsDir>/<id>/mission.json` (data, read by path). */
export interface Mission {
  id: string;
  title: string;
  worldId: string;
  seed: number;
  /** Adapter id that runs this mission. */
  adapter: string;
  /** Absolute mission directory. Adapters may read their own files from here. */
  dir: string;
  /** Absolute path of the repo copied into each run's workspace. */
  repoDir: string;
  /** The full mission.json, for adapter-specific settings. */
  raw: Record<string, unknown>;
}

export class MissionNotFoundError extends Error {}

const MISSION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_WORLD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function loadMission(missionsDir: string, missionId: string): Mission {
  if (!MISSION_ID.test(missionId)) throw new MissionNotFoundError(`Unknown mission: ${missionId}`);
  const dir = path.join(missionsDir, missionId);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path.join(dir, 'mission.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    throw new MissionNotFoundError(`Unknown mission: ${missionId}`);
  }
  const str = (key: string): string => {
    const v = raw[key];
    if (typeof v !== 'string' || v.length === 0) throw new Error(`mission.json: "${key}" must be a non-empty string`);
    return v;
  };
  if (raw.id !== missionId) throw new Error(`mission.json: id "${String(raw.id)}" does not match directory "${missionId}"`);
  const worldId = str('worldId');
  if (!SAFE_WORLD_ID.test(worldId)) throw new Error(`mission.json: invalid worldId "${worldId}"`);
  const seed = raw.seed ?? 0;
  if (typeof seed !== 'number' || !Number.isInteger(seed)) throw new Error('mission.json: "seed" must be an integer');
  const repoDir = path.resolve(dir, typeof raw.repo === 'string' ? raw.repo : 'repo');
  if (!repoDir.startsWith(dir + path.sep) || !statSync(repoDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`mission.json: "repo" must be a directory inside ${dir}`);
  }
  return { id: missionId, title: str('title'), worldId, seed, adapter: str('adapter'), dir, repoDir, raw };
}
