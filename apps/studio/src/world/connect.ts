/**
 * Keeps the world store in step with the runtime: world info and the town
 * once, then the SSE stream (`snapshot`, event batches, a 1 Hz `clock`), and
 * the agents API every few seconds. The browser resumes a dropped stream with
 * Last-Event-ID (a world seq); when it gives up, Studio reopens it from the
 * last folded seq (the server backfills). A gap or a frame that does not parse
 * reopens it without a seq, for a fresh snapshot: nothing is folded on guesswork.
 */
import {
  WORLD_SSE_CLOCK_EVENT,
  WORLD_SSE_SNAPSHOT_EVENT,
  WorldClockFrameSchema,
  WorldEventsFrameSchema,
  WorldSnapshotSchema,
  type WorldEvent,
} from '@runloop-world/events';
import { loadTown } from '@runloop-world/town';
import { getWorldEventsSince, getWorldInfo, getWorldTown, listAgents, listArrivals, WorldApiError, worldStreamUrl } from './api';
import type { WorldStore } from './store';

const FLUSH_MS = 50;
/** How far back attention is seeded from the log when a snapshot arrives. */
const PRIME_WINDOW = 3000;
const REOPEN_MS = 3000;
const INFO_RETRY_MS = 4000;
export const AGENTS_POLL_MS = 4000;

const parseJson = (s: string): unknown => {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
};

/** Connect the store to the runtime's world. Returns a disconnect function (safe to call twice). */
export function connectWorld(store: WorldStore): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let queue: WorldEvent[] = [];
  const st = () => store.getState();

  const flush = () => {
    flushTimer = null;
    const batch = queue;
    queue = [];
    if (closed || batch.length === 0) return;
    st().applyEvents(batch, Date.now());
    if (st().gap) reopen(0);
  };

  const reopen = (delay: number) => {
    es?.close();
    es = null;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      openStream();
    }, delay);
  };

  const openStream = () => {
    if (closed) return;
    const s = st();
    // After a gap the state may be partly folded: start again from a snapshot.
    const after = s.snapshot && !s.gap ? s.snapshot.seq : null;
    if (s.gap) store.setState({ gap: false });
    const source = new EventSource(worldStreamUrl(after));
    es = source;
    source.addEventListener(WORLD_SSE_SNAPSHOT_EVENT, (m) => {
      const parsed = WorldSnapshotSchema.safeParse(parseJson((m as MessageEvent<string>).data));
      if (closed || es !== source) return;
      if (!parsed.success) {
        st().setStatus('reconnecting', 'The runtime sent a world snapshot Studio could not read.');
        return;
      }
      queue = [];
      st().applySnapshot(parsed.data, Date.now());
      st().setStatus('live');
      void primeAttention(parsed.data);
    });
    source.onmessage = (m: MessageEvent<string>) => {
      if (closed || es !== source) return;
      const parsed = WorldEventsFrameSchema.safeParse(parseJson(m.data));
      if (!parsed.success) {
        // Never fold something that does not parse: resync from a snapshot.
        store.setState({ gap: true });
        reopen(0);
        return;
      }
      queue.push(...parsed.data.events);
      flushTimer ??= setTimeout(flush, FLUSH_MS);
    };
    source.addEventListener(WORLD_SSE_CLOCK_EVENT, (m) => {
      const parsed = WorldClockFrameSchema.safeParse(parseJson((m as MessageEvent<string>).data));
      if (closed || es !== source || !parsed.success) return;
      st().setClock(parsed.data, Date.now());
      if (st().status !== 'live' && st().snapshot) st().setStatus('live');
    });
    source.onerror = () => {
      if (closed || es !== source) return;
      st().setStatus('reconnecting');
      // The browser retries by itself unless it gave up (HTTP error, CORS, runtime gone).
      if (source.readyState === EventSource.CLOSED) reopen(REOPEN_MS);
    };
  };

  /**
   * Seed attention from the log: the recent window, plus every agent's
   * connection and session events (so a condition older than the window, such
   * as a failure still open in a session, is still cited and shown).
   */
  const primeAttention = async (snap: { seq: number; agents: readonly { agentId: string }[] }) => {
    try {
      const recent = getWorldEventsSince(Math.max(0, snap.seq - PRIME_WINDOW), PRIME_WINDOW);
      const perAgent = snap.agents.flatMap((a) =>
        (['agent.connection_changed', 'agent.session_changed', 'agent.housed'] as const).map((type) => getWorldEventsSince(0, 500, { actor: a.agentId, type })),
      );
      const pages = await Promise.all([recent, ...perAgent]);
      if (closed) return;
      const bySeq = new Map<number, WorldEvent>();
      for (const p of pages) for (const e of p.events) if (e.seq <= snap.seq) bySeq.set(e.seq, e);
      st().primeAttention([...bySeq.values()]);
    } catch {
      // Attention fills from live events; history is a bonus.
    }
  };

  const start = async () => {
    st().setStatus(st().snapshot ? 'reconnecting' : 'connecting');
    try {
      const info = await getWorldInfo(AbortSignal.timeout(4000));
      if (closed) return;
      st().setInfo(info);
      if (!st().town || st().town!.contentHash !== info.contentHash) {
        const raw = await getWorldTown();
        if (closed) return;
        st().setTown(loadTown(raw.town, raw.interiors));
      }
      openStream();
    } catch (e) {
      if (closed) return;
      if (e instanceof WorldApiError && e.code === 'world_disabled') {
        st().setStatus('disabled', 'The world is turned off in this runtime (RUNLOOP_WORLD=off).');
        return;
      }
      st().setStatus('offline', e instanceof Error ? e.message : String(e));
      timer = setTimeout(() => void start(), INFO_RETRY_MS);
    }
  };

  let agentsTimer: ReturnType<typeof setTimeout> | null = null;
  const pollAgents = async () => {
    try {
      const [{ agents }, { arrivals }] = await Promise.all([listAgents(), listArrivals()]);
      if (!closed) st().setAgents('ok', agents, arrivals, Date.now());
    } catch (e) {
      if (!closed) st().setAgents(e instanceof WorldApiError && e.status === 404 ? 'unavailable' : 'offline', undefined, undefined, Date.now());
    }
    if (!closed) agentsTimer = setTimeout(() => void pollAgents(), AGENTS_POLL_MS);
  };

  void start();
  void pollAgents();
  return () => {
    closed = true;
    es?.close();
    es = null;
    for (const t of [timer, flushTimer, agentsTimer]) if (t) clearTimeout(t);
  };
}

/** Refresh the agents list now (after Add to World or a claim). */
export async function refreshAgents(store: WorldStore): Promise<void> {
  try {
    const [{ agents }, { arrivals }] = await Promise.all([listAgents(), listArrivals()]);
    store.getState().setAgents('ok', agents, arrivals, Date.now());
  } catch {
    // the poll will retry
  }
}
