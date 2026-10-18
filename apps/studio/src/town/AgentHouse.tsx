'use client';
import { useFrame } from '@react-three/fiber';
import type { Lot } from '@runloop-world/town';
import { memo, useMemo, useRef, useState } from 'react';
import { Matrix4, Vector3, type Group } from 'three';
import { Board } from '../scene/Board';
import { Characters } from '../scene/Characters';
import { CameraBus, SceneContext, type SceneCtx } from '../scene/context';
import { Effects } from '../scene/Effects';
import { LabelProjector, LabelStore, type Anchor, type LabelContent } from '../scene/labels';
import { buildPalette, documentTokens } from '../scene/palette';
import { Paths } from '../scene/Paths';
import { Props } from '../scene/Props';
import { SLAB_DEPTH } from '../scene/layout';
import { Stations } from '../scene/Stations';
import { cellY } from './coords';
import { useTown } from './context';
import { MergeStatic } from './MergeStatic';
import type { LocalFrame } from './geometry/frame';
import type { AgentHouseSource } from './types';

/** Scale of the run diorama inside an agent's headquarters (plan §0: research-campus at 0.5). */
export const HQ_SCALE = 0.5;

/**
 * A LabelStore for the diorama: the scene's labels anchor in the diorama's
 * local space (toScene), so each anchor is carried through the group's world
 * matrix before the projector reads it.
 */
export class ScopedLabelStore extends LabelStore {
  readonly matrix = new Matrix4();
  override set(id: string, content: LabelContent, anchor: Anchor): void {
    const m = this.matrix;
    const wrapped = (out: Vector3) => {
      const p = typeof anchor === 'function' ? anchor(out) : out.copy(anchor);
      return p ? p.applyMatrix4(m) : null;
    };
    super.set(id, content, wrapped);
  }
}

/**
 * An agent's headquarters, entered: the Live World diorama of its current
 * session (Board, Stations, Paths, Characters and Effects from scene/) at half
 * scale on its lot, driven by the StudioStore frame the shell provides. It
 * keeps the Signature look, so a real agent's house reads as Runloop's.
 * Without a loaded session it shows nothing but the lot (the shell says why).
 */
export const AgentHouse = memo(function AgentHouse({ agentId, lot, frame: f }: { agentId: string; lot: Lot; frame: LocalFrame }) {
  const { town, live, dioramaLabels } = useTown();
  // The shell may load the agent's session after the interior opened: look again every frame (cheap) and re-render on a change.
  const [source, setSource] = useState<AgentHouseSource | null>(() => live.agentHouse?.(agentId) ?? null);
  const group = useRef<Group>(null);
  const [camera] = useState(() => new CameraBus());
  const palette = useMemo(() => buildPalette(documentTokens()), []);
  const incidentStations = useMemo(() => new Map<string, string>(), [source?.world]);
  const ctx = useMemo<SceneCtx | null>(
    () =>
      source
        ? {
            world: source.world,
            getFrame: source.getFrame,
            subscribeEffects: source.subscribeEffects,
            reducedMotion: live.reducedMotion,
            incidentStations,
            labels: dioramaLabels,
            palette,
            camera,
            selectEvent: () => {},
          }
        : null,
    [source, live.reducedMotion, incidentStations, dioramaLabels, palette, camera],
  );
  const y = cellY(town, lot.rect[0], lot.rect[1]) + SLAB_DEPTH * HQ_SCALE;
  useFrame(() => {
    const next = live.agentHouse?.(agentId) ?? null;
    if (next?.world !== source?.world || next?.getFrame !== source?.getFrame) setSource(next);
    if (group.current) {
      group.current.updateWorldMatrix(true, false);
      dioramaLabels.matrix.copy(group.current.matrixWorld);
    }
  });
  if (!ctx || !source) return null;
  return (
    <group ref={group} position={[f.cx, y, f.cz]} rotation={[0, f.yaw, 0]} scale={HQ_SCALE}>
      <SceneContext.Provider value={ctx}>
        <Board />
        <Paths />
        {/* Static: baked into a few meshes (80 calls → a handful) so the HQ stays inside the interior budget. */}
        <MergeStatic key={source.world.def.id}>
          <Props />
        </MergeStatic>
        <Stations selectedStationId={null} onSelectStation={() => {}} />
        <Characters selectedAgentId={source.selectedAgentId ?? null} onSelectAgent={source.onSelectAgent ?? (() => {})} />
        <Effects selectedSeq={null} />
        <LabelProjector />
      </SceneContext.Provider>
    </group>
  );
});
