import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { DEFAULT_RUNTIME_HOST, DEFAULT_RUNTIME_PORT } from '@runloop-world/events';
import { findRepoRoot, resolveDataDir } from './config';
import { isLoopbackAddress } from './http/app';
import { createRuntime, type Runtime } from './runtime';
import { TracePrinter } from './trace-printer';

const USAGE = `Usage:
  runloop serve [--port ${DEFAULT_RUNTIME_PORT}] [--host ${DEFAULT_RUNTIME_HOST}]
  runloop demo  [--speed 1] [--keep] [--port ${DEFAULT_RUNTIME_PORT}] [--host ${DEFAULT_RUNTIME_HOST}]

serve  Start the local runtime API (Studio talks to it).
demo   Run the coding mission headless and print one trace line per event.
       Also serves the API while it runs; exits after run.completed unless --keep.

Environment:
  RUNLOOP_DATA_DIR         data directory (default <repo>/.runloop)
  RUNLOOP_ALLOWED_ORIGINS  extra comma-separated browser origins`;

/**
 * One runtime process per data dir: boot recovery would otherwise mark
 * another live process's active run as interrupted.
 */
function acquireLock(dataDir: string): () => void {
  const file = path.join(dataDir, 'runtime.pid');
  try {
    const pid = Number(readFileSync(file, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        throw new Error(
          `Another runtime (pid ${pid}) is using ${dataDir}. Stop it, or set RUNLOOP_DATA_DIR to another directory.`,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  writeFileSync(file, String(process.pid));
  return () => rmSync(file, { force: true });
}

/** Grace period for open responses (SSE streams sending their `end`) when the server closes. */
const CLOSE_GRACE_MS = 2000;

function listen(rt: Runtime, host: string, port: number): Promise<{ close(): Promise<void>; url: string }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: rt.app.fetch, hostname: host, port }, (info) => {
      resolve({
        url: `http://${host}:${info.port}`,
        // Graceful: stop accepting, let open responses finish (an SSE stream ends by
        // itself once its run is terminal), and only then cut what is left.
        close: () =>
          new Promise<void>((r) => {
            const force = setTimeout(() => {
              if ('closeAllConnections' in server) server.closeAllConnections();
            }, CLOSE_GRACE_MS);
            force.unref();
            server.close(() => {
              clearTimeout(force);
              r();
            });
          }),
      });
    });
    server.once('error', reject);
  });
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? DEFAULT_RUNTIME_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid --port: ${value}`);
  return port;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  if (command !== 'serve' && command !== 'demo') {
    console.error(`Unknown command: ${command}\n\n${USAGE}`);
    return 1;
  }
  const { values } = parseArgs({
    args: rest.filter((a) => a !== '--'),
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      speed: { type: 'string' },
      keep: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const port = parsePort(values.port);
  const host = values.host ?? DEFAULT_RUNTIME_HOST;
  if (host !== 'localhost' && !isLoopbackAddress(host)) {
    console.error(`[runtime] --host ${host} refused: the API has no authentication, so it only listens on loopback (127.0.0.1, ::1 or localhost).`);
    return 1;
  }

  const repoRoot = findRepoRoot();
  const dataDir = resolveDataDir(process.env, repoRoot);
  mkdirSync(dataDir, { recursive: true });
  const releaseLock = acquireLock(dataDir);
  const rt = createRuntime({ repoRoot, dataDir });
  for (const runId of rt.recovered) console.log(`[runtime] run ${runId} was left running by a previous process; marked interrupted`);

  let server: { close(): Promise<void>; url: string } | null = null;
  let shuttingDown = false;
  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Order matters: record run.completed{stopped}, let SSE clients receive it and
    // their `end`, close the server, and only then close the database.
    await rt.manager.shutdown();
    await server?.close();
    await rt.close();
    releaseLock();
    process.exit(code);
  };
  process.once('SIGINT', () => void shutdown(130));
  process.once('SIGTERM', () => void shutdown(143));

  try {
    server = await listen(rt, host, port);
  } catch (err) {
    if (command === 'serve') {
      console.error(`[runtime] could not listen on ${host}:${port}: ${(err as Error).message}`);
      await shutdown(1);
      return 1;
    }
    console.warn(`[runtime] API not served (${(err as Error).message}); continuing headless`);
  }

  if (command === 'serve') {
    console.log(`Runloop runtime ${server!.url}  (data: ${dataDir})`);
    return new Promise<number>(() => {}); // until a signal arrives
  }

  // demo
  const speed = Number(values.speed ?? 1);
  if (!Number.isFinite(speed) || speed < 0) throw new Error(`Invalid --speed: ${values.speed}`);
  // This process runs a single run, so every recorded event belongs to it.
  const printer = new TracePrinter();
  rt.recorder.bus.subscribeAll((e) => console.log(printer.format(e)));
  console.log(`# Runloop demo · speed ${speed} · data ${dataDir}${server ? ` · API ${server.url}` : ''}`);
  const { runId } = rt.manager.start({ missionId: 'coding-mission', speed });

  const summary = await rt.manager.whenDone(runId);
  if (values.keep && server) {
    console.log(`# run finished (${summary.status}); still serving ${server.url}. Ctrl-C to exit.`);
    return new Promise<number>(() => {});
  }
  await shutdown(summary.status === 'succeeded' ? 0 : 1);
  return 0;
}
