'use client';
import { useCallback, useState } from 'react';
import { ApiError, startRun } from '../lib/api';
import { DEMO_MISSION_ID } from '../lib/config';
import { useStudio, useStudioStore } from '../state/context';
import { toast } from '../ui/Toast';
import { useStudioNav } from './overlays/nav';

/**
 * Start the scripted demo mission, open its Live World, and report what
 * happened. In the world that is the trace sheet's World tab beside the
 * town; on the pages it is /world, as before.
 */
export function useStartDemo(): { start: () => Promise<void>; starting: boolean; disabledReason: string | null } {
  const store = useStudioStore();
  const nav = useStudioNav();
  const runtime = useStudio((s) => s.runtime);
  const [starting, setStarting] = useState(false);

  const disabledReason =
    runtime.status !== 'online' ? 'The local runtime is offline' : runtime.activeRunId ? 'A demo run is already in progress' : null;

  const start = useCallback(async () => {
    setStarting(true);
    try {
      const { runId } = await startRun(DEMO_MISSION_ID);
      nav.openRunWorld(runId);
      toast({ tone: 'ok', title: 'Demo mission started', description: 'Scripted agent, real tools: the runtime edits files and runs tests.' });
    } catch (err) {
      const active = store.getState().runtime.activeRunId;
      if (err instanceof ApiError && err.status === 409 && active) {
        nav.openRunWorld(active);
        toast({ tone: 'warn', title: 'A run is already in progress', description: 'Opened it instead.' });
      } else {
        toast({
          tone: 'err',
          title: 'Could not start the demo mission',
          description: `${err instanceof Error ? err.message : String(err)}. Nothing was recorded; try again.`,
        });
      }
    } finally {
      setStarting(false);
    }
  }, [store, nav]);

  return { start, starting, disabledReason };
}
