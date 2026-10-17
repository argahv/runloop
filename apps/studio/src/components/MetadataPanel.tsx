'use client';
import { isUnknownEvent } from '@runloop-world/events';
import { useMemo, type ReactNode } from 'react';
import { useStudio, useStudioStore } from '../state/context';
import { formatDuration } from '../state/timeline';
import styles from './InfoPanels.module.css';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children ?? '—'}</dd>
    </>
  );
}

/** Run facts: ids, seed, schema version, world, adapter. */
export default function MetadataPanel() {
  const store = useStudioStore();
  const run = useStudio((s) => s.run);
  const world = useStudio((s) => s.world);
  const lastSequence = useStudio((s) => s.lastSequence);
  const durationMs = useStudio((s) => s.durationMs);
  const raw = useStudio((s) => s.raw);
  const exec = useMemo(() => store.getState().stateAt(lastSequence).exec, [store, lastSequence]);
  const first = useMemo(() => store.getState().events()[0], [store, lastSequence]);
  const versions = useMemo(
    () => [...new Set(store.getState().events().map((e) => e.schemaVersion))].sort().join(', '),
    [store, lastSequence],
  );
  const unknownCount = useMemo(() => store.getState().events().filter(isUnknownEvent).length, [store, lastSequence]);

  if (!run) return <p className={styles.note}>No run selected.</p>;
  const r = exec.run;
  return (
    <div className={styles.scroll}>
      <section className={styles.section}>
        <h2 className={styles.h2}>Run</h2>
        <dl className={styles.dl}>
          <Row label="Run id">
            <code>{run.runId}</code>
          </Row>
          <Row label="Title">{run.title}</Row>
          <Row label="Mission">
            <code>{run.missionId}</code>
          </Row>
          <Row label="Status">{run.status}{run.paused ? ' (paused)' : ''}</Row>
          <Row label="Started">{r.startedAt ?? run.createdAt}</Row>
          <Row label="Ended">{r.endedAt ?? run.endedAt}</Row>
          <Row label="Duration">{formatDuration(durationMs)}</Row>
          <Row label="Summary">{r.summary}</Row>
          <Row label="Seed">{first ? <code>{r.seed}</code> : null}</Row>
          <Row label="Workspace">{r.workspace ? <code>{r.workspace}</code> : null}</Row>
        </dl>
      </section>
      <section className={styles.section}>
        <h2 className={styles.h2}>Adapter</h2>
        <dl className={styles.dl}>
          <Row label="Label">{r.adapter?.label ?? run.adapterLabel}</Row>
          <Row label="Kind">{r.adapter?.kind}</Row>
          <Row label="Id">{r.adapter ? <code>{r.adapter.id}</code> : null}</Row>
        </dl>
      </section>
      <section className={styles.section}>
        <h2 className={styles.h2}>Trace</h2>
        <dl className={styles.dl}>
          <Row label="Schema version">{versions || null}</Row>
          <Row label="Events">{lastSequence}</Row>
          <Row label="Unrecognised">{unknownCount}</Row>
          <Row label="Invalid">{raw.length}</Row>
          <Row label="Anomalies">{exec.anomalies.length}</Row>
          <Row label="Incidents">{exec.incidents.length}</Row>
        </dl>
      </section>
      <section className={styles.section}>
        <h2 className={styles.h2}>World</h2>
        <dl className={styles.dl}>
          <Row label="World id">
            <code>{world?.def.id ?? run.worldId}</code>
          </Row>
          <Row label="Name">{world?.def.name}</Row>
          <Row label="Grid">{world ? `${world.width} × ${world.height} cells` : null}</Row>
          <Row label="Tick rate">{world ? `${world.def.tickHz} Hz, ${world.def.ticksPerCell} ticks per cell` : null}</Row>
          <Row label="Stations">{world?.def.stations.length}</Row>
        </dl>
      </section>
    </div>
  );
}
