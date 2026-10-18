'use client';
import type { EntityRef } from '@runloop-world/events';
import { useWorld, useWorldStore, useWorldTick } from '../../world/context';
import { actionLabel, districtOf, residentDistrict } from '../../world/entityIndex';
import { Chip } from '../../ui/Chip';
import { Icon } from '../../ui/Icon';
import styles from './panels.module.css';

/** An outdoor place, a district or a lot: what it is and who is there. */
export default function PlacePanel({ refId }: { refId: EntityRef }) {
  const store = useWorldStore();
  const town = useWorld((s) => s.town);
  const snapshot = useWorld((s) => s.snapshot);
  useWorld((s) => s.rev);
  const tick = useWorldTick(1);
  if (!town || !snapshot) return null;

  let title = refId.id;
  let subtitle = '';
  let people = snapshot.residents.filter(() => false);
  let extra: string | null = null;
  if (refId.kind === 'spot') {
    const s = town.spotById.get(refId.id);
    if (!s) return <p className={styles.panel}>This place is not in the town.</p>;
    title = s.def.label;
    const d = town.def.districts.find((x) => x.id === s.def.districtId);
    subtitle = `Outdoors · ${s.def.kind}${d ? ` · ${d.label}` : ''}`;
    people = snapshot.residents.filter((r) => !r.motion && r.place.kind === 'outdoor' && r.place.spotId === refId.id);
    extra = `${s.def.cells.length} places to ${s.def.pose}. Good for ${s.def.tags.map((t) => actionLabel(t)).join(', ')}${s.def.hours ? `, ${s.def.hours.open}–${s.def.hours.close}` : ''}.`;
  } else if (refId.kind === 'district') {
    const d = town.def.districts.find((x) => x.id === refId.id);
    if (!d) return <p className={styles.panel}>This district is not in the town.</p>;
    title = d.label;
    subtitle = `District · ${d.kind}`;
    people = snapshot.residents.filter((r) => residentDistrict(town, r, tick) === d.id);
    const buildings = town.buildings.filter((b) => districtOf(town, b.def.id) === d.id).length;
    extra = `${buildings} ${buildings === 1 ? 'building' : 'buildings'}${d.id === 'dst_agent_district' ? ` · ${town.agentLots.length} agent lots` : ''}.`;
  } else if (refId.kind === 'lot') {
    const lot = town.lotById.get(refId.id);
    if (!lot) return <p className={styles.panel}>This lot is not in the town.</p>;
    const agent = snapshot.agents.find((a) => a.lotId === lot.id);
    title = `Lot ${lot.id.replace(/^lot_/, '').replace(/_/g, ' ')}`;
    subtitle = lot.use === 'agent' ? (agent ? `Home of ${agent.displayName}` : 'Free agent lot') : 'Building lot';
  }

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <div className={styles.titleRow}>
          <span className={`${styles.avatar} ${styles.square}`} style={{ background: '#d6c39b' }} aria-hidden="true">
            <Icon name="map" size={18} />
          </span>
          <div>
            <h2 className={styles.title}>{title}</h2>
            <p className={styles.subtitle}>{subtitle}</p>
          </div>
        </div>
        <div className={styles.chips}>
          <Chip icon="map">Town</Chip>
        </div>
        {extra && <p className={styles.note}>{extra}</p>}
      </div>
      <section className={styles.section} aria-labelledby="here-title">
        <h3 id="here-title" className={styles.h3}>
          {refId.kind === 'district' ? `In the district now (${people.length})` : `Here now (${people.length})`}
        </h3>
        {people.length === 0 ? (
          <p className={styles.note}>Nobody right now.</p>
        ) : (
          <ul className={styles.list}>
            {people
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .slice(0, 40)
              .map((r) => (
                <li key={r.id}>
                  <button type="button" className={styles.row} onClick={() => store.getState().focusEntity({ kind: 'resident', id: r.id })}>
                    <span className={styles.dot} style={{ background: r.outfit.top }} aria-hidden="true" />
                    <span className={styles.rowMain}>{r.name}</span>
                    <span className={styles.rowMeta}>{r.motion ? 'walking' : actionLabel(r.action)}</span>
                  </button>
                </li>
              ))}
          </ul>
        )}
      </section>
    </div>
  );
}
