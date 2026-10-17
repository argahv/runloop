import { SSE_END_EVENT, type StreamEndData } from '@runloop-world/events';
import { getAllEvents, getEventsPage, getRun, streamUrl } from '../lib/api';
import type { StudioStore } from './store';

const GAP_CHECK_MS = 1000;
const REOPEN_MS = 3000;
/** SSE frames are applied in small batches so a burst re-renders once. */
const FLUSH_MS = 30;

/**
 * Load a run and keep it up to date: run detail (with the world), the event
 * backlog page by page, then an SSE stream from the last sequence received.
 * The browser resumes a dropped stream with Last-Event-ID; if it gives up,
 * we reopen from the last contiguous sequence. Gaps that stay open for ~2 s
 * are backfilled from GET /events. Returns a disconnect function; safe to
 * call twice (React StrictMode mounts effects twice).
 */
export function connectRun(store: StudioStore, runId: string): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let reopenTimer: ReturnType<typeof setTimeout> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let queue: unknown[] = [];
  let backfilling = false;

  const state = () => store.getState();
  const current = () => !closed && state().runId === runId;

  const flush = () => {
    flushTimer = null;
    const batch = queue;
    queue = [];
    if (current() && batch.length) state().ingest(batch, 'live');
  };

  const openStream = () => {
    if (!current()) return;
    const source = new EventSource(streamUrl(runId, state().lastSequence));
    es = source;
    source.onopen = () => {
      if (current()) state().setConn('streaming');
    };
    source.onmessage = (m: MessageEvent<string>) => {
      queue.push(parseJson(m.data));
      flushTimer ??= setTimeout(flush, FLUSH_MS);
    };
    source.addEventListener(SSE_END_EVENT, (m) => {
      // Without close() the browser would reconnect forever.
      source.close();
      if (es === source) es = null;
      flush();
      if (!current()) return;
      const end = parseJson((m as MessageEvent<string>).data) as Partial<StreamEndData> | null;
      if (end?.status) state().markEnded(end.status, end.lastSequence ?? 0);
      state().setConn('complete');
    });
    source.onerror = () => {
      if (!current()) return;
      if (source.readyState === EventSource.CLOSED) {
        // The browser gave up (HTTP error, CORS, runtime gone): retry ourselves.
        if (es === source) es = null;
        state().setConn('error');
        reopenTimer = setTimeout(() => {
          reopenTimer = null;
          if (!state().ended) openStream();
        }, REOPEN_MS);
      } else {
        state().setConn('reconnecting');
      }
    };
  };

  const checkGap = async () => {
    if (!current() || backfilling) return;
    const gap = state().gapToBackfill();
    if (!gap) return;
    backfilling = true;
    try {
      const page = await getEventsPage(runId, gap.from - 1, gap.to - gap.from + 1);
      if (current()) state().ingest(page.events, 'backlog');
    } catch {
      // Retried on the next check.
    } finally {
      backfilling = false;
    }
  };
  const gapTimer = setInterval(() => void checkGap(), GAP_CHECK_MS);

  void (async () => {
    try {
      const detail = await getRun(runId);
      if (!current()) return;
      state().loadRun(detail);
      const backlog = await getAllEvents(runId, state().lastSequence);
      if (!current()) return;
      state().ingest(backlog, 'backlog');
      const s = state();
      if (detail.run.status !== 'running' && s.lastSequence >= detail.run.lastSequence) {
        s.markEnded(detail.run.status, detail.run.lastSequence);
        s.setConn('complete');
        return;
      }
      openStream();
    } catch (err) {
      if (current()) state().setLoadError(err instanceof Error ? err.message : String(err));
    }
  })();

  return () => {
    closed = true;
    clearInterval(gapTimer);
    if (reopenTimer) clearTimeout(reopenTimer);
    if (flushTimer) clearTimeout(flushTimer);
    es?.close();
    es = null;
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
