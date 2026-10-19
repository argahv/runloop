/**
 * Shared helpers for the film's data exporters. They import Runloop's own source packages by
 * relative path (read-only) so the film is driven by the product's real data and logic:
 * the town file and its compiler, the simulation, the tracer's ingest and the reducers.
 *
 * Run from film/:  npx tsx tools/export-town.ts   (see package.json "export")
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTown, type CompiledTown } from '../../packages/town/src/index.ts';
import { readTownFiles } from '../../packages/runtime/src/world/town-files.ts';

export const FILM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(FILM_ROOT, '..');
export const FILM = 'keeps-running';
export const DATA_DIR = path.join(FILM_ROOT, FILM, 'data');

/**
 * The seed of the film's world. A new world in the runtime draws a random seed
 * (WorldHost: randomInt(2^31)); 42 is the seed of the engine's own fixture world
 * (packages/sim/test/fixtures). When the real captures are made, read the capture
 * world's seed from GET /api/world (info.seed) and re-export with --seed <n>, so the
 * 3-D residents and decorations match the screen.
 */
export const DEFAULT_SEED = 42;

export function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}

/** Runloop Commons, compiled exactly as the runtime loads it (town.json + interiors/*.json). */
export function loadCommons(): { town: CompiledTown; files: { town: unknown; interiors: Record<string, unknown> } } {
  const files = readTownFiles(path.join(REPO_ROOT, 'worlds'));
  return { town: loadTown(files.town, files.interiors), files };
}

export function writeJson(name: string, value: unknown, { pretty = false }: { pretty?: boolean } = {}): string {
  mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, name);
  writeFileSync(file, pretty ? `${JSON.stringify(value, null, 1)}\n` : `${JSON.stringify(value)}\n`);
  return file;
}

/** Ticks are sim minutes since Day 1 00:00. */
export function clockOf(tick: number): string {
  const day = Math.floor(tick / 1440) + 1;
  const m = ((tick % 1440) + 1440) % 1440;
  return `Day ${day} · ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
