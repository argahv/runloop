'use client';
import type { ExecState, Incident } from '@runloop-world/core';
import type { RunState } from '@runloop-world/replay';
import type { CompiledWorld } from '@runloop-world/world-engine';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { runProvenance } from '../state/provenance';
import type { CameraBus } from './context';
import { Icon } from './Icon';
import { incidentStationId } from './layout';
import type { SceneFrame, SceneStatus } from './types';
import styles from './scene.module.css';

/** What the overlay shows; recomputed when the frame's state changes, compared by value. */
interface OverlayInfo {
  provenance: string;
  /** Incidents placed in the world at the playhead, open ones first. */
  incidents: { seq: number; stationId: string; open: boolean }[];
  /** Subagents traced without a robot (over the cap of embodied subagents). */
  unembodied: number;
}

/** Provenance chip text (design-system.md, Provenance labelling). */
export function provenanceLabel(exec: ExecState): string {
  const p = runProvenance(null, exec);
  if (p.kind !== 'executed') return p.label;
  const adapter = exec.run.adapter;
  if (!adapter) return 'Executed';
  return `Executed · ${adapter.kind === 'scripted' ? 'Scripted adapter' : adapter.label}`;
}

/** Subagents (owners of delegated tasks) that have no robot in the world. */
export function unembodiedSubagents(exec: ExecState): number {
  const owners = new Set<string>();
  for (const id of exec.taskOrder) {
    const t = exec.tasks[id];
    if (t?.kind === 'delegated' && t.ownerId) owners.add(t.ownerId);
  }
  let n = 0;
  for (const id of owners) if (exec.agents[id] && !exec.agents[id]!.embodied) n += 1;
  return n;
}

function infoOf(world: CompiledWorld, state: RunState, cache: Map<string, string>): OverlayInfo {
  const exec = state.exec;
  const incidents: OverlayInfo['incidents'] = [];
  for (const inc of exec.incidents as Incident[]) {
    if (inc.kind === 'run_failed') continue;
    const stationId = incidentStationId(world, state, inc, cache);
    if (stationId) incidents.push({ seq: inc.seq, stationId, open: inc.resolvedSeq === null });
  }
  incidents.sort((a, b) => Number(b.open) - Number(a.open) || a.seq - b.seq);
  return {
    provenance: provenanceLabel(exec),
    incidents,
    unembodied: unembodiedSubagents(exec),
  };
}

/**
 * Floating controls over the world (glass, per the design system): the camera
 * rail (overview, focus the selection, next error) and the provenance chip
 * that says where the events come from and whether they are live.
 */
export function SceneOverlay({
  world,
  getFrame,
  camera,
  selectedAgentId,
  selectedStationId,
  selectedSeq,
  onSelectEvent,
  status,
  incidentStations,
}: {
  world: CompiledWorld;
  getFrame: () => SceneFrame;
  camera: CameraBus;
  selectedAgentId: string | null;
  selectedStationId: string | null;
  selectedSeq: number | null;
  onSelectEvent: (seq: number, opts: { seek: boolean }) => void;
  status: SceneStatus;
  incidentStations: Map<string, string>;
}) {
  const [info, setInfo] = useState<OverlayInfo>(() => infoOf(world, getFrame().state, incidentStations));
  const overview = useSyncExternalStore(camera.subscribe, camera.getOverview, camera.getOverview);

  // Poll the frame on animation frames, but re-render only when what is shown changes.
  useEffect(() => {
    let raf = 0;
    let lastState: RunState | null = null;
    let lastKey = '';
    const loop = () => {
      const state = getFrame().state;
      if (state !== lastState) {
        lastState = state;
        const next = infoOf(world, state, incidentStations);
        const key = JSON.stringify(next);
        if (key !== lastKey) {
          lastKey = key;
          setInfo(next);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [world, getFrame, incidentStations]);

  const canFocus = selectedAgentId !== null || selectedStationId !== null;
  const focus = () => {
    if (selectedAgentId) camera.request({ kind: 'focusAgent', agentId: selectedAgentId });
    else if (selectedStationId) camera.request({ kind: 'focusStation', stationId: selectedStationId });
  };
  const nextError = () => {
    const list = info.incidents;
    if (list.length === 0) return;
    const i = list.findIndex((x) => x.seq === selectedSeq);
    const next = list[(i + 1) % list.length]!;
    onSelectEvent(next.seq, { seek: false });
    camera.request({ kind: 'focusStation', stationId: next.stationId });
  };
  const errors = info.incidents.length;
  const open = info.incidents.filter((x) => x.open).length;

  return (
    <>
      <div className={styles.rail} role="toolbar" aria-label="Camera presets" aria-orientation="vertical">
        <button type="button" className={styles.railButton} aria-pressed={overview} onClick={() => camera.request({ kind: 'overview' })} title="Overview: frame the whole world" aria-label="Overview: frame the whole world">
          <Icon name="frame" className={styles.railIcon} />
        </button>
        <button
          type="button"
          className={styles.railButton}
          disabled={!canFocus}
          onClick={focus}
          title={canFocus ? 'Focus the selection' : 'Select an agent or a station to focus it'}
          aria-label="Focus the selection"
        >
          <Icon name="target" className={styles.railIcon} />
        </button>
        <button
          type="button"
          className={styles.railButton}
          disabled={errors === 0}
          onClick={nextError}
          title={errors === 0 ? 'No failures in the world at the playhead' : `Next error (${open} open, ${errors - open} resolved)`}
          aria-label={errors === 0 ? 'Next error: none at the playhead' : `Next error: ${open} open, ${errors - open} resolved`}
        >
          <Icon name="alert" className={styles.railIcon} />
          {open > 0 && (
            <span className={styles.railCount} aria-hidden>
              {open}
            </span>
          )}
        </button>
      </div>
      <div className={styles.corner}>
        {info.unembodied > 0 && (
          <span className={styles.chip} title="Only the first 8 subagents get a robot. The others are traced in full: see the Network view and the timeline.">
            +{info.unembodied} {info.unembodied === 1 ? 'subagent' : 'subagents'} without a robot
          </span>
        )}
        <span className={styles.chip} data-live={status.live} title={status.detail}>
          <Icon name={info.provenance.startsWith('Traced') ? 'eye' : 'terminal'} />
          <span className={styles.chipStrong}>{info.provenance}</span>
          <span className={styles.chipSep} aria-hidden />
          <span className={styles.liveDot} aria-hidden />
          {status.text}
        </span>
      </div>
    </>
  );
}
