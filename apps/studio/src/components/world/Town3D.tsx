'use client';
import type { EntityRef } from '@runloop-world/events';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, type Ref } from 'react';
import { useStudio, useStudioStore } from '../../state/context';
import { selectRun } from '../../state/hooks';
import type { AgentHouseSource, Insets, ScreenRect, TownApi, TownCam, TownCameraRequest, TownListener, TownState } from '../../town/types';
import { useWorld, useWorldStore } from '../../world/context';
import { focusOf } from '../../world/store';
import { useHudLayout } from './hud/context';
import { useLotPickModel } from './hud/Guide';
import { hudInsets } from './hud/layout';
import { floatingRects } from './hud/occlusion';
import { useSheetWidths } from './hud/Sheets';
import styles from './hud/hud.module.css';

/** three.js and the town scene load on the client only, after the shell. */
const TownCanvas = dynamic(() => import('../../town/TownCanvas'), {
  ssr: false,
  loading: () => <div className={styles.stageMessage}>Loading the town…</div>,
});

/**
 * Mounts the town renderer (`town/TownCanvas`) on the world store, per its
 * contract in `town/types.ts` and the immersive contract §5.2: the renderer
 * reads the folded snapshot and the clock every frame and reports what the
 * viewer does; the HUD owns selection, cards, follow, interiors, lot picking
 * and camera requests, and tells the camera what it covers (`viewInsets`).
 */
export default function Town3D({
  apiRef,
  onFly,
  onListener,
}: {
  apiRef?: Ref<TownApi>;
  /** A camera flight started (the whoosh). */
  onFly?: (durationMs: number, pan: number) => void;
  /** The soundscape's listener (~4 Hz). */
  onListener?: (l: TownListener) => void;
}) {
  const store = useWorldStore();
  const studio = useStudioStore();
  const town = useWorld((s) => s.town);
  const selected = useWorld((s) => focusOf(s));
  const follow = useWorld((s) => s.follow);
  const entered = useWorld((s) => s.entered);
  const camera = useWorld((s) => s.camera);
  const seed = useWorld((s) => s.info?.seed);
  const reducedMotion = useWorld((s) => s.reducedMotion);
  const menu = useWorld((s) => s.menu);
  // The trace sheet's run shortcuts (Space, ←/→, L, [ ], F) win over the camera keys while it is open.
  const traceSheet = useWorld((s) => s.overlay === 'trace');
  const hudHidden = useWorld((s) => s.hud.hidden);
  const paused = useWorld((s) => s.townPaused);
  const quality = useStudio((s) => s.quality);
  const layout = useHudLayout();
  const sheets = useSheetWidths(layout.vw);
  const lotPick = useLotPickModel();
  const initialCam = useMemo(() => store.getState().cam, [store]);
  const phone = layout.size === 'phone';

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

  const cameraRequest = useMemo<TownCameraRequest | null>(() => {
    if (!camera) return null;
    const r: TownCameraRequest = { id: camera.id, kind: camera.kind, ref: camera.ref, motion: camera.motion };
    if (camera.point) r.point = camera.point;
    if (camera.level) r.level = camera.level;
    if (camera.deg !== undefined) r.deg = camera.deg;
    if (camera.cam) r.cam = camera.cam;
    return r;
  }, [camera]);

  const viewInsets = useMemo<Insets>(
    () => hudInsets(layout, { right: sheets.right, left: sheets.left, hidden: hudHidden }),
    // Only the numbers matter.
    [layout.size, layout.top, layout.hotbar.height, layout.hotbar.bottom, sheets.right, sheets.left, hudHidden],
  );

  const onSelect = useCallback(
    (ref: EntityRef | null) => {
      const s = store.getState();
      if (!ref) {
        // Empty ground closes the card (contract §1.4).
        if (s.panelStack.length && !s.lotPick) s.closePanels();
        return;
      }
      s.focusEntity(ref, { camera: false });
      // Residents and robots are followed when selected (contract §2.2).
      if (ref.kind === 'resident' || ref.kind === 'agent') s.setFollow(ref);
    },
    [store],
  );
  const onLongPress = useCallback((ref: EntityRef) => store.getState().focusEntity(ref, { camera: false, expand: true }), [store]);
  const onEnter = useCallback((buildingId: string) => store.getState().enter(buildingId), [store]);
  const onCamChange = useCallback((cam: TownCam) => store.getState().setCam(cam), [store]);
  const onFollowBroken = useCallback(() => store.getState().setFollow(null), [store]);
  const onInteraction = useCallback((active: boolean) => store.getState().setInteracting(active), [store]);
  const onPickLot = useCallback((lotId: string) => store.getState().pickLot(lotId), [store]);
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

  /** Floating chrome the labels keep clear of: the top row, the hotbar and an open sheet. */
  const obstacles = useCallback(
    (width: number, height: number): ScreenRect[] => {
      const out: ScreenRect[] = [
        { l: 0, t: 0, r: width, b: viewInsets.top },
        { l: 0, t: height - viewInsets.bottom, r: width, b: height },
      ];
      if (viewInsets.right) out.push({ l: width - viewInsets.right, t: 0, r: width, b: height });
      if (viewInsets.left) out.push({ l: 0, t: 0, r: viewInsets.left, b: height });
      // The anchored card: labels move out from under it (it names its entity itself).
      if (floatingRects.card) out.push(floatingRects.card);
      return out;
    },
    [viewInsets],
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
      onLongPress={onLongPress}
      quality={phone ? 'low' : quality}
      reducedMotion={reducedMotion}
      {...(seed !== undefined ? { seed } : {})}
      agentHouse={agentHouse}
      obstacles={obstacles}
      onReady={onReady}
      {...(apiRef ? { apiRef } : {})}
      viewInsets={viewInsets}
      lotPick={lotPick}
      onPickLot={onPickLot}
      onInteraction={onInteraction}
      {...(onFly ? { onFly } : {})}
      {...(onListener ? { onListener } : {})}
      surroundings={phone || quality === 'low' ? 'lite' : 'full'}
      ambientLife={!reducedMotion}
      labelBudget={layout.labelBudget}
      keyboard={menu === null && !traceSheet}
      paused={paused}
    />
  );
}
