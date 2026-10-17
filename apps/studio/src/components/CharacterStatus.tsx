'use client';
import { presentationAt } from '@runloop-world/world-engine';
import { useSyncExternalStore } from 'react';
import { useStudio, useStudioStore } from '../state/context';
import { useTicker } from '../state/hooks';
import { characterStatusView } from '../state/view';
import { StatusBadge } from '../ui/Chip';

/**
 * A character's state exactly as its 3D badge shows it at the playhead
 * (Layer-2 state → presentationAt at the frame's tick), so DOM panels and
 * the scene never disagree. Re-renders while the playhead moves.
 */
export default function CharacterStatus({ agentId }: { agentId: string }) {
  const store = useStudioStore();
  const world = useStudio((s) => s.world);
  const frame = store.getState().getFrame();
  // Live: the playhead follows wall time. Replay: re-render on scrubs, at tick resolution.
  useTicker(frame.advancing, 200);
  useSyncExternalStore(
    store.subscribe,
    () => {
      const s = store.getState();
      return s.cursor.mode === 'replay' ? Math.round(s.cursor.tMs / 100) : s.playheadSeq;
    },
    () => 0,
  );

  const c = frame.state.world.characters[agentId];
  if (!c || !world) return null;
  const pose = presentationAt(c, frame.tick, world, { paused: frame.state.world.paused });
  return <StatusBadge view={characterStatusView(pose.state)} />;
}
