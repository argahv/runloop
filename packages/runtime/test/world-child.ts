/**
 * Child process for the SIGKILL test (world-host.test.ts): runs a world host
 * at 16× on the given database with real timers until it is killed.
 */
import { openDb } from '../src/store/db';
import { readTownFiles } from '../src/world/town-files';
import { WorldHost } from '../src/world/world-host';
import { findRepoRoot } from '../src/config';

const db = openDb(process.argv[2]!);
const host = new WorldHost({ db, town: readTownFiles(`${findRepoRoot()}/worlds`), now: Date.now, seed: 42, tickMs: 20 });
host.start();
void host.submit({ id: 'clock:fast', source: 'user', command: { type: 'clock.set', speed: 16 } }).then(() => {
  process.stdout.write('ready\n');
});
setInterval(() => {}, 1000);
