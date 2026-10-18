'use client';
import type { RunSummary } from '@runloop-world/events';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useRef, useState } from 'react';
import { setBaseline } from '../lib/api';
import { baselineFor, compareHref, isPinned } from '../state/baselines';
import { useStudio, useStudioStore } from '../state/context';
import { formatWhen } from '../state/format';
import { Button, ButtonLink } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { toast } from '../ui/Toast';

/** Pin or unpin a run as a baseline (persisted by the runtime), with a toast and an undo. */
export function usePinToggle() {
  const store = useStudioStore();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const self = useRef<(run: RunSummary) => Promise<void>>(async () => {});

  const toggle = useCallback(async (run: RunSummary): Promise<void> => {
    const pin = !isPinned(run);
    setBusy(run.runId);
    try {
      const updated = await setBaseline(run.runId, pin);
      store.getState().updateRun(updated);
      const others = store.getState().runs.filter((r) => r.runId !== run.runId);
      toast(
        pin
          ? {
              tone: 'ok',
              title: 'Pinned as a baseline',
              description: 'Run your agent again, then compare the new run against this one in Experiments.',
              ...(others.length > 0 ? { action: { label: 'Compare now', run: () => router.push(compareHref({ a: run.runId, b: null })) } } : {}),
            }
          : {
              tone: 'ok',
              title: 'Baseline removed',
              description: 'The run and its events are unchanged.',
              action: { label: 'Undo', run: () => void self.current(updated) },
            },
      );
    } catch (err) {
      toast({
        tone: 'err',
        title: pin ? 'Could not pin the run' : 'Could not remove the baseline',
        description: `${err instanceof Error ? err.message : String(err)}. Nothing changed; try again.`,
      });
    } finally {
      setBusy(null);
    }
  }, [store, router]);
  self.current = toggle;

  return useMemo(() => ({ toggle, busy }), [toggle, busy]);
}

/** "Baseline" chip for pinned runs (text + icon, never colour alone). */
export function BaselineBadge({ run, compact }: { run: RunSummary; compact?: boolean }) {
  if (!isPinned(run)) return null;
  return (
    <Chip tone="info" icon="pin" title={`Pinned as a baseline · ${formatWhen(run.pinnedAt!)}`}>
      {compact ? <span className="sr-only">Baseline</span> : 'Baseline'}
    </Chip>
  );
}

/**
 * Toggle button: "Pin as baseline" / "Baseline" (pressed). Icon-only in
 * dense rows, where the accessible name stays "Pin as baseline".
 */
export function PinButton({ run, iconOnly, size = 'sm', variant }: { run: RunSummary; iconOnly?: boolean; size?: 'sm' | 'md'; variant?: 'primary' }) {
  const { toggle, busy } = usePinToggle();
  const pinned = isPinned(run);
  const runtimeOnline = useStudio((s) => s.runtime.status === 'online');
  const title = pinned ? 'Pinned as a baseline. Press to unpin (the run is kept).' : 'Pin as a baseline to compare later runs against it';
  return (
    <Button
      size={size}
      variant={pinned ? 'secondary' : (variant ?? 'ghost')}
      icon="pin"
      iconOnly={iconOnly}
      aria-pressed={pinned}
      // One name for both states (a toggle); it contains the visible text "Baseline".
      aria-label="Pin as baseline"
      title={runtimeOnline ? title : 'The runtime is offline'}
      busy={busy === run.runId}
      disabled={!runtimeOnline}
      onClick={() => void toggle(run)}
      data-pinned={pinned || undefined}
    >
      {pinned ? 'Baseline' : 'Pin as baseline'}
    </Button>
  );
}

/** "Compare with baseline" for a run that is not itself the newest baseline; null when there is none. */
export function CompareWithBaseline({ run }: { run: RunSummary }) {
  const runs = useStudio((s) => s.runs);
  const base = baselineFor(runs, run.runId);
  if (!base) return null;
  return (
    <ButtonLink href={compareHref({ a: base.runId, b: run.runId })} size="sm" variant="ghost" icon="compare" title={`Compare this run with the baseline “${base.title}”`}>
      Compare
    </ButtonLink>
  );
}
