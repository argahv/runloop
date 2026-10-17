'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { ApiError, startRun } from '../lib/api';
import { DEMO_MISSION_ID } from '../lib/config';
import { useStudio, useStudioStore } from '../state/context';
import { ROUTES } from '../state/deeplink';
import { selectRun } from '../state/hooks';
import { toast } from '../ui/Toast';

/** Start the scripted demo mission, open it in the Live World, and report what happened. */
export function useStartDemo(): { start: () => Promise<void>; starting: boolean; disabledReason: string | null } {
  const store = useStudioStore();
  const router = useRouter();
  const runtime = useStudio((s) => s.runtime);
  const [starting, setStarting] = useState(false);

  const disabledReason =
    runtime.status !== 'online' ? 'The local runtime is offline' : runtime.activeRunId ? 'A demo run is already in progress' : null;

  const start = useCallback(async () => {
    setStarting(true);
    try {
      const { runId } = await startRun(DEMO_MISSION_ID);
      selectRun(store, runId);
      router.push(ROUTES.world);
      toast({ tone: 'ok', title: 'Demo mission started', description: 'Scripted agent, real tools: the runtime edits files and runs tests.' });
    } catch (err) {
      const active = store.getState().runtime.activeRunId;
      if (err instanceof ApiError && err.status === 409 && active) {
        selectRun(store, active);
        router.push(ROUTES.world);
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
  }, [store, router]);

  return { start, starting, disabledReason };
}
