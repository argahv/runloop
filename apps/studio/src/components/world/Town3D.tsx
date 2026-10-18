'use client';
import type { EntityRef } from '@runloop-world/events';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo } from 'react';
import { useStudio, useStudioStore } from '../../state/context';
import { selectRun } from '../../state/hooks';
import type { AgentHouseSource, ScreenRect, TownCam, TownCameraRequest, TownState } from '../../town/types';
import { useWorld, useWorldStore } from '../../world/context';
import { focusOf } from '../../world/store';
import styles from './WorldHome.module.css';

/** three.js and the town scene load on the client only, after the shell. */
const TownCanvas = dynamic(() => import('../../town/TownCanvas'), {
  ssr: false,
  loading: () => <div className={styles.stageMessage}>Loading the town…</div>,
});

/** Chrome floating over the canvas that the renderer's labels keep clear of (px). */
function chromeObstacles(width: number, height: number): ScreenRect[] {
  return [
    { l: 0, t: 0, r: width, b: 84 },
    { l: 0, t: height - 64, r: width, b: height },
  ];
}

/**
 * Mounts the town renderer (workstream B1, `town/TownCanvas`) on the world
 * store, per its contract in `town/types.ts`: the renderer reads the folded
 * snapshot and the clock every frame and reports what the viewer does; the
 * shell owns selection, panels, follow, interiors and camera requests.
 */
export default function Town3D() {
  const store = useWorldStore();
  const studio = useStudioStore();
  const town = useWorld((s) => s.town);
  const selected = useWorld((s) => focusOf(s));
  const follow = useWorld((s) => s.follow);
  const entered = useWorld((s) => s.entered);
  const camera = useWorld((s) => s.camera);
  const seed = useWorld((s) => s.info?.seed);
  const reducedMotion = useWorld((s) => s.reducedMotion);
  const quality = useStudio((s) => s.quality);
  const initialCam = useMemo(() => store.getState().cam, [store]);
  // Inside an agent's building, the interior follows its open session: a session that
  // starts while you watch (a dispatched task, a new prompt) replaces the one shown.
  const enteredRun = useWorld((s) => (s.entered ? (s.snapshot?.agents.find((a) => a.buildingId === s.entered)?.activeRunId ?? null) : null));
  useEffect(() => {
    if (enteredRun) selectRun(studio, enteredRun);
  }, [enteredRun, studio]);

  const getState = useCallback((): TownState => {
    const s = store.getState();
    return { snapshot: s.snapshot, clock: s.clock ? { tick: s.clock.tick, speed: s.clock.speed, receivedAt: s.clock.receivedAt } : null };
  }, [store]);

  const cameraRequest = useMemo<TownCameraRequest | null>(
    () => (camera ? { id: camera.id, kind: camera.kind, ref: camera.ref, motion: camera.motion } : null),
    [camera],
  );

  const onSelect = useCallback((ref: EntityRef | null) => {
    if (ref) store.getState().focusEntity(ref, { camera: false });
  }, [store]);
  const onEnter = useCallback((buildingId: string) => store.getState().enter(buildingId), [store]);
  const onCamChange = useCallback((cam: TownCam) => store.getState().setCam(cam), [store]);
  const onFollowBroken = useCallback(() => store.getState().setFollow(null), [store]);
  // A deep-linked focus asked before the town was drawn is framed once it is (no animation on load).
  const onReady = useCallback(() => {
    // After a few frames, so the renderer knows where residents and agents stand.
    setTimeout(() => {
      const s = store.getState();
      const f = focusOf(s);
      if (f && !s.cam) s.requestCamera(s.entered ? 'enter' : 'focus', f, 'cut');
    }, 800);
  }, [store]);

  /**
   * An agent's headquarters shows the run diorama of the session the Studio
   * has open, when that session is this agent's (Enter opens its latest).
   */
  const agentHouse = useCallback(
    (agentId: string): AgentHouseSource | null => {
      const s = studio.getState();
      const w = store.getState();
      const presence = w.snapshot?.agents.find((a) => a.agentId === agentId);
      const summary = w.agents.find((a) => a.agentId === agentId);
      const runs = new Set([presence?.activeRunId, ...(summary?.sessions.map((x) => x.runId) ?? [])].filter(Boolean));
      if (!s.world || !s.runId || !runs.has(s.runId)) return null;
      return {
        world: s.world,
        getFrame: s.getFrame,
        subscribeEffects: s.subscribeEffects,
        selectedAgentId: s.selectedAgentId,
        onSelectAgent: (id) => (id ? s.selectAgent(id) : s.clearSelection()),
      };
    },
    [store, studio],
  );

  if (!town) return null;
  return (
    <TownCanvas
      town={town}
      getState={getState}
      selected={selected}
      follow={follow}
      entered={entered}
      cameraRequest={cameraRequest}
      initialCam={initialCam}
      onSelect={onSelect}
      onEnter={onEnter}
      onCamChange={onCamChange}
      onFollowBroken={onFollowBroken}
      quality={quality}
      reducedMotion={reducedMotion}
      {...(seed !== undefined ? { seed } : {})}
      agentHouse={agentHouse}
      obstacles={chromeObstacles}
      onReady={onReady}
    />
  );
}
