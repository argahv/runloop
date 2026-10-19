/** Child-process half of determinism.test.ts: one scripted day, printed as {events, hash, state}. */
import { hashState } from '../src/index';
import { logHash, newWorld, runUntil, scriptedCommands } from './helpers';

const run = newWorld({ seed: Number(process.argv[2] ?? 42) });
const start = run.tick;
runUntil(run, start + 1440, { inputs: scriptedCommands(start) });
process.stdout.write(JSON.stringify({ events: run.events.length, hash: logHash(run.events), state: hashState(run.state) }));
