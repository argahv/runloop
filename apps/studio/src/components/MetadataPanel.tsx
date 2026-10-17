'use client';
import { isUnknownEvent } from '@runloop-world/events';
import { useMemo, type ReactNode } from 'react';
import { useStudio, useStudioStore } from '../state/context';
import { runProvenance } from '../state/provenance';
import { formatDuration } from '../state/timeline';
import { runStatusView } from '../state/view';
import { Chip } from '../ui/Chip';
import { EmptyState } from '../ui/States';
import styles from './InfoPanels.module.css';
import SourceFacts from './SourceFacts';

const NOT_REPORTED = <span className={styles.none}>not reported</span>;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <dt>{label}</dt>
      <dd>{children ?? NOT_REPORTED}</dd>
    </div>
  );
}

/** Run facts: ids, provenance, adapter, trace integrity and world. */
export default function MetadataPanel() {
  const store = useStudioStore();
  const run = useStudio((s) => s.run);
  const world = useStudio((s) => s.world);
  const lastSequence = useStudio((s) => s.lastSequence);
  const durationMs = useStudio((s) => s.durationMs);
  const raw = useStudio((s) => s.raw);
  const exec = useMemo(() => store.getState().stateAt(lastSequence).exec, [store, lastSequence]);
  const versions = useMemo(
    () => [...new Set(store.getState().events().map((e) => e.schemaVersion))].sort().join(', '),
    [store, lastSequence],
  );
  const unknownCount = useMemo(() => store.getState().events().filter(isUnknownEvent).length, [store, lastSequence]);

  if (!run) {
    return (
      <EmptyState compact icon="traces" title="No run open">
        <p>Open a run to see its metadata.</p>
      </EmptyState>
    );
  }
  const r = exec.run;
  const prov = runProvenance(run, exec);

  return (
    <div className={styles.scroll}>
      <section className={styles.banner} data-kind={prov.kind}>
        <Chip tone={prov.tone} icon={prov.icon}>
          {prov.label}
        </Chip>
        <p>{prov.detail}</p>
      </section>
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
          <Row label="Status">
            {runStatusView(run.status, run.paused, prov.kind === 'traced').text}
            {prov.kind === 'traced' && run.status === 'stopped' ? ' (recorded as stopped)' : ''}
          </Row>
          <Row label="Started">{r.startedAt ?? run.createdAt}</Row>
          <Row label="Ended">{r.endedAt ?? run.endedAt ?? (run.status === 'running' ? <span className={styles.none}>still running</span> : null)}</Row>
          <Row label="Duration">{formatDuration(durationMs)}</Row>
          <Row label="Summary">{r.summary}</Row>
          {prov.kind !== 'traced' && <Row label="Seed">{r.seed !== null && r.seed !== undefined ? <code>{r.seed}</code> : null}</Row>}
          {prov.kind !== 'traced' && <Row label="Workspace">{r.workspace ? <code>{r.workspace}</code> : null}</Row>}
        </dl>
      </section>
      {prov.kind === 'traced' && (
        <section className={styles.section}>
          <h2 className={styles.h2}>Source</h2>
          <SourceFacts run={run} exec={exec} />
        </section>
      )}
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
          <Row label="Failures">{exec.incidents.length}</Row>
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
