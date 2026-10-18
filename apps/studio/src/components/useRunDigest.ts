'use client';
import { summarizeRun, type ExecState, type RunDigest } from '@runloop-world/core';
import type { RunSummary } from '@runloop-world/events';
import { useEffect, useMemo, useState } from 'react';
import { getAllEvents } from '../lib/api';
import { foldRaw } from '../state/compare';

export type DigestLoad =
  | { status: 'idle'; digest: null; error: null }
  | { status: 'loading'; digest: null; error: null }
  | { status: 'ready'; digest: RunDigest; error: null; partial: boolean }
  | { status: 'error'; digest: null; error: string };

/**
 * Folded runs kept for this page session, so switching the pickers back and
 * forth does not refetch. A run that is still recording is topped up from its
 * last folded sequence when its summary reports more events.
 */
const folded = new Map<string, ExecState>();

/** Load a run's events (paged API), fold them with core and summarise them for compare. */
export function useRunDigest(run: RunSummary | null, retryKey = 0): DigestLoad {
  const runId = run?.runId ?? null;
  const target = run?.lastSequence ?? 0;
  const [state, setState] = useState<{ runId: string | null; exec: ExecState | null; complete: boolean; error: string | null }>({
    runId: null,
    exec: null,
    complete: false,
    error: null,
  });

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    const cached = folded.get(runId) ?? null;
    if (cached && cached.lastSequence >= target) {
      setState({ runId, exec: cached, complete: true, error: null });
      return;
    }
    setState((s) => (s.runId === runId ? { ...s, error: null } : { runId, exec: cached, complete: false, error: null }));
    void (async () => {
      try {
        const raws = await getAllEvents(runId, cached?.lastSequence ?? 0);
        if (cancelled) return;
        const r = foldRaw(raws, runId, cached ?? undefined, target);
        folded.set(runId, r.exec);
        setState({ runId, exec: r.exec, complete: r.complete, error: null });
      } catch (err) {
        if (!cancelled) setState({ runId, exec: null, complete: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, target, retryKey]);

  const exec = state.runId === runId ? state.exec : null;
  const digest = useMemo(() => (exec ? summarizeRun(exec) : null), [exec]);

  if (!runId) return { status: 'idle', digest: null, error: null };
  if (state.runId === runId && state.error) return { status: 'error', digest: null, error: state.error };
  if (!digest || exec!.lastSequence === 0) return { status: 'loading', digest: null, error: null };
  return { status: 'ready', digest, error: null, partial: !state.complete };
}
