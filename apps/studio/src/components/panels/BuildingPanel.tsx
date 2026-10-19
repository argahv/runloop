'use client';
import { useWorld, useWorldStore, useWorldTick } from '../../world/context';
import { buildingView } from '../../world/selectors';
import { sendWorldCommand } from '../../world/send';
import { Button } from '../../ui/Button';
import { Chip } from '../../ui/Chip';
import { Icon } from '../../ui/Icon';
import styles from './panels.module.css';

/** A town building (plan §5): purpose, org, occupancy n/cap, open or closed, Enter, who is inside. */
export default function BuildingPanel({ id }: { id: string }) {
  const store = useWorldStore();
  const town = useWorld((s) => s.town);
  const snapshot = useWorld((s) => s.snapshot);
  useWorld((s) => s.rev);
  const entered = useWorld((s) => s.entered);
  const pending = useWorld((s) => Object.values(s.pending).find((p) => p.command.type === 'building.set_open' && p.command.buildingId === id) ?? null);
  const tick = useWorldTick(1);
  const def = town?.buildingById.get(id);
  const v = snapshot && town ? buildingView(snapshot, town, id, tick) : null;
  if (!v || !def) return <p className={styles.panel}>This building is not in the town.</p>;

  const inside = entered === id;
  const status = !v.open ? 'Closed by you' : v.openNow ? 'Open now' : `Closed now · hours ${v.hours}`;
  const setOpen = (open: boolean) =>
    void sendWorldCommand(store, { type: 'building.set_open', buildingId: id, open }, open ? `Reopening ${v.name}…` : `Closing ${v.name}…`);
  const pct = v.capacity > 0 ? Math.min(100, Math.round((v.occupancy / v.capacity) * 100)) : 0;

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <div className={styles.titleRow}>
          <span className={`${styles.avatar} ${styles.square}`} style={{ background: def.def.palette.roof }} aria-hidden="true">
            <Icon name="world" size={18} />
          </span>
          <div>
            <h2 className={styles.title}>{v.name}</h2>
            <p className={styles.subtitle}>
              {v.purpose}
              {v.org && v.org !== v.name ? ` · ${v.org}` : ''}
              {v.district ? ` · ${v.district}` : ''}
            </p>
          </div>
        </div>
        <div className={styles.chips}>
          <Chip icon={v.chip.icon} title={v.chip.detail}>
            {v.chip.label}
          </Chip>
          <Chip icon={v.openNow ? 'checkCircle' : 'slash'} tone={v.openNow ? 'ok' : 'muted'}>
            {status}
          </Chip>
          {def.def.sign && def.def.sign.text !== v.name && <Chip>{`Sign: ${def.def.sign.text}`}</Chip>}
        </div>
        <div className={styles.actions}>
          <Button size="sm" variant="secondary" icon={inside ? 'arrowUp' : 'arrowRight'} aria-keyshortcuts="Enter" onClick={() => store.getState().enter(inside ? null : id)}>
            {inside ? 'Leave interior' : 'Enter'}
          </Button>
          {!v.isHome && (
            <Button size="sm" variant="ghost" icon={v.open ? 'lock' : 'refresh'} disabled={pending?.state === 'sending'} onClick={() => setOpen(!v.open)}>
              {v.open ? 'Close for now' : 'Reopen'}
            </Button>
          )}
        </div>
        {pending && (
          <span className={styles.pending} data-state={pending.state} role="status">
            <Icon name={pending.state === 'sending' ? 'hourglass' : 'alert'} size={12} />
            {pending.state === 'sending' ? `${pending.label} Waiting for the engine.` : `Not changed: ${String(pending.reason).replace(/_/g, ' ')}`}
          </span>
        )}
      </div>

      <section className={styles.section} aria-labelledby="occ-title">
        <div className={styles.sectionHead}>
          <h3 id="occ-title" className={styles.h3}>
            Occupancy
          </h3>
          <span className={styles.note}>{def.def.floors > 1 ? `${def.def.floors} floors · ` : ''}places to sit, work or sleep</span>
        </div>
        <div className={styles.meter}>
          <span className={styles.big}>
            {v.occupancy}
            <span className={styles.muted}>/{v.capacity}</span>
          </span>
          <span className={styles.meterBar} role="meter" aria-valuemin={0} aria-valuemax={v.capacity} aria-valuenow={v.occupancy} aria-label={`${v.occupancy} of ${v.capacity} places taken`}>
            <span className={styles.meterFill} style={{ width: `${pct}%`, display: 'block' }} />
          </span>
        </div>
        <p className={styles.note}>
          {def.def.access === 'residents' ? 'Only the people who live here go in.' : def.def.access === 'staff' ? 'Staff only.' : 'Open to everyone during its hours.'} Hours: {v.hours}.
        </p>
      </section>

      <section className={styles.section} aria-labelledby="inside-title">
        <h3 id="inside-title" className={styles.h3}>
          Inside now
        </h3>
        {v.occupants.length === 0 ? (
          <p className={styles.note}>Nobody is inside.</p>
        ) : (
          <ul className={styles.list}>
            {v.occupants.map((o) => (
              <li key={o.id}>
                <button type="button" className={styles.row} onClick={() => store.getState().focusEntity({ kind: 'resident', id: o.id })}>
                  <span className={styles.dot} style={{ background: snapshot!.residents.find((r) => r.id === o.id)?.outfit.top }} aria-hidden="true" />
                  <span className={styles.rowMain}>{o.name}</span>
                  <span className={styles.rowMeta}>{o.action}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
