import type { RunEvent, StreamEndData } from '@runloop-world/events';
import { SSE_END_EVENT } from '@runloop-world/events';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Recorder } from '../recorder';

export const DEFAULT_PING_MS = 15_000;
const PAGE = 500;

/**
 * Stream a run's events as SSE, resuming after sequence `after`.
 *
 * Subscribe first, then backfill from the DB, then drain live events, so an
 * event appended during the backfill is neither lost nor sent twice (anything
 * ≤ the last sent sequence is dropped; a gap triggers another backfill).
 * Each frame is a default `message` with `id: <sequence>`. Once the run is
 * terminal and everything was sent, an `end` event closes the stream.
 */
export function streamRunEvents(
  c: Context,
  opts: { recorder: Recorder; runId: string; after: number; pingMs?: number },
): Response {
  const { recorder, runId } = opts;
  const pingMs = opts.pingMs ?? DEFAULT_PING_MS;

  return streamSSE(c, async (stream) => {
    const queue: RunEvent[] = [];
    let wake: (() => void) | null = null;
    const notify = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const unsubscribe = recorder.subscribe(runId, (e) => {
      queue.push(e);
      notify();
    });
    stream.onAbort(notify);
    c.req.raw.signal?.addEventListener('abort', () => stream.abort(), { once: true });

    let lastSent = opts.after;
    const send = async (e: RunEvent) => {
      await stream.writeSSE({ id: String(e.sequence), data: JSON.stringify(e) });
      lastSent = e.sequence;
    };
    const backfill = async () => {
      for (;;) {
        const page = recorder.list(runId, { after: lastSent, limit: PAGE });
        for (const e of page) {
          if (stream.aborted) return;
          await send(e);
        }
        if (page.length < PAGE) return;
      }
    };

    try {
      await stream.write('retry: 2000\n\n');
      await backfill();
      while (!stream.aborted) {
        while (queue.length > 0 && !stream.aborted) {
          const e = queue.shift()!;
          if (e.sequence <= lastSent) continue;
          if (e.sequence > lastSent + 1) await backfill();
          if (e.sequence > lastSent) await send(e);
        }
        if (stream.aborted) break;
        const run = recorder.getRun(runId);
        if (!run) break;
        if (run.status !== 'running' && lastSent >= run.lastSequence) {
          const end: StreamEndData = { status: run.status, lastSequence: run.lastSequence };
          await stream.writeSSE({ event: SSE_END_EVENT, data: JSON.stringify(end) });
          break;
        }
        if (queue.length > 0) continue;
        const timedOut = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            wake = null;
            resolve(true);
          }, pingMs);
          wake = () => {
            clearTimeout(timer);
            resolve(false);
          };
        });
        if (timedOut && !stream.aborted) await stream.write(': ping\n\n');
      }
    } catch (err) {
      // A client that went away (or a server shutting down) is not an error.
      if (!stream.aborted) throw err;
    } finally {
      unsubscribe();
    }
  });
}
